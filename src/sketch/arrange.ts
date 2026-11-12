/**
 * From a request to an arrangement: the seeded composer writes chords and a melody, and
 * every part of the chosen family (or mix) derives what it plays from that piece. All
 * pitches are chord tones or melody notes of the piece, so everything stays in its key.
 * Pure and deterministic.
 */
import { generate, scoreTime } from '../engine/compose';
import { BEATS_PER_BAR, MODE_LABELS, PARAM_SPECS } from '../engine/params';
import { createRng, type Rng } from '../engine/rng';
import { keyName } from '../engine/theory';
import { MODES, type ChordSpan, type Mode, type Piece } from '../engine/types';
import type { FamilyId } from '../style/types';
import { EXCLUSIVE_SLOTS, MIX_MIN_SHARE, MIX_TAKEOVER, RECIPES, type PartSpec } from './families';
import type { Group, Sketch, SketchEvent, SketchRequest, SketchTrack } from './types';
import { parseWords } from './words';

const MINOR_MODES: readonly Mode[] = ['aeolian', 'dorian'];
const UNPITCHED = new Set(['kick', 'snare', 'hat', 'tick', 'air']);

/** Parts used when the owner's words add a group the family does not have. */
const EXTRA_PARTS: Record<Group, readonly PartSpec[]> = {
  drums: [
    { id: 'x-thump', label: 'soft low drum', voice: 'kick', group: 'drums', slot: 'drums', role: 'thump', gain: 0.3, pan: 0, fromBar: 1 },
    { id: 'x-hat', label: 'quiet ticks', voice: 'hat', group: 'drums', slot: 'drums', role: 'hat', gain: 0.07, pan: 0.15, fromBar: 1 },
  ],
  guitar: [{ id: 'x-guitar', label: 'picked guitar', voice: 'pluck', group: 'guitar', slot: 'figure', role: 'arpeggio', gain: 0.45, pan: 0.2, centre: 55, loose: 0.014 }],
  bass: [{ id: 'x-bass', label: 'bass notes', voice: 'bass', group: 'bass', slot: 'bass', role: 'bassChord', gain: 0.38, pan: 0, centre: 40 }],
  keys: [{ id: 'x-keys', label: 'soft keys', voice: 'keys', group: 'keys', slot: 'melody', role: 'melody', gain: 0.45, pan: -0.1 }],
  pads: [{ id: 'x-pad', label: 'synth pad', voice: 'pad', group: 'pads', slot: 'chords', role: 'chords', gain: 0.35, pan: 0, centre: 60 }],
  voice: [{ id: 'x-voice', label: 'wordless voice', voice: 'voice', group: 'voice', slot: 'voice', role: 'voiceChords', gain: 0.22, pan: 0, centre: 64 }],
  texture: [{ id: 'x-air', label: 'noise bed', voice: 'air', group: 'texture', slot: 'texture', role: 'air', gain: 0.05, pan: 0 }],
};

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

interface Chosen {
  spec: PartSpec;
  /** Gain factor from the mix share. */
  share: number;
}

/** Which parts play for a mix of two families. */
export function chooseParts(a: FamilyId, b: FamilyId | null, mix: number, vocals: boolean): Chosen[] {
  const t = b && b !== a ? clamp(mix, 0, 1) : 0;
  const partsOf = (id: FamilyId): PartSpec[] => [...RECIPES[id].parts, ...(vocals ? RECIPES[id].voiceParts : [])];
  if (!b || t === 0) return partsOf(a).map((spec) => ({ spec, share: 1 }));
  if (t === 1) return partsOf(b).map((spec) => ({ spec, share: 1 }));
  const lead = t <= 0.5 ? a : b;
  const other = t <= 0.5 ? b : a;
  const otherShare = t <= 0.5 ? t : 1 - t;
  const leadParts = partsOf(lead);
  const out: Chosen[] = leadParts.map((spec) => ({ spec, share: EXCLUSIVE_SLOTS.includes(spec.slot) ? 1 : Math.sqrt(1 - otherShare) }));
  if (otherShare < MIX_MIN_SHARE) return out;
  for (const spec of partsOf(other)) {
    if (EXCLUSIVE_SLOTS.includes(spec.slot)) {
      // Only fills a slot the bigger family leaves empty, and only with a real share.
      if (otherShare >= MIX_TAKEOVER && !leadParts.some((p) => p.slot === spec.slot)) out.push({ spec: { ...spec, id: `${other}-${spec.id}` }, share: 1 });
    } else {
      out.push({ spec: { ...spec, id: `${other}-${spec.id}` }, share: Math.sqrt(otherShare) });
    }
  }
  return out;
}

