/**
 * The right hand. Every melody note is a motif note: each chunk gets one or a few motif
 * statements, shaped by the four transforms (diatonic transposition onto the chord, stretch,
 * dropped notes, octave shift), laid out over the bars of the chunk and fitted to the chords.
 */
import type { Chunk } from './layout';
import {
  dropMotifNotes,
  motifOnsetSpan,
  motifPitches,
  octaveShiftMotif,
  stretchMotif,
  transposeMotif,
} from './motif';
import { BEATS_PER_BAR, clamp, PITCH_MAX } from './params';
import type { Rng } from './rng';
import { barOfBeat, type ComposeContext } from './score';
import { isScaleStep, nearestIndex, nearestToneIndex, pitchClass, tonesBetween } from './theory';
import type { Motif } from './types';

/** The melody never goes below C3; the left hand owns everything under it. */
export const MELODY_FLOOR = 48;
/** The melody stays within this many semitones of its centre. */
export const MELODY_HALF_RANGE = 10;
/** Most melody onsets in one bar. */
export const MAX_MELODY_PER_BAR = 5;
/** Longest key-down time of a melody note inside a phrase, in beats. */
const HOLD_MAX = 4;
/** Key-down time of the last note of a phrase, in beats. */
const PHRASE_END_HOLD_MIN = 2;
const PHRASE_END_HOLD_MAX = 6;
/** Longest key-down time of the closing note, in beats. */
export const CLOSING_HOLD_MAX = 8;
/** Chance that a motif note which lands between two chord tones stays a passing tone. */
const PASSING_KEEP = 0.65;

export function melodyWindow(centre: number): [number, number] {
  return [Math.max(MELODY_FLOOR, centre - MELODY_HALF_RANGE), Math.min(PITCH_MAX, centre + MELODY_HALF_RANGE)];
}

/** Bars the motif needs at its written speed (bar of its last onset + 1). */
export function motifBarCount(motif: Motif): number {
  return Math.floor(motifOnsetSpan(motif) / BEATS_PER_BAR) + 1;
}

/** Beats 2 and 4 and every off-beat are weak; beats 1 and 3 are not. */
export function isWeakBeat(beat: number): boolean {
  return beat % 2 !== 0;
}

/**
 * May `pitch` be used as a passing tone over a chord? It must be outside the chord and must
 * not sit a semitone above one of the chord tones.
 */
export function passingPitchAllowed(chordPcs: readonly number[], pitch: number): boolean {
  const pc = pitchClass(pitch);
  return !chordPcs.includes(pc) && !chordPcs.includes((pc + 11) % 12);
}

/** Split `total` notes into the fewest parts of at most `maxPart`, as even as possible. */
export function splitEven(total: number, maxPart: number): number[] {
  if (total <= 0) return [];
  const parts = Math.ceil(total / maxPart);
  const base = Math.floor(total / parts);
  const extra = total - base * parts;
  return Array.from({ length: parts }, (_, i) => base + (i < extra ? 1 : 0));
}

/**
 * Turn wished onsets (beats from the chunk start, ascending) into grid positions.
 *
 * Guarantees: strictly ascending, on the half-beat grid, at most MAX_MELODY_PER_BAR per bar,
 * and when there are at least as many notes as bars every bar gets an onset (that is how
 * a planned active bar is certain to be active).
 * `fine` keeps half-beat precision; otherwise bars with up to three notes snap to whole beats.
 */
