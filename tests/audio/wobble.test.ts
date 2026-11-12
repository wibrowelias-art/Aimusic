import { describe, expect, it } from 'vitest';
import {
  FLUTTER_CENTS,
  FLUTTER_HZ,
  SAMPLE_RATE,
  WOW_A_CENTS,
  WOW_A_HZ,
  WOW_B_CENTS,
  WOW_B_HZ,
} from '../../src/audio/constants';
import { createWobble, startPianoVoice, wobbleDepthCents } from '../../src/audio/graph';
import { createContext, makeSineSampleSet } from '../fixtures/audio';

const SR = SAMPLE_RATE;
const SECONDS = 10;
const MIDI = 81; // A5, 880 Hz
const HZ = 880;

/**
 * Pitch track in cents relative to `hz` from interpolated rising zero crossings,
 * averaged over 20 ms frames. Returns [time, cents] pairs.
 */
function pitchTrack(x: Float32Array, hz: number): [number, number][] {
  const crossings: number[] = [];
  for (let i = 1; i < x.length; i++) {
    if (x[i - 1] < 0 && x[i] >= 0) crossings.push(i - 1 + -x[i - 1] / (x[i] - x[i - 1]));
  }
  const frame = Math.round(0.02 * SR);
  const out: [number, number][] = [];
  let k = 0;
  for (let start = Math.round(0.05 * SR); start + frame < x.length - Math.round(0.05 * SR); start += frame) {
    while (k < crossings.length && crossings[k] < start) k++;
    let last = k;
    while (last + 1 < crossings.length && crossings[last + 1] < start + frame) last++;
    if (last > k) {
      const freq = ((last - k) * SR) / (crossings[last] - crossings[k]);
      out.push([(crossings[k] + crossings[last]) / 2 / SR, 1200 * Math.log2(freq / hz)]);
    }
  }
  return out;
}

function expectedCents(t: number, lofi: number): number {
  const d = wobbleDepthCents(lofi);
  return (
    d.wowA * Math.sin(2 * Math.PI * WOW_A_HZ * t) +
    d.wowB * Math.sin(2 * Math.PI * WOW_B_HZ * t) +
    d.flutter * Math.sin(2 * Math.PI * FLUTTER_HZ * t)
  );
}

/** Renders one sampler voice (pure-sine "sample", no pitch shift) through the wobble path. */
async function renderVoice(lofi: number): Promise<Float32Array> {
  const ctx = createContext(1, SECONDS * SR, SR);
  const set = makeSineSampleSet([MIDI], SECONDS + 1);
  const wobble = createWobble(ctx, lofi, 0);
  startPianoVoice(ctx, set, { pitch: MIDI, velocity: 100, startAt: 0, releaseAt: Infinity }, ctx.destination, wobble);
  return (await ctx.startRendering()).getChannelData(0);
}

function stats(track: [number, number][], lofi: number): { max: number; rmsErr: number } {
  let max = 0;
  let err = 0;
  for (const [t, cents] of track) {
    max = Math.max(max, Math.abs(cents));
    err += (cents - expectedCents(t, lofi)) ** 2;
  }
  return { max, rmsErr: Math.sqrt(err / track.length) };
}

describe('tape wobble', () => {
  it('documents its depth', () => {
    expect(wobbleDepthCents(0).maxTotal).toBe(0);
    expect(wobbleDepthCents(1).wowA + wobbleDepthCents(1).wowB).toBeCloseTo(14, 5);
    expect(WOW_A_CENTS + WOW_B_CENTS).toBe(14);
    for (const hz of [WOW_A_HZ, WOW_B_HZ]) {
      expect(hz).toBeGreaterThanOrEqual(0.3);
      expect(hz).toBeLessThanOrEqual(0.6);
    }
    expect(FLUTTER_HZ).toBeGreaterThanOrEqual(5);
    expect(FLUTTER_HZ).toBeLessThanOrEqual(7);
    expect(FLUTTER_CENTS).toBeLessThan(2);
  });

  it('does not move the pitch of a sampler voice at lofi 0', async () => {
    const s = stats(pitchTrack(await renderVoice(0), HZ), 0);
    console.log(`wobble lofi 0: max |deviation| ${s.max.toFixed(3)} cents`);
    expect(s.max).toBeLessThan(0.1);
  });

  it('moves the pitch of a sampler voice by the documented amount at lofi 1 and 0.5', async () => {
    const full = stats(pitchTrack(await renderVoice(1), HZ), 1);
    const half = stats(pitchTrack(await renderVoice(0.5), HZ), 0.5);
    const bound = wobbleDepthCents(1).maxTotal;
    console.log(
      `wobble lofi 1: max |deviation| ${full.max.toFixed(2)} cents (bound ${bound.toFixed(1)}), RMS error vs LFO formula ${full.rmsErr.toFixed(3)} cents; lofi 0.5: max ${half.max.toFixed(2)} cents, RMS error ${half.rmsErr.toFixed(3)}`,
    );
    expect(full.max).toBeLessThanOrEqual(bound + 0.3);
    expect(full.max).toBeGreaterThan(10);
    expect(full.rmsErr).toBeLessThan(0.5);
    expect(half.max).toBeLessThanOrEqual(bound / 2 + 0.3);
    expect(half.max).toBeGreaterThan(5);
    expect(half.rmsErr).toBeLessThan(0.3);
  });

  it('drives an oscillator detune the same way (pad path)', async () => {
    const ctx = createContext(1, SECONDS * SR, SR);
    const osc = ctx.createOscillator();
    osc.frequency.value = HZ;
    const wobble = createWobble(ctx, 1, 0);
    wobble.connect(osc.detune);
    osc.connect(ctx.destination);
    osc.start(0);
    const s = stats(pitchTrack((await ctx.startRendering()).getChannelData(0), HZ), 1);
    console.log(`wobble on oscillator, lofi 1: max ${s.max.toFixed(2)} cents, RMS error ${s.rmsErr.toFixed(3)} cents`);
    expect(s.max).toBeLessThanOrEqual(wobbleDepthCents(1).maxTotal + 0.3);
    expect(s.max).toBeGreaterThan(10);
    expect(s.rmsErr).toBeLessThan(0.5);
  });
});
