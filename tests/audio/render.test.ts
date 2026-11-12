import { beforeAll, describe, expect, it } from 'vitest';
import { END_FADE_SEC, NORMALIZE_MAX_BOOST_DB, NORMALIZE_PEAK_DB, SAMPLE_RATE } from '../../src/audio/constants';
import { peakAbs, peakDb, rmsDb } from '../../src/audio/dsp';
import { buildGraph, tailSecFor, totalSecFor } from '../../src/audio/graph';
import { renderPiece } from '../../src/audio/render';
import type { PianoSampleSet } from '../../src/audio/sampler';
import { STEM_NAMES, type OfflineContextFactory, type RenderResult } from '../../src/audio/types';
import { AUDIO_TARGETS } from '../../src/analysis/targets';
import { MODE_INTERVALS, PITCH_MAX, PITCH_MIN } from '../../src/engine/params';
import { createContext, fetchSample, loadSamples, manifest } from '../fixtures/audio';
import { makeFixturePiece } from '../fixtures/piece';

const SR = SAMPLE_RATE;
const db = (v: number): string => (Number.isFinite(v) ? v.toFixed(2) : '-inf');

function maxAbsDiff(a: Float32Array, b: Float32Array): number {
  let max = Math.abs(a.length - b.length) > 0 ? Infinity : 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > max) max = d;
  }
  return max;
}

describe('fixture piece', () => {
  it('is a complete, well-formed Piece of about 25 s', () => {
    const piece = makeFixturePiece();
    const scale = MODE_INTERVALS[piece.params.mode].map((iv) => (piece.params.key + iv) % 12);
    expect(piece.durationSec).toBeGreaterThan(20);
    expect(piece.durationSec).toBeLessThan(30);
    expect(piece.notes.length).toBeGreaterThan(10);
    expect(piece.chords.length).toBe(3);
    expect(piece.pad.length).toBeGreaterThan(0);
    expect(piece.pedal.length).toBeGreaterThan(0);
    expect(piece.pedal[0].down).toBe(true);
    expect(piece.pedal[piece.pedal.length - 1].down).toBe(false);
    expect(piece.beatTimes).toHaveLength(piece.bars * 4 + 1);
    expect(piece.barTimes).toHaveLength(piece.bars + 1);
    piece.notes.forEach((n, i) => {
      expect(n.id).toBe(i);
      expect(scale).toContain(n.pitch % 12);
      expect(n.pitch).toBeGreaterThanOrEqual(PITCH_MIN);
      expect(n.pitch).toBeLessThanOrEqual(PITCH_MAX);
      expect(n.duration).toBeGreaterThan(0);
      if (i > 0) expect(n.time).toBeGreaterThanOrEqual(piece.notes[i - 1].time);
    });
    // Same options, same piece.
    expect(makeFixturePiece()).toEqual(piece);
  });
});

