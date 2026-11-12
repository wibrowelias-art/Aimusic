/**
 * The lo-fi chain on synthetic input under node-web-audio-api: every stage has to move
 * the number it is there for, and the finished file has to meet the loudness and peak rules.
 */
import { describe, expect, it } from 'vitest';
import { integratedLufs, truePeakDb } from '../../src/analysis/loudness';
import { measurePitchDeviationCents } from '../../src/analysis/metrics';
import { biquadInPlace, highpassCoeffs } from '../../src/audio/dsp';
import type { StereoPcm } from '../../src/audio/types';
import { renderPostFx, sideOverMidDb } from '../../src/postfx/chain';
import { HALL_RT60_SEC, TARGET_LUFS } from '../../src/postfx/constants';
import { POSTFX_CLEAN, type PostFxSettings } from '../../src/postfx/settings';
import { createContext } from '../fixtures/audio';
import { add, silence, sine, SR, whiteNoise } from '../helpers/signals';

const deps = { createContext, seed: 11 };
const fx = (over: Partial<PostFxSettings>): PostFxSettings => ({ ...POSTFX_CLEAN, ...over });

/** Wide noise: different in the two channels. */
function noiseInput(seconds: number): StereoPcm {
  return [whiteNoise({ seconds, rmsDb: -24, seed: 21 }), whiteNoise({ seconds, rmsDb: -24, seed: 22 })];
}
function toneInput(hz: number, seconds: number): StereoPcm {
  const x = sine({ hz, seconds, amplitude: 0.25 });
  return [x, x.slice()];
}
const rmsDb = (x: Float32Array, from = 0, to = x.length): number => {
  let s = 0;
  for (let i = from; i < to; i++) s += x[i] * x[i];
  return 10 * Math.log10(s / Math.max(1, to - from) || 1e-30);
};
/** Level of everything above `hz`, relative to the whole signal, dB. */
function shareAboveDb(x: Float32Array, hz: number): number {
  const hi = Float64Array.from(x);
  const c = highpassCoeffs(SR, hz);
  biquadInPlace(hi, c);
  biquadInPlace(hi, c);
  return rmsDb(Float32Array.from(hi)) - rmsDb(x);
}
/** Amplitude of one frequency by projection on sine and cosine. */
function partial(x: Float32Array, hz: number, from: number, to: number): number {
  let re = 0;
  let im = 0;
  for (let i = from; i < to; i++) {
    const p = (2 * Math.PI * hz * i) / SR;
    re += x[i] * Math.cos(p);
    im += x[i] * Math.sin(p);
  }
  return (2 * Math.hypot(re, im)) / (to - from);
}

