/**
 * The Web Audio graph of one piece. Works on any BaseAudioContext:
 * OfflineAudioContext (schedule everything, then render) and AudioContext
 * (schedule by time window from a lookahead timer).
 *
 *   piano voices -> pianoIn -> high-pass -> lo-fi low-pass -+-> dry ------------+-> stems.piano
 *                                                           +-> convolver -> wet +
 *   pad voices ---> padIn (params.pad) ---------------------+-> dry ------------+-> stems.pad
 *                                                           +-> convolver -> wet +
 *   noise loop ---> fade in/out ------------------------------------------------> stems.noise
 *   wobble LFOs --> detune of every piano source and pad oscillator
 *
 * Everything is linear and no node is shared between stems, so the three stems
 * always sum to the mix.
 */
import type { Note, PadNote, PedalEvent, Piece } from '../engine/types';
import {
  DAMPER_FREE_FROM_MIDI,
  DAMPER_TAU_SEC,
  FLUTTER_CENTS,
  FLUTTER_HZ,
  LOFI_LP_HZ_CLEAN,
  LOFI_LP_HZ_FULL,
  LOFI_LP_Q,
  NOISE_FADE_SEC,
  ONSET_PREROLL_SEC,
  PAD_ATTACK_SEC,
  PAD_DETUNE_CENTS,
  PAD_DRY_DB,
  PAD_GAIN_DB,
  PAD_LP_HZ,
  PAD_LP_Q,
  PAD_OCTAVE_DB,
  PAD_OSC_TYPE,
  PAD_RELEASE_SEC,
  PAD_SPREAD,
  PAD_STOP_RELEASES,
  PAD_WET_DB,
  PIANO_DRY_DB,
  PIANO_GAIN_DB,
  PIANO_HP_HZ,
  PIANO_HP_Q,
  PIANO_WET_DB,
  RELEASE_STOP_TAUS,
  RETRIGGER_TAU_SEC,
  TAIL_EXTRA_SEC,
  TAIL_RT60_FACTOR,
  VELOCITY_GAIN_EXPONENT,
  VOICE_ATTACK_SEC,
  VOICE_LP_HZ_HI,
  VOICE_LP_HZ_LO,
  VOICE_LP_HZ_MAX,
  VOICE_LP_HZ_MIN,
  VOICE_LP_KEYTRACK,
  VOICE_LP_Q,
  VOICE_LP_VELOCITY_HI,
  VOICE_LP_VELOCITY_LO,
  WOBBLE_DEPTH_EXPONENT,
  WOW_A_CENTS,
  WOW_A_HZ,
  WOW_B_CENTS,
  WOW_B_HZ,
} from './constants';
import { dbToGain, midiToHz } from './dsp';
import { buildNoiseLoop } from './noise';
import { buildReverbIR } from './reverb';
import { nearestSample, type PianoSampleSet } from './sampler';
import { STEM_NAMES, type StemName, type StereoPcm } from './types';

const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Seconds of tail rendered after piece.durationSec (damper release + reverb). */
export function tailSecFor(reverbSize: number): number {
  return reverbSize * TAIL_RT60_FACTOR + TAIL_EXTRA_SEC;
}

/** Total length in seconds of a piece including its tail. */
export function totalSecFor(piece: Piece): number {
  return piece.durationSec + tailSecFor(piece.params.reverbSize);
}

/** Voice gain (linear) for a MIDI velocity, before PIANO_GAIN_DB and the level correction. */
export function velocityGain(velocity: number): number {
  return (Math.min(127, Math.max(1, velocity)) / 127) ** VELOCITY_GAIN_EXPONENT;
}

/** Cutoff in Hz of the per-voice low-pass (softer = darker, higher pitch = higher cutoff). */
export function voiceCutoffHz(velocity: number, pitch: number): number {
  const x = clamp01((velocity - VOICE_LP_VELOCITY_LO) / (VOICE_LP_VELOCITY_HI - VOICE_LP_VELOCITY_LO));
  const base = VOICE_LP_HZ_LO * (VOICE_LP_HZ_HI / VOICE_LP_HZ_LO) ** x;
  const hz = base * 2 ** ((VOICE_LP_KEYTRACK * (pitch - 60)) / 12);
  return Math.min(VOICE_LP_HZ_MAX, Math.max(VOICE_LP_HZ_MIN, hz));
}

