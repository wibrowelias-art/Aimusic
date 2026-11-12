/**
 * Hiss and room tone, synthesised: band-limited noise in two bands (a high one for the
 * hiss, a low one for the room), different in the two channels. Pure and deterministic.
 * The result is scaled to an exact RMS level, so the number on the knob is the number
 * in the file.
 */
import { biquadInPlace, dbToGain, highpassCoeffs, lowpassCoeffs } from '../audio/dsp';
import { mulberry32, subSeed } from '../audio/rng';
import type { StereoPcm } from '../audio/types';
import { HISS_BAND_HZ, TONE_BAND_HZ, TONE_POWER_SHARE } from './constants';
import { HISS_MAX_DB, HISS_MIN_DB } from './settings';

function band(n: number, sampleRate: number, seed: number, loHz: number, hiHz: number): Float64Array {
  const rand = mulberry32(seed);
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = rand() * 2 - 1;
  const hp = highpassCoeffs(sampleRate, loHz);
  const lp = lowpassCoeffs(sampleRate, hiHz);
  biquadInPlace(x, hp);
  biquadInPlace(x, hp);
  biquadInPlace(x, lp);
  biquadInPlace(x, lp);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += x[i] * x[i];
  const norm = 1 / Math.sqrt(sum / n || 1);
  for (let i = 0; i < n; i++) x[i] *= norm;
  return x;
}

/** The level the chain really uses for a knob value: clamped into the allowed range, null = off. */
export function effectiveHissDb(hissDb: number): number | null {
  if (!Number.isFinite(hissDb) || hissDb < HISS_MIN_DB) return null;
  return Math.min(HISS_MAX_DB, hissDb);
}

/**
 * `frames` of stereo noise with an RMS of exactly `rmsDb` dBFS (both channels together).
 * Never louder than HISS_MAX_DB, whatever is asked.
 */
export function buildHiss(frames: number, sampleRate: number, rmsDb: number, seed: number): StereoPcm {
  const level = Math.min(HISS_MAX_DB, rmsDb);
  const out: StereoPcm = [new Float32Array(frames), new Float32Array(frames)];
  if (frames <= 0 || !Number.isFinite(level)) return out;
  const hissGain = Math.sqrt(1 - TONE_POWER_SHARE);
  const toneGain = Math.sqrt(TONE_POWER_SHARE);
  let power = 0;
  const raw: Float64Array[] = [];
  for (let ch = 0; ch < 2; ch++) {
    const hiss = band(frames, sampleRate, subSeed(seed, 10 + ch), HISS_BAND_HZ[0], HISS_BAND_HZ[1]);
    const tone = band(frames, sampleRate, subSeed(seed, 20 + ch), TONE_BAND_HZ[0], TONE_BAND_HZ[1]);
    const mix = new Float64Array(frames);
    for (let i = 0; i < frames; i++) {
      mix[i] = hiss[i] * hissGain + tone[i] * toneGain;
      power += mix[i] * mix[i];
    }
    raw.push(mix);
  }
  const scale = dbToGain(level) / Math.sqrt(power / (2 * frames) || 1);
  for (let ch = 0; ch < 2; ch++) {
    const dst = out[ch];
    const src = raw[ch];
    for (let i = 0; i < frames; i++) dst[i] = src[i] * scale;
  }
  return out;
}
