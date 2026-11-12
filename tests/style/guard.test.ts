import { describe, expect, it } from 'vitest';
import { checkDescriptors } from '../../src/style/guard';

describe('descriptor guard', () => {
  it('lets plain sound descriptors through', () => {
    for (const text of [
      'Slow, quiet bedroom recording. Instruments: nylon guitar, a few piano notes.\nVocals: soft and close.',
      'more tape hiss, no drums',
      'Warm Rhodes and a Juno pad, around 70 BPM, like a tape machine left running',
      'Recorded on a Tascam four-track. Mood: tired, Sunday evening.',
      'Avoid: drums, bright synths.\nAlso: I want more room tone',
    ]) {
      expect(checkDescriptors(text), text).toEqual({ ok: true, issues: [] });
    }
  });

  it('stops names in the middle of a sentence', () => {
    const r = checkDescriptors('a slow song with Xavier Quillfeather on guitar');
    expect(r.ok).toBe(false);
    expect(r.issues.map((i) => i.text)).toEqual(['Xavier', 'Quillfeather']);
    expect(r.issues[0].kind).toBe('name');
  });

  it('stops pointers at existing music', () => {
    for (const text of [
      'in the style of some band',
      'a cover of that one song',
      'slowed type beat',
      'sounds like Quillfeather',
      'something by Quillfeather',
      'lo-fi remix of a pop song',
    ]) {
      const r = checkDescriptors(text);
      expect(r.ok, text).toBe(false);
      expect(r.issues.some((i) => i.kind === 'reference'), text).toBe(true);
    }
  });

  it('stops quoted titles', () => {
    const r = checkDescriptors('make it feel like "a title in quotes" please');
    expect(r.ok).toBe(false);
    expect(r.issues[0].kind).toBe('quoted');
  });

  it('accepts a capital at the start of a sentence or a line', () => {
    expect(checkDescriptors('Hazy and slow. Distant drums.\nMuted guitar: Soft attack').ok).toBe(true);
  });
});
