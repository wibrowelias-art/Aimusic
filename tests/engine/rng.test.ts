import { describe, expect, it } from 'vitest';
import { createRng, hashString } from '../../src/engine';

describe('seeded rng', () => {
  it('gives the same sequence for the same seed and different sequences for different seeds', () => {
    const a = createRng(42);
    const b = createRng(42);
    const c = createRng(43);
    const seqA = Array.from({ length: 50 }, () => a.next());
    const seqB = Array.from({ length: 50 }, () => b.next());
    const seqC = Array.from({ length: 50 }, () => c.next());
    expect(seqA).toEqual(seqB);
    expect(seqA).not.toEqual(seqC);
  });

  it('stays inside [0, 1) and is roughly uniform', () => {
    const rng = createRng(7);
    const buckets = new Array<number>(10).fill(0);
    const n = 20000;
    for (let i = 0; i < n; i++) {
      const v = rng.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      buckets[Math.floor(v * 10)]++;
    }
    for (const count of buckets) {
      expect(count).toBeGreaterThan(n / 10 - 250);
      expect(count).toBeLessThan(n / 10 + 250);
    }
  });

  it('forks depend on the path only, not on how much the parent or a sibling was used', () => {
    const fresh = createRng(5).fork('motif');
    const expected = Array.from({ length: 20 }, () => fresh.next());

    const used = createRng(5);
    for (let i = 0; i < 1000; i++) used.next();
    const sibling = used.fork('harmony');
    for (let i = 0; i < 1000; i++) sibling.next();
    const late = used.fork('motif');
    expect(Array.from({ length: 20 }, () => late.next())).toEqual(expected);
  });

  it('differently named forks are different streams', () => {
    const rng = createRng(5);
    const a = rng.fork('develop');
    const b = rng.fork('perform');
    const c = rng.fork('develop').fork('variation1');
    const seq = (r: { next(): number }) => Array.from({ length: 10 }, () => r.next());
    const sa = seq(a);
    expect(sa).not.toEqual(seq(b));
    expect(sa).not.toEqual(seq(c));
  });

  it('seeds are read as uint32', () => {
    expect(createRng(-1).path).toBe(createRng(4294967295).path);
    expect(createRng(0).path).not.toBe(createRng(1).path);
  });

  it('int and range respect their bounds', () => {
    const rng = createRng(9);
    const seen = new Set<number>();
    for (let i = 0; i < 2000; i++) {
      const k = rng.int(3, 7);
      expect(Number.isInteger(k)).toBe(true);
      expect(k).toBeGreaterThanOrEqual(3);
      expect(k).toBeLessThanOrEqual(7);
      seen.add(k);
      const x = rng.range(-2, 5);
      expect(x).toBeGreaterThanOrEqual(-2);
      expect(x).toBeLessThan(5);
    }
    expect([...seen].sort()).toEqual([3, 4, 5, 6, 7]);
  });

  it('weighted draws never pick a zero weight and follow the weights', () => {
    const rng = createRng(11);
    const counts = [0, 0, 0, 0];
    for (let i = 0; i < 20000; i++) counts[rng.weightedIndex([1, 0, 3, -5])]++;
    expect(counts[1]).toBe(0);
    expect(counts[3]).toBe(0);
    expect(counts[2] / counts[0]).toBeGreaterThan(2.7);
    expect(counts[2] / counts[0]).toBeLessThan(3.3);
    // All weights zero: falls back to a uniform draw instead of failing.
    const idx = rng.weightedIndex([0, 0, 0]);
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(idx).toBeLessThan(3);
  });

  it('shuffle keeps the elements and does not touch the input', () => {
    const rng = createRng(13);
    const input = [1, 2, 3, 4, 5, 6];
    const out = rng.shuffle(input);
    expect(input).toEqual([1, 2, 3, 4, 5, 6]);
    expect(out.slice().sort()).toEqual(input);
  });

  it('hashString is stable', () => {
    expect(hashString('ambient')).toBe(hashString('ambient'));
    expect(hashString('ambient')).not.toBe(hashString('ambienu'));
    expect(hashString('')).toBeGreaterThanOrEqual(0);
  });
});