export function placeOnsets(targets: readonly number[], bars: number, fine: boolean): number[] {
  const m = targets.length;
  const barOf: number[] = [];
  const count = new Array<number>(bars).fill(0);
  for (let i = 0; i < m; i++) {
    const natural = clamp(Math.floor(targets[i] / BEATS_PER_BAR), 0, bars - 1);
    const prev = i === 0 ? 0 : barOf[i - 1];
    let lo = prev;
    let hi = bars - 1;
    if (m >= bars) {
      // Enough notes left for the bars to come, no bar skipped, room for the notes to come.
      lo = Math.max(prev, bars - m + i);
      hi = Math.min(i === 0 ? 0 : prev + 1, bars - Math.ceil((m - i) / MAX_MELODY_PER_BAR));
    }
    let bar = clamp(natural, lo, Math.max(lo, hi));
    while (count[bar] >= MAX_MELODY_PER_BAR && bar < bars - 1) bar++;
    barOf.push(bar);
    count[bar]++;
  }

  const out = new Array<number>(m).fill(0);
  let i = 0;
  while (i < m) {
    const bar = barOf[i];
    let j = i;
    while (j < m && barOf[j] === bar) j++;
    const n = j - i;
    const grid = fine || n > 3 ? 0.5 : 1;
    const slots = Math.round(BEATS_PER_BAR / grid);
    const q: number[] = [];
    for (let k = i; k < j; k++) {
      const natural = Math.floor(targets[k] / BEATS_PER_BAR);
      // A note moved into another bar goes to the near edge of that bar.
      const raw = natural === bar ? targets[k] - BEATS_PER_BAR * bar : natural < bar ? 0 : BEATS_PER_BAR;
      q.push(clamp(Math.round(raw / grid), 0, slots - 1));
    }
    for (let k = 1; k < n; k++) q[k] = Math.max(q[k], q[k - 1] + 1);
    q[n - 1] = Math.min(q[n - 1], slots - 1);
    for (let k = n - 2; k >= 0; k--) q[k] = Math.min(q[k], q[k + 1] - 1);
    for (let k = 0; k < n; k++) out[i + k] = bar * BEATS_PER_BAR + Math.max(0, q[k]) * grid;
    i = j;
  }
  return out;
}

interface Statement {
  /** The motif after dropping notes and stretching. */
  variant: Motif;
  /** Which chord tone carries the anchor: 0 = the nearest to the centre, +-n = n chord tones away. */
  rank: number;
  /** Whole-octave displacement (B section only). */
  octave: number;
  /** Register centre the statement is built around (before the octave displacement). */
  centre: number;
}

/** Indices to drop so that `size` of `count` motif notes stay. */
function chooseDrop(count: number, size: number, weights: readonly number[], rng: Rng): number[] {
  const kind = rng.weightedIndex(weights);
  const order = rng.shuffle(Array.from({ length: count - 1 }, (_, i) => i + 1));
  if (size >= count) return [];
  if (kind === 0) return Array.from({ length: count - size }, (_, i) => size + i); // keep the head
  if (kind === 1) return Array.from({ length: count - size }, (_, i) => i); // keep the tail
  return order.slice(0, count - size).sort((a, b) => a - b); // keep the first note and a scatter
}

function planStatement(
  ctx: ComposeContext,
  chunk: Chunk,
  index: number,
  size: number,
  chunkOctave: number,
  rng: Rng,
): Statement {
  const count = ctx.motif.steps.length;
  let drop: number[] = [];
  let stretch = 1;
  let rank = 0;
  let octave = 0;
  let centre = ctx.register;
  if (index === 0 && (chunk.first || chunk.reprise)) {
    // The motif in its opening form (its head when there is no room for all of it).
    drop = Array.from({ length: count - size }, (_, i) => size + i);
  } else if (chunk.section === 'B') {
    // Contrast: scattered fragments, further from the centre, stronger stretch.
    drop = chooseDrop(count, size, [0.25, 0.3, 0.45], rng);
    stretch = rng.weighted([1, 1.5, 2, 3], [0.25, 0.15, 0.4, 0.2]);
    // Mostly further out in the direction B has moved, sometimes back towards A.
    rank = rng.weighted([2, 1, -1, -2], [0.3, 0.35, 0.25, 0.1]) * (ctx.centreB >= ctx.register ? 1 : -1);
    octave = chunkOctave;
  } else if (chunk.section === 'A') {
    drop = chooseDrop(count, size, [0.6, 0.25, 0.15], rng);
    stretch = rng.weighted([1, 1.5, 2], [0.6, 0.2, 0.2]);
    rank = rng.weighted([0, 1, -1], [0.6, 0.2, 0.2]);
  } else {
    drop = chooseDrop(count, size, [0.7, 0.2, 0.1], rng);
    stretch = rng.weighted([1, 2], [0.5, 0.5]);
    rank = rng.weighted([0, 1, -1], [0.7, 0.15, 0.15]);
  }
  if (chunk.section === 'B') centre = ctx.centreB;
  let variant = dropMotifNotes(ctx.motif, drop);
  if (stretch !== 1) variant = stretchMotif(variant, stretch);
  return { variant, rank, octave, centre };
}

/**
 * Pitches for one statement. The anchor is a chord tone near the centre; every note is then
 * the nearest chord tone that keeps the direction of the motif, except for a few notes that
 * may stay between two chord tones as passing tones.
 */