/** Cutoff in Hz of the piano bus low-pass for a lofi amount. */
export function lofiCutoffHz(lofi: number): number {
  return LOFI_LP_HZ_CLEAN * (LOFI_LP_HZ_FULL / LOFI_LP_HZ_CLEAN) ** clamp01(lofi);
}

/** Peak depths in cents of the three wobble LFOs for a lofi amount. */
export function wobbleDepthCents(lofi: number): { wowA: number; wowB: number; flutter: number; maxTotal: number } {
  const k = clamp01(lofi) ** WOBBLE_DEPTH_EXPONENT;
  const wowA = WOW_A_CENTS * k;
  const wowB = WOW_B_CENTS * k;
  const flutter = FLUTTER_CENTS * k;
  return { wowA, wowB, flutter, maxTotal: wowA + wowB + flutter };
}

export interface ReleasePlan {
  /** Piece time in seconds at which the damper falls. Infinity = the voice rings until its sample ends. */
  releaseSec: number;
  /** Time constant of the release in seconds. */
  tauSec: number;
}

/**
 * When does every piano voice get damped?
 *  - key up, or, if the pedal is down at key up, the next pedal up after it;
 *  - earlier if the same pitch is struck again (short RETRIGGER_TAU_SEC);
 *  - never for pitches without dampers (>= DAMPER_FREE_FROM_MIDI), unless re-struck.
 * Returns one plan per note, in the order of `notes`.
 */
export function planReleases(
  notes: readonly Pick<Note, 'pitch' | 'time' | 'duration'>[],
  pedal: readonly PedalEvent[],
  durationSec: number,
): ReleasePlan[] {
  const events = [...pedal].sort((a, b) => a.time - b.time);
  const order = notes.map((_, i) => i).sort((a, b) => notes[a].time - notes[b].time);
  const nextOnset = new Map<number, number>();
  const plans: ReleasePlan[] = new Array<ReleasePlan>(notes.length);
  for (let k = order.length - 1; k >= 0; k--) {
    const note = notes[order[k]];
    const keyUp = note.time + note.duration;
    let down = false;
    let nextUp = Infinity;
    for (const e of events) {
      if (e.time <= keyUp) down = e.down;
      else if (!e.down) {
        nextUp = e.time;
        break;
      }
    }
    let releaseSec = down ? Math.max(keyUp, Math.min(nextUp, Math.max(keyUp, durationSec))) : keyUp;
    let tauSec = DAMPER_TAU_SEC;
    if (note.pitch >= DAMPER_FREE_FROM_MIDI) releaseSec = Infinity;
    const again = nextOnset.get(note.pitch);
    if (again !== undefined && again > note.time && again < releaseSec) {
      releaseSec = again;
      tauSec = RETRIGGER_TAU_SEC;
    }
    plans[order[k]] = { releaseSec, tauSec };
    nextOnset.set(note.pitch, note.time);
  }
  return plans;
}

// ---------------------------------------------------------------------------
// Tape wobble
// ---------------------------------------------------------------------------

export interface Wobble {
  /** Largest possible excursion in cents (sum of the LFO depths). 0 when lofi is 0. */
  readonly maxCents: number;
  /** Feeds the wobble (a signal in cents) into a detune AudioParam. No-op when lofi is 0. */
  connect(param: AudioParam): void;
  disconnect(param: AudioParam): void;
  /** Stops and disconnects the LFOs. */
  dispose(): void;
}

/**
 * Slow tape wobble as a control signal in cents: two incommensurate wow LFOs
 * plus a light flutter. Depth scales with lofi; at lofi 0 no node is created.
 */
export function createWobble(ctx: BaseAudioContext, lofi: number, startTime = 0): Wobble {
  const depth = wobbleDepthCents(lofi);
  if (depth.maxTotal <= 0) {
    return { maxCents: 0, connect: () => {}, disconnect: () => {}, dispose: () => {} };
  }
  const out = ctx.createGain();
  out.gain.value = 1;
  const lfos: OscillatorNode[] = [];
  const gains: GainNode[] = [];
  const add = (hz: number, cents: number): void => {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = hz;
    const g = ctx.createGain();
    g.gain.value = cents;
    osc.connect(g);
    g.connect(out);
    // Never negative: when seeking, piece time 0 can lie before the context started.
    osc.start(Math.max(0, startTime));
    lfos.push(osc);
    gains.push(g);
  };
  add(WOW_A_HZ, depth.wowA);
  add(WOW_B_HZ, depth.wowB);
  add(FLUTTER_HZ, depth.flutter);
  return {
    maxCents: depth.maxTotal,
    connect: (param) => {
      out.connect(param);
    },
    disconnect: (param) => {
      try {
        out.disconnect(param);
      } catch {
        // already disconnected
      }
    },
    dispose: () => {
      for (const osc of lfos) {
        try {
          osc.stop();
        } catch {
          // never started or already stopped
        }
        osc.disconnect();
      }
      for (const g of gains) g.disconnect();
      out.disconnect();
    },
  };
}

