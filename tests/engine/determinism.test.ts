import { describe, expect, it } from 'vitest';
import { createRng, DEFAULT_PARAMS, generate, MODES, pieceToMidi, validatePiece, type Params } from '../../src/engine';
import { describePiece, fingerprint, randomParams, scoreSignature } from './helpers';

describe('determinism', () => {
  it('same seed + params => deeply equal piece and byte-identical MIDI', () => {
    const rng = createRng(2024);
    const sets: Partial<Params>[] = [{}, { seed: 2 }, { seed: 3, mode: 'dorian' }];
    for (let i = 0; i < 40; i++) sets.push(randomParams(rng));
    for (const p of sets) {
      const a = generate(p);
      const b = generate({ ...p });
      expect(b).toEqual(a);
      expect(JSON.stringify(b)).toBe(JSON.stringify(a));
      const midiA = pieceToMidi(a);
      const midiB = pieceToMidi(b);
      expect(midiB.length).toBe(midiA.length);
      expect(Buffer.from(midiB).equals(Buffer.from(midiA))).toBe(true);
    }
  });

  it('generate() with no arguments uses the default params', () => {
    expect(generate({})).toEqual(generate(DEFAULT_PARAMS));
    expect(generate({}).params).toEqual(DEFAULT_PARAMS);
  });

  it('params are normalised before use (out-of-range input gives the clamped piece)', () => {
    const wild = generate({ seed: 9, tempo: 500, density: -3, key: 14, register: 200, restProbability: 7, length: 1 });
    const clamped = generate({ seed: 9, tempo: 72, density: 0.5, key: 2, register: 79, restProbability: 0.8, length: 30 });
    expect(wild).toEqual(clamped);
    expect(validatePiece(wild).ok).toBe(true);
  });

  it('does not modify its input', () => {
    const input: Partial<Params> = { seed: 5, tempo: 61.4, mode: 'lydian' };
    const copy = { ...input };
    generate(input);
    expect(input).toEqual(copy);
  });

  it('different seeds give different pieces', () => {
    const signatures = new Set<string>();
    const motifs = new Set<string>();
    const midi = new Set<string>();
    const count = 60;
    for (let seed = 1; seed <= count; seed++) {
      const piece = generate({ seed });
      signatures.add(scoreSignature(piece));
      motifs.add(JSON.stringify(piece.motif));
      midi.add(fingerprint(pieceToMidi(piece)));
    }
    expect(signatures.size).toBe(count);
    expect(midi.size).toBe(count);
    expect(motifs.size).toBeGreaterThan(count * 0.8);
  });

  it('example pieces: seeds 1-3 with the default params, one mode each (summary in reports/tmp when asked)', async () => {
    const examples = [
      generate({ seed: 1, mode: 'majorPentatonic' }),
      generate({ seed: 2, mode: 'lydian' }),
      generate({ seed: 3, mode: 'dorian' }),
    ];
    for (const piece of examples) {
      expect(validatePiece(piece).ok).toBe(true);
      expect(MODES).toContain(piece.params.mode);
    }
    if (process.env.ENGINE_SUMMARY) {
      const fs = await import('node:fs');
      fs.mkdirSync('reports/tmp', { recursive: true });
      fs.writeFileSync('reports/tmp/engine-examples.txt', examples.map(describePiece).join('\n\n') + '\n');
    }
  });
});
