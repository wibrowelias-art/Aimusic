/**
 * Small seeded PRNG for the pure parts of the sound engine (reverb IR, noise loop, dither).
 * The sound engine never calls Math.random(): same seed, same samples.
 */

/** mulberry32. Returns a function that yields floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Derives an independent sub-seed (uint32) from a seed and a stream index. */
export function subSeed(seed: number, stream: number): number {
  let h = (seed >>> 0) ^ Math.imul((stream + 1) >>> 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}
