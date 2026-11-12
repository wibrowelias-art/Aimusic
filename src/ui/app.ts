/**
 * Ambient Lab, the interface: one big Generate button, mood presets, knobs,
 * "Again", piano roll / waveform, history, favorites and the rating loop.
 */
import {
  AudioWaveform,
  Download,
  FileMusic,
  History as HistoryIcon,
  Info,
  KeyboardMusic,
  Layers,
  LoaderCircle,
  Play,
  RefreshCw,
  Sparkles,
  Square,
  Star,
  ThumbsDown,
  ThumbsUp,
  X,
} from 'lucide';
import { SAMPLE_RATE } from '../audio/constants';
import { fetchManifest, urlSampleFetcher } from '../audio/fetch';
import { totalSecFor } from '../audio/graph';
import { Player } from '../audio/player';
import { renderPiece } from '../audio/render';
import { loadPianoSamples, type PianoSampleSet } from '../audio/sampler';
import type { RenderResult, SampleFetcher, SampleManifest } from '../audio/types';
import { encodeWav } from '../audio/wav';
import { generate } from '../engine/compose';
import { pieceToMidi } from '../engine/midi';
import {
  KEY_NAMES,
  MODE_LABELS,
  NUMERIC_KEYS,
  PARAM_SPECS,
  PRESET_NAMES,
  PRESETS,
  paramLabel,
  type PresetName,
} from '../engine/params';
import { createRng } from '../engine/rng';
import { MODES, type Mode, type NumericParamKey, type Params, type Piece } from '../engine/types';
import { learnedShifts, sampleParams, type Learned } from '../store/learning';
import { browserStore, readJson, writeJson, type KeyValueStore } from '../store/storage';
import { TakeStore, type Take, type TakeOrigin } from '../store/takes';
import { clear, downloadBytes, formatTime, h, icon } from './dom';
import { Knob } from './knob';
import { PianoRoll, Waveform } from './views';
import { makeZip } from './zip';

const UI_KEY = 'ambientlab.ui.v1';
/** Knobs that change the sound but not the notes: playback resumes where it was. */
const SOUND_ONLY: ReadonlySet<NumericParamKey> = new Set<NumericParamKey>(['reverbSize', 'lofi', 'pad', 'rain']);

const KNOB_TITLES: Record<NumericParamKey, string> = {
  tempo: 'Tempo in beats per minute',
  density: 'How many piano notes per bar, on average',
  register: 'How high the melody sits',
  restProbability: 'Space: the share of bars left silent between phrases',
  reverbSize: 'Length of the reverb tail in seconds',
  lofi: 'Tape wobble, hiss and a darker tone, together',
  length: 'Length of the piece',
  pad: 'Level of the soft pad under the piano',
  rain: 'Level of the rain in the background',
};

interface AudioBundle {
  ctx: AudioContext;
  samples: PianoSampleSet;
  manifest: SampleManifest;
  fetchSample: SampleFetcher;
  player: Player;
}

interface UiPrefs {
  preset: PresetName;
  pins: Partial<Params>;
  view: 'roll' | 'wave';
  tab: 'history' | 'favorites';
}

function randomSeed(): number {
  const box = new Uint32Array(1);
  globalThis.crypto.getRandomValues(box);
  return box[0] >>> 0;
}

function takeTitle(take: Take): string {
  const p = take.params;
  const mood = take.preset ? `${PRESETS[take.preset].label} · ` : '';
  return `#${take.n} ${mood}${KEY_NAMES[p.key]} ${MODE_LABELS[p.mode].toLowerCase()}`;
}

function takeMeta(take: Take): string {
  const p = take.params;
  const variation = p.variation > 0 ? ` · variation ${p.variation}` : '';
  return `${p.tempo} BPM · ${paramLabel('length', p.length)} · seed ${p.seed}${variation}`;
}

function fileStem(take: Take): string {
  return `ambient-lab-${String(take.n).padStart(3, '0')}-seed${take.params.seed}-v${take.params.variation}`;
}

const CREDITS = [
  'Made with Ambient Lab.',
  '',
  'The notes of this piece were generated from a seed. They are not taken from',
  'or modelled on any existing piece of music.',
  '',
  'Piano samples: Salamander Grand Piano V3 by Alexander Holm,',
  'licensed under Creative Commons Attribution 3.0 (CC BY 3.0),',
  'https://creativecommons.org/licenses/by/3.0/',
  'If you publish this audio, keep this credit with it.',
  '',
  'Reverb, pad, tape hiss and rain are synthesised in code.',
  '',
].join('\n');

export class App {
  private readonly kv: KeyValueStore;
  private readonly store: TakeStore;
  private prefs: UiPrefs;
  private current: Take | null = null;
  private piece: Piece | null = null;
  private audio: AudioBundle | null = null;
  private audioPromise: Promise<AudioBundle> | null = null;
  private render: { key: string; result: RenderResult } | null = null;
  private renderJob: { key: string; promise: Promise<RenderResult> } | null = null;
  private playToken = 0;
  private raf = 0;
  private toastTimer = 0;