/** Chord tones around a centre, ascending, at most `count`. */
function voicing(chord: ChordSpan, centre: number, count: number): number[] {
  const pitches: number[] = [];
  for (let p = centre - 9; p <= centre + 14 && pitches.length < count; p++) {
    if (chord.pitchClasses.includes(((p % 12) + 12) % 12)) pitches.push(p);
  }
  return pitches;
}

/** The chord root at or just above `floor`. */
function rootAbove(chord: ChordSpan, floor: number): number {
  let p = floor;
  while (((p % 12) + 12) % 12 !== chord.root) p++;
  return p;
}

function chordAt(piece: Piece, bar: number): ChordSpan {
  return piece.chords.find((c) => bar >= c.startBar && bar < c.startBar + c.bars) ?? piece.chords[piece.chords.length - 1];
}

/** Moves a pitch by octaves into [lo, hi]. */
function fold(pitch: number, lo: number, hi: number): number {
  let p = pitch;
  while (p < lo) p += 12;
  while (p > hi) p -= 12;
  return p;
}

/** Rhythmic roles and how strong a step of the owner's pattern has to be for them to play on it. */
const MATCH_THRESHOLD: Partial<Record<PartSpec['role'], number>> = {
  arpeggio: 0.3,
  strum: 0.6,
  bassPulse: 0.7,
  kick: 0.75,
  hat: 0.25,
  machine: 0.25,
  thump: 0.9,
};

