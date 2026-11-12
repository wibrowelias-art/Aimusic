/**
 * Where the piano plays and how many notes each stretch gets.
 *
 * Silence is planned as whole bars between phrases: first the number of active bars is
 * derived from restProbability (density wins when both cannot hold), then the active bars
 * are grouped into runs with silent bars between them, the runs are cut into chunks of
 * 1-4 bars (one chunk = room for one or a few motif statements), and the target note count
 * is shared out over the chunks. The first chunk always holds the complete motif, the last
 * active bar is kept for the closing note.
 */
import type { SectionPlan } from './harmony';
import { clamp } from './params';
import type { Rng } from './rng';
import type { SectionName } from './types';

/** No bar ever gets more piano onsets than this. */
export const HARD_BAR_CAP = 8;
/** Average onsets per active bar the planner aims to stay under (leaves headroom to HARD_BAR_CAP). */
export const PLAN_BAR_CAP = 7;
/** The first chunk holds the motif plus at most this many other notes per bar. */
export const FIRST_CHUNK_EXTRAS_PER_BAR = 3;
/** The bar of the closing note holds that note and at most a bass note under it. */
export const FINAL_BAR_MAX = 2;
/** Relative share of playing bars per section bar: A a little more, A' a little less than B. */
const A_ACTIVE_WEIGHT = 1.05;
const A2_ACTIVE_WEIGHT = 0.95;
/** Relative share of notes per playing bar in A' (it thins out). */
const A2_NOTE_WEIGHT = 0.9;

export interface Chunk {
  index: number;
  startBar: number;
  bars: number;
  section: SectionName;
  /** Piano onsets planned for this chunk. */
  budget: number;
  /** Holds the first, complete motif statement (always starts at bar 0). */
  first: boolean;
  /** The last active bar: holds only the closing note. */
  final: boolean;
  /** First chunk of A': the motif comes back in its opening form. */
  reprise: boolean;
  /** The bar after this chunk is silent (or the piece ends). */
  runEnd: boolean;
}

export interface Layout {
  /** One flag per bar: true = the piano has at least one onset there. */
  active: boolean[];
  chunks: Chunk[];
  /** Planned number of piano onsets (the density target, moved only when it cannot be met). */
  target: number;
}

export interface LayoutInput {
  bars: number;
  sections: readonly SectionPlan[];
  /** round(density * bars). */
  target: number;
  restProbability: number;
  /** Number of notes in the motif. */
  motifNotes: number;
  /** Bars the motif needs at its written speed. */
  motifBars: number;
}

/**
 * Share `total` units over buckets: everybody starts at its minimum, the rest goes one by
 * one to the bucket furthest below its weighted share, never above its maximum.
 */
export function apportion(
  total: number,
  weights: readonly number[],
  mins: readonly number[],
  maxs: readonly number[],
): number[] {
  const out = mins.slice();
  let sumW = 0;
  for (const w of weights) sumW += w;
  if (sumW <= 0) sumW = 1;
  let left = total;
  for (const v of out) left -= v;
  while (left > 0) {
    let best = -1;
    let bestDeficit = -Infinity;
    for (let i = 0; i < out.length; i++) {
      if (out[i] >= maxs[i]) continue;
      const deficit = (total * weights[i]) / sumW - out[i];
      if (deficit > bestDeficit) {
        best = i;
        bestDeficit = deficit;
      }
    }
    if (best < 0) break;
    out[best]++;
    left--;
  }
  return out;
}

/**
 * Number of active bars per section [A, B, A'] and the length of the first chunk.
 * No randomness: the same params always give the same counts, whatever the variation.
 */
