/**
 * The frame around the two labs: top bar, the profile picker, and below it either the
 * Style Lab (the five families) or the old piano lab ("Ambient piano (offline)").
 */
import { Info } from 'lucide';
import { browserStore, readJson, writeJson } from '../store/storage';
import { FAMILY_IDS, PIANO_OFFLINE_BLURB, PIANO_OFFLINE_LABEL, PROFILES } from '../style/profiles';
import { PIANO_OFFLINE_ID, type FamilyId, type ProfileId } from '../style/types';
import { brandMark, mountApp, type App } from './app';
import { h, icon } from './dom';
import { StyleLab } from './stylelab';

const SHELL_KEY = 'ambientlab.shell.v1';
const PROFILE_IDS: readonly ProfileId[] = [...FAMILY_IDS, PIANO_OFFLINE_ID];

export function mountShell(root: HTMLElement): void {
  const kv = browserStore();
  const saved = (readJson(kv, SHELL_KEY) as { profile?: unknown } | null)?.profile;
  let toastTimer = 0;
  const toast = h('div', { class: 'sl-toast', role: 'status', 'aria-live': 'polite' });
  const showToast = (text: string): void => {
    toast.textContent = text;
    toast.classList.add('is-shown');
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toast.classList.remove('is-shown'), 6000);
  };

  const lab = new StyleLab({ toast: showToast }, kv);
  let piano: App | null = null;
  let active: ProfileId = saved === PIANO_OFFLINE_ID ? PIANO_OFFLINE_ID : lab.getProfile();

  const styleRoot = h('div', { class: 'view-style' }, lab.element);
  const pianoRoot = h('div', { class: 'view-piano' });
  const cards = h('div', { class: 'profiles', role: 'radiogroup', 'aria-label': 'Style profile' });

  const show = (): void => {
    const isPiano = active === PIANO_OFFLINE_ID;
    styleRoot.hidden = isPiano;
    pianoRoot.hidden = !isPiano;
    if (isPiano) {
      lab.pause();
      piano ??= mountApp(pianoRoot, { embedded: true });
    } else {
      piano?.pause();
    }
    for (const card of cards.querySelectorAll<HTMLElement>('.profile')) {
      const on = card.dataset.profile === active;
      card.setAttribute('aria-checked', String(on));
      card.tabIndex = on ? 0 : -1;
    }
  };

  const select = (id: ProfileId): void => {
    if (id !== PIANO_OFFLINE_ID && (active === PIANO_OFFLINE_ID ? id !== lab.getProfile() : id !== active)) {
      lab.setProfile(id as FamilyId);
    }
    active = id;
    writeJson(kv, SHELL_KEY, { profile: id });
    show();
  };

  for (const id of PROFILE_IDS) {
    const offline = id === PIANO_OFFLINE_ID;
    cards.append(
      h(
        'button',
        { class: offline ? 'profile is-offline' : 'profile', type: 'button', role: 'radio', dataset: { profile: id }, onclick: () => select(id) },
        h('span', { class: 'profile-name' }, offline ? PIANO_OFFLINE_LABEL : PROFILES[id].label),
        h('span', { class: 'profile-blurb' }, offline ? PIANO_OFFLINE_BLURB : PROFILES[id].blurb),
      ),
    );
  }
  cards.addEventListener('keydown', (e) => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (step === 0) return;
    e.preventDefault();
    const next = PROFILE_IDS[(PROFILE_IDS.indexOf(active) + step + PROFILE_IDS.length) % PROFILE_IDS.length];
    select(next);
    cards.querySelector<HTMLElement>(`[data-profile="${next}"]`)?.focus();
  });

  root.replaceChildren(
    h(
      'div',
      { class: 'app shell' },
      h(
        'header',
        { class: 'topbar' },
        h('div', { class: 'brand' }, brandMark(), h('span', null, 'Ambient Lab')),
        h('div', { class: 'topbar-note' }, 'Pick a style, get a new song, make it lo-fi. Nothing is copied.'),
        h(
          'button',
          {
            class: 'btn ghost',
            type: 'button',
            onclick: () => (active === PIANO_OFFLINE_ID && piano ? piano.openAbout() : lab.openAbout()),
          },
          icon(Info, 15),
          'About',
        ),
      ),
      cards,
      styleRoot,
      pianoRoot,
      toast,
    ),
  );
  show();
}
