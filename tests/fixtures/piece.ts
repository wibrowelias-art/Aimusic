/**
 * Hand-built Piece for the audio tests (the composer is not imported here).
 * Every note is made programmatically from scale tones with a tiny LCG: an
 * original pattern, not taken from any existing music.
 */
import { BEATS_PER_BAR, MODE_INTERVALS, normalizeParams, PITCH_MAX, PITCH_MIN } from '../../src/engine/params';
import type {
  ChordSpan,
  Note,
  NoteRole,
  PadNote,
  Params,
  PedalEvent,
  Piece,
  SectionName,
  SectionSpan,
} from '../../src/engine/types';

export interface FixtureOptions extends Partial<Params> {
  /** Number of bars, at least 1 (default 6 = 24 s at the default 60 BPM). Chords last 2 bars. */
  bars?: number;
  /** Add pedal events (default true). */
  pedal?: boolean;
  /** Bars per chord (default 2). Pad notes last as long as their chord. */
  chordBars?: number;
}

function lcg(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x / 4294967296;
  };
}

/** Nearest pitch with pitch class `pc` to `target`, inside the sampled range. */
function nearestPitch(pc: number, target: number): number {
  let best = -1;
  for (let p = PITCH_MIN; p <= PITCH_MAX; p++) {
    if (((p % 12) + 12) % 12 !== pc) continue;
    if (best < 0 || Math.abs(p - target) < Math.abs(best - target)) best = p;
  }
  return best;
}

