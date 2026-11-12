/**
 * The Style Lab backend with the network replaced: what exactly goes out, what is refused
 * before anything goes out, and what lands on disk.
 */
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compose } from '../../server/elevenlabs';
import { createStyleLabHandler } from '../../server/plugin';
import { unzip } from '../../server/unzip';
import { POSTFX_CLEAN } from '../../src/postfx/settings';
import { estimateCost } from '../../src/style/cost';
import { buildPrompt } from '../../src/style/prompt';
import { buildComposeBody, promptToStyles, sectionPlanFromLyrics, StyleApiError } from '../../src/style/request';
import type { ComposeRequestBody, StyleTake } from '../../src/style/take';
import { makeZip } from '../../src/ui/zip';

const DEFLATED_ZIP = 'UEsDBBQAAAAIALV0bF0MOy5tBwAAACwBAAAQAAAAc3RlbXMvdm9jYWxzLm1wMwsLGwXEAgBQSwMEFAAAAAgAtXRsXehO8zQGAAAAyAAAABYAAABzdGVtcy9pbnN0cnVtZW50YWwubXAz8/QcHgAAUEsBAhQDFAAAAAgAtXRsXQw7Lm0HAAAALAEAABAAAAAAAAAAAAAAAIABAAAAAHN0ZW1zL3ZvY2Fscy5tcDNQSwECFAMUAAAACAC1dGxd6E7zNAYAAADIAAAAFgAAAAAAAAAAAAAAgAE1AAAAc3RlbXMvaW5zdHJ1bWVudGFsLm1wM1BLBQYAAAAAAgACAIIAAABvAAAAAAA=';
const prompt = buildPrompt({ a: 'bedroom-demo', b: null, mix: 0, words: '', vocals: false, lengthSec: 60 });

