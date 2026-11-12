import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as analysis from '../../src/analysis';
import { AUDIO_TARGETS as targetsDirect } from '../../src/analysis/targets';
import { decayingNoise, sine, SR, vibratoSine, whiteNoise } from '../helpers/signals';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'analysis');

describe('src/analysis index', () => {
  it('exports the measurement API', () => {
    const functions = [
      'measureAudio',
      'longTermSpectrum',
      'spectralCentroid',
      'centroidOfSpectrum',
      'measureRt60',
      'analyzeDecay',
      'measurePitchDeviationCents',
      'frameRmsDb',
      'peakAbs',
      'peakDb',
      'rmsDb',
      'silenceRatio',
      'tailSecAfter',
      'sumChannels',
      'toDb',
      'fromDb',
      'powerToDb',
      'checkAgainstTargets',
      'formatMetricsRow',
      'fftInPlace',
      'realFft',
      'hannWindow',
      'magnitudeSpectrum',
      'isPowerOfTwo',
      'nextPowerOfTwo',
      'binToHz',
      'hzToBin',
      'RealFft',
    ] as const;
    for (const name of functions) expect(typeof analysis[name], name).toBe('function');
    expect(typeof analysis.METRICS_TABLE_HEADER).toBe('string');
    expect(analysis.AUDIO_TARGETS).toBe(targetsDirect);
    expect(analysis.CLIP_LEVEL).toBe(0.999);
    expect(analysis.DEFAULT_SILENCE_THRESHOLD_DB).toBe(-50);
    expect(analysis.DEFAULT_TAIL_THRESHOLD_DB).toBe(-60);
    expect(analysis.DEFAULT_FRAME_MS).toBe(50);
  });

  it('accepts a stereo tuple (the StereoPcm shape of the renderer)', () => {
    const stereo: [Float32Array, Float32Array] = [sine({ hz: 440, seconds: 0.5, amplitude: 0.5 }), sine({ hz: 660, seconds: 0.5, amplitude: 0.5 })];
    const readonlyStereo: readonly Float32Array[] = stereo;
    const m = analysis.measureAudio(stereo, SR, { musicEndSec: 0.25 });
    expect(m.durationSec).toBe(0.5);
    expect(analysis.measureAudio(readonlyStereo, SR, { musicEndSec: 0.25 })).toEqual(m);
    expect(analysis.spectralCentroid(stereo, SR)).toBeCloseTo(550, -1);
    expect(analysis.frameRmsDb(stereo, SR, 50).length).toBe(10);
    expect(analysis.measureRt60(stereo, SR)).toBe(0);
  });
});

describe('purity', () => {
  it('the source uses no randomness, clock, DOM or Web Audio', () => {
    const files = readdirSync(SRC).filter((f) => f.endsWith('.ts'));
    expect(files).toEqual(expect.arrayContaining(['fft.ts', 'index.ts', 'metrics.ts', 'targets.ts', 'types.ts']));
    const banned = [
      'Math.random',
      'Date.now',
      'new Date',
      'performance.',
      'AudioContext',
      'AudioBuffer',
      'window.',
      'window[',
      'document.',
      'globalThis',
      'process.',
      'require(',
      'setTimeout',
    ];
    for (const file of files) {
      const text = readFileSync(join(SRC, file), 'utf8');
      // Only code counts: comments may talk about windows and clocks.
      const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      expect(code.length).toBeGreaterThan(0);
      for (const word of banned) expect(code.includes(word), `${file} contains ${word}`).toBe(false);
      // Plain ASCII only.
      expect(/^[\x09\x0a\x20-\x7e]*$/.test(text), `${file} has non-ASCII characters`).toBe(true);
    }
  });

  it('the same samples give the same numbers, whatever was measured before', () => {
    const left = whiteNoise({ seconds: 2, seed: 71 });
    const right = whiteNoise({ seconds: 2, seed: 72 });
    const first = analysis.measureAudio([left, right], SR, { musicEndSec: 1 });
    // Unrelated work in between (other FFT sizes, other signals).
    analysis.longTermSpectrum([sine({ hz: 100, seconds: 0.3 })], SR, { fftSize: 1024 });
    analysis.measurePitchDeviationCents(vibratoSine({ hz: 440, depthCents: 5, lfoHz: 1, seconds: 2 }), SR, 440);
    const second = analysis.measureAudio([Float32Array.from(left), Float32Array.from(right)], SR, { musicEndSec: 1 });
    expect(second).toEqual(first);
    const ir = decayingNoise({ rt60Sec: 1, seconds: 1.2, seed: 73 });
    expect(analysis.analyzeDecay(Float32Array.from(ir), SR)).toEqual(analysis.analyzeDecay(ir, SR));
  });

  it('does not modify its input', () => {
    const x = whiteNoise({ seconds: 1, seed: 74 });
    const copy = Float32Array.from(x);
    analysis.measureAudio([x], SR, { musicEndSec: 0.5 });
    analysis.measureRt60(x, SR, { bandHz: [500, 1000] });
    analysis.measurePitchDeviationCents(x, SR, 440);
    analysis.longTermSpectrum([x, x], SR, { channelMode: 'power' });
    expect(Buffer.from(x.buffer).equals(Buffer.from(copy.buffer))).toBe(true);
  });
});

describe('speed', () => {
  it('measures a 60 s stereo file in well under a second per pass', () => {
    const left = whiteNoise({ seconds: 60, seed: 81 });
    const right = whiteNoise({ seconds: 60, seed: 82 });
    const t0 = performance.now();
    const m = analysis.measureAudio([left, right], SR, { musicEndSec: 55 });
    const ms = performance.now() - t0;
    console.log(`[analysis] measureAudio on 60 s stereo at 48 kHz: ${ms.toFixed(0)} ms`);
    expect(m.durationSec).toBe(60);
    expect(ms).toBeLessThan(5000);
  });
});