function statementPitches(
  ctx: ComposeContext,
  st: Statement,
  beats: readonly number[],
  durs: readonly number[],
  rng: Rng,
): { pitches: number[]; passing: boolean[] } {
  const { scale, chords, barChord } = ctx;
  const chordAt = (beat: number) => chords[barChord[barOfBeat(beat)]];
  const steps = st.variant.steps;
  const [lo, hi] = melodyWindow(st.centre + 12 * st.octave);

  let mean = 0;
  for (const s of steps) mean += s / steps.length;
  const [anchorLo, anchorHi] = melodyWindow(st.centre);
  const ladder = tonesBetween(chordAt(beats[0]).pitchClasses, anchorLo - 12, anchorHi + 12);
  const wanted = st.centre - (mean * 12) / scale.size;
  // Diatonic transposition onto the anchor, then the octave shift.
  const shape = (anchor: number): number[] => {
    let shaped = transposeMotif(st.variant, nearestIndex(scale, anchor) - ctx.baseIndex);
    if (st.octave !== 0) shaped = octaveShiftMotif(shaped, st.octave, scale.size);
    return motifPitches(shaped, scale, ctx.baseIndex);
  };
  let at = clamp(nearestToneIndex(ladder, wanted) + st.rank, 0, ladder.length - 1);
  let raw = shape(ladder[at]);
  // Slide the anchor along the chord tones until the statement fits the register window.
  while (at > 0 && Math.max(...raw) > hi && Math.min(...raw) > lo) raw = shape(ladder[--at]);
  while (at < ladder.length - 1 && Math.min(...raw) < lo && Math.max(...raw) < hi) raw = shape(ladder[++at]);

  const pitches: number[] = [];
  for (let i = 0; i < steps.length; i++) {
    const tones = tonesBetween(chordAt(beats[i]).pitchClasses, lo, hi);
    let idx = nearestToneIndex(tones, raw[i], i > 0 && steps[i] > steps[i - 1]);
    if (i > 0) {
      const prev = pitches[i - 1];
      const dir = Math.sign(steps[i] - steps[i - 1]);
      const above = tones.findIndex((t) => t > prev);
      let below = -1;
      for (let k = 0; k < tones.length; k++) {
        if (tones[k] < prev) below = k;
      }
      // Keep the direction of the motif; at the edge of the window turn around instead of repeating.
      if (dir > 0 && tones[idx] <= prev) {
        idx = above >= 0 ? above : below >= 0 ? below : idx;
      } else if (dir < 0 && tones[idx] >= prev) {
        idx = below >= 0 ? below : above >= 0 ? above : idx;
      } else if (dir === 0) {
        const same = tones.indexOf(prev);
        if (same >= 0) idx = same;
      }
    }
    pitches.push(tones[idx]);
  }

  const passing = steps.map(() => false);
  for (let i = 1; i < steps.length - 1; i++) {
    if (ctx.passingLeft <= 0) break;
    const keep = rng.chance(PASSING_KEEP);
    const p = raw[i];
    if (!keep || passing[i - 1] || p < lo || p > hi) continue;
    if (!isWeakBeat(beats[i]) || durs[i] > 1) continue;
    if (!passingPitchAllowed(chordAt(beats[i]).pitchClasses, p)) continue;
    const before = pitches[i - 1];
    const after = pitches[i + 1];
    if (!((before < p && p < after) || (before > p && p > after))) continue;
    // It has to connect by step to at least one of its neighbours.
    if (!isScaleStep(scale, before, p) && !isScaleStep(scale, p, after)) continue;
    pitches[i] = p;
    passing[i] = true;
    ctx.passingLeft--;
  }
  return { pitches, passing };
}

