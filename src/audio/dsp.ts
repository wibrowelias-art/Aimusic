/**
 * Pure DSP helpers (no AudioContext): dB conversion, RBJ biquads, level meters.
 * Used to build the reverb impulse response and the noise loop, and by the tests.
 */

export function dbToGain(db: number): number {
  return 10 ** (db / 20);
}

/** 20 * log10(gain); -Infinity for 0. */
export function gainToDb(gain: number): number {
  return gain > 0 ? 20 * Math.log10(gain) : -Infinity;
}

export function midiToHz(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

/** Normalised biquad coefficients (a0 = 1). */
export interface BiquadCoeffs {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

function rbj(sampleRate: number, hz: number, q: number): { cos: number; alpha: number } {
  const w0 = (2 * Math.PI * Math.min(hz, sampleRate * 0.49)) / sampleRate;
  return { cos: Math.cos(w0), alpha: Math.sin(w0) / (2 * q) };
}

/** 12 dB/oct low-pass (RBJ cookbook). */
export function lowpassCoeffs(sampleRate: number, hz: number, q = Math.SQRT1_2): BiquadCoeffs {
  const { cos, alpha } = rbj(sampleRate, hz, q);
  const a0 = 1 + alpha;
  return {
    b0: (1 - cos) / 2 / a0,
    b1: (1 - cos) / a0,
    b2: (1 - cos) / 2 / a0,
    a1: (-2 * cos) / a0,
    a2: (1 - alpha) / a0,
  };
}

/** 12 dB/oct high-pass (RBJ cookbook). */
export function highpassCoeffs(sampleRate: number, hz: number, q = Math.SQRT1_2): BiquadCoeffs {
  const { cos, alpha } = rbj(sampleRate, hz, q);
  const a0 = 1 + alpha;
  return {
    b0: (1 + cos) / 2 / a0,
    b1: -(1 + cos) / a0,
    b2: (1 + cos) / 2 / a0,
    a1: (-2 * cos) / a0,
    a2: (1 - alpha) / a0,
  };
}

/** Band-pass with 0 dB peak gain (RBJ cookbook). */
export function bandpassCoeffs(sampleRate: number, hz: number, q: number): BiquadCoeffs {
  const { cos, alpha } = rbj(sampleRate, hz, q);
  const a0 = 1 + alpha;
  return { b0: alpha / a0, b1: 0, b2: -alpha / a0, a1: (-2 * cos) / a0, a2: (1 - alpha) / a0 };
}

/**
 * Filters `x` in place (transposed direct form II, float64 state).
 * `state` carries the two delay values across calls; it is updated.
 */
export function biquadInPlace(
  x: Float32Array | Float64Array,
  c: BiquadCoeffs,
  state: [number, number] = [0, 0],
): void {
  let z1 = state[0];
  let z2 = state[1];
  const { b0, b1, b2, a1, a2 } = c;
  for (let i = 0; i < x.length; i++) {
    const v = x[i];
    const y = b0 * v + z1;
    z1 = b1 * v - a1 * y + z2;
    z2 = b2 * v - a2 * y;
    x[i] = y;
  }
  state[0] = z1;
  state[1] = z2;
}

/**
 * Filters a PERIODIC signal in place so the result is periodic too: the filter is
 * warmed up on the last `warmup` samples of the loop before the real pass.
 */
export function biquadPeriodicInPlace(
  x: Float32Array | Float64Array,
  c: BiquadCoeffs,
  warmup: number,
): void {
  const n = x.length;
  const w = Math.min(warmup, n);
  const state: [number, number] = [0, 0];
  const head = x.slice(n - w);
  biquadInPlace(head, c, state);
  biquadInPlace(x, c, state);
}

/** Largest |sample| over all channels in [from, to). */
export function peakAbs(channels: readonly Float32Array[], from = 0, to = Infinity): number {
  let peak = 0;
  for (const ch of channels) {
    const end = Math.min(to, ch.length);
    for (let i = Math.max(0, from); i < end; i++) {
      const a = Math.abs(ch[i]);
      if (a > peak) peak = a;
    }
  }
  return peak;
}

/** RMS over all channels in [from, to), linear. */
export function rms(channels: readonly Float32Array[], from = 0, to = Infinity): number {
  let sum = 0;
  let count = 0;
  for (const ch of channels) {
    const end = Math.min(to, ch.length);
    for (let i = Math.max(0, from); i < end; i++) {
      sum += ch[i] * ch[i];
      count++;
    }
  }
  return count > 0 ? Math.sqrt(sum / count) : 0;
}

export function peakDb(channels: readonly Float32Array[], from = 0, to = Infinity): number {
  return gainToDb(peakAbs(channels, from, to));
}

export function rmsDb(channels: readonly Float32Array[], from = 0, to = Infinity): number {
  return gainToDb(rms(channels, from, to));
}
