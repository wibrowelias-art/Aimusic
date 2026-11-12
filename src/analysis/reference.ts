/**
 * Reference analysis: reads GENERAL TRAITS of a track the user owns, to set the knobs.
 *
 * What comes out is five numbers and nothing else: tempo, key (with a major / minor
 * colour), note density, brightness and reverb length. By construction this code never
 * holds a melody, a chord sequence or any note data:
 *
 *  - pitch is only ever looked at as ONE histogram of 12 pitch classes summed over the
 *    whole file (which notes are common, not which note comes when);
 *  - time is only ever looked at as an onset-strength curve that carries no pitch
 *    (how often something starts, not what starts);
 *  - both are thrown away when the function returns. The result type has no arrays.
 *
 * Pure and deterministic: plain Float32Array in, numbers out, no Web Audio.
 */
import { BEATS_PER_BAR, KEY_NAMES, MODE_LABELS, PARAM_SPECS, clamp, normalizeParams, paramLabel } from '../engine/params';
import type { Mode, Params } from '../engine/types';
import { RealFft, hannWindow } from './fft';
import { spectralCentroid } from './metrics';

/** The only thing the analysis returns. Scalars only: no notes, no sequences. */
export interface ReferenceTraits {
  /** Seconds of audio that were analysed. */
  analysedSec: number;
  /** Beats per minute as measured (before folding into the lab's 40..72 range), or null. */
  tempoBpm: number | null;
  /** 0..1: how clear the pulse is. */
  tempoConfidence: number;
  /** Tonic pitch class 0..11, or null when no key stands out. */
  keyPc: number | null;
  /** The lab mode closest to the colour of the track, or null. */
  mode: Mode | null;
  /** 0..1: how far the best key is ahead of the next one. */
  keyConfidence: number;
  /** Note onsets per second (all instruments together). */
  onsetsPerSecond: number;
  /** Spectral centroid of the long-term spectrum in Hz. */
  brightnessHz: number;
  /** Decay time in seconds (how long sound takes to fall by 60 dB after it stops), or null. */
  decaySec: number | null;
}

/** Hz. Tempo, onsets and the pitch-class histogram work on a decimated mono signal. */
const WORK_RATE = 11025;
/** Seconds. Longer files are analysed up to here. */
export const REFERENCE_MAX_SEC = 300;
/** Below these confidences a knob is left alone. */
export const TEMPO_MIN_CONFIDENCE = 0.2;
export const KEY_MIN_CONFIDENCE = 0.05;

function mixToMono(channels: readonly Float32Array[], frames: number): Float32Array {
  const out = new Float32Array(frames);
  const n = channels.length;
  if (n === 0) return out;
  for (const ch of channels) {
    const len = Math.min(frames, ch.length);
    for (let i = 0; i < len; i++) out[i] += ch[i] / n;
  }
  return out;
}

/** Low-pass (windowed sinc) and keep every `factor`-th sample. */
function decimate(x: Float32Array, factor: number): Float32Array {
  if (factor <= 1) return x;
  const taps = 8 * factor + 1;
  const mid = (taps - 1) / 2;
  const h = new Float64Array(taps);
  let sum = 0;
  for (let i = 0; i < taps; i++) {
    const t = i - mid;
    const sinc = t === 0 ? 1 : Math.sin((Math.PI * t) / factor) / ((Math.PI * t) / factor);
    const taper = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (taps - 1));
    h[i] = sinc * taper;
    sum += h[i];
  }
  for (let i = 0; i < taps; i++) h[i] /= sum;
  const out = new Float32Array(Math.floor(x.length / factor));
  for (let o = 0; o < out.length; o++) {
    const centre = o * factor;
    let acc = 0;
    for (let i = 0; i < taps; i++) {
      const j = centre + i - mid;
      if (j >= 0 && j < x.length) acc += h[i] * x[j];
    }
    out[o] = acc;
  }
  return out;
}

/**
 * Onset strength over time (spectral flux of the log spectrum, 100 values per second).
 * A curve of "how much starts here": it carries no pitch.
 */
