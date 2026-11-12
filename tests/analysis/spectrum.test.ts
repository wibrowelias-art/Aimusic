import { describe, expect, it } from 'vitest';
import { centroidOfSpectrum, longTermSpectrum, measureAudio, spectralCentroid } from '../../src/analysis/metrics';
import { add, concat, dc, lowpass, scale, silence, sine, SR, whiteNoise } from '../helpers/signals';

function meanSquare(...channels: Float32Array[]): number {
  let sum = 0;
  let count = 0;
  for (const ch of channels) {
    for (const v of ch) sum += v * v;
    count += ch.length;
  }
  return sum / count;
}

function total(power: Float64Array): number {
  return power.reduce((s, v) => s + v, 0);
}

/**
 * Centroid a white signal must have after `poles` one-pole low-passes at `cutoffHz`:
 * numeric integral of f |H(f)|^(2 poles) over 0 .. Nyquist, |H|^2 = (1 - a)^2 / (1 - 2 a cos w + a^2).
 */
function expectedLowpassCentroid(cutoffHz: number, poles: number): number {
  const a = Math.exp((-2 * Math.PI * cutoffHz) / SR);
  const steps = 200000;
  let weighted = 0;
  let sum = 0;
  for (let i = 0; i < steps; i++) {
    const w = ((i + 0.5) * Math.PI) / steps;
    const gain = ((1 - a) ** 2 / (1 - 2 * a * Math.cos(w) + a * a)) ** poles;
    weighted += ((w * SR) / (2 * Math.PI)) * gain;
    sum += gain;
  }
  return weighted / sum;
}

const noise = whiteNoise({ seconds: 10, rmsDb: -20, seed: 3 });

