/**
 * The two pictures of a take: piano roll (always there, drawn from the notes)
 * and waveform (drawn once the take has been rendered). Both share the time
 * axis, the section tints and the playhead, and both seek on click.
 */
import { planReleases } from '../audio/graph';
import type { StereoPcm } from '../audio/types';
import type { Piece, SectionName } from '../engine/types';
import { h } from './dom';

const SECTION_LABEL: Record<SectionName, string> = { A: 'A', B: 'B', A2: "A'" };

interface Palette {
  bg: string;
  line: string;
  text: string;
  muted: string;
  faint: string;
  accent: string;
  warm: string;
  violet: string;
}

function readPalette(el: Element): Palette {
  const css = getComputedStyle(el);
  const get = (name: string, fallback: string): string => css.getPropertyValue(name).trim() || fallback;
  return {
    bg: get('--surface-sunk', '#0b0e12'),
    line: get('--line', '#262f3a'),
    text: get('--text', '#e8edf2'),
    muted: get('--muted', '#8e9aa8'),
    faint: get('--faint', '#5d6875'),
    accent: get('--accent', '#8fd3b6'),
    warm: get('--warm', '#e9b872'),
    violet: get('--violet', '#a9a1e8'),
  };
}

function withAlpha(hex: string, alpha: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/** Canvas plumbing shared by both views: sizing, the playhead layer, seeking. */
abstract class TimelineView {
  readonly element: HTMLElement;
  protected readonly base: HTMLCanvasElement;
  private readonly overlay: HTMLCanvasElement;
  protected piece: Piece | null = null;
  /** Seconds shown on the time axis. */
  protected totalSec = 1;
  protected width = 0;
  protected height = 0;
  private playhead = -1;
  private readonly observer: ResizeObserver | null;
  onSeek: ((sec: number) => void) | null = null;

  constructor(className: string, label: string) {
    this.base = h('canvas', { class: 'view-canvas' });
    this.overlay = h('canvas', { class: 'view-canvas view-overlay' });
    this.element = h('div', { class: `view ${className}`, role: 'img', 'aria-label': label }, this.base, this.overlay);
    this.overlay.addEventListener('click', (e) => {
      if (!this.piece || !this.onSeek) return;
      const rect = this.overlay.getBoundingClientRect();
      const t = ((e.clientX - rect.left) / Math.max(1, rect.width)) * this.totalSec;
      this.onSeek(Math.min(Math.max(0, t), Math.max(0, this.piece.durationSec - 0.05)));
    });
    this.observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => {
            this.resize();
          });
    this.observer?.observe(this.element);
  }

  /** Call after the element has been put into the document or shown again. */
  resize(): void {
    const rect = this.element.getBoundingClientRect();
    const w = Math.max(0, Math.floor(rect.width));
    const hgt = Math.max(0, Math.floor(rect.height));
    if (w === this.width && hgt === this.height) return;
    this.width = w;
    this.height = hgt;
    const dpr = Math.min(3, globalThis.devicePixelRatio || 1);
    for (const canvas of [this.base, this.overlay]) {
      canvas.width = Math.max(1, Math.round(w * dpr));
      canvas.height = Math.max(1, Math.round(hgt * dpr));
      canvas.style.width = `${w}px`;
      canvas.style.height = `${hgt}px`;
      canvas.getContext('2d')?.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    this.redraw();
    this.paintPlayhead();
  }

  setPlayhead(sec: number): void {
    if (sec === this.playhead) return;
    this.playhead = sec;
    this.paintPlayhead();
  }

  protected x(sec: number): number {
    return (sec / this.totalSec) * this.width;
  }

  protected redraw(): void {
    const ctx = this.base.getContext('2d');
    if (!ctx || this.width === 0 || this.height === 0) return;
    const palette = readPalette(this.element);
    ctx.clearRect(0, 0, this.width, this.height);
    ctx.fillStyle = palette.bg;
    ctx.fillRect(0, 0, this.width, this.height);
    this.paint(ctx, palette);
  }

  /** Section tints, bar lines, section letters and chord names along the top. */
  protected paintFrame(ctx: CanvasRenderingContext2D, palette: Palette, top: number): void {
    const piece = this.piece;
    if (!piece) return;
    const tint: Record<SectionName, string> = { A: palette.accent, B: palette.warm, A2: palette.violet };
    for (const s of piece.sections) {
      const x0 = this.x(s.startTime);
      const x1 = this.x(s.endTime);
      ctx.fillStyle = withAlpha(tint[s.name], 0.045);
      ctx.fillRect(x0, 0, x1 - x0, this.height);
      ctx.fillStyle = withAlpha(tint[s.name], 0.9);
      ctx.font = '600 11px Inter Variable, Inter, system-ui, sans-serif';
      ctx.textBaseline = 'top';
      ctx.fillText(SECTION_LABEL[s.name], x0 + 6, 5);
    }
    ctx.strokeStyle = withAlpha(palette.line, 0.7);
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let b = 0; b < piece.barTimes.length; b++) {
      const x = Math.round(this.x(piece.barTimes[b])) + 0.5;
      ctx.moveTo(x, top);
      ctx.lineTo(x, this.height);
    }
    ctx.stroke();
    ctx.font = '500 10.5px Inter Variable, Inter, system-ui, sans-serif';
    ctx.textBaseline = 'top';
    let lastRight = -Infinity;
    for (const c of piece.chords) {
      const x = this.x(c.startTime) + 6;
      // Skip a label that would run into the previous one or into a section letter.
      const sectionStart = piece.sections.some((s) => Math.abs(s.startTime - c.startTime) < 1e-6);
      const left = sectionStart ? x + 16 : x;
      if (left < lastRight + 6) continue;
      ctx.fillStyle = palette.muted;
      ctx.fillText(c.name, left, 5.5);
      lastRight = left + ctx.measureText(c.name).width;
    }
  }

  private paintPlayhead(): void {
    const ctx = this.overlay.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, this.width, this.height);
    if (!this.piece || this.playhead < 0) return;
    const x = Math.round(this.x(Math.min(this.playhead, this.totalSec))) + 0.5;
    const palette = readPalette(this.element);
    ctx.strokeStyle = palette.text;
    ctx.globalAlpha = 0.85;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, this.height);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  protected abstract paint(ctx: CanvasRenderingContext2D, palette: Palette): void;
}

