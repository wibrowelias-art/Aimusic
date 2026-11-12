/**
 * From score to performance: the rubato tempo map, humanised onsets, velocities, the
 * sustain pedal and the pad. Only plain arithmetic is used (no Math.sin / Math.pow), so
 * the result is bit-identical on every JS engine.
 */
import type { ChordPlan } from './harmony';
import { BEATS_PER_BAR, clamp } from './params';
import type { Rng } from './rng';
import { compareScoreNotes, type ScoreNote } from './score';
import { tonesBetween } from './theory';
import type { ChordSpan, Note, PadNote, PedalEvent } from './types';

/** Time of beat 0. Larger than the largest humanise offset, so no onset can go below 0. */
export const LEAD_IN_SEC = 0.08;
export const HUMANIZE_MIN_MS = 15;
export const HUMANIZE_MAX_MS = 40;
/** Share of humanizeMs the offsets really use (keeps rounding inside the bound). */
const HUMANIZE_USE = 0.9;
export const VELOCITY_MIN = 22;
export const VELOCITY_MAX = 78;
/** Two notes of the same pitch: the earlier one is released at least this long before the later one starts. */
export const SAME_PITCH_GAP_SEC = 0.012;
/** Shortest key-down time. */
const MIN_KEY_DOWN_SEC = 0.12;
/** The mean beat may be at most this much longer than the nominal beat. */
const MAX_MEAN_STRETCH = 1.04;
/** Beats of the closing ritardando. */
const FINAL_RIT_BEATS = 8;
/** Pad register (C3..C5) and the silence between two pad chords. */
export const PAD_LOW = 48;
export const PAD_HIGH = 72;
const PAD_GAP_SEC = 0.02;

/** Round to microseconds: stable numbers in JSON and MIDI. */
export function round6(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}

function floor6(x: number): number {
  return Math.floor(x * 1e6) / 1e6;
}

/** Smooth random curve in [-1, 1]: seeded control points every `period` beats, smoothstep between them. */
function smoothCurve(length: number, period: number, rng: Rng): number[] {
  const points: number[] = [];
  for (let i = 0; i < Math.ceil(length / period) + 2; i++) points.push(rng.range(-1, 1));
  const out: number[] = [];
  for (let b = 0; b < length; b++) {
    const x = (b + 0.5) / period;
    const i = Math.floor(x);
    const f = x - i;
    const s = f * f * (3 - 2 * f);
    out.push(points[i] + (points[i + 1] - points[i]) * s);
  }
  return out;
}

export interface PhraseEnd {
  /** Bar that ends a phrase. */
  bar: number;
  /** True when silence follows (stronger ritardando). */
  strong: boolean;
}

/**
 * Tempo map with rubato: the performed time of every beat (bars * 4 + 1 values).
 * Slow drift of a few percent, a small ritardando at phrase ends and a clear one at the end.
 */
export function buildTempoMap(bars: number, tempo: number, phraseEnds: readonly PhraseEnd[], rng: Rng): number[] {
  const beats = bars * BEATS_PER_BAR;
  const slow = smoothCurve(beats, rng.range(16, 32), rng.fork('slow'));
  const fast = smoothCurve(beats, rng.range(6, 10), rng.fork('fast'));
  const slowDepth = rng.range(0.02, 0.035);
  const fastDepth = rng.range(0.006, 0.014);
  const finalDepth = rng.range(0.24, 0.36);
  const ritRng = rng.fork('rit');

  const factor: number[] = [];
  let mean = 0;
  for (let b = 0; b < beats; b++) {
    factor.push(1 + slowDepth * slow[b] + fastDepth * fast[b]);
    mean += factor[b] / beats;
  }
  for (let b = 0; b < beats; b++) factor[b] /= mean;

  for (const end of phraseEnds) {
    const depth = end.strong ? ritRng.range(0.04, 0.09) : ritRng.range(0.015, 0.035);
    for (let k = 0; k < 3; k++) {
      const b = end.bar * BEATS_PER_BAR + 1 + k;
      const ramp = (k + 1) / 3;
      if (b < beats) factor[b] += depth * ramp * ramp;
    }
  }
  const ritBeats = Math.min(FINAL_RIT_BEATS, beats);
  for (let k = 0; k < ritBeats; k++) {
    const ramp = (k + 1) / ritBeats;
    factor[beats - ritBeats + k] += finalDepth * ramp * ramp;
  }

  mean = 0;
  for (const f of factor) mean += f / beats;
  const scale = mean > MAX_MEAN_STRETCH ? MAX_MEAN_STRETCH / mean : 1;

  const beatSec = 60 / tempo;
  const times = [LEAD_IN_SEC];
  let t = LEAD_IN_SEC;
  for (let b = 0; b < beats; b++) {
    t += beatSec * factor[b] * scale;
    times.push(round6(t));
  }
  return times;
}

