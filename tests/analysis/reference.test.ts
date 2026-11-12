/**
 * Reference analysis: general traits only. Synthetic signals with known tempo, key,
 * density, brightness and decay, plus the checks that no note data comes out.
 */
import { describe, expect, it } from 'vitest';
import {
  KEY_MIN_CONFIDENCE,
  REFERENCE_PROMISE,
  TEMPO_MIN_CONFIDENCE,
  analyseReference,
  foldTempo,
  traitsToSettings,
  type ReferenceTraits,
} from '../../src/analysis/reference';
import { MODE_INTERVALS, PARAM_SPECS, presetCenter } from '../../src/engine/params';
import type { Mode } from '../../src/engine/types';

const SR = 22050;

function lcg(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x / 4294967296;
  };
}

interface ToneEvent {
  time: number;
  midi: number;
  /** Seconds the key is held. */
  hold: number;
  amp?: number;
}

/**
 * A plucked tone with a few partials: sharp attack, held, then a tail that falls by 60 dB
 * in `decaySec` seconds (what a reverb of that length would leave).
 */
function synth(events: readonly ToneEvent[], seconds: number, decaySec = 0.6, partials = 4): Float32Array {
  const out = new Float32Array(Math.round(seconds * SR));
  const k = Math.log(1000) / decaySec; // amplitude e-folding rate for 60 dB in decaySec
  for (const e of events) {
    const hz = 440 * 2 ** ((e.midi - 69) / 12);
    const start = Math.round(e.time * SR);
    const amp = e.amp ?? 0.2;
    const end = Math.min(out.length, start + Math.round((e.hold + decaySec * 1.2) * SR));
    for (let i = start; i < end; i++) {
      const t = (i - start) / SR;
      const attack = Math.min(1, t / 0.004);
      const tail = t <= e.hold ? Math.exp(-0.6 * t) : Math.exp(-0.6 * e.hold) * Math.exp(-k * (t - e.hold));
      let v = 0;
      for (let p = 1; p <= partials; p++) v += Math.sin(2 * Math.PI * hz * p * t) / (p * p);
      out[i] += amp * attack * tail * v;
    }
  }
  return out;
}

/** Notes of a key on a steady pulse. The tonic and the fifth come up more often, as in tonal music. */
function tonalEvents(key: number, mode: Mode, bpm: number, seconds: number, seed: number, everyBeats = 1): ToneEvent[] {
  const rand = lcg(seed);
  const iv = MODE_INTERVALS[mode];
  const pool: number[] = [];
  iv.forEach((interval, degree) => {
    const weight = degree === 0 ? 5 : interval === 7 ? 4 : interval === 3 || interval === 4 ? 3 : 2;
    for (let i = 0; i < weight; i++) pool.push(interval);
  });
  const events: ToneEvent[] = [];
  const beat = 60 / bpm;
  for (let t = 0.2; t < seconds - 2; t += beat * everyBeats) {
    const interval = pool[Math.floor(rand() * pool.length)];
    const octave = rand() < 0.5 ? 0 : 12;
    events.push({ time: t, midi: 48 + key + interval + octave, hold: beat * 0.5 });
  }
  return events;
}

describe('analyseReference: result shape (no note data)', () => {
  const traits = analyseReference([synth(tonalEvents(2, 'aeolian', 60, 30, 1), 30)], SR);

  it('returns exactly nine scalars', () => {
    expect(Object.keys(traits).sort()).toEqual(
      ['analysedSec', 'brightnessHz', 'decaySec', 'keyConfidence', 'keyPc', 'mode', 'onsetsPerSecond', 'tempoBpm', 'tempoConfidence'].sort(),
    );
    for (const value of Object.values(traits)) {
      expect(['number', 'string'].includes(typeof value) || value === null).toBe(true);
    }
    // Nothing array-like, nothing nested: a melody has nowhere to hide.
    expect(JSON.stringify(traits).includes('[')).toBe(false);
    expect(JSON.stringify(traits).length).toBeLessThan(400);
  });

  it('says what it reads', () => {
    expect(REFERENCE_PROMISE).toContain('tempo, key, note density, brightness and reverb length');
    expect(REFERENCE_PROMISE).toContain('No melody, no chords and no notes');
  });

  it('two different melodies from the same notes give the same traits', () => {
    // Same onset times and the same multiset of pitches, in a different order.
    const a = tonalEvents(7, 'dorian', 60, 40, 11);
    const rand = lcg(99);
    const pitches = a.map((e) => e.midi);
    for (let i = pitches.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [pitches[i], pitches[j]] = [pitches[j], pitches[i]];
    }
    const b = a.map((e, i) => ({ ...e, midi: pitches[i] }));
    expect(b.map((e) => e.midi)).not.toEqual(a.map((e) => e.midi));
    const ta = analyseReference([synth(a, 40)], SR);
    const tb = analyseReference([synth(b, 40)], SR);
    expect(tb.keyPc).toBe(ta.keyPc);
    expect(tb.mode).toBe(ta.mode);
    expect(tb.tempoBpm).toBeCloseTo(ta.tempoBpm ?? 0, 0);
    expect(Math.abs(tb.onsetsPerSecond - ta.onsetsPerSecond)).toBeLessThan(0.08);
    expect(Math.abs(tb.brightnessHz - ta.brightnessHz) / ta.brightnessHz).toBeLessThan(0.1);
  });

  it('silence and very short input give empty traits without throwing', () => {
    for (const input of [[], [new Float32Array(0)], [new Float32Array(SR * 5)], [new Float32Array(100)]]) {
      const t = analyseReference(input, SR);
      expect(t.tempoBpm).toBeNull();
      expect(t.keyPc).toBeNull();
      expect(t.onsetsPerSecond).toBe(0);
      expect(Number.isFinite(t.brightnessHz)).toBe(true);
    }
    expect(analyseReference([new Float32Array(SR * 5)], 0).analysedSec).toBe(0);
  });
});

