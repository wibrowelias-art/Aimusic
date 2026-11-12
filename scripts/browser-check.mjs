#!/usr/bin/env node
/**
 * `npm run check:browser`
 *
 * Renders one fixed take (dev/render-check-core.ts) twice: in headless Chromium with the
 * real Web Audio implementation and in Node with node-web-audio-api, and prints the
 * measured numbers side by side. Exits non-zero when Chromium breaks a hard check or
 * when the two engines disagree.
 *
 * Needs Playwright with Chromium (global install is fine).
 */
import { createRequire } from 'node:module';
import { createServer } from 'vite';

const require = createRequire(import.meta.url);

function loadPlaywright() {
  try {
    return require('playwright');
  } catch {
    throw new Error('Playwright is not installed. Install it (npm i -g playwright) or run this check in CI.');
  }
}

/** Allowed difference between the two engines. */
const LIMITS = { rmsDb: 0.5, stemRmsDb: 0.5, centroidRel: 0.05, gainDb: 0.5, fileSec: 0.06 };

const fmt = (v, d = 2) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : String(v));

const server = await createServer({ logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false } });
let browser;
let failures = [];
try {
  await server.listen();
  const address = server.httpServer.address();
  const url = `http://127.0.0.1:${address.port}/dev/render-check.html`;

  const { chromium } = loadPlaywright();
  browser = await chromium.launch();
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') pageErrors.push(m.text());
  });
  await page.goto(url);
  await page.waitForFunction(() => window.__renderCheck !== undefined, undefined, { timeout: 300_000 });
  const result = await page.evaluate(() => window.__renderCheck);
  if (!result.ok) throw new Error(`Chromium render failed: ${result.error}`);
  const chromiumNumbers = result.numbers;

  const mod = await server.ssrLoadModule('/dev/render-check-node.ts');
  const nodeNumbers = await mod.runNodeRenderCheck();

  const rows = [
    ['notes', 0],
    ['fileSec', 3],
    ['gainDb', 2],
    ['peakDb', 2],
    ['rmsDb', 2],
    ['clippedSamples', 0],
    ['centroidHz', 1],
    ['pianoRmsDb', 2],
    ['padRmsDb', 2],
    ['noiseRmsDb', 2],
    ['pianoSilenceRatio', 3],
    ['stemSumError', 8],
    ['repeatMaxDiff', 8],
    ['renderSec', 1],
  ];
  console.log(`| number | Chromium ${browser.version()} | node-web-audio-api |`);
  console.log('| --- | --- | --- |');
  for (const [key, digits] of rows) {
    console.log(`| ${key} | ${fmt(chromiumNumbers[key], digits)} | ${fmt(nodeNumbers[key], digits)} |`);
  }

  const c = chromiumNumbers;
  const n = nodeNumbers;
  if (pageErrors.length) failures.push(`page errors: ${pageErrors.join(' | ')}`);
  if (c.validationErrors.length) failures.push(`piece invalid: ${c.validationErrors.join('; ')}`);
  if (!(c.peakDb < -1)) failures.push(`Chromium peak ${fmt(c.peakDb)} dBFS is not below -1 dBFS`);
  if (c.clippedSamples !== 0) failures.push(`Chromium render has ${c.clippedSamples} clipped samples`);
  if (!(c.stemSumError < 1e-4)) failures.push(`Chromium stems do not sum to the mix (error ${c.stemSumError})`);
  if (!(c.repeatMaxDiff >= 0 && c.repeatMaxDiff < 1e-3)) failures.push(`Chromium repeat render differs by ${c.repeatMaxDiff}`);
  if (c.notes !== n.notes) failures.push(`note count differs: ${c.notes} vs ${n.notes}`);
  if (Math.abs(c.fileSec - n.fileSec) > LIMITS.fileSec) failures.push(`file length differs: ${fmt(c.fileSec, 3)} vs ${fmt(n.fileSec, 3)} s`);
  if (Math.abs(c.gainDb - n.gainDb) > LIMITS.gainDb) failures.push(`gain differs: ${fmt(c.gainDb)} vs ${fmt(n.gainDb)} dB`);
  if (Math.abs(c.rmsDb - n.rmsDb) > LIMITS.rmsDb) failures.push(`mix RMS differs: ${fmt(c.rmsDb)} vs ${fmt(n.rmsDb)} dBFS`);
  for (const key of ['pianoRmsDb', 'padRmsDb', 'noiseRmsDb']) {
    if (Math.abs(c[key] - n[key]) > LIMITS.stemRmsDb) failures.push(`${key} differs: ${fmt(c[key])} vs ${fmt(n[key])} dBFS`);
  }
  if (Math.abs(c.centroidHz - n.centroidHz) / n.centroidHz > LIMITS.centroidRel) {
    failures.push(`centroid differs: ${fmt(c.centroidHz, 1)} vs ${fmt(n.centroidHz, 1)} Hz`);
  }
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
} finally {
  await browser?.close();
  await server.close();
}

if (failures.length) {
  console.error(`\nFAILED:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('\nOK: Chromium passes the hard checks and agrees with node-web-audio-api.');
process.exit(0);
