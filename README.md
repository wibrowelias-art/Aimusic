# Ambient Lab

One click, one calm and sparse ambient piano piece. Slow, lots of silence, long
reverb, a little tape wobble. Every piece is new: the notes are invented from a
seed, nothing is copied from or modelled on an existing song.

## Run

```bash
npm install
npm run dev            # open the printed URL
npm test               # composer, sound engine and store checks
npm run measure        # render full pieces offline, write the numbers logged in TUNING.md
npm run check:browser  # same take in headless Chromium and in Node, side by side
npm run check:ui       # drive the real app in headless Chromium
```

The two `check:*` scripts need Playwright with Chromium.

## Use

- Pick a mood (Warm, Sad, Dreamy, Cave) and press **Generate**. Every press is a new seed.
- **Again** keeps the idea and the chords of the current take and plays them out differently.
- Turn a knob to fix a value (the lock closes); the amber arc shows where the mood would pick it.
- Thumbs up / down teach the mood: its ranges move towards what you like.
- The star keeps a take (seed + settings). MIDI, WAV and stems (piano, pad, noise) are one click each.
- Shortcuts: Space = play / stop, G = Generate, A = Again. Click the piano roll to jump.
- **Tell the lab**: type "sadder, slower, more space, add rain". Rules, no API key. It lists every knob it
  moved. Requests for existing music ("like <song>", "in the style of ...", note or chord lists) are left out,
  and the box says so.
- **Reference (optional)**: drop in a track you own. Five general traits are read (tempo, key, note density,
  brightness, reverb length) and offered as knob values. No melody, chords or notes are read or kept; the file
  stays in the browser.

## Layout

- `src/engine` – seeded composer (motif, harmony, form, performance), MIDI export, piece validation
- `src/audio` – sampler, procedural reverb / noise / pad, offline render, WAV, realtime player
- `src/analysis` – measurements on rendered audio, targets, reference traits
- `src/chat` – the keyword rules behind the text box
- `src/store` – takes, favorites, ratings and what the moods learned (localStorage)
- `src/ui` – the interface (plain TypeScript and DOM)

## Docs

- `ASSETS.md` – every sample, impulse response, font and icon with source and licence
- `TUNING.md` – every sound/composer change with measured numbers and listening notes

## Credits

Piano: Salamander Grand Piano V3 by Alexander Holm, CC BY 3.0. Font: Inter (OFL 1.1). Icons: Lucide (ISC).
