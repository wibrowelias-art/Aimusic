/**
 * The Style Lab view: pick a style family (the shell does that), mix a second one in,
 * add your own words, generate, and run the result through the lo-fi chain with a knob
 * per stage.
 *
 * Two engines:
 *   - "Built-in generator" (default): free. The piece is composed and synthesised in the
 *     browser from a seed. Nothing is sent anywhere. Takes are kept in localStorage.
 *   - "Music AI": the ElevenLabs Music API through the local server (server/plugin.ts).
 *     Costs money, needs a key in .env, shows the exact prompt, and always asks to
 *     confirm the estimated cost first. The page never sees the key.
 */
import {
  Check,
  Download,
  Info,
  LoaderCircle,
  PenLine,
  RotateCcw,
  Scissors,
  Sparkles,
  ThumbsDown,
  ThumbsUp,
  Trash2,
  TriangleAlert,
} from 'lucide';
import { matchSong, type SongMatch } from '../analysis/rhythm';
import { SAMPLE_RATE } from '../audio/constants';
import type { StereoPcm } from '../audio/types';
import { encodeWav } from '../audio/wav';
import { renderPostFx, type PostFxReport } from '../postfx/chain';
import { TARGET_LUFS } from '../postfx/constants';
import {
  normalizePostFx,
  POSTFX_CLEAN,
  POSTFX_KEYS,
  POSTFX_SPECS,
  postFxLabel,
  type PostFxNumericKey,
  type PostFxSettings,
} from '../postfx/settings';
import type { Mode } from '../engine/types';
import { DIP_MAX_DB, makeSketch, matchFx, overlayMelody, parseWords, renderSketch, type Sketch, type SketchRequest } from '../sketch';
import { browserStore, readJson, writeJson, type KeyValueStore } from '../store/storage';
import { estimateCost, formatLength, formatUsd, MUSIC_USD_PER_MINUTE, PRICE_SOURCE } from '../style/cost';
import { checkDescriptors, GUARD_RULE } from '../style/guard';
import { draftLyrics, parseTopics } from '../style/lyrics';
import { KEY_NAMES, MODE_LABELS } from '../engine/params';
import { FAMILY_IDS, PROFILES } from '../style/profiles';
import { blendOf, buildPrompt } from '../style/prompt';
import { buildComposeBody, DEFAULT_MODEL, MODELS, StyleApiError } from '../style/request';
import type { ApiErrorBody, ComposeRequestBody, StyleStatus, StyleTake } from '../style/take';
import { LENGTH_MAX_SEC, LENGTH_MIN_SEC, LENGTH_STEP_SEC, type FamilyId, type StyleRequest } from '../style/types';
import { clear, downloadBytes, h, icon } from './dom';
import { Knob } from './knob';

const STATE_KEY = 'ambientlab.style.v1';
/** Takes of the built-in generator: seed and settings only, the audio is made again. */
const LOCAL_TAKES_KEY = 'ambientlab.sketch.v1';
const LOCAL_TAKES_LIMIT = 40;
const API = '/api/style/';
const CHAIN_DEBOUNCE_MS = 350;

type Engine = 'sketch' | 'ai';

interface LabState {
  engine: Engine;
  a: FamilyId;
  b: FamilyId | null;
  /** Share of `b`, 0..1. */
  mix: number;
  words: string;
  vocals: boolean;
  lengthSec: number;
  modelId: string;
  prompt: string;
  /** True once the prompt was changed by hand: settings no longer rewrite it. */
  promptEdited: boolean;
  topics: string;
  lyrics: string;
  lyricsSeed: number;
  fx: PostFxSettings;
  /** True once a chain knob was turned: the profile preset no longer rewrites it. */
  fxEdited: boolean;
  /** "Match my own song": numbers read from the owner's file, or null. No audio is kept. */
  match: SongMatch | null;
  /** True: Generate plays the owner's own recording and lays a new melody over it. */
  overlay: boolean;
  /** How far the middle of the recording is dipped to make room, dB. */
  dipDb: number;
  /** Loudness of the new melody against the recording, LU. */
  melodyDb: number;
}

interface Decoded {
  id: string;
  full: StereoPcm;
  stems: { vocals: StereoPcm; backing: StereoPcm } | null;
  /** The arrangement, for takes of the built-in generator. */
  sketch: Sketch | null;
}

export interface StyleLabHost {
  toast(text: string): void;
}

class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly suggestion: string | null,
  ) {
    super(message);
  }
}

async function api<T>(route: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(API + route, init);
  } catch {
    throw new ApiError('The local server did not answer. Is "npm run dev" still running?', 'offline', null);
  }
  const text = await res.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    // Not JSON: a static host answered with a page.
  }
  if (!res.ok || body === null) {
    const err = (body as ApiErrorBody | null)?.error;
    if (err) throw new ApiError(err.message, err.code, err.suggestion);
    throw new ApiError('The music AI backend is not there. It runs with "npm run dev" on your computer.', 'offline', null);
  }
  return body as T;
}

const postJson = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

async function decodeToStereo(bytes: ArrayBuffer): Promise<StereoPcm> {
  const ctx = new OfflineAudioContext(2, 1, SAMPLE_RATE);
  const buffer = await ctx.decodeAudioData(bytes);
  const left = buffer.getChannelData(0).slice();
  const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1).slice() : left.slice();
  return [left, right];
}

/** FNV-1a, so every take has its own (stable) hiss and wobble phases. */
function seedOf(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

const db = (v: number, digits = 1): string => (Number.isFinite(v) ? `${v.toFixed(digits)}` : '-inf');
const isSketch = (take: StyleTake): boolean => take.engine === 'sketch';
/** Lets the page paint ("Generating...") before a few seconds of arithmetic. */
const nextPaint = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 40));

function sketchRequestOf(take: StyleTake): SketchRequest {
  return {
    seed: take.seed ?? 1,
    a: take.profileA,
    b: take.profileB,
    mix: take.mix,
    words: take.words,
    vocals: take.vocals,
    lengthSec: take.lengthSec,
    match: take.match ?? null,
    only: take.overlay ? 'melody' : null,
    key: take.overlay && take.overlay.keyPc >= 0 ? { pc: take.overlay.keyPc, mode: take.overlay.mode as Mode } : null,
  };
}

export class StyleLab {
  readonly element: HTMLElement;
  private readonly host: StyleLabHost;
  private readonly kv: KeyValueStore;
  private state: LabState;
  private status: StyleStatus | null = null;
  private statusError: string | null = null;
  private serverTakes: StyleTake[] = [];
  private takes: StyleTake[] = [];
  private current: StyleTake | null = null;
  private decoded: Decoded | null = null;
  private lofi: { pcm: StereoPcm; report: PostFxReport; url: string } | null = null;
  private rawUrl: string | null = null;
  /** The owner's own recording, decoded. Memory only: never stored, gone when the page closes. */
  private song: StereoPcm | null = null;
  /** Takes made on top of that recording: they cannot outlive it. */
  private sessionTakes: StyleTake[] = [];
  private busy = false;
  private chainToken = 0;
  private chainTimer = 0;
  private pendingConfirm: (() => void) | null = null;
  private suggestion: string | null = null;

  private readonly knobs = {} as Record<PostFxNumericKey, Knob>;
  private readonly els: ReturnType<StyleLab['build']>;

  constructor(host: StyleLabHost, kv: KeyValueStore = browserStore()) {
    this.host = host;
    this.kv = kv;
    this.state = this.loadState();
    this.els = this.build();
    this.element = this.els.root;
    this.refreshAll();
    void this.refreshStatus();
    void this.refreshTakes(true);
  }

  // ------------------------------------------------------------------ public

  getProfile(): FamilyId {
    return this.state.a;
  }

  /** The shell calls this when a profile card is picked: a fresh recipe for that family. */
  setProfile(id: FamilyId): void {
    const profile = PROFILES[id];
    this.state = {
      ...this.state,
      a: id,
      b: this.state.b === id ? null : this.state.b,
      vocals: profile.vocalsDefault,
      lengthSec: profile.lengthSec,
      promptEdited: false,
      fxEdited: false,
    };
    this.rebuild();
  }