// ---------------------------------------------------------------------------
// Voices
// ---------------------------------------------------------------------------

/** A scheduled voice. `dispose` stops it now and disconnects all of its nodes. */
export interface Voice {
  dispose(): void;
}

export interface PianoVoiceSpec {
  pitch: number;
  velocity: number;
  /** Context time of the onset, seconds. */
  startAt: number;
  /** Context time at which the damper falls. Infinity = ring until the sample ends. */
  releaseAt: number;
  /** Time constant of the release, seconds. Default DAMPER_TAU_SEC. */
  tauSec?: number;
}

/**
 * Schedules one piano note: nearest sample, pitch shift by playbackRate, start
 * at the detected onset, velocity gain + velocity low-pass, damper release.
 * `onEnded` (optional) fires when the source has finished; realtime graphs use
 * it to drop the voice.
 */
export function startPianoVoice(
  ctx: BaseAudioContext,
  set: PianoSampleSet,
  spec: PianoVoiceSpec,
  destination: AudioNode,
  wobble?: Wobble,
  onEnded?: () => void,
): Voice {
  const { sample, semitones } = nearestSample(set, spec.pitch);
  const rate = 2 ** (semitones / 12);
  const source = ctx.createBufferSource();
  source.buffer = sample.buffer;
  source.playbackRate.value = rate;
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = voiceCutoffHz(spec.velocity, spec.pitch);
  filter.Q.value = VOICE_LP_Q;
  const gain = ctx.createGain();
  source.connect(filter);
  filter.connect(gain);
  gain.connect(destination);
  wobble?.connect(source.detune);

  const level = velocityGain(spec.velocity) * dbToGain(PIANO_GAIN_DB + sample.correctionDb);
  let offset = Math.max(0, sample.onsetSec - ONSET_PREROLL_SEC);
  let startAt = spec.startAt;
  // Realtime only: a voice scheduled late keeps its place in time and skips its start.
  const late = ctx.currentTime - startAt;
  if (late > 0) {
    offset += late * rate;
    startAt = ctx.currentTime;
  }
  gain.gain.value = 0;
  gain.gain.setValueAtTime(0, startAt);
  gain.gain.linearRampToValueAtTime(level, startAt + VOICE_ATTACK_SEC);
  source.start(startAt, Math.min(offset, Math.max(0, sample.buffer.duration - 0.001)));
  if (Number.isFinite(spec.releaseAt)) {
    const tau = spec.tauSec ?? DAMPER_TAU_SEC;
    const releaseAt = Math.max(spec.releaseAt, startAt + VOICE_ATTACK_SEC + 0.001);
    const stopAt = releaseAt + tau * RELEASE_STOP_TAUS;
    // The setValueAtTime anchor is needed: node-web-audio-api 2.2 extrapolates a
    // future setTargetAtTime backwards (gain > 1 before the release) without it.
    gain.gain.setValueAtTime(level, releaseAt);
    gain.gain.setTargetAtTime(0, releaseAt, tau);
    gain.gain.setValueAtTime(0, stopAt);
    source.stop(stopAt);
  }

  let done = false;
  const dispose = (): void => {
    if (done) return;
    done = true;
    source.onended = null;
    try {
      source.stop();
    } catch {
      // not started yet or already stopped
    }
    wobble?.disconnect(source.detune);
    source.disconnect();
    filter.disconnect();
    gain.disconnect();
  };
  if (onEnded) {
    source.onended = () => {
      dispose();
      onEnded();
    };
  }
  return { dispose };
}

export interface PadVoiceSpec {
  pitch: number;
  velocity: number;
  /** Context time of the note start / end, seconds. The release follows the end. */
  startAt: number;
  endAt: number;
}

/**
 * Schedules one pad note: two slightly detuned oscillators left/right plus a
 * quiet sine one octave up, a low-pass and a slow attack/release envelope.
 */
