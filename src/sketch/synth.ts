/**
 * The synthesised voices of the built-in generator and the mixdown. Plain arithmetic on
 * sample arrays: no Web Audio, no samples, seeded noise only. Same sketch, same samples,
 * in the browser and in Node.
 *
 * Voices: pad (detuned saws), organ (four sine partials), keys and bell (two-operator FM),
 * toy (triangle with vibrato), pluck (Karplus-Strong string), bass and sub (sines),
 * drone, kick / snare / hat / tick, voice (saw through three vowel formants, no words),
 * air (slow band-passed noise).
 */
import { bandpassCoeffs, biquadInPlace, highpassCoeffs, lowpassCoeffs, midiToHz } from '../audio/dsp';
import { mulberry32, subSeed } from '../audio/rng';
import type { StereoPcm } from '../audio/types';
import type { Sketch, SketchAudio, SketchEvent, SketchTrack } from './types';

export const SKETCH_SAMPLE_RATE = 48000;
/** Room for the last releases after the music ends, seconds. */
export const SKETCH_TAIL_SEC = 3;
/** Peak of the raw mix (the lo-fi chain sets the final loudness). */
export const SKETCH_PEAK = 0.5;

const TAU = Math.PI * 2;

/** Voices rendered once per channel with slightly different tuning, for width. */
const WIDE = new Set(['pad', 'drone', 'voice', 'organ']);

/** Band-limited step correction for a saw. */
function polyBlep(phase: number, dt: number): number {
  if (phase < dt) {
    const x = phase / dt;
    return x + x - x * x - 1;
  }
  if (phase > 1 - dt) {
    const x = (phase - 1) / dt;
    return x * x + x + x + 1;
  }
  return 0;
}

/** Raised-cosine fade in over `attack` and out over `release` samples around a held length. */
function swell(i: number, held: number, attack: number, release: number): number {
  if (i < attack) return 0.5 - 0.5 * Math.cos((Math.PI * i) / attack);
  if (i < held) return 1;
  const r = i - held;
  return r < release ? 0.5 + 0.5 * Math.cos((Math.PI * r) / release) : 0;
}

interface NoteContext {
  buf: Float32Array;
  sr: number;
  start: number;
  /** Held samples. */
  held: number;
  hz: number;
  level: number;
  rand: () => number;
  /** 0 = left / mono, 1 = right. */
  channel: number;
}

type NoteRenderer = (c: NoteContext) => void;

const renderPad: NoteRenderer = ({ buf, sr, start, held, hz, level, rand, channel }) => {
  const attack = Math.round(1.2 * sr);
  const release = Math.round(2.2 * sr);
  const hold = Math.max(held, attack);
  const total = Math.min(buf.length - start, hold + release);
  const spread = channel === 0 ? -1 : 1;
  for (const cents of [0, 7 + 2 * spread, -7 + 2 * spread]) {
    const dt = (hz * 2 ** (cents / 1200)) / sr;
    let phase = rand();
    for (let i = 0; i < total; i++) {
      phase += dt;
      if (phase >= 1) phase -= 1;
      buf[start + i] += (2 * phase - 1 - polyBlep(phase, dt)) * level * 0.2 * swell(i, hold, attack, release);
    }
  }
};

const renderOrgan: NoteRenderer = ({ buf, sr, start, held, hz, level, rand, channel }) => {
  const attack = Math.round(0.25 * sr);
  const release = Math.round(0.7 * sr);
  const hold = Math.max(held, attack);
  const total = Math.min(buf.length - start, hold + release);
  const partials = [1, 0.5, 0.22, 0.1];
  const tune = 2 ** (((channel === 0 ? -1.5 : 1.5) as number) / 1200);
  const tremoloPhase = rand() * TAU;
  partials.forEach((gain, k) => {
    const w = (TAU * hz * tune * (k + 1)) / sr;
    if (hz * (k + 1) > sr * 0.45) return;
    const phase = rand() * TAU;
    for (let i = 0; i < total; i++) {
      const tremolo = 1 + 0.05 * Math.sin((TAU * 0.9 * i) / sr + tremoloPhase);
      buf[start + i] += Math.sin(w * i + phase) * gain * level * 0.22 * tremolo * swell(i, hold, attack, release);
    }
  });
};