  /** Pauses both players (the shell calls this when another view takes over). */
  pause(): void {
    this.els.lofiAudio.pause();
    this.els.rawAudio.pause();
  }

  openAbout(): void {
    this.els.about.showModal();
  }

  // ------------------------------------------------------------------ state

  private defaults(a: FamilyId = 'bedroom-demo'): LabState {
    const profile = PROFILES[a];
    const base = { a, b: null, mix: 0.3, words: '', vocals: profile.vocalsDefault, lengthSec: profile.lengthSec };
    return {
      engine: 'sketch',
      ...base,
      modelId: DEFAULT_MODEL,
      prompt: buildPrompt(base),
      promptEdited: false,
      topics: '',
      lyrics: '',
      lyricsSeed: 1,
      fx: profile.fx,
      fxEdited: false,
      match: null,
      overlay: false,
      dipDb: 0,
      melodyDb: -8,
    };
  }

  private loadState(): LabState {
    const fallback = this.defaults();
    const raw = readJson(this.kv, STATE_KEY) as Partial<LabState> | null;
    if (!raw || typeof raw !== 'object') return fallback;
    const isFamily = (v: unknown): v is FamilyId => typeof v === 'string' && (FAMILY_IDS as readonly string[]).includes(v);
    const a = isFamily(raw.a) ? raw.a : fallback.a;
    const base = this.defaults(a);
    const num = (v: unknown, lo: number, hi: number, d: number): number =>
      typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;
    return {
      engine: raw.engine === 'ai' ? 'ai' : 'sketch',
      a,
      b: isFamily(raw.b) && raw.b !== a ? raw.b : null,
      mix: num(raw.mix, 0, 1, base.mix),
      words: typeof raw.words === 'string' ? raw.words : '',
      vocals: typeof raw.vocals === 'boolean' ? raw.vocals : base.vocals,
      lengthSec: num(raw.lengthSec, LENGTH_MIN_SEC, LENGTH_MAX_SEC, base.lengthSec),
      modelId: typeof raw.modelId === 'string' && (MODELS as readonly string[]).includes(raw.modelId) ? raw.modelId : DEFAULT_MODEL,
      prompt: typeof raw.prompt === 'string' && raw.prompt ? raw.prompt : base.prompt,
      promptEdited: raw.promptEdited === true,
      topics: typeof raw.topics === 'string' ? raw.topics : '',
      lyrics: typeof raw.lyrics === 'string' ? raw.lyrics : '',
      lyricsSeed: num(raw.lyricsSeed, 1, 1e9, 1),
      fx: raw.fx ? normalizePostFx(raw.fx) : base.fx,
      fxEdited: raw.fxEdited === true,
      match: raw.match && Array.isArray(raw.match.grid) && typeof raw.match.tempoBpm === 'number' ? raw.match : null,
      overlay: raw.overlay === true,
      dipDb: num(raw.dipDb, 0, DIP_MAX_DB, 0),
      melodyDb: num(raw.melodyDb, -18, 0, -8),
    };
  }

  private save(): void {
    writeJson(this.kv, STATE_KEY, this.state);
  }

  private request(): StyleRequest {
    const { a, b, mix, words, vocals, lengthSec } = this.state;
    return { a, b, mix: b ? mix : 0, words, vocals, lengthSec };
  }

  /** The chain preset of the current recipe. The built-in generator also reads the words for it. */
  private presetFx(): PostFxSettings {
    const blend = blendOf(this.request()).fx;
    if (this.state.engine !== 'sketch') return blend;
    return parseWords(this.state.words).fx(this.state.match ? matchFx(this.state.match, blend) : blend);
  }

  /** Settings changed: rewrite the prompt and the chain preset unless they were edited by hand. */
  private rebuild(): void {
    if (!this.state.promptEdited) this.state.prompt = buildPrompt(this.request());
    if (!this.state.fxEdited) this.state.fx = this.presetFx();
    this.save();
    this.refreshAll();
    if (!this.state.fxEdited) this.scheduleChain();
  }

  private usdPerMinute(): number {
    return this.status?.usdPerMinute ?? MUSIC_USD_PER_MINUTE;
  }

  private isMock(): boolean {
    return this.status?.mock === true;
  }

  private localTakes(): StyleTake[] {
    const raw = readJson(this.kv, LOCAL_TAKES_KEY);
    if (!Array.isArray(raw)) return [];
    return (raw as StyleTake[]).filter((t) => t && t.engine === 'sketch' && typeof t.id === 'string' && (FAMILY_IDS as readonly string[]).includes(t.profileA));
  }

  private saveLocalTakes(takes: StyleTake[]): void {
    writeJson(this.kv, LOCAL_TAKES_KEY, takes.slice(0, LOCAL_TAKES_LIMIT));
  }

  private mergeTakes(): void {
    this.takes = [...this.sessionTakes, ...this.localTakes(), ...this.serverTakes].sort((x, y) => (x.createdAt < y.createdAt ? 1 : -1));
  }

  // ------------------------------------------------------------------ build

