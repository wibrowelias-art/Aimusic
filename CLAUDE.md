# Ambient Lab - project rules

Ambient Lab is a web app with two labs. The Style Lab turns a style family (a list of plain
sound descriptors) into a new ORIGINAL piece and runs it through a lo-fi post-processing
chain. By default the piece comes from the built-in generator (`src/sketch`: seeded composer
+ synthesised voices, free, offline). A paid music AI (ElevenLabs Music API) is an optional
second engine. "Ambient piano (offline)" is the seeded piano engine. The owner is Elias.

## Hard rules (never break these)

1. **Originality.** Never recreate, transcribe or approximate any existing song's melody,
   chords, lyrics, title or arrangement. No hard-coded melodies or progressions taken from
   real music, no note or chord tables modelled on a song, no reference MIDI. The lab captures
   a mood and a sound world only. Piano notes come from a seeded generator. If a user request
   or a reference file would require copying notes, that part is refused and the UI says so.
   Lyrics are the owner's own, the helper's own frames, or none.
1b. **No names to the music API.** Only sound descriptors are sent: never an artist name or a
   song title. `src/style/guard.ts` enforces it on the page and in `src/style/request.ts`
   (so also on the server). No artist names or titles anywhere in `src/` or `server/`
   (the research with names lives in `STYLES.md` only).
1c. **Research is text only.** Never download, stream or analyse the audio of a reference
   song. Public text only (reviews, interviews, wikis, label pages), sources cited in `STYLES.md`.
1d. **Free by default.** The default path costs nothing and sends nothing anywhere; keep it
   that way. Every call to the music API shows its estimated cost first and needs a yes
   (the server refuses a request without the matching `confirmUsd`). The API key lives in a
   local `.env` (git-ignored), is read on the Node side only and is never committed or logged.
   Tests and checks run in mock mode; they never call the API.
2. **Assets.** No copyrighted audio in the repo. Every sample, impulse response, font and
   icon set is listed in `ASSETS.md` with source and licence (prefer CC0 / CC BY). Do not add
   an asset without adding it there. Reverb IRs, noise, rain and pad are synthesised in code.
3. **You cannot hear.** Never write "sounds like X", "sounds good/warm/better" or "fixed the
   sound" in code comments, docs, commit messages, UI text or reports. Report measured
   numbers (peak dBFS, RMS, silence ratio, spectral centroid, RT60, tail length, density...)
   and leave judgement of the sound to Elias. Log every change to the sound or the composer
   in `TUNING.md` with the numbers before/after.
4. Reference-audio analysis reads ONLY general traits (tempo, key, note density, brightness,
   reverb length). It never extracts or stores melodies, chord sequences or any pitch data.
4b. "Match my own song" (Style Lab, asked for by Elias on 2026-11-12) is the one exception to
   "no rhythm from a file": for a song the owner confirms is his own, it reads the tempo and
   the hit strength per sixteenth of the bar (16 numbers) plus brightness and reverb length
   (`src/analysis/rhythm.ts`). Still no pitches, no melody, no chords, and no audio is kept.
   The box stays behind its "this song is mine" tick.

## Stack and conventions

- Vite + TypeScript (strict), Web Audio API, Vitest. No UI framework: plain TS + DOM.
- UI: dark minimal, own palette, Inter font (`@fontsource-variable/inter`), lucide icons (`lucide`).
- Contracts live in `src/engine/types.ts`, `src/engine/params.ts`, `src/audio/types.ts`,
  `src/analysis/types.ts`, `src/analysis/targets.ts`, `src/style/types.ts`, `src/style/take.ts`,
  `src/postfx/settings.ts`. Read them before writing code. Do not change a contract without
  saying so in your report.
- Style Lab: `src/sketch` (built-in generator: recipes per family, arranger, synthesised
  voices, word rules; pure and deterministic, no Web Audio), `src/style` (profiles, prompt,
  guard, cost, lyrics, request body; pure),
  `src/postfx` (lo-fi chain; knob mappings in `constants.ts`), `server` (local backend mounted
  by `vite.config.ts` on `/api/style`; generations are stored in `renders/style`, git-ignored).
  `vite.config.ts` must not import local files (it loads `server/plugin.ts` through Vite).
- Engine code (`src/engine`, `src/sketch`, `src/analysis`, `src/style`, pure parts of `src/audio` and `src/postfx`) must be deterministic:
  no `Math.random()`, no `Date.now()`. All randomness comes from the seeded RNG.
- Audio code takes its `BaseAudioContext` / context factory as a parameter so the same code
  runs in the browser and under `node-web-audio-api` in tests. Never touch `window` in engine code.
- All audio contexts run at 48000 Hz (the sample set is 48 kHz).
- Tests live in `tests/**/**.test.ts` (`npm test`). Measurement runs live in
  `tests/measure/*.measure.ts` (`npm run measure`). `npm run typecheck` must pass.
- Do not run `npm install` / add dependencies unless your task says so. Installed: vite,
  typescript, vitest, node-web-audio-api, @types/node, lucide, @fontsource-variable/inter.
  Playwright + Chromium are installed globally (`require('playwright')`, no install needed).
- Scratch files go to the scratchpad directory or `reports/tmp/` (git-ignored), not into the repo.
- Plain ASCII punctuation in docs and UI text. Short, casual tone towards Elias.
- Git: work on branch `ccr-e55f9a1c-ytkosh`. Only commit when your task tells you to. Never push.