export function startPadVoice(
  ctx: BaseAudioContext,
  spec: PadVoiceSpec,
  destination: AudioNode,
  wobble?: Wobble,
  onEnded?: () => void,
): Voice {
  const hz = midiToHz(spec.pitch);
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = PAD_LP_HZ;
  filter.Q.value = PAD_LP_Q;
  const env = ctx.createGain();
  filter.connect(env);
  env.connect(destination);

  const nodes: AudioNode[] = [filter, env];
  const oscillators: OscillatorNode[] = [];
  const addOsc = (type: OscillatorType, freq: number, cents: number, pan: number, level: number): void => {
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;
    osc.detune.value = cents;
    wobble?.connect(osc.detune);
    const g = ctx.createGain();
    g.gain.value = level;
    const panner = ctx.createStereoPanner();
    panner.pan.value = pan;
    osc.connect(g);
    g.connect(panner);
    panner.connect(filter);
    oscillators.push(osc);
    nodes.push(g, panner);
  };
  addOsc(PAD_OSC_TYPE, hz, -PAD_DETUNE_CENTS, -PAD_SPREAD, 1);
  addOsc(PAD_OSC_TYPE, hz, PAD_DETUNE_CENTS, PAD_SPREAD, 1);
  addOsc('sine', hz * 2, 0, 0, dbToGain(PAD_OCTAVE_DB));

  const startAt = Math.max(spec.startAt, ctx.currentTime);
  const endAt = Math.max(spec.endAt, startAt + 0.01);
  const level = Math.min(127, Math.max(1, spec.velocity)) / 127;
  const stopAt = endAt + PAD_RELEASE_SEC * PAD_STOP_RELEASES;
  const attackTau = PAD_ATTACK_SEC / 3;
  // Where the attack curve stands when the note ends (it may not have finished).
  const levelAtEnd = level * (1 - Math.exp(-(endAt - startAt) / attackTau));
  env.gain.value = 0;
  env.gain.setValueAtTime(0, startAt);
  env.gain.setTargetAtTime(level, startAt, attackTau);
  // Anchor before the release, as in startPianoVoice: without it node-web-audio-api 2.2
  // extrapolates the release curve backwards once the attack has settled (gain far above 1).
  env.gain.setValueAtTime(levelAtEnd, endAt);
  env.gain.setTargetAtTime(0, endAt, PAD_RELEASE_SEC / 4.6);
  env.gain.setValueAtTime(0, stopAt);

  let done = false;
  const dispose = (): void => {
    if (done) return;
    done = true;
    for (const osc of oscillators) {
      osc.onended = null;
      try {
        osc.stop();
      } catch {
        // not started yet or already stopped
      }
      wobble?.disconnect(osc.detune);
      osc.disconnect();
    }
    for (const node of nodes) node.disconnect();
  };
  if (onEnded) {
    oscillators[0].onended = () => {
      dispose();
      onEnded();
    };
  }
  for (const osc of oscillators) {
    osc.start(startAt);
    osc.stop(stopAt);
  }
  return { dispose };
}

// ---------------------------------------------------------------------------
// Graph
// ---------------------------------------------------------------------------

export interface GraphOptions {
  /** Context time in seconds at which piece time 0 happens. Default 0. */
  startTime?: number;
  /** Length in piece seconds including the tail; the noise fades out at its end. Default totalSecFor(piece). */
  totalSec?: number;
  /**
   * Piece time in seconds at which playback begins (seeking). Voices that are over by
   * then are not built; voices that still ring start part-way into their sample. The
   * caller sets `startTime` so that piece time `fromSec` falls on "now". Default 0.
   */
  fromSec?: number;
  /** Build only these stems (the others stay silent). Default: all three. */
  stems?: readonly StemName[];
  /** Pre-built impulse response for piece.params.reverbSize at the context sample rate (cache). */
  reverbIR?: StereoPcm;
  /** Pre-built noise loop for the piece at the context sample rate (cache). */
  noiseLoop?: StereoPcm;
}