describe('analyseReference: tempo and density', () => {
  it.each([50, 60, 72, 90, 120])('a steady pulse at %s BPM', (bpm) => {
    const seconds = 40;
    const events = tonalEvents(0, 'majorPentatonic', bpm, seconds, bpm);
    const t = analyseReference([synth(events, seconds, 0.4)], SR);
    console.log(
      `[reference] pulse ${bpm} BPM: measured ${t.tempoBpm?.toFixed(1)} BPM (confidence ${t.tempoConfidence.toFixed(2)}), ${t.onsetsPerSecond.toFixed(2)} onsets/s (made ${(events.length / seconds).toFixed(2)})`,
    );
    expect(t.tempoBpm).not.toBeNull();
    expect(t.tempoConfidence).toBeGreaterThan(TEMPO_MIN_CONFIDENCE);
    // The pulse or one of its octaves: after folding it must be the lab tempo for that pulse.
    expect(Math.abs(foldTempo(t.tempoBpm ?? 0) - foldTempo(bpm))).toBeLessThanOrEqual(1);
    expect(Math.abs(t.onsetsPerSecond - events.length / seconds) / (events.length / seconds)).toBeLessThan(0.15);
  });

  it('sparser playing gives fewer onsets per second', () => {
    const dense = analyseReference([synth(tonalEvents(0, 'aeolian', 60, 40, 3, 1), 40)], SR);
    const sparse = analyseReference([synth(tonalEvents(0, 'aeolian', 60, 40, 3, 4), 40)], SR);
    expect(sparse.onsetsPerSecond).toBeLessThan(dense.onsetsPerSecond * 0.4);
    expect(sparse.onsetsPerSecond).toBeGreaterThan(0.15);
  });

  it('foldTempo moves a tempo by octaves into 40..72', () => {
    expect(foldTempo(60)).toBe(60);
    expect(foldTempo(120)).toBe(60);
    expect(foldTempo(90)).toBe(45);
    expect(foldTempo(30)).toBe(60);
    expect(foldTempo(140)).toBe(70);
    expect(foldTempo(200)).toBe(50);
    for (let bpm = 20; bpm <= 260; bpm += 1) {
      const t = foldTempo(bpm);
      expect(t).toBeGreaterThanOrEqual(PARAM_SPECS.tempo.min);
      expect(t).toBeLessThanOrEqual(PARAM_SPECS.tempo.max);
    }
  });
});

describe('analyseReference: key and colour', () => {
  const cases: [number, Mode][] = [
    [0, 'majorPentatonic'],
    [2, 'aeolian'],
    [7, 'dorian'],
    [5, 'lydian'],
    [9, 'aeolian'],
    [10, 'majorPentatonic'],
    [4, 'dorian'],
  ];
  it.each(cases)('key %s, %s', (key, mode) => {
    const t = analyseReference([synth(tonalEvents(key, mode, 66, 60, key * 7 + 1), 60)], SR);
    console.log(`[reference] made key ${key} ${mode}: read key ${t.keyPc} ${t.mode} (confidence ${t.keyConfidence.toFixed(2)})`);
    expect(t.keyPc).toBe(key);
    expect(t.keyConfidence).toBeGreaterThan(KEY_MIN_CONFIDENCE);
    const minor = (m: Mode | null): boolean => m === 'aeolian' || m === 'dorian';
    expect(minor(t.mode)).toBe(minor(mode));
    expect(t.mode).toBe(mode);
  });
});