describe('buildComposeBody', () => {
  it('prompt mode: text, length in ms, instrumental flag', () => {
    expect(buildComposeBody({ prompt, lengthSec: 60, vocals: false })).toEqual({
      prompt,
      music_length_ms: 60000,
      model_id: 'music_v2_5',
      force_instrumental: true,
    });
    const sung = buildComposeBody({ prompt, lengthSec: 45, vocals: true, modelId: 'music_v1' });
    expect(sung).toMatchObject({ force_instrumental: false, model_id: 'music_v1', music_length_ms: 45000 });
    expect(buildComposeBody({ prompt, lengthSec: 45, vocals: true, modelId: 'nope' })).toMatchObject({ model_id: 'music_v2_5' });
  });

  it('turns the prompt into short style phrases for a plan', () => {
    const { styles, avoid } = promptToStyles('A slow song.\nGenre: ambient folk, dream pop.\nVocals: hushed, mixed low.\nMood: calm.\nAvoid: drums, bright leads.\nAlso: more hiss.');
    expect(styles).toEqual(['A slow song', 'ambient folk', 'dream pop', 'Vocals: hushed, mixed low', 'calm', 'more hiss']);
    expect(avoid).toEqual(['drums', 'bright leads']);
  });

  it('lyrics mode on the current models: chunks with the lines in their text', () => {
    const lyrics = '[verse 1]\nline one\nline two\n\n[refrain]\nline three';
    const body = buildComposeBody({ prompt, lengthSec: 100, vocals: true, lyrics });
    if (!('composition_plan' in body) || !('chunks' in body.composition_plan)) throw new Error('expected a chunk plan');
    expect(body.model_id).toBe('music_v2_5');
    expect('respect_sections_durations' in body).toBe(false);
    const { chunks } = body.composition_plan;
    expect(chunks.map((c) => c.text)).toEqual(['[intro]', '[verse 1]\nline one\nline two', '[refrain]\nline three', '[outro]']);
    expect(chunks.reduce((sum, c) => sum + c.duration_ms, 0)).toBe(100000);
    expect(chunks[0].positive_styles).toContain('lo-fi bedroom recording');
    expect(chunks[0].positive_styles.at(-1)).toBe('instrumental, no singing');
    expect(chunks[0].negative_styles).toContain('vocals');
    expect(chunks[1].negative_styles).toEqual(['polished studio sound', 'bright modern production', 'busy arrangement']);
    expect(chunks.every((c) => c.duration_ms >= 3000 && c.duration_ms <= 120000)).toBe(true);
    // Lyrics are ignored when vocals are off.
    expect('prompt' in buildComposeBody({ prompt, lengthSec: 100, vocals: false, lyrics })).toBe(true);
  });

  it('lyrics mode on music_v1: the older section plan', () => {
    const lyrics = '[verse 1]\nline one\nline two\n\n[refrain]\nline three';
    const body = buildComposeBody({ prompt, lengthSec: 100, vocals: true, lyrics, modelId: 'music_v1' });
    if (!('composition_plan' in body) || !('sections' in body.composition_plan)) throw new Error('expected a section plan');
    expect(body.model_id).toBe('music_v1');
    const plan = body.composition_plan;
    expect(plan.sections.map((s) => s.section_name)).toEqual(['intro', 'verse 1', 'refrain', 'outro']);
    expect(plan.sections[1].lines).toEqual(['line one', 'line two']);
    expect(plan.sections[0].lines).toEqual([]);
    expect(plan.sections.reduce((sum, s) => sum + s.duration_ms, 0)).toBe(100000);
    expect(plan.negative_global_styles).toEqual(['polished studio sound', 'bright modern production', 'busy arrangement']);
    expect(plan.positive_global_styles[0]).toBe('A loose, home-recorded instrumental sketch');
    expect(sectionPlanFromLyrics(prompt, lyrics, 30).sections.every((s) => s.duration_ms >= 3000)).toBe(true);
    const long = Array.from({ length: 40 }, (_, i) => `line ${i} ${'x'.repeat(300)}`).join('\n');
    const capped = sectionPlanFromLyrics(prompt, long, 120).sections[1];
    expect(capped.lines).toHaveLength(30);
    expect(capped.lines.every((l) => l.length <= 200)).toBe(true);
  });

  it('refuses names, empty and oversized prompts, and bad lengths before anything is sent', () => {
    const bad = (input: Parameters<typeof buildComposeBody>[0], code: string): void => {
      try {
        buildComposeBody(input);
        throw new Error('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(StyleApiError);
        expect((err as StyleApiError).code).toBe(code);
        expect((err as StyleApiError).status).toBe(400);
      }
    };
    bad({ prompt: 'a song in the style of somebody famous', lengthSec: 60, vocals: false }, 'guard');
    bad({ prompt: 'slow song with Xavier Quillfeather singing', lengthSec: 60, vocals: true }, 'guard');
    bad({ prompt: '   ', lengthSec: 60, vocals: false }, 'empty_prompt');
    bad({ prompt: 'x'.repeat(4101), lengthSec: 60, vocals: false }, 'prompt_too_long');
    bad({ prompt, lengthSec: 5, vocals: false }, 'bad_length');
    bad({ prompt, lengthSec: 900, vocals: false }, 'bad_length');
  });
});

describe('compose', () => {
  it('posts the body with the key in the header and returns the bytes', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
    }) as unknown as typeof fetch;
    const result = await compose({ prompt, lengthSec: 60, vocals: false }, { apiKey: 'k-123', fetch: fake });
    expect(Array.from(result.audio)).toEqual([1, 2, 3]);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.elevenlabs.io/v1/music?output_format=auto');
    expect(calls[0].init.method).toBe('POST');
    expect((calls[0].init.headers as Record<string, string>)['xi-api-key']).toBe('k-123');
    expect(JSON.parse(calls[0].init.body as string)).toEqual(buildComposeBody({ prompt, lengthSec: 60, vocals: false }));
  });

  it("passes on the provider's refusal and its suggested prompt", async () => {
    const fake = (async () =>
      new Response(JSON.stringify({ detail: { status: 'bad_prompt', message: 'no', data: { prompt_suggestion: 'try this' } } }), {
        status: 400,
      })) as unknown as typeof fetch;
    await expect(compose({ prompt, lengthSec: 60, vocals: false }, { apiKey: 'k', fetch: fake })).rejects.toMatchObject({
      status: 400,
      code: 'bad_prompt',
      suggestion: 'try this',
    });
  });
});

describe('unzip', () => {
  it('reads stored and deflated archives', () => {
    const stored = unzip(makeZip([{ name: 'a.txt', data: new Uint8Array([104, 105]) }]));
    expect(stored).toEqual([{ name: 'a.txt', data: new Uint8Array([104, 105]) }]);
    const deflated = unzip(new Uint8Array(Buffer.from(DEFLATED_ZIP, 'base64')));
    expect(deflated.map((f) => [f.name, f.data.length])).toEqual([
      ['stems/vocals.mp3', 300],
      ['stems/instrumental.mp3', 200],
    ]);
    expect(() => unzip(new Uint8Array(40))).toThrow();
  });
});

