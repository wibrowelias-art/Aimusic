import { describe, expect, it } from 'vitest';
import { presetCenter } from '../../src/engine/params';
import { basePreset } from '../../src/store/learning';
import { memoryStore } from '../../src/store/storage';
import { HISTORY_LIMIT, TAKES_KEY, TakeStore } from '../../src/store/takes';

function makeStore(): { store: TakeStore; kv: ReturnType<typeof memoryStore> } {
  const kv = memoryStore();
  let t = 1000;
  return { store: new TakeStore(kv, () => t++), kv };
}

describe('TakeStore', () => {
  it('adds takes newest first with running numbers and survives a reload', () => {
    const { store, kv } = makeStore();
    const a = store.add(presetCenter('warm', { seed: 11 }), 'warm', 'generate');
    const b = store.add(presetCenter('sad', { seed: 12 }), 'sad', 'generate');
    expect(a.n).toBe(1);
    expect(b.n).toBe(2);
    expect(store.list().map((t) => t.id)).toEqual([b.id, a.id]);
    const again = new TakeStore(kv);
    expect(again.list()).toEqual(store.list());
    const c = again.add(presetCenter('cave', { seed: 13 }), 'cave', 'again');
    expect(c.n).toBe(3);
    expect(c.id).not.toBe(a.id);
  });

  it('stores only seed and settings (no notes, no audio)', () => {
    const { store, kv } = makeStore();
    store.add(presetCenter('warm', { seed: 11 }), 'warm', 'generate');
    const raw = JSON.parse(kv.getItem(TAKES_KEY) ?? '{}') as { takes: Record<string, unknown>[] };
    expect(Object.keys(raw.takes[0]).sort()).toEqual(
      ['createdAt', 'favorite', 'id', 'n', 'origin', 'params', 'preset', 'rating'].sort(),
    );
    expect(Object.keys(raw.takes[0].params as object).sort()).toEqual(
      ['density', 'key', 'length', 'lofi', 'mode', 'pad', 'rain', 'register', 'restProbability', 'reverbSize', 'seed', 'tempo', 'variation'].sort(),
    );
  });

  it('keeps at most HISTORY_LIMIT plain takes but never drops a favorite', () => {
    const { store } = makeStore();
    const first = store.add(presetCenter('warm', { seed: 1 }), 'warm', 'generate');
    store.toggleFavorite(first.id);
    for (let i = 0; i < HISTORY_LIMIT + 15; i++) store.add(presetCenter('warm', { seed: 100 + i }), 'warm', 'generate');
    const list = store.list();
    expect(list.filter((t) => !t.favorite).length).toBe(HISTORY_LIMIT);
    expect(list.some((t) => t.id === first.id)).toBe(true);
    expect(store.favorites().map((t) => t.id)).toEqual([first.id]);
    store.clearHistory();
    expect(store.list().map((t) => t.id)).toEqual([first.id]);
  });

  it('rating: toggles, feeds the learning, and survives deleting the take', () => {
    const { store, kv } = makeStore();
    const take = store.add({ ...presetCenter('warm', { seed: 1 }), tempo: 50 }, 'warm', 'generate');
    expect(store.learned().warm).toEqual(basePreset('warm'));
    store.rate(take.id, 1);
    expect(store.get(take.id)?.rating).toBe(1);
    const learned = store.learned().warm;
    expect(learned.likes).toBe(1);
    expect((learned.ranges.tempo.lo + learned.ranges.tempo.hi) / 2).toBeLessThan(56);
    // Reload keeps it.
    expect(new TakeStore(kv).learned().warm).toEqual(learned);
    // The same thumb again clears the rating and its effect.
    store.rate(take.id, 1);
    expect(store.get(take.id)?.rating).toBe(0);
    expect(store.learned().warm).toEqual(basePreset('warm'));
    // Switching from up to down replaces the rating, it does not stack.
    store.rate(take.id, 1);
    store.rate(take.id, -1);
    expect(store.ratings()).toHaveLength(1);
    expect(store.learned().warm.dislikes).toBe(1);
    expect(store.learned().warm.likes).toBe(0);
    // Deleting the take keeps what was learned; resetLearning forgets it.
    store.remove(take.id);
    expect(store.learned().warm.dislikes).toBe(1);
    store.resetLearning();
    expect(store.learned().warm).toEqual(basePreset('warm'));
  });

  it('a take without preset can be rated but teaches nothing', () => {
    const { store } = makeStore();
    const take = store.add(presetCenter('warm', { seed: 1 }), null, 'reference');
    store.rate(take.id, 1);
    expect(store.get(take.id)?.rating).toBe(1);
    expect(store.ratings()).toEqual([]);
  });

  it('edit: changes a plain take in place, forks a rated or favorite one', () => {
    const { store } = makeStore();
    const take = store.add(presetCenter('warm', { seed: 1 }), 'warm', 'generate');
    const edited = store.edit(take.id, { ...take.params, tempo: 60 });
    expect(edited?.id).toBe(take.id);
    expect(store.get(take.id)?.params.tempo).toBe(60);
    expect(store.list()).toHaveLength(1);
    store.rate(take.id, 1);
    const fork = store.edit(take.id, { ...take.params, tempo: 44 });
    expect(fork?.id).not.toBe(take.id);
    expect(fork?.origin).toBe('edit');
    expect(fork?.rating).toBe(0);
    expect(store.get(take.id)?.params.tempo).toBe(60);
    expect(store.list()).toHaveLength(2);
    // The rating in the log still points at the settings that were liked.
    expect(store.ratings()[0].params.tempo).toBe(60);
  });

  it('tolerates broken or foreign data in storage', () => {
    for (const raw of ['not json', '{"version":2}', '[]', '{"version":1,"takes":[{"id":5},null,{"id":"t9","params":{"tempo":999,"mode":"x"}}],"ratings":[{"takeId":"a"}]}']) {
      const kv = memoryStore({ [TAKES_KEY]: raw });
      const store = new TakeStore(kv);
      const list = store.list();
      for (const t of list) {
        expect(t.params.tempo).toBeLessThanOrEqual(72);
        expect(t.params.mode).toBe('majorPentatonic');
      }
      expect(store.ratings()).toEqual([]);
      expect(() => store.add(presetCenter('warm', { seed: 1 }), 'warm', 'generate')).not.toThrow();
    }
  });
});
