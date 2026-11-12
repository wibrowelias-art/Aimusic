/**
 * Procedural impulse response of a small room. Pure and deterministic, nothing recorded.
 *
 * A few early reflections inside the first ~30 ms, then a short diffuse tail of
 * band-limited noise where the high bands die sooner. Unit energy gain in the
 * 500-1000 Hz band, like the hall from `audio/reverb.ts`, so "wet 1.0" means the same
 * thing for both.
 */
import { biquadInPlace, dbToGain, highpassCoeffs, lowpassCoeffs } from '../audio/dsp';
import { bandEnergyGain } from '../audio/reverb';
import { mulberry32, subSeed } from '../audio/rng';
import type { StereoPcm } from '../audio/types';
import {
  ROOM_BANDS,
  ROOM_EARLY_COUNT,
  ROOM_EARLY_ENERGY_SHARE,
  ROOM_EARLY_WINDOW_SEC,
  ROOM_PREDELAY_SEC,
  ROOM_REF_BAND_HZ,
  ROOM_SEED,
} from './constants';

const LN_1000 = Math.log(1000);

export function buildRoomIR(sampleRate: number, rt60Sec: number): StereoPcm {
  const rt60 = Math.min(2, Math.max(0.1, rt60Sec));
  const pre = Math.round(ROOM_PREDELAY_SEC * sampleRate);
  const tailLen = Math.ceil(rt60 * 1.6 * sampleRate);
  const len = pre + tailLen;
  const channels: Float32Array[] = [];

  for (let ch = 0; ch < 2; ch++) {
    const acc = new Float64Array(len);
    const band = new Float64Array(tailLen);
    ROOM_BANDS.forEach(([loHz, hiHz, rtMul, densityDb], b) => {
      const rand = mulberry32(subSeed(ROOM_SEED, ch * 16 + b));
      for (let i = 0; i < tailLen; i++) band[i] = rand() * 2 - 1;
      biquadInPlace(band, highpassCoeffs(sampleRate, loHz));
      biquadInPlace(band, lowpassCoeffs(sampleRate, hiHz));
      let sum = 0;
      for (let i = 0; i < tailLen; i++) sum += band[i] * band[i];
      const level = dbToGain(densityDb + 10 * Math.log10(hiHz - loHz)) / Math.sqrt(sum / tailLen || 1);
      const decay = Math.exp(-LN_1000 / (rt60 * rtMul * sampleRate));
      let env = level;
      for (let i = 0; i < tailLen; i++) {
        acc[pre + i] += band[i] * env;
        env *= decay;
      }
    });

    let tailEnergy = 0;
    for (let i = 0; i < len; i++) tailEnergy += acc[i] * acc[i];
    const rand = mulberry32(subSeed(ROOM_SEED, 500 + ch));
    const window = Math.round(ROOM_EARLY_WINDOW_SEC * sampleRate);
    const taps: { index: number; amp: number }[] = [];
    let tapEnergy = 0;
    for (let k = 0; k < ROOM_EARLY_COUNT; k++) {
      const pos = (k + 0.2 + 0.6 * rand()) / ROOM_EARLY_COUNT;
      const amp = (rand() < 0.5 ? -1 : 1) * (1 - 0.5 * pos) * (0.6 + 0.4 * rand());
      taps.push({ index: Math.min(len - 1, pre + Math.round(pos * window)), amp });
      tapEnergy += amp * amp;
    }
    const share = ROOM_EARLY_ENERGY_SHARE;
    const tapScale = Math.sqrt(((share / (1 - share)) * tailEnergy) / (tapEnergy || 1));
    for (const tap of taps) acc[tap.index] += tap.amp * tapScale;

    // Fade the last fifth to exactly zero.
    const fade = Math.max(2, Math.round(tailLen * 0.2));
    for (let i = 0; i < fade; i++) acc[len - fade + i] *= 0.5 + 0.5 * Math.cos((Math.PI * (i + 1)) / fade);
    acc[len - 1] = 0;

    const refGain = bandEnergyGain(acc, sampleRate, ROOM_REF_BAND_HZ[0], ROOM_REF_BAND_HZ[1]);
    const scale = refGain > 0 ? 1 / Math.sqrt(refGain) : 0;
    const out = new Float32Array(len);
    for (let i = 0; i < len; i++) out[i] = acc[i] * scale;
    channels.push(out);
  }
  return [channels[0], channels[1]];
}