function eventsFor(spec: PartSpec, piece: Piece, rng: Rng, grid: readonly number[] | null = null): SketchEvent[] {
  const events: SketchEvent[] = [];
  const threshold = MATCH_THRESHOLD[spec.role];
  if (grid && grid.length > 0 && threshold !== undefined) {
    // The owner's pattern decides when this part plays; the pitches still come from the piece.
    const loose = spec.loose ?? 0.008;
    const beatSec = 60 / piece.params.tempo;
    const stepBeats = BEATS_PER_BAR / grid.length;
    const top = Math.max(...grid);
    let walk = 0;
    for (let bar = spec.fromBar ?? 0; bar < piece.bars; bar++) {
      const chord = chordAt(piece, bar);
      grid.forEach((strength, step) => {
        if (strength < threshold * top) return;
        const time = Math.max(0, scoreTime(piece, bar * BEATS_PER_BAR + step * stepBeats) + rng.range(-loose, loose));
        const level = Math.min(1, 0.45 + 0.5 * (strength / top));
        if (spec.role === 'arpeggio') {
          const tones = voicing(chord, spec.centre ?? 55, 5);
          walk = clamp(walk + rng.pick([-2, -1, 1, 1, 2]), 0, Math.max(0, tones.length - 1));
          if (tones.length > 0) events.push({ time, duration: beatSec * 1.5, pitch: tones[walk], level });
        } else if (spec.role === 'strum') {
          voicing(chord, spec.centre ?? 50, 5).forEach((pitch, string) => events.push({ time: time + string * 0.022, duration: beatSec * 2, pitch, level }));
        } else if (spec.role === 'bassPulse') {
          events.push({ time, duration: beatSec * 1.4, pitch: rootAbove(chord, (spec.centre ?? 38) - 5), level });
        } else {
          events.push({ time, duration: 0.2, pitch: spec.role === 'machine' ? 76 : spec.role === 'hat' ? 42 : 36, level });
        }
      });
    }
    if (!spec.sections) return events;
    const keep = piece.sections.filter((sec) => spec.sections?.includes(sec.name));
    return events.filter((e) => keep.some((sec) => e.time >= sec.startTime - 0.05 && e.time < sec.endTime - 0.05));
  }
  const loose = spec.loose ?? 0.008;
  const at = (beat: number): number => Math.max(0, scoreTime(piece, beat) + rng.range(-loose, loose));
  const beatSec = 60 / piece.params.tempo;
  const fromBar = spec.fromBar ?? 0;
  const melody = piece.notes.filter((n) => n.role === 'melody' || n.role === 'echo');
  const bars = Array.from({ length: piece.bars }, (_, i) => i).filter((bar) => bar >= fromBar);

  switch (spec.role) {
    case 'melody':
      for (const n of melody) {
        events.push({ time: n.time, duration: Math.max(n.duration, 0.4), pitch: n.pitch, level: clamp(n.velocity / 80, 0.25, 1) });
      }
      break;
    case 'voiceLine': {
      const centre = spec.centre ?? 64;
      melody.forEach((n, i) => {
        const next = melody[i + 1];
        const hold = next ? Math.min(next.time - n.time, 4.5) : 3;
        events.push({ time: n.time, duration: Math.max(hold * 0.92, 0.6), pitch: fold(n.pitch, centre - 7, centre + 8), level: 0.7 });
      });
      break;
    }
    case 'chords':
      for (const c of piece.chords) {
        for (const pitch of voicing(c, spec.centre ?? 60, 4)) {
          events.push({ time: c.startTime, duration: c.endTime - c.startTime + 0.4, pitch, level: 0.6 });
        }
      }
      break;
    case 'voiceChords':
      for (const c of piece.chords) {
        for (const pitch of voicing(c, spec.centre ?? 64, 2)) {
          events.push({ time: c.startTime + 0.3, duration: c.endTime - c.startTime, pitch, level: 0.6 });
        }
      }
      break;
    case 'root':
      for (const c of piece.chords) {
        events.push({ time: c.startTime, duration: c.endTime - c.startTime + 0.3, pitch: rootAbove(c, (spec.centre ?? 40) - 5), level: 0.7 });
      }
      break;
    case 'tonic': {
      const tonic = fold(piece.scale[0] + 48, (spec.centre ?? 48) - 6, (spec.centre ?? 48) + 5);
      events.push({ time: 0, duration: piece.durationSec, pitch: tonic, level: 0.7 });
      // A perfect fifth above the tonic is in all four modes.
      events.push({ time: 0, duration: piece.durationSec, pitch: tonic + 7, level: 0.35 });
      break;
    }
    case 'bassChord':
      for (const c of piece.chords) {
        events.push({ time: c.startTime, duration: Math.min(c.endTime - c.startTime, beatSec * 4), pitch: rootAbove(c, (spec.centre ?? 40) - 5), level: 0.7 });
      }
      break;
    case 'bassPulse':
      for (const bar of bars) {
        const pitch = rootAbove(chordAt(piece, bar), (spec.centre ?? 38) - 5);
        events.push({ time: at(bar * BEATS_PER_BAR), duration: beatSec * 1.6, pitch, level: 0.75 });
        events.push({ time: at(bar * BEATS_PER_BAR + 2), duration: beatSec * 1.4, pitch, level: 0.55 });
      }
      break;
    case 'arpeggio': {
      // One picking figure for the whole piece: a seeded walk over the chord tones, with rests.
      const steps = 8;
      const figure: (number | null)[] = [0];
      for (let i = 1; i < steps; i++) {
        if (rng.chance(0.2)) {
          figure.push(null);
          continue;
        }
        const prev = [...figure].reverse().find((v): v is number => v !== null) ?? 0;
        figure.push(clamp(prev + rng.pick([-2, -1, 1, 1, 2]), 0, 4));
      }
      for (const bar of bars) {
        const tones = voicing(chordAt(piece, bar), spec.centre ?? 55, 5);
        figure.forEach((index, step) => {
          if (index === null || tones.length === 0) return;
          events.push({
            time: at(bar * BEATS_PER_BAR + step * 0.5),
            duration: beatSec * 1.5,
            pitch: tones[Math.min(index, tones.length - 1)],
            level: (step % 4 === 0 ? 0.75 : 0.55) * rng.range(0.85, 1.1),
          });
        });
      }
      break;
    }
    case 'strum':
      for (const bar of bars) {
        const tones = voicing(chordAt(piece, bar), spec.centre ?? 50, 5);
        for (const [beat, level] of [
          [0, 0.8],
          [2, 0.6],
        ] as const) {
          const start = at(bar * BEATS_PER_BAR + beat);
          tones.forEach((pitch, string) => {
            events.push({ time: start + string * 0.022, duration: beatSec * 2.1, pitch, level: level * rng.range(0.85, 1.05) });
          });
        }
      }
      break;
    case 'kick': {
      const extra = rng.pick([1.5, 2.5, 3.5]);
      for (const bar of bars) {
        events.push({ time: at(bar * BEATS_PER_BAR), duration: 0.3, pitch: 36, level: 0.9 });
        if (bar % 2 === 1) events.push({ time: at(bar * BEATS_PER_BAR + extra), duration: 0.3, pitch: 36, level: 0.6 });
      }
      break;
    }
    case 'snare':
      for (const bar of bars) events.push({ time: at(bar * BEATS_PER_BAR + 2), duration: 0.25, pitch: 38, level: rng.range(0.7, 0.9) });
      break;
    case 'hat':
      for (const bar of bars) {
        for (let step = 0; step < 8; step++) {
          events.push({ time: at(bar * BEATS_PER_BAR + step * 0.5), duration: 0.05, pitch: 42, level: (step % 2 === 0 ? 0.8 : 0.4) * rng.range(0.8, 1.1) });
        }
      }
      break;
    case 'machine': {
      const accents = Array.from({ length: 8 }, (_, i) => (i % 4 === 0 ? 0.9 : rng.chance(0.25) ? 0 : rng.range(0.35, 0.6)));
      for (const bar of bars) {
        accents.forEach((level, step) => {
          if (level > 0) events.push({ time: at(bar * BEATS_PER_BAR + step * 0.5), duration: 0.03, pitch: 76, level });
        });
      }
      break;
    }
    case 'thump':
      for (const bar of bars) {
        events.push({ time: at(bar * BEATS_PER_BAR), duration: 0.3, pitch: 36, level: 0.8 });
        if (bar % 2 === 1) events.push({ time: at(bar * BEATS_PER_BAR + 2), duration: 0.3, pitch: 36, level: 0.5 });
      }
      break;
    case 'clicks':
      for (const bar of bars) {
        if (rng.chance(0.4)) events.push({ time: at(bar * BEATS_PER_BAR + rng.int(0, 15) * 0.25), duration: 0.02, pitch: 80, level: rng.range(0.4, 1) });
      }
      break;
    case 'air':
      events.push({ time: 0, duration: piece.durationSec, pitch: 60, level: 1 });
      break;
  }

  if (!spec.sections) return events;
  const spans = piece.sections.filter((s) => spec.sections?.includes(s.name));
  return events.filter((e) => spans.some((s) => e.time >= s.startTime - 0.05 && e.time < s.endTime - 0.05));
}

