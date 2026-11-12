/**
 * Local backend of the Style Lab. vite.config.ts mounts it on the dev server and on
 * `vite preview`.
 *
 * It holds the API key (from .env, never sent to the page), calls the music API, and
 * keeps every generation on disk in renders/style (git-ignored): the audio as it came
 * back, plus a JSON file with the exact request and the settings. A paid generation is
 * never lost on a page reload.
 *
 *   GET    /api/style/status
 *   GET    /api/style/takes
 *   POST   /api/style/compose        { prompt, lengthSec, vocals, lyrics, modelId, confirmUsd, meta }
 *   POST   /api/style/stems          { id, confirmUsd }
 *   POST   /api/style/takes/<id>     { fx?, rating?, note? }
 *   DELETE /api/style/takes/<id>
 *   GET    /api/style/audio/<file>
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { loadEnv } from 'vite';
import { normalizePostFx } from '../src/postfx/settings';
import { estimateCost, MUSIC_USD_PER_MINUTE } from '../src/style/cost';
import { FAMILY_IDS } from '../src/style/profiles';
import type { ApiErrorBody, ComposeRequestBody, StyleStatus, StyleTake } from '../src/style/take';
import type { FamilyId } from '../src/style/types';
import { buildComposeBody, DEFAULT_MODEL, MODELS, StyleApiError } from '../src/style/request';
import { compose, separateStems } from './elevenlabs';
import { mockAudio } from './mock';
import { unzip } from './unzip';

const PREFIX = '/api/style/';
const FILE_NAME = /^[a-z0-9][a-z0-9._-]{0,80}\.(mp3|wav)$/;
const TAKE_ID = /^[a-z0-9][a-z0-9-]{0,60}$/;
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

interface Env {
  apiKey: string;
  mock: boolean;
  allowRemote: boolean;
  usdPerMinute: number;
  outputFormat: string | undefined;
}

export interface StyleLabOptions {
  /** Where takes are stored. Default: <root>/renders/style. */
  dir?: string;
  /** Replaces the network (tests). */
  fetch?: typeof fetch;
  /** Replaces the .env lookup (tests). */
  env?: Partial<Env>;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(text);
}

function fail(res: ServerResponse, status: number, message: string, code: string, suggestion: string | null = null): void {
  const body: ApiErrorBody = { error: { message, code, suggestion } };
  send(res, status, body);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > 1_000_000) throw new StyleApiError('Request too large.', 413, 'too_large');
    chunks.push(buf);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new StyleApiError('Request body is not JSON.', 400, 'bad_json');
  }
}

function stamp(now: Date): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}

