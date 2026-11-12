import { describe, expect, it } from 'vitest';
import {
  createRng,
  dropMotifNotes,
  inventMotif,
  makeScale,
  MODES,
  MOTIF_MAX_NOTES,
  MOTIF_MAX_SPAN,
  MOTIF_MIN_NOTES,
  motifIntervals,
  motifOnsets,
  motifOnsetSpan,
  motifPitches,
  motifSpan,
  octaveShiftMotif,
  stretchMotif,
  transposeMotif,
  type Motif,
} from '../../src/engine';

const SAMPLE: Motif = { steps: [0, 1, -1, 2], durations: [1, 2, 1, 4] };

describe('motif invention', () => {
  const motifs = Array.from({ length: 600 }, (_, seed) => inventMotif(createRng(seed).fork('motif')));

  it('is deterministic per seed', () => {
    expect(inventMotif(createRng(77).fork('motif'))).toEqual(inventMotif(createRng(77).fork('motif')));
  });

  it('has 3-5 notes, starts on the anchor and keeps steps and durations in step', () => {
    const sizes = new Set<number>();
    for (const m of motifs) {
      expect(m.steps.length).toBeGreaterThanOrEqual(MOTIF_MIN_NOTES);
      expect(m.steps.length).toBeLessThanOrEqual(MOTIF_MAX_NOTES);
      expect(m.durations.length).toBe(m.steps.length);
      expect(m.steps[0]).toBe(0);
      expect(m.steps.every((s) => Number.isInteger(s))).toBe(true);
      sizes.add(m.steps.length);
    }
    expect([...sizes].sort()).toEqual([3, 4, 5]);
  });

  it('moves by steps and small leaps, with at least two interval sizes, inside the span limit', () => {
    let steps = 0;
    let moves = 0;
    for (const m of motifs) {
      const intervals = motifIntervals(m);
      expect(new Set(intervals.map((iv) => Math.abs(iv))).size).toBeGreaterThanOrEqual(2);
      expect(Math.max(...intervals.map((iv) => Math.abs(iv)))).toBeLessThanOrEqual(3);
      expect(intervals[0]).not.toBe(0);
      expect(intervals.filter((iv) => iv === 0).length).toBeLessThanOrEqual(1);
      expect(motifSpan(m)).toBeLessThanOrEqual(MOTIF_MAX_SPAN);
      for (const iv of intervals) {
        moves++;
        if (Math.abs(iv) <= 1) steps++;
      }
    }
    // Stepwise motion (or a repeat) is the most common move.
    expect(steps / moves).toBeGreaterThan(0.4);
  });

  it('spans at most about an octave in every mode', () => {
    for (const mode of MODES) {
      const scale = makeScale(0, mode);
      for (const m of motifs.slice(0, 200)) {
        const pitches = motifPitches(m, scale, 5 * scale.size);
        expect(Math.max(...pitches) - Math.min(...pitches)).toBeLessThanOrEqual(12);
      }
    }
  });

  it('uses slow durations: 0.5-4 beats, mostly 1 beat or longer, closing note at least 2 beats', () => {
    let all = 0;
    let slow = 0;
    for (const m of motifs) {
      for (const d of m.durations) {
        expect(d).toBeGreaterThanOrEqual(0.5);
        expect(d).toBeLessThanOrEqual(4);
        expect((d * 2) % 1).toBe(0);
        all++;
        if (d >= 1) slow++;
      }
      expect(m.durations[m.durations.length - 1]).toBeGreaterThanOrEqual(2);
      // The closing note starts on a beat.
      expect(motifOnsetSpan(m) % 1).toBe(0);
    }
    expect(slow / all).toBeGreaterThan(0.9);
  });

  it('gives many different motifs', () => {
    const distinct = new Set(motifs.map((m) => JSON.stringify(m)));
    expect(distinct.size).toBeGreaterThan(300);
  });
});

describe('motif transforms', () => {
  it('transpose moves every step by the same amount and keeps the rhythm', () => {
    const t = transposeMotif(SAMPLE, 3);
    expect(t.steps).toEqual([3, 4, 2, 5]);
    expect(t.durations).toEqual(SAMPLE.durations);
    expect(motifIntervals(t)).toEqual(motifIntervals(SAMPLE));
    expect(transposeMotif(t, -3)).toEqual(SAMPLE);
  });

  it('transposition is diatonic: every pitch stays in the scale', () => {
    for (const mode of MODES) {
      const scale = makeScale(4, mode);
      for (let t = -9; t <= 9; t++) {
        for (const p of motifPitches(transposeMotif(SAMPLE, t), scale, 4 * scale.size)) {
          expect(scale.pcs).toContain(p % 12);
        }
      }
    }
  });

  it('stretch scales the durations and keeps the pitches', () => {
    const s = stretchMotif(SAMPLE, 2);
    expect(s.durations).toEqual([2, 4, 2, 8]);
    expect(s.steps).toEqual(SAMPLE.steps);
    expect(stretchMotif(SAMPLE, 0.5).durations).toEqual([0.5, 1, 0.5, 2]);
    expect(motifOnsets(s)).toEqual(motifOnsets(SAMPLE).map((o) => o * 2));
  });

  it('dropping notes gives a fragment and hands the time to the note before', () => {
    const d = dropMotifNotes(SAMPLE, [1]);
    expect(d.steps).toEqual([0, -1, 2]);
    expect(d.durations).toEqual([3, 1, 4]);
    // The kept notes stay where they were.
    expect(motifOnsets(d)).toEqual([0, 3, 4]);

    const tail = dropMotifNotes(SAMPLE, [0, 1]);
    expect(tail.steps).toEqual([-1, 2]);
    expect(tail.durations).toEqual([1, 4]);

    const head = dropMotifNotes(SAMPLE, [2, 3]);
    expect(head.steps).toEqual([0, 1]);
    expect(head.durations).toEqual([1, 7]);
  });

  it('dropping never empties the motif and dropping nothing changes nothing', () => {
    expect(dropMotifNotes(SAMPLE, [])).toEqual(SAMPLE);
    const one = dropMotifNotes(SAMPLE, [0, 1, 2, 3]);
    expect(one.steps).toEqual([0]);
    expect(one.durations).toEqual([8]);
  });

  it('octave shift moves the pitches by exactly 12 semitones per octave', () => {
    for (const mode of MODES) {
      const scale = makeScale(9, mode);
      const base = motifPitches(SAMPLE, scale, 5 * scale.size);
      const up = motifPitches(octaveShiftMotif(SAMPLE, 1, scale.size), scale, 5 * scale.size);
      const down = motifPitches(octaveShiftMotif(SAMPLE, -2, scale.size), scale, 5 * scale.size);
      expect(up).toEqual(base.map((p) => p + 12));
      expect(down).toEqual(base.map((p) => p - 24));
    }
  });

  it('transforms do not modify their input', () => {
    const copy = JSON.parse(JSON.stringify(SAMPLE)) as Motif;
    transposeMotif(SAMPLE, 2);
    stretchMotif(SAMPLE, 3);
    dropMotifNotes(SAMPLE, [1, 2]);
    octaveShiftMotif(SAMPLE, 1, 7);
    expect(SAMPLE).toEqual(copy);
  });

  it('span and onset helpers', () => {
    expect(motifSpan(SAMPLE)).toBe(3);
    expect(motifOnsets(SAMPLE)).toEqual([0, 1, 3, 4]);
    expect(motifOnsetSpan(SAMPLE)).toBe(4);
  });
});
