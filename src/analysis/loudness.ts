/**
 * Programme loudness after ITU-R BS.1770-4 and a 4x oversampled peak estimate.
 *
 * Integrated loudness: K-weighting (a high shelf and a high-pass), mean square over
 * 400 ms blocks with 75 % overlap, an absolute gate at -70 LUFS and a relative gate
 * 10 LU below the mean of the blocks that passed the absolute gate.
 *
 * Pure and deterministic.
 */

/** Blocks quieter than this never count. */
export const LUFS_ABSOLUTE_GATE = -70;
/** Blocks this far below the ungated mean do not count either. */
export const LUFS_RELATIVE_GATE_LU = -10;
export const LUFS_BLOCK_SEC = 0.4;
/** Blocks advance by a quarter of their length. */
export const LUFS_HOP_SEC = 0.1;

interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

/**
 * The two K-weighting filters for a sample rate. At 48 kHz these are the coefficients
 * printed in BS.1770 (to the printed precision).
 */
export function kWeighting(sampleRate: number): { shelf: Biquad; highpass: Biquad } {
  // Stage 1: high shelf (+4 dB above ~1.7 kHz), the head model.
  const shelfHz = 1681.974450955533;
  const shelfGainDb = 3.999843853973347;
  const shelfQ = 0.7071752369554196;
  const k1 = Math.tan((Math.PI * shelfHz) / sampleRate);
  const vh = 10 ** (shelfGainDb / 20);
  const vb = vh ** 0.4996667741545416;
  const d1 = 1 + k1 / shelfQ + k1 * k1;
  const shelf: Biquad = {
    b0: (vh + (vb * k1) / shelfQ + k1 * k1) / d1,
    b1: (2 * (k1 * k1 - vh)) / d1,
    b2: (vh - (vb * k1) / shelfQ + k1 * k1) / d1,
    a1: (2 * (k1 * k1 - 1)) / d1,
    a2: (1 - k1 / shelfQ + k1 * k1) / d1,
  };
  // Stage 2: high-pass at ~38 Hz (RLB weighting).
  const hpHz = 38.13547087602444;
  const hpQ = 0.5003270373238773;
  const k2 = Math.tan((Math.PI * hpHz) / sampleRate);
  const d2 = 1 + k2 / hpQ + k2 * k2;
  const highpass: Biquad = {
    b0: 1,
    b1: -2,
    b2: 1,
    a1: (2 * (k2 * k2 - 1)) / d2,
    a2: (1 - k2 / hpQ + k2 * k2) / d2,
  };
  return { shelf, highpass };
}

/** Running sums of the squared K-weighted signal of one channel (prefix sums, float64). */
function weightedPrefix(x: Float32Array, sampleRate: number): Float64Array {
  const { shelf, highpass } = kWeighting(sampleRate);
  const out = new Float64Array(x.length + 1);
  let s1 = 0;
  let s2 = 0;
  let h1 = 0;
  let h2 = 0;
  let acc = 0;
  for (let i = 0; i < x.length; i++) {
    const v = x[i];
    const y = shelf.b0 * v + s1;
    s1 = shelf.b1 * v - shelf.a1 * y + s2;
    s2 = shelf.b2 * v - shelf.a2 * y;
    const z = highpass.b0 * y + h1;
    h1 = highpass.b1 * y - highpass.a1 * z + h2;
    h2 = highpass.b2 * y - highpass.a2 * z;
    acc += z * z;
    out[i + 1] = acc;
  }
  return out;
}

const toLufs = (power: number): number => (power > 0 ? -0.691 + 10 * Math.log10(power) : -Infinity);

/**
 * Integrated loudness in LUFS of a mono or stereo signal (all channels weighted 1.0).
 * -Infinity when nothing passes the absolute gate (silence) or the signal is shorter
 * than one block.
 */
export function integratedLufs(channels: readonly Float32Array[], sampleRate: number): number {
  const n = channels.length > 0 ? channels[0].length : 0;
  const block = Math.round(LUFS_BLOCK_SEC * sampleRate);
  const hop = Math.round(LUFS_HOP_SEC * sampleRate);
  if (n < block || block <= 0) return -Infinity;
  const prefixes = channels.map((c) => weightedPrefix(c, sampleRate));
  const powers: number[] = [];
  for (let start = 0; start + block <= n; start += hop) {
    let p = 0;
    for (const prefix of prefixes) p += (prefix[start + block] - prefix[start]) / block;
    powers.push(p);
  }
  const absolute = powers.filter((p) => toLufs(p) > LUFS_ABSOLUTE_GATE);
  if (absolute.length === 0) return -Infinity;
  const ungated = absolute.reduce((a, b) => a + b, 0) / absolute.length;
  const relativeGate = toLufs(ungated) + LUFS_RELATIVE_GATE_LU;
  const gated = absolute.filter((p) => toLufs(p) > relativeGate);
  if (gated.length === 0) return -Infinity;
  return toLufs(gated.reduce((a, b) => a + b, 0) / gated.length);
}

/** Taps on each side of the interpolation kernel. */
const TP_HALF_TAPS = 12;
const TP_PHASES = 4;

/** Windowed-sinc kernels for the three in-between positions (1/4, 2/4, 3/4 of a sample). */
function interpolationKernels(): Float64Array[] {
  const kernels: Float64Array[] = [];
  for (let phase = 1; phase < TP_PHASES; phase++) {
    const frac = phase / TP_PHASES;
    const taps = new Float64Array(TP_HALF_TAPS * 2);
    let sum = 0;
    for (let k = 0; k < taps.length; k++) {
      // Tap k sits at sample offset (k - HALF + 1); the point we want is at offset `frac`.
      const t = k - TP_HALF_TAPS + 1 - frac;
      const sinc = t === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t);
      const hann = 0.5 + 0.5 * Math.cos((Math.PI * t) / TP_HALF_TAPS);
      taps[k] = sinc * hann;
      sum += taps[k];
    }
    for (let k = 0; k < taps.length; k++) taps[k] /= sum;
    kernels.push(taps);
  }
  return kernels;
}

/**
 * Peak of the signal between the samples too (4x oversampling), in dBFS. Only the
 * neighbourhood of samples within 6 dB of the sample peak is interpolated: a true peak
 * cannot hide next to much smaller samples.
 */
export function truePeakDb(channels: readonly Float32Array[]): number {
  let samplePeak = 0;
  for (const c of channels) {
    for (let i = 0; i < c.length; i++) {
      const a = Math.abs(c[i]);
      if (a > samplePeak) samplePeak = a;
    }
  }
  if (samplePeak <= 0) return -Infinity;
  const kernels = interpolationKernels();
  const near = samplePeak * 0.5;
  let peak = samplePeak;
  for (const c of channels) {
    const n = c.length;
    for (let i = 0; i < n - 1; i++) {
      if (Math.abs(c[i]) < near && Math.abs(c[i + 1]) < near) continue;
      for (const taps of kernels) {
        let v = 0;
        for (let k = 0; k < taps.length; k++) {
          const j = i + k - TP_HALF_TAPS + 1;
          if (j >= 0 && j < n) v += taps[k] * c[j];
        }
        const a = Math.abs(v);
        if (a > peak) peak = a;
      }
    }
  }
  return 20 * Math.log10(peak);
}