export function planActiveCounts(input: LayoutInput): { perSection: number[]; firstBars: number } {
  const { bars, sections, target, motifNotes, motifBars } = input;

  /**
   * Bars per section for `want` active bars. Fixed claims first: the closing note (A'), one
   * bar for B so that every section has something to play, then room for the motif at its
   * written speed (A). `emptyB` gives up the claim of B when notes are scarce.
   */
  const split = (want: number, emptyB: boolean): number[] => {
    const minB = !emptyB && want >= 3 ? 1 : 0;
    const minA = clamp(motifBars, 1, Math.max(1, Math.min(sections[0].bars, want - minB - 1)));
    return apportion(
      want,
      [sections[0].bars * A_ACTIVE_WEIGHT, sections[1].bars, sections[2].bars * A2_ACTIVE_WEIGHT],
      [minA, minB, 1],
      sections.map((s) => s.bars),
    );
  };
  const firstOf = (per: readonly number[]): number => Math.max(1, Math.min(motifBars, per[0]));
  /** Most notes `want` active bars can take without crowding. */
  const capacity = (want: number, first: number): number =>
    (want - first - 1) * PLAN_BAR_CAP + motifNotes + FIRST_CHUNK_EXTRAS_PER_BAR * first + FINAL_BAR_MAX;
  /** Fewest notes `want` active bars need (one per bar, the whole motif, the closing note). */
  const minimum = (want: number, first: number): number => want - first - 1 + Math.max(motifNotes, first) + 1;

  // With enough notes every section gets something to play; otherwise only A and A'.
  const formMin = target >= motifNotes + 2 ? 3 : 2;
  let want = clamp(bars - Math.round(input.restProbability * bars), formMin, bars);
  let emptyB = false;
  let per = split(want, emptyB);
  // Density wins over space: open more bars until the notes fit ...
  while (want < bars && capacity(want, firstOf(per)) < target) {
    want++;
    per = split(want, emptyB);
  }
  // ... or, with too few notes for the bars, first let B go silent, then close bars. Stop at
  // "motif bars + closing bar": closing more would only squeeze the motif, not save a note.
  while (minimum(want, firstOf(per)) > target) {
    if (!emptyB) emptyB = true;
    else if (want - firstOf(per) - 1 > 0) want--;
    else break;
    per = split(want, emptyB);
  }
  return { perSection: per, firstBars: firstOf(per) };
}

interface SectionLayoutOptions {
  /** May the section start with silent bars? */
  lead: boolean;
  /** Most silent bars allowed at the end of the section. */
  trailMax: number;
  /** Minimum length of the first run. */
  firstRunMin: number;
}

/** Spread `active` playing bars over a section of `n` bars as runs with silent bars between them. */
export function layoutSection(n: number, active: number, opts: SectionLayoutOptions, rng: Rng): boolean[] {
  const flags = new Array<boolean>(n).fill(false);
  if (active <= 0) return flags;
  if (active >= n) return flags.fill(true);
  const rest = n - active;
  const firstMin = clamp(opts.firstRunMin, 1, active);
  const maxRuns = Math.max(1, Math.min(active - firstMin + 1, rest + 1));
  // Runs of about 2-3 bars; more and shorter runs when there is a lot of silence, so that
  // no single gap gets very long.
  const preferred = rng.range(2, 3.4);
  const runCount = clamp(Math.max(Math.round(active / preferred), Math.ceil(rest / 4)), 1, maxRuns);

  const runs = new Array<number>(runCount).fill(1);
  runs[0] = firstMin;
  for (let spare = active - (runCount - 1) - firstMin; spare > 0; spare--) {
    runs[rng.weightedIndex(runs.map((len) => 1 / len))]++;
  }

  // gaps[0] = before the first run, gaps[i] = after run i-1.
  const gaps = new Array<number>(runCount + 1).fill(0);
  for (let i = 1; i < runCount; i++) gaps[i] = 1;
  for (let left = rest - (runCount - 1); left > 0; left--) {
    // Every gap gets less likely to grow the longer it already is, so the silence spreads out.
    const weights = gaps.map((g, i) => {
      if (i === 0) return opts.lead ? 0.7 / (g + 1) : 0;
      if (i === runCount) return g < opts.trailMax ? 0.7 / (g + 1) : 0;
      return 1 / g;
    });
    const slot = weights.some((w) => w > 0) ? rng.weightedIndex(weights) : opts.lead ? 0 : runCount;
    gaps[slot]++;
  }

  let bar = gaps[0];
  for (let r = 0; r < runCount; r++) {
    for (let j = 0; j < runs[r]; j++) flags[bar++] = true;
    bar += gaps[r + 1];
  }
  return flags;
}

