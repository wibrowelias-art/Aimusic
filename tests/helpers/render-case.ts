/**
 * Shared by the render checks (npm test) and the measure run (npm run measure):
 * generate a piece, render it offline with node-web-audio-api and measure it.
 */
import {
  measureAudio,
  measureRt60,
  silenceRatio,
  sumChannels,
  tailSecAfter,
  type AudioMetrics,
} from '../../src/analysis';
import { REVERB_REF_BAND_HZ, SAMPLE_RATE } from '../../src/audio/constants';
import { renderPiece } from '../../src/audio/render';
import { buildReverbIR } from '../../src/audio/reverb';
import type { RenderResult } from '../../src/audio/types';
import { generate } from '../../src/engine/compose';
import { normalizeParams, presetCenter, PRESET_NAMES, type PresetName } from '../../src/engine/params';
import type { Params, Piece, PieceReport } from '../../src/engine/types';
import { validatePiece } from '../../src/engine/validate';
import { createContext, fetchSample, loadSamples, manifest } from '../fixtures/audio';

export interface CaseResult {
  label: string;
  params: Params;
  piece: Piece;
  report: PieceReport;
  render: RenderResult;
  /** Metrics of the stereo mix. */
  mix: AudioMetrics;
  /** Share of 50 ms frames of the piano stem below -50 dBFS. */
  pianoSilenceRatio: number;
  /** Seconds from the last release (piece.durationSec) until piano + pad stay below -60 dBFS. */
  tailSec: number;
  /** Seconds from the last piano onset until piano + pad stay below -60 dBFS. */
  ringOutSec: number;
  /** Seconds at the end of the file where piano + pad are already below -60 dBFS. */
  deadEndSec: number;
  /** RT60 of the impulse response in the 500-1000 Hz band (T30), seconds. */
  rt60MidSec: number;
  /** Broadband RT60 of the impulse response (T30), seconds. */
  rt60BroadSec: number;
  /** Wall-clock seconds of the offline render. */
  renderSec: number;
}

/** Preset centre with a fixed, spread-out key per (preset, seed); `overrides` win over the preset. */
export function presetCase(preset: PresetName, seed: number, overrides: Partial<Params> = {}): Params {
  const presetIndex = PRESET_NAMES.indexOf(preset);
  const key = (seed * 5 + presetIndex * 3) % 12;
  return normalizeParams({ ...presetCenter(preset, { seed, key }), ...overrides });
}

const rt60Cache = new Map<number, { mid: number; broad: number }>();

export function irRt60(reverbSize: number): { mid: number; broad: number } {
  let hit = rt60Cache.get(reverbSize);
  if (!hit) {
    const ir = buildReverbIR(SAMPLE_RATE, reverbSize);
    hit = {
      mid: measureRt60(ir, SAMPLE_RATE, { bandHz: REVERB_REF_BAND_HZ }),
      broad: measureRt60(ir, SAMPLE_RATE),
    };
    rt60Cache.set(reverbSize, hit);
  }
  return hit;
}

export async function renderCase(label: string, params: Params): Promise<CaseResult> {
  const piece = generate(params);
  const report = validatePiece(piece);
  const samples = await loadSamples();
  const t0 = performance.now();
  const render = await renderPiece(piece, { createContext, fetchSample, manifest, samples });
  const renderSec = (performance.now() - t0) / 1000;

  const sr = render.sampleRate;
  const mix = measureAudio(render.mix, sr, { musicEndSec: render.musicEndSec });
  const music = sumChannels(render.stems.piano, render.stems.pad);
  const tailSec = tailSecAfter(music, sr, render.musicEndSec);
  const lastOnset = piece.notes.reduce((m, n) => Math.max(m, n.time), 0);
  const ringOutSec = tailSecAfter(music, sr, lastOnset);
  const deadEndSec = render.length / sr - (render.musicEndSec + tailSec);
  const rt60 = irRt60(piece.params.reverbSize);

  return {
    label,
    params: piece.params,
    piece,
    report,
    render,
    mix,
    pianoSilenceRatio: silenceRatio(render.stems.piano, sr),
    tailSec,
    ringOutSec,
    deadEndSec,
    rt60MidSec: rt60.mid,
    rt60BroadSec: rt60.broad,
    renderSec,
  };
}
