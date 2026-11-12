# Ambient Lab

Two labs in one page:

- **Style Lab**: pick a style family (or mix two), add your own words, and a music AI makes
  a new, original song from a prompt of plain sound descriptors. Then a lo-fi chain in the
  browser makes it rougher: tape, room, bedroom mic, hiss, slowed.
- **Ambient piano (offline)**: the built-in seeded piano engine. One click, one calm and
  sparse piano piece. Free, no music AI.

Nothing is copied from or modelled on an existing song. No artist name or song title is
ever sent anywhere. `STYLES.md` has the research behind the families, with sources.

## Run

```bash
npm install
cp .env.example .env   # then put your ElevenLabs API key into .env (never commit it)
npm run dev            # open the printed URL
```

No key yet? Set `STYLE_LAB_MOCK=1` in `.env`: Generate then returns a test signal for free,
so you can try the page and the lo-fi chain. The offline piano needs no key at all.

```bash
npm test               # composer, sound engine, chain, prompt, guard and backend checks
npm run check:ui       # drive the real app in headless Chromium (Style Lab in mock mode)
npm run check:browser  # piano: same take in headless Chromium and in Node, side by side
npm run measure        # piano: render full pieces offline, write the numbers logged in TUNING.md
npm run style:test     # one test generation per family; prints the cost and stops until confirmed
```

The two `check:*` scripts need Playwright with Chromium. `style:test` makes MP3s if ffmpeg is installed.

## Style Lab

- Pick one of the five families at the top. **Mix with** blends a second one in; the slider sets how much.
- **Your own words** are appended ("more tape hiss"). "no drums" also takes the drums out of the
  instrument list and adds them to the Avoid line.
- **Vocals** on or off, **Length**, and the model.
- The **Prompt** box shows exactly the text that is sent. Edit it freely; "Rebuild from settings" undoes
  your edits. "The exact request (JSON)" shows the whole request body.
- **Names are blocked.** A quoted title, "in the style of ...", "by <Name>" or a capitalised name in the
  middle of a sentence stops Generate, on the page and again on the local server.
- **Lyrics (optional)**, with vocals on: type topic words and press "Draft lyrics" for short plain lines
  built around them, or write your own. Empty = the music AI writes its own words.
- **Generate** always shows the estimated cost first and waits for your yes. The estimate is length times
  the public per-minute price (`src/style/cost.ts`); the real charge is whatever ElevenLabs bills.
- Every generation is kept in `renders/style` (audio + the exact request), so a paid one survives a reload.
- **Lo-fi chain** (free, runs in the browser): saturation, wow / flutter, drift, high-cut, room (small room
  or big hall), bedroom mic, hiss, slowed, vocal blur. Turn a knob and it renders again. The table under the
  players shows what was measured: loudness (target -16 LUFS), peak (below -1 dBFS), hiss level and so on.
- **Separate vocals** (extra cost, confirmed separately) splits a sung take into vocals and the rest, so the
  vocal blur knob can act on the voice alone.
- The API key lives in `.env` on your computer and stays on the local dev server. The page never sees it.
  The backend only answers this computer unless `STYLE_LAB_ALLOW_REMOTE=1` is set.

Deploying this to a static host would leave the Style Lab without its backend (the piano would still
work). A hosted version needs the same routes as server functions; not built yet.

## Ambient piano (offline)

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

- `src/style` - style families, prompt builder, name guard, cost estimate, lyrics helper, request body
- `src/postfx` - the lo-fi chain (offline Web Audio graph + master stage)
- `server` - local backend: ElevenLabs Music client, key handling, storage of generations, mock mode
- `src/engine` - seeded piano composer (motif, harmony, form, performance), MIDI export, piece validation
- `src/audio` - sampler, procedural reverb / noise / pad, offline render, WAV, realtime player
- `src/analysis` - measurements on audio (levels, loudness, spectrum, RT60), targets, reference traits
- `src/chat` - the keyword rules behind the piano lab's text box
- `src/store` - takes, favorites, ratings and what the moods learned (localStorage)
- `src/ui` - the interface (plain TypeScript and DOM)

## Docs

- `STYLES.md` - research on the reference tracks (public text only, with sources) and the five families
- `ASSETS.md` - every sample, impulse response, font and icon with source and licence
- `TUNING.md` - every sound/composer/chain change with measured numbers and listening notes

## Credits

Piano: Salamander Grand Piano V3 by Alexander Holm, CC BY 3.0. Font: Inter (OFL 1.1). Icons: Lucide (ISC).
Style Lab generations come from the ElevenLabs Music API under your own account and its terms.
