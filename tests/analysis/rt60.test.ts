import { describe, expect, it } from 'vitest';
import { analyzeDecay, measureRt60 } from '../../src/analysis/metrics';
import {
  add,
  concat,
  decayingBand,
  decayingNoise,
  fadeOut,
  scale,
  silence,
  sine,
  SR,
  whiteNoise,
} from '../helpers/signals';

const percent = (measured: number, expected: number): string =>
  `${(((measured - expected) / expected) * 100).toFixed(2)} %`;

describe('measureRt60 on exponentially decaying noise', () => {
  it.each([1, 3, 6])('known RT60 of %s s is read within 5 %', (rt) => {
    const errors: number[] = [];
    let first = 0;
    for (const seed of [1, 2, 3]) {
      const measured = measureRt60(decayingNoise({ rt60Sec: rt, seconds: rt * 1.2, seed }), SR);
      if (seed === 1) first = measured;
      errors.push(Math.abs(measured - rt) / rt);
    }
    console.log(
      `[analysis] RT60 ${rt} s: measured ${first.toFixed(4)} s (${percent(first, rt)}), worst of 3 seeds ${(Math.max(...errors) * 100).toFixed(2)} %`,
    );
    expect(Math.max(...errors)).toBeLessThan(0.05);
    // The decay is far cleaner than the required 5 %.
    expect(Math.max(...errors)).toBeLessThan(0.005);
  });

  it('an exact exponential is read exactly', () => {
    // No randomness at all: x[i] = 10^(-3 i / (rt sr)).
    const rt = 2;
    const x = Float32Array.from({ length: SR * 3 }, (_, i) => 0.5 * 10 ** ((-3 * i) / (rt * SR)));
    const d = analyzeDecay(x, SR);
    console.log(`[analysis] RT60 exact exponential 2 s: measured ${d.rt60Sec.toFixed(5)} s, correlation ${d.correlation.toFixed(6)}`);
    expect(d.rt60Sec).toBeCloseTo(rt, 3);
    expect(d.correlation).toBeLessThan(-0.999999);
    expect(d.fitFromDb).toBe(-5);
    expect(d.fitToDb).toBe(-35);
  });

  it('a pre-delay does not change the result and is reported as the onset', () => {
    const rt = 3;
    const reference = measureRt60(decayingNoise({ rt60Sec: rt, seconds: 3.6, seed: 9 }), SR);
    const lines: string[] = [];
    for (const pre of [0.025, 0.25, 1]) {
      const d = analyzeDecay(decayingNoise({ rt60Sec: rt, seconds: 3.6, preDelaySec: pre, seed: 9 }), SR);
      lines.push(`${pre} s -> ${d.rt60Sec.toFixed(4)} s (${percent(d.rt60Sec, rt)}), onset ${d.onsetSec.toFixed(4)} s`);
      expect(Math.abs(d.rt60Sec - rt) / rt).toBeLessThan(0.05);
      expect(d.rt60Sec).toBeCloseTo(reference, 6);
      expect(Math.abs(d.onsetSec - pre)).toBeLessThan(0.002);
    }
    console.log(`[analysis] RT60 3 s with pre-delay ${lines.join('; ')}`);
  });

  it('a noise floor behind the decay is detected and does not lengthen the result', () => {
    const rt = 3;
    const lines: string[] = [];
    for (const floorDb of [-60, -50, -40, -30]) {
      const x = decayingNoise({ rt60Sec: rt, seconds: 4.5, preDelaySec: 0.05, noiseFloorDb: floorDb, seed: 4 });
      const d = analyzeDecay(x, SR);
      const plain = analyzeDecay(x, SR, { subtractNoise: false });
      lines.push(
        `${floorDb} dB -> ${d.rt60Sec.toFixed(3)} s (${percent(d.rt60Sec, rt)}; without subtraction ${percent(plain.rt60Sec, rt)}; fit to ${d.fitToDb.toFixed(1)} dB)`,
      );
      expect(Math.abs(d.rt60Sec - rt) / rt).toBeLessThan(0.05);
      expect(d.noiseSubtracted).toBe(true);
      expect(plain.noiseSubtracted).toBe(false);
      // The floor is found where it was put (relative to the start of the decay).
      expect(Math.abs(d.floorDb - floorDb)).toBeLessThan(1.5);
      // The integration starts where the decay meets the floor: |floor| / 60 * rt after the onset.
      expect(Math.abs(d.truncationSec - d.onsetSec - (-floorDb / 60) * rt)).toBeLessThan(0.1);
      // Subtracting the floor is at least as accurate as only truncating.
      expect(Math.abs(d.rt60Sec - rt)).toBeLessThanOrEqual(Math.abs(plain.rt60Sec - rt) + 0.01);
    }
    console.log(`[analysis] RT60 3 s with noise floor ${lines.join('; ')}`);
  });

  it('noise floors of -30 .. -60 dB under decays of 1, 3 and 6 s: within 2 %', () => {
    let worst = 0;
    for (const rt of [1, 3, 6]) {
      for (const floorDb of [-30, -40, -50, -60]) {
        for (const seed of [1, 2]) {
          const x = decayingNoise({ rt60Sec: rt, seconds: rt * 1.5, preDelaySec: 0.05, noiseFloorDb: floorDb, seed });
          worst = Math.max(worst, Math.abs(measureRt60(x, SR) - rt) / rt);
        }
      }
    }
    console.log(`[analysis] RT60 1 / 3 / 6 s with floors -30 .. -60 dB, 24 cases: worst error ${(worst * 100).toFixed(2)} %`);
    expect(worst).toBeLessThan(0.02);
  });

  it('a fade-out behind the noise floor (the end of a recording) is left out', () => {
    const rt = 3;
    const plain = decayingNoise({ rt60Sec: rt, seconds: 6, noiseFloorDb: -40, seed: 14 });
    const faded = fadeOut(plain, 0.5);
    const reference = analyzeDecay(plain, SR);
    const d = analyzeDecay(faded, SR);
    console.log(
      `[analysis] RT60 3 s, floor -40 dB, 0.5 s fade-out at the end: ${d.rt60Sec.toFixed(3)} s (${percent(d.rt60Sec, rt)}); without the fade ${reference.rt60Sec.toFixed(3)} s`,
    );
    expect(Math.abs(d.rt60Sec - rt) / rt).toBeLessThan(0.05);
    expect(Math.abs(d.rt60Sec - reference.rt60Sec) / rt).toBeLessThan(0.01);
    expect(d.noiseSubtracted).toBe(true);
    expect(Math.abs(d.floorDb + 40)).toBeLessThan(1.5);
    // Shorter decay, higher floor, the fade right behind a short stretch of floor.
    const short = fadeOut(decayingNoise({ rt60Sec: 0.5, seconds: 1, noiseFloorDb: -32, seed: 15 }), 0.3);
    expect(Math.abs(measureRt60(short, SR) - 0.5) / 0.5).toBeLessThan(0.05);
  });

  it('an end fade far below the fit range changes nothing (the shape of the generated reverb)', () => {
    // 3 s of decay (down to -60 dB), the last 0.3 s faded to zero.
    const plain = decayingNoise({ rt60Sec: 3, seconds: 3, seed: 16 });
    const faded = fadeOut(plain, 0.3);
    expect(Math.abs(faded[faded.length - 1])).toBe(0);
    const a = analyzeDecay(plain, SR);
    const b = analyzeDecay(faded, SR);
    expect(Math.abs(b.rt60Sec - a.rt60Sec) / a.rt60Sec).toBeLessThan(0.002);
    expect(b.noiseSubtracted).toBe(false);
    expect(b.fitToDb).toBe(-35);
  });

  it('shortens the fit when the response is cut off early, and says so', () => {
    // Only 0.5 * rt of the decay: the file ends at -30 dB.
    const rt = 3;
    const d = analyzeDecay(decayingNoise({ rt60Sec: rt, seconds: 1.5, seed: 2 }), SR);
    console.log(
      `[analysis] RT60 3 s, file cut at -30 dB: measured ${d.rt60Sec.toFixed(3)} s (${percent(d.rt60Sec, rt)}), fit ${d.fitFromDb} .. ${d.fitToDb.toFixed(1)} dB`,
    );
    expect(Math.abs(d.rt60Sec - rt) / rt).toBeLessThan(0.05);
    expect(d.fitToDb).toBeGreaterThan(-30);
    expect(d.fitToDb).toBeLessThan(-15);
    expect(d.noiseSubtracted).toBe(false);
    expect(d.truncationSec).toBeLessThanOrEqual(1.5);
  });

  it('ignores digital silence after the response', () => {
    const x = decayingNoise({ rt60Sec: 1, seconds: 1.2, seed: 6 });
    const padded = concat(x, silence(3));
    expect(measureRt60(padded, SR)).toBeCloseTo(measureRt60(x, SR), 9);
  });

  it('accepts one channel or several and does not depend on the level', () => {
    const left = decayingNoise({ rt60Sec: 3, seconds: 3.6, seed: 31 });
    const right = decayingNoise({ rt60Sec: 3, seconds: 3.6, seed: 32 });
    const stereo = measureRt60([left, right], SR);
    expect(Math.abs(stereo - 3) / 3).toBeLessThan(0.05);
    expect(measureRt60(left, SR)).toBe(measureRt60([left], SR));
    // Stereo lies between the two channels.
    const l = measureRt60(left, SR);
    const r = measureRt60(right, SR);
    expect(stereo).toBeGreaterThanOrEqual(Math.min(l, r) - 1e-3);
    expect(stereo).toBeLessThanOrEqual(Math.max(l, r) + 1e-3);
    expect(measureRt60(scale(left, 0.001), SR)).toBeCloseTo(l, 4);
  });

  it('other fit ranges (T20, T15) give the same decay time', () => {
    const x = decayingNoise({ rt60Sec: 3, seconds: 3.6, seed: 12 });
    for (const toDb of [-25, -20]) {
      const d = analyzeDecay(x, SR, { toDb });
      expect(d.fitToDb).toBe(toDb);
      expect(Math.abs(d.rt60Sec - 3) / 3).toBeLessThan(0.05);
    }
    expect(Math.abs(measureRt60(x, SR, { fromDb: -10, toDb: -40 }) - 3) / 3).toBeLessThan(0.05);
    expect(() => measureRt60(x, SR, { fromDb: -35, toDb: -5 })).toThrow(RangeError);
    expect(() => measureRt60(x, SR, { fromDb: 3 })).toThrow(RangeError);
    expect(() => measureRt60(x, 0)).toThrow(RangeError);
  });

  it('works at 44.1 kHz and for short decays', () => {
    const x = decayingNoise({ rt60Sec: 0.4, seconds: 0.6, seed: 8, sampleRate: 44100 });
    expect(Math.abs(measureRt60(x, 44100) - 0.4) / 0.4).toBeLessThan(0.05);
  });
});

