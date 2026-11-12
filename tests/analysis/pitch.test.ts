import { describe, expect, it } from 'vitest';
import { measurePitchDeviationCents } from '../../src/analysis/metrics';
import { add, concat, dc, decayFrom, scale, silence, sine, SR, vibratoSine, whiteNoise } from '../helpers/signals';

const cents = (hz: number, offset: number): number => hz * 2 ** (offset / 1200);

describe('measurePitchDeviationCents: steady tones', () => {
  it('a pure sine has no deviation and no LFO', () => {
    const lines: string[] = [];
    for (const hz of [110, 440, 880, 3520]) {
      const p = measurePitchDeviationCents(sine({ hz, seconds: 4, amplitude: 0.5 }), SR, hz);
      lines.push(`${hz} Hz ${p.maxCents.toFixed(5)}`);
      expect(p.maxCents).toBeLessThan(0.01);
      expect(p.rmsCents).toBeLessThan(0.01);
      expect(Math.abs(p.meanCents)).toBeLessThan(0.001);
      expect(p.lfoHz).toBeNull();
      expect(p.lfoCents).toBe(0);
      // Something was measured: most of the 4 s, at the level of the tone.
      expect(p.analyzedSec).toBeGreaterThan(3.5);
      expect(p.toneDb).toBeCloseTo(-6.02, 1);
    }
    console.log(`[analysis] pitch, steady sine: max |deviation| in cents: ${lines.join(', ')}`);
  });

  it('a constant detune is read as the mean deviation', () => {
    for (const offset of [5, -20, 0.3]) {
      const p = measurePitchDeviationCents(sine({ hz: cents(880, offset), seconds: 3 }), SR, 880);
      expect(p.meanCents).toBeCloseTo(offset, 3);
      expect(p.maxCents).toBeCloseTo(Math.abs(offset), 2);
      expect(p.rmsCents).toBeCloseTo(Math.abs(offset), 2);
      expect(p.lfoHz).toBeNull();
    }
  });
});

describe('measurePitchDeviationCents: wobble', () => {
  it('+-10 cents at 0.5 Hz: depth within 1.5 cents, rate within 0.1 Hz', () => {
    const lines: string[] = [];
    for (const hz of [110, 440, 880]) {
      const p = measurePitchDeviationCents(vibratoSine({ hz, depthCents: 10, lfoHz: 0.5, seconds: 10 }), SR, hz);
      lines.push(
        `${hz} Hz: max ${p.maxCents.toFixed(4)}, RMS ${p.rmsCents.toFixed(3)}, LFO ${p.lfoHz?.toFixed(4)} Hz / ${p.lfoCents.toFixed(3)} cents`,
      );
      expect(Math.abs(p.maxCents - 10)).toBeLessThan(1.5);
      expect(p.lfoHz).not.toBeNull();
      expect(Math.abs(p.lfoHz! - 0.5)).toBeLessThan(0.1);
      // Far closer than required.
      expect(Math.abs(p.maxCents - 10)).toBeLessThan(0.05);
      expect(Math.abs(p.lfoHz! - 0.5)).toBeLessThan(0.01);
      expect(Math.abs(p.lfoCents - 10)).toBeLessThan(0.2);
      // RMS of a sine movement over nearly whole cycles: depth / sqrt(2).
      expect(Math.abs(p.rmsCents - 10 / Math.SQRT2)).toBeLessThan(0.2);
      expect(Math.abs(p.meanCents)).toBeLessThan(0.1);
    }
    console.log(`[analysis] pitch, +-10 cents at 0.5 Hz, 10 s: ${lines.join('; ')}`);
  });

  it('reads small and fast movements too (flutter)', () => {
    const p = measurePitchDeviationCents(vibratoSine({ hz: 880, depthCents: 1.2, lfoHz: 6.1, seconds: 6 }), SR, 880);
    console.log(
      `[analysis] pitch, +-1.2 cents at 6.1 Hz: max ${p.maxCents.toFixed(4)}, LFO ${p.lfoHz?.toFixed(4)} Hz / ${p.lfoCents.toFixed(4)} cents`,
    );
    expect(Math.abs(p.maxCents - 1.2)).toBeLessThan(0.02);
    expect(Math.abs(p.lfoHz! - 6.1)).toBeLessThan(0.05);
    expect(Math.abs(p.lfoCents - 1.2)).toBeLessThan(0.02);
    const tiny = measurePitchDeviationCents(vibratoSine({ hz: 880, depthCents: 0.1, lfoHz: 1, seconds: 6 }), SR, 880);
    expect(Math.abs(tiny.maxCents - 0.1)).toBeLessThan(0.005);
    expect(Math.abs(tiny.lfoHz! - 1)).toBeLessThan(0.02);
  });

  it('two slow movements at once: the sum of the depths is the maximum, the stronger one is the LFO', () => {
    // 9 cents at 0.37 Hz plus 5 cents at 0.53 Hz; over 30 s the two line up to 14 cents.
    const options = { hz: 880, depthCents: 9, lfoHz: 0.37, extra: { depthCents: 5, lfoHz: 0.53 }, seconds: 30 };
    const p = measurePitchDeviationCents(vibratoSine(options), SR, 880);
    console.log(
      `[analysis] pitch, 9 cents at 0.37 Hz + 5 cents at 0.53 Hz, 30 s: max ${p.maxCents.toFixed(3)}, RMS ${p.rmsCents.toFixed(3)}, LFO ${p.lfoHz?.toFixed(4)} Hz / ${p.lfoCents.toFixed(3)} cents`,
    );
    expect(p.maxCents).toBeLessThanOrEqual(14.01);
    expect(p.maxCents).toBeGreaterThan(13.8);
    expect(Math.abs(p.rmsCents - Math.sqrt((81 + 25) / 2))).toBeLessThan(0.3);
    expect(Math.abs(p.lfoHz! - 0.37)).toBeLessThan(0.02);
    expect(Math.abs(p.lfoCents - 9)).toBeLessThan(0.3);
  });

  it('the depth scales with the movement', () => {
    for (const depth of [2, 7, 25]) {
      const p = measurePitchDeviationCents(vibratoSine({ hz: 440, depthCents: depth, lfoHz: 0.8, seconds: 8 }), SR, 440);
      expect(Math.abs(p.maxCents - depth) / depth).toBeLessThan(0.01);
      expect(Math.abs(p.lfoHz! - 0.8)).toBeLessThan(0.02);
    }
  });
});

