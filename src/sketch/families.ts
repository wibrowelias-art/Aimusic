/**
 * What the built-in generator plays for each style family: the ranges the composer draws
 * from and the parts of the arrangement. The traits follow the family descriptions in
 * STYLES.md (instruments, tempo feel, structure). There are no notes in here: every pitch
 * comes from the seeded composer at run time.
 */
import type { Mode, SectionName } from '../engine/types';
import type { FamilyId } from '../style/types';
import type { Group, Slot, VoiceId } from './types';

/** What a part plays, derived from the composed piece. */
export type Role =
  | 'melody' // the composed melody line
  | 'chords' // the chord tones, held for the length of each chord
  | 'root' // the chord root, held
  | 'tonic' // the tonic and its fifth, held through the whole piece
  | 'arpeggio' // a picked figure over the chord tones, repeating every bar
  | 'strum' // all chord tones struck one after the other
  | 'bassPulse' // the root on beats 1 and 3
  | 'bassChord' // the root once per chord
  | 'kick'
  | 'snare'
  | 'hat'
  | 'machine' // drum machine tick on the eighths
  | 'thump' // a soft low hit on beat 1
  | 'clicks' // sparse quiet clicks
  | 'air' // a slow noise bed
  | 'voiceLine' // the melody, held from note to note
  | 'voiceChords'; // two chord tones, held

export interface PartSpec {
  id: string;
  label: string;
  voice: VoiceId;
  group: Group;
  slot: Slot;
  role: Role;
  gain: number;
  pan: number;
  drive?: number;
  /** Centre of the part as a MIDI note. */
  centre?: number;
  /** Only in these sections (default: all). */
  sections?: readonly SectionName[];
  /** Silent before this bar (default 0). */
  fromBar?: number;
  /** Timing looseness in seconds (default 0.008). */
  loose?: number;
}

export interface FamilyRecipe {
  modes: Partial<Record<Mode, number>>;
  tempo: readonly [number, number];
  density: readonly [number, number];
  register: readonly [number, number];
  rest: readonly [number, number];
  parts: readonly PartSpec[];
  /** Added when vocals are on. */
  voiceParts: readonly PartSpec[];
}

