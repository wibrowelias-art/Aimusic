import { describe, expect, it } from 'vitest';
import { encodeWav, WAV_HEADER_BYTES } from '../../src/audio/wav';

function text(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function decode(bytes: Uint8Array): { channels: number; sampleRate: number; bits: number; data: number[][] } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const channels = view.getUint16(22, true);
  const bits = view.getUint16(34, true);
  const dataBytes = view.getUint32(40, true);
  const step = bits / 8;
  const frames = dataBytes / (step * channels);
  const data: number[][] = Array.from({ length: channels }, () => []);
  let o = WAV_HEADER_BYTES;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      let v: number;
      if (bits === 16) v = view.getInt16(o, true);
      else v = (view.getUint8(o) | (view.getUint8(o + 1) << 8) | (view.getInt8(o + 2) << 16)) | 0;
      data[c].push(v);
      o += step;
    }
  }
  return { channels, sampleRate: view.getUint32(24, true), bits, data };
}

describe('encodeWav', () => {
  it('writes a correct RIFF/PCM header (16 bit stereo default)', () => {
    const frames = 1000;
    const wav = encodeWav([new Float32Array(frames), new Float32Array(frames)], 48000);
    const view = new DataView(wav.buffer);
    expect(wav.length).toBe(44 + frames * 4);
    expect(text(wav, 0, 4)).toBe('RIFF');
    expect(view.getUint32(4, true)).toBe(wav.length - 8);
    expect(text(wav, 8, 4)).toBe('WAVE');
    expect(text(wav, 12, 4)).toBe('fmt ');
    expect(view.getUint32(16, true)).toBe(16);
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(2); // channels
    expect(view.getUint32(24, true)).toBe(48000);
    expect(view.getUint32(28, true)).toBe(48000 * 4); // byte rate
    expect(view.getUint16(32, true)).toBe(4); // block align
    expect(view.getUint16(34, true)).toBe(16);
    expect(text(wav, 36, 4)).toBe('data');
    expect(view.getUint32(40, true)).toBe(frames * 4);
  });

  it('writes a correct header for 24 bit and pads odd data to a word', () => {
    const wav = encodeWav([new Float32Array(3)], 44100, { bitDepth: 24 });
    const view = new DataView(wav.buffer);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(44100);
    expect(view.getUint32(28, true)).toBe(44100 * 3);
    expect(view.getUint16(32, true)).toBe(3);
    expect(view.getUint16(34, true)).toBe(24);
    expect(view.getUint32(40, true)).toBe(9);
    expect(wav.length).toBe(44 + 9 + 1);
    expect(view.getUint32(4, true)).toBe(wav.length - 8);
  });

  it('round-trips known samples at 24 bit exactly', () => {
    const left = Float32Array.from([0, 0.5, -0.5, 0.25, 1 / 8388608, -1, 0.75, -0.125]);
    const right = Float32Array.from([0.125, -0.25, 0, 0, 0.5, 0.5, -0.75, 1 / 4096]);
    const out = decode(encodeWav([left, right], 48000, { bitDepth: 24 }));
    expect(out.bits).toBe(24);
    expect(out.data[0]).toEqual(Array.from(left, (v) => Math.round(v * 8388608)));
    expect(out.data[1]).toEqual(Array.from(right, (v) => Math.round(v * 8388608)));
  });

  it('round-trips known samples at 16 bit within the dither (+-1.5 LSB), keeps zeros, is deterministic', () => {
    const n = 4096;
    const left = new Float32Array(n);
    const right = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      left[i] = i % 4 === 0 ? 0 : 0.6 * Math.sin(i * 0.01);
      right[i] = 0.1003; // constant: the dither must make the LSB move
    }
    const a = encodeWav([left, right], 48000);
    const b = encodeWav([left, right], 48000, { bitDepth: 16 });
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    const out = decode(a);
    let maxErr = 0;
    for (let i = 0; i < n; i++) {
      maxErr = Math.max(maxErr, Math.abs(out.data[0][i] - left[i] * 32768), Math.abs(out.data[1][i] - right[i] * 32768));
      if (left[i] === 0) expect(out.data[0][i]).toBe(0);
    }
    expect(maxErr).toBeLessThanOrEqual(1.5);
    expect(new Set(out.data[1]).size).toBeGreaterThan(1);
    const mean = out.data[1].reduce((s, v) => s + v, 0) / n;
    expect(Math.abs(mean - 0.1003 * 32768)).toBeLessThan(0.1); // dither has no bias
  });

  it('clamps instead of wrapping', () => {
    const x = Float32Array.from([1, 1.5, -1, -1.5, 100, -100, Infinity, -Infinity, NaN]);
    const w16 = decode(encodeWav([x], 48000)).data[0];
    expect(w16).toEqual([32767, 32767, -32768, -32768, 32767, -32768, 32767, -32768, 0]);
    const w24 = decode(encodeWav([x], 48000, { bitDepth: 24 })).data[0];
    expect(w24).toEqual([8388607, 8388607, -8388608, -8388608, 8388607, -8388608, 8388607, -8388608, 0]);
  });

  it('rejects channels of different length', () => {
    expect(() => encodeWav([new Float32Array(4), new Float32Array(5)], 48000)).toThrow();
    expect(() => encodeWav([], 48000)).toThrow();
  });
});