/** Score position in beats -> performed seconds (linear between beats, clamped to the piece). */
export function beatToTime(beatTimes: readonly number[], beat: number): number {
  const last = beatTimes.length - 1;
  if (beat <= 0) return beatTimes[0];
  if (beat >= last) return beatTimes[last];
  const i = Math.floor(beat);
  return beatTimes[i] + (beatTimes[i + 1] - beatTimes[i]) * (beat - i);
}

export interface PerformOptions {
  beatTimes: readonly number[];
  totalBeats: number;
  humanizeMs: number;
  /** Velocity offset of the B section. */
  contrast: number;
}

function velocityOf(n: ScoreNote, opts: PerformOptions, rng: Rng): number {
  const base = n.role === 'melody' ? 56 : n.role === 'bass' ? 44 : n.role === 'harmony' ? 40 : 32;
  // Phrase arc: softer at both ends of a chunk, fuller in the middle.
  let v = base + 9 * (4 * n.pos * (1 - n.pos)) - 3;
  if (n.section === 'B') v += opts.contrast;
  if (n.section === 'A2') v -= 4;
  if (n.passing) v -= 6;
  // The last fifth of the piece fades.
  const progress = n.startBeat / opts.totalBeats;
  if (progress > 0.8) v -= 8 * ((progress - 0.8) / 0.2);
  v += rng.range(-3, 3);
  return clamp(Math.round(v), VELOCITY_MIN, VELOCITY_MAX);
}

/**
 * Humanised, sorted piano notes. Notes written on the same beat are rolled low to high;
 * every onset stays within humanizeMs of its place in the tempo map; two notes of the same
 * pitch never overlap.
 */
export function performNotes(score: readonly ScoreNote[], opts: PerformOptions, rng: Rng): Note[] {
  const ordered = score.slice().sort(compareScoreNotes);
  const bound = opts.humanizeMs / 1000;
  const endSec = opts.beatTimes[opts.beatTimes.length - 1];
  const timingRng = rng.fork('timing');
  const velocityRng = rng.fork('velocity');

  const notes: Note[] = [];
  let i = 0;
  while (i < ordered.length) {
    let j = i;
    while (j < ordered.length && ordered[j].startBeat === ordered[i].startBeat) j++;
    const size = j - i;
    const scoreTime = beatToTime(opts.beatTimes, ordered[i].startBeat);
    // Triangular spread: mostly small offsets, sometimes close to the bound.
    const centre = (timingRng.next() + timingRng.next() - 1) * bound * (size > 1 ? 0.45 : HUMANIZE_USE);
    const rollDraw = timingRng.range(0.008, 0.02);
    const roll = size > 1 ? Math.min(rollDraw, (0.8 * bound) / (size - 1)) : 0;
    for (let k = 0; k < size; k++) {
      const n = ordered[i + k];
      const offset = clamp(centre + (k - (size - 1) / 2) * roll, -HUMANIZE_USE * bound, HUMANIZE_USE * bound);
      const time = round6(Math.max(0, scoreTime + offset));
      const release = Math.min(endSec, beatToTime(opts.beatTimes, n.startBeat + n.durBeats));
      notes.push({
        id: 0,
        pitch: n.pitch,
        velocity: velocityOf(n, opts, velocityRng),
        startBeat: n.startBeat,
        durBeats: n.durBeats,
        time,
        duration: round6(Math.max(MIN_KEY_DOWN_SEC, release - time)),
        role: n.role,
        section: n.section,
        passing: n.passing,
      });
    }
    i = j;
  }

  notes.sort((a, b) => a.time - b.time || a.pitch - b.pitch || a.startBeat - b.startBeat);
  const lastOfPitch = new Map<number, Note>();
  for (const n of notes) {
    const prev = lastOfPitch.get(n.pitch);
    if (prev && prev.time + prev.duration > n.time - SAME_PITCH_GAP_SEC) {
      prev.duration = floor6(n.time - SAME_PITCH_GAP_SEC - prev.time);
    }
    lastOfPitch.set(n.pitch, n);
  }
  notes.forEach((n, id) => {
    if (n.time + n.duration > endSec) n.duration = round6(endSec - n.time);
    n.id = id;
  });
  return notes;
}

