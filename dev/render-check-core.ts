/**
 * One fixed take, rendered and measured. Runs unchanged in the browser (real
 * OfflineAudioContext + fetch) and in Node (node-web-audio-api + fs), so that
 * `npm run check:browser` can put the two engines side by side.
 */
import { measureAudio, rmsDb, silenceRatio } from '../src/analysis';
import { renderPiece, type RenderDeps } from '../src/audio/render';
import { generate } from '../src/engine/compose';
import { normalizeParams, presetCenter } from '../src/engine/params';
import { validatePiece } from '../src/engine/validate';

/** Warm preset centre, seed 1, key F, about 30 s. */
export const CHECK_PARAMS = normalizeParams({ ...presetCenter('warm', { seed: 1, key: 5 }), length: 30 });

export interface RenderCheckNumbers {
  notes: number;
  validationErrors: string[];
  fileSec: number;
  gainDb: number;
  peakDb: number;
  rmsDb: number;
  clippedSamples: number;
  centroidHz: number;
  pianoRmsDb: number;
  padRmsDb: number;
  noiseRmsDb: number;
  pianoSilenceRatio: number;
  /** Largest |difference| between the stems summed and the mix. */
  stemSumError: number;
  /** Largest |difference| between two renders of the same take (-1 when the lengths differ). */
  repeatMaxDiff: number;
  /** Wall-clock seconds of the first render. */
  renderSec: number;
}

export async function runRenderCheck(deps: RenderDeps): Promise<RenderCheckNumbers> {
  const piece = generate(CHECK_PARAMS);
  const report = validatePiece(piece);
  const t0 = performance.now();
  const a = await renderPiece(piece, deps);
  const renderSec = (performance.now() - t0) / 1000;
  const b = await renderPiece(piece, deps);

  let stemSumError = 0;
  let repeatMaxDiff = a.length === b.length ? 0 : -1;
  for (let ch = 0; ch < 2; ch++) {
    for (let i = 0; i < a.length; i++) {
      const sum = a.stems.piano[ch][i] + a.stems.pad[ch][i] + a.stems.noise[ch][i];
      stemSumError = Math.max(stemSumError, Math.abs(sum - a.mix[ch][i]));
      if (repeatMaxDiff >= 0) repeatMaxDiff = Math.max(repeatMaxDiff, Math.abs(a.mix[ch][i] - b.mix[ch][i]));
    }
  }
  const mix = measureAudio(a.mix, a.sampleRate, { musicEndSec: a.musicEndSec });
  return {
    notes: piece.notes.length,
    validationErrors: report.errors,
    fileSec: a.length / a.sampleRate,
    gainDb: a.gainDb,
    peakDb: mix.peakDb,
    rmsDb: mix.rmsDb,
    clippedSamples: mix.clippedSamples,
    centroidHz: mix.spectralCentroidHz,
    pianoRmsDb: rmsDb(a.stems.piano),
    padRmsDb: rmsDb(a.stems.pad),
    noiseRmsDb: rmsDb(a.stems.noise),
    pianoSilenceRatio: silenceRatio(a.stems.piano, a.sampleRate),
    stemSumError,
    repeatMaxDiff,
    renderSec,
  };
}
