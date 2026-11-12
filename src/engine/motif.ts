/**
 * The motif: 3-5 notes invented from the seed, plus the small pure transforms the
 * development is built from (transpose, stretch, drop notes, octave shift).
 *
 * A motif is stored as scale-step offsets from an anchor chord tone and durations in beats.
 * It contains no absolute pitches and is never taken from existing music.
 */
import type { Rng } from './rng';
import { pitchOfIndex, type Scale } from './theory';
import type { Motif } from './types';

/** Largest allowed distance between the lowest and highest motif note, in scale steps. */
export const MOTIF_MAX_SPAN = 5;
export const MOTIF_MIN_NOTES = 3;
export const MOTIF_MAX_NOTES = 5;

function drawIntervals(count: number, rng: Rng): number[] {
  const intervals: number[] = [];
  let pos = 0;
  let lo = 0;
  let hi = 0;
  for (let i = 1; i < count; i++) {
    let iv = rng.weighted([-3, -2, -1, 1, 2, 3], [0.09, 0.16, 0.25, 0.25, 0.16, 0.09]);
    // A repeated note now and then, never as the first move.
    if (rng.chance(0.07) && i > 1) iv = 0;
    // Reflect a move that would leave the allowed span.
    if (Math.max(hi, pos + iv) - Math.min(lo, pos + iv) > MOTIF_MAX_SPAN) iv = -iv;
    pos += iv;
    lo = Math.min(lo, pos);
    hi = Math.max(hi, pos);
    intervals.push(iv);
  }
  return intervals;
}

function intervalsOk(intervals: readonly number[], needTurn: boolean): boolean {
  const sizes = new Set(intervals.map((iv) => Math.abs(iv)));
  if (sizes.size < 2) return false;
  if (intervals.filter((iv) => iv === 0).length > 1) return false;
  let pos = 0;
  let lo = 0;
  let hi = 0;
  for (const iv of intervals) {
    pos += iv;
    lo = Math.min(lo, pos);
    hi = Math.max(hi, pos);
  }
  if (hi - lo > MOTIF_MAX_SPAN) return false;
  if (needTurn && !(intervals.some((iv) => iv > 0) && intervals.some((iv) => iv < 0))) return false;
  return true;
}

function drawDurations(count: number, rng: Rng): number[] {
  const durations: number[] = [];
  let offBeat = false;
  for (let i = 0; i < count - 1; i++) {
    let d: number;
    if (offBeat) {
      // Come back onto the beat right away (dotted quarter + eighth and the like).
      d = rng.weighted([0.5, 1.5], [0.6, 0.4]);
    } else {
      d = rng.weighted([0.5, 1, 1.5, 2, 3], [0.05, 0.38, 0.1, 0.33, 0.14]);
      // The last inner note may not push the closing note off the beat.
      if (i === count - 2 && d % 1 !== 0) d = 1;
    }
    if (d % 1 !== 0) offBeat = !offBeat;
    durations.push(d);
  }
  durations.push(rng.weighted([2, 3, 4], [0.2, 0.3, 0.5]));
  return durations;
}

/** Invent a motif. Uses nothing but the generator: same generator path, same motif. */
export function inventMotif(rng: Rng): Motif {
  const count = rng.weighted([3, 4, 5], [0.3, 0.45, 0.25]);
  const needTurn = count >= 4 && rng.chance(0.8);
  let intervals = drawIntervals(count, rng);
  for (let attempt = 0; attempt < 500 && !intervalsOk(intervals, needTurn); attempt++) {
    intervals = drawIntervals(count, rng);
  }
  const steps = [0];
  for (const iv of intervals) steps.push(steps[steps.length - 1] + iv);
  return { steps, durations: drawDurations(count, rng) };
}

/** Diatonic transposition: move every note by the same number of scale steps. */
export function transposeMotif(m: Motif, steps: number): Motif {
  return { steps: m.steps.map((s) => s + steps), durations: m.durations.slice() };
}

/** Augmentation (factor > 1) or diminution (factor < 1) of every duration. */
export function stretchMotif(m: Motif, factor: number): Motif {
  return { steps: m.steps.slice(), durations: m.durations.map((d) => d * factor) };
}

/**
 * Fragment: remove the notes at the given indices. The time of a removed note goes to the
 * kept note before it, so the remaining notes keep their place; removed leading notes just
 * disappear. At least one note always survives (the first one if `drop` lists everything).
 */
export function dropMotifNotes(m: Motif, drop: readonly number[]): Motif {
  const gone = new Set(drop);
  if (gone.size >= m.steps.length) gone.delete(0);
  const steps: number[] = [];
  const durations: number[] = [];
  for (let i = 0; i < m.steps.length; i++) {
    if (!gone.has(i)) {
      steps.push(m.steps[i]);
      durations.push(m.durations[i]);
    } else if (durations.length > 0) {
      durations[durations.length - 1] += m.durations[i];
    }
  }
  return { steps, durations };
}

/** Move the whole motif by whole octaves (an octave is `scaleSize` scale steps). */
export function octaveShiftMotif(m: Motif, octaves: number, scaleSize: number): Motif {
  return transposeMotif(m, octaves * scaleSize);
}

/** Scale-step moves between consecutive motif notes. */
export function motifIntervals(m: Motif): number[] {
  const out: number[] = [];
  for (let i = 1; i < m.steps.length; i++) out.push(m.steps[i] - m.steps[i - 1]);
  return out;
}

/** Distance between the lowest and the highest note in scale steps. */
export function motifSpan(m: Motif): number {
  return Math.max(...m.steps) - Math.min(...m.steps);
}

/** Onset of every note in beats from the start of the motif. */
export function motifOnsets(m: Motif): number[] {
  const out: number[] = [];
  let acc = 0;
  for (const d of m.durations) {
    out.push(acc);
    acc += d;
  }
  return out;
}

/** Beats from the first to the last onset. */
export function motifOnsetSpan(m: Motif): number {
  const onsets = motifOnsets(m);
  return onsets[onsets.length - 1];
}

/** Absolute pitches of the motif when its anchor (step 0) sits on scale-step index `anchorIndex`. */
export function motifPitches(m: Motif, scale: Scale, anchorIndex: number): number[] {
  return m.steps.map((s) => pitchOfIndex(scale, anchorIndex + s));
}
