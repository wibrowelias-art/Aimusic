/**
 * Guard for hard rule 1 (originality): the engine sources must not contain hard-coded note
 * material. A scale has at most 7 tones, so any literal list of more than 7 numbers (flat or
 * as a table of small arrays), any long list of note names and any long run of literal pitch
 * assignments is treated as a note-sequence table and fails the build.
 * The same scan checks the determinism rule: no Math.random / Date in engine code.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ENGINE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'engine');
const MAX_LITERAL_NUMBERS = 7;

const NUMBER = /^[-+]?(?:0x[0-9a-f]+|\d+\.?\d*(?:e[-+]?\d+)?|\.\d+)$/i;

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
}

/** Numbers of a bracket body when it is a pure list of numeric literals, else null. */
function numericList(body: string): number | null {
  const parts = body
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length === 0 || !parts.every((p) => NUMBER.test(p))) return null;
  return parts.length;
}

/** Human-readable findings; empty when the source is clean. */
function findNoteTables(source: string): string[] {
  const code = stripComments(source);
  const findings: string[] = [];

  // 1. Flat numeric array literals.
  for (const match of code.matchAll(/\[([^[\]]*)\]/g)) {
    const count = numericList(match[1]);
    if (count !== null && count > MAX_LITERAL_NUMBERS) findings.push(`numeric list of ${count}: [${match[1].trim().slice(0, 60)}]`);
  }

  // 2. Tables of small numeric arrays: [[60, 1], [62, 1], ...].
  for (const match of code.matchAll(/\[\s*(?:\[[^[\]]*\]\s*,?\s*)+\]/g)) {
    let total = 0;
    let pure = true;
    for (const inner of match[0].slice(1, -1).matchAll(/\[([^[\]]*)\]/g)) {
      const count = numericList(inner[1]);
      if (count === null) pure = false;
      else total += count;
    }
    if (pure && total > MAX_LITERAL_NUMBERS) findings.push(`numeric table with ${total} numbers: ${match[0].slice(0, 60)}`);
  }

  // 3. Lists of note names with octaves: 'C4', "F#3", `Bb2` ...
  for (const match of code.matchAll(/(?:['"`][A-G][#b]?-?\d['"`]\s*,?\s*){8,}/g)) {
    findings.push(`list of note names: ${match[0].slice(0, 60)}`);
  }

  // 4. Long runs of literal pitch assignments in object tables: { pitch: 60, ... }, { pitch: 62, ... }
  const literalPitches = code.match(/\b(?:pitch|note|midi|key)\s*:\s*\d+\b/g) ?? [];
  if (literalPitches.length > MAX_LITERAL_NUMBERS) findings.push(`${literalPitches.length} literal pitch assignments`);

  return findings;
}

function engineFiles(): string[] {
  return readdirSync(ENGINE_DIR, { recursive: true })
    .map((entry) => String(entry))
    .sort();
}

describe('originality guard', () => {
  it('src/engine holds TypeScript sources only (no MIDI, audio or data files)', () => {
    const files = engineFiles();
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) expect(file.endsWith('.ts')).toBe(true);
  });

  it('no engine source contains a hard-coded note-sequence table longer than a scale', () => {
    for (const file of engineFiles()) {
      const findings = findNoteTables(readFileSync(join(ENGINE_DIR, file), 'utf8'));
      expect(findings, `${file}: ${findings.join(' | ')}`).toEqual([]);
    }
  });

  it('no engine source uses unseeded randomness or the clock', () => {
    const banned = [/Math\.random/, /Date\.now/, /new Date\b/, /performance\.now/, /crypto\./, /\bwindow\b/, /\bdocument\b/];
    for (const file of engineFiles()) {
      const code = stripComments(readFileSync(join(ENGINE_DIR, file), 'utf8'));
      for (const pattern of banned) expect(pattern.test(code), `${file} matches ${pattern}`).toBe(false);
    }
  });

  it('no engine source loads note material from outside (imports stay inside src/engine)', () => {
    for (const file of engineFiles()) {
      const code = stripComments(readFileSync(join(ENGINE_DIR, file), 'utf8'));
      for (const match of code.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
        expect(match[1].startsWith('./'), `${file} imports ${match[1]}`).toBe(true);
        expect(/\.(json|mid|midi|txt|csv)$/.test(match[1])).toBe(false);
      }
      expect(/\brequire\s*\(|\bfetch\s*\(|readFile/.test(code), `${file} reads external data`).toBe(false);
    }
  });

  it('the detector itself works: it flags planted tables and accepts scales', () => {
    expect(findNoteTables('const melody = [60, 62, 64, 65, 67, 69, 71, 72];').length).toBe(1);
    expect(findNoteTables('const melody = [\n  60, 62, 64,\n  65, 67, 69,\n  71, 72, 74,\n];').length).toBe(1);
    expect(findNoteTables('const notes = [[60, 1], [62, 1], [64, 2], [65, 1]];').length).toBe(1);
    expect(findNoteTables("const tune = ['E4', 'D4', 'C4', 'D4', 'E4', 'E4', 'E4', 'D4'];").length).toBe(1);
    expect(
      findNoteTables(
        'const t = [{ pitch: 60 }, { pitch: 62 }, { pitch: 64 }, { pitch: 65 }, { pitch: 67 }, { pitch: 69 }, { pitch: 71 }, { pitch: 72 }];',
      ).length,
    ).toBe(1);
    // A table hidden in a comment is not code.
    expect(findNoteTables('// [60, 62, 64, 65, 67, 69, 71, 72]\nconst x = 1;')).toEqual([]);
    // Scales, chord stacks and weight lists pass.
    expect(findNoteTables('const lydian = [0, 2, 4, 6, 7, 9, 11];')).toEqual([]);
    expect(findNoteTables('rng.weighted([0.5, 1, 1.5, 2, 3], [0.05, 0.38, 0.1, 0.33, 0.14]);')).toEqual([]);
    expect(findNoteTables("const names = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];")).toEqual([]);
    expect(findNoteTables('const a: number[] = []; const b = a[3]; const c = [1, x, 3, 4, 5, 6, 7, 8, 9];')).toEqual([]);
  });
});
