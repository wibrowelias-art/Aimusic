import type { Mode, NumericParamKey, Params } from './types';

/** Lowest / highest MIDI note the piano sample set covers (F#1 .. C7). */
export const PITCH_MIN = 30;
export const PITCH_MAX = 96;

export const BEATS_PER_BAR = 4;

export interface ParamSpec {
  min: number;
  max: number;
  step: number;
  default: number;
  label: string;
  unit: string;
}

export const PARAM_SPECS: Record<NumericParamKey, ParamSpec> = {
  tempo: { min: 40, max: 72, step: 1, default: 54, label: 'Tempo', unit: 'BPM' },
  density: { min: 0.5, max: 4, step: 0.1, default: 1.8, label: 'Density', unit: 'notes/bar' },
  register: { min: 55, max: 79, step: 1, default: 65, label: 'Register', unit: 'MIDI' },
  restProbability: { min: 0, max: 0.8, step: 0.01, default: 0.35, label: 'Space', unit: '' },
  reverbSize: { min: 3, max: 6, step: 0.1, default: 4.5, label: 'Reverb', unit: 's' },
  lofi: { min: 0, max: 1, step: 0.01, default: 0.35, label: 'Lo-fi', unit: '' },
  length: { min: 30, max: 240, step: 5, default: 95, label: 'Length', unit: 's' },
  pad: { min: 0, max: 1, step: 0.01, default: 0.25, label: 'Pad', unit: '' },
  rain: { min: 0, max: 1, step: 0.01, default: 0, label: 'Rain', unit: '' },
};

export const NUMERIC_KEYS = Object.keys(PARAM_SPECS) as NumericParamKey[];

export const KEY_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'] as const;

export const MODE_LABELS: Record<Mode, string> = {
  majorPentatonic: 'Major pentatonic',
  lydian: 'Lydian',
  dorian: 'Dorian',
  aeolian: 'Aeolian',
};

/** Scale intervals in semitones from the tonic. */
export const MODE_INTERVALS: Record<Mode, readonly number[]> = {
  majorPentatonic: [0, 2, 4, 7, 9],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  aeolian: [0, 2, 3, 5, 7, 8, 10],
};

export const DEFAULT_PARAMS: Params = {
  seed: 1,
  variation: 0,
  key: 0,
  mode: 'majorPentatonic',
  tempo: PARAM_SPECS.tempo.default,
  density: PARAM_SPECS.density.default,
  register: PARAM_SPECS.register.default,
  restProbability: PARAM_SPECS.restProbability.default,
  reverbSize: PARAM_SPECS.reverbSize.default,
  lofi: PARAM_SPECS.lofi.default,
  length: PARAM_SPECS.length.default,
  pad: PARAM_SPECS.pad.default,
  rain: PARAM_SPECS.rain.default,
};

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function snap(v: number, spec: ParamSpec): number {
  const stepped = Math.round((v - spec.min) / spec.step) * spec.step + spec.min;
  // Kill float noise such as 1.7999999999.
  return Number(clamp(stepped, spec.min, spec.max).toFixed(4));
}

/** Clamp + snap every field so that a Params object is always valid and canonical. */
export function normalizeParams(p: Partial<Params>): Params {
  const merged: Params = { ...DEFAULT_PARAMS, ...p };
  const out: Params = {
    ...merged,
    seed: (Number.isFinite(merged.seed) ? Math.floor(merged.seed) : 1) >>> 0,
    variation: Math.max(0, Math.floor(Number.isFinite(merged.variation) ? merged.variation : 0)),
    key: ((Math.round(Number.isFinite(merged.key) ? merged.key : 0) % 12) + 12) % 12,
    mode: merged.mode in MODE_INTERVALS ? merged.mode : DEFAULT_PARAMS.mode,
  };
  for (const k of NUMERIC_KEYS) {
    const v = Number.isFinite(out[k]) ? out[k] : PARAM_SPECS[k].default;
    out[k] = snap(v, PARAM_SPECS[k]);
  }
  return out;
}

/** A range a preset draws a parameter from when Generate is pressed. */
export interface Range {
  lo: number;
  hi: number;
}

export type PresetName = 'warm' | 'sad' | 'dreamy' | 'cave';

