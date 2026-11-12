/**
 * Convenience for the browser: sample files and the manifest over HTTP.
 * (Tests read the same files from disk instead.)
 */
import type { SampleFetcher, SampleManifest } from './types';

/** Default location of the piano samples when the app is served by Vite (public/samples/piano). */
export const PIANO_SAMPLE_BASE_URL = 'samples/piano';

function join(baseUrl: string, file: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${file}`;
}

/** A SampleFetcher that downloads `<baseUrl>/<file>`. */
export function urlSampleFetcher(baseUrl: string = PIANO_SAMPLE_BASE_URL): SampleFetcher {
  return async (file) => {
    const response = await fetch(join(baseUrl, file));
    if (!response.ok) throw new Error(`Sample ${file}: HTTP ${response.status}`);
    return response.arrayBuffer();
  };
}

/** Downloads `<baseUrl>/manifest.json`. */
export async function fetchManifest(baseUrl: string = PIANO_SAMPLE_BASE_URL): Promise<SampleManifest> {
  const response = await fetch(join(baseUrl, 'manifest.json'));
  if (!response.ok) throw new Error(`Sample manifest: HTTP ${response.status}`);
  return (await response.json()) as SampleManifest;
}
