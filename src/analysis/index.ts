/**
 * Measurement library: numbers for rendered audio (levels, silence, spectrum, RT60,
 * pitch deviation) and the checks against AUDIO_TARGETS. Pure and deterministic:
 * plain Float32Array in, numbers out, no Web Audio, no randomness.
 *
 * Typical use on a render (stems are [left, right] pairs):
 *
 *   const mix = measureAudio(render.mix, sampleRate, { musicEndSec });
 *   const tailSec = tailSecAfter(sumChannels(stems.piano, stems.pad), sampleRate, musicEndSec);
 *   const pianoSilenceRatio = silenceRatio(stems.piano, sampleRate);
 *   const rt60Sec = measureRt60(impulseResponse, sampleRate);
 *   const check = checkAgainstTargets(mix, { tailSec, pianoSilenceRatio, rt60Sec, requestedRt60Sec });
 *   const row = formatMetricsRow('Warm, seed 42', mix); // goes under METRICS_TABLE_HEADER
 */
export * from './types';
export * from './targets';
export * from './fft';
export * from './metrics';
export * from './reference';
export * from './loudness';
export * from './rhythm';
