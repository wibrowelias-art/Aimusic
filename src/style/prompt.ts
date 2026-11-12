/**
 * Turns a profile (or a mix of two) plus the owner's words into the text that is sent to
 * the music API. Pure and deterministic. The text holds sound descriptors only; the
 * guard in `guard.ts` checks it again before anything is sent.
 */
import { mixPostFx, type PostFxSettings } from '../postfx/settings';
import { PROFILES } from './profiles';
import type { StyleProfile, StyleRequest } from './types';

/** Below this share the second profile is "a touch", above 1 - this it leads. */
export const MIX_TOUCH = 0.35;

const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

/** The first `share` of a list, at least one item while the share is above zero. */
function take(list: readonly string[], share: number): string[] {
  if (share <= 0 || list.length === 0) return [];
  return list.slice(0, Math.max(1, Math.round(list.length * share)));
}

function unique(items: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const key = item.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(item);
    }
  }
  return out;
}

/** Last word of an avoid item without its plural s: "big drums" -> "drum". */
function headNoun(item: string): string {
  const words = item.toLowerCase().trim().split(/\s+/);
  return (words[words.length - 1] ?? '').replace(/s$/, '');
}

export interface Blend {
  /** The profile with the bigger share. */
  lead: StyleProfile;
  other: StyleProfile | null;
  /** Share of `other`, 0..0.5. */
  otherShare: number;
  tempoBpm: [number, number];
  fx: PostFxSettings;
}

/** Resolves a request to its two profiles, the blended tempo range and the blended chain preset. */
export function blendOf(req: Pick<StyleRequest, 'a' | 'b' | 'mix'>): Blend {
  const a = PROFILES[req.a];
  const b = req.b && req.b !== req.a ? PROFILES[req.b] : null;
  const t = b ? clamp01(req.mix) : 0;
  if (!b || t === 0) return { lead: a, other: null, otherShare: 0, tempoBpm: [a.tempoBpm[0], a.tempoBpm[1]], fx: a.fx };
  const tempoBpm: [number, number] = [
    Math.round(a.tempoBpm[0] + (b.tempoBpm[0] - a.tempoBpm[0]) * t),
    Math.round(a.tempoBpm[1] + (b.tempoBpm[1] - a.tempoBpm[1]) * t),
  ];
  const fx = mixPostFx(a.fx, b.fx, t);
  if (t === 1) return { lead: b, other: null, otherShare: 0, tempoBpm, fx };
  return t <= 0.5
    ? { lead: a, other: b, otherShare: t, tempoBpm, fx }
    : { lead: b, other: a, otherShare: 1 - t, tempoBpm, fx };
}

function firstLine(blend: Blend): string {
  const { lead, other, otherShare } = blend;
  if (!other) return `A ${lead.lead}.`;
  if (otherShare < MIX_TOUCH) return `A ${lead.lead}, with a touch of ${other.lead}.`;
  return `An even blend of a ${lead.lead} and a ${other.lead}.`;
}

/** The prompt text for a request. One labelled line per trait, so it is easy to edit by hand. */
export function buildPrompt(req: StyleRequest): string {
  const blend = blendOf(req);
  const { lead, other, otherShare } = blend;
  const leadShare = other ? 1 - otherShare : 1;
  const list = (pick: (p: StyleProfile) => readonly string[]): string[] =>
    unique([...take(pick(lead), other ? Math.max(0.5, leadShare) : 1), ...(other ? take(pick(other), otherShare) : [])]);

  const instruments = list((p) => p.instruments);
  const lines: string[] = [firstLine(blend)];
  lines.push(`Genre: ${list((p) => p.genre).join(', ')}.`);
  lines.push(`Instruments: ${instruments.join(', ')}.`);
  lines.push(req.vocals ? `Vocals: ${lead.vocal}.` : 'Vocals: none. Instrumental only, no singing, no spoken words.');
  lines.push(`Tempo: ${lead.tempoFeel}, around ${blend.tempoBpm[0]}-${blend.tempoBpm[1]} BPM.`);
  lines.push(`Production: ${list((p) => p.production).join(', ')}.`);
  lines.push(`Mood: ${list((p) => p.mood).join(', ')}.`);
  lines.push(`Structure: ${lead.structure}.`);
  // Do not ask to avoid something the blend just asked for.
  const wanted = instruments.join(' ').toLowerCase();
  const avoid = lead.avoid.filter((item) => !wanted.includes(headNoun(item)) && !(req.vocals && /vocal|sing/i.test(item)));
  if (avoid.length > 0) lines.push(`Avoid: ${avoid.join(', ')}.`);
  const words = req.words.trim().replace(/\s+/g, ' ');
  if (words) lines.push(`Also: ${words.replace(/[.\s]+$/, '')}.`);
  return lines.join('\n');
}

/** "Avoid: a, b." lines of a (possibly hand-edited) prompt as a list; everything else as style lines. */
export function splitPrompt(prompt: string): { styles: string[]; avoid: string[] } {
  const styles: string[] = [];
  const avoid: string[] = [];
  for (const raw of prompt.split(/\n+/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^avoid\s*:\s*(.+)$/i.exec(line);
    if (m) {
      for (const item of m[1].split(',')) {
        const clean = item.trim().replace(/[.\s]+$/, '');
        if (clean) avoid.push(clean);
      }
    } else {
      styles.push(line.replace(/[.\s]+$/, ''));
    }
  }
  return { styles, avoid };
}
