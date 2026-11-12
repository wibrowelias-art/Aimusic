/** The built-in generator: free, offline, seeded. */
export * from './types';
export { EXCLUSIVE_SLOTS, MIX_MIN_SHARE, MIX_TAKEOVER, RECIPES, type FamilyRecipe, type PartSpec, type Role } from './families';
export { parseWords } from './words';
export { chooseParts, makeSketch } from './arrange';
export { renderSketch, renderTrack, SKETCH_PEAK, SKETCH_SAMPLE_RATE, SKETCH_TAIL_SEC } from './synth';