  private readonly knobs = {} as Record<NumericParamKey, Knob>;
  private readonly roll = new PianoRoll();
  private readonly wave = new Waveform();
  private readonly els: {
    moods: HTMLElement;
    generate: HTMLButtonElement;
    again: HTMLButtonElement;
    play: HTMLButtonElement;
    time: HTMLElement;
    takeTitle: HTMLElement;
    takeSub: HTMLElement;
    takeActions: HTMLElement;
    viewStatus: HTMLElement;
    tabRoll: HTMLButtonElement;
    tabWave: HTMLButtonElement;
    exportMidi: HTMLButtonElement;
    exportWav: HTMLButtonElement;
    exportStems: HTMLButtonElement;
    keySelect: HTMLSelectElement;
    modeSelect: HTMLSelectElement;
    takesTabs: HTMLElement;
    takes: HTMLElement;
    toast: HTMLElement;
    about: HTMLDialogElement;
    extras: HTMLElement;
  };

  constructor(root: HTMLElement, kv: KeyValueStore = browserStore()) {
    this.kv = kv;
    this.store = new TakeStore(kv);
    this.prefs = this.loadPrefs();
    this.els = this.build(root);
    this.roll.onSeek = (sec) => this.seek(sec);
    this.wave.onSeek = (sec) => this.seek(sec);
    document.addEventListener('keydown', (e) => this.onKey(e));

    this.refreshMoods();
    this.refreshKnobs();
    this.refreshTakes();
    this.setView(this.prefs.view, false);
    const latest = this.store.list()[0];
    if (latest) void this.loadTake(latest, { play: false });
    else this.refreshCurrent();
  }

  // ------------------------------------------------------------------ prefs

  private loadPrefs(): UiPrefs {
    const fallback: UiPrefs = { preset: 'warm', pins: {}, view: 'roll', tab: 'history' };
    const raw = readJson(this.kv, UI_KEY);
    if (typeof raw !== 'object' || raw === null) return fallback;
    const r = raw as Record<string, unknown>;
    const pins: Partial<Params> = {};
    if (typeof r.pins === 'object' && r.pins !== null) {
      const p = r.pins as Record<string, unknown>;
      for (const k of NUMERIC_KEYS) {
        const v = p[k];
        if (typeof v === 'number' && Number.isFinite(v)) pins[k] = Math.min(PARAM_SPECS[k].max, Math.max(PARAM_SPECS[k].min, v));
      }
      if (typeof p.key === 'number' && p.key >= 0 && p.key <= 11) pins.key = Math.round(p.key);
      if (typeof p.mode === 'string' && (MODES as readonly string[]).includes(p.mode)) pins.mode = p.mode as Mode;
    }
    return {
      preset: (PRESET_NAMES as string[]).includes(r.preset as string) ? (r.preset as PresetName) : fallback.preset,
      pins,
      view: r.view === 'wave' ? 'wave' : 'roll',
      tab: r.tab === 'favorites' ? 'favorites' : 'history',
    };
  }

  private savePrefs(): void {
    writeJson(this.kv, UI_KEY, this.prefs);
  }

  // ------------------------------------------------------------------ build

