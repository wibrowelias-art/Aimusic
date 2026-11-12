/**
 * Standard MIDI File export (format 1, 480 PPQ). Deterministic: the same piece always gives
 * the same bytes.
 *
 *   track 0: track name (with the seed), tempo (params.tempo), time signature 4/4
 *   track 1: piano, channel 0, program 0: the PERFORMED notes (rubato and humanisation are
 *            baked into the tick positions at the nominal tempo) and the pedal as CC64
 *   track 2: pad, channel 1, program 89
 */
import type { Piece } from './types';

export const MIDI_PPQ = 480;
export const MIDI_PIANO_CHANNEL = 0;
export const MIDI_PIANO_PROGRAM = 0;
export const MIDI_PAD_CHANNEL = 1;
export const MIDI_PAD_PROGRAM = 89;
const CC_SUSTAIN = 64;

/** Performed seconds -> ticks at the nominal tempo. */
export function secondsToTicks(seconds: number, tempo: number): number {
  return Math.round((seconds * tempo * MIDI_PPQ) / 60);
}

/** MIDI variable-length quantity, most significant group first. */
export function encodeVlq(value: number): number[] {
  let v = Math.max(0, Math.floor(value));
  const out = [v % 128];
  v = Math.floor(v / 128);
  while (v > 0) {
    out.unshift((v % 128) + 128);
    v = Math.floor(v / 128);
  }
  return out;
}

interface MidiEvent {
  tick: number;
  /** Order inside one tick: note-offs, then controllers and meta, then note-ons. */
  order: number;
  data: number[];
}

function ascii(text: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) out.push(text.charCodeAt(i) % 128);
  return out;
}

function u32(value: number): number[] {
  return [Math.floor(value / 16777216) % 256, Math.floor(value / 65536) % 256, Math.floor(value / 256) % 256, value % 256];
}

function u16(value: number): number[] {
  return [Math.floor(value / 256) % 256, value % 256];
}

function meta(type: number, payload: readonly number[]): number[] {
  return [0xff, type, ...encodeVlq(payload.length), ...payload];
}

function trackChunk(events: readonly MidiEvent[], endTick: number): number[] {
  const sorted = events
    .map((e, i) => ({ e, i }))
    .sort((a, b) => a.e.tick - b.e.tick || a.e.order - b.e.order || a.i - b.i)
    .map((x) => x.e);
  const body: number[] = [];
  let tick = 0;
  for (const e of sorted) {
    for (const b of encodeVlq(e.tick - tick)) body.push(b);
    for (const b of e.data) body.push(b);
    tick = e.tick;
  }
  for (const b of encodeVlq(Math.max(0, endTick - tick))) body.push(b);
  for (const b of meta(0x2f, [])) body.push(b);
  return [...ascii('MTrk'), ...u32(body.length), ...body];
}

interface Sounding {
  pitch: number;
  velocity: number;
  time: number;
  duration: number;
}

function noteEvents(notes: readonly Sounding[], channel: number, tempo: number): MidiEvent[] {
  const out: MidiEvent[] = [];
  for (const n of notes) {
    const on = secondsToTicks(n.time, tempo);
    const off = Math.max(on + 1, secondsToTicks(n.time + n.duration, tempo));
    out.push({ tick: on, order: 2, data: [0x90 + channel, n.pitch, n.velocity] });
    out.push({ tick: off, order: 0, data: [0x80 + channel, n.pitch, 0] });
  }
  return out;
}

export function pieceToMidi(piece: Piece): Uint8Array {
  const tempo = piece.params.tempo;
  const usPerQuarter = Math.round(60000000 / tempo);

  const piano: MidiEvent[] = [
    { tick: 0, order: 1, data: meta(0x03, ascii('Piano')) },
    { tick: 0, order: 1, data: [0xc0 + MIDI_PIANO_CHANNEL, MIDI_PIANO_PROGRAM] },
    ...noteEvents(piece.notes, MIDI_PIANO_CHANNEL, tempo),
  ];
  for (const e of piece.pedal) {
    piano.push({
      tick: secondsToTicks(e.time, tempo),
      order: 1,
      data: [0xb0 + MIDI_PIANO_CHANNEL, CC_SUSTAIN, e.down ? 127 : 0],
    });
  }
  const padTrack: MidiEvent[] = [
    { tick: 0, order: 1, data: meta(0x03, ascii('Pad')) },
    { tick: 0, order: 1, data: [0xc0 + MIDI_PAD_CHANNEL, MIDI_PAD_PROGRAM] },
    ...noteEvents(piece.pad, MIDI_PAD_CHANNEL, tempo),
  ];

  let endTick = secondsToTicks(piece.durationSec, tempo);
  for (const e of piano) endTick = Math.max(endTick, e.tick);
  for (const e of padTrack) endTick = Math.max(endTick, e.tick);

  const name = `Ambient Lab seed ${piece.params.seed} variation ${piece.params.variation}`;
  const conductor: MidiEvent[] = [
    { tick: 0, order: 1, data: meta(0x03, ascii(name)) },
    { tick: 0, order: 1, data: meta(0x51, u32(usPerQuarter).slice(1)) },
    // 4/4, 24 MIDI clocks per click, 8 thirty-second notes per quarter.
    { tick: 0, order: 1, data: meta(0x58, [4, 2, 24, 8]) },
  ];

  const bytes = [
    ...ascii('MThd'),
    ...u32(6),
    ...u16(1),
    ...u16(3),
    ...u16(MIDI_PPQ),
    ...trackChunk(conductor, endTick),
    ...trackChunk(piano, endTick),
    ...trackChunk(padTrack, endTick),
  ];
  return Uint8Array.from(bytes);
}
