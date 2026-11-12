/**
 * The built-in generator: free, offline, seeded. Same request = same audio, everything in
 * key, the owner's words do what they say, and the result passes the lo-fi chain's rules.
 */
import { describe, expect, it } from 'vitest';
import { peakDb, rmsDb } from '../../src/analysis/metrics';
import { renderPostFx } from '../../src/postfx/chain';
import { HISS_OFF_DB, POSTFX_CLEAN } from '../../src/postfx/settings';
import { chooseParts, makeSketch, parseWords, renderSketch, SKETCH_PEAK, type SketchRequest } from '../../src/sketch';
import { FAMILY_IDS, PROFILES } from '../../src/style/profiles';
import { createContext } from '../fixtures/audio';

const req = (over: Partial<SketchRequest>): SketchRequest => ({ seed: 11, a: 'bedroom-demo', b: null, mix: 0, words: '', vocals: false, lengthSec: 30, ...over });
const groups = (r: SketchRequest): string[] => [...new Set(makeSketch(r).tracks.map((t) => t.group))].sort();

describe('arrangement', () => {
  it('is the same for the same request and different for another seed', () => {
    expect(JSON.stringify(makeSketch(req({})))).toBe(JSON.stringify(makeSketch(req({}))));
    expect(JSON.stringify(makeSketch(req({ seed: 12 })).tracks)).not.toBe(JSON.stringify(makeSketch(req({})).tracks));
  });

  it('keeps every pitched note inside the key and mode, for every family and several seeds', () => {
    for (const a of FAMILY_IDS) {
      for (const seed of [1, 2, 3, 4]) {
        const sketch = makeSketch(req({ a, seed, vocals: true }));
        expect(sketch.tracks.length, a).toBeGreaterThanOrEqual(4);
        for (const track of sketch.tracks) {
          expect(track.events.length, `${a}/${track.id}`).toBeGreaterThan(0);
          for (const e of track.events) {
            expect(e.time).toBeGreaterThanOrEqual(0);
            expect(e.duration).toBeGreaterThan(0);
            if (track.pitched) expect(sketch.scale, `${a}/${track.id} pitch ${e.pitch} in ${sketch.keyLabel}`).toContain(((e.pitch % 12) + 12) % 12);
          }
        }
        expect(sketch.tempo).toBeGreaterThanOrEqual(40);
        expect(sketch.tempo).toBeLessThanOrEqual(72);
      }
    }
  });

  it('gives each family its own instruments', () => {
    expect(groups(req({ a: 'ambient-keys' }))).toEqual(['bass', 'keys', 'pads', 'texture']);
    expect(groups(req({ a: 'bedroom-demo' }))).toEqual(['bass', 'drums', 'guitar', 'keys', 'pads']);
    expect(groups(req({ a: 'dream-folk' }))).toEqual(['bass', 'guitar', 'keys', 'pads', 'texture']);
    expect(groups(req({ a: 'slowcore' }))).toEqual(['bass', 'drums', 'guitar']);
    expect(groups(req({ a: 'slowed-reverb' }))).toEqual(['bass', 'drums', 'keys', 'pads']);
    // The distorted guitar of the slowcore family only plays in the middle section.
    const slow = makeSketch(req({ a: 'slowcore', lengthSec: 60 }));
    const loud = slow.tracks.find((t) => t.id === 'loud');
    const clean = slow.tracks.find((t) => t.id === 'strum');
    expect(loud && loud.drive > 0 && loud.events.length > 0).toBe(true);
    expect(Math.min(...(loud?.events.map((e) => e.time) ?? [0]))).toBeGreaterThan(Math.min(...(clean?.events.map((e) => e.time) ?? [0])) + 5);
  });

  it('adds a wordless voice only when vocals are on', () => {
    expect(groups(req({ a: 'dream-folk', vocals: true }))).toContain('voice');
    expect(groups(req({ a: 'dream-folk', vocals: false }))).not.toContain('voice');
  });

  it('mixes two families without doubling the melody, the bass or the drums', () => {
    const ids = (a: SketchRequest['a'], b: SketchRequest['b'], mix: number): string[] => chooseParts(a, b, mix, false).map((c) => c.spec.id);
    expect(ids('slowcore', 'ambient-keys', 0)).toEqual(ids('slowcore', null, 0));
    expect(ids('slowcore', 'ambient-keys', 1)).toEqual(ids('ambient-keys', null, 0));
    // A touch of ambient: too little to add anything.
    expect(ids('slowcore', 'ambient-keys', 0.1)).toEqual(ids('slowcore', null, 0));
    // Half and half: the pads and the clicks come in, the ambient melody and bass do not.
    const half = ids('slowcore', 'ambient-keys', 0.5);
    expect(half).toContain('ambient-keys-pad');
    expect(half).toContain('ambient-keys-clicks');
    expect(half).not.toContain('ambient-keys-keys');
    expect(half).not.toContain('ambient-keys-sub');
    // The other way round at 40 %: slowcore brings the guitar figure and the drums ambient has none of.
    const other = ids('ambient-keys', 'slowcore', 0.4);
    expect(other).toContain('slowcore-strum');
    expect(other).toContain('slowcore-kick');
    expect(other).not.toContain('slowcore-lead');
  });
});

