/**
 * The lo-fi chain's knobs: one entry per stage, with range, step and what the value means.
 * Every number that shapes the result lives here or in `constants.ts`, so TUNING.md can
 * quote it.
 */

export type RoomType = 'room' | 'hall';

export interface PostFxSettings {
  /** Tape saturation, 0..1 (0 = stage bypassed). */
  saturation: number;
  /** Wow and flutter depth, 0..1 (0 = none). */
  wobble: number;
  /** Slow pitch drift, 0..1 (0 = none). */
  drift: number;
  /** Tape high-cut in Hz (24 dB/oct). At the top of the range the filter is bypassed. */
  highCutHz: number;
  /** Reverb amount, 0..1 (0 = dry). */
  room: number;
  /** Small room (short) or big hall (long). */
  roomType: RoomType;
  /** Bedroom mic, 0..1: narrower stereo, low-mid boost, low-cut, light compression. */
  mic: number;
  /** Hiss and room tone, RMS in dBFS of the finished file. Below HISS_MIN_DB = off. */
  hissDb: number;
  /** Slowed: playback this many percent slower (pitch and tempo drop together). 0 = off. */
  slowedPct: number;
  /** Vocal blur, 0..1: low-pass and reverb on the vocal stem. Needs stems; ignored without. */
  vocalBlur: number;
}

export type PostFxNumericKey = Exclude<keyof PostFxSettings, 'roomType'>;

export interface PostFxSpec {
  label: string;
  min: number;
  max: number;
  step: number;
  /** What the knob does, for the tooltip. */
  title: string;
}

/** Loudest hiss the chain will ever add ("never loud"). */
export const HISS_MAX_DB = -45;
/** Quietest hiss that still counts as on. */
export const HISS_MIN_DB = -60;
/** Knob position that means "no hiss" (one step under the range). */
export const HISS_OFF_DB = -61;
/** The high-cut is bypassed at this value. */
export const HIGH_CUT_OFF_HZ = 16000;
export const SLOWED_MAX_PCT = 25;

export const POSTFX_SPECS: Record<PostFxNumericKey, PostFxSpec> = {
  saturation: { label: 'Saturation', min: 0, max: 1, step: 0.01, title: 'Tape saturation: soft clipping of the peaks' },
  wobble: { label: 'Wow / flutter', min: 0, max: 1, step: 0.01, title: 'Slow and fast pitch wobble of a tape transport' },
  drift: { label: 'Drift', min: 0, max: 1, step: 0.01, title: 'Very slow pitch drift' },
  highCutHz: { label: 'High-cut', min: 4000, max: HIGH_CUT_OFF_HZ, step: 250, title: 'Tape high-cut, 24 dB per octave' },
  room: { label: 'Room', min: 0, max: 1, step: 0.01, title: 'Reverb amount (small room or big hall, see the switch)' },
  mic: { label: 'Bedroom mic', min: 0, max: 1, step: 0.01, title: 'Narrower stereo, low-mid boost, low-cut and light compression' },
  hissDb: { label: 'Hiss', min: HISS_OFF_DB, max: HISS_MAX_DB, step: 1, title: 'Hiss and room tone level in the finished file' },
  slowedPct: { label: 'Slowed', min: 0, max: SLOWED_MAX_PCT, step: 1, title: 'Slower playback: pitch and tempo drop together, with extra reverb' },
  vocalBlur: { label: 'Vocal blur', min: 0, max: 1, step: 0.01, title: 'Low-pass and reverb on the vocal stem (needs stems)' },
};

export const POSTFX_KEYS = Object.keys(POSTFX_SPECS) as PostFxNumericKey[];

/** A chain that changes nothing but the loudness. */
export const POSTFX_CLEAN: PostFxSettings = {
  saturation: 0,
  wobble: 0,
  drift: 0,
  highCutHz: HIGH_CUT_OFF_HZ,
  room: 0,
  roomType: 'room',
  mic: 0,
  hissDb: HISS_OFF_DB,
  slowedPct: 0,
  vocalBlur: 0,
};

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Clamps every knob to its range and snaps it to its step. Unknown values fall back to clean. */
export function normalizePostFx(input: Partial<PostFxSettings>): PostFxSettings {
  const out: PostFxSettings = { ...POSTFX_CLEAN };
  for (const key of POSTFX_KEYS) {
    const spec = POSTFX_SPECS[key];
    const raw = input[key];
    if (typeof raw !== 'number' || !Number.isFinite(raw)) continue;
    const snapped = spec.min + Math.round((clamp(raw, spec.min, spec.max) - spec.min) / spec.step) * spec.step;
    out[key] = Number(clamp(snapped, spec.min, spec.max).toFixed(4));
  }
  if (input.roomType === 'hall' || input.roomType === 'room') out.roomType = input.roomType;
  return out;
}

/**
 * Blend of two presets: `t` = 0 gives `a`, 1 gives `b`. Numbers move linearly (the
 * high-cut on a log scale); the room type is the one of the bigger share. Hiss that is
 * off on one side fades in from the bottom of its range.
 */
export function mixPostFx(a: PostFxSettings, b: PostFxSettings, t: number): PostFxSettings {
  const w = clamp(t, 0, 1);
  const lerp = (x: number, y: number): number => x + (y - x) * w;
  const out: Partial<PostFxSettings> = { roomType: w < 0.5 ? a.roomType : b.roomType };
  for (const key of POSTFX_KEYS) {
    if (key === 'highCutHz') {
      out.highCutHz = Math.exp(lerp(Math.log(a.highCutHz), Math.log(b.highCutHz)));
    } else {
      out[key] = lerp(a[key], b[key]);
    }
  }
  // Room amount: only the dominant side's room type sounds, so scale by how dominant it is
  // when the two types differ (at 50/50 a mix of a dry room and a hall is not a full hall).
  if (a.roomType !== b.roomType) {
    const dominant = w < 0.5 ? a : b;
    const share = w < 0.5 ? 1 - w : w;
    out.room = dominant.room * share;
  }
  return normalizePostFx(out);
}

/** Text for a knob value, e.g. "9.5 kHz", "-54 dB", "off". */
export function postFxLabel(key: PostFxNumericKey, value: number): string {
  switch (key) {
    case 'highCutHz':
      return value >= HIGH_CUT_OFF_HZ ? 'off' : `${(value / 1000).toFixed(value % 1000 === 0 ? 0 : 1)} kHz`;
    case 'hissDb':
      return value < HISS_MIN_DB ? 'off' : `${Math.round(value)} dB`;
    case 'slowedPct':
      return value <= 0 ? 'off' : `-${Math.round(value)}%`;
    default:
      return `${Math.round(value * 100)}%`;
  }
}