function onsetStrength(x: Float32Array, rate: number): { env: Float32Array; fps: number } {
  const size = 1024;
  const hop = Math.max(1, Math.round(rate / 100));
  const fps = rate / hop;
  const frames = x.length >= size ? 1 + Math.floor((x.length - size) / hop) : 0;
  const env = new Float32Array(frames);
  if (frames === 0) return { env, fps };
  const fft = new RealFft(size);
  const hann = hannWindow(size);
  const re = new Float64Array(fft.bins);
  const im = new Float64Array(fft.bins);
  const frame = new Float64Array(size);
  let prev = new Float64Array(fft.bins);
  let cur = new Float64Array(fft.bins);
  for (let f = 0; f < frames; f++) {
    const start = f * hop;
    for (let i = 0; i < size; i++) frame[i] = x[start + i] * hann[i];
    fft.forward(frame, re, im);
    let flux = 0;
    for (let k = 1; k < fft.bins; k++) {
      // Magnitude scaled so that a sine of amplitude A reads A, then compressed: partials
      // far below the loud ones (and the leakage around a release) add next to nothing.
      cur[k] = Math.log1p((100 * Math.hypot(re[k], im[k])) / (size / 4));
      const d = cur[k] - prev[k];
      if (d > 0) flux += d;
    }
    env[f] = f === 0 ? 0 : flux;
    const swap = prev;
    prev = cur;
    cur = swap;
  }
  return { env, fps };
}

/**
 * Onsets as a COUNT only: local maxima of the (smoothed) strength curve above a moving
 * threshold. One attack smears over about 90 ms of analysis frames, so the curve is
 * smoothed over 50 ms and two onsets are at least 130 ms apart.
 */
function countOnsets(env: Float32Array, fps: number): number {
  const n = env.length;
  if (n < 8) return 0;
  const reach = Math.max(1, Math.round(0.025 * fps));
  const smooth = new Float32Array(n);
  const prefixRaw = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefixRaw[i + 1] = prefixRaw[i] + env[i];
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - reach);
    const b = Math.min(n, i + reach + 1);
    smooth[i] = (prefixRaw[b] - prefixRaw[a]) / (b - a);
  }
  const half = Math.max(1, Math.round(0.5 * fps));
  const minGap = Math.max(1, Math.round(0.13 * fps));
  const globalMean = prefixRaw[n] / n;
  if (!(globalMean > 0)) return 0;
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + smooth[i];
  // What a clear attack looks like in this file: the strength-weighted mean strength
  // (the curve is near zero most of the time, so this sits at the height of the attacks).
  // Bumps far below it (a damper falling, a tail ending, ripple) are not counted as notes.
  let sumSq = 0;
  for (let i = 0; i < n; i++) sumSq += smooth[i] * smooth[i];
  const strong = sumSq / prefix[n];
  let count = 0;
  let last = -Infinity;
  for (let i = 1; i < n - 1; i++) {
    if (!(smooth[i] > smooth[i - 1] && smooth[i] >= smooth[i + 1])) continue;
    const a = Math.max(0, i - half);
    const b = Math.min(n, i + half + 1);
    const local = (prefix[b] - prefix[a]) / (b - a);
    if (smooth[i] > 1.5 * local + 0.5 * globalMean && smooth[i] > 0.2 * strong && i - last >= minGap) {
      count++;
      last = i;
    }
  }
  return count;
}

