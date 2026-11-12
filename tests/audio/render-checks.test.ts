/**
 * The automated CHECKS on real generated pieces: generate -> validate -> render
 * offline (node-web-audio-api) -> measure -> compare with AUDIO_TARGETS.
 * Short pieces (about 40 s) keep it fast; `npm run measure` does full-length ones.
 */
import { describe, expect, it } from 'vitest';
import { AUDIO_TARGETS, checkAgainstTargets, measureRt60, peakAbs, rmsDb, type TargetExtras } from '../../src/analysis';
import { REVERB_REF_BAND_HZ, SAMPLE_RATE } from '../../src/audio/constants';
import { renderPiece } from '../../src/audio/render';
import { buildReverbIR } from '../../src/audio/reverb';
import { PARAM_SPECS, PRESET_NAMES } from '../../src/engine/params';
import type { Piece } from '../../src/engine/types';
import { densityTolerance } from '../../src/engine/validate';
import { createContext, fetchSample, loadSamples, manifest } from '../fixtures/audio';
import { makeFixturePiece } from '../fixtures/piece';
import { presetCase, renderCase, type CaseResult } from '../helpers/render-case';

const SR = SAMPLE_RATE;
const SEEDS = [11, 12];
const SHORT = { length: 40 };

function extras(c: CaseResult): TargetExtras {
  return {
    pianoSilenceRatio: c.pianoSilenceRatio,
    rt60Sec: c.rt60MidSec,
    rt60BroadSec: c.rt60BroadSec,
    requestedRt60Sec: c.params.reverbSize,
    tailSec: c.tailSec,
    ringOutSec: c.ringOutSec,
  };
}

function line(c: CaseResult): string {
  const m = c.mix;
  return (
    `${c.label.padEnd(10)} notes ${String(c.report.noteCount).padStart(3)} density ${c.report.measuredDensity.toFixed(2)}/${c.params.density.toFixed(1)} ` +
    `rest ${c.report.measuredRestRatio.toFixed(2)}/${c.params.restProbability.toFixed(2)} | file ${m.durationSec.toFixed(1)} s gain ${c.render.gainDb.toFixed(1)} dB ` +
    `peak ${m.peakDb.toFixed(2)} RMS ${m.rmsDb.toFixed(1)} dBFS clipped ${m.clippedSamples} | piano silence ${c.pianoSilenceRatio.toFixed(2)} ` +
    `centroid ${m.spectralCentroidHz.toFixed(0)} Hz | RT60 mid ${c.rt60MidSec.toFixed(2)} broad ${c.rt60BroadSec.toFixed(2)} of ${c.params.reverbSize.toFixed(1)} s ` +
    `| tail ${c.tailSec.toFixed(2)} s ring-out ${c.ringOutSec.toFixed(2)} s dead end ${c.deadEndSec.toFixed(2)} s | render ${c.renderSec.toFixed(1)} s`
  );
}

function expectStemsSumToMix(c: CaseResult): void {
  const { mix, stems } = c.render;
  let maxErr = 0;
  for (let ch = 0; ch < 2; ch++) {
    for (let i = 0; i < c.render.length; i++) {
      const err = Math.abs(stems.piano[ch][i] + stems.pad[ch][i] + stems.noise[ch][i] - mix[ch][i]);
      if (err > maxErr) maxErr = err;
    }
  }
  expect(maxErr).toBeLessThan(1e-4);
}

describe('render checks on generated pieces (presets)', () => {
  for (const preset of PRESET_NAMES) {
    for (const seed of SEEDS) {
      it(`${preset}, seed ${seed}: notes and rendered audio are inside the targets`, async () => {
        const c = await renderCase(`${preset} ${seed}`, presetCase(preset, seed, SHORT));
        console.log(`[render-check] ${line(c)}`);

        // Notes: the hard checks of the composer.
        expect(c.report.errors).toEqual([]);
        expect(c.report.ok).toBe(true);
        expect(c.report.outOfScale).toBe(0);
        expect(c.report.overlaps).toBe(0);
        expect(c.report.stuck).toBe(0);
        expect(Math.abs(c.report.measuredDensity - c.params.density)).toBeLessThanOrEqual(
          densityTolerance(c.params.density) + 1e-9,
        );

        // Audio: peak below -1 dBFS, no clipping, RMS, silence, centroid, reverb, tail.
        const check = checkAgainstTargets(c.mix, extras(c));
        expect(check.failures).toEqual([]);
        expect(c.mix.peakDb).toBeLessThan(-1);
        expect(c.mix.clippedSamples).toBe(0);
        expect(Number.isFinite(c.mix.rmsDb)).toBe(true);
        expectStemsSumToMix(c);

        // The file ends at digital silence and without a long dead end.
        const n = c.render.length;
        expect(rmsDb(c.render.mix, n - Math.round(0.05 * SR), n)).toBeLessThan(-90);
        expect(c.deadEndSec).toBeLessThanOrEqual(2.6);
      });
    }
  }
});

