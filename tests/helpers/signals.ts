/**
 * Synthetic test signals with known properties, for checking the measurement library.
 *
 * Everything is deterministic: the only randomness is the seeded generator below
 * (no Math.random). Nothing here is imported by the app.
 */

export const SR = 48000;

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform in [lo, hi). */
  uniform(lo: number, hi: number): number;
  /** Normal distribution, mean 0, standard deviation 1. */
  gaussian(): number;
}

/** mulberry32 with a Box-Muller transform on top. Same seed, same sequence. */
export function makeRng(seed: number): Rng {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let spare: number | null = null;
  return {
    next,
    uniform: (lo, hi) => lo + (hi - lo) * next(),
    gaussian: () => {
      if (spare !== null) {
        const v = spare;
        spare = null;
        return v;
      }
      const r = Math.sqrt(-2 * Math.log(1 - next()));
      const phi = 2 * Math.PI * next();
      spare = r * Math.sin(phi);
      return r * Math.cos(phi);
    },
  };
}

/** dB to amplitude. */
export function amp(db: number): number {
  return 10 ** (db / 20);
}

/** Number of samples in `seconds`. */
export function frames(seconds: number, sampleRate = SR): number {
  return Math.round(seconds * sampleRate);
}

export function silence(seconds: number, sampleRate = SR): Float32Array {
  return new Float32Array(frames(seconds, sampleRate));
}

/** Constant value (pure DC). */
export function dc(level: number, seconds: number, sampleRate = SR): Float32Array {
  return new Float32Array(frames(seconds, sampleRate)).fill(level);
}

export interface SineOptions {
  hz: number;
  seconds: number;
  /** Peak amplitude, default 1 (0 dBFS). */
  amplitude?: number;
  /** Start phase in radians, default 0. */
  phase?: number;
  sampleRate?: number;
}

/** amplitude * sin(2 pi hz t + phase). */
export function sine({ hz, seconds, amplitude = 1, phase = 0, sampleRate = SR }: SineOptions): Float32Array {
  const out = new Float32Array(frames(seconds, sampleRate));
  for (let i = 0; i < out.length; i++) out[i] = amplitude * Math.sin((2 * Math.PI * hz * i) / sampleRate + phase);
  return out;
}

export interface NoiseOptions {
  seconds: number;
  /** RMS level in dBFS, default -20. */
  rmsDb?: number;
  seed?: number;
  sampleRate?: number;
}

/** Gaussian white noise with the given RMS level. */
export function whiteNoise({ seconds, rmsDb = -20, seed = 1, sampleRate = SR }: NoiseOptions): Float32Array {
  const rng = makeRng(seed);
  const sigma = amp(rmsDb);
  const out = new Float32Array(frames(seconds, sampleRate));
  for (let i = 0; i < out.length; i++) out[i] = sigma * rng.gaussian();
  return out;
}

/** One-pole low-pass (6 dB / octave) applied `poles` times; returns a new array. */
export function lowpass(x: Float32Array, cutoffHz: number, poles = 2, sampleRate = SR): Float32Array {
  const out = Float64Array.from(x);
  const a = Math.exp((-2 * Math.PI * cutoffHz) / sampleRate);
  for (let p = 0; p < poles; p++) {
    let y = 0;
    for (let i = 0; i < out.length; i++) {
      y = (1 - a) * out[i] + a * y;
      out[i] = y;
    }
  }
  return Float32Array.from(out);
}

export interface DecayOptions {
  /** Time for 60 dB of decay, seconds. */
  rt60Sec: number;
  /** Length of the decaying part, seconds. */
  seconds: number;
  /** Silence (or noise floor only) before the decay starts, seconds. Default 0. */
  preDelaySec?: number;
  /** RMS of the noise at the start of the decay, dBFS. Default -12. */
  startDb?: number;
  /**
   * Stationary noise floor in dB RELATIVE to the start level of the decay (e.g. -50),
   * added over the whole signal including the pre-delay. Default: none.
   */
  noiseFloorDb?: number;
  seed?: number;
  sampleRate?: number;
}

