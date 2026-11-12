/**
 * The hard checks every generated piece must pass. validatePiece never throws; it returns
 * a report with one line per problem.
 */
import { BEATS_PER_BAR, normalizeParams, PITCH_MAX, PITCH_MIN } from './params';
import { beatToTime, HUMANIZE_MAX_MS, HUMANIZE_MIN_MS } from './perform';
import { pitchClass, scalePitchClasses } from './theory';
import type { Piece, PieceReport, SectionName } from './types';

/**
 * Allowed gap between the measured density (piano onsets per bar over the whole piece)
 * and params.density: max(abs, rel * target).
 */
export const DENSITY_TOLERANCE = { abs: 0.25, rel: 0.15 } as const;

export function densityTolerance(target: number): number {
  return Math.max(DENSITY_TOLERANCE.abs, DENSITY_TOLERANCE.rel * target);
}

/** Two notes of the same pitch: the earlier one must end at least this long before the later one starts. */
export const MIN_SAME_PITCH_GAP_SEC = 0.01;

const EPS = 1e-9;
const SECTION_ORDER: readonly SectionName[] = ['A', 'B', 'A2'];
const ROLES = ['melody', 'bass', 'harmony', 'echo'];
const MAX_ERRORS = 60;

interface Timed {
  pitch: number;
  time: number;
  duration: number;
}

/** Number of same-pitch pairs where the earlier note has not ended MIN_SAME_PITCH_GAP_SEC before the later one. */
function countOverlaps(items: readonly Timed[]): number {
  const byPitch = new Map<number, Timed[]>();
  for (const n of items) {
    const list = byPitch.get(n.pitch);
    if (list) list.push(n);
    else byPitch.set(n.pitch, [n]);
  }
  let overlaps = 0;
  for (const list of byPitch.values()) {
    list.sort((a, b) => a.time - b.time);
    for (let i = 1; i < list.length; i++) {
      if (list[i - 1].time + list[i - 1].duration > list[i].time - MIN_SAME_PITCH_GAP_SEC + EPS) overlaps++;
    }
  }
  return overlaps;
}

