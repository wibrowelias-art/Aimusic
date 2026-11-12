#!/usr/bin/env node
/**
 * Downloads the piano samples Ambient Lab uses and converts them for the web.
 *
 * Source : Salamander Grand Piano V3 (Yamaha C5) by Alexander Holm
 * Licence: Creative Commons Attribution 3.0 Unported (CC BY 3.0)
 * Mirror : https://github.com/sfzinstruments/SalamanderGrandPiano (48 kHz / 24 bit FLAC)
 *
 * What it does per note:
 *   1. download the original FLAC (one velocity layer, sampled in minor thirds)
 *   2. trim the silent lead-in so the hammer lands ~4 ms after the file start
 *   3. encode to MP3 (LAME VBR q4, 48 kHz, stereo). No EQ, no level change.
 *   4. measure the result and write manifest.json
 *
 * Needs `curl` and `ffmpeg` on the PATH. Usage: npm run samples:fetch
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'public', 'samples', 'piano');
const BASE = 'https://raw.githubusercontent.com/sfzinstruments/SalamanderGrandPiano/master/Samples';
const LAYER = 4; // of 16. Soft layer, see TUNING.md for the measurements behind the choice.
const SAMPLE_RATE = 48000;
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// Every minor third from F#1 to C7 (the set is sampled in minor thirds from A0).
const NOTES = [];
for (let midi = 30; midi <= 96; midi += 3) NOTES.push(midi);

function noteName(midi) {
  return `${NOTE_NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`;
}

function decode(file) {
  const raw = execFileSync(
    'ffmpeg',
    ['-v', 'error', '-i', file, '-f', 'f32le', '-ac', '2', '-ar', String(SAMPLE_RATE), '-'],
    { maxBuffer: 1 << 30 },
  );
  return new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
}

function analyse(pcm) {
  const frames = pcm.length / 2;
  let peak = 0;
  for (let i = 0; i < pcm.length; i++) peak = Math.max(peak, Math.abs(pcm[i]));
  const threshold = peak * 10 ** (-40 / 20);
  let onset = 0;
  for (let i = 0; i < frames; i++) {
    if (Math.abs(pcm[2 * i]) > threshold || Math.abs(pcm[2 * i + 1]) > threshold) {
      onset = i;
      break;
    }
  }
  let sum = 0;
  const n = Math.min(frames - onset, SAMPLE_RATE);
  for (let i = onset; i < onset + n; i++) {
    const m = 0.5 * (pcm[2 * i] + pcm[2 * i + 1]);
    sum += m * m;
  }
  return {
    duration: frames / SAMPLE_RATE,
    peakDb: 20 * Math.log10(peak),
    rmsDb: 10 * Math.log10(sum / n),
    onset: onset / SAMPLE_RATE,
  };
}

const round = (v, d = 2) => Number(v.toFixed(d));

mkdirSync(OUT_DIR, { recursive: true });
const tmp = mkdtempSync(join(tmpdir(), 'ambient-lab-samples-'));
const entries = [];
try {
  for (const midi of NOTES) {
    const name = noteName(midi);
    const srcName = `${name}v${LAYER}.flac`;
    const url = `${BASE}/${encodeURIComponent(srcName)}`;
    const flac = join(tmp, srcName.replace('#', 's'));
    const file = `${name.replace('#', 's')}.mp3`;
    const out = join(OUT_DIR, file);

    execFileSync('curl', ['-sSfL', '--retry', '4', '--retry-delay', '2', '-o', flac, url]);
    const sha256 = createHash('sha256').update(readFileSync(flac)).digest('hex');
    const src = analyse(decode(flac));
    const trim = Math.max(0, src.onset - 0.004);
    execFileSync('ffmpeg', [
      '-v', 'error', '-y',
      '-ss', trim.toFixed(4),
      '-i', flac,
      '-map_metadata', '-1',
      '-af', 'afade=t=in:st=0:d=0.002',
      '-c:a', 'libmp3lame', '-q:a', '4',
      '-ar', String(SAMPLE_RATE), '-ac', '2',
      out,
    ]);
    const res = analyse(decode(out));
    entries.push({
      midi,
      note: name,
      file,
      duration: round(res.duration, 3),
      peakDb: round(res.peakDb),
      rmsDb: round(res.rmsDb),
      onsetMs: round(res.onset * 1000, 1),
      source: url,
      sourceSha256: sha256,
    });
    console.log(
      `${name.padEnd(4)} -> ${file.padEnd(8)} ${res.duration.toFixed(1)} s  peak ${res.peakDb.toFixed(1)} dBFS  ` +
        `rms(1s) ${res.rmsDb.toFixed(1)} dBFS  onset ${(res.onset * 1000).toFixed(1)} ms`,
    );
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

const manifest = {
  instrument: 'Salamander Grand Piano V3 (Yamaha C5)',
  author: 'Alexander Holm',
  licence: 'CC BY 3.0 (https://creativecommons.org/licenses/by/3.0/)',
  source: 'https://github.com/sfzinstruments/SalamanderGrandPiano',
  changes: 'One velocity layer, lead-in silence trimmed, converted from FLAC to MP3 (LAME VBR q4). No other processing.',
  velocityLayer: LAYER,
  sampleRate: SAMPLE_RATE,
  notes: entries,
};
writeFileSync(join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`\n${entries.length} samples written to ${OUT_DIR}`);