export const RECIPES: Record<FamilyId, FamilyRecipe> = {
  'ambient-keys': {
    modes: { lydian: 0.4, majorPentatonic: 0.35, dorian: 0.25 },
    tempo: [50, 62],
    density: [0.9, 1.6],
    register: [62, 72],
    rest: [0.35, 0.5],
    parts: [
      { id: 'pad', label: 'synth pad', voice: 'pad', group: 'pads', slot: 'chords', role: 'chords', gain: 0.5, pan: 0, centre: 62 },
      { id: 'organ', label: 'organ-like chords', voice: 'organ', group: 'pads', slot: 'chords', role: 'chords', gain: 0.2, pan: 0.15, centre: 55 },
      { id: 'keys', label: 'soft keys', voice: 'keys', group: 'keys', slot: 'melody', role: 'melody', gain: 0.55, pan: -0.1 },
      { id: 'sub', label: 'low synth bass', voice: 'sub', group: 'bass', slot: 'bass', role: 'root', gain: 0.4, pan: 0, centre: 38 },
      { id: 'clicks', label: 'faint clicks', voice: 'tick', group: 'texture', slot: 'texture', role: 'clicks', gain: 0.07, pan: 0.4 },
    ],
    voiceParts: [{ id: 'voice', label: 'wordless voice', voice: 'voice', group: 'voice', slot: 'voice', role: 'voiceChords', gain: 0.22, pan: 0, centre: 64 }],
  },
  'bedroom-demo': {
    modes: { majorPentatonic: 0.4, dorian: 0.35, lydian: 0.25 },
    tempo: [60, 70],
    density: [1.2, 2.0],
    register: [60, 70],
    rest: [0.25, 0.4],
    parts: [
      { id: 'tone', label: 'long synth tone', voice: 'drone', group: 'pads', slot: 'chords', role: 'root', gain: 0.4, pan: -0.15, centre: 50 },
      { id: 'loop', label: 'looped guitar figure', voice: 'pluck', group: 'guitar', slot: 'figure', role: 'arpeggio', gain: 0.5, pan: 0.2, centre: 55, loose: 0.02 },
      { id: 'machine', label: 'drum machine tick', voice: 'tick', group: 'drums', slot: 'drums', role: 'machine', gain: 0.14, pan: 0.1, fromBar: 1, loose: 0.004 },
      { id: 'thump', label: 'drum machine thump', voice: 'kick', group: 'drums', slot: 'drums', role: 'thump', gain: 0.3, pan: 0, fromBar: 1, loose: 0.004 },
      { id: 'toy', label: 'small keyboard', voice: 'toy', group: 'keys', slot: 'melody', role: 'melody', gain: 0.3, pan: -0.25 },
      { id: 'bass', label: 'soft bass notes', voice: 'bass', group: 'bass', slot: 'bass', role: 'bassChord', gain: 0.4, pan: 0, centre: 40 },
    ],
    voiceParts: [{ id: 'voice', label: 'wordless voice', voice: 'voice', group: 'voice', slot: 'voice', role: 'voiceLine', gain: 0.3, pan: 0, centre: 62 }],
  },
  'dream-folk': {
    modes: { aeolian: 0.4, dorian: 0.35, majorPentatonic: 0.25 },
    tempo: [56, 68],
    density: [1.0, 1.8],
    register: [62, 72],
    rest: [0.3, 0.45],
    parts: [
      { id: 'guitar', label: 'picked guitar', voice: 'pluck', group: 'guitar', slot: 'figure', role: 'arpeggio', gain: 0.5, pan: -0.15, centre: 55, loose: 0.014 },
      { id: 'keys', label: 'sparse keys', voice: 'keys', group: 'keys', slot: 'melody', role: 'melody', gain: 0.35, pan: 0.2 },
      { id: 'bass', label: 'minimal bass', voice: 'bass', group: 'bass', slot: 'bass', role: 'bassChord', gain: 0.3, pan: 0, centre: 40 },
      { id: 'drone', label: 'quiet synth drone', voice: 'pad', group: 'pads', slot: 'chords', role: 'chords', gain: 0.22, pan: 0, centre: 60 },
      { id: 'air', label: 'outdoor noise bed', voice: 'air', group: 'texture', slot: 'texture', role: 'air', gain: 0.05, pan: 0 },
    ],
    voiceParts: [
      { id: 'voice', label: 'wordless lead voice', voice: 'voice', group: 'voice', slot: 'voice', role: 'voiceLine', gain: 0.36, pan: 0, centre: 64 },
      { id: 'voices', label: 'wordless backing voices', voice: 'voice', group: 'voice', slot: 'voice', role: 'voiceChords', gain: 0.18, pan: 0, centre: 67 },
    ],
  },
  slowcore: {
    modes: { aeolian: 0.5, dorian: 0.3, majorPentatonic: 0.2 },
    tempo: [60, 70],
    density: [1.0, 1.8],
    register: [57, 67],
    rest: [0.25, 0.4],
    parts: [
      { id: 'strum', label: 'clean guitar', voice: 'pluck', group: 'guitar', slot: 'figure', role: 'strum', gain: 0.5, pan: -0.25, centre: 50, sections: ['A', 'A2'], loose: 0.012 },
      { id: 'loud', label: 'distorted guitar (middle part)', voice: 'pluck', group: 'guitar', slot: 'figure', role: 'strum', gain: 0.5, pan: 0.2, centre: 50, drive: 0.85, sections: ['B'], loose: 0.012 },
      { id: 'lead', label: 'single-note guitar', voice: 'pluck', group: 'guitar', slot: 'melody', role: 'melody', gain: 0.4, pan: 0.3 },
      { id: 'bass', label: 'bass guitar', voice: 'bass', group: 'bass', slot: 'bass', role: 'bassPulse', gain: 0.45, pan: 0, centre: 38, loose: 0.01 },
      { id: 'kick', label: 'kick drum', voice: 'kick', group: 'drums', slot: 'drums', role: 'kick', gain: 0.5, pan: 0, fromBar: 2, loose: 0.012 },
      { id: 'snare', label: 'snare', voice: 'snare', group: 'drums', slot: 'drums', role: 'snare', gain: 0.32, pan: 0.05, fromBar: 2, loose: 0.014 },
      { id: 'hat', label: 'cymbal ticks', voice: 'hat', group: 'drums', slot: 'drums', role: 'hat', gain: 0.1, pan: -0.2, fromBar: 2, loose: 0.012 },
    ],
    voiceParts: [{ id: 'voice', label: 'wordless low voice', voice: 'voice', group: 'voice', slot: 'voice', role: 'voiceLine', gain: 0.3, pan: 0, centre: 52 }],
  },
  'slowed-reverb': {
    modes: { aeolian: 0.6, dorian: 0.4 },
    tempo: [64, 72],
    density: [0.8, 1.4],
    register: [60, 70],
    rest: [0.35, 0.5],
    parts: [
      { id: 'pad', label: 'synth pads', voice: 'pad', group: 'pads', slot: 'chords', role: 'chords', gain: 0.5, pan: 0, centre: 60 },
      { id: 'drone', label: 'slow drone', voice: 'drone', group: 'pads', slot: 'chords', role: 'tonic', gain: 0.28, pan: 0, centre: 48 },
      { id: 'bell', label: 'bell-like tones', voice: 'bell', group: 'keys', slot: 'melody', role: 'melody', gain: 0.32, pan: 0.2 },
      { id: 'sub', label: 'deep bass', voice: 'sub', group: 'bass', slot: 'bass', role: 'root', gain: 0.45, pan: 0, centre: 36 },
      { id: 'pulse', label: 'faint pulse', voice: 'kick', group: 'drums', slot: 'drums', role: 'thump', gain: 0.22, pan: 0, fromBar: 2 },
    ],
    voiceParts: [{ id: 'voice', label: 'wordless distant voice', voice: 'voice', group: 'voice', slot: 'voice', role: 'voiceChords', gain: 0.22, pan: 0, centre: 62 }],
  },
};

/** Slots where two mixed families do not double each other: the bigger share plays. */
export const EXCLUSIVE_SLOTS: readonly Slot[] = ['melody', 'figure', 'bass', 'drums', 'voice'];
/** A family below this share adds nothing; in exclusive slots it needs MIX_TAKEOVER to fill a gap. */
export const MIX_MIN_SHARE = 0.15;
export const MIX_TAKEOVER = 0.35;
