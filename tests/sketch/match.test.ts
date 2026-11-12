import { describe, expect, it } from 'vitest';
import { matchSong } from '../../src/analysis/rhythm';
import { PROFILES } from '../../src/style/profiles';
import { integratedLufs } from '../../src/analysis/loudness';
import { makeSketch, matchFx, overlayMelody, renderSketch } from '../../src/sketch';

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
    expect(Object.keys(m).sort()).toEqual(['brightnessHz', 'decaySec', 'durationSec', 'grid', 'keyPc', 'mode', 'offsetSec', 'readTempoBpm', 'tempoBpm']);
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

  it('lays a new melody over the recording and leaves the recording itself alone', () => {
    const sr = 48000;
    const song = new Float32Array(sr * 20);
    for (let i = 0; i < song.length; i++) song[i] = 0.2 * Math.sin((2 * Math.PI * 220 * i) / sr) + 0.1 * Math.sin((2 * Math.PI * 1500 * i) / sr);
    const sketch = makeSketch({ seed: 9, a: 'ambient-keys', b: null, mix: 0, words: '', vocals: false, lengthSec: 20, only: 'melody', key: { pc: 2, mode: 'dorian' } });
    expect(sketch.keyLabel).toBe('D dorian');
    expect(sketch.tracks.map((t) => t.id)).toEqual(['keys']);
    const melody = renderSketch(sketch, sr).full;
    const untouched = overlayMelody([song, song.slice()], [new Float32Array(sr), new Float32Array(sr)], { dipDb: 0, melodyDb: -8, offsetSec: 0 }, sr);
    expect(untouched[0]).toEqual(song);
    const mixed = overlayMelody([song, song.slice()], melody, { dipDb: 0, melodyDb: -8, offsetSec: 1 }, sr);
    // Before the offset nothing is added; after it the melody is there, 8 LU under the recording.
    expect(mixed[0].subarray(0, sr)).toEqual(song.subarray(0, sr));
    const added: [Float32Array, Float32Array] = [new Float32Array(song.length), new Float32Array(song.length)];
    for (let ch = 0; ch < 2; ch++) for (let i = 0; i < song.length; i++) added[ch][i] = mixed[ch][i] - song[i];
    // (The end of the melody is cut where the recording ends, so allow 1.5 LU.)
    const rel = integratedLufs(added, sr) - integratedLufs([song, song], sr);
    expect(rel).toBeGreaterThan(-9.5);
    expect(rel).toBeLessThan(-6.5);
    // The dip takes the 1.5 kHz part of the centre down and leaves 220 Hz nearly alone.
    const part = (x: Float32Array, hz: number): number => {
      let re = 0;
      let im = 0;
      for (let i = sr; i < sr * 3; i++) {
        re += x[i] * Math.cos((2 * Math.PI * hz * i) / sr);
        im += x[i] * Math.sin((2 * Math.PI * hz * i) / sr);
      }
      return Math.hypot(re, im);
    };
    const silent: [Float32Array, Float32Array] = [new Float32Array(sr), new Float32Array(sr)];
    const dipped = overlayMelody([song, song.slice()], silent, { dipDb: 12, melodyDb: -8, offsetSec: 0 }, sr);
    expect(20 * Math.log10(part(dipped[0], 1500) / part(song, 1500))).toBeCloseTo(-12, 0);
    expect(Math.abs(20 * Math.log10(part(dipped[0], 220) / part(song, 220)))).toBeLessThan(1.5);
  });
});
