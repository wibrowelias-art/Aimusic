import { describe, expect, it } from 'vitest';
import { CHAT_EXAMPLES, REFUSAL_TEXT, applyChat } from '../../src/chat/rules';
import { NUMERIC_KEYS, PARAM_SPECS, PRESET_NAMES, normalizeParams, presetCenter } from '../../src/engine/params';
import { createRng } from '../../src/engine/rng';
import type { Params } from '../../src/engine/types';

/** Warm centre: major pentatonic, 56 BPM, 2.1 notes/bar, register 64, rest 0.31, reverb 3.7, lofi 0.5, pad 0.3, rain 0. */
const WARM = presetCenter('warm', { seed: 1, key: 0 });
const chat = (text: string, from: Params = WARM) => applyChat(text, from);
const moved = (text: string, from: Params = WARM): string[] => chat(text, from).changes.map((c) => c.key).sort();

describe('chat: the example from the brief', () => {
  it('"sadder, slower, more space, add rain" moves mode, tempo, register, space, density and rain', () => {
    const r = chat('sadder, slower, more space, add rain');
    expect(r.params.mode).toBe('dorian');
    expect(r.params.tempo).toBe(WARM.tempo - 4 - 6);
    expect(r.params.register).toBe(WARM.register - 2);
    expect(r.params.restProbability).toBeCloseTo(WARM.restProbability + 0.12, 9);
    expect(r.params.density).toBeCloseTo(WARM.density - 0.3, 9);
    expect(r.params.rain).toBeCloseTo(0.35, 9);
    expect(r.changes.map((c) => c.key)).toEqual(['mode', 'tempo', 'density', 'register', 'restProbability', 'rain']);
    expect(r.understood).toEqual(['sadder', 'slower', 'more space', 'rain']);
    expect(r.ignored).toEqual([]);
    expect(r.refused).toEqual([]);
    expect(r.notes).toEqual([]);
    expect(r.action).toBeNull();
    // The seed and everything not asked for stay as they were.
    expect(r.params.seed).toBe(WARM.seed);
    expect(r.params.key).toBe(WARM.key);
    expect(r.params.reverbSize).toBe(WARM.reverbSize);
    expect(r.params.lofi).toBe(WARM.lofi);
    // "what changed" is readable.
    const tempo = r.changes.find((c) => c.key === 'tempo');
    expect(tempo).toEqual({ key: 'tempo', label: 'Tempo', from: '56 BPM', to: '46 BPM' });
    expect(r.changes.find((c) => c.key === 'mode')).toMatchObject({ from: 'Major pentatonic', to: 'Dorian' });
  });

  it('every example chip does something', () => {
    for (const example of CHAT_EXAMPLES) {
      const r = chat(example);
      expect(r.changes.length, example).toBeGreaterThan(0);
      expect(r.ignored, example).toEqual([]);
      expect(r.refused, example).toEqual([]);
    }
  });
});

