/**
 * Audio measurements on plain sample arrays.
 *
 * Pure TypeScript on Float32Array, no Web Audio, no randomness, no clock: the same
 * samples always give the same numbers. Nothing in here judges how audio sounds;
 * it only produces the numbers that go into TUNING.md and the automated checks.
 *
 * Conventions: channels are equally long Float32Arrays in the range -1 .. 1 (a shorter
 * channel counts as zero-padded), levels are dBFS (1.0 = 0 dBFS), times are seconds.
 */
import { fftInPlace, hannWindow, isPowerOfTwo, nextPowerOfTwo, RealFft } from './fft';
import { AUDIO_TARGETS } from './targets';
import type { AudioMetrics } from './types';

export type Channels = readonly Float32Array[];

/** A sample with |x| at or above this counts as clipped (see AudioMetrics.clippedSamples). */
export const CLIP_LEVEL = 0.999;
export const DEFAULT_SILENCE_THRESHOLD_DB = -50;
export const DEFAULT_TAIL_THRESHOLD_DB = -60;
export const DEFAULT_FRAME_MS = 50;

/** Mean power below this (-200 dBFS) is treated as digital silence. */
const SILENCE_POWER = 1e-20;

// ---------------------------------------------------------------------------
// dB helpers
// ---------------------------------------------------------------------------

/** Amplitude to dB: 20 log10(|a|). 0 gives -Infinity. */
export function toDb(amplitude: number): number {
  const a = Math.abs(amplitude);
  if (a > 0) return 20 * Math.log10(a);
  return a === 0 ? -Infinity : NaN;
}

/** dB to amplitude: 10^(dB / 20). -Infinity gives 0. */
export function fromDb(db: number): number {
  return 10 ** (db / 20);
}

/** Power (mean square) to dB: 10 log10(p). 0 gives -Infinity. */
export function powerToDb(power: number): number {
  if (power > 0) return 10 * Math.log10(power);
  return power === 0 ? -Infinity : NaN;
}

function assertSampleRate(sampleRate: number): void {
  if (!(Number.isFinite(sampleRate) && sampleRate > 0)) {
    throw new RangeError(`sampleRate must be a positive number, got ${sampleRate}`);
  }
}

function maxLength(channels: Channels): number {
  let n = 0;
  for (const ch of channels) if (ch.length > n) n = ch.length;
  return n;
}

