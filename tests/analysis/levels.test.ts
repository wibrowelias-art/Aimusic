import { describe, expect, it } from 'vitest';
import {
  CLIP_LEVEL,
  frameRmsDb,
  fromDb,
  measureAudio,
  peakAbs,
  peakDb,
  powerToDb,
  rmsDb,
  silenceRatio,
  sumChannels,
  tailSecAfter,
  toDb,
} from '../../src/analysis/metrics';
import {
  add,
  amp,
  concat,
  dc,
  decayFrom,
  frames,
  gatedBursts,
  hardClip,
  makeRng,
  silence,
  sine,
  SR,
  whiteNoise,
} from '../helpers/signals';

const SINE_CREST_DB = 20 * Math.log10(Math.SQRT2); // 3.0103

describe('dB helpers', () => {
  it('converts amplitude and power', () => {
    expect(toDb(1)).toBe(0);
    expect(toDb(0.5)).toBeCloseTo(-6.0206, 4);
    expect(toDb(-0.1)).toBeCloseTo(-20, 12);
    expect(toDb(0)).toBe(-Infinity);
    expect(toDb(NaN)).toBeNaN();
    expect(fromDb(0)).toBe(1);
    expect(fromDb(-20)).toBeCloseTo(0.1, 12);
    expect(fromDb(-Infinity)).toBe(0);
    expect(powerToDb(0.01)).toBeCloseTo(-20, 12);
    expect(powerToDb(0)).toBe(-Infinity);
    for (const db of [-60, -12.3, 0, 6]) expect(toDb(fromDb(db))).toBeCloseTo(db, 10);
  });
});

describe('peakAbs, peakDb, rmsDb: levels of a stretch of samples', () => {
  it('agree with measureAudio over the whole signal', () => {
    const stereo = [whiteNoise({ seconds: 0.5, rmsDb: -20, seed: 31 }), sine({ hz: 300, seconds: 0.5, amplitude: 0.25 })];
    const m = measureAudio(stereo, SR);
    expect(peakDb(stereo)).toBe(m.peakDb);
    expect(rmsDb(stereo)).toBeCloseTo(m.rmsDb, 9);
    expect(toDb(peakAbs(stereo))).toBe(m.peakDb);
  });

  it('read only the samples inside [fromSample, toSample)', () => {
    const x = new Float32Array(1000);
    x.fill(0.5, 100, 200);
    x[150] = -0.8;
    x[600] = 0.1;
    expect(peakAbs([x])).toBeCloseTo(0.8, 6);
    expect(peakAbs([x], 151)).toBeCloseTo(0.5, 6);
    expect(peakAbs([x], 200)).toBeCloseTo(0.1, 6);
    expect(peakAbs([x], 200, 600)).toBe(0);
    expect(peakAbs([x], 600, 601)).toBeCloseTo(0.1, 6);
    expect(peakDb([x], 200, 600)).toBe(-Infinity);
    expect(rmsDb([x], 200, 600)).toBe(-Infinity);
    // 100 samples at 0.5 except one at 0.8, inside a window of 200 samples.
    const meanSquare = (99 * 0.25 + 0.64) / 200;
    expect(rmsDb([x], 50, 250)).toBeCloseTo(10 * Math.log10(meanSquare), 5);
    // Bounds outside the signal and fractional bounds are fine; an empty stretch is silence.
    expect(rmsDb([x], -50, 5000)).toBeCloseTo(rmsDb([x]), 12);
    expect(peakAbs([x], 149.2, 150.5)).toBeCloseTo(0.8, 6);
    expect(peakAbs([x], 300, 200)).toBe(0);
    expect(rmsDb([x], 300, 200)).toBe(-Infinity);
    expect(rmsDb([], 0, 10)).toBe(-Infinity);
    expect(peakAbs([])).toBe(0);
  });

  it('pool the channels and count a shorter channel only where it has samples', () => {
    const long = new Float32Array(200).fill(0.5);
    const short = new Float32Array(100).fill(0.5);
    expect(rmsDb([long, short])).toBeCloseTo(toDb(0.5), 6);
    expect(rmsDb([long, new Float32Array(200)])).toBeCloseTo(toDb(0.5) - 10 * Math.log10(2), 6);
    expect(peakDb([new Float32Array(10), short])).toBeCloseTo(toDb(0.5), 6);
  });

  it('do not hide a NaN sample', () => {
    const x = new Float32Array(100).fill(0.1);
    x[40] = NaN;
    expect(peakAbs([x])).toBeNaN();
    expect(peakDb([x])).toBeNaN();
    expect(rmsDb([x])).toBeNaN();
    expect(peakAbs([x], 41)).toBeCloseTo(0.1, 6);
    expect(rmsDb([x], 0, 40)).toBeCloseTo(-20, 5);
  });
});

