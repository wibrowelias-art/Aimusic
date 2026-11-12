/**
 * Contracts of the built-in generator ("sketch engine"): the free way to make a piece in
 * a style family. Everything is derived from a seed by the composer in `src/engine` and
 * played by synthesised voices from `synth.ts`. No samples, no music AI, no network.
 */
import type { StereoPcm } from '../audio/types';
import type { Mode } from '../engine/types';
import type { PostFxSettings } from '../postfx/settings';
import type { FamilyId } from '../style/types';

/** The synthesised voices. */
export type VoiceId =
  | 'pad'
  | 'organ'
  | 'keys'
  | 'bell'
  | 'toy'
  | 'pluck'
  | 'bass'
  | 'sub'
  | 'drone'
  | 'kick'
  | 'snare'
  | 'hat'
  | 'tick'
  | 'voice'
  | 'air';

/** What the owner's words can switch off or turn up ("no drums", "more guitar"). */
export type Group = 'keys' | 'pads' | 'guitar' | 'bass' | 'drums' | 'voice' | 'texture';

/** A musical job inside the arrangement. Two families never fill the same exclusive slot twice. */
export type Slot = 'melody' | 'figure' | 'chords' | 'bass' | 'drums' | 'texture' | 'voice';

export interface SketchEvent {
  /** Seconds from the start. */
  time: number;
  /** Seconds the note is held (voices add their own release). */
  duration: number;
  /** MIDI note number (ignored by drums and noise). */
  pitch: number;
  /** 0..1. */
  level: number;
}

export interface SketchTrack {
  id: string;
  /** For the UI, e.g. "picked guitar". */
  label: string;
  voice: VoiceId;
  group: Group;
  /** Linear gain in the mix. */
  gain: number;
  /** -1 (left) .. 1 (right). */
  pan: number;
  /** 0..1 overdrive (guitars). */
  drive: number;
  /** False for drums and noise: their `pitch` means nothing. */
  pitched: boolean;
  events: SketchEvent[];
}

export interface SketchRequest {
  /** uint32. Same request, same audio. */
  seed: number;
  a: FamilyId;
  b: FamilyId | null;
  /** Share of `b`, 0..1. */
  mix: number;
  /** The owner's own words (rule-based, see words.ts). */
  words: string;
  /** True adds a wordless synthesised voice. It cannot sing words. */
  vocals: boolean;
  lengthSec: number;
  /**
   * "Match my own song": tempo and hit pattern read from a track the owner uploaded
   * (numbers only, see analysis/rhythm.ts). The rhythmic parts then play on that pattern.
   */
  match?: { tempoBpm: number; grid: number[] } | null;
}

/** What the rules made of the owner's words. */
export interface WordsResult {
  /** Plain sentences: what was changed and by how much. */
  understood: string[];
  /** Clauses no rule matched. */
  ignored: string[];
  removeGroups: Group[];
  addGroups: Group[];
  /** Gain factor per group ("more guitar"). */
  groupGain: Partial<Record<Group, number>>;
  tempoDelta: number;
  restDelta: number;
  registerDelta: number;
  densityFactor: number;
  /** Positive = towards minor modes, negative = towards major ones. */
  minorBias: number;
  /** Applies the chain-side changes ("more tape hiss") to a preset. */
  fx: (preset: PostFxSettings) => PostFxSettings;
}

export interface Sketch {
  request: SketchRequest;
  key: number;
  mode: Mode;
  /** e.g. "D dorian". */
  keyLabel: string;
  tempo: number;
  bars: number;
  /** End of the last note, seconds. */
  musicSec: number;
  /** Pitch classes of the key and mode. */
  scale: number[];
  tracks: SketchTrack[];
  words: WordsResult;
}

export interface SketchAudio {
  sampleRate: number;
  full: StereoPcm;
  /** Present when a voice track exists: the vocal blur of the chain can use it for free. */
  stems: { vocals: StereoPcm; backing: StereoPcm } | null;
  durationSec: number;
}