export interface Preset {
  name: PresetName;
  label: string;
  blurb: string;
  /** Relative weights of the modes this mood draws from. */
  modes: Partial<Record<Mode, number>>;
  ranges: Record<NumericParamKey, Range>;
}

/**
 * Mood presets. They describe a mood and a sound world only (tempo range,
 * mode colour, space, reverb...). They never describe a specific piece.
 */
export const PRESETS: Record<PresetName, Preset> = {
  warm: {
    name: 'warm',
    label: 'Warm',
    blurb: 'Soft major colours, close room, a little tape.',
    modes: { majorPentatonic: 0.6, lydian: 0.25, dorian: 0.15 },
    ranges: {
      tempo: { lo: 50, hi: 62 },
      density: { lo: 1.6, hi: 2.6 },
      register: { lo: 60, hi: 68 },
      restProbability: { lo: 0.22, hi: 0.4 },
      reverbSize: { lo: 3.2, hi: 4.2 },
      lofi: { lo: 0.4, hi: 0.6 },
      length: { lo: 80, hi: 110 },
      pad: { lo: 0.2, hi: 0.4 },
      rain: { lo: 0, hi: 0 },
    },
  },
  sad: {
    name: 'sad',
    label: 'Sad',
    blurb: 'Minor, slow, more silence between phrases.',
    modes: { aeolian: 0.7, dorian: 0.3 },
    ranges: {
      tempo: { lo: 42, hi: 52 },
      density: { lo: 1.0, hi: 1.8 },
      register: { lo: 57, hi: 65 },
      restProbability: { lo: 0.35, hi: 0.55 },
      reverbSize: { lo: 4.0, hi: 5.2 },
      lofi: { lo: 0.3, hi: 0.5 },
      length: { lo: 85, hi: 120 },
      pad: { lo: 0.1, hi: 0.3 },
      rain: { lo: 0, hi: 0.25 },
    },
  },
  dreamy: {
    name: 'dreamy',
    label: 'Dreamy',
    blurb: 'Lydian shimmer, higher register, long tail, more pad.',
    modes: { lydian: 0.7, majorPentatonic: 0.3 },
    ranges: {
      tempo: { lo: 46, hi: 58 },
      density: { lo: 1.4, hi: 2.4 },
      register: { lo: 67, hi: 76 },
      restProbability: { lo: 0.3, hi: 0.5 },
      reverbSize: { lo: 4.8, hi: 6.0 },
      lofi: { lo: 0.2, hi: 0.45 },
      length: { lo: 85, hi: 120 },
      pad: { lo: 0.35, hi: 0.6 },
      rain: { lo: 0, hi: 0 },
    },
  },
  cave: {
    name: 'cave',
    label: 'Cave',
    blurb: 'Very sparse, low, the longest reverb.',
    modes: { dorian: 0.5, aeolian: 0.5 },
    ranges: {
      tempo: { lo: 40, hi: 48 },
      density: { lo: 0.6, hi: 1.3 },
      register: { lo: 55, hi: 64 },
      restProbability: { lo: 0.5, hi: 0.7 },
      reverbSize: { lo: 5.5, hi: 6.0 },
      lofi: { lo: 0.15, hi: 0.35 },
      length: { lo: 90, hi: 130 },
      pad: { lo: 0.05, hi: 0.2 },
      rain: { lo: 0, hi: 0.2 },
    },
  },
};

export const PRESET_NAMES = Object.keys(PRESETS) as PresetName[];

export function paramLabel(key: NumericParamKey, value: number): string {
  const spec = PARAM_SPECS[key];
  switch (key) {
    case 'tempo':
      return `${Math.round(value)} BPM`;
    case 'density':
      return `${value.toFixed(1)} notes/bar`;
    case 'register': {
      const octave = Math.floor(value / 12) - 1;
      return `${KEY_NAMES[((value % 12) + 12) % 12]}${octave}`;
    }
    case 'reverbSize':
      return `${value.toFixed(1)} s`;
    case 'length': {
      const m = Math.floor(value / 60);
      const s = Math.round(value % 60);
      return `${m}:${String(s).padStart(2, '0')}`;
    }
    default:
      return `${Math.round(((value - spec.min) / (spec.max - spec.min)) * 100)}%`;
  }
}
