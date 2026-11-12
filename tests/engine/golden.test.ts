/**
 * Regression pins for the composer: note count, bar count, length and a hash of the MIDI
 * bytes of four fixed takes.
 *
 * These fail on ANY change to what the composer writes, on purpose. If you changed the
 * composer deliberately: log the change in TUNING.md with the numbers before/after (project
 * rule), then update the values below. To print the new values run
 *   ENGINE_GOLDEN=1 npx vitest run tests/engine/golden
 * and copy them from reports/tmp/engine-golden.txt.
 * The engine uses plain IEEE arithmetic only (no Math.sin / Math.pow), so the values are the
 * same on every JS engine.
 */
import { describe, expect, it } from 'vitest';
import { generate, pieceToMidi, validatePiece, type Params } from '../../src/engine';
import { fingerprint } from './helpers';

interface Pin {
  params: Partial<Params>;
  notes: number;
  bars: number;
  durationSec: number;
  midiBytes: number;
  midi: string;
}

const PINS: Pin[] = [
  { params: { seed: 1, mode: 'majorPentatonic' }, notes: 38, bars: 21, durationSec: 94.907868, midiBytes: 708, midi: '391c12d2' },
  { params: { seed: 2, mode: 'lydian' }, notes: 38, bars: 21, durationSec: 94.962978, midiBytes: 709, midi: 'c4f4f2cd' },
  { params: { seed: 3, mode: 'dorian' }, notes: 38, bars: 21, durationSec: 94.943004, midiBytes: 712, midi: 'ae378278' },
  {
    params: { seed: 4, mode: 'aeolian', variation: 2, key: 9, tempo: 44, density: 3.2, restProbability: 0.1, register: 60, length: 150 },
    notes: 90,
    bars: 28,
    durationSec: 154.967414,
    midiBytes: 1197,
    midi: '5cd46df4',
  },
];

function measure(params: Partial<Params>): Omit<Pin, 'params'> {
  const piece = generate(params);
  const midi = pieceToMidi(piece);
  return {
    notes: piece.notes.length,
    bars: piece.bars,
    durationSec: piece.durationSec,
    midiBytes: midi.length,
    midi: fingerprint(midi),
  };
}

describe('golden takes', () => {
  it('fixed params still give exactly the pinned pieces', async () => {
    if (process.env.ENGINE_GOLDEN) {
      const fs = await import('node:fs');
      fs.mkdirSync('reports/tmp', { recursive: true });
      fs.writeFileSync(
        'reports/tmp/engine-golden.txt',
        PINS.map((pin) => JSON.stringify({ params: pin.params, ...measure(pin.params) })).join('\n') + '\n',
      );
    }
    for (const pin of PINS) {
      const { params, ...expected } = pin;
      expect(measure(params), `take ${JSON.stringify(params)}`).toEqual(expected);
      expect(validatePiece(generate(params)).ok).toBe(true);
    }
  });
});