  private build() {
    const banner = h('div', { class: 'sl-banner', role: 'status' });

    // Engine
    const engineButton = (engine: Engine, title: string, sub: string): HTMLButtonElement =>
      h(
        'button',
        {
          class: 'sl-engine-option',
          type: 'button',
          role: 'radio',
          dataset: { engine },
          onclick: () => {
            if (this.state.engine === engine) return;
            this.state.engine = engine;
            this.rebuild();
          },
        },
        h('span', { class: 'sl-engine-name' }, title),
        h('span', { class: 'sl-engine-sub' }, sub),
      );
    const engines = h(
      'div',
      { class: 'sl-engine', role: 'radiogroup', 'aria-label': 'How the music is made' },
      engineButton('sketch', 'Built-in generator', 'Free. Made on this computer, nothing is sent.'),
      engineButton('ai', 'Music AI', 'Paid. ElevenLabs, needs your key.'),
    );

    // Recipe
    const mixSelect = h('select', {
      'aria-label': 'Mix with a second profile',
      onchange: () => {
        const v = mixSelect.value;
        this.state.b = v === '' ? null : (v as FamilyId);
        this.rebuild();
      },
    });
    const mixRange = h('input', {
      type: 'range',
      class: 'sl-range',
      min: '0',
      max: '100',
      step: '5',
      'aria-label': 'Share of the second profile',
      oninput: () => {
        this.state.mix = Number(mixRange.value) / 100;
        this.rebuild();
      },
    });
    const mixText = h('span', { class: 'sl-mix-text' });
    const words = h('input', {
      type: 'text',
      class: 'sl-input',
      placeholder: 'e.g. more tape hiss, no drums',
      maxlength: '200',
      'aria-label': 'Your own words',
      oninput: () => {
        this.state.words = words.value;
        this.rebuild();
      },
    });
    const vocals = h('input', {
      type: 'checkbox',
      class: 'sl-switch',
      role: 'switch',
      onchange: () => {
        this.state.vocals = vocals.checked;
        this.rebuild();
      },
    });
    const vocalsHint = h('span', { class: 'sl-vocals-hint' });
    const lengthRange = h('input', {
      type: 'range',
      class: 'sl-range',
      min: String(LENGTH_MIN_SEC),
      max: String(LENGTH_MAX_SEC),
      step: String(LENGTH_STEP_SEC),
      'aria-label': 'Length of the generation',
      oninput: () => {
        this.state.lengthSec = Number(lengthRange.value);
        this.rebuild();
      },
    });
    const lengthText = h('span', { class: 'sl-length-text' });
    const model = h('select', {
      'aria-label': 'Model',
      onchange: () => {
        this.state.modelId = model.value;
        this.save();
        this.refreshPrompt();
      },
    });
    for (const id of MODELS) model.append(h('option', { value: id }, id));
    const modelField = h('label', { class: 'field sl-model' }, 'Model', model);

    // Plan (built-in generator)
    const planList = h('ul', { class: 'sl-plan-list' });
    const planWords = h('div', { class: 'sl-plan-words' });
    const matchOwn = h('input', { type: 'checkbox', onchange: () => (matchFile.disabled = !matchOwn.checked) });
    const matchFile = h('input', {
      type: 'file',
      accept: 'audio/*',
      disabled: true,
      'aria-label': 'Your own song',
      onchange: () => void this.readMatch(matchFile),
    });
    const matchInfo = h('p', { class: 'sl-match-info' });
    const matchClear = h(
      'button',
      {
        class: 'btn small',
        type: 'button',
        onclick: () => {
          this.state.match = null;
          this.song = null;
          matchFile.value = '';
          this.rebuild();
        },
      },
      'Stop matching',
    );
    const overlayOn = h('input', {
      type: 'checkbox',
      onchange: () => {
        this.state.overlay = overlayOn.checked;
        this.save();
        this.refreshAll();
      },
    });
    const dipRange = h('input', {
      type: 'range',
      class: 'sl-range',
      min: '0',
      max: String(DIP_MAX_DB),
      step: '1',
      'aria-label': 'Push the original melody back',
      oninput: () => {
        this.state.dipDb = Number(dipRange.value);
        this.save();
        this.refreshPlan();
      },
    });
    const melodyRange = h('input', {
      type: 'range',
      class: 'sl-range',
      min: '-18',
      max: '0',
      step: '1',
      'aria-label': 'Level of the new melody',
      oninput: () => {
        this.state.melodyDb = Number(melodyRange.value);
        this.save();
        this.refreshPlan();
      },
    });
    const dipText = h('span', { class: 'sl-mix-text' });
    const melodyText = h('span', { class: 'sl-mix-text' });
    const overlayNote = h('p', { class: 'hint' });
    const overlaySliders = h(
      'div',
      { class: 'sl-grid' },
      h('label', { class: 'field' }, h('span', null, 'Push the original melody back'), dipRange, dipText),
      h('label', { class: 'field' }, h('span', null, 'Level of the new melody'), melodyRange, melodyText),
    );
    const overlayBox = h(
      'div',
      { class: 'sl-overlay' },
      h('label', { class: 'sl-match-own' }, overlayOn, 'Play my recording itself and add a new melody on top'),
      overlaySliders,
      overlayNote,
    );
    const matchBox = h(
      'div',
      { class: 'sl-match' },
      h('h3', null, 'Match my own song (rhythm + tone)'),
      h('label', { class: 'sl-match-own' }, matchOwn, 'This song is mine: I made it or I hold the rights to it.'),
      h('div', { class: 'sl-row' }, matchFile, matchClear),
      matchInfo,
      overlayBox,
      h(
        'p',
        { class: 'hint' },
        'Reads the tempo, where the hits fall in the bar (16 numbers), the brightness and the reverb length. The guitar, bass and drum parts then play on your rhythm and the chain is set to your tone. No melody and no chords are read; the notes stay new. The file stays in the browser and is not kept.',
      ),
    );
    const planPanel = h(
      'section',
      { class: 'panel sl-plan', 'aria-label': 'What it will play' },
      h('h2', null, 'What it will play'),
      planList,
      planWords,
      matchBox,
      h(
        'p',
        { class: 'hint' },
        'The notes come from a seeded composer and are played by synthesised instruments. No recordings, no music AI. Every Generate is a new piece.',
      ),
    );

    // Prompt (music AI)
    const promptText = h('textarea', {
      class: 'sl-prompt-text',
      rows: '13',
      spellcheck: 'false',
      'aria-label': 'Prompt text that is sent to the music API',
      oninput: () => {
        this.state.prompt = promptText.value;
        this.state.promptEdited = promptText.value !== buildPrompt(this.request());
        this.save();
        this.refreshPrompt();
      },
    });
    const promptNote = h('span', { class: 'sl-prompt-note' });
    const rebuildBtn = h(
      'button',
      {
        class: 'btn small',
        type: 'button',
        title: 'Throw away the hand edits and write the prompt from the settings again',
        onclick: () => {
          this.state.promptEdited = false;
          this.rebuild();
        },
      },
      icon(RotateCcw, 13),
      'Rebuild from settings',
    );
    const guardList = h('ul', { class: 'sl-guard', role: 'alert' });
    const suggestionBox = h('div', { class: 'sl-suggestion' });

    const topics = h('input', {
      type: 'text',
      class: 'sl-input',
      placeholder: 'your topics, e.g. the bus stop, cold coffee, my brother',
      maxlength: '300',
      'aria-label': 'Topic words for the lyrics draft',
      oninput: () => {
        this.state.topics = topics.value;
        this.save();
        draftBtn.disabled = parseTopics(topics.value).length === 0;
      },
    });
    const draftBtn = h(
      'button',
      {
        class: 'btn small',
        type: 'button',
        title: 'Writes short plain lines around your topic words. Press again for another draft.',
        onclick: () => {
          const text = draftLyrics(this.state.topics, this.state.lyricsSeed);
          this.state.lyricsSeed += 1;
          this.state.lyrics = text;
          this.save();
          this.refreshPrompt();
        },
      },
      icon(PenLine, 13),
      'Draft lyrics',
    );
    const lyricsText = h('textarea', {
      class: 'sl-lyrics-text',
      rows: '8',
      spellcheck: 'false',
      placeholder: 'Empty = the music AI writes its own words. Your own lines only, nothing from existing songs.',
      'aria-label': 'Lyrics',
      oninput: () => {
        this.state.lyrics = lyricsText.value;
        this.save();
        this.refreshPrompt();
      },
    });
    const lyricsNote = h('p', { class: 'hint sl-lyrics-note' });
    const lyricsBlock = h(
      'div',
      { class: 'sl-lyrics' },
      h('h3', null, 'Lyrics (optional)'),
      h('div', { class: 'sl-row' }, topics, draftBtn),
      lyricsText,
      lyricsNote,
    );
    const requestPre = h('pre', { class: 'sl-request' });
    const promptPanel = h(
      'section',
      { class: 'panel sl-prompt', 'aria-label': 'Prompt' },
      h('div', { class: 'sl-prompt-head' }, h('h2', null, 'Prompt - exactly what is sent'), promptNote, rebuildBtn),
      promptText,
      guardList,
      suggestionBox,
      lyricsBlock,
      h('details', { class: 'sl-details' }, h('summary', null, 'The exact request (JSON)'), requestPre),
    );

    // Generate
    const generateLabel = h('span', { class: 'generate-label' }, 'Generate');
    const generate = h(
      'button',
      { class: 'sl-generate', type: 'button', onclick: () => this.onGenerate() },
      icon(Sparkles, 22),
      generateLabel,
    );
    const costText = h('div', { class: 'sl-cost' });

    // Result
    const resultTitle = h('span', { class: 'sl-take-title' });
    const resultSub = h('span', { class: 'sl-take-sub' });
    const lofiAudio = h('audio', { controls: true, preload: 'metadata', class: 'sl-audio' });
    const rawAudio = h('audio', { controls: true, preload: 'metadata', class: 'sl-audio' });
    lofiAudio.addEventListener('play', () => rawAudio.pause());
    rawAudio.addEventListener('play', () => lofiAudio.pause());
    const rawLabel = h('span', null, 'Raw');
    const chainStatus = h('span', { class: 'sl-chain-status', role: 'status', 'aria-live': 'polite' });
    const metrics = h('table', { class: 'sl-metrics' });
    const downloadLofi = h(
      'button',
      { class: 'btn small', type: 'button', title: 'Download the lo-fi version as a WAV file', onclick: () => this.downloadLofi() },
      icon(Download, 14),
      'Lo-fi WAV',
    );
    const downloadRaw = h('a', { class: 'btn small', title: 'Download the version before the lo-fi chain' }, icon(Download, 14), 'Raw file');
    const stemsBtn = h(
      'button',
      { class: 'btn small', type: 'button', onclick: () => this.askStems() },
      icon(Scissors, 14),
      h('span', null, 'Separate vocals'),
    );
    const up = h('button', { class: 'btn small icon-only', type: 'button', 'aria-label': 'Like this take', onclick: () => void this.rate(1) }, icon(ThumbsUp, 14));
    const down = h(
      'button',
      { class: 'btn small icon-only down', type: 'button', 'aria-label': 'Dislike this take', onclick: () => void this.rate(-1) },
      icon(ThumbsDown, 14),
    );
    const result = h(
      'section',
      { class: 'panel sl-result', 'aria-label': 'Current take' },
      h('div', { class: 'sl-take-line' }, resultTitle, resultSub),
      h(
        'div',
        { class: 'sl-players' },
        h('label', { class: 'sl-player' }, h('span', null, 'Lo-fi (after the chain)'), lofiAudio),
        h('label', { class: 'sl-player' }, rawLabel, rawAudio),
      ),
      h('div', { class: 'sl-actions' }, downloadLofi, downloadRaw, stemsBtn, up, down, chainStatus),
      metrics,
    );

    // Chain
    const roomType = h('select', {
      'aria-label': 'Room type',
      onchange: () => {
        this.state.fx = normalizePostFx({ ...this.state.fx, roomType: roomType.value === 'hall' ? 'hall' : 'room' });
        this.onFxEdited();
      },
    });
    roomType.append(h('option', { value: 'room' }, 'Small room'), h('option', { value: 'hall' }, 'Big hall'));
    const knobGrid = h('div', { class: 'knob-grid sl-knobs' });
    for (const key of POSTFX_KEYS) {
      const spec = POSTFX_SPECS[key];
      const knob = new Knob({
        label: spec.label,
        min: spec.min,
        max: spec.max,
        step: spec.step,
        value: this.state.fx[key],
        format: (v) => postFxLabel(key, v),
        title: `${spec.title}. Drag up or down, or use the arrow keys.`,
        pinnable: false,
        onChange: (v) => {
          this.state.fx = normalizePostFx({ ...this.state.fx, [key]: v });
          this.onFxEdited();
        },
      });
      this.knobs[key] = knob;
      knobGrid.append(knob.element);
    }
    const resetFx = h(
      'button',
      {
        class: 'btn small',
        type: 'button',
        title: 'Back to the preset of the chosen profile (or mix)',
        onclick: () => {
          this.state.fxEdited = false;
          this.rebuild();
        },
      },
      icon(RotateCcw, 13),
      'Profile preset',
    );
    const fxNote = h('p', { class: 'hint' });

    const takeList = h('ul', { class: 'sl-takes' });

    // Confirm dialog
    const confirmBody = h('div', { class: 'sl-confirm-body' });
    const confirmOk = h('button', { class: 'btn sl-confirm-ok', type: 'button' }, icon(Check, 15), h('span', null, 'Confirm'));
    const confirm = h(
      'dialog',
      { class: 'sl-confirm', 'aria-label': 'Confirm the cost' },
      h('h2', null, 'Confirm before it costs anything'),
      confirmBody,
      h(
        'div',
        { class: 'dialog-actions' },
        h('button', { class: 'btn ghost', type: 'button', onclick: () => confirm.close() }, 'Cancel'),
        confirmOk,
      ),
    );
    confirmOk.addEventListener('click', () => {
      const run = this.pendingConfirm;
      this.pendingConfirm = null;
      confirm.close();
      run?.();
    });
    confirm.addEventListener('close', () => {
      this.pendingConfirm = null;
    });

    const about = this.buildAbout();

    const root = h(
      'div',
      { class: 'sl' },
      h(
        'main',
        { class: 'layout' },
        h(
          'section',
          { class: 'stage', 'aria-label': 'Recipe and result' },
          engines,
          banner,
          h(
            'section',
            { class: 'panel sl-recipe', 'aria-label': 'Recipe' },
            h('h2', null, 'Recipe'),
            h(
              'div',
              { class: 'sl-grid' },
              h('label', { class: 'field' }, 'Mix with', mixSelect),
              h('label', { class: 'field sl-mix' }, h('span', null, 'How much of it'), mixRange, mixText),
              h('label', { class: 'field sl-words' }, 'Your own words', words),
              h('label', { class: 'field sl-vocals' }, 'Vocals', vocals, vocalsHint),
              h('label', { class: 'field sl-length' }, h('span', null, 'Length'), lengthRange, lengthText),
              modelField,
            ),
          ),
          planPanel,
          promptPanel,
          h('div', { class: 'hero sl-hero' }, generate, costText),
          result,
        ),
        h(
          'aside',
          { class: 'side' },
          h(
            'section',
            { class: 'panel', 'aria-label': 'Lo-fi chain' },
            h('h2', null, 'Lo-fi chain'),
            h('div', { class: 'sl-chain-top' }, h('label', { class: 'field' }, 'Room type', roomType), resetFx),
            knobGrid,
            fxNote,
          ),
          h('section', { class: 'panel', 'aria-label': 'Generations' }, h('h2', null, 'Generations'), takeList),
        ),
      ),
      confirm,
      about,
    );

    return {
      root,
      banner,
      engines,
      mixSelect,
      mixRange,
      mixText,
      words,
      vocals,
      vocalsHint,
      lengthRange,
      lengthText,
      model,
      modelField,
      planPanel,
      planList,
      planWords,
      matchInfo,
      matchClear,
      overlayBox,
      overlayOn,
      overlaySliders,
      overlayNote,
      dipRange,
      dipText,
      melodyRange,
      melodyText,
      promptPanel,
      promptText,
      promptNote,
      rebuildBtn,
      guardList,
      suggestionBox,
      topics,
      draftBtn,
      lyricsText,
      lyricsNote,
      lyricsBlock,
      requestPre,
      generate,
      generateLabel,
      costText,
      result,
      resultTitle,
      resultSub,
      lofiAudio,
      rawAudio,
      rawLabel,
      chainStatus,
      metrics,
      downloadLofi,
      downloadRaw,
      stemsBtn,
      up,
      down,
      roomType,
      resetFx,
      fxNote,
      takeList,
      confirm,
      confirmBody,
      confirmOk,
      about,
    };
  }

