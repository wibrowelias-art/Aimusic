/**
 * Seeded randomness for the composer. Nothing in src/engine may call Math.random().
 *
 * A generator is identified by a text path ("seed:42/harmony"). `fork(name)` derives a new
 * generator from the path alone, never from how many numbers the parent has already produced.
 * That is what keeps the sub-streams independent: drawing more numbers for the performance
 * cannot change the motif, and so on.
 */

/** xmur3 string hash: returns a function that yields successive uint32 values. */
function xmur3(str: string): () => number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}

/** sfc32 generator: floats in [0, 1) with 32 bits of resolution. */
function sfc32(a: number, b: number, c: number, d: number): () => number {
  return () => {
    a |= 0;
    b |= 0;
    c |= 0;
    d |= 0;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

/** uint32 hash of a string (first xmur3 output). */
export function hashString(str: string): number {
  return xmur3(str)();
}

export class Rng {
  readonly path: string;
  private readonly gen: () => number;

  constructor(path: string) {
    this.path = path;
    const h = xmur3(path);
    this.gen = sfc32(h(), h(), h(), h());
    for (let i = 0; i < 15; i++) this.gen();
  }

  /** Float in [0, 1). */
  next(): number {
    return this.gen();
  }

  /** Float in [lo, hi). */
  range(lo: number, hi: number): number {
    return lo + (hi - lo) * this.gen();
  }

  /** Integer in [lo, hi], both inclusive. */
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.gen() * (hi - lo + 1));
  }

  chance(p: number): boolean {
    return this.gen() < p;
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.gen() * items.length)];
  }

  /**
   * Index drawn with the given relative weights (negative weights count as 0).
   * Always consumes exactly one number. Falls back to a uniform draw when all weights are 0.
   */
  weightedIndex(weights: readonly number[]): number {
    let total = 0;
    for (const w of weights) total += w > 0 ? w : 0;
    const u = this.gen();
    if (total <= 0) return Math.floor(u * weights.length);
    const r = u * total;
    let acc = 0;
    let last = 0;
    for (let i = 0; i < weights.length; i++) {
      const w = weights[i] > 0 ? weights[i] : 0;
      if (w === 0) continue;
      acc += w;
      last = i;
      if (r < acc) return i;
    }
    return last;
  }

  weighted<T>(items: readonly T[], weights: readonly number[]): T {
    return items[this.weightedIndex(weights)];
  }

  /** Fisher-Yates shuffle, returns a new array. */
  shuffle<T>(items: readonly T[]): T[] {
    const out = items.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(this.gen() * (i + 1));
      const tmp = out[i];
      out[i] = out[j];
      out[j] = tmp;
    }
    return out;
  }

  /** Independent sub-stream. Depends only on this generator's path and `name`. */
  fork(name: string): Rng {
    return new Rng(`${this.path}/${name}`);
  }
}

export function createRng(seed: number): Rng {
  return new Rng(`seed:${seed >>> 0}`);
}