/** Tempo from the autocorrelation of the onset-strength curve. */
function estimateTempo(env: Float32Array, fps: number): { bpm: number | null; confidence: number } {
  const n = env.length;
  if (n < fps * 4) return { bpm: null, confidence: 0 };
  let mean = 0;
  for (let i = 0; i < n; i++) mean += env[i];
  mean /= n;
  const x = new Float32Array(n);
  let energy = 0;
  for (let i = 0; i < n; i++) {
    x[i] = env[i] - mean;
    energy += x[i] * x[i];
  }
  if (!(energy > 0)) return { bpm: null, confidence: 0 };
  const minLag = Math.max(2, Math.floor((60 / 200) * fps));
  const maxLag = Math.min(n - 1, Math.ceil((60 / 30) * fps));
  const ac = new Float64Array(maxLag + 2);
  for (let lag = minLag - 1; lag <= maxLag + 1 && lag < n; lag++) {
    let s = 0;
    for (let i = lag; i < n; i++) s += x[i] * x[i - lag];
    // Unbiased: fewer products at longer lags.
    ac[lag] = s / (n - lag) / (energy / n);
  }
  let best = -1;
  let bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    if (!(ac[lag] > ac[lag - 1] && ac[lag] >= ac[lag + 1])) continue;
    const bpm = (60 * fps) / lag;
    // A broad preference for moderate tempi breaks ties between a pulse and its multiples.
    const octaves = Math.log2(bpm / 70);
    const score = ac[lag] * Math.exp(-0.5 * (octaves / 1.2) ** 2);
    if (score > bestScore) {
      bestScore = score;
      best = lag;
    }
  }
  if (best < 0 || !(ac[best] > 0)) return { bpm: null, confidence: 0 };
  // Parabolic refinement of the peak position.
  const y0 = ac[best - 1];
  const y1 = ac[best];
  const y2 = ac[best + 1];
  const denom = y0 - 2 * y1 + y2;
  const shift = denom !== 0 ? clamp((0.5 * (y0 - y2)) / denom, -0.5, 0.5) : 0;
  return { bpm: (60 * fps) / (best + shift), confidence: clamp(ac[best], 0, 1) };
}

/**
 * ONE histogram of 12 pitch classes for the whole signal: how much energy each pitch
 * class has in total. Frames are added up as they are read; no frame is kept, so the
 * order of the notes cannot be recovered from the result.
 */
function pitchClassHistogram(x: Float32Array, rate: number): Float64Array {
  const hist = new Float64Array(12);
  const size = 4096;
  const hop = size >> 1;
  if (x.length < size) return hist;
  const fft = new RealFft(size);
  const hann = hannWindow(size);
  const re = new Float64Array(fft.bins);
  const im = new Float64Array(fft.bins);
  const mag = new Float64Array(fft.bins);
  const frame = new Float64Array(size);
  const loBin = Math.max(2, Math.ceil((65 * size) / rate));
  const hiBin = Math.min(fft.bins - 2, Math.floor((2100 * size) / rate));
  for (let start = 0; start + size <= x.length; start += hop) {
    for (let i = 0; i < size; i++) frame[i] = x[start + i] * hann[i];
    fft.forward(frame, re, im);
    for (let k = loBin - 1; k <= hiBin + 1; k++) mag[k] = Math.hypot(re[k], im[k]);
    for (let k = loBin; k <= hiBin; k++) {
      // Spectral peaks only, so that the skirts of a partial do not smear into its neighbours.
      if (!(mag[k] > mag[k - 1] && mag[k] >= mag[k + 1])) continue;
      const hz = (k * rate) / size;
      const midi = 69 + 12 * Math.log2(hz / 440);
      const pc = ((Math.round(midi) % 12) + 12) % 12;
      hist[pc] += mag[k];
    }
  }
  return hist;
}

// Krumhansl-Kessler key profiles (how strongly each scale degree belongs to a major / minor key).
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function correlation(hist: Float64Array, profile: readonly number[], tonic: number): number {
  let mh = 0;
  let mp = 0;
  for (let i = 0; i < 12; i++) {
    mh += hist[i];
    mp += profile[i];
  }
  mh /= 12;
  mp /= 12;
  let num = 0;
  let dh = 0;
  let dp = 0;
  for (let i = 0; i < 12; i++) {
    const a = hist[(tonic + i) % 12] - mh;
    const b = profile[i] - mp;
    num += a * b;
    dh += a * a;
    dp += b * b;
  }
  return dh > 0 && dp > 0 ? num / Math.sqrt(dh * dp) : 0;
}

/**
 * Key from the pitch-class histogram: the best fit of the 24 major / minor profiles.
 * Keys that share their notes (C major and A minor, and the modes between them) fit almost
 * equally well, so the tonic is the least certain of the traits; `confidence` is the
 * distance to the best other tonic.
 */
