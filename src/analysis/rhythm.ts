/**
 * "Match my own song": reads the rhythm and the tone of a track the owner uploads, as
 * numbers only. Rhythm = tempo plus how strong the hits are on each sixteenth of the bar
 * (16 numbers). Tone = brightness and reverb length. No pitches, no melody, no chords
 * are read, and no audio is kept. Pure and deterministic.
 */
import type { Mode } from '../engine/types';
import { analyseReference, foldTempo } from './reference';

export const RHYTHM_STEPS = 16;

export interface SongMatch {
  /** Tempo the generator will use (the read tempo folded into its range), BPM. */
  tempoBpm: number;
  /** Tempo as read from the file, BPM. */
  readTempoBpm: number;
  /** Hit strength per sixteenth of the bar, 0..1, the strongest step is 1. */
  grid: number[];
  /** Spectral centroid of the file, Hz. */
  brightnessHz: number;
  /** Reverb / decay length in seconds, null when no free decay was found. */
  decaySec: number | null;
  /** Key of the file as a general trait (tonic pitch class and mode), null when unclear. */
  keyPc: number | null;
  mode: Mode | null;
  /** Where the first bar line was found, seconds from the start of the file. */
  offsetSec: number;
  /** Length of the analysed audio, seconds. */
  durationSec: number;
}

/** Rise of the log energy, 100 values per second. */
function onsetEnvelope(channels: readonly Float32Array[], sampleRate: number): Float32Array {
  const hop = Math.max(1, Math.round(sampleRate / 100));
  const n = Math.floor((channels[0]?.length ?? 0) / hop);
  const env = new Float32Array(Math.max(0, n));
  let prev = 0;
  for (let f = 0; f < n; f++) {
    let sum = 0;
    for (const c of channels) {
      for (let i = f * hop; i < (f + 1) * hop; i++) sum += c[i] * c[i];
    }
    const level = Math.log(1e-9 + sum / hop);
    env[f] = f === 0 ? 0 : Math.max(0, level - prev);
    prev = level;
  }
  return env;
}

/** Null when the file has no readable tempo. */
export function matchSong(channels: readonly Float32Array[], sampleRate: number): SongMatch | null {
  const traits = analyseReference(channels, sampleRate);
  if (traits.tempoBpm === null) return null;
  const tempoBpm = foldTempo(traits.tempoBpm);
  const env = onsetEnvelope(channels, sampleRate);
  const barFrames = (240 / tempoBpm) * 100;
  if (env.length < barFrames * 2) return null;
  const stepFrames = barFrames / RHYTHM_STEPS;
  // Where the bar starts: the offset that puts the most energy on the four beats.
  let bestOffset = 0;
  let bestScore = -1;
  for (let offset = 0; offset < Math.round(barFrames); offset++) {
    let score = 0;
    for (let t = offset, k = 0; t < env.length; t += barFrames / 4, k++) score += env[Math.round(t)] * (k % 4 === 0 ? 2 : 1);
    if (score > bestScore) {
      bestScore = score;
      bestOffset = offset;
    }
  }
  const grid = new Array<number>(RHYTHM_STEPS).fill(0);
  for (let f = 0; f < env.length; f++) {
    const pos = (((f - bestOffset) / stepFrames) % RHYTHM_STEPS + RHYTHM_STEPS) % RHYTHM_STEPS;
    grid[Math.round(pos) % RHYTHM_STEPS] += env[f];
  }
  const max = Math.max(...grid);
  if (max <= 0) return null;
  return {
    tempoBpm,
    readTempoBpm: Math.round(traits.tempoBpm * 10) / 10,
    grid: grid.map((v) => Math.round((v / max) * 100) / 100),
    brightnessHz: Math.round(traits.brightnessHz),
    decaySec: traits.decaySec,
    keyPc: traits.keyPc,
    mode: traits.mode,
    offsetSec: bestOffset / 100,
    durationSec: (channels[0]?.length ?? 0) / sampleRate,
  };
}
