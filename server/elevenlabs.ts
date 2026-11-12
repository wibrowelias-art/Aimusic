/**
 * Client for the ElevenLabs Music API. Node side only: the key never reaches the browser.
 * The body comes from src/style/request.ts (guarded there).
 *
 * API facts used (elevenlabs.io/docs/api-reference/music, read 2026-11-12):
 *   POST /v1/music?output_format=...   header xi-api-key   JSON body -> audio bytes
 *   A refused prompt answers with detail.status "bad_prompt" and detail.data.prompt_suggestion.
 *   POST /v1/music/stem-separation  multipart (file, stem_variation_id) -> ZIP of stems.
 */
import { buildComposeBody, StyleApiError, type ComposeBody, type ComposeInput } from '../src/style/request';

export const API_BASE = 'https://api.elevenlabs.io';
export const DEFAULT_OUTPUT_FORMAT = 'mp3_44100_128';

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