describe('measurePitchDeviationCents: robustness', () => {
  const tone = vibratoSine({ hz: 440, depthCents: 10, lfoHz: 0.5, seconds: 8 });

  it('ignores harmonics, DC and the level of the tone', () => {
    const reference = measurePitchDeviationCents(tone, SR, 440);
    const dressed = add(
      tone,
      sine({ hz: 880, seconds: 8, amplitude: 0.3 }),
      sine({ hz: 1320, seconds: 8, amplitude: 0.2 }),
      dc(0.2, 8),
    );
    const p = measurePitchDeviationCents(dressed, SR, 440);
    expect(p.maxCents).toBeCloseTo(reference.maxCents, 2);
    expect(p.lfoHz).toBeCloseTo(reference.lfoHz!, 3);
    const quiet = measurePitchDeviationCents(scale(tone, 0.001), SR, 440);
    expect(quiet.maxCents).toBeCloseTo(reference.maxCents, 2);
    expect(quiet.toneDb).toBeCloseTo(reference.toneDb - 60, 1);
  });

  it('a little noise adds a little jitter, not a different answer', () => {
    const p = measurePitchDeviationCents(add(tone, whiteNoise({ seconds: 8, rmsDb: -50, seed: 5 })), SR, 440);
    expect(Math.abs(p.maxCents - 10)).toBeLessThan(0.3);
    expect(Math.abs(p.lfoHz! - 0.5)).toBeLessThan(0.01);
  });

  it('analyses only the part where the tone is present', () => {
    const p = measurePitchDeviationCents(concat(tone, silence(4)), SR, 440);
    expect(Math.abs(p.maxCents - 10)).toBeLessThan(0.05);
    expect(p.analyzedSec).toBeGreaterThan(7);
    expect(p.analyzedSec).toBeLessThan(8.1);
    // A tone that fades by 12 dB per second leaves the 30 dB gate after 2.5 s.
    const fading = measurePitchDeviationCents(decayFrom(tone, 0, 12), SR, 440);
    expect(fading.analyzedSec).toBeGreaterThan(2.2);
    expect(fading.analyzedSec).toBeLessThan(2.8);
    expect(Math.abs(fading.maxCents - 10)).toBeLessThan(0.05);
    const wide = measurePitchDeviationCents(decayFrom(tone, 0, 12), SR, 440, { gateDb: 60 });
    expect(wide.analyzedSec).toBeGreaterThan(4.5);
  });

  it('the bandwidth option limits how fast a movement may be', () => {
    const fast = vibratoSine({ hz: 880, depthCents: 5, lfoHz: 12, seconds: 5 });
    const wide = measurePitchDeviationCents(fast, SR, 880, { bandwidthHz: 60 });
    expect(Math.abs(wide.maxCents - 5)).toBeLessThan(0.1);
    expect(Math.abs(wide.lfoHz! - 12)).toBeLessThan(0.1);
    // With a 4 Hz band the 12 Hz side bands are filtered out: the movement disappears.
    const narrow = measurePitchDeviationCents(fast, SR, 880, { bandwidthHz: 4 });
    expect(narrow.maxCents).toBeLessThan(0.5);
    expect(() => measurePitchDeviationCents(fast, SR, 880, { bandwidthHz: 0 })).toThrow(RangeError);
  });

  it('returns zeros, null and analyzedSec 0 when there is no tone, without throwing', () => {
    const cases: [string, Float32Array, number][] = [
      ['empty', new Float32Array(0), 440],
      ['5 samples', Float32Array.from([0.1, 0.2, 0.1, 0, -0.1]), 440],
      ['50 ms', sine({ hz: 440, seconds: 0.05 }), 440],
      ['digital silence', silence(3), 440],
      ['another tone', sine({ hz: 1000, seconds: 3 }), 440],
      ['nominal 0', tone, 0],
      ['nominal negative', tone, -440],
      ['nominal NaN', tone, NaN],
      ['nominal above Nyquist', tone, 30000],
    ];
    for (const [name, x, hz] of cases) {
      const p = measurePitchDeviationCents(x, SR, hz);
      expect(p, name).toEqual({
        maxCents: 0,
        rmsCents: 0,
        lfoHz: null,
        lfoCents: 0,
        meanCents: 0,
        analyzedSec: 0,
        toneDb: -Infinity,
      });
    }
    expect(() => measurePitchDeviationCents(tone, 0, 440)).toThrow(RangeError);
  });

  it('works at 44.1 kHz and is deterministic', () => {
    const x = vibratoSine({ hz: 440, depthCents: 10, lfoHz: 0.5, seconds: 8, sampleRate: 44100 });
    const a = measurePitchDeviationCents(x, 44100, 440);
    const b = measurePitchDeviationCents(Float32Array.from(x), 44100, 440);
    expect(Math.abs(a.maxCents - 10)).toBeLessThan(0.05);
    expect(Math.abs(a.lfoHz! - 0.5)).toBeLessThan(0.01);
    expect(b).toEqual(a);
  });
});