describe('chat: directions and amounts', () => {
  it('tempo words', () => {
    expect(chat('slower').params.tempo).toBe(50);
    expect(chat('much slower').params.tempo).toBe(44);
    expect(chat('a bit slower').params.tempo).toBe(53);
    expect(chat('faster').params.tempo).toBe(62);
    expect(chat('speed it up a lot').params.tempo).toBe(62);
    expect(chat('too slow').params.tempo).toBe(62);
    expect(chat('too fast').params.tempo).toBe(50);
    expect(chat('lower the tempo').params.tempo).toBe(50);
    expect(chat('raise the tempo').params.tempo).toBe(62);
    expect(chat('tempo down').params.tempo).toBe(50);
    expect(moved('lower the tempo')).toEqual(['tempo']);
  });

  it('space and density words', () => {
    expect(moved('more space')).toEqual(['density', 'restProbability']);
    expect(chat('more space').params.restProbability).toBeGreaterThan(WARM.restProbability);
    expect(chat('less space').params.restProbability).toBeLessThan(WARM.restProbability);
    expect(chat('too busy').params.density).toBeLessThan(WARM.density);
    expect(chat('busier').params.density).toBeGreaterThan(WARM.density);
    expect(chat('sparser').params.density).toBeLessThan(WARM.density);
    expect(chat('fewer notes').params.density).toBeLessThan(WARM.density);
    expect(chat('more notes').params.density).toBeGreaterThan(WARM.density);
    expect(chat('more space between the notes').params.density).toBeLessThan(WARM.density);
    expect(chat('calmer').params.density).toBeLessThan(WARM.density);
    expect(chat('too empty').params.density).toBeGreaterThan(WARM.density);
  });

  it('reverb words', () => {
    expect(chat('more reverb').params.reverbSize).toBeCloseTo(4.5, 9);
    expect(chat('a bit more reverb').params.reverbSize).toBeCloseTo(4.1, 9);
    expect(chat('less reverb').params.reverbSize).toBeCloseTo(3.0, 9);
    expect(chat('too much reverb').params.reverbSize).toBeLessThan(WARM.reverbSize);
    expect(chat('drier').params.reverbSize).toBeLessThan(WARM.reverbSize);
    expect(chat('no reverb').params.reverbSize).toBe(PARAM_SPECS.reverbSize.min);
    expect(chat('turn the reverb down').params.reverbSize).toBeLessThan(WARM.reverbSize);
    expect(chat('turn down the reverb').params.reverbSize).toBeLessThan(WARM.reverbSize);
    expect(chat('turn up the reverb').params.reverbSize).toBeGreaterThan(WARM.reverbSize);
    expect(chat('max reverb').params.reverbSize).toBe(PARAM_SPECS.reverbSize.max);
    expect(chat('like a cave').params.reverbSize).toBe(6);
    expect(chat('like a cave').refused).toEqual([]);
  });

  it('rain, pad and lo-fi words', () => {
    expect(chat('add rain').params.rain).toBeCloseTo(0.35, 9);
    expect(chat('heavy rain').params.rain).toBe(0.75);
    expect(chat('light rain').params.rain).toBe(0.2);
    const rainy = normalizeParams({ ...WARM, rain: 0.5 });
    expect(chat('no rain', rainy).params.rain).toBe(0);
    expect(chat('stop the rain', rainy).params.rain).toBe(0);
    expect(chat('rain off', rainy).params.rain).toBe(0);
    expect(chat('less rain', rainy).params.rain).toBeLessThan(0.5);
    expect(chat('more rain', rainy).params.rain).toBeGreaterThan(0.5);
    expect(chat("i don't like the rain", rainy).params.rain).toBe(0);
    expect(chat('no pad').params.pad).toBe(0);
    expect(chat('add a pad').params.pad).toBeGreaterThan(WARM.pad);
    expect(chat('just piano', rainy).params).toMatchObject({ pad: 0, rain: 0 });
    expect(chat('more tape').params.lofi).toBeGreaterThan(WARM.lofi);
    expect(chat('cleaner').params.lofi).toBeLessThan(WARM.lofi);
    expect(chat('no hiss').params.lofi).toBe(0);
    expect(chat('less wobble').params.lofi).toBeLessThan(WARM.lofi);
  });

  it('tone and mood words', () => {
    expect(chat('brighter').params.register).toBe(WARM.register + 4);
    expect(chat('a bit brighter').params.register).toBe(WARM.register + 2);
    expect(chat('darker').params.register).toBe(WARM.register - 4);
    expect(chat('too bright').params.register).toBeLessThan(WARM.register);
    expect(chat('not so dark').params.register).toBeGreaterThan(WARM.register);
    expect(chat('an octave higher').params.register).toBe(Math.min(PARAM_SPECS.register.max, WARM.register + 12));
    expect(chat('dreamier').params).toMatchObject({ mode: 'lydian' });
    expect(chat('dreamier').params.reverbSize).toBeGreaterThan(WARM.reverbSize);
    expect(chat('warmer').params.lofi).toBeGreaterThan(WARM.lofi);
    expect(chat('colder').params.lofi).toBeLessThan(WARM.lofi);
    expect(chat('longer').params.length).toBe(WARM.length + 20);
    expect(chat('much shorter').params.length).toBe(WARM.length - 40);
    // Sadder walks towards minor one step at a time; happier walks back.
    const dorian = chat('sadder').params;
    expect(dorian.mode).toBe('dorian');
    const aeolian = chat('sadder', dorian).params;
    expect(aeolian.mode).toBe('aeolian');
    expect(chat('sadder', aeolian).params.mode).toBe('aeolian');
    expect(chat('happier', aeolian).params.mode).toBe('dorian');
    expect(chat('less sad', aeolian).params.mode).toBe('dorian');
    expect(chat('happier', dorian).params.mode).toBe('majorPentatonic');
  });

  it('several things in one sentence, with their own amounts', () => {
    const r = chat('a bit more reverb and much less rain, slightly slower', normalizeParams({ ...WARM, rain: 0.6 }));
    expect(r.params.reverbSize).toBeCloseTo(4.1, 9);
    expect(r.params.rain).toBeCloseTo(0.1, 9);
    expect(r.params.tempo).toBe(53);
    const s = chat('much slower more reverb');
    expect(s.params.tempo).toBe(44);
    expect(s.params.reverbSize).toBeCloseTo(4.5, 9);
  });
});

