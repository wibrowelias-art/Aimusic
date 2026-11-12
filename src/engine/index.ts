/**
 * Public API of the composer.
 *
 *   generate(params)      -> Piece        seeded, pure, deterministic
 *   validatePiece(piece)  -> PieceReport  the hard checks
 *   pieceToMidi(piece)    -> Uint8Array   Standard MIDI File, format 1, 480 PPQ
 *   scoreTime(piece, b)   -> seconds      beat -> performed time via the tempo map
 */
export * from './types';
export * from './params';
export { createRng, hashString, Rng } from './rng';
export {
  buildChord,
  CHARACTERISTIC_INTERVAL,
  CHORD_QUALITIES,
  chordName,
  chordOptions,
  chordPitchClasses,
  indexAtOrBelow,
  isInScale,
  makeScale,
  nearestIndex,
  pitchClass,
  pitchName,
  pitchOfIndex,
  scalePitchClasses,
  type ChordInfo,
  type ChordQuality,
  type Scale,
} from './theory';
export {
  dropMotifNotes,
  inventMotif,
  MOTIF_MAX_NOTES,
  MOTIF_MAX_SPAN,
  MOTIF_MIN_NOTES,
  motifIntervals,
  motifOnsets,
  motifOnsetSpan,
  motifPitches,
  motifSpan,
  octaveShiftMotif,
  stretchMotif,
  transposeMotif,
} from './motif';
export { MIN_BARS } from './harmony';
export { HARD_BAR_CAP, PLAN_BAR_CAP } from './layout';
export { MELODY_FLOOR, MELODY_HALF_RANGE } from './melody';
export { MUD_LIMIT, MUD_MIN_INTERVAL } from './accompany';
export {
  beatToTime,
  HUMANIZE_MAX_MS,
  HUMANIZE_MIN_MS,
  LEAD_IN_SEC,
  PAD_HIGH,
  PAD_LOW,
  VELOCITY_MAX,
  VELOCITY_MIN,
} from './perform';
export { barCount, generate, melodyRange, PASSING_SHARE, scoreTime } from './compose';
export { DENSITY_TOLERANCE, densityTolerance, MIN_SAME_PITCH_GAP_SEC, validatePiece } from './validate';
export {
  encodeVlq,
  MIDI_PAD_CHANNEL,
  MIDI_PAD_PROGRAM,
  MIDI_PIANO_CHANNEL,
  MIDI_PIANO_PROGRAM,
  MIDI_PPQ,
  pieceToMidi,
  secondsToTicks,
} from './midi';
