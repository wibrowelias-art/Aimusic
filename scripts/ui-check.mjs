#!/usr/bin/env node
/**
 * `npm run check:ui`
 *
 * Drives the real app in headless Chromium. First the Style Lab: the free built-in
 * generator (nothing leaves the page), then the music AI engine in mock mode (no call to
 * the music API, nothing billed): profiles, mix, own words, the name guard, lyrics, cost
 * confirmation, the lo-fi chain and its numbers. Then the offline piano lab:
 * Generate, Again, a knob, rating, favorites, waveform render, MIDI / WAV / stems export,
 * reload, history, seek, keyboard shortcuts. Fails on any console error. Screenshots go
 * to reports/tmp/.
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'vite';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const failures = [];
const notes = [];
const check = (ok, message) => {
  if (!ok) failures.push(message);
  notes.push(`${ok ? 'ok  ' : 'FAIL'} ${message}`);
};

mkdirSync('reports/tmp', { recursive: true });
// The Style Lab backend in mock mode, whatever is in .env: this check can never spend money.
process.env.STYLE_LAB_MOCK = '1';
process.env.ELEVENLABS_API_KEY = '';
const server = await createServer({ logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/`;
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e}`));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`console: ${m.text()}`);
});

const text = (selector) => page.textContent(selector);
const seconds = async () => {
  const t = (await text('.time')) ?? '';
  const [m, s] = t.split(' / ')[0].split(':').map(Number);
  return m * 60 + s;
};
const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem('ambientlab.takes.v1') ?? '{"takes":[],"ratings":[]}'));
const download = async (selector) => {
  const [d] = await Promise.all([page.waitForEvent('download', { timeout: 240_000 }), page.click(selector)]);
  const path = await d.path();
  return { name: d.suggestedFilename(), bytes: readFileSync(path) };
};

try {
  await page.goto(url);

  // ---------------------------------------------------------------- Style Lab (mock mode)
  {
  await page.waitForSelector('.sl-generate');
  const api = (route, init) => page.evaluate(async ([r, i]) => (await fetch(`/api/style/${r}`, i)).json(), [route, init]);
  const prompt = () => page.inputValue('.sl-prompt-text');
  const metric = async (label) =>
    page.evaluate((l) => [...document.querySelectorAll('.sl-metrics tr')].find((tr) => tr.firstElementChild?.textContent === l)?.children[1]?.textContent ?? '', label);
  const chainDone = () =>
    page.waitForFunction(() => document.querySelector('.sl-metrics tr') !== null && document.querySelector('.sl-chain-status')?.textContent === '', undefined, { timeout: 180_000 });
  const takesBefore = (await api('takes')).map((t) => t.id);

  check((await page.locator('.profile').count()) === 6, 'six profiles: five families and the offline piano');
  check((await page.getAttribute('.profile[data-profile="bedroom-demo"]', 'aria-checked')) === 'true', 'starts on a Style Lab family');

  // ---- The built-in generator: free, nothing leaves the page
  const posts = [];
  const onRequest = (r) => {
    if (r.method() !== 'GET') posts.push(`${r.method()} ${r.url()}`);
  };
  page.on('request', onRequest);
  const localTakes = () => page.evaluate(() => JSON.parse(localStorage.getItem('ambientlab.sketch.v1') ?? '[]'));
  const planParts = () => page.$$eval('.sl-plan-list li', (els) => els.map((e) => e.textContent));
  check((await page.getAttribute('.sl-engine-option[data-engine="sketch"]', 'aria-checked')) === 'true', 'the free built-in generator is the default');
  check(((await text('.sl-cost')) ?? '').startsWith('Free'), `the page says it is free: ${await text('.sl-cost')}`);
  check((await page.isVisible('.sl-plan')) && !(await page.isVisible('.sl-prompt')), 'free mode shows what will be played, not a prompt');
  check((await planParts()).includes('drum machine tick'), 'the bedroom family comes with its drum machine');
  await page.fill('.sl-words input', 'more tape hiss, no drums, like a rainy sunday');
  const partsNoDrums = await planParts();
  check(!partsNoDrums.some((x) => /drum/.test(x)) && partsNoDrums.includes('looped guitar figure'), `"no drums" takes the drums out: ${partsNoDrums.join(', ')}`);
  check(((await text('.sl-understood')) ?? '').includes('hiss up 4 dB') && ((await text('.sl-understood')) ?? '').includes('drums left out'), 'the page says what it made of the words');
  check(((await text('.sl-ignored')) ?? '').includes('like a rainy sunday'), 'and which words it did not understand');
  check((await page.getAttribute('[role="slider"][aria-label="Hiss"]', 'aria-valuetext')) === '-46 dB', '"more tape hiss" moves the hiss knob (-50 -> -46 dB)');
  await page.fill('.sl-length input', '20');
  await page.click('.sl-generate');
  check(!(await page.isVisible('dialog[open]')), 'free: no cost dialog');
  await chainDone();
  const freeKey = await metric('Key and tempo');
  check(freeKey.includes('BPM'), `the free take reports its key and tempo: ${freeKey}`);
  check(Math.abs(Number.parseFloat(await metric('Loudness')) + 16) <= 0.5 && Number.parseFloat(await metric('Peak')) < -1, `free take on target: ${await metric('Loudness')}, peak ${await metric('Peak')}`);
  check((await metric('Hiss')).startsWith('-46 dBFS'), 'the hiss in the file is where the words put it');
  let local = await localTakes();
  check(local.length === 1 && local[0].engine === 'sketch' && Number.isInteger(local[0].seed) && local[0].costUsd === 0, 'the take is kept as seed + settings in the browser');
  await page.screenshot({ path: 'reports/tmp/ui-s0-free.png', fullPage: true });
  await page.reload();
  await chainDone();
  check((await metric('Key and tempo')) === freeKey, 'after a reload the same seed gives the same piece');

  await page.click('.profile[data-profile="dream-folk"]');
  await chainDone();
  check((await planParts()).includes('wordless lead voice'), 'dream-folk comes with a wordless voice');
  await page.fill('.sl-length input', '20');
  await page.click('.sl-generate');
  await chainDone();
  check((await metric('Vocal blur')) === 'on the vocal stem', 'the voice of the built-in generator gets the vocal blur without any stem separation');
  check(posts.length === 0, `the free generator sent nothing anywhere${posts.length ? `: ${posts.join(' | ')}` : ''}`);
  page.off('request', onRequest);
  for (let n = 2; n > 0; n--) {
    page.once('dialog', (d) => void d.accept());
    await page.click('.sl-take >> nth=0 >> .btn');
    await page.waitForFunction((count) => document.querySelectorAll('.sl-take').length === count, takesBefore.length + n - 1);
  }
  check((await localTakes()).length === 0, 'deleting removes the free takes');

  // ---- The music AI engine, in mock mode
  await page.click('.profile[data-profile="bedroom-demo"]');
  await page.fill('.sl-words input', '');
  await page.click('.sl-engine-option[data-engine="ai"]');
  check((await page.isVisible('.sl-prompt')) && !(await page.isVisible('.sl-plan')), 'the music AI engine shows the prompt');
  check(((await text('.sl-banner')) ?? '').includes('Mock mode'), 'the page says when mock mode is on');
  check((await prompt()).includes('Vocals: none. Instrumental only'), 'the prompt text is shown and says instrumental');
  check(!(await page.isDisabled('.sl-generate')), 'Generate is ready');

  await page.fill('.sl-words input', 'more tape hiss, no drums');
  let p = await prompt();
  check(p.endsWith('Also: more tape hiss.') && /Avoid: .*drums/.test(p) && !p.includes('drum machine'), 'own words: "more tape hiss" is appended, "no drums" removes the drum machine and joins Avoid');

  await page.selectOption('.sl-recipe select >> nth=0', 'slowcore');
  await page.fill('.sl-mix input', '50');
  p = await prompt();
  check(p.startsWith('An even blend of') && p.includes('woozy clean electric guitar'), 'mixing two profiles 50/50 rewrites the prompt');
  check(((await text('.sl-mix-text')) ?? '') === '50% Bedroom demo + 50% Slowcore guitar', 'the mix is spelled out');

  // The name guard
  await page.fill('.sl-prompt-text', `${p}\nMake it sound like Xavier Quillfeather.`);
  check(await page.isVisible('.sl-guard'), 'a name in the prompt is flagged');
  check(await page.isDisabled('.sl-generate'), 'Generate is blocked while a name is in the prompt');
  check(((await text('.sl-request')) ?? '').startsWith('Nothing would be sent'), 'the request preview says nothing would be sent');
  await page.click('.sl-prompt-head .btn');
  check(!(await page.isVisible('.sl-guard')) && !(await page.isDisabled('.sl-generate')), '"Rebuild from settings" clears it');

  // Vocals and the lyrics helper
  await page.check('.sl-switch');
  check((await prompt()).includes('Vocals: quiet, plain solo voice'), 'the vocals switch changes the vocal line');
  await page.fill('.sl-lyrics .sl-input', 'the bus stop, cold coffee');
  await page.click('.sl-lyrics .btn');
  const lyrics = await page.inputValue('.sl-lyrics-text');
  check(lyrics.includes('the bus stop') && lyrics.includes('cold coffee') && lyrics.includes('[verse 1]'), 'the lyrics helper drafts lines around the topic words');
  check(((await text('.sl-request')) ?? '').includes('"composition_plan"'), 'own lyrics go out as a section plan');
  await page.fill('.sl-lyrics-text', '');
  await page.uncheck('.sl-switch');
  await page.selectOption('.sl-recipe select >> nth=0', '');

  // What a real (billed) run would show: fake only the status answer, then cancel.
  await page.route('**/api/style/status', (route) =>
    route.fulfill({ json: { keyPresent: true, mock: false, usdPerMinute: 0.15, models: ['music_v1'], defaultModel: 'music_v1' } }),
  );
  await page.reload();
  await page.waitForSelector('.sl-generate:not([disabled])');
  check(((await text('.sl-cost')) ?? '').includes('About $0.23'), `the cost estimate is on the page before anything happens: ${await text('.sl-cost')}`);
  await page.click('.sl-generate');
  const confirmText = (await text('dialog[open]')) ?? '';
  check(confirmText.includes('billed to your account') && confirmText.includes('Estimated total') && confirmText.includes('$0.23'), 'Generate asks to confirm the cost first');
  check(confirmText.includes('"prompt"'), 'the confirm dialog shows what is sent');
  await page.screenshot({ path: 'reports/tmp/ui-s1-confirm.png' });
  await page.click('dialog[open] .btn.ghost');
  check(JSON.stringify((await api('takes')).map((t) => t.id)) === JSON.stringify(takesBefore), 'cancelling sends nothing');
  await page.unroute('**/api/style/status');
  await page.reload();
  await page.waitForSelector('.sl-generate:not([disabled])');

  // Generate (mock): test signal, then the chain
  await page.fill('.sl-length input', '20');
  await page.click('.sl-generate');
  check(((await text('dialog[open]')) ?? '').includes('Mock mode'), 'in mock mode the dialog says nothing is billed');
  await page.click('.sl-confirm-ok');
  await chainDone();
  const made = (await api('takes')).filter((t) => !takesBefore.includes(t.id));
  check(made.length === 1 && made[0].mock === true && made[0].costUsd === 0 && made[0].lengthSec === 20, 'one generation is stored with its request and cost');
  const lufs = Number.parseFloat(await metric('Loudness'));
  const peak = Number.parseFloat(await metric('Peak'));
  check(Math.abs(lufs + 16) <= 0.5, `lo-fi loudness ${lufs} LUFS (target -16)`);
  check(peak < -1, `lo-fi peak ${peak} dBFS is below -1`);
  check((await metric('Hiss')).startsWith('-50 dBFS'), `hiss sits where the knob says: ${await metric('Hiss')}`);
  check(((await page.getAttribute('.sl-audio >> nth=0', 'src')) ?? '').startsWith('blob:'), 'the lo-fi player has audio');
  await page.screenshot({ path: 'reports/tmp/ui-s2-result.png', fullPage: true });

  // Another profile's preset on the same take: slowed
  await page.click('.profile[data-profile="slowed-reverb"]');
  await page.waitForFunction(() => [...document.querySelectorAll('.sl-metrics td')].some((td) => td.textContent === '86% speed'), undefined, { timeout: 180_000 });
  await chainDone();
  check((await metric('Speed and pitch')) === '86% speed', 'the slowed preset plays the take at 86% speed');
  check(Math.abs(Number.parseFloat(await metric('Loudness')) + 16) <= 0.5 && Number.parseFloat(await metric('Peak')) < -1, 'still on target after slowing');

  // A knob re-renders for free
  await page.focus('[role="slider"][aria-label="Hiss"]');
  await page.keyboard.press('ArrowUp');
  await page.waitForFunction(() => [...document.querySelectorAll('.sl-metrics td')].some((td) => td.textContent === '-53 dBFS RMS'), undefined, { timeout: 180_000 });
  check(true, 'turning the hiss knob renders the chain again (-54 -> -53 dBFS)');

  // Stems (mock) switch the vocal blur on
  await page.click('.sl-actions .btn >> nth=2');
  await page.click('.sl-confirm-ok');
  await page.waitForFunction(() => [...document.querySelectorAll('.sl-metrics td')].some((td) => td.textContent === 'on the vocal stem'), undefined, { timeout: 180_000 });
  check(true, 'with stems the vocal blur acts on the vocal stem');
  await page.click('.sl-actions .btn >> nth=3');
  await page.waitForFunction(() => document.querySelector('.sl-actions .btn:nth-of-type(3)')?.getAttribute('aria-pressed') === 'true' || [...document.querySelectorAll('.sl-actions .btn')].some((b) => b.getAttribute('aria-pressed') === 'true'));
  check((await api('takes')).find((t) => t.id === made[0].id)?.rating === 1, 'thumbs up is stored with the take');

  const lofi = await download('.sl-actions .btn >> nth=0');
  let lofiPeak = 0;
  for (let i = 44; i + 1 < lofi.bytes.length; i += 2) lofiPeak = Math.max(lofiPeak, Math.abs(lofi.bytes.readInt16LE(i)));
  const lofiPeakDb = 20 * Math.log10(lofiPeak / 32768);
  check(lofi.name.endsWith('-lofi.wav') && lofi.bytes.readUInt32LE(24) === 48000 && lofi.bytes.readUInt16LE(22) === 2, `lo-fi WAV export (${lofi.name})`);
  check(lofiPeakDb < -1, `exported lo-fi WAV peaks at ${lofiPeakDb.toFixed(2)} dBFS`);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  const slOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check(slOverflow <= 1, `Style Lab: no sideways scrolling at 390 px (overflow ${slOverflow} px)`);
  await page.screenshot({ path: 'reports/tmp/ui-s3-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });

  // Clean up the test generation (files included)
  page.once('dialog', (d) => void d.accept());
  await page.click('.sl-take.is-current .btn');
  await page.waitForFunction((n) => document.querySelectorAll('.sl-take').length === n, takesBefore.length);
  check(JSON.stringify((await api('takes')).map((t) => t.id)) === JSON.stringify(takesBefore), 'deleting a generation removes it');
  }

  // ---------------------------------------------------------------- Ambient piano (offline)
  await page.click('.profile[data-profile="piano-offline"]');
  await page.waitForSelector('.generate');
  check(!(await page.isVisible('.sl-generate')), 'the offline piano profile swaps the Style Lab for the piano lab');
  check((await text('.take-title')) === 'No take yet', 'starts without a take');
  check(await page.isDisabled('.exports .btn >> nth=0'), 'exports are disabled without a take');
  await page.screenshot({ path: 'reports/tmp/ui-0-empty.png' });

  // Generate
  await page.click('.generate');
  await page.waitForFunction(() => document.querySelector('.take-title')?.textContent?.startsWith('#1 '), undefined, { timeout: 90_000 });
  await page.waitForFunction(() => document.querySelector('.hero-side .btn.icon-only')?.getAttribute('aria-pressed') === 'true', undefined, { timeout: 90_000 });
  await page.waitForTimeout(3200);
  const t1 = await seconds();
  check(t1 >= 2 && t1 <= 5, `plays after Generate (time shows ${t1} s after about 3.2 s)`);
  const first = (await stored()).takes[0];
  check(first.preset === 'warm' && first.params.variation === 0, 'take 1 is a Warm take, variation 0');
  await page.screenshot({ path: 'reports/tmp/ui-1-playing.png' });

  // Stop
  await page.click('.hero-side .btn.icon-only');
  await page.waitForTimeout(300);
  check((await page.getAttribute('.hero-side .btn.icon-only', 'aria-pressed')) === 'false', 'stop button stops');
  check((await seconds()) === 0, 'time goes back to 0:00 when stopped');

  // Again
  await page.click('.hero-side .btn.tall >> nth=0');
  await page.waitForFunction(() => document.querySelector('.take-title')?.textContent?.startsWith('#2 '), undefined, { timeout: 30_000 });
  let data = await stored();
  check(data.takes.length === 2, 'Again adds a second take');
  check(data.takes[0].params.seed === first.params.seed && data.takes[0].params.variation === 1, 'Again keeps the seed and bumps the variation');
  check(JSON.stringify({ ...data.takes[0].params, variation: 0 }) === JSON.stringify(first.params), 'Again keeps every setting');

  // Knob by keyboard: tempo + 1, becomes pinned, edits the take in place
  const tempoBefore = data.takes[0].params.tempo;
  await page.focus('[role="slider"][aria-label="Tempo"]');
  await page.keyboard.press(tempoBefore < 72 ? 'ArrowUp' : 'ArrowDown');
  await page.waitForTimeout(400);
  data = await stored();
  check(Math.abs(data.takes[0].params.tempo - tempoBefore) === 1, `arrow key on the tempo knob changes the take (${tempoBefore} -> ${data.takes[0].params.tempo})`);
  check(data.takes.length === 2, 'a knob edit changes the take in place');
  check(await page.evaluate(() => document.querySelector('[role="slider"][aria-label="Tempo"]')?.closest('.knob')?.classList.contains('is-pinned')), 'the turned knob is fixed (lock closed)');
  check((await page.getAttribute('[role="slider"][aria-label="Tempo"]', 'aria-valuetext')) === `${data.takes[0].params.tempo} BPM`, 'knob announces its value');

  // Sound-only knob keeps playing from where it was
  await page.waitForTimeout(2500);
  const before = await seconds();
  await page.focus('[role="slider"][aria-label="Reverb"]');
  await page.keyboard.press('ArrowUp');
  await page.waitForTimeout(700);
  const after = await seconds();
  check(after >= before && after <= before + 3, `a reverb change resumes in place (${before} s -> ${after} s)`);

  // Rating
  await page.click('.take-actions .btn >> nth=0');
  await page.waitForTimeout(200);
  data = await stored();
  check(data.takes[0].rating === 1 && data.ratings.length === 1, 'thumbs up is stored with its settings');
  check(((await text('.toast')) ?? '').startsWith('Noted.'), `rating toast: "${await text('.toast')}"`);
  // Editing a rated take forks it
  await page.focus('[role="slider"][aria-label="Pad"]');
  await page.keyboard.press('ArrowUp');
  await page.waitForTimeout(400);
  data = await stored();
  check(data.takes.length === 3 && data.takes[0].origin === 'edit' && data.takes[1].rating === 1, 'editing a rated take makes a new take and leaves the rated one alone');

  // Favorite
  await page.click('.take-actions .btn.star');
  await page.click('.tabs .tab >> nth=1');
  await page.waitForTimeout(150);
  check((await page.locator('.takes .take').count()) === 1, 'favorites tab lists the starred take');
  await page.click('.tabs .tab >> nth=0');

  // Waveform (renders offline)
  await page.click('.hero-side .btn.icon-only'); // stop, keeps the render quick
  await page.click('.segmented button >> nth=1');
  await page.waitForFunction(() => (document.querySelector('.view-status')?.textContent ?? '').startsWith('Rendered'), undefined, { timeout: 240_000 });
  notes.push(`     ${await text('.view-status')}`);
  const painted = await page.evaluate(() => {
    const canvas = document.querySelector('.view-wave canvas');
    const ctx = canvas.getContext('2d');
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const colours = new Set();
    for (let i = 0; i < data.length; i += 4 * 97) colours.add(`${data[i]},${data[i + 1]},${data[i + 2]}`);
    return colours.size;
  });
  check(painted > 3, `waveform is drawn (${painted} colours sampled)`);
  await page.screenshot({ path: 'reports/tmp/ui-2-waveform.png' });

  // Exports
  const midi1 = await download('.exports .btn >> nth=0');
  const midi2 = await download('.exports .btn >> nth=0');
  check(midi1.name.endsWith('.mid') && midi1.bytes.subarray(0, 4).toString('latin1') === 'MThd', `MIDI export (${midi1.name}, ${midi1.bytes.length} bytes)`);
  check(midi1.bytes.equals(midi2.bytes), 'the same take exports identical MIDI bytes');

  const wav = await download('.exports .btn >> nth=1');
  const isWav = wav.bytes.subarray(0, 4).toString('latin1') === 'RIFF' && wav.bytes.subarray(8, 12).toString('latin1') === 'WAVE';
  check(wav.name.endsWith('.wav') && isWav, `WAV export (${wav.name}, ${(wav.bytes.length / 1e6).toFixed(1)} MB)`);
  let peak = 0;
  for (let i = 44; i + 1 < wav.bytes.length; i += 2) peak = Math.max(peak, Math.abs(wav.bytes.readInt16LE(i)));
  const peakDb = 20 * Math.log10(peak / 32768);
  check(peakDb < -1 && peakDb > -6, `WAV peak ${peakDb.toFixed(2)} dBFS is below -1 dBFS`);
  check(wav.bytes.readUInt32LE(24) === 48000 && wav.bytes.readUInt16LE(22) === 2 && wav.bytes.readUInt16LE(34) === 16, 'WAV is 48 kHz, stereo, 16 bit');

  const zip = await download('.exports .btn >> nth=2');
  const eocd = zip.bytes.length - 22;
  check(zip.name.endsWith('-stems.zip') && zip.bytes.readUInt32LE(0) === 0x04034b50 && zip.bytes.readUInt32LE(eocd) === 0x06054b50, `stems export (${zip.name}, ${(zip.bytes.length / 1e6).toFixed(1)} MB)`);
  check(zip.bytes.readUInt16LE(eocd + 10) === 7, 'stems zip holds piano, pad, noise, mix, MIDI, settings and credits');
  check(zip.bytes.includes(Buffer.from('Salamander Grand Piano V3 by Alexander Holm')), 'stems zip carries the piano credit');

  // Seek by clicking the piano roll
  await page.click('.segmented button >> nth=0');
  const box = await page.locator('.view-roll .view-overlay').boundingBox();
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await page.waitForTimeout(900);
  const total = await page.evaluate(() => {
    const [m, s] = (document.querySelector('.time')?.textContent ?? '0:00 / 0:00').split(' / ')[1].split(':').map(Number);
    return m * 60 + s;
  });
  const seeked = await seconds();
  check(Math.abs(seeked - total / 2) <= 4, `clicking the middle of the piano roll jumps there (${seeked} s of ${total} s)`);
  await page.screenshot({ path: 'reports/tmp/ui-3-seek.png' });

  // Keyboard shortcuts
  await page.locator('.topbar').click({ position: { x: 300, y: 10 } });
  await page.keyboard.press('Space');
  await page.waitForTimeout(250);
  check((await page.getAttribute('.hero-side .btn.icon-only', 'aria-pressed')) === 'false', 'Space stops playback');
  await page.keyboard.press('g');
  await page.waitForFunction(() => document.querySelector('.take-title')?.textContent?.startsWith('#4 '), undefined, { timeout: 30_000 });
  check(true, 'G generates a new take');
  // Pins carry over: tempo was fixed by the knob
  data = await stored();
  check(data.takes[0].params.tempo === data.takes[1].params.tempo, 'a fixed knob keeps its value on the next Generate');

  // Chat: words move the knobs, and what changed is shown
  const beforeChat = data.takes[0].params;
  await page.fill('.chat-input', 'sadder, slower, more space, add rain');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);
  data = await stored();
  const afterChat = data.takes[0].params;
  check(data.takes.length === 4, 'a chat message changes the current take, it does not add one');
  check(afterChat.seed === beforeChat.seed, 'chat keeps the seed');
  check(afterChat.tempo === Math.max(40, beforeChat.tempo - 10), `chat "slower" + "sadder" lowers the tempo (${beforeChat.tempo} -> ${afterChat.tempo})`);
  check(afterChat.rain >= 0.25 && afterChat.rain > beforeChat.rain, `chat "add rain" turns the rain on (${beforeChat.rain} -> ${afterChat.rain})`);
  check(afterChat.restProbability > beforeChat.restProbability, 'chat "more space" raises the share of silent bars');
  const shown = ((await text('.chat-changes')) ?? '').replace(/\s+/g, ' ');
  check(shown.includes('Tempo') && shown.includes('Rain') && shown.includes('Space'), `chat shows what changed: ${shown.slice(0, 140)}`);
  check(await page.evaluate(() => document.querySelector('[role="slider"][aria-label="Rain"]')?.closest('.knob')?.classList.contains('is-pinned')), 'knobs moved by chat are fixed');
  await page.screenshot({ path: 'reports/tmp/ui-6-chat.png' });

  await page.fill('.chat-input', 'make it sound like Sweden by C418, and a bit brighter');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);
  data = await stored();
  const refusedText = ((await text('.chat-refused')) ?? '').replace(/\s+/g, ' ');
  check(refusedText.includes('do not copy or imitate existing music') && refusedText.includes('Sweden by C418'), `a reference to existing music is left out and the UI says so: ${refusedText.slice(0, 120)}`);
  check(data.takes[0].params.register === Math.min(79, afterChat.register + 2) && data.takes[0].params.tempo === afterChat.tempo, 'the rest of that message ("a bit brighter") still applies');
  await page.screenshot({ path: 'reports/tmp/ui-7-chat-refused.png' });
  await page.click('.chips .chip >> nth=4');
  await page.waitForTimeout(400);
  data = await stored();
  check(data.takes[0].params.reverbSize > afterChat.reverbSize || afterChat.reverbSize === 6, 'an example chip ("more reverb") applies');
  await page.locator('.topbar').click({ position: { x: 300, y: 10 } });
  await page.keyboard.press('Space');
  await page.waitForTimeout(200);
  if ((await page.getAttribute('.hero-side .btn.icon-only', 'aria-pressed')) === 'true') await page.keyboard.press('Space');

  // Reference: a made-up track (plucked tones, 60 BPM, D minor) is read for general traits only
  {
    const sr = 22050;
    const seconds = 30;
    const pcm = new Float32Array(sr * seconds);
    const scale = [0, 2, 3, 5, 7, 8, 10];
    let x = 12345;
    const rand = () => ((x = (Math.imul(x, 1664525) + 1013904223) >>> 0) / 4294967296);
    for (let t = 0.2; t < seconds - 2; t += 1) {
      const pool = [0, 0, 0, 0, 7, 7, 7, 3, 3, ...scale];
      const midi = 50 + pool[Math.floor(rand() * pool.length)] + (rand() < 0.5 ? 0 : 12);
      const hz = 440 * 2 ** ((midi - 69) / 12);
      const start = Math.round(t * sr);
      for (let i = start; i < Math.min(pcm.length, start + sr); i++) {
        const u = (i - start) / sr;
        pcm[i] += 0.2 * Math.min(1, u / 0.004) * Math.exp(-4 * u) * (Math.sin(2 * Math.PI * hz * u) + 0.25 * Math.sin(4 * Math.PI * hz * u));
      }
    }
    const wavBytes = Buffer.alloc(44 + pcm.length * 2);
    wavBytes.write('RIFF', 0);
    wavBytes.writeUInt32LE(36 + pcm.length * 2, 4);
    wavBytes.write('WAVEfmt ', 8);
    wavBytes.writeUInt32LE(16, 16);
    wavBytes.writeUInt16LE(1, 20);
    wavBytes.writeUInt16LE(1, 22);
    wavBytes.writeUInt32LE(sr, 24);
    wavBytes.writeUInt32LE(sr * 2, 28);
    wavBytes.writeUInt16LE(2, 32);
    wavBytes.writeUInt16LE(16, 34);
    wavBytes.write('data', 36);
    wavBytes.writeUInt32LE(pcm.length * 2, 40);
    for (let i = 0; i < pcm.length; i++) wavBytes.writeInt16LE(Math.round(Math.max(-1, Math.min(1, pcm[i])) * 32767), 44 + i * 2);
    const before = (await stored()).takes[0].params;
    await page.setInputFiles('.reference input[type="file"]', { name: 'my-own-sketch.wav', mimeType: 'audio/wav', buffer: wavBytes });
    await page.waitForSelector('.reference-table', { timeout: 60_000 });
    const table = ((await text('.reference-table')) ?? '').replace(/\s+/g, ' ');
    check(table.includes('Tempo') && table.includes('60 BPM'), `reference: reads the tempo of a 60 BPM test track: ${table.slice(0, 160)}`);
    check(table.includes('Key') && table.includes('Note density') && table.includes('Brightness') && table.includes('Reverb length'), 'reference: shows exactly the five traits');
    check(((await text('.reference')) ?? '').includes('No melody, no chords and no notes are read or kept'), 'reference: the UI says what is read and what is not');
    await page.screenshot({ path: 'reports/tmp/ui-8-reference.png', fullPage: true });
    await page.click('.reference-actions .btn >> nth=0');
    await page.waitForTimeout(500);
    data = await stored();
    check(data.takes[0].params.tempo === 60, `reference: "Use these settings" sets the tempo knob (${before.tempo} -> ${data.takes[0].params.tempo})`);
    check(data.takes[0].params.seed === before.seed, 'reference: the seed is untouched (no notes come from the file)');
    const keys = await page.evaluate(() => Object.keys(localStorage));
    const all = await page.evaluate(() => JSON.stringify(Object.values(localStorage)));
    check(keys.every((k) => k.startsWith('ambientlab.')) && !all.includes('my-own-sketch'), 'reference: nothing about the file is stored');
    await page.locator('.topbar').click({ position: { x: 300, y: 10 } });
    if ((await page.getAttribute('.hero-side .btn.icon-only', 'aria-pressed')) === 'true') await page.keyboard.press('Space');
  }

  // Mood change lets go of the pins
  await page.click('.mood >> nth=3');
  await page.keyboard.press('g');
  await page.waitForFunction(() => document.querySelector('.take-title')?.textContent?.startsWith('#5 Cave'), undefined, { timeout: 30_000 });
  data = await stored();
  check(data.takes[0].preset === 'cave' && data.takes[0].params.tempo >= 40 && data.takes[0].params.tempo <= 48, `Cave take draws inside the Cave ranges (tempo ${data.takes[0].params.tempo})`);
  await page.keyboard.press('Space');

  // Reload: history and favorites are still there, nothing plays by itself
  await page.reload();
  await page.waitForSelector('.takes .take');
  check((await page.locator('.takes .take').count()) === 5, 'history survives a reload');
  check(((await text('.take-title')) ?? '').startsWith('#5 Cave'), 'the newest take is loaded after a reload');
  check((await page.getAttribute('.hero-side .btn.icon-only', 'aria-pressed')) === 'false', 'nothing plays by itself after a reload');
  check((await page.getAttribute('.mood >> nth=3', 'aria-checked')) === 'true', 'the chosen mood survives a reload');
  await page.click('.takes .take-load >> nth=4');
  await page.waitForFunction(() => document.querySelector('.take-title')?.textContent?.startsWith('#1 '), undefined, { timeout: 60_000 });
  await page.waitForFunction(() => document.querySelector('.hero-side .btn.icon-only')?.getAttribute('aria-pressed') === 'true', undefined, { timeout: 60_000 });
  check(true, 'a click in the history loads and plays that take');
  await page.keyboard.press('Space');

  // About dialog
  await page.click('.topbar .btn');
  check(await page.isVisible('dialog[open]'), 'About dialog opens');
  check(((await text('dialog[open]')) ?? '').includes('CC BY 3.0'), 'About shows the sample credit');
  await page.screenshot({ path: 'reports/tmp/ui-4-about.png' });
  await page.keyboard.press('Escape');

  // Narrow screen
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check(overflow <= 1, `no sideways scrolling at 390 px (overflow ${overflow} px)`);
  await page.screenshot({ path: 'reports/tmp/ui-5-mobile.png', fullPage: true });

  check(errors.length === 0, `no console errors${errors.length ? `: ${errors.join(' | ')}` : ''}`);
} catch (error) {
  failures.push(`script error: ${error instanceof Error ? error.stack : String(error)}`);
  if (errors.length) failures.push(`console errors so far: ${errors.join(' | ')}`);
  await page.screenshot({ path: 'reports/tmp/ui-error.png' }).catch(() => undefined);
} finally {
  await browser.close();
  await server.close();
}

console.log(notes.join('\n'));
if (failures.length) {
  console.error(`\nFAILED (${failures.length}):\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('\nOK: the interface works end to end.');
process.exit(0);
