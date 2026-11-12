/**
 * Realtime playback in the browser: the same graph as the offline render,
 * scheduled a little ahead of the playhead by a timer, through a master gain
 * and a safety limiter (the limiter exists only here, never in the export).
 */
import type { Piece } from '../engine/types';
import {
  LIMITER_ATTACK_SEC,
  LIMITER_KNEE_DB,
  LIMITER_RATIO,
  LIMITER_RELEASE_SEC,
  LIMITER_THRESHOLD_DB,
  PLAYER_DEFAULT_GAIN_DB,
  PLAYER_LOOKAHEAD_SEC,
  PLAYER_START_DELAY_SEC,
  PLAYER_STOP_TAU_SEC,
  PLAYER_STOP_TEARDOWN_SEC,
  PLAYER_TICK_MS,
} from './constants';
import { dbToGain } from './dsp';
import { buildGraph, type PieceGraph } from './graph';
import { buildNoiseLoop } from './noise';
import { buildReverbIR } from './reverb';
import type { PianoSampleSet } from './sampler';
import { STEM_NAMES, type StereoPcm } from './types';

export interface PlayOptions {
  /** dB. Master gain. Pass RenderResult.gainDb to play at the level of the export. */
  gainDb?: number;
  /**
   * Seconds. Length to play, tail included; the noise bed fades out at its end.
   * Pass RenderResult.length / sampleRate to end where the export ends.
   * Default: totalSecFor(piece), the full rendered length before trimming.
   */
  totalSec?: number;
  /** Called once when the piece has played to its end (not when stop() is called). */
  onEnded?: () => void;
}

interface Session {
  graph: PieceGraph;
  out: GainNode;
  timer: ReturnType<typeof setInterval> | null;
  onEnded?: () => void;
}

/**
 * Makeup gain a DynamicsCompressorNode adds on its own (Web Audio spec:
 * (1 / curve(1.0)) ^ 0.6 with a hard knee), in dB. The player takes it out again
 * so that everything below the threshold passes at unity.
 */
export function limiterMakeupDb(thresholdDb: number, ratio: number): number {
  const fullScaleOutDb = thresholdDb + (0 - thresholdDb) / ratio;
  return -0.6 * fullScaleOutDb;
}

export class Player {
  private readonly ctx: AudioContext;
  private readonly samples: PianoSampleSet;
  private readonly limiter: DynamicsCompressorNode;
  private readonly trim: GainNode;
  private session: Session | null = null;
  private readonly teardowns = new Map<ReturnType<typeof setTimeout>, () => void>();
  private irCache: { key: string; pcm: StereoPcm } | null = null;
  private noiseCache: { key: string; pcm: StereoPcm } | null = null;

  constructor(ctx: AudioContext, samples: PianoSampleSet) {
    this.ctx = ctx;
    this.samples = samples;
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = LIMITER_THRESHOLD_DB;
    this.limiter.knee.value = LIMITER_KNEE_DB;
    this.limiter.ratio.value = LIMITER_RATIO;
    this.limiter.attack.value = LIMITER_ATTACK_SEC;
    this.limiter.release.value = LIMITER_RELEASE_SEC;
    this.trim = ctx.createGain();
    this.trim.gain.value = dbToGain(-limiterMakeupDb(LIMITER_THRESHOLD_DB, LIMITER_RATIO));
    this.limiter.connect(this.trim);
    this.trim.connect(ctx.destination);
  }

  get isPlaying(): boolean {
    return this.session !== null;
  }

  /** Seconds since the start of the piece (0 when nothing plays). Runs on into the tail. */
  get position(): number {
    const s = this.session;
    if (!s) return 0;
    return Math.min(s.graph.totalSec, Math.max(0, this.ctx.currentTime - s.graph.startTime));
  }

  /** Length in seconds of what is playing, tail included (0 when nothing plays). */
  get duration(): number {
    return this.session ? this.session.graph.totalSec : 0;
  }

  /** Voices currently alive in the graph (diagnostics). */
  get liveVoices(): number {
    return this.session ? this.session.graph.liveVoices : 0;
  }

  play(piece: Piece, opts: PlayOptions = {}): void {
    this.stop();
    const ctx = this.ctx;
    if (ctx.state === 'suspended') void ctx.resume();
    const { params } = piece;

    // The impulse response and the noise loop are cached: "Again" usually keeps both.
    const irKey = `${ctx.sampleRate}:${params.reverbSize}`;
    if (this.irCache?.key !== irKey) {
      this.irCache = { key: irKey, pcm: buildReverbIR(ctx.sampleRate, params.reverbSize) };
    }
    const noiseKey = `${ctx.sampleRate}:${params.lofi}:${params.rain}:${params.seed}`;
    if (this.noiseCache?.key !== noiseKey) {
      this.noiseCache = {
        key: noiseKey,
        pcm: buildNoiseLoop(ctx.sampleRate, { lofi: params.lofi, rain: params.rain, seed: params.seed }),
      };
    }

    const out = ctx.createGain();
    out.gain.value = dbToGain(opts.gainDb ?? PLAYER_DEFAULT_GAIN_DB);
    out.connect(this.limiter);
    const graph = buildGraph(ctx, piece, this.samples, {
      startTime: ctx.currentTime + PLAYER_START_DELAY_SEC,
      totalSec: opts.totalSec,
      reverbIR: this.irCache.pcm,
      noiseLoop: this.noiseCache.pcm,
    });
    for (const name of STEM_NAMES) graph.stems[name].connect(out);

    const session: Session = { graph, out, timer: null, onEnded: opts.onEnded };
    this.session = session;
    const tick = (): void => {
      if (this.session !== session) return;
      const now = ctx.currentTime - graph.startTime;
      if (now >= graph.totalSec) {
        this.finish(session);
        return;
      }
      graph.scheduleUntil(now + PLAYER_LOOKAHEAD_SEC);
    };
    tick();
    session.timer = setInterval(tick, PLAYER_TICK_MS);
  }

  /** Fast fade, then everything of the running piece is stopped and disconnected. */
  stop(): void {
    const session = this.session;
    if (!session) return;
    this.session = null;
    if (session.timer !== null) clearInterval(session.timer);
    session.timer = null;
    const now = this.ctx.currentTime;
    session.out.gain.cancelScheduledValues(now);
    session.out.gain.setValueAtTime(session.out.gain.value, now);
    session.out.gain.setTargetAtTime(0, now, PLAYER_STOP_TAU_SEC);
    const teardown = (): void => {
      session.graph.dispose();
      session.out.disconnect();
    };
    const handle = setTimeout(() => {
      this.teardowns.delete(handle);
      teardown();
    }, PLAYER_STOP_TEARDOWN_SEC * 1000);
    this.teardowns.set(handle, teardown);
  }

  /** stop() without the fade, and the player's own nodes are disconnected too. */
  dispose(): void {
    this.stop();
    for (const [handle, teardown] of this.teardowns) {
      clearTimeout(handle);
      teardown();
    }
    this.teardowns.clear();
    this.limiter.disconnect();
    this.trim.disconnect();
  }

  private finish(session: Session): void {
    if (this.session !== session) return;
    this.session = null;
    if (session.timer !== null) clearInterval(session.timer);
    session.timer = null;
    session.graph.dispose();
    session.out.disconnect();
    session.onEnded?.();
  }
}
