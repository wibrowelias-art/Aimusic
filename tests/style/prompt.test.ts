import { describe, expect, it } from 'vitest';
import { HISS_MAX_DB, HISS_MIN_DB, SLOWED_MAX_PCT } from '../../src/postfx/settings';
import { estimateCost, formatUsd } from '../../src/style/cost';
import { checkDescriptors } from '../../src/style/guard';
import { draftLyrics, draftLyricSections, parseLyrics, parseTopics } from '../../src/style/lyrics';
import { FAMILY_IDS, PROFILES } from '../../src/style/profiles';
import { blendOf, buildPrompt, splitPrompt, splitWords } from '../../src/style/prompt';
import type { StyleRequest } from '../../src/style/types';

const req = (over: Partial<StyleRequest>): StyleRequest => ({ a: 'bedroom-demo', b: null, mix: 0, words: '', vocals: false, lengthSec: 90, ...over });

describe('profiles', () => {
  it('hold descriptors only: every prompt passes the name guard', () => {
    for (const a of FAMILY_IDS) {
      for (const vocals of [true, false]) {
        const text = buildPrompt(req({ a, vocals }));
        expect(checkDescriptors(text), text).toEqual({ ok: true, issues: [] });
        expect(text.length).toBeLessThan(2000);
      }
      for (const b of FAMILY_IDS) {
        expect(checkDescriptors(buildPrompt(req({ a, b, mix: 0.5, vocals: true }))).ok).toBe(true);
      }
    }
  });

  it('keep the chain presets inside the ranges of the brief', () => {
    for (const id of FAMILY_IDS) {
      const { fx, tempoBpm, lengthSec } = PROFILES[id];
      expect(fx.highCutHz, id).toBeGreaterThanOrEqual(8000);
      expect(fx.highCutHz, id).toBeLessThanOrEqual(12000);
      expect(fx.hissDb, id).toBeGreaterThanOrEqual(HISS_MIN_DB);
      expect(fx.hissDb, id).toBeLessThanOrEqual(HISS_MAX_DB);
      expect(fx.slowedPct === 0 || (fx.slowedPct >= 10 && fx.slowedPct <= SLOWED_MAX_PCT), id).toBe(true);
      expect(tempoBpm[0]).toBeLessThan(tempoBpm[1]);
      expect(lengthSec).toBeGreaterThanOrEqual(20);
    }
    expect(PROFILES['slowed-reverb'].fx.slowedPct).toBeGreaterThanOrEqual(10);
    expect(PROFILES['ambient-keys'].fx.roomType).toBe('hall');
  });
});