function estimateKey(hist: Float64Array): { keyPc: number | null; mode: Mode | null; confidence: number } {
  let total = 0;
  for (let i = 0; i < 12; i++) total += hist[i];
  if (!(total > 0)) return { keyPc: null, mode: null, confidence: 0 };
  let best = { score: -Infinity, tonic: 0, minor: false };
  const byTonic = new Float64Array(12).fill(-Infinity);
  for (let tonic = 0; tonic < 12; tonic++) {
    for (const minor of [false, true]) {
      const score = correlation(hist, minor ? MINOR_PROFILE : MAJOR_PROFILE, tonic);
      if (score > byTonic[tonic]) byTonic[tonic] = score;
      if (score > best.score) best = { score, tonic, minor };
    }
  }
  let second = -Infinity;
  for (let tonic = 0; tonic < 12; tonic++) {
    if (tonic !== best.tonic && byTonic[tonic] > second) second = byTonic[tonic];
  }
  const k = best.tonic;
  const at = (interval: number): number => hist[(k + interval) % 12];
  // The colour inside major / minor, read from the same histogram:
  // a raised fourth stronger than the fourth -> lydian; a major sixth stronger than the minor sixth -> dorian.
  // The raised fourth must be a real scale tone (as strong as half the second degree):
  // in a pentatonic piece it only shows up as an overtone of other notes.
  let mode: Mode;
  if (best.minor) mode = at(9) > at(8) ? 'dorian' : 'aeolian';
  else mode = at(6) > at(5) * 1.15 && at(6) > 0.5 * at(2) ? 'lydian' : 'majorPentatonic';
  return { keyPc: k, mode, confidence: clamp(best.score - second, 0, 1) };
}

/**
 * Decay time: how fast the level falls once the direct sound is gone. Lines are fitted to
 * the level curve in windows that start at least 20 dB below the loudest moment of the
 * last 4 seconds (so the notes themselves are over and only the room or the reverb is
 * left) and end above the noise floor. The median slope of the clean, steadily falling
 * windows gives the time for 60 dB. Long windows first; shorter ones for short decays.
 * Returns null when no such free decay is found (dense music, pads, noise beds).
 */
const DECAY_MIN_WINDOWS = 5;
const DECAY_MAX_SEC = 8;

function estimateDecay(x: Float32Array, rate: number): number | null {
  const hopSec = 0.02;
  const hop = Math.max(1, Math.round(rate * hopSec));
  const frames = Math.floor(x.length / hop);
  if (frames < 100) return null;
  const db = new Float32Array(frames);
  let top = -Infinity;
  for (let f = 0; f < frames; f++) {
    let s = 0;
    for (let i = f * hop; i < (f + 1) * hop; i++) s += x[i] * x[i];
    db[f] = 10 * Math.log10(s / hop + 1e-12);
    if (db[f] > top) top = db[f];
  }
  // Loudest level of the last 4 seconds, for every frame.
  const look = Math.round(4 / hopSec);
  const recent = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let m = -Infinity;
    for (let i = Math.max(0, f - look); i <= f; i++) if (db[i] > m) m = db[i];
    recent[f] = m;
  }
  for (const winSec of [1.5, 1.0, 0.6]) {
    const win = Math.round(winSec / hopSec);
    const slopes: number[] = [];
    for (let start = 0; start + win <= frames; start += 5) {
      if (db[start] > recent[start] - 20) continue;
      if (db[start + win - 1] < top - 65) continue;
      let st = 0;
      let sy = 0;
      let stt = 0;
      let sty = 0;
      let syy = 0;
      for (let i = 0; i < win; i++) {
        const t = i * hopSec;
        const y = db[start + i];
        st += t;
        sy += y;
        stt += t * t;
        sty += t * y;
        syy += y * y;
      }
      const vt = win * stt - st * st;
      const vy = win * syy - sy * sy;
      if (!(vt > 0 && vy > 0)) continue;
      const cov = win * sty - st * sy;
      const slope = cov / vt; // dB per second
      const r2 = (cov * cov) / (vt * vy);
      if (slope < -5 && slope > -80 && r2 > 0.95) slopes.push(-slope);
    }
    if (slopes.length >= DECAY_MIN_WINDOWS) {
      slopes.sort((p, q) => p - q);
      const sec = 60 / slopes[slopes.length >> 1];
      // Outside this range the windows were not looking at a room or a reverb.
      return sec >= 0.3 && sec <= DECAY_MAX_SEC ? sec : null;
    }
  }
  return null;
}

