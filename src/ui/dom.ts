/** Small DOM helpers. No framework: plain elements. */
import { createElement as createIcon, type IconNode } from 'lucide';

type Child = Node | string | number | null | undefined | false;
type Attrs = Record<string, unknown>;

/** h('button', { class: 'x', onclick: fn, 'aria-label': 'y' }, child, ...) */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Attrs | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value === null || value === undefined || value === false) continue;
      if (key.startsWith('on') && typeof value === 'function') {
        el.addEventListener(key.slice(2), value as EventListener);
      } else if (key === 'class') {
        el.className = String(value);
      } else if (key === 'dataset' && typeof value === 'object') {
        for (const [k, v] of Object.entries(value as Record<string, string>)) el.dataset[k] = v;
      } else if (value === true) {
        el.setAttribute(key, '');
      } else {
        el.setAttribute(key, String(value));
      }
    }
  }
  append(el, children);
  return el;
}

export function append(el: Element, children: readonly Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    el.append(typeof child === 'object' ? child : String(child));
  }
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

/** A lucide icon as an inline SVG, decorative (hidden from assistive tech). */
export function icon(node: IconNode, size = 16): SVGElement {
  const svg = createIcon(node, { width: size, height: size, 'stroke-width': 1.75 });
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.classList.add('icon');
  return svg;
}

/** m:ss */
export function formatTime(sec: number): string {
  const s = Math.max(0, Math.floor(Number.isFinite(sec) ? sec : 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Offers bytes as a file download. */
export function downloadBytes(bytes: Uint8Array<ArrayBuffer>, fileName: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  const a = h('a', { href: url, download: fileName, style: 'display:none' });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