  private buildAbout(): HTMLDialogElement {
    const dialog = h(
      'dialog',
      { class: 'about', 'aria-label': 'About the Style Lab' },
      h('h2', null, 'Style Lab'),
      h(
        'p',
        null,
        'Pick a style family, mix a second one in, add your own words, press Generate. Then the lo-fi chain makes the result rougher: tape, room, bedroom mic, hiss, slowed.',
      ),
      h('h3', null, 'Two ways to make the music'),
      h(
        'ul',
        null,
        h(
          'li',
          null,
          'Built-in generator (free): a seeded composer writes chords and a melody, synthesised instruments play them. It runs in your browser. It cannot sing words; "Vocals" adds a wordless synth voice.',
        ),
        h(
          'li',
          null,
          'Music AI (paid): the ElevenLabs Music API makes a song from a prompt of plain sound descriptors. It needs your API key in .env, shows the estimated cost and waits for your yes every time.',
        ),
      ),
      h('h3', null, 'What it never does'),
      h(
        'ul',
        null,
        h('li', null, 'It never sends an artist name or a song title anywhere. The prompt is checked on this page and again on the local server.'),
        h('li', null, 'It never copies a melody, chords, lyrics or a recording. The families are lists of general traits; STYLES.md has the sources.'),
        h('li', null, 'It never spends money without asking. The built-in generator spends none at all.'),
      ),
      h('h3', null, 'Numbers, not opinions'),
      h(
        'p',
        null,
        `The lab cannot hear. It measures: loudness (target ${TARGET_LUFS} LUFS), peak (below -1 dBFS), hiss level, high-cut, pitch change. Whether it is any good is yours to say.`,
      ),
      h('div', { class: 'dialog-actions' }, h('button', { class: 'btn', type: 'button', onclick: () => dialog.close() }, 'Close')),
    );
    return dialog;
  }

