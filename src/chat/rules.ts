/**
 * Chat control: plain words move the knobs. Rule-based keyword mapping, no
 * network, no API key, fully deterministic.
 *
 *   applyChat("sadder, slower, more space, add rain", params)
 *
 * The lab works with mood words only. A request to copy, imitate or play an
 * existing piece ("like <song>", "in the style of <artist>", a quoted title, a
 * list of notes or chords) is left out, and the result says so.
 */
import { KEY_NAMES, MODE_LABELS, NUMERIC_KEYS, PARAM_SPECS, clamp, normalizeParams, paramLabel } from '../engine/params';
import type { Mode, NumericParamKey, Params } from '../engine/types';

export interface ChatChange {
  key: NumericParamKey | 'mode' | 'key';
  /** Human readable name of the setting. */
  label: string;
  from: string;
  to: string;
}

export interface ChatResult {
  /** The settings after the message. */
  params: Params;
  /** What moved, in the order of the knobs. Empty when nothing changed. */
  changes: ChatChange[];
  /** The words that were understood. */
  understood: string[];
  /** Words nothing was found for. */
  ignored: string[];
  /** Parts that were left out because they ask to copy existing music or give notes. */
  refused: string[];
  /** Notes for the user ("Tempo is already at its lowest."). */
  notes: string[];
  /** A take was asked for ("another one", "again"). */
  action: 'generate' | 'again' | null;
}

export const REFUSAL_TEXT =
  'I left that part out. I do not copy or imitate existing music, and I do not take note or chord lists. If you meant a mood, say it with words like slower, sadder, more space, more reverb, add rain.';

type Effect =
  | { kind: 'add'; key: NumericParamKey; amount: number }
  | { kind: 'set'; key: NumericParamKey; value: number }
  | { kind: 'min'; key: NumericParamKey; value: number }
  | { kind: 'minor' }
  | { kind: 'major' }
  | { kind: 'mode'; mode: Mode };

interface Rule {
  /** Name shown under "understood". */
  name: string;
  /** Matches the words that mean "more of this". */
  pattern: RegExp;
  /** Effects for "more of this". */
  effects: Effect[];
  /** Effects when the user asks for none of it ("no rain"). Default: the inverse, doubled. */
  off?: Effect[];
  /** Name shown when the direction is reversed ("less reverb"). */
  inverseName?: string;
  /** The direction is part of the pattern ("lower the tempo"): words around it change nothing. */
  fixed?: boolean;
  /** A thing with a level (rain, pad, reverb...): "rain off", "reverb down" and "remove the X and the Y" work. */
  level?: boolean;
}

const add = (key: NumericParamKey, amount: number): Effect => ({ kind: 'add', key, amount });
const set = (key: NumericParamKey, value: number): Effect => ({ kind: 'set', key, value });
const atLeast = (key: NumericParamKey, value: number): Effect => ({ kind: 'min', key, value });

const UP = '(?:raise|increase|higher|more|up|boost|push up|bump up|turn up|bring up)';
const DOWN = '(?:lower|decrease|reduce|less|drop|bring down|turn down|cut|pull down)';
const THE = '(?: the| that| its)?';
/** "raise the tempo" / "tempo up" for a knob that has no mood word of its own. */
function knobRules(noun: string, key: NumericParamKey, amount: number, upName: string, downName: string): Rule[] {
  return [
    {
      name: upName,
      pattern: new RegExp(`\\b(?:${UP}${THE} (?:${noun})|(?:${noun}) (?:up|higher))\\b`),
      effects: [add(key, amount)],
      fixed: true,
    },
    {
      name: downName,
      pattern: new RegExp(`\\b(?:${DOWN}${THE} (?:${noun})|(?:${noun}) (?:down|lower))\\b`),
      effects: [add(key, -amount)],
      fixed: true,
    },
  ];
}

/**
 * The vocabulary. Order matters: longer, more specific phrases come first.
 * Amounts are in the units of the knob (BPM, notes per bar, semitones, seconds, 0..1).
 */