describe('measureAudio: peak, RMS, crest', () => {
  it('full-scale sine: 0 dBFS peak, -3.01 dBFS RMS, 3.01 dB crest', () => {
    const x = sine({ hz: 1000, seconds: 1 });
    const m = measureAudio([x], SR);
    console.log(
      `[analysis] 0 dBFS sine: peak ${m.peakDb.toFixed(6)} dBFS, RMS ${m.rmsDb.toFixed(6)} dBFS, crest ${m.crestDb.toFixed(6)} dB`,
    );
    expect(m.sampleRate).toBe(SR);
    expect(m.durationSec).toBe(1);
    expect(m.peakDb).toBe(0);
    expect(m.rmsDb).toBeCloseTo(-SINE_CREST_DB, 6);
    expect(m.crestDb).toBeCloseTo(SINE_CREST_DB, 6);
    expect(Math.abs(m.dcOffset)).toBeLessThan(1e-9);
    // 1 kHz at 48 kHz: only the two samples on the crests of every period reach 0.999.
    expect(m.clippedSamples).toBe(2000);
  });

  it('-12 dBFS sine: -12 dBFS peak, -15.01 dBFS RMS, same crest', () => {
    const x = sine({ hz: 1000, seconds: 1, amplitude: amp(-12) });
    const m = measureAudio([x], SR);
    console.log(
      `[analysis] -12 dBFS sine: peak ${m.peakDb.toFixed(6)} dBFS, RMS ${m.rmsDb.toFixed(6)} dBFS, crest ${m.crestDb.toFixed(6)} dB`,
    );
    expect(m.peakDb).toBeCloseTo(-12, 5);
    expect(m.rmsDb).toBeCloseTo(-12 - SINE_CREST_DB, 5);
    expect(m.crestDb).toBeCloseTo(SINE_CREST_DB, 5);
    expect(m.clippedSamples).toBe(0);
  });

  it('square wave: crest 0 dB', () => {
    const x = Float32Array.from({ length: SR }, (_, i) => (i % 100 < 50 ? 0.5 : -0.5));
    const m = measureAudio([x], SR);
    expect(m.peakDb).toBeCloseTo(-6.0206, 4);
    expect(m.rmsDb).toBeCloseTo(-6.0206, 4);
    expect(m.crestDb).toBeCloseTo(0, 9);
  });

  it('stereo: peak is the maximum over the channels, RMS is taken over both', () => {
    const left = sine({ hz: 1000, seconds: 1, amplitude: 0.5 });
    const right = sine({ hz: 1000, seconds: 1, amplitude: 0.125 });
    const m = measureAudio([left, right], SR);
    expect(m.peakDb).toBeCloseTo(toDb(0.5), 6);
    const expectedPower = (0.5 ** 2 / 2 + 0.125 ** 2 / 2) / 2;
    expect(m.rmsDb).toBeCloseTo(powerToDb(expectedPower), 6);
    // One silent channel halves the power: -3.01 dB against the mono figure.
    const half = measureAudio([left, silence(1)], SR);
    expect(half.rmsDb).toBeCloseTo(measureAudio([left], SR).rmsDb - SINE_CREST_DB, 6);
    expect(half.durationSec).toBe(1);
  });

  it('white noise at -20 dBFS RMS reads -20 dBFS', () => {
    const m = measureAudio([whiteNoise({ seconds: 4, rmsDb: -20, seed: 11 })], SR);
    expect(m.rmsDb).toBeCloseTo(-20, 1);
    expect(m.crestDb).toBeGreaterThan(10);
    expect(m.crestDb).toBeLessThan(16);
  });
});

