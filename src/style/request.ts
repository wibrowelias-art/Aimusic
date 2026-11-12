/**
 * The exact JSON body of a music API request, built from descriptor text (and, in lyrics
 * mode, the owner's own lines). Pure: the page uses it to show what would be sent, the
 * local server uses it to send exactly that. The descriptor guard runs in here, so a name
 * or a title is refused wherever the body is built.
 *
 * API facts used (elevenlabs.io/docs/api-reference/music/compose and the composition plan
 * guide, read 2026-11-12):
 *   prompt + music_length_ms (3000..600000) + force_instrumental (prompt mode only), or
 *   composition_plan, whose shape depends on the model:
 *     music_v1:            { positive_global_styles, negative_global_styles,
 *                            sections[{ section_name, positive_local_styles,
 *                            negative_local_styles, duration_ms, lines }] }
 *     music_v2, music_v2_5: { chunks[{ text, duration_ms, positive_styles, negative_styles }] }
 *                            text = "[Section name]" then the lyric lines
 *   A section or chunk lasts 3000..120000 ms and holds at most 30 lines of 200 characters.
 */
import { checkDescriptors, GUARD_RULE } from './guard';
import { LYRICS_MAX_LINE_CHARS, parseLyrics, type LyricsSection } from './lyrics';
import { LENGTH_MAX_SEC, LENGTH_MIN_SEC } from './types';

export const PROMPT_MAX_CHARS = 4100;
export const MODELS = ['music_v2_5', 'music_v2', 'music_v1'] as const;
/** The model the provider's own quickstart uses. */
export const DEFAULT_MODEL = 'music_v2_5';
/** The one model that takes the older section plan instead of chunks. */
export const SECTION_PLAN_MODEL = 'music_v1';
export const SECTION_MIN_MS = 3000;
export const SECTION_MAX_MS = 120000;
export const SECTION_MAX_LINES = 30;
export const SECTION_NAME_MAX_CHARS = 100;
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

/** Plan shape of music_v1. */
export interface SectionPlan {
  positive_global_styles: string[];
  negative_global_styles: string[];
  sections: PlanSection[];
}

export interface PlanChunk {
  text: string;
  duration_ms: number;
  positive_styles: string[];
  negative_styles: string[];
}

/** Plan shape of music_v2 and music_v2_5. */
export interface ChunkPlan {
  chunks: PlanChunk[];
}

export type ComposeBody =
  | { prompt: string; music_length_ms: number; model_id: string; force_instrumental: boolean }
  | { composition_plan: SectionPlan; model_id: string; respect_sections_durations: boolean }
  | { composition_plan: ChunkPlan; model_id: string };

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
/** Lines of the prompt whose comma-separated items each stand on their own as a style. */
const LIST_LABELS = /^(genre|instruments|production|mood|also)\s*:\s*(.+)$/i;

/**
 * The prompt text as short style phrases for a plan. List lines (genre, instruments,
 * production, mood, also) are split at their commas; "Avoid:" becomes the negative list;
 * every other line (the opening sentence, vocals, tempo, structure, or anything written
 * by hand) stays whole.
 */
export function promptToStyles(prompt: string): { styles: string[]; avoid: string[] } {
  const styles: string[] = [];
  const avoid: string[] = [];
  const items = (text: string): string[] =>
    text
      .split(',')
      .map((item) => item.trim().replace(/[.\s]+$/, ''))
      .filter((item) => item.length > 0);
  for (const raw of prompt.split(/\n+/)) {
    const line = raw.trim().replace(/[.\s]+$/, '');
    if (!line) continue;
    const no = /^avoid\s*:\s*(.+)$/i.exec(line);
    if (no) {
      avoid.push(...items(no[1]));
      continue;
    }
    const list = LIST_LABELS.exec(line);
    if (list) styles.push(...items(list[2]));
    else styles.push(line);
  }
  return { styles, avoid };
}

interface Slot {
  name: string;
  lines: string[];
  durationMs: number;
}

/** Intro without words, one slot per stanza (time by line count), outro without words. */
function layoutSlots(stanzas: readonly LyricsSection[], lengthSec: number): Slot[] {
  const totalMs = Math.round(lengthSec * 1000);
  const introMs = clamp(Math.round(totalMs * INTRO_SHARE), SECTION_MIN_MS, SECTION_MAX_MS);
  const outroMs = clamp(Math.round(totalMs * OUTRO_SHARE), SECTION_MIN_MS, SECTION_MAX_MS);
  const sung = stanzas.map((s) => ({
    name: s.name.slice(0, SECTION_NAME_MAX_CHARS),
    lines: s.lines.slice(0, SECTION_MAX_LINES).map((l) => l.slice(0, LYRICS_MAX_LINE_CHARS)),
  }));
  const lineCount = sung.reduce((sum, s) => sum + s.lines.length, 0) || 1;
  const sungMs = Math.max(SECTION_MIN_MS * sung.length, totalMs - introMs - outroMs);
  return [
    { name: 'intro', lines: [], durationMs: introMs },
    ...sung.map((s) => ({ ...s, durationMs: clamp(Math.round((sungMs * s.lines.length) / lineCount), SECTION_MIN_MS, SECTION_MAX_MS) })),
    { name: 'outro', lines: [], durationMs: outroMs },
  ];
}

/** Plan for music_v1: global styles plus named sections. */
export function sectionPlanFromLyrics(prompt: string, lyrics: string, lengthSec: number): SectionPlan {
  const { styles, avoid } = promptToStyles(prompt);
  return {
    positive_global_styles: styles,
    negative_global_styles: avoid,
    sections: layoutSlots(parseLyrics(lyrics), lengthSec).map((slot) => ({
      section_name: slot.name,
      positive_local_styles: slot.lines.length === 0 ? ['instrumental'] : [],
      negative_local_styles: slot.lines.length === 0 ? ['vocals'] : [],
      duration_ms: slot.durationMs,
      lines: slot.lines,
    })),
  };
}

/** Plan for music_v2 and music_v2_5: chunks, each with its text and the full style list. */
export function chunkPlanFromLyrics(prompt: string, lyrics: string, lengthSec: number): ChunkPlan {
  const { styles, avoid } = promptToStyles(prompt);
  return {
    chunks: layoutSlots(parseLyrics(lyrics), lengthSec).map((slot) => ({
      text: [`[${slot.name}]`, ...slot.lines].join('\n'),
      duration_ms: slot.durationMs,
      positive_styles: slot.lines.length === 0 ? [...styles, 'instrumental, no singing'] : styles,
      negative_styles: slot.lines.length === 0 ? [...avoid, 'vocals'] : avoid,
    })),
  };
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
  const modelId = (MODELS as readonly string[]).includes(input.modelId ?? '') ? (input.modelId as string) : DEFAULT_MODEL;
  const lyrics = input.vocals ? (input.lyrics ?? '').trim() : '';
  if (lyrics && parseLyrics(lyrics).length > 0) {
    return modelId === SECTION_PLAN_MODEL
      ? { composition_plan: sectionPlanFromLyrics(prompt, lyrics, input.lengthSec), model_id: modelId, respect_sections_durations: true }
      : { composition_plan: chunkPlanFromLyrics(prompt, lyrics, input.lengthSec), model_id: modelId };
  }
  return {
    prompt,
    music_length_ms: Math.round(input.lengthSec * 1000),
    model_id: modelId,
    force_instrumental: !input.vocals,
  };
}