describe('chat: explicit values', () => {
  it('numbers with units', () => {
    expect(chat('tempo 60').params.tempo).toBe(60);
    expect(chat('60 bpm').params.tempo).toBe(60);
    expect(chat('make it 48bpm').params.tempo).toBe(48);
    expect(chat('2 minutes').params.length).toBe(120);
    expect(chat('1:30').params.length).toBe(90);
    expect(chat('90 seconds long').params.length).toBe(90);
    expect(chat('reverb 5s').params.reverbSize).toBe(5);
    expect(chat('5 seconds of reverb').params.reverbSize).toBe(5);
    expect(chat('3 notes per bar').params.density).toBe(3);
  });

  it('out-of-range numbers are clamped and said so', () => {
    const r = chat('tempo 120');
    expect(r.params.tempo).toBe(72);
    expect(r.notes.join(' ')).toContain('40 BPM to 72 BPM');
    expect(chat('20 bpm').params.tempo).toBe(40);
  });

  it('keys and modes', () => {
    expect(chat('in d minor').params).toMatchObject({ key: 2, mode: 'aeolian' });
    expect(chat('key of f#').params.key).toBe(6);
    expect(chat('f sharp dorian').params).toMatchObject({ key: 6, mode: 'dorian' });
    expect(chat('in Bb major').params).toMatchObject({ key: 10, mode: 'majorPentatonic' });
    expect(chat('lydian').params.mode).toBe('lydian');
    expect(chat('in e').params.key).toBe(4);
    // "a" is an article unless a mode follows.
    expect(chat('in a cave').params.key).toBe(WARM.key);
    expect(chat('in a minor').params).toMatchObject({ key: 9, mode: 'aeolian' });
    expect(chat('a bit darker').params.key).toBe(WARM.key);
  });
});

