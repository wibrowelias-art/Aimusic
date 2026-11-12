import { describe, expect, it } from 'vitest';
import {
  AUDIO_TARGETS,
  checkAgainstTargets,
  formatMetricsRow,
  measureAudio,
  METRICS_TABLE_HEADER,
  tailSecAfter,
  type AudioMetrics,
} from '../../src/analysis';
import { add, amp, concat, decayFrom, hardClip, scale, sine, SR } from '../helpers/signals';

/** Numbers inside every target range. */
const IN_RANGE: AudioMetrics = {
  sampleRate: 48000,
  durationSec: 104.5,
  peakDb: -1.5,
  clippedSamples: 0,
  rmsDb: -24.3,
  crestDb: 22.8,
  dcOffset: 0.00001,
  silenceRatio: 0.12,
  silenceThresholdDb: -50,
  spectralCentroidHz: 640,
  tailSec: 5.35,
  tailThresholdDb: -60,
};

const with_ = (patch: Partial<AudioMetrics>): AudioMetrics => ({ ...IN_RANGE, ...patch });

describe('checkAgainstTargets', () => {
  it('passes numbers inside every range', () => {
    expect(checkAgainstTargets(IN_RANGE)).toEqual({ ok: true, failures: [] });
    expect(
      checkAgainstTargets(IN_RANGE, { pianoSilenceRatio: 0.4, rt60Sec: 4.4, requestedRt60Sec: 4.5 }),
    ).toEqual({ ok: true, failures: [] });
    // Fields that were not measured are not checked.
    expect(checkAgainstTargets(with_({ tailSec: null })).ok).toBe(true);
    expect(checkAgainstTargets(IN_RANGE, { requestedRt60Sec: 4.5 }).ok).toBe(true);
  });

  it('peak: must be strictly below -1 dBFS and not below -6 dBFS', () => {
    expect(AUDIO_TARGETS.peakDb).toEqual({ min: -6, max: -1 });
    expect(checkAgainstTargets(with_({ peakDb: -1.01 })).ok).toBe(true);
    expect(checkAgainstTargets(with_({ peakDb: -6 })).ok).toBe(true);
    for (const peakDb of [-1, -0.5, 0, 2, -6.01, -30, -Infinity, NaN]) {
      const result = checkAgainstTargets(with_({ peakDb }));
      expect(result.ok, String(peakDb)).toBe(false);
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]).toMatch(/^peak /);
    }
    expect(checkAgainstTargets(with_({ peakDb: -0.5 })).failures[0]).toBe(
      'peak -0.50 dBFS is outside -6 <= peak < -1 dBFS',
    );
  });

  it('clipping: any clipped sample fails', () => {
    const result = checkAgainstTargets(with_({ clippedSamples: 3 }));
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual(['3 clipped samples (|x| >= 0.999), must be 0']);
  });

  it('RMS, centroid and tail: inclusive ranges', () => {
    const cases: [Partial<AudioMetrics>, boolean, RegExp][] = [
      [{ rmsDb: AUDIO_TARGETS.rmsDb.min }, true, /RMS/],
      [{ rmsDb: AUDIO_TARGETS.rmsDb.max }, true, /RMS/],
      [{ rmsDb: AUDIO_TARGETS.rmsDb.min - 0.1 }, false, /^RMS -36\.10 dBFS is outside -36 \.\. -16 dBFS$/],
      [{ rmsDb: AUDIO_TARGETS.rmsDb.max + 0.1 }, false, /^RMS /],
      [{ rmsDb: -Infinity }, false, /^RMS -inf dBFS/],
      [{ spectralCentroidHz: AUDIO_TARGETS.centroidHz.min }, true, /centroid/],
      [{ spectralCentroidHz: AUDIO_TARGETS.centroidHz.max }, true, /centroid/],
      [{ spectralCentroidHz: 150 }, false, /^spectral centroid 150 Hz is outside 200 \.\. 1600 Hz$/],
      [{ spectralCentroidHz: 2400 }, false, /^spectral centroid 2400 Hz/],
      [{ spectralCentroidHz: 0 }, false, /^spectral centroid 0 Hz/],
      [{ tailSec: AUDIO_TARGETS.tailSec.min }, true, /tail/],
      [{ tailSec: AUDIO_TARGETS.tailSec.max }, true, /tail/],
      [{ tailSec: 0.4 }, true, /tail/],
      [{ tailSec: -0.1 }, false, /^tail -0\.10 s \(to -60 dBFS\) is outside 0 \.\. 14 s$/],
      [{ tailSec: 15 }, false, /^tail 15\.00 s/],
      [{ tailSec: NaN }, false, /^tail NaN s/],
      [{ dcOffset: NaN }, false, /^DC offset NaN/],
    ];
    for (const [patch, ok, message] of cases) {
      const result = checkAgainstTargets(with_(patch));
      expect(result.ok, JSON.stringify(patch)).toBe(ok);
      if (!ok) {
        expect(result.failures).toHaveLength(1);
        expect(result.failures[0]).toMatch(message);
      }
    }
  });

  it('tail: the piano + pad tail given as an extra is checked instead of the tail of the mix', () => {
    // Mix tail 16.55 s (noise bed), instruments 0.2 s: the instruments count.
    const mix = with_({ tailSec: 16.55 });
    expect(checkAgainstTargets(mix).ok).toBe(false);
    expect(checkAgainstTargets(mix, { tailSec: 0.2 }).ok).toBe(true);
    expect(checkAgainstTargets(with_({ tailSec: 0.2 }), { tailSec: 15.5 }).failures).toEqual([
      'tail 15.50 s (to -60 dBFS) is outside 0 .. 14 s',
    ]);
    expect(checkAgainstTargets(with_({ tailSec: null }), { tailSec: 20 }).ok).toBe(false);
  });

  it('ring-out after the last onset: only checked when given', () => {
    expect(AUDIO_TARGETS.ringOutSec).toEqual({ min: 3, max: 30 });
    expect(checkAgainstTargets(IN_RANGE, { ringOutSec: 3 }).ok).toBe(true);
    expect(checkAgainstTargets(IN_RANGE, { ringOutSec: 30 }).ok).toBe(true);
    expect(checkAgainstTargets(IN_RANGE, { ringOutSec: 1.2 }).failures).toEqual([
      'ring-out 1.20 s after the last onset is outside 3 .. 30 s',
    ]);
    expect(checkAgainstTargets(IN_RANGE, { ringOutSec: 31 }).ok).toBe(false);
    expect(checkAgainstTargets(IN_RANGE, { ringOutSec: NaN }).ok).toBe(false);
  });

  it('piano silence ratio: only checked when given', () => {
    expect(checkAgainstTargets(IN_RANGE, { pianoSilenceRatio: AUDIO_TARGETS.pianoSilenceRatio.max }).ok).toBe(true);
    expect(checkAgainstTargets(IN_RANGE, { pianoSilenceRatio: 0 }).ok).toBe(true);
    const result = checkAgainstTargets(IN_RANGE, { pianoSilenceRatio: 0.9 });
    expect(result.failures).toEqual(['piano silence ratio 0.900 is outside 0 .. 0.85']);
    expect(checkAgainstTargets(IN_RANGE, { pianoSilenceRatio: NaN }).ok).toBe(false);
    // The silence ratio of the mix itself has no target.
    expect(checkAgainstTargets(with_({ silenceRatio: 1 })).ok).toBe(true);
  });

  it('RT60: absolute bounds, and the tolerance against the requested size', () => {
    // Mid-band RT60: the 3..6 s knob range with 5 % measuring margin.
    expect(AUDIO_TARGETS.rt60Sec).toEqual({ min: 2.85, max: 6.3 });
    expect(checkAgainstTargets(IN_RANGE, { rt60Sec: 2.985 }).ok).toBe(true);
    expect(checkAgainstTargets(IN_RANGE, { rt60Sec: 6 }).ok).toBe(true);
    expect(checkAgainstTargets(IN_RANGE, { rt60Sec: 2.8 }).failures).toEqual(['RT60 2.80 s is outside 2.85 .. 6.3 s']);
    expect(checkAgainstTargets(IN_RANGE, { rt60Sec: 6.5 }).failures).toEqual(['RT60 6.50 s is outside 2.85 .. 6.3 s']);
    expect(checkAgainstTargets(IN_RANGE, { rt60Sec: 0 }).ok).toBe(false);
    expect(checkAgainstTargets(IN_RANGE, { rt60Sec: NaN }).ok).toBe(false);
    // 5 % tolerance around the request.
    expect(AUDIO_TARGETS.rt60Tolerance).toBe(0.05);
    expect(checkAgainstTargets(IN_RANGE, { rt60Sec: 4.8, requestedRt60Sec: 5 }).ok).toBe(true);
    expect(checkAgainstTargets(IN_RANGE, { rt60Sec: 5.2, requestedRt60Sec: 5 }).ok).toBe(true);
    expect(checkAgainstTargets(IN_RANGE, { rt60Sec: 4.6, requestedRt60Sec: 5 }).failures).toEqual([
      'RT60 4.60 s deviates 8.0 % from the requested 5.00 s (allowed 5 %)',
    ]);
    // Both rules can fail at once.
    expect(checkAgainstTargets(IN_RANGE, { rt60Sec: 2.3, requestedRt60Sec: 3 }).failures).toHaveLength(2);
  });

  it('broadband RT60: a ratio to the requested size, only checked when both are given', () => {
    expect(AUDIO_TARGETS.rt60BroadRatio).toEqual({ min: 0.85, max: 1.05 });
    expect(checkAgainstTargets(IN_RANGE, { rt60BroadSec: 4.21, requestedRt60Sec: 4.5 }).ok).toBe(true);
    expect(checkAgainstTargets(IN_RANGE, { rt60BroadSec: 1 }).ok).toBe(true);
    expect(checkAgainstTargets(IN_RANGE, { rt60BroadSec: 3.6, requestedRt60Sec: 4.5 }).failures).toEqual([
      'broadband RT60 3.60 s is 0.800 x the requested 4.50 s (allowed 0.85 .. 1.05)',
    ]);
    expect(checkAgainstTargets(IN_RANGE, { rt60BroadSec: 5, requestedRt60Sec: 4.5 }).ok).toBe(false);
  });

  it('reports every violated target, in a fixed order', () => {
    const bad = with_({ peakDb: 0, clippedSamples: 120, rmsDb: -10, spectralCentroidHz: 3000, tailSec: 20 });
    const result = checkAgainstTargets(bad, {
      pianoSilenceRatio: 0.95,
      rt60Sec: 8,
      requestedRt60Sec: 6,
      rt60BroadSec: 7,
      ringOutSec: 1,
    });
    expect(result.ok).toBe(false);
    expect(result.failures.map((f) => f.split(' ')[0])).toEqual([
      'peak',
      '120',
      'RMS',
      'spectral',
      'tail',
      'piano',
      'RT60',
      'RT60',
      'broadband',
      'ring-out',
    ]);
  });
});