export class PianoRoll extends TimelineView {
  constructor() {
    super('view-roll', 'Piano roll of the current take');
  }

  setPiece(piece: Piece | null, totalSec?: number): void {
    this.piece = piece;
    this.totalSec = Math.max(1, totalSec ?? (piece ? piece.durationSec + 3 : 1));
    this.redraw();
  }

  protected paint(ctx: CanvasRenderingContext2D, palette: Palette): void {
    const piece = this.piece;
    const top = 24;
    if (!piece) {
      ctx.fillStyle = palette.faint;
      ctx.font = '500 13px Inter Variable, Inter, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('Press Generate. The notes show up here.', this.width / 2, this.height / 2);
      ctx.textAlign = 'start';
      return;
    }
    this.paintFrame(ctx, palette, top);

    let lo = Infinity;
    let hi = -Infinity;
    for (const n of piece.notes) {
      lo = Math.min(lo, n.pitch);
      hi = Math.max(hi, n.pitch);
    }
    for (const n of piece.pad) {
      lo = Math.min(lo, n.pitch);
      hi = Math.max(hi, n.pitch);
    }
    if (!Number.isFinite(lo)) return;
    lo -= 2;
    hi += 2;
    const bodyH = this.height - top - 6;
    const rowH = bodyH / (hi - lo + 1);
    const y = (pitch: number): number => top + (hi - pitch) * rowH;
    const noteH = Math.max(2.5, Math.min(7, rowH * 0.9));

    // Faint lines at every C for orientation.
    ctx.strokeStyle = withAlpha(palette.line, 0.55);
    ctx.beginPath();
    for (let p = Math.ceil(lo / 12) * 12; p <= hi; p += 12) {
      const yy = Math.round(y(p) + rowH / 2) + 0.5;
      ctx.moveTo(0, yy);
      ctx.lineTo(this.width, yy);
    }
    ctx.stroke();

    // Pad: wide soft bars behind the piano.
    ctx.fillStyle = withAlpha(palette.violet, piece.params.pad > 0 ? 0.13 : 0.04);
    for (const n of piece.pad) {
      const x0 = this.x(n.time);
      ctx.fillRect(x0, y(n.pitch) + rowH / 2 - noteH / 2, Math.max(1, this.x(n.time + n.duration) - x0), noteH);
    }

    // Piano: the key-down part solid, the pedal ring as a thin tail.
    const releases = planReleases(piece.notes, piece.pedal, piece.durationSec);
    const colour = { melody: palette.accent, bass: palette.warm, harmony: palette.warm, echo: palette.accent } as const;
    piece.notes.forEach((n, i) => {
      const base = colour[n.role];
      const alpha = 0.45 + 0.55 * Math.min(1, Math.max(0, (n.velocity - 20) / 50));
      const x0 = this.x(n.time);
      const x1 = this.x(n.time + n.duration);
      const yy = y(n.pitch) + rowH / 2;
      const ringEnd = Number.isFinite(releases[i].releaseSec)
        ? releases[i].releaseSec
        : Math.min(piece.durationSec, n.time + 6);
      if (ringEnd > n.time + n.duration) {
        ctx.fillStyle = withAlpha(base, 0.22 * alpha);
        ctx.fillRect(x1, yy - 0.75, Math.max(0, this.x(ringEnd) - x1), 1.5);
      }
      const w = Math.max(2.5, x1 - x0);
      if (n.role === 'echo') {
        ctx.strokeStyle = withAlpha(base, 0.8 * alpha);
        ctx.lineWidth = 1;
        ctx.strokeRect(x0 + 0.5, yy - noteH / 2 + 0.5, Math.max(1.5, w - 1), Math.max(1.5, noteH - 1));
      } else {
        ctx.fillStyle = withAlpha(base, (n.passing ? 0.6 : 1) * alpha);
        ctx.beginPath();
        ctx.roundRect(x0, yy - noteH / 2, w, noteH, Math.min(2, noteH / 2));
        ctx.fill();
      }
    });
  }
}