describe('measureRt60 per frequency band', () => {
  // Low band decays in 3 s, high band (20 dB louder at the start) in 1 s: a reverb with strong damping.
  const low = decayingBand({ loHz: 300, hiHz: 700, rt60Sec: 3, seconds: 3.6, startDb: -32, seed: 41 });
  const high = decayingBand({ loHz: 5000, hiHz: 9000, rt60Sec: 1, seconds: 3.6, startDb: -12, seed: 42 });
  const both = add(low, high);

  it('reads each band on its own', () => {
    const lowRt = measureRt60(both, SR, { bandHz: [200, 1000] });
    const highRt = measureRt60(both, SR, { bandHz: [4000, 12000] });
    const broad = measureRt60(both, SR);
    console.log(
      `[analysis] RT60 per band (3 s below 700 Hz, 1 s above 5 kHz): 200-1000 Hz ${lowRt.toFixed(3)} s, 4-12 kHz ${highRt.toFixed(3)} s, broadband ${broad.toFixed(3)} s`,
    );
    expect(Math.abs(lowRt - 3) / 3).toBeLessThan(0.05);
    expect(Math.abs(highRt - 1) / 1).toBeLessThan(0.05);
    // The broadband curve bends from the fast to the slow decay: one line through it lands in between.
    expect(broad).toBeGreaterThan(highRt * 1.1);
    expect(broad).toBeLessThan(lowRt * 0.9);
  });

  it('an open band edge and a band over everything change nothing', () => {
    const lowOnly = measureRt60(low, SR);
    expect(measureRt60(low, SR, { bandHz: [0, SR] })).toBeCloseTo(lowOnly, 9);
    expect(Math.abs(measureRt60(low, SR, { bandHz: [0, 2000] }) - lowOnly) / lowOnly).toBeLessThan(0.01);
    expect(Math.abs(measureRt60(low, SR, { bandHz: [100, SR] }) - lowOnly) / lowOnly).toBeLessThan(0.01);
    expect(() => measureRt60(low, SR, { bandHz: [1000, 500] })).toThrow(RangeError);
    expect(() => measureRt60(low, SR, { bandHz: [-1, 500] })).toThrow(RangeError);
  });
});

