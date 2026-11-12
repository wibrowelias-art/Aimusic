/**
 * The lo-fi chain: an offline Web Audio graph, then the master stage.
 *
 *   source(s) at the "slowed" rate  ->  level to -18 LUFS
 *     -> room   (dry + small room and/or hall)
 *     -> mic    (width, low-cut, low-mid boost, compressor)
 *     -> tape   (saturation, wow / flutter / drift as a moving delay, high-cut)
 *   -> master   (loudness to -16 LUFS, hiss at its exact level, limiter, peak check)
 *
 * With stems the vocal goes through its own low-pass and hall send first ("vocal blur").
 * The context factory is a parameter, so this runs in the browser and under
 * node-web-audio-api. Same input, settings and seed give the same output on one engine.
 */
import { integratedLufs } from '../analysis/loudness';
import { spectralCentroid } from '../analysis/metrics';
import { dbToGain } from '../audio/dsp';
import { buildReverbIR } from '../audio/reverb';
import { mulberry32, subSeed } from '../audio/rng';
import type { OfflineContextFactory, StereoPcm } from '../audio/types';
import {
  CHAIN_INPUT_LUFS,
  END_FADE_SEC,
  HALL_RT60_SEC,
  HALL_WET_AT_FULL,
  HIGH_CUT_Q,
  MIC_COMP_ATTACK_SEC,
  MIC_COMP_KNEE_DB,
  MIC_COMP_RATIO_AT_FULL,
  MIC_COMP_RELEASE_SEC,
  MIC_COMP_THRESHOLD_DB_MAX,
  MIC_COMP_THRESHOLD_DB_MIN,
  MIC_LOWCUT_HZ_MAX,
  MIC_LOWCUT_HZ_MIN,
  MIC_LOWMID_DB_AT_FULL,
  MIC_LOWMID_HZ,
  MIC_LOWMID_Q,
  MIC_WIDTH_AT_FULL,
  ROOM_RT60_SEC,
  ROOM_WET_AT_FULL,
  SAT_CURVE_POINTS,
  SAT_DRIVE_DB_MAX,
  SAT_DRIVE_DB_MIN,
  SLOWED_HALL_WET_AT_FULL,
  TAIL_MAX_SEC,
  TAPE_DRIFT_A_CENTS,
  TAPE_DRIFT_A_HZ,
  TAPE_DRIFT_B_CENTS,
  TAPE_DRIFT_B_HZ,
  TAPE_FLUTTER_CENTS,
  TAPE_FLUTTER_HZ,
  TAPE_WOW_A_CENTS,
  TAPE_WOW_A_HZ,
  TAPE_WOW_B_CENTS,
  TAPE_WOW_B_HZ,
  VOCAL_HALL_WET_AT_FULL,
  VOCAL_LP_HZ_MAX,
  VOCAL_LP_HZ_MIN,
} from './constants';
import { buildHiss, effectiveHissDb } from './hiss';
import { masterInPlace, type MasterReport } from './master';
import { buildRoomIR } from './room';
import { HIGH_CUT_OFF_HZ, normalizePostFx, SLOWED_MAX_PCT, type PostFxSettings } from './settings';

export interface PostFxInput {
  sampleRate: number;
  /** The whole mix. */
  full: StereoPcm;
  /** Optional: the same music as two stems that add up to the mix. */
  stems?: { vocals: StereoPcm; backing: StereoPcm } | null;
}

export interface PostFxDeps {
  createContext: OfflineContextFactory;
  /** Seeds the hiss and the phases of the tape wobble. */
  seed?: number;
}

export interface PostFxReport {
  settings: PostFxSettings;
  inputDurationSec: number;
  inputLufs: number;
  inputCentroidHz: number;
  /** Side energy over mid energy of the input, dB (-Infinity = mono). */
  inputSideDb: number;
  durationSec: number;
  /** 1 = unchanged; 0.8 = 20 % slower. */
  playbackRate: number;
  /** Pitch change that comes with the rate, semitones (negative = lower). */
  pitchSemitones: number;
  /** Largest pitch deviation the tape stage asks for, cents. */
  wobbleMaxCents: number;
  /** High-cut corner in Hz, null when bypassed. */
  highCutHz: number | null;
  /** Hiss RMS in dBFS as added to the file, null when off. */
  hissDb: number | null;
  /** True when a vocal stem was there and the blur was on. */
  vocalBlurApplied: boolean;
  centroidHz: number;
  sideDb: number;
  master: MasterReport;
}

