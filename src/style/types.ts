/**
 * Contracts of the Style Lab: a style profile is a set of plain sound descriptors plus a
 * preset for the lo-fi chain. No artist names, no song titles, no notes, anywhere.
 */
import type { PostFxSettings } from '../postfx/settings';

export type FamilyId = 'ambient-keys' | 'bedroom-demo' | 'dream-folk' | 'slowcore' | 'slowed-reverb';

/** The old piano engine, kept as its own profile. It never calls the music API. */
export const PIANO_OFFLINE_ID = 'piano-offline';
export type ProfileId = FamilyId | typeof PIANO_OFFLINE_ID;

export interface StyleProfile {
  id: FamilyId;
  /** Name in the UI. */
  label: string;
  /** One line under the name. */
  blurb: string;
  /** Short noun phrase for the first sentence of the prompt, e.g. "slow, quiet ambient piano piece". */
  lead: string;
  genre: readonly string[];
  instruments: readonly string[];
  /** How the voice is described when vocals are on. */
  vocal: string;
  vocalsDefault: boolean;
  tempoBpm: readonly [number, number];
  tempoFeel: string;
  production: readonly string[];
  mood: readonly string[];
  structure: string;
  /** Things the prompt asks to leave out. */
  avoid: readonly string[];
  /** Default length of a generation, seconds. */
  lengthSec: number;
  fx: PostFxSettings;
}

export interface StyleRequest {
  a: FamilyId;
  /** Second profile to mix in, or null. */
  b: FamilyId | null;
  /** Share of `b`, 0..1. */
  mix: number;
  /** The owner's own words, appended as they are. */
  words: string;
  vocals: boolean;
  lengthSec: number;
}

export const LENGTH_MIN_SEC = 20;
export const LENGTH_MAX_SEC = 240;
export const LENGTH_STEP_SEC = 5;