/**
 * Gaussian noise with an exactly exponential envelope: the level falls by 60 dB in `rt60Sec`.
 * This is the textbook model of a diffuse reverb tail with a known RT60.
 */
export function decayingNoise({
  rt60Sec,
  seconds,
  preDelaySec = 0,
  startDb = -12,
  noiseFloorDb,
  seed = 1,
  sampleRate = SR,
}: DecayOptions): Float32Array {
  const rng = makeRng(seed);
  const pre = frames(preDelaySec, sampleRate);
  const n = frames(seconds, sampleRate);
  const out = new Float32Array(pre + n);
  const start = amp(startDb);
  // Amplitude falls by a factor 1000 (60 dB) in rt60Sec.
  const perSample = Math.log(1000) / (rt60Sec * sampleRate);
  for (let i = 0; i < n; i++) out[pre + i] = start * Math.exp(-perSample * i) * rng.gaussian();
  if (noiseFloorDb !== undefined) {
    const floorRng = makeRng(seed ^ 0x5f3759df);
    const sigma = start * amp(noiseFloorDb);
    for (let i = 0; i < out.length; i++) out[i] += sigma * floorRng.gaussian();
  }
  return out;
}

export interface BandDecayOptions {
  /** Band edges in Hz: the signal has no energy outside. */
  loHz: number;
  hiHz: number;
  rt60Sec: number;
  seconds: number;
  /** Number of sine partials spread over the band, default 64. */
  partials?: number;
  /** RMS at the start of the decay, dBFS. Default -12. */
  startDb?: number;
  seed?: number;
  sampleRate?: number;
}

/**
 * Strictly band-limited "noise" with an exponential envelope: a sum of sines with random
 * frequencies inside [loHz, hiHz] and random phases, falling by 60 dB in `rt60Sec`.
 */
export function decayingBand({
  loHz,
  hiHz,
  rt60Sec,
  seconds,
  partials = 64,
  startDb = -12,
  seed = 1,
  sampleRate = SR,
}: BandDecayOptions): Float32Array {
  const rng = makeRng(seed);
  const n = frames(seconds, sampleRate);
  const acc = new Float64Array(n);
  for (let p = 0; p < partials; p++) {
    const w = (2 * Math.PI * rng.uniform(loHz, hiHz)) / sampleRate;
    const phase = rng.uniform(0, 2 * Math.PI);
    const cw = Math.cos(w);
    const sw = Math.sin(w);
    let re = Math.cos(phase);
    let im = Math.sin(phase);
    // Rotating pointer: (re, im) advances by w per sample.
    for (let i = 0; i < n; i++) {
      acc[i] += im;
      const next = re * cw - im * sw;
      im = re * sw + im * cw;
      re = next;
    }
  }
  const out = new Float32Array(n);
  const gain = amp(startDb) * Math.sqrt(2 / partials);
  const perSample = Math.log(1000) / (rt60Sec * sampleRate);
  for (let i = 0; i < n; i++) out[i] = gain * acc[i] * Math.exp(-perSample * i);
  return out;
}

export interface BurstOptions {
  /** Length of one loud stretch and of one quiet stretch, seconds. */
  onSec: number;
  offSec: number;
  /** Number of on/off pairs. */
  repeats: number;
  /** Sine frequency of the loud stretches, default 440 Hz. */
  hz?: number;
  /** Peak amplitude of the loud stretches, default 0.5. */
  amplitude?: number;
  /** Peak amplitude of the quiet stretches, default 0 (digital silence). */
  offAmplitude?: number;
  sampleRate?: number;
}

/** A tone that is switched on and off: `repeats` times [onSec loud, offSec quiet]. */
export function gatedBursts({
  onSec,
  offSec,
  repeats,
  hz = 440,
  amplitude = 0.5,
  offAmplitude = 0,
  sampleRate = SR,
}: BurstOptions): Float32Array {
  const on = frames(onSec, sampleRate);
  const off = frames(offSec, sampleRate);
  const out = new Float32Array((on + off) * repeats);
  for (let i = 0; i < out.length; i++) {
    const loud = i % (on + off) < on;
    out[i] = (loud ? amplitude : offAmplitude) * Math.sin((2 * Math.PI * hz * i) / sampleRate);
  }
  return out;
}