/** Pedal: down shortly after each chord starts, up shortly before the next one, last up at the end. */
export function buildPedal(chords: readonly ChordSpan[], durationSec: number, rng: Rng): PedalEvent[] {
  const out: PedalEvent[] = [];
  chords.forEach((chord, i) => {
    const down = rng.range(0.05, 0.11);
    const up = rng.range(0.06, 0.1);
    out.push({ time: round6(chord.startTime + down), down: true });
    out.push({ time: i === chords.length - 1 ? durationSec : round6(chord.endTime - up), down: false });
  });
  return out;
}

/**
 * Pad voicing: 2-3 chord tones per chord between C3 and C5, the lowest one a root or fifth,
 * each chord as close as possible to the one before. Depends on the seed only.
 */
export function voicePad(chords: readonly ChordPlan[], rng: Rng): number[][] {
  const out: number[][] = [];
  let prev: number[] | null = null;
  for (const chord of chords) {
    const size = rng.weighted([2, 3], [0.4, 0.6]);
    const pick: { best: number[]; cost: number } = { best: [], cost: Infinity };
    const consider = (voicing: number[]): void => {
      let cost = 0;
      if (prev === null) {
        let centre = 0;
        for (const p of voicing) centre += p / voicing.length;
        cost = Math.abs(centre - 60);
      } else {
        for (const p of voicing) {
          let nearest = Infinity;
          for (const q of prev) nearest = Math.min(nearest, Math.abs(p - q));
          cost += nearest;
        }
      }
      const pcs = voicing.map((p) => p % 12);
      if (!pcs.includes(chord.triad[0])) cost += 1;
      if (!pcs.includes(chord.triad[1])) cost += 1.5;
      if (new Set(pcs).size < voicing.length) cost += 2;
      if (cost < pick.cost) {
        pick.best = voicing;
        pick.cost = cost;
      }
    };
    for (const low of tonesBetween([chord.triad[0], chord.triad[2]], PAD_LOW, PAD_LOW + 11)) {
      for (const mid of tonesBetween(chord.pitchClasses, low + 3, PAD_HIGH - 5)) {
        if (size === 2) consider([low, mid]);
        else for (const high of tonesBetween(chord.pitchClasses, mid + 3, PAD_HIGH)) consider([low, mid, high]);
      }
    }
    out.push(pick.best);
    prev = pick.best;
  }
  return out;
}

/** Sustained pad notes that follow the chords, with a short gap before every chord change. */
export function buildPad(
  chords: readonly ChordSpan[],
  voicings: readonly number[][],
  durationSec: number,
  rng: Rng,
): PadNote[] {
  const out: PadNote[] = [];
  chords.forEach((chord, i) => {
    const level = rng.int(34, 44);
    const end = i === chords.length - 1 ? durationSec : chord.endTime - PAD_GAP_SEC;
    voicings[i].forEach((pitch, k) => {
      out.push({
        pitch,
        velocity: level - 2 * k,
        time: chord.startTime,
        duration: round6(end - chord.startTime),
      });
    });
  });
  return out;
}