/** The whole arrangement for a request. */
export function makeSketch(request: SketchRequest): Sketch {
  const { a, b } = request;
  const t = b && b !== a ? clamp(request.mix, 0, 1) : 0;
  const words = parseWords(request.words);
  const rng = createRng(request.seed >>> 0).fork('sketch');
  const ra = RECIPES[a];
  const rb = b ? RECIPES[b] : ra;
  const draw = rng.fork('params');
  const pick = (ka: readonly [number, number], kb: readonly [number, number]): number => {
    const u = draw.next();
    return lerp(lerp(ka[0], ka[1], u), lerp(kb[0], kb[1], u), t);
  };

  const match = request.match && request.match.grid.length > 0 ? request.match : null;
  const weights = MODES.map((mode) => {
    const base = lerp(ra.modes[mode] ?? 0, rb.modes[mode] ?? 0, t);
    const minor = MINOR_MODES.includes(mode);
    const bias = words.minorBias === 0 ? 1 : (words.minorBias > 0) === minor ? 1 + 2 * Math.abs(words.minorBias) : 1 / (1 + 2 * Math.abs(words.minorBias));
    // A bias can bring in a mode the family does not list, a little.
    return (base > 0 ? base : words.minorBias !== 0 && (words.minorBias > 0) === minor ? 0.1 : 0) * bias;
  });
  const mode = draw.weighted(MODES, weights);
  const key = draw.int(0, 11);
  const spec = PARAM_SPECS;
  const piece = generate({
    seed: request.seed >>> 0,
    variation: 0,
    key,
    mode,
    tempo: clamp(Math.round((match ? match.tempoBpm : pick(ra.tempo, rb.tempo)) + words.tempoDelta), spec.tempo.min, spec.tempo.max),
    density: clamp(pick(ra.density, rb.density) * words.densityFactor, spec.density.min, spec.density.max),
    register: clamp(Math.round(pick(ra.register, rb.register) + words.registerDelta), spec.register.min, spec.register.max),
    restProbability: clamp(pick(ra.rest, rb.rest) + words.restDelta, spec.restProbability.min, spec.restProbability.max),
    length: clamp(request.lengthSec, spec.length.min, spec.length.max),
    pad: 0,
    rain: 0,
    lofi: 0,
    reverbSize: spec.reverbSize.min,
  });

  let chosen = chooseParts(a, b, t, request.vocals).filter((c) => !words.removeGroups.includes(c.spec.group));
  for (const group of words.addGroups) {
    if (words.removeGroups.includes(group) || chosen.some((c) => c.spec.group === group)) continue;
    for (const extra of EXTRA_PARTS[group]) {
      if (EXCLUSIVE_SLOTS.includes(extra.slot) && extra.slot !== 'drums' && chosen.some((c) => c.spec.slot === extra.slot)) continue;
      chosen = [...chosen, { spec: extra, share: 1 }];
    }
  }

  const tracks: SketchTrack[] = chosen
    .map(({ spec: part, share }) => ({
      id: part.id,
      label: part.label,
      voice: part.voice,
      group: part.group,
      gain: part.gain * share * (words.groupGain[part.group] ?? 1),
      pan: part.pan,
      drive: part.drive ?? 0,
      pitched: !UNPITCHED.has(part.voice),
      events: eventsFor(part, piece, rng.fork(`part:${part.id}`), match ? match.grid : null).sort((x, y) => x.time - y.time || x.pitch - y.pitch),
    }))
    .filter((track) => track.events.length > 0);

  return {
    request,
    key,
    mode,
    keyLabel: `${keyName(key, mode)} ${MODE_LABELS[mode].toLowerCase()}`,
    tempo: piece.params.tempo,
    bars: piece.bars,
    musicSec: piece.durationSec,
    scale: [...piece.scale],
    tracks,
    words,
  };
}