export function makeFixturePiece(opts: FixtureOptions = {}): Piece {
  const { bars: barsOpt, pedal: pedalOpt, chordBars: chordBarsOpt, ...paramOverrides } = opts;
  const params = normalizeParams({
    seed: 7,
    key: 2,
    mode: 'dorian',
    tempo: 60,
    density: 2.5,
    register: 64,
    restProbability: 0.2,
    reverbSize: 3.5,
    lofi: 0.4,
    length: 30,
    pad: 0.5,
    rain: 0.3,
    ...paramOverrides,
  });
  const bars = Math.max(1, Math.floor(barsOpt ?? 6));
  const withPedal = pedalOpt ?? true;
  const chordBars = Math.max(1, Math.floor(chordBarsOpt ?? 2));
  const rand = lcg(params.seed * 2654435761 + 12345);
  const beatSec = 60 / params.tempo;
  const scale = MODE_INTERVALS[params.mode].map((iv) => (params.key + iv) % 12);
  const beats = bars * BEATS_PER_BAR;
  const beatTimes = Array.from({ length: beats + 1 }, (_, i) => i * beatSec);
  const barTimes = Array.from({ length: bars + 1 }, (_, i) => beatTimes[i * BEATS_PER_BAR]);

  // Sections A / B / A2 in thirds (fewer sections when there are fewer than 3 bars).
  const cuts = [0, Math.round(bars / 3), Math.round((2 * bars) / 3), bars];
  const names: SectionName[] = ['A', 'B', 'A2'];
  const sections: SectionSpan[] = [];
  for (let i = 0; i < 3; i++) {
    if (cuts[i + 1] <= cuts[i]) continue;
    sections.push({
      name: names[sections.length],
      startBar: cuts[i],
      bars: cuts[i + 1] - cuts[i],
      startTime: barTimes[cuts[i]],
      endTime: barTimes[cuts[i + 1]],
    });
  }
  const sectionAt = (bar: number): SectionName => {
    let name: SectionName = 'A';
    for (const s of sections) if (bar >= s.startBar) name = s.name;
    return name;
  };

  // One chord per `chordBars` bars: a stack of every other scale tone on a drawn degree.
  const chords: ChordSpan[] = [];
  for (let bar = 0; bar < bars; bar += chordBars) {
    const degree = Math.floor(rand() * scale.length);
    const pitchClasses = [0, 2, 4].map((k) => scale[(degree + k) % scale.length]);
    const n = Math.min(chordBars, bars - bar);
    chords.push({
      startBar: bar,
      bars: n,
      degree,
      root: scale[degree],
      pitchClasses,
      name: `deg${degree + 1}`,
      section: sectionAt(bar),
      startTime: barTimes[bar],
      endTime: barTimes[bar + n],
    });
  }

  // Notes: a bass note per chord, two or three chord tones per bar, sometimes a passing tone.
  const raw: Omit<Note, 'id'>[] = [];
  const humanizeMs = 20;
  const push = (pitch: number, startBeat: number, durBeats: number, velocity: number, role: NoteRole, bar: number, passing: boolean): void => {
    const jitter = (rand() * 2 - 1) * (humanizeMs / 1000);
    raw.push({
      pitch,
      velocity: Math.round(velocity),
      startBeat,
      durBeats,
      time: Math.max(0, startBeat * beatSec + jitter),
      duration: durBeats * beatSec * 0.9,
      role,
      section: sectionAt(bar),
      passing,
    });
  };
  for (const chord of chords) {
    push(nearestPitch(chord.root, 43), chord.startBar * BEATS_PER_BAR, 3, 44 + rand() * 12, 'bass', chord.startBar, false);
    for (let bar = chord.startBar; bar < chord.startBar + chord.bars; bar++) {
      const count = 2 + Math.floor(rand() * 2);
      const slots = [0.5, 1.5, 2.5, 3.5];
      for (let i = slots.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [slots[i], slots[j]] = [slots[j], slots[i]];
      }
      for (const slot of slots.slice(0, count)) {
        const passing = rand() < 0.15;
        const pc = passing
          ? scale[Math.floor(rand() * scale.length)]
          : chord.pitchClasses[Math.floor(rand() * chord.pitchClasses.length)];
        const target = params.register + Math.round((rand() * 2 - 1) * 7);
        push(nearestPitch(pc, target), bar * BEATS_PER_BAR + slot, 1 + Math.floor(rand() * 2), 30 + rand() * 40, 'melody', bar, passing && !chord.pitchClasses.includes(pc));
      }
    }
  }
  raw.sort((a, b) => a.time - b.time || a.pitch - b.pitch);
  // No overlapping notes of the same pitch: shorten the earlier one.
  const lastByPitch = new Map<number, Omit<Note, 'id'>>();
  for (const note of raw) {
    const prev = lastByPitch.get(note.pitch);
    if (prev && prev.time + prev.duration > note.time - 0.01) {
      prev.duration = Math.max(0.05, note.time - 0.01 - prev.time);
    }
    lastByPitch.set(note.pitch, note);
  }
  const notes: Note[] = raw.map((n, id) => ({ id, ...n }));

  // Pedal: down at each chord start, up shortly before the next chord. The last
  // pedal up is the end of the piece: the final notes ring under the pedal until then.
  const pedal: PedalEvent[] = [];
  if (withPedal) {
    const lastKeyUp = notes.reduce((m, n) => Math.max(m, n.time + n.duration), 0);
    chords.forEach((chord, i) => {
      const last = i === chords.length - 1;
      pedal.push({ time: chord.startTime, down: true });
      pedal.push({ time: last ? Math.max(chord.endTime, lastKeyUp) : chord.endTime - 0.15, down: false });
    });
  }

  // Pad: two chord tones per chord in the middle register.
  const pad: PadNote[] = [];
  for (const chord of chords) {
    for (const pc of chord.pitchClasses.slice(0, 2)) {
      pad.push({
        pitch: nearestPitch(pc, 55),
        velocity: 50,
        time: chord.startTime,
        duration: chord.endTime - chord.startTime - 0.1,
      });
    }
  }
  pad.sort((a, b) => a.time - b.time || a.pitch - b.pitch);

  let durationSec = 0;
  for (const n of notes) durationSec = Math.max(durationSec, n.time + n.duration);
  for (const p of pedal) durationSec = Math.max(durationSec, p.time);
  for (const p of pad) durationSec = Math.max(durationSec, p.time + p.duration);

  return {
    params,
    scale,
    beatsPerBar: 4,
    bars,
    motif: { steps: [0, 1, 2], durations: [1, 1, 2] },
    sections,
    chords,
    notes,
    pad,
    pedal,
    beatTimes,
    barTimes,
    humanizeMs,
    durationSec,
  };
}
