/**
 * `npm run measure`: renders 4 presets x 3 seeds at the preset centre with
 * node-web-audio-api and writes the numbers that TUNING.md reports to
 * reports/phase1.json and reports/phase1.md. Also writes one WAV per preset
 * (seed 1) to renders/ (git-ignored) for listening.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { rmsDb } from '../../src/analysis';
import { encodeWav } from '../../src/audio/wav';
import { KEY_NAMES, MODE_LABELS, PRESET_NAMES } from '../../src/engine/params';
import { presetCase, renderCase, type CaseResult } from '../helpers/render-case';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SEEDS = [1, 2, 3];

const f = (v: number, d = 2): string => (Number.isFinite(v) ? v.toFixed(d) : String(v));

function row(c: CaseResult, preset: string, seed: number): Record<string, string | number> {
  return {
    preset,
    seed,
    key: KEY_NAMES[c.params.key],
    mode: MODE_LABELS[c.params.mode],
    tempo: c.params.tempo,
    bars: c.piece.bars,
    notes: c.report.noteCount,
    densityTarget: c.params.density,
    density: Number(f(c.report.measuredDensity, 3)),
    restTarget: c.params.restProbability,
    restRatio: Number(f(c.report.measuredRestRatio, 3)),
    musicSec: Number(f(c.piece.durationSec, 1)),
    fileSec: Number(f(c.mix.durationSec, 1)),
    gainDb: Number(f(c.render.gainDb)),
    peakDb: Number(f(c.mix.peakDb)),
    rmsDb: Number(f(c.mix.rmsDb)),
    crestDb: Number(f(c.mix.crestDb)),
    clipped: c.mix.clippedSamples,
    pianoRmsDb: Number(f(rmsDb(c.render.stems.piano))),
    padRmsDb: Number(f(rmsDb(c.render.stems.pad))),
    noiseRmsDb: Number(f(rmsDb(c.render.stems.noise))),
    pianoSilenceRatio: Number(f(c.pianoSilenceRatio, 3)),
    centroidHz: Math.round(c.mix.spectralCentroidHz),
    reverbSize: c.params.reverbSize,
    rt60MidSec: Number(f(c.rt60MidSec)),
    rt60BroadSec: Number(f(c.rt60BroadSec)),
    tailSec: Number(f(c.tailSec)),
    ringOutSec: Number(f(c.ringOutSec)),
    deadEndSec: Number(f(c.deadEndSec)),
    renderSec: Number(f(c.renderSec, 1)),
  };
}

describe('Phase 1 measure run', () => {
  it('renders the presets and writes the reports', async () => {
    mkdirSync(join(ROOT, 'reports'), { recursive: true });
    mkdirSync(join(ROOT, 'renders'), { recursive: true });
    const rows: Record<string, string | number>[] = [];
    const wavs: string[] = [];
    for (const preset of PRESET_NAMES) {
      for (const seed of SEEDS) {
        const c = await renderCase(`${preset} ${seed}`, presetCase(preset, seed));
        expect(c.report.ok, c.report.errors.join('; ')).toBe(true);
        rows.push(row(c, preset, seed));
        if (seed === 1) {
          const file = join(ROOT, 'renders', `phase1-${preset}-seed1.wav`);
          writeFileSync(file, encodeWav(c.render.mix, c.render.sampleRate));
          wavs.push(file);
        }
      }
    }
    const cols = Object.keys(rows[0]);
    const md = [
      `| ${cols.join(' | ')} |`,
      `| ${cols.map(() => '---').join(' | ')} |`,
      ...rows.map((r) => `| ${cols.map((k) => r[k]).join(' | ')} |`),
    ].join('\n');
    writeFileSync(join(ROOT, 'reports', 'phase1.json'), JSON.stringify(rows, null, 2) + '\n');
    writeFileSync(join(ROOT, 'reports', 'phase1.md'), md + '\n');
    console.log(md);
    console.log(`\nWAVs for listening:\n${wavs.join('\n')}`);
  });
});
