import { describe, expect, it } from 'vitest';
import {
  MAX_SHIFT_SEMITONES,
  PAD_ATTACK_SEC,
  PAD_OCTAVE_DB,
  PAD_RELEASE_SEC,
  PAD_STOP_RELEASES,
  PIANO_GAIN_DB,
  SAMPLE_RATE,
  VELOCITY_GAIN_EXPONENT,
  VOICE_LP_HZ_MAX,
  VOICE_LP_HZ_MIN,
} from '../../src/audio/constants';
import { biquadInPlace, dbToGain, highpassCoeffs, midiToHz } from '../../src/audio/dsp';
import { lofiCutoffHz, startPadVoice, startPianoVoice, velocityGain, voiceCutoffHz } from '../../src/audio/graph';
import { nearestSample } from '../../src/audio/sampler';
import { measurePitchDeviationCents, peakAbs, rmsDb } from '../../src/analysis';
import { createContext, loadSamples, makeNoiseSampleSet, makeSineSampleSet } from '../fixtures/audio';

const SR = SAMPLE_RATE;
const at = (sec: number): number => Math.round(sec * SR);

describe('voice curves', () => {
  it('velocity gain follows (v / 127) ^ 1.7', () => {
    expect(VELOCITY_GAIN_EXPONENT).toBeCloseTo(1.7, 5);
    expect(velocityGain(127)).toBe(1);
    expect(velocityGain(64)).toBeCloseTo((64 / 127) ** 1.7, 9);
    expect(20 * Math.log10(velocityGain(80) / velocityGain(40))).toBeCloseTo(20 * 1.7 * Math.log10(2), 6);
  });

  it('velocity low-pass: softer is darker, higher pitch is brighter, clamped', () => {
    for (let v = 2; v <= 127; v++) expect(voiceCutoffHz(v, 60)).toBeGreaterThanOrEqual(voiceCutoffHz(v - 1, 60));
    for (let p = 31; p <= 96; p++) expect(voiceCutoffHz(50, p)).toBeGreaterThanOrEqual(voiceCutoffHz(50, p - 1));
    expect(voiceCutoffHz(20, 60)).toBeLessThan(voiceCutoffHz(80, 60) / 3);
    expect(voiceCutoffHz(1, 30)).toBeGreaterThanOrEqual(VOICE_LP_HZ_MIN);
    expect(voiceCutoffHz(127, 96)).toBeLessThanOrEqual(VOICE_LP_HZ_MAX);
    console.log(
      `voice low-pass at C4: v20 ${voiceCutoffHz(20, 60).toFixed(0)} Hz, v40 ${voiceCutoffHz(40, 60).toFixed(0)} Hz, v60 ${voiceCutoffHz(60, 60).toFixed(0)} Hz, v80 ${voiceCutoffHz(80, 60).toFixed(0)} Hz; bus low-pass: lofi 0 ${lofiCutoffHz(0).toFixed(0)} Hz, 0.35 ${lofiCutoffHz(0.35).toFixed(0)} Hz, 1 ${lofiCutoffHz(1).toFixed(0)} Hz`,
    );
    expect(lofiCutoffHz(0)).toBeCloseTo(9000, 6);
    expect(lofiCutoffHz(1)).toBeCloseTo(2200, 6);
    expect(lofiCutoffHz(0.5)).toBeLessThan(lofiCutoffHz(0.25));
  });
});

