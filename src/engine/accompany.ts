/**
 * The left hand and the small extras around the melody: a low root at chord changes,
 * slowly followed by a fifth / tenth, soft echoes of melody notes, and a few passing tones.
 *
 * Extras are picked one at a time: every free grid position of a chunk is scored for every
 * kind of note that would be allowed there and the best one is written. The same routine
 * tops the piece up to its target note count at the end.
 */
import { HARD_BAR_CAP, type Chunk } from './layout';
import { CLOSING_HOLD_MAX, isWeakBeat, MELODY_FLOOR, passingPitchAllowed } from './melody';
import { BEATS_PER_BAR } from './params';
import type { Rng } from './rng';
import { barOfBeat, compareScoreNotes, type ComposeContext, type Score, type ScoreNote } from './score';
import { isScaleStep, pitchClass, tonesBetween } from './theory';
import type { NoteRole } from './types';

/** Below this pitch (C3) two different notes of one chord span must be at least a fifth apart. */
export const MUD_LIMIT = 48;
export const MUD_MIN_INTERVAL = 7;
/** Above it, two different left-hand pitches of one chord span keep at least a minor third. */
const LEFT_HAND_MIN_INTERVAL = 3;
/** The bass root sits in [BASS_FLOOR, BASS_FLOOR + 11] (A1..G#2). */
export const BASS_FLOOR = 33;
/** The left hand stays at least this many semitones under the lowest melody note of the chord span. */
export const MELODY_CLEARANCE = 3;
/** Beats between two strikes of the same left-hand pitch. */
const RESTRIKE_BEATS = 2;

export function bassPitch(rootPc: number): number {
  let p = rootPc + 24;
  while (p < BASS_FLOOR) p += 12;
  return p;
}

function isLeftHand(n: ScoreNote): boolean {
  return n.role === 'bass' || n.role === 'harmony';
}

interface Candidate {
  beat: number;
  pitch: number;
  role: NoteRole;
  passing: boolean;
  dur: number;
  score: number;
}

export class Accompanist {
  /** Per chord span: the bass root, then the tones the left hand may add above it, ascending. */
  private readonly ladders: number[][];
  /** Per chord span: the left-hand notes written so far. */
  private readonly leftHand: ScoreNote[][];

  constructor(private readonly ctx: ComposeContext) {
    const { chords, barChord, score } = ctx;
    const lowest = chords.map(() => Infinity);
    for (const n of score.notes) {
      if (n.role !== 'melody') continue;
      const s = barChord[barOfBeat(n.startBeat)];
      lowest[s] = Math.min(lowest[s], n.pitch);
    }
    this.ladders = chords.map((chord, s) => {
      if (lowest[s] === Infinity) return [];
      const ceiling = lowest[s] - MELODY_CLEARANCE;
      const bass = bassPitch(chord.root);
      const ladder = [bass];
      if (bass + 7 <= ceiling) ladder.push(bass + 7);
      for (const p of tonesBetween(chord.pitchClasses, bass + 12, ceiling)) ladder.push(p);
      return ladder;
    });
    this.leftHand = chords.map(() => []);
  }

  /** No mud and no clusters: distance rules against the other left-hand pitches of the span. */
  private spacingOk(span: number, pitch: number): boolean {
    for (const n of this.leftHand[span]) {
      if (n.pitch === pitch) continue;
      const need = pitch < MUD_LIMIT && n.pitch < MUD_LIMIT ? MUD_MIN_INTERVAL : LEFT_HAND_MIN_INTERVAL;
      if (Math.abs(n.pitch - pitch) < need) return false;
    }
    return true;
  }

  private commit(chunk: Chunk, c: Candidate): void {
    const { ctx } = this;
    const note = ctx.score.add({
      pitch: c.pitch,
      startBeat: c.beat,
      durBeats: Math.max(0.5, c.dur),
      role: c.role,
      passing: c.passing,
      section: chunk.section,
      chunk: chunk.index,
      pos: (c.beat - chunk.startBar * BEATS_PER_BAR) / (chunk.bars * BEATS_PER_BAR),
      locked: false,
    });
    if (isLeftHand(note)) this.leftHand[ctx.barChord[barOfBeat(c.beat)]].push(note);
    if (c.passing) ctx.passingLeft--;
  }

