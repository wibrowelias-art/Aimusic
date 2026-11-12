/**
 * Client for the ElevenLabs Music API. Node side only: the key never reaches the browser.
 *
 * What goes out is built by `buildComposeBody` from plain descriptor text (and, in
 * lyrics mode, the owner's own lines). The descriptor guard runs here as well, so a
 * name or a title is refused even if the page was bypassed.
 *
 * API facts used (elevenlabs.io/docs/api-reference/music, read 2026-11-12):
 *   POST /v1/music?output_format=...   header xi-api-key   JSON body
 *   prompt (<= 4100 chars) + music_length_ms (3000..600000) + force_instrumental, or
 *   composition_plan (music_v1 only) { positive_global_styles, negative_global_styles,
 *   sections[{ section_name, positive_local_styles, negative_local_styles, duration_ms, lines }] }
 *   A refused prompt answers with detail.status "bad_prompt" and detail.data.prompt_suggestion.
 *   POST /v1/music/stem-separation  multipart (file, stem_variation_id) -> ZIP of stems.
 */
import { checkDescriptors, GUARD_RULE } from '../src/style/guard';
import { LYRICS_MAX_LINE_CHARS, parseLyrics } from '../src/style/lyrics';
import { splitPrompt } from '../src/style/prompt';
import { LENGTH_MAX_SEC, LENGTH_MIN_SEC } from '../src/style/types';

export const API_BASE = 'https://api.elevenlabs.io';
export const PROMPT_MAX_CHARS = 4100;
export const DEFAULT_MODEL = 'music_v1';
export const MODELS = ['music_v1', 'music_v2', 'music_v2_5'] as const;
/** Composition plans (needed for custom lyrics) exist for this model only. */
export const PLAN_MODEL = 'music_v1';
export const DEFAULT_OUTPUT_FORMAT = 'mp3_44100_128';
export const SECTION_MIN_MS = 3000;
export const SECTION_MAX_MS = 120000;
/** Share of the length kept free of lyrics at the start and at the end. */
export const INTRO_SHARE = 0.12;
export const OUTRO_SHARE = 0.12;

export interface ComposeInput {
  /** Descriptor text, exactly as shown in the UI. */
  prompt: string;
  lengthSec: number;
  vocals: boolean;
  /** The owner's own lyrics (optional). Empty = the model writes its own words, or none. */
  lyrics?: string;
  modelId?: string;
}

export interface PlanSection {
  section_name: string;
  positive_local_styles: string[];
  negative_local_styles: string[];
  duration_ms: number;
  lines: string[];
}

export interface CompositionPlan {
  positive_global_styles: string[];
  negative_global_styles: string[];
  sections: PlanSection[];
}

export type ComposeBody =
  | { prompt: string; music_length_ms: number; model_id: string; force_instrumental: boolean }
  | { composition_plan: CompositionPlan; model_id: string; respect_sections_durations: boolean };

export class StyleApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    /** The provider's rewritten prompt, when it sent one. */
    readonly suggestion: string | null = null,
  ) {
    super(message);
    this.name = 'StyleApiError';
  }
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** A composition plan from descriptor text and lyrics: instrumental intro, one section per stanza, outro. */
export function planFromLyrics(prompt: string, lyrics: string, lengthSec: number): CompositionPlan {
  const { styles, avoid } = splitPrompt(prompt);
  const stanzas = parseLyrics(lyrics);
  const totalMs = Math.round(lengthSec * 1000);
  const introMs = clamp(Math.round(totalMs * INTRO_SHARE), SECTION_MIN_MS, SECTION_MAX_MS);
  const outroMs = clamp(Math.round(totalMs * OUTRO_SHARE), SECTION_MIN_MS, SECTION_MAX_MS);
  const lineCount = stanzas.reduce((sum, s) => sum + s.lines.length, 0) || 1;
  const sungMs = Math.max(SECTION_MIN_MS * stanzas.length, totalMs - introMs - outroMs);
  const sections: PlanSection[] = [
    { section_name: 'intro', positive_local_styles: ['instrumental'], negative_local_styles: ['vocals'], duration_ms: introMs, lines: [] },
    ...stanzas.map((s) => ({
      section_name: s.name,
      positive_local_styles: [],
      negative_local_styles: [],
      duration_ms: clamp(Math.round((sungMs * s.lines.length) / lineCount), SECTION_MIN_MS, SECTION_MAX_MS),
      lines: s.lines.map((l) => l.slice(0, LYRICS_MAX_LINE_CHARS)),
    })),
    { section_name: 'outro', positive_local_styles: ['instrumental'], negative_local_styles: ['vocals'], duration_ms: outroMs, lines: [] },
  ];
  return { positive_global_styles: styles, negative_global_styles: avoid, sections };
}

