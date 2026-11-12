import { describe, expect, it } from 'vitest';
import { matchSong } from '../../src/analysis/rhythm';
import { PROFILES } from '../../src/style/profiles';
import { makeSketch, matchFx } from '../../src/sketch';

const SR = 22050;

/** Clicks at the given sixteenth steps of a 4-second bar (60 BPM), for `bars` bars. */
function clicks(steps: number[], bars: number): Float32Array {
  const x = new Float32Array(SR * 4 * bars);
  for (let bar = 0; bar < bars; bar++) {
    for (const step of steps) {
      const at = Math.round((bar * 4 + step * 0.25) * SR);
      for (let i = 0; i < 400; i++) x[at + i] += 0.8 * Math.sin(i * 0.9) * Math.exp(-i / 80);
    }
  }
  return x;
}

describe('match my own song', () => {
  it('reads the tempo and where the hits fall, and nothing about pitch', () => {
    const steps = [0, 4, 6, 8, 12];
    const m = matchSong([clicks(steps, 10)], SR);
    expect(m).not.toBeNull();
    if (!m) return;
    expect(m.tempoBpm).toBe(60);
    expect(m.grid).toHaveLength(16);
    // The pattern comes back (possibly rotated by whole beats: the downbeat is a guess).
    const strong = m.grid.map((v, i) => (v >= 0.5 ? i : -1)).filter((i) => i >= 0);
    expect(strong).toHaveLength(steps.length);
    const rotations = [0, 4, 8, 12].map((r) => steps.map((s) => (s + r) % 16).sort((a, b) => a - b).join(','));
    expect(rotations).toContain(strong.join(','));
    expect(Object.keys(m).sort()).toEqual(['brightnessHz', 'decaySec', 'grid', 'readTempoBpm', 'tempoBpm']);
    expect(matchSong([new Float32Array(SR * 20)], SR)).toBeNull();
  });

  it('puts the rhythmic parts on the pattern and keeps the notes new and in key', () => {
    const grid = [1, 0, 0, 0.4, 0, 0, 0.9, 0, 0.8, 0, 0, 0, 0.5, 0, 0, 0];
    const base = { seed: 5, a: 'slowcore' as const, b: null, mix: 0, words: '', vocals: false, lengthSec: 40 };
    const matched = makeSketch({ ...base, match: { tempoBpm: 66, grid } });
    const plain = makeSketch(base);
    expect(matched.tempo).toBe(66);
    const kicksPerBar = (s: typeof matched): number => (s.tracks.find((t) => t.id === 'kick')?.events.length ?? 0) / (s.bars - 2);
    // Steps at or above 0.75 of the strongest: 0, 6 and 8.
    expect(kicksPerBar(matched)).toBeCloseTo(3, 5);
    expect(kicksPerBar(plain)).toBeLessThan(2);
    for (const track of matched.tracks) {
      for (const e of track.events) if (track.pitched) expect(matched.scale).toContain(((e.pitch % 12) + 12) % 12);
    }
    // The melody is still the composer's own: same seed, same family, same key.
    expect(matched.keyLabel).toBe(plain.keyLabel);
  });

  it('sets the chain to the tone that was read', () => {
    const preset = PROFILES['bedroom-demo'].fx;
    const dark = matchFx({ brightnessHz: 400, decaySec: 3 }, preset);
    expect(dark.highCutHz).toBe(4750);
    expect(dark.roomType).toBe('hall');
    expect(dark.room).toBeCloseTo(3 / 4.5 / 1.5, 2);
    const dry = matchFx({ brightnessHz: 1200, decaySec: 0.3 }, preset);
    expect(dry.highCutHz).toBe(14500);
    expect(dry.roomType).toBe('room');
    expect(matchFx({ brightnessHz: 800, decaySec: null }, preset).room).toBe(preset.room);
  });
});
