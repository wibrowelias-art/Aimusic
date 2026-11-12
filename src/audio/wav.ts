/**
 * PCM WAV encoder (RIFF, little endian, interleaved).
 * 16 bit gets deterministic TPDF dither (fixed seed); 24 bit is rounded only.
 * Samples that are exactly 0 stay 0 so digital silence survives the export.
 */
import { DITHER_SEED } from './constants';
import { mulberry32 } from './rng';

export interface WavOptions {
  /** Bits per sample. Default 16. */
  bitDepth?: 16 | 24;
}

export const WAV_HEADER_BYTES = 44;

function writeAscii(out: Uint8Array, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) out[offset + i] = text.charCodeAt(i);
}

export function encodeWav(
  channels: Float32Array[],
  sampleRate: number,
  opts: WavOptions = {},
): Uint8Array<ArrayBuffer> {
  const bitDepth = opts.bitDepth ?? 16;
  if (bitDepth !== 16 && bitDepth !== 24) throw new Error(`encodeWav: unsupported bit depth ${String(bitDepth)}`);
  const numChannels = channels.length;
  if (numChannels < 1) throw new Error('encodeWav: no channels');
  const frames = channels[0].length;
  for (const ch of channels) {
    if (ch.length !== frames) throw new Error('encodeWav: channels differ in length');
  }
  const bytesPerSample = bitDepth / 8;
  const blockAlign = numChannels * bytesPerSample;
  const dataBytes = frames * blockAlign;
  const pad = dataBytes % 2; // RIFF chunks are word aligned
  const out = new Uint8Array(WAV_HEADER_BYTES + dataBytes + pad);
  const view = new DataView(out.buffer);

  writeAscii(out, 0, 'RIFF');
  view.setUint32(4, 36 + dataBytes + pad, true);
  writeAscii(out, 8, 'WAVE');
  writeAscii(out, 12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true); // byte rate
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  writeAscii(out, 36, 'data');
  view.setUint32(40, dataBytes, true);

  const scale = bitDepth === 16 ? 32768 : 8388608;
  const max = scale - 1;
  const min = -scale;
  const rand = mulberry32(DITHER_SEED);
  let o = WAV_HEADER_BYTES;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < numChannels; c++) {
      const x = channels[c][i];
      let v = 0;
      if (x !== 0 && Number.isFinite(x)) {
        // TPDF dither of +-1 LSB (difference of two uniform numbers) for 16 bit.
        const dither = bitDepth === 16 ? rand() - rand() : 0;
        v = Math.round(x * scale + dither);
        // Hard clamp guard: never wrap around.
        if (v > max) v = max;
        else if (v < min) v = min;
      } else if (x === Infinity) {
        v = max;
      } else if (x === -Infinity) {
        v = min;
      }
      out[o++] = v & 0xff;
      out[o++] = (v >> 8) & 0xff;
      if (bitDepth === 24) out[o++] = (v >> 16) & 0xff;
    }
  }
  return out;
}