  private build(root: HTMLElement): App['els'] {
    const moods = h('div', { class: 'moods', role: 'radiogroup', 'aria-label': 'Mood' });
    for (const name of PRESET_NAMES) {
      moods.append(
        h(
          'button',
          {
            class: 'mood',
            type: 'button',
            role: 'radio',
            dataset: { preset: name },
            onclick: () => this.setPreset(name),
          },
          h('span', { class: 'mood-name' }, PRESETS[name].label),
          h('span', { class: 'mood-blurb' }, PRESETS[name].blurb),
        ),
      );
    }

    moods.addEventListener('keydown', (e) => {
      const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
      if (step === 0) return;
      e.preventDefault();
      const index = PRESET_NAMES.indexOf(this.prefs.preset);
      const next = PRESET_NAMES[(index + step + PRESET_NAMES.length) % PRESET_NAMES.length];
      this.setPreset(next);
      moods.querySelector<HTMLElement>(`[data-preset="${next}"]`)?.focus();
    });

    const generateBtn = h(
      'button',
      { class: 'generate', type: 'button', title: 'A new piece in this mood (G)', onclick: () => void this.generateNew() },
      icon(Sparkles, 22),
      h('span', { class: 'generate-label' }, 'Generate'),
    );
    const again = h(
      'button',
      {
        class: 'btn tall',
        type: 'button',
        title: 'Same idea and chords, played out differently (A)',
        onclick: () => void this.again(),
      },
      icon(RefreshCw, 16),
      'Again',
    );
    const play = h('button', { class: 'btn tall icon-only', type: 'button', onclick: () => void this.togglePlay() });
    const time = h('span', { class: 'time', 'aria-live': 'off' }, '0:00 / 0:00');

    const takeTitleEl = h('span', { class: 'take-title' });
    const takeSub = h('span', { class: 'take-sub' });
    const takeActions = h('span', { class: 'take-actions' });

    const tabRoll = h(
      'button',
      { type: 'button', role: 'tab', onclick: () => this.setView('roll') },
      icon(KeyboardMusic, 14),
      'Piano roll',
    );
    const tabWave = h(
      'button',
      { type: 'button', role: 'tab', onclick: () => this.setView('wave') },
      icon(AudioWaveform, 14),
      'Waveform',
    );
    const viewStatus = h('span', { class: 'view-status', role: 'status', 'aria-live': 'polite' });
    const exportMidi = h(
      'button',
      { class: 'btn small', type: 'button', title: 'Download the notes as a MIDI file', onclick: () => this.exportMidi() },
      icon(FileMusic, 14),
      'MIDI',
    );
    const exportWav = h(
      'button',
      { class: 'btn small', type: 'button', title: 'Render and download a WAV file', onclick: () => void this.exportWav() },
      icon(Download, 14),
      'WAV',
    );
    const exportStems = h(
      'button',
      {
        class: 'btn small',
        type: 'button',
        title: 'Render and download piano, pad and noise as separate WAV files (zip)',
        onclick: () => void this.exportStems(),
      },
      icon(Layers, 14),
      'Stems',
    );

    const viewArea = h('div', { class: 'view-area' }, this.roll.element, this.wave.element);

    const keySelect = h('select', { 'aria-label': 'Key', onchange: () => this.onKeySelect() });
    keySelect.append(h('option', { value: 'auto' }, 'Auto'));
    KEY_NAMES.forEach((name, i) => keySelect.append(h('option', { value: String(i) }, name)));
    const modeSelect = h('select', { 'aria-label': 'Mode', onchange: () => this.onModeSelect() });
    modeSelect.append(h('option', { value: 'auto' }, 'Auto'));
    for (const mode of MODES) modeSelect.append(h('option', { value: mode }, MODE_LABELS[mode]));

    const knobGrid = h('div', { class: 'knob-grid' });
    for (const key of NUMERIC_KEYS) {
      const spec = PARAM_SPECS[key];
      const knob = new Knob({
        label: spec.label,
        min: spec.min,
        max: spec.max,
        step: spec.step,
        value: spec.default,
        format: (v) => paramLabel(key, v),
        title: `${KNOB_TITLES[key]}. Drag up or down, or use the arrow keys.`,
        onChange: (v) => this.onKnobChange(key, v),
        onPinToggle: (pinned) => this.onPinToggle(key, pinned),
      });
      this.knobs[key] = knob;
      knobGrid.append(knob.element);
    }

    const takesTabs = h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Takes' });
    const takes = h('ul', { class: 'takes' });
    const toast = h('div', { class: 'toast', role: 'status', 'aria-live': 'polite' });
    const about = this.buildAbout();
    const extras = h('div', { class: 'extras' });

    const app = h(
      'div',
      { class: 'app' },
      h(
        'header',
        { class: 'topbar' },
        h('div', { class: 'brand' }, brandMark(), h('span', null, 'Ambient Lab')),
        h('div', { class: 'topbar-note' }, 'Calm piano from a seed. Every piece is new, nothing is copied.'),
        h(
          'button',
          { class: 'btn ghost', type: 'button', onclick: () => about.showModal() },
          icon(Info, 15),
          'About',
        ),
      ),
      h(
        'main',
        { class: 'layout' },
        h(
          'section',
          { class: 'stage', 'aria-label': 'Generate and listen' },
          moods,
          h('div', { class: 'hero' }, generateBtn, h('div', { class: 'hero-side' }, again, play, time)),
          h('div', { class: 'take-line' }, takeTitleEl, takeSub, takeActions),
          h(
            'div',
            { class: 'viewbox' },
            h(
              'div',
              { class: 'view-bar' },
              h('div', { class: 'segmented', role: 'tablist', 'aria-label': 'View' }, tabRoll, tabWave),
              viewStatus,
              h('div', { class: 'exports' }, exportMidi, exportWav, exportStems),
            ),
            viewArea,
            h(
              'div',
              { class: 'legend', 'aria-hidden': 'true' },
              h('span', null, h('i', { class: 'swatch' }), 'melody'),
              h('span', null, h('i', { class: 'swatch warm' }), 'left hand'),
              h('span', null, h('i', { class: 'swatch ring' }), 'ringing in the pedal'),
              h('span', null, h('i', { class: 'swatch violet' }), 'pad'),
              h('span', null, 'Click to jump.'),
            ),
          ),
          extras,
        ),
        h(
          'aside',
          { class: 'side' },
          h(
            'section',
            { class: 'panel', 'aria-label': 'Settings' },
            h('h2', null, 'Settings'),
            h(
              'div',
              { class: 'selects' },
              h('label', { class: 'field' }, 'Key', keySelect),
              h('label', { class: 'field' }, 'Mode', modeSelect),
            ),
            knobGrid,
            h(
              'p',
              { class: 'hint' },
              h('i', { class: 'swatch warm' }),
              'The amber arc is where this mood picks a value. Turn a knob to fix it; the lock lets it go again.',
            ),
          ),
          h('section', { class: 'panel', 'aria-label': 'Takes' }, takesTabs, takes),
        ),
      ),
      toast,
      about,
    );
    clear(root);
    root.append(app);

    return {
      moods,
      generate: generateBtn,
      again,
      play,
      time,
      takeTitle: takeTitleEl,
      takeSub,
      takeActions,
      viewStatus,
      tabRoll,
      tabWave,
      exportMidi,
      exportWav,
      exportStems,
      keySelect,
      modeSelect,
      takesTabs,
      takes,
      toast,
      about,
      extras,
    };
  }

