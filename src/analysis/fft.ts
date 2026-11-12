/**
 * Radix-2 FFT utilities for the measurement library.
 *
 * Pure TypeScript on typed arrays, no Web Audio, no randomness. The only state is
 * a cache of twiddle tables (pure memoisation), so results are deterministic.
 *
 * Convention: X[k] = sum_n x[n] * exp(-2 pi i k n / N), no scaling on the forward
 * transform, 1 / N on the inverse.
 */

export function isPowerOfTwo(n: number): boolean {
  return Number.isInteger(n) && n >= 1 && n <= 0x40000000 && (n & (n - 1)) === 0;
}

/** Smallest power of two >= n (1 for n <= 1). */
export function nextPowerOfTwo(n: number): number {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

interface FftTables {
  /** Bit-reversed index of every position. */
  rev: Uint32Array;
  /** cos(2 pi k / n), sin(2 pi k / n) and -sin(2 pi k / n) for k < n / 2. */
  cos: Float64Array;
  sin: Float64Array;
  negSin: Float64Array;
}

/** Tables are kept for sizes up to this; larger ones are rebuilt per call instead of held in memory. */
const MAX_CACHED_SIZE = 1 << 16;
const tableCache = new Map<number, FftTables>();

function getTables(n: number): FftTables {
  let t = tableCache.get(n);
  if (t) return t;
  const half = n >> 1;
  const rev = new Uint32Array(n);
  let bits = 0;
  while (1 << bits < n) bits++;
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b);
    rev[i] = r;
  }
  const cos = new Float64Array(half);
  const sin = new Float64Array(half);
  const negSin = new Float64Array(half);
  for (let k = 0; k < half; k++) {
    const a = (2 * Math.PI * k) / n;
    cos[k] = Math.cos(a);
    sin[k] = Math.sin(a);
    negSin[k] = -sin[k];
  }
  t = { rev, cos, sin, negSin };
  if (n <= MAX_CACHED_SIZE) tableCache.set(n, t);
  return t;
}

function assertSize(n: number): void {
  if (!isPowerOfTwo(n)) throw new RangeError(`FFT size must be a power of two, got ${n}`);
}

/**
 * In-place complex FFT. `re` and `im` must have the same power-of-two length.
 * With `inverse` the result is scaled by 1 / N, so fft followed by ifft is the identity.
 */
export function fftInPlace(re: Float64Array, im: Float64Array, inverse = false): void {
  const n = re.length;
  assertSize(n);
  if (im.length !== n) throw new RangeError(`FFT: re has ${n} values, im has ${im.length}`);
  if (n === 1) return;
  const tables = getTables(n);
  const { rev, cos } = tables;
  // Twiddle factors: exp(-i a) = cos a - i sin a forward, exp(+i a) inverse.
  const sin = inverse ? tables.sin : tables.negSin;
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (j > i) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }
  // First stage: the twiddle factor is 1.
  for (let a = 0; a < n; a += 2) {
    const xr = re[a + 1];
    const xi = im[a + 1];
    re[a + 1] = re[a] - xr;
    im[a + 1] = im[a] - xi;
    re[a] += xr;
    im[a] += xi;
  }
  for (let len = 4; len <= n; len <<= 1) {
    const half = len >> 1;
    const step = n / len;
    if (half <= 16) {
      // Short blocks: one twiddle factor at a time, across all blocks.
      for (let j = 0, k = 0; j < half; j++, k += step) {
        const wr = cos[k];
        const wi = sin[k];
        for (let a = j; a < n; a += len) {
          const b = a + half;
          const br = re[b];
          const bi = im[b];
          const xr = br * wr - bi * wi;
          const xi = br * wi + bi * wr;
          const ar = re[a];
          const ai = im[a];
          re[b] = ar - xr;
          im[b] = ai - xi;
          re[a] = ar + xr;
          im[a] = ai + xi;
        }
      }
    } else {
      // Long blocks: one block at a time (stays inside the cache for large sizes).
      for (let start = 0; start < n; start += len) {
        for (let a = start, k = 0; a < start + half; a++, k += step) {
          const wr = cos[k];
          const wi = sin[k];
          const b = a + half;
          const br = re[b];
          const bi = im[b];
          const xr = br * wr - bi * wi;
          const xi = br * wi + bi * wr;
          const ar = re[a];
          const ai = im[a];
          re[b] = ar - xr;
          im[b] = ai - xi;
          re[a] = ar + xr;
          im[a] = ai + xi;
        }
      }
    }
  }
  if (inverse) {
    const s = 1 / n;
    for (let i = 0; i < n; i++) {
      re[i] *= s;
      im[i] *= s;
    }
  }
}

/**
 * Forward FFT of real input of one fixed size, with reusable work buffers.
 * A size-N real transform is done as one complex FFT of size N / 2.
 */
export class RealFft {
  /** Transform size N (power of two). */
  readonly size: number;
  /** Number of output bins, N / 2 + 1 (DC .. Nyquist). */
  readonly bins: number;
  private readonly zr: Float64Array;
  private readonly zi: Float64Array;
  private readonly tables: FftTables;

  constructor(size: number) {
    assertSize(size);
    this.size = size;
    this.bins = (size >> 1) + 1;
    const half = Math.max(1, size >> 1);
    this.zr = new Float64Array(half);
    this.zi = new Float64Array(half);
    this.tables = getTables(size);
  }

