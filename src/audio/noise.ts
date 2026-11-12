/**
 * Procedural noise bed: tape hiss (scaled by lofi) plus rain (scaled by rain).
 * Pure and deterministic, no samples. The result is a seamless loop: every
 * ingredient is periodic by construction (periodic noise through filters that
 * were warmed up on the loop end, swells with whole cycles per loop, droplet
 * grains that wrap around), which is the limit case of a crossfade with no
 * level dip at the seam.
 */
import {
  HISS_CURVE,
  HISS_HP_HZ,
  HISS_LP_HZ,
  HISS_RMS_DB_AT_FULL,
  NOISE_LOOP_SEC,
  RAIN_CURVE,
  RAIN_DROP_AMP_MIN,
  RAIN_DROP_ENERGY_SHARE,
  RAIN_DROP_HZ_HI,
  RAIN_DROP_HZ_LO,
  RAIN_DROP_Q,
  RAIN_DROP_TAU_HI,
  RAIN_DROP_TAU_LO,
  RAIN_DROPS_PER_SEC_MAX,
  RAIN_DROPS_PER_SEC_MIN,
  RAIN_RMS_DB_AT_FULL,
  RAIN_SWELL_CYCLES,
  RAIN_SWELL_DEPTH,
  RAIN_WASH_HP_HZ,
  RAIN_WASH_LP_HZ,
} from './constants';
import {
  bandpassCoeffs,
  biquadInPlace,
  biquadPeriodicInPlace,
  dbToGain,
  highpassCoeffs,
  lowpassCoeffs,
} from './dsp';
import { mulberry32, subSeed } from './rng';
import type { StereoPcm } from './types';

export interface NoiseLoopOptions {
  /** 0..1. Hiss level (0 = no hiss). */
  lofi: number;
  /** 0..1. Rain level (0 = no rain). */
  rain: number;
  /** uint32. Different seeds give different (equally loud) noise. */
  seed: number;
}

const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

function energyOf(a: Float64Array, b: Float64Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * a[i] + b[i] * b[i];
  return sum;
}

/** Periodic band-limited noise, one array per channel (arbitrary level). */
function periodicBand(n: number, sampleRate: number, seed: number, hpHz: number, lpHz: number): Float64Array {
  const rand = mulberry32(seed);
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = rand() * 2 - 1;
  const warmup = Math.round(0.5 * sampleRate);
  biquadPeriodicInPlace(x, highpassCoeffs(sampleRate, hpHz), warmup);
  biquadPeriodicInPlace(x, lowpassCoeffs(sampleRate, lpHz), warmup);
  return x;
}

function addScaled(out: StereoPcm, l: Float64Array, r: Float64Array, targetRms: number): void {
  const n = l.length;
  const current = Math.sqrt(energyOf(l, r) / (2 * n));
  if (!(current > 0)) return;
  const g = targetRms / current;
  for (let i = 0; i < n; i++) {
    out[0][i] += l[i] * g;
    out[1][i] += r[i] * g;
  }
}

