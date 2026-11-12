/**
 * Generic music theory helpers: scales, scale-step arithmetic, diatonic chord stacks and
 * their labels. Only interval structures live here (what a "minor triad" is). There are no
 * melodies and no chord progressions in this file or anywhere else in the engine.
 */
import { KEY_NAMES, MODE_INTERVALS } from './params';
import type { Mode } from './types';

export function mod(n: number, m: number): number {
  return ((n % m) + m) % m;
}

export function pitchClass(pitch: number): number {
  return mod(pitch, 12);
}

export interface Scale {
  /** Tonic pitch class 0..11. */
  key: number;
  mode: Mode;
  /** Semitones from the tonic, ascending. */
  intervals: readonly number[];
  /** Pitch classes ascending from the tonic. */
  pcs: number[];
  /** Number of tones per octave (5 or 7). */
  size: number;
  /** Note name of every pitch class 0..11 as it is spelled in this key and mode. */
  names: string[];
}

const LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'] as const;
const LETTER_PC = [0, 2, 4, 5, 7, 9, 11] as const;
/** Seven-tone scale that gives a mode its note names (the pentatonic is spelled like its major scale). */
const SPELLING_INTERVALS: Record<Mode, readonly number[]> = {
  ...MODE_INTERVALS,
  majorPentatonic: [0, 2, 4, 5, 7, 9, 11],
};

/**
 * Note names of all 12 pitch classes for a key and mode. The seven scale tones get seven
 * different letters (Ab dorian has Gb, not F#); the tonic is spelled with sharps or flats,
 * whichever needs fewer accidentals (the KEY_NAMES spelling wins a tie). Pitch classes
 * outside the scale keep their KEY_NAMES name.
 */
export function spellScale(key: number, mode: Mode): string[] {
  const k = mod(Math.round(key), 12);
  const intervals = SPELLING_INTERVALS[mode];
  let best: { cost: number; names: string[] } | null = null;
  for (let letter = 0; letter < 7; letter++) {
    const tonicAcc = mod(k - LETTER_PC[letter] + 6, 12) - 6;
    if (Math.abs(tonicAcc) > 1) continue;
    const names = [...KEY_NAMES] as string[];
    let cost = 0;
    for (let d = 0; d < 7; d++) {
      const l = (letter + d) % 7;
      const pc = (k + intervals[d]) % 12;
      const acc = mod(pc - LETTER_PC[l] + 6, 12) - 6;
      cost += Math.abs(acc) + (Math.abs(acc) > 1 ? 100 : 0);
      names[pc] = LETTERS[l] + (acc > 0 ? '#'.repeat(acc) : 'b'.repeat(-acc));
    }
    // The usual spelling of the tonic wins a tie.
    if (names[k] === KEY_NAMES[k]) cost -= 0.5;
    if (!best || cost < best.cost) best = { cost, names };
  }
  return best ? best.names : ([...KEY_NAMES] as string[]);
}

/** Name of the tonic as it is spelled in this key and mode, e.g. "G#" for G# / Ab aeolian. */
export function keyName(key: number, mode: Mode): string {
  return spellScale(key, mode)[mod(Math.round(key), 12)];
}

export function makeScale(key: number, mode: Mode): Scale {
  const k = mod(Math.round(key), 12);
  const intervals = MODE_INTERVALS[mode];
  return {
    key: k,
    mode,
    intervals,
    pcs: intervals.map((i) => (k + i) % 12),
    size: intervals.length,
    names: spellScale(k, mode),
  };
}

/** Pitch classes of key + mode, ascending from the tonic. */
export function scalePitchClasses(key: number, mode: Mode): number[] {
  return makeScale(key, mode).pcs;
}

export function isInScale(scalePcs: readonly number[], pitch: number): boolean {
  return scalePcs.includes(pitchClass(pitch));
}

/**
 * Scale-step index -> MIDI pitch. Index 0 is the tonic in the lowest MIDI octave
 * (pitch = key), every `scale.size` steps is one octave.
 */
export function pitchOfIndex(scale: Scale, index: number): number {
  const octave = Math.floor(index / scale.size);
  const degree = index - octave * scale.size;
  return scale.key + 12 * octave + scale.intervals[degree];
}

/** Largest scale-step index whose pitch is <= `pitch`. */
export function indexAtOrBelow(scale: Scale, pitch: number): number {
  const rel = pitch - scale.key;
  const octave = Math.floor(rel / 12);
  const within = rel - octave * 12;
  let degree = 0;
  for (let d = 0; d < scale.size; d++) {
    if (scale.intervals[d] <= within) degree = d;
  }
  return octave * scale.size + degree;
}

/** Scale-step index of the scale tone nearest to `pitch` (ties go down). */
export function nearestIndex(scale: Scale, pitch: number): number {
  const below = indexAtOrBelow(scale, pitch);
  const pBelow = pitchOfIndex(scale, below);
  if (pBelow === pitch) return below;
  const pAbove = pitchOfIndex(scale, below + 1);
  return pitch - pBelow <= pAbove - pitch ? below : below + 1;
}