describe('renderPiece', () => {
  let samples: PianoSampleSet;
  let full: RenderResult;
  let again: RenderResult;
  let bare: RenderResult;
  let fullMs = 0;
  const piece = makeFixturePiece();
  const barePiece = makeFixturePiece({ pad: 0, lofi: 0, rain: 0 });

  beforeAll(async () => {
    samples = await loadSamples();
    const deps = { createContext, fetchSample, manifest, samples };
    const t0 = performance.now();
    full = await renderPiece(piece, deps);
    fullMs = performance.now() - t0;
    again = await renderPiece(piece, deps);
    bare = await renderPiece(barePiece, deps);
  });

  it('reports its numbers', () => {
    const seconds = full.length / full.sampleRate;
    const lines = [
      `fixture: ${piece.notes.length} notes, ${piece.pad.length} pad notes, music ${piece.durationSec.toFixed(2)} s + tail ${tailSecFor(piece.params.reverbSize).toFixed(2)} s = ${seconds.toFixed(2)} s (lofi ${piece.params.lofi}, pad ${piece.params.pad}, rain ${piece.params.rain}, reverb ${piece.params.reverbSize} s)`,
      `render time: ${fullMs.toFixed(0)} ms = ${(fullMs / seconds).toFixed(1)} ms per second of audio (${(seconds / (fullMs / 1000)).toFixed(1)}x realtime, node-web-audio-api)`,
      `normalisation gain: ${db(full.gainDb)} dB`,
      `mix:   peak ${db(peakDb(full.mix))} dBFS, RMS ${db(rmsDb(full.mix))} dBFS`,
      ...STEM_NAMES.map(
        (name) =>
          `${name.padEnd(5)}: peak ${db(peakDb(full.stems[name]))} dBFS, RMS ${db(rmsDb(full.stems[name]))} dBFS (before normalisation: peak ${db(peakDb(full.stems[name]) - full.gainDb)}, RMS ${db(rmsDb(full.stems[name]) - full.gainDb)})`,
      ),
      `bare (pad 0, lofi 0, rain 0): gain ${db(bare.gainDb)} dB, mix peak ${db(peakDb(bare.mix))}, RMS ${db(rmsDb(bare.mix))} dBFS`,
    ];
    console.log(lines.join('\n'));
    expect(full.sampleRate).toBe(SR);
  });

  it('has the documented length and metadata', () => {
    expect(full.sampleRate).toBe(48000);
    expect(full.length).toBe(Math.ceil(totalSecFor(piece) * SR));
    expect(full.musicEndSec).toBe(piece.durationSec);
    for (const ch of [...full.mix, ...STEM_NAMES.flatMap((n) => full.stems[n])]) {
      expect(ch).toBeInstanceOf(Float32Array);
      expect(ch.length).toBe(full.length);
    }
  });

  it('peaks between -6 and -1 dBFS with zero clipped samples and no NaN', () => {
    for (const result of [full, bare]) {
      const peak = peakDb(result.mix);
      expect(peak).toBeLessThanOrEqual(AUDIO_TARGETS.peakDb.max);
      expect(peak).toBeGreaterThanOrEqual(AUDIO_TARGETS.peakDb.min);
      expect(peak).toBeCloseTo(NORMALIZE_PEAK_DB, 2);
      expect(result.gainDb).toBeLessThanOrEqual(NORMALIZE_MAX_BOOST_DB);
      for (const ch of [...result.mix, ...STEM_NAMES.flatMap((n) => result.stems[n])]) {
        let clipped = 0;
        let bad = 0;
        for (let i = 0; i < ch.length; i++) {
          if (!Number.isFinite(ch[i])) bad++;
          else if (Math.abs(ch[i]) >= 0.999) clipped++;
        }
        expect(bad).toBe(0);
        expect(clipped).toBe(0);
      }
    }
  });

  it('stems sum to the mix', () => {
    for (const result of [full, bare]) {
      let maxErr = 0;
      for (let c = 0; c < 2; c++) {
        const sum = new Float32Array(result.length);
        for (const name of STEM_NAMES) {
          const ch = result.stems[name][c];
          for (let i = 0; i < sum.length; i++) sum[i] += ch[i];
        }
        maxErr = Math.max(maxErr, maxAbsDiff(sum, result.mix[c]));
      }
      expect(maxErr).toBeLessThan(1e-4);
    }
  });

  it('every stem carries signal when its parameter is on, in stereo', () => {
    // Sane levels before normalisation (a runaway envelope would show here).
    expect(full.gainDb).toBeGreaterThan(0);
    expect(peakDb(full.stems.pad) - full.gainDb).toBeLessThan(-12);
    for (const name of STEM_NAMES) {
      expect(rmsDb(full.stems[name])).toBeGreaterThan(-70);
      expect(peakAbs([full.stems[name][0]])).toBeGreaterThan(0);
      expect(peakAbs([full.stems[name][1]])).toBeGreaterThan(0);
      expect(maxAbsDiff(full.stems[name][0], full.stems[name][1])).toBeGreaterThan(0);
    }
  });

  it('pad stem is digital silence at pad 0, noise stem at lofi 0 and rain 0', () => {
    expect(peakAbs(bare.stems.pad)).toBe(0);
    expect(peakAbs(bare.stems.noise)).toBe(0);
    expect(peakAbs(bare.stems.piano)).toBeGreaterThan(0.5);
    expect(maxAbsDiff(bare.stems.piano[0], bare.mix[0])).toBe(0);
  });

  it('is deterministic', () => {
    let maxErr = 0;
    for (let c = 0; c < 2; c++) {
      maxErr = Math.max(maxErr, maxAbsDiff(full.mix[c], again.mix[c]));
      for (const name of STEM_NAMES) maxErr = Math.max(maxErr, maxAbsDiff(full.stems[name][c], again.stems[name][c]));
    }
    console.log(`determinism: max |difference| between two renders ${maxErr.toExponential(2)}, gain ${db(full.gainDb)} / ${db(again.gainDb)} dB`);
    expect(maxErr).toBeLessThan(1e-6);
    expect(again.gainDb).toBeCloseTo(full.gainDb, 6);
  });

  it('ends at digital silence, with the tails below -60 dBFS before the final fade', () => {
    const fadeFrames = Math.round(END_FADE_SEC * SR);
    for (const result of [full, bare]) {
      const n = result.length;
      for (const ch of [...result.mix, ...STEM_NAMES.flatMap((name) => result.stems[name])]) {
        expect(Math.abs(ch[n - 1])).toBe(0);
      }
      expect(rmsDb(result.mix, n - Math.round(0.05 * SR), n)).toBeLessThan(-90);
      const before = [n - fadeFrames - SR, n - fadeFrames] as const;
      expect(rmsDb(result.stems.piano, ...before)).toBeLessThan(-60);
      expect(rmsDb(result.stems.pad, ...before)).toBeLessThan(-60);
    }
    // Where the piano + pad tail falls below -60 dBFS for good (50 ms frames, mix without noise).
    const frame = Math.round(0.05 * SR);
    const end = Math.round(bare.musicEndSec * SR);
    let last = end;
    for (let i = end; i + frame <= bare.length; i += frame) {
      if (rmsDb(bare.mix, i, i + frame) > -60) last = i + frame;
    }
    console.log(
      `tail (pad 0, lofi 0, rain 0, reverb ${barePiece.params.reverbSize} s): below -60 dBFS ${((last - end) / SR).toFixed(2)} s after the last release; rendered tail ${tailSecFor(barePiece.params.reverbSize).toFixed(2)} s`,
    );
    expect((last - end) / SR).toBeLessThan(tailSecFor(barePiece.params.reverbSize) - END_FADE_SEC);
  });

  it('fades the noise stem in and out', () => {
    const noise = full.stems.noise;
    const n = full.length;
    const middle = rmsDb(noise, Math.round(5 * SR), Math.round(15 * SR));
    expect(rmsDb(noise, 0, Math.round(0.1 * SR))).toBeLessThan(middle - 15);
    expect(rmsDb(noise, n - Math.round(0.6 * SR), n)).toBeLessThan(middle - 12);
    expect(Math.abs(noise[0][0])).toBe(0);
  });
});