/**
 * The exact JSON body for a request. Throws a StyleApiError (status 400) when the
 * descriptor text trips the guard or the numbers are out of range: nothing is sent then.
 */
export function buildComposeBody(input: ComposeInput): ComposeBody {
  const prompt = input.prompt.trim();
  if (!prompt) throw new StyleApiError('The prompt is empty.', 400, 'empty_prompt');
  if (prompt.length > PROMPT_MAX_CHARS) {
    throw new StyleApiError(`The prompt is ${prompt.length} characters; the limit is ${PROMPT_MAX_CHARS}.`, 400, 'prompt_too_long');
  }
  const guard = checkDescriptors(prompt);
  if (!guard.ok) {
    throw new StyleApiError(`${GUARD_RULE} ${guard.issues.map((i) => i.message).join(' ')}`, 400, 'guard');
  }
  if (!Number.isFinite(input.lengthSec) || input.lengthSec < LENGTH_MIN_SEC || input.lengthSec > LENGTH_MAX_SEC) {
    throw new StyleApiError(`Length must be ${LENGTH_MIN_SEC}-${LENGTH_MAX_SEC} seconds.`, 400, 'bad_length');
  }
  const lyrics = input.vocals ? (input.lyrics ?? '').trim() : '';
  if (lyrics && parseLyrics(lyrics).length > 0) {
    return {
      composition_plan: planFromLyrics(prompt, lyrics, input.lengthSec),
      model_id: PLAN_MODEL,
      respect_sections_durations: true,
    };
  }
  const modelId = (MODELS as readonly string[]).includes(input.modelId ?? '') ? (input.modelId as string) : DEFAULT_MODEL;
  return {
    prompt,
    music_length_ms: Math.round(input.lengthSec * 1000),
    model_id: modelId,
    force_instrumental: !input.vocals,
  };
}

export interface ClientDeps {
  apiKey: string;
  fetch: typeof fetch;
  outputFormat?: string;
  timeoutMs?: number;
}

/** Turns a non-2xx answer into a StyleApiError with the provider's own words. */
export async function errorFrom(res: Response): Promise<StyleApiError> {
  let code = `http_${res.status}`;
  let message = `The music API answered ${res.status}.`;
  let suggestion: string | null = null;
  try {
    const body = (await res.json()) as { detail?: unknown };
    const detail = body.detail;
    if (typeof detail === 'string') {
      message = detail;
    } else if (detail && typeof detail === 'object') {
      const d = detail as { status?: unknown; message?: unknown; data?: { prompt_suggestion?: unknown } };
      if (typeof d.status === 'string') code = d.status;
      if (typeof d.message === 'string') message = d.message;
      if (d.data && typeof d.data.prompt_suggestion === 'string') suggestion = d.data.prompt_suggestion;
    }
  } catch {
    // Not JSON: keep the generic message.
  }
  if (res.status === 401) message = `The API key was not accepted (401). ${message}`;
  return new StyleApiError(message, res.status, code, suggestion);
}

export interface ComposeResult {
  audio: Uint8Array;
  contentType: string;
  body: ComposeBody;
}

export async function compose(input: ComposeInput, deps: ClientDeps): Promise<ComposeResult> {
  const body = buildComposeBody(input);
  const url = `${API_BASE}/v1/music?output_format=${encodeURIComponent(deps.outputFormat ?? DEFAULT_OUTPUT_FORMAT)}`;
  const res = await deps.fetch(url, {
    method: 'POST',
    headers: { 'xi-api-key': deps.apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(deps.timeoutMs ?? 600_000),
  });
  if (!res.ok) throw await errorFrom(res);
  return {
    audio: new Uint8Array(await res.arrayBuffer()),
    contentType: res.headers.get('content-type') ?? 'audio/mpeg',
    body,
  };
}

/** Two stems (vocals and the rest) as the provider's ZIP archive. */
export async function separateStems(audio: Uint8Array, fileName: string, deps: ClientDeps): Promise<Uint8Array> {
  const form = new FormData();
  form.append('file', new Blob([audio as Uint8Array<ArrayBuffer>], { type: 'audio/mpeg' }), fileName);
  form.append('stem_variation_id', 'two_stems_v1');
  const url = `${API_BASE}/v1/music/stem-separation?output_format=${encodeURIComponent(deps.outputFormat ?? DEFAULT_OUTPUT_FORMAT)}`;
  const res = await deps.fetch(url, {
    method: 'POST',
    headers: { 'xi-api-key': deps.apiKey },
    body: form,
    signal: AbortSignal.timeout(deps.timeoutMs ?? 600_000),
  });
  if (!res.ok) throw await errorFrom(res);
  return new Uint8Array(await res.arrayBuffer());
}