/**
 * Reads the five general traits. `channels` = decoded audio (any number of channels).
 * Nothing from the audio is kept: only the returned numbers leave this function.
 */
export function analyseReference(channels: readonly Float32Array[], sampleRate: number): ReferenceTraits {
  const total = channels.reduce((m, ch) => Math.max(m, ch.length), 0);
  const frames = Math.min(total, Math.floor(REFERENCE_MAX_SEC * sampleRate));
  const empty: ReferenceTraits = {
    analysedSec: 0,
    tempoBpm: null,
    tempoConfidence: 0,
    keyPc: null,
    mode: null,
    keyConfidence: 0,
    onsetsPerSecond: 0,
    brightnessHz: 0,
    decaySec: null,
  };
  if (!(sampleRate > 0) || frames < sampleRate) return empty;
  const mono = mixToMono(channels, frames);
  const factor = Math.max(1, Math.floor(sampleRate / WORK_RATE));
  const work = decimate(mono, factor);
  const rate = sampleRate / factor;
  const seconds = frames / sampleRate;

  const { env, fps } = onsetStrength(work, rate);
  const tempo = estimateTempo(env, fps);
  const onsets = countOnsets(env, fps);
  const key = estimateKey(pitchClassHistogram(work, rate));
  return {
    analysedSec: seconds,
    tempoBpm: tempo.bpm,
    tempoConfidence: tempo.confidence,
    keyPc: key.keyPc,
    mode: key.mode,
    keyConfidence: key.confidence,
    onsetsPerSecond: onsets / seconds,
    brightnessHz: spectralCentroid([mono], sampleRate),
    decaySec: estimateDecay(work, rate),
  };
}

/** A measured tempo moved by octaves into the lab's range (120 -> 60, 90 -> 45). */
export function foldTempo(bpm: number): number {
  const { min, max } = PARAM_SPECS.tempo;
  let t = bpm;
  for (let guard = 0; guard < 8 && t > max; guard++) t /= 2;
  for (let guard = 0; guard < 8 && t < min; guard++) t *= 2;
  // 72..80 has no octave inside 40..72: take the nearer end.
  if (t > max) t = t / 2 >= min * 0.95 && Math.log2(t / max) > Math.log2(min / (t / 2)) ? min : max;
  return Math.round(clamp(t, min, max));
}

export interface ReferenceRow {
  /** Name of the trait. */
  trait: string;
  /** What was measured, as text. */
  measured: string;
  /** What the knob is set to, or why it is left alone. */
  setting: string;
}

export interface ReferenceSettings {
  /** Only the knobs the traits are clear enough to set. */
  changes: Partial<Params>;
  rows: ReferenceRow[];
}

/**
 * Hz. Centroid of the lab's own renders at its default settings (measured 300..410 Hz on
 * the Phase 1 baseline). A reference with this centroid leaves register and lo-fi where
 * the defaults are; every octave above / below moves them.
 */
export const BRIGHTNESS_NEUTRAL_HZ = 350;
const REGISTER_PER_OCTAVE = 5; // semitones
const LOFI_PER_OCTAVE = -0.2;

/** Brightness (Hz) in octaves above the lab's own typical centroid. */
function brightnessOctaves(hz: number): number {
  return Math.log2(Math.max(hz, 1) / BRIGHTNESS_NEUTRAL_HZ);
}

