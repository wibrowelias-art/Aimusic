/**
 * Offline render of a whole piece including its tail, as mix + three stems.
 *
 * One OfflineAudioContext with a 6-channel destination carries the three
 * stereo stems side by side (piano 0/1, pad 2/3, noise 4/5); the mix is the
 * sample-wise sum of the stems. If a 6-channel context is not available the
 * stems are rendered one after the other in stereo contexts instead.
 * The master is linear: one common gain (normalisation) and one common fade.
 */
import type { Piece } from '../engine/types';
import {
  END_FADE_SEC,
  NORMALIZE_MAX_BOOST_DB,
  NORMALIZE_PEAK_DB,
  NORMALIZE_STEM_CEILING_DB,
  SAMPLE_RATE,
} from './constants';
import { dbToGain, gainToDb } from './dsp';
import { buildGraph, totalSecFor } from './graph';
import { buildNoiseLoop } from './noise';
import { buildReverbIR } from './reverb';
import { loadPianoSamples, type PianoSampleSet } from './sampler';
import {
  STEM_NAMES,
  type OfflineContextFactory,
  type RenderResult,
  type SampleFetcher,
  type SampleManifest,
  type StemName,
  type StereoPcm,
} from './types';

export interface RenderDeps {
  createContext: OfflineContextFactory;
  fetchSample: SampleFetcher;
  manifest: SampleManifest;
  /** Hz. Default 48000. */
  sampleRate?: number;
  /** Already decoded samples (skips fetching and decoding). */
  samples?: PianoSampleSet;
}

type Stems = Record<StemName, StereoPcm>;

function takeStereo(buffer: AudioBuffer, first: number, frames: number): StereoPcm {
  const pick = (index: number): Float32Array => {
    const out = new Float32Array(frames);
    if (index < buffer.numberOfChannels) out.set(buffer.getChannelData(index).subarray(0, frames));
    return out;
  };
  return [pick(first), pick(first + 1)];
}

/** All three stems in one render: stem k goes to destination channels 2k and 2k + 1. */
async function renderMerged(
  ctx: OfflineAudioContext,
  piece: Piece,
  samples: PianoSampleSet,
  totalSec: number,
  frames: number,
): Promise<Stems | null> {
  const graph = buildGraph(ctx, piece, samples, { startTime: 0, totalSec });
  // Merger output and destination both have 6 channels, so nothing is up- or down-mixed.
  const merger = ctx.createChannelMerger(2 * STEM_NAMES.length);
  STEM_NAMES.forEach((name, k) => {
    const splitter = ctx.createChannelSplitter(2);
    graph.stems[name].connect(splitter);
    splitter.connect(merger, 0, 2 * k);
    splitter.connect(merger, 1, 2 * k + 1);
  });
  merger.connect(ctx.destination);
  graph.scheduleAll();
  const rendered = await ctx.startRendering();
  if (rendered.numberOfChannels < 2 * STEM_NAMES.length) return null;
  const stems = {} as Stems;
  STEM_NAMES.forEach((name, k) => {
    stems[name] = takeStereo(rendered, 2 * k, frames);
  });
  return stems;
}

/** Fallback: one stereo render per stem. */
async function renderSeparately(
  deps: RenderDeps,
  piece: Piece,
  samples: PianoSampleSet | undefined,
  totalSec: number,
  frames: number,
  sampleRate: number,
): Promise<Stems> {
  const reverbIR = buildReverbIR(sampleRate, piece.params.reverbSize);
  const noiseLoop = buildNoiseLoop(sampleRate, {
    lofi: piece.params.lofi,
    rain: piece.params.rain,
    seed: piece.params.seed,
  });
  const stems = {} as Stems;
  let set = samples;
  for (const name of STEM_NAMES) {
    const ctx = deps.createContext(2, frames, sampleRate);
    set ??= await loadPianoSamples(ctx, deps.fetchSample, deps.manifest);
    const graph = buildGraph(ctx, piece, set, { startTime: 0, totalSec, stems: [name], reverbIR, noiseLoop });
    graph.stems[name].connect(ctx.destination);
    graph.scheduleAll();
    stems[name] = takeStereo(await ctx.startRendering(), 0, frames);
  }
  return stems;
}

export async function renderPiece(piece: Piece, deps: RenderDeps): Promise<RenderResult> {
  const sampleRate = deps.sampleRate ?? SAMPLE_RATE;
  const totalSec = totalSecFor(piece);
  const frames = Math.ceil(totalSec * sampleRate);
  const channelsWanted = 2 * STEM_NAMES.length;

  let merged: OfflineAudioContext | null = null;
  try {
    merged = deps.createContext(channelsWanted, frames, sampleRate);
    if (merged.destination.maxChannelCount < channelsWanted) merged = null;
  } catch {
    merged = null;
  }
  let samples = deps.samples;
  let stems: Stems | null = null;
  if (merged) {
    samples ??= await loadPianoSamples(merged, deps.fetchSample, deps.manifest);
    stems = await renderMerged(merged, piece, samples, totalSec, frames);
  }
  stems ??= await renderSeparately(deps, piece, samples, totalSec, frames, sampleRate);

  // Common fade to digital silence over the last END_FADE_SEC.
  const fade = Math.min(frames, Math.round(END_FADE_SEC * sampleRate));
  for (const name of STEM_NAMES) {
    for (const ch of stems[name]) {
      for (let i = 0; i < fade; i++) {
        ch[frames - fade + i] *= 0.5 + 0.5 * Math.cos((Math.PI * (i + 1)) / fade);
      }
      if (frames > 0) ch[frames - 1] = 0;
    }
  }

  // One common gain: the MIX peaks at NORMALIZE_PEAK_DB, boost capped. A single
  // stem can in theory peak above the mix (when another stem cancels it there),
  // so no stem may go above NORMALIZE_STEM_CEILING_DB either.
  let peak = 0;
  let stemPeak = 0;
  for (let c = 0; c < 2; c++) {
    const a = stems.piano[c];
    const b = stems.pad[c];
    const n = stems.noise[c];
    for (let i = 0; i < frames; i++) {
      const v = Math.abs(a[i] + b[i] + n[i]);
      if (v > peak) peak = v;
      const s = Math.max(Math.abs(a[i]), Math.abs(b[i]), Math.abs(n[i]));
      if (s > stemPeak) stemPeak = s;
    }
  }
  let gain = 1;
  if (peak > 0 && Number.isFinite(peak) && Number.isFinite(stemPeak)) {
    gain = Math.min(
      dbToGain(NORMALIZE_PEAK_DB) / peak,
      dbToGain(NORMALIZE_STEM_CEILING_DB) / stemPeak,
      dbToGain(NORMALIZE_MAX_BOOST_DB),
    );
  }
  const mix: StereoPcm = [new Float32Array(frames), new Float32Array(frames)];
  for (let c = 0; c < 2; c++) {
    const a = stems.piano[c];
    const b = stems.pad[c];
    const n = stems.noise[c];
    const m = mix[c];
    for (let i = 0; i < frames; i++) {
      a[i] *= gain;
      b[i] *= gain;
      n[i] *= gain;
      m[i] = a[i] + b[i] + n[i];
    }
  }

  return {
    sampleRate,
    length: frames,
    mix,
    stems,
    gainDb: gainToDb(gain),
    musicEndSec: piece.durationSec,
  };
}
