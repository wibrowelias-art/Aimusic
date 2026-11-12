/**
 * The text box: "sadder, slower, more space, add rain" moves the knobs.
 * Rule-based (src/chat/rules.ts), nothing leaves the browser.
 */
import { ArrowRight, MessageSquare, Send } from 'lucide';
import { CHAT_EXAMPLES, applyChat, type ChatResult } from '../chat/rules';
import type { NumericParamKey, Params } from '../engine/types';
import type { TakeOrigin } from '../store/takes';
import { clear, h, icon } from './dom';

export interface ChatHost {
  getShownParams(): Params;
  hasTake(): boolean;
  applySettings(changes: Partial<Params>, origin: TakeOrigin): void;
  runAction(action: 'generate' | 'again'): void;
}

export class ChatBox {
  readonly element: HTMLElement;
  private readonly host: ChatHost;
  private readonly input: HTMLInputElement;
  private readonly log: HTMLElement;

  constructor(host: ChatHost) {
    this.host = host;
    this.input = h('input', {
      type: 'text',
      class: 'chat-input',
      placeholder: 'sadder, slower, more space, add rain',
      'aria-label': 'Describe how the piece should change',
      autocomplete: 'off',
      maxlength: '240',
    });
    this.log = h('div', { class: 'chat-log', role: 'status', 'aria-live': 'polite' });
    const form = h(
      'form',
      {
        class: 'chat-form',
        onsubmit: (e: Event) => {
          e.preventDefault();
          this.submit(this.input.value);
        },
      },
      this.input,
      h('button', { class: 'btn', type: 'submit' }, icon(Send, 14), 'Apply'),
    );
    const chips = h('div', { class: 'chips', 'aria-label': 'Examples' });
    for (const example of CHAT_EXAMPLES) {
      chips.append(
        h('button', { class: 'chip', type: 'button', onclick: () => this.submit(example) }, example),
      );
    }
    this.element = h(
      'section',
      { class: 'panel chat', 'aria-label': 'Tell the lab' },
      h('h2', null, icon(MessageSquare, 13), ' Tell the lab'),
      form,
      chips,
      this.log,
    );
  }

  private submit(text: string): void {
    const before = this.host.getShownParams();
    const result = applyChat(text, before);
    const changed: Partial<Params> = {};
    for (const change of result.changes) {
      if (change.key === 'mode') changed.mode = result.params.mode;
      else if (change.key === 'key') changed.key = result.params.key;
      else changed[change.key as NumericParamKey] = result.params[change.key as NumericParamKey];
    }
    const hadTake = this.host.hasTake();
    if (result.changes.length > 0) this.host.applySettings(changed, 'chat');
    if (result.action) this.host.runAction(result.action);
    this.show(text, result, hadTake || result.action !== null);
    if (result.changes.length > 0 || result.action) this.input.value = '';
  }

  private show(text: string, result: ChatResult, hasTake: boolean): void {
    clear(this.log);
    const said = text.trim();
    if (said) this.log.append(h('p', { class: 'chat-said' }, `"${said}"`));

    if (result.changes.length > 0) {
      const list = h('ul', { class: 'chat-changes' });
      for (const c of result.changes) {
        list.append(
          h(
            'li',
            null,
            h('span', { class: 'chat-key' }, c.label),
            h('span', { class: 'chat-from' }, c.from),
            icon(ArrowRight, 12),
            h('span', { class: 'chat-to' }, c.to),
          ),
        );
      }
      this.log.append(list);
      if (!hasTake) this.log.append(h('p', { class: 'chat-note' }, 'No take yet: these are fixed for the next Generate.'));
    } else if (result.refused.length === 0 && result.action === null && result.notes.length === 0) {
      this.log.append(h('p', { class: 'chat-note' }, 'Nothing changed.'));
    }
    if (result.action) {
      this.log.append(
        h('p', { class: 'chat-note' }, result.action === 'generate' ? 'Made a new take.' : 'Made a variation of this take.'),
      );
    }
    if (result.refused.length > 0) {
      this.log.append(
        h(
          'div',
          { class: 'chat-refused' },
          h('p', null, result.notes[0] ?? ''),
          h('p', { class: 'chat-left-out' }, `Left out: ${result.refused.map((r) => `"${r}"`).join(', ')}`),
        ),
      );
    }
    for (const note of result.refused.length > 0 ? result.notes.slice(1) : result.notes) {
      this.log.append(h('p', { class: 'chat-note' }, note));
    }
    if (result.ignored.length > 0) {
      this.log.append(h('p', { class: 'chat-note' }, `Not understood: ${result.ignored.join(', ')}`));
    }
  }
}