export interface PostFxResult {
  sampleRate: number;
  pcm: StereoPcm;
  report: PostFxReport;
}

/** Resolution of the delay curve that carries wow, flutter and drift, points per second. */
const WOBBLE_CURVE_HZ = 1000;
const CENTS_TO_RATIO = Math.LN2 / 1200;

/** Side energy over mid energy in dB. */
export function sideOverMidDb(pcm: StereoPcm): number {
  const [l, r] = pcm;
  let mid = 0;
  let side = 0;
  for (let i = 0; i < l.length; i++) {
    const m = l[i] + r[i];
    const s = l[i] - r[i];
    mid += m * m;
    side += s * s;
  }
  if (side <= 0) return -Infinity;
  return mid > 0 ? 10 * Math.log10(side / mid) : Infinity;
}

interface WobblePlan {
  /** Delay in seconds, WOBBLE_CURVE_HZ points per second. */
  curve: Float32Array;
  maxDelaySec: number;
  maxCents: number;
}

/**
 * The tape transport as a moving delay. A delay d(t) plays the input at the rate
 * 1 - d'(t), so d is minus the running sum of the wanted speed deviation.
 */
export function planWobble(settings: PostFxSettings, totalSec: number, seed: number): WobblePlan | null {
  const parts: { hz: number; cents: number }[] = [
    { hz: TAPE_WOW_A_HZ, cents: TAPE_WOW_A_CENTS * settings.wobble },
    { hz: TAPE_WOW_B_HZ, cents: TAPE_WOW_B_CENTS * settings.wobble },
    { hz: TAPE_FLUTTER_HZ, cents: TAPE_FLUTTER_CENTS * settings.wobble },
    { hz: TAPE_DRIFT_A_HZ, cents: TAPE_DRIFT_A_CENTS * settings.drift },
    { hz: TAPE_DRIFT_B_HZ, cents: TAPE_DRIFT_B_CENTS * settings.drift },
  ].filter((p) => p.cents > 0);
  if (parts.length === 0) return null;
  const rand = mulberry32(subSeed(seed >>> 0, 77));
  const phases = parts.map(() => rand() * 2 * Math.PI);
  const n = Math.max(2, Math.ceil(totalSec * WOBBLE_CURVE_HZ) + 1);
  const curve = new Float32Array(n);
  let lo = Infinity;
  let hi = -Infinity;
  let maxCents = 0;
  for (let i = 0; i < n; i++) {
    const t = i / WOBBLE_CURVE_HZ;
    let delay = 0;
    let cents = 0;
    parts.forEach((p, k) => {
      const w = 2 * Math.PI * p.hz;
      // speed deviation a*sin(wt + phase)  ->  delay (a/w)*cos(wt + phase)
      delay += ((p.cents * CENTS_TO_RATIO) / w) * Math.cos(w * t + phases[k]);
      cents += p.cents * Math.sin(w * t + phases[k]);
    });
    curve[i] = delay;
    if (delay < lo) lo = delay;
    if (delay > hi) hi = delay;
    if (Math.abs(cents) > maxCents) maxCents = Math.abs(cents);
  }
  const base = 0.001 - lo;
  for (let i = 0; i < n; i++) curve[i] += base;
  return { curve, maxDelaySec: hi + base, maxCents };
}

/** The shaper sees the signal 12 dB down, so peaks up to +12 dBFS stay on the table. */
const SAT_PAD = 0.25;

function saturationCurve(amount: number): Float32Array<ArrayBuffer> {
  const driveDb = SAT_DRIVE_DB_MIN + (SAT_DRIVE_DB_MAX - SAT_DRIVE_DB_MIN) * amount;
  const g = dbToGain(driveDb) / SAT_PAD;
  const curve = new Float32Array(SAT_CURVE_POINTS);
  for (let i = 0; i < SAT_CURVE_POINTS; i++) {
    const x = (i / (SAT_CURVE_POINTS - 1)) * 2 - 1;
    curve[i] = Math.tanh(g * x) / g;
  }
  return curve;
}