export interface PieceGraph {
  readonly ctx: BaseAudioContext;
  /** One stereo output per stem. Not connected to anything: the caller routes them. */
  readonly stems: Record<StemName, GainNode>;
  /** Context time of piece time 0. */
  readonly startTime: number;
  /** Piece seconds including the tail. */
  readonly totalSec: number;
  /** Voices that are scheduled and not yet cleaned up (realtime graphs clean up as voices end). */
  readonly liveVoices: number;
  /**
   * Schedules every piano and pad voice whose onset (piece time, seconds) lies
   * before `untilSec` and has not been scheduled yet. Call it repeatedly with a
   * growing value from a lookahead timer.
   */
  scheduleUntil(untilSec: number): void;
  /** Schedules everything (offline rendering). */
  scheduleAll(): void;
  /** Stops every source and disconnects every node. The graph is unusable afterwards. */
  dispose(): void;
}

function toAudioBuffer(ctx: BaseAudioContext, pcm: StereoPcm): AudioBuffer {
  const buffer = ctx.createBuffer(2, pcm[0].length, ctx.sampleRate);
  buffer.getChannelData(0).set(pcm[0]);
  buffer.getChannelData(1).set(pcm[1]);
  return buffer;
}

function stereoBus(ctx: BaseAudioContext, gain = 1): GainNode {
  const node = ctx.createGain();
  node.gain.value = gain;
  node.channelCount = 2;
  node.channelCountMode = 'explicit';
  node.channelInterpretation = 'speakers';
  return node;
}