describe('own words', () => {
  it('leaves out, adds and turns up groups', () => {
    expect(groups(req({ a: 'slowcore', words: 'no drums' }))).toEqual(['bass', 'guitar']);
    expect(groups(req({ a: 'slowcore', words: 'without the guitar, no bass' }))).toEqual(['drums']);
    expect(groups(req({ a: 'ambient-keys', words: 'add drums and add a guitar' }))).toEqual(['bass', 'drums', 'guitar', 'keys', 'pads', 'texture']);
    const plain = makeSketch(req({ a: 'slowcore' })).tracks.find((t) => t.id === 'strum');
    const louder = makeSketch(req({ a: 'slowcore', words: 'more guitar' })).tracks.find((t) => t.id === 'strum');
    expect((louder?.gain ?? 0) / (plain?.gain ?? 1)).toBeCloseTo(1.5, 5);
  });

  it('moves tempo, space and the chain', () => {
    const base = makeSketch(req({ a: 'bedroom-demo' }));
    expect(makeSketch(req({ a: 'bedroom-demo', words: 'slower' })).tempo).toBe(base.tempo - 8);
    expect(makeSketch(req({ a: 'bedroom-demo', words: 'a bit faster' })).tempo).toBe(Math.min(72, base.tempo + 4));
    const preset = PROFILES['bedroom-demo'].fx;
    expect(parseWords('more tape hiss').fx(preset).hissDb).toBe(preset.hissDb + 4);
    expect(parseWords('more tape hiss, more hiss, more hiss').fx(preset).hissDb).toBe(-45);
    expect(parseWords('no hiss').fx(preset).hissDb).toBe(HISS_OFF_DB);
    expect(parseWords('less reverb').fx(preset).room).toBeCloseTo(preset.room - 0.2, 5);
    expect(parseWords('more wobble').fx(preset).wobble).toBeCloseTo(preset.wobble + 0.2, 5);
    expect(parseWords('darker').fx(preset).highCutHz).toBeLessThan(preset.highCutHz);
    expect(parseWords('').fx(POSTFX_CLEAN)).toEqual(POSTFX_CLEAN);
  });

  it('says what it understood and what it did not', () => {
    const r = parseWords('no drums, more tape hiss, like a rainy sunday, slower');
    expect(r.understood).toHaveLength(3);
    expect(r.ignored).toEqual(['like a rainy sunday']);
    expect(parseWords('sadder').minorBias).toBe(1);
  });
});

describe('audio', () => {
  it('is deterministic, finite and at a sane level; voice gives free stems', () => {
    const sketch = makeSketch(req({ a: 'dream-folk', vocals: true, lengthSec: 30 }));
    const a = renderSketch(sketch);
    const b = renderSketch(sketch);
    expect(a.full[0]).toEqual(b.full[0]);
    expect(a.full[1]).toEqual(b.full[1]);
    let bad = 0;
    for (const c of a.full) for (const v of c) if (!Number.isFinite(v)) bad++;
    expect(bad).toBe(0);
    expect(peakDb(a.full)).toBeCloseTo(20 * Math.log10(SKETCH_PEAK), 1);
    expect(rmsDb(a.full)).toBeGreaterThan(-32);
    expect(a.durationSec).toBeGreaterThan(25);
    expect(a.durationSec).toBeLessThan(50);
    expect(a.stems).not.toBeNull();
    expect(rmsDb(a.stems?.vocals ?? a.full)).toBeGreaterThan(-45);
    // The stems add up to the mix.
    const { vocals, backing } = a.stems ?? { vocals: a.full, backing: a.full };
    let worst = 0;
    for (let i = 0; i < a.full[0].length; i += 97) worst = Math.max(worst, Math.abs(vocals[0][i] + backing[0][i] - a.full[0][i]));
    expect(worst).toBeLessThan(1e-5);
    expect(renderSketch(makeSketch(req({ a: 'slowcore' }))).stems).toBeNull();
    // The left and right channels differ (pads and voices are wide).
    let diff = 0;
    for (let i = 0; i < a.full[0].length; i += 31) diff += Math.abs(a.full[0][i] - a.full[1][i]);
    expect(diff).toBeGreaterThan(1);
  });

  it('every family passes the lo-fi chain on target', async () => {
    for (const id of FAMILY_IDS) {
      const audio = renderSketch(makeSketch(req({ a: id, lengthSec: 30, vocals: PROFILES[id].vocalsDefault })));
      const { report } = await renderPostFx({ sampleRate: audio.sampleRate, full: audio.full, stems: audio.stems }, PROFILES[id].fx, { createContext, seed: 3 });
      expect(report.master.onTarget, `${id}: ${report.master.lufs.toFixed(2)} LUFS`).toBe(true);
      expect(report.master.peakDb, id).toBeLessThanOrEqual(-1);
      expect(report.master.truePeakDb, id).toBeLessThanOrEqual(-0.99);
      expect(report.vocalBlurApplied).toBe(audio.stems !== null && PROFILES[id].fx.vocalBlur > 0);
    }
  });
});