describe('chat: existing music and note lists are left out', () => {
  const cases: [string, string[]][] = [
    ['like Sweden by C418', ['like Sweden by C418']],
    ['make it sound like the Minecraft soundtrack', ['sound like the Minecraft soundtrack']],
    ['in the style of Satie', ['in the style of Satie']],
    ['play clair de lune', ['play clair de lune']],
    ['recreate the intro of that famous song', ['recreate the intro of that famous song']],
    ['like "Warmth"', ['"Warmth"']],
    ['like Warmth', ['like Warmth']],
    ['something by Satie', ['Satie']],
    ['use the melody from zelda', ['melody from zelda']],
    ['chords: Am F C G', ['chords: Am F C G']],
    ['the notes are c e g a', ['notes are c e g a']],
    ['c e g b', ['c e g b']],
    ['inspired by ghibli films', ['inspired by ghibli films']],
  ];
  it.each(cases)('%s', (text, refused) => {
    const r = chat(text);
    expect(r.refused).toEqual(refused);
    expect(r.changes).toEqual([]);
    expect(r.params).toEqual(WARM);
    expect(r.notes[0]).toBe(REFUSAL_TEXT);
  });

  it('the rest of the message still counts', () => {
    const r = chat('slower, like the Minecraft soundtrack, and add rain');
    expect(r.refused).toEqual(['like the Minecraft soundtrack']);
    expect(r.params.tempo).toBe(50);
    expect(r.params.rain).toBeCloseTo(0.35, 9);
    expect(r.notes[0]).toBe(REFUSAL_TEXT);
    const s = chat('sadder like Hans Zimmer');
    expect(s.refused).toEqual(['like Hans Zimmer']);
    expect(s.params.mode).toBe('dorian');
  });

  it('mood words after "like" are moods, not references', () => {
    for (const text of ['like rain', 'like a dream', 'more like a cave', 'play it slower', 'play something sad', 'I like it but slower']) {
      const r = chat(text);
      expect(r.refused, text).toEqual([]);
      expect(r.changes.length, text).toBeGreaterThan(0);
    }
  });

  it('capitalised mood words at the start of a sentence are fine', () => {
    const r = chat('Sadder. Slower. More Reverb');
    expect(r.refused).toEqual([]);
    expect(r.ignored).toEqual([]);
    expect(r.params.tempo).toBe(46);
    expect(chat('SLOWER AND SADDER').refused).toEqual([]);
    expect(chat('SLOWER AND SADDER').params.tempo).toBe(46);
  });

  it('a statement of taste changes nothing', () => {
    const r = chat('I like the reverb');
    expect(r.changes).toEqual([]);
    expect(r.refused).toEqual([]);
    expect(r.notes.join(' ')).toContain('thumbs up');
  });
});

describe('chat: phrasings that used to go wrong', () => {
  it('"slow down" is slower, not "slow" followed by "down"', () => {
    const r = chat("slow down, it's too fast and too bright");
    expect(r.params.tempo).toBe(44);
    expect(r.params.register).toBe(WARM.register - 4);
    expect(r.ignored).toEqual([]);
    expect(chat('calm down').params.density).toBeLessThan(WARM.density);
  });

  it('"too much" is not "much more"', () => {
    expect(chat('too much reverb').params.reverbSize).toBeCloseTo(WARM.reverbSize - 0.8 < 3 ? 3 : WARM.reverbSize - 0.8, 9);
    expect(chat('too much reverb').understood).toEqual(['less reverb']);
    const wet = normalizeParams({ ...WARM, reverbSize: 5 });
    expect(chat('not too much reverb', wet).params.reverbSize).toBeCloseTo(4.2, 9);
    expect(chat('much less reverb', wet).params.reverbSize).toBeCloseTo(3.4, 9);
  });

  it('"remove the tape hiss and the pad" takes both out, once each', () => {
    const r = chat('remove the tape hiss and the pad');
    expect(r.params.lofi).toBe(0);
    expect(r.params.pad).toBe(0);
    expect(r.understood).toEqual(['no lo-fi', 'no pad']);
    // The "no" does not leak onto words that are not levels.
    const s = chat('no rain and slower', normalizeParams({ ...WARM, rain: 0.4 }));
    expect(s.params.rain).toBe(0);
    expect(s.params.tempo).toBe(50);
    // And not past a clause with its own direction.
    const t = chat('no rain and more reverb', normalizeParams({ ...WARM, rain: 0.4 }));
    expect(t.params.reverbSize).toBeGreaterThan(WARM.reverbSize);
  });

  it('a mood described with "like" is a mood, the unknown rest is reported', () => {
    const r = chat('Make it feel like a cold winter morning');
    expect(r.refused).toEqual([]);
    expect(r.understood).toEqual(['colder']);
    expect(r.ignored).toEqual(['morning']);
    expect(r.params.lofi).toBeLessThan(WARM.lofi);
  });

  it('amount words are never reported as unknown', () => {
    const r = chat('huge reverb');
    expect(r.ignored).toEqual([]);
    expect(r.params.reverbSize).toBeCloseTo(WARM.reverbSize + 1.6, 9);
    expect(chat('D minor please, around 50 bpm, 2 min long').ignored).toEqual([]);
  });

  it('softer has no knob of its own: a little sparser and darker', () => {
    const r = chat('make the piano softer');
    expect(r.understood).toEqual(['gentler']);
    expect(r.params.density).toBeCloseTo(WARM.density - 0.2, 9);
  });

  it('a name after "like" is left out even when it is also a mood word', () => {
    const r = chat('make it sound like Warmth but slower');
    expect(r.refused).toEqual(['sound like Warmth']);
    expect(r.params.tempo).toBe(50);
    expect(r.params.lofi).toBe(WARM.lofi);
    expect(chat('I want it to sound like Ludovico Einaudi').refused).toEqual(['sound like Ludovico Einaudi']);
    expect(chat('like the song from my childhood').refused).toEqual(['song from my childhood']);
    expect(chat('like the song from my childhood').changes).toEqual([]);
  });
});