/** Sample-wise sum of several channel sets (e.g. the piano and the pad stem). */
export function sumChannels(...parts: Channels[]): Float32Array[] {
  const count = parts.reduce((m, p) => Math.max(m, p.length), 0);
  const length = parts.reduce((m, p) => Math.max(m, maxLength(p)), 0);
  const out: Float32Array[] = [];
  for (let c = 0; c < count; c++) {
    const acc = new Float64Array(length);
    for (const part of parts) {
      const ch = part[c];
      if (!ch) continue;
      for (let i = 0; i < ch.length; i++) acc[i] += ch[i];
    }
    out.push(Float32Array.from(acc));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Levels of a stretch of samples
// ---------------------------------------------------------------------------

/**
 * Largest |sample| over all channels inside [fromSample, toSample), linear.
 * 0 for an empty stretch, NaN when the stretch holds a NaN sample.
 */
export function peakAbs(channels: Channels, fromSample = 0, toSample = Infinity): number {
  let peak = 0;
  for (const ch of channels) {
    const end = Math.min(toSample, ch.length);
    for (let i = Math.max(0, Math.ceil(fromSample)); i < end; i++) {
      const a = Math.abs(ch[i]);
      if (a > peak) peak = a;
      else if (Number.isNaN(a)) return NaN;
    }
  }
  return peak;
}

/** Sample peak in dBFS over all channels inside [fromSample, toSample). -Infinity for silence. */
export function peakDb(channels: Channels, fromSample = 0, toSample = Infinity): number {
  return toDb(peakAbs(channels, fromSample, toSample));
}

/**
 * RMS in dBFS over all channels inside [fromSample, toSample) (every channel counts with
 * the samples it has there). -Infinity for silence or an empty stretch.
 */
export function rmsDb(channels: Channels, fromSample = 0, toSample = Infinity): number {
  let sum = 0;
  let count = 0;
  for (const ch of channels) {
    const end = Math.min(toSample, ch.length);
    for (let i = Math.max(0, Math.ceil(fromSample)); i < end; i++) {
      sum += ch[i] * ch[i];
      count++;
    }
  }
  return count > 0 ? powerToDb(sum / count) : -Infinity;
}

// ---------------------------------------------------------------------------
// Frame levels, silence ratio, tail
// ---------------------------------------------------------------------------

function frameLength(sampleRate: number, frameMs: number): number {
  if (!(Number.isFinite(frameMs) && frameMs > 0)) throw new RangeError(`frameMs must be positive, got ${frameMs}`);
  return Math.max(1, Math.round((sampleRate * frameMs) / 1000));
}

/**
 * Mean square of consecutive frames (all channels together), starting at `startSample`.
 * The last frame may be shorter than the others; its mean is taken over the samples it has.
 */
function frameMeanSquares(channels: Channels, frameLen: number, startSample = 0): Float64Array {
  const n = maxLength(channels);
  const count = n > startSample ? Math.ceil((n - startSample) / frameLen) : 0;
  const out = new Float64Array(count);
  for (const ch of channels) {
    for (let f = 0; f < count; f++) {
      const start = startSample + f * frameLen;
      if (start >= ch.length) break;
      const stop = Math.min(ch.length, start + frameLen);
      let acc = 0;
      for (let i = start; i < stop; i++) acc += ch[i] * ch[i];
      out[f] += acc;
    }
  }
  for (let f = 0; f < count; f++) {
    const start = startSample + f * frameLen;
    out[f] /= Math.min(frameLen, n - start) * channels.length;
  }
  return out;
}

/**
 * RMS level in dBFS of consecutive frames of `frameMs` milliseconds, all channels together.
 * Frame k covers [k * frame, (k + 1) * frame); the last one may be shorter. Silent frames are -Infinity.
 */
export function frameRmsDb(channels: Channels, sampleRate: number, frameMs = DEFAULT_FRAME_MS): Float32Array {
  assertSampleRate(sampleRate);
  const ms = frameMeanSquares(channels, frameLength(sampleRate, frameMs));
  const out = new Float32Array(ms.length);
  for (let f = 0; f < ms.length; f++) out[f] = powerToDb(ms[f]);
  return out;
}

/**
 * Share of frames whose RMS is below `thresholdDb`. An empty signal counts as
 * completely silent (1), so that an empty render can never pass a check.
 */
export function silenceRatio(
  channels: Channels,
  sampleRate: number,
  thresholdDb = DEFAULT_SILENCE_THRESHOLD_DB,
  frameMs = DEFAULT_FRAME_MS,
): number {
  assertSampleRate(sampleRate);
  const ms = frameMeanSquares(channels, frameLength(sampleRate, frameMs));
  if (ms.length === 0) return 1;
  const limit = 10 ** (thresholdDb / 10);
  let silent = 0;
  for (let f = 0; f < ms.length; f++) if (ms[f] < limit) silent++;
  return silent / ms.length;
}

/**
 * Seconds from `musicEndSec` until the frame RMS stays below `thresholdDb` for the rest
 * of the file. Frames are `frameMs` long and start exactly at `musicEndSec`, so the result
 * is a multiple of the frame length (0 = already below at the music end). When the last
 * frame of the file is still above the threshold the result is the whole remainder of the file.
 */
export function tailSecAfter(
  channels: Channels,
  sampleRate: number,
  musicEndSec: number,
  thresholdDb = DEFAULT_TAIL_THRESHOLD_DB,
  frameMs = DEFAULT_FRAME_MS,
): number {
  assertSampleRate(sampleRate);
  const frameLen = frameLength(sampleRate, frameMs);
  const n = maxLength(channels);
  const start = Math.min(n, Math.max(0, Math.round(musicEndSec * sampleRate)));
  const ms = frameMeanSquares(channels, frameLen, start);
  const limit = 10 ** (thresholdDb / 10);
  let last = ms.length - 1;
  while (last >= 0 && ms[last] < limit) last--;
  if (last < 0) return 0;
  return Math.min((last + 1) * frameLen, n - start) / sampleRate;
}

// ---------------------------------------------------------------------------
// Long-term spectrum and spectral centroid
// ---------------------------------------------------------------------------

export interface SpectrumOptions {
  /** Window and FFT size, a power of two. Default 4096. */
  fftSize?: number;
  /**
   * Samples between frames. Default fftSize / 4: with the Hann window every sample of
   * the file then carries exactly the same weight (the squared windows add up to a constant).
   */
  hopSize?: number;
  /**
   * 'mono' (default): spectrum of the mono sum (mean of the channels).
   * 'power': mean of the power spectra of the individual channels.
   */
  channelMode?: 'mono' | 'power';
}

export interface LongTermSpectrum {
  sampleRate: number;
  fftSize: number;
  hopSize: number;
  /** Width of one bin in Hz; bin k is centred on k * binHz. */
  binHz: number;
  /** Number of averaged frames. */
  frames: number;
  /**
   * Long-term average power per bin, bins 0 .. fftSize / 2 (one-sided).
   * The bins add up to the mean square of the analysed signal (with the default hop exactly).
   */
  power: Float64Array;
}

/**
 * frame[j] = hann[j] * x[start + j] where that sample exists, 0 elsewhere.
 * With `pair` (same length as `x`) the mean of the two channels is loaded.
 */
function loadFrame(frame: Float64Array, hann: Float64Array, x: Float32Array, start: number, pair?: Float32Array): void {
  const size = frame.length;
  const lo = Math.min(size, Math.max(0, -start));
  const hi = Math.max(lo, Math.min(size, x.length - start));
  frame.fill(0, 0, lo);
  if (pair) for (let j = lo; j < hi; j++) frame[j] = hann[j] * 0.5 * (x[start + j] + pair[start + j]);
  else for (let j = lo; j < hi; j++) frame[j] = hann[j] * x[start + j];
  frame.fill(0, hi);
}

/** Like `loadFrame` for the mean of any number of channels of any lengths. */
function loadMeanFrame(frame: Float64Array, hann: Float64Array, channels: Channels, start: number): void {
  const size = frame.length;
  frame.fill(0);
  for (const ch of channels) {
    const lo = Math.min(size, Math.max(0, -start));
    const hi = Math.min(size, ch.length - start);
    for (let j = lo; j < hi; j++) frame[j] += ch[start + j];
  }
  const scale = 1 / channels.length;
  for (let j = 0; j < size; j++) frame[j] *= hann[j] * scale;
}

/**
 * Welch-style long-term average spectrum: Hann windows of `fftSize` samples every
 * `hopSize` samples, power spectra averaged over the whole file. The file is treated as
 * surrounded by silence, so the first and last samples count as much as all others.
 */
export function longTermSpectrum(channels: Channels, sampleRate: number, opts: SpectrumOptions = {}): LongTermSpectrum {
  assertSampleRate(sampleRate);
  const size = opts.fftSize ?? 4096;
  if (!isPowerOfTwo(size) || size < 4) throw new RangeError(`fftSize must be a power of two >= 4, got ${size}`);
  const hop = opts.hopSize ?? size >> 2;
  if (!Number.isInteger(hop) || hop < 1 || hop > size) throw new RangeError(`hopSize must be in 1..fftSize, got ${hop}`);
  const mono = (opts.channelMode ?? 'mono') === 'mono';
  const half = size >> 1;
  const power = new Float64Array(half + 1);
  const result: LongTermSpectrum = { sampleRate, fftSize: size, hopSize: hop, binHz: sampleRate / size, frames: 0, power };
  const n = maxLength(channels);
  if (n === 0) return result;

  const hann = hannWindow(size);
  // prefix[j] = sum of hann[i]^2 for i < j: the weight of a partly filled frame.
  const prefix = new Float64Array(size + 1);
  for (let j = 0; j < size; j++) prefix[j + 1] = prefix[j] + hann[j] * hann[j];

  const fft = new RealFft(size);
  const frame = new Float64Array(size);
  const re = new Float64Array(half + 1);
  const im = new Float64Array(half + 1);
  const stereoPair = channels.length === 2 && channels[0].length === channels[1].length;
  let weight = 0;

  const accumulate = (): void => {
    fft.forward(frame, re, im);
    for (let k = 0; k <= half; k++) power[k] += re[k] * re[k] + im[k] * im[k];
  };

  for (let start = hop - size; start < n; start += hop) {
    const lo = Math.max(0, start);
    const hi = Math.min(n, start + size);
    weight += prefix[hi - start] - prefix[lo - start];
    result.frames++;
    if (!mono) {
      for (const ch of channels) {
        loadFrame(frame, hann, ch, start);
        accumulate();
      }
    } else {
      if (channels.length === 1) loadFrame(frame, hann, channels[0], start);
      else if (stereoPair) loadFrame(frame, hann, channels[0], start, channels[1]);
      else loadMeanFrame(frame, hann, channels, start);
      accumulate();
    }
  }

  // One-sided spectrum: every bin except DC and Nyquist also carries its mirror image.
  const norm = 1 / (size * weight * (mono ? 1 : channels.length));
  for (let k = 0; k <= half; k++) power[k] *= k === 0 || k === half ? norm : 2 * norm;
  return result;
}

/**
 * Energy-weighted mean frequency of a power spectrum in Hz, optionally restricted to
 * [minHz, maxHz]. Returns 0 when there is no energy (silence).
 */
export function centroidOfSpectrum(
  spectrum: Pick<LongTermSpectrum, 'power' | 'binHz'>,
  minHz = 0,
  maxHz = Infinity,
): number {
  let weighted = 0;
  let total = 0;
  for (let k = 0; k < spectrum.power.length; k++) {
    const hz = k * spectrum.binHz;
    if (hz < minHz || hz > maxHz) continue;
    weighted += hz * spectrum.power[k];
    total += spectrum.power[k];
  }
  return total > SILENCE_POWER ? weighted / total : 0;
}

/**
 * Spectral centroid in Hz: the energy-weighted centre of the long-term average
 * spectrum (see `longTermSpectrum`). Returns 0 for silence or an empty signal.
 */
export function spectralCentroid(
  channels: Channels,
  sampleRate: number,
  opts: SpectrumOptions & { minHz?: number; maxHz?: number } = {},
): number {
  return centroidOfSpectrum(longTermSpectrum(channels, sampleRate, opts), opts.minHz, opts.maxHz);
}

// ---------------------------------------------------------------------------
// measureAudio
// ---------------------------------------------------------------------------

export interface MeasureOptions {
  /** Where the last key / pedal / pad note is released, seconds. Enables `tailSec`. */
  musicEndSec?: number;
  /** Frames below this RMS count as silent. Default -50 dBFS. */
  silenceThresholdDb?: number;
  /** The tail ends where the frame RMS stays below this. Default -60 dBFS. */
  tailThresholdDb?: number;
  /** Frame length for the silence ratio and the tail. Default 50 ms. */
  frameMs?: number;
  /** Settings of the long-term spectrum behind `spectralCentroidHz` (default: 4096 window, mono sum). */
  spectrum?: SpectrumOptions;
}

/**
 * All standard numbers for one piece of rendered audio (a mix or a stem).
 * See AudioMetrics for the meaning of the fields. Never throws on empty or short audio:
 * an empty or all-zero signal measures as silence (peak and RMS -Infinity, crest 0,
 * silenceRatio 1, centroid 0, tail 0). A NaN sample turns peak, RMS and crest into NaN.
 */
export function measureAudio(channels: Channels, sampleRate: number, opts: MeasureOptions = {}): AudioMetrics {
  assertSampleRate(sampleRate);
  const silenceThresholdDb = opts.silenceThresholdDb ?? DEFAULT_SILENCE_THRESHOLD_DB;
  const tailThresholdDb = opts.tailThresholdDb ?? DEFAULT_TAIL_THRESHOLD_DB;
  const frameMs = opts.frameMs ?? DEFAULT_FRAME_MS;
  const n = maxLength(channels);
  const total = n * channels.length;

  let peak = 0;
  let clipped = 0;
  let sum = 0;
  let sumSquares = 0;
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i++) {
      const v = ch[i];
      const a = Math.abs(v);
      if (a > peak) peak = a;
      if (a >= CLIP_LEVEL) clipped++;
      sum += v;
      sumSquares += v * v;
    }
  }
  // A NaN sample must not hide behind a normal looking peak.
  if (Number.isNaN(sumSquares)) peak = NaN;

  const peakLevelDb = toDb(peak);
  const rmsLevelDb = total > 0 ? powerToDb(sumSquares / total) : -Infinity;
  const musicEnd = opts.musicEndSec;

  return {
    sampleRate,
    durationSec: n / sampleRate,
    peakDb: peakLevelDb,
    clippedSamples: clipped,
    rmsDb: rmsLevelDb,
    crestDb: peak === 0 ? 0 : peakLevelDb - rmsLevelDb,
    dcOffset: total > 0 ? sum / total : 0,
    silenceRatio: silenceRatio(channels, sampleRate, silenceThresholdDb, frameMs),
    silenceThresholdDb,
    spectralCentroidHz: spectralCentroid(channels, sampleRate, opts.spectrum),
    tailSec:
      musicEnd === undefined || Number.isNaN(musicEnd)
        ? null
        : tailSecAfter(channels, sampleRate, musicEnd, tailThresholdDb, frameMs),
    tailThresholdDb,
  };
}

