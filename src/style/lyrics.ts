/**
 * "Original lyrics" helper: short, plain, everyday lines put together from the owner's
 * own topic words by a small seeded grammar. Nothing is taken from any song: every line
 * is built here from a frame and a topic, or from one of the small household sentences
 * below. It cannot check itself against every song ever written, so the result is a
 * draft to edit, and the owner's words carry it.
 *
 * Pure and deterministic: same topics and seed, same text.
 */
import { mulberry32 } from '../audio/rng';

export const LYRICS_MAX_TOPICS = 6;
export const LYRICS_MAX_TOPIC_CHARS = 40;
/** The music API takes at most this many characters per line. */
export const LYRICS_MAX_LINE_CHARS = 200;

/** Frames that take a topic exactly as typed. */
const TOPIC_FRAMES: readonly string[] = [
  '{t}, again',
  'i keep coming back to {t}',
  'nobody brings up {t} now',
  'it was only {t}',
  '{t}, and then nothing much',
  'i wrote {t} on my hand and it washed off',
  'there is still {t}',
  'i did not plan around {t}',
  'someone asked about {t} and i said fine',
  '{t}, same as last week',
  'i think about {t} on the stairs',
  'all day it was {t}',
  'i meant to say something about {t}',
  '{t} is on the list for tomorrow',
];

/** Small household sentences with no topic in them. */
const PLAIN_LINES: readonly string[] = [
  'the kettle switches itself off',
  'i rinse the one cup twice',
  'the heating ticks on at six',
  'my phone is down to four percent',
  'next door they are dragging a table',
  'i eat my dinner standing up',
  'the hall bulb is still out',
  'i leave my shoes pointing at the door',
  'it is dark by four these days',
  'i let it ring three times',
  'the bus pulls off while i look for my card',
  'i fold the receipt and keep it',
  'the washing has been in there since monday',
  'i sit in the car a while before going in',
  'the fridge hums and then stops',
  'i set two alarms and sleep through both',
];

const REFRAIN_TAILS: readonly string[] = [
  'and i am mostly fine',
  'and that is about all',
  'and i will sort it out later',
  'and nothing needs doing',
  'and it is nearly tomorrow',
];

/** Cleans the owner's topic words: trims, drops empties, caps count and length. */
export function parseTopics(input: string): string[] {
  return input
    .split(/[,\n;]+/)
    .map((t) => t.trim().replace(/\s+/g, ' ').slice(0, LYRICS_MAX_TOPIC_CHARS))
    .filter((t) => t.length > 0)
    .slice(0, LYRICS_MAX_TOPICS);
}

export interface LyricsSection {
  name: string;
  lines: string[];
}

/** Two verses and a two-line refrain after each. Empty when there are no topics. */
export function draftLyricSections(topicsInput: string, seed: number): LyricsSection[] {
  const topics = parseTopics(topicsInput);
  if (topics.length === 0) return [];
  const rand = mulberry32(seed >>> 0);
  const pickFrom = <T>(pool: T[]): T => pool.splice(Math.floor(rand() * pool.length), 1)[0];
  const frames = [...TOPIC_FRAMES];
  const plain = [...PLAIN_LINES];
  const tails = [...REFRAIN_TAILS];
  let topicAt = Math.floor(rand() * topics.length);
  const nextTopic = (): string => topics[topicAt++ % topics.length];
  const topicLine = (): string => pickFrom(frames).replace('{t}', nextTopic());

  const verse = (): string[] => {
    // Two lines about a topic, two about the room, in a seeded order that starts plain or not.
    const startPlain = rand() < 0.5;
    const a = [topicLine(), topicLine()];
    const b = [pickFrom(plain), pickFrom(plain)];
    return startPlain ? [b[0], a[0], b[1], a[1]] : [a[0], b[0], a[1], b[1]];
  };
  const refrainTopic = topics[0];
  const refrain = [pickFrom(frames).replace('{t}', refrainTopic), pickFrom(tails)];
  return [
    { name: 'verse 1', lines: verse() },
    { name: 'refrain', lines: [...refrain] },
    { name: 'verse 2', lines: verse() },
    { name: 'refrain', lines: [...refrain] },
  ].map((s) => ({ name: s.name, lines: s.lines.map((l) => l.slice(0, LYRICS_MAX_LINE_CHARS)) }));
}

/** The draft as editable text: "[name]" on its own line, a blank line between sections. */
export function draftLyrics(topicsInput: string, seed: number): string {
  return formatLyrics(draftLyricSections(topicsInput, seed));
}

export function formatLyrics(sections: readonly LyricsSection[]): string {
  return sections.map((s) => [`[${s.name}]`, ...s.lines].join('\n')).join('\n\n');
}

/**
 * Reads lyrics text back into sections. Sections are split by blank lines; a first line
 * in square brackets names the section. Lines are trimmed and cut to the API's limit.
 */
export function parseLyrics(text: string): LyricsSection[] {
  const sections: LyricsSection[] = [];
  let verses = 0;
  for (const block of text.replace(/\r/g, '').split(/\n\s*\n+/)) {
    const lines = block
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    if (lines.length === 0) continue;
    let name = '';
    const label = /^\[(.+)\]$/.exec(lines[0]);
    if (label) {
      name = label[1].trim();
      lines.shift();
    }
    if (lines.length === 0) continue;
    if (!name) name = `verse ${++verses}`;
    sections.push({ name, lines: lines.map((l) => l.slice(0, LYRICS_MAX_LINE_CHARS)) });
  }
  return sections;
}