describe('measureAudio: DC offset', () => {
  it('reads a constant as its value', () => {
    const m = measureAudio([dc(0.25, 0.5)], SR);
    expect(m.dcOffset).toBeCloseTo(0.25, 9);
    expect(m.rmsDb).toBeCloseTo(toDb(0.25), 6);
    expect(m.crestDb).toBeCloseTo(0, 6);
  });

  it('finds a small offset under a sine and averages over the channels', () => {
    const tone = sine({ hz: 440, seconds: 1, amplitude: 0.5 });
    const m = measureAudio([add(tone, dc(0.01, 1))], SR);
    console.log(`[analysis] DC: constructed 0.010000, measured ${m.dcOffset.toFixed(6)}`);
    expect(m.dcOffset).toBeCloseTo(0.01, 6);
    expect(Math.abs(measureAudio([tone], SR).dcOffset)).toBeLessThan(1e-7);
    expect(measureAudio([dc(0.1, 1), dc(-0.1, 1)], SR).dcOffset).toBeCloseTo(0, 9);
    expect(measureAudio([dc(0.3, 1), dc(0.1, 1)], SR).dcOffset).toBeCloseTo(0.2, 7);
  });
});

describe('measureAudio: clipping', () => {
  it('counts exactly the samples that were set to full scale', () => {
    const x = whiteNoise({ seconds: 2, rmsDb: -30, seed: 3 });
    const rng = makeRng(99);
    const hit = new Set<number>();
    while (hit.size < 37) hit.add(Math.floor(rng.uniform(0, x.length)));
    let sign = 1;
    for (const i of hit) {
      x[i] = sign;
      sign = -sign;
    }
    const m = measureAudio([x], SR);
    expect(m.clippedSamples).toBe(37);
    expect(m.peakDb).toBe(0);
  });

  it('counts a hard-clipped sine like a sample-by-sample count does, summed over the channels', () => {
    const clipped = hardClip(sine({ hz: 997, seconds: 1, amplitude: 1.5 }), 1);
    let expected = 0;
    for (const v of clipped) if (Math.abs(v) >= CLIP_LEVEL) expected++;
    // |1.5 sin| >= 0.999 holds for the share 1 - (2 / pi) asin(0.999 / 1.5) of all phases.
    const analytic = clipped.length * (1 - (2 / Math.PI) * Math.asin(CLIP_LEVEL / 1.5));
    expect(Math.abs(expected - analytic)).toBeLessThanOrEqual(4);
    expect(measureAudio([clipped], SR).clippedSamples).toBe(expected);
    expect(measureAudio([clipped, clipped], SR).clippedSamples).toBe(2 * expected);
    console.log(`[analysis] clipping: 1.5x sine clipped at 1.0, constructed ${expected} samples, counted ${measureAudio([clipped], SR).clippedSamples}`);
  });

  it('uses 0.999 as the limit', () => {
    expect(CLIP_LEVEL).toBe(0.999);
    const x = new Float32Array(1000);
    x[10] = 0.9989;
    x[20] = -0.9989;
    expect(measureAudio([x], SR).clippedSamples).toBe(0);
    x[30] = 0.999;
    x[40] = -0.9995;
    x[50] = 1;
    x[60] = -1.2;
    expect(measureAudio([x], SR).clippedSamples).toBe(4);
    // A mix normalised to -1.5 dBFS is nowhere near the limit.
    expect(measureAudio([sine({ hz: 440, seconds: 1, amplitude: amp(-1.5) })], SR).clippedSamples).toBe(0);
  });
});