/** Cut a run of `len` active bars into chunks of 2-4 bars (a lone bar stays one chunk). */
export function splitRun(len: number, rng: Rng): number[] {
  if (len <= 0) return [];
  if (len === 1) return [1];
  const out: number[] = [];
  let left = len;
  while (left > 0) {
    const options = [2, 3, 4].filter((c) => left - c === 0 || left - c >= 2);
    const c = rng.weighted(
      options,
      options.map((o) => (o === 4 ? 0.2 : 0.4)),
    );
    out.push(c);
    left -= c;
  }
  return out;
}

export function planLayout(input: LayoutInput, rng: Rng): Layout {
  const { bars, sections, motifNotes } = input;
  const { perSection, firstBars } = planActiveCounts(input);

  const active: boolean[] = [];
  const runsRng = rng.fork('runs');
  sections.forEach((section, i) => {
    const flags = layoutSection(
      section.bars,
      perSection[i],
      {
        lead: i > 0,
        // The closing note sits in the last or second to last bar.
        trailMax: i === 2 ? 1 : Infinity,
        firstRunMin: i === 0 ? firstBars : 1,
      },
      runsRng,
    );
    for (const f of flags) active.push(f);
  });
  active[0] = true;

  let finalBar = bars - 1;
  while (finalBar > 0 && !active[finalBar]) finalBar--;

  const chunks: Chunk[] = [];
  const chunkRng = rng.fork('chunks');
  const push = (startBar: number, len: number, section: SectionName, first: boolean, final: boolean): void => {
    chunks.push({
      index: chunks.length,
      startBar,
      bars: len,
      section,
      budget: 0,
      first,
      final,
      reprise: false,
      runEnd: startBar + len >= bars || !active[startBar + len],
    });
  };
  for (const section of sections) {
    const end = section.startBar + section.bars;
    let bar = section.startBar;
    while (bar < end) {
      if (!active[bar]) {
        bar++;
        continue;
      }
      let runEnd = bar;
      while (runEnd < end && active[runEnd]) runEnd++;
      // The closing bar is its own chunk.
      const hasFinal = finalBar >= bar && finalBar < runEnd;
      let cursor = bar;
      const bodyEnd = hasFinal ? finalBar : runEnd;
      if (cursor === 0 && bodyEnd > 0) {
        const len = Math.min(firstBars, bodyEnd);
        push(0, len, section.name, true, false);
        cursor = len;
      }
      for (const len of splitRun(bodyEnd - cursor, chunkRng)) {
        push(cursor, len, section.name, false, false);
        cursor += len;
      }
      if (hasFinal) push(finalBar, 1, section.name, false, true);
      bar = runEnd;
    }
  }
  const reprise = chunks.find((c) => c.section === 'A2' && !c.final);
  if (reprise) reprise.reprise = true;

  // Share the notes out.
  const budgetRng = rng.fork('budget');
  const sectionWeight: Record<SectionName, number> = { A: 1, B: 1, A2: A2_NOTE_WEIGHT };
  const mins = chunks.map((c) => (c.final ? 1 : c.first ? Math.max(motifNotes, c.bars) : c.bars));
  const maxs = chunks.map((c) =>
    c.final
      ? FINAL_BAR_MAX
      : c.first
        ? Math.max(motifNotes, c.bars) + FIRST_CHUNK_EXTRAS_PER_BAR * c.bars
        : HARD_BAR_CAP * c.bars,
  );
  const weights = chunks.map((c) => (c.final ? 0.3 : c.bars * sectionWeight[c.section] * budgetRng.range(0.85, 1.15)));
  let minTotal = 0;
  let maxTotal = 0;
  for (let i = 0; i < chunks.length; i++) {
    minTotal += mins[i];
    maxTotal += maxs[i];
  }
  const target = clamp(input.target, minTotal, maxTotal);
  const budgets = apportion(target, weights, mins, maxs);
  chunks.forEach((c, i) => {
    c.budget = budgets[i];
  });

  return { active, chunks, target };
}