describe('buildPrompt', () => {
  it('switches the vocal line', () => {
    expect(buildPrompt(req({ vocals: false }))).toContain('Vocals: none. Instrumental only');
    const sung = buildPrompt(req({ a: 'dream-folk', vocals: true }));
    expect(sung).toContain('Vocals: hushed');
    expect(sung).not.toContain('Instrumental only');
  });

  it("appends the owner's words, and takes out what they say no to", () => {
    const text = buildPrompt(req({ words: '  more tape hiss,   no drums. ' }));
    expect(text.split('\n').at(-1)).toBe('Also: more tape hiss.');
    expect(splitPrompt(text).avoid).toContain('drums');
    expect(text).not.toContain('drum machine');
    expect(buildPrompt(req({ words: '' }))).toContain('drum machine');
    expect(buildPrompt(req({ words: '   ' }))).not.toContain('Also:');
    expect(splitWords('without the guitar; remove any hiss, slower')).toEqual({ remove: ['guitar', 'hiss'], rest: ['slower'] });
    const noHiss = buildPrompt(req({ words: 'no hiss' }));
    expect(noHiss).not.toContain('audible tape hiss');
    expect(splitPrompt(noHiss).avoid).toContain('hiss');
  });

  it('mixes two profiles by share', () => {
    const pure = buildPrompt(req({ a: 'slowcore', b: 'ambient-keys', mix: 0 }));
    expect(pure).toBe(buildPrompt(req({ a: 'slowcore' })));
    const touch = buildPrompt(req({ a: 'slowcore', b: 'ambient-keys', mix: 0.2 }));
    expect(touch).toContain('with a touch of calm, slow ambient piece');
    expect(touch).toContain('analog-style synthesizer');
    const even = buildPrompt(req({ a: 'slowcore', b: 'ambient-keys', mix: 0.5 }));
    expect(even.startsWith('An even blend of')).toBe(true);
    const flipped = buildPrompt(req({ a: 'slowcore', b: 'ambient-keys', mix: 0.8 }));
    expect(flipped.startsWith('A calm, slow ambient piece')).toBe(true);
    expect(buildPrompt(req({ a: 'slowcore', b: 'ambient-keys', mix: 1 }))).toBe(buildPrompt(req({ a: 'ambient-keys' })));
  });

  it('does not ask to avoid what the blend asks for', () => {
    // Dream-folk avoids drums; the bedroom demo brings a drum machine.
    const text = buildPrompt(req({ a: 'dream-folk', b: 'bedroom-demo', mix: 0.5 }));
    expect(text).toContain('drum machine');
    expect(splitPrompt(text).avoid).not.toContain('drums');
    expect(splitPrompt(buildPrompt(req({ a: 'dream-folk' }))).avoid).toContain('drums');
    // Vocals on: "vocals" leaves the avoid list.
    expect(splitPrompt(buildPrompt(req({ a: 'ambient-keys', vocals: true }))).avoid).not.toContain('vocals');
  });

  it('blends tempo and the chain preset', () => {
    const a = PROFILES['bedroom-demo'];
    const b = PROFILES['slowed-reverb'];
    const half = blendOf({ a: 'bedroom-demo', b: 'slowed-reverb', mix: 0.5 });
    expect(half.tempoBpm[0]).toBe(Math.round((a.tempoBpm[0] + b.tempoBpm[0]) / 2));
    expect(half.fx.slowedPct).toBe(7);
    expect(half.fx.highCutHz).toBeGreaterThan(8000);
    expect(half.fx.highCutHz).toBeLessThan(9000);
    expect(blendOf({ a: 'bedroom-demo', b: 'bedroom-demo', mix: 0.7 }).fx).toEqual(a.fx);
  });

  it('splits a prompt into style lines and an avoid list', () => {
    const { styles, avoid } = splitPrompt('A slow song.\nMood: calm, warm.\nAvoid: drums, bright leads.\n');
    expect(styles).toEqual(['A slow song', 'Mood: calm, warm']);
    expect(avoid).toEqual(['drums', 'bright leads']);
  });
});

describe('cost', () => {
  it('is length times the per-minute price', () => {
    expect(estimateCost(90).usd).toBeCloseTo(0.225, 3);
    expect(estimateCost(60, { usdPerMinute: 0.3 }).usd).toBeCloseTo(0.3, 3);
    const withStems = estimateCost(120, { stems: true });
    expect(withStems.usd).toBeCloseTo(0.45, 3);
    expect(withStems.lines[1].confirmed).toBe(false);
    expect(formatUsd(0.225)).toBe('$0.23');
    expect(formatUsd(0.05)).toBe('$0.050');
  });
});

describe('lyrics helper', () => {
  it('is deterministic and built around the topics', () => {
    const a = draftLyrics('the bus stop, cold coffee, my brother', 4);
    expect(a).toBe(draftLyrics('the bus stop, cold coffee, my brother', 4));
    expect(a).not.toBe(draftLyrics('the bus stop, cold coffee, my brother', 5));
    for (const topic of ['the bus stop', 'cold coffee', 'my brother']) expect(a).toContain(topic);
    const sections = draftLyricSections('the bus stop, cold coffee, my brother', 4);
    expect(sections.map((s) => s.name)).toEqual(['verse 1', 'refrain', 'verse 2', 'refrain']);
    expect(sections[0].lines).toHaveLength(4);
    expect(sections[1].lines).toEqual(sections[3].lines);
    // No line twice inside the verses.
    const verseLines = [...sections[0].lines, ...sections[2].lines];
    expect(new Set(verseLines).size).toBe(verseLines.length);
  });

  it('gives nothing without topics and caps what it takes', () => {
    expect(draftLyrics('  ,, ', 1)).toBe('');
    expect(parseTopics('a, b; c\nd, e, f, g, h')).toHaveLength(6);
    expect(parseTopics('x'.repeat(100))[0]).toHaveLength(40);
  });

  it('reads its own format back', () => {
    const text = draftLyrics('rain', 2);
    const parsed = parseLyrics(text);
    expect(parsed).toEqual(draftLyricSections('rain', 2));
    expect(parseLyrics('one\ntwo\n\n\n[bridge]\nthree')).toEqual([
      { name: 'verse 1', lines: ['one', 'two'] },
      { name: 'bridge', lines: ['three'] },
    ]);
    expect(parseLyrics('  \n\n')).toEqual([]);
  });
});
