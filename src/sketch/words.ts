/**
 * The owner's own words for the built-in generator. Rules, not a language model: a short
 * list of things it can leave out, turn up or down, and a few one-word directions. What
 * no rule matches is reported back as not understood (the music AI engine would read it,
 * this one cannot).
 */
import { HISS_MAX_DB, HISS_MIN_DB, HISS_OFF_DB, normalizePostFx, type PostFxSettings } from '../postfx/settings';
import type { Group, WordsResult } from './types';

type FxEdit = (fx: PostFxSettings) => Partial<PostFxSettings>;

type Target =
  | { kind: 'group'; group: Group; name: string }
  | { kind: 'fx'; name: string; more: FxEdit; less: FxEdit; none: FxEdit; unit: string }
  | { kind: 'space' }
  | { kind: 'notes' };

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** First match wins, so the more specific words come first. */
const TARGETS: readonly { pattern: RegExp; target: Target }[] = [
  {
    pattern: /hiss|tape noise|room tone|\bnoise\b/,
    target: {
      kind: 'fx',
      name: 'hiss',
      unit: '4 dB',
      more: (fx) => ({ hissDb: clamp(Math.max(fx.hissDb, HISS_MIN_DB - 4) + 4, HISS_MIN_DB, HISS_MAX_DB) }),
      less: (fx) => ({ hissDb: fx.hissDb - 4 < HISS_MIN_DB ? HISS_OFF_DB : fx.hissDb - 4 }),
      none: () => ({ hissDb: HISS_OFF_DB }),
    },
  },
  {
    pattern: /reverb|\broom\b|\bhall\b|echo|wash/,
    target: {
      kind: 'fx',
      name: 'reverb',
      unit: '20 points',
      more: (fx) => ({ room: fx.room + 0.2 }),
      less: (fx) => ({ room: fx.room - 0.2 }),
      none: () => ({ room: 0 }),
    },
  },
  {
    pattern: /wobble|\bwow\b|flutter|warble|detun|drift/,
    target: {
      kind: 'fx',
      name: 'tape wobble',
      unit: '20 points',
      more: (fx) => ({ wobble: fx.wobble + 0.2, drift: fx.drift + 0.1 }),
      less: (fx) => ({ wobble: fx.wobble - 0.2, drift: fx.drift - 0.1 }),
      none: () => ({ wobble: 0, drift: 0 }),
    },
  },
  {
    pattern: /saturat|\bdirt|grit|distort|crunch|fuzz|\btape\b/,
    target: {
      kind: 'fx',
      name: 'saturation',
      unit: '20 points',
      more: (fx) => ({ saturation: fx.saturation + 0.2 }),
      less: (fx) => ({ saturation: fx.saturation - 0.2 }),
      none: () => ({ saturation: 0 }),
    },
  },
  {
    pattern: /slowed|slow[- ]?down effect/,
    target: {
      kind: 'fx',
      name: 'slowed',
      unit: '5 %',
      more: (fx) => ({ slowedPct: fx.slowedPct + 5 }),
      less: (fx) => ({ slowedPct: fx.slowedPct - 5 }),
      none: () => ({ slowedPct: 0 }),
    },
  },
  { pattern: /drum|\bbeat\b|percussion|kick|snare|\bhat\b|cymbal|pulse/, target: { kind: 'group', group: 'drums', name: 'drums' } },
  { pattern: /guitar|strum|pluck/, target: { kind: 'group', group: 'guitar', name: 'guitar' } },
  { pattern: /\bbass\b|\bsub\b/, target: { kind: 'group', group: 'bass', name: 'bass' } },
  { pattern: /piano|\bkeys\b|keyboard|\bbells?\b/, target: { kind: 'group', group: 'keys', name: 'keys' } },
  { pattern: /\bpads?\b|synth|organ|drone/, target: { kind: 'group', group: 'pads', name: 'pads' } },
  { pattern: /voice|vocal|sing|choir|\bhum/, target: { kind: 'group', group: 'voice', name: 'voice' } },
  { pattern: /click|texture|\bwind\b|\bair\b/, target: { kind: 'group', group: 'texture', name: 'texture' } },
  { pattern: /space|silence|pauses?|gaps?|empt/, target: { kind: 'space' } },
  { pattern: /\bnotes?\b|busy|movement/, target: { kind: 'notes' } },
];

const NONE = /^(?:no|without|remove|drop|lose|kill)(?:\s+(?:the|any|all))?\s+(.+)$/;
const MORE = /^(?:more|extra|louder|bigger|heavier|add more)\s+(.+)$/;
const LESS = /^(?:less|fewer|quieter|softer|lighter)\s+(.+)$/;
const ADD = /^(?:add|with)(?:\s+(?:a|an|some|the))?\s+(.+)$/;

