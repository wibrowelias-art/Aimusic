import { describe, expect, it } from 'vitest';
import { DAMPER_FREE_FROM_MIDI, DAMPER_TAU_SEC, RETRIGGER_TAU_SEC, SAMPLE_RATE } from '../../src/audio/constants';
import { planReleases, startPianoVoice } from '../../src/audio/graph';
import { rmsDb } from '../../src/analysis';
import type { PedalEvent } from '../../src/engine/types';
import { createContext, loadSamples } from '../fixtures/audio';

const SR = SAMPLE_RATE;

describe('planReleases', () => {
  const pedal: PedalEvent[] = [
    { time: 0, down: true },
    { time: 3.8, down: false },
    { time: 4, down: true },
    { time: 7.8, down: false },
  ];

  it('holds a note until the next pedal up when the pedal is down at key up', () => {
    const [plan] = planReleases([{ pitch: 60, time: 1, duration: 0.5 }], pedal, 8);
    expect(plan.releaseSec).toBe(3.8);
    expect(plan.tauSec).toBe(DAMPER_TAU_SEC);
  });

  it('releases at key up when the pedal is up, and at the later of key up / pedal up otherwise', () => {
    const plans = planReleases(
      [
        { pitch: 60, time: 3.7, duration: 0.2 }, // key up at 3.9, pedal up since 3.8
        { pitch: 62, time: 3.0, duration: 2.0 }, // key up at 5.0, pedal down again since 4.0
        { pitch: 64, time: 1.0, duration: 0.5 }, // no pedal at all (other list)
      ],
      pedal,
      8,
    );
    expect(plans[0].releaseSec).toBeCloseTo(3.9, 9);
    expect(plans[1].releaseSec).toBe(7.8);
    const [noPedal] = planReleases([{ pitch: 64, time: 1.0, duration: 0.5 }], [], 8);
    expect(noPedal.releaseSec).toBe(1.5);
  });

  it('damps a ringing voice quickly when the same pitch is struck again', () => {
    const plans = planReleases(
      [
        { pitch: 60, time: 1, duration: 0.5 },
        { pitch: 60, time: 2, duration: 0.5 },
      ],
      pedal,
      8,
    );
    expect(plans[0]).toEqual({ releaseSec: 2, tauSec: RETRIGGER_TAU_SEC });
    expect(plans[1]).toEqual({ releaseSec: 3.8, tauSec: DAMPER_TAU_SEC });
  });

  it('lets pitches without dampers ring', () => {
    const plans = planReleases(
      [
        { pitch: DAMPER_FREE_FROM_MIDI, time: 1, duration: 0.5 },
        { pitch: DAMPER_FREE_FROM_MIDI - 1, time: 1, duration: 0.5 },
      ],
      [],
      8,
    );
    expect(plans[0].releaseSec).toBe(Infinity);
    expect(plans[1].releaseSec).toBe(1.5);
    expect(DAMPER_FREE_FROM_MIDI).toBe(90); // F#6
  });

  it('never releases before key up and falls back to the end of the piece', () => {
    const [plan] = planReleases([{ pitch: 60, time: 1, duration: 0.5 }], [{ time: 0, down: true }], 6);
    expect(plan.releaseSec).toBe(6);
  });
});

describe('pedal sustain (rendered, dry voice, real C4 sample)', () => {
  const note = { pitch: 60, time: 0.1, duration: 0.3 };

  async function render(pedal: PedalEvent[]): Promise<Float32Array[]> {
    const samples = await loadSamples();
    const ctx = createContext(2, 5 * SR, SR);
    const [plan] = planReleases([note], pedal, 4.5);
    startPianoVoice(
      ctx,
      samples,
      { pitch: note.pitch, velocity: 64, startAt: note.time, releaseAt: plan.releaseSec, tauSec: plan.tauSec },
      ctx.destination,
    );
    const out = await ctx.startRendering();
    return [out.getChannelData(0), out.getChannelData(1)];
  }

  it('keeps a short note ringing under a held pedal and damps it without', async () => {
    const held = await render([
      { time: 0, down: true },
      { time: 4.5, down: false },
    ]);
    const damped = await render([]);
    const win = (x: Float32Array[], from: number, to: number): number => rmsDb(x, Math.round(from * SR), Math.round(to * SR));

    // While the key is down both are the same.
    expect(Math.abs(win(held, 0.15, 0.38) - win(damped, 0.15, 0.38))).toBeLessThan(0.05);

    // 2 s after the onset: the pedalled note still rings, the other one is gone.
    const heldDb = win(held, 2.1, 2.6);
    const dampedDb = win(damped, 2.1, 2.6);
    const bodyDb = win(held, 0.15, 0.38);
    // Expected attenuation by the damper alone at the middle of the window (1.95 s after key up).
    const expectedDropDb = (20 / Math.LN10) * ((2.35 - 0.4) / DAMPER_TAU_SEC);
    console.log(
      `pedal: body ${bodyDb.toFixed(1)} dBFS; 2.0-2.5 s after onset: held ${heldDb.toFixed(1)} dBFS, no pedal ${dampedDb.toFixed(1)} dBFS (drop ${(heldDb - dampedDb).toFixed(1)} dB, damper formula ${expectedDropDb.toFixed(1)} dB at the window centre); 0.5-0.75 s after key up: drop ${(win(held, 0.9, 1.15) - win(damped, 0.9, 1.15)).toFixed(1)} dB`,
    );
    expect(heldDb).toBeGreaterThan(bodyDb - 30); // the C4 sample itself falls ~24 dB in 2 s
    expect(heldDb).toBeGreaterThan(-60);
    expect(heldDb - dampedDb).toBeGreaterThan(35);
    expect(heldDb - dampedDb).toBeLessThan(expectedDropDb + 6);

    // The damped voice is stopped: digital silence after release + 9 tau.
    const silentFrom = Math.round((0.4 + DAMPER_TAU_SEC * 9 + 0.05) * SR);
    expect(damped[0].subarray(silentFrom).every((v) => v === 0)).toBe(true);
    // The held one is released at 4.5 s and fades.
    expect(win(held, 4.9, 5.0)).toBeLessThan(win(held, 4.3, 4.5) - 8);
  });
});