/** Turns measured traits into knob values. `current` supplies the tempo when none was found. */
export function traitsToSettings(traits: ReferenceTraits, current: Params): ReferenceSettings {
  const changes: Partial<Params> = {};
  const rows: ReferenceRow[] = [];

  // Tempo
  let tempo = current.tempo;
  if (traits.tempoBpm !== null && traits.tempoConfidence >= TEMPO_MIN_CONFIDENCE) {
    tempo = foldTempo(traits.tempoBpm);
    changes.tempo = tempo;
    const folded = Math.abs(tempo - traits.tempoBpm) > 1.5 ? ' (moved by octaves into 40 to 72)' : '';
    rows.push({ trait: 'Tempo', measured: `${traits.tempoBpm.toFixed(0)} BPM`, setting: `${tempo} BPM${folded}` });
  } else {
    rows.push({ trait: 'Tempo', measured: 'no clear pulse', setting: `kept at ${tempo} BPM` });
  }

  // Key and colour
  if (traits.keyPc !== null && traits.mode !== null && traits.keyConfidence >= KEY_MIN_CONFIDENCE) {
    changes.key = traits.keyPc;
    changes.mode = traits.mode;
    rows.push({
      trait: 'Key',
      measured: `${KEY_NAMES[traits.keyPc]}, ${traits.mode === 'aeolian' || traits.mode === 'dorian' ? 'minor' : 'major'} colour (the least certain reading: check it)`,
      setting: `${KEY_NAMES[traits.keyPc]} ${MODE_LABELS[traits.mode].toLowerCase()}`,
    });
  } else {
    rows.push({ trait: 'Key', measured: 'no clear key', setting: 'kept' });
  }

  // Note density: onsets per second -> notes per bar at the tempo in use.
  const barSec = (BEATS_PER_BAR * 60) / tempo;
  const perBar = traits.onsetsPerSecond * barSec;
  const density = clamp(perBar, PARAM_SPECS.density.min, PARAM_SPECS.density.max);
  changes.density = density;
  rows.push({
    trait: 'Note density',
    measured: `${traits.onsetsPerSecond.toFixed(2)} onsets per second`,
    setting:
      paramLabel('density', normalizeParams({ ...current, density }).density) +
      (perBar > PARAM_SPECS.density.max + 0.05 ? ` (measured ${perBar.toFixed(1)} per bar, the lab stops at 4)` : ''),
  });

  // Brightness -> register and lo-fi together.
  if (traits.brightnessHz > 0) {
    const octaves = brightnessOctaves(traits.brightnessHz);
    changes.register = Math.round(
      clamp(PARAM_SPECS.register.default + REGISTER_PER_OCTAVE * octaves, PARAM_SPECS.register.min, PARAM_SPECS.register.max),
    );
    changes.lofi = clamp(PARAM_SPECS.lofi.default + LOFI_PER_OCTAVE * octaves, 0, 1);
    const n = normalizeParams({ ...current, ...changes });
    rows.push({
      trait: 'Brightness',
      measured: `centroid ${traits.brightnessHz.toFixed(0)} Hz`,
      setting: `register ${paramLabel('register', n.register)}, lo-fi ${paramLabel('lofi', n.lofi)}`,
    });
  }

  // Reverb length
  if (traits.decaySec !== null) {
    const size = clamp(traits.decaySec, PARAM_SPECS.reverbSize.min, PARAM_SPECS.reverbSize.max);
    changes.reverbSize = size;
    const outside = traits.decaySec < PARAM_SPECS.reverbSize.min - 0.05 || traits.decaySec > PARAM_SPECS.reverbSize.max + 0.05;
    rows.push({
      trait: 'Reverb length',
      measured: `decay about ${traits.decaySec.toFixed(1)} s`,
      setting: `${size.toFixed(1)} s${outside ? ' (the lab goes from 3 to 6 s)' : ''}`,
    });
  } else {
    rows.push({ trait: 'Reverb length', measured: 'no free decay found', setting: 'kept' });
  }

  return { changes, rows };
}

/** Shown wherever a reference file is asked for. */
export const REFERENCE_PROMISE =
  'Only five general traits are read: tempo, key, note density, brightness and reverb length. No melody, no chords and no notes are read or kept, and the file does not leave this browser.';