  private buildAbout(): HTMLDialogElement {
    const dialog = h('dialog', { 'aria-labelledby': 'about-title' });
    dialog.append(
      h('h2', { id: 'about-title' }, 'About Ambient Lab'),
      h(
        'p',
        null,
        'One click makes one calm, sparse piano piece. The lab invents a short motif from a random seed and develops it over slow chords, in the form A / B / A\'.',
      ),
      h('h3', null, 'Original by design'),
      h(
        'p',
        null,
        'The lab captures a mood and a sound world, never a specific piece. It does not copy, transcribe or approximate the melody, chords or arrangement of any existing music, and it will say so when a request would need that.',
      ),
      h('h3', null, 'Credits'),
      h(
        'ul',
        null,
        h(
          'li',
          null,
          'Piano: Salamander Grand Piano V3 by Alexander Holm, ',
          h('a', { href: 'https://creativecommons.org/licenses/by/3.0/', target: '_blank', rel: 'noreferrer' }, 'CC BY 3.0'),
          '. Keep this credit when you publish audio made here.',
        ),
        h('li', null, 'Reverb, pad, tape hiss and rain: synthesised in code, no recordings.'),
        h('li', null, 'Font: Inter (SIL Open Font License 1.1). Icons: Lucide (ISC).'),
      ),
      h('h3', null, 'Your data'),
      h(
        'p',
        null,
        'Takes, favorites and ratings are kept in this browser only (seed and settings, no audio). Thumbs up and down move the ranges a mood picks from.',
      ),
      h(
        'div',
        { class: 'dialog-actions' },
        h(
          'button',
          {
            class: 'btn',
            type: 'button',
            onclick: () => {
              this.store.resetLearning();
              this.refreshKnobs();
              this.toast('Learning reset. The moods are back to their original ranges.');
            },
          },
          'Reset what the moods learned',
        ),
        h(
          'button',
          {
            class: 'btn',
            type: 'button',
            onclick: () => {
              this.store.clearHistory();
              this.refreshTakes();
              this.toast('History cleared. Favorites are kept.');
            },
          },
          'Clear history',
        ),
        h('button', { class: 'btn', type: 'button', onclick: () => dialog.close() }, 'Close'),
      ),
    );
    return dialog;
  }

  /** Room under the views for the chat box and the reference drop zone. */
  get extrasElement(): HTMLElement {
    return this.els.extras;
  }

  // ------------------------------------------------------------------ state access for add-ons

  getPreset(): PresetName {
    return this.prefs.preset;
  }

  getLearned(): Learned {
    return this.store.learned();
  }

  /** The settings the knobs show right now: the current take, or pins over the mood's centre. */
  getShownParams(): Params {
    if (this.current) return { ...this.current.params };
    const state = this.store.learned()[this.prefs.preset];
    const out = sampleParams(state, createRng(1), { seed: 1, pins: this.prefs.pins });
    for (const k of NUMERIC_KEYS) {
      if (this.prefs.pins[k] === undefined) out[k] = this.knobs[k].getValue();
    }
    return out;
  }

  /**
   * Applies changed settings (from the chat box or a reference analysis): they are
   * fixed like turned knobs, and the current take is re-made with them.
   */
  applySettings(changes: Partial<Params>, origin: TakeOrigin, preset?: PresetName): void {
    if (preset && preset !== this.prefs.preset) {
      this.prefs.preset = preset;
      this.refreshMoods();
    }
    for (const k of NUMERIC_KEYS) {
      const v = changes[k];
      if (v !== undefined) this.prefs.pins[k] = v;
    }
    if (changes.key !== undefined) this.prefs.pins.key = changes.key;
    if (changes.mode !== undefined) this.prefs.pins.mode = changes.mode;
    this.savePrefs();
    if (this.current) {
      const wasPlaying = this.audio?.player.isPlaying ?? false;
      const take = this.store.edit(this.current.id, { ...this.current.params, ...changes }, origin);
      if (take) void this.loadTake(take, { play: wasPlaying });
    } else {
      this.refreshKnobs();
    }
    this.refreshTakes();
  }

