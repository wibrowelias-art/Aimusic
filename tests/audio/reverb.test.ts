import { describe, expect, it } from 'vitest';
import { REVERB_PREDELAY_SEC, REVERB_REF_BAND_HZ, SAMPLE_RATE } from '../../src/audio/constants';
import { bandEnergyGain, buildReverbIR, reverbIRLength } from '../../src/audio/reverb';
import { AUDIO_TARGETS, measureRt60 } from '../../src/analysis';

const SR = SAMPLE_RATE;
const SIZES = [3, 4.5, 6];
const irs = new Map(SIZES.map((rt) => [rt, buildReverbIR(SR, rt)]));

const energy = (ch: Float32Array): number => ch.reduce((s, v) => s + v * v, 0);

describe('buildReverbIR', () => {
  it('is deterministic and has the documented length', () => {
    const a = buildReverbIR(SR, 4.5);
    const b = irs.get(4.5)!;
    expect(a[0].length).toBe(reverbIRLength(SR, 4.5));
    expect(a[1].length).toBe(a[0].length);
    expect(Buffer.from(a[0].buffer).equals(Buffer.from(b[0].buffer))).toBe(true);
    expect(Buffer.from(a[1].buffer).equals(Buffer.from(b[1].buffer))).toBe(true);
  });

  it.each(SIZES)('measured RT60 matches the request of %s s', (rt) => {
    const ir = irs.get(rt)!;
    const broad = measureRt60(ir, SR);
    const mid = measureRt60(ir, SR, { bandHz: REVERB_REF_BAND_HZ });
    const high = measureRt60(ir, SR, { bandHz: [4000, SR / 2] });
    console.log(
      `RT60 request ${rt} s: broadband T30 ${broad.toFixed(2)} s, ${REVERB_REF_BAND_HZ[0]}-${REVERB_REF_BAND_HZ[1]} Hz ${mid.toFixed(2)} s, above 4 kHz ${high.toFixed(2)} s`,
    );
    // The knob means the mid band; the damped highs pull the broadband figure below it.
    expect(Math.abs(mid - rt) / rt).toBeLessThan(Math.min(0.03, AUDIO_TARGETS.rt60Tolerance));
    expect(broad / rt).toBeGreaterThanOrEqual(AUDIO_TARGETS.rt60BroadRatio.min);
    expect(broad / rt).toBeLessThanOrEqual(AUDIO_TARGETS.rt60BroadRatio.max);
    // Damping: highs decay faster than mids.
    expect(high).toBeLessThan(mid * 0.85);
    expect(high).toBeGreaterThan(mid * 0.4);
  });

  it('has the same level for every size', () => {
    const totals: number[] = [];
    for (const rt of SIZES) {
      const ir = irs.get(rt)!;
      for (const ch of ir) {
        const refDb = 10 * Math.log10(bandEnergyGain(ch, SR, REVERB_REF_BAND_HZ[0], REVERB_REF_BAND_HZ[1]));
        expect(Math.abs(refDb)).toBeLessThan(0.01);
      }
      totals.push(10 * Math.log10(energy(ir[0]) + energy(ir[1])));
    }
    console.log(`IR total energy (L+R) for ${SIZES.join(' / ')} s: ${totals.map((v) => v.toFixed(2)).join(' / ')} dB`);
    expect(Math.max(...totals) - Math.min(...totals)).toBeLessThan(0.5);
  });

  it('has no DC and no rumble', () => {
    for (const rt of SIZES) {
      for (const ch of irs.get(rt)!) {
        const sum = ch.reduce((s, v) => s + v, 0);
        // |H(0)| relative to the reference band gain of 1.
        expect(Math.abs(sum)).toBeLessThan(1e-4);
        // |H(f)|^2 at single low frequencies (plain DFT), relative to the reference band gain of 0 dB.
        for (const hz of [20, 30, 40, 50, 60]) {
          let re = 0;
          let im = 0;
          const w = (2 * Math.PI * hz) / SR;
          for (let i = 0; i < ch.length; i++) {
            re += ch[i] * Math.cos(w * i);
            im -= ch[i] * Math.sin(w * i);
          }
          expect(10 * Math.log10(re * re + im * im)).toBeLessThan(-20);
        }
      }
    }
  });

  it('starts with a 20-35 ms pre-delay and ends at zero', () => {
    for (const rt of SIZES) {
      for (const ch of irs.get(rt)!) {
        const first = ch.findIndex((v) => v !== 0);
        expect(first / SR).toBeGreaterThanOrEqual(0.02);
        expect(first / SR).toBeLessThanOrEqual(0.035);
        expect(first).toBeGreaterThanOrEqual(Math.round(REVERB_PREDELAY_SEC * SR));
        expect(ch[ch.length - 1]).toBe(0);
        // Smooth fade: the last 5 ms are far below the peak.
        let peak = 0;
        let tail = 0;
        for (let i = 0; i < ch.length; i++) {
          const a = Math.abs(ch[i]);
          if (a > peak) peak = a;
          if (i >= ch.length - 240 && a > tail) tail = a;
        }
        expect(tail).toBeLessThan(peak * 1e-4);
        expect(ch.every((v) => Number.isFinite(v))).toBe(true);
      }
    }
  });

  it('is decorrelated between left and right', () => {
    for (const rt of SIZES) {
      const [l, r] = irs.get(rt)!;
      let dot = 0;
      for (let i = 0; i < l.length; i++) dot += l[i] * r[i];
      const corr = dot / Math.sqrt(energy(l) * energy(r));
      expect(Math.abs(corr)).toBeLessThan(0.1);
    }
  });
});