  /** The best extra note the chunk can still take, or null when nothing fits. */
  private best(chunk: Chunk, rng: Rng): Candidate | null {
    const { ctx } = this;
    const { score, chords, barChord, scale } = ctx;
    const firstBar = chunk.startBar;
    const lastBar = chunk.startBar + chunk.bars - 1;
    const chunkNotes = score.inBars(firstBar, lastBar);
    const melody = chunkNotes.filter((n) => n.role === 'melody').sort(compareScoreNotes);
    // How much of each kind the chunk already has, per bar: the more, the less wanted.
    const have = { bass: 0, harmony: 0, echo: 0, passing: 0 };
    for (const n of chunkNotes) {
      if (n.passing) have.passing += 1 / chunk.bars;
      else if (n.role !== 'melody') have[n.role] += 1 / chunk.bars;
    }
    const pick: { best: Candidate | null } = { best: null };
    const offer = (c: Candidate): void => {
      if (pick.best === null || c.score > pick.best.score) pick.best = c;
    };

    for (let bar = firstBar; bar <= lastBar; bar++) {
      const load = score.load(bar);
      if (load >= HARD_BAR_CAP) continue;
      const s = barChord[bar];
      const chord = chords[s];
      const ladder = this.ladders[s];
      const spanEnd = (chord.startBar + chord.bars) * BEATS_PER_BAR;
      const near = score.inBars(bar - 1, bar + 1);
      const samePitchNear = (pitch: number, beat: number, dist: number): boolean =>
        near.some((n) => n.pitch === pitch && Math.abs(n.startBeat - beat) < dist);
      const bassInSpan = chunkNotes.some((n) => n.role === 'bass' && barChord[barOfBeat(n.startBeat)] === s);
      const struck = new Set<number>();
      for (const n of this.leftHand[s]) {
        if (n.role === 'harmony') struck.add(n.pitch);
      }

      for (let slot = 0; slot < 2 * BEATS_PER_BAR; slot++) {
        const beat = bar * BEATS_PER_BAR + slot * 0.5;
        const half = slot % 2 === 1;
        // A little seeded noise breaks ties; busy bars are less attractive.
        const bias = rng.next() * 6 - 4 * load;
        let anyHere = false;
        let melodyHere = false;
        let leftHere = false;
        let prevGap = Infinity;
        let nextGap = Infinity;
        for (const n of near) {
          if (n.startBeat === beat) {
            anyHere = true;
            if (n.role === 'melody') melodyHere = true;
            if (isLeftHand(n)) leftHere = true;
          } else if (isLeftHand(n)) {
            const d = beat - n.startBeat;
            if (d > 0 && d < prevGap) prevGap = d;
            if (d < 0 && -d < nextGap) nextGap = -d;
          }
        }

        if (ladder.length > 0) {
          // Bass root: first choice where a chord begins (or first plays) in the chunk,
          // re-struck later only as filler.
          const root = ladder[0];
          if (!samePitchNear(root, beat, RESTRIKE_BEATS) && this.spacingOk(s, root)) {
            let v: number;
            if (slot === 0 && bar === Math.max(firstBar, chord.startBar) && !bassInSpan) v = 100;
            else if (slot === 0) v = (bassInSpan ? 34 : 54) - 24 * have.bass;
            else v = (slot === BEATS_PER_BAR ? 12 : half ? 1 : 5) - 10 * have.bass;
            if (leftHere) v -= 25;
            offer({
              beat,
              pitch: root,
              role: 'bass',
              passing: false,
              dur: Math.min(4, spanEnd - beat),
              score: v + bias,
            });
          }
          // Harmony: climbs the ladder (fifth first), one or two beats after the previous left-hand note.
          for (let j = 1; j < ladder.length; j++) {
            const pitch = ladder[j];
            if (samePitchNear(pitch, beat, RESTRIKE_BEATS) || !this.spacingOk(s, pitch)) continue;
            let v = (prevGap >= 1 && prevGap <= 2 ? 60 : prevGap > 2 ? 30 : 8) - 28 * have.harmony;
            if (half) v -= 14;
            if (nextGap < 1) v -= 10;
            if (leftHere) v -= 25;
            if (!bassInSpan) v -= 20;
            v -= 4 * Math.abs(j - 1 - (struck.size % (ladder.length - 1)));
            offer({
              beat,
              pitch,
              role: 'harmony',
              passing: false,
              dur: Math.min(3, spanEnd - beat),
              score: v + bias,
            });
          }
        }

        // The melody notes around this position.
        let before: ScoreNote | null = null;
        let after: ScoreNote | null = null;
        for (const n of melody) {
          if (n.startBeat < beat) before = n;
          else if (n.startBeat > beat && after === null) after = n;
        }

        // Echo: a soft repeat of the last melody note, an octave lower where there is room.
        if (before !== null && !before.passing && barChord[barOfBeat(before.startBeat)] === s) {
          const gap = beat - before.startBeat;
          if (gap >= 1 && gap <= 3) {
            const pitch = before.pitch - 12 >= MELODY_FLOOR ? before.pitch - 12 : before.pitch;
            if (!samePitchNear(pitch, beat, 1)) {
              const free = after === null || after.startBeat >= beat + 0.5;
              const v =
                42 - 6 * Math.abs(gap - 2) - 30 * have.echo - (anyHere ? 22 : 0) - (free ? 0 : 15) - (half ? 4 : 0);
              offer({
                beat,
                pitch,
                role: 'echo',
                passing: false,
                dur: Math.min(2, spanEnd - beat),
                score: v + bias,
              });
            }
          }
        }

        // Passing tone: a short scale tone on a weak position between two chord tones of the melody.
        if (
          ctx.passingLeft > 0 &&
          isWeakBeat(beat) &&
          !melodyHere &&
          before !== null &&
          after !== null &&
          !before.passing &&
          !after.passing &&
          // The opening statement stays as it is.
          !(before.locked && after.locked) &&
          after.startBeat - beat <= 1 &&
          barChord[barOfBeat(before.startBeat)] === s &&
          barChord[barOfBeat(after.startBeat)] === s
        ) {
          const lo = Math.min(before.pitch, after.pitch);
          const hi = Math.max(before.pitch, after.pitch);
          let pitch = -1;
          for (let p = lo + 1; p < hi; p++) {
            if (!scale.pcs.includes(pitchClass(p)) || !passingPitchAllowed(chord.pitchClasses, p)) continue;
            if (!isScaleStep(scale, before.pitch, p) && !isScaleStep(scale, p, after.pitch)) continue;
            // Prefer the tone next to the note it leads into.
            if (pitch < 0 || Math.abs(p - after.pitch) < Math.abs(pitch - after.pitch)) pitch = p;
          }
          if (pitch >= 0 && !samePitchNear(pitch, beat, 1)) {
            offer({
              beat,
              pitch,
              role: 'melody',
              passing: true,
              dur: after.startBeat - beat,
              score: 40 - 40 * have.passing - (anyHere ? 10 : 0) + bias,
            });
          }
        }
      }
    }
    return pick.best;
  }