// ---------------------------------------------------------------------------
// RT60 (Schroeder backward integration)
// ---------------------------------------------------------------------------

export interface DecayOptions {
  /** Upper end of the line fit on the decay curve in dB. Default -5. */
  fromDb?: number;
  /** Lower end of the line fit in dB. Default -35 (a "T30" fit). */
  toDb?: number;
  /** Subtract a stationary noise floor when one is found behind the decay. Default true. */
  subtractNoise?: boolean;
  /**
   * Measure only this frequency band [low Hz, high Hz] instead of the whole spectrum
   * (24 dB / octave Butterworth edges; 0 or a value at / above Nyquist leaves that side open).
   * A reverb with damping decays faster at high frequencies, so the broadband figure
   * is shorter than the mid-band one.
   */
  bandHz?: readonly [number, number];
}

export interface DecayAnalysis {
  /** Time for 60 dB of decay, extrapolated from the fitted slope, seconds. 0 = no decay could be measured. */
  rt60Sec: number;
  /** dB range of the decay curve the line was fitted to. `fitToDb` is raised when the response does not reach `toDb`. */
  fitFromDb: number;
  fitToDb: number;
  /** Correlation coefficient of the fit (-1 = the decay curve is a perfectly straight line). */
  correlation: number;
  /** Start of the response (the pre-delay), seconds. */
  onsetSec: number;
  /** Where the backward integration starts: the decay meets the noise floor, or the file ends. Seconds. */
  truncationSec: number;
  /** Level of the decay curve at the truncation point, dB relative to its start. */
  floorDb: number;
  /** True when a stationary noise floor was found and its power was subtracted. */
  noiseSubtracted: boolean;
}

/** dB above the floor where the late-decay fit stops, and dB of decay skipped before the floor is measured. */
const DECAY_FLOOR_MARGIN_DB = 7.5;
/** dB range of the late-decay fit that locates the truncation point. */
const DECAY_LATE_RANGE_DB = 20;
/** The line fit stays this many dB above the level of the truncation point. */
const DECAY_FIT_HEADROOM_DB = 5;
/** Smallest dB range a line is fitted to. */
const DECAY_MIN_FIT_RANGE_DB = 10;
/** Start of the response: first sample within this many dB of the largest one (ISO 3382-1). */
const DECAY_ONSET_DB = -20;
/** The end of the response counts as a noise floor when its slope is less than this share of the decay slope. */
const DECAY_FLAT_SLOPE_RATIO = 0.5;
/**
 * Search for a noise floor in front of a fade-out: a stretch is "level" when the slope of
 * its level stays below this share of the decay rate ...
 */
const DECAY_LEVEL_SLOPE_RATIO = 0.25;
/** ... measured by a line through at least this many short parts ... */
const DECAY_LEVEL_PARTS = 6;
/** ... and when it lies at least this many dB below the loudest part of the response. */
const DECAY_LEVEL_MIN_DROP_DB = 10;
/** What follows a level stretch is a fade-out when the response ends at least this many dB below it. */
const DECAY_FADE_DROP_DB = 6;

/** Q of the two 12 dB / octave sections that make a 4th-order Butterworth filter. */
const BUTTERWORTH4_Q: readonly number[] = [0.5411961001461969, 1.3065629648763766];

/** One 12 dB / octave low-pass or high-pass section (RBJ cookbook biquad), applied in place. */
function biquadInPlace(x: Float64Array, kind: 'lowpass' | 'highpass', hz: number, q: number, sampleRate: number): void {
  const w0 = (2 * Math.PI * hz) / sampleRate;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  const a0 = 1 + alpha;
  const b0 = (kind === 'lowpass' ? (1 - cos) / 2 : (1 + cos) / 2) / a0;
  const b1 = (kind === 'lowpass' ? 1 - cos : -(1 + cos)) / a0;
  const a1 = (-2 * cos) / a0;
  const a2 = (1 - alpha) / a0;
  let z1 = 0;
  let z2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = x[i];
    const y = b0 * v + z1;
    z1 = b1 * v - a1 * y + z2;
    z2 = b0 * v - a2 * y;
    x[i] = y;
  }
}

