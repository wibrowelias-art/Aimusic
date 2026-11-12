import { describe, expect, it } from 'vitest';
import {
  binToHz,
  fftInPlace,
  hannWindow,
  hzToBin,
  isPowerOfTwo,
  magnitudeSpectrum,
  nextPowerOfTwo,
  RealFft,
  realFft,
} from '../../src/analysis/fft';
import { makeRng, naiveDft, sine, SR } from '../helpers/signals';

function randomVector(n: number, seed: number): Float64Array {
  const rng = makeRng(seed);
  return Float64Array.from({ length: n }, () => rng.gaussian());
}

describe('sizes', () => {
  it('recognises powers of two', () => {
    for (const n of [1, 2, 4, 1024, 65536]) expect(isPowerOfTwo(n)).toBe(true);
    for (const n of [0, 3, 6, 1000, 2.5, -4, NaN, Infinity]) expect(isPowerOfTwo(n)).toBe(false);
    expect(nextPowerOfTwo(0)).toBe(1);
    expect(nextPowerOfTwo(1)).toBe(1);
    expect(nextPowerOfTwo(5)).toBe(8);
    expect(nextPowerOfTwo(1024)).toBe(1024);
    expect(nextPowerOfTwo(1025)).toBe(2048);
  });

  it('converts between bins and Hz', () => {
    expect(binToHz(128, 4096, SR)).toBe(1500);
    expect(hzToBin(1500, 4096, SR)).toBe(128);
    expect(hzToBin(1505, 4096, SR)).toBe(128);
    expect(binToHz(2048, 4096, SR)).toBe(SR / 2);
  });

  it('rejects sizes that are not a power of two', () => {
    expect(() => fftInPlace(new Float64Array(3), new Float64Array(3))).toThrow(RangeError);
    expect(() => fftInPlace(new Float64Array(8), new Float64Array(4))).toThrow(RangeError);
    expect(() => new RealFft(1000)).toThrow(RangeError);
    expect(() => realFft(new Float64Array(10), 8)).toThrow(RangeError);
    expect(() => realFft(new Float64Array(10), 12)).toThrow(RangeError);
    expect(() => new RealFft(8).forward(new Float64Array(4), new Float64Array(5), new Float64Array(5))).toThrow(RangeError);
    expect(() => magnitudeSpectrum(new Float64Array(10), { size: 8 })).toThrow(RangeError);
  });
});

describe('fftInPlace', () => {
  it('matches the plain DFT for complex input', () => {
    let worst = 0;
    for (const n of [1, 2, 4, 8, 16, 32, 64, 128, 256]) {
      const xr = randomVector(n, 100 + n);
      const xi = randomVector(n, 200 + n);
      const ref = naiveDft(xr, xi);
      const re = Float64Array.from(xr);
      const im = Float64Array.from(xi);
      fftInPlace(re, im);
      for (let k = 0; k < n; k++) worst = Math.max(worst, Math.hypot(re[k] - ref.re[k], im[k] - ref.im[k]));
    }
    console.log(`[analysis] complex FFT vs plain DFT, sizes 1..256: max |error| ${worst.toExponential(2)}`);
    expect(worst).toBeLessThan(1e-11);
  });

  it('inverse undoes forward', () => {
    for (const n of [1, 2, 8, 64, 1024, 8192]) {
      const xr = randomVector(n, 300 + n);
      const xi = randomVector(n, 400 + n);
      const re = Float64Array.from(xr);
      const im = Float64Array.from(xi);
      fftInPlace(re, im);
      fftInPlace(re, im, true);
      let worst = 0;
      for (let k = 0; k < n; k++) worst = Math.max(worst, Math.hypot(re[k] - xr[k], im[k] - xi[k]));
      expect(worst).toBeLessThan(1e-12);
    }
  });

  it('keeps the energy (Parseval)', () => {
    const n = 4096;
    const xr = randomVector(n, 5);
    const re = Float64Array.from(xr);
    const im = new Float64Array(n);
    fftInPlace(re, im);
    let time = 0;
    let freq = 0;
    for (let i = 0; i < n; i++) {
      time += xr[i] * xr[i];
      freq += re[i] * re[i] + im[i] * im[i];
    }
    expect(freq / n / time).toBeCloseTo(1, 12);
  });

  it('transforms simple signals as the textbook says', () => {
    const n = 64;
    // Unit impulse at sample 3: magnitude 1 everywhere, phase -2 pi k 3 / n.
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    re[3] = 1;
    fftInPlace(re, im);
    for (let k = 0; k < n; k++) {
      expect(re[k]).toBeCloseTo(Math.cos((2 * Math.PI * k * 3) / n), 12);
      expect(im[k]).toBeCloseTo(-Math.sin((2 * Math.PI * k * 3) / n), 12);
    }
    // Constant 1: everything in bin 0.
    re.fill(1);
    im.fill(0);
    fftInPlace(re, im);
    expect(re[0]).toBeCloseTo(n, 12);
    for (let k = 1; k < n; k++) expect(Math.hypot(re[k], im[k])).toBeLessThan(1e-12);
    // cos on bin 5: n / 2 in bins 5 and n - 5.
    for (let i = 0; i < n; i++) {
      re[i] = Math.cos((2 * Math.PI * 5 * i) / n);
      im[i] = 0;
    }
    fftInPlace(re, im);
    for (let k = 0; k < n; k++) {
      expect(re[k]).toBeCloseTo(k === 5 || k === n - 5 ? n / 2 : 0, 11);
      expect(im[k]).toBeCloseTo(0, 11);
    }
  });
});

