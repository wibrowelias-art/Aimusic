import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AudioContext } from 'node-web-audio-api';
import {
  LIMITER_RATIO,
  LIMITER_THRESHOLD_DB,
  PLAYER_STOP_TEARDOWN_SEC,
  SAMPLE_RATE,
} from '../../src/audio/constants';
import { totalSecFor } from '../../src/audio/graph';
import { limiterMakeupDb, Player } from '../../src/audio/player';
import type { PianoSampleSet } from '../../src/audio/sampler';
import { loadSamples } from '../fixtures/audio';
import { makeFixturePiece } from '../fixtures/piece';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Counts timers that were set but neither cleared nor fired. */
function trackTimers(): { pending: () => number; restore: () => void } {
  const intervals = new Set<unknown>();
  const timeouts = new Set<unknown>();
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const si = vi.spyOn(globalThis, 'setInterval').mockImplementation(((fn: () => void, ms?: number) => {
    const handle = realSetInterval(fn, ms);
    intervals.add(handle);
    return handle;
  }) as typeof setInterval);
  const ci = vi.spyOn(globalThis, 'clearInterval').mockImplementation(((handle: unknown) => {
    intervals.delete(handle);
    realClearInterval(handle as ReturnType<typeof setInterval>);
  }) as typeof clearInterval);
  const st = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
    const handle: unknown = realSetTimeout(() => {
      timeouts.delete(handle);
      fn();
    }, ms);
    timeouts.add(handle);
    return handle;
  }) as typeof setTimeout);
  const ct = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(((handle: unknown) => {
    timeouts.delete(handle);
    realClearTimeout(handle as ReturnType<typeof setTimeout>);
  }) as typeof clearTimeout);
  return {
    pending: () => intervals.size + timeouts.size,
    restore: () => {
      si.mockRestore();
      ci.mockRestore();
      st.mockRestore();
      ct.mockRestore();
    },
  };
}

describe('Player (realtime context without an audio device)', () => {
  let ctx: AudioContext;
  let samples: PianoSampleSet;
  let timers: ReturnType<typeof trackTimers> | null = null;

  beforeAll(async () => {
    samples = await loadSamples();
    // node-web-audio-api: a running realtime context that renders into nothing.
    ctx = new AudioContext({ sinkId: { type: 'none' }, sampleRate: SAMPLE_RATE } as AudioContextOptions);
  });

  afterEach(() => {
    timers?.restore();
    timers = null;
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('plays, reports its position, and stop() leaves no voices or timers behind', async () => {
    const player = new Player(ctx, samples);
    const piece = makeFixturePiece();
    expect(player.isPlaying).toBe(false);
    expect(player.position).toBe(0);

    timers = trackTimers();
    let ended = 0;
    player.play(piece, { gainDb: 3, onEnded: () => ended++ });
    expect(player.isPlaying).toBe(true);
    expect(player.duration).toBeCloseTo(totalSecFor(piece), 6);
    expect(timers.pending()).toBe(1); // the scheduler tick
    await sleep(700);
    const position = player.position;
    expect(position).toBeGreaterThan(0.3);
    expect(position).toBeLessThan(1.2);
    // Only the lookahead window is scheduled, not the whole piece.
    const scheduledAhead = piece.notes.filter((n) => n.time < position + 1.5).length + piece.pad.filter((n) => n.time < position + 1.5).length;
    expect(player.liveVoices).toBeGreaterThan(0);
    expect(player.liveVoices).toBeLessThanOrEqual(scheduledAhead);
    expect(player.liveVoices).toBeLessThan(piece.notes.length + piece.pad.length);
    console.log(`player: position ${position.toFixed(2)} s after 0.7 s wall clock, ${player.liveVoices} live voices`);

    player.stop();
    expect(player.isPlaying).toBe(false);
    expect(player.position).toBe(0);
    expect(player.liveVoices).toBe(0);
    await sleep(PLAYER_STOP_TEARDOWN_SEC * 1000 + 100);
    expect(timers.pending()).toBe(0);
    expect(ended).toBe(0); // onEnded is for the natural end only

    // play() again while playing restarts cleanly; dispose() tears everything down at once.
    player.play(piece);
    player.play(piece);
    expect(player.isPlaying).toBe(true);
    player.dispose();
    expect(player.isPlaying).toBe(false);
    expect(timers.pending()).toBe(0);
  });

  it('cleans up finished voices while playing and calls onEnded at the end of the tail', async () => {
    const player = new Player(ctx, samples);
    // 1 bar at 72 BPM, no pedal, no pad: voices are released early and stop long before the end.
    const piece = makeFixturePiece({ bars: 1, tempo: 72, pad: 0, lofi: 0.5, rain: 0, reverbSize: 3, pedal: false });
    const total = totalSecFor(piece);
    expect(total).toBeLessThan(10);
    timers = trackTimers();
    let ended = 0;
    let voicesMidway = -1;
    let maxVoices = 0;
    const started = performance.now();
    await new Promise<void>((resolve) => {
      player.play(piece, {
        onEnded: () => {
          ended++;
          resolve();
        },
      });
      const probe = setInterval(() => {
        maxVoices = Math.max(maxVoices, player.liveVoices);
        if (player.position > total - 0.6 && voicesMidway < 0) voicesMidway = player.liveVoices;
        if (!player.isPlaying) clearInterval(probe);
      }, 50);
    });
    const wall = (performance.now() - started) / 1000;
    console.log(
      `player: piece of ${total.toFixed(2)} s ended after ${wall.toFixed(2)} s wall clock; live voices max ${maxVoices}, ${voicesMidway} shortly before the end`,
    );
    expect(ended).toBe(1);
    expect(player.isPlaying).toBe(false);
    expect(wall).toBeGreaterThan(total - 0.1);
    expect(wall).toBeLessThan(total + 1.5);
    expect(maxVoices).toBeGreaterThan(0);
    expect(voicesMidway).toBe(0); // every voice ended and was dropped
    await sleep(120);
    expect(timers.pending()).toBe(0);
    player.dispose();
  }, 30_000);

  it('takes the automatic make-up gain of the limiter out again', () => {
    // Web Audio spec: makeup = (1 / curve(1.0)) ^ 0.6, hard knee.
    expect(limiterMakeupDb(-24, 12)).toBeCloseTo(0.6 * 22, 6);
    expect(limiterMakeupDb(LIMITER_THRESHOLD_DB, LIMITER_RATIO)).toBeCloseTo(0.6 * (-LIMITER_THRESHOLD_DB) * (1 - 1 / LIMITER_RATIO), 6);
  });
});
