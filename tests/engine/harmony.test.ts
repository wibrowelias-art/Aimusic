import { describe, expect, it } from 'vitest';
import {
  CHARACTERISTIC_INTERVAL,
  createRng,
  generate,
  MODES,
  validatePiece,
  type Mode,
  type Params,
  type Piece,
} from '../../src/engine';
import { planForm, splitBars } from '../../src/engine/harmony';
import { extremeParams, parseChordName, randomParams } from './helpers';

function batch(): Piece[] {
  const rng = createRng(909);
  const sets: Partial<Params>[] = extremeParams();
  for (let i = 0; i < 200; i++) sets.push(randomParams(rng));
  for (const mode of MODES) {
    for (let seed = 1; seed <= 40; seed++) sets.push({ seed, mode, key: seed % 12 });
  }
  return sets.map((p) => generate(p));
}

describe('form A / B / A\'', () => {
  const pieces = batch();

  it('sections are A, B, A2, contiguous, and cover every bar', () => {
    for (const piece of pieces) {
      expect(piece.sections.map((s) => s.name)).toEqual(['A', 'B', 'A2']);
      let bar = 0;
      for (const s of piece.sections) {
        expect(s.startBar).toBe(bar);
        expect(s.bars).toBeGreaterThanOrEqual(2);
        expect(s.startTime).toBe(piece.barTimes[s.startBar]);
        expect(s.endTime).toBe(piece.barTimes[s.startBar + s.bars]);
        bar += s.bars;
      }
      expect(bar).toBe(piece.bars);
    }
  });

  it('section sizes: A about 40 %, B about 25-30 %, A2 the rest', () => {
    for (const piece of pieces) {
      const [a, b, a2] = piece.sections;
      expect(Math.abs(a.bars - 0.4 * piece.bars)).toBeLessThanOrEqual(0.5 + 1e-9);
      expect(b.bars).toBeGreaterThanOrEqual(Math.round(0.25 * piece.bars));
      expect(b.bars).toBeLessThanOrEqual(Math.round(0.3 * piece.bars));
      expect(a2.bars).toBe(piece.bars - a.bars - b.bars);
      expect(a2.bars / piece.bars).toBeGreaterThan(0.2);
      expect(a2.bars / piece.bars).toBeLessThan(0.42);
    }
  });

  it('planForm is deterministic and independent of everything but its generator and the bar count', () => {
    expect(planForm(21, createRng(3).fork('form'))).toEqual(planForm(21, createRng(3).fork('form')));
    for (let bars = 8; bars <= 72; bars++) {
      const form = planForm(bars, createRng(bars).fork('form'));
      expect(form.sections.reduce((sum, s) => sum + s.bars, 0)).toBe(bars);
      expect(form.shiftSemis).toBeGreaterThanOrEqual(5);
      expect(form.shiftSemis).toBeLessThanOrEqual(12);
    }
  });
});