/** Copy of `x` limited to [lowHz, highHz] with 24 dB / octave Butterworth edges. */
function bandLimited(x: Float32Array, lowHz: number, highHz: number, sampleRate: number): Float64Array {
  const out = Float64Array.from(x);
  const nyquist = sampleRate / 2;
  if (lowHz > 0 && lowHz < 0.98 * nyquist) {
    for (const q of BUTTERWORTH4_Q) biquadInPlace(out, 'highpass', lowHz, q, sampleRate);
  }
  if (highHz > 0 && highHz < 0.98 * nyquist) {
    for (const q of BUTTERWORTH4_Q) biquadInPlace(out, 'lowpass', highHz, q, sampleRate);
  }
  return out;
}

/** Least-squares line through (t[i], y[i]); null when it is not defined. */
function fitLine(t: ArrayLike<number>, y: ArrayLike<number>, count: number): { slope: number; intercept: number } | null {
  if (count < 2) return null;
  let st = 0;
  let sy = 0;
  for (let i = 0; i < count; i++) {
    st += t[i];
    sy += y[i];
  }
  const mt = st / count;
  const my = sy / count;
  let stt = 0;
  let sty = 0;
  for (let i = 0; i < count; i++) {
    stt += (t[i] - mt) * (t[i] - mt);
    sty += (t[i] - mt) * (y[i] - my);
  }
  if (!(stt > 0)) return null;
  const slope = sty / stt;
  return { slope, intercept: my - slope * mt };
}

/**
 * Decay analysis of an impulse response (or of any isolated decay).
 *
 * Method: energy per sample summed over the channels, Schroeder backward integration,
 * least-squares line through the decay curve between `fromDb` and `toDb`, slope
 * extrapolated to 60 dB.
 *
 * - Pre-delay: the response starts at the first sample within 20 dB of the largest
 *   one; everything before it is ignored.
 * - Noise floor / short file (after Lundeby et al. 1995): the level behind the decay is
 *   estimated from the end of the response, the integration starts where the late decay
 *   meets that level, and the energy of the decay beyond that point is added back from
 *   the fitted late slope. If the end of the response is flat (a stationary noise floor),
 *   its power is also subtracted before integrating.
 * - A fade-out behind a noise floor (the end of a recording) is left out, provided the
 *   floor is visible for roughly 0.1 * RT60^(2/3) seconds or more. A shorter floor in front
 *   of a fade can lengthen the result by up to about 10 %.
 * - A fade or cut inside the decay itself is part of the response and is measured as such.
 * - When the response does not reach `toDb` with 5 dB to spare, the fit range is shortened
 *   (see `fitToDb`); below 10 dB of usable range the result is 0.
 *
 * Accuracy on synthetic decays (tests/analysis/rt60.test.ts): within 0.5 % for clean broadband
 * decays of 1 .. 6 s, within 2 % with a noise floor 30 .. 60 dB below the start. Narrow bands
 * scatter more by nature: the standard deviation is about 55 % / sqrt(bandwidth Hz * RT60 s).
 */
