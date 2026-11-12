/** Node-side plumbing for the audio tests: sample files from disk, node-web-audio-api contexts. */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OfflineAudioContext } from 'node-web-audio-api';
import { SAMPLE_RATE } from '../../src/audio/constants';
import { loadPianoSamples, type PianoSampleSet } from '../../src/audio/sampler';
import type { OfflineContextFactory, SampleFetcher, SampleManifest } from '../../src/audio/types';

const SAMPLE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'samples', 'piano');

export const manifest = JSON.parse(readFileSync(join(SAMPLE_DIR, 'manifest.json'), 'utf8')) as SampleManifest;

export const fetchSample: SampleFetcher = async (file) => {
  const bytes = readFileSync(join(SAMPLE_DIR, file));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
};

export const createContext: OfflineContextFactory = (channels, lengthFrames, sampleRate) =>
  new OfflineAudioContext(channels, lengthFrames, sampleRate);

let cached: Promise<PianoSampleSet> | null = null;

/** The real sample set, decoded once per test file. */
export function loadSamples(): Promise<PianoSampleSet> {
  cached ??= loadPianoSamples(createContext(2, SAMPLE_RATE, SAMPLE_RATE), fetchSample, manifest);
  return cached;
}

/**
 * A synthetic sample set for measurements: every "sample" is a pure sine at the
 * pitch of its MIDI note with constant level, so pitch and level can be read
 * off the rendered signal exactly.
 */
export function makeSineSampleSet(midis: number[], seconds: number, amplitude = 0.5): PianoSampleSet {
  const ctx = createContext(1, SAMPLE_RATE, SAMPLE_RATE);
  const frames = Math.round(seconds * SAMPLE_RATE);
  return {
    sampleRate: SAMPLE_RATE,
    samples: midis.map((midi) => {
      const hz = 440 * 2 ** ((midi - 69) / 12);
      const buffer = ctx.createBuffer(1, frames, SAMPLE_RATE);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < frames; i++) data[i] = amplitude * Math.sin((2 * Math.PI * hz * i) / SAMPLE_RATE);
      return { midi, note: `m${midi}`, file: `m${midi}.sine`, buffer, onsetSec: 0, correctionDb: 0 };
    }),
  };
}

/** A synthetic one-sample set of seeded white noise (flat spectrum), for filter measurements. */
export function makeNoiseSampleSet(midi: number, seconds: number, amplitude = 0.25): PianoSampleSet {
  const ctx = createContext(1, SAMPLE_RATE, SAMPLE_RATE);
  const frames = Math.round(seconds * SAMPLE_RATE);
  const buffer = ctx.createBuffer(1, frames, SAMPLE_RATE);
  const data = buffer.getChannelData(0);
  let x = 0x2545f491;
  for (let i = 0; i < frames; i++) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    data[i] = amplitude * (x / 2147483648 - 1);
  }
  return {
    sampleRate: SAMPLE_RATE,
    samples: [{ midi, note: `m${midi}`, file: `m${midi}.noise`, buffer, onsetSec: 0, correctionDb: 0 }],
  };
}