export interface VibratoOptions {
  /** Centre frequency in Hz. */
  hz: number;
  /** Peak pitch deviation in cents. */
  depthCents: number;
  /** Rate of the pitch movement in Hz. */
  lfoHz: number;
  seconds: number;
  amplitude?: number;
  /** Second, independent pitch movement (depth in cents, rate in Hz). */
  extra?: { depthCents: number; lfoHz: number };
  sampleRate?: number;
}

/** The pitch offset in cents that `vibratoSine` applies at time `t` (seconds). */
export function vibratoCentsAt(t: number, o: Pick<VibratoOptions, 'depthCents' | 'lfoHz' | 'extra'>): number {
  let cents = o.depthCents * Math.sin(2 * Math.PI * o.lfoHz * t);
  if (o.extra) cents += o.extra.depthCents * Math.sin(2 * Math.PI * o.extra.lfoHz * t);
  return cents;
}

/**
 * Sine whose pitch moves by +- depthCents at lfoHz (frequency = hz * 2^(cents(t) / 1200)).
 * The phase is the running sum of the instantaneous frequency (midpoint rule), in float64.
 */
export function vibratoSine(o: VibratoOptions): Float32Array {
  const sampleRate = o.sampleRate ?? SR;
  const amplitude = o.amplitude ?? 0.5;
  const out = new Float32Array(frames(o.seconds, sampleRate));
  let phase = 0;
  for (let i = 0; i < out.length; i++) {
    out[i] = amplitude * Math.sin(phase);
    const cents = vibratoCentsAt((i + 0.5) / sampleRate, o);
    phase += (2 * Math.PI * o.hz * 2 ** (cents / 1200)) / sampleRate;
    if (phase > Math.PI) phase -= 2 * Math.PI;
  }
  return out;
}

/** Joins signals end to end. */
export function concat(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Sample-wise sum (length of the longest input). */
export function add(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => Math.max(n, p.length), 0));
  for (const p of parts) for (let i = 0; i < p.length; i++) out[i] += p[i];
  return out;
}

export function scale(x: Float32Array, gain: number): Float32Array {
  return x.map((v) => v * gain);
}

/** Limits every sample to [-limit, limit]. */
export function hardClip(x: Float32Array, limit: number): Float32Array {
  return x.map((v) => Math.max(-limit, Math.min(limit, v)));
}

/** Raised-cosine fade to zero over the last `seconds` of the signal; returns a new array. */
export function fadeOut(x: Float32Array, seconds: number, sampleRate = SR): Float32Array {
  const out = Float32Array.from(x);
  const n = Math.min(out.length, frames(seconds, sampleRate));
  for (let i = 0; i < n; i++) out[out.length - 1 - i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / n);
  return out;
}

/** Multiplies the signal from `fromSec` on with an exponential fall of `dbPerSec`. */
export function decayFrom(x: Float32Array, fromSec: number, dbPerSec: number, sampleRate = SR): Float32Array {
  const out = Float32Array.from(x);
  const from = frames(fromSec, sampleRate);
  for (let i = from; i < out.length; i++) out[i] *= amp((-dbPerSec * (i - from)) / sampleRate);
  return out;
}

/**
 * Plain DFT, O(n^2): the reference the FFT is checked against. Bins 0 .. n - 1.
 * `xi` is the optional imaginary part of the input.
 */
export function naiveDft(x: ArrayLike<number>, xi?: ArrayLike<number>): { re: Float64Array; im: Float64Array } {
  const n = x.length;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    let sr = 0;
    let si = 0;
    for (let i = 0; i < n; i++) {
      const a = (-2 * Math.PI * ((k * i) % n)) / n;
      const c = Math.cos(a);
      const s = Math.sin(a);
      const yi = xi ? xi[i] : 0;
      sr += x[i] * c - yi * s;
      si += x[i] * s + yi * c;
    }
    re[k] = sr;
    im[k] = si;
  }
  return { re, im };
}
