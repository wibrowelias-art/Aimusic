/**
 * Optional: drop in a track you own. The lab reads five general traits from it
 * (src/analysis/reference.ts) and offers knob values. No melody, no chords, no
 * notes are read or kept, and nothing is uploaded or stored.
 */
import { FileMusic, LoaderCircle, Upload } from 'lucide';
import { REFERENCE_MAX_SEC, REFERENCE_PROMISE, analyseReference, traitsToSettings, type ReferenceSettings } from '../analysis/reference';
import type { Params } from '../engine/types';
import type { TakeOrigin } from '../store/takes';
import { clear, h, icon } from './dom';

export interface ReferenceHost {
  getShownParams(): Params;
  applySettings(changes: Partial<Params>, origin: TakeOrigin): void;
  toast(text: string): void;
}

/** Hz. The file is decoded at this rate: plenty for the five traits, and quick. */
const DECODE_RATE = 22050;
const MAX_FILE_BYTES = 120 * 1024 * 1024;

export class ReferenceBox {
  readonly element: HTMLElement;
  private readonly host: ReferenceHost;
  private readonly drop: HTMLElement;
  private readonly result: HTMLElement;
  private readonly input: HTMLInputElement;
  private busy = false;

  constructor(host: ReferenceHost) {
    this.host = host;
    this.input = h('input', {
      type: 'file',
      accept: 'audio/*,.wav,.mp3,.flac,.ogg,.m4a,.aac',
      class: 'visually-hidden',
      'aria-label': 'Choose a reference track you own',
      onchange: () => {
        const file = this.input.files?.[0];
        this.input.value = '';
        if (file) void this.read(file);
      },
    });
    this.drop = h(
      'div',
      { class: 'drop' },
      icon(Upload, 18),
      h(
        'div',
        { class: 'drop-text' },
        h('strong', null, 'Drop a track you own'),
        h('span', null, ' or '),
        h('button', { class: 'link', type: 'button', onclick: () => this.input.click() }, 'choose a file'),
        h('span', null, '.'),
      ),
    );
    this.drop.addEventListener('dragover', (e) => {
      e.preventDefault();
      this.drop.classList.add('is-over');
    });
    this.drop.addEventListener('dragleave', () => this.drop.classList.remove('is-over'));
    this.drop.addEventListener('drop', (e) => {
      e.preventDefault();
      this.drop.classList.remove('is-over');
      const file = e.dataTransfer?.files?.[0];
      if (file) void this.read(file);
    });
    this.result = h('div', { class: 'reference-result', role: 'status', 'aria-live': 'polite' });
    this.element = h(
      'section',
      { class: 'panel reference', 'aria-label': 'Reference track' },
      h('h2', null, icon(FileMusic, 13), ' Reference (optional)'),
      this.drop,
      this.input,
      h('p', { class: 'hint' }, REFERENCE_PROMISE),
      this.result,
    );
  }

  private message(text: string, spinning = false): void {
    clear(this.result);
    this.result.append(h('p', { class: 'chat-note' }, spinning ? icon(LoaderCircle, 14) : null, spinning ? ' ' : null, text));
    this.result.classList.toggle('is-busy', spinning);
  }

  private async read(file: File): Promise<void> {
    if (this.busy) return;
    if (file.size > MAX_FILE_BYTES) {
      this.message('That file is larger than 120 MB. A shorter excerpt is enough.');
      return;
    }
    this.busy = true;
    this.message('Reading the general traits...', true);
    try {
      const bytes = await file.arrayBuffer();
      const ctx = new OfflineAudioContext(1, 1, DECODE_RATE);
      let buffer: AudioBuffer;
      try {
        buffer = await ctx.decodeAudioData(bytes);
      } catch {
        this.message('That file could not be read as audio. WAV, MP3, FLAC, OGG and M4A usually work.');
        return;
      }
      // Let the "reading" message paint before the analysis keeps the page busy.
      await new Promise((resolve) => setTimeout(resolve, 30));
      const channels: Float32Array[] = [];
      for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
      const traits = analyseReference(channels, buffer.sampleRate);
      // From here on only the numbers exist: the decoded audio is not kept anywhere.
      if (traits.analysedSec === 0) {
        this.message('That file is too short to read anything from (it needs at least a second of audio).');
        return;
      }
      this.show(traitsToSettings(traits, this.host.getShownParams()), traits.analysedSec, buffer.duration);
    } catch (error) {
      this.message(`Reading failed (${error instanceof Error ? error.message : String(error)}).`);
    } finally {
      this.busy = false;
      this.result.classList.remove('is-busy');
    }
  }

  private show(settings: ReferenceSettings, analysedSec: number, fileSec: number): void {
    clear(this.result);
    const table = h(
      'table',
      { class: 'reference-table' },
      h('thead', null, h('tr', null, h('th', null, 'Trait'), h('th', null, 'Read from the file'), h('th', null, 'Knob'))),
    );
    const body = h('tbody');
    for (const row of settings.rows) {
      body.append(h('tr', null, h('td', null, row.trait), h('td', null, row.measured), h('td', null, row.setting)));
    }
    table.append(body);
    const cut = fileSec > analysedSec + 1 ? ` (the first ${Math.round(REFERENCE_MAX_SEC / 60)} minutes)` : '';
    this.result.append(
      table,
      h(
        'p',
        { class: 'chat-note' },
        `Read ${Math.round(analysedSec)} s of audio${cut}. Nothing from the file is kept: only these knob values.`,
      ),
      h(
        'div',
        { class: 'reference-actions' },
        h(
          'button',
          {
            class: 'btn',
            type: 'button',
            onclick: () => {
              this.host.applySettings(settings.changes, 'reference');
              this.host.toast('Knobs set from the reference. The notes are still new: press Generate.');
              clear(this.result);
            },
          },
          'Use these settings',
        ),
        h('button', { class: 'btn ghost', type: 'button', onclick: () => clear(this.result) }, 'Dismiss'),
      ),
    );
  }
}
