/**
 * The exact JSON body of a music API request, built from descriptor text (and, in lyrics
 * mode, the owner's own lines). Pure: the page uses it to show what would be sent, the
 * local server uses it to send exactly that. The descriptor guard runs in here, so a name
 * or a title is refused wherever the body is built.
 *
 * API facts used (elevenlabs.io/docs/api-reference/music, read 2026-11-12):
 *   prompt (<= 4100 chars) + music_length_ms (3000..600000) + force_instrumental, or
 *   composition_plan (music_v1 only) { positive_global_styles, negative_global_styles,
 *   sections[{ section_name, positive_local_styles, negative_local_styles, duration_ms, lines }] }
 */
import { checkDescriptors, GUARD_RULE } from './guard';
import { LYRICS_MAX_LINE_CHARS, parseLyrics } from './lyrics';
import { splitPrompt } from './prompt';
import { LENGTH_MAX_SEC, LENGTH_MIN_SEC } from './types';

export const PROMPT_MAX_CHARS = 4100;
export const DEFAULT_MODEL = 'music_v1';
export const MODELS = ['music_v1', 'music_v2', 'music_v2_5'] as const;
/** Composition plans (needed for custom lyrics) exist for this model only. */
export const PLAN_MODEL = 'music_v1';
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