export class Waveform extends TimelineView {
  private peaks: { min: Float32Array; max: Float32Array } | null = null;
  private mix: StereoPcm | null = null;
  private message = '';

  constructor() {
    super('view-wave', 'Waveform of the current take');
  }

  /** `mix` null = not rendered yet; `message` is shown instead. */
  setAudio(piece: Piece | null, mix: StereoPcm | null, sampleRate: number, message: string): void {
    this.piece = piece;
    this.mix = mix;
    this.message = message;
    this.peaks = null;
    this.totalSec = Math.max(1, mix ? mix[0].length / sampleRate : piece ? piece.durationSec + 3 : 1);
    this.redraw();
  }

  /** Seconds on the time axis (the rendered file length once there is audio). */
  get shownSec(): number {
    return this.totalSec;
  }

  private computePeaks(columns: number): { min: Float32Array; max: Float32Array } {
    const min = new Float32Array(columns);
    const max = new Float32Array(columns);
    const mix = this.mix;
    if (!mix) return { min, max };
    const [l, r] = mix;
    const per = l.length / columns;
    for (let c = 0; c < columns; c++) {
      const from = Math.floor(c * per);
      const to = Math.min(l.length, Math.max(from + 1, Math.floor((c + 1) * per)));
      let lo = 0;
      let hi = 0;
      for (let i = from; i < to; i++) {
        const v = 0.5 * (l[i] + r[i]);
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      min[c] = lo;
      max[c] = hi;
    }
    return { min, max };
  }

  protected paint(ctx: CanvasRenderingContext2D, palette: Palette): void {
    const top = 24;
    this.paintFrame(ctx, palette, top);
    const mid = top + (this.height - top) / 2;
    if (!this.mix) {
      ctx.fillStyle = palette.faint;
      ctx.font = '500 13px Inter Variable, Inter, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(this.message, this.width / 2, mid);
      ctx.textAlign = 'start';
      return;
    }
    const columns = Math.max(1, Math.floor(this.width));
    if (!this.peaks || this.peaks.min.length !== columns) this.peaks = this.computePeaks(columns);
    const half = (this.height - top) / 2 - 6;
    // The mix peaks at -1.5 dBFS but sits 20 dB lower most of the time; a gentle
    // power curve keeps the quiet tails visible without flattening the picture.
    const shape = (v: number): number => Math.sign(v) * Math.abs(v) ** 0.7;
    ctx.fillStyle = withAlpha(palette.accent, 0.85);
    ctx.beginPath();
    for (let c = 0; c < columns; c++) ctx.lineTo(c + 0.5, mid - shape(this.peaks.max[c]) * half);
    for (let c = columns - 1; c >= 0; c--) ctx.lineTo(c + 0.5, mid - shape(this.peaks.min[c]) * half);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = withAlpha(palette.accent, 0.35);
    ctx.beginPath();
    ctx.moveTo(0, Math.round(mid) + 0.5);
    ctx.lineTo(this.width, Math.round(mid) + 0.5);
    ctx.stroke();
  }
}