function buildRain(n: number, sampleRate: number, rain: number, seed: number): [Float64Array, Float64Array] {
  // Wash: band-limited noise with a slow, loop-periodic level movement.
  const wash = [
    periodicBand(n, sampleRate, subSeed(seed, 10), RAIN_WASH_HP_HZ, RAIN_WASH_LP_HZ),
    periodicBand(n, sampleRate, subSeed(seed, 11), RAIN_WASH_HP_HZ, RAIN_WASH_LP_HZ),
  ];
  const rand = mulberry32(subSeed(seed, 12));
  // Each swell is a sine with a whole number of cycles per loop, advanced by rotation.
  const swells = RAIN_SWELL_CYCLES.map((cycles, k) => {
    const phase = rand() * 2 * Math.PI;
    const step = (2 * Math.PI * cycles) / n;
    return {
      depth: RAIN_SWELL_DEPTH[k],
      sin: Math.sin(phase),
      cos: Math.cos(phase),
      stepSin: Math.sin(step),
      stepCos: Math.cos(step),
    };
  });
  for (let i = 0; i < n; i++) {
    let swell = 1;
    for (const w of swells) {
      swell += w.depth * w.sin;
      const nextSin = w.sin * w.stepCos + w.cos * w.stepSin;
      w.cos = w.cos * w.stepCos - w.sin * w.stepSin;
      w.sin = nextSin;
    }
    wash[0][i] *= swell;
    wash[1][i] *= swell;
  }

  // Droplets: many tiny resonant noise grains, wrapped around the loop end.
  const drops = [new Float64Array(n), new Float64Array(n)];
  const perSec = RAIN_DROPS_PER_SEC_MIN + (RAIN_DROPS_PER_SEC_MAX - RAIN_DROPS_PER_SEC_MIN) * rain;
  const count = Math.round((perSec * n) / sampleRate);
  const grain = new Float64Array(Math.ceil(RAIN_DROP_TAU_HI * 8 * sampleRate) + 8);
  for (let d = 0; d < count; d++) {
    const start = Math.floor(rand() * n);
    const hz = RAIN_DROP_HZ_LO * (RAIN_DROP_HZ_HI / RAIN_DROP_HZ_LO) ** rand();
    const tau = RAIN_DROP_TAU_LO + (RAIN_DROP_TAU_HI - RAIN_DROP_TAU_LO) * rand();
    const u = rand();
    const amp = RAIN_DROP_AMP_MIN + (1 - RAIN_DROP_AMP_MIN) * u * u;
    const pan = (rand() * 2 - 1) * 0.9;
    const angle = ((pan + 1) * Math.PI) / 4;
    const gl = Math.cos(angle) * amp;
    const gr = Math.sin(angle) * amp;
    const glen = Math.min(grain.length, Math.ceil(tau * 8 * sampleRate));
    const decay = Math.exp(-1 / (tau * sampleRate));
    let env = 1;
    for (let i = 0; i < glen; i++) {
      grain[i] = (rand() * 2 - 1) * env;
      env *= decay;
    }
    const view = grain.subarray(0, glen);
    biquadInPlace(view, bandpassCoeffs(sampleRate, hz, RAIN_DROP_Q));
    for (let i = 0; i < glen; i++) {
      const j = (start + i) % n;
      drops[0][j] += view[i] * gl;
      drops[1][j] += view[i] * gr;
    }
  }

  // Fixed energy split between wash and droplets.
  const washE = energyOf(wash[0], wash[1]);
  const dropE = energyOf(drops[0], drops[1]);
  const washG = washE > 0 ? Math.sqrt((1 - RAIN_DROP_ENERGY_SHARE) / washE) : 0;
  const dropG = dropE > 0 ? Math.sqrt(RAIN_DROP_ENERGY_SHARE / dropE) : 0;
  const l = new Float64Array(n);
  const r = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    l[i] = wash[0][i] * washG + drops[0][i] * dropG;
    r[i] = wash[1][i] * washG + drops[1][i] * dropG;
  }
  return [l, r];
}

/** Hiss RMS in dBFS for a lofi value (-Infinity at 0). */
export function hissRmsDb(lofi: number): number {
  const v = clamp01(lofi);
  return v > 0 ? HISS_RMS_DB_AT_FULL + 20 * Math.log10(v ** HISS_CURVE) : -Infinity;
}

/** Rain RMS in dBFS for a rain value (-Infinity at 0). */
export function rainRmsDb(rain: number): number {
  const v = clamp01(rain);
  return v > 0 ? RAIN_RMS_DB_AT_FULL + 20 * Math.log10(v ** RAIN_CURVE) : -Infinity;
}

export function buildNoiseLoop(sampleRate: number, opts: NoiseLoopOptions): StereoPcm {
  const n = Math.round(NOISE_LOOP_SEC * sampleRate);
  const out: StereoPcm = [new Float32Array(n), new Float32Array(n)];
  const lofi = clamp01(opts.lofi);
  const rain = clamp01(opts.rain);
  const seed = opts.seed >>> 0;

  if (lofi > 0) {
    const l = periodicBand(n, sampleRate, subSeed(seed, 1), HISS_HP_HZ, HISS_LP_HZ);
    const r = periodicBand(n, sampleRate, subSeed(seed, 2), HISS_HP_HZ, HISS_LP_HZ);
    addScaled(out, l, r, dbToGain(hissRmsDb(lofi)));
  }
  if (rain > 0) {
    const [l, r] = buildRain(n, sampleRate, rain, seed);
    addScaled(out, l, r, dbToGain(rainRmsDb(rain)));
  }
  return out;
}
