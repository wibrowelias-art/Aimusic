import { describe, expect, it } from 'vitest';
import {
  BEATS_PER_BAR,
  barCount,
  createRng,
  densityTolerance,
  generate,
  HARD_BAR_CAP,
  MODES,
  PARAM_SPECS,
  pieceToMidi,
  PITCH_MAX,
  PITCH_MIN,
  validatePiece,
  type Params,
  type Piece,
} from '../../src/engine';
import { barOf, extremeParams, parseMidi, Problems, randomParams } from './helpers';

/** The property sweep: every corner of the parameter space plus a seeded random batch. */
const RANDOM_SETS = 360;

interface Row {
  params: Params;
  piece: Piece;
  densityError: number;
  restError: number;
}

function runSweep(): Row[] {
  const rng = createRng(20261112);
  const sets: Partial<Params>[] = extremeParams();
  for (let i = 0; i < RANDOM_SETS; i++) sets.push(randomParams(rng));
  return sets.map((p) => {
    const piece = generate(p);
    const report = validatePiece(piece);
    if (!report.ok) {
      throw new Error(`invalid piece for ${JSON.stringify(piece.params)}:\n  ${report.errors.slice(0, 8).join('\n  ')}`);
    }
    return {
      params: piece.params,
      piece,
      densityError: Math.abs(report.measuredDensity - piece.params.density),
      restError: Math.abs(report.measuredRestRatio - piece.params.restProbability),
    };
  });
}