describe('chat: edges', () => {
  it('unknown words are reported, not guessed', () => {
    const r = chat('make it purple and slower');
    expect(r.ignored).toEqual(['purple']);
    expect(r.params.tempo).toBe(50);
    expect(chat('asdf qwerty').changes).toEqual([]);
    expect(chat('asdf qwerty').ignored).toEqual(['asdf', 'qwerty']);
  });

  it('empty input gives a hint', () => {
    const r = chat('   ');
    expect(r.changes).toEqual([]);
    expect(r.notes[0]).toContain('sadder, slower');
  });

  it('a knob at its end says so', () => {
    const slowest = normalizeParams({ ...WARM, tempo: 40 });
    const r = chat('slower', slowest);
    expect(r.changes).toEqual([]);
    expect(r.understood).toEqual(['slower']);
    expect(r.notes.join(' ')).toContain('nothing moved');
  });

  it('asks for takes: "another one", "again but slower"', () => {
    expect(chat('another one').action).toBe('generate');
    expect(chat('another one').changes).toEqual([]);
    const r = chat('again but slower');
    expect(r.action).toBe('again');
    expect(r.params.tempo).toBe(50);
    expect(chat('surprise me').action).toBe('generate');
  });

  it('is deterministic and never leaves the knob ranges', () => {
    const words = ['sadder', 'happier', 'slower', 'faster', 'more space', 'busier', 'more reverb', 'drier', 'add rain', 'no rain', 'warmer', 'colder', 'brighter', 'darker', 'dreamier', 'much', 'a bit', 'less', 'no', 'too', 'longer', 'shorter', 'cave', 'lo-fi', 'cleaner', 'pad', 'tempo 200', 'in g minor', 'like', 'and', ',', 'play', 'max'];
    const rng = createRng(4242);
    for (let i = 0; i < 1500; i++) {
      const preset = rng.pick(PRESET_NAMES);
      let params = presetCenter(preset, { seed: i });
      const text = Array.from({ length: rng.int(1, 7) }, () => rng.pick(words)).join(' ');
      const a = applyChat(text, params);
      const b = applyChat(text, params);
      expect(b).toEqual(a);
      params = a.params;
      expect(normalizeParams(params)).toEqual(params);
      for (const k of NUMERIC_KEYS) {
        expect(params[k]).toBeGreaterThanOrEqual(PARAM_SPECS[k].min);
        expect(params[k]).toBeLessThanOrEqual(PARAM_SPECS[k].max);
      }
      expect(params.seed).toBe(i);
    }
  });
});