  // ------------------------------------------------------------------ refresh

  private refreshAll(): void {
    const { els, state } = this;
    const sketch = state.engine === 'sketch';
    for (const option of els.engines.querySelectorAll<HTMLElement>('.sl-engine-option')) {
      option.setAttribute('aria-checked', String(option.dataset.engine === state.engine));
    }
    els.planPanel.hidden = !sketch;
    els.promptPanel.hidden = sketch;
    els.modelField.hidden = sketch;
    els.vocalsHint.textContent = sketch ? 'a wordless synth voice (it cannot sing words)' : '';

    clear(els.mixSelect);
    els.mixSelect.append(h('option', { value: '' }, 'Nothing'));
    for (const id of FAMILY_IDS) {
      if (id !== state.a) els.mixSelect.append(h('option', { value: id }, PROFILES[id].label));
    }
    els.mixSelect.value = state.b ?? '';
    els.mixRange.value = String(Math.round(state.mix * 100));
    els.mixRange.disabled = state.b === null;
    const pct = Math.round(state.mix * 100);
    els.mixText.textContent = state.b
      ? `${100 - pct}% ${PROFILES[state.a].label} + ${pct}% ${PROFILES[state.b].label}`
      : `100% ${PROFILES[state.a].label}`;
    if (els.words.value !== state.words) els.words.value = state.words;
    els.vocals.checked = state.vocals;
    els.lengthRange.value = String(state.lengthSec);
    els.model.value = state.modelId;
    if (els.topics.value !== state.topics) els.topics.value = state.topics;
    this.refreshFx();
    this.refreshPlan();
    this.refreshPrompt();
    this.refreshBanner();
  }

  private refreshFx(): void {
    const { els, state } = this;
    for (const key of POSTFX_KEYS) this.knobs[key].setValue(state.fx[key]);
    els.roomType.value = state.fx.roomType;
    els.resetFx.disabled = !state.fxEdited;
    const slowed = state.fx.slowedPct;
    const length = slowed > 0 ? ` After slowing, ${formatLength(state.lengthSec)} becomes about ${formatLength(state.lengthSec / (1 - slowed / 100))}.` : '';
    els.fxNote.textContent = `The chain runs here and costs nothing. Turn a knob and the lo-fi version renders again.${length}`;
    els.lengthText.textContent = formatLength(state.lengthSec);
  }

  /** Decodes the owner's file, keeps the numbers, drops the audio. */
  private async readMatch(input: HTMLInputElement): Promise<void> {
    const file = input.files?.[0];
    if (!file) return;
    this.els.matchInfo.textContent = 'Reading...';
    try {
      const ctx = new OfflineAudioContext(2, 1, SAMPLE_RATE);
      const buffer = await ctx.decodeAudioData(await file.arrayBuffer());
      const frames = Math.min(buffer.length, SAMPLE_RATE * 300);
      const channels = Array.from({ length: buffer.numberOfChannels }, (_, ch) => buffer.getChannelData(ch).slice(0, frames));
      await nextPaint();
      const match = matchSong(channels, buffer.sampleRate);
      if (!match) {
        this.els.matchInfo.textContent = 'No steady tempo found in that file, so there is no rhythm to match.';
        return;
      }
      this.state.match = match;
      this.song = [channels[0], channels[1] ?? channels[0].slice()];
      this.state.fxEdited = false;
      this.rebuild();
    } catch {
      this.els.matchInfo.textContent = 'That file could not be read as audio.';
    }
  }

  /** The built-in generator's plan: which parts play, and what it made of the owner's words. */
  private refreshPlan(): void {
    const { els, state } = this;
    if (state.engine !== 'sketch') return;
    const m = state.match;
    els.matchClear.hidden = m === null;
    els.overlayBox.hidden = m === null;
    els.overlayOn.checked = state.overlay;
    els.overlaySliders.hidden = !state.overlay;
    els.dipRange.value = String(state.dipDb);
    els.melodyRange.value = String(state.melodyDb);
    els.dipText.textContent = state.dipDb === 0 ? 'off' : `-${state.dipDb} dB around 1.5 kHz, centre only`;
    els.melodyText.textContent = `${state.melodyDb} dB against the recording`;
    els.overlayNote.textContent = !state.overlay
      ? ''
      : this.song === null
        ? 'Pick the file again: the recording is only held while the page is open.'
        : `Your recording plays as it is (its own sounds, background, rhythm and tone). A new melody${m && m.keyPc !== null && m.mode ? ` in its key (${KEY_NAMES[m.keyPc]} ${MODE_LABELS[m.mode].toLowerCase()}, the least certain reading)` : ' (the key of the file was not clear, so it may clash)'} is laid over it. The original melody stays in the recording; the first slider can only push it back roughly. These takes are not kept after the page closes, because the recording is not stored.`;
    if (m) {
      const hits = m.grid.map((v) => (v >= 0.6 ? 'X' : v >= 0.3 ? 'x' : '.')).join('');
      els.matchInfo.textContent = `Matching: ${m.tempoBpm} BPM (read ${m.readTempoBpm}), hits per sixteenth ${hits}, brightness ${m.brightnessHz} Hz, reverb ${m.decaySec === null ? 'not found' : `${m.decaySec.toFixed(1)} s`}.`;
    } else if (!els.matchInfo.textContent?.startsWith('No steady') && !els.matchInfo.textContent?.startsWith('That file')) {
      els.matchInfo.textContent = '';
    }
    // The parts do not depend on the seed, so any seed shows the right list.
    const preview = makeSketch({ ...this.request(), seed: 1, match: state.match });
    clear(els.planList);
    for (const track of preview.tracks) els.planList.append(h('li', { dataset: { group: track.group } }, track.label));
    clear(els.planWords);
    const { understood, ignored } = preview.words;
    if (understood.length > 0) {
      els.planWords.append(h('p', { class: 'sl-understood' }, 'From your words: ', understood.join('; '), '.'));
    }
    if (ignored.length > 0) {
      els.planWords.append(
        h(
          'p',
          { class: 'sl-ignored' },
          `Not understood by the built-in generator: ${ignored.map((w) => `"${w}"`).join(', ')}. `,
          'It knows: no / more / less / add + drums, guitar, bass, keys, pads, voice, hiss, reverb, wobble, saturation, space; and slower, faster, darker, brighter, sadder, happier, sparser, busier.',
        ),
      );
    }
  }