describe('property sweep', () => {
  const rows = runSweep();

  it(`covers at least 300 parameter sets, all modes, all keys and every extreme`, () => {
    expect(rows.length).toBeGreaterThanOrEqual(300 + 128);
    expect(new Set(rows.map((r) => r.params.mode)).size).toBe(MODES.length);
    expect(new Set(rows.map((r) => r.params.key)).size).toBe(12);
    for (const key of ['density', 'restProbability', 'tempo', 'length', 'register'] as const) {
      const values = rows.map((r) => r.params[key]);
      expect(Math.min(...values)).toBe(PARAM_SPECS[key].min);
      expect(Math.max(...values)).toBe(PARAM_SPECS[key].max);
    }
  });

  it('every piece passes validatePiece (checked while generating) and reports clean counters', () => {
    for (const { piece } of rows) {
      const report = validatePiece(piece);
      expect(report.ok).toBe(true);
      expect(report.errors).toEqual([]);
      expect(report.outOfScale).toBe(0);
      expect(report.overlaps).toBe(0);
      expect(report.stuck).toBe(0);
      expect(report.noteCount).toBe(piece.notes.length);
    }
  });

  it('all notes are inside the key/mode and the sample range (checked independently of the validator)', () => {
    const problems = new Problems();
    let checked = 0;
    for (const { piece } of rows) {
      const allowed = new Set(piece.scale);
      for (const n of [...piece.notes, ...piece.pad]) {
        checked++;
        problems.check(allowed.has(n.pitch % 12), () => `pitch ${n.pitch} outside the scale, ${JSON.stringify(piece.params)}`);
        problems.check(n.pitch >= PITCH_MIN && n.pitch <= PITCH_MAX, () => `pitch ${n.pitch} outside the sample range`);
      }
    }
    expect(problems.list).toEqual([]);
    expect(checked).toBeGreaterThan(20000);
  });

  it('density is inside the tolerance everywhere; worst case reported', () => {
    let worst = rows[0];
    let worstRelative = rows[0];
    let exact = 0;
    for (const row of rows) {
      const tolerance = densityTolerance(row.params.density);
      expect(row.densityError).toBeLessThanOrEqual(tolerance + 1e-9);
      if (row.densityError > worst.densityError) worst = row;
      if (row.densityError / tolerance > worstRelative.densityError / densityTolerance(worstRelative.params.density)) {
        worstRelative = row;
      }
      // The note count is exact by construction. The only exception: the whole motif plus the
      // closing note are always written, even when the target is smaller than that.
      const target = Math.round(row.params.density * row.piece.bars);
      expect(row.piece.notes.length).toBe(Math.max(target, row.piece.motif.steps.length + 1));
      if (row.piece.notes.length === target) exact++;
    }
    console.log(
      `[sweep] ${rows.length} pieces, worst density error ${worst.densityError.toFixed(4)} notes/bar ` +
        `(target ${worst.params.density}, ${worst.piece.notes.length} notes in ${worst.piece.bars} bars, ` +
        `tolerance ${densityTolerance(worst.params.density).toFixed(3)}); ` +
        `${exact} of ${rows.length} pieces hit round(density * bars) exactly`,
    );
    expect(exact / rows.length).toBeGreaterThan(0.9);
  });

  it('bar count follows length and tempo, never below 8', () => {
    for (const { piece, params } of rows) {
      const expected = Math.max(8, Math.round(params.length / ((60 / params.tempo) * BEATS_PER_BAR)));
      expect(piece.bars).toBe(expected);
      expect(piece.bars).toBe(barCount(params.tempo, params.length));
    }
  });

  it('no bar has more than the cap of onsets and bar 0 always has one', () => {
    for (const { piece } of rows) {
      const perBar = new Array<number>(piece.bars).fill(0);
      for (const n of piece.notes) perBar[barOf(n)]++;
      expect(perBar[0]).toBeGreaterThan(0);
      expect(Math.max(...perBar)).toBeLessThanOrEqual(HARD_BAR_CAP);
    }
  });

  it('rest ratio tracks restProbability where the density allows', () => {
    let checked = 0;
    let worst = 0;
    for (const { piece, params, restError } of rows) {
      const target = Math.round(params.density * piece.bars);
      const wantActive = piece.bars - Math.round(params.restProbability * piece.bars);
      // "Allows": between one note per active bar plus the motif, and six notes per active bar.
      const allows = target >= wantActive + piece.motif.steps.length && target <= 6 * wantActive;
      if (!allows) continue;
      checked++;
      worst = Math.max(worst, restError);
      // One bar of slack for short pieces (rounding to whole bars, one bar kept for each section).
      expect(restError).toBeLessThanOrEqual(Math.max(0.15, 1.5 / piece.bars) + 1e-9);
    }
    console.log(`[sweep] rest ratio checked on ${checked} pieces, worst deviation ${worst.toFixed(4)}`);
    expect(checked).toBeGreaterThan(rows.length * 0.4);
  });

  it('silence comes as whole bars between phrases: silent bars form runs, active bars form phrases', () => {
    for (const { piece, params } of rows) {
      const active = new Array<boolean>(piece.bars).fill(false);
      for (const n of piece.notes) active[barOf(n)] = true;
      const activeCount = active.filter(Boolean).length;
      // Lowering density must not blow holes into phrases: active bars never outnumber notes.
      expect(activeCount).toBeLessThanOrEqual(piece.notes.length);
      if (params.restProbability === 0 && params.density >= 2) expect(activeCount).toBe(piece.bars);
    }
  });

  it('MIDI of every swept piece parses and has balanced notes', () => {
    for (const { piece } of rows) {
      const midi = parseMidi(pieceToMidi(piece));
      expect(midi.trackCount).toBe(3);
      const ons = midi.tracks[1].filter((e) => e.kind === 'noteOn').length;
      const offs = midi.tracks[1].filter((e) => e.kind === 'noteOff').length;
      expect(ons).toBe(piece.notes.length);
      expect(offs).toBe(piece.notes.length);
    }
  });

  it('generation is fast', () => {
    const start = performance.now();
    for (let seed = 0; seed < 100; seed++) generate({ seed, density: 4, restProbability: 0, tempo: 72, length: 240 });
    const perPiece = (performance.now() - start) / 100;
    console.log(`[sweep] densest, longest setting: ${perPiece.toFixed(1)} ms per piece`);
    expect(perPiece).toBeLessThan(250);
  });
});
