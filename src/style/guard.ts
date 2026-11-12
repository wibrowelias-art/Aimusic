/**
 * Keeps names and titles out of what goes to the music API.
 *
 * It cannot know every artist or song, so it works on form: quoted text, phrases that
 * point at somebody else's music ("in the style of", "cover of", "by ..."), and words
 * with a capital in the middle of a sentence that are not on the short list of gear
 * and place words. A plain word that trips it only has to be written in lowercase.
 */

export type GuardKind = 'quoted' | 'reference' | 'name';

export interface GuardIssue {
  kind: GuardKind;
  /** The piece of text that tripped the guard. */
  text: string;
  message: string;
}

export interface GuardResult {
  ok: boolean;
  issues: GuardIssue[];
}

export const GUARD_RULE =
  'Names and titles are never sent to the music API, only sound descriptors. Describe the sound instead.';

/** Capitalised words that are sound descriptors, not artists: gear, formats, places as genre words. */
const ALLOWED_CAPITALS = new Set(
  [
    'I', 'BPM', 'EQ', 'LFO', 'VHS', 'DIY', 'MIDI', 'FM', 'AM', 'CD', 'EP', 'LP', 'TV', 'UK', 'US', 'OK', 'DI', 'RT60', 'LUFS',
    'Rhodes', 'Wurlitzer', 'Mellotron', 'Hammond', 'Moog', 'Juno', 'Casio', 'Fender', 'Telecaster', 'Stratocaster',
    'Jazzmaster', 'Tascam', 'Portastudio', 'Leslie', 'Omnichord', 'Dobro', 'Farfisa', 'Vox', 'Roland', 'Korg', 'Yamaha',
    'American', 'Americana', 'British', 'English', 'Irish', 'Scottish', 'Celtic', 'Nordic', 'Scandinavian', 'Japanese',
    'French', 'German', 'Italian', 'Spanish', 'Latin', 'Brazilian', 'African', 'Hawaiian', 'Appalachian', 'Midwest',
    'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
    'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December',
  ].map((w) => w.toLowerCase()),
);

/** Always a pointer at existing music, whatever follows. */
const HARD_REFERENCE =
  /\b(in the (style|vein|manner|spirit) of|style of|inspired by|reminiscent of|influenced by|tribute to|homage to|cover of|covers? version|remix of|version of|type beat|as (played|sung|performed|recorded) by|feat\.?|ft\.|featuring)\b/i;
/** A pointer only when a capitalised word follows ("like a tape machine" is fine). */
const SOFT_REFERENCE = /\b(sounds? like|just like|like|similar to|a la|by|from|era)\s+((?:the\s+)?\p{Lu}[\p{L}\p{N}'.-]*)/u;
const QUOTED = /["“”«»]([^"“”«»]{2,})["“”«»]/;

function isAllowed(word: string): boolean {
  const bare = word.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
  return bare.length === 0 || ALLOWED_CAPITALS.has(bare);
}

/** Checks descriptor text (the prompt, the owner's extra words). */
export function checkDescriptors(text: string): GuardResult {
  const issues: GuardIssue[] = [];
  const seen = new Set<string>();
  const push = (kind: GuardKind, piece: string, message: string): void => {
    const key = `${kind}:${piece.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    issues.push({ kind, text: piece, message });
  };

  const quoted = QUOTED.exec(text);
  if (quoted) push('quoted', quoted[0], `Quoted text reads like a title: ${quoted[0]}. Take it out.`);

  const hard = HARD_REFERENCE.exec(text);
  if (hard) push('reference', hard[0], `"${hard[0]}" points at existing music. Describe the sound itself.`);

  const soft = SOFT_REFERENCE.exec(text);
  if (soft && !isAllowed(soft[2].replace(/^the\s+/i, ''))) {
    push('reference', soft[0], `"${soft[0]}" reads like a reference to an artist or a song.`);
  }

  // Capitals in the middle of a sentence. A sentence starts at the beginning, after . ! ? : ; or a line break.
  const tokens = text.matchAll(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu);
  for (const token of tokens) {
    const word = token[0];
    if (!/^\p{Lu}/u.test(word)) continue;
    if (isAllowed(word)) continue;
    const before = text.slice(0, token.index).replace(/[\s"'(\[“-]+$/u, '');
    const opensSentence = before.length === 0 || /[.!?:;\n]$/.test(text.slice(0, token.index).replace(/[ \t"'(\[“-]+$/u, ''));
    if (opensSentence) continue;
    push('name', word, `"${word}" looks like a name or a title. If it is a plain word, write it in lowercase.`);
  }
  return { ok: issues.length === 0, issues };
}
