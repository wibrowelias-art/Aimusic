import { describe, expect, it } from 'vitest';
import { pruneScore } from '../../src/engine/accompany';
import { planForm } from '../../src/engine/harmony';
import {
  apportion,
  FINAL_BAR_MAX,
  HARD_BAR_CAP,
  layoutSection,
  planActiveCounts,
  planLayout,
  splitRun,
} from '../../src/engine/layout';
import { MAX_MELODY_PER_BAR, placeOnsets, splitEven } from '../../src/engine/melody';
import { createRng } from '../../src/engine/rng';
import { Score, type NewScoreNote } from '../../src/engine/score';

describe('apportion', () => {
  it('hands out exactly the total, inside the bounds, close to the weights', () => {
    expect(apportion(10, [1, 1], [0, 0], [10, 10])).toEqual([5, 5]);
    expect(apportion(10, [3, 1], [0, 0], [10, 10])).toEqual([8, 2]);
    expect(apportion(10, [3, 1], [0, 5], [10, 10])).toEqual([5, 5]);
    expect(apportion(10, [1, 1, 1], [0, 0, 0], [2, 3, 10])).toEqual([2, 3, 5]);
    const rng = createRng(4);
    for (let k = 0; k < 300; k++) {
      const n = rng.int(1, 12);
      const weights = Array.from({ length: n }, () => rng.range(0.1, 5));
      const mins = Array.from({ length: n }, () => rng.int(0, 3));
      const maxs = mins.map((m) => m + rng.int(0, 8));
      const lo = mins.reduce((a, b) => a + b, 0);
      const hi = maxs.reduce((a, b) => a + b, 0);
      const total = rng.int(lo, hi);
      const out = apportion(total, weights, mins, maxs);
      expect(out.reduce((a, b) => a + b, 0)).toBe(total);
      out.forEach((v, i) => {
        expect(v).toBeGreaterThanOrEqual(mins[i]);
        expect(v).toBeLessThanOrEqual(maxs[i]);
      });
    }
  });

  it('stops at the maxima when the total does not fit', () => {
    expect(apportion(50, [1, 1], [0, 0], [3, 4])).toEqual([3, 4]);
  });
});

describe('placeOnsets', () => {
  it('keeps on-grid wishes as they are', () => {
    expect(placeOnsets([0, 1, 3, 4], 2, true)).toEqual([0, 1, 3, 4]);
    expect(placeOnsets([0, 1.5, 2, 4.5], 2, true)).toEqual([0, 1.5, 2, 4.5]);
    expect(placeOnsets([0, 2, 4, 6], 2, false)).toEqual([0, 2, 4, 6]);
  });

  it('gives every bar an onset when there are enough notes', () => {
    // Three notes that would all fall into the first of three bars.
    expect(placeOnsets([0, 1, 2], 3, false).map((o) => Math.floor(o / 4))).toEqual([0, 1, 2]);
    // One note per bar when the wishes leave the last bar empty.
    expect(placeOnsets([0, 3.4, 10.3, 11], 4, false).map((o) => Math.floor(o / 4))).toEqual([0, 1, 2, 3]);
  });

  it('random wishes: ascending, half-beat grid, inside the chunk, capped per bar, every bar covered', () => {
    const rng = createRng(99);
    for (let k = 0; k < 3000; k++) {
      const bars = rng.int(1, 4);
      const m = rng.int(1, MAX_MELODY_PER_BAR * bars);
      const fine = rng.chance(0.5);
      let t = rng.chance(0.5) ? 0 : rng.range(0, 2);
      const targets: number[] = [];
      for (let i = 0; i < m; i++) {
        targets.push(t);
        t += rng.range(0.1, (4 * bars) / m + 1);
      }
      const scale = Math.min(1, (4 * bars - 0.01) / (targets[m - 1] + 0.01));
      const wishes = targets.map((x) => x * scale);
      const out = placeOnsets(wishes, bars, fine);
      expect(out.length).toBe(m);
      const perBar = new Array<number>(bars).fill(0);
      out.forEach((o, i) => {
        expect((o * 2) % 1).toBe(0);
        expect(o).toBeGreaterThanOrEqual(0);
        expect(o).toBeLessThan(4 * bars);
        if (i > 0) expect(o).toBeGreaterThan(out[i - 1]);
        perBar[Math.floor(o / 4)]++;
      });
      expect(Math.max(...perBar)).toBeLessThanOrEqual(MAX_MELODY_PER_BAR);
      if (m >= bars) expect(Math.min(...perBar)).toBeGreaterThanOrEqual(1);
      expect(Math.floor(out[0] / 4)).toBe(0);
    }
  });

  it('sparse bars snap to whole beats unless half-beat precision is asked for', () => {
    expect(placeOnsets([0.4, 2.6], 1, false)).toEqual([0, 3]);
    expect(placeOnsets([0.4, 2.6], 1, true)).toEqual([0.5, 2.5]);
  });

  it('splitEven', () => {
    expect(splitEven(0, 4)).toEqual([]);
    expect(splitEven(3, 4)).toEqual([3]);
    expect(splitEven(7, 4)).toEqual([4, 3]);
    expect(splitEven(9, 4)).toEqual([3, 3, 3]);
    expect(splitEven(10, 5)).toEqual([5, 5]);
  });
});

