/** Node side of `npm run check:browser` (loaded through Vite's SSR loader). */
import { createContext, fetchSample, manifest } from '../tests/fixtures/audio';
import { runRenderCheck, type RenderCheckNumbers } from './render-check-core';

export function runNodeRenderCheck(): Promise<RenderCheckNumbers> {
  return runRenderCheck({ createContext, fetchSample, manifest });
}