/** Two-operator FM with a falling modulation index: `ratio` 1 for the keys, 3.5 for the bell. */
function fm(ratio: number, indexStart: number, indexDecay: number, t60: (hz: number) => number, minRing: number): NoteRenderer {
  return ({ buf, sr, start, held, hz, level }) => {
    const ring = t60(hz);
    const tau = ring / 6.9;
    const total = Math.min(buf.length - start, Math.round(Math.max(held / sr, minRing, ring * 0.8) * sr));
    const attack = Math.round(0.004 * sr);
    const w = (TAU * hz) / sr;
    for (let i = 0; i < total; i++) {
      const t = i / sr;
      const index = indexStart * Math.exp(-t / indexDecay) + 0.2;
      const env = Math.exp(-t / tau) * (i < attack ? i / attack : 1) * (i > total - 2400 ? (total - i) / 2400 : 1);
      buf[start + i] += Math.sin(w * i + index * Math.sin(w * ratio * i)) * env * level * 0.5;
    }
  };
}

const renderKeys = fm(1, 1.4, 0.25, (hz) => Math.min(4.5, Math.max(1.4, 4.5 - Math.log2(hz / 130) * 1.1)), 1.5);
const renderBell = fm(3.5, 2.2, 0.6, (hz) => Math.min(5, Math.max(2, 5 - Math.log2(hz / 200))), 2.5);

const renderToy: NoteRenderer = ({ buf, sr, start, held, hz, level, rand }) => {
  const attack = Math.round(0.015 * sr);
  const release = Math.round(0.3 * sr);
  const hold = Math.max(held, attack);
  const total = Math.min(buf.length - start, hold + release);
  let phase = rand();
  const vibPhase = rand() * TAU;
  for (let i = 0; i < total; i++) {
    const t = i / sr;
    const vib = 1 + 0.004 * Math.min(1, t / 0.4) * Math.sin(TAU * 5.5 * t + vibPhase);
    phase += (hz * vib) / sr;
    if (phase >= 1) phase -= 1;
    const tri = 4 * Math.abs(phase - 0.5) - 1;
    const body = tri + 0.2 * Math.sin(TAU * 2 * phase);
    const sag = 0.7 + 0.3 * Math.exp(-t / 0.3);
    buf[start + i] += body * sag * level * 0.3 * swell(i, hold, attack, release);
  }
};

/** Karplus-Strong string with a fractional-delay all-pass, so it is in tune at every pitch. */
const renderPluck: NoteRenderer = ({ buf, sr, start, held, hz, level, rand }) => {
  const period = sr / hz - 0.5; // the two-point average in the loop adds half a sample
  let n = Math.floor(period);
  let frac = period - n;
  if (frac < 0.2) {
    n -= 1;
    frac += 1;
  }
  if (n < 2) return;
  const allpass = (1 - frac) / (1 + frac);
  const line = new Float32Array(n);
  // Pick: noise, softened more for quiet notes.
  let lp = 0;
  const soft = 0.35 + 0.45 * level;
  let mean = 0;
  for (let i = 0; i < n; i++) {
    lp += soft * (rand() * 2 - 1 - lp);
    line[i] = lp;
    mean += lp;
  }
  mean /= n;
  for (let i = 0; i < n; i++) line[i] -= mean;
  const ringSec = Math.min(6, Math.max(1.5, 5 - Math.log2(hz / 110)));
  const sustain = 10 ** (-3 / (ringSec * hz));
  const damped = 10 ** (-3 / (0.25 * hz));
  const total = Math.min(buf.length - start, held + Math.round(0.6 * sr));
  let idx = 0;
  let x1 = 0;
  let y1 = 0;
  for (let i = 0; i < total; i++) {
    const cur = line[idx];
    const next = line[idx + 1 === n ? 0 : idx + 1];
    const avg = 0.5 * (cur + next);
    const y = allpass * avg + x1 - allpass * y1;
    x1 = avg;
    y1 = y;
    line[idx] = y * (i < held ? sustain : damped);
    idx = idx + 1 === n ? 0 : idx + 1;
    buf[start + i] += cur * level * 0.9;
  }
};

