/**
 * The seeded composer. generate(params) is pure: the same params always give the same piece.
 *
 * Every piece is original: a 3-5 note motif is invented from the seed, the chords come from a
 * seeded walk over the scale degrees of the mode, and the whole piece is that motif developed
 * (transposed, stretched, fragmented, octave-shifted) over those chords in an A / B / A' form.
 * Nothing here quotes or approximates existing music.
 *
 * Random sub-streams (see rng.ts):
 *   seed only:          motif, form, harmony, statement (the opening statement), pad
 *   seed + variation:   develop (silence, budgets, transforms, left hand), perform (rubato,
 *                       timing, velocities, pedal)
 * reverbSize, lofi, pad and rain are not read at all, so they cannot change a note.
 */
import { Accompanist, pruneScore } from './accompany';
import { MIN_BARS, planForm, planHarmony } from './harmony';
import { planLayout } from './layout';
import { melodyWindow, motifBarCount, writeChunkMelody, writeClosingNote } from './melody';
import { inventMotif } from './motif';
import { BEATS_PER_BAR, normalizeParams } from './params';
import {
  beatToTime,
  buildPad,
  buildPedal,
  buildTempoMap,
  HUMANIZE_MAX_MS,
  HUMANIZE_MIN_MS,
  performNotes,
  type PhraseEnd,
  voicePad,
} from './perform';
import { createRng } from './rng';
import { barOfBeat, compareScoreNotes, Score, type ComposeContext, type ScoreNote } from './score';
import { makeScale, nearestIndex, pitchClass } from './theory';
import type { ChordSpan, Params, Piece, SectionSpan } from './types';

/** At most this share of the piano notes may be passing tones. */
export const PASSING_SHARE = 0.15;
/** The centre of the B melody stays inside these MIDI notes. */
const B_CENTRE_MIN = 55;
const B_CENTRE_MAX = 84;

/** Number of bars for a tempo and a target length (at least MIN_BARS). */
export function barCount(tempo: number, lengthSec: number): number {
  const barSec = (60 / tempo) * BEATS_PER_BAR;
  return Math.max(MIN_BARS, Math.round(lengthSec / barSec));
}

/** Key-down times end with the chord unless the next chord contains the note; same pitches never overlap. */
function finishScore(ctx: ComposeContext): ScoreNote[] {
  const notes = ctx.score.notes.slice().sort(compareScoreNotes);
  for (const n of notes) {
    const s = ctx.barChord[barOfBeat(n.startBeat)];
    const chord = ctx.chords[s];
    const spanEnd = (chord.startBar + chord.bars) * BEATS_PER_BAR;
    const next = s + 1 < ctx.chords.length ? ctx.chords[s + 1] : null;
    const tiesOver = next !== null && next.pitchClasses.includes(pitchClass(n.pitch));
    if (n.startBeat + n.durBeats > spanEnd && !tiesOver) n.durBeats = spanEnd - n.startBeat;
    if (n.startBeat + n.durBeats > ctx.totalBeats) n.durBeats = ctx.totalBeats - n.startBeat;
  }
  const lastOfPitch = new Map<number, ScoreNote>();
  for (const n of notes) {
    const prev = lastOfPitch.get(n.pitch);
    if (prev && prev.startBeat + prev.durBeats > n.startBeat) prev.durBeats = n.startBeat - prev.startBeat;
    lastOfPitch.set(n.pitch, n);
  }
  return notes;
}