describe('silence ratio and frame levels', () => {
  // 10 x [0.3 s tone, 0.7 s quiet]: 6 loud and 14 quiet 50 ms frames per second.
  const bursts = gatedBursts({ onSec: 0.3, offSec: 0.7, repeats: 10, amplitude: 0.5 });

  it('gated bursts: 70 % of the frames are silent, as constructed', () => {
    const m = measureAudio([bursts], SR);
    console.log(`[analysis] silence ratio: constructed 0.700, measured ${m.silenceRatio.toFixed(4)}`);
    expect(m.silenceRatio).toBeCloseTo(0.7, 12);
    expect(m.silenceThresholdDb).toBe(-50);
    expect(silenceRatio([bursts], SR)).toBe(m.silenceRatio);
    // Other duty cycles.
    for (const [on, off] of [
      [0.1, 0.1],
      [0.05, 0.95],
      [0.5, 0],
    ]) {
      const x = gatedBursts({ onSec: on, offSec: off, repeats: 4 });
      expect(measureAudio([x], SR).silenceRatio).toBeCloseTo(off / (on + off), 12);
    }
  });

  it('the threshold decides what counts as silent', () => {
    // Quiet stretches at -45 dBFS RMS: above the default -50, below -40.
    const quiet = gatedBursts({ onSec: 0.3, offSec: 0.7, repeats: 10, amplitude: 0.5, offAmplitude: amp(-45) * Math.SQRT2 });
    expect(measureAudio([quiet], SR).silenceRatio).toBe(0);
    const strict = measureAudio([quiet], SR, { silenceThresholdDb: -40 });
    expect(strict.silenceRatio).toBeCloseTo(0.7, 12);
    expect(strict.silenceThresholdDb).toBe(-40);
    // Quiet stretches at -55 dBFS RMS count as silent with the default threshold.
    const quieter = gatedBursts({ onSec: 0.3, offSec: 0.7, repeats: 10, amplitude: 0.5, offAmplitude: amp(-55) * Math.SQRT2 });
    expect(measureAudio([quieter], SR).silenceRatio).toBeCloseTo(0.7, 12);
  });

  it('a stereo frame is silent only when both channels are', () => {
    const other = gatedBursts({ onSec: 0.6, offSec: 0.4, repeats: 10, amplitude: 0.5 });
    expect(measureAudio([bursts, other], SR).silenceRatio).toBeCloseTo(0.4, 12);
    expect(measureAudio([bursts, silence(10)], SR).silenceRatio).toBeCloseTo(0.7, 12);
  });

  it('frameRmsDb gives the level of every frame', () => {
    const levels = frameRmsDb([bursts], SR, 50);
    expect(levels).toBeInstanceOf(Float32Array);
    expect(levels.length).toBe(200);
    const loud = toDb(0.5 / Math.SQRT2);
    for (let f = 0; f < levels.length; f++) {
      if (f % 20 < 6) expect(levels[f]).toBeCloseTo(loud, 2);
      else expect(levels[f]).toBe(-Infinity);
    }
    // Other frame lengths; the last frame may be shorter.
    expect(frameRmsDb([bursts], SR, 10).length).toBe(1000);
    const odd = frameRmsDb([sine({ hz: 1000, seconds: 0.125, amplitude: 0.5 })], SR, 50);
    expect(odd.length).toBe(3);
    expect(odd[2]).toBeCloseTo(loud, 2);
    expect(frameRmsDb([bursts], SR).length).toBe(200);
    expect(() => frameRmsDb([bursts], SR, 0)).toThrow(RangeError);
  });

  it('the frame length is an option of measureAudio', () => {
    // 20 ms on / 20 ms off: every 50 ms frame holds some tone, 20 ms frames separate them.
    const fast = gatedBursts({ onSec: 0.02, offSec: 0.02, repeats: 50 });
    expect(measureAudio([fast], SR).silenceRatio).toBe(0);
    expect(measureAudio([fast], SR, { frameMs: 20 }).silenceRatio).toBeCloseTo(0.5, 12);
  });
});