export function parseWords(words: string): WordsResult {
  const understood: string[] = [];
  const ignored: string[] = [];
  const removeGroups: Group[] = [];
  const addGroups: Group[] = [];
  const groupGain: Partial<Record<Group, number>> = {};
  const fxEdits: FxEdit[] = [];
  let tempoDelta = 0;
  let restDelta = 0;
  let registerDelta = 0;
  let densityFactor = 1;
  let minorBias = 0;

  const find = (text: string): Target | null => TARGETS.find((t) => t.pattern.test(text))?.target ?? null;

  for (const raw of words.toLowerCase().split(/[,;\n]+|\s+and\s+/)) {
    const clause = raw.trim().replace(/\s+/g, ' ').replace(/[.!\s]+$/, '');
    if (!clause) continue;
    const none = NONE.exec(clause);
    const more = MORE.exec(clause);
    const less = LESS.exec(clause);
    const add = ADD.exec(clause);
    const rest = (none ?? more ?? less ?? add)?.[1] ?? clause;
    const target = find(rest);
    const amount = none ? 'none' : more ? 'more' : less ? 'less' : add ? 'add' : null;

    if (target && amount) {
      if (target.kind === 'group') {
        if (amount === 'none') {
          removeGroups.push(target.group);
          understood.push(`${clause}: ${target.name} left out`);
        } else if (amount === 'add') {
          addGroups.push(target.group);
          understood.push(`${clause}: ${target.name} added if the family has none`);
        } else {
          groupGain[target.group] = (groupGain[target.group] ?? 1) * (amount === 'more' ? 1.5 : 0.6);
          understood.push(`${clause}: ${target.name} ${amount === 'more' ? 'up 3.5 dB' : 'down 4.4 dB'}`);
        }
        continue;
      }
      if (target.kind === 'fx') {
        fxEdits.push(amount === 'none' ? target.none : amount === 'less' ? target.less : target.more);
        understood.push(`${clause}: ${target.name} ${amount === 'none' ? 'off' : `${amount === 'less' ? 'down' : 'up'} ${target.unit}`} in the chain`);
        continue;
      }
      if (target.kind === 'space') {
        const d = amount === 'none' || amount === 'less' ? -0.12 : 0.12;
        restDelta += d;
        understood.push(`${clause}: ${d > 0 ? 'more' : 'fewer'} silent bars (${d > 0 ? '+' : ''}${Math.round(d * 100)} points)`);
        continue;
      }
      const f = amount === 'none' || amount === 'less' ? 0.75 : 1.3;
      densityFactor *= f;
      understood.push(`${clause}: ${f > 1 ? 'more' : 'fewer'} melody notes (x${f})`);
      continue;
    }

    // One-word directions, with an optional "much" / "a bit".
    const scale = /\b(much|a lot|way)\b/.test(clause) ? 1.75 : /\b(a bit|slightly|a little)\b/.test(clause) ? 0.5 : 1;
    if (/\bslower\b/.test(clause)) {
      tempoDelta -= Math.round(8 * scale);
      understood.push(`${clause}: tempo ${-Math.round(8 * scale)} BPM`);
    } else if (/\bfaster\b/.test(clause)) {
      tempoDelta += Math.round(8 * scale);
      understood.push(`${clause}: tempo +${Math.round(8 * scale)} BPM`);
    } else if (/\b(darker|duller|muffled)\b/.test(clause)) {
      registerDelta -= Math.round(3 * scale);
      fxEdits.push((fx) => ({ highCutHz: fx.highCutHz * 0.8 }));
      understood.push(`${clause}: melody ${Math.round(3 * scale)} semitones lower, high-cut down by a fifth`);
    } else if (/\bbrighter\b/.test(clause)) {
      registerDelta += Math.round(3 * scale);
      fxEdits.push((fx) => ({ highCutHz: fx.highCutHz * 1.25 }));
      understood.push(`${clause}: melody ${Math.round(3 * scale)} semitones higher, high-cut up by a fifth`);
    } else if (/\b(sadder|gloomier|bleaker|minor)\b/.test(clause)) {
      minorBias += 1;
      tempoDelta -= 4;
      understood.push(`${clause}: minor modes more likely, tempo -4 BPM`);
    } else if (/\b(happier|warmer|lighter|major)\b/.test(clause)) {
      minorBias -= 1;
      understood.push(`${clause}: major modes more likely`);
    } else if (/\b(sparser|emptier|calmer)\b/.test(clause)) {
      restDelta += 0.12;
      understood.push(`${clause}: more silent bars (+12 points)`);
    } else if (/\bbusier\b/.test(clause)) {
      densityFactor *= 1.3;
      understood.push(`${clause}: more melody notes (x1.3)`);
    } else {
      ignored.push(clause);
    }
  }

  return {
    understood,
    ignored,
    removeGroups,
    addGroups,
    groupGain,
    tempoDelta,
    restDelta,
    registerDelta,
    densityFactor,
    minorBias,
    fx: (preset) => fxEdits.reduce((fx, edit) => normalizePostFx({ ...fx, ...edit(fx) }), normalizePostFx(preset)),
  };
}