  toast(text: string): void {
    const el = this.els.toast;
    el.textContent = text;
    el.classList.add('is-shown');
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => el.classList.remove('is-shown'), 4200);
  }

  // ------------------------------------------------------------------ moods and knobs

  private setPreset(name: PresetName): void {
    if (name === this.prefs.preset && Object.keys(this.prefs.pins).length === 0) return;
    this.prefs.preset = name;
    // A new mood lets go of everything that was fixed.
    this.prefs.pins = {};
    this.savePrefs();
    this.refreshMoods();
    this.refreshKnobs();
  }

  private refreshMoods(): void {
    for (const el of Array.from(this.els.moods.children)) {
      const on = (el as HTMLElement).dataset.preset === this.prefs.preset;
      el.setAttribute('aria-checked', String(on));
      el.setAttribute('tabindex', on ? '0' : '-1');
    }
  }

  private refreshKnobs(): void {
    const state = this.store.learned()[this.prefs.preset];
    const shown = this.current?.params;
    for (const key of NUMERIC_KEYS) {
      const knob = this.knobs[key];
      const range = state.ranges[key];
      const pin = this.prefs.pins[key];
      knob.setRange(range);
      knob.setPinned(pin !== undefined);
      knob.setValue(shown ? shown[key] : (pin ?? (range.lo + range.hi) / 2));
    }
    this.els.keySelect.value = this.prefs.pins.key !== undefined ? String(this.prefs.pins.key) : 'auto';
    this.els.modeSelect.value = this.prefs.pins.mode ?? 'auto';
    const auto = (select: HTMLSelectElement, text: string): void => {
      const option = select.options[0];
      if (option) option.textContent = text;
    };
    auto(this.els.keySelect, shown ? `Auto (${KEY_NAMES[shown.key]})` : 'Auto');
    auto(this.els.modeSelect, shown ? `Auto (${MODE_LABELS[shown.mode]})` : 'Auto');
  }

  private onKnobChange(key: NumericParamKey, value: number): void {
    this.prefs.pins[key] = value;
    this.knobs[key].setPinned(true);
    this.savePrefs();
    if (!this.current) return;
    const player = this.audio?.player;
    const wasPlaying = player?.isPlaying ?? false;
    const position = player?.position ?? 0;
    const take = this.store.edit(this.current.id, { ...this.current.params, [key]: value });
    if (!take) return;
    void this.loadTake(take, { play: wasPlaying, fromSec: SOUND_ONLY.has(key) ? position : 0 });
    this.refreshTakes();
  }

  private onPinToggle(key: NumericParamKey, pinned: boolean): void {
    if (pinned) this.prefs.pins[key] = this.knobs[key].getValue();
    else delete this.prefs.pins[key];
    this.savePrefs();
  }

  private onKeySelect(): void {
    const v = this.els.keySelect.value;
    if (v === 'auto') {
      delete this.prefs.pins.key;
      this.savePrefs();
      return;
    }
    this.applySettings({ key: Number(v) }, 'edit');
  }

  private onModeSelect(): void {
    const v = this.els.modeSelect.value;
    if (v === 'auto') {
      delete this.prefs.pins.mode;
      this.savePrefs();
      return;
    }
    this.applySettings({ mode: v as Mode }, 'edit');
  }

  // ------------------------------------------------------------------ takes

  private async generateNew(): Promise<void> {
    const seed = randomSeed();
    const state = this.store.learned()[this.prefs.preset];
    const params = sampleParams(state, createRng(seed).fork('settings'), { seed, pins: this.prefs.pins });
    const take = this.store.add(params, this.prefs.preset, 'generate');
    this.refreshTakes();
    await this.loadTake(take, { play: true });
  }

  private async again(): Promise<void> {
    if (!this.current) {
      await this.generateNew();
      return;
    }
    const params = { ...this.current.params, variation: this.current.params.variation + 1 };
    const take = this.store.add(params, this.current.preset, 'again');
    this.refreshTakes();
    await this.loadTake(take, { play: true });
  }

  private async loadTake(take: Take, opts: { play: boolean; fromSec?: number }): Promise<void> {
    // Stop first: the audio of the old take must not run under the picture of the new one.
    this.stopPlayback();
    this.current = take;
    this.piece = generate(take.params);
    if (this.render && this.render.key !== this.renderKey(take)) this.render = null;
    this.refreshCurrent();
    this.refreshKnobs();
    this.refreshTakes();
    this.refreshViews();
    if (this.prefs.view === 'wave') void this.ensureRender().catch(() => undefined);
    if (opts.play) await this.play(opts.fromSec ?? 0);
  }

  private refreshCurrent(): void {
    const take = this.current;
    const has = take !== null;
    this.els.again.disabled = !has;
    this.els.play.disabled = !has;
    this.els.exportMidi.disabled = !has;
    this.els.exportWav.disabled = !has;
    this.els.exportStems.disabled = !has;
    clear(this.els.takeActions);
    if (!take) {
      this.els.takeTitle.textContent = 'No take yet';
      this.els.takeSub.textContent = 'Pick a mood and press Generate.';
    } else {
      this.els.takeTitle.textContent = takeTitle(take);
      this.els.takeSub.textContent = takeMeta(take);
      this.els.takeActions.append(...this.ratingButtons(take, false));
    }
    this.refreshTransport();
  }

  private ratingButtons(take: Take, small: boolean): HTMLButtonElement[] {
    const cls = small ? 'btn small icon-only' : 'btn icon-only';
    const size = small ? 14 : 16;
    return [
      h(
        'button',
        {
          class: cls,
          type: 'button',
          'aria-pressed': String(take.rating === 1),
          'aria-label': `Like take ${take.n}`,
          title: 'Like: this mood leans towards these settings',
          onclick: () => this.rate(take.id, 1),
        },
        icon(ThumbsUp, size),
      ),
      h(
        'button',
        {
          class: `${cls} down`,
          type: 'button',
          'aria-pressed': String(take.rating === -1),
          'aria-label': `Dislike take ${take.n}`,
          title: 'Dislike: this mood leans away from these settings',
          onclick: () => this.rate(take.id, -1),
        },
        icon(ThumbsDown, size),
      ),
      h(
        'button',
        {
          class: `${cls} star`,
          type: 'button',
          'aria-pressed': String(take.favorite),
          'aria-label': take.favorite ? `Remove take ${take.n} from favorites` : `Add take ${take.n} to favorites`,
          title: 'Favorite: keeps the seed and the settings',
          onclick: () => this.toggleFavorite(take.id),
        },
        icon(Star, size),
      ),
    ];
  }

  private rate(id: string, value: 1 | -1): void {
    const before = this.store.learned();
    const take = this.store.rate(id, value);
    if (!take) return;
    if (this.current?.id === id) this.current = take;
    this.refreshCurrent();
    this.refreshTakes();
    this.refreshKnobs();
    if (take.rating === 0) {
      this.toast('Rating removed.');
      return;
    }
    if (!take.preset) {
      this.toast('Noted. Takes made without a mood do not move any ranges.');
      return;
    }
    const after = this.store.learned()[take.preset];
    const was = before[take.preset];
    const moved = learnedShifts(take.preset, after)
      .map((s) => {
        const prev = was.ranges[s.key];
        const shift = Math.abs((s.to.lo + s.to.hi) / 2 - (prev.lo + prev.hi) / 2) / (PARAM_SPECS[s.key].max - PARAM_SPECS[s.key].min);
        return { ...s, shift };
      })
      .sort((a, b) => b.shift - a.shift)
      .slice(0, 2)
      .map((s) => `${PARAM_SPECS[s.key].label.toLowerCase()} ${paramLabel(s.key, s.to.lo)} to ${paramLabel(s.key, s.to.hi)}`);
    const label = PRESETS[take.preset].label;
    this.toast(
      moved.length > 0
        ? `Noted. ${label} now picks ${moved.join(', ')}.`
        : `Noted. ${label} keeps its ranges for now.`,
    );
  }

  private toggleFavorite(id: string): void {
    const take = this.store.toggleFavorite(id);
    if (!take) return;
    if (this.current?.id === id) this.current = take;
    this.refreshCurrent();
    this.refreshTakes();
    this.toast(take.favorite ? `Take #${take.n} saved to favorites (seed and settings).` : `Take #${take.n} removed from favorites.`);
  }

  private removeTake(id: string): void {
    const wasCurrent = this.current?.id === id;
    this.store.remove(id);
    if (wasCurrent) {
      this.stopPlayback();
      this.current = null;
      this.piece = null;
      this.render = null;
      this.refreshCurrent();
      this.refreshKnobs();
      this.refreshViews();
    }
    this.refreshTakes();
  }

  private refreshTakes(): void {
    const all = this.store.list();
    const favorites = all.filter((t) => t.favorite);
    clear(this.els.takesTabs);
    const tab = (id: UiPrefs['tab'], label: string, count: number, node: SVGElement): HTMLButtonElement =>
      h(
        'button',
        {
          class: 'tab',
          type: 'button',
          role: 'tab',
          'aria-selected': String(this.prefs.tab === id),
          onclick: () => {
            this.prefs.tab = id;
            this.savePrefs();
            this.refreshTakes();
          },
        },
        node,
        label,
        h('span', { class: 'tab-count' }, String(count)),
      );
    this.els.takesTabs.append(
      tab('history', 'History', all.length, icon(HistoryIcon, 14)),
      tab('favorites', 'Favorites', favorites.length, icon(Star, 14)),
    );

    const list = this.prefs.tab === 'favorites' ? favorites : all;
    clear(this.els.takes);
    if (list.length === 0) {
      this.els.takes.append(
        h(
          'li',
          { class: 'empty' },
          this.prefs.tab === 'favorites'
            ? 'No favorites yet. The star on a take keeps its seed and settings.'
            : 'No takes yet. Every Generate and every Again lands here.',
        ),
      );
      return;
    }
    for (const take of list) {
      const isCurrent = this.current?.id === take.id;
      this.els.takes.append(
        h(
          'li',
          { class: `take${isCurrent ? ' is-current' : ''}` },
          h(
            'button',
            {
              class: 'take-load',
              type: 'button',
              title: 'Load and play this take',
              'aria-current': isCurrent ? 'true' : null,
              onclick: () => void this.loadTake(take, { play: true }),
            },
            h('span', { class: 'take-name' }, takeTitle(take)),
            h('span', { class: 'take-meta' }, takeMeta(take)),
          ),
          ...this.ratingButtons(take, true),
          h(
            'button',
            {
              class: 'btn small icon-only',
              type: 'button',
              'aria-label': `Delete take ${take.n}`,
              title: 'Delete this take',
              onclick: () => this.removeTake(take.id),
            },
            icon(X, 14),
          ),
        ),
      );
    }
  }

  // ------------------------------------------------------------------ audio

  private ensureAudio(): Promise<AudioBundle> {
    if (this.audio) {
      if (this.audio.ctx.state === 'suspended') void this.audio.ctx.resume();
      return Promise.resolve(this.audio);
    }
    if (this.audioPromise) return this.audioPromise;
    // Created inside the click that asked for sound, so the browser lets it play.
    const ctx = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'playback' });
    void ctx.resume();
    this.setBusy(true, 'Loading the piano...');
    this.audioPromise = (async () => {
      const manifest = await fetchManifest();
      const fetchSample = urlSampleFetcher();
      const samples = await loadPianoSamples(ctx, fetchSample, manifest);
      const bundle: AudioBundle = { ctx, samples, manifest, fetchSample, player: new Player(ctx, samples) };
      this.audio = bundle;
      return bundle;
    })();
    this.audioPromise
      .catch((error: unknown) => {
        this.audioPromise = null;
        void ctx.close();
        this.toast(`The piano samples could not be loaded (${error instanceof Error ? error.message : String(error)}).`);
      })
      .finally(() => this.setBusy(false, ''));
    return this.audioPromise;
  }

  private setBusy(busy: boolean, label: string): void {
    const btn = this.els.generate;
    btn.classList.toggle('is-busy', busy);
    btn.replaceChildren(
      icon(busy ? LoaderCircle : Sparkles, 22),
      h('span', { class: 'generate-label' }, busy ? label : 'Generate'),
    );
  }

  private async play(fromSec: number): Promise<void> {
    const token = ++this.playToken;
    let audio: AudioBundle;
    try {
      audio = await this.ensureAudio();
    } catch {
      return;
    }
    const piece = this.piece;
    const take = this.current;
    if (token !== this.playToken || !piece || !take) return;
    const rendered = this.render && this.render.key === this.renderKey(take) ? this.render.result : null;
    audio.player.play(piece, {
      fromSec,
      totalSec: rendered ? rendered.length / rendered.sampleRate : undefined,
      onEnded: () => this.refreshTransport(),
    });
    this.refreshTransport();
    this.tick();
  }

  private stopPlayback(): void {
    this.playToken++;
    this.audio?.player.stop();
    this.refreshTransport();
  }

  private async togglePlay(): Promise<void> {
    if (this.audio?.player.isPlaying) {
      this.stopPlayback();
      return;
    }
    if (this.piece) await this.play(0);
  }

  private seek(sec: number): void {
    if (!this.piece) return;
    void this.play(sec);
  }

  private totalSec(): number {
    const take = this.current;
    if (!this.piece || !take) return 0;
    if (this.render && this.render.key === this.renderKey(take)) return this.render.result.length / this.render.result.sampleRate;
    return totalSecFor(this.piece);
  }

  private refreshTransport(): void {
    const playing = this.audio?.player.isPlaying ?? false;
    const btn = this.els.play;
    btn.replaceChildren(icon(playing ? Square : Play, 16));
    btn.setAttribute('aria-label', playing ? 'Stop' : 'Play');
    btn.title = playing ? 'Stop (Space)' : 'Play from the start (Space)';
    btn.setAttribute('aria-pressed', String(playing));
    if (!playing) {
      this.roll.setPlayhead(-1);
      this.wave.setPlayhead(-1);
      this.els.time.textContent = `0:00 / ${formatTime(this.totalSec())}`;
    }
  }

  private tick(): void {
    cancelAnimationFrame(this.raf);
    const step = (): void => {
      const player = this.audio?.player;
      if (!player || !player.isPlaying) {
        this.refreshTransport();
        return;
      }
      const pos = player.position;
      this.roll.setPlayhead(pos);
      this.wave.setPlayhead(pos);
      this.els.time.textContent = `${formatTime(pos)} / ${formatTime(this.totalSec())}`;
      this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
  }

  // ------------------------------------------------------------------ views and render

  private setView(view: UiPrefs['view'], save = true): void {
    this.prefs.view = view;
    if (save) this.savePrefs();
    this.els.tabRoll.setAttribute('aria-selected', String(view === 'roll'));
    this.els.tabWave.setAttribute('aria-selected', String(view === 'wave'));
    this.roll.element.hidden = view !== 'roll';
    this.wave.element.hidden = view !== 'wave';
    this.roll.resize();
    this.wave.resize();
    if (view === 'wave' && this.current && !this.currentRender()) void this.ensureRender().catch(() => undefined);
  }

  private renderKey(take: Take): string {
    return JSON.stringify(take.params);
  }

  private currentRender(): RenderResult | null {
    const take = this.current;
    return take && this.render && this.render.key === this.renderKey(take) ? this.render.result : null;
  }

  private refreshViews(): void {
    const piece = this.piece;
    const rendered = this.currentRender();
    const total = rendered ? rendered.length / rendered.sampleRate : piece ? totalSecFor(piece) : undefined;
    this.roll.setPiece(piece, total);
    const busy = this.renderJob !== null && this.current !== null && this.renderJob.key === this.renderKey(this.current);
    this.wave.setAudio(
      piece,
      rendered ? rendered.mix : null,
      rendered ? rendered.sampleRate : SAMPLE_RATE,
      !piece ? 'Press Generate first.' : busy ? 'Rendering the audio...' : 'The waveform shows up once the take is rendered.',
    );
    this.refreshTransport();
  }

  /** Renders the current take offline (once) for the waveform and the WAV / stems export. */
  private async ensureRender(): Promise<RenderResult> {
    const take = this.current;
    const piece = this.piece;
    if (!take || !piece) throw new Error('No take to render.');
    const key = this.renderKey(take);
    if (this.render && this.render.key === key) return this.render.result;
    if (this.renderJob && this.renderJob.key === key) return this.renderJob.promise;
    const promise = (async () => {
      const audio = await this.ensureAudio();
      this.els.viewStatus.textContent = 'Rendering the audio...';
      const started = performance.now();
      const result = await renderPiece(piece, {
        createContext: (channels, length, sampleRate) => new OfflineAudioContext(channels, length, sampleRate),
        fetchSample: audio.fetchSample,
        manifest: audio.manifest,
        samples: audio.samples,
      });
      // Keep only the newest render: one take is around 150 MB of float audio.
      this.render = { key, result };
      const sec = ((performance.now() - started) / 1000).toFixed(1);
      if (this.current && this.renderKey(this.current) === key) {
        this.els.viewStatus.textContent = `Rendered ${formatTime(result.length / result.sampleRate)} in ${sec} s.`;
      }
      return result;
    })();
    this.renderJob = { key, promise };
    this.refreshViews();
    try {
      return await promise;
    } catch (error) {
      this.els.viewStatus.textContent = '';
      this.toast(`Rendering failed (${error instanceof Error ? error.message : String(error)}).`);
      throw error;
    } finally {
      if (this.renderJob?.promise === promise) this.renderJob = null;
      this.refreshViews();
    }
  }

  // ------------------------------------------------------------------ export

  private exportMidi(): void {
    if (!this.piece || !this.current) return;
    const bytes = pieceToMidi(this.piece);
    downloadBytes(new Uint8Array(bytes), `${fileStem(this.current)}.mid`, 'audio/midi');
    this.toast('MIDI saved: piano with pedal on channel 1, pad on channel 2.');
  }

  private async withBusy(button: HTMLButtonElement, work: () => Promise<void>): Promise<void> {
    if (button.classList.contains('is-busy')) return;
    const original = Array.from(button.childNodes);
    button.classList.add('is-busy');
    button.replaceChildren(icon(LoaderCircle, 14), 'Rendering');
    try {
      await work();
    } catch {
      // ensureRender has already told the user.
    } finally {
      button.classList.remove('is-busy');
      button.replaceChildren(...original);
    }
  }

  private async exportWav(): Promise<void> {
    const take = this.current;
    if (!take) return;
    await this.withBusy(this.els.exportWav, async () => {
      const result = await this.ensureRender();
      downloadBytes(encodeWav(result.mix, result.sampleRate), `${fileStem(take)}.wav`, 'audio/wav');
      this.toast('WAV saved (48 kHz, 16 bit, peak -1.5 dBFS). Credit the piano samples when you publish it: see About.');
    });
  }

  private async exportStems(): Promise<void> {
    const take = this.current;
    const piece = this.piece;
    if (!take || !piece) return;
    await this.withBusy(this.els.exportStems, async () => {
      const result = await this.ensureRender();
      const text = new TextEncoder();
      const stem = fileStem(take);
      const zip = makeZip(
        [
          { name: `${stem}/piano.wav`, data: encodeWav(result.stems.piano, result.sampleRate) },
          { name: `${stem}/pad.wav`, data: encodeWav(result.stems.pad, result.sampleRate) },
          { name: `${stem}/noise.wav`, data: encodeWav(result.stems.noise, result.sampleRate) },
          { name: `${stem}/mix.wav`, data: encodeWav(result.mix, result.sampleRate) },
          { name: `${stem}/notes.mid`, data: pieceToMidi(piece) },
          { name: `${stem}/settings.json`, data: text.encode(JSON.stringify(take.params, null, 2) + '\n') },
          { name: `${stem}/CREDITS.txt`, data: text.encode(CREDITS) },
        ],
        new Date(),
      );
      downloadBytes(zip, `${stem}-stems.zip`, 'application/zip');
      this.toast('Stems saved: piano, pad, noise, mix, MIDI and the settings in one zip.');
    });
  }

  // ------------------------------------------------------------------ keyboard

  private onKey(e: KeyboardEvent): void {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    const target = e.target as HTMLElement | null;
    if (target) {
      const tag = target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) return;
      if (target.getAttribute('role') === 'slider') return;
      if (target.closest('dialog')) return;
      if (e.key === ' ' && tag === 'BUTTON') return;
    }
    if (e.key === ' ') {
      e.preventDefault();
      void this.togglePlay();
    } else if (e.key === 'g' || e.key === 'G') {
      e.preventDefault();
      void this.generateNew();
    } else if (e.key === 'a' || e.key === 'A') {
      e.preventDefault();
      void this.again();
    }
  }
}

function brandMark(): SVGElement {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 26 26');
  svg.setAttribute('class', 'brand-mark');
  svg.setAttribute('aria-hidden', 'true');
  const add = (tag: string, attrs: Record<string, string>): void => {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    svg.append(el);
  };
  // Three notes that fade: a motif and its echo.
  add('circle', { cx: '13', cy: '13', r: '12', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.4', opacity: '0.35' });
  add('rect', { x: '5.5', y: '14', width: '6', height: '3', rx: '1.5', fill: 'currentColor' });
  add('rect', { x: '10.5', y: '9.5', width: '7', height: '3', rx: '1.5', fill: 'currentColor', opacity: '0.75' });
  add('rect', { x: '15', y: '16.5', width: '5.5', height: '3', rx: '1.5', fill: 'currentColor', opacity: '0.45' });
  return svg;
}

export function mountApp(root: HTMLElement): App {
  return new App(root);
}