export function buildGraph(
  ctx: BaseAudioContext,
  piece: Piece,
  samples: PianoSampleSet,
  opts: GraphOptions = {},
): PieceGraph {
  const { params } = piece;
  const startTime = opts.startTime ?? 0;
  const totalSec = opts.totalSec ?? totalSecFor(piece);
  const fromSec = Math.max(0, opts.fromSec ?? 0);
  const wanted = new Set<StemName>(opts.stems ?? STEM_NAMES);
  const realtime = typeof (ctx as Partial<OfflineAudioContext>).startRendering !== 'function';

  const fixed: AudioNode[] = []; // nodes that live as long as the graph
  const sources: AudioScheduledSourceNode[] = [];
  const stems: Record<StemName, GainNode> = {
    piano: stereoBus(ctx),
    pad: stereoBus(ctx),
    noise: stereoBus(ctx),
  };
  fixed.push(stems.piano, stems.pad, stems.noise);

  const padLevel = clamp01(params.pad);
  const wantPiano = wanted.has('piano') && piece.notes.length > 0;
  const wantPad = wanted.has('pad') && padLevel > 0 && piece.pad.length > 0;
  const wantNoise = wanted.has('noise') && (params.lofi > 0 || params.rain > 0);

  const wobble = wantPiano || wantPad ? createWobble(ctx, params.lofi, startTime) : undefined;

  let reverbBuffer: AudioBuffer | null = null;
  const reverb = (): ConvolverNode => {
    reverbBuffer ??= toAudioBuffer(ctx, opts.reverbIR ?? buildReverbIR(ctx.sampleRate, params.reverbSize));
    const node = ctx.createConvolver();
    node.normalize = false; // must be set before the buffer
    node.buffer = reverbBuffer;
    return node;
  };

  // Piano bus.
  let pianoIn: GainNode | null = null;
  if (wantPiano) {
    pianoIn = stereoBus(ctx);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = PIANO_HP_HZ;
    hp.Q.value = PIANO_HP_Q;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = lofiCutoffHz(params.lofi);
    lp.Q.value = LOFI_LP_Q;
    const dry = ctx.createGain();
    dry.gain.value = dbToGain(PIANO_DRY_DB);
    const wet = ctx.createGain();
    wet.gain.value = dbToGain(PIANO_WET_DB);
    const conv = reverb();
    pianoIn.connect(hp);
    hp.connect(lp);
    lp.connect(dry);
    lp.connect(conv);
    conv.connect(wet);
    dry.connect(stems.piano);
    wet.connect(stems.piano);
    fixed.push(pianoIn, hp, lp, dry, wet, conv);
  }

  // Pad bus.
  let padIn: GainNode | null = null;
  if (wantPad) {
    padIn = stereoBus(ctx, padLevel * dbToGain(PAD_GAIN_DB));
    const dry = ctx.createGain();
    dry.gain.value = dbToGain(PAD_DRY_DB);
    const wet = ctx.createGain();
    wet.gain.value = dbToGain(PAD_WET_DB);
    const conv = reverb();
    padIn.connect(dry);
    padIn.connect(conv);
    conv.connect(wet);
    dry.connect(stems.pad);
    wet.connect(stems.pad);
    fixed.push(padIn, dry, wet, conv);
  }

  // Noise bed: one looping source for the whole length, faded at both ends.
  if (wantNoise) {
    const loop =
      opts.noiseLoop ??
      buildNoiseLoop(ctx.sampleRate, { lofi: params.lofi, rain: params.rain, seed: params.seed });
    const source = ctx.createBufferSource();
    source.buffer = toAudioBuffer(ctx, loop);
    source.loop = true;
    const fade = ctx.createGain();
    const begin = startTime + fromSec;
    const fadeSec = Math.min(NOISE_FADE_SEC, Math.max(0.01, (totalSec - fromSec) / 2));
    fade.gain.setValueAtTime(0, begin);
    fade.gain.linearRampToValueAtTime(1, begin + fadeSec);
    fade.gain.setValueAtTime(1, startTime + totalSec - fadeSec);
    fade.gain.linearRampToValueAtTime(0, startTime + totalSec);
    source.connect(fade);
    fade.connect(stems.noise);
    source.start(begin);
    source.stop(startTime + totalSec);
    fixed.push(fade);
    sources.push(source);
  }

  // Voice scheduling.
  const noteOrder = piece.notes.map((_, i) => i).sort((a, b) => piece.notes[a].time - piece.notes[b].time);
  const padOrder = piece.pad.map((_, i) => i).sort((a, b) => piece.pad[a].time - piece.pad[b].time);
  const releases = wantPiano ? planReleases(piece.notes, piece.pedal, piece.durationSec) : [];
  const live = new Set<Voice>();
  let nextNote = 0;
  let nextPad = 0;
  let disposed = false;

  const track = (make: (onEnded?: () => void) => Voice): void => {
    if (!realtime) {
      // Offline: nothing to clean up while rendering, the context is thrown away afterwards.
      live.add(make());
      return;
    }
    let voice: Voice | null = null;
    let endedEarly = false;
    voice = make(() => {
      if (voice) live.delete(voice);
      else endedEarly = true;
    });
    if (!endedEarly) live.add(voice);
  };

  const scheduleNote = (note: Note, plan: ReleasePlan): void => {
    if (!pianoIn) return;
    if (note.time < fromSec) {
      // Seeking: leave out what has been damped by then or has run through its sample.
      if (plan.releaseSec + plan.tauSec * RELEASE_STOP_TAUS <= fromSec) return;
      const { sample, semitones } = nearestSample(samples, note.pitch);
      const played = (fromSec - note.time) * 2 ** (semitones / 12);
      if (sample.onsetSec + played >= sample.buffer.duration - 0.05) return;
    }
    const dest = pianoIn;
    track((onEnded) =>
      startPianoVoice(
        ctx,
        samples,
        {
          pitch: note.pitch,
          velocity: note.velocity,
          startAt: startTime + note.time,
          releaseAt: startTime + plan.releaseSec,
          tauSec: plan.tauSec,
        },
        dest,
        wobble,
        onEnded,
      ),
    );
  };

  const schedulePad = (note: PadNote): void => {
    if (!padIn) return;
    // Seeking: a pad note that has ended and faded is left out.
    if (note.time + note.duration + PAD_RELEASE_SEC * PAD_STOP_RELEASES <= fromSec) return;
    const dest = padIn;
    track((onEnded) =>
      startPadVoice(
        ctx,
        {
          pitch: note.pitch,
          velocity: note.velocity,
          startAt: startTime + note.time,
          endAt: startTime + note.time + note.duration,
        },
        dest,
        wobble,
        onEnded,
      ),
    );
  };

  const scheduleUntil = (untilSec: number): void => {
    if (disposed) return;
    while (nextNote < noteOrder.length && piece.notes[noteOrder[nextNote]].time < untilSec) {
      const index = noteOrder[nextNote++];
      scheduleNote(piece.notes[index], releases[index]);
    }
    while (nextPad < padOrder.length && piece.pad[padOrder[nextPad]].time < untilSec) {
      schedulePad(piece.pad[padOrder[nextPad++]]);
    }
  };

  return {
    ctx,
    stems,
    startTime,
    totalSec,
    get liveVoices() {
      return live.size;
    },
    scheduleUntil,
    scheduleAll: () => scheduleUntil(Infinity),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const voice of live) voice.dispose();
      live.clear();
      for (const source of sources) {
        try {
          source.stop();
        } catch {
          // already stopped
        }
        source.disconnect();
      }
      wobble?.dispose();
      for (const node of fixed) node.disconnect();
    },
  };
}