describe('silence layout', () => {
  it('layoutSection: exact number of playing bars, runs separated by silent bars', () => {
    const rng = createRng(17);
    for (let k = 0; k < 2000; k++) {
      const n = rng.int(2, 30);
      const active = rng.int(1, n);
      const lead = rng.chance(0.5);
      const trailMax = rng.chance(0.5) ? 1 : Infinity;
      const firstRunMin = rng.int(1, 3);
      const flags = layoutSection(n, active, { lead, trailMax, firstRunMin }, rng);
      expect(flags.length).toBe(n);
      expect(flags.filter(Boolean).length).toBe(active);
      if (!lead) {
        expect(flags[0]).toBe(true);
        // The first run is long enough for the motif.
        const want = Math.min(firstRunMin, active);
        for (let i = 0; i < want; i++) expect(flags[i]).toBe(true);
      }
      if (trailMax === 1 && lead) {
        // At most one silent bar at the end.
        expect(flags[n - 1] || flags[n - 2]).toBe(true);
      }
    }
  });

  it('layoutSection: with a lot of silence no gap gets much longer than the others', () => {
    const rng = createRng(18);
    for (let k = 0; k < 200; k++) {
      const flags = layoutSection(30, 6, { lead: true, trailMax: Infinity, firstRunMin: 1 }, rng);
      let longest = 0;
      let run = 0;
      for (const f of flags) {
        run = f ? 0 : run + 1;
        longest = Math.max(longest, run);
      }
      expect(longest).toBeLessThanOrEqual(10);
    }
  });

  it('splitRun: chunks of 2-4 bars, a lone bar stays alone', () => {
    const rng = createRng(19);
    expect(splitRun(0, rng)).toEqual([]);
    expect(splitRun(1, rng)).toEqual([1]);
    for (let len = 2; len <= 40; len++) {
      const parts = splitRun(len, rng);
      expect(parts.reduce((a, b) => a + b, 0)).toBe(len);
      for (const p of parts) {
        expect(p).toBeGreaterThanOrEqual(2);
        expect(p).toBeLessThanOrEqual(4);
      }
    }
  });

  it('planActiveCounts: follows restProbability, but density wins in both directions', () => {
    const sections = planForm(20, createRng(1).fork('form')).sections;
    const base = { bars: 20, sections, motifNotes: 4, motifBars: 2 };
    const total = (target: number, restProbability: number): number =>
      planActiveCounts({ ...base, target, restProbability }).perSection.reduce((a, b) => a + b, 0);
    // Comfortable: exactly the wished number of playing bars.
    expect(total(36, 0.35)).toBe(13);
    expect(total(36, 0)).toBe(20);
    expect(total(40, 0.5)).toBe(10);
    // Too many notes for the wished bars: more bars are opened.
    expect(total(80, 0.8)).toBeGreaterThan(4);
    expect(total(80, 0.8)).toBeGreaterThanOrEqual(Math.ceil(80 / HARD_BAR_CAP));
    // Too few notes: bars are closed, one note per bar at least.
    expect(total(10, 0)).toBeLessThanOrEqual(10);
    expect(total(10, 0)).toBeGreaterThanOrEqual(7);
    // Never fewer than the motif bar and the closing bar.
    expect(total(4, 0.8)).toBeGreaterThanOrEqual(2);
  });

  it('planLayout: chunks tile the playing bars, budgets add up to the target and respect their limits', () => {
    const rng = createRng(20);
    for (let k = 0; k < 600; k++) {
      const bars = rng.int(8, 72);
      const density = rng.range(0.5, 4);
      const motifNotes = rng.int(3, 5);
      const motifBars = rng.int(1, Math.min(4, motifNotes - 1));
      const target = Math.round(density * bars);
      const sections = planForm(bars, rng.fork(`form${k}`)).sections;
      const layout = planLayout(
        { bars, sections, target, restProbability: rng.range(0, 0.8), motifNotes, motifBars },
        rng.fork(`layout${k}`),
      );
      expect(layout.active.length).toBe(bars);
      expect(layout.active[0]).toBe(true);
      const covered = new Array<number>(bars).fill(0);
      let budget = 0;
      layout.chunks.forEach((c, i) => {
        expect(c.index).toBe(i);
        expect(c.bars).toBeGreaterThanOrEqual(1);
        expect(c.bars).toBeLessThanOrEqual(4);
        for (let b = c.startBar; b < c.startBar + c.bars; b++) covered[b]++;
        expect(c.budget).toBeGreaterThanOrEqual(c.final ? 1 : c.bars);
        expect(c.budget).toBeLessThanOrEqual(c.final ? FINAL_BAR_MAX : HARD_BAR_CAP * c.bars);
        if (c.first) expect(c.budget).toBeGreaterThanOrEqual(motifNotes);
        // A chunk never crosses a section boundary.
        const section = sections.find((s) => s.name === c.section);
        expect(section).toBeDefined();
        if (section) {
          expect(c.startBar).toBeGreaterThanOrEqual(section.startBar);
          expect(c.startBar + c.bars).toBeLessThanOrEqual(section.startBar + section.bars);
        }
        budget += c.budget;
      });
      for (let b = 0; b < bars; b++) expect(covered[b]).toBe(layout.active[b] ? 1 : 0);
      expect(layout.chunks[0].first).toBe(true);
      expect(layout.chunks[0].startBar).toBe(0);
      expect(layout.chunks.filter((c) => c.first).length).toBe(1);
      const final = layout.chunks[layout.chunks.length - 1];
      expect(final.final).toBe(true);
      expect(final.section).toBe('A2');
      expect(final.startBar).toBeGreaterThanOrEqual(bars - 2);
      expect(layout.chunks.filter((c) => c.final).length).toBe(1);
      expect(budget).toBe(layout.target);
      expect(layout.target).toBe(Math.max(target, layout.target));
      // The target only moves when the motif plus the closing note do not fit into it.
      if (target >= motifNotes + 1) expect(layout.target).toBe(target);
    }
  });
});

