import { describe, expect, it } from 'vitest';
import { integratedLufs } from '../../src/analysis/loudness';
import type { StereoPcm } from '../../src/audio/types';
import { CEILING_DB, TARGET_LUFS, TRUE_PEAK_MAX_DB } from '../../src/postfx/constants';
import { buildHiss, effectiveHissDb } from '../../src/postfx/hiss';
import { limitInPlace, masterInPlace } from '../../src/postfx/master';
import { mixPostFx, normalizePostFx, POSTFX_CLEAN, postFxLabel } from '../../src/postfx/settings';
import { amp, makeRng, silence, sine, SR, whiteNoise } from '../helpers/signals';

const peakOf = (pcm: StereoPcm): number => {
  let p = 0;
  for (const c of pcm) for (const v of c) p = Math.max(p, Math.abs(v));
  return p;
};
const rmsDbOf = (pcm: StereoPcm): number => {
  let s = 0;
  for (const c of pcm) for (const v of c) s += v * v;
  return 10 * Math.log10(s / (2 * pcm[0].length));
};

/** Quiet noise with sparse loud clicks: a lot of crest, so the limiter has to work. */
function peaky(seconds: number, clicks = seconds * 6): StereoPcm {
  const l = whiteNoise({ seconds, rmsDb: -30, seed: 3 });
  const r = whiteNoise({ seconds, rmsDb: -30, seed: 4 });
  const rng = makeRng(9);
  for (let k = 0; k < clicks; k++) {
    const at = Math.floor(rng.next() * (l.length - 200));
    for (let i = 0; i < 120; i++) {
      const v = 0.9 * Math.sin(i * 0.4) * (1 - i / 120);
      l[at + i] += v;
      r[at + i] += v;
    }
  }
  return [l, r];
}

describe('limitInPlace', () => {
  it('leaves no sample above the ceiling and reports what it did', () => {
    const pcm = peaky(4, 2);
    const before = peakOf(pcm);
    const result = limitInPlace(pcm, SR, 0.3);
    expect(before).toBeGreaterThan(0.6);
    expect(peakOf(pcm)).toBeLessThanOrEqual(0.3 + 1e-6);
    expect(result.maxReductionDb).toBeGreaterThan(3);
    expect(result.limitedShare).toBeGreaterThan(0);
    expect(result.limitedShare).toBeLessThan(0.5);
  });

  it('does nothing below the ceiling', () => {
    const x = sine({ hz: 300, seconds: 1, amplitude: 0.2 });
    const pcm: StereoPcm = [x.slice(), x.slice()];
    expect(limitInPlace(pcm, SR, 0.5)).toEqual({ maxReductionDb: 0, limitedShare: 0 });
    expect(pcm[0]).toEqual(x);
  });
});

describe('masterInPlace', () => {
  it('lands on -16 LUFS with the peak under the ceiling', () => {
    for (const level of [-40, -20, -6]) {
      const pcm: StereoPcm = [whiteNoise({ seconds: 6, rmsDb: level, seed: 1 }), whiteNoise({ seconds: 6, rmsDb: level, seed: 2 })];
      const report = masterInPlace(pcm, SR);
      expect(report.onTarget).toBe(true);
      expect(Math.abs(integratedLufs(pcm, SR) - TARGET_LUFS)).toBeLessThanOrEqual(0.5);
      expect(20 * Math.log10(peakOf(pcm))).toBeLessThanOrEqual(CEILING_DB + 0.01);
      expect(report.truePeakDb).toBeLessThanOrEqual(TRUE_PEAK_MAX_DB + 0.01);
    }
  });

  it('keeps the peak rule even when the loudness target cannot be met', () => {
    const pcm = peaky(6);
    const report = masterInPlace(pcm, SR);
    expect(20 * Math.log10(peakOf(pcm))).toBeLessThanOrEqual(CEILING_DB + 0.01);
    expect(report.truePeakDb).toBeLessThanOrEqual(TRUE_PEAK_MAX_DB + 0.01);
    expect(report.limiter.maxReductionDb).toBeGreaterThan(0);
    expect(report.lufs).toBeCloseTo(integratedLufs(pcm, SR), 1);
  });

  it('leaves silence alone', () => {
    const pcm: StereoPcm = [silence(2), silence(2)];
    const report = masterInPlace(pcm, SR, { hiss: buildHiss(2 * SR, SR, -50, 1) });
    expect(report.lufs).toBe(-Infinity);
    expect(peakOf(pcm)).toBe(0);
  });
});

describe('hiss', () => {
  it('has exactly the level asked for and is the same for the same seed', () => {
    for (const db of [-60, -52, -45]) {
      expect(rmsDbOf(buildHiss(SR * 3, SR, db, 7))).toBeCloseTo(db, 1);
    }
    expect(buildHiss(SR, SR, -50, 7)[0]).toEqual(buildHiss(SR, SR, -50, 7)[0]);
    expect(buildHiss(SR, SR, -50, 7)[0]).not.toEqual(buildHiss(SR, SR, -50, 8)[0]);
  });

  it('is never louder than -45 dBFS', () => {
    expect(rmsDbOf(buildHiss(SR * 2, SR, -20, 1))).toBeCloseTo(-45, 1);
    expect(effectiveHissDb(-20)).toBe(-45);
    expect(effectiveHissDb(-61)).toBeNull();
    expect(effectiveHissDb(-60)).toBe(-60);
  });
});

describe('settings', () => {
  it('clamps and snaps', () => {
    const s = normalizePostFx({ saturation: 3, highCutHz: 100, hissDb: -10, slowedPct: 99, roomType: 'hall' });
    expect(s.saturation).toBe(1);
    expect(s.highCutHz).toBe(4000);
    expect(s.hissDb).toBe(-45);
    expect(s.slowedPct).toBe(25);
    expect(s.roomType).toBe('hall');
    expect(normalizePostFx({})).toEqual(POSTFX_CLEAN);
  });

  it('mixes two presets', () => {
    const a = normalizePostFx({ saturation: 0.2, highCutHz: 8000, room: 0.4, roomType: 'room', hissDb: -50 });
    const b = normalizePostFx({ saturation: 0.6, highCutHz: 12000, room: 0.8, roomType: 'hall', hissDb: -60 });
    expect(mixPostFx(a, b, 0)).toEqual(a);
    expect(mixPostFx(a, b, 1)).toEqual(b);
    const half = mixPostFx(a, b, 0.5);
    expect(half.saturation).toBeCloseTo(0.4, 2);
    expect(half.hissDb).toBe(-55);
    expect(half.highCutHz).toBeGreaterThan(9500);
    expect(half.highCutHz).toBeLessThan(10000);
    expect(mixPostFx(a, b, 0.25).roomType).toBe('room');
    expect(mixPostFx(a, b, 0.75).roomType).toBe('hall');
    expect(mixPostFx(a, b, 0.75).room).toBeCloseTo(0.6, 2);
  });

  it('labels values', () => {
    expect(postFxLabel('highCutHz', 9500)).toBe('9.5 kHz');
    expect(postFxLabel('highCutHz', 16000)).toBe('off');
    expect(postFxLabel('hissDb', -61)).toBe('off');
    expect(postFxLabel('hissDb', -52)).toBe('-52 dB');
    expect(postFxLabel('slowedPct', 18)).toBe('-18%');
    expect(postFxLabel('room', 0.35)).toBe('35%');
    expect(amp(0)).toBe(1);
  });
});