const RULES: Rule[] = [
  // Knobs named directly, with their direction.
  ...knobRules('tempo|speed|pace|bpm', 'tempo', 6, 'faster', 'slower'),
  ...knobRules('density|note count|number of notes', 'density', 0.5, 'busier', 'sparser'),
  ...knobRules('register|pitch|melody', 'register', 4, 'higher', 'lower'),
  ...knobRules('length|duration', 'length', 20, 'longer', 'shorter'),
  // Rain
  { name: 'heavy rain', pattern: /\b(heavy rain|pouring|downpour|storm(y)?|thunderstorm)\b/, effects: [atLeast('rain', 0.75)], off: [set('rain', 0)] },
  { name: 'light rain', pattern: /\b(light rain|drizzle|drizzling|a little rain|some rain|soft rain|gentle rain)\b/, effects: [set('rain', 0.2)], off: [set('rain', 0)] },
  { name: 'rain', pattern: /\b(rain(y|ing|fall)?|raindrops?)\b/, effects: [atLeast('rain', 0.25), add('rain', 0.1)], off: [set('rain', 0)], inverseName: 'less rain', level: true },
  // Piano only
  { name: 'piano only', pattern: /\b((just|only)( the| a)? piano|piano only|solo piano|nothing but( the)? piano)\b/, effects: [set('pad', 0), set('rain', 0)], fixed: true },
  // Pad
  { name: 'pad', pattern: /\b(pads?|drones?|strings?|synth(s)?|atmosphere|atmos)\b/, effects: [atLeast('pad', 0.2), add('pad', 0.12)], off: [set('pad', 0)], inverseName: 'less pad', level: true },
  // Space and density
  { name: 'busier', pattern: /\b(more notes|more going on|more movement|more active)\b/, effects: [add('density', 0.5), add('restProbability', -0.1)], fixed: true },
  { name: 'sparser', pattern: /\b(fewer notes|less notes|less going on|less movement)\b/, effects: [add('density', -0.4), add('restProbability', 0.08)], fixed: true },
  { name: 'more space', pattern: /\b(space|spacious(ness)?|silences?|silent|room to breathe|breath(e|ing)?|air(y|ier)?|pauses?|rests?|gaps?)\b/, effects: [add('restProbability', 0.12), add('density', -0.3)], inverseName: 'less space', level: true },
  { name: 'sparser', pattern: /\b(spars(e|er)|empt(y|ier)|minimal|simpl(e|er)|thin(ner)?|quiet(er)?|calm(er)?( down)?|still(er)?|peaceful|relax(ed|ing)?|sleep(y|ier))\b/, effects: [add('density', -0.4), add('restProbability', 0.08)], inverseName: 'busier' },
  // There is no knob for how hard the keys are struck: softer means a little sparser and darker.
  { name: 'gentler', pattern: /\b(gentl(e|er)|soft(er)?|tender|delicate)\b/, effects: [add('density', -0.2), add('restProbability', 0.04), add('lofi', 0.05)], inverseName: 'busier' },
  { name: 'busier', pattern: /\b(bus(y|ier)|dens(e|er)|full(er)?|rich(er)?|crowded|cluttered|hectic)\b/, effects: [add('density', 0.5), add('restProbability', -0.1)], inverseName: 'sparser' },
  // Tempo
  { name: 'slower', pattern: /\b(slow down|slow it down|slow(er|ly)?|largo|adagio|drag(ging)?|laz(y|ier))\b/, effects: [add('tempo', -6)], inverseName: 'faster' },
  { name: 'faster', pattern: /\b(fast(er)?|quick(er)?|speed up|speed it up|upbeat|livel(y|ier)|more energy|energetic)\b/, effects: [add('tempo', 6)], inverseName: 'slower' },
  // Reverb
  { name: 'cave', pattern: /\b(cave(rn|rnous|s)?|cathedral|huge (room|hall|space)|endless)\b/, effects: [set('reverbSize', 6), add('register', -2), add('density', -0.3)] },
  { name: 'more reverb', pattern: /\b(reverb(y)?|echo(ey|y)?|wet(ter)?|hall|big(ger)? room|larger room|tail|wash(y|ier)?|distant|far away|faraway)\b/, effects: [add('reverbSize', 0.8)], off: [set('reverbSize', PARAM_SPECS.reverbSize.min)], inverseName: 'less reverb', level: true },
  { name: 'less reverb', pattern: /\b(dr(y|ier)|small(er)? room|clos(e|er)|intimate|near(er)?|tight(er)?)\b/, effects: [add('reverbSize', -0.8)], inverseName: 'more reverb' },
  // Lo-fi
  { name: 'more lo-fi', pattern: /\b(lo-?fi|tape|wobbl(e|y|ier)|wow|flutter|vintage|old(er)?|worn|dust(y|ier)?|hiss(y)?|crackl(e|y)|cassette|vhs|nostalgi(a|c)|degraded|warbl(e|y))\b/, effects: [add('lofi', 0.15)], off: [set('lofi', 0)], inverseName: 'cleaner', level: true },
  { name: 'cleaner', pattern: /\b(clean(er)?|clear(er)?|hi-?fi|pristine|crisp(er)?|modern)\b/, effects: [add('lofi', -0.15)], inverseName: 'more lo-fi' },
  // Length
  { name: 'longer', pattern: /\b(long(er)?|extend(ed)?|more time)\b/, effects: [add('length', 20)], inverseName: 'shorter' },
  { name: 'shorter', pattern: /\b(short(er)?|brief(er)?)\b/, effects: [add('length', -20)], inverseName: 'longer' },
  // Register / tone
  { name: 'octave higher', pattern: /\b(an? octave (up|higher)|octave up)\b/, effects: [add('register', 12)], fixed: true },
  { name: 'octave lower', pattern: /\b(an? octave (down|lower)|octave down)\b/, effects: [add('register', -12)], fixed: true },
  { name: 'higher', pattern: /\b(high(er)?|bright(er)?|light(er)?|sparkl(e|y|ing)|shimmer(y|ing)?|glass(y)?|twinkl(e|y|ing))\b/, effects: [add('register', 4), add('lofi', -0.06)], inverseName: 'lower' },
  { name: 'lower', pattern: /\b(low(er)?|deep(er)?|dark(er)?|dull(er)?|muffled|mellow(er)?|heav(y|ier)|bass(y|ier)?)\b/, effects: [add('register', -4), add('lofi', 0.06)], inverseName: 'higher' },
  // Moods
  { name: 'sadder', pattern: /\b(sad(der)?|melanchol(y|ic)|sorrow(ful)?|blue|gloom(y|ier)?|mourn(ful|ing)?|lonel(y|ier)|wistful|bittersweet|tragic|grief|griev(e|ing)|heartbr(oken|eak(ing)?)|tear(s|ful)?|cry(ing)?|mood(y|ier)|minor)\b/, effects: [{ kind: 'minor' }, add('tempo', -4), add('register', -2)], inverseName: 'happier' },
  { name: 'happier', pattern: /\b(happ(y|ier)|hopeful|hope|cheer(ful|y|ier)?|joy(ful)?|optimistic|uplift(ing|ed)?|sunn(y|ier)|content|major)\b/, effects: [{ kind: 'major' }, add('tempo', 3), add('register', 2)], inverseName: 'sadder' },
  { name: 'dreamier', pattern: /\b(dream(y|ier|like|s)?|float(y|ing|ier)?|ethereal|weightless|heaven(ly)?|celestial|magic(al)?|otherworldly|haz(y|ier)|misty|foggy)\b/, effects: [{ kind: 'mode', mode: 'lydian' }, add('reverbSize', 0.6), add('pad', 0.1), add('register', 3)] },
  { name: 'warmer', pattern: /\b(warm(er|th)?|cos(y|ier)|coz(y|ier)|snug|homely|fireside|comfort(ing|able)?)\b/, effects: [add('lofi', 0.12), add('register', -2), add('reverbSize', -0.3)], inverseName: 'colder' },
  { name: 'colder', pattern: /\b(cold(er)?|ic(y|ier)|frozen|frost(y)?|winter(y)?|snow(y)?|bleak(er)?)\b/, effects: [add('lofi', -0.12), add('register', 3), add('reverbSize', 0.4)], inverseName: 'warmer' },
  { name: 'night', pattern: /\b(night(time)?|midnight|nocturnal|moon(lit|light)?)\b/, effects: [add('tempo', -3), add('register', -2), add('restProbability', 0.06)] },
];

