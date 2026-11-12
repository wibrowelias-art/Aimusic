import { describe, expect, it } from 'vitest';
import {
  LEVEL_CORRECTION_MAX_DB,
  LEVEL_CORRECTION_TABLE_DB,
  MAX_SHIFT_IN_RANGE_SEMITONES,
  MAX_SHIFT_SEMITONES,
  SAMPLE_RATE,
} from '../../src/audio/constants';
import { computeLevelCorrections, detectOnsetFrame, nearestSample } from '../../src/audio/sampler';
import { PITCH_MAX, PITCH_MIN } from '../../src/engine/params';
import { loadSamples, manifest } from '../fixtures/audio';

describe('piano sample set', () => {
  it('loads all 23 samples with an onset inside the first 20 ms', async () => {
    const set = await loadSamples();
    expect(set.samples).toHaveLength(23);
    expect(manifest.notes).toHaveLength(23);
    expect(set.sampleRate).toBe(SAMPLE_RATE);
    const onsetsMs: number[] = [];
    set.samples.forEach((s, i) => {
      if (i > 0) expect(s.midi).toBeGreaterThan(set.samples[i - 1].midi);
      const entry = manifest.notes.find((n) => n.midi === s.midi)!;
      expect(s.buffer.numberOfChannels).toBe(2);
      expect(s.buffer.sampleRate).toBe(SAMPLE_RATE);
      expect(Math.abs(s.buffer.duration - entry.duration)).toBeLessThan(0.1);
      expect(s.onsetSec).toBeGreaterThanOrEqual(0);
      expect(s.onsetSec).toBeLessThan(0.02);
      expect(Math.abs(s.correctionDb)).toBeLessThanOrEqual(LEVEL_CORRECTION_MAX_DB);
      onsetsMs.push(s.onsetSec * 1000);
    });
    console.log(
      `sample onsets: min ${Math.min(...onsetsMs).toFixed(2)} ms, max ${Math.max(...onsetsMs).toFixed(2)} ms (manifest: ${Math.min(...manifest.notes.map((n) => n.onsetMs))}..${Math.max(...manifest.notes.map((n) => n.onsetMs))} ms)`,
    );
    expect(set.samples[0].midi).toBe(PITCH_MIN);
    expect(set.samples[set.samples.length - 1].midi).toBe(PITCH_MAX);
  });

  it('maps every pitch of the range to a sample at most 1 semitone away', async () => {
    const set = await loadSamples();
    for (let pitch = PITCH_MIN; pitch <= PITCH_MAX; pitch++) {
      const { sample, semitones } = nearestSample(set, pitch);
      expect(Math.abs(semitones)).toBeLessThanOrEqual(MAX_SHIFT_IN_RANGE_SEMITONES);
      expect(sample.midi + semitones).toBe(pitch);
    }
    // Outside the range: edge sample, clamped shift.
    expect(nearestSample(set, PITCH_MIN - 5)).toMatchObject({ semitones: -5 });
    expect(nearestSample(set, PITCH_MIN - 5).sample.midi).toBe(PITCH_MIN);
    expect(nearestSample(set, PITCH_MAX + 30).semitones).toBe(MAX_SHIFT_SEMITONES);
    expect(nearestSample(set, PITCH_MAX + 30).sample.midi).toBe(PITCH_MAX);
  });

  it('smooths uneven neighbours by at most 4 dB and matches the documented table', () => {
    const notes = [...manifest.notes].sort((a, b) => a.midi - b.midi);
    const corr = computeLevelCorrections(notes);
    expect(LEVEL_CORRECTION_MAX_DB).toBe(4);
    const roughness = (levels: number[]): number => {
      let sum = 0;
      for (let i = 1; i < levels.length; i++) sum += Math.abs(levels[i] - levels[i - 1]);
      return sum / (levels.length - 1);
    };
    const before = notes.map((n) => n.rmsDb);
    const after = notes.map((n, i) => n.rmsDb + corr[i]);
    console.log(
      `level smoothing: mean neighbour step ${roughness(before).toFixed(2)} dB -> ${roughness(after).toFixed(2)} dB; corrections ${notes.map((n, i) => `${n.note} ${corr[i] >= 0 ? '+' : ''}${corr[i].toFixed(1)}`).join(', ')}`,
    );
    notes.forEach((n, i) => {
      expect(Math.abs(corr[i])).toBeLessThanOrEqual(LEVEL_CORRECTION_MAX_DB);
      expect(LEVEL_CORRECTION_TABLE_DB[n.note]).toBeDefined();
      expect(Math.abs(LEVEL_CORRECTION_TABLE_DB[n.note] - corr[i])).toBeLessThan(0.051);
    });
    expect(Object.keys(LEVEL_CORRECTION_TABLE_DB)).toHaveLength(notes.length);
    expect(roughness(after)).toBeLessThan(roughness(before) * 0.6);
  });

  it('detects the onset of a synthetic buffer', () => {
    const sr = SAMPLE_RATE;
    const left = new Float32Array(sr);
    const right = new Float32Array(sr);
    // Noise floor at -70 dB, tone from frame 480 on.
    for (let i = 0; i < sr; i++) {
      left[i] = 0.0003 * Math.sin(i * 0.37);
      right[i] = left[i];
      if (i >= 480) right[i] += 0.5 * Math.sin((i - 480) * 0.05) * Math.exp(-(i - 480) / 20000);
    }
    const frame = detectOnsetFrame([left, right], sr);
    expect(frame).toBeGreaterThanOrEqual(480);
    expect(frame).toBeLessThan(486);
    expect(detectOnsetFrame([new Float32Array(100)], sr)).toBe(0);
  });
});