const renderBass: NoteRenderer = ({ buf, sr, start, held, hz, level }) => {
  const attack = Math.round(0.006 * sr);
  const release = Math.round(0.08 * sr);
  const hold = Math.max(held, attack);
  const total = Math.min(buf.length - start, hold + release);
  const w = (TAU * hz) / sr;
  for (let i = 0; i < total; i++) {
    const t = i / sr;
    const body = Math.sin(w * i) + 0.35 * Math.exp(-t / 0.3) * Math.sin(2 * w * i);
    buf[start + i] += body * Math.exp(-t / 0.9) * level * 0.6 * swell(i, hold, attack, release);
  }
};

const renderSub: NoteRenderer = ({ buf, sr, start, held, hz, level }) => {
  const attack = Math.round(0.5 * sr);
  const release = Math.round(0.9 * sr);
  const hold = Math.max(held, attack);
  const total = Math.min(buf.length - start, hold + release);
  const w = (TAU * hz) / sr;
  for (let i = 0; i < total; i++) buf[start + i] += Math.sin(w * i) * level * 0.5 * swell(i, hold, attack, release);
};

const renderDrone: NoteRenderer = ({ buf, sr, start, held, hz, level, rand, channel }) => {
  const attack = Math.round(2.5 * sr);
  const release = Math.round(2.5 * sr);
  const hold = Math.max(held, attack);
  const total = Math.min(buf.length - start, hold + release);
  const tune = channel === 0 ? 0.9985 : 1.0015;
  const w = (TAU * hz * tune) / sr;
  const p1 = rand() * TAU;
  const p2 = rand() * TAU;
  const lfo = rand() * TAU;
  for (let i = 0; i < total; i++) {
    const slow = 1 + 0.2 * Math.sin((TAU * 0.07 * i) / sr + lfo);
    const body = Math.sin(w * i + p1) + 0.3 * Math.sin(2 * w * i + p2) + 0.08 * Math.sin(3 * w * i);
    buf[start + i] += body * slow * level * 0.3 * swell(i, hold, attack, release);
  }
};

const renderKick: NoteRenderer = ({ buf, sr, start, level }) => {
  const total = Math.min(buf.length - start, Math.round(0.6 * sr));
  let phase = 0;
  for (let i = 0; i < total; i++) {
    const t = i / sr;
    phase += (TAU * (44 + 70 * Math.exp(-t / 0.03))) / sr;
    buf[start + i] += Math.sin(phase) * Math.exp(-t / 0.16) * level * 0.9 * Math.min(1, i / 48);
  }
};

const renderSnare: NoteRenderer = ({ buf, sr, start, level, rand }) => {
  const total = Math.min(buf.length - start, Math.round(0.4 * sr));
  let prev = 0;
  for (let i = 0; i < total; i++) {
    const t = i / sr;
    const noise = rand() * 2 - 1;
    const high = noise - prev; // crude high-pass
    prev = noise;
    buf[start + i] += (high * 0.5 * Math.exp(-t / 0.09) + Math.sin(TAU * 185 * t) * 0.6 * Math.exp(-t / 0.05)) * level * 0.6;
  }
};

const renderHat: NoteRenderer = ({ buf, sr, start, level, rand }) => {
  const total = Math.min(buf.length - start, Math.round(0.09 * sr));
  let prev = 0;
  for (let i = 0; i < total; i++) {
    const noise = rand() * 2 - 1;
    const high = noise - prev;
    prev = noise;
    buf[start + i] += high * Math.exp(-i / (0.022 * sr)) * level * 0.5;
  }
};

