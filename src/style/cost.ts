/**
 * Cost estimate shown before every generation. An estimate only: the real charge is
 * whatever the provider bills. Change the numbers here when the price list changes.
 */

/**
 * Music generation, USD per minute of audio, billed per generation. Plans include some
 * minutes (Starter 40, Creator 147, Pro 660 a month). Source: elevenlabs.io/pricing/api, read 2026-11-12.
 */
export const MUSIC_USD_PER_MINUTE = 0.15;
/**
 * Stem separation as a share of the generation price. The API price list has no line for
 * it; this is the share the provider's blog gave for its app (two stems = half a
 * generation). Not confirmed for the API.
 */
export const STEMS_SHARE_OF_GENERATION = 0.5;
export const PRICE_SOURCE = 'elevenlabs.io/pricing/api, read 2026-11-12';

export interface CostEstimate {
  usd: number;
  /** The parts, for the confirm dialog. */
  lines: { label: string; usd: number; confirmed: boolean }[];
  usdPerMinute: number;
}

const round = (usd: number): number => Math.round(usd * 1000) / 1000;

export function estimateCost(lengthSec: number, opts: { stems?: boolean; usdPerMinute?: number } = {}): CostEstimate {
  const usdPerMinute = opts.usdPerMinute ?? MUSIC_USD_PER_MINUTE;
  const generation = round((Math.max(0, lengthSec) / 60) * usdPerMinute);
  const lines = [{ label: `Generation, ${formatLength(lengthSec)} at $${usdPerMinute.toFixed(2)} per minute`, usd: generation, confirmed: true }];
  if (opts.stems) {
    lines.push({
      label: 'Vocal stem separation (price not on the API list; assumed half a generation)',
      usd: round(generation * STEMS_SHARE_OF_GENERATION),
      confirmed: false,
    });
  }
  return { usd: round(lines.reduce((sum, l) => sum + l.usd, 0)), lines, usdPerMinute };
}

export function formatLength(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function formatUsd(usd: number): string {
  return usd < 0.1 ? `$${usd.toFixed(3)}` : `$${usd.toFixed(2)}`;
}