export function analyzeDecay(ir: Float32Array | Channels, sampleRate: number, opts: DecayOptions = {}): DecayAnalysis {
  assertSampleRate(sampleRate);
  const fromDb = opts.fromDb ?? -5;
  const toDb = opts.toDb ?? -35;
  if (!(fromDb <= 0 && toDb < fromDb)) throw new RangeError(`need toDb < fromDb <= 0, got ${fromDb} / ${toDb}`);
  const allowSubtract = opts.subtractNoise ?? true;
  const band = opts.bandHz;
  if (band && !(band[0] >= 0 && band[1] > band[0])) {
    throw new RangeError(`bandHz needs 0 <= low < high, got ${band[0]} / ${band[1]}`);
  }
  const input: Channels = ArrayBuffer.isView(ir) ? [ir] : ir;
  const channels: readonly (Float32Array | Float64Array)[] = band
    ? input.map((ch) => bandLimited(ch, band[0], band[1], sampleRate))
    : input;
  const none: DecayAnalysis = {
    rt60Sec: 0,
    fitFromDb: fromDb,
    fitToDb: toDb,
    correlation: 0,
    onsetSec: 0,
    truncationSec: 0,
    floorDb: 0,
    noiseSubtracted: false,
  };

  const n = maxLength(input);
  if (n < 16) return none;
  const energy = new Float64Array(n);
  for (const ch of channels) for (let i = 0; i < ch.length; i++) energy[i] += ch[i] * ch[i];
  let peak = 0;
  let sane = true;
  for (let i = 0; i < n; i++) {
    if (energy[i] > peak) peak = energy[i];
    else if (!(energy[i] >= 0)) sane = false;
  }
  if (!sane || !(peak > 0) || !Number.isFinite(peak)) return none;

  // Trailing digital silence is not part of the response.
  let end = n;
  while (end > 0 && !(energy[end - 1] > peak * SILENCE_POWER)) end--;
  let onset = 0;
  const onsetLevel = peak * 10 ** (DECAY_ONSET_DB / 10);
  while (onset < end && energy[onset] < onsetLevel) onset++;
  const span = end - onset;
  if (span < 16) return none;
  none.onsetSec = onset / sampleRate;

  // tailSum[i] = energy from sample onset + i to the end of the response (the plain decay curve).
  const tailSum = new Float64Array(span + 1);
  for (let i = span - 1; i >= 0; i--) tailSum[i] = tailSum[i + 1] + energy[onset + i];
  const total = tailSum[0];
  const meanPower = (a: number, b: number): number => (tailSum[a] - tailSum[b]) / (b - a);
  /** First index whose plain decay curve is at or below `level` (the curve never rises). */
  const firstAtOrBelow = (level: number): number => {
    let lo = 0;
    let hi = span;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tailSum[mid] <= level) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  };

  // Rough decay rate from the plain curve; it only sets the smoothing of the envelope.
  let roughDbPerSec = 0;
  for (let top = 5; top <= 35 && roughDbPerSec === 0; top += 10) {
    const a = firstAtOrBelow(total * 10 ** (-top / 10));
    const b = firstAtOrBelow(total * 10 ** (-(top + 10) / 10));
    if (b - a >= 8 && b < span) roughDbPerSec = (10 * sampleRate) / (b - a);
  }
  if (roughDbPerSec === 0) return none;

  // Envelope: mean power in blocks, about 6 blocks per 10 dB of decay (1 .. 100 ms).
  const blockLen = Math.round(
    Math.min(0.1 * sampleRate, Math.max(8, 0.001 * sampleRate, ((10 / roughDbPerSec) * sampleRate) / 6)),
  );
  const blocks = Math.floor(span / blockLen);
  if (blocks < 6) return none;
  const blockSec = blockLen / sampleRate;
  const env = new Float64Array(blocks);
  let peakBlock = 0;
  for (let b = 0; b < blocks; b++) {
    env[b] = meanPower(b * blockLen, (b + 1) * blockLen);
    if (env[b] > env[peakBlock]) peakBlock = b;
  }

  /**
   * The last stretch of the response where the level stays put: a stationary noise floor.
   * Returns its sample range (relative to the onset) or null. `to` is the end of the response
   * unless a fade-out follows the stretch (the end of a recording): then it is the end of
   * the stretch, so that the faded part is not taken for the floor level.
   */
  const findLevelStretch = (): { from: number; to: number } | null => {
    const maxSlope = DECAY_LEVEL_SLOPE_RATIO * roughDbPerSec; // dB per second
    // Shortest window in which that slope can be told from noise: the slope of the level of
    // M white-noise samples over T seconds scatters by about 21 / (sqrt(M) T) dB/s; ask for a quarter of maxSlope.
    const windowSec = (85 / (maxSlope * Math.sqrt(sampleRate))) ** (2 / 3);
    const part = Math.max(8, Math.round((windowSec * sampleRate) / DECAY_LEVEL_PARTS));
    const count = Math.floor(span / part);
    if (count < 3 * DECAY_LEVEL_PARTS) return null;
    const partSec = part / sampleRate;
    const level = new Float64Array(count);
    for (let b = 0; b < count; b++) {
      const mean = meanPower(b * part, (b + 1) * part);
      level[b] = mean > 0 ? 10 * Math.log10(mean) : -Infinity;
    }
    // How much the level really scatters from part to part (band-limited or tonal responses
    // scatter far more than white noise): median of the second differences, which ignore a trend.
    const bends: number[] = [];
    for (let b = 1; b + 1 < count; b++) {
      const bend = level[b + 1] - 2 * level[b] + level[b - 1];
      if (Number.isFinite(bend)) bends.push(Math.abs(bend));
    }
    if (bends.length < 8) return null;
    bends.sort((a, b) => a - b);
    const scatter = (1.4826 * bends[bends.length >> 1]) / Math.sqrt(6);
    // Window (in parts) whose slope scatters by no more than a quarter of maxSlope.
    const need = 12 * ((4 * scatter) / (maxSlope * partSec)) ** 2;
    let width = DECAY_LEVEL_PARTS;
    while (width * (width * width - 1) < need && 3 * width <= count) width++;
    if (3 * width > count) return null;

    const ceiling = 10 * Math.log10(env[peakBlock]) - DECAY_LEVEL_MIN_DROP_DB;
    let sumTT = 0;
    for (let i = 0; i < width; i++) sumTT += ((i - (width - 1) / 2) * partSec) ** 2;
    const isLevel = (first: number): boolean => {
      let sumTY = 0;
      let mean = 0;
      for (let i = 0; i < width; i++) {
        const y = level[first + i];
        if (!(y > -Infinity)) return false;
        sumTY += (i - (width - 1) / 2) * partSec * y;
        mean += y / width;
      }
      return mean <= ceiling && Math.abs(sumTY / sumTT) <= maxSlope;
    };
    let last = count - width;
    while (last >= 0 && !isLevel(last)) last--;
    if (last < 0) return null;
    let first = last;
    while (first > 0 && isLevel(first - 1)) first--;
    const stop = last + width;
    let plateau = 0;
    for (let b = first; b < stop; b++) plateau += level[b] / (stop - first);
    // Behind a floor the level can only fall (a fade-out). Anything louder: not a floor.
    const slack = Math.max(2, 3 * scatter);
    for (let b = stop; b < count; b++) if (level[b] > plateau + slack) return null;
    const fadeOut = stop < count && level[count - 1] <= plateau - Math.max(DECAY_FADE_DROP_DB, 2 * slack);
    return { from: first * part, to: fadeOut ? stop * part : span };
  };

  const stretch = findLevelStretch();
  const limit = stretch ? stretch.to : span;
  const usedBlocks = Math.min(blocks, Math.floor(limit / blockLen));

  /** Line through the late decay (in dB over seconds from the onset), above the floor `floor`. */
  const fitLateDecay = (floor: number, subtract: number): { slope: number; intercept: number } | null => {
    const lo = floor * 10 ** (DECAY_FLOOR_MARGIN_DB / 10);
    const hi = floor * 10 ** ((DECAY_FLOOR_MARGIN_DB + DECAY_LATE_RANGE_DB) / 10);
    let b0 = peakBlock;
    while (b0 < usedBlocks && env[b0] > hi) b0++;
    let b1 = b0;
    while (b1 < usedBlocks && env[b1] >= lo) b1++;
    if (b1 - b0 < 3) {
      b0 = peakBlock;
      b1 = peakBlock;
      while (b1 < usedBlocks && env[b1] >= lo) b1++;
    }
    const count = b1 - b0;
    if (count < 3) return null;
    const t = new Float64Array(count);
    const y = new Float64Array(count);
    for (let i = 0; i < count; i++) {
      t[i] = (b0 + i + 0.5) * blockSec;
      y[i] = 10 * Math.log10(env[b0 + i] - subtract);
    }
    const line = fitLine(t, y, count);
    return line && line.slope < 0 ? line : null;
  };

  /** True when the level between `from` and the end of the response hardly falls compared to `decaySlope`. */
  const isFlat = (from: number, decaySlope: number): boolean => {
    const parts = Math.min(16, Math.floor((limit - from) / 64));
    if (parts < 4) return false;
    const len = Math.floor((limit - from) / parts);
    const t = new Float64Array(parts);
    const y = new Float64Array(parts);
    for (let p = 0; p < parts; p++) {
      const mean = meanPower(from + p * len, from + (p + 1) * len);
      if (!(mean > 0)) return false;
      t[p] = ((p + 0.5) * len) / sampleRate;
      y[p] = 10 * Math.log10(mean);
    }
    const line = fitLine(t, y, parts);
    return line !== null && line.slope > DECAY_FLAT_SLOPE_RATIO * decaySlope;
  };

  // Iterate: floor level -> late slope -> crossing point -> floor level measured behind the crossing.
  // The floor is measured over the last 10 % of the response at least (over a shorter level stretch as it is).
  const floorLimit = Math.max(stretch ? stretch.from : 0, Math.floor(limit * 0.9));
  let floorFrom = floorLimit;
  let floor = meanPower(floorFrom, limit);
  let subtract = 0;
  let cross = limit;
  let slope = 0;
  for (let iteration = 0; iteration < 8; iteration++) {
    if (!(floor > 0)) return none;
    const line = fitLateDecay(floor, subtract);
    if (!line) return none;
    slope = line.slope;
    const crossSec = (10 * Math.log10(floor) - line.intercept) / slope;
    const nextCross = Math.min(limit, Math.max(blockLen, Math.round(crossSec * sampleRate)));
    const behind = Math.round((crossSec + DECAY_FLOOR_MARGIN_DB / -slope) * sampleRate);
    const nextFrom = Math.min(floorLimit, Math.max(0, behind));
    const nextFloor = meanPower(nextFrom, limit);
    const nextSubtract = allowSubtract && isFlat(nextFrom, slope) ? nextFloor : 0;
    const settled =
      Math.abs(nextCross - cross) <= blockLen / 8 &&
      Math.abs(nextFrom - floorFrom) <= blockLen / 8 &&
      (nextSubtract > 0) === (subtract > 0);
    cross = nextCross;
    floorFrom = nextFrom;
    floor = nextFloor;
    subtract = nextSubtract;
    if (settled) break;
  }
  if (!(floor > 0) || !(slope < 0)) return none;

  // Decay curve from the truncation point backwards, plus the decay that lies beyond it.
  const perSample = (-slope * Math.LN10) / 10 / sampleRate;
  const beyond = floor / -Math.expm1(-perSample);
  const curve = (i: number): number => tailSum[i] - tailSum[cross] - subtract * (cross - i) + beyond;
  const reference = curve(0);
  if (!(reference > 0)) return none;
  const floorDb = 10 * Math.log10(beyond / reference);
  const fitToDb = Math.max(toDb, floorDb + DECAY_FIT_HEADROOM_DB);
  const partial: DecayAnalysis = {
    ...none,
    fitToDb,
    truncationSec: (onset + cross) / sampleRate,
    floorDb,
    noiseSubtracted: subtract > 0,
  };
  if (fromDb - fitToDb < DECAY_MIN_FIT_RANGE_DB) return partial;

  const upper = reference * 10 ** (fromDb / 10);
  const lower = reference * 10 ** (fitToDb / 10);
  let first = 0;
  while (first < cross && curve(first) > upper) first++;
  let count = 0;
  let st = 0;
  let sy = 0;
  let stt = 0;
  let sty = 0;
  let syy = 0;
  for (let i = first; i < cross; i++) {
    const v = curve(i);
    if (!(v >= lower)) break;
    const t = (i - first) / sampleRate;
    const y = 10 * Math.log10(v / reference);
    count++;
    st += t;
    sy += y;
    stt += t * t;
    sty += t * y;
    syy += y * y;
  }
  if (count < 8) return partial;
  const varT = count * stt - st * st;
  const varY = count * syy - sy * sy;
  const cov = count * sty - st * sy;
  if (!(varT > 0) || !(cov < 0)) return partial;
  return {
    ...partial,
    rt60Sec: (-60 * varT) / cov,
    correlation: varY > 0 ? cov / Math.sqrt(varT * varY) : 0,
  };
}

