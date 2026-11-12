/**
 * A rotary knob: drag up/down, arrow keys, wheel while focused. role="slider".
 * It also shows the range a preset draws from (a faint arc) and whether the
 * value is pinned (kept when Generate is pressed).
 */
import { Lock, LockOpen } from 'lucide';
import { h, icon } from './dom';

export interface KnobOptions {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  /** Text for a value, e.g. "56 BPM". */
  format: (value: number) => string;
  /** Fires while dragging. */
  onInput?: (value: number) => void;
  /** Fires when a change is finished (pointer released, key pressed). */
  onChange: (value: number) => void;
  /** Fires when the pin button is pressed. */
  onPinToggle?: (pinned: boolean) => void;
  /** False: no pin button (a knob that is always just a value). Default true. */
  pinnable?: boolean;
  title?: string;
}

const SWEEP = 270; // degrees of travel
const START = 135; // degrees, measured clockwise from 3 o'clock
const R = 22;
const C = 28;
const NS = 'http://www.w3.org/2000/svg';

function polar(deg: number, radius = R): [number, number] {
  const rad = (deg * Math.PI) / 180;
  return [C + radius * Math.cos(rad), C + radius * Math.sin(rad)];
}

function arcPath(fromDeg: number, toDeg: number): string {
  const [x0, y0] = polar(fromDeg);
  const [x1, y1] = polar(toDeg);
  const large = toDeg - fromDeg > 180 ? 1 : 0;
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${R} ${R} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

function svgEl(tag: string, attrs: Record<string, string>): SVGElement {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

export class Knob {
  readonly element: HTMLElement;
  private readonly opts: KnobOptions;
  private readonly dial: HTMLElement;
  private readonly valueArc: SVGElement;
  private readonly rangeArc: SVGElement;
  private readonly dot: SVGElement;
  private readonly valueText: HTMLElement;
  private readonly pinButton: HTMLButtonElement;
  private value: number;
  private pinned = false;
  private dragStart: { y: number; value: number } | null = null;
  private committed: number;

  constructor(opts: KnobOptions) {
    this.opts = opts;
    this.value = opts.value;
    this.committed = opts.value;

    const svg = svgEl('svg', { viewBox: '0 0 56 56', class: 'knob-svg', 'aria-hidden': 'true' });
    svg.append(svgEl('path', { d: arcPath(START, START + SWEEP), class: 'knob-track' }));
    this.rangeArc = svgEl('path', { d: '', class: 'knob-range' });
    this.valueArc = svgEl('path', { d: '', class: 'knob-value-arc' });
    this.dot = svgEl('circle', { r: '2.6', class: 'knob-dot' });
    svg.append(this.rangeArc, this.valueArc, this.dot);

    this.dial = h('div', {
      class: 'knob-dial',
      role: 'slider',
      tabindex: '0',
      'aria-label': opts.label,
      'aria-valuemin': opts.min,
      'aria-valuemax': opts.max,
      title: opts.title ?? `${opts.label}: drag up or down, or use the arrow keys`,
    });
    this.dial.append(svg);
    this.valueText = h('div', { class: 'knob-value' });
    this.pinButton = h('button', {
      class: 'knob-pin',
      type: 'button',
      'aria-pressed': 'false',
      onclick: () => {
        this.setPinned(!this.pinned);
        this.opts.onPinToggle?.(this.pinned);
      },
    });
    this.element = h(
      'div',
      { class: 'knob' },
      this.dial,
      h('div', { class: 'knob-label' }, opts.label),
      this.valueText,
      opts.pinnable === false ? null : this.pinButton,
    );

    this.dial.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    this.dial.addEventListener('pointermove', (e) => this.onPointerMove(e));
    this.dial.addEventListener('pointerup', (e) => this.onPointerUp(e));
    this.dial.addEventListener('pointercancel', (e) => this.onPointerUp(e));
    this.dial.addEventListener('keydown', (e) => this.onKeyDown(e));
    this.dial.addEventListener(
      'wheel',
      (e) => {
        if (document.activeElement !== this.dial) return;
        e.preventDefault();
        this.nudge(e.deltaY < 0 ? 1 : -1, true);
      },
      { passive: false },
    );
    this.setPinned(false);
    this.paint();
  }

  getValue(): number {
    return this.value;
  }

  /** Sets the shown value without firing callbacks. */
  setValue(value: number): void {
    this.value = this.snap(value);
    this.committed = this.value;
    this.paint();
  }

  /** The range Generate draws from (null hides the arc). */
  setRange(range: { lo: number; hi: number } | null): void {
    if (!range) {
      this.rangeArc.setAttribute('d', '');
      return;
    }
    const a = this.angle(Math.min(range.lo, range.hi));
    const b = this.angle(Math.max(range.lo, range.hi));
    // A zero-width range still shows as a short tick.
    this.rangeArc.setAttribute('d', arcPath(a - (b - a < 3 ? 1.5 : 0), b + (b - a < 3 ? 1.5 : 0)));
  }

  setPinned(pinned: boolean): void {
    this.pinned = pinned;
    this.element.classList.toggle('is-pinned', pinned);
    this.pinButton.setAttribute('aria-pressed', String(pinned));
    const label = pinned
      ? `${this.opts.label} is fixed. Press to let Generate choose it again.`
      : `${this.opts.label} is chosen by Generate. Press to fix the current value.`;
    this.pinButton.setAttribute('aria-label', label);
    this.pinButton.title = label;
    this.pinButton.replaceChildren(icon(pinned ? Lock : LockOpen, 12));
  }

  private snap(value: number): number {
    const { min, max, step } = this.opts;
    const stepped = Math.round((value - min) / step) * step + min;
    return Number(Math.min(max, Math.max(min, stepped)).toFixed(4));
  }

  private angle(value: number): number {
    const { min, max } = this.opts;
    const t = Math.min(1, Math.max(0, (value - min) / (max - min)));
    return START + t * SWEEP;
  }

  private paint(): void {
    const a = this.angle(this.value);
    this.valueArc.setAttribute('d', a - START > 0.5 ? arcPath(START, a) : '');
    const [x, y] = polar(a, R - 7);
    this.dot.setAttribute('cx', x.toFixed(2));
    this.dot.setAttribute('cy', y.toFixed(2));
    const text = this.opts.format(this.value);
    this.valueText.textContent = text;
    this.dial.setAttribute('aria-valuenow', String(this.value));
    this.dial.setAttribute('aria-valuetext', text);
  }

  private input(value: number): void {
    const next = this.snap(value);
    if (next === this.value) return;
    this.value = next;
    this.paint();
    this.opts.onInput?.(next);
  }

  private commit(): void {
    if (this.value === this.committed) return;
    this.committed = this.value;
    this.opts.onChange(this.value);
  }

  private nudge(steps: number, commit: boolean): void {
    this.input(this.value + steps * this.opts.step);
    if (commit) this.commit();
  }

  private onPointerDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    this.dial.setPointerCapture(e.pointerId);
    this.dial.focus();
    this.dragStart = { y: e.clientY, value: this.value };
    this.element.classList.add('is-dragging');
    e.preventDefault();
  }

  private onPointerMove(e: PointerEvent): void {
    if (!this.dragStart) return;
    const { min, max } = this.opts;
    const fine = e.shiftKey ? 0.25 : 1;
    const delta = ((this.dragStart.y - e.clientY) / 150) * (max - min) * fine;
    this.input(this.dragStart.value + delta);
  }

  private onPointerUp(e: PointerEvent): void {
    if (!this.dragStart) return;
    this.dragStart = null;
    this.element.classList.remove('is-dragging');
    if (this.dial.hasPointerCapture(e.pointerId)) this.dial.releasePointerCapture(e.pointerId);
    this.commit();
  }

  private onKeyDown(e: KeyboardEvent): void {
    const { min, max, step } = this.opts;
    const big = Math.max(1, Math.round((max - min) / step / 10));
    let handled = true;
    switch (e.key) {
      case 'ArrowUp':
      case 'ArrowRight':
        this.nudge(1, true);
        break;
      case 'ArrowDown':
      case 'ArrowLeft':
        this.nudge(-1, true);
        break;
      case 'PageUp':
        this.nudge(big, true);
        break;
      case 'PageDown':
        this.nudge(-big, true);
        break;
      case 'Home':
        this.input(min);
        this.commit();
        break;
      case 'End':
        this.input(max);
        this.commit();
        break;
      default:
        handled = false;
    }
    if (handled) e.preventDefault();
  }
}