const renderTick: NoteRenderer = ({ buf, sr, start, level, hz, rand }) => {
  const total = Math.min(buf.length - start, Math.round(0.04 * sr));
  const w = (TAU * Math.min(hz, 4000)) / sr;
  for (let i = 0; i < total; i++) {
    buf[start + i] += (Math.sin(w * i) + 0.3 * (rand() * 2 - 1)) * Math.exp(-i / (0.006 * sr)) * level * 0.6;
  }
};

/** The source of the voice: a saw with late vibrato and a little breath. The vowel comes later. */
const renderVoice: NoteRenderer = ({ buf, sr, start, held, hz, level, rand, channel }) => {
  const attack = Math.round(0.3 * sr);
  const release = Math.round(0.7 * sr);
  const hold = Math.max(held, attack);
  const total = Math.min(buf.length - start, hold + release);
  const tune = channel === 0 ? 0.998 : 1.002;
  let phase = rand();
  const vibPhase = rand() * TAU;
  for (let i = 0; i < total; i++) {
    const t = i / sr;
    const vib = 1 + 0.006 * Math.min(1, Math.max(0, (t - 0.35) / 0.6)) * Math.sin(TAU * 5.2 * t + vibPhase);
    const dt = (hz * tune * vib) / sr;
    phase += dt;
    if (phase >= 1) phase -= 1;
    const saw = 2 * phase - 1 - polyBlep(phase, dt);
    buf[start + i] += (saw + 0.25 * (rand() * 2 - 1)) * level * 0.5 * swell(i, hold, attack, release);
  }
};

const RENDERERS: Record<SketchTrack['voice'], NoteRenderer | null> = {
  pad: renderPad,
  organ: renderOrgan,
  keys: renderKeys,
  bell: renderBell,
  toy: renderToy,
  pluck: renderPluck,
  bass: renderBass,
  sub: renderSub,
  drone: renderDrone,
  kick: renderKick,
  snare: renderSnare,
  hat: renderHat,
  tick: renderTick,
  voice: renderVoice,
  air: null,
};

function filter(buf: Float32Array, ...coeffs: ReturnType<typeof lowpassCoeffs>[]): void {
  for (const c of coeffs) biquadInPlace(buf, c);
}

/** What happens to a whole track after its notes: tone filters, vowel, overdrive. */
function finish(track: SketchTrack, buf: Float32Array, sr: number): void {
  switch (track.voice) {
    case 'pad':
      filter(buf, lowpassCoeffs(sr, 1300), lowpassCoeffs(sr, 2600));
      break;
    case 'voice': {
      // Three vowel formants ("oo" towards "oh"), summed, then the top taken off.
      const dry = buf.slice();
      buf.fill(0);
      for (const [hz, q, gain] of [
        [380, 5, 1],
        [820, 7, 0.55],
        [2500, 9, 0.12],
      ] as const) {
        const band = dry.slice();
        biquadInPlace(band, bandpassCoeffs(sr, hz, q));
        for (let i = 0; i < buf.length; i++) buf[i] += band[i] * gain * 2.5;
      }
      filter(buf, lowpassCoeffs(sr, 3800));
      break;
    }
    case 'pluck':
      if (track.drive > 0) {
        const g = 1 + 24 * track.drive;
        for (let i = 0; i < buf.length; i++) buf[i] = Math.tanh(buf[i] * g) * 0.45;
        filter(buf, highpassCoeffs(sr, 110), lowpassCoeffs(sr, 3200), lowpassCoeffs(sr, 4500));
      } else {
        filter(buf, highpassCoeffs(sr, 80), lowpassCoeffs(sr, 5200));
      }
      break;
    case 'toy':
      filter(buf, lowpassCoeffs(sr, 3000));
      break;
    case 'keys':
    case 'bell':
      filter(buf, lowpassCoeffs(sr, 6000));
      break;
    case 'bass':
    case 'sub':
      filter(buf, lowpassCoeffs(sr, 700));
      break;
    case 'hat':
      filter(buf, highpassCoeffs(sr, 6000));
      break;
    default:
      break;
  }
}

