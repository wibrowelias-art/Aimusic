# Ambient Lab – project rules

Ambient Lab is a web app that makes calm, sparse, ORIGINAL ambient piano pieces with one
click (slow, lots of silence, long reverb, a little tape wobble). The owner is Elias.

## Hard rules (never break these)

1. **Originality.** Never recreate, transcribe or approximate any existing song's melody,
   chords or arrangement. No hard-coded melodies or progressions taken from real music, no
   "in the style of <song>" tables, no reference MIDI. The lab captures a mood and a sound
   world only. All notes come from a seeded generator. If a user request or a reference file
   would require copying notes, that part is refused and the UI says so.
2. **Assets.** No copyrighted audio in the repo. Every sample, impulse response, font and
   icon set is listed in `ASSETS.md` with source and licence (prefer CC0 / CC BY). Do not add
   an asset without adding it there. Reverb IRs, noise, rain and pad are synthesised in code.
3. **You cannot hear.** Never write "sounds like X", "sounds good/warm/better" or "fixed the
   sound" in code comments, docs, commit messages, UI text or reports. Report measured
   numbers (peak dBFS, RMS, silence ratio, spectral centroid, RT60, tail length, density...)
   and leave judgement of the sound to Elias. Log every change to the sound or the composer
   in `TUNING.md` with the numbers before/after.
4. Reference-audio analysis (Phase 4) reads ONLY general traits (tempo, key, note density,
   brightness, reverb length). It never extracts or stores melodies, chord sequences or any
   note data.

## Stack and conventions

- Vite + TypeScript (strict), Web Audio API, Vitest. No UI framework: plain TS + DOM.
- UI: dark minimal, own palette, Inter font (`@fontsource-variable/inter`), lucide icons (`lucide`).
- Contracts live in `src/engine/types.ts`, `src/engine/params.ts`, `src/audio/types.ts`,
  `src/analysis/types.ts`, `src/analysis/targets.ts`. Read them before writing code. Do not
  change a contract without saying so in your report.
- Engine code (`src/engine`, `src/analysis`, pure parts of `src/audio`) must be deterministic:
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
