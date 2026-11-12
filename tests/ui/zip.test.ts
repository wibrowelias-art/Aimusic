import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { crc32, makeZip } from '../../src/ui/zip';

const text = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('zip writer', () => {
  it('crc32 matches the known check value', () => {
    expect(crc32(text('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
  });

  it('writes local headers, a central directory and the end record', () => {
    const a = text('hello');
    const b = new Uint8Array([0, 1, 2, 3, 250, 251, 252]);
    const zip = makeZip([
      { name: 'a.txt', data: a },
      { name: 'stems/b.bin', data: b },
    ]);
    const view = new DataView(zip.buffer);
    expect(view.getUint32(0, true)).toBe(0x04034b50);
    const end = zip.length - 22;
    expect(view.getUint32(end, true)).toBe(0x06054b50);
    expect(view.getUint16(end + 10, true)).toBe(2);
    const centralStart = view.getUint32(end + 16, true);
    expect(view.getUint32(centralStart, true)).toBe(0x02014b50);
    expect(centralStart + view.getUint32(end + 12, true)).toBe(end);
    // First entry: stored, sizes and CRC, then the bytes.
    expect(view.getUint16(8, true)).toBe(0);
    expect(view.getUint32(14, true)).toBe(crc32(a));
    expect(view.getUint32(18, true)).toBe(5);
    expect(new TextDecoder().decode(zip.subarray(30, 35))).toBe('a.txt');
    expect(new TextDecoder().decode(zip.subarray(35, 40))).toBe('hello');
    // Deterministic.
    expect(Buffer.from(makeZip([{ name: 'a.txt', data: a }])).equals(Buffer.from(makeZip([{ name: 'a.txt', data: a }])))).toBe(true);
  });

  it('is readable by an independent zip reader (python zipfile), when python is around', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ambient-zip-'));
    try {
      const big = new Uint8Array(70000);
      for (let i = 0; i < big.length; i++) big[i] = (i * 31) & 0xff;
      const file = join(dir, 't.zip');
      writeFileSync(file, makeZip([
        { name: 'CREDITS.txt', data: text('credits') },
        { name: 'stems/piano.wav', data: big },
      ]));
      let out: string;
      try {
        out = execFileSync(
          'python3',
          ['-I', '-c', 'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); print(z.testzip()); print([(i.filename,i.file_size) for i in z.infolist()]); print(z.read("CREDITS.txt"))', file],
          { encoding: 'utf8' },
        );
      } catch {
        return; // no python on this machine
      }
      expect(out).toContain('None');
      expect(out).toContain("('CREDITS.txt', 7)");
      expect(out).toContain("('stems/piano.wav', 70000)");
      expect(out).toContain("b'credits'");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
