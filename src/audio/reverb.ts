/**
 * Procedural reverb impulse response. Pure and deterministic: no AudioContext,
 * no recorded material, fixed internal seed.
 *
 * Shape: pre-delay, a few sparse early reflections, then a diffuse tail made of
 * band-limited decorrelated stereo noise. Every band has its own exponential
 * decay: the mid bands reach -60 dB after `rt60Sec`, the high bands sooner
 * (damping). A low-cut removes rumble, the end fades to exactly zero, and each
 * channel is scaled to unit energy gain in a mid reference band, so the wet
 * level does not depend on the size.
 */
import {
  REVERB_BANDS,
  REVERB_BUILDUP_SEC,
  REVERB_EARLY_COUNT,
  REVERB_EARLY_ENERGY_SHARE,
  REVERB_EARLY_WINDOW_SEC,
  REVERB_END_FADE_SEC,
  REVERB_LENGTH_FACTOR,
  REVERB_LOWCUT_HZ,
  REVERB_PREDELAY_SEC,
  REVERB_REF_BAND_HZ,
  REVERB_SEED,
} from './constants';
import { biquadInPlace, dbToGain, highpassCoeffs, lowpassCoeffs } from './dsp';
import { mulberry32, subSeed } from './rng';
import type { StereoPcm } from './types';

const LN_1000 = Math.log(1000); // amplitude factor of 60 dB

/** Number of frames `buildReverbIR` returns for a given size. */
export function reverbIRLength(sampleRate: number, rt60Sec: number): number {
  const rt60 = Math.min(20, Math.max(0.1, rt60Sec));
  return Math.round(REVERB_PREDELAY_SEC * sampleRate) + Math.ceil(rt60 * REVERB_LENGTH_FACTOR * sampleRate);
}

export function buildReverbIR(sampleRate: number, rt60Sec: number): StereoPcm {
  const rt60 = Math.min(20, Math.max(0.1, rt60Sec));
  const pre = Math.round(REVERB_PREDELAY_SEC * sampleRate);
  const len = reverbIRLength(sampleRate, rt60);
  const tailLen = len - pre;
  const buildup = Math.max(1, Math.round(REVERB_BUILDUP_SEC * sampleRate));
  const channels: Float32Array[] = [];

  for (let ch = 0; ch < 2; ch++) {
    const acc = new Float64Array(len);

    // Diffuse tail: one noise band at a time, each with its own decay.
    const band = new Float64Array(tailLen);
    REVERB_BANDS.forEach(([loHz, hiHz, rtMul, densityDb], b) => {
      // Band power = density per Hz * bandwidth.
      const levelDb = densityDb + 10 * Math.log10(hiHz - loHz);
      const rand = mulberry32(subSeed(REVERB_SEED, ch * 64 + b));
      for (let i = 0; i < tailLen; i++) band[i] = rand() * 2 - 1;
      biquadInPlace(band, highpassCoeffs(sampleRate, loHz));
      biquadInPlace(band, lowpassCoeffs(sampleRate, hiHz));
      let sum = 0;
      for (let i = 0; i < tailLen; i++) sum += band[i] * band[i];
      const norm = dbToGain(levelDb) / Math.sqrt(sum / tailLen || 1);
      const decayPerSample = Math.exp(-LN_1000 / (rt60 * rtMul * sampleRate));
      let env = norm;
      for (let i = 0; i < tailLen; i++) {
        const rise = i < buildup ? 0.5 - 0.5 * Math.cos((Math.PI * i) / buildup) : 1;
        acc[pre + i] += band[i] * env * rise;
        env *= decayPerSample;
      }
    });

    // Sparse early reflections: single taps, alternating-ish signs, falling level.
    let tailEnergy = 0;
    for (let i = 0; i < len; i++) tailEnergy += acc[i] * acc[i];
    const rand = mulberry32(subSeed(REVERB_SEED, 1000 + ch));
    const window = Math.round(REVERB_EARLY_WINDOW_SEC * sampleRate);
    const taps: { index: number; amp: number }[] = [];
    let tapEnergy = 0;
    for (let k = 0; k < REVERB_EARLY_COUNT; k++) {
      // One tap per slice of the window, jittered inside its slice.
      const pos = (k + 0.15 + 0.7 * rand()) / REVERB_EARLY_COUNT;
      const amp = (rand() < 0.5 ? -1 : 1) * (1 - 0.6 * pos) * (0.6 + 0.4 * rand());
      taps.push({ index: Math.min(len - 1, pre + Math.round(pos * window)), amp });
      tapEnergy += amp * amp;
    }
    const share = REVERB_EARLY_ENERGY_SHARE;
    const tapScale = Math.sqrt(((share / (1 - share)) * tailEnergy) / (tapEnergy || 1));
    for (const tap of taps) acc[tap.index] += tap.amp * tapScale;

    // Low-cut last (24 dB/oct), so the response at DC is ~0 by construction.
    const lowcut = highpassCoeffs(sampleRate, REVERB_LOWCUT_HZ);
    biquadInPlace(acc, lowcut);
    biquadInPlace(acc, lowcut);

    // Smooth fade to exactly zero at the end.
    const fade = Math.min(tailLen, Math.max(2, Math.round(REVERB_END_FADE_SEC * sampleRate)));
    for (let i = 0; i < fade; i++) {
      acc[len - fade + i] *= 0.5 + 0.5 * Math.cos((Math.PI * (i + 1)) / fade);
    }
    acc[len - 1] = 0;
    for (let i = 0; i < pre; i++) acc[i] = 0;

    // Unit energy gain in the reference band, per channel.
    const refGain = bandEnergyGain(acc, sampleRate, REVERB_REF_BAND_HZ[0], REVERB_REF_BAND_HZ[1]);
    const scale = refGain > 0 ? 1 / Math.sqrt(refGain) : 0;
    const out = new Float32Array(len);
    for (let i = 0; i < len; i++) out[i] = acc[i] * scale;
    channels.push(out);
  }
  return [channels[0], channels[1]];
}

