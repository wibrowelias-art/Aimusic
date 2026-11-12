/**
 * Last stage of the lo-fi chain, in plain arithmetic (no Web Audio, deterministic):
 * bring the programme to the target loudness, add the hiss at its exact level, hold the
 * peaks under the ceiling with a look-ahead limiter, and check the peak between the
 * samples too.
 */
import { integratedLufs, truePeakDb } from '../analysis/loudness';
import { dbToGain } from '../audio/dsp';
import type { StereoPcm } from '../audio/types';
import {
  CEILING_DB,
  LIMITER_LOOKAHEAD_SEC,
  LIMITER_RELEASE_SEC,
  TARGET_LUFS,
  TARGET_LUFS_TOLERANCE,
  TRUE_PEAK_MAX_DB,
} from './constants';

/** Gain below this (0.1 dB down) counts as "limited" in the report. */
const COUNTS_AS_LIMITED = 10 ** (-0.1 / 20);

export interface LimitResult {
  /** Largest gain reduction applied, dB (0 = the limiter never acted). */
  maxReductionDb: number;
  /** Share of the samples with more than 0.1 dB of gain reduction. */
  limitedShare: number;
}

/**
 * Look-ahead peak limiter, in place. The gain may fall at once but recovers slowly, and
 * it is averaged over the look-ahead window, so it starts to fall before a peak arrives.
 * After this no sample is above `ceiling` (linear), by construction: every value the
 * average sees is at most the gain the sample itself needs.
 */
export function limitInPlace(pcm: StereoPcm, sampleRate: number, ceiling: number): LimitResult {
  const [l, r] = pcm;
  const n = l.length;
  const look = Math.max(1, Math.round(LIMITER_LOOKAHEAD_SEC * sampleRate));
  let any = false;
  const need = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.max(Math.abs(l[i]), Math.abs(r[i]));
    if (a > ceiling) {
      need[i] = ceiling / a;
      any = true;
    } else {
      need[i] = 1;
    }
  }
  if (!any) return { maxReductionDb: 0, limitedShare: 0 };

  // Smallest needed gain over the next `look` samples (sliding minimum, monotonic queue).
  const ahead = new Float32Array(n);
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;
  let next = 0;
  for (let i = 0; i < n; i++) {
    const end = Math.min(n, i + look);
    while (next < end) {
      while (tail > head && need[queue[tail - 1]] >= need[next]) tail--;
      queue[tail++] = next++;
    }
    while (queue[head] < i) head++;
    ahead[i] = need[queue[head]];
  }

  // Slow recovery.
  const keep = Math.exp(-1 / (LIMITER_RELEASE_SEC * sampleRate));
  let g = 1;
  for (let i = 0; i < n; i++) {
    const recovered = 1 - (1 - g) * keep;
    g = Math.min(ahead[i], recovered);
    ahead[i] = g;
  }

  // Moving average over the look-ahead window, then apply.
  let sum = 0;
  let minGain = 1;
  let limited = 0;
  for (let i = 0; i < n; i++) {
    sum += ahead[i];
    if (i >= look) sum -= ahead[i - look];
    const count = Math.min(i + 1, look);
    // Before a full window exists, the missing part counts as the current value (never above it).
    const gain = Math.min(1, i + 1 >= look ? sum / look : (sum + ahead[i] * (look - count)) / look);
    const safe = Math.min(gain, need[i]);
    if (safe < 1) {
      l[i] *= safe;
      r[i] *= safe;
      if (safe < COUNTS_AS_LIMITED) limited++;
      if (safe < minGain) minGain = safe;
    }
  }
  return { maxReductionDb: -20 * Math.log10(minGain), limitedShare: limited / n };
}

export interface MasterOptions {
  targetLufs?: number;
  ceilingDb?: number;
  truePeakMaxDb?: number;
  /** Noise to add once the programme has its final loudness (same length or shorter). */
  hiss?: StereoPcm | null;
}

export interface MasterReport {
  /** Loudness of what came in, LUFS. */
  inputLufs: number;
  /** Gain applied before the limiter, dB. */
  gainDb: number;
  /** Loudness of the finished signal, LUFS. */
  lufs: number;
  /** Sample peak of the finished signal, dBFS. */
  peakDb: number;
  /** 4x oversampled peak of the finished signal, dBFS. */
  truePeakDb: number;
  limiter: LimitResult;
  /** Extra trim after the limiter to keep the oversampled peak in range, dB (0 or negative). */
  truePeakTrimDb: number;
  /** True when the loudness ended within the tolerance of the target. */
  onTarget: boolean;
}

function scaleInPlace(pcm: StereoPcm, gain: number): void {
  for (const c of pcm) for (let i = 0; i < c.length; i++) c[i] *= gain;
}

function samplePeakDb(pcm: StereoPcm): number {
  let peak = 0;
  for (const c of pcm) {
    for (let i = 0; i < c.length; i++) {
      const a = Math.abs(c[i]);
      if (a > peak) peak = a;
    }
  }
  return peak > 0 ? 20 * Math.log10(peak) : -Infinity;
}

/**
 * Masters `pcm` in place. Silence stays silence (gain 0 dB, lufs -Infinity).
 * Two rounds at most: when the limiter took enough off the peaks to pull the loudness
 * under the target, the gain is raised by the difference and the limiter runs again.
 */
export function masterInPlace(pcm: StereoPcm, sampleRate: number, opts: MasterOptions = {}): MasterReport {
  const target = opts.targetLufs ?? TARGET_LUFS;
  const ceiling = dbToGain(opts.ceilingDb ?? CEILING_DB);
  const truePeakMax = opts.truePeakMaxDb ?? TRUE_PEAK_MAX_DB;
  const inputLufs = integratedLufs(pcm, sampleRate);
  const report: MasterReport = {
    inputLufs,
    gainDb: 0,
    lufs: inputLufs,
    peakDb: samplePeakDb(pcm),
    truePeakDb: truePeakDb(pcm),
    limiter: { maxReductionDb: 0, limitedShare: 0 },
    truePeakTrimDb: 0,
    onTarget: false,
  };
  if (!Number.isFinite(inputLufs)) return report;

  const source: StereoPcm = [pcm[0].slice(), pcm[1].slice()];
  let gainDb = target - inputLufs;
  for (let round = 0; round < 2; round++) {
    const gain = dbToGain(gainDb);
    for (let ch = 0; ch < 2; ch++) {
      const dst = pcm[ch];
      const src = source[ch];
      const noise = opts.hiss ? opts.hiss[ch] : null;
      for (let i = 0; i < dst.length; i++) dst[i] = src[i] * gain + (noise && i < noise.length ? noise[i] : 0);
    }
    report.limiter = limitInPlace(pcm, sampleRate, ceiling);
    report.gainDb = gainDb;
    report.lufs = integratedLufs(pcm, sampleRate);
    const miss = target - report.lufs;
    if (Math.abs(miss) <= 0.1 || report.limiter.maxReductionDb === 0) break;
    gainDb += miss;
  }

  const tp = truePeakDb(pcm);
  if (tp > truePeakMax) {
    report.truePeakTrimDb = truePeakMax - tp;
    scaleInPlace(pcm, dbToGain(report.truePeakTrimDb));
    report.lufs += report.truePeakTrimDb;
  }
  report.peakDb = samplePeakDb(pcm);
  report.truePeakDb = truePeakDb(pcm);
  report.onTarget = Math.abs(report.lufs - target) <= TARGET_LUFS_TOLERANCE;
  return report;
}