describe('prune pass', () => {
  const note = (startBeat: number, pitch: number, extra: Partial<NewScoreNote>): NewScoreNote => ({
    pitch,
    startBeat,
    durBeats: 1,
    role: 'melody',
    passing: false,
    section: 'A',
    chunk: 0,
    pos: 0,
    locked: false,
    ...extra,
  });

  it('removes passing tones first, then echoes, harmony, melody, bass; never locked notes', () => {
    const score = new Score(2);
    const opening = score.add(note(0, 60, { locked: true }));
    const melody = score.add(note(1, 64, {}));
    const passing = score.add(note(1.5, 65, { passing: true }));
    const echo = score.add(note(2, 52, { role: 'echo' }));
    const harmony = score.add(note(2, 43, { role: 'harmony' }));
    const bass = score.add(note(0, 36, { role: 'bass' }));
    const second = score.add(note(4, 67, {}));
    const closing = score.add(note(5, 72, { locked: true }));

    expect(pruneScore(score, 7)).toBe(1);
    expect(score.notes).not.toContain(passing);
    pruneScore(score, 6);
    expect(score.notes).not.toContain(echo);
    pruneScore(score, 5);
    expect(score.notes).not.toContain(harmony);
    // Two melody notes are left to choose from: the one in the busier bar goes first.
    pruneScore(score, 4);
    expect(score.notes).not.toContain(melody);
    expect(score.notes).toContain(second);
    pruneScore(score, 3);
    expect(score.notes).not.toContain(second);
    expect(score.notes).toContain(bass);
    pruneScore(score, 2);
    expect(score.notes).not.toContain(bass);
    // Only the locked notes are left, and they stay whatever the target.
    expect(pruneScore(score, 0)).toBe(0);
    expect(score.notes).toEqual([opening, closing]);
  });

  it('never empties a bar and never goes below the locked notes', () => {
    const score = new Score(3);
    score.add(note(0, 60, { locked: true }));
    score.add(note(1, 62, { locked: true }));
    score.add(note(4, 64, {}));
    score.add(note(8, 65, { role: 'echo' }));
    score.add(note(9, 67, { passing: true }));
    const removed = pruneScore(score, 0);
    // Only the passing tone could go: bar 2 keeps one onset, bar 1 its only note, bar 0 is locked.
    expect(removed).toBe(1);
    expect(score.notes.length).toBe(4);
    for (let bar = 0; bar < 3; bar++) expect(score.load(bar)).toBeGreaterThanOrEqual(1);
  });

  it('does nothing when the score is already at or under the target', () => {
    const score = new Score(1);
    score.add(note(0, 60, {}));
    score.add(note(1, 62, {}));
    expect(pruneScore(score, 2)).toBe(0);
    expect(pruneScore(score, 5)).toBe(0);
    expect(score.notes.length).toBe(2);
  });
});
