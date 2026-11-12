/**
 * Ambient Lab engine contract.
 *
 * Everything the composer produces is ORIGINAL material derived from a seed.
 * Nothing in the engine may encode, quote or approximate an existing piece of
 * music: no hard-coded melodies, no hard-coded progressions lifted from songs.
 */

export const MODES = ['majorPentatonic', 'lydian', 'dorian', 'aeolian'] as const;
export type Mode = (typeof MODES)[number];

/** Everything needed to reproduce a take. Same Params => identical Piece and MIDI. */
export interface Params {
  /** uint32. Drives the motif, the harmony plan and everything else. */
  seed: number;
  /**
   * 0 = base take. "Again" bumps this: the motif and the harmony plan stay,
   * the development (transforms, rests, fills, humanisation) is re-drawn.
   */
  variation: number;
  /** Tonic pitch class, 0..11 (0 = C). */
  key: number;
  mode: Mode;
  /** Quarter-note BPM, 40..72. */
  tempo: number;
  /** Average piano note onsets per bar over the whole piece, 0.5..4. Pad notes do not count. */
  density: number;
  /** Centre of the melody as a MIDI note number, 55..79. */
  register: number;
  /** 0..0.8. Share of bars that get no new piano onset (silence between phrases). */
  restProbability: number;
  /** Reverb tail (RT60) in seconds, 3..6. */
  reverbSize: number;
  /** 0..1. Tape wobble depth, hiss level and high-cut together. */
  lofi: number;
  /** Target length of the music in seconds (reverb tail excluded), 30..240. */
  length: number;
  /** 0..1. Level of the pad stem (0 = silent). */
  pad: number;
  /** 0..1. Level of procedural rain in the noise stem (0 = off). */
  rain: number;
}

export type NumericParamKey =
  | 'tempo'
  | 'density'
  | 'register'
  | 'restProbability'
  | 'reverbSize'
  | 'lofi'
  | 'length'
  | 'pad'
  | 'rain';

export type SectionName = 'A' | 'B' | 'A2';

export type NoteRole = 'melody' | 'bass' | 'harmony' | 'echo';

export interface Note {
  /** Index in Piece.notes (notes are sorted by `time`, then `pitch`). */
  id: number;
  /** MIDI note number. Always inside the key/mode and inside [PITCH_MIN, PITCH_MAX]. */
  pitch: number;
  /** MIDI velocity 1..127. Soft: the engine stays roughly inside 20..80. */
  velocity: number;
  /** Score position in beats from the start of the piece (quantised grid, before rubato/humanise). */
  startBeat: number;
  /** Score duration in beats (> 0). */
  durBeats: number;
  /** Performed onset in seconds (rubato + humanise applied), >= 0. */
  time: number;
  /** Performed key-down duration in seconds (> 0). The pedal lets notes ring past this. */
  duration: number;
  role: NoteRole;
  section: SectionName;
  /** True when the pitch is a passing tone (in the scale but not in the current chord). */
  passing: boolean;
}

export interface ChordSpan {
  /** First bar of the chord (0-based). */
  startBar: number;
  /** Length in bars: 2, 3 or 4 (the final chord of a section may be shorter to fit). */
  bars: number;
  /** Scale-degree index of the chord root inside the mode (0-based). */
  degree: number;
  /** Root pitch class 0..11. */
  root: number;
  /** Chord tones as pitch classes 0..11 (all inside the scale). */
  pitchClasses: number[];
  /** Human readable label for the UI, e.g. "Dm7" or "G sus2". */
  name: string;
  section: SectionName;
  /** Performed start/end in seconds. */
  startTime: number;
  endTime: number;
}

export interface PedalEvent {
  /** Performed time in seconds. */
  time: number;
  down: boolean;
}

/** A sustained pad note (separate stem / MIDI track). Always chord tones. */
export interface PadNote {
  pitch: number;
  velocity: number;
  time: number;
  duration: number;
}

export interface SectionSpan {
  name: SectionName;
  startBar: number;
  bars: number;
  startTime: number;
  endTime: number;
}

export interface Motif {
  /** Scale-step offsets relative to the anchor chord tone (0 = anchor). 3..5 entries. */
  steps: number[];
  /** Duration of each motif note in beats. Same length as `steps`. */
  durations: number[];
}

export interface Piece {
  /** The exact (clamped) params used. */
  params: Params;
  /** Pitch classes of the chosen key/mode, ascending from the tonic. */
  scale: number[];
  beatsPerBar: 4;
  bars: number;
  motif: Motif;
  sections: SectionSpan[];
  chords: ChordSpan[];
  /** Piano notes, sorted by time then pitch. */
  notes: Note[];
  /** Pad stem notes, sorted by time then pitch. */
  pad: PadNote[];
  /** Sustain pedal, sorted by time, starts with a `down`, ends with an `up`. */
  pedal: PedalEvent[];
  /**
   * Tempo map with rubato: performed time of every beat in seconds, length = bars * 4 + 1.
   * A score position between two beats maps to time by linear interpolation.
   */
  beatTimes: number[];
  /** Performed time of every bar line in seconds; length = bars + 1 (barTimes[i] = beatTimes[4 * i]). */
  barTimes: number[];
  /**
   * Half-width of the per-note timing humanisation in milliseconds, 15..40.
   * For every note: |note.time - scoreTime(note.startBeat)| <= humanizeMs / 1000.
   */
  humanizeMs: number;
  /** Performed time at which the last piano key / pedal / pad note is released. */
  durationSec: number;
}

/** Result of validating a piece against the hard checks. */
export interface PieceReport {
  ok: boolean;
  errors: string[];
  /** Piano onsets per bar measured over the whole piece. */
  measuredDensity: number;
  /** Share of bars without a piano onset. */
  measuredRestRatio: number;
  noteCount: number;
  outOfScale: number;
  overlaps: number;
  stuck: number;
}