describe('spectral centroid', () => {
  it('white noise: sr / 4', () => {
    const centroid = spectralCentroid([noise], SR);
    console.log(
      `[analysis] centroid, white noise: ${centroid.toFixed(1)} Hz (expected ${SR / 4}, ${(((centroid - SR / 4) / (SR / 4)) * 100).toFixed(3)} %)`,
    );
    expect(Math.abs(centroid - SR / 4) / (SR / 4)).toBeLessThan(0.01);
    expect(measureAudio([noise], SR).spectralCentroidHz).toBe(centroid);
    // The spectrum settings can be passed through measureAudio.
    const custom = { fftSize: 1024, channelMode: 'power' as const };
    expect(measureAudio([noise, noise], SR, { spectrum: custom }).spectralCentroidHz).toBe(
      spectralCentroid([noise, noise], SR, custom),
    );
  });

  it('low-passed noise: lower, and where the filter curve says', () => {
    const results: string[] = [];
    let previous = spectralCentroid([noise], SR);
    for (const cutoff of [8000, 2000, 500]) {
      const centroid = spectralCentroid([lowpass(noise, cutoff, 2)], SR);
      const expected = expectedLowpassCentroid(cutoff, 2);
      results.push(`${cutoff} Hz: ${centroid.toFixed(1)} (expected ${expected.toFixed(1)})`);
      expect(centroid).toBeLessThan(previous);
      expect(Math.abs(centroid - expected) / expected).toBeLessThan(0.02);
      previous = centroid;
    }
    console.log(`[analysis] centroid, noise through 2 one-pole low-passes at ${results.join(', ')}`);
  });

  it('pure tone: its frequency', () => {
    const results: string[] = [];
    for (const hz of [110, 440, 1000, 3000, 9000]) {
      const centroid = spectralCentroid([sine({ hz, seconds: 2, amplitude: 0.5 })], SR);
      results.push(`${hz} -> ${centroid.toFixed(2)}`);
      expect(Math.abs(centroid - hz)).toBeLessThan(0.5);
    }
    console.log(`[analysis] centroid, 2 s pure tones (Hz): ${results.join(', ')}`);
    // A frequency between two bins and a short tone still land within 1 Hz.
    expect(Math.abs(spectralCentroid([sine({ hz: 1234.5, seconds: 2, amplitude: 0.5 })], SR) - 1234.5)).toBeLessThan(0.5);
    expect(Math.abs(spectralCentroid([sine({ hz: 440, seconds: 0.25, amplitude: 0.5 })], SR) - 440)).toBeLessThan(1);
  });

  it('is weighted by energy', () => {
    const low = sine({ hz: 500, seconds: 2, amplitude: 0.4 });
    const high = sine({ hz: 1500, seconds: 2, amplitude: 0.4 });
    expect(spectralCentroid([add(low, high)], SR)).toBeCloseTo(1000, 0);
    // Amplitude 2 : 1 is energy 4 : 1 -> (4 * 500 + 1500) / 5 = 700.
    expect(spectralCentroid([add(low, scale(high, 0.5))], SR)).toBeCloseTo(700, 0);
    // A tone that plays for a quarter of the time has a quarter of the energy.
    const part = concat(sine({ hz: 1500, seconds: 0.5, amplitude: 0.4 }), silence(1.5));
    expect(spectralCentroid([add(low, part)], SR)).toBeCloseTo((4 * 500 + 1500) / 5, 0);
  });

  it('does not depend on the level', () => {
    const tone = add(sine({ hz: 300, seconds: 1, amplitude: 0.3 }), lowpass(noise.subarray(0, SR), 2000));
    const reference = spectralCentroid([tone], SR);
    expect(spectralCentroid([scale(tone, 0.01)], SR)).toBeCloseTo(reference, 3);
    expect(spectralCentroid([scale(tone, 1e-5)], SR)).toBeCloseTo(reference, 0);
  });

  it('a DC offset pulls the centroid down (it is part of the spectrum)', () => {
    const tone = sine({ hz: 1000, seconds: 2, amplitude: 0.2 });
    // DC 0.1: power 0.01 against 0.02 for the tone -> 1000 * 0.02 / 0.03.
    expect(spectralCentroid([add(tone, dc(0.1, 2))], SR)).toBeCloseTo(666.7, -1);
    // Without the lowest bins the tone is back (the DC steps at the file edges leak a little above 20 Hz).
    expect(spectralCentroid([add(tone, dc(0.1, 2))], SR, { minHz: 20 })).toBeCloseTo(1000, -1);
  });

  it('stereo: mono sum by default, per-channel power on request', () => {
    const left = sine({ hz: 500, seconds: 2, amplitude: 0.4 });
    const right = sine({ hz: 1500, seconds: 2, amplitude: 0.4 });
    expect(spectralCentroid([left, right], SR)).toBeCloseTo(1000, 0);
    expect(spectralCentroid([left, right], SR, { channelMode: 'power' })).toBeCloseTo(1000, 0);
    // Identical channels: same as mono.
    expect(spectralCentroid([left, left], SR)).toBe(spectralCentroid([left], SR));
    // Opposite polarity cancels in the mono sum; the per-channel mode still sees the tone.
    const inverted = scale(left, -1);
    expect(spectralCentroid([left, inverted], SR)).toBe(0);
    expect(spectralCentroid([left, inverted], SR, { channelMode: 'power' })).toBeCloseTo(500, 0);
    // Channels of different lengths.
    expect(spectralCentroid([left, right.subarray(0, SR)], SR)).toBeCloseTo((2 * 500 + 1500) / 3, 0);
  });

  it('returns 0 for silence and for an empty signal', () => {
    expect(spectralCentroid([silence(1)], SR)).toBe(0);
    expect(spectralCentroid([silence(1), silence(1)], SR)).toBe(0);
    expect(spectralCentroid([], SR)).toBe(0);
    expect(spectralCentroid([new Float32Array(0)], SR)).toBe(0);
    expect(centroidOfSpectrum({ power: new Float64Array(0), binHz: 10 })).toBe(0);
  });

  it('can be limited to a band', () => {
    const mix = add(sine({ hz: 200, seconds: 1, amplitude: 0.4 }), sine({ hz: 5000, seconds: 1, amplitude: 0.4 }));
    expect(spectralCentroid([mix], SR, { maxHz: 1000 })).toBeCloseTo(200, 0);
    expect(spectralCentroid([mix], SR, { minHz: 1000 })).toBeCloseTo(5000, 0);
    expect(spectralCentroid([mix], SR, { minHz: 10000, maxHz: 12000 })).toBeLessThan(12001);
    expect(spectralCentroid([mix], SR, { minHz: 30000 })).toBe(0);
  });
});