const MODE_WORDS: { pattern: RegExp; mode: Mode }[] = [
  { pattern: /\b(major )?pentatonic\b/, mode: 'majorPentatonic' },
  { pattern: /\blydian\b/, mode: 'lydian' },
  { pattern: /\bdorian\b/, mode: 'dorian' },
  { pattern: /\b(aeolian|natural minor)\b/, mode: 'aeolian' },
];

/** Words that carry no setting. They never show up under "not understood". */
const STOP_WORDS = new Set(
  (
    'a an the it its this that these those to of for in on at by with and or but so then now please pls make makes made ' +
    'be been is are was were am do does did can could would should will shall may might must let lets have has had get got ' +
    'give gives me my i you your we us our some any all bit little lot lots much many more most less least fewer few very ' +
    'really quite rather pretty kind kinda sort sorta too also just only even still again another new one take takes piece ' +
    'pieces song track music sound sounds feel feels feeling mood vibe vibes thing things way far tad touch slightly ' +
    'somewhat add added adding put use with without no not none remove removed drop kill stop turn turned up down off out ' +
    'want wants wanted need needs like likes think maybe perhaps if when than as into from there here bars bar note piano ' +
    'keys key tempo bpm seconds second sec secs minutes minute min mins room something anything everything stuff between ' +
    'before earlier previous last same different overall general generally whole lab hey hi hello thanks thank ok okay ' +
    'play playing played go going keep keeping set setting change changing try trying bring going notes ' +
    'around about roughly approximately almost nearly while during every each per long amount level levels'
  ).split(' '),
);