/** A slow band of noise that swells and fades. */
function renderAir(buf: Float32Array, event: SketchEvent, sr: number, rand: () => number): void {
  const start = Math.round(event.time * sr);
  const total = Math.min(buf.length - start, Math.round(event.duration * sr));
  const phase = rand() * TAU;
  for (let i = 0; i < total; i++) buf[start + i] = rand() * 2 - 1;
  filter(buf, bandpassCoeffs(sr, 480, 0.7), lowpassCoeffs(sr, 1800));
  const fade = Math.round(2 * sr);
  for (let i = 0; i < total; i++) {
    const slow = 0.55 + 0.45 * Math.sin((TAU * 0.06 * i) / sr + phase);
    buf[start + i] *= slow * event.level * Math.min(1, i / fade, (total - i) / fade);
  }
}

/** One track as stereo, pan and gain applied. */
export function renderTrack(track: SketchTrack, frames: number, sr: number, seed: number): StereoPcm {
  const wide = WIDE.has(track.voice);
  const channels: Float32Array[] = [];
  for (let channel = 0; channel < (wide ? 2 : 1); channel++) {
    const buf = new Float32Array(frames);
    // Same noise in both channels of a wide voice would cancel its width, so the seed moves with the channel.
    const rand = mulberry32(subSeed(seed, channel + 1));
    const render = RENDERERS[track.voice];
    for (const event of track.events) {
      const start = Math.round(event.time * sr);
      if (start < 0 || start >= frames) continue;
      if (!render) {
        renderAir(buf, event, sr, rand);
        continue;
      }
      render({ buf, sr, start, held: Math.max(1, Math.round(event.duration * sr)), hz: midiToHz(event.pitch), level: event.level, rand, channel });
    }
    finish(track, buf, sr);
    channels.push(buf);
  }
  const left = channels[0];
  const right = channels[1] ?? channels[0].slice();
  const angle = ((Math.min(1, Math.max(-1, track.pan)) + 1) * Math.PI) / 4;
  const gl = Math.cos(angle) * Math.SQRT2 * track.gain;
  const gr = Math.sin(angle) * Math.SQRT2 * track.gain;
  for (let i = 0; i < frames; i++) {
    left[i] *= gl;
    right[i] *= gr;
  }
  return [left, right];
}

/** The whole sketch as audio: the mix, and vocals / backing stems when there is a voice. */
export function renderSketch(sketch: Sketch, sampleRate = SKETCH_SAMPLE_RATE): SketchAudio {
  const frames = Math.ceil((sketch.musicSec + SKETCH_TAIL_SEC) * sampleRate);
  const vocals: StereoPcm = [new Float32Array(frames), new Float32Array(frames)];
  const backing: StereoPcm = [new Float32Array(frames), new Float32Array(frames)];
  let hasVoice = false;
  sketch.tracks.forEach((track, index) => {
    const [l, r] = renderTrack(track, frames, sampleRate, subSeed(sketch.request.seed >>> 0, 100 + index));
    const bus = track.group === 'voice' ? vocals : backing;
    if (track.group === 'voice') hasVoice = true;
    for (let i = 0; i < frames; i++) {
      bus[0][i] += l[i];
      bus[1][i] += r[i];
    }
  });
  const full: StereoPcm = [new Float32Array(frames), new Float32Array(frames)];
  let peak = 0;
  for (let ch = 0; ch < 2; ch++) {
    for (let i = 0; i < frames; i++) {
      const v = vocals[ch][i] + backing[ch][i];
      full[ch][i] = v;
      if (Math.abs(v) > peak) peak = Math.abs(v);
    }
  }
  const scale = peak > 0 ? SKETCH_PEAK / peak : 1;
  // Fade the very end so nothing is cut.
  const fade = Math.min(frames, Math.round(0.5 * sampleRate));
  for (const pcm of [full, vocals, backing]) {
    for (const c of pcm) {
      for (let i = 0; i < frames; i++) c[i] *= scale * (i >= frames - fade ? (frames - i) / fade : 1);
    }
  }
  return { sampleRate, full, stems: hasVoice ? { vocals, backing } : null, durationSec: frames / sampleRate };
}