describe('backend routes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'stylelab-'));
  const outbound: { url: string; body: unknown }[] = [];
  const env = { apiKey: 'k-test', mock: false, allowRemote: false, usdPerMinute: 0.15, outputFormat: undefined as string | undefined };
  const fakeFetch = (async (url: string, init: RequestInit) => {
    outbound.push({ url, body: typeof init.body === 'string' ? JSON.parse(init.body) : 'form' });
    if (url.includes('stem-separation')) return new Response(Buffer.from(DEFLATED_ZIP, 'base64'), { status: 200 });
    return new Response(new Uint8Array([9, 9, 9, 9]), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
  }) as unknown as typeof fetch;
  let server: Server;
  let base = '';

  beforeAll(async () => {
    const handle = createStyleLabHandler(process.cwd(), { dir, fetch: fakeFetch, env });
    server = createServer((req, res) => void handle(req, res, () => res.end('next')));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/style/`;
  });
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });

  const request = (over: Partial<ComposeRequestBody> = {}): ComposeRequestBody => ({
    prompt,
    lengthSec: 60,
    vocals: false,
    lyrics: '',
    modelId: 'music_v2_5',
    confirmUsd: estimateCost(60).usd,
    meta: { profileA: 'bedroom-demo', profileB: null, mix: 0, words: '', fx: POSTFX_CLEAN },
    ...over,
  });
  const post = (route: string, body: unknown): Promise<Response> =>
    fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  it('reports its status without leaking the key', async () => {
    const res = await fetch(`${base}status`);
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ keyPresent: true, mock: false, usdPerMinute: 0.15, defaultModel: 'music_v2_5' });
    expect(text).not.toContain('k-test');
  });

  it('wants the cost confirmed, and sends nothing until it is', async () => {
    const res = await post('compose', request({ confirmUsd: 0 }));
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('confirm_cost');
    expect(outbound).toHaveLength(0);
  });

  it('refuses a name before any call', async () => {
    const res = await post('compose', request({ prompt: 'something by Quillfeather' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('guard');
    expect(outbound).toHaveLength(0);
  });

  it('generates, stores audio and settings, and serves them back', async () => {
    const res = await post('compose', request());
    expect(res.status).toBe(200);
    const take = (await res.json()) as StyleTake;
    expect(take).toMatchObject({ profileA: 'bedroom-demo', lengthSec: 60, mock: false, costUsd: 0.15, model: 'music_v2_5', stems: null });
    expect(take.audioFile).toBe(`${take.id}.mp3`);
    expect(outbound).toHaveLength(1);
    expect(outbound[0].body).toEqual(take.body);
    expect(JSON.stringify(outbound[0].body)).not.toContain('k-test');
    expect(readdirSync(dir).sort()).toEqual([`${take.id}.json`, `${take.id}.mp3`]);

    const audio = await fetch(`${base}audio/${take.audioFile}`);
    expect(audio.headers.get('content-type')).toBe('audio/mpeg');
    expect(new Uint8Array(await audio.arrayBuffer())).toEqual(new Uint8Array([9, 9, 9, 9]));
    expect((await fetch(`${base}audio/..%2Fpackage.json`)).status).toBe(404);

    const list = (await (await fetch(`${base}takes`)).json()) as StyleTake[];
    expect(list.map((t) => t.id)).toEqual([take.id]);

    const patched = (await (await post(`takes/${take.id}`, { rating: 1, note: 'ok', fx: { ...POSTFX_CLEAN, room: 0.4 } })).json()) as StyleTake;
    expect(patched).toMatchObject({ rating: 1, note: 'ok' });
    expect(patched.fx.room).toBe(0.4);

    // Stems: cost confirmed separately, files unpacked from the archive.
    expect((await post('stems', { id: take.id, confirmUsd: 0 })).status).toBe(409);
    const stems = (await (await post('stems', { id: take.id, confirmUsd: estimateCost(60, { stems: true }).lines[1].usd })).json()) as StyleTake;
    expect(stems.stems).toEqual({ vocals: `${take.id}.vocals.mp3`, backing: `${take.id}.backing.mp3` });
    expect(stems.costUsd).toBeCloseTo(0.225, 3);
    expect((await (await fetch(`${base}audio/${take.id}.vocals.mp3`)).arrayBuffer()).byteLength).toBe(300);

    expect((await fetch(`${base}takes/${take.id}`, { method: 'DELETE' })).status).toBe(200);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('says so when there is no key, and costs nothing in mock mode', async () => {
    env.apiKey = '';
    const before = outbound.length;
    const noKey = await post('compose', request());
    expect(noKey.status).toBe(503);
    expect((await noKey.json()).error.code).toBe('no_key');

    env.mock = true;
    const res = await post('compose', request({ lengthSec: 20, confirmUsd: 0 }));
    expect(res.status).toBe(200);
    const take = (await res.json()) as StyleTake;
    expect(take).toMatchObject({ mock: true, costUsd: 0 });
    expect(take.audioFile.endsWith('.wav')).toBe(true);
    const wav = new Uint8Array(await (await fetch(`${base}audio/${take.audioFile}`)).arrayBuffer());
    expect(wav.length).toBe(44 + 20 * 48000 * 4);
    const withStems = (await (await post('stems', { id: take.id, confirmUsd: 0 })).json()) as StyleTake;
    expect(withStems.stems?.vocals.endsWith('.vocals.wav')).toBe(true);
    expect(outbound.length).toBe(before);
    env.mock = false;
    env.apiKey = 'k-test';
  });
});
