/**
 * Seeking: a graph built with `fromSec` plays the piece from that point on.
 * Checked offline against the same stretch of a render from the start.
 */
import { describe, expect, it } from 'vitest';
import { peakAbs, rmsDb } from '../../src/analysis';
import { SAMPLE_RATE } from '../../src/audio/constants';
import { buildGraph, totalSecFor } from '../../src/audio/graph';
import { STEM_NAMES } from '../../src/audio/types';
import type { Piece } from '../../src/engine/types';
import { createContext, loadSamples } from '../fixtures/audio';
import { makeFixturePiece } from '../fixtures/piece';

const SR = SAMPLE_RATE;

async function renderFrom(piece: Piece, fromSec: number): Promise<Float32Array[]> {
  const samples = await loadSamples();
  const totalSec = totalSecFor(piece);
  const frames = Math.ceil((totalSec - fromSec) * SR);
  const ctx = createContext(2, frames, SR);
  const graph = buildGraph(ctx, piece, samples, { startTime: -fromSec, fromSec, totalSec });
  for (const name of STEM_NAMES) graph.stems[name].connect(ctx.destination);
  graph.scheduleAll();
  const buffer = await ctx.startRendering();
  // Copies: under node-web-audio-api the views die with the AudioBuffer.
  return [buffer.getChannelData(0).slice(), buffer.getChannelData(1).slice()];
}

function countNonFinite(channels: Float32Array[]): number {
  let bad = 0;
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i++) if (!Number.isFinite(ch[i])) bad++;
  }
  return bad;
}

describe('seeking with fromSec', () => {
  const piece = makeFixturePiece({ lofi: 0, rain: 0, pad: 0.4 });

  it('fromSec 0 is the plain render', async () => {
    const a = await renderFrom(piece, 0);
    const b = await renderFrom(piece, 0);
    expect(peakAbs(a)).toBeGreaterThan(0.01);
    let maxDiff = 0;
    for (let i = 0; i < a[0].length; i++) maxDiff = Math.max(maxDiff, Math.abs(a[0][i] - b[0][i]));
    expect(maxDiff).toBeLessThan(1e-6);
  });

  it('starts without a burst of old notes and catches up with the full render', async () => {
    const full = await renderFrom(piece, 0);
    const lines: string[] = [];
    for (const fromSec of [6.3, 12, 19.5]) {
      const part = await renderFrom(piece, fromSec);
      expect(countNonFinite(part)).toBe(0);
      const at = (sec: number): number => Math.round(sec * SR);
      // Nothing louder than the whole piece ever gets.
      expect(peakAbs(part)).toBeLessThanOrEqual(peakAbs(full) * 1.05);
      // The first 150 ms are not louder than the same stretch of the full render (plus margin):
      // notes that were over by then must not be re-triggered.
      const startPart = rmsDb(part, 0, at(0.15));
      const startFull = rmsDb(full, at(fromSec), at(fromSec + 0.15));
      expect(startPart).toBeLessThan(Math.max(startFull + 3, -45));
      // From the next onsets on the two renders carry the same notes: levels within 3 dB
      // over a long window (what differs is the reverb of notes before the seek point).
      const later = rmsDb(part, at(3), at(Math.min(9, totalSecFor(piece) - fromSec - 1)));
      const laterFull = rmsDb(full, at(fromSec + 3), at(fromSec + Math.min(9, totalSecFor(piece) - fromSec - 1)));
      lines.push(
        `seek to ${fromSec} s: first 150 ms ${startPart.toFixed(1)} dBFS (full render there ${startFull.toFixed(1)}), 3 s later ${later.toFixed(1)} dBFS (full ${laterFull.toFixed(1)})`,
      );
      expect(Math.abs(later - laterFull)).toBeLessThan(3);
    }
    console.log(lines.join('\n'));
  });

  it('seeking past the last note leaves near silence, not an error', async () => {
    const part = await renderFrom(piece, piece.durationSec + 1);
    expect(countNonFinite(part)).toBe(0);
    expect(rmsDb(part)).toBeLessThan(-40);
  });
});
