# Ambient Lab

Two labs in one page, both free to use:

- **Style Lab**: pick a style family (or mix two), add your own words, press Generate. By
  default the **built-in generator** makes the piece right in your browser: a seeded
  composer plus synthesised instruments. No key, no account, no cost, nothing is sent
  anywhere. Then a lo-fi chain makes it rougher: tape, room, bedroom mic, hiss, slowed.
  If you want a music AI instead, there is an optional paid engine (ElevenLabs Music API).
- **Ambient piano (offline)**: the built-in seeded piano engine. One click, one calm and
  sparse piano piece.

Nothing is copied from or modelled on an existing song. No artist name or song title is
ever sent anywhere. `STYLES.md` has the research behind the families, with sources.

## Run

```bash
npm install
npm run dev            # open the printed URL
```

That is all for the free path. Only the optional music AI engine needs a key:
`cp .env.example .env` and put your ElevenLabs API key into `.env` (never commit it).

```bash
npm test               # composer, generator, sound engine, chain, prompt, guard and backend checks
npm run check:ui       # drive the real app in headless Chromium (music AI engine in mock mode)
npm run check:browser  # piano: same take in headless Chromium and in Node, side by side
npm run measure        # piano: render full pieces offline, write the numbers logged in TUNING.md
npm run style:test     # one free test piece per family, with lo-fi WAV + MP3 and a numbers report
```

The two `check:*` scripts need Playwright with Chromium. `style:test` makes MP3s if ffmpeg is installed;
`npm run style:test -- --engine ai` uses the paid engine instead and stops until the cost is confirmed.

## Style Lab

- Pick one of the five families at the top. **Mix with** blends a second one in; the slider sets how much.
- **Built-in generator** (default, free) or **Music AI** (paid): the switch above the recipe.
- **Your own words**: "more tape hiss", "no drums", "slower", "add a guitar". The built-in generator reads
  them by rules and lists what it understood and what it did not. The music AI gets them in its prompt.
- **Vocals**: the built-in generator adds a wordless synth voice (it cannot sing words). The music AI sings.
- **Generate**. Every press is a new piece. Free takes are kept in the browser as seed + settings and are
  made again from those; nothing is uploaded.
- **Lo-fi chain** (runs in the browser): saturation, wow / flutter, drift, high-cut, room (small room or big
  hall), bedroom mic, hiss, slowed, vocal blur. Turn a knob and it renders again. The table under the players
  shows what was measured: key and tempo, loudness (target -16 LUFS), peak (below -1 dBFS), hiss and so on.
- Downloads: the lo-fi version and the raw version as WAV.
- **Match my own song** (built-in generator): tick "this song is mine" and pick a file. The lab reads its
  tempo, where the hits fall in the bar, its brightness and its reverb length. Guitar, bass and drum parts
  then play on your rhythm and the chain is set to your tone. No melody or chords are read; the notes stay
  new. It cannot reproduce the recording itself.
  Tick "Play my recording itself and add a new melody on top" to hear your actual recording (its own
  sounds, background, rhythm and tone) with a new melody in its key over it. The original melody stays
  in the recording; a slider can push it back roughly. These takes are gone when the page closes.

### The optional music AI engine

- Needs `ELEVENLABS_API_KEY` in `.env` and the local dev server (`npm run dev`). The page never sees the key.
- The **Prompt** box shows exactly the text that is sent. Edit it freely; "Rebuild from settings" undoes your
  edits. "The exact request (JSON)" shows the whole request body.
- **Names are blocked.** A quoted title, "in the style of ...", "by <Name>" or a capitalised name in the
  middle of a sentence stops Generate, on the page and again on the local server.
- **Lyrics (optional)**: type topic words and press "Draft lyrics", or write your own. Empty = the model
  writes its own words.
- **Generate** shows the estimated cost first and waits for your yes: length times the public per-minute
  price (`src/style/cost.ts`). The real charge is whatever ElevenLabs bills.
- Every paid generation is kept in `renders/style` (audio + the exact request).
- **Separate vocals** (extra cost, confirmed separately) splits a sung take so the vocal blur can act on
  the voice alone. The built-in generator does not need this: its voice is already its own stem.
- `STYLE_LAB_MOCK=1` in `.env` makes this engine return a test signal for free (for trying the page).

The free path is plain static files: it works on any static host. The music AI engine needs its backend
routes; a hosted version of those is not built.

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

- `src/sketch` - the built-in generator: arrangement per family, synthesised voices, word rules (free)
- `src/style` - style families, prompt builder, name guard, cost estimate, lyrics helper, request body
- `src/postfx` - the lo-fi chain (offline Web Audio graph + master stage)
- `server` - local backend for the optional music AI engine: ElevenLabs client, key handling, storage, mock mode
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
Built-in generator: all sound is synthesised in code. Music AI generations (optional) come from the
ElevenLabs Music API under your own account and its terms.
