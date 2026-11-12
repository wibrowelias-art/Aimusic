/**
 * Test-side helpers for the engine checks. Nothing here is imported by the app.
 * The MIDI parser and the chord-label table are written independently of src/engine on
 * purpose: they check the engine's output, they do not reuse its code.
 */
import {
  BEATS_PER_BAR,
  createRng,
  generate,
  KEY_NAMES,
  MODES,
  PARAM_SPECS,
  pitchName,
  validatePiece,
  type ChordSpan,
  type Mode,
  type Note,
  type NumericParamKey,
  type Params,
  type Piece,
  type Rng,
} from '../../src/engine';

/** One value of a numeric parameter: 15 % minimum, 15 % maximum, otherwise uniform. */
function drawParam(key: NumericParamKey, rng: Rng): number {
  const spec = PARAM_SPECS[key];
  const u = rng.next();
  if (u < 0.15) return spec.min;
  if (u < 0.3) return spec.max;
  return rng.range(spec.min, spec.max);
}

export function randomParams(rng: Rng): Partial<Params> {
  return {
    seed: rng.int(0, 4294967295),
    variation: rng.chance(0.5) ? 0 : rng.int(1, 9),
    key: rng.int(0, 11),
    mode: rng.pick(MODES),
    tempo: drawParam('tempo', rng),
    density: drawParam('density', rng),
    register: drawParam('register', rng),
    restProbability: drawParam('restProbability', rng),
    reverbSize: drawParam('reverbSize', rng),
    lofi: drawParam('lofi', rng),
    length: drawParam('length', rng),
    pad: drawParam('pad', rng),
    rain: drawParam('rain', rng),
  };
}

/** Every combination of the extremes of density, rest, tempo, length and register (32), cycling modes and keys. */
export function extremeParams(): Partial<Params>[] {
  const out: Partial<Params>[] = [];
  const pick = (key: NumericParamKey, high: boolean): number => (high ? PARAM_SPECS[key].max : PARAM_SPECS[key].min);
  for (let mask = 0; mask < 32; mask++) {
    for (let m = 0; m < MODES.length; m++) {
      out.push({
        seed: 1000 + mask * 7 + m,
        key: (mask + 5 * m) % 12,
        mode: MODES[m],
        density: pick('density', (mask & 1) !== 0),
        restProbability: pick('restProbability', (mask & 2) !== 0),
        tempo: pick('tempo', (mask & 4) !== 0),
        length: pick('length', (mask & 8) !== 0),
        register: pick('register', (mask & 16) !== 0),
      });
    }
  }
  return out;
}

/** A fixed, seeded batch of pieces for property tests. */
export function sampleBatch(count: number, seed: number): Piece[] {
  const rng = createRng(seed);
  const out: Piece[] = [];
  for (let i = 0; i < count; i++) out.push(generate(randomParams(rng)));
  return out;
}

export function barOf(note: Note): number {
  return Math.floor(note.startBeat / BEATS_PER_BAR);
}

export function chordAtBar(piece: Piece, bar: number): ChordSpan {
  const chord = piece.chords.find((c) => bar >= c.startBar && bar < c.startBar + c.bars);
  if (!chord) throw new Error(`no chord at bar ${bar}`);
  return chord;
}

/** Melody notes in score order (startBeat, then pitch). */
export function melodyInScoreOrder(piece: Piece): Note[] {
  return piece.notes.filter((n) => n.role === 'melody').sort((a, b) => a.startBeat - b.startBeat || a.pitch - b.pitch);
}

/** Pitch and score position of every note: what "the notes" means when timing is ignored. */
export function scoreSignature(piece: Piece): string {
  return piece.notes
    .slice()
    .sort((a, b) => a.startBeat - b.startBeat || a.pitch - b.pitch)
    .map((n) => `${n.startBeat}:${n.pitch}:${n.durBeats}:${n.role}`)
    .join(' ');
}

// ---------------------------------------------------------------------------
// Chord labels
// ---------------------------------------------------------------------------