export function validatePiece(piece: Piece): PieceReport {
  const errors: string[] = [];
  const fail = (msg: string): void => {
    if (errors.length < MAX_ERRORS) errors.push(msg);
  };
  const { params, notes, pad, pedal, chords, sections, beatTimes, barTimes, bars } = piece;
  const totalBeats = bars * BEATS_PER_BAR;

  // Params and scale.
  if (JSON.stringify(normalizeParams(params)) !== JSON.stringify(params)) fail('params are not normalised');
  const scale = scalePitchClasses(params.key, params.mode);
  if (piece.scale.length !== scale.length || piece.scale.some((pc, i) => pc !== scale[i])) {
    fail('scale does not match key and mode');
  }
  if (piece.beatsPerBar !== BEATS_PER_BAR) fail('beatsPerBar is not 4');
  if (!Number.isInteger(bars) || bars < 1) fail(`bad bar count ${bars}`);

  // Tempo map.
  if (beatTimes.length !== totalBeats + 1) fail(`beatTimes has ${beatTimes.length} entries, expected ${totalBeats + 1}`);
  if (!(beatTimes[0] >= 0.05)) fail(`lead-in ${beatTimes[0]} s is below 0.05 s`);
  for (let i = 1; i < beatTimes.length; i++) {
    if (!(beatTimes[i] > beatTimes[i - 1])) {
      fail(`beatTimes not strictly increasing at beat ${i}`);
      break;
    }
  }
  if (barTimes.length !== bars + 1) fail(`barTimes has ${barTimes.length} entries, expected ${bars + 1}`);
  for (let b = 0; b < barTimes.length; b++) {
    if (barTimes[b] !== beatTimes[b * BEATS_PER_BAR]) {
      fail(`barTimes[${b}] differs from beatTimes[${b * BEATS_PER_BAR}]`);
      break;
    }
  }
  if (!(piece.durationSec > 0) || !Number.isFinite(piece.durationSec)) fail(`bad durationSec ${piece.durationSec}`);
  if (
    !Number.isFinite(piece.humanizeMs) ||
    piece.humanizeMs < HUMANIZE_MIN_MS ||
    piece.humanizeMs > HUMANIZE_MAX_MS
  ) {
    fail(`humanizeMs ${piece.humanizeMs} outside ${HUMANIZE_MIN_MS}..${HUMANIZE_MAX_MS}`);
  }

  // Sections: A, B, A2 covering every bar.
  if (sections.length !== SECTION_ORDER.length || sections.some((s, i) => s.name !== SECTION_ORDER[i])) {
    fail(`sections are ${sections.map((s) => s.name).join(',')}, expected A,B,A2`);
  }
  let cursor = 0;
  for (const s of sections) {
    if (s.startBar !== cursor) fail(`section ${s.name} starts at bar ${s.startBar}, expected ${cursor}`);
    if (!Number.isInteger(s.bars) || s.bars < 1) fail(`section ${s.name} has ${s.bars} bars`);
    if (s.startTime !== barTimes[s.startBar] || s.endTime !== barTimes[s.startBar + s.bars]) {
      fail(`section ${s.name} times do not match the bar lines`);
    }
    cursor = s.startBar + s.bars;
  }
  if (cursor !== bars) fail(`sections cover ${cursor} bars of ${bars}`);
  const sectionOfBar = (bar: number): SectionName | null => {
    for (const s of sections) {
      if (bar >= s.startBar && bar < s.startBar + s.bars) return s.name;
    }
    return null;
  };

  // Chords: cover every bar, 2-4 bars each (the last chord of a section may be 1-4), all tones in scale.
  cursor = 0;
  chords.forEach((c, i) => {
    if (c.startBar !== cursor) fail(`chord ${i} starts at bar ${c.startBar}, expected ${cursor}`);
    const section = sections.find((s) => s.name === c.section);
    const lastOfSection = section !== undefined && c.startBar + c.bars === section.startBar + section.bars;
    if (!Number.isInteger(c.bars) || c.bars > 4 || c.bars < (lastOfSection ? 1 : 2)) {
      fail(`chord ${i} (${c.name}) lasts ${c.bars} bars`);
    }
    if (!section || c.startBar < section.startBar || c.startBar + c.bars > section.startBar + section.bars) {
      fail(`chord ${i} (${c.name}) is not inside its section ${c.section}`);
    }
    if (c.degree < 0 || c.degree >= scale.length || scale[c.degree] !== c.root) {
      fail(`chord ${i} (${c.name}): root ${c.root} is not scale degree ${c.degree}`);
    }
    if (c.pitchClasses.length < 3 || c.pitchClasses[0] !== c.root) fail(`chord ${i} (${c.name}): bad chord tones`);
    if (c.pitchClasses.some((pc) => !scale.includes(pc))) fail(`chord ${i} (${c.name}) has tones outside the scale`);
    if (!c.name) fail(`chord ${i} has no name`);
    if (c.startTime !== barTimes[c.startBar] || c.endTime !== barTimes[c.startBar + c.bars]) {
      fail(`chord ${i} (${c.name}) times do not match the bar lines`);
    }
    cursor = c.startBar + c.bars;
  });
  if (cursor !== bars) fail(`chords cover ${cursor} bars of ${bars}`);
  const chordOfBar = (bar: number) => chords.find((c) => bar >= c.startBar && bar < c.startBar + c.bars);

  // Piano notes.
  let outOfScale = 0;
  let stuck = 0;
  const onsetsPerBar = new Array<number>(Math.max(0, bars)).fill(0);
  const bound = piece.humanizeMs / 1000;
  notes.forEach((n, i) => {
    const tag = `note ${i} (pitch ${n.pitch}, beat ${n.startBeat})`;
    if (n.id !== i) fail(`${tag}: id ${n.id} is not its index`);
    if (i > 0) {
      const p = notes[i - 1];
      if (n.time < p.time || (n.time === p.time && n.pitch < p.pitch)) fail(`${tag}: notes not sorted by time, pitch`);
    }
    if (!Number.isInteger(n.pitch) || n.pitch < PITCH_MIN || n.pitch > PITCH_MAX) {
      fail(`${tag}: pitch outside ${PITCH_MIN}..${PITCH_MAX}`);
    }
    if (!scale.includes(pitchClass(n.pitch))) {
      outOfScale++;
      fail(`${tag}: not in the scale`);
    }
    if (!Number.isInteger(n.velocity) || n.velocity < 1 || n.velocity > 127) fail(`${tag}: velocity ${n.velocity}`);
    if (!ROLES.includes(n.role)) fail(`${tag}: unknown role ${n.role}`);
    if (!(n.startBeat >= 0) || !(n.startBeat < totalBeats)) fail(`${tag}: startBeat outside the piece`);
    if (!(n.durBeats > 0)) fail(`${tag}: durBeats ${n.durBeats}`);
    if (!(n.time >= 0)) fail(`${tag}: time ${n.time}`);
    if (!(n.duration > 0) || !Number.isFinite(n.duration)) {
      stuck++;
      fail(`${tag}: duration ${n.duration}`);
    } else if (n.time + n.duration > piece.durationSec + EPS) {
      stuck++;
      fail(`${tag}: ends at ${n.time + n.duration} s, after durationSec ${piece.durationSec}`);
    }
    if (Math.abs(n.time - beatToTime(beatTimes, n.startBeat)) > bound + EPS) {
      fail(`${tag}: onset is more than ${piece.humanizeMs} ms away from its beat`);
    }
    const bar = Math.floor(n.startBeat / BEATS_PER_BAR);
    if (bar >= 0 && bar < bars) {
      onsetsPerBar[bar]++;
      if (sectionOfBar(bar) !== n.section) fail(`${tag}: section ${n.section} does not match bar ${bar}`);
      const chord = chordOfBar(bar);
      if (chord) {
        const inChord = chord.pitchClasses.includes(pitchClass(n.pitch));
        if (n.passing && inChord) fail(`${tag}: marked passing but is a tone of ${chord.name}`);
        if (!n.passing && !inChord) fail(`${tag}: not a tone of ${chord.name} and not marked passing`);
        if (n.passing && n.role !== 'melody') fail(`${tag}: passing tone outside the melody`);
      }
    }
  });
  const overlaps = countOverlaps(notes);
  if (overlaps > 0) fail(`${overlaps} overlapping piano notes of the same pitch`);

  // Pad.
  if (pad.length === 0) fail('pad is empty');
  pad.forEach((n, i) => {
    const tag = `pad note ${i} (pitch ${n.pitch})`;
    if (i > 0) {
      const p = pad[i - 1];
      if (n.time < p.time || (n.time === p.time && n.pitch < p.pitch)) fail(`${tag}: pad not sorted by time, pitch`);
    }
    if (!Number.isInteger(n.pitch) || n.pitch < PITCH_MIN || n.pitch > PITCH_MAX) {
      fail(`${tag}: pitch outside ${PITCH_MIN}..${PITCH_MAX}`);
    }
    if (!scale.includes(pitchClass(n.pitch))) {
      outOfScale++;
      fail(`${tag}: not in the scale`);
    }
    if (!Number.isInteger(n.velocity) || n.velocity < 1 || n.velocity > 127) fail(`${tag}: velocity ${n.velocity}`);
    if (!(n.time >= 0)) fail(`${tag}: time ${n.time}`);
    if (!(n.duration > 0) || !Number.isFinite(n.duration)) {
      stuck++;
      fail(`${tag}: duration ${n.duration}`);
    } else if (n.time + n.duration > piece.durationSec + EPS) {
      stuck++;
      fail(`${tag}: ends after durationSec`);
    }
  });
  const padOverlaps = countOverlaps(pad);
  if (padOverlaps > 0) fail(`${padOverlaps} overlapping pad notes of the same pitch`);

  // Pedal: down, up, down, ... up; in order; nothing after the end.
  if (pedal.length === 0 || pedal.length % 2 !== 0) fail(`pedal has ${pedal.length} events`);
  pedal.forEach((e, i) => {
    if (e.down !== (i % 2 === 0)) fail(`pedal event ${i} does not alternate`);
    if (i > 0 && !(e.time > pedal[i - 1].time)) fail(`pedal event ${i} is not after the one before`);
    if (!(e.time >= 0) || e.time > piece.durationSec + EPS) fail(`pedal event ${i} at ${e.time} s is outside the piece`);
  });
  if (pedal.length > 0 && pedal[pedal.length - 1].down) fail('pedal does not end up');

  // Density and silence.
  const measuredDensity = bars > 0 ? notes.length / bars : 0;
  let silentBars = 0;
  for (const c of onsetsPerBar) {
    if (c === 0) silentBars++;
  }
  const measuredRestRatio = bars > 0 ? silentBars / bars : 0;
  const tolerance = densityTolerance(params.density);
  if (Math.abs(measuredDensity - params.density) > tolerance + EPS) {
    fail(
      `density ${measuredDensity.toFixed(3)} is more than ${tolerance.toFixed(3)} away from the target ${params.density}`,
    );
  }
  if (bars > 0 && onsetsPerBar[0] === 0) fail('bar 0 has no piano onset');

  return {
    ok: errors.length === 0,
    errors,
    measuredDensity,
    measuredRestRatio,
    noteCount: notes.length,
    outOfScale,
    overlaps: overlaps + padOverlaps,
    stuck,
  };
}
