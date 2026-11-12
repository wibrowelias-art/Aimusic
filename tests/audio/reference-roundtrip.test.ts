/**
 * The reference analyser on the lab's own audio: a rendered take with known settings is
 * read back. Tempo and note density must come back; the numbers are logged for TUNING.md.
 */
import { describe, expect, it } from 'vitest';
import { analyseReference, foldTempo } from '../../src/analysis/reference';
import { presetCase, renderCase } from '../helpers/render-case';

describe('reference analysis of a rendered take', () => {
  it('reads tempo and note density back, returns scalars only', async () => {
    const params = presetCase('warm', 35, { length: 45, reverbSize: 3, pad: 0, lofi: 0, density: 3, restProbability: 0.1, tempo: 66 });
    const c = await renderCase('reference', params);
    const traits = analyseReference(c.render.mix, c.render.sampleRate);
    const made = c.piece.notes.length / (c.render.length / c.render.sampleRate);
    console.log(
      `[reference] own render (tempo ${params.tempo}, ${made.toFixed(2)} notes/s, reverb ${params.reverbSize} s): read tempo ${traits.tempoBpm?.toFixed(1)} (confidence ${traits.tempoConfidence.toFixed(2)}), ${traits.onsetsPerSecond.toFixed(2)} onsets/s, key ${traits.keyPc} ${traits.mode} (confidence ${traits.keyConfidence.toFixed(2)}), centroid ${traits.brightnessHz.toFixed(0)} Hz, decay ${traits.decaySec === null ? 'not found' : `${traits.decaySec.toFixed(2)} s`}`,
    );
    expect(traits.tempoBpm).not.toBeNull();
    expect(Math.abs(foldTempo(traits.tempoBpm ?? 0) - params.tempo)).toBeLessThanOrEqual(2);
    // Notes struck together count once, so the reading may sit below the note count.
    expect(traits.onsetsPerSecond).toBeGreaterThan(made * 0.6);
    expect(traits.onsetsPerSecond).toBeLessThan(made * 1.2);
    expect(traits.brightnessHz).toBeGreaterThan(150);
    expect(traits.brightnessHz).toBeLessThan(1600);
    for (const value of Object.values(traits)) expect(typeof value === 'object' && value !== null).toBe(false);
  });
});
