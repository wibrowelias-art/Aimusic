import { describe, expect, it } from 'vitest';
import {
  buildChord,
  CHARACTERISTIC_INTERVAL,
  CHORD_QUALITIES,
  chordName,
  keyName,
  chordOptions,
  indexAtOrBelow,
  isInScale,
  makeScale,
  MODE_INTERVALS,
  MODES,
  nearestIndex,
  pitchName,
  pitchOfIndex,
  scalePitchClasses,
} from '../../src/engine';
import { parseChordName, SUFFIX_INTERVALS } from './helpers';

describe('scales', () => {
  it('pitch classes come from key + mode intervals, ascending from the tonic', () => {
    expect(scalePitchClasses(0, 'majorPentatonic')).toEqual([0, 2, 4, 7, 9]);
    expect(scalePitchClasses(9, 'aeolian')).toEqual([9, 11, 0, 2, 4, 5, 7]);
    expect(scalePitchClasses(5, 'lydian')).toEqual([5, 7, 9, 11, 0, 2, 4]);
    for (const mode of MODES) {
      for (let key = 0; key < 12; key++) {
        expect(scalePitchClasses(key, mode)).toEqual(MODE_INTERVALS[mode].map((iv) => (key + iv) % 12));
      }
    }
  });

  it('scale-step index <-> pitch round trip, strictly ascending, octave every `size` steps', () => {
    for (const mode of MODES) {
      for (let key = 0; key < 12; key++) {
        const scale = makeScale(key, mode);
        for (let i = 2 * scale.size; i < 9 * scale.size; i++) {
          const p = pitchOfIndex(scale, i);
          expect(isInScale(scale.pcs, p)).toBe(true);
          expect(pitchOfIndex(scale, i + 1)).toBeGreaterThan(p);
          expect(pitchOfIndex(scale, i + scale.size)).toBe(p + 12);
          expect(indexAtOrBelow(scale, p)).toBe(i);
          expect(nearestIndex(scale, p)).toBe(i);
        }
      }
    }
  });

  it('nearestIndex finds the closest scale tone for any pitch', () => {
    for (const mode of MODES) {
      const scale = makeScale(3, mode);
      for (let p = 30; p <= 96; p++) {
        const got = pitchOfIndex(scale, nearestIndex(scale, p));
        let best = Infinity;
        for (let q = 18; q <= 108; q++) {
          if (isInScale(scale.pcs, q)) best = Math.min(best, Math.abs(q - p));
        }
        expect(Math.abs(got - p)).toBe(best);
      }
    }
  });

  it('pitch names', () => {
    expect(pitchName(60)).toBe('C4');
    expect(pitchName(30)).toBe('F#1');
    expect(pitchName(96)).toBe('C7');
    expect(pitchName(70)).toBe('Bb4');
  });
});