/**
 * RT60 in seconds of an impulse response (one channel or several): Schroeder backward
 * integration, line fit between -5 and -35 dB of the decay curve, extrapolated to 60 dB.
 * Returns 0 when no decay can be measured (silence, too short, less than about 20 dB of
 * decay above the noise floor). See `analyzeDecay` for the details and the diagnostics.
 */
export function measureRt60(ir: Float32Array | Channels, sampleRate: number, opts: DecayOptions = {}): number {
  return analyzeDecay(ir, sampleRate, opts).rt60Sec;
}

// ---------------------------------------------------------------------------
// Pitch deviation of a near-sinusoidal tone (tape wobble check)
// ---------------------------------------------------------------------------

export interface PitchDeviationOptions {
  /**
   * Half-width in Hz of the band around `nominalHz` that is analysed (deviation and
   * wobble rate both have to fit inside). Default: max(15, 4 % of nominalHz).
   */
  bandwidthHz?: number;
  /** Parts of the signal more than this many dB below the loudest part are ignored. Default 30. */
  gateDb?: number;
}

export interface PitchDeviation {
  /** Largest |deviation| from `nominalHz`, cents. */
  maxCents: number;
  /** RMS deviation from `nominalHz`, cents. */
  rmsCents: number;
  /** Rate of the strongest periodic pitch movement in Hz, null when there is none. */
  lfoHz: number | null;
  /** Peak depth in cents of that movement (0 when `lfoHz` is null). */
  lfoCents: number;
  /** Mean deviation from `nominalHz` in cents (a constant detune). */
  meanCents: number;
  /** Seconds of signal the numbers are based on. 0 means: no tone found, nothing was measured. */
  analyzedSec: number;
  /** Peak level of the tone inside the analysis band, dBFS (-Infinity when nothing was measured). */
  toneDb: number;
}

/** Stop-band attenuation of the demodulation filter in dB. */
const PITCH_FILTER_ATTENUATION_DB = 80;
/** A wobble component must reach this depth (cents, peak) to be reported as an LFO. */
const PITCH_LFO_MIN_CENTS = 0.02;
/** ... and its power must exceed the median of the modulation spectrum by this factor. */
const PITCH_LFO_MIN_PROMINENCE = 20;
/** The tone must not be more than this many dB below the level of the whole signal. */
const PITCH_MIN_TONE_REL_DB = -40;

/** Modified Bessel function of the first kind, order 0 (power series). */
function besselI0(x: number): number {
  const q = (x * x) / 4;
  let term = 1;
  let sum = 1;
  for (let k = 1; k < 200; k++) {
    term *= q / (k * k);
    sum += term;
    if (term < sum * 1e-17) break;
  }
  return sum;
}

/**
 * Kaiser-windowed sinc low-pass with unity DC gain and an odd number of taps.
 * `cutoff` and `transition` are in cycles per sample.
 */
function kaiserLowpass(cutoff: number, transition: number, attenuationDb: number): Float64Array {
  const beta = 0.1102 * (attenuationDb - 8.7);
  let taps = Math.ceil((attenuationDb - 7.95) / (2.285 * 2 * Math.PI * transition)) + 1;
  if (taps % 2 === 0) taps++;
  taps = Math.max(3, taps);
  const mid = (taps - 1) / 2;
  const h = new Float64Array(taps);
  const i0Beta = besselI0(beta);
  let sum = 0;
  for (let j = 0; j < taps; j++) {
    const t = j - mid;
    const r = t / mid;
    const win = besselI0(beta * Math.sqrt(Math.max(0, 1 - r * r))) / i0Beta;
    const sinc = t === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * t) / (Math.PI * t);
    h[j] = sinc * win;
    sum += h[j];
  }
  for (let j = 0; j < taps; j++) h[j] /= sum;
  return h;
}

/**
 * Pitch deviation of a near-sinusoidal tone from `nominalHz`, in cents, for checking tape wobble.
 *
 * Method: the signal is shifted down by `nominalHz` (complex demodulation), low-passed to a
 * narrow band around the tone (80 dB stop band, which removes harmonics, DC and other tones)
 * and decimated. The phase advance between two successive output points is the mean frequency
 * offset over that interval, so a constant detune and slow wobble are read without bias.
 * `lfoHz` is the strongest peak in the spectrum of that pitch track; it is accurate when the
 * analysed stretch holds at least two cycles of the movement (0.5 Hz needs 4 s or more).
 *
 * Not analysed: the first and the last 1.7 / bandwidth seconds of the signal (half the filter
 * length, about 50 ms at 880 Hz and 110 ms at 110 Hz with the default band) and parts more than
 * `gateDb` below the loudest part. When the tone is absent or the signal is too short, all
 * numbers are 0, `lfoHz` is null and `analyzedSec` is 0: check `analyzedSec` before trusting
 * a small deviation. The input has to be a steady tone: noise alone gives large, meaningless numbers.
 *
 * Accuracy on synthetic tones (tests/analysis/pitch.test.ts): +-10 cents at 0.5 Hz reads
 * 10.00 cents / 0.500 Hz, +-1.2 cents at 6.1 Hz reads 1.199 cents / 6.10 Hz, a steady sine
 * (110 Hz and up) reads below 0.01 cents.
 */