/** The request handler, separate from Vite so tests can call it directly. */
export function createStyleLabHandler(root: string, options: StyleLabOptions = {}) {
  const dir = options.dir ?? join(root, 'renders', 'style');
  const doFetch = options.fetch ?? fetch;

  const env = (): Env => {
    const raw = loadEnv('development', root, '');
    const per = Number(raw.ELEVENLABS_USD_PER_MINUTE);
    return {
      apiKey: raw.ELEVENLABS_API_KEY ?? '',
      mock: raw.STYLE_LAB_MOCK === '1',
      allowRemote: raw.STYLE_LAB_ALLOW_REMOTE === '1',
      usdPerMinute: Number.isFinite(per) && per > 0 ? per : MUSIC_USD_PER_MINUTE,
      outputFormat: raw.ELEVENLABS_OUTPUT_FORMAT || undefined,
      ...options.env,
    };
  };

  const takePath = (id: string): string => join(dir, `${id}.json`);
  const readTake = (id: string): StyleTake | null => {
    if (!TAKE_ID.test(id) || !existsSync(takePath(id))) return null;
    return JSON.parse(readFileSync(takePath(id), 'utf8')) as StyleTake;
  };
  const writeTake = (take: StyleTake): void => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(takePath(take.id), `${JSON.stringify(take, null, 2)}\n`);
  };
  const listTakes = (): StyleTake[] => {
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => readTake(f.slice(0, -5)))
      .filter((t): t is StyleTake => t !== null)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  };
  const freshId = (profile: string): string => {
    const base = `${stamp(new Date())}-${profile}`;
    let id = base;
    for (let n = 2; existsSync(takePath(id)); n++) id = `${base}-${n}`;
    return id;
  };

  async function handleCompose(req: IncomingMessage, res: ServerResponse, e: Env): Promise<void> {
    const body = (await readJson(req)) as Partial<ComposeRequestBody>;
    const meta = body.meta;
    if (!meta || !FAMILY_IDS.includes(meta.profileA) || (meta.profileB !== null && !FAMILY_IDS.includes(meta.profileB as FamilyId))) {
      throw new StyleApiError('Unknown profile.', 400, 'bad_profile');
    }
    const input = {
      prompt: String(body.prompt ?? ''),
      lengthSec: Number(body.lengthSec),
      vocals: Boolean(body.vocals),
      lyrics: String(body.lyrics ?? ''),
      modelId: String(body.modelId ?? DEFAULT_MODEL),
    };
    // Builds (and guards) the request before any money question, so a bad prompt costs nothing.
    const requestBody = buildComposeBody(input);
    const estimate = e.mock ? 0 : estimateCost(input.lengthSec, { usdPerMinute: e.usdPerMinute }).usd;
    if (typeof body.confirmUsd !== 'number' || Math.abs(body.confirmUsd - estimate) > 0.0005) {
      throw new StyleApiError(`Confirm the estimated cost first (${estimate.toFixed(3)} USD).`, 409, 'confirm_cost');
    }
    if (!e.mock && !e.apiKey) {
      throw new StyleApiError('No API key. Put ELEVENLABS_API_KEY=... into the .env file next to package.json.', 503, 'no_key');
    }

    const id = freshId(meta.profileA);
    let audio: Uint8Array;
    let ext = 'mp3';
    if (e.mock) {
      audio = mockAudio(input.lengthSec).full;
      ext = 'wav';
    } else {
      const result = await compose(input, { apiKey: e.apiKey, fetch: doFetch, outputFormat: e.outputFormat });
      audio = result.audio;
      if (/wav|pcm/.test(result.contentType)) ext = 'wav';
    }
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${id}.${ext}`), audio);
    const take: StyleTake = {
      id,
      createdAt: new Date().toISOString(),
      profileA: meta.profileA,
      profileB: meta.profileB ?? null,
      mix: Number(meta.mix) || 0,
      vocals: input.vocals,
      lengthSec: input.lengthSec,
      words: String(meta.words ?? ''),
      prompt: input.prompt.trim(),
      lyrics: 'composition_plan' in requestBody ? input.lyrics.trim() : '',
      body: requestBody,
      model: requestBody.model_id,
      costUsd: estimate,
      mock: e.mock,
      audioFile: `${id}.${ext}`,
      stems: null,
      fx: normalizePostFx(meta.fx ?? {}),
      rating: 0,
      note: '',
    };
    writeTake(take);
    send(res, 200, take);
  }

  async function handleStems(req: IncomingMessage, res: ServerResponse, e: Env): Promise<void> {
    const body = (await readJson(req)) as { id?: unknown; confirmUsd?: unknown };
    const take = typeof body.id === 'string' ? readTake(body.id) : null;
    if (!take) throw new StyleApiError('Unknown take.', 404, 'not_found');
    if (take.stems) return send(res, 200, take);
    const full = estimateCost(take.lengthSec, { stems: true, usdPerMinute: e.usdPerMinute });
    const estimate = take.mock ? 0 : full.lines[1].usd;
    if (typeof body.confirmUsd !== 'number' || Math.abs(body.confirmUsd - estimate) > 0.0005) {
      throw new StyleApiError(`Confirm the estimated cost first (${estimate.toFixed(3)} USD).`, 409, 'confirm_cost');
    }
    let vocals: Uint8Array;
    let backing: Uint8Array;
    let ext = 'mp3';
    if (take.mock) {
      const mock = mockAudio(take.lengthSec);
      vocals = mock.vocals;
      backing = mock.backing;
      ext = 'wav';
    } else {
      if (!e.apiKey) throw new StyleApiError('No API key in .env.', 503, 'no_key');
      const zip = await separateStems(new Uint8Array(readFileSync(join(dir, take.audioFile))), take.audioFile, {
        apiKey: e.apiKey,
        fetch: doFetch,
        outputFormat: e.outputFormat,
      });
      const files = unzip(zip);
      const vocalFile = files.find((f) => /vocal|voice/i.test(f.name));
      const backingFile = files.find((f) => f !== vocalFile);
      if (!vocalFile || !backingFile) {
        throw new StyleApiError(`Stems came back in an unexpected shape: ${files.map((f) => f.name).join(', ') || 'no files'}.`, 502, 'bad_stems');
      }
      vocals = vocalFile.data;
      backing = backingFile.data;
      if (/\.wav$/i.test(vocalFile.name)) ext = 'wav';
    }
    const stems = { vocals: `${take.id}.vocals.${ext}`, backing: `${take.id}.backing.${ext}` };
    writeFileSync(join(dir, stems.vocals), vocals);
    writeFileSync(join(dir, stems.backing), backing);
    const updated: StyleTake = { ...take, stems, costUsd: take.costUsd + estimate };
    writeTake(updated);
    send(res, 200, updated);
  }

  return async function handle(req: IncomingMessage, res: ServerResponse, next: () => void): Promise<void> {
    const url = (req.url ?? '').split('?')[0];
    if (!url.startsWith(PREFIX)) return next();
    const route = url.slice(PREFIX.length);
    const method = req.method ?? 'GET';
    try {
      const e = env();
      if (!e.allowRemote && !LOOPBACK.has(req.socket.remoteAddress ?? '')) {
        return fail(res, 403, 'The Style Lab backend only answers this computer. Set STYLE_LAB_ALLOW_REMOTE=1 in .env to open it up.', 'remote');
      }
      if (route === 'status' && method === 'GET') {
        const status: StyleStatus = {
          keyPresent: e.apiKey.length > 0,
          mock: e.mock,
          usdPerMinute: e.usdPerMinute,
          models: MODELS,
          defaultModel: DEFAULT_MODEL,
        };
        return send(res, 200, status);
      }
      if (route === 'takes' && method === 'GET') return send(res, 200, listTakes());
      if (route === 'compose' && method === 'POST') return await handleCompose(req, res, e);
      if (route === 'stems' && method === 'POST') return await handleStems(req, res, e);
      if (route.startsWith('audio/') && method === 'GET') {
        const file = route.slice('audio/'.length);
        if (!FILE_NAME.test(file) || !existsSync(join(dir, file))) return fail(res, 404, 'No such file.', 'not_found');
        res.statusCode = 200;
        res.setHeader('Content-Type', file.endsWith('.wav') ? 'audio/wav' : 'audio/mpeg');
        res.setHeader('Cache-Control', 'no-store');
        return void res.end(readFileSync(join(dir, file)));
      }
      if (route.startsWith('takes/')) {
        const take = readTake(route.slice('takes/'.length));
        if (!take) return fail(res, 404, 'Unknown take.', 'not_found');
        if (method === 'DELETE') {
          for (const f of [take.audioFile, take.stems?.vocals, take.stems?.backing]) {
            if (f && FILE_NAME.test(f)) rmSync(join(dir, f), { force: true });
          }
          rmSync(takePath(take.id), { force: true });
          return send(res, 200, { ok: true });
        }
        if (method === 'POST') {
          const patch = (await readJson(req)) as Partial<Pick<StyleTake, 'fx' | 'rating' | 'note'>>;
          const updated: StyleTake = { ...take };
          if (patch.fx) updated.fx = normalizePostFx(patch.fx);
          if (patch.rating === 1 || patch.rating === -1 || patch.rating === 0) updated.rating = patch.rating;
          if (typeof patch.note === 'string') updated.note = patch.note.slice(0, 2000);
          writeTake(updated);
          return send(res, 200, updated);
        }
      }
      return fail(res, 404, 'No such route.', 'not_found');
    } catch (err) {
      if (err instanceof StyleApiError) return fail(res, err.status >= 400 ? err.status : 500, err.message, err.code, err.suggestion);
      const message = err instanceof Error ? err.message : String(err);
      return fail(res, 500, message, 'server');
    }
  };
}
