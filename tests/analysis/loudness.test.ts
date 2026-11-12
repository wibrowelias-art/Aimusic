import { describe, expect, it } from 'vitest';
import { integratedLufs, kWeighting, truePeakDb } from '../../src/analysis/loudness';
import { amp, concat, silence, sine, SR } from '../helpers/signals';

describe('K-weighting', () => {
  it('matches the coefficients printed in BS.1770 at 48 kHz', () => {
    const { shelf, highpass } = kWeighting(48000);
    expect(shelf.b0).toBeCloseTo(1.53512485958697, 6);
    expect(shelf.b1).toBeCloseTo(-2.69169618940638, 6);
    expect(shelf.b2).toBeCloseTo(1.19839281085285, 6);
    expect(shelf.a1).toBeCloseTo(-1.69065929318241, 6);
    expect(shelf.a2).toBeCloseTo(0.73248077421585, 6);
    expect(highpass.a1).toBeCloseTo(-1.99004745483398, 6);
    expect(highpass.a2).toBeCloseTo(0.99007225036621, 6);
  });
});

describe('integratedLufs', () => {
  it('reads -23.0 LUFS for a stereo 1 kHz sine at -23 dBFS (EBU Tech 3341, case 1)', () => {
    const x = sine({ hz: 1000, seconds: 20, amplitude: amp(-23) });
    expect(integratedLufs([x, x], SR)).toBeCloseTo(-23, 1);
  });

  it('reads -3.01 LUFS for a mono 997 Hz sine at full scale', () => {
    const x = sine({ hz: 997, seconds: 10, amplitude: 1 });
    expect(integratedLufs([x], SR)).toBeCloseTo(-3.01, 1);
  });

  it('gates out silence and much quieter parts', () => {
    const loud = sine({ hz: 1000, seconds: 20, amplitude: amp(-23) });
    const quiet = sine({ hz: 1000, seconds: 5, amplitude: amp(-36) });
    const withSilence = concat(silence(8), loud, silence(8));
    // EBU Tech 3341 allows +-0.1 LU: blocks that straddle an edge pull the mean a little.
    expect(Math.abs(integratedLufs([withSilence, withSilence], SR) + 23)).toBeLessThan(0.1);
    const withQuiet = concat(quiet, loud, quiet);
    expect(Math.abs(integratedLufs([withQuiet, withQuiet], SR) + 23)).toBeLessThan(0.1);
  });

  it('is -Infinity for silence and for less than one block', () => {
    expect(integratedLufs([silence(3), silence(3)], SR)).toBe(-Infinity);
    expect(integratedLufs([sine({ hz: 440, seconds: 0.2 })], SR)).toBe(-Infinity);
  });

  it('moves 1 LU per dB', () => {
    const a = sine({ hz: 400, seconds: 5, amplitude: 0.1 });
    const b = sine({ hz: 400, seconds: 5, amplitude: 0.1 * amp(-7) });
    expect(integratedLufs([a, a], SR) - integratedLufs([b, b], SR)).toBeCloseTo(7, 2);
  });
});

describe('truePeakDb', () => {
  it('finds the peak between the samples', () => {
    // fs/4 with a 45 degree phase: every sample is at 0.707 of the real peak.
    const x = sine({ hz: SR / 4, seconds: 1, amplitude: 0.5, phase: Math.PI / 4 });
    let samplePeak = 0;
    for (const v of x) samplePeak = Math.max(samplePeak, Math.abs(v));
    expect(20 * Math.log10(samplePeak)).toBeCloseTo(-9.03, 1);
    expect(truePeakDb([x])).toBeGreaterThan(-6.3);
    expect(truePeakDb([x])).toBeLessThan(-5.9);
  });

  it('equals the sample peak for a slow sine and is -Infinity for silence', () => {
    const x = sine({ hz: 100, seconds: 1, amplitude: 0.25 });
    expect(truePeakDb([x])).toBeCloseTo(-12.04, 1);
    expect(truePeakDb([silence(1)])).toBe(-Infinity);
  });
});
