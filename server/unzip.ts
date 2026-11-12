/** Reads a ZIP archive (stored or deflated entries) with Node's zlib. Enough for the stems download. */
import { inflateRawSync } from 'node:zlib';

export interface UnzippedFile {
  name: string;
  data: Uint8Array;
}

export function unzip(bytes: Uint8Array): UnzippedFile[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // End of central directory: search backwards for its signature.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not a ZIP archive.');
  const count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  const out: UnzippedFile[] = [];
  for (let n = 0; n < count; n++) {
    if (view.getUint32(at, true) !== 0x02014b50) throw new Error('Broken ZIP directory.');
    const method = view.getUint16(at + 10, true);
    const compressedSize = view.getUint32(at + 20, true);
    const nameLen = view.getUint16(at + 28, true);
    const extraLen = view.getUint16(at + 30, true);
    const commentLen = view.getUint16(at + 32, true);
    const localAt = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLen));
    at += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    const localNameLen = view.getUint16(localAt + 26, true);
    const localExtraLen = view.getUint16(localAt + 28, true);
    const start = localAt + 30 + localNameLen + localExtraLen;
    const raw = bytes.subarray(start, start + compressedSize);
    if (method === 0) out.push({ name, data: raw.slice() });
    else if (method === 8) out.push({ name, data: new Uint8Array(inflateRawSync(raw)) });
    else throw new Error(`ZIP method ${method} is not supported.`);
  }
  return out;
}