describe('renderPiece variants (short piece)', () => {
  const piece = makeFixturePiece({ bars: 2, reverbSize: 3 });

  it('gives the same result when the stems are rendered one by one (no 6-channel context)', async () => {
    const samples = await loadSamples();
    const merged = await renderPiece(piece, { createContext, fetchSample, manifest, samples });
    let stereoContexts = 0;
    const stereoOnly: OfflineContextFactory = (channels, frames, sampleRate) => {
      if (channels > 2) throw new Error('NotSupportedError: more than 2 channels');
      stereoContexts++;
      return createContext(channels, frames, sampleRate);
    };
    const separate = await renderPiece(piece, { createContext: stereoOnly, fetchSample, manifest, samples });
    expect(stereoContexts).toBe(3);
    let maxErr = Math.abs(merged.gainDb - separate.gainDb);
    for (let c = 0; c < 2; c++) {
      maxErr = Math.max(maxErr, maxAbsDiff(merged.mix[c], separate.mix[c]));
      for (const name of STEM_NAMES) maxErr = Math.max(maxErr, maxAbsDiff(merged.stems[name][c], separate.stems[name][c]));
    }
    console.log(`6-channel render vs 3 stereo renders: max |difference| ${maxErr.toExponential(2)}`);
    expect(maxErr).toBeLessThan(1e-5);
  });

  it('decodes the samples itself when none are passed', async () => {
    const result = await renderPiece(piece, { createContext, fetchSample, manifest });
    expect(peakDb(result.mix)).toBeCloseTo(NORMALIZE_PEAK_DB, 2);
  });

  it('keeps long pad notes at their level in the pad stem (20 s notes)', async () => {
    const samples = await loadSamples();
    const long = makeFixturePiece({ bars: 4, chordBars: 4, tempo: 48, pad: 1, reverbSize: 3 });
    expect(long.pad[0].duration).toBeGreaterThan(19);
    const total = totalSecFor(long);
    const ctx = createContext(2, Math.ceil(total * SR), SR);
    const graph = buildGraph(ctx, long, samples, { stems: ['pad'] });
    graph.stems.pad.connect(ctx.destination);
    graph.scheduleAll();
    const out = await ctx.startRendering();
    const pad = [out.getChannelData(0), out.getChannelData(1)];
    const windows = [4, 8, 12, 16].map((t) => rmsDb(pad, Math.round(t * SR), Math.round((t + 3) * SR)));
    console.log(
      `pad stem before normalisation, pad 1, two 20 s notes at velocity 50: peak ${db(peakDb(pad))} dBFS, RMS ${windows.map(db).join(' / ')} dBFS at 4 / 8 / 12 / 16 s`,
    );
    expect(peakDb(pad)).toBeLessThan(-8);
    for (const w of windows) expect(Math.abs(w - windows[1])).toBeLessThan(1.5);
  });

  it('scheduling by time window gives the same audio as scheduling everything at once', async () => {
    const samples = await loadSamples();
    const total = totalSecFor(piece);
    const frames = Math.ceil(total * SR);
    const voices = piece.notes.length + piece.pad.length;

    const render = async (windowed: boolean): Promise<Float32Array[]> => {
      const ctx = createContext(2, frames, SR);
      const graph = buildGraph(ctx, piece, samples, { startTime: 0, totalSec: total });
      for (const name of STEM_NAMES) graph.stems[name].connect(ctx.destination);
      if (windowed) {
        // The calls a lookahead player makes: a growing horizon, sometimes repeated or going back.
        let previous = 0;
        for (let horizon = 0.3; horizon < total + 1; horizon += 0.7) {
          graph.scheduleUntil(horizon);
          const expected = piece.notes.filter((n) => n.time < horizon).length + piece.pad.filter((n) => n.time < horizon).length;
          expect(graph.liveVoices).toBe(expected);
          expect(graph.liveVoices).toBeGreaterThanOrEqual(previous);
          previous = graph.liveVoices;
          graph.scheduleUntil(horizon - 0.5); // going back schedules nothing twice
          graph.scheduleUntil(horizon);
          expect(graph.liveVoices).toBe(expected);
        }
      } else {
        graph.scheduleAll();
      }
      expect(graph.liveVoices).toBe(voices);
      const out = await ctx.startRendering();
      graph.dispose();
      expect(graph.liveVoices).toBe(0);
      return [out.getChannelData(0), out.getChannelData(1)];
    };

    const all = await render(false);
    const windows = await render(true);
    const maxErr = Math.max(maxAbsDiff(all[0], windows[0]), maxAbsDiff(all[1], windows[1]));
    console.log(`windowed vs all-at-once scheduling: max |difference| ${maxErr.toExponential(2)} (peak ${peakAbs(all).toFixed(3)})`);
    expect(peakAbs(all)).toBeGreaterThan(0.01);
    expect(maxErr).toBeLessThan(1e-6);
  });
});
