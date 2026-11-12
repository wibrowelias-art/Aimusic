import { describe, expect, it } from 'vitest';
import { NUMERIC_KEYS, PARAM_SPECS, PRESET_NAMES, PRESETS, presetCenter } from '../../src/engine/params';
import { createRng } from '../../src/engine/rng';
import { MODES } from '../../src/engine/types';
import {
  LIKE_NARROW,
  LIKE_PULL,
  MAX_WIDTH_SHARE,
  MIN_WIDTH_SHARE,
  MODE_FLOOR,
  applyRating,
  baseLearned,
  basePreset,
  learnFromRatings,
  learnedShifts,
  sampleParams,
  type Rating,
} from '../../src/store/learning';

const mid = (r: { lo: number; hi: number }): number => (r.lo + r.hi) / 2;
const width = (r: { lo: number; hi: number }): number => r.hi - r.lo;

describe('rating loop', () => {
  it('starts at the preset ranges with normalised mode weights', () => {
    const learned = baseLearned();
    for (const name of PRESET_NAMES) {
      expect(learned[name].ranges).toEqual(PRESETS[name].ranges);
      const sum = MODES.reduce((s, m) => s + learned[name].modes[m], 0);
      expect(sum).toBeCloseTo(1, 12);
      expect(learnedShifts(name, learned[name])).toEqual([]);
    }
  });

  it('a like pulls every range towards the liked value and narrows it', () => {
    const before = basePreset('warm');
    const liked = presetCenter('warm', { seed: 1, tempo: 50, density: 1.6, reverbSize: 4.2 });
    liked.tempo = 50; // low end of 50..62
    liked.reverbSize = 4.2; // high end of 3.2..4.2
    const after = applyRating(before, 'warm', liked, 1);
    expect(mid(after.ranges.tempo)).toBeCloseTo(56 + LIKE_PULL * (50 - 56), 9);
    expect(width(after.ranges.tempo)).toBeCloseTo(12 * LIKE_NARROW, 9);
    expect(mid(after.ranges.reverbSize)).toBeGreaterThan(mid(before.ranges.reverbSize));
    expect(after.likes).toBe(1);
    expect(after.dislikes).toBe(0);
    // The untouched input is not modified.
    expect(before.ranges.tempo).toEqual({ lo: 50, hi: 62 });
    const shifted = learnedShifts('warm', after).map((s) => s.key);
    expect(shifted).toContain('tempo');
  });

  it('a dislike pushes the range away from the value and widens it', () => {
    const before = basePreset('sad');
    const disliked = presetCenter('sad', { seed: 1 });
    disliked.tempo = 52; // high end of 42..52
    const after = applyRating(before, 'sad', disliked, -1);
    expect(mid(after.ranges.tempo)).toBeLessThan(mid(before.ranges.tempo));
    expect(width(after.ranges.tempo)).toBeGreaterThan(width(before.ranges.tempo));
    expect(after.dislikes).toBe(1);
  });

  it('many likes converge on the liked value but keep a minimum width', () => {
    let state = basePreset('dreamy');
    const liked = presetCenter('dreamy', { seed: 1 });
    liked.tempo = 48;
    for (let i = 0; i < 60; i++) state = applyRating(state, 'dreamy', liked, 1);
    const base = PRESETS.dreamy.ranges.tempo;
    expect(mid(state.ranges.tempo)).toBeCloseTo(48, 1);
    expect(width(state.ranges.tempo)).toBeCloseTo((base.hi - base.lo) * MIN_WIDTH_SHARE, 9);
  });

  it('ranges always stay inside the knob limits and never invert, whatever is rated', () => {
    const rng = createRng(77);
    for (const name of PRESET_NAMES) {
      let state = basePreset(name);
      for (let i = 0; i < 400; i++) {
        const params = presetCenter(name, { seed: i });
        for (const k of NUMERIC_KEYS) params[k] = rng.range(PARAM_SPECS[k].min, PARAM_SPECS[k].max);
        params.mode = rng.pick(MODES);
        state = applyRating(state, name, params, rng.chance(0.5) ? 1 : -1);
        for (const k of NUMERIC_KEYS) {
          const r = state.ranges[k];
          const base = PRESETS[name].ranges[k];
          expect(r.lo).toBeGreaterThanOrEqual(PARAM_SPECS[k].min - 1e-9);
          expect(r.hi).toBeLessThanOrEqual(PARAM_SPECS[k].max + 1e-9);
          expect(r.hi).toBeGreaterThanOrEqual(r.lo - 1e-12);
          expect(width(r)).toBeLessThanOrEqual((base.hi - base.lo) * MAX_WIDTH_SHARE + 1e-9);
          expect(Number.isFinite(r.lo) && Number.isFinite(r.hi)).toBe(true);
        }
        const sum = MODES.reduce((s, m) => s + state.modes[m], 0);
        expect(sum).toBeCloseTo(1, 9);
        for (const m of MODES) expect(state.modes[m]).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('a zero-width range (rain in Warm) can still be pulled by a liked value', () => {
    const liked = presetCenter('warm', { seed: 1 });
    liked.rain = 0.4;
    const after = applyRating(basePreset('warm'), 'warm', liked, 1);
    expect(after.ranges.rain.lo).toBeCloseTo(0.1, 9);
    expect(after.ranges.rain.hi).toBeCloseTo(0.1, 9);
  });

  it('modes: a like raises the weight, a dislike lowers it, preset modes never vanish', () => {
    const params = presetCenter('sad', { seed: 1, mode: 'dorian' });
    const liked = applyRating(basePreset('sad'), 'sad', params, 1);
    expect(liked.modes.dorian).toBeGreaterThan(basePreset('sad').modes.dorian);
    let state = basePreset('sad');
    for (let i = 0; i < 50; i++) state = applyRating(state, 'sad', params, -1);
    expect(state.modes.dorian).toBeGreaterThanOrEqual(MODE_FLOOR / 2);
    expect(state.modes.dorian).toBeLessThan(basePreset('sad').modes.dorian);
    // A mode from outside the preset gets in when it is liked.
    const outside = applyRating(basePreset('sad'), 'sad', presetCenter('sad', { seed: 1, mode: 'lydian' }), 1);
    expect(outside.modes.lydian).toBeGreaterThan(0.05);
  });

  it('learnFromRatings is a pure fold: order kept, removing a rating removes its effect', () => {
    const a: Rating = { preset: 'warm', params: { ...presetCenter('warm', { seed: 1 }), tempo: 50 }, value: 1 };
    const b: Rating = { preset: 'cave', params: { ...presetCenter('cave', { seed: 2 }), density: 1.3 }, value: -1 };
    const both = learnFromRatings([a, b]);
    expect(both.warm).toEqual(applyRating(basePreset('warm'), 'warm', a.params, 1));
    expect(both.cave).toEqual(applyRating(basePreset('cave'), 'cave', b.params, -1));
    expect(both.sad).toEqual(basePreset('sad'));
    expect(learnFromRatings([a]).cave).toEqual(basePreset('cave'));
    expect(learnFromRatings([])).toEqual(baseLearned());
  });
});

describe('sampleParams', () => {
  it('draws inside the ranges, deterministically, with valid snapped params', () => {
    for (const name of PRESET_NAMES) {
      const state = basePreset(name);
      for (let seed = 1; seed <= 200; seed++) {
        const p = sampleParams(state, createRng(seed).fork('params'), { seed });
        const again = sampleParams(state, createRng(seed).fork('params'), { seed });
        expect(again).toEqual(p);
        expect(p.seed).toBe(seed);
        expect(p.variation).toBe(0);
        for (const k of NUMERIC_KEYS) {
          const r = state.ranges[k];
          const step = PARAM_SPECS[k].step;
          expect(p[k]).toBeGreaterThanOrEqual(r.lo - step / 2 - 1e-9);
          expect(p[k]).toBeLessThanOrEqual(r.hi + step / 2 + 1e-9);
        }
        expect(state.modes[p.mode]).toBeGreaterThan(0);
        expect(p.key).toBeGreaterThanOrEqual(0);
        expect(p.key).toBeLessThanOrEqual(11);
      }
    }
  });

  it('pins are used as they are and do not change the other draws', () => {
    const state = basePreset('warm');
    const free = sampleParams(state, createRng(5), { seed: 5 });
    const pinned = sampleParams(state, createRng(5), { seed: 5, pins: { tempo: 70, mode: 'aeolian', key: 3, rain: 0.5 } });
    expect(pinned.tempo).toBe(70);
    expect(pinned.mode).toBe('aeolian');
    expect(pinned.key).toBe(3);
    expect(pinned.rain).toBe(0.5);
    expect(pinned.density).toBe(free.density);
    expect(pinned.reverbSize).toBe(free.reverbSize);
    expect(pinned.length).toBe(free.length);
  });

  it('all modes and keys of a preset show up over many draws', () => {
    const state = basePreset('warm');
    const modes = new Set<string>();
    const keys = new Set<number>();
    for (let seed = 1; seed <= 300; seed++) {
      const p = sampleParams(state, createRng(seed), { seed });
      modes.add(p.mode);
      keys.add(p.key);
    }
    expect([...modes].sort()).toEqual(['dorian', 'lydian', 'majorPentatonic']);
    expect(keys.size).toBe(12);
  });
});
