/** Browser side of `npm run check:browser`. Dev-only page, not part of the app. */
import { fetchManifest, urlSampleFetcher } from '../src/audio/fetch';
import { runRenderCheck, type RenderCheckNumbers } from './render-check-core';

declare global {
  interface Window {
    __renderCheck?: { ok: true; numbers: RenderCheckNumbers } | { ok: false; error: string };
  }
}

const out = document.querySelector('#out');
const show = (text: string): void => {
  if (out) out.textContent = text;
};

async function main(): Promise<void> {
  const base = '/samples/piano';
  const manifest = await fetchManifest(base);
  const numbers = await runRenderCheck({
    createContext: (channels, length, sampleRate) => new OfflineAudioContext(channels, length, sampleRate),
    fetchSample: urlSampleFetcher(base),
    manifest,
  });
  window.__renderCheck = { ok: true, numbers };
  show(JSON.stringify(numbers, null, 2));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
  window.__renderCheck = { ok: false, error: message };
  show(message);
});