/** True when both pitches are scale tones and neighbours in the scale. */
export function isScaleStep(scale: Scale, a: number, b: number): boolean {
  if (!scale.pcs.includes(pitchClass(a)) || !scale.pcs.includes(pitchClass(b))) return false;
  return Math.abs(indexAtOrBelow(scale, a) - indexAtOrBelow(scale, b)) === 1;
}

/**
 * The colour tone that sets each mode apart, as semitones above the tonic:
 * lydian raised 4th, dorian major 6th, aeolian minor 6th, pentatonic major 6th.
 */
export const CHARACTERISTIC_INTERVAL: Record<Mode, number> = {
  majorPentatonic: 9,
  lydian: 6,
  dorian: 9,
  aeolian: 8,
};

export interface ChordQuality {
  /** Label suffix after the root name ("" = major triad). */
  suffix: string;
  /** Semitones above the root, ascending, root included. */
  intervals: readonly number[];
  /** Relative weight when a colour is drawn for a scale degree. */
  weight: number;
}

/**
 * The chord colours the composer may stack on a scale degree. All of them contain a perfect
 * fifth, so a degree without one (the diminished degree of a mode) gets no chord at all.
 */
export const CHORD_QUALITIES: readonly ChordQuality[] = [
  { suffix: '', intervals: [0, 4, 7], weight: 1.0 },
  { suffix: 'm', intervals: [0, 3, 7], weight: 1.0 },
  { suffix: 'sus2', intervals: [0, 2, 7], weight: 0.35 },
  { suffix: 'sus4', intervals: [0, 5, 7], weight: 0.2 },
  { suffix: 'add9', intervals: [0, 2, 4, 7], weight: 0.7 },
  { suffix: 'm(add9)', intervals: [0, 2, 3, 7], weight: 0.45 },
  { suffix: '6', intervals: [0, 4, 7, 9], weight: 0.4 },
  { suffix: 'm6', intervals: [0, 3, 7, 9], weight: 0.3 },
  { suffix: 'maj7', intervals: [0, 4, 7, 11], weight: 0.6 },
  { suffix: 'm7', intervals: [0, 3, 7, 10], weight: 0.6 },
  { suffix: 'maj9', intervals: [0, 2, 4, 7, 11], weight: 0.3 },
  { suffix: 'm9', intervals: [0, 2, 3, 7, 10], weight: 0.3 },
  { suffix: '6/9', intervals: [0, 2, 4, 7, 9], weight: 0.2 },
  { suffix: '7sus4', intervals: [0, 5, 7, 10], weight: 0.12 },
];

/** Chord colours whose tones all lie inside the scale when built on `degree`. */
export function chordOptions(scale: Scale, degree: number): ChordQuality[] {
  const root = scale.pcs[degree];
  return CHORD_QUALITIES.filter((q) => q.intervals.every((iv) => scale.pcs.includes((root + iv) % 12)));
}

export function chordPitchClasses(root: number, quality: ChordQuality): number[] {
  return quality.intervals.map((iv) => (root + iv) % 12);
}

/** Chord label. `names` = Scale.names for the spelling of the key; default: KEY_NAMES. */
export function chordName(root: number, quality: ChordQuality, names: readonly string[] = KEY_NAMES): string {
  return `${names[mod(root, 12)]}${quality.suffix}`;
}

export interface ChordInfo {
  /** Scale-degree index of the root inside the mode (0-based). */
  degree: number;
  /** Root pitch class. */
  root: number;
  /** Chord tones as pitch classes, root first, then ascending by interval. */
  pitchClasses: number[];
  /** Root, third (or the suspended 2nd/4th) and fifth as pitch classes. */
  triad: number[];
  name: string;
}

export function buildChord(scale: Scale, degree: number, quality: ChordQuality): ChordInfo {
  const root = scale.pcs[degree];
  const third =
    quality.intervals.find((iv) => iv === 3 || iv === 4) ?? quality.intervals.find((iv) => iv === 2 || iv === 5) ?? 7;
  return {
    degree,
    root,
    pitchClasses: chordPitchClasses(root, quality),
    triad: [root, (root + third) % 12, (root + 7) % 12],
    name: chordName(root, quality, scale.names),
  };
}

/** All pitches in [lo, hi] whose pitch class is in `pcs`, ascending. */
export function tonesBetween(pcs: readonly number[], lo: number, hi: number): number[] {
  const out: number[] = [];
  for (let p = Math.ceil(lo); p <= hi; p++) {
    if (pcs.includes(pitchClass(p))) out.push(p);
  }
  return out;
}

/** Index of the entry of the ascending list `tones` nearest to `pitch`. Ties go to `tieUp`. */
export function nearestToneIndex(tones: readonly number[], pitch: number, tieUp = false): number {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < tones.length; i++) {
    const d = Math.abs(tones[i] - pitch);
    if (d < bestDist || (d === bestDist && tieUp)) {
      best = i;
      bestDist = d;
    }
  }
  return best;
}

/** "C4", "F#2", "Bb5" (MIDI 60 = C4). */
export function pitchName(pitch: number): string {
  return `${KEY_NAMES[pitchClass(pitch)]}${Math.floor(pitch / 12) - 1}`;
}