/** Label suffix -> semitones above the root. Independent of the engine's table. */
export const SUFFIX_INTERVALS: Record<string, number[]> = {
  '': [0, 4, 7],
  m: [0, 3, 7],
  sus2: [0, 2, 7],
  sus4: [0, 5, 7],
  add9: [0, 2, 4, 7],
  'm(add9)': [0, 2, 3, 7],
  '6': [0, 4, 7, 9],
  m6: [0, 3, 7, 9],
  maj7: [0, 4, 7, 11],
  m7: [0, 3, 7, 10],
  maj9: [0, 2, 4, 7, 11],
  m9: [0, 2, 3, 7, 10],
  '6/9': [0, 2, 4, 7, 9],
  '7sus4': [0, 5, 7, 10],
};

/** "Ebmaj7" -> { root: 3, pitchClasses: [3, 7, 10, 2] }. Throws on an unknown label. */
export function parseChordName(name: string): { root: number; suffix: string; pitchClasses: number[] } {
  // Letter plus accidentals, read independently of the engine's own spelling code.
  const m = /^([A-G])(#{1,2}|b{1,2})?/.exec(name);
  if (!m) throw new Error(`unknown root in chord label "${name}"`);
  const rootName = m[0];
  const natural = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[m[1] as 'C'];
  const acc = m[2] === undefined ? 0 : m[2][0] === '#' ? m[2].length : -m[2].length;
  const root = (((natural + acc) % 12) + 12) % 12;
  const suffix = name.slice(rootName.length);
  const intervals = SUFFIX_INTERVALS[suffix];
  if (!intervals) throw new Error(`unknown suffix in chord label "${name}"`);
  return { root, suffix, pitchClasses: intervals.map((iv) => (root + iv) % 12) };
}

// ---------------------------------------------------------------------------
// MIDI parser (Standard MIDI File, no running status, no sysex)
// ---------------------------------------------------------------------------

export interface MidiEvent {
  tick: number;
  kind: 'noteOn' | 'noteOff' | 'controller' | 'program' | 'meta';
  channel: number;
  /** Note number, controller number, program number or meta type. */
  a: number;
  /** Velocity or controller value. */
  b: number;
  /** Meta payload. */
  data: number[];
}

export interface ParsedMidi {
  format: number;
  trackCount: number;
  ppq: number;
  tracks: MidiEvent[][];
  /** Tick of the End of Track event of every track. */
  endTicks: number[];
}

export function parseMidi(bytes: Uint8Array): ParsedMidi {
  let pos = 0;
  const need = (n: number): void => {
    if (pos + n > bytes.length) throw new Error(`unexpected end of file at byte ${pos}`);
  };
  const tag = (): string => {
    need(4);
    const s = String.fromCharCode(bytes[pos], bytes[pos + 1], bytes[pos + 2], bytes[pos + 3]);
    pos += 4;
    return s;
  };
  const uint = (n: number): number => {
    need(n);
    let v = 0;
    for (let i = 0; i < n; i++) v = v * 256 + bytes[pos++];
    return v;
  };
  const vlq = (): number => {
    let v = 0;
    for (let i = 0; i < 4; i++) {
      need(1);
      const b = bytes[pos++];
      v = v * 128 + (b & 0x7f);
      if ((b & 0x80) === 0) return v;
    }
    throw new Error(`variable-length quantity longer than 4 bytes at byte ${pos}`);
  };

  if (tag() !== 'MThd') throw new Error('missing MThd');
  if (uint(4) !== 6) throw new Error('bad header length');
  const format = uint(2);
  const trackCount = uint(2);
  const ppq = uint(2);
  const tracks: MidiEvent[][] = [];
  const endTicks: number[] = [];

  for (let t = 0; t < trackCount; t++) {
    if (tag() !== 'MTrk') throw new Error(`track ${t}: missing MTrk`);
    const length = uint(4);
    const end = pos + length;
    if (end > bytes.length) throw new Error(`track ${t}: chunk runs past the end of the file`);
    const events: MidiEvent[] = [];
    let tick = 0;
    let ended = false;
    while (pos < end) {
      if (ended) throw new Error(`track ${t}: data after End of Track`);
      tick += vlq();
      const status = uint(1);
      if (status < 0x80) throw new Error(`track ${t}: running status at byte ${pos - 1}`);
      if (status === 0xff) {
        const type = uint(1);
        const len = vlq();
        need(len);
        const data = Array.from(bytes.slice(pos, pos + len));
        pos += len;
        if (type === 0x2f) {
          ended = true;
          endTicks.push(tick);
        } else {
          events.push({ tick, kind: 'meta', channel: -1, a: type, b: 0, data });
        }
        continue;
      }
      const high = status & 0xf0;
      const channel = status & 0x0f;
      if (high === 0x90 || high === 0x80) {
        const note = uint(1);
        const velocity = uint(1);
        if (note > 127 || velocity > 127) throw new Error(`track ${t}: data byte above 127`);
        const on = high === 0x90 && velocity > 0;
        events.push({ tick, kind: on ? 'noteOn' : 'noteOff', channel, a: note, b: velocity, data: [] });
      } else if (high === 0xb0) {
        const controller = uint(1);
        const value = uint(1);
        events.push({ tick, kind: 'controller', channel, a: controller, b: value, data: [] });
      } else if (high === 0xc0) {
        events.push({ tick, kind: 'program', channel, a: uint(1), b: 0, data: [] });
      } else {
        throw new Error(`track ${t}: unexpected status byte ${status}`);
      }
    }
    if (pos !== end) throw new Error(`track ${t}: chunk length does not match its content`);
    if (!ended) throw new Error(`track ${t}: no End of Track`);
    tracks.push(events);
  }
  if (pos !== bytes.length) throw new Error('trailing bytes after the last track');
  return { format, trackCount, ppq, tracks, endTicks };
}

/** FNV-1a 32-bit hash as 8 hex digits. */
export function fingerprint(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (const b of bytes) {
    h ^= b;
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// ---------------------------------------------------------------------------
// Text summary of a piece (numbers only)
// ---------------------------------------------------------------------------

export function describePiece(piece: Piece): string {
  const p = piece.params;
  const report = validatePiece(piece);
  const pitches = piece.notes.map((n) => n.pitch);
  const velocities = piece.notes.map((n) => n.velocity);
  const roles: Record<string, number> = {};
  for (const n of piece.notes) roles[n.role] = (roles[n.role] ?? 0) + 1;
  const passing = piece.notes.filter((n) => n.passing).length;
  const beats = piece.bars * BEATS_PER_BAR;
  const meanTempo = (beats * 60) / (piece.beatTimes[beats] - piece.beatTimes[0]);
  const lo = Math.min(...pitches);
  const hi = Math.max(...pitches);
  return [
    `seed ${p.seed}, variation ${p.variation}, ${KEY_NAMES[p.key]} ${p.mode}, tempo ${p.tempo}, density ${p.density}, rest ${p.restProbability}, register ${p.register}, length ${p.length}`,
    `  bars: ${piece.bars}`,
    `  sections: ${piece.sections.map((s) => `${s.name} bars ${s.startBar}-${s.startBar + s.bars - 1} (${s.bars})`).join(', ')}`,
    `  chords: ${piece.chords.map((c) => `${c.name} x${c.bars}`).join(' | ')}`,
    `  motif: steps [${piece.motif.steps.join(', ')}], beats [${piece.motif.durations.join(', ')}]`,
    `  notes: ${piece.notes.length} (${Object.keys(roles)
      .sort()
      .map((r) => `${r} ${roles[r]}`)
      .join(', ')}), pad notes ${piece.pad.length}, pedal events ${piece.pedal.length}`,
    `  measured density: ${report.measuredDensity.toFixed(3)} notes/bar (target ${p.density})`,
    `  rest ratio: ${report.measuredRestRatio.toFixed(3)} (target ${p.restProbability})`,
    `  pitch range: ${pitchName(lo)}..${pitchName(hi)} (MIDI ${lo}..${hi})`,
    `  velocity range: ${Math.min(...velocities)}..${Math.max(...velocities)}`,
    `  passing ratio: ${(passing / piece.notes.length).toFixed(3)} (${passing} notes)`,
    `  durationSec: ${piece.durationSec.toFixed(3)}, mean tempo ${meanTempo.toFixed(2)} BPM, humanizeMs ${piece.humanizeMs}`,
    `  validatePiece: ${report.ok ? 'ok' : report.errors.join('; ')}`,
  ].join('\n');
}

export const ALL_MODES: readonly Mode[] = MODES;

/**
 * Collects the first few failed checks of a hot loop. One `expect(problems.list).toEqual([])`
 * at the end is much faster than an `expect` per note and still says what went wrong.
 */
export class Problems {
  readonly list: string[] = [];

  check(ok: boolean, describe: () => string): void {
    if (!ok && this.list.length < 5) this.list.push(describe());
  }
}