  /** Everything that depends on the prompt text: guard, request preview, cost, the button. */
  private refreshPrompt(): void {
    const { els, state } = this;
    const sketch = state.engine === 'sketch';
    if (els.promptText.value !== state.prompt) els.promptText.value = state.prompt;
    if (els.lyricsText.value !== state.lyrics) els.lyricsText.value = state.lyrics;
    els.promptNote.textContent = state.promptEdited ? 'edited by hand - settings no longer change it' : '';
    els.rebuildBtn.hidden = !state.promptEdited;
    els.lyricsBlock.hidden = !state.vocals;
    els.draftBtn.disabled = parseTopics(state.topics).length === 0;

    const guard = checkDescriptors(state.prompt);
    clear(els.guardList);
    if (!guard.ok) {
      els.guardList.append(h('li', { class: 'sl-guard-rule' }, icon(TriangleAlert, 14), GUARD_RULE));
      for (const issue of guard.issues) els.guardList.append(h('li', null, issue.message));
    }
    els.guardList.hidden = guard.ok;

    let requestError: string | null = null;
    let usesPlan = false;
    try {
      const body = buildComposeBody({
        prompt: state.prompt,
        lengthSec: state.lengthSec,
        vocals: state.vocals,
        lyrics: state.lyrics,
        modelId: state.modelId,
      });
      usesPlan = 'composition_plan' in body;
      els.requestPre.textContent = `POST https://api.elevenlabs.io/v1/music\n${JSON.stringify(body, null, 2)}`;
    } catch (err) {
      requestError = err instanceof StyleApiError ? err.message : String(err);
      els.requestPre.textContent = `Nothing would be sent: ${requestError}`;
    }
    els.lyricsNote.textContent = usesPlan
      ? 'With your own lyrics the request goes out as a plan: an intro without words, one part per block of lines, an outro. See the exact request below.'
      : 'The draft button builds lines from your topic words with a small grammar. It takes nothing from any song. Edit freely.';

    clear(els.suggestionBox);
    if (this.suggestion) {
      const text = this.suggestion;
      els.suggestionBox.append(
        h('p', null, 'The music API refused the prompt and suggests this instead:'),
        h('pre', null, text),
        h(
          'button',
          {
            class: 'btn small',
            type: 'button',
            onclick: () => {
              this.suggestion = null;
              this.state.prompt = text;
              this.state.promptEdited = true;
              this.save();
              this.refreshPrompt();
            },
          },
          'Use the suggestion',
        ),
      );
    }
    els.suggestionBox.hidden = this.suggestion === null;

    const mock = this.isMock();
    clear(els.costText);
    let blocked = this.busy;
    if (sketch) {
      els.costText.append(h('strong', null, 'Free'), h('span', null, 'Made on this computer by the built-in generator. Nothing is sent anywhere.'));
    } else if (mock) {
      els.costText.append(h('strong', null, 'Mock mode: free'), h('span', null, 'A test signal comes back, the music API is not called.'));
      blocked ||= requestError !== null || this.status === null;
    } else {
      const cost = estimateCost(state.lengthSec, { usdPerMinute: this.usdPerMinute() });
      els.costText.append(
        h('strong', null, `About ${formatUsd(cost.usd)}`),
        h('span', null, `${formatLength(state.lengthSec)} at $${cost.usdPerMinute.toFixed(2)} per minute. You confirm before anything is sent.`),
      );
      blocked ||= requestError !== null || this.status === null || !this.status.keyPresent;
    }
    els.generate.disabled = blocked;
    els.generate.classList.toggle('is-busy', this.busy);
    els.generateLabel.textContent = this.busy ? 'Generating...' : 'Generate';
    els.generate.replaceChildren(icon(this.busy ? LoaderCircle : Sparkles, 22), els.generateLabel);
  }

  private refreshBanner(): void {
    const { banner } = this.els;
    clear(banner);
    let text: string | null = null;
    if (this.state.engine === 'ai') {
      if (this.statusError) text = `${this.statusError} The built-in generator works without it.`;
      else if (this.status?.mock) text = 'Mock mode is on (STYLE_LAB_MOCK=1): Generate returns a test signal, nothing is billed.';
      else if (this.status && !this.status.keyPresent) {
        text = 'No API key yet. Copy .env.example to .env, put your ElevenLabs key in, and reload. The built-in generator needs no key.';
      }
    }
    banner.hidden = text === null;
    if (text) banner.append(icon(Info, 15), h('span', null, text));
  }

  private async refreshStatus(): Promise<void> {
    try {
      this.status = await api<StyleStatus>('status');
      this.statusError = null;
    } catch (err) {
      this.status = null;
      this.statusError = err instanceof Error ? err.message : String(err);
    }
    this.refreshBanner();
    this.refreshPrompt();
  }

  private async refreshTakes(loadLatest = false): Promise<void> {
    try {
      this.serverTakes = await api<StyleTake[]>('takes');
    } catch {
      this.serverTakes = [];
    }
    this.mergeTakes();
    this.renderTakes();
    if (loadLatest && this.takes[0] && !this.current) void this.loadTake(this.takes[0]);
    else this.refreshResult();
  }

  private takeLabel(take: StyleTake): string {
    const a = PROFILES[take.profileA]?.label ?? take.profileA;
    if (!take.profileB || take.mix <= 0) return a;
    const pct = Math.round(take.mix * 100);
    return `${100 - pct}% ${a} + ${pct}% ${PROFILES[take.profileB]?.label ?? take.profileB}`;
  }