/**
 * Energy gain of an impulse response for signals inside a band: energy of the
 * band-filtered IR divided by the energy of the band filter itself (a weighted
 * mean of |H(f)|^2 over the band; 12 dB/oct edges at `loHz` and `hiHz`).
 */
export function bandEnergyGain(
  ir: Float32Array | Float64Array,
  sampleRate: number,
  loHz: number,
  hiHz: number,
): number {
  const hp = highpassCoeffs(sampleRate, loHz);
  const lp = lowpassCoeffs(sampleRate, hiHz);
  const probe = new Float64Array(Math.round(sampleRate / 2));
  probe[0] = 1;
  biquadInPlace(probe, hp);
  biquadInPlace(probe, lp);
  const filtered = Float64Array.from(ir);
  biquadInPlace(filtered, hp);
  biquadInPlace(filtered, lp);
  let filterEnergy = 0;
  for (let i = 0; i < probe.length; i++) filterEnergy += probe[i] * probe[i];
  let energy = 0;
  for (let i = 0; i < filtered.length; i++) energy += filtered[i] * filtered[i];
  return filterEnergy > 0 ? energy / filterEnergy : 0;
}

/**
 * RT60 of an impulse response by Schroeder backward integration: a straight
 * line is fitted to the energy decay curve between `fromDb` and `toDb`
 * (default -5..-35 dB = T30) and extrapolated to -60 dB. Returns seconds.
 */
export function measureRt60(
  ir: readonly Float32Array[],
  sampleRate: number,
  fromDb = -5,
  toDb = -35,
): number {
  const n = ir.reduce((m, ch) => Math.max(m, ch.length), 0);
  const edc = new Float64Array(n);
  let acc = 0;
  for (let i = n - 1; i >= 0; i--) {
    for (const ch of ir) if (i < ch.length) acc += ch[i] * ch[i];
    edc[i] = acc;
  }
  const total = edc[0];
  if (!(total > 0)) return 0;
  // Least-squares line through (t, dB) for all samples inside the dB window.
  let count = 0;
  let st = 0;
  let sd = 0;
  let stt = 0;
  let std = 0;
  for (let i = 0; i < n; i++) {
    const db = 10 * Math.log10(edc[i] / total);
    if (db > fromDb) continue;
    if (db < toDb) break;
    const t = i / sampleRate;
    count++;
    st += t;
    sd += db;
    stt += t * t;
    std += t * db;
  }
  if (count < 2) return 0;
  const slope = (count * std - st * sd) / (count * stt - st * st); // dB per second, negative
  return slope < 0 ? -60 / slope : 0;
}
