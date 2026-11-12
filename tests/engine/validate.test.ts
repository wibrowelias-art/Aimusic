import { describe, expect, it } from 'vitest';
import {
  DENSITY_TOLERANCE,
  densityTolerance,
  generate,
  MIN_SAME_PITCH_GAP_SEC,
  validatePiece,
  type Piece,
} from '../../src/engine';

/** A valid piece to break in one place per test. */
function fresh(): Piece {
  return structuredClone(generate({ seed: 21, mode: 'dorian', density: 2.4, restProbability: 0.25 }));
}

function expectError(piece: Piece, pattern: RegExp): ReturnType<typeof validatePiece> {
  const report = validatePiece(piece);
  expect(report.ok).toBe(false);
  expect(report.errors.some((e) => pattern.test(e))).toBe(true);
  return report;
}

describe('validatePiece', () => {
  it('accepts a generated piece and reports its numbers', () => {
    const piece = fresh();
    const report = validatePiece(piece);
    expect(report).toEqual({
      ok: true,
      errors: [],
      measuredDensity: piece.notes.length / piece.bars,
      measuredRestRatio: report.measuredRestRatio,
      noteCount: piece.notes.length,
      outOfScale: 0,
      overlaps: 0,
      stuck: 0,
    });
    const active = new Set(piece.notes.map((n) => Math.floor(n.startBeat / 4)));
    expect(report.measuredRestRatio).toBeCloseTo(1 - active.size / piece.bars, 12);
  });

  it('density tolerance is max(0.25, 15 % of the target)', () => {
    expect(DENSITY_TOLERANCE).toEqual({ abs: 0.25, rel: 0.15 });
    expect(densityTolerance(0.5)).toBe(0.25);
    expect(densityTolerance(1)).toBe(0.25);
    expect(densityTolerance(1.8)).toBeCloseTo(0.27, 12);
    expect(densityTolerance(4)).toBeCloseTo(0.6, 12);
  });

  it('catches a note outside the scale', () => {
    const piece = fresh();
    const scale = new Set(piece.scale);
    const note = piece.notes[5];
    while (scale.has(note.pitch % 12)) note.pitch++;
    const report = expectError(piece, /not in the scale/);
    expect(report.outOfScale).toBe(1);
  });

  it('catches a note outside the sample range', () => {
    const piece = fresh();
    piece.notes[3].pitch += 60;
    expectError(piece, /pitch outside 30\.\.96/);
  });

  it('catches stuck notes: zero duration, or a release after durationSec', () => {
    const zero = fresh();
    zero.notes[4].duration = 0;
    expect(expectError(zero, /duration 0/).stuck).toBe(1);

    const late = fresh();
    late.notes[late.notes.length - 1].duration += 1;
    expect(expectError(late, /after durationSec/).stuck).toBe(1);

    const nan = fresh();
    nan.notes[2].duration = Number.NaN;
    expect(expectError(nan, /duration NaN/).stuck).toBe(1);
  });

  it('catches overlapping notes of the same pitch, including a gap under 10 ms', () => {
    const piece = fresh();
    // Find two notes of the same pitch and stretch the first into the second.
    const firstOf = new Map<number, number>();
    let pair: [number, number] | null = null;
    piece.notes.forEach((n, i) => {
      const earlier = firstOf.get(n.pitch);
      if (pair === null && earlier !== undefined) pair = [earlier, i];
      firstOf.set(n.pitch, i);
    });
    expect(pair).not.toBeNull();
    const [a, b] = pair as unknown as [number, number];
    const overlapping = structuredClone(piece);
    overlapping.notes[a].duration = overlapping.notes[b].time - overlapping.notes[a].time + 0.2;
    expect(expectError(overlapping, /overlapping piano notes/).overlaps).toBeGreaterThanOrEqual(1);

    const tight = structuredClone(piece);
    tight.notes[a].duration = tight.notes[b].time - tight.notes[a].time - MIN_SAME_PITCH_GAP_SEC / 2;
    expect(expectError(tight, /overlapping piano notes/).overlaps).toBe(1);

    const fine = structuredClone(piece);
    fine.notes[a].duration = fine.notes[b].time - fine.notes[a].time - MIN_SAME_PITCH_GAP_SEC - 0.001;
    expect(validatePiece(fine).overlaps).toBe(0);
  });

  it('catches wrong order and wrong ids', () => {
    const swapped = fresh();
    const tmp = swapped.notes[2];
    swapped.notes[2] = swapped.notes[9];
    swapped.notes[9] = tmp;
    expectError(swapped, /not sorted|is not its index/);

    const ids = fresh();
    ids.notes[7].id = 99;
    expectError(ids, /id 99 is not its index/);
  });

  it('catches a density outside the tolerance', () => {
    const piece = fresh();
    piece.notes = piece.notes.filter((_, i) => i % 2 === 0).map((n, id) => ({ ...n, id }));
    expectError(piece, /density .* away from the target/);
  });

  it('catches an onset outside the humanise bound', () => {
    const piece = fresh();
    piece.notes[6].time += 0.06;
    piece.notes.sort((a, b) => a.time - b.time || a.pitch - b.pitch);
    piece.notes.forEach((n, id) => {
      n.id = id;
    });
    expectError(piece, /away from its beat/);

    const wide = fresh();
    wide.humanizeMs = 80;
    expectError(wide, /humanizeMs 80 outside 15\.\.40/);
  });

  it('catches a broken tempo map', () => {
    const flat = fresh();
    flat.beatTimes[10] = flat.beatTimes[9];
    expectError(flat, /beatTimes not strictly increasing/);

    const bars = fresh();
    bars.barTimes[3] += 0.5;
    expectError(bars, /barTimes\[3\] differs/);

    const short = fresh();
    short.beatTimes.pop();
    expectError(short, /beatTimes has/);

    const early = fresh();
    early.beatTimes[0] = 0.01;
    expectError(early, /lead-in/);
  });

  it('catches pedal problems', () => {
    const order = fresh();
    order.pedal[1].down = true;
    expectError(order, /does not alternate/);

    const hanging = fresh();
    hanging.pedal.pop();
    expectError(hanging, /pedal has|does not end up/);

    const late = fresh();
    late.pedal[late.pedal.length - 1].time = late.durationSec + 1;
    expectError(late, /outside the piece/);

    const backwards = fresh();
    backwards.pedal[2].time = backwards.pedal[1].time - 0.5;
    expectError(backwards, /is not after the one before/);
  });

  it('catches chord and section problems', () => {
    const long = fresh();
    long.chords[0].bars = 5;
    expectError(long, /lasts 5 bars|starts at bar/);

    const gap = fresh();
    gap.chords.splice(1, 1);
    expectError(gap, /starts at bar|chords cover/);

    const outside = fresh();
    outside.chords[1].pitchClasses = outside.chords[1].pitchClasses.map((pc) => (pc + 1) % 12);
    expectError(outside, /outside the scale|bad chord tones|not a tone of/);

    const names = fresh();
    names.sections[1].name = 'A';
    expectError(names, /expected A,B,A2/);

    const cover = fresh();
    cover.sections[2].bars -= 1;
    expectError(cover, /sections cover/);

    const one = fresh();
    // A one-bar chord is only allowed at the end of a section.
    one.chords[0].bars = 1;
    expectError(one, /lasts 1 bars|starts at bar/);
  });

  it('catches a wrong passing flag in both directions', () => {
    const piece = fresh();
    const plain = piece.notes.find((n) => !n.passing);
    expect(plain).toBeDefined();
    if (plain) plain.passing = true;
    expectError(piece, /marked passing but is a tone of/);

    const other = fresh();
    const melody = other.notes.find((n) => n.role === 'melody' && !n.passing && n.id > 3);
    expect(melody).toBeDefined();
    if (melody) {
      const chord = other.chords.find((c) => {
        const bar = Math.floor(melody.startBeat / 4);
        return bar >= c.startBar && bar < c.startBar + c.bars;
      });
      // Move to a scale tone that is not in the chord, if there is one.
      const outsideChord = other.scale.find((pc) => chord !== undefined && !chord.pitchClasses.includes(pc));
      if (outsideChord !== undefined) {
        melody.pitch = melody.pitch - (melody.pitch % 12) + outsideChord;
        const report = validatePiece(other);
        expect(report.errors.some((e) => /not marked passing/.test(e))).toBe(true);
      }
    }
  });

  it('catches pad problems', () => {
    const scalePiece = fresh();
    const scale = new Set(scalePiece.scale);
    while (scale.has(scalePiece.pad[0].pitch % 12)) scalePiece.pad[0].pitch++;
    expect(expectError(scalePiece, /pad note 0 .*not in the scale|pad not sorted/).outOfScale).toBe(1);

    const overlap = fresh();
    const first = overlap.pad[0];
    const again = overlap.pad.findIndex((n, i) => i > 0 && n.pitch === first.pitch);
    if (again > 0) {
      first.duration = overlap.pad[again].time - first.time + 0.5;
      expect(expectError(overlap, /overlapping pad notes/).overlaps).toBeGreaterThanOrEqual(1);
    }

    const empty = fresh();
    empty.pad = [];
    expectError(empty, /pad is empty/);
  });

  it('catches a wrong scale, un-normalised params and an empty first bar', () => {
    const scale = fresh();
    scale.scale = scale.scale.map((pc) => (pc + 1) % 12);
    expectError(scale, /scale does not match/);

    const params = fresh();
    params.params.tempo = 300;
    expectError(params, /params are not normalised/);

    const silent = fresh();
    silent.notes = silent.notes.filter((n) => n.startBeat >= 4).map((n, id) => ({ ...n, id }));
    expectError(silent, /bar 0 has no piano onset/);
  });

  it('never throws, even on an empty shell', () => {
    const shell = fresh();
    shell.notes = [];
    shell.pad = [];
    shell.pedal = [];
    shell.chords = [];
    shell.sections = [];
    shell.beatTimes = [];
    shell.barTimes = [];
    const report = validatePiece(shell);
    expect(report.ok).toBe(false);
    expect(report.noteCount).toBe(0);
    expect(report.errors.length).toBeGreaterThan(3);
  });
});