describe('render checks: extremes and repeatability', () => {
  it('everything turned up stays below -1 dBFS without clipping', async () => {
    const c = await renderCase(
      'extreme',
      presetCase('warm', 5, {
        length: 30,
        tempo: PARAM_SPECS.tempo.max,
        density: PARAM_SPECS.density.max,
        restProbability: 0,
        reverbSize: PARAM_SPECS.reverbSize.max,
        lofi: 1,
        pad: 1,
        rain: 1,
      }),
    );
    console.log(`[render-check] ${line(c)}`);
    expect(c.report.errors).toEqual([]);
    expect(c.mix.peakDb).toBeLessThan(AUDIO_TARGETS.peakDb.max);
    expect(c.mix.peakDb).toBeGreaterThanOrEqual(AUDIO_TARGETS.peakDb.min);
    expect(c.mix.clippedSamples).toBe(0);
    for (const name of ['piano', 'pad', 'noise'] as const) {
      expect(peakAbs(c.render.stems[name])).toBeLessThan(0.999);
    }
    expectStemsSumToMix(c);
  });

  it('the sparsest, quietest setting still renders a valid file', async () => {
    const c = await renderCase(
      'sparse',
      presetCase('cave', 6, {
        length: 30,
        tempo: PARAM_SPECS.tempo.min,
        density: PARAM_SPECS.density.min,
        restProbability: PARAM_SPECS.restProbability.max,
        lofi: 0,
        pad: 0,
        rain: 0,
      }),
    );
    console.log(`[render-check] ${line(c)}`);
    expect(c.report.errors).toEqual([]);
    expect(c.mix.peakDb).toBeLessThan(AUDIO_TARGETS.peakDb.max);
    expect(c.mix.peakDb).toBeGreaterThanOrEqual(AUDIO_TARGETS.peakDb.min);
    expect(c.mix.clippedSamples).toBe(0);
    expect(peakAbs(c.render.stems.pad)).toBe(0);
    expect(peakAbs(c.render.stems.noise)).toBe(0);
  });

  it('rendering the same take twice gives identical audio', async () => {
    const params = presetCase('warm', 21, { length: 30, tempo: PARAM_SPECS.tempo.max });
    const a = await renderCase('repeat a', params);
    const b = await renderCase('repeat b', params);
    expect(b.render.length).toBe(a.render.length);
    expect(b.render.gainDb).toBe(a.render.gainDb);
    let maxDiff = 0;
    for (let ch = 0; ch < 2; ch++) {
      for (let i = 0; i < a.render.length; i++) {
        const d = Math.abs(a.render.mix[ch][i] - b.render.mix[ch][i]);
        if (d > maxDiff) maxDiff = d;
      }
    }
    console.log(`[render-check] repeat render: max |difference| ${maxDiff.toExponential(2)}`);
    expect(maxDiff).toBeLessThan(1e-6);
  });
});

describe('reverb tail length in the rendered audio', () => {
  /** One short, undamped-by-pedal note: after the damper has fallen only the reverb is left. */
  function probePiece(reverbSize: number): Piece {
    const base = makeFixturePiece({ bars: 2, reverbSize, lofi: 0, pad: 0, rain: 0 });
    const note = { ...base.notes[0], id: 0, pitch: 72, velocity: 78, time: 0.1, duration: 0.25, startBeat: 0, durBeats: 0.25 };
    return { ...base, notes: [note], pad: [], pedal: [], durationSec: 0.6 };
  }

  for (const reverbSize of [3, 4.5, 6]) {
    it(`a single short note decays with RT60 close to ${reverbSize} s`, async () => {
      const piece = probePiece(reverbSize);
      const samples = await loadSamples();
      const render = await renderPiece(piece, { createContext, fetchSample, manifest, samples });
      // From the key release on. The first 10 dB of the decay still hold the damped
      // direct signal, so the line is fitted from -10 to -40 dB.
      const from = Math.round((0.1 + 0.25) * SR);
      const tail = render.stems.piano.map((ch) => ch.subarray(from));
      const rendered = measureRt60(tail, SR, { fromDb: -10, toDb: -40 });
      const ir = measureRt60(buildReverbIR(SR, reverbSize), SR, { bandHz: REVERB_REF_BAND_HZ });
      console.log(
        `[render-check] reverb ${reverbSize} s: RT60 of the rendered note ${rendered.toFixed(2)} s, of the impulse response (500-1000 Hz) ${ir.toFixed(2)} s, file ${(render.length / SR).toFixed(2)} s`,
      );
      expect(rendered).toBeGreaterThan(reverbSize * 0.8);
      expect(rendered).toBeLessThan(reverbSize * 1.2);
    });
  }
});
