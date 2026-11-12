import { describe, expect, it } from 'vitest';
import { HISS_RMS_DB_AT_FULL, NOISE_LOOP_SEC, RAIN_RMS_DB_AT_FULL, SAMPLE_RATE } from '../../src/audio/constants';
import { peakDb, rmsDb } from '../../src/audio/dsp';
import { buildNoiseLoop, hissRmsDb, rainRmsDb } from '../../src/audio/noise';

const SR = SAMPLE_RATE;

function same(a: Float32Array, b: Float32Array): boolean {
  return Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength));
}

/** How the step across the loop seam compares with ordinary sample-to-sample steps. */
function seamReport(ch: Float32Array): { seamStep: number; rmsStep: number; seamCurve: number; rmsCurve: number } {
  const n = ch.length;
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < n; i++) {
    const d1 = ch[(i + 1) % n] - ch[i];
    const d2 = ch[(i + 2) % n] - 2 * ch[(i + 1) % n] + ch[i];
    s1 += d1 * d1;
    s2 += d2 * d2;
  }
  return {
    seamStep: Math.abs(ch[0] - ch[n - 1]),
    rmsStep: Math.sqrt(s1 / n),
    seamCurve: Math.max(Math.abs(ch[1] - 2 * ch[0] + ch[n - 1]), Math.abs(ch[0] - 2 * ch[n - 1] + ch[n - 2])),
    rmsCurve: Math.sqrt(s2 / n),
  };
}

describe('buildNoiseLoop', () => {
  const full = buildNoiseLoop(SR, { lofi: 1, rain: 1, seed: 7 });

  it('is deterministic and depends on the seed', () => {
    const again = buildNoiseLoop(SR, { lofi: 1, rain: 1, seed: 7 });
    const other = buildNoiseLoop(SR, { lofi: 1, rain: 1, seed: 8 });
    expect(full[0].length).toBe(Math.round(NOISE_LOOP_SEC * SR));
    expect(full[1].length).toBe(full[0].length);
    expect(NOISE_LOOP_SEC).toBeGreaterThanOrEqual(20);
    expect(NOISE_LOOP_SEC).toBeLessThanOrEqual(30);
    expect(same(full[0], again[0]) && same(full[1], again[1])).toBe(true);
    expect(same(full[0], other[0])).toBe(false);
    expect(same(full[0], full[1])).toBe(false);
    expect(full[0].every((v) => Number.isFinite(v))).toBe(true);
  });

  it('is digital silence at lofi 0 and rain 0', () => {
    const silent = buildNoiseLoop(SR, { lofi: 0, rain: 0, seed: 7 });
    expect(silent[0].every((v) => v === 0)).toBe(true);
    expect(silent[1].every((v) => v === 0)).toBe(true);
  });

  it('scales the hiss with lofi', () => {
    const report: string[] = [];
    let previous = -Infinity;
    for (const lofi of [0.1, 0.25, 0.35, 0.5, 1]) {
      const loop = buildNoiseLoop(SR, { lofi, rain: 0, seed: 7 });
      const db = rmsDb(loop);
      report.push(`lofi ${lofi}: ${db.toFixed(2)} dBFS RMS, peak ${peakDb(loop).toFixed(2)}`);
      expect(db).toBeCloseTo(hissRmsDb(lofi), 1);
      expect(db).toBeGreaterThan(previous);
      previous = db;
    }
    console.log(`hiss: ${report.join(' | ')}`);
    expect(previous).toBeCloseTo(HISS_RMS_DB_AT_FULL, 1);
    expect(HISS_RMS_DB_AT_FULL).toBeCloseTo(-46, 0);
  });

  it('adds energy with rain', () => {
    const dry = buildNoiseLoop(SR, { lofi: 0.35, rain: 0, seed: 7 });
    const wet = buildNoiseLoop(SR, { lofi: 0.35, rain: 0.5, seed: 7 });
    const rainOnly = buildNoiseLoop(SR, { lofi: 0, rain: 1, seed: 7 });
    console.log(
      `rain: lofi 0.35 alone ${rmsDb(dry).toFixed(2)}, with rain 0.5 ${rmsDb(wet).toFixed(2)}, rain 1 alone ${rmsDb(rainOnly).toFixed(2)} dBFS RMS (peak ${peakDb(rainOnly).toFixed(2)}), all on ${rmsDb(full).toFixed(2)} (peak ${peakDb(full).toFixed(2)})`,
    );
    expect(rmsDb(wet)).toBeGreaterThan(rmsDb(dry) + 6);
    expect(rmsDb(rainOnly)).toBeCloseTo(rainRmsDb(1), 1);
    expect(rainRmsDb(1)).toBe(RAIN_RMS_DB_AT_FULL);
    // Droplets must not poke far out of the bed.
    expect(peakDb(full)).toBeLessThan(-12);
  });

  it('loops without a step at the seam', () => {
    const loops = [
      buildNoiseLoop(SR, { lofi: 1, rain: 0, seed: 7 }),
      buildNoiseLoop(SR, { lofi: 0, rain: 1, seed: 7 }),
      full,
    ];
    for (const loop of loops) {
      for (const ch of loop) {
        const r = seamReport(ch);
        expect(r.seamStep).toBeLessThan(4 * r.rmsStep);
        expect(r.seamCurve).toBeLessThan(5 * r.rmsCurve);
        // No level dip or bump around the seam: 50 ms across it vs the whole loop.
        const half = Math.round(0.025 * SR);
        const around = new Float32Array(2 * half);
        around.set(ch.subarray(ch.length - half), 0);
        around.set(ch.subarray(0, half), half);
        expect(Math.abs(rmsDb([around]) - rmsDb([ch]))).toBeLessThan(6);
      }
    }
  });
});
