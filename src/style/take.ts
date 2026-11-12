/** One generation of the Style Lab as the local server stores it next to its audio file. */
import type { PostFxSettings } from '../postfx/settings';
import type { FamilyId } from './types';

export interface StyleTake {
  /**
   * 'sketch' = made by the built-in generator in the browser (free; kept in localStorage,
   * the audio is made again from `seed` and the settings). Missing or 'ai' = made by the
   * music API through the local server (audio kept on disk).
   */
  engine?: 'ai' | 'sketch';
  /** uint32 seed of a 'sketch' take. */
  seed?: number;
  /** 'sketch' takes made with "match my own song": the tempo and hit pattern that were read (numbers only). */
  match?: { tempoBpm: number; grid: number[] } | null;
  /**
   * "My recording + a new melody on top": this take is the owner's own recording with a new
   * melody over it. The recording itself is never stored, so such a take only lives until
   * the page is closed.
   */
  overlay?: { dipDb: number; melodyDb: number; offsetSec: number; keyPc: number; mode: string } | null;
  id: string;
  /** ISO time the server wrote the file. */
  createdAt: string;
  profileA: FamilyId;
  profileB: FamilyId | null;
  /** Share of profileB, 0..1. */
  mix: number;
  vocals: boolean;
  lengthSec: number;
  words: string;
  /** The descriptor text that was sent. */
  prompt: string;
  /** The owner's lyrics that were sent ('' = none). */
  lyrics: string;
  /** The exact JSON body that went to the music API. */
  body: unknown;
  model: string;
  /** The estimate that was confirmed before the call, USD. */
  costUsd: number;
  /** True for the built-in test signal (no API call, no cost). */
  mock: boolean;
  /** File names inside renders/style. */
  audioFile: string;
  stems: { vocals: string; backing: string } | null;
  /** Lo-fi chain settings last used on this take. */
  fx: PostFxSettings;
  rating: -1 | 0 | 1;
  note: string;
}

export interface StyleStatus {
  keyPresent: boolean;
  mock: boolean;
  usdPerMinute: number;
  models: readonly string[];
  defaultModel: string;
}

export interface ComposeRequestBody {
  prompt: string;
  lengthSec: number;
  vocals: boolean;
  lyrics: string;
  modelId: string;
  /** The estimate the owner confirmed. The server refuses when it does not match its own. */
  confirmUsd: number;
  meta: { profileA: FamilyId; profileB: FamilyId | null; mix: number; words: string; fx: PostFxSettings };
}

export interface ApiErrorBody {
  error: { message: string; code: string; suggestion: string | null };
}