export function generate(input: Partial<Params>): Piece {
  const params = normalizeParams(input);
  const scale = makeScale(params.key, params.mode);
  const bars = barCount(params.tempo, params.length);
  const totalBeats = bars * BEATS_PER_BAR;

  const rng = createRng(params.seed);
  const develop = rng.fork('develop').fork(`variation${params.variation}`);
  const performRng = rng.fork('perform').fork(`variation${params.variation}`);

  // What "Again" keeps: motif, form, chords.
  const motif = inventMotif(rng.fork('motif'));
  const form = planForm(bars, rng.fork('form'));
  const chords = planHarmony(scale, form.sections, rng.fork('harmony'));
  const barChord: number[] = [];
  chords.forEach((chord, i) => {
    for (let b = 0; b < chord.bars; b++) barChord.push(i);
  });

  // Where the piano plays and how many notes each chunk gets.
  const layout = planLayout(
    {
      bars,
      sections: form.sections,
      target: Math.round(params.density * bars),
      restProbability: params.restProbability,
      motifNotes: motif.steps.length,
      motifBars: motifBarCount(motif),
    },
    develop.fork('layout'),
  );

  // Register of the B section: a fourth to an octave away, in the drawn direction when there is room.
  const up = params.register + form.shiftSemis;
  const down = params.register - form.shiftSemis;
  const goUp = form.shiftUp ? up <= B_CENTRE_MAX : down < B_CENTRE_MIN;
  const centreB = goUp ? up : down;
  const alt = centreB + (goUp ? -12 : 12);

  const ctx: ComposeContext = {
    scale,
    bars,
    totalBeats,
    motif,
    chords,
    barChord,
    chunks: layout.chunks,
    score: new Score(bars),
    register: params.register,
    baseIndex: nearestIndex(scale, params.register),
    centreB,
    centreBAlt: alt >= B_CENTRE_MIN && alt <= B_CENTRE_MAX ? alt : null,
    passingLeft: Math.floor(PASSING_SHARE * layout.target),
  };

  // Right hand: motif statements. The opening statement draws from the seed only.
  const melodyCount: number[] = [];
  for (const chunk of layout.chunks) {
    if (chunk.final) {
      writeClosingNote(ctx, chunk, develop.fork('closing'));
      melodyCount.push(1);
    } else {
      const chunkRng = chunk.first ? rng.fork('statement') : develop.fork(`melody${chunk.index}`);
      melodyCount.push(writeChunkMelody(ctx, chunk, chunkRng));
    }
  }

  // Left hand, echoes, passing tones; then the exact note count.
  const accompanist = new Accompanist(ctx);
  for (const chunk of layout.chunks) {
    const extras = chunk.budget - melodyCount[chunk.index];
    if (chunk.final) {
      if (extras > 0) accompanist.addClosingBass(chunk);
    } else if (extras > 0) {
      accompanist.addExtras(chunk, extras, develop.fork(`extras${chunk.index}`));
    }
  }
  accompanist.fill(layout.target, develop.fork('fill'));
  pruneScore(ctx.score, layout.target);
  const scoreNotes = finishScore(ctx);

  // Performance.
  const phraseEnds: PhraseEnd[] = layout.chunks
    .filter((c) => !c.final)
    .map((c) => ({ bar: c.startBar + c.bars - 1, strong: c.runEnd }));
  const beatTimes = buildTempoMap(bars, params.tempo, phraseEnds, performRng.fork('tempo'));
  const barTimes: number[] = [];
  for (let b = 0; b <= bars; b++) barTimes.push(beatTimes[b * BEATS_PER_BAR]);
  const durationSec = beatTimes[totalBeats];
  const humanizeMs = performRng.fork('humanize').int(HUMANIZE_MIN_MS, HUMANIZE_MAX_MS);
  const notes = performNotes(
    scoreNotes,
    { beatTimes, totalBeats, humanizeMs, contrast: goUp ? -2 : 2 },
    performRng.fork('notes'),
  );

  const chordSpans: ChordSpan[] = chords.map((c) => ({
    startBar: c.startBar,
    bars: c.bars,
    degree: c.degree,
    root: c.root,
    pitchClasses: c.pitchClasses.slice(),
    name: c.name,
    section: c.section,
    startTime: barTimes[c.startBar],
    endTime: barTimes[c.startBar + c.bars],
  }));
  const sections: SectionSpan[] = form.sections.map((s) => ({
    name: s.name,
    startBar: s.startBar,
    bars: s.bars,
    startTime: barTimes[s.startBar],
    endTime: barTimes[s.startBar + s.bars],
  }));

  return {
    params,
    scale: scale.pcs.slice(),
    beatsPerBar: BEATS_PER_BAR,
    bars,
    motif,
    sections,
    chords: chordSpans,
    notes,
    pad: buildPad(chordSpans, voicePad(chords, rng.fork('pad')), durationSec, rng.fork('pad').fork('level')),
    pedal: buildPedal(chordSpans, durationSec, performRng.fork('pedal')),
    beatTimes,
    barTimes,
    humanizeMs,
    durationSec,
  };
}

/** Score position in beats -> performed seconds via the piece's tempo map (linear between beats). */
export function scoreTime(piece: Piece, beat: number): number {
  return beatToTime(piece.beatTimes, beat);
}

/** MIDI range the melody of the A and A' sections may use for a given register. */
export function melodyRange(register: number): [number, number] {
  return melodyWindow(register);
}