const HALF = /\b(a (little|bit|tad|touch)( bit)?|slightly|slight|somewhat|kind of|kinda|sort of|sorta|just a bit|subtly|subtle|faint|a hint of|a touch of)\b/;
const DOUBLE = /\b(much|a lot|lots|way|far|really|very|super|extremely|significantly|considerably|loads|tons|heaps|huge|massive|enormous|giant)\b/;
/** "too much reverb" is not "much more reverb". */
const NOT_DOUBLE = /\b(too|so|as|that|how) much\b/g;
const NEGATE = /\b(less|fewer|not so|not as|not too|not that|reduce|reduced|lower the|decrease|turn down|tone down|dial back|ease off|back off)\b/;
const TOO = /\b(too|too much|overly|excessively)\b/;
const NONE = /\b(no|without|remove|drop|kill|stop|zero|none|get rid of|lose the|turn off|switch off|cut the|mute)\b/;
const MAX = /\b(max(imum|ed)?|full(y)?|all the way|as (much|far) as possible)\b/;
const AFTER_DOWN = /^\s*(down|lower|less)\b/;
const AFTER_OFF = /^\s*(off|out|gone|away)\b/;
const DISLIKE = /\b(i |we )?(really |just |also )?(don'?t like|do not like|dislike|hate|can'?t stand|cannot stand|not a fan of|sick of|tired of)\b/;
const LIKE_STATEMENT = /^\s*(i|we) (really |do |quite |kinda |also |just )*(like|love|enjoy|dig|adore)\b/;

const NOTE = '[a-g](?:#|b|♯|♭| sharp| flat)?';
const MODE_TAIL = '(major pentatonic|pentatonic|major|minor|lydian|dorian|aeolian|natural minor)';

/**
 * Signs that the user asks for existing music.
 * Soft ("like ..."): also used for moods ("like a cold winter morning"), so what follows decides.
 * Strong ("in the style of ..."): only a pure mood phrase gets through.
 */
const SOFT_REFERENCE = /\b(sounds? like|just like|like|as in|similar to|reminds? (me )?of)\b/;
const STRONG_REFERENCE =
  /\b(in the style of|style of|in the vein of|inspired by|a la|based on|from the (game|movie|film|show|series|soundtrack|song|album|ost)|soundtrack (of|to|from)|ost (of|from)|theme (of|from|to)|cover of|version of|remix of|(melody|tune|theme|song|chords?|chord progression|progression|riff|music|piece|track) (from|of|by))\b/;
