/**
 * The score while it is being written: notes on the beat grid, before rubato and
 * humanisation. Internal to the composer.
 */
import type { ChordPlan } from './harmony';
import type { Chunk } from './layout';
import { BEATS_PER_BAR } from './params';
import type { Scale } from './theory';
import type { Motif, NoteRole, SectionName } from './types';

export interface ScoreNote {
  pitch: number;
  /** Beats from the start of the piece, on a half-beat grid. */
  startBeat: number;
  durBeats: number;
  role: NoteRole;
  passing: boolean;
  section: SectionName;
  /** Index of the chunk the note belongs to. */
  chunk: number;
  /** 0..1 position inside its chunk, used for the dynamic arc. */
  pos: number;
  /** Never removed by the prune pass (first motif statement, closing note). */
  locked: boolean;
  /** Creation order; keeps every sort stable and deterministic. */
  seq: number;
}

export type NewScoreNote = Omit<ScoreNote, 'seq'>;

export function barOfBeat(beat: number): number {
  return Math.floor(beat / BEATS_PER_BAR);
}

export class Score {
  readonly notes: ScoreNote[] = [];
  /** Notes by the bar of their onset. */
  readonly byBar: ScoreNote[][];
  private seq = 0;

  constructor(readonly bars: number) {
    this.byBar = Array.from({ length: bars }, () => []);
  }

  add(note: NewScoreNote): ScoreNote {
    const full: ScoreNote = { ...note, seq: this.seq++ };
    this.notes.push(full);
    this.byBar[barOfBeat(full.startBeat)].push(full);
    return full;
  }

  remove(note: ScoreNote): void {
    const i = this.notes.indexOf(note);
    if (i >= 0) this.notes.splice(i, 1);
    const list = this.byBar[barOfBeat(note.startBeat)];
    const j = list.indexOf(note);
    if (j >= 0) list.splice(j, 1);
  }

  /** Number of onsets in a bar. */
  load(bar: number): number {
    return this.byBar[bar].length;
  }

  /** Notes with an onset in bars [fromBar, toBar], clipped to the piece. */
  inBars(fromBar: number, toBar: number): ScoreNote[] {
    const out: ScoreNote[] = [];
    for (let b = Math.max(0, fromBar); b <= Math.min(this.bars - 1, toBar); b++) {
      for (const n of this.byBar[b]) out.push(n);
    }
    return out;
  }
}

/** Everything the melody and accompaniment writers share. */
export interface ComposeContext {
  scale: Scale;
  bars: number;
  totalBeats: number;
  motif: Motif;
  chords: readonly ChordPlan[];
  /** Index into `chords` for every bar. */
  barChord: readonly number[];
  chunks: readonly Chunk[];
  score: Score;
  /** Melody centre of A and A' (params.register). */
  register: number;
  /** Scale-step index the motif transforms are measured from (the scale tone nearest the register). */
  baseIndex: number;
  /** Melody centre of B. */
  centreB: number;
  /** Second, octave-displaced centre for some B statements, or null when there is no room. */
  centreBAlt: number | null;
  /** How many more passing tones may be written (keeps them a small share of the notes). */
  passingLeft: number;
}

export function compareScoreNotes(a: ScoreNote, b: ScoreNote): number {
  return a.startBeat - b.startBeat || a.pitch - b.pitch || a.seq - b.seq;
}
