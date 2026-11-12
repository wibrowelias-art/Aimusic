/** Public API of the sound engine. */
export * from './types';
export * from './constants';
export { dbToGain, gainToDb, midiToHz, peakAbs, peakDb, rms, rmsDb } from './dsp';
export { buildReverbIR, measureRt60, reverbIRLength } from './reverb';
export { buildNoiseLoop, hissRmsDb, rainRmsDb, type NoiseLoopOptions } from './noise';
export { encodeWav, WAV_HEADER_BYTES, type WavOptions } from './wav';
export {
  computeLevelCorrections,
  detectOnsetFrame,
  loadPianoSamples,
  nearestSample,
  type PianoSample,
  type PianoSampleSet,
} from './sampler';
export {
  buildGraph,
  createWobble,
  lofiCutoffHz,
  planReleases,
  startPadVoice,
  startPianoVoice,
  tailSecFor,
  totalSecFor,
  velocityGain,
  voiceCutoffHz,
  wobbleDepthCents,
  type GraphOptions,
  type PadVoiceSpec,
  type PianoVoiceSpec,
  type PieceGraph,
  type ReleasePlan,
  type Voice,
  type Wobble,
} from './graph';
export { renderPiece, type RenderDeps } from './render';
export { fetchManifest, PIANO_SAMPLE_BASE_URL, urlSampleFetcher } from './fetch';
export { limiterMakeupDb, Player, type PlayOptions } from './player';