describe('harmony plan', () => {
  const pieces = batch();

  it('chords cover every bar, last 2-4 bars each and stay inside their section', () => {
    for (const piece of pieces) {
      let bar = 0;
      for (const chord of piece.chords) {
        expect(chord.startBar).toBe(bar);
        expect(chord.bars).toBeGreaterThanOrEqual(2);
        expect(chord.bars).toBeLessThanOrEqual(4);
        const section = piece.sections.find((s) => s.name === chord.section);
        expect(section).toBeDefined();
        if (section) {
          expect(chord.startBar).toBeGreaterThanOrEqual(section.startBar);
          expect(chord.startBar + chord.bars).toBeLessThanOrEqual(section.startBar + section.bars);
        }
        expect(chord.startTime).toBe(piece.barTimes[chord.startBar]);
        expect(chord.endTime).toBe(piece.barTimes[chord.startBar + chord.bars]);
        bar += chord.bars;
      }
      expect(bar).toBe(piece.bars);
      // Sections start exactly where a chord starts.
      for (const s of piece.sections) expect(piece.chords.some((c) => c.startBar === s.startBar)).toBe(true);
    }
  });

  it('starts and ends on the tonic chord, never repeats a chord immediately, B stays off the tonic', () => {
    for (const piece of pieces) {
      const first = piece.chords[0];
      const last = piece.chords[piece.chords.length - 1];
      expect(first.degree).toBe(0);
      expect(last.degree).toBe(0);
      expect(first.root).toBe(piece.params.key);
      expect(last.root).toBe(piece.params.key);
      for (let i = 1; i < piece.chords.length; i++) {
        expect(piece.chords[i].degree).not.toBe(piece.chords[i - 1].degree);
      }
      for (const chord of piece.chords) {
        if (chord.section === 'B') expect(chord.degree).not.toBe(0);
      }
      // The closing tonic is the longest chord of A2.
      const a2 = piece.chords.filter((c) => c.section === 'A2');
      expect(last.bars).toBe(Math.max(...a2.map((c) => c.bars)));
    }
  });

  it('chord labels are correct: the name parses to exactly the chord tones', () => {
    for (const piece of pieces) {
      for (const chord of piece.chords) {
        const parsed = parseChordName(chord.name);
        expect(parsed.root).toBe(chord.root);
        expect(chord.pitchClasses[0]).toBe(chord.root);
        expect(parsed.pitchClasses.slice().sort((a, b) => a - b)).toEqual(chord.pitchClasses.slice().sort((a, b) => a - b));
        expect(chord.root).toBe(piece.scale[chord.degree]);
        for (const pc of chord.pitchClasses) expect(piece.scale).toContain(pc);
        // Every chord has a perfect fifth (no diminished stacks).
        expect(chord.pitchClasses).toContain((chord.root + 7) % 12);
      }
    }
  });

  it('a degree keeps one colour through a piece and minor/major follows the mode', () => {
    for (const piece of pieces) {
      const nameOfDegree = new Map<number, string>();
      for (const chord of piece.chords) {
        const seen = nameOfDegree.get(chord.degree);
        if (seen !== undefined) expect(chord.name).toBe(seen);
        nameOfDegree.set(chord.degree, chord.name);
      }
      const tonic = piece.chords[0];
      const third = tonic.pitchClasses.map((pc) => (pc - tonic.root + 12) % 12);
      if (piece.params.mode === 'dorian' || piece.params.mode === 'aeolian') expect(third).not.toContain(4);
      else expect(third).not.toContain(3);
    }
  });

  it('A2 comes back to the A chords', () => {
    let returns = 0;
    let total = 0;
    for (const piece of pieces) {
      const a = piece.chords.filter((c) => c.section === 'A').map((c) => c.degree);
      const a2 = piece.chords.filter((c) => c.section === 'A2').map((c) => c.degree);
      if (a2.length < 3) continue;
      total++;
      // All chords of A2 before the closing tonic are taken from A, in order.
      if (a2.slice(0, -1).every((d, i) => d === a[i % a.length])) returns++;
      expect(a2[0]).toBe(0);
    }
    expect(total).toBeGreaterThan(50);
    expect(returns / total).toBeGreaterThan(0.85);
  });

  it('the walk favours the characteristic colour of each mode', () => {
    const share = (mode: Mode): number => {
      let withColour = 0;
      let all = 0;
      for (let seed = 1; seed <= 150; seed++) {
        const piece = generate({ seed, mode, key: 0, length: 150 });
        const colour = CHARACTERISTIC_INTERVAL[mode];
        for (const chord of piece.chords) {
          if (chord.degree === 0) continue;
          all++;
          if (chord.pitchClasses.includes(colour)) withColour++;
        }
      }
      return withColour / all;
    };
    // Share of the non-tonic chords that contain the colour tone. A uniform choice over the
    // usable degrees would give about 0.4 (lydian, dorian, aeolian) and 0.67 (pentatonic) for triads.
    expect(share('lydian')).toBeGreaterThan(0.5);
    expect(share('dorian')).toBeGreaterThan(0.5);
    expect(share('aeolian')).toBeGreaterThan(0.5);
    expect(share('majorPentatonic')).toBeGreaterThan(0.6);
  });

  it('different seeds give different progressions (no fixed progression table)', () => {
    for (const mode of MODES) {
      const seen = new Set<string>();
      for (let seed = 1; seed <= 80; seed++) {
        seen.add(generate({ seed, mode }).chords.map((c) => `${c.name}x${c.bars}`).join(' '));
      }
      expect(seen.size).toBeGreaterThan(70);
    }
  });

  it('splitBars: parts of 2-4 bars that add up', () => {
    const rng = createRng(1);
    expect(splitBars(0, rng)).toEqual([]);
    expect(splitBars(1, rng)).toEqual([1]);
    for (let total = 2; total <= 40; total++) {
      for (let k = 0; k < 20; k++) {
        const parts = splitBars(total, rng);
        expect(parts.reduce((a, b) => a + b, 0)).toBe(total);
        for (const part of parts) {
          expect(part).toBeGreaterThanOrEqual(2);
          expect(part).toBeLessThanOrEqual(4);
        }
      }
    }
  });

  it('all pieces of this batch are valid', () => {
    for (const piece of pieces) expect(validatePiece(piece).ok).toBe(true);
  });
});