  /**
   * Transforms `frame` (exactly `size` real values) into bins 0 .. N / 2.
   * `outRe` and `outIm` need at least `bins` entries. `frame` is not modified.
   */
  forward(frame: ArrayLike<number>, outRe: Float64Array, outIm: Float64Array): void {
    const n = this.size;
    if (frame.length !== n) throw new RangeError(`RealFft: expected ${n} samples, got ${frame.length}`);
    if (outRe.length < this.bins || outIm.length < this.bins) {
      throw new RangeError(`RealFft: output needs ${this.bins} bins`);
    }
    if (n === 1) {
      outRe[0] = frame[0];
      outIm[0] = 0;
      return;
    }
    const h = n >> 1;
    const { zr, zi } = this;
    // z[m] = x[2m] + i x[2m + 1]; its FFT Z holds the FFTs of the even and of the odd samples:
    // E[k] = (Z[k] + conj(Z[h - k])) / 2, O[k] = (Z[k] - conj(Z[h - k])) / (2i).
    for (let m = 0; m < h; m++) {
      zr[m] = frame[2 * m];
      zi[m] = frame[2 * m + 1];
    }
    fftInPlace(zr, zi);
    // X[k] = E[k] + exp(-2 pi i k / N) O[k]. At k = 0 and k = h: E = Re Z[0], O = Im Z[0].
    outRe[0] = zr[0] + zi[0];
    outIm[0] = 0;
    outRe[h] = zr[0] - zi[0];
    outIm[h] = 0;
    const { cos, sin } = this.tables;
    for (let k = 1; k < h; k++) {
      const ar = zr[k];
      const ai = zi[k];
      const br = zr[h - k];
      const bi = zi[h - k];
      const er = 0.5 * (ar + br);
      const ei = 0.5 * (ai - bi);
      const or = 0.5 * (ai + bi);
      const oi = 0.5 * (br - ar);
      const c = cos[k];
      const s = sin[k];
      outRe[k] = er + c * or + s * oi;
      outIm[k] = ei + c * oi - s * or;
    }
  }
}

/**
 * FFT of a real signal. The input is zero-padded to `size` (default: the next
 * power of two >= its length). Returns bins 0 .. size / 2 (DC .. Nyquist).
 */
export function realFft(input: ArrayLike<number>, size?: number): { re: Float64Array; im: Float64Array } {
  const n = size ?? nextPowerOfTwo(Math.max(1, input.length));
  assertSize(n);
  if (input.length > n) throw new RangeError(`realFft: ${input.length} samples do not fit into size ${n}`);
  const frame = new Float64Array(n);
  for (let i = 0; i < input.length; i++) frame[i] = input[i];
  const fft = new RealFft(n);
  const re = new Float64Array(fft.bins);
  const im = new Float64Array(fft.bins);
  fft.forward(frame, re, im);
  return { re, im };
}

/**
 * Hann window. `periodic` (default) is the DFT-even form used for spectral analysis
 * (w[n] = 0.5 - 0.5 cos(2 pi n / N)); otherwise the symmetric form with zeros at both ends.
 */
export function hannWindow(length: number, periodic = true): Float64Array {
  const n = Math.max(0, Math.floor(length));
  const w = new Float64Array(n);
  if (n === 1) {
    w[0] = 1;
    return w;
  }
  const denom = periodic ? n : n - 1;
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / denom);
  return w;
}

export interface MagnitudeSpectrumOptions {
  /** FFT size (power of two >= frame length). Default: next power of two. */
  size?: number;
  /** Window applied over the frame before zero-padding. Default 'hann'. */
  window?: 'hann' | 'none';
  /**
   * 'amplitude' (default): a steady sine of amplitude A that sits on a bin reads A
   * there (2 |X[k]| / sum(w); DC and Nyquist are not doubled).
   * 'raw': plain |X[k]|.
   */
  scale?: 'amplitude' | 'raw';
}

/** Magnitude spectrum of one frame, bins 0 .. size / 2. */
export function magnitudeSpectrum(frame: ArrayLike<number>, opts: MagnitudeSpectrumOptions = {}): Float64Array {
  const len = frame.length;
  const n = opts.size ?? nextPowerOfTwo(Math.max(1, len));
  assertSize(n);
  if (len > n) throw new RangeError(`magnitudeSpectrum: ${len} samples do not fit into size ${n}`);
  const useHann = (opts.window ?? 'hann') === 'hann';
  const w = useHann ? hannWindow(len) : null;
  const buf = new Float64Array(n);
  let wsum = 0;
  for (let i = 0; i < len; i++) {
    const wi = w ? w[i] : 1;
    buf[i] = frame[i] * wi;
    wsum += wi;
  }
  const fft = new RealFft(n);
  const re = new Float64Array(fft.bins);
  const im = new Float64Array(fft.bins);
  fft.forward(buf, re, im);
  const out = new Float64Array(fft.bins);
  const amplitude = (opts.scale ?? 'amplitude') === 'amplitude';
  const norm = amplitude && wsum > 0 ? 1 / wsum : 1;
  const last = fft.bins - 1;
  for (let k = 0; k <= last; k++) {
    const mag = Math.hypot(re[k], im[k]);
    const doubled = amplitude && k > 0 && k < last;
    out[k] = mag * norm * (doubled ? 2 : 1);
  }
  return out;
}

/** Centre frequency of bin `k` in Hz. */
export function binToHz(k: number, fftSize: number, sampleRate: number): number {
  return (k * sampleRate) / fftSize;
}

/** Nearest bin for a frequency in Hz (not clamped). */
export function hzToBin(hz: number, fftSize: number, sampleRate: number): number {
  return Math.round((hz * fftSize) / sampleRate);
}
