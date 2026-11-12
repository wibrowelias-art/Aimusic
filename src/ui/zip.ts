/**
 * Minimal ZIP writer (method 0 = stored, no compression) for the stems export.
 * WAV data does not compress well anyway, and this keeps the app free of a zip dependency.
 */

export interface ZipEntry {
  /** Path inside the archive, forward slashes, ASCII. */
  name: string;
  data: Uint8Array;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** MS-DOS date and time fields for a (local) Date. */
function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

export function makeZip(entries: readonly ZipEntry[], modified: Date = new Date(2026, 0, 1)): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder();
  const names = entries.map((e) => encoder.encode(e.name));
  const stamp = dosDateTime(modified);
  let localSize = 0;
  let centralSize = 0;
  entries.forEach((e, i) => {
    localSize += 30 + names[i].length + e.data.length;
    centralSize += 46 + names[i].length;
  });
  const out = new Uint8Array(localSize + centralSize + 22);
  const view = new DataView(out.buffer);
  const offsets: number[] = [];
  const crcs: number[] = [];
  let p = 0;
  entries.forEach((e, i) => {
    const crc = crc32(e.data);
    offsets.push(p);
    crcs.push(crc);
    view.setUint32(p, 0x04034b50, true); // local file header
    view.setUint16(p + 4, 20, true); // version needed
    view.setUint16(p + 6, 0, true); // flags
    view.setUint16(p + 8, 0, true); // method: stored
    view.setUint16(p + 10, stamp.time, true);
    view.setUint16(p + 12, stamp.date, true);
    view.setUint32(p + 14, crc, true);
    view.setUint32(p + 18, e.data.length, true);
    view.setUint32(p + 22, e.data.length, true);
    view.setUint16(p + 26, names[i].length, true);
    view.setUint16(p + 28, 0, true);
    out.set(names[i], p + 30);
    out.set(e.data, p + 30 + names[i].length);
    p += 30 + names[i].length + e.data.length;
  });
  const centralStart = p;
  entries.forEach((e, i) => {
    view.setUint32(p, 0x02014b50, true); // central directory header
    view.setUint16(p + 4, 20, true); // version made by
    view.setUint16(p + 6, 20, true); // version needed
    view.setUint16(p + 8, 0, true);
    view.setUint16(p + 10, 0, true);
    view.setUint16(p + 12, stamp.time, true);
    view.setUint16(p + 14, stamp.date, true);
    view.setUint32(p + 16, crcs[i], true);
    view.setUint32(p + 20, e.data.length, true);
    view.setUint32(p + 24, e.data.length, true);
    view.setUint16(p + 28, names[i].length, true);
    view.setUint16(p + 30, 0, true); // extra
    view.setUint16(p + 32, 0, true); // comment
    view.setUint16(p + 34, 0, true); // disk
    view.setUint16(p + 36, 0, true); // internal attributes
    view.setUint32(p + 38, 0, true); // external attributes
    view.setUint32(p + 42, offsets[i], true);
    out.set(names[i], p + 46);
    p += 46 + names[i].length;
  });
  view.setUint32(p, 0x06054b50, true); // end of central directory
  view.setUint16(p + 4, 0, true);
  view.setUint16(p + 6, 0, true);
  view.setUint16(p + 8, entries.length, true);
  view.setUint16(p + 10, entries.length, true);
  view.setUint32(p + 12, p - centralStart, true);
  view.setUint32(p + 16, centralStart, true);
  view.setUint16(p + 20, 0, true);
  return out;
}