describe('analyseReference: brightness and decay', () => {
  it('more partials read brighter', () => {
    const events = tonalEvents(0, 'aeolian', 60, 20, 5);
    const dull = analyseReference([synth(events, 20, 0.6, 1)], SR);
    const bright = analyseReference([synth(events.map((e) => ({ ...e, midi: e.midi + 24 })), 20, 0.6, 8)], SR);
    expect(bright.brightnessHz).toBeGreaterThan(dull.brightnessHz * 2);
  });

  it.each([1.5, 3, 4.5, 6])('a tail that falls 60 dB in %s s', (decaySec) => {
    // Sparse notes so that every tail can run out.
    const events: ToneEvent[] = [];
    for (let t = 0.5; t < 70; t += decaySec + 2.5) events.push({ time: t, midi: 60 + ((t * 7) % 12 | 0), hold: 0.3 });
    const traits = analyseReference([synth(events, 80, decaySec)], SR);
    console.log(`[reference] tail ${decaySec} s: read ${traits.decaySec?.toFixed(2)} s`);
    expect(traits.decaySec).not.toBeNull();
    expect(Math.abs((traits.decaySec ?? 0) - decaySec) / decaySec).toBeLessThan(0.2);
  });
});

describe('traitsToSettings', () => {
  const current = presetCenter('warm', { seed: 1, key: 0 });
  const base: ReferenceTraits = {
    analysedSec: 120,
    tempoBpm: 118.6,
    tempoConfidence: 0.6,
    keyPc: 2,
    mode: 'aeolian',
    keyConfidence: 0.3,
    onsetsPerSecond: 0.5,
    brightnessHz: 600,
    decaySec: 4.2,
  };

  it('turns clear traits into knob values', () => {
    const { changes, rows } = traitsToSettings(base, current);
    expect(changes.tempo).toBe(59);
    expect(changes.key).toBe(2);
    expect(changes.mode).toBe('aeolian');
    // 0.5 onsets per second at 59 BPM = 2.03 per bar.
    expect(changes.density).toBeCloseTo(0.5 * (240 / 59), 6);
    expect(changes.reverbSize).toBeCloseTo(4.2, 9);
    expect(changes.register).toBeGreaterThanOrEqual(PARAM_SPECS.register.min);
    expect(changes.register).toBeLessThanOrEqual(PARAM_SPECS.register.max);
    expect(changes.lofi).toBeGreaterThan(0);
    expect(changes.lofi).toBeLessThan(1);
    expect(rows.map((r) => r.trait)).toEqual(['Tempo', 'Key', 'Note density', 'Brightness', 'Reverb length']);
    expect(rows[0].setting).toBe('59 BPM (moved by octaves into 40 to 72)');
    expect(rows[1].setting).toBe('D aeolian');
    // Only settings come out: no key that could hold notes.
    expect(Object.keys(changes).sort()).toEqual(['density', 'key', 'lofi', 'mode', 'register', 'reverbSize', 'tempo']);
  });

  it('leaves a knob alone when the trait is unclear', () => {
    const { changes, rows } = traitsToSettings({ ...base, tempoConfidence: 0.05, keyConfidence: 0.01, decaySec: null }, current);
    expect(changes.tempo).toBeUndefined();
    expect(changes.key).toBeUndefined();
    expect(changes.mode).toBeUndefined();
    expect(changes.reverbSize).toBeUndefined();
    expect(rows[0].setting).toBe(`kept at ${current.tempo} BPM`);
    expect(rows[1].setting).toBe('kept');
    expect(rows[4].setting).toBe('kept');
    // Density then uses the tempo that is set.
    expect(changes.density).toBeCloseTo(0.5 * (240 / current.tempo), 6);
  });

  it('clamps what the lab cannot do and says so', () => {
    const { changes, rows } = traitsToSettings({ ...base, onsetsPerSecond: 3, decaySec: 1.2, brightnessHz: 5000 }, current);
    expect(changes.density).toBe(PARAM_SPECS.density.max);
    expect(rows[2].setting).toContain('the lab stops at 4');
    expect(changes.reverbSize).toBe(PARAM_SPECS.reverbSize.min);
    expect(rows[4].setting).toContain('the lab goes from 3 to 6 s');
    expect(changes.register).toBe(PARAM_SPECS.register.max);
    expect(changes.lofi).toBe(0);
    const dark = traitsToSettings({ ...base, brightnessHz: 120 }, current).changes;
    expect(dark.register).toBe(57);
    expect(dark.lofi).toBeCloseTo(0.35 + 0.2 * Math.log2(350 / 120), 9);
    // A reference as bright as the lab's own output leaves both at their defaults.
    const neutral = traitsToSettings({ ...base, brightnessHz: 350 }, current).changes;
    expect(neutral.register).toBe(PARAM_SPECS.register.default);
    expect(neutral.lofi).toBeCloseTo(PARAM_SPECS.lofi.default, 9);
  });
});
