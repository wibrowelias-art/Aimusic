/**
 * Form (A / B / A') and the harmony plan.
 *
 * The chords are NOT taken from any list of progressions. Each scale degree gets one chord
 * colour drawn from the stacks the mode allows, and the order of the degrees comes from a
 * seeded weighted walk: no immediate repeats, tonic first and last, B stays off the tonic.
 */
import type { Rng } from './rng';
import { buildChord, CHARACTERISTIC_INTERVAL, chordOptions, type ChordInfo, type Scale } from './theory';
import type { SectionName } from './types';

/** A piece is never shorter than this many bars. */
export const MIN_BARS = 8;
/** Share of the bars that go to the A section. */
export const A_SHARE = 0.4;
/** The B section gets between these shares of the bars; A' gets the rest. */
export const B_SHARE_MIN = 0.25;
export const B_SHARE_MAX = 0.3;
/** Walk weight of a chord that contains the mode's characteristic tone, relative to one that does not. */
export const CHARACTERISTIC_BONUS = 2.4;

export interface SectionPlan {
  name: SectionName;
  startBar: number;
  bars: number;
}

export interface FormPlan {
  sections: SectionPlan[];
  /** Size of the register shift of the B section in semitones (5..12). */
  shiftSemis: number;
  /** Preferred direction of that shift; flipped when the register leaves no room. */
  shiftUp: boolean;
}

export interface ChordPlan extends ChordInfo {
  startBar: number;
  bars: number;
  section: SectionName;
}

export function planForm(bars: number, rng: Rng): FormPlan {
  const bShare = rng.range(B_SHARE_MIN, B_SHARE_MAX);
  const shiftSemis = rng.int(5, 12);
  const shiftUp = rng.chance(0.5);
  let nA = Math.max(2, Math.round(bars * A_SHARE));
  let nB = Math.max(2, Math.round(bars * bShare));
  while (bars - nA - nB < 2 && nA > 2) nA--;
  while (bars - nA - nB < 2 && nB > 2) nB--;
  const nA2 = Math.max(1, bars - nA - nB);
  return {
    sections: [
      { name: 'A', startBar: 0, bars: nA },
      { name: 'B', startBar: nA, bars: nB },
      { name: 'A2', startBar: nA + nB, bars: nA2 },
    ],
    shiftSemis,
    shiftUp,
  };
}

/** Split `total` bars into chord lengths of 2..4 bars (a lone bar only when total is 1). */
export function splitBars(total: number, rng: Rng): number[] {
  if (total <= 0) return [];
  if (total === 1) return [1];
  const out: number[] = [];
  let left = total;
  while (left > 0) {
    const options = [2, 3, 4].filter((len) => left - len === 0 || left - len >= 2);
    const len = rng.weighted(
      options,
      options.map((o) => (o === 2 ? 0.45 : o === 3 ? 0.2 : 0.35)),
    );
    out.push(len);
    left -= len;
  }
  return out;
}

/** One chord colour per scale degree (null where the mode has no stack with a perfect fifth). */
export function chooseChordColours(scale: Scale, rng: Rng): (ChordInfo | null)[] {
  const charPc = (scale.key + CHARACTERISTIC_INTERVAL[scale.mode]) % 12;
  const out: (ChordInfo | null)[] = [];
  for (let d = 0; d < scale.size; d++) {
    const options = chordOptions(scale, d);
    const root = scale.pcs[d];
    const weights = options.map((q) => q.weight * (q.intervals.some((iv) => (root + iv) % 12 === charPc) ? 1.6 : 1));
    const pick = rng.weightedIndex(weights.length > 0 ? weights : [1]);
    out.push(options.length > 0 ? buildChord(scale, d, options[pick]) : null);
  }
  return out;
}

/** Walk weight of each degree: 0 for unusable degrees, more for the mode's characteristic colour. */
export function degreeWeights(scale: Scale, colours: readonly (ChordInfo | null)[]): number[] {
  const charPc = (scale.key + CHARACTERISTIC_INTERVAL[scale.mode]) % 12;
  return colours.map((c, d) => {
    if (!c) return 0;
    return (c.pitchClasses.includes(charPc) ? CHARACTERISTIC_BONUS : 1) * (d === 0 ? 1.15 : 1);
  });
}