export function measurePitchDeviationCents(
  signal: Float32Array,
  sampleRate: number,
  nominalHz: number,
  opts: PitchDeviationOptions = {},
): PitchDeviation {
  assertSampleRate(sampleRate);
  const none: PitchDeviation = {
    maxCents: 0,
    rmsCents: 0,
    lfoHz: null,
    lfoCents: 0,
    meanCents: 0,
    analyzedSec: 0,
    toneDb: -Infinity,
  };
  const n = signal.length;
  if (!(Number.isFinite(nominalHz) && nominalHz > 0 && nominalHz < 0.45 * sampleRate) || n < 16) return none;

  // Band: pass nominal +- pass, reject beyond nominal +- stop (stop stays below nominal: DC and octave are out).
  const requested = opts.bandwidthHz ?? Math.max(15, 0.04 * nominalHz);
  if (!(requested > 0)) throw new RangeError(`bandwidthHz must be positive, got ${requested}`);
  const pass = Math.min(requested, 0.4 * nominalHz);
  const stop = Math.min(2.5 * pass, 0.8 * nominalHz);
  const h = kaiserLowpass((pass + stop) / 2 / sampleRate, (stop - pass) / sampleRate, PITCH_FILTER_ATTENUATION_DB);
  const taps = h.length;
  if (n < taps + 2) return none;
  const mid = (taps - 1) / 2;
  const hop = Math.max(1, Math.floor(sampleRate / (4 * stop)));
  const w0 = (2 * Math.PI * nominalHz) / sampleRate;

  // Filter shifted to the tone: g[j] = h[j] * exp(-i w0 (j - mid)).
  const gr = new Float64Array(taps);
  const gi = new Float64Array(taps);
  for (let j = 0; j < taps; j++) {
    gr[j] = h[j] * Math.cos(w0 * (j - mid));
    gi[j] = -h[j] * Math.sin(w0 * (j - mid));
  }

  // Demodulated, band-limited tone at every `hop` samples (only where the filter fits completely).
  const points = Math.floor((n - taps) / hop) + 1;
  const yr = new Float64Array(points);
  const yi = new Float64Array(points);
  const amp = new Float64Array(points);
  let ampMax = 0;
  for (let m = 0; m < points; m++) {
    const base = m * hop;
    let ar = 0;
    let ai = 0;
    for (let j = 0; j < taps; j++) {
      const v = signal[base + j];
      ar += gr[j] * v;
      ai += gi[j] * v;
    }
    const centre = w0 * (base + mid);
    const c = Math.cos(centre);
    const s = Math.sin(centre);
    yr[m] = ar * c + ai * s;
    yi[m] = ai * c - ar * s;
    amp[m] = 2 * Math.hypot(yr[m], yi[m]);
    if (amp[m] > ampMax) ampMax = amp[m];
  }

  // Is there a tone at all? Compare with the level of the whole signal.
  let sumSquares = 0;
  for (let i = 0; i < n; i++) sumSquares += signal[i] * signal[i];
  const overall = Math.sqrt((2 * sumSquares) / n); // amplitude of a sine with the same RMS
  if (!(ampMax > 0) || !Number.isFinite(ampMax) || ampMax < overall * fromDb(PITCH_MIN_TONE_REL_DB)) return none;

  // Mean frequency offset of every interval between two valid points, in cents.
  const gate = ampMax * fromDb(-Math.abs(opts.gateDb ?? 30));
  const intervals = points - 1;
  const cents = new Float64Array(intervals);
  const valid = new Uint8Array(intervals);
  const hzPerRadian = sampleRate / (2 * Math.PI * hop);
  let used = 0;
  let sum = 0;
  let sumSq = 0;
  let maxAbs = 0;
  for (let m = 0; m < intervals; m++) {
    if (amp[m] < gate || amp[m + 1] < gate) continue;
    const dPhase = Math.atan2(yi[m + 1] * yr[m] - yr[m + 1] * yi[m], yr[m + 1] * yr[m] + yi[m + 1] * yi[m]);
    const ratio = 1 + (dPhase * hzPerRadian) / nominalHz;
    if (!(ratio > 0)) continue;
    const c = 1200 * Math.log2(ratio);
    cents[m] = c;
    valid[m] = 1;
    used++;
    sum += c;
    sumSq += c * c;
    if (Math.abs(c) > maxAbs) maxAbs = Math.abs(c);
  }
  if (used === 0) return none;

  const lfo = strongestModulation(cents, valid, sampleRate / hop, pass);
  return {
    maxCents: maxAbs,
    rmsCents: Math.sqrt(sumSq / used),
    lfoHz: lfo ? lfo.hz : null,
    lfoCents: lfo ? lfo.cents : 0,
    meanCents: sum / used,
    analyzedSec: (used * hop) / sampleRate,
    toneDb: toDb(ampMax),
  };
}

/**
 * Strongest periodic component of a pitch track (cents, sampled at `rate` Hz), looked for
 * between one cycle per track length and `maxHz`, on the longest gap-free stretch of the track.
 */