describe('chord stacks', () => {
  it('the engine table and the independent label table agree', () => {
    expect(CHORD_QUALITIES.map((q) => q.suffix).sort()).toEqual(Object.keys(SUFFIX_INTERVALS).sort());
    for (const q of CHORD_QUALITIES) {
      expect(q.intervals.slice().sort((a, b) => a - b)).toEqual(SUFFIX_INTERVALS[q.suffix]);
      // Every colour is built on a root and a perfect fifth.
      expect(q.intervals).toContain(0);
      expect(q.intervals).toContain(7);
      expect(q.weight).toBeGreaterThan(0);
    }
  });

  it('spells every scale with seven different letters and as few accidentals as possible', () => {
    const expectNames = (key: number, mode: (typeof MODES)[number], names: string[]): void => {
      const scale = makeScale(key, mode);
      expect(scale.pcs.map((pc) => scale.names[pc])).toEqual(names);
    };
    expectNames(0, 'lydian', ['C', 'D', 'E', 'F#', 'G', 'A', 'B']);
    expectNames(8, 'dorian', ['Ab', 'Bb', 'Cb', 'Db', 'Eb', 'F', 'Gb']);
    expectNames(8, 'aeolian', ['G#', 'A#', 'B', 'C#', 'D#', 'E', 'F#']);
    expectNames(3, 'aeolian', ['Eb', 'F', 'Gb', 'Ab', 'Bb', 'Cb', 'Db']);
    expectNames(6, 'lydian', ['Gb', 'Ab', 'Bb', 'C', 'Db', 'Eb', 'F']);
    expectNames(6, 'aeolian', ['F#', 'G#', 'A', 'B', 'C#', 'D', 'E']);
    expectNames(1, 'majorPentatonic', ['Db', 'Eb', 'F', 'Ab', 'Bb']);
    expectNames(5, 'majorPentatonic', ['F', 'G', 'A', 'C', 'D']);
    expect(keyName(8, 'aeolian')).toBe('G#');
    expect(keyName(8, 'dorian')).toBe('Ab');
    for (const mode of MODES) {
      for (let key = 0; key < 12; key++) {
        const scale = makeScale(key, mode);
        expect(scale.names).toHaveLength(12);
        const letters = scale.pcs.map((pc) => scale.names[pc][0]);
        expect(new Set(letters).size).toBe(scale.size);
        for (const pc of scale.pcs) {
          // No double sharps or flats, and the name really is that pitch class.
          expect(scale.names[pc]).toMatch(/^[A-G](#|b)?$/);
          const natural = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[scale.names[pc][0] as 'C'];
          const acc = scale.names[pc].endsWith('#') ? 1 : scale.names[pc].endsWith('b') ? -1 : 0;
          expect((natural + acc + 12) % 12).toBe(pc);
        }
      }
    }
  });

  it('every offered chord lies inside the scale and its label parses back to its tones', () => {
    for (const mode of MODES) {
      for (let key = 0; key < 12; key++) {
        const scale = makeScale(key, mode);
        for (let degree = 0; degree < scale.size; degree++) {
          for (const quality of chordOptions(scale, degree)) {
            const chord = buildChord(scale, degree, quality);
            expect(chord.root).toBe(scale.pcs[degree]);
            for (const pc of chord.pitchClasses) expect(scale.pcs).toContain(pc);
            const parsed = parseChordName(chord.name);
            expect(parsed.root).toBe(chord.root);
            expect(parsed.pitchClasses.slice().sort()).toEqual(chord.pitchClasses.slice().sort());
            expect(chord.name).toBe(chordName(chord.root, quality, scale.names));
            // Triad: root, a third or suspended tone, the fifth; all chord tones.
            expect(chord.triad[0]).toBe(chord.root);
            expect(chord.triad[2]).toBe((chord.root + 7) % 12);
            for (const pc of chord.triad) expect(chord.pitchClasses).toContain(pc);
          }
        }
      }
    }
  });

  it('usable degrees per mode: the tonic always, the diminished degree never', () => {
    const usable = (mode: (typeof MODES)[number]): number[] => {
      const scale = makeScale(0, mode);
      return scale.pcs.map((_, d) => d).filter((d) => chordOptions(scale, d).length > 0);
    };
    expect(usable('majorPentatonic')).toEqual([0, 1, 3, 4]);
    expect(usable('lydian')).toEqual([0, 1, 2, 4, 5, 6]);
    expect(usable('dorian')).toEqual([0, 1, 2, 3, 4, 6]);
    expect(usable('aeolian')).toEqual([0, 2, 3, 4, 5, 6]);
  });

  it('pentatonic stacks use pentatonic tones only (suspended chords where there is no third)', () => {
    const scale = makeScale(0, 'majorPentatonic');
    expect(chordOptions(scale, 1).map((q) => q.suffix).sort()).toEqual(['7sus4', 'sus2', 'sus4']);
    expect(chordOptions(scale, 0).map((q) => q.suffix).sort()).toEqual(['', '6', '6/9', 'add9', 'sus2']);
  });

  it('the characteristic interval of every mode is a scale tone', () => {
    for (const mode of MODES) {
      expect(MODE_INTERVALS[mode]).toContain(CHARACTERISTIC_INTERVAL[mode]);
    }
  });
});