describe('longTermSpectrum', () => {
  it('describes its bins', () => {
    const lts = longTermSpectrum([noise], SR);
    expect(lts.sampleRate).toBe(SR);
    expect(lts.fftSize).toBe(4096);
    expect(lts.hopSize).toBe(1024);
    expect(lts.binHz).toBeCloseTo(SR / 4096, 12);
    expect(lts.power.length).toBe(2049);
    expect(lts.frames).toBe(Math.ceil((noise.length + 3072) / 1024));
    const small = longTermSpectrum([noise], SR, { fftSize: 1024, hopSize: 512 });
    expect(small.power.length).toBe(513);
    expect(small.hopSize).toBe(512);
  });

  it('the bins add up to the mean square of the signal (to 1e-9)', () => {
    const cases: [string, Float32Array][] = [
      ['white noise', noise],
      ['tone', sine({ hz: 997, seconds: 1.7, amplitude: 0.3 })],
      ['click', Float32Array.from({ length: 30000 }, (_, i) => (i === 12345 ? 0.8 : 0))],
      ['shorter than a window', sine({ hz: 300, seconds: 0.01, amplitude: 0.5 })],
      ['one sample', Float32Array.from([0.25])],
    ];
    let worst = 0;
    for (const [name, x] of cases) {
      const sum = total(longTermSpectrum([x], SR).power);
      const error = Math.abs(sum / meanSquare(x) - 1);
      worst = Math.max(worst, error);
      expect(error, name).toBeLessThan(1e-9);
    }
    console.log(`[analysis] long-term spectrum: sum of bins vs mean square, worst relative error ${worst.toExponential(2)}`);
  });

  it('every sample has the same weight: a click counts the same wherever it is', () => {
    const totals: number[] = [];
    const centroids: number[] = [];
    for (const at of [0, 1, 511, 1024, 3000, 4095, 4096, 9999, 19999]) {
      const x = new Float32Array(20000);
      x[at] = 0.5;
      const lts = longTermSpectrum([x], SR);
      totals.push(total(lts.power));
      centroids.push(centroidOfSpectrum(lts));
    }
    for (const t of totals) expect(t / totals[0]).toBeCloseTo(1, 9);
    // A click is white: centroid sr / 4 at every position.
    for (const c of centroids) expect(c).toBeCloseTo(SR / 4, 3);
  });

  it('stereo: mono mode measures the mono sum, power mode the mean channel power', () => {
    const left = whiteNoise({ seconds: 2, seed: 21 });
    const right = whiteNoise({ seconds: 2, seed: 22 });
    const mono = Float32Array.from(left, (v, i) => 0.5 * (v + right[i]));
    expect(total(longTermSpectrum([left, right], SR).power) / meanSquare(mono)).toBeCloseTo(1, 6);
    expect(total(longTermSpectrum([left, right], SR, { channelMode: 'power' }).power) / meanSquare(left, right)).toBeCloseTo(1, 9);
    // Three channels take the general path.
    const third = whiteNoise({ seconds: 2, seed: 23 });
    const mono3 = Float32Array.from(left, (v, i) => (v + right[i] + third[i]) / 3);
    expect(total(longTermSpectrum([left, right, third], SR).power) / meanSquare(mono3)).toBeCloseTo(1, 6);
  });

  it('shows a tone in the right bin with the right power', () => {
    const lts = longTermSpectrum([sine({ hz: 1500, seconds: 2, amplitude: 0.5 })], SR); // bin 128
    let peak = 0;
    for (let k = 0; k < lts.power.length; k++) if (lts.power[k] > lts.power[peak]) peak = k;
    expect(peak).toBe(128);
    // Tone power 0.125, spread by the Hann window over bins 127..129.
    expect(lts.power[127] + lts.power[128] + lts.power[129]).toBeCloseTo(0.125, 3);
  });

  it('is empty for an empty signal and rejects impossible settings', () => {
    const empty = longTermSpectrum([], SR);
    expect(empty.frames).toBe(0);
    expect(total(empty.power)).toBe(0);
    expect(() => longTermSpectrum([noise], SR, { fftSize: 1000 })).toThrow(RangeError);
    expect(() => longTermSpectrum([noise], SR, { fftSize: 2 })).toThrow(RangeError);
    expect(() => longTermSpectrum([noise], SR, { hopSize: 0 })).toThrow(RangeError);
    expect(() => longTermSpectrum([noise], SR, { hopSize: 5000 })).toThrow(RangeError);
    expect(() => longTermSpectrum([noise], 0)).toThrow(RangeError);
  });

  it('is deterministic', () => {
    const a = longTermSpectrum([noise], SR);
    const b = longTermSpectrum([Float32Array.from(noise)], SR);
    expect(Buffer.from(a.power.buffer).equals(Buffer.from(b.power.buffer))).toBe(true);
  });
});
