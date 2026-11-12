/**
 * Takes: the history of generated pieces, favorites and the ratings that feed
 * the learning. Only seeds and settings are stored (a take is re-generated from
 * them), never audio and never notes.
 */
import { PRESET_NAMES, normalizeParams, type PresetName } from '../engine/params';
import type { Params } from '../engine/types';
import { learnFromRatings, type Learned, type Rating } from './learning';
import { readJson, writeJson, type KeyValueStore } from './storage';

export type TakeOrigin = 'generate' | 'again' | 'edit' | 'chat' | 'reference';

export interface Take {
  id: string;
  /** Running number shown in the UI. */
  n: number;
  /** Milliseconds since the epoch. */
  createdAt: number;
  /** Seed + settings: everything needed to re-generate the take. */
  params: Params;
  /** The mood preset that was active, if any. Ratings teach this preset. */
  preset: PresetName | null;
  rating: -1 | 0 | 1;
  favorite: boolean;
  origin: TakeOrigin;
}

interface StoredRating extends Rating {
  takeId: string;
}

interface Stored {
  version: 1;
  counter: number;
  takes: Take[];
  ratings: StoredRating[];
}

export const TAKES_KEY = 'ambientlab.takes.v1';
/** History keeps this many takes that are not favorites; favorites are never dropped. */
export const HISTORY_LIMIT = 60;
/** The ratings log keeps this many entries (oldest go first). */
export const RATINGS_LIMIT = 400;

const isPreset = (v: unknown): v is PresetName => typeof v === 'string' && (PRESET_NAMES as string[]).includes(v);

function reviveTake(raw: unknown): Take | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || typeof r.params !== 'object' || r.params === null) return null;
  const rating = r.rating === 1 || r.rating === -1 ? r.rating : 0;
  const origins: TakeOrigin[] = ['generate', 'again', 'edit', 'chat', 'reference'];
  return {
    id: r.id,
    n: typeof r.n === 'number' && Number.isFinite(r.n) ? r.n : 0,
    createdAt: typeof r.createdAt === 'number' && Number.isFinite(r.createdAt) ? r.createdAt : 0,
    params: normalizeParams(r.params as Partial<Params>),
    preset: isPreset(r.preset) ? r.preset : null,
    rating,
    favorite: r.favorite === true,
    origin: origins.includes(r.origin as TakeOrigin) ? (r.origin as TakeOrigin) : 'generate',
  };
}

function reviveRating(raw: unknown): StoredRating | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.takeId !== 'string' || !isPreset(r.preset)) return null;
  if (r.value !== 1 && r.value !== -1) return null;
  if (typeof r.params !== 'object' || r.params === null) return null;
  return { takeId: r.takeId, preset: r.preset, params: normalizeParams(r.params as Partial<Params>), value: r.value };
}

export class TakeStore {
  private readonly store: KeyValueStore;
  private readonly now: () => number;
  private data: Stored;

  constructor(store: KeyValueStore, now: () => number = () => Date.now()) {
    this.store = store;
    this.now = now;
    this.data = this.load();
  }

  private load(): Stored {
    const raw = readJson(this.store, TAKES_KEY);
    const empty: Stored = { version: 1, counter: 0, takes: [], ratings: [] };
    if (typeof raw !== 'object' || raw === null) return empty;
    const r = raw as Record<string, unknown>;
    if (r.version !== 1) return empty;
    const takes = Array.isArray(r.takes) ? r.takes.map(reviveTake).filter((t): t is Take => t !== null) : [];
    const ratings = Array.isArray(r.ratings)
      ? r.ratings.map(reviveRating).filter((x): x is StoredRating => x !== null)
      : [];
    const maxN = takes.reduce((m, t) => Math.max(m, t.n), 0);
    const counter = typeof r.counter === 'number' && Number.isFinite(r.counter) ? Math.max(r.counter, maxN) : maxN;
    return { version: 1, counter, takes, ratings };
  }

  private save(): void {
    writeJson(this.store, TAKES_KEY, this.data);
  }

  /** Newest first. */
  list(): Take[] {
    return [...this.data.takes];
  }

  favorites(): Take[] {
    return this.data.takes.filter((t) => t.favorite);
  }

  get(id: string): Take | undefined {
    return this.data.takes.find((t) => t.id === id);
  }

  add(params: Params, preset: PresetName | null, origin: TakeOrigin): Take {
    const n = ++this.data.counter;
    const take: Take = {
      id: `t${n}`,
      n,
      createdAt: this.now(),
      params: normalizeParams(params),
      preset,
      rating: 0,
      favorite: false,
      origin,
    };
    this.data.takes.unshift(take);
    // Drop the oldest takes that are not favorites.
    let plain = 0;
    this.data.takes = this.data.takes.filter((t) => t.favorite || ++plain <= HISTORY_LIMIT);
    this.save();
    return take;
  }

  /**
   * New settings for a take (a knob was turned). A take that is rated or a
   * favorite is left as it is and a new take is added instead, so that what was
   * liked stays what it was.
   */
  edit(id: string, params: Params, origin: TakeOrigin = 'edit'): Take | undefined {
    const take = this.get(id);
    if (!take) return undefined;
    if (take.rating !== 0 || take.favorite) return this.add(params, take.preset, origin);
    take.params = normalizeParams(params);
    this.save();
    return take;
  }

  remove(id: string): void {
    this.data.takes = this.data.takes.filter((t) => t.id !== id);
    this.save();
  }

  toggleFavorite(id: string): Take | undefined {
    const take = this.get(id);
    if (!take) return undefined;
    take.favorite = !take.favorite;
    this.save();
    return take;
  }

  /** Thumbs up (1), thumbs down (-1) or clear (0). The same value again clears the rating. */
  rate(id: string, value: -1 | 0 | 1): Take | undefined {
    const take = this.get(id);
    if (!take) return undefined;
    const next = take.rating === value ? 0 : value;
    take.rating = next;
    this.data.ratings = this.data.ratings.filter((r) => r.takeId !== id);
    if (next !== 0 && take.preset) {
      this.data.ratings.push({ takeId: id, preset: take.preset, params: { ...take.params }, value: next });
      if (this.data.ratings.length > RATINGS_LIMIT) {
        this.data.ratings = this.data.ratings.slice(this.data.ratings.length - RATINGS_LIMIT);
      }
    }
    this.save();
    return take;
  }

  ratings(): Rating[] {
    return this.data.ratings.map(({ preset, params, value }) => ({ preset, params, value }));
  }

  /** What the ratings so far have taught every preset. */
  learned(): Learned {
    return learnFromRatings(this.data.ratings);
  }

  /** Forgets what was learned (takes keep their thumbs for display). */
  resetLearning(): void {
    this.data.ratings = [];
    this.save();
  }

  clearHistory(): void {
    this.data.takes = this.data.takes.filter((t) => t.favorite);
    this.save();
  }
}