  private renderTakes(): void {
    const list = this.els.takeList;
    clear(list);
    if (this.takes.length === 0) {
      list.append(h('li', { class: 'empty' }, 'Nothing generated yet. Every generation is kept here.'));
      return;
    }
    for (const take of this.takes) {
      const when = new Date(take.createdAt);
      const date = Number.isNaN(when.getTime()) ? '' : `${when.toLocaleDateString()} ${when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
      const kind = isSketch(take) ? 'built-in, free' : take.mock ? 'test signal' : `music AI, ${formatUsd(take.costUsd)}`;
      const voice = take.vocals ? (isSketch(take) ? 'wordless voice' : 'vocals') : 'instrumental';
      list.append(
        h(
          'li',
          { class: take.id === this.current?.id ? 'sl-take is-current' : 'sl-take' },
          h(
            'button',
            { class: 'sl-take-load', type: 'button', onclick: () => void this.loadTake(take) },
            h('span', { class: 'sl-take-name' }, this.takeLabel(take), take.rating === 1 ? ' +' : take.rating === -1 ? ' -' : ''),
            h('span', { class: 'sl-take-meta' }, `${formatLength(take.lengthSec)} - ${voice} - ${kind} - ${date}`),
          ),
          h(
            'button',
            {
              class: 'btn small icon-only ghost',
              type: 'button',
              'aria-label': 'Delete this generation',
              title: 'Delete this generation',
              onclick: () => void this.deleteTake(take),
            },
            icon(Trash2, 13),
          ),
        ),
      );
    }
  }

  private refreshResult(): void {
    const { els } = this;
    const take = this.current;
    els.result.hidden = take === null;
    if (!take) return;
    const sketch = isSketch(take);
    els.resultTitle.textContent = this.takeLabel(take);
    els.resultSub.textContent = sketch
      ? `${formatLength(take.lengthSec)} - built-in generator, free - seed ${take.seed ?? 0}`
      : `${formatLength(take.lengthSec)} - ${take.model} - ${take.mock ? 'test signal, no cost' : `estimate ${formatUsd(take.costUsd)}`}`;
    els.rawLabel.textContent = sketch ? 'Raw (before the chain)' : 'Raw (from the music AI)';
    els.up.setAttribute('aria-pressed', String(take.rating === 1));
    els.down.setAttribute('aria-pressed', String(take.rating === -1));
    if (sketch) {
      if (this.rawUrl) els.downloadRaw.setAttribute('href', this.rawUrl);
      else els.downloadRaw.removeAttribute('href');
      els.downloadRaw.setAttribute('download', `${take.id}-raw.wav`);
    } else {
      els.downloadRaw.setAttribute('href', `${API}audio/${take.audioFile}`);
      els.downloadRaw.setAttribute('download', take.audioFile);
    }
    els.downloadLofi.disabled = this.lofi === null;
    const stemCost = take.mock ? 0 : estimateCost(take.lengthSec, { stems: true, usdPerMinute: this.usdPerMinute() }).lines[1].usd;
    els.stemsBtn.hidden = sketch || (!take.vocals && !take.mock);
    els.stemsBtn.disabled = take.stems !== null || this.busy;
    els.stemsBtn.lastElementChild!.textContent = take.stems ? 'Vocals separated' : `Separate vocals (${take.mock ? 'free' : `about ${formatUsd(stemCost)}`})`;
    els.stemsBtn.title = 'Splits the song into vocals and the rest, so the vocal blur knob can act on the voice alone';
    this.renderMetrics();
  }

  private renderMetrics(): void {
    const table = this.els.metrics;
    clear(table);
    const report = this.lofi?.report;
    if (!report) return;
    const m = report.master;
    const row = (label: string, value: string, note = ''): HTMLElement =>
      h('tr', null, h('th', { scope: 'row' }, label), h('td', null, value), h('td', { class: 'sl-metric-note' }, note));
    table.append(h('caption', null, 'Measured on the lo-fi version'));
    const sketch = this.decoded?.id === this.current?.id ? this.decoded?.sketch : null;
    if (sketch) {
      table.append(
        row('Key and tempo', `${sketch.keyLabel}, ${sketch.tempo} BPM`, `${sketch.bars} bars`),
        row('Parts', String(sketch.tracks.length), sketch.tracks.map((t) => t.label).join(', ')),
      );
    }
    table.append(
      row('Loudness', `${db(m.lufs)} LUFS`, `target ${TARGET_LUFS}; raw was ${db(report.inputLufs)} LUFS`),
      row('Peak', `${db(m.peakDb, 2)} dBFS`, `between samples ${db(m.truePeakDb, 2)} dBFS; must stay below -1`),
      row('Limiter', m.limiter.maxReductionDb > 0 ? `${db(m.limiter.maxReductionDb)} dB at most` : 'did not act', m.limiter.maxReductionDb > 0 ? `on ${(m.limiter.limitedShare * 100).toFixed(1)}% of the samples` : ''),
      row('Length', formatLength(report.durationSec), `raw ${formatLength(report.inputDurationSec)}`),
      row(
        'Speed and pitch',
        report.playbackRate === 1 ? 'unchanged' : `${Math.round(report.playbackRate * 100)}% speed`,
        report.playbackRate === 1 ? '' : `${report.pitchSemitones.toFixed(2)} semitones`,
      ),
      row('Wow / flutter / drift', report.wobbleMaxCents > 0 ? `up to ${report.wobbleMaxCents.toFixed(1)} cents` : 'off'),
      row('High-cut', report.highCutHz === null ? 'off' : `${(report.highCutHz / 1000).toFixed(1)} kHz`, `spectral centroid ${Math.round(report.inputCentroidHz)} -> ${Math.round(report.centroidHz)} Hz`),
      row('Stereo side level', `${db(report.sideDb)} dB`, `raw ${db(report.inputSideDb)} dB (side against mid)`),
      row('Hiss', report.hissDb === null ? 'off' : `${report.hissDb} dBFS RMS`, report.hissDb === null ? '' : `${(m.lufs - report.hissDb).toFixed(0)} dB under the music`),
      row('Vocal blur', report.vocalBlurApplied ? 'on the vocal stem' : report.settings.vocalBlur > 0 ? 'not applied: no vocal stem' : 'off'),
    );
  }

  // ------------------------------------------------------------------ actions

  private setBusy(busy: boolean): void {
    this.busy = busy;
    this.refreshPrompt();
    this.refreshResult();
  }

  private openConfirm(body: Node[], okLabel: string, run: () => void): void {
    const { confirm, confirmBody, confirmOk } = this.els;
    clear(confirmBody);
    confirmBody.append(...body);
    confirmOk.lastElementChild!.textContent = okLabel;
    this.pendingConfirm = run;
    confirm.showModal();
  }

  private onGenerate(): void {
    if (this.state.engine === 'sketch') void this.generateSketch();
    else this.askGenerate();
  }

  /** The free path: a new seed, a take in localStorage, audio made right here. */
  private async generateSketch(): Promise<void> {
    const { state } = this;
    const seed = crypto.getRandomValues(new Uint32Array(1))[0];
    const now = new Date();
    const m = state.match;
    const overlay =
      state.overlay && m && this.song
        ? { dipDb: state.dipDb, melodyDb: state.melodyDb, offsetSec: m.offsetSec, keyPc: m.keyPc ?? -1, mode: m.mode ?? 'dorian' }
        : null;
    if (overlay && this.song) {
      // The recording sets the length; the chain starts clean so its tone is kept.
      state.lengthSec = Math.min(LENGTH_MAX_SEC, Math.max(LENGTH_MIN_SEC, Math.round(this.song[0].length / SAMPLE_RATE)));
      state.fx = POSTFX_CLEAN;
      state.fxEdited = true;
    }
    const take: StyleTake = {
      engine: 'sketch',
      seed,
      match: state.match ? { tempoBpm: state.match.tempoBpm, grid: state.match.grid } : null,
      overlay,
      id: `sk-${now.getTime().toString(36)}-${seed.toString(36)}`,
      createdAt: now.toISOString(),
      profileA: state.a,
      profileB: state.b,
      mix: state.b ? state.mix : 0,
      vocals: state.vocals,
      lengthSec: state.lengthSec,
      words: state.words,
      prompt: '',
      lyrics: '',
      body: null,
      model: 'built-in',
      costUsd: 0,
      mock: false,
      audioFile: '',
      stems: null,
      fx: state.fx,
      rating: 0,
      note: '',
    };
    this.setBusy(true);
    try {
      if (take.overlay) this.sessionTakes = [take, ...this.sessionTakes];
      else this.saveLocalTakes([take, ...this.localTakes()]);
      this.mergeTakes();
      await this.loadTake(take);
    } finally {
      this.setBusy(false);
    }
  }

  private askGenerate(): void {
    const { state } = this;
    const mock = this.isMock();
    const cost = estimateCost(state.lengthSec, { usdPerMinute: this.usdPerMinute() });
    const usd = mock ? 0 : cost.usd;
    const body: Node[] = mock
      ? [h('p', null, 'Mock mode: the local server returns a test signal. The music API is not called and nothing is billed.')]
      : [
          h('p', null, `This calls the ElevenLabs Music API once and is billed to your account.`),
          h(
            'table',
            { class: 'sl-cost-table' },
            ...cost.lines.map((l) => h('tr', null, h('td', null, l.label), h('td', null, formatUsd(l.usd)))),
            h('tr', { class: 'sl-cost-total' }, h('td', null, 'Estimated total'), h('td', null, formatUsd(cost.usd))),
          ),
          h('p', { class: 'sl-fine' }, `Estimate from the public price list (${PRICE_SOURCE}). On a subscription it comes out of your included minutes. The real charge is whatever ElevenLabs bills. The built-in generator is free.`),
        ];
    body.push(h('h3', null, 'What is sent'), h('pre', { class: 'sl-request' }, this.els.requestPre.textContent ?? ''));
    this.openConfirm(body, mock ? 'Generate the test signal' : `Generate for about ${formatUsd(usd)}`, () => void this.generate(usd));
  }

  private async generate(confirmUsd: number): Promise<void> {
    const { state } = this;
    const payload: ComposeRequestBody = {
      prompt: state.prompt,
      lengthSec: state.lengthSec,
      vocals: state.vocals,
      lyrics: state.vocals ? state.lyrics : '',
      modelId: state.modelId,
      confirmUsd,
      meta: { profileA: state.a, profileB: state.b, mix: state.b ? state.mix : 0, words: state.words, fx: state.fx },
    };
    this.suggestion = null;
    this.setBusy(true);
    try {
      const take = await api<StyleTake>('compose', postJson(payload));
      this.serverTakes = [take, ...this.serverTakes.filter((t) => t.id !== take.id)];
      this.mergeTakes();
      this.host.toast(take.mock ? 'Test signal ready.' : 'Generated. Running the lo-fi chain.');
      await this.loadTake(take);
    } catch (err) {
      const e = err instanceof ApiError ? err : new ApiError(String(err), 'error', null);
      this.suggestion = e.suggestion;
      this.host.toast(e.message);
    } finally {
      this.setBusy(false);
    }
  }

  private askStems(): void {
    const take = this.current;
    if (!take || take.stems || isSketch(take)) return;
    const usd = take.mock ? 0 : estimateCost(take.lengthSec, { stems: true, usdPerMinute: this.usdPerMinute() }).lines[1].usd;
    this.openConfirm(
      [
        h('p', null, take.mock ? 'Mock mode: the test signal comes with its two stems for free.' : 'This sends the generated file to the ElevenLabs stem separation and is billed to your account.'),
        h(
          'p',
          { class: 'sl-fine' },
          take.mock
            ? ''
            : `Estimated ${formatUsd(usd)}. The API price list has no line for stems; this assumes half the price of the generation. Check your usage page after the first one.`,
        ),
      ],
      take.mock ? 'Get the stems' : `Separate for about ${formatUsd(usd)}`,
      () => void this.separate(take, usd),
    );
  }

  private async separate(take: StyleTake, confirmUsd: number): Promise<void> {
    this.setBusy(true);
    try {
      const updated = await api<StyleTake>('stems', postJson({ id: take.id, confirmUsd }));
      this.replaceTake(updated);
      this.decoded = null;
      await this.loadTake(updated);
    } catch (err) {
      this.host.toast(err instanceof Error ? err.message : String(err));
    } finally {
      this.setBusy(false);
    }
  }

  /** Puts a changed take back where it lives (localStorage or the server list). */
  private replaceTake(take: StyleTake): void {
    if (take.overlay) this.sessionTakes = this.sessionTakes.map((t) => (t.id === take.id ? take : t));
    else if (isSketch(take)) this.saveLocalTakes(this.localTakes().map((t) => (t.id === take.id ? take : t)));
    else this.serverTakes = this.serverTakes.map((t) => (t.id === take.id ? take : t));
    this.mergeTakes();
    if (this.current?.id === take.id) this.current = take;
    this.renderTakes();
    this.refreshResult();
  }

  /** Saves a change to a take: locally for the built-in generator, on the server for the music AI. */
  private async patchTake(take: StyleTake, patch: Partial<Pick<StyleTake, 'fx' | 'rating'>>): Promise<void> {
    if (isSketch(take)) this.replaceTake({ ...take, ...patch });
    else this.replaceTake(await api<StyleTake>(`takes/${take.id}`, postJson(patch)));
  }

  private async rate(value: 1 | -1): Promise<void> {
    const take = this.current;
    if (!take) return;
    try {
      await this.patchTake(take, { rating: take.rating === value ? 0 : value });
    } catch (err) {
      this.host.toast(err instanceof Error ? err.message : String(err));
    }
  }

  private async deleteTake(take: StyleTake): Promise<void> {
    const paid = !isSketch(take) && !take.mock;
    if (!window.confirm(`Delete this generation?${paid ? ' It was paid for.' : ''}`)) return;
    if (take.overlay) {
      this.sessionTakes = this.sessionTakes.filter((t) => t.id !== take.id);
    } else if (isSketch(take)) {
      this.saveLocalTakes(this.localTakes().filter((t) => t.id !== take.id));
    } else {
      try {
        await api<{ ok: boolean }>(`takes/${take.id}`, { method: 'DELETE' });
      } catch (err) {
        this.host.toast(err instanceof Error ? err.message : String(err));
        return;
      }
      this.serverTakes = this.serverTakes.filter((t) => t.id !== take.id);
    }
    this.mergeTakes();
    if (this.current?.id === take.id) {
      this.current = null;
      this.decoded = null;
      this.setLofi(null);
      this.setRaw(null);
    }
    this.renderTakes();
    this.refreshResult();
  }

  /** Shows a take: its own chain settings come back with it, then the chain runs. */
  private async loadTake(take: StyleTake): Promise<void> {
    this.pause();
    this.current = take;
    this.state.fx = normalizePostFx(take.fx);
    this.state.fxEdited = true;
    this.save();
    this.refreshFx();
    this.renderTakes();
    this.setLofi(null);
    if (isSketch(take)) this.setRaw(null);
    else this.setRaw(`${API}audio/${take.audioFile}`, false);
    this.refreshResult();
    await this.runChain();
  }

  private onFxEdited(): void {
    this.state.fxEdited = true;
    this.save();
    this.refreshFx();
    this.scheduleChain();
  }

  private scheduleChain(): void {
    window.clearTimeout(this.chainTimer);
    if (!this.current) return;
    this.chainTimer = window.setTimeout(() => void this.runChain(), CHAIN_DEBOUNCE_MS);
  }

  /** The raw player: a server file, or a blob made here (which this object then owns). */
  private setRaw(url: string | null, owned = true): void {
    const audio = this.els.rawAudio;
    if (this.rawUrl) URL.revokeObjectURL(this.rawUrl);
    this.rawUrl = url && owned ? url : null;
    if (url) audio.src = url;
    else {
      audio.removeAttribute('src');
      audio.load();
    }
  }

  private setLofi(next: { pcm: StereoPcm; report: PostFxReport } | null): void {
    const audio = this.els.lofiAudio;
    const wasPlaying = !audio.paused;
    const at = audio.currentTime;
    if (this.lofi) URL.revokeObjectURL(this.lofi.url);
    if (!next) {
      this.lofi = null;
      audio.removeAttribute('src');
      audio.load();
      return;
    }
    const url = URL.createObjectURL(new Blob([encodeWav(next.pcm, SAMPLE_RATE)], { type: 'audio/wav' }));
    this.lofi = { ...next, url };
    audio.src = url;
    if (at > 0) {
      audio.addEventListener(
        'loadedmetadata',
        () => {
          audio.currentTime = Math.min(at, Math.max(0, audio.duration - 0.2));
          if (wasPlaying) void audio.play().catch(() => undefined);
        },
        { once: true },
      );
    }
  }

  /** The audio of a take before the chain: synthesised here, or fetched and decoded. */
  private async decode(take: StyleTake): Promise<Decoded> {
    if (isSketch(take)) {
      await nextPaint();
      const sketch = makeSketch(sketchRequestOf(take));
      const audio = renderSketch(sketch, SAMPLE_RATE);
      if (take.overlay) {
        if (!this.song) throw new Error('the recording is no longer in memory. Pick the file again and press Generate.');
        return { id: take.id, full: overlayMelody(this.song, audio.full, take.overlay, SAMPLE_RATE), stems: null, sketch };
      }
      return { id: take.id, full: audio.full, stems: audio.stems, sketch };
    }
    const load = async (file: string): Promise<StereoPcm> => {
      const res = await fetch(`${API}audio/${file}`);
      if (!res.ok) throw new Error(`Could not load ${file}.`);
      return decodeToStereo(await res.arrayBuffer());
    };
    const full = await load(take.audioFile);
    const stems = take.stems ? { vocals: await load(take.stems.vocals), backing: await load(take.stems.backing) } : null;
    return { id: take.id, full, stems, sketch: null };
  }

  private async runChain(): Promise<void> {
    const take = this.current;
    if (!take) return;
    const token = ++this.chainToken;
    const status = this.els.chainStatus;
    status.classList.remove('is-error');
    try {
      if (this.decoded?.id !== take.id) {
        status.textContent = isSketch(take) ? 'Composing and synthesising...' : 'Loading...';
        const decoded = await this.decode(take);
        if (token !== this.chainToken) return;
        this.decoded = decoded;
        if (isSketch(take)) {
          this.setRaw(URL.createObjectURL(new Blob([encodeWav(decoded.full, SAMPLE_RATE)], { type: 'audio/wav' })));
        }
      }
      status.textContent = 'Rendering the lo-fi version...';
      const fx = this.state.fx;
      const result = await renderPostFx(
        { sampleRate: SAMPLE_RATE, full: this.decoded.full, stems: this.decoded.stems },
        fx,
        { createContext: (channels, frames, rate) => new OfflineAudioContext(channels, frames, rate), seed: seedOf(take.id) },
      );
      if (token !== this.chainToken) return;
      this.setLofi({ pcm: result.pcm, report: result.report });
      status.textContent = '';
      this.refreshResult();
      if (JSON.stringify(take.fx) !== JSON.stringify(fx)) void this.patchTake(take, { fx }).catch(() => undefined);
    } catch (err) {
      if (token !== this.chainToken) return;
      status.textContent = `It failed: ${err instanceof Error ? err.message : String(err)}`;
      status.classList.add('is-error');
    }
  }

  private downloadLofi(): void {
    if (!this.lofi || !this.current) return;
    downloadBytes(encodeWav(this.lofi.pcm, SAMPLE_RATE), `${this.current.id}-lofi.wav`, 'audio/wav');
  }
}
