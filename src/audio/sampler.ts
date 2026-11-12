/**
 * Piano sample set: loading, onset detection, level smoothing, nearest-sample lookup.
 */
import {
  LEVEL_CORRECTION_MAX_DB,
  MAX_SHIFT_SEMITONES,
  ONSET_SCAN_SEC,
  ONSET_THRESHOLD_DB,
} from './constants';
import { dbToGain } from './dsp';
import type { SampleFetcher, SampleManifest } from './types';

export interface PianoSample {
  /** MIDI note the sample was recorded at. */
  midi: number;
  /** Note name, e.g. "F#1". */
  note: string;
  file: string;
  buffer: AudioBuffer;
  /** Seconds. Position of the hammer onset inside `buffer`, detected at load time. */
  onsetSec: number;
  /** dB. Level smoothing applied to every voice that uses this sample (within +-LEVEL_CORRECTION_MAX_DB). */
  correctionDb: number;
}

export interface PianoSampleSet {
  /** Sample rate of the decoded buffers. */
  sampleRate: number;
  /** Ascending by `midi`. */
  samples: PianoSample[];
}

/**
 * Index of the first frame whose |value| (any channel) is above
 * ONSET_THRESHOLD_DB relative to the peak of the first ONSET_SCAN_SEC seconds.
 */
export function detectOnsetFrame(channels: readonly Float32Array[], sampleRate: number): number {
  const frames = channels.reduce((m, ch) => Math.min(m, ch.length), Infinity);
  if (!Number.isFinite(frames) || frames === 0) return 0;
  const scan = Math.min(frames, Math.round(ONSET_SCAN_SEC * sampleRate));
  let peak = 0;
  for (const ch of channels) {
    for (let i = 0; i < scan; i++) {
      const a = Math.abs(ch[i]);
      if (a > peak) peak = a;
    }
  }
  if (!(peak > 0)) return 0;
  const threshold = peak * dbToGain(ONSET_THRESHOLD_DB);
  for (let i = 0; i < scan; i++) {
    for (const ch of channels) {
      if (Math.abs(ch[i]) > threshold) return i;
    }
  }
  return 0;
}

/**
 * Level smoothing across the keyboard. Fits a straight line (least squares)
 * through rmsDb over the MIDI number and returns, per entry, the gain in dB that
 * moves the sample towards the line, clamped to +-LEVEL_CORRECTION_MAX_DB.
 */
export function computeLevelCorrections(notes: readonly { midi: number; rmsDb: number }[]): number[] {
  const n = notes.length;
  if (n < 3) return notes.map(() => 0);
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (const e of notes) {
    sx += e.midi;
    sy += e.rmsDb;
    sxx += e.midi * e.midi;
    sxy += e.midi * e.rmsDb;
  }
  const denom = n * sxx - sx * sx;
  const slope = denom !== 0 ? (n * sxy - sx * sy) / denom : 0;
  const intercept = (sy - slope * sx) / n;
  return notes.map((e) => {
    const trend = intercept + slope * e.midi;
    return Math.min(LEVEL_CORRECTION_MAX_DB, Math.max(-LEVEL_CORRECTION_MAX_DB, trend - e.rmsDb));
  });
}

/** Decodes every file of the manifest and measures its onset. */
export async function loadPianoSamples(
  ctx: BaseAudioContext,
  fetchSample: SampleFetcher,
  manifest: SampleManifest,
): Promise<PianoSampleSet> {
  const entries = [...manifest.notes].sort((a, b) => a.midi - b.midi);
  const corrections = computeLevelCorrections(entries);
  const samples = await Promise.all(
    entries.map(async (entry, i): Promise<PianoSample> => {
      const bytes = await fetchSample(entry.file);
      const buffer = await ctx.decodeAudioData(bytes);
      const channels: Float32Array[] = [];
      for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
      const onsetFrame = detectOnsetFrame(channels, buffer.sampleRate);
      return {
        midi: entry.midi,
        note: entry.note,
        file: entry.file,
        buffer,
        onsetSec: onsetFrame / buffer.sampleRate,
        correctionDb: corrections[i],
      };
    }),
  );
  return { sampleRate: samples.length > 0 ? samples[0].buffer.sampleRate : ctx.sampleRate, samples };
}

/**
 * Nearest sample for a MIDI pitch and the shift in semitones (pitch - sample.midi).
 * Inside the sampled range the shift is at most +-1 (minor-third sampling); outside
 * it the edge sample is used and the shift is clamped to +-MAX_SHIFT_SEMITONES.
 */
export function nearestSample(set: PianoSampleSet, pitch: number): { sample: PianoSample; semitones: number } {
  const list = set.samples;
  if (list.length === 0) throw new Error('nearestSample: empty sample set');
  let best = list[0];
  let bestDist = Math.abs(pitch - best.midi);
  for (let i = 1; i < list.length; i++) {
    const dist = Math.abs(pitch - list[i].midi);
    if (dist < bestDist) {
      best = list[i];
      bestDist = dist;
    }
  }
  const semitones = Math.min(MAX_SHIFT_SEMITONES, Math.max(-MAX_SHIFT_SEMITONES, pitch - best.midi));
  return { sample: best, semitones };
}
