#!/usr/bin/env node
/**
 * `npm run style:test -- [--length 60] [--families a,b] [--mock] [--confirm-usd 0.75]`
 *
 * One test generation per style family, through the same local backend the page uses
 * (name guard, cost check, files kept in renders/style), then that family's lo-fi chain
 * preset, measurements, and an MP3 next to the WAV (the MP3 needs ffmpeg).
 *
 * Without --confirm-usd it only prints the plan and the estimated total, and stops.
 * With it, the number has to match the printed total. Nothing is sent before that.
 *
 * Output: renders/style-test/<n>-<family>-{raw.*,lofi.wav,lofi.mp3}, reports/style-test.{json,md}
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { createServer } from 'vite';

const require = createRequire(import.meta.url);
const { OfflineAudioContext } = require('node-web-audio-api');

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
if (flag('mock')) process.env.STYLE_LAB_MOCK = '1';

const server = await createServer({ logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
await server.listen();
const base = `http://127.0.0.1:${server.httpServer.address().port}/api/style/`;
const load = (path) => server.ssrLoadModule(path);
const { FAMILY_IDS, PROFILES } = await load('/src/style/profiles.ts');
const { buildPrompt } = await load('/src/style/prompt.ts');
const { estimateCost, formatUsd, formatLength } = await load('/src/style/cost.ts');
const { renderPostFx } = await load('/src/postfx/index.ts');
const { encodeWav } = await load('/src/audio/wav.ts');
const { integratedLufs, truePeakDb, peakDb, spectralCentroid } = await load('/src/analysis/index.ts');

const SR = 48000;
const outDir = 'renders/style-test';
let exitCode = 0;

const decode = async (bytes) => {
  const ctx = new OfflineAudioContext(2, 1, SR);
  const buffer = await ctx.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const left = buffer.getChannelData(0).slice();
  const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1).slice() : left.slice();
  return [left, right];
};
const hasFfmpeg = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
const r1 = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);
const r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);

try {
  const status = await (await fetch(`${base}status`)).json();
  const families = (value('families')?.split(',') ?? [...FAMILY_IDS]).filter((id) => FAMILY_IDS.includes(id));
  const lengthSec = Number(value('length') ?? 60);
  const plan = families.map((id) => {
    const profile = PROFILES[id];
    const request = { a: id, b: null, mix: 0, words: '', vocals: profile.vocalsDefault, lengthSec };
    return { id, profile, request, prompt: buildPrompt(request), usd: status.mock ? 0 : estimateCost(lengthSec, { usdPerMinute: status.usdPerMinute }).usd };
  });
  const total = Math.round(plan.reduce((sum, p) => sum + p.usd, 0) * 1000) / 1000;

  console.log(`Style test: ${plan.length} generation(s) of ${formatLength(lengthSec)} each${status.mock ? ' (MOCK MODE: test signal, no API call)' : ''}\n`);
  for (const p of plan) {
    console.log(`--- ${p.profile.label} (${p.id}), ${p.request.vocals ? 'with vocals' : 'instrumental'}, ${formatUsd(p.usd)}`);
    console.log(`${p.prompt}\n`);
  }
  console.log(`Estimated total: ${formatUsd(total)} (${status.usdPerMinute.toFixed(2)} USD per minute; the real charge is whatever the provider bills)`);

  const confirmed = value('confirm-usd');
  if (confirmed === undefined || Math.abs(Number(confirmed) - total) > 0.005) {
    console.log(`\nNothing was sent. To run it: npm run style:test -- ${args.filter((a, i) => a !== '--confirm-usd' && args[i - 1] !== '--confirm-usd').join(' ')} --confirm-usd ${total}`.replace(/\s+/g, ' '));
    process.exitCode = 0;
  } else if (!status.mock && !status.keyPresent) {
    console.log('\nNo API key. Put ELEVENLABS_API_KEY into .env first.');
    exitCode = 1;
  } else {
    mkdirSync(outDir, { recursive: true });
    mkdirSync('reports', { recursive: true });
    const rows = [];
    let n = 0;
    for (const p of plan) {
      n += 1;
      const started = performance.now();
      process.stdout.write(`\n[${n}/${plan.length}] ${p.profile.label}: generating... `);
      const res = await fetch(`${base}compose`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: p.prompt,
          lengthSec,
          vocals: p.request.vocals,
          lyrics: '',
          modelId: value('model') ?? status.defaultModel,
          confirmUsd: p.usd,
          meta: { profileA: p.id, profileB: null, mix: 0, words: '', fx: p.profile.fx },
        }),
      });
      const body = await res.json();
      if (!res.ok) {
        exitCode = 1;
        console.log(`FAILED (${res.status} ${body.error?.code}): ${body.error?.message}`);
        if (body.error?.suggestion) console.log(`  The API suggests this prompt instead:\n  ${body.error.suggestion}`);
        rows.push({ family: p.id, label: p.profile.label, error: body.error });
        continue;
      }
      const take = body;
      const genSec = (performance.now() - started) / 1000;
      const rawPath = join('renders/style', take.audioFile);
      const raw = await decode(readFileSync(rawPath));
      const stem = `${n}-${p.id}`;
      copyFileSync(rawPath, join(outDir, `${stem}-raw.${take.audioFile.split('.').pop()}`));
      process.stdout.write(`${genSec.toFixed(0)} s. Lo-fi chain... `);
      const { pcm, report } = await renderPostFx({ sampleRate: SR, full: raw }, p.profile.fx, {
        createContext: (channels, frames, rate) => new OfflineAudioContext(channels, frames, rate),
        seed: n,
      });
      const wavPath = join(outDir, `${stem}-lofi.wav`);
      writeFileSync(wavPath, encodeWav(pcm, SR));
      let mp3 = null;
      if (hasFfmpeg) {
        const mp3Path = join(outDir, `${stem}-lofi.mp3`);
        execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', wavPath, '-codec:a', 'libmp3lame', '-b:a', '192k', mp3Path]);
        const back = await decode(readFileSync(mp3Path));
        mp3 = { file: mp3Path, lufs: r1(integratedLufs(back, SR)), peakDb: r2(peakDb(back)), truePeakDb: r2(truePeakDb(back)) };
      }
      const m = report.master;
      rows.push({
        family: p.id,
        label: p.profile.label,
        takeId: take.id,
        vocals: take.vocals,
        model: take.model,
        mock: take.mock,
        estimateUsd: take.costUsd,
        generationSec: r1(genSec),
        prompt: take.prompt,
        fx: report.settings,
        raw: {
          durationSec: r1(report.inputDurationSec),
          lufs: r1(report.inputLufs),
          peakDb: r2(peakDb(raw)),
          centroidHz: Math.round(report.inputCentroidHz),
          sideDb: r1(report.inputSideDb),
        },
        lofi: {
          file: wavPath,
          durationSec: r1(report.durationSec),
          lufs: r1(m.lufs),
          peakDb: r2(m.peakDb),
          truePeakDb: r2(m.truePeakDb),
          limiterMaxDb: r1(m.limiter.maxReductionDb),
          limitedShare: r2(m.limiter.limitedShare),
          centroidHz: Math.round(spectralCentroid(pcm, SR)),
          sideDb: r1(report.sideDb),
          hissDb: report.hissDb,
          highCutHz: report.highCutHz,
          playbackRate: report.playbackRate,
          pitchSemitones: r2(report.pitchSemitones),
          wobbleMaxCents: r1(report.wobbleMaxCents),
          onTarget: m.onTarget,
        },
        mp3,
      });
      console.log(`done. ${m.lufs.toFixed(1)} LUFS, peak ${m.peakDb.toFixed(2)} dBFS${mp3 ? `, mp3 peak ${mp3.peakDb} dBFS` : ''}`);
    }

    const ok = rows.filter((r) => !r.error);
    const md = [
      '# Style test: one generation per family',
      '',
      `${ok.length} of ${rows.length} generated${status.mock ? ' in MOCK MODE (test signal, not music)' : ''}. Length asked for: ${formatLength(lengthSec)} each. Estimated total: ${formatUsd(ok.reduce((s, r) => s + r.estimateUsd, 0))}.`,
      'Numbers are measured on the files; nobody here has listened to them.',
      '',
      '| Family | Raw LUFS | Raw peak dBFS | Raw centroid Hz | Lo-fi LUFS | Lo-fi peak dBFS | Peak between samples | MP3 peak dBFS | Lo-fi centroid Hz | Side dB raw -> lo-fi | Hiss dBFS | High-cut | Speed | Length |',
      '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
      ...ok.map(
        (r) =>
          `| ${r.label} | ${r.raw.lufs} | ${r.raw.peakDb} | ${r.raw.centroidHz} | ${r.lofi.lufs} | ${r.lofi.peakDb} | ${r.lofi.truePeakDb} | ${r.mp3 ? r.mp3.peakDb : 'n/a'} | ${r.lofi.centroidHz} | ${r.raw.sideDb} -> ${r.lofi.sideDb} | ${r.lofi.hissDb ?? 'off'} | ${r.lofi.highCutHz ? `${r.lofi.highCutHz / 1000} kHz` : 'off'} | ${Math.round(r.lofi.playbackRate * 100)}% | ${formatLength(r.raw.durationSec)} -> ${formatLength(r.lofi.durationSec)} |`,
      ),
      ...rows.filter((r) => r.error).map((r) => `\nFAILED ${r.label}: ${r.error?.message ?? 'unknown error'}`),
      '',
    ].join('\n');
    writeFileSync('reports/style-test.json', `${JSON.stringify({ lengthSec, mock: status.mock, rows }, null, 2)}\n`);
    writeFileSync('reports/style-test.md', md);
    console.log(`\n${md}\nFiles: ${outDir}/, report: reports/style-test.md`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.stack : String(error));
  exitCode = 1;
} finally {
  await server.close();
}
process.exit(exitCode);
