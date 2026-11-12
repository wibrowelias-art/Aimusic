import { describe, expect, it } from 'vitest';
import {
  createRng,
  encodeVlq,
  generate,
  MIDI_PAD_CHANNEL,
  MIDI_PAD_PROGRAM,
  MIDI_PIANO_CHANNEL,
  MIDI_PIANO_PROGRAM,
  MIDI_PPQ,
  pieceToMidi,
  secondsToTicks,
  type Params,
  type Piece,
} from '../../src/engine';
import { extremeParams, parseMidi, randomParams, type MidiEvent } from './helpers';

function pieces(): Piece[] {
  const rng = createRng(555);
  const sets: Partial<Params>[] = [{}, { seed: 2, mode: 'lydian' }, { seed: 3, mode: 'dorian' }, ...extremeParams().slice(0, 32)];
  for (let i = 0; i < 40; i++) sets.push(randomParams(rng));
  return sets.map((p) => generate(p));
}

/** Pair note-ons with note-offs per pitch; fails on a double note-on or an orphan note-off. */
function pairNotes(events: readonly MidiEvent[], channel: number): { pitch: number; on: number; off: number; velocity: number }[] {
  const open = new Map<number, { on: number; velocity: number }>();
  const out: { pitch: number; on: number; off: number; velocity: number }[] = [];
  for (const e of events) {
    if (e.kind !== 'noteOn' && e.kind !== 'noteOff') continue;
    expect(e.channel).toBe(channel);
    if (e.kind === 'noteOn') {
      // A second note-on while the pitch is still held would be an overlap.
      expect(open.has(e.a)).toBe(false);
      open.set(e.a, { on: e.tick, velocity: e.b });
    } else {
      const start = open.get(e.a);
      expect(start).toBeDefined();
      if (start) out.push({ pitch: e.a, on: start.on, off: e.tick, velocity: start.velocity });
      open.delete(e.a);
    }
  }
  // Nothing left hanging.
  expect(open.size).toBe(0);
  return out;
}