describe('piano voice (rendered, real samples)', () => {
  async function render(pitch: number, velocity: number, seconds: number, releaseAt: number): Promise<Float32Array[]> {
    const samples = await loadSamples();
    const ctx = createContext(2, at(seconds), SR);
    startPianoVoice(ctx, samples, { pitch, velocity, startAt: 0.05, releaseAt }, ctx.destination);
    const out = await ctx.startRendering();
    return [out.getChannelData(0), out.getChannelData(1)];
  }

  it('is louder at higher velocity by the gain curve', async () => {
    const soft = await render(60, 40, 1.5, Infinity);
    const loud = await render(60, 80, 1.5, Infinity);
    const diffDb = rmsDb(loud, at(0.05), at(1.05)) - rmsDb(soft, at(0.05), at(1.05));
    console.log(`C4 velocity 80 vs 40: level +${diffDb.toFixed(1)} dB (gain curve alone +${(20 * 1.7 * Math.log10(2)).toFixed(1)} dB)`);
    expect(diffDb).toBeGreaterThan(9.5);
    expect(diffDb).toBeLessThan(13);
  });

  it('never plays a held note above its own level (long key down, release at 12 s)', async () => {
    // F#1 is the longest sample (23 s). The gain must sit at `level` until the release.
    const samples = await loadSamples();
    const { sample } = nearestSample(samples, 30);
    const out = await render(30, 64, 14, 12);
    const level = velocityGain(64) * dbToGain(PIANO_GAIN_DB + sample.correctionDb);
    const samplePeak = peakAbs([sample.buffer.getChannelData(0), sample.buffer.getChannelData(1)]);
    expect(peakAbs(out)).toBeLessThanOrEqual(samplePeak * level * 1.05);
    expect(peakAbs(out)).toBeGreaterThan(samplePeak * level * 0.5);
    // Still ringing shortly before the release, 20 dB down 1 s after it (tau 0.35 s = 24.8 dB/s).
    expect(rmsDb(out, at(11.5), at(12))).toBeGreaterThan(-70);
    expect(rmsDb(out, at(13), at(13.5))).toBeLessThan(rmsDb(out, at(11.5), at(12)) - 20);
  });
});

describe('piano voice (rendered, synthetic samples)', () => {
  it('plays the right pitch for shifted notes', async () => {
    // One pure-sine "sample" at C4: the neighbours come from it by playbackRate.
    const set = makeSineSampleSet([60], 3);
    const report: string[] = [];
    for (const pitch of [59, 60, 61, 48, 40]) {
      const ctx = createContext(1, at(2), SR);
      startPianoVoice(ctx, set, { pitch, velocity: 100, startAt: 0, releaseAt: Infinity }, ctx.destination);
      const x = (await ctx.startRendering()).getChannelData(0);
      // Shift is clamped to +-12 semitones for pitches outside the sampled range.
      const expected = midiToHz(Math.max(pitch, 60 - MAX_SHIFT_SEMITONES));
      const measured = measurePitchDeviationCents(x, SR, expected);
      const hz = expected * 2 ** (measured.meanCents / 1200);
      report.push(`${pitch}: ${hz.toFixed(2)} Hz (expected ${expected.toFixed(2)})`);
      expect(measured.analyzedSec).toBeGreaterThan(1.5);
      expect(Math.abs(measured.meanCents)).toBeLessThan(0.5);
      expect(measured.maxCents).toBeLessThan(0.5);
    }
    console.log(`pitch from one C4 sine sample: ${report.join(', ')}`);
  });

  it('is darker at lower velocity (white-noise "sample" through the voice low-pass)', async () => {
    const set = makeNoiseSampleSet(60, 2);
    const bandDb = async (velocity: number): Promise<number> => {
      const ctx = createContext(1, at(1.5), SR);
      startPianoVoice(ctx, set, { pitch: 60, velocity, startAt: 0, releaseAt: Infinity }, ctx.destination);
      const x = (await ctx.startRendering()).getChannelData(0);
      const high = Float32Array.from(x);
      for (let k = 0; k < 4; k++) biquadInPlace(high, highpassCoeffs(SR, 6000));
      // Level above 6 kHz relative to the whole voice: independent of the velocity gain.
      return rmsDb([high], at(0.1), at(1.4)) - rmsDb([x], at(0.1), at(1.4));
    };
    const shares = { v30: await bandDb(30), v60: await bandDb(60), v90: await bandDb(90) };
    console.log(
      `share of a white-noise voice above 6 kHz at C4: v30 ${shares.v30.toFixed(1)} dB, v60 ${shares.v60.toFixed(1)} dB, v90 ${shares.v90.toFixed(1)} dB (cutoffs ${voiceCutoffHz(30, 60).toFixed(0)} / ${voiceCutoffHz(60, 60).toFixed(0)} / ${voiceCutoffHz(90, 60).toFixed(0)} Hz)`,
    );
    expect(shares.v60).toBeGreaterThan(shares.v30 + 6);
    expect(shares.v90).toBeGreaterThan(shares.v60 + 2);
  });
});