describe('realFft', () => {
  it('matches the plain DFT for real input', () => {
    let worst = 0;
    for (const n of [1, 2, 4, 8, 16, 32, 128, 1024]) {
      const x = randomVector(n, 500 + n);
      const ref = naiveDft(x);
      const { re, im } = realFft(x);
      expect(re.length).toBe(Math.floor(n / 2) + 1);
      for (let k = 0; k <= n / 2; k++) worst = Math.max(worst, Math.hypot(re[k] - ref.re[k], im[k] - ref.im[k]));
    }
    console.log(`[analysis] real FFT vs plain DFT, sizes 1..1024: max |error| ${worst.toExponential(2)}`);
    expect(worst).toBeLessThan(1e-10);
  });

  it('zero-pads short input', () => {
    const x = randomVector(100, 6);
    const padded = new Float64Array(128);
    padded.set(x);
    const ref = naiveDft(padded);
    const { re, im } = realFft(x, 128);
    for (let k = 0; k <= 64; k++) {
      expect(re[k]).toBeCloseTo(ref.re[k], 10);
      expect(im[k]).toBeCloseTo(ref.im[k], 10);
    }
    expect(realFft(new Float64Array(0)).re.length).toBe(1);
    expect(realFft(x).re.length).toBe(65);
  });

  it('accepts Float32Array input and a reused RealFft keeps no state between frames', () => {
    const a = Float32Array.from(randomVector(256, 7));
    const b = Float32Array.from(randomVector(256, 8));
    const fft = new RealFft(256);
    const re1 = new Float64Array(129);
    const im1 = new Float64Array(129);
    fft.forward(a, re1, im1);
    fft.forward(b, re1, im1);
    const fresh = realFft(b);
    expect(Array.from(re1)).toEqual(Array.from(fresh.re));
    expect(Array.from(im1)).toEqual(Array.from(fresh.im));
    // The input frame is left alone.
    expect(Array.from(b)).toEqual(Array.from(Float32Array.from(randomVector(256, 8))));
  });
});