describe('MIDI export', () => {
  const batch = pieces().map((piece) => ({ piece, bytes: pieceToMidi(piece) }));

  it('header: MThd, format 1, 3 tracks, 480 PPQ', () => {
    for (const { bytes } of batch) {
      expect(String.fromCharCode(...bytes.slice(0, 4))).toBe('MThd');
      const midi = parseMidi(bytes);
      expect(midi.format).toBe(1);
      expect(midi.trackCount).toBe(3);
      expect(midi.tracks.length).toBe(3);
      expect(midi.ppq).toBe(480);
      expect(MIDI_PPQ).toBe(480);
    }
  });

  it('track 0: tempo meta matches params.tempo, 4/4, track name with the seed, no notes', () => {
    for (const { piece, bytes } of batch) {
      const conductor = parseMidi(bytes).tracks[0];
      expect(conductor.every((e) => e.kind === 'meta')).toBe(true);
      const tempo = conductor.filter((e) => e.a === 0x51);
      expect(tempo.length).toBe(1);
      expect(tempo[0].tick).toBe(0);
      expect(tempo[0].data.length).toBe(3);
      const usPerQuarter = tempo[0].data[0] * 65536 + tempo[0].data[1] * 256 + tempo[0].data[2];
      expect(usPerQuarter).toBe(Math.round(60000000 / piece.params.tempo));
      const timeSig = conductor.filter((e) => e.a === 0x58);
      expect(timeSig.length).toBe(1);
      expect(timeSig[0].data).toEqual([4, 2, 24, 8]);
      const name = conductor.filter((e) => e.a === 0x03);
      expect(name.length).toBe(1);
      expect(String.fromCharCode(...name[0].data)).toContain(`seed ${piece.params.seed}`);
    }
  });

  it('track 1: piano on channel 0, program 0, every note-on matched by a note-off, no same-pitch overlap', () => {
    for (const { piece, bytes } of batch) {
      const track = parseMidi(bytes).tracks[1];
      const programs = track.filter((e) => e.kind === 'program');
      expect(programs.length).toBe(1);
      expect(programs[0].channel).toBe(MIDI_PIANO_CHANNEL);
      expect(programs[0].a).toBe(MIDI_PIANO_PROGRAM);
      expect(programs[0].tick).toBe(0);
      const notes = pairNotes(track, 0);
      expect(notes.length).toBe(piece.notes.length);
      for (const n of notes) {
        expect(n.off).toBeGreaterThan(n.on);
        expect(n.velocity).toBeGreaterThanOrEqual(1);
        expect(n.velocity).toBeLessThanOrEqual(127);
      }
      // The performed notes, in ticks at the nominal tempo.
      const expected = piece.notes
        .map((n) => `${n.pitch}@${secondsToTicks(n.time, piece.params.tempo)}v${n.velocity}`)
        .sort();
      expect(notes.map((n) => `${n.pitch}@${n.on}v${n.velocity}`).sort()).toEqual(expected);
      for (const n of piece.notes) {
        const on = Math.round((n.time * piece.params.tempo * 480) / 60);
        expect(secondsToTicks(n.time, piece.params.tempo)).toBe(on);
      }
    }
  });

  it('track 1: note lengths follow the performed durations within one tick', () => {
    for (const { piece, bytes } of batch.slice(0, 12)) {
      const notes = pairNotes(parseMidi(bytes).tracks[1], 0);
      const byKey = new Map<string, number>();
      for (const n of notes) byKey.set(`${n.pitch}@${n.on}`, n.off - n.on);
      for (const n of piece.notes) {
        const on = secondsToTicks(n.time, piece.params.tempo);
        const ticks = byKey.get(`${n.pitch}@${on}`);
        expect(ticks).toBeDefined();
        const ideal = (n.duration * piece.params.tempo * 480) / 60;
        expect(Math.abs((ticks ?? 0) - ideal)).toBeLessThanOrEqual(1.01);
      }
    }
  });

  it('track 1: pedal is CC64 on channel 0, alternating 127 / 0, starting down and ending up', () => {
    for (const { piece, bytes } of batch) {
      const track = parseMidi(bytes).tracks[1];
      const controllers = track.filter((e) => e.kind === 'controller');
      expect(controllers.length).toBe(piece.pedal.length);
      expect(controllers.length).toBeGreaterThanOrEqual(2);
      controllers.forEach((e, i) => {
        expect(e.a).toBe(64);
        expect(e.channel).toBe(0);
        expect(e.b).toBe(i % 2 === 0 ? 127 : 0);
        expect(e.tick).toBe(secondsToTicks(piece.pedal[i].time, piece.params.tempo));
        if (i > 0) expect(e.tick).toBeGreaterThan(controllers[i - 1].tick);
      });
      expect(controllers[controllers.length - 1].b).toBe(0);
      // One pedal change per chord.
      expect(controllers.length).toBe(piece.chords.length * 2);
    }
  });

  it('track 2: pad on channel 1, program 89, balanced notes without overlaps', () => {
    for (const { piece, bytes } of batch) {
      const track = parseMidi(bytes).tracks[2];
      const programs = track.filter((e) => e.kind === 'program');
      expect(programs.length).toBe(1);
      expect(programs[0].channel).toBe(MIDI_PAD_CHANNEL);
      expect(programs[0].a).toBe(MIDI_PAD_PROGRAM);
      expect(MIDI_PAD_PROGRAM).toBe(89);
      const notes = pairNotes(track, 1);
      expect(notes.length).toBe(piece.pad.length);
      expect(track.some((e) => e.kind === 'controller')).toBe(false);
    }
  });

  it('timing: deltas never negative, End of Track after the last event, total ticks match durationSec', () => {
    for (const { piece, bytes } of batch) {
      const midi = parseMidi(bytes);
      const total = Math.round((piece.durationSec * piece.params.tempo * 480) / 60);
      midi.tracks.forEach((track, t) => {
        for (let i = 1; i < track.length; i++) expect(track[i].tick).toBeGreaterThanOrEqual(track[i - 1].tick);
        const last = track.length > 0 ? track[track.length - 1].tick : 0;
        expect(midi.endTicks[t]).toBeGreaterThanOrEqual(last);
        expect(midi.endTicks[t]).toBe(total);
      });
      // The last piano event is the final pedal release at durationSec.
      const piano = midi.tracks[1];
      expect(piano[piano.length - 1].tick).toBe(total);
      // Tick length and seconds agree at the nominal tempo.
      expect(Math.abs((total * 60) / (piece.params.tempo * 480) - piece.durationSec)).toBeLessThan(0.002);
    }
  });

  it('is byte-identical when exported twice and when the piece is regenerated', () => {
    for (const { piece, bytes } of batch.slice(0, 20)) {
      expect(Buffer.from(pieceToMidi(piece)).equals(Buffer.from(bytes))).toBe(true);
      expect(Buffer.from(pieceToMidi(generate(piece.params))).equals(Buffer.from(bytes))).toBe(true);
    }
  });

  it('variable-length quantities', () => {
    expect(encodeVlq(0)).toEqual([0x00]);
    expect(encodeVlq(0x40)).toEqual([0x40]);
    expect(encodeVlq(0x7f)).toEqual([0x7f]);
    expect(encodeVlq(0x80)).toEqual([0x81, 0x00]);
    expect(encodeVlq(0x2000)).toEqual([0xc0, 0x00]);
    expect(encodeVlq(0x3fff)).toEqual([0xff, 0x7f]);
    expect(encodeVlq(0x4000)).toEqual([0x81, 0x80, 0x00]);
    expect(encodeVlq(0x1fffff)).toEqual([0xff, 0xff, 0x7f]);
    expect(encodeVlq(0x0fffffff)).toEqual([0xff, 0xff, 0xff, 0x7f]);
  });

  it('the test parser rejects broken files (so the checks above mean something)', () => {
    const good = pieceToMidi(generate({ seed: 12 }));
    expect(() => parseMidi(good.slice(0, good.length - 3))).toThrow();
    const badTag = good.slice();
    badTag[0] = 0x58;
    expect(() => parseMidi(badTag)).toThrow();
    const extra = new Uint8Array(good.length + 1);
    extra.set(good);
    expect(() => parseMidi(extra)).toThrow();
  });
});