function strongestModulation(
  cents: Float64Array,
  valid: Uint8Array,
  rate: number,
  maxHz: number,
): { hz: number; cents: number } | null {
  let bestStart = 0;
  let bestLen = 0;
  for (let i = 0; i < valid.length; ) {
    if (!valid[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j < valid.length && valid[j]) j++;
    if (j - i > bestLen) {
      bestLen = j - i;
      bestStart = i;
    }
    i = j;
  }
  if (bestLen < 16) return null;
  bestLen = Math.min(bestLen, 1 << 17);

  // Hann-windowed, mean-free, zero-padded spectrum of the track.
  const hann = hannWindow(bestLen);
  let wSum = 0;
  let wMean = 0;
  for (let i = 0; i < bestLen; i++) {
    wSum += hann[i];
    wMean += hann[i] * cents[bestStart + i];
  }
  wMean /= wSum;
  const size = nextPowerOfTwo(8 * bestLen);
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  for (let i = 0; i < bestLen; i++) re[i] = hann[i] * (cents[bestStart + i] - wMean);
  fftInPlace(re, im);

  const binHz = rate / size;
  const kMin = Math.max(1, Math.ceil(rate / bestLen / binHz));
  const kMax = Math.min(size / 2 - 1, Math.floor(Math.min(maxHz, 0.4 * rate) / binHz));
  if (kMax <= kMin) return null;
  const powerAt = (k: number): number => re[k] * re[k] + im[k] * im[k];
  let best = -1;
  let bestPower = 0;
  const powers = new Float64Array(kMax - kMin + 1);
  for (let k = kMin; k <= kMax; k++) {
    const p = powerAt(k);
    powers[k - kMin] = p;
    if (p > bestPower && p >= powerAt(k - 1) && p >= powerAt(k + 1)) {
      bestPower = p;
      best = k;
    }
  }
  if (best < 0) return null;
  const depth = (2 * Math.sqrt(bestPower)) / wSum;
  powers.sort();
  const median = powers[powers.length >> 1];
  if (depth < PITCH_LFO_MIN_CENTS || bestPower < PITCH_LFO_MIN_PROMINENCE * median) return null;

  // Parabola through the log power of the peak and its neighbours.
  const a = Math.log(powerAt(best - 1));
  const b = Math.log(bestPower);
  const c = Math.log(powerAt(best + 1));
  const curvature = a - 2 * b + c;
  const shift = curvature < 0 && Number.isFinite(curvature) ? (0.5 * (a - c)) / curvature : 0;
  return { hz: (best + Math.max(-0.5, Math.min(0.5, shift))) * binHz, cents: depth };
}

// ---------------------------------------------------------------------------
// Target checks and TUNING.md formatting
// ---------------------------------------------------------------------------

export interface TargetExtras {
  /** Silence ratio of the PIANO stem (measureAudio on the piano stem, default threshold). */
  pianoSilenceRatio?: number;
  /** Measured RT60 of the generated impulse response, seconds. */
  rt60Sec?: number;
  /** The reverbSize the impulse response was generated for, seconds. */
  requestedRt60Sec?: number;
  /**
   * Tail of piano + pad in seconds (`tailSecAfter` on the sum of the two stems). When given it
   * is checked instead of `metrics.tailSec`: in a mix the noise bed outlasts the instruments.
   */
  tailSec?: number;
}

export interface TargetCheck {
  ok: boolean;
  /** One line per violated target, with the measured number. Empty when `ok`. */
  failures: string[];
}

function num(v: number, digits: number): string {
  if (Number.isNaN(v)) return 'NaN';
  if (!Number.isFinite(v)) return v > 0 ? 'inf' : '-inf';
  return v.toFixed(digits);
}

/**
 * Checks measured numbers against AUDIO_TARGETS. `metrics` are the numbers of the MIX.
 * The tail target is about piano + pad: pass their tail as `extra.tailSec` when the mix has
 * a noise bed (otherwise `metrics.tailSec` is checked). A value that is not a finite number
 * always fails. What was not measured (tailSec null, extras left out) is not checked.
 */
export function checkAgainstTargets(metrics: AudioMetrics, extra: TargetExtras = {}): TargetCheck {
  const failures: string[] = [];
  const T = AUDIO_TARGETS;
  const inside = (v: number, range: { min: number; max: number }): boolean => v >= range.min && v <= range.max;

  // "Strictly below" the maximum for the peak.
  if (!(metrics.peakDb >= T.peakDb.min && metrics.peakDb < T.peakDb.max)) {
    failures.push(
      `peak ${num(metrics.peakDb, 2)} dBFS is outside ${T.peakDb.min} <= peak < ${T.peakDb.max} dBFS`,
    );
  }
  if (metrics.clippedSamples !== 0) {
    failures.push(`${metrics.clippedSamples} clipped samples (|x| >= ${CLIP_LEVEL}), must be 0`);
  }
  if (!inside(metrics.rmsDb, T.rmsDb)) {
    failures.push(`RMS ${num(metrics.rmsDb, 2)} dBFS is outside ${T.rmsDb.min} .. ${T.rmsDb.max} dBFS`);
  }
  if (!inside(metrics.spectralCentroidHz, T.centroidHz)) {
    failures.push(
      `spectral centroid ${num(metrics.spectralCentroidHz, 0)} Hz is outside ${T.centroidHz.min} .. ${T.centroidHz.max} Hz`,
    );
  }
  if (!Number.isFinite(metrics.dcOffset)) {
    failures.push(`DC offset ${num(metrics.dcOffset, 6)} is not a finite number`);
  }
  const tailSec = extra.tailSec ?? metrics.tailSec;
  if (tailSec !== null && !inside(tailSec, T.tailSec)) {
    failures.push(
      `tail ${num(tailSec, 2)} s (to ${metrics.tailThresholdDb} dBFS) is outside ${T.tailSec.min} .. ${T.tailSec.max} s`,
    );
  }
  if (extra.pianoSilenceRatio !== undefined && !inside(extra.pianoSilenceRatio, T.pianoSilenceRatio)) {
    failures.push(
      `piano silence ratio ${num(extra.pianoSilenceRatio, 3)} is outside ${T.pianoSilenceRatio.min} .. ${T.pianoSilenceRatio.max}`,
    );
  }
  if (extra.rt60Sec !== undefined) {
    if (!inside(extra.rt60Sec, T.rt60Sec)) {
      failures.push(`RT60 ${num(extra.rt60Sec, 2)} s is outside ${T.rt60Sec.min} .. ${T.rt60Sec.max} s`);
    }
    if (extra.requestedRt60Sec !== undefined) {
      const deviation = Math.abs(extra.rt60Sec - extra.requestedRt60Sec) / extra.requestedRt60Sec;
      if (!(deviation <= T.rt60Tolerance)) {
        failures.push(
          `RT60 ${num(extra.rt60Sec, 2)} s deviates ${num(deviation * 100, 1)} % from the requested ${num(extra.requestedRt60Sec, 2)} s (allowed ${T.rt60Tolerance * 100} %)`,
        );
      }
    }
  }
  return { ok: failures.length === 0, failures };
}

/** Header (two lines) of the metrics table used in TUNING.md. Rows come from `formatMetricsRow`. */
export const METRICS_TABLE_HEADER = [
  `| Take | Length s | Peak dBFS | RMS dBFS | Crest dB | Clipped | DC offset | Silence ratio (< ${DEFAULT_SILENCE_THRESHOLD_DB} dBFS) | Centroid Hz | Tail s (to ${DEFAULT_TAIL_THRESHOLD_DB} dBFS) |`,
  '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
].join('\n');

function formatDc(v: number): string {
  if (!Number.isFinite(v)) return num(v, 0);
  if (v === 0) return '0';
  return Math.abs(v) < 1e-3 ? v.toExponential(1) : v.toFixed(4);
}

/**
 * One markdown table row for METRICS_TABLE_HEADER. A threshold that differs from the
 * default named in the header is written into the cell.
 */
export function formatMetricsRow(label: string, metrics: AudioMetrics): string {
  const silenceNote =
    metrics.silenceThresholdDb === DEFAULT_SILENCE_THRESHOLD_DB ? '' : ` (< ${metrics.silenceThresholdDb} dBFS)`;
  const tailNote = metrics.tailThresholdDb === DEFAULT_TAIL_THRESHOLD_DB ? '' : ` (to ${metrics.tailThresholdDb} dBFS)`;
  const cells = [
    label.replace(/\|/g, '/').replace(/\s+/g, ' ').trim(),
    num(metrics.durationSec, 1),
    num(metrics.peakDb, 2),
    num(metrics.rmsDb, 2),
    num(metrics.crestDb, 2),
    String(metrics.clippedSamples),
    formatDc(metrics.dcOffset),
    num(metrics.silenceRatio, 3) + silenceNote,
    num(metrics.spectralCentroidHz, 0),
    metrics.tailSec === null ? 'n/a' : num(metrics.tailSec, 2) + tailNote,
  ];
  return `| ${cells.join(' | ')} |`;
}
