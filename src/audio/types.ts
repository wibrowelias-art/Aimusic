export type StemName = 'piano' | 'pad' | 'noise';
export const STEM_NAMES: readonly StemName[] = ['piano', 'pad', 'noise'];

export type StereoPcm = [Float32Array, Float32Array];

/** Returns the bytes of one sample file, e.g. "C4.mp3" (browser: fetch, tests: fs). */
export type SampleFetcher = (file: string) => Promise<ArrayBuffer>;

/** Lets the renderer run in the browser and under node-web-audio-api. */
export type OfflineContextFactory = (
  channels: number,
  lengthFrames: number,
  sampleRate: number,
) => OfflineAudioContext;

export interface SampleManifestEntry {
  /** MIDI note the sample was recorded at. */
  midi: number;
  /** Note name, e.g. "F#1". */
  note: string;
  /** File name inside public/samples/piano. */
  file: string;
  /** Seconds. */
  duration: number;
  peakDb: number;
  /** RMS of the first second after the onset, dBFS. */
  rmsDb: number;
  /** Position of the hammer onset inside the file, milliseconds. */
  onsetMs: number;
  /** URL of the original FLAC and its SHA-256 (provenance). */
  source: string;
  sourceSha256: string;
}

/** Shape of public/samples/piano/manifest.json (written by scripts/fetch-samples.mjs). */
export interface SampleManifest {
  instrument: string;
  author: string;
  licence: string;
  source: string;
  changes: string;
  velocityLayer: number;
  sampleRate: number;
  notes: SampleManifestEntry[];
}

export interface RenderResult {
  sampleRate: number;
  /** Frames per channel. */
  length: number;
  /** Final stereo mix. Equal to the sum of the three stems (within float error). */
  mix: StereoPcm;
  stems: Record<StemName, StereoPcm>;
  /** Normalisation gain in dB that was applied equally to the mix and to every stem. */
  gainDb: number;
  /** Time in seconds where the last piano key / pedal / pad note is released. After it: tails only. */
  musicEndSec: number;
}