describe('checkAgainstTargets on measured audio', () => {
  // Five decaying notes (300 + 600 Hz), then a quiet tail that falls 10 dB per second.
  const note = add(sine({ hz: 300, seconds: 2, amplitude: 0.6 }), sine({ hz: 600, seconds: 2, amplitude: 0.3 }));
  const notes = concat(...Array.from({ length: 5 }, () => decayFrom(note, 0, 40)));
  const tail = decayFrom(sine({ hz: 300, seconds: 6, amplitude: amp(-25) * Math.SQRT2 }), 0, 10);
  const raw = concat(notes, tail);
  const peak = raw.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  const passing = scale(raw, amp(-1.5) / peak);
  const musicEndSec = 10;

  it('a render built to meet the targets passes', () => {
    const m = measureAudio([passing, passing], SR, { musicEndSec });
    console.log(`[analysis] synthetic render: ${formatMetricsRow('in range', m)}`);
    expect(m.peakDb).toBeCloseTo(-1.5, 3);
    expect(m.clippedSamples).toBe(0);
    // Tail: about -26 dBFS falling 10 dB/s reaches -60 dBFS after about 3.4 s.
    expect(m.tailSec).toBeGreaterThan(3);
    expect(m.tailSec).toBeLessThan(4);
    expect(m.spectralCentroidHz).toBeGreaterThan(300);
    expect(m.spectralCentroidHz).toBeLessThan(400);
    expect(checkAgainstTargets(m, { pianoSilenceRatio: m.silenceRatio })).toEqual({ ok: true, failures: [] });
  });

  it('the same render overdriven, too low in level, with a high centroid or cut short fails with the reason', () => {
    const over = measureAudio([hardClip(scale(passing, 1.5), 1)], SR, { musicEndSec });
    const overCheck = checkAgainstTargets(over);
    expect(over.clippedSamples).toBeGreaterThan(0);
    expect(overCheck.failures.some((f) => f.startsWith('peak 0.00 dBFS'))).toBe(true);
    expect(overCheck.failures.some((f) => f.includes('clipped samples'))).toBe(true);

    const quiet = checkAgainstTargets(measureAudio([scale(passing, 0.05)], SR, { musicEndSec }));
    expect(quiet.failures.some((f) => f.startsWith('peak -27.5'))).toBe(true);
    expect(quiet.failures.some((f) => f.startsWith('RMS'))).toBe(true);

    const withHighTone = add(scale(passing, 0.8), sine({ hz: 9000, seconds: 16, amplitude: 0.1 }));
    const highCentroid = checkAgainstTargets(measureAudio([withHighTone], SR, { musicEndSec }));
    expect(highCentroid.failures.some((f) => f.startsWith('spectral centroid'))).toBe(true);

    // Cut 2.5 s after the last note starts (it starts at 8 s): the ring-out is too short.
    const cutSignal = passing.subarray(0, SR * 10.5);
    const cut = checkAgainstTargets(measureAudio([cutSignal], SR, { musicEndSec }), {
      ringOutSec: tailSecAfter([cutSignal], SR, 8),
    });
    expect(cut.failures).toEqual(['ring-out 2.50 s after the last onset is outside 3 .. 30 s']);

    const empty = checkAgainstTargets(measureAudio([], SR, { musicEndSec }), {
      pianoSilenceRatio: 1,
      ringOutSec: tailSecAfter([], SR, 8),
    });
    expect(empty.ok).toBe(false);
    expect(empty.failures.length).toBeGreaterThanOrEqual(5);
  });
});

