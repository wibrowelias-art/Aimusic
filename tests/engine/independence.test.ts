import { describe, expect, it } from 'vitest';
import { generate, MODES, pieceToMidi, type ChordSpan, type Params, type Piece, type SectionSpan } from '../../src/engine';
import { scoreSignature } from './helpers';

/** The piece without the params it was made from. */
function content(piece: Piece): Omit<Piece, 'params'> {
  const { params: _params, ...rest } = piece;
  return rest;
}

/** The harmony plan: chord degrees, chord lengths, labels (no performed times). */
function harmonyPlan(chords: readonly ChordSpan[]): unknown[] {
  return chords.map(({ startBar, bars, degree, root, pitchClasses, name, section }) => ({
    startBar,
    bars,
    degree,
    root,
    pitchClasses,
    name,
    section,
  }));
}

function sectionLayout(sections: readonly SectionSpan[]): unknown[] {
  return sections.map(({ name, startBar, bars }) => ({ name, startBar, bars }));
}

const BASES: Partial<Params>[] = [
  { seed: 1 },
  { seed: 77, mode: 'lydian', key: 5, density: 2.6, restProbability: 0.2 },
  { seed: 4242, mode: 'dorian', key: 10, tempo: 44, density: 0.9, restProbability: 0.6, length: 140 },
  { seed: 99, mode: 'aeolian', key: 3, tempo: 70, density: 3.6, restProbability: 0.05, register: 74 },
];

describe('parameter independence', () => {
  it('reverbSize, lofi, pad and rain do not change a single note, pad note, pedal event or beat time', () => {
    for (const base of BASES) {
      const a = generate({ ...base, reverbSize: 3, lofi: 0, pad: 0, rain: 0 });
      const variants: Partial<Params>[] = [
        { reverbSize: 6 },
        { lofi: 1 },
        { pad: 1 },
        { rain: 1 },
        { reverbSize: 4.7, lofi: 0.63, pad: 0.4, rain: 0.8 },
      ];
      for (const v of variants) {
        const b = generate({ ...base, reverbSize: 3, lofi: 0, pad: 0, rain: 0, ...v });
        expect(content(b)).toEqual(content(a));
        expect(b.params).not.toEqual(a.params);
        // The MIDI carries no sound-only parameter either.
        expect(Buffer.from(pieceToMidi(b)).equals(Buffer.from(pieceToMidi(a)))).toBe(true);
      }
    }
  });

  it('the motif depends on the seed only', () => {
    for (let seed = 1; seed <= 25; seed++) {
      const base = generate({ seed });
      const others: Partial<Params>[] = [
        { mode: 'aeolian' },
        { key: 7 },
        { tempo: 70, length: 200 },
        { density: 3.8, restProbability: 0 },
        { register: 78, variation: 5 },
      ];
      for (const o of others) expect(generate({ seed, ...o }).motif).toEqual(base.motif);
    }
  });

  it('density, rest, register and tempo-neutral changes keep the harmony plan and the sections', () => {
    for (const base of BASES) {
      const a = generate(base);
      for (const o of [{ density: 0.7 }, { density: 3.9 }, { restProbability: 0.75 }, { register: 58 }, { register: 78 }]) {
        const b = generate({ ...base, ...o });
        expect(harmonyPlan(b.chords)).toEqual(harmonyPlan(a.chords));
        expect(sectionLayout(b.sections)).toEqual(sectionLayout(a.sections));
        expect(b.pad.map((n) => n.pitch)).toEqual(a.pad.map((n) => n.pitch));
      }
    }
  });

  it('changing the key transposes the harmony plan (same degrees and lengths)', () => {
    for (const base of BASES) {
      const a = generate({ ...base, key: 0 });
      const b = generate({ ...base, key: 4 });
      expect(b.chords.map((c) => [c.degree, c.bars, c.startBar])).toEqual(a.chords.map((c) => [c.degree, c.bars, c.startBar]));
      expect(b.chords.map((c) => c.root)).toEqual(a.chords.map((c) => (c.root + 4) % 12));
      expect(b.chords.map((c) => c.pitchClasses)).toEqual(a.chords.map((c) => c.pitchClasses.map((pc) => (pc + 4) % 12)));
    }
  });
});

describe('variation contract ("Again")', () => {
  it('keeps motif, harmony plan, section layout and pad voicing; re-draws development and performance', () => {
    let scoreChanged = 0;
    let timingChanged = 0;
    let total = 0;
    for (const mode of MODES) {
      for (let seed = 1; seed <= 12; seed++) {
        const base = generate({ seed, mode, variation: 0 });
        for (const variation of [1, 2, 7]) {
          const again = generate({ seed, mode, variation });
          expect(again.motif).toEqual(base.motif);
          expect(harmonyPlan(again.chords)).toEqual(harmonyPlan(base.chords));
          expect(sectionLayout(again.sections)).toEqual(sectionLayout(base.sections));
          expect(again.bars).toBe(base.bars);
          expect(again.scale).toEqual(base.scale);
          expect(again.pad.map((n) => n.pitch)).toEqual(base.pad.map((n) => n.pitch));
          // Same density target, so the same number of notes.
          expect(again.notes.length).toBe(base.notes.length);
          total++;
          if (scoreSignature(again) !== scoreSignature(base)) scoreChanged++;
          if (JSON.stringify(again.beatTimes) !== JSON.stringify(base.beatTimes)) timingChanged++;
        }
      }
    }
    expect(scoreChanged).toBe(total);
    expect(timingChanged).toBe(total);
  });

  it('the opening motif statement is the same in every variation', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const opening = (variation: number): string => {
        const piece = generate({ seed, variation });
        const count = piece.motif.steps.length;
        return piece.notes
          .filter((n) => n.role === 'melody')
          .sort((a, b) => a.startBeat - b.startBeat)
          .slice(0, count)
          .map((n) => `${n.startBeat}:${n.pitch}:${n.passing ? 'p' : 'c'}`)
          .join(' ');
      };
      expect(opening(1)).toBe(opening(0));
      expect(opening(3)).toBe(opening(0));
    }
  });

  it('different variations differ from each other', () => {
    const signatures = new Set<string>();
    for (let variation = 0; variation < 12; variation++) signatures.add(scoreSignature(generate({ seed: 31, variation })));
    expect(signatures.size).toBe(12);
  });
});