describe('measureRt60 when there is nothing to measure', () => {
  it('returns 0 without throwing', () => {
    const cases: [string, Float32Array | Float32Array[]][] = [
      ['no channels', []],
      ['empty', new Float32Array(0)],
      ['empty stereo', [new Float32Array(0), new Float32Array(0)]],
      ['3 samples', Float32Array.from([0.5, 0.2, 0.1])],
      ['digital silence', silence(1)],
      ['steady noise', whiteNoise({ seconds: 2, seed: 2 })],
      ['steady tone', sine({ hz: 440, seconds: 2, amplitude: 0.5 })],
      ['single click', Float32Array.from({ length: SR }, (_, i) => (i === 100 ? 1 : 0))],
      ['NaN inside', Float32Array.from({ length: 1000 }, (_, i) => (i === 500 ? NaN : 0.1))],
    ];
    for (const [name, x] of cases) {
      const d = analyzeDecay(x, SR);
      expect(d.rt60Sec, name).toBe(0);
      expect(measureRt60(x, SR), name).toBe(0);
      expect(Number.isFinite(d.onsetSec) && Number.isFinite(d.truncationSec), name).toBe(true);
    }
  });

  it('returns 0 when the decay is buried: floor only 15 dB below the start', () => {
    const x = decayingNoise({ rt60Sec: 3, seconds: 4.5, noiseFloorDb: -15, seed: 4 });
    expect(measureRt60(x, SR)).toBe(0);
  });
});