describe('pad voice (rendered)', () => {
  it('keeps a long note at its level and releases it (regression: envelope must not run away)', async () => {
    const seconds = 34;
    const startAt = 1;
    const endAt = 21; // 20 s note: much longer than the attack needs to settle
    const ctx = createContext(2, at(seconds), SR);
    startPadVoice(ctx, { pitch: 57, velocity: 127, startAt, endAt }, ctx.destination);
    const out = await ctx.startRendering();
    const x = [out.getChannelData(0), out.getChannelData(1)];

    // Two panned main oscillators at amplitude 1 plus the quiet octave: the peak cannot exceed their sum.
    const ceiling = 2 + dbToGain(PAD_OCTAVE_DB);
    expect(peakAbs(x)).toBeLessThanOrEqual(ceiling);
    expect(peakAbs(x, 0, at(startAt))).toBe(0);

    const sustain = rmsDb(x, at(8), at(12));
    const windows = [4, 8, 12, 16, 19].map((t) => rmsDb(x, at(t), at(t + 2)));
    console.log(
      `pad voice, 20 s note: RMS ${windows.map((v) => v.toFixed(2)).join(' / ')} dBFS at 4 / 8 / 12 / 16 / 19 s; 0.2 s after start ${rmsDb(x, at(startAt + 0.1), at(startAt + 0.3)).toFixed(1)}; at the attack time ${rmsDb(x, at(startAt + PAD_ATTACK_SEC - 0.5), at(startAt + PAD_ATTACK_SEC + 0.5)).toFixed(1)}; one release time after the end ${rmsDb(x, at(endAt + PAD_RELEASE_SEC - 0.25), at(endAt + PAD_RELEASE_SEC + 0.25)).toFixed(1)} dBFS`,
    );
    for (const w of windows) expect(Math.abs(w - sustain)).toBeLessThan(1);
    // Slow attack: far down at first, nearly there after PAD_ATTACK_SEC (95 %).
    expect(rmsDb(x, at(startAt + 0.1), at(startAt + 0.3))).toBeLessThan(sustain - 10);
    expect(rmsDb(x, at(startAt + PAD_ATTACK_SEC - 0.5), at(startAt + PAD_ATTACK_SEC + 0.5))).toBeGreaterThan(sustain - 2);
    // Release: 40 dB down after PAD_RELEASE_SEC, digital silence after the stop.
    const released = rmsDb(x, at(endAt + PAD_RELEASE_SEC - 0.25), at(endAt + PAD_RELEASE_SEC + 0.25));
    expect(released).toBeLessThan(sustain - 35);
    expect(released).toBeGreaterThan(sustain - 45);
    expect(peakAbs(x, at(endAt + PAD_RELEASE_SEC * PAD_STOP_RELEASES + 0.05))).toBe(0);
  });

  it('handles a note shorter than its attack', async () => {
    const ctx = createContext(2, at(10), SR);
    startPadVoice(ctx, { pitch: 57, velocity: 127, startAt: 0.5, endAt: 1.0 }, ctx.destination);
    const out = await ctx.startRendering();
    const x = [out.getChannelData(0), out.getChannelData(1)];
    // The envelope reached 1 - exp(-0.5 / tau) = 49 % and falls from there, without a jump.
    expect(peakAbs(x)).toBeLessThan((2 + dbToGain(PAD_OCTAVE_DB)) * 0.55);
    expect(peakAbs(x)).toBeGreaterThan(0.3);
    expect(rmsDb(x, at(4.5), at(5))).toBeLessThan(rmsDb(x, at(0.9), at(1.1)) - 30);
  });
});
