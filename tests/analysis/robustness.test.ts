import { describe, expect, it } from 'vitest';
import {
  analyzeDecay,
  checkAgainstTargets,
  formatMetricsRow,
  frameRmsDb,
  longTermSpectrum,
  measureAudio,
  measurePitchDeviationCents,
  silenceRatio,
  spectralCentroid,
  tailSecAfter,
} from '../../src/analysis';
import { makeRng, type Rng } from '../helpers/signals';

/** A signal of a random kind and a random (often tiny) length. Seeded: the same every run. */
function randomSignal(rng: Rng, sampleRate: number): Float32Array {
  const lengths = [0, 1, 2, 3, 15, 16, 17, 100, 1023, 2400, 4096, 5000, 20000];
  const n = rng.next() < 0.5 ? lengths[Math.floor(rng.uniform(0, lengths.length))] : Math.floor(rng.uniform(0, 30000));
  const x = new Float32Array(n);
  const kind = Math.floor(rng.uniform(0, 8));
  const level = 10 ** rng.uniform(-6, 0.3);
  const hz = rng.uniform(20, 0.45 * sampleRate);
  const decay = rng.uniform(1, 400) / sampleRate;
  for (let i = 0; i < n; i++) {
    switch (kind) {
      case 0: // silence
        break;
      case 1: // noise
        x[i] = level * rng.gaussian();
        break;
      case 2: // tone
        x[i] = level * Math.sin((2 * Math.PI * hz * i) / sampleRate);
        break;
      case 3: // decaying noise
        x[i] = level * rng.gaussian() * Math.exp(-decay * i);
        break;
      case 4: // constant
        x[i] = level;
        break;
      case 5: // sparse clicks
        x[i] = rng.next() < 0.001 ? level : 0;
        break;
      case 6: // rising noise
        x[i] = level * rng.gaussian() * (i / Math.max(1, n));
        break;
      default: // decaying tone on a noise floor
        x[i] = level * (Math.sin((2 * Math.PI * hz * i) / sampleRate) * Math.exp(-decay * i) + 0.001 * rng.gaussian());
    }
  }
  return x;
}

describe('any input: no exception, no NaN', () => {
  it('300 random signals through every measurement', () => {
    const rng = makeRng(20240607);
    for (let trial = 0; trial < 300; trial++) {
      const sampleRate = [8000, 22050, 44100, 48000, 96000][Math.floor(rng.uniform(0, 5))];
      const channelCount = Math.floor(rng.uniform(0, 3.99));
      const channels = Array.from({ length: channelCount }, () => randomSignal(rng, sampleRate));
      const first = channels[0] ?? new Float32Array(0);
      const label = `trial ${trial}: ${channelCount} channels, ${first.length} samples at ${sampleRate} Hz`;
      const musicEndSec = rng.uniform(-0.1, 1);

      const m = measureAudio(channels, sampleRate, { musicEndSec, frameMs: rng.uniform(1, 80) });
      expect(Number.isNaN(m.peakDb) || Number.isNaN(m.rmsDb) || Number.isNaN(m.crestDb), label).toBe(false);
      expect(m.peakDb, label).toBeLessThan(40);
      expect(Number.isFinite(m.crestDb) && m.crestDb >= -1e-9, label).toBe(true);
      expect(Number.isFinite(m.dcOffset), label).toBe(true);
      expect(m.silenceRatio >= 0 && m.silenceRatio <= 1, label).toBe(true);
      expect(m.spectralCentroidHz >= 0 && m.spectralCentroidHz <= sampleRate / 2, label).toBe(true);
      expect(m.tailSec !== null && m.tailSec >= 0 && m.tailSec <= m.durationSec + 1e-9, label).toBe(true);
      expect(m.clippedSamples >= 0, label).toBe(true);
      expect(typeof formatMetricsRow(label, m), label).toBe('string');
      expect(Array.isArray(checkAgainstTargets(m, { pianoSilenceRatio: m.silenceRatio }).failures), label).toBe(true);

      expect(frameRmsDb(channels, sampleRate, 50).some((v) => Number.isNaN(v)), label).toBe(false);
      expect(silenceRatio(channels, sampleRate, -30), label).toBeGreaterThanOrEqual(m.silenceRatio === 1 ? 1 : 0);
      expect(tailSecAfter(channels, sampleRate, musicEndSec, -30), label).toBeGreaterThanOrEqual(0);
      const lts = longTermSpectrum(channels, sampleRate, { fftSize: 512, channelMode: 'power' });
      expect(lts.power.every((p) => Number.isFinite(p) && p >= 0), label).toBe(true);
      expect(spectralCentroid(channels, sampleRate, { fftSize: 256, hopSize: 100 }), label).toBeGreaterThanOrEqual(0);

      for (const input of [first, channels]) {
        const band = rng.next() < 0.3 ? ([200, 2000] as const) : undefined;
        const d = analyzeDecay(input, sampleRate, { bandHz: band });
        expect(Object.values(d).every((v) => typeof v === 'boolean' || Number.isFinite(v)), label).toBe(true);
        expect(d.rt60Sec, label).toBeGreaterThanOrEqual(0);
        expect(d.fitToDb, label).toBeLessThan(d.fitFromDb);
        expect(d.onsetSec >= 0 && d.truncationSec >= 0, label).toBe(true);
        expect(d.correlation >= -1.0000001 && d.correlation <= 0, label).toBe(true);
      }

      const nominal = rng.uniform(10, sampleRate * 0.6);
      const p = measurePitchDeviationCents(first, sampleRate, nominal);
      expect(Number.isFinite(p.maxCents) && Number.isFinite(p.rmsCents) && Number.isFinite(p.meanCents), label).toBe(true);
      expect(p.maxCents + 1e-9 >= p.rmsCents && p.rmsCents + 1e-9 >= Math.abs(p.meanCents), label).toBe(true);
      expect(p.lfoHz === null || (Number.isFinite(p.lfoHz) && p.lfoHz > 0), label).toBe(true);
      expect(p.analyzedSec >= 0 && p.analyzedSec <= first.length / sampleRate, label).toBe(true);
    }
  });
});