describe('formatMetricsRow', () => {
  it('writes one markdown row that fits the header', () => {
    const row = formatMetricsRow('Warm, seed 42', IN_RANGE);
    expect(row).toBe('| Warm, seed 42 | 104.5 | -1.50 | -24.30 | 22.80 | 0 | 1.0e-5 | 0.120 | 640 | 5.35 |');
    const [head, rule] = METRICS_TABLE_HEADER.split('\n');
    const columns = (line: string): number => line.split('|').length - 2;
    expect(columns(row)).toBe(10);
    expect(columns(head)).toBe(10);
    expect(columns(rule)).toBe(10);
    expect(head).toBe(
      '| Take | Length s | Peak dBFS | RMS dBFS | Crest dB | Clipped | DC offset | Silence ratio (< -50 dBFS) | Centroid Hz | Tail s (to -60 dBFS) |',
    );
    expect(rule).toMatch(/^(\| --- )+\|$/);
  });

  it('marks what was not measured, silence, and thresholds other than the default', () => {
    const silent = measureAudio([new Float32Array(4800)], SR);
    expect(formatMetricsRow('silence', silent)).toBe('| silence | 0.1 | -inf | -inf | 0.00 | 0 | 0 | 1.000 | 0 | n/a |');
    const custom = with_({ silenceThresholdDb: -40, tailThresholdDb: -50, dcOffset: -0.0123, clippedSamples: 7 });
    expect(formatMetricsRow('custom', custom)).toBe(
      '| custom | 104.5 | -1.50 | -24.30 | 22.80 | 7 | -0.0123 | 0.120 (< -40 dBFS) | 640 | 5.35 (to -50 dBFS) |',
    );
    expect(formatMetricsRow('nan', with_({ rmsDb: NaN }))).toContain('| NaN |');
  });

  it('keeps the table intact whatever the label holds, and uses plain ASCII', () => {
    const row = formatMetricsRow('a | b\nc', IN_RANGE);
    expect(row.startsWith('| a / b c | ')).toBe(true);
    expect(row.split('|').length - 2).toBe(10);
    expect(row).not.toContain('\n');
    expect(/^[\x20-\x7e\n]*$/.test(METRICS_TABLE_HEADER + row)).toBe(true);
  });
});