/** Write the melody of one chunk (not the closing chunk). Returns the number of notes written. */
export function writeChunkMelody(ctx: ComposeContext, chunk: Chunk, rng: Rng): number {
  const { motif, score } = ctx;
  const count = motif.steps.length;
  const bars = chunk.bars;
  const budget = chunk.budget;

  // How many of the chunk's notes are melody; the rest goes to the left hand and echoes.
  const perBar = budget / bars;
  const share = perBar <= 1.5 ? 1 : clamp(0.74 - 0.045 * perBar, 0.45, 0.7);
  let m = Math.round(budget * share + rng.range(-0.4, 0.4));
  if (budget >= count && Math.abs(m - count) <= 1) m = count; // prefer a whole statement
  const mMin = chunk.first ? Math.max(count, bars) : bars;
  const mMax = Math.max(mMin, Math.min(budget, MAX_MELODY_PER_BAR * bars));
  m = clamp(m, mMin, mMax);
  const written = chunk.first && bars >= motifBarCount(motif);
  if (written) m = mMin;

  const opening = (chunk.first || chunk.reprise) && m >= count;
  const sizes = opening ? [count, ...splitEven(m - count, count)] : splitEven(m, count);
  // Some B chunks are displaced by an octave as a whole (the register changes between phrases, not inside one).
  let chunkOctave = 0;
  if (chunk.section === 'B' && rng.chance(0.2) && ctx.centreBAlt !== null) {
    chunkOctave = ctx.centreBAlt > ctx.centreB ? 1 : -1;
  }
  const statements = sizes.map((size, j) => planStatement(ctx, chunk, j, size, chunkOctave, rng.fork(`plan${j}`)));

  // Rhythm: the (stretched) motif durations, scaled to the room the chunk has.
  const rel: number[] = [];
  for (const st of statements) {
    for (const d of st.variant.durations) rel.push(d);
  }
  let total = 0;
  for (const d of rel) total += d;
  const lastDur = rel[m - 1];
  let lead = 0;
  if (!chunk.first && budget > m && m <= 3 * bars) lead = rng.weighted([0, 1, 2], [0.55, 0.25, 0.2]);
  const room = BEATS_PER_BAR * bars - lead;
  let phi = room / total;
  // A single statement that fits is played as written.
  const literal =
    written || (statements.length === 1 && total - lastDur <= room - 0.5 && phi >= 0.7 && phi <= 1.8);
  if (literal) phi = 1;
  const targets: number[] = [];
  let acc = 0;
  for (let i = 0; i < m; i++) {
    targets.push(lead + acc * phi);
    acc += rel[i];
  }
  const startBeat = chunk.startBar * BEATS_PER_BAR;
  const onsets = placeOnsets(targets, bars, literal).map((o) => startBeat + o);
  const durs = onsets.map((o, i) =>
    i < m - 1
      ? Math.min(onsets[i + 1] - o, HOLD_MAX)
      : Math.min(
          clamp(Math.round(lastDur * phi * 2) / 2, PHRASE_END_HOLD_MIN, PHRASE_END_HOLD_MAX),
          ctx.totalBeats - o,
        ),
  );

  let offset = 0;
  statements.forEach((st, j) => {
    const size = st.variant.steps.length;
    const beats = onsets.slice(offset, offset + size);
    const { pitches, passing } = statementPitches(
      ctx,
      st,
      beats,
      durs.slice(offset, offset + size),
      rng.fork(`pitch${j}`),
    );
    for (let i = 0; i < size; i++) {
      score.add({
        pitch: pitches[i],
        startBeat: beats[i],
        durBeats: durs[offset + i],
        role: 'melody',
        passing: passing[i],
        section: chunk.section,
        chunk: chunk.index,
        pos: m > 1 ? (offset + i) / (m - 1) : 0.5,
        locked: chunk.first && j === 0,
      });
    }
    offset += size;
  });
  return m;
}

/** The closing note: a long tone of the tonic triad at the start of the last active bar. */
export function writeClosingNote(ctx: ComposeContext, chunk: Chunk, rng: Rng): void {
  const chord = ctx.chords[ctx.barChord[chunk.startBar]];
  const [lo, hi] = melodyWindow(ctx.register);
  // Root, third or fifth; a suspended 2nd/4th is not a place to end on.
  const third = (chord.triad[1] - chord.triad[0] + 12) % 12;
  const pc = rng.weighted(chord.triad, third === 3 || third === 4 ? [0.5, 0.25, 0.25] : [0.6, 0, 0.4]);
  let previous = ctx.register;
  let latest = -1;
  for (const n of ctx.score.notes) {
    if (n.role === 'melody' && n.startBeat > latest) {
      latest = n.startBeat;
      previous = n.pitch;
    }
  }
  const tones = tonesBetween([pc], lo, hi);
  const startBeat = chunk.startBar * BEATS_PER_BAR;
  ctx.score.add({
    pitch: tones[nearestToneIndex(tones, previous)],
    startBeat,
    durBeats: Math.min(CLOSING_HOLD_MAX, ctx.totalBeats - startBeat),
    role: 'melody',
    passing: false,
    section: chunk.section,
    chunk: chunk.index,
    pos: 1,
    locked: true,
  });
}