  /** Write up to `count` extra notes into a chunk. Returns how many were written. */
  addExtras(chunk: Chunk, count: number, rng: Rng): number {
    let added = 0;
    while (added < count) {
      const c = this.best(chunk, rng);
      if (c === null) break;
      this.commit(chunk, c);
      added++;
    }
    return added;
  }

  /** A low root under the closing note, struck together with it. */
  addClosingBass(chunk: Chunk): boolean {
    const { ctx } = this;
    const span = ctx.barChord[chunk.startBar];
    const beat = chunk.startBar * BEATS_PER_BAR;
    const pitch = bassPitch(ctx.chords[span].root);
    const clash = ctx.score
      .inBars(chunk.startBar - 1, chunk.startBar)
      .some((n) => n.pitch === pitch && Math.abs(n.startBeat - beat) < RESTRIKE_BEATS);
    if (clash || !this.spacingOk(span, pitch)) return false;
    this.commit(chunk, {
      beat,
      pitch,
      role: 'bass',
      passing: false,
      dur: Math.min(CLOSING_HOLD_MAX, ctx.totalBeats - beat),
      score: 0,
    });
    return true;
  }

  /** Top the piece up to `target` onsets, always in the chunk that is emptiest for its size. */
  fill(target: number, rng: Rng): void {
    const { score } = this.ctx;
    const open = this.ctx.chunks.filter((c) => !c.final);
    while (score.notes.length < target && open.length > 0) {
      let pickAt = 0;
      let lowest = Infinity;
      open.forEach((c, i) => {
        let load = 0;
        for (let b = c.startBar; b < c.startBar + c.bars; b++) load += score.load(b);
        if (load / c.bars < lowest) {
          lowest = load / c.bars;
          pickAt = i;
        }
      });
      if (this.addExtras(open[pickAt], 1, rng) === 0) open.splice(pickAt, 1);
    }
  }
}

/** Removal order of the prune pass: passing tones and echoes first, the bass last. */
function prunePriority(n: ScoreNote): number {
  if (n.passing) return 0;
  if (n.role === 'echo') return 1;
  if (n.role === 'harmony') return 2;
  if (n.role === 'melody') return 3;
  return 4;
}

/**
 * Remove notes until at most `target` are left. Locked notes (the first motif statement and
 * the closing note) are never removed and no bar loses its last onset, so the plan of active
 * bars survives. Among equals the busiest bar gives first, then the later note.
 */
export function pruneScore(score: Score, target: number): number {
  let removed = 0;
  while (score.notes.length > target) {
    let victim: ScoreNote | null = null;
    let victimLoad = 0;
    for (const n of score.notes) {
      const load = score.load(barOfBeat(n.startBeat));
      if (n.locked || load <= 1) continue;
      if (victim === null) {
        victim = n;
        victimLoad = load;
        continue;
      }
      const dp = prunePriority(n) - prunePriority(victim);
      if (dp < 0 || (dp === 0 && (load > victimLoad || (load === victimLoad && compareScoreNotes(n, victim) > 0)))) {
        victim = n;
        victimLoad = load;
      }
    }
    if (victim === null) break;
    score.remove(victim);
    removed++;
  }
  return removed;
}
