/**
 * "My recording + a new melody on top": the owner's own recording plays as it is, and a
 * newly composed melody is laid over it. Optionally the middle of the recording (where a
 * lead usually sits) is dipped a little to make room. Plain arithmetic, deterministic.
 */
import { integratedLufs } from '../analysis/loudness';
import { bandpassCoeffs, biquadInPlace, dbToGain } from '../audio/dsp';
import type { StereoPcm } from '../audio/types';

/** Centre and width of the dip in the mid signal. */
export const DIP_HZ = 1500;
export const DIP_Q = 0.7;
export const DIP_MAX_DB = 12;

export interface OverlayOptions {
  /** 0..DIP_MAX_DB: how far the band around DIP_HZ is turned down in the centre of the recording. */
  dipDb: number;
  /** Loudness of the new melody relative to the recording, LU (negative = quieter). */
  melodyDb: number;
  /** Where the melody starts in the recording, seconds (the first bar line that was found). */
  offsetSec: number;
}

export function overlayMelody(song: StereoPcm, melody: StereoPcm, opts: OverlayOptions, sampleRate: number): StereoPcm {
  const n = song[0].length;
  const out: StereoPcm = [song[0].slice(), song[1].slice()];
  const dip = Math.min(DIP_MAX_DB, Math.max(0, opts.dipDb));
  if (dip > 0) {
    // Take the band out of the mid (L+R) only; the sides stay as they are.
    const band = new Float32Array(n);
    for (let i = 0; i < n; i++) band[i] = 0.5 * (song[0][i] + song[1][i]);
    biquadInPlace(band, bandpassCoeffs(sampleRate, DIP_HZ, DIP_Q));
    const k = 1 - dbToGain(-dip);
    for (let i = 0; i < n; i++) {
      out[0][i] -= k * band[i];
      out[1][i] -= k * band[i];
    }
  }
  const songLufs = integratedLufs(song, sampleRate);
  const melodyLufs = integratedLufs(melody, sampleRate);
  if (!Number.isFinite(songLufs) || !Number.isFinite(melodyLufs)) return out;
  const gain = dbToGain(songLufs + opts.melodyDb - melodyLufs);
  const start = Math.max(0, Math.round(opts.offsetSec * sampleRate));
  const len = Math.min(melody[0].length, n - start);
  for (let ch = 0; ch < 2; ch++) for (let i = 0; i < len; i++) out[ch][start + i] += melody[ch][i] * gain;
  return out;
}