const COPY_VERB = /\b(play|recreate|re-create|copy|cover|transcribe|imitate|reproduce|remake|clone|rip|steal|replicate|mimic|emulate|quote)\b/;
const CHORD = `${NOTE}(?:m|maj|min|dim|aug|sus|add)?\\d*`;
const NOTE_LIST = new RegExp(`(?:^|[\\s:,])(${CHORD})(?:[\\s,\\-–>|]+(${CHORD})){2,}(?=$|[\\s.,;])`);
const NOTE_WORD = /\b(notes?|chords?|melod(y|ies)|progression|riff|tune|lick|motif)\s*(:|are|is|=|should be|must be|go(es)?)\s/;
const QUOTED = /["“”«»]([^"“”«»]{2,})["“”«»]|(?:^|\s)'([^']{3,})'(?=$|\s)/;
const ARTICLE = /^\s*(a|an|the|some|that|this)\s+/i;

function parseKey(text: string): number | null {
  const m = /^([a-g])(#|b|♯|♭| sharp| flat)?$/.exec(text.trim());
  if (!m) return null;
  const base = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 }[m[1] as 'c'];
  const acc = m[2] === undefined ? 0 : m[2] === '#' || m[2] === '♯' || m[2] === ' sharp' ? 1 : -1;
  return (base + acc + 12) % 12;
}

function modeFromWord(word: string, current: Mode): Mode {
  switch (word) {
    case 'major pentatonic':
    case 'pentatonic':
      return 'majorPentatonic';
    case 'major':
      return current === 'lydian' || current === 'majorPentatonic' ? current : 'majorPentatonic';
    case 'minor':
      return current === 'dorian' || current === 'aeolian' ? current : 'aeolian';
    case 'aeolian':
    case 'natural minor':
      return 'aeolian';
    case 'lydian':
      return 'lydian';
    case 'dorian':
      return 'dorian';
    default:
      return current;
  }
}

/** One step towards minor / towards major. */
function minorStep(mode: Mode): Mode {
  return mode === 'aeolian' || mode === 'dorian' ? 'aeolian' : 'dorian';
}
function majorStep(mode: Mode): Mode {
  return mode === 'aeolian' ? 'dorian' : mode === 'dorian' ? 'majorPentatonic' : mode;
}

function inverse(effects: readonly Effect[]): Effect[] {
  const out: Effect[] = [];
  for (const e of effects) {
    if (e.kind === 'add') out.push({ ...e, amount: -e.amount });
    else if (e.kind === 'minor') out.push({ kind: 'major' });
    else if (e.kind === 'major') out.push({ kind: 'minor' });
    else if (e.kind === 'min') out.push({ kind: 'add', key: e.key, amount: -0.15 });
    // A "set" or a named mode has no inverse.
  }
  return out;
}

function blank(text: string, start: number, end: number): string {
  return text.slice(0, start) + ' '.repeat(end - start) + text.slice(end);
}

interface Working {
  params: Params;
  understood: string[];
  refused: string[];
  notes: string[];
  action: ChatResult['action'];
}

function applyEffects(w: Working, effects: readonly Effect[], scale: number): void {
  const p = { ...w.params };
  for (const e of effects) {
    if (e.kind === 'add') p[e.key] = p[e.key] + e.amount * scale;
    else if (e.kind === 'set') p[e.key] = e.value;
    else if (e.kind === 'min') p[e.key] = Math.max(p[e.key], e.value);
    else if (e.kind === 'minor') p.mode = minorStep(p.mode);
    else if (e.kind === 'major') p.mode = majorStep(p.mode);
    else p.mode = e.mode;
  }
  w.params = normalizeParams(p);
}

/** Explicit values: "60 bpm", "tempo 52", "in d minor", "key of f#", "2 minutes", "reverb 5 s". */
function takeExplicit(clause: string, w: Working): string {
  let text = clause;
  const eat = (re: RegExp, fn: (m: RegExpExecArray) => string | null): void => {
    for (let guard = 0; guard < 8; guard++) {
      const m = re.exec(text);
      if (!m) return;
      const name = fn(m);
      if (name === null) return;
      text = blank(text, m.index, m.index + m[0].length);
      w.understood.push(name);
    }
  };
  const setNum = (key: NumericParamKey, value: number): string => {
    const spec = PARAM_SPECS[key];
    const clamped = clamp(value, spec.min, spec.max);
    if (clamped !== value) {
      w.notes.push(`${spec.label} goes from ${paramLabel(key, spec.min)} to ${paramLabel(key, spec.max)}, so I used ${paramLabel(key, clamped)}.`);
    }
    w.params = normalizeParams({ ...w.params, [key]: clamped });
    return `${spec.label.toLowerCase()} ${paramLabel(key, w.params[key])}`;
  };

  eat(/\b(?:tempo|bpm|speed)(?: of| to| at| is| =|:)? (\d{2,3})(?: ?bpm)?\b/, (m) => setNum('tempo', Number(m[1])));
  eat(/\b(\d{2,3}) ?bpm\b/, (m) => setNum('tempo', Number(m[1])));
  eat(/\b(\d+):([0-5]\d)(?: ?(?:min(?:ute)?s?|long))?\b/, (m) => setNum('length', Number(m[1]) * 60 + Number(m[2])));
  eat(/\b(\d+(?:\.\d+)?) ?(?:minutes?|mins?)(?: long)?\b/, (m) => setNum('length', Number(m[1]) * 60));
  eat(/\b(?:reverb|tail|decay)(?: of| to| at| =|:)? (\d(?:\.\d+)?) ?(?:s|sec|secs|seconds?)?\b/, (m) => setNum('reverbSize', Number(m[1])));
  eat(/\b(\d(?:\.\d+)?) ?(?:s|sec|secs|seconds?) (?:of )?(?:reverb|tail|decay)\b/, (m) => setNum('reverbSize', Number(m[1])));
  eat(/\b(\d{2,3}) ?(?:s|sec|secs|seconds?)(?: long)?\b/, (m) => setNum('length', Number(m[1])));
  eat(/\b(\d(?:\.\d+)?) notes? (?:per|a|\/) ?bar\b/, (m) => setNum('density', Number(m[1])));
  eat(/\bdensity(?: of| to| at| =|:)? (\d(?:\.\d+)?)\b/, (m) => setNum('density', Number(m[1])));

  // Key with a mode word: "in d minor", "f# dorian", "key of a major".
  eat(new RegExp(`\\b(?:in |key of |key )?(${NOTE}) ${MODE_TAIL}\\b`), (m) => {
    const key = parseKey(m[1]);
    if (key === null) return null;
    const mode = modeFromWord(m[2], w.params.mode);
    w.params = normalizeParams({ ...w.params, key, mode });
    return `key ${KEY_NAMES[key]}, ${MODE_LABELS[mode].toLowerCase()}`;
  });
  // Key alone: "key of f#", or "in e" at the end. A bare "a" there is the article, not a key.
  eat(new RegExp(`\\bkey(?: of| to| is|:)? (${NOTE})(?=$|[\\s.,;])`), (m) => {
    const key = parseKey(m[1]);
    if (key === null) return null;
    w.params = normalizeParams({ ...w.params, key });
    return `key ${KEY_NAMES[key]}`;
  });
  eat(new RegExp(`\\bin (${NOTE})\\s*$`), (m) => {
    if (m[1] === 'a') return null;
    const key = parseKey(m[1]);
    if (key === null) return null;
    w.params = normalizeParams({ ...w.params, key });
    return `key ${KEY_NAMES[key]}`;
  });
  for (const { pattern, mode } of MODE_WORDS) {
    eat(pattern, () => {
      w.params = normalizeParams({ ...w.params, mode });
      return MODE_LABELS[mode].toLowerCase();
    });
  }
  return text;
}

function leftoverWords(text: string): string[] {
  return text
    .split(/[^a-z0-9#♯♭'-]+/)
    .map((t) => t.replace(/^['-]+|['-]+$/g, ''))
    .filter((t) => {
      if (t.length === 0 || /^\d+(\.\d+)?$/.test(t)) return false;
      // "it's", "that's", "i'm", "don't": the word in front of the apostrophe decides.
      const stem = t.replace(/(n't|'(s|m|re|ve|ll|d))$/, '');
      return !STOP_WORDS.has(t) && !STOP_WORDS.has(stem);
    });
}

/** What is left of `text` once mood vocabulary, modifiers and filler are taken out. */
function unknownWords(text: string): { hits: number; unknown: string[] } {
  let rest = text;
  let hits = 0;
  for (const rule of RULES) {
    for (let guard = 0; guard < 6; guard++) {
      const m = rule.pattern.exec(rest);
      if (!m) break;
      hits++;
      rest = blank(rest, m.index, m.index + m[0].length);
    }
  }
  for (const { pattern } of MODE_WORDS) {
    const m = pattern.exec(rest);
    if (m) {
      hits++;
      rest = blank(rest, m.index, m.index + m[0].length);
    }
  }
  for (const re of [HALF, DOUBLE, NEGATE, TOO, NONE, MAX]) {
    for (let guard = 0; guard < 6; guard++) {
      const m = re.exec(rest);
      if (!m) break;
      rest = blank(rest, m.index, m.index + m[0].length);
    }
  }
  return { hits, unknown: leftoverWords(rest) };
}

/** Does the text (in its original spelling) start with a capitalised word after an optional article? */
function startsWithName(original: string): boolean {
  const rest = original.replace(ARTICLE, '');
  return /^\s*\p{Lu}/u.test(rest);
}

/** Is one of `words` written with a capital in the original spelling? */
function hasCapitalised(text: string, original: string, words: readonly string[]): boolean {
  for (const word of words) {
    const at = text.indexOf(word);
    if (at >= 0 && /\p{Lu}/u.test(original.charAt(at)) && original.slice(at, at + word.length) !== word.toUpperCase()) return true;
  }
  return false;
}

/**
 * Takes out what asks for existing music or gives notes. `original` is the same
 * clause with its capitals (same length), used to spot names and titles.
 */
function takeRefusals(clause: string, original: string, w: Working): string {
  let text = clause;
  const refuse = (start: number, end: number): void => {
    const shown = original.slice(start, end).trim().replace(/\s+/g, ' ');
    if (shown && !w.refused.includes(shown)) w.refused.push(shown);
    text = blank(text, start, end);
  };

  const quoted = QUOTED.exec(text);
  if (quoted) refuse(quoted.index, quoted.index + quoted[0].length);

  const noteWord = NOTE_WORD.exec(text);
  if (noteWord) refuse(noteWord.index, text.length);
  const notes = NOTE_LIST.exec(text);
  if (notes) refuse(notes.index, notes.index + notes[0].length);

  const copy = COPY_VERB.exec(text);
  if (copy) {
    // "play it slower" is fine, "play <a piece>" is not: what follows decides.
    const from = copy.index + copy[0].length;
    if (unknownWords(text.slice(from)).unknown.length > 0 || startsWithName(original.slice(from))) {
      refuse(copy.index, text.length);
    } else {
      text = blank(text, copy.index, from);
    }
  }

  const strong = STRONG_REFERENCE.exec(text);
  if (strong) {
    const from = strong.index + strong[0].length;
    const rest = unknownWords(text.slice(from));
    const pureMood = rest.hits > 0 && rest.unknown.length === 0 && !startsWithName(original.slice(from));
    if (pureMood) text = blank(text, strong.index, from);
    else refuse(strong.index, text.length);
  }

  const soft = SOFT_REFERENCE.exec(text);
  if (soft) {
    // "like a cave", "like a cold winter morning" are moods; "like <a song>" is a reference.
    const from = soft.index + soft[0].length;
    const rest = unknownWords(text.slice(from));
    const named = startsWithName(original.slice(from)) || hasCapitalised(text.slice(from), original.slice(from), rest.unknown);
    const nothingKnown = rest.hits === 0 && rest.unknown.length > 0;
    if (named || nothingKnown) refuse(soft.index, text.length);
    else text = blank(text, soft.index, from);
  }
  return text;
}

type Carry = 'none' | 'negate' | null;

/**
 * Applies the mood words of one clause. `carry` is the "no" / "less" of the clause
 * before an "and": "remove the hiss and the pad" takes the pad out too.
 * Returns what is left of the clause and the "no" / "less" this clause was led by.
 */
function takeMoodWords(clause: string, w: Working, dislike: boolean, carry: Carry): { text: string; led: Carry } {
  let text = clause;
  let led: Carry = null;
  const ownModifier = [HALF, DOUBLE, NEGATE, TOO, NONE, MAX].some((re) => re.test(clause)) || /\b(more|add|adding|with|some)\b/.test(clause);
  for (const rule of RULES) {
    const m = rule.pattern.exec(text);
    if (!m) continue;
    // Modifiers are looked for in the words right before the keyword, back to the last
    // keyword that was already taken out (it left a run of blanks).
    const before = text.slice(Math.max(0, m.index - 30), m.index);
    const lead = before.slice(Math.max(before.lastIndexOf('  '), 0));
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 8);
    const amountWords = lead.replace(NOT_DOUBLE, ' ');
    const scale = HALF.test(amountWords) ? 0.5 : DOUBLE.test(amountWords) ? 2 : 1;
    const amount = scale === 1 ? '' : scale === 2 ? ' (a lot)' : ' (a little)';
    // The same thing said twice in one clause ("tape hiss", "cold winter") counts once.
    for (let guard = 0; guard < 8; guard++) {
      const again = rule.pattern.exec(text);
      if (!again) break;
      text = blank(text, again.index, again.index + again[0].length);
    }
    const bare = rule.name.replace(/^more /, '');
    const inherited = rule.level && !ownModifier ? carry : null;
    const none = NONE.test(lead) || (rule.level === true && AFTER_OFF.test(after)) || inherited === 'none';
    const negate = NEGATE.test(lead) || TOO.test(lead) || (rule.level === true && AFTER_DOWN.test(after)) || inherited === 'negate';
    if (rule.fixed) {
      applyEffects(w, rule.effects, scale);
      w.understood.push(`${rule.name}${amount}`);
    } else if (none || (dislike && rule.off !== undefined)) {
      const off = rule.off ?? inverse(rule.effects).map((e) => (e.kind === 'add' ? { ...e, amount: e.amount * 2 } : e));
      applyEffects(w, off, 1);
      w.understood.push(`no ${bare}`);
      if (NONE.test(lead)) led = 'none';
    } else if (negate || dislike) {
      applyEffects(w, inverse(rule.effects), scale);
      w.understood.push(`${rule.inverseName ?? `less ${bare}`}${amount}`);
      if (NEGATE.test(lead)) led = 'negate';
    } else if (MAX.test(lead)) {
      applyEffects(w, rule.effects, 4);
      w.understood.push(`${rule.name} (all the way)`);
    } else {
      applyEffects(w, rule.effects, scale);
      w.understood.push(`${rule.name}${amount}`);
    }
  }
  return { text, led };
}

function diff(before: Params, after: Params): ChatChange[] {
  const out: ChatChange[] = [];
  if (before.key !== after.key) out.push({ key: 'key', label: 'Key', from: KEY_NAMES[before.key], to: KEY_NAMES[after.key] });
  if (before.mode !== after.mode) {
    out.push({ key: 'mode', label: 'Mode', from: MODE_LABELS[before.mode], to: MODE_LABELS[after.mode] });
  }
  for (const k of NUMERIC_KEYS) {
    if (before[k] !== after[k]) {
      out.push({ key: k, label: PARAM_SPECS[k].label, from: paramLabel(k, before[k]), to: paramLabel(k, after[k]) });
    }
  }
  return out;
}

const SPLIT = /\s*(?:[,;\n]|\.(?=\s|$)|\band then\b|\bthen\b|\band\b|\bbut\b|\bplus\b|&|\+)\s*/g;
const NEW_TAKE = /\b(another( one)?|new (one|take|piece)|something (new|else)|next one|surprise me|generate)\b/g;
const SAME_AGAIN = /\b(again|variation|vary it|one more time|same again|re-?roll)\b/g;

export function applyChat(message: string, current: Params): ChatResult {
  const before = normalizeParams(current);
  const w: Working = { params: before, understood: [], refused: [], notes: [], action: null };
  const ignored: string[] = [];

  let original = message
    .replace(/[‘’]/g, "'")
    .replace(/[!?()[\]{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  let text = original.toLowerCase();
  // A few letters change length when lowered; then names cannot be told by capitals.
  if (text.length !== original.length) original = text;
  if (text.length === 0) {
    return {
      params: before,
      changes: [],
      understood: [],
      ignored: [],
      refused: [],
      notes: ['Type a few mood words, for example: sadder, slower, more space, add rain.'],
      action: null,
    };
  }
  text = ` ${text} `;
  original = ` ${original} `;

  // Clause boundaries, kept as positions so the original spelling stays aligned.
  const bounds: { start: number; end: number; sentenceStart: boolean; afterAnd: boolean }[] = [];
  let cursor = 0;
  let sentenceStart = true;
  let afterAnd = false;
  for (const m of text.matchAll(SPLIT)) {
    const at = m.index ?? 0;
    if (at > cursor) bounds.push({ start: cursor, end: at, sentenceStart, afterAnd });
    sentenceStart = m[0].includes('.');
    afterAnd = /\band\b|&|\+|\bplus\b/.test(m[0]) && !/then/.test(m[0]);
    cursor = at + m[0].length;
  }
  if (cursor < text.length) bounds.push({ start: cursor, end: text.length, sentenceStart, afterAnd });

  let carry: Carry = null;
  for (const b of bounds) {
    let clause = ` ${text.slice(b.start, b.end)} `;
    const origClause = ` ${original.slice(b.start, b.end)} `;
    if (clause.trim().length === 0) continue;

    if (NEW_TAKE.test(clause)) {
      w.action = 'generate';
      clause = clause.replace(NEW_TAKE, (s) => ' '.repeat(s.length));
    } else if (SAME_AGAIN.test(clause)) {
      w.action = 'again';
      clause = clause.replace(SAME_AGAIN, (s) => ' '.repeat(s.length));
    }
    NEW_TAKE.lastIndex = 0;
    SAME_AGAIN.lastIndex = 0;

    // "I don't like the rain" asks for less of it; "I like the reverb" asks for nothing.
    let dislike = false;
    const hate = DISLIKE.exec(clause);
    if (hate) {
      dislike = true;
      clause = blank(clause, hate.index, hate.index + hate[0].length);
    } else if (LIKE_STATEMENT.test(clause)) {
      if (!w.notes.includes('Good to know. The thumbs up on a take is what teaches the mood.')) {
        w.notes.push('Good to know. The thumbs up on a take is what teaches the mood.');
      }
      continue;
    }

    clause = takeRefusals(clause, origClause, w);
    clause = takeExplicit(clause, w);
    const mood = takeMoodWords(clause, w, dislike, b.afterAnd ? carry : null);
    clause = mood.text;
    carry = mood.led;

    // What is left: unknown words. A capitalised one (not at the start of a sentence)
    // is most likely a name or a title, so it is left out as a reference.
    const firstWord = /[a-z0-9#'-]+/.exec(` ${text.slice(b.start, b.end)} `)?.[0];
    for (const re of [HALF, DOUBLE, NEGATE, TOO, NONE, MAX]) {
      // Amount words that had nothing to act on are filler, not unknown words.
      for (let guard = 0; guard < 6; guard++) {
        const m = re.exec(clause);
        if (!m) break;
        clause = blank(clause, m.index, m.index + m[0].length);
      }
    }
    for (const word of leftoverWords(clause)) {
      const where = new RegExp(`(^|[^a-z0-9])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`).exec(clause);
      const at = where ? where.index + where[1].length : -1;
      const capital = at >= 0 && /\p{Lu}/u.test(origClause.charAt(at));
      const allCaps = at >= 0 && origClause.slice(at, at + word.length) === word.toUpperCase() && word.length > 1;
      const opensSentence = b.sentenceStart && word === firstWord;
      if (capital && !allCaps && !opensSentence) {
        const shown = origClause.slice(at, at + word.length);
        if (!w.refused.includes(shown)) w.refused.push(shown);
      } else if (!ignored.includes(word)) {
        ignored.push(word);
      }
    }
  }

  const changes = diff(before, w.params);
  // Say so when a word was understood but its knob was already at the end.
  if (w.understood.length > 0 && changes.length === 0) {
    w.notes.push('Understood, but those settings are already there, so nothing moved.');
  }
  if (w.refused.length > 0) w.notes.unshift(REFUSAL_TEXT);
  return {
    params: w.params,
    changes,
    understood: w.understood,
    ignored,
    refused: w.refused,
    notes: w.notes,
    action: w.action,
  };
}

/** Example messages for the UI. */
export const CHAT_EXAMPLES: readonly string[] = ['sadder', 'slower', 'more space', 'add rain', 'more reverb', 'a bit brighter', 'no pad'];
