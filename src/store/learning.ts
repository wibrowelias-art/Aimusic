/**
 * The rating loop. Thumbs up / down on a take nudge the ranges its preset draws
 * from when Generate is pressed: a liked value pulls the range towards itself and
 * narrows it a little, a disliked value pushes it away and widens it a little.
 *
 * Pure functions: the learned state is always recomputed from the list of
 * ratings, so removing a rating simply removes its effect.
 */
import {
  MODE_INTERVALS,
  NUMERIC_KEYS,
  PARAM_SPECS,
  PRESET_NAMES,
  PRESETS,
  clamp,
  normalizeParams,
  type PresetName,
  type Range,
} from '../engine/params';
import type { Rng } from '../engine/rng';
import type { Mode, NumericParamKey, Params } from '../engine/types';

/** Share of the distance to a liked value the centre of a range moves. */
export const LIKE_PULL = 0.25;
/** Factor on the width of a range after a like. */
export const LIKE_NARROW = 0.92;
/** Share of the distance to a disliked value the centre moves AWAY from it. */
export const DISLIKE_PUSH = 0.15;
/** Factor on the width of a range after a dislike. */
export const DISLIKE_WIDEN = 1.04;
/** A learned range never gets narrower / wider than these shares of the preset's own width. */
export const MIN_WIDTH_SHARE = 0.35;
export const MAX_WIDTH_SHARE = 1.5;
/** A dislike never counts a value as further away than this share of the knob's whole span. */
export const DISLIKE_REACH_SHARE = 0.25;
/** Added to the weight of a liked mode (weights sum to 1). */
export const MODE_LIKE_BONUS = 0.15;
/** Factor on the weight of a disliked mode. */
export const MODE_DISLIKE_FACTOR = 0.7;
/** A mode the preset itself uses never falls below this weight. */
export const MODE_FLOOR = 0.03;

const MODES = Object.keys(MODE_INTERVALS) as Mode[];

export interface LearnedPreset {
  ranges: Record<NumericParamKey, Range>;
  /** Weights of all four modes, summing to 1. */
  modes: Record<Mode, number>;
  likes: number;
  dislikes: number;
}

export type Learned = Record<PresetName, LearnedPreset>;

export interface Rating {
  preset: PresetName;
  params: Params;
  value: 1 | -1;
}

function baseModes(name: PresetName): Record<Mode, number> {
  const raw = PRESETS[name].modes;
  let sum = 0;
  for (const m of MODES) sum += raw[m] ?? 0;
  const out = {} as Record<Mode, number>;
  for (const m of MODES) out[m] = sum > 0 ? (raw[m] ?? 0) / sum : 1 / MODES.length;
  return out;
}

/** The untouched preset as a learned state. */
export function basePreset(name: PresetName): LearnedPreset {
  const ranges = {} as Record<NumericParamKey, Range>;
  for (const k of NUMERIC_KEYS) ranges[k] = { ...PRESETS[name].ranges[k] };
  return { ranges, modes: baseModes(name), likes: 0, dislikes: 0 };
}

export function baseLearned(): Learned {
  const out = {} as Learned;
  for (const name of PRESET_NAMES) out[name] = basePreset(name);
  return out;
}

function normaliseModes(weights: Record<Mode, number>, name: PresetName): Record<Mode, number> {
  const base = baseModes(name);
  const out = {} as Record<Mode, number>;
  let sum = 0;
  for (const m of MODES) {
    const floor = base[m] > 0 ? MODE_FLOOR : 0;
    out[m] = Math.max(floor, Number.isFinite(weights[m]) ? weights[m] : 0);
    sum += out[m];
  }
  if (!(sum > 0)) return base;
  for (const m of MODES) out[m] /= sum;
  return out;
}

/** One rating applied to the learned state of its preset. Returns a new object. */
export function applyRating(state: LearnedPreset, name: PresetName, params: Params, value: 1 | -1): LearnedPreset {
  const ranges = {} as Record<NumericParamKey, Range>;
  for (const k of NUMERIC_KEYS) {
    const spec = PARAM_SPECS[k];
    const span = spec.max - spec.min;
    const base = PRESETS[name].ranges[k];
    const baseWidth = base.hi - base.lo;
    const { lo, hi } = state.ranges[k];
    const v = clamp(params[k], spec.min, spec.max);
    let centre = (lo + hi) / 2;
    let width = hi - lo;
    if (value > 0) {
      centre += LIKE_PULL * (v - centre);
      width = Math.max(baseWidth * MIN_WIDTH_SHARE, width * LIKE_NARROW);
    } else {
      const reach = DISLIKE_REACH_SHARE * span;
      centre -= DISLIKE_PUSH * clamp(v - centre, -reach, reach);
      width = Math.min(baseWidth * MAX_WIDTH_SHARE, width * DISLIKE_WIDEN);
    }
    width = Math.min(width, span);
    centre = clamp(centre, spec.min + width / 2, spec.max - width / 2);
    ranges[k] = { lo: centre - width / 2, hi: centre + width / 2 };
  }
  const modes = { ...state.modes };
  if (params.mode in modes) {
    if (value > 0) modes[params.mode] += MODE_LIKE_BONUS;
    else modes[params.mode] *= MODE_DISLIKE_FACTOR;
  }
  return {
    ranges,
    modes: normaliseModes(modes, name),
    likes: state.likes + (value > 0 ? 1 : 0),
    dislikes: state.dislikes + (value < 0 ? 1 : 0),
  };
}

/** The learned state after all ratings, applied in order. */
export function learnFromRatings(ratings: readonly Rating[]): Learned {
  const out = baseLearned();
  for (const r of ratings) {
    if (!(r.preset in out)) continue;
    out[r.preset] = applyRating(out[r.preset], r.preset, r.params, r.value);
  }
  return out;
}

export interface RangeShift {
  key: NumericParamKey;
  from: Range;
  to: Range;
}

/** Which ranges differ from the untouched preset by at least one knob step. */
export function learnedShifts(name: PresetName, state: LearnedPreset): RangeShift[] {
  const out: RangeShift[] = [];
  for (const k of NUMERIC_KEYS) {
    const from = PRESETS[name].ranges[k];
    const to = state.ranges[k];
    const step = PARAM_SPECS[k].step;
    if (Math.abs(from.lo - to.lo) >= step || Math.abs(from.hi - to.hi) >= step) out.push({ key: k, from, to });
  }
  return out;
}

export interface SampleOptions {
  seed: number;
  /** Values the user fixed; they are used as they are. */
  pins?: Partial<Params>;
}

/** Draws the settings of a new take from the (learned) ranges of a preset. */
export function sampleParams(state: LearnedPreset, rng: Rng, opts: SampleOptions): Params {
  const pins = opts.pins ?? {};
  const out: Partial<Params> = { seed: opts.seed, variation: 0 };
  // Every value is drawn even when pinned, so that a pin does not change the other draws.
  for (const k of NUMERIC_KEYS) {
    const { lo, hi } = state.ranges[k];
    const drawn = lo + (hi - lo) * rng.next();
    out[k] = pins[k] ?? drawn;
  }
  const mode = rng.weighted(
    MODES,
    MODES.map((m) => state.modes[m]),
  );
  out.mode = pins.mode ?? mode;
  const key = rng.int(0, 11);
  out.key = pins.key ?? key;
  return normalizeParams(out);
}