describe('hannWindow', () => {
  it('periodic form: 0 at the start, 1 in the middle, sum N / 2, sum of squares 3 N / 8', () => {
    const n = 1024;
    const w = hannWindow(n);
    expect(w[0]).toBe(0);
    expect(w[n / 2]).toBe(1);
    expect(w[1]).toBeCloseTo(w[n - 1], 15);
    expect(w.reduce((s, v) => s + v, 0)).toBeCloseTo(n / 2, 9);
    expect(w.reduce((s, v) => s + v * v, 0)).toBeCloseTo((3 * n) / 8, 9);
  });

  it('symmetric form has zeros at both ends', () => {
    const w = hannWindow(101, false);
    expect(w[0]).toBe(0);
    expect(w[100]).toBeCloseTo(0, 15);
    expect(w[50]).toBeCloseTo(1, 15);
    for (let i = 0; i < 50; i++) expect(w[i]).toBeCloseTo(w[100 - i], 14);
  });

  it('overlaps to a constant: windows at hop N / 2, squared windows at hop N / 4', () => {
    const n = 256;
    const w = hannWindow(n);
    for (let i = 0; i < n / 2; i++) expect(w[i] + w[i + n / 2]).toBeCloseTo(1, 14);
    for (let i = 0; i < n / 4; i++) {
      let sq = 0;
      for (let m = 0; m < 4; m++) sq += w[i + (m * n) / 4] ** 2;
      expect(sq).toBeCloseTo(1.5, 14);
    }
  });

  it('handles tiny lengths', () => {
    expect(hannWindow(0).length).toBe(0);
    expect(Array.from(hannWindow(1))).toEqual([1]);
    expect(Array.from(hannWindow(2))).toEqual([0, 1]);
  });
});

describe('magnitudeSpectrum', () => {
  const frame = sine({ hz: 1500, seconds: 4096 / SR, amplitude: 0.25 }); // exactly bin 128

  it('reads the amplitude of a sine that sits on a bin', () => {
    const mag = magnitudeSpectrum(frame);
    expect(mag.length).toBe(2049);
    expect(mag[128]).toBeCloseTo(0.25, 6);
    // Hann window: the two neighbours read half the amplitude, the rest nothing.
    expect(mag[127]).toBeCloseTo(0.125, 6);
    expect(mag[129]).toBeCloseTo(0.125, 6);
    expect(mag[126]).toBeLessThan(1e-6);
    expect(mag[130]).toBeLessThan(1e-6);
    expect(mag[1000]).toBeLessThan(1e-6);
  });

  it('without a window all other bins are empty', () => {
    const mag = magnitudeSpectrum(frame, { window: 'none' });
    expect(mag[128]).toBeCloseTo(0.25, 6);
    let other = 0;
    for (let k = 0; k < mag.length; k++) if (k !== 128) other = Math.max(other, mag[k]);
    expect(other).toBeLessThan(1e-7);
  });

  it("'raw' is the plain FFT magnitude", () => {
    const mag = magnitudeSpectrum(frame, { window: 'none', scale: 'raw' });
    expect(mag[128]).toBeCloseTo((0.25 * 4096) / 2, 2);
  });

  it('reads DC without doubling and stays within the Hann scalloping loss between bins', () => {
    expect(magnitudeSpectrum(new Float32Array(1024).fill(0.3))[0]).toBeCloseTo(0.3, 6);
    // Half way between bins 128 and 129 the Hann window reads 0.8488 of the amplitude (-1.42 dB).
    const between = sine({ hz: (128.5 * SR) / 4096, seconds: 4096 / SR, amplitude: 0.25 });
    const mag = magnitudeSpectrum(between);
    expect(mag[128] / 0.25).toBeCloseTo(0.8488, 3);
    expect(mag[129] / 0.25).toBeCloseTo(0.8488, 3);
  });

  it('zero-pads a short frame and handles an empty one', () => {
    const mag = magnitudeSpectrum(sine({ hz: 3000, seconds: 0.01, amplitude: 0.5 }), { size: 2048 });
    expect(mag.length).toBe(1025);
    let peak = 0;
    for (let k = 1; k < mag.length; k++) if (mag[k] > mag[peak]) peak = k;
    expect(binToHz(peak, 2048, SR)).toBeCloseTo(3000, -2);
    expect(mag[peak]).toBeCloseTo(0.5, 2);
    expect(Array.from(magnitudeSpectrum(new Float32Array(0)))).toEqual([0]);
  });
});