export function planHarmony(scale: Scale, sections: readonly SectionPlan[], rng: Rng): ChordPlan[] {
  const colours = chooseChordColours(scale, rng.fork('colour'));
  const weights = degreeWeights(scale, colours);
  const walk = rng.fork('walk');
  const lengths = rng.fork('lengths');

  /** Next degree: never `prev`, never a banned one, less likely to bounce straight back. */
  const pickDegree = (prev: number, prevPrev: number, banned: readonly number[], damped: readonly number[]): number => {
    const w = weights.map((base, d) => {
      if (d === prev || banned.includes(d)) return 0;
      return base * (d === prevPrev ? 0.6 : 1) * (damped.includes(d) ? 0.6 : 1);
    });
    if (w.some((x) => x > 0)) return walk.weightedIndex(w);
    return walk.weightedIndex(weights.map((base, d) => (d === prev ? 0 : base)));
  };

  const [secA, secB, secA2] = sections;
  const lenA = splitBars(secA.bars, lengths);
  const lenB = splitBars(secB.bars, lengths);
  const lenA2 = splitBars(secA2.bars, lengths);
  // A' needs three chords to come back the way A began (tonic, then on, then home):
  // with room for it, a two-chord split is cut once more.
  if (lenA2.length === 2 && secA2.bars >= 6) {
    const wide = lenA2[0] >= lenA2[1] ? 0 : 1;
    if (lenA2[wide] >= 4) {
      const half = Math.floor(lenA2[wide] / 2);
      lenA2.splice(wide, 1, half, lenA2[wide] - half);
    } else {
      // 3 + 3
      lenA2.splice(0, 2, 2, 2, 2);
    }
  }
  // The closing tonic chord gets the longest span of A'.
  let longest = lenA2.length - 1;
  for (let i = lenA2.length - 1; i >= 0; i--) {
    if (lenA2[i] > lenA2[longest]) longest = i;
  }
  const last = lenA2.length - 1;
  const tmp = lenA2[last];
  lenA2[last] = lenA2[longest];
  lenA2[longest] = tmp;

  // A: starts on the tonic, then walks.
  const degA: number[] = [0];
  for (let i = 1; i < lenA.length; i++) {
    degA.push(pickDegree(degA[i - 1], i >= 2 ? degA[i - 2] : -1, [], []));
  }

  // A': the A degrees again, closing on the tonic. With two chords there is no room for
  // "tonic, on, home", so it comes home from the chord that followed the tonic in A.
  const degA2: number[] = [];
  if (lenA2.length === 2 && degA.length >= 2) {
    degA2.push(degA[1]);
  } else {
    for (let i = 0; i < lenA2.length - 1; i++) degA2.push(degA[i % degA.length]);
  }
  degA2.push(0);
  for (let i = degA2.length - 2; i >= 0; i--) {
    const next = degA2[i + 1];
    const prev = i > 0 ? degA2[i - 1] : -1;
    if (degA2[i] === next || degA2[i] === prev) {
      // Prefer another chord of A before drawing a new one.
      const fromA = degA.find((d) => d !== next && d !== prev && d !== 0);
      degA2[i] = fromA ?? pickDegree(next, -1, prev >= 0 ? [prev] : [], []);
    }
  }

  // B: another chord region. Off the tonic, leaning away from the degrees A used.
  const degB: number[] = [];
  for (let i = 0; i < lenB.length; i++) {
    const prev = i === 0 ? degA[degA.length - 1] : degB[i - 1];
    const banned = [0];
    if (i === lenB.length - 1) banned.push(degA2[0]);
    degB.push(pickDegree(prev, i >= 2 ? degB[i - 2] : -1, banned, degA));
  }

  const out: ChordPlan[] = [];
  const emit = (section: SectionPlan, lens: readonly number[], degs: readonly number[]): void => {
    let bar = section.startBar;
    for (let i = 0; i < lens.length; i++) {
      // Degrees with weight 0 are never drawn, so the colour is always there; the tonic is the fallback.
      const info = colours[degs[i]] ?? (colours[0] as ChordInfo);
      out.push({ ...info, startBar: bar, bars: lens[i], section: section.name });
      bar += lens[i];
    }
  };
  emit(secA, lenA, degA);
  emit(secB, lenB, degB);
  emit(secA2, lenA2, degA2);
  return out;
}