describe('tail length', () => {
  // Tone at -20 dBFS RMS for 2 s, then the level falls by 20 dB per second for 4 s.
  const musicEnd = 2;
  const level = amp(-20) * Math.SQRT2;
  const signal = decayFrom(sine({ hz: 440, seconds: 6, amplitude: level }), musicEnd, 20);

  it('reads the constructed tail: -20 dBFS falling 20 dB/s reaches -60 dBFS after 2 s', () => {
    const m = measureAudio([signal], SR, { musicEndSec: musicEnd });
    console.log(`[analysis] tail: constructed 2.000 s to -60 dBFS, measured ${m.tailSec?.toFixed(3)} s`);
    expect(m.tailThresholdDb).toBe(-60);
    expect(m.tailSec).not.toBeNull();
    expect(Math.abs(m.tailSec! - 2)).toBeLessThanOrEqual(0.05);
    expect(tailSecAfter([signal], SR, musicEnd)).toBe(m.tailSec);
  });

  it('follows the threshold', () => {
    for (const [threshold, expected] of [
      [-40, 1],
      [-50, 1.5],
      [-70, 2.5],
      [-80, 3],
    ]) {
      const m = measureAudio([signal], SR, { musicEndSec: musicEnd, tailThresholdDb: threshold });
      expect(m.tailThresholdDb).toBe(threshold);
      expect(Math.abs(m.tailSec! - expected)).toBeLessThanOrEqual(0.05);
    }
  });

  it('does not depend on where the music end falls relative to the file start', () => {
    const shifted = concat(silence(0.0173), signal);
    const m = measureAudio([shifted], SR, { musicEndSec: musicEnd + 0.0173 });
    expect(Math.abs(m.tailSec! - 2)).toBeLessThanOrEqual(0.05);
    const stereo = measureAudio([signal, signal], SR, { musicEndSec: musicEnd });
    expect(Math.abs(stereo.tailSec! - 2)).toBeLessThanOrEqual(0.05);
  });

  it('is null without musicEndSec and 0 when the level is already below the threshold', () => {
    expect(measureAudio([signal], SR).tailSec).toBeNull();
    const abrupt = concat(sine({ hz: 440, seconds: 1, amplitude: 0.3 }), silence(2));
    expect(measureAudio([abrupt], SR, { musicEndSec: 1 }).tailSec).toBe(0);
    expect(measureAudio([signal], SR, { musicEndSec: 60 }).tailSec).toBe(0);
    expect(measureAudio([signal], SR, { musicEndSec: 5.5 }).tailSec).toBe(0);
  });

  it('"for good": a late burst extends the tail to its end', () => {
    // Silence after the music end, then a burst from 3.0 to 3.2 s after it.
    const late = concat(
      sine({ hz: 440, seconds: 1, amplitude: 0.3 }),
      silence(3),
      sine({ hz: 440, seconds: 0.2, amplitude: 0.01 }),
      silence(1),
    );
    expect(measureAudio([late], SR, { musicEndSec: 1 }).tailSec).toBeCloseTo(3.2, 6);
  });

  it('a file that ends above the threshold gives the whole remainder', () => {
    const cut = signal.subarray(0, frames(3.03)); // 1.03 s after the music end, still at about -40 dBFS
    expect(measureAudio([cut], SR, { musicEndSec: musicEnd }).tailSec).toBeCloseTo(1.03, 6);
  });
});