function toBuffer(ctx: BaseAudioContext, pcm: StereoPcm, sampleRate: number): AudioBuffer {
  const buffer = ctx.createBuffer(2, Math.max(1, pcm[0].length), sampleRate);
  buffer.copyToChannel(pcm[0] as Float32Array<ArrayBuffer>, 0);
  buffer.copyToChannel(pcm[1] as Float32Array<ArrayBuffer>, 1);
  return buffer;
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

export async function renderPostFx(
  input: PostFxInput,
  settingsIn: Partial<PostFxSettings>,
  deps: PostFxDeps,
): Promise<PostFxResult> {
  const settings = normalizePostFx(settingsIn);
  const { sampleRate, full } = input;
  const seed = (deps.seed ?? 1) >>> 0;
  const inFrames = full[0].length;
  const rate = 1 - settings.slowedPct / 100;
  const inputLufs = integratedLufs(full, sampleRate);
  const useStems = Boolean(input.stems) && settings.vocalBlur > 0;

  const roomWet = settings.roomType === 'room' ? settings.room * ROOM_WET_AT_FULL : 0;
  const hallWet =
    (settings.roomType === 'hall' ? settings.room * HALL_WET_AT_FULL : 0) +
    (settings.slowedPct / SLOWED_MAX_PCT) * SLOWED_HALL_WET_AT_FULL;
  const vocalWet = useStems ? settings.vocalBlur * VOCAL_HALL_WET_AT_FULL : 0;
  const hallOn = hallWet > 0 || vocalWet > 0;
  const tailSec = hallOn ? Math.min(TAIL_MAX_SEC, HALL_RT60_SEC) : roomWet > 0 ? ROOM_RT60_SEC * 1.5 : 0.05;

  const musicSec = inFrames / rate / sampleRate;
  const wobble = planWobble(settings, musicSec + tailSec + 0.5, seed);
  const totalSec = musicSec + tailSec + (wobble ? wobble.maxDelaySec : 0);
  const totalFrames = Math.max(1, Math.ceil(totalSec * sampleRate));
  const ctx = deps.createContext(2, totalFrames, sampleRate);

  // Sources.
  const level = ctx.createGain();
  level.gain.value = Number.isFinite(inputLufs) ? dbToGain(CHAIN_INPUT_LUFS - inputLufs) : 1;
  const hallSendVocal = ctx.createGain();
  hallSendVocal.gain.value = vocalWet;
  const play = (pcm: StereoPcm): AudioBufferSourceNode => {
    const src = ctx.createBufferSource();
    src.buffer = toBuffer(ctx, pcm, sampleRate);
    src.playbackRate.value = rate;
    src.start(0);
    return src;
  };
  if (useStems && input.stems) {
    play(input.stems.backing).connect(level);
    const vocalLp = ctx.createBiquadFilter();
    vocalLp.type = 'lowpass';
    vocalLp.frequency.value = VOCAL_LP_HZ_MAX * (VOCAL_LP_HZ_MIN / VOCAL_LP_HZ_MAX) ** settings.vocalBlur;
    vocalLp.Q.value = Math.SQRT1_2;
    play(input.stems.vocals).connect(vocalLp);
    vocalLp.connect(level);
    vocalLp.connect(hallSendVocal);
  } else {
    play(full).connect(level);
  }

  // Room.
  const roomOut = ctx.createGain();
  level.connect(roomOut);
  if (roomWet > 0) {
    const conv = ctx.createConvolver();
    conv.normalize = false;
    conv.buffer = toBuffer(ctx, buildRoomIR(sampleRate, ROOM_RT60_SEC), sampleRate);
    const wet = ctx.createGain();
    wet.gain.value = roomWet;
    level.connect(conv);
    conv.connect(wet);
    wet.connect(roomOut);
  }
  if (hallOn) {
    const conv = ctx.createConvolver();
    conv.normalize = false;
    conv.buffer = toBuffer(ctx, buildReverbIR(sampleRate, HALL_RT60_SEC), sampleRate);
    const send = ctx.createGain();
    send.gain.value = hallWet;
    level.connect(send);
    send.connect(conv);
    // The vocal send sits before `level`, so it gets the same level gain here.
    const vocalLevel = ctx.createGain();
    vocalLevel.gain.value = level.gain.value;
    hallSendVocal.connect(vocalLevel);
    vocalLevel.connect(conv);
    conv.connect(roomOut);
  }

  // Bedroom mic.
  let node: AudioNode = roomOut;
  if (settings.mic > 0) {
    const m = settings.mic;
    const width = lerp(1, MIC_WIDTH_AT_FULL, m);
    const splitter = ctx.createChannelSplitter(2);
    const merger = ctx.createChannelMerger(2);
    node.connect(splitter);
    const same = (1 + width) / 2;
    const cross = (1 - width) / 2;
    for (let from = 0; from < 2; from++) {
      for (let to = 0; to < 2; to++) {
        const g = ctx.createGain();
        g.gain.value = from === to ? same : cross;
        splitter.connect(g, from);
        g.connect(merger, 0, to);
      }
    }
    const lowCut = ctx.createBiquadFilter();
    lowCut.type = 'highpass';
    lowCut.frequency.value = lerp(MIC_LOWCUT_HZ_MIN, MIC_LOWCUT_HZ_MAX, m);
    lowCut.Q.value = Math.SQRT1_2;
    const lowMid = ctx.createBiquadFilter();
    lowMid.type = 'peaking';
    lowMid.frequency.value = MIC_LOWMID_HZ;
    lowMid.Q.value = MIC_LOWMID_Q;
    lowMid.gain.value = MIC_LOWMID_DB_AT_FULL * m;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = lerp(MIC_COMP_THRESHOLD_DB_MIN, MIC_COMP_THRESHOLD_DB_MAX, m);
    comp.ratio.value = lerp(1, MIC_COMP_RATIO_AT_FULL, m);
    comp.knee.value = MIC_COMP_KNEE_DB;
    comp.attack.value = MIC_COMP_ATTACK_SEC;
    comp.release.value = MIC_COMP_RELEASE_SEC;
    merger.connect(lowCut);
    lowCut.connect(lowMid);
    lowMid.connect(comp);
    node = comp;
  }

  // Tape.
  if (settings.saturation > 0) {
    const pad = ctx.createGain();
    pad.gain.value = SAT_PAD;
    const shaper = ctx.createWaveShaper();
    shaper.curve = saturationCurve(settings.saturation);
    shaper.oversample = '4x';
    const unpad = ctx.createGain();
    unpad.gain.value = 1 / SAT_PAD;
    node.connect(pad);
    pad.connect(shaper);
    shaper.connect(unpad);
    node = unpad;
  }
  if (wobble) {
    const delay = ctx.createDelay(Math.max(0.05, wobble.maxDelaySec + 0.05));
    delay.delayTime.setValueCurveAtTime(wobble.curve, 0, (wobble.curve.length - 1) / WOBBLE_CURVE_HZ);
    node.connect(delay);
    node = delay;
  }
  const highCutHz = settings.highCutHz < HIGH_CUT_OFF_HZ ? settings.highCutHz : null;
  if (highCutHz !== null) {
    for (const q of HIGH_CUT_Q) {
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = highCutHz;
      lp.Q.value = q;
      node.connect(lp);
      node = lp;
    }
  }
  node.connect(ctx.destination);

  const rendered = await ctx.startRendering();
  // Copies: the views die with the AudioBuffer on some engines.
  const pcm: StereoPcm = [rendered.getChannelData(0).slice(), rendered.getChannelData(1).slice()];

  // End fade, so the file ends at zero whatever is still ringing.
  const fade = Math.min(pcm[0].length, Math.round(END_FADE_SEC * sampleRate));
  for (const c of pcm) {
    for (let i = 0; i < fade; i++) c[c.length - fade + i] *= 0.5 + 0.5 * Math.cos((Math.PI * (i + 1)) / fade);
  }

  const hissDb = effectiveHissDb(settings.hissDb);
  let hiss: StereoPcm | null = null;
  if (hissDb !== null) {
    hiss = buildHiss(pcm[0].length, sampleRate, hissDb, subSeed(seed, 5));
    const edge = Math.min(hiss[0].length, Math.round(0.05 * sampleRate));
    for (const c of hiss) {
      for (let i = 0; i < edge; i++) {
        const g = i / edge;
        c[i] *= g;
        c[c.length - 1 - i] *= g;
      }
    }
  }
  const master = masterInPlace(pcm, sampleRate, { hiss });

  return {
    sampleRate,
    pcm,
    report: {
      settings,
      inputDurationSec: inFrames / sampleRate,
      inputLufs,
      inputCentroidHz: spectralCentroid(full, sampleRate),
      inputSideDb: sideOverMidDb(full),
      durationSec: pcm[0].length / sampleRate,
      playbackRate: rate,
      pitchSemitones: 12 * Math.log2(rate),
      wobbleMaxCents: wobble ? wobble.maxCents : 0,
      highCutHz,
      hissDb,
      vocalBlurApplied: useStems,
      centroidHz: spectralCentroid(pcm, sampleRate),
      sideDb: sideOverMidDb(pcm),
      master,
    },
  };
}
