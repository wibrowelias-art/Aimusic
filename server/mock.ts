/**
 * Mock mode: a test signal instead of a call to the music API, so the page and the lo-fi
 * chain can be tried for free. It is a signal, not music: three steady tones that switch
 * on and off (the "vocals" stem) over band-limited noise bursts (the "backing" stem).
 */
import { mulberry32 } from '../src/audio/rng';
import type { StereoPcm } from '../src/audio/types';
import { encodeWav } from '../src/audio/wav';

export const MOCK_SAMPLE_RATE = 48000;

export interface MockAudio {
  full: Uint8Array;
  vocals: Uint8Array;
  backing: Uint8Array;
}

export function mockAudio(lengthSec: number, seed = 1): MockAudio {
  const sr = MOCK_SAMPLE_RATE;
  const n = Math.round(lengthSec * sr);
  const tones: StereoPcm = [new Float32Array(n), new Float32Array(n)];
  const noise: StereoPcm = [new Float32Array(n), new Float32Array(n)];
  const rand = mulberry32(seed >>> 0);
  const hz = [220, 330, 495];
  const lp = [0, 0];
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    // Each tone is on for 2 s out of every 3, 4 and 5 s; 50 ms ramps.
    let v = 0;
    hz.forEach((f, k) => {
      const period = 3 + k;
      const pos = t % period;
      const gate = Math.min(1, pos / 0.05, Math.max(0, (2 - pos) / 0.05));
      v += 0.12 * Math.max(0, gate) * Math.sin(2 * Math.PI * f * t);
    });
    tones[0][i] = v;
    tones[1][i] = v;
    // Noise bursts: 0.4 s on, 0.6 s off, one-pole low-pass, different left and right.
    const burst = t % 1 < 0.4 ? Math.min(1, (t % 1) / 0.01, (0.4 - (t % 1)) / 0.05) : 0;
    for (let ch = 0; ch < 2; ch++) {
      lp[ch] += 0.25 * ((rand() * 2 - 1) - lp[ch]);
      noise[ch][i] = 0.25 * burst * lp[ch];
    }
  }
  const full: StereoPcm = [new Float32Array(n), new Float32Array(n)];
  for (let ch = 0; ch < 2; ch++) for (let i = 0; i < n; i++) full[ch][i] = tones[ch][i] + noise[ch][i];
  return { full: encodeWav(full, sr), vocals: encodeWav(tones, sr), backing: encodeWav(noise, sr) };
}