describe('empty, short and broken input', () => {
  it('measures an empty signal as silence without throwing', () => {
    for (const channels of [[], [new Float32Array(0)], [new Float32Array(0), new Float32Array(0)]]) {
      const m = measureAudio(channels, SR, { musicEndSec: 1 });
      expect(m.durationSec).toBe(0);
      expect(m.peakDb).toBe(-Infinity);
      expect(m.rmsDb).toBe(-Infinity);
      expect(m.crestDb).toBe(0);
      expect(m.clippedSamples).toBe(0);
      expect(m.dcOffset).toBe(0);
      expect(m.silenceRatio).toBe(1);
      expect(m.spectralCentroidHz).toBe(0);
      expect(m.tailSec).toBe(0);
      expect(frameRmsDb(channels, SR, 50).length).toBe(0);
    }
  });

  it('measures digital silence as silence', () => {
    const m = measureAudio([silence(1), silence(1)], SR, { musicEndSec: 0.5 });
    expect(m.peakDb).toBe(-Infinity);
    expect(m.rmsDb).toBe(-Infinity);
    expect(m.crestDb).toBe(0);
    expect(m.silenceRatio).toBe(1);
    expect(m.spectralCentroidHz).toBe(0);
    expect(m.tailSec).toBe(0);
  });

  it('handles signals shorter than one frame or one FFT window', () => {
    for (const n of [1, 2, 7, 100, 2399, 2401, 4095, 4097]) {
      const x = sine({ hz: 1000, seconds: n / SR, amplitude: 0.5 });
      expect(x.length).toBe(n);
      const m = measureAudio([x], SR, { musicEndSec: 0 });
      expect(m.durationSec).toBeCloseTo(n / SR, 12);
      expect(Number.isFinite(m.rmsDb) || n === 1).toBe(true);
      expect(Number.isFinite(m.spectralCentroidHz)).toBe(true);
      expect(m.silenceRatio).toBeGreaterThanOrEqual(0);
      expect(m.silenceRatio).toBeLessThanOrEqual(1);
      expect(m.tailSec).toBeGreaterThanOrEqual(0);
      expect(frameRmsDb([x], SR, 50).length).toBe(Math.ceil(n / 2400));
    }
  });

  it('treats a shorter channel as zero-padded', () => {
    const long = sine({ hz: 1000, seconds: 1, amplitude: 0.5 });
    const short = long.subarray(0, SR / 2);
    const m = measureAudio([long, short], SR);
    expect(m.durationSec).toBe(1);
    expect(m.rmsDb).toBeCloseTo(powerToDb((0.125 + 0.0625) / 2), 5);
  });

  it('a NaN sample makes the levels NaN instead of hiding', () => {
    const x = sine({ hz: 1000, seconds: 0.5, amplitude: 0.5 });
    x[1234] = NaN;
    const m = measureAudio([x], SR);
    expect(m.peakDb).toBeNaN();
    expect(m.rmsDb).toBeNaN();
  });

  it('rejects a sample rate that is not a positive number', () => {
    for (const bad of [0, -48000, NaN, Infinity]) {
      expect(() => measureAudio([silence(0.1)], bad)).toThrow(RangeError);
      expect(() => frameRmsDb([silence(0.1)], bad, 50)).toThrow(RangeError);
    }
  });

  it('works at other sample rates', () => {
    const x = sine({ hz: 1000, seconds: 1, amplitude: 0.5, sampleRate: 44100 });
    const m = measureAudio([x], 44100);
    expect(m.sampleRate).toBe(44100);
    expect(m.durationSec).toBe(1);
    expect(m.peakDb).toBeCloseTo(toDb(0.5), 3);
    expect(m.spectralCentroidHz).toBeCloseTo(1000, 0);
    expect(frameRmsDb([x], 44100, 50).length).toBe(20);
  });
});

describe('sumChannels', () => {
  it('adds stems sample by sample', () => {
    const a = [Float32Array.from([1, 2, 3]), Float32Array.from([4, 5, 6])];
    const b = [Float32Array.from([10, 20]), Float32Array.from([40, 50, 60, 70])];
    const sum = sumChannels(a, b);
    expect(sum.length).toBe(2);
    expect(Array.from(sum[0])).toEqual([11, 22, 3, 0]);
    expect(Array.from(sum[1])).toEqual([44, 55, 66, 70]);
    expect(sumChannels().length).toBe(0);
    // Mono plus stereo: the missing channel counts as silence.
    expect(Array.from(sumChannels([Float32Array.from([1])], a)[1])).toEqual([4, 5, 6]);
  });
});