describe('lo-fi chain', () => {
  it('clean settings: only the loudness changes', async () => {
    const input = noiseInput(5);
    const { pcm, report } = await renderPostFx({ sampleRate: SR, full: input }, POSTFX_CLEAN, deps);
    expect(report.durationSec).toBeGreaterThan(5);
    expect(report.durationSec).toBeLessThan(5.2);
    expect(Math.abs(integratedLufs(pcm, SR) - TARGET_LUFS)).toBeLessThanOrEqual(0.5);
    expect(report.master.onTarget).toBe(true);
    expect(report.master.peakDb).toBeLessThanOrEqual(-1);
    expect(truePeakDb(pcm)).toBeLessThanOrEqual(-0.99);
    expect(report.sideDb).toBeCloseTo(report.inputSideDb, 0);
    expect(report.hissDb).toBeNull();
    expect(report.highCutHz).toBeNull();
    expect(report.playbackRate).toBe(1);
  });

  it('is deterministic', async () => {
    const input = noiseInput(3);
    const settings = fx({ saturation: 0.5, wobble: 0.6, drift: 0.5, highCutHz: 9000, room: 0.4, mic: 0.5, hissDb: -52 });
    const a = await renderPostFx({ sampleRate: SR, full: input }, settings, deps);
    const b = await renderPostFx({ sampleRate: SR, full: input }, settings, deps);
    expect(a.pcm[0]).toEqual(b.pcm[0]);
    expect(a.pcm[1]).toEqual(b.pcm[1]);
    expect(a.report.master.onTarget).toBe(true);
    expect(a.report.master.truePeakDb).toBeLessThanOrEqual(-0.99);
  });

  it('high-cut takes the top off', async () => {
    const input = noiseInput(4);
    const clean = await renderPostFx({ sampleRate: SR, full: input }, POSTFX_CLEAN, deps);
    const cut = await renderPostFx({ sampleRate: SR, full: input }, fx({ highCutHz: 8000 }), deps);
    expect(shareAboveDb(clean.pcm[0], 14000)).toBeGreaterThan(-8);
    expect(shareAboveDb(cut.pcm[0], 14000)).toBeLessThan(-25);
    expect(cut.report.centroidHz).toBeLessThan(clean.report.centroidHz * 0.6);
    expect(cut.report.highCutHz).toBe(8000);
  });

  it('bedroom mic narrows the stereo image and lifts the low mids', async () => {
    const input = noiseInput(4);
    const clean = await renderPostFx({ sampleRate: SR, full: input }, POSTFX_CLEAN, deps);
    const mic = await renderPostFx({ sampleRate: SR, full: input }, fx({ mic: 1 }), deps);
    // Width 0.25 scales the side signal by 0.25: 12 dB less side energy.
    expect(sideOverMidDb(clean.pcm) - sideOverMidDb(mic.pcm)).toBeGreaterThan(10);
    expect(sideOverMidDb(clean.pcm) - sideOverMidDb(mic.pcm)).toBeLessThan(14);
    expect(mic.report.centroidHz).toBeLessThan(clean.report.centroidHz);
    expect(mic.report.master.onTarget).toBe(true);
  });

  it('slowed: longer and lower by the same factor, with a hall tail', async () => {
    const input = toneInput(1000, 4);
    const { pcm, report } = await renderPostFx({ sampleRate: SR, full: input }, fx({ slowedPct: 20 }), deps);
    expect(report.playbackRate).toBeCloseTo(0.8, 5);
    expect(report.pitchSemitones).toBeCloseTo(-3.86, 2);
    expect(report.durationSec).toBeCloseTo(4 / 0.8 + HALL_RT60_SEC, 1);
    const pitch = measurePitchDeviationCents(pcm[0].subarray(SR, SR * 4), SR, 800);
    expect(pitch.analyzedSec).toBeGreaterThan(2);
    expect(Math.abs(pitch.meanCents)).toBeLessThan(3);
    // Still ringing one second after the slowed tone has ended.
    const after = Math.round((4 / 0.8 + 1) * SR);
    expect(rmsDb(pcm[0], after, after + SR / 2)).toBeGreaterThan(-60);
  });

  it('wow and flutter move the pitch by about the planned amount', async () => {
    const input = toneInput(1000, 10);
    const still = await renderPostFx({ sampleRate: SR, full: input }, POSTFX_CLEAN, deps);
    const moving = await renderPostFx({ sampleRate: SR, full: input }, fx({ wobble: 1 }), deps);
    const a = measurePitchDeviationCents(still.pcm[0].subarray(SR, SR * 9), SR, 1000);
    const b = measurePitchDeviationCents(moving.pcm[0].subarray(SR, SR * 9), SR, 1000);
    expect(a.maxCents).toBeLessThan(0.5);
    expect(moving.report.wobbleMaxCents).toBeGreaterThan(15);
    expect(moving.report.wobbleMaxCents).toBeLessThanOrEqual(25);
    expect(b.maxCents).toBeGreaterThan(moving.report.wobbleMaxCents * 0.6);
    expect(b.maxCents).toBeLessThan(moving.report.wobbleMaxCents * 1.15);
    expect(Math.abs(b.meanCents)).toBeLessThan(3);
  });

  it('saturation adds odd harmonics', async () => {
    const input = toneInput(220, 3);
    const clean = await renderPostFx({ sampleRate: SR, full: input }, POSTFX_CLEAN, deps);
    const hot = await renderPostFx({ sampleRate: SR, full: input }, fx({ saturation: 1 }), deps);
    const third = (x: Float32Array): number => 20 * Math.log10(partial(x, 660, SR, SR * 2) / partial(x, 220, SR, SR * 2));
    expect(third(clean.pcm[0])).toBeLessThan(-70);
    expect(third(hot.pcm[0])).toBeGreaterThan(-35);
    expect(hot.report.master.onTarget).toBe(true);
  });

  it('hiss sits at the level on the knob', async () => {
    const input = noiseInput(4);
    const without = await renderPostFx({ sampleRate: SR, full: input }, POSTFX_CLEAN, deps);
    const withHiss = await renderPostFx({ sampleRate: SR, full: input }, fx({ hissDb: -50 }), deps);
    expect(without.report.master.limiter.maxReductionDb).toBe(0);
    expect(withHiss.report.master.limiter.maxReductionDb).toBe(0);
    const n = without.pcm[0].length;
    let sum = 0;
    for (let ch = 0; ch < 2; ch++) {
      for (let i = SR; i < n - SR; i++) {
        const d = withHiss.pcm[ch][i] - without.pcm[ch][i];
        sum += d * d;
      }
    }
    expect(10 * Math.log10(sum / (2 * (n - 2 * SR)))).toBeCloseTo(-50, 0);
    expect(withHiss.report.hissDb).toBe(-50);
  });

  it('a hall rings on after the input, a small room does not', async () => {
    const input: StereoPcm = [add(whiteNoise({ seconds: 2, rmsDb: -24, seed: 5 }), silence(2)), whiteNoise({ seconds: 2, rmsDb: -24, seed: 6 })];
    const hall = await renderPostFx({ sampleRate: SR, full: input }, fx({ room: 1, roomType: 'hall' }), deps);
    const room = await renderPostFx({ sampleRate: SR, full: input }, fx({ room: 1, roomType: 'room' }), deps);
    expect(hall.report.durationSec).toBeCloseTo(2 + HALL_RT60_SEC, 1);
    expect(room.report.durationSec).toBeLessThan(3);
    const at = Math.round(3 * SR);
    expect(rmsDb(hall.pcm[0], at, at + SR / 2)).toBeGreaterThan(-55);
    // 0.3 s after the input: the room (RT60 0.45 s) is already far down.
    const soon = Math.round(2.3 * SR);
    expect(rmsDb(room.pcm[0], soon, soon + SR / 5)).toBeLessThan(rmsDb(hall.pcm[0], soon, soon + SR / 5) - 15);
  });

  it('vocal blur needs stems and darkens the vocal stem only', async () => {
    const vocals = noiseInput(3);
    const backing: StereoPcm = [silence(3), silence(3)];
    const full: StereoPcm = [vocals[0].slice(), vocals[1].slice()];
    const noStems = await renderPostFx({ sampleRate: SR, full }, fx({ vocalBlur: 1 }), deps);
    const blurred = await renderPostFx({ sampleRate: SR, full, stems: { vocals, backing } }, fx({ vocalBlur: 1 }), deps);
    expect(noStems.report.vocalBlurApplied).toBe(false);
    expect(blurred.report.vocalBlurApplied).toBe(true);
    expect(blurred.report.centroidHz).toBeLessThan(noStems.report.centroidHz * 0.5);
    expect(blurred.report.durationSec).toBeGreaterThan(noStems.report.durationSec + 3);
  });
});
