# Tuning log

Rules for this file:

- Claude cannot hear. Nothing here claims how anything sounds. Only measured numbers.
- Every change to the sound or the composer gets an entry: what changed, why, numbers before/after.
- Elias's listening answers are written down here BEFORE anything is tuned by ear-related reasons.
- Thresholds live in `src/analysis/targets.ts`. They were written before the first render was measured; changes are logged here.

## 0. Piano sample choice (before any render)

Source: Salamander Grand Piano V3, CC BY 3.0 (see ASSETS.md). The set has 16 velocity layers.
Measured on the original FLACs (ffmpeg decode, 48 kHz, mono sum for RMS/centroid, first second after onset):

| Sample | Peak dBFS | RMS 1 s dBFS | Centroid 1 s Hz | End noise floor dBFS |
| --- | --- | --- | --- | --- |
| A2 v2 | -16.7 | -29.7 | 169 | -73.7 |
| A2 v3 | -14.7 | -28.0 | 174 | -73.5 |
| A2 v4 | -12.8 | -26.6 | 180 | -73.7 |
| A2 v5 | -11.8 | -25.8 | 185 | -73.8 |
| A2 v6 | -11.3 | -25.2 | 185 | -73.1 |
| A2 v8 | -9.9 | -24.1 | 192 | -73.1 |
| C4 v2 | -15.5 | -31.8 | 441 | -71.8 |
| C4 v3 | -13.3 | -29.7 | 449 | -79.5 |
| C4 v4 | -11.7 | -28.0 | 464 | -79.8 |
| C4 v5 | -10.5 | -26.7 | 470 | -77.7 |
| C4 v6 | -9.7 | -26.0 | 474 | -81.2 |
| C4 v8 | -8.1 | -24.5 | 483 | -80.8 |
| C6 v2 | -18.4 | -41.7 | 785 | -75.6 |
| C6 v3 | -15.3 | -39.4 | 832 | -64.2 |
| C6 v4 | -15.2 | -39.5 | 800 | -70.3 |
| C6 v5 | -17.2 | -39.4 | 671 | -68.2 |
| C6 v6 | -13.4 | -37.3 | 944 | -68.7 |
| C6 v8 | -10.6 | -34.7 | 1030 | -73.5 |

Decision: one layer, **v4**. Reasons in numbers: centroid rises only ~7 % from v3 to v8 at C4
(449 -> 483 Hz), so the layers differ mostly in level; v4 has a low end-of-file floor (-79.8 dBFS at C4)
and sits in the soft part of the set (the SFZ maps v4 to MIDI velocities 37-43). Velocity is done with
gain (and a velocity-dependent low-pass) in the engine instead of layer switching.
Open question for Elias (cannot be measured): is the attack too hard or too dull? If yes, re-run
`scripts/fetch-samples.mjs` with another `LAYER`.

Converted set (MP3, LAME q4, lead-in trimmed): 23 files, 2.5 MB. Per-note numbers are in
`public/samples/piano/manifest.json`. Note: loudness between neighbouring samples is uneven in the
source (RMS 1 s: F#3 -32.9, A3 -35.3, C4 -28.0 dBFS).

## 1. Phase 1 baseline (engine + sound)

How to reproduce: `npm run measure` (writes `reports/phase1.json` and `reports/phase1.md`, plus one WAV per
preset to `renders/`). Renderer: node-web-audio-api, 48 kHz. Every take is the centre of its preset's ranges.

Column meanings: *Silent bars* = share of bars without a piano onset. *Gain* = normalisation gain (the mix is
set to a sample peak of -1.5 dBFS). *Piano silence* = share of 50 ms frames of the piano stem below -50 dBFS.
*Centroid* = energy-weighted centroid of the long-term spectrum of the mix. *RT60 mid* = T30 of the impulse
response in the 500-1000 Hz band. *Tail* = seconds from the last release until piano + pad stay below -60 dBFS.
*Ring-out* = the same, counted from the last piano onset.

| Preset | Seed | Key | Mode | BPM | Bars | Notes | Notes/bar | Silent bars | File s | Gain dB | Peak dBFS | RMS dBFS | Clipped | Piano silence | Centroid Hz | RT60 mid s | Tail s | Ring-out s | Render s |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| warm | 1 | F | Major pentatonic | 56 | 22 | 46 | 2.091 | 0.318 | 100.1 | 5.91 | -1.5 | -24.13 | 0 | 0.136 | 341 | 3.69 | 2.65 | 12.25 | 13.7 |
| warm | 2 | Bb | Major pentatonic | 56 | 22 | 46 | 2.091 | 0.318 | 99.8 | 7.9 | -1.5 | -22.54 | 0 | 0.206 | 339 | 3.69 | 2.55 | 12.05 | 13.6 |
| warm | 3 | Eb | Major pentatonic | 56 | 22 | 46 | 2.091 | 0.318 | 99.8 | 4.83 | -1.5 | -25.38 | 0 | 0.131 | 318 | 3.69 | 2.5 | 7.55 | 13 |
| sad | 1 | Ab | Aeolian | 47 | 21 | 29 | 1.381 | 0.429 | 112.9 | 6.44 | -1.5 | -25.7 | 0 | 0.413 | 356 | 4.61 | 2.45 | 13.85 | 16 |
| sad | 2 | C# | Aeolian | 47 | 21 | 29 | 1.381 | 0.429 | 112.9 | 7.72 | -1.5 | -24.19 | 0 | 0.362 | 372 | 4.61 | 2.7 | 14 | 15.9 |
| sad | 3 | F# | Aeolian | 47 | 21 | 29 | 1.381 | 0.429 | 113.3 | 8.42 | -1.5 | -23.16 | 0 | 0.298 | 353 | 4.61 | 2.8 | 8.95 | 15.4 |
| dreamy | 1 | B | Lydian | 52 | 23 | 44 | 1.913 | 0.391 | 113.1 | 6.23 | -1.5 | -23.88 | 0 | 0.226 | 313 | 5.39 | 3.85 | 14.15 | 18.4 |
| dreamy | 2 | E | Lydian | 52 | 23 | 44 | 1.913 | 0.391 | 112.7 | 6.28 | -1.5 | -23.57 | 0 | 0.357 | 318 | 5.39 | 3.4 | 13.65 | 18.3 |
| dreamy | 3 | A | Lydian | 52 | 23 | 44 | 1.913 | 0.391 | 112.7 | 7.01 | -1.5 | -22.69 | 0 | 0.192 | 300 | 5.39 | 3.25 | 8.75 | 18.9 |
| cave | 1 | D | Dorian | 44 | 20 | 18 | 0.9 | 0.6 | 114.8 | 7.17 | -1.5 | -26.5 | 0 | 0.497 | 374 | 5.77 | 2.35 | 14.55 | 18.2 |
| cave | 2 | G | Dorian | 44 | 20 | 18 | 0.9 | 0.6 | 114.8 | 7.72 | -1.5 | -26.6 | 0 | 0.543 | 409 | 5.77 | 2.5 | 14.65 | 17.8 |
| cave | 3 | C | Dorian | 44 | 20 | 18 | 0.9 | 0.6 | 115 | 9.27 | -1.5 | -25.35 | 0 | 0.513 | 379 | 5.77 | 2.6 | 15.05 | 18.4 |

| Preset | Seed | Piano RMS dBFS | Pad RMS dBFS | Noise RMS dBFS | Reverb knob s | RT60 broadband s | Dead end s |
| --- | --- | --- | --- | --- | --- | --- | --- |
| warm | 1 | -24.67 | -33.54 | -46.2 | 3.7 | 3.45 | 1.53 |
| warm | 2 | -23.18 | -31.27 | -44.21 | 3.7 | 3.45 | 1.45 |
| warm | 3 | -26.09 | -33.87 | -47.28 | 3.7 | 3.45 | 1.44 |
| sad | 1 | -26.21 | -35.79 | -43.32 | 4.6 | 4.31 | 1.47 |
| sad | 2 | -24.59 | -35.54 | -42.03 | 4.6 | 4.31 | 1.47 |
| sad | 3 | -23.63 | -33.77 | -41.35 | 4.6 | 4.31 | 1.43 |
| dreamy | 1 | -25.62 | -28.78 | -49.48 | 5.4 | 5.05 | 1.46 |
| dreamy | 2 | -24.89 | -29.44 | -49.43 | 5.4 | 5.05 | 1.53 |
| dreamy | 3 | -24.19 | -28.05 | -48.7 | 5.4 | 5.05 | 1.51 |
| cave | 1 | -26.72 | -39.95 | -45.47 | 5.8 | 5.42 | 1.55 |
| cave | 2 | -26.95 | -39.1 | -44.89 | 5.8 | 5.42 | 1.5 |
| cave | 3 | -25.77 | -36.79 | -43.37 | 5.8 | 5.42 | 1.47 |

All 12 takes pass `validatePiece` (0 notes out of scale, 0 overlaps, 0 stuck notes, density inside tolerance)
and `checkAgainstTargets`.

### Chromium against node-web-audio-api

`npm run check:browser` renders one fixed take (Warm centre, seed 1, key F, about 30 s) in headless Chromium
and in Node and compares:

| Number | Chromium 153 | node-web-audio-api 2.2 |
| --- | --- | --- |
| Notes | 17 | 17 |
| File length s | 39.200 | 39.250 |
| Normalisation gain dB | 5.28 | 5.44 |
| Peak dBFS | -1.50 | -1.50 |
| Mix RMS dBFS | -24.92 | -24.80 |
| Clipped samples | 0 | 0 |
| Centroid Hz | 351.7 | 351.3 |
| Piano / pad / noise RMS dBFS | -25.46 / -34.47 / -46.97 | -25.35 / -34.31 / -46.81 |
| Piano silence ratio | 0.210 | 0.204 |
| Stems summed minus mix, max | 3e-8 | 3e-8 |
| Same take rendered twice, max difference | 2.8e-5 (-91 dBFS) | 0 |
| Render time for 39 s of audio | 8.9 s | 5.1 s |

The two engines agree within 0.16 dB. Chromium is not bit-identical between two runs (difference at -91 dBFS);
Node is. A 16 bit WAV exported twice from the browser can therefore differ by one LSB.

### Sound constants that matter (all in `src/audio/constants.ts`)

| What | Constant | Value |
| --- | --- | --- |
| Piano level before normalisation | `PIANO_GAIN_DB` | +12 dB |
| Velocity to gain | `VELOCITY_GAIN_EXPONENT` | (v/127)^1.7, so velocity 80 is 10.2 dB above velocity 40 |
| Per-voice low-pass (softer = darker) | `VOICE_LP_HZ_LO/HI`, `VOICE_LP_KEYTRACK` | at C4: v20 2013 Hz, v40 3516 Hz, v60 6143 Hz, v80 10733 Hz |
| Damper release | `DAMPER_TAU_SEC` | 0.35 s time constant (46.8 dB down after 2 s, measured) |
| Reverb wet level, piano / pad | `PIANO_WET_DB` / `PAD_WET_DB` | -4 dB / -2 dB re the dry signal (mid band) |
| Reverb high damping | `REVERB_BANDS` | RT60 above 4 kHz measures 0.72 x the mid-band RT60 |
| Lo-fi low-pass on the piano bus | `LOFI_LP_HZ_CLEAN/FULL` | 9000 Hz at lo-fi 0, 2200 Hz at lo-fi 1 |
| Tape wobble | `WOW_A/B_*`, `FLUTTER_*` | 0.37 Hz + 0.53 Hz + 6.1 Hz; measured max 15.1 cents at lo-fi 1, 5.3 cents at 0.35, 0 at 0 |
| Hiss | `HISS_RMS_DB_AT_FULL` | -46 dBFS RMS at lo-fi 1, -55.1 at 0.35, none at 0 (before normalisation) |
| Rain | `RAIN_RMS_DB_AT_FULL` | -34 dBFS RMS at rain 1 (before normalisation) |
| Pad level | `PAD_GAIN_DB` | -19 dB per voice at pad 1 |
| Pad envelope | `PAD_ATTACK_SEC` / `PAD_RELEASE_SEC` | 2.2 s to 95 % / 3.5 s to -40 dB |
| Normalisation | `NORMALIZE_PEAK_DB` | mix peak -1.5 dBFS, boost capped at +18 dB |
| Per-sample level smoothing | `LEVEL_CORRECTION_MAX_DB` | at most +-4 dB; mean step between neighbouring samples 2.79 dB -> 0.80 dB |

### Changes made after the first measurement

**1. Dead end of the file cut (sound engine).** The render length was `durationSec + reverbSize + 2.5 s`, a safe
upper bound. Measured on the 12 baseline takes, piano + pad were already below -60 dBFS for the last 3.3 to
5.95 s of every file (only hiss left). Now the file is cut 1.5 s after the last 50 ms frame at or above -60 dBFS
(`TRIM_*` constants), never earlier than 1 s after the last release, and the noise bed fades out over the last
1.5 s of the cut file. After: dead end 1.43 to 1.55 s, files 2.0 to 4.4 s shorter (Warm seed 1: 102.1 -> 100.1 s,
Cave seed 1: 119.1 -> 114.8 s). On the takes whose normalisation gain did not change, the mix RMS moved by at
most 0.16 dB and the centroid by at most 8 Hz.

**2. Silence no longer stacks up across section boundaries (composer).** Silent bars were spread per section,
so the silent end of one section and the silent start of the next added up. Measured on 300 takes per preset
(parameters drawn inside the preset ranges): the longest gap sat on a section boundary in 67 % (Sad), 50 %
(Dreamy), 84 % (Cave) of the takes although only 2 of the gaps are boundaries. Now the two count as one gap and
no gap is planned longer than `MAX_GAP_BARS = 4` bars unless the bars cannot be placed otherwise.

| Preset | Longest stretch of silent bars, before | after | Longest time between two piano onsets, median / max before | after |
| --- | --- | --- | --- | --- |
| Warm | 1-4 bars | 1-4 bars (unchanged) | 12.1 / 22.7 s | 12.1 / 22.7 s |
| Sad | 2-6 bars | 2-4 bars | 21.8 / 36.5 s | 21.2 / 29.0 s |
| Dreamy | 2-6 bars | 2-4 bars | 17.2 / 33.5 s | 17.1 / 24.9 s |
| Cave | 3-9 bars | 3-7 bars (4 or less in 91 % of takes) | 31.0 / 47.8 s | 26.4 / 41.4 s |

The Cave leftovers are takes with so few playing bars that the opening motif (2 bars) is the only phrase of
its section.

**3. A' comes back on the chords of A (composer).** The plan was "A' repeats the degrees of A and closes on the
tonic", but with two chords in A' the first one was re-drawn at random. Measured on the same 1200 takes: A'
started on the tonic chord in 54 / 41 / 60 / 43 % (Warm / Sad / Dreamy / Cave) and on any chord of A in
80 / 65 / 79 / 61 %. Now A' is cut into three chords when it has 6 bars or more (tonic, on, home), and a
two-chord A' starts on the chord that followed the tonic in A. After: tonic start 96 / 89 / 98 / 88 %, chord of
A 100 % in all four presets. The regression pins of seeds 2 and 3 in `tests/engine/golden.test.ts` were updated.

**4. Thresholds in `src/analysis/targets.ts` (changed once, here).**

- `rt60Sec`: was "3 to 6 s, within 20 % of the knob", without saying which band. The impulse response measures
  3.69 / 4.61 / 5.39 / 5.77 s in the 500-1000 Hz band for knob values 3.7 / 4.6 / 5.4 / 5.8 (within 0.5 %), and
  6.5 % lower broadband because the highs are damped on purpose. A knob value of exactly 3.0 reads 2.985 s and
  failed the old absolute bound. Now: mid band within 5 % of the knob (stricter), absolute bounds 2.85 to 6.3 s,
  and broadband T30 between 0.85 and 1.05 x the knob.
- `tailSec` (after the last release): minimum 2 s -> 0 s. The closing note is held for 1 to 2 bars, so at the
  release the piano is already down by 30 dB or more; with pad 0 the measured tail was 0.20 s. The maximum of
  14 s stays (nothing may hang).
- New `ringOutSec` (after the last piano onset): 3 to 30 s. Baseline 7.55 to 15.05 s.
- New end-to-end check of the reverb in the rendered audio: one short note without pedal decays with T30 of
  3.33 / 4.11 / 6.34 s for knob values 3 / 4.5 / 6 (allowed: within 20 %).

### Known limits (measured, not judged)

- The soft sample layer decays fast by itself: raw C4 RMS is -23.3 dBFS at 0.1-0.3 s and -46.0 dBFS at 1-1.5 s.
- The lo-fi low-pass moves the long-term spectrum very little on this material: piano stem centroid 348 to
  388 Hz over lo-fi 0 to 1 (the samples have little energy above 3 kHz at these velocities).
- Offline render speed in this sandbox: about 0.13 to 0.17 s per second of audio in Node, 0.23 s in headless
  Chromium (a 100 s take: 13 to 23 s). Realtime playback does not need a render.
- A two-chord A' cannot start on the tonic (it would repeat the closing chord), so 2 to 12 % of takes start A'
  on another chord of A.

### Listening questions for Elias (Phase 1)

Files to listen to: `renders/phase1-warm-seed1.wav`, `-sad-`, `-dreamy-`, `-cave-` (made by `npm run measure`).

1. **Too busy or too empty?** Warm plays 2.1 notes per bar with about a third of the bars silent; Sad 1.4 with
   43 % silent; Cave 0.9 with 60 % silent. The longest stretch without a new piano note is typically 12 s (Warm),
   21 s (Sad), 26 s (Cave). Knobs: the density and Space ranges of the presets, `MAX_GAP_BARS` (4).

   Answer:

2. **Too bright or too dull?** The mix centroid is 300 to 410 Hz, and a note at velocity 40 is low-passed at
   3.5 kHz (C4). Is the piano attack too soft / too hard? Knobs: `VOICE_LP_HZ_LO/HI`, `LOFI_LP_HZ_*`, the sample
   layer (`LAYER` in `scripts/fetch-samples.mjs`, now 4 of 16).

   Answer:

3. **Reverb too short, too long, too loud?** RT60 is 3.7 s (Warm), 4.6 s (Sad), 5.4 s (Dreamy), 5.8 s (Cave) at
   a wet level of -4 dB. Knobs: the reverb ranges of the presets, `PIANO_WET_DB`.

   Answer:

## 2. Phase 2 (interface)

No change to the composer or to the sound constants in this phase. What was added and measured:

- `npm run check:ui` drives the real app in headless Chromium 153: 41 checks, all pass (Generate plays, Again
  keeps seed + settings and bumps the variation, a knob edit, rating, favorites, waveform, MIDI / WAV / stems
  export, seek, shortcuts, reload, 390 px layout, zero console errors).
- WAV exported from the browser: 48 kHz, stereo, 16 bit, measured sample peak -1.50 dBFS, 0 clipped samples.
  The same take exported twice gives byte-identical MIDI.
- Offline render in headless Chromium in this sandbox: 1:42 of audio in 23.9 s, 1:27 in 18.8 s (about 0.22 s per
  second of audio). Playback does not wait for it; only the waveform view and the WAV / stems export do.
- Seeking (new, `fromSec` in `buildGraph`): a graph started at 6.3 / 12 / 19.5 s of the fixture piece has, 3 s
  later, the same level as a render from the start (-25.3 / -25.9 / -32.1 dBFS in both), and its first 150 ms are
  not louder than the full render at that point (-40.3 / -46.1 / -26.0 against -34.0 / -33.3 / -26.3 dBFS).
  Notes that were already damped are left out; the reverb of notes before the seek point is missing by design.
- Realtime playback uses a fixed master gain of +4 dB (`PLAYER_DEFAULT_GAIN_DB`) and a safety limiter at -2 dBFS;
  the export is normalised instead (gain +4.8 to +9.3 dB on the baseline takes). So playback is 1 to 5 dB below
  the export on those takes.
- Rating loop (`src/store/learning.ts`): a like moves the centre of every range 25 % of the way to the liked
  value and narrows the range to 92 %; a dislike moves it 15 % away and widens it to 104 %; widths stay between
  35 % and 150 % of the preset's own width. Example from the UI check: one like on a Warm take at tempo 60 and
  30 % silent bars moved Warm from "50 to 62 BPM" to "51 to 63 BPM".
- Size: JS 95 kB (35 kB gzip), CSS 12 kB, piano samples 2.5 MB (loaded on the first Generate).

### Listening questions for Elias (Phase 2)

Run `npm install && npm run dev`, open the printed URL, press Generate.

1. **Again:** after Generate, press Again two or three times. Does each take still feel like the same piece
   (same idea, same chords) and is it different enough to be worth having? Knob: how much of the development is
   re-drawn per variation (composer).

   Answer:

2. **Playback:** any clicks, dropouts or jumps when a note starts, when you click into the piano roll, or when
   you turn Reverb / Lo-fi / Pad / Rain while it plays? Is playback loud enough next to the exported WAV?
   Knobs: `PLAYER_DEFAULT_GAIN_DB` (+4 dB), `PLAYER_LOOKAHEAD_SEC` (1.5 s).

   Answer:

3. **Moods:** are Warm, Sad, Dreamy and Cave far enough apart, and is any of them wrong for its name? Which
   knob do you reach for first in each? Knobs: the ranges in `PRESETS` (`src/engine/params.ts`).

   Answer:

## 3. Phase 3 (chat control)

No change to the composer or to the sound constants. The text box maps words to knob moves with fixed rules
(`src/chat/rules.ts`, 40 tests in `tests/chat/rules.test.ts`). One step of each word:

| Words (examples) | Knob moves |
| --- | --- |
| slower / faster | tempo -6 / +6 BPM |
| sadder / happier | mode one step towards minor / major, tempo -4 / +3 BPM, register -2 / +2 semitones |
| more space / less space | silent bars +12 / -12 points, density -0.3 / +0.3 notes per bar |
| sparser, calmer / busier | density -0.4 / +0.5, silent bars +8 / -10 points |
| softer, gentler | density -0.2, silent bars +4 points, lo-fi +5 points (there is no knob for touch) |
| more reverb / drier | reverb +0.8 / -0.8 s; "cave" sets it to 6 s |
| brighter, higher / darker, lower | register +4 / -4 semitones, lo-fi -6 / +6 points |
| dreamier | mode lydian, reverb +0.6 s, pad +10 points, register +3 |
| warmer / colder | lo-fi +12 / -12 points, register -2 / +3, reverb -0.3 / +0.4 s |
| more lo-fi, tape / cleaner | lo-fi +15 / -15 points |
| add rain / light rain / heavy rain / no rain | rain to at least 25 % then +10 points (35 % from zero) / 20 % / at least 75 % / 0 |
| add pad / no pad / just piano | pad to at least 20 % then +12 points / 0 / pad and rain 0 |
| longer / shorter | length +20 / -20 s |

"a bit" halves a step, "much" doubles it, "less / too / not so" reverses it, "no / remove" switches a level off.
Numbers work too ("tempo 60", "in D minor", "2 minutes", "reverb 5s"). Out-of-range numbers are clamped and the
answer says so. The answer always lists every knob that moved with its old and new value.

Requests for existing music are left out and the box says so: "like <name>", "in the style of ...", "play ...",
quoted titles, "melody / chords from ...", note or chord lists. In the UI check, "make it sound like Sweden by
C418, and a bit brighter" moved only the register (+2 semitones) and showed the refusal with the left-out part.
Chat never changes the seed: the same take is re-made with the new settings.

Also in this phase: chord roots and key names are now spelled per key and mode with seven different letters
(Ab dorian shows Gb, not F#; G# is used instead of Ab for Ab aeolian because it needs 5 accidentals instead
of 7). Labels only: no note changed, the regression pins are untouched.

### Listening questions for Elias (Phase 3)

1. Type **sadder** on a Warm take, then again. Each step is: mode one step towards minor, 4 BPM slower, 2
   semitones lower. Is one step too timid, right, or too much?

   Answer:

2. Type **more space**, then **slower**. Is the difference after one step big enough to be worth a message,
   or should a step be larger?

   Answer:

3. Type **add rain** (35 %), then **light rain** (20 %) and **heavy rain** (75 %). Does the rain sit behind the
   piano at 35 %? Is 75 % still usable? Knob: `RAIN_RMS_DB_AT_FULL` (-34 dBFS at rain 100 %).

   Answer:

## 4. Phase 4 (reference analysis, optional)

No change to the composer or to the sound constants. `src/analysis/reference.ts` reads five general traits from a
dropped track and offers knob values. What it can hold is limited by construction: one 12-bin pitch-class
histogram summed over the whole file (for the key), one onset-strength curve without pitch (for tempo and note
density), the long-term spectrum (brightness) and the level curve (decay). The result type is nine scalars; a test
checks that there is no array in it and that two different melodies made of the same notes give the same result.
The UI check confirms that nothing about the file reaches `localStorage` and that the seed does not change.

Measured accuracy on synthetic signals with known properties (`tests/analysis/reference.test.ts`):

| Trait | Made | Read |
| --- | --- | --- |
| Tempo | pulses at 50 / 60 / 72 / 90 / 120 BPM | 50.0 / 60.0 / 72.0 / 90.0 / 60.0 BPM (120 is read an octave down, both fold to the same knob value) |
| Note density | 0.80 / 0.95 / 1.15 / 1.43 / 1.90 onsets per second | 0.80 / 0.95 / 1.15 / 1.43 / 1.90 |
| Key | 7 keys in 4 modes | tonic and mode right in 7 of 7 |
| Reverb length | tails of 1.5 / 3 / 4.5 / 6 s | 1.50 / 2.99 / 4.49 / 5.99 s |

Measured on the lab's own renders (six 60 s takes with known settings, a harder case: sparse, rubato, pad and
hiss on top):

| Trait | Result |
| --- | --- |
| Tempo | within 1 BPM in 6 of 6 (55.1 for 56, 46.7 for 47, 51.7 for 52, 44.1 for 44, 66.0 for 66, 44.7 for 44) |
| Note density | 0.37 / 0.24 / 0.27 / 0.15 / 0.68 / 0.17 onsets per second for 0.44 / 0.25 / 0.38 / 0.15 / 0.79 / 0.20 notes per second (notes struck together count once) |
| Key | tonic right in 3 of 6; the relative major instead of the minor once (Bb for G aeolian); wrong twice (confidence 0.05 and 0.01, the second one below the threshold, so the knob is kept) |
| Brightness | centroid 310 to 468 Hz |
| Reverb length | found in 1 of 6 (6.0 s read for a 5.4 s reverb); "no free decay found" in the other five, so the knob is kept |

What follows from these numbers:

- Tempo and note density are the dependable readings.
- Key is the least certain one (keys that share their notes fit almost equally well). The UI says so in the row.
- Reverb length is only read where the sound falls freely for 0.6 s or more, at least 20 dB below the last loud
  moment. In dense or padded music there is no such place and the knob is left alone rather than guessed.
- Brightness maps to two knobs: a centroid of 350 Hz (the lab's own typical output, measured 300 to 410 Hz) keeps
  register and lo-fi at their defaults; each octave brighter is +5 semitones of register and -20 points of lo-fi.

### Listening questions for Elias (Phase 4)

1. Drop in a track you own (bottom of the page). Do the five readings match what you hear? Which one is off?

   Answer:

2. Press "Use these settings", then Generate a few times. Is the new piece in the same general mood as your
   track (speed, busyness, room) while clearly being different music?

   Answer:

3. Is the result too dark or too bright next to your track? Knobs: `BRIGHTNESS_NEUTRAL_HZ` (350 Hz) and the two
   per-octave steps in `src/analysis/reference.ts`.

   Answer:

## 5. Style Lab (music AI + lo-fi chain)

What was added: style families as descriptor prompts (`src/style`), the ElevenLabs Music backend (`server`),
and the lo-fi chain (`src/postfx`). The piano engine and its numbers above are unchanged.

### Chain stages and what a knob position means (all in `src/postfx/constants.ts`)

| Stage | Knob | Mapping |
| --- | --- | --- |
| Input | - | the file is brought to -18 LUFS before the chain, so every knob acts on the same level |
| Tape | Saturation 0..1 | tanh curve, drive -6 dB (knob just above 0) to +12 dB (knob 1), 4x oversampled |
| Tape | Wow / flutter 0..1 | at 1: 14 cents at 0.37 Hz + 8 cents at 0.53 Hz + 3 cents at 6.1 Hz (a moving delay) |
| Tape | Drift 0..1 | at 1: 12 cents at 0.043 Hz + 8 cents at 0.017 Hz |
| Tape | High-cut 4..16 kHz | 4th order low-pass (24 dB/oct); 16 kHz = bypassed |
| Room | Room 0..1 + type | small room RT60 0.45 s or hall RT60 4.5 s; wet gain 0.9 at knob 1 (unit-energy impulse responses) |
| Mic | Bedroom mic 0..1 | at 1: stereo width 25 %, low-cut 90 Hz, +5 dB at 280 Hz, compressor 3.5:1 at -24 dB |
| Noise | Hiss -60..-45 dB | RMS in dBFS in the finished file; one step lower = off; -45 is the hard ceiling |
| Slowed | 0..25 % | playback rate 1 - x (pitch and tempo together) plus a hall send of up to 0.6 |
| Vocals | Vocal blur 0..1 | on the vocal stem only: low-pass 9 kHz -> 2.2 kHz and a hall send of up to 0.8 |
| Master | - | gain to -16 LUFS, hiss added, look-ahead limiter at -1.5 dBFS, 4x oversampled peak held under -1 dBFS |

### Checks (`tests/postfx`, `tests/analysis/loudness.test.ts`, node-web-audio-api)

- Loudness meter: 1 kHz stereo sine at -23 dBFS reads -23.0 LUFS; 997 Hz mono at full scale reads -3.01; gating
  cases within 0.1 LU; K-weighting coefficients equal the BS.1770 table at 48 kHz to 6 decimals.
- Master: noise at -40 / -20 / -6 dBFS RMS all land within 0.5 LU of -16 with the sample peak <= -1.5 dBFS and
  the oversampled peak <= -1.0 dBFS. A very peaky signal keeps the peak rule and reports the limiter's work.
- Each stage moves its own number: high-cut 8 kHz puts the band above 14 kHz more than 25 dB down; bedroom mic
  at 1 lowers side-against-mid by 10 to 14 dB; slowed 20 % gives 0.8x speed, -3.86 semitones, a tone at 1000 Hz
  measured within 3 cents of 800 Hz; wow / flutter at 1 measures 60 to 115 % of the planned peak deviation
  (15 to 25 cents); saturation at 1 lifts the third harmonic of a 220 Hz tone from below -70 dB to above -35 dB;
  hiss at -50 measures -50 dBFS (+-0.5); same input, settings and seed give identical samples.

### The five presets on the built-in test signal (30 s, not music)

Raw test signal: -16.4 LUFS, peak -6.4 dBFS, centroid 500 Hz, side against mid -13.4 dB.

| Preset | LUFS | Peak dBFS | Peak between samples | MP3 192k peak | Centroid Hz | Side dB | Hiss dBFS | High-cut | Speed | Length |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Ambient keys + pads | -16.0 | -6.33 | -6.33 | -6.48 | 403 | -9.1 | -56 | 10 kHz | 100 % | 0:30 -> 0:35 |
| Bedroom demo | -16.0 | -8.78 | -8.74 | -9.09 | 373 | -19.3 | -50 | 9 kHz | 100 % | 0:30 -> 0:31 |
| Dream-folk vocal | -16.0 | -7.35 | -7.33 | -7.45 | 371 | -12.2 | -56 | 11 kHz | 100 % | 0:30 -> 0:35 |
| Slowcore guitar | -16.0 | -8.47 | -8.40 | -8.63 | 390 | -15.3 | -52 | 10 kHz | 100 % | 0:30 -> 0:31 |
| Slowed + reverb | -16.0 | -5.76 | -5.76 | -5.94 | 455 | -4.9 | -54 | 8 kHz | 86 % | 0:30 -> 0:39 |

These numbers say the chain does what its knobs say. They say nothing about real songs: the test signal is
three tones and noise bursts.

### Known limits

- Request shape, error shape and price were read from the provider's own pages on 2026-11-12
  (api-reference/music/compose, the composition plan guide, the music quickstart, pricing/api): default model
  `music_v2_5`; prompt + `music_length_ms` + `force_instrumental`; lyrics as a chunk plan (v2 models) or a
  section plan (`music_v1`); $0.15 per minute, billed per generation, 5 minute limit.
- Stem separation: the endpoint and its ZIP answer are implemented from the docs but not yet tried against
  the live API; its price is not on the API price list. The app assumes half a generation and says so in
  the confirm dialog.
- The cost shown is an estimate (length x $0.15 per minute). Rounding rules and plan credits are the provider's.
- The name guard works on form (quotes, "in the style of", capitals mid-sentence). A name typed in lowercase
  with no such phrase around it passes the guard; the provider's own filter is the second line there.
- Compressor and wave shaper are the browser's own nodes: Chromium and node-web-audio-api differ slightly in
  their curves. The master stage is plain arithmetic and identical everywhere.

### Music AI test generations

Confirmed by Elias on 2026-11-12 (5 x 1:00, estimated $0.75), then not run: the key form was declined and
Elias asked for the lab to be free instead. The paid engine is still there and still untried against the
live API. `npm run style:test -- --engine ai --length 60 --confirm-usd 0.75` would run it.

## 6. Built-in generator (free, default engine)

Asked for by Elias on 2026-11-12 ("make this free"). The Style Lab no longer needs a key or money: the
default engine composes with the seeded composer from `src/engine` and plays the result with synthesised
voices (`src/sketch`). The lo-fi chain from section 5 is unchanged and runs on its output.

### What plays, and how it is made (all in `src/sketch/synth.ts`)

| Voice | How it is synthesised |
| --- | --- |
| pad | three detuned band-limited saws per note (+-7 cents), low-pass 1.3 kHz + 2.6 kHz, 1.2 s attack, 2.2 s release |
| organ | four sine partials (1, 0.5, 0.22, 0.1), slow tremolo |
| keys / bell | two-operator FM, ratio 1 (keys) or 3.5 (bell), falling index, ring time by pitch |
| toy keyboard | triangle with an octave partial, 5.5 Hz vibrato |
| pluck (guitars) | Karplus-Strong string with an all-pass for exact tuning; ring 1.5 to 6 s by pitch; overdrive = tanh, x25 at drive 1, then 3.2 kHz low-pass |
| bass / sub | sine with a decaying octave partial / plain sine with 0.5 s attack |
| drone | sine + octave + twelfth, 2.5 s swells, 0.07 Hz level movement |
| kick / snare / hat / tick | sine sweep 114 -> 44 Hz / noise + 185 Hz tone / high-passed noise 22 ms / 6 ms click |
| voice | saw with late 5.2 Hz vibrato and 25 % noise, through three formants (380, 820, 2500 Hz). No words. |
| air | band-passed noise around 480 Hz with a 0.06 Hz swell |

Raw mix peak is fixed at -6.0 dBFS; the chain sets the loudness.

### Checks (`tests/sketch`)

- Same request gives identical samples; another seed gives another piece.
- Every pitched note of every part is inside the piece's key and mode (5 families x 4 seeds, vocals on).
- Each family has its instrument groups; the distorted slowcore guitar only plays in the middle section.
- Mixing never doubles melody, bass, drums or voice; a share under 15 % adds nothing.
- Words: "no drums" removes the drum parts, "more guitar" is x1.5 gain, "slower" is -8 BPM, "more tape hiss"
  is +4 dB on the hiss knob (capped at -45), unknown clauses are reported back.
- Voice on: vocals and backing stems exist and add up to the mix (error below 1e-5).
- All five families pass the chain on target (-16 LUFS +-0.5, peak <= -1 dBFS).
- In the browser (`check:ui`): Generate sends no request at all, takes are stored as seed + settings, a reload
  gives the same key and tempo, a 60 s piece takes about 6 s to compose, synthesise and run through the chain.

### The five test pieces sent to Elias on 2026-11-12 (`npm run style:test -- --length 60 --seed 1`)

| Family | Seed | Key | Tempo | Parts |
| --- | --- | --- | --- | --- |
| Ambient keys + pads | 1 | G dorian | 53 BPM, 13 bars | synth pad, organ-like chords, soft keys, low synth bass, faint clicks |
| Bedroom demo | 2 | D major pentatonic | 64 BPM, 16 bars | long synth tone, looped guitar figure, drum machine tick and thump, small keyboard, soft bass notes |
| Dream-folk vocal | 3 | F aeolian | 58 BPM, 14 bars | picked guitar, sparse keys, minimal bass, quiet synth drone, outdoor noise bed, wordless lead and backing voices |
| Slowcore guitar | 4 | G aeolian | 64 BPM, 16 bars | clean guitar, distorted guitar (middle part), single-note guitar, bass guitar, kick, snare, cymbal ticks |
| Slowed + reverb | 5 | E dorian | 71 BPM, 18 bars | synth pads, slow drone, bell-like tones, deep bass, faint pulse |

| Family | Raw LUFS | Raw centroid Hz | Lo-fi LUFS | Lo-fi peak dBFS | MP3 192k peak dBFS | Lo-fi centroid Hz | Side dB raw -> lo-fi | Hiss dBFS | High-cut | Speed | Length |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Ambient keys + pads | -17.1 | 220 | -16.0 | -4.70 | -4.97 | 241 | -4.0 -> -3.4 | -56 | 10 kHz | 100 % | 1:03 -> 1:08 |
| Bedroom demo | -22.0 | 576 | -16.0 | -5.20 | -5.48 | 534 | -4.0 -> -9.3 | -50 | 9 kHz | 100 % | 1:04 -> 1:05 |
| Dream-folk vocal | -18.8 | 665 | -16.0 | -5.21 | -5.48 | 541 | -1.3 -> -2.9 | -56 | 11 kHz | 100 % | 1:02 -> 1:07 |
| Slowcore guitar | -22.5 | 830 | -16.0 | -4.17 | -4.34 | 735 | -17.9 -> -17.7 | -52 | 10 kHz | 100 % | 1:04 -> 1:05 |
| Slowed + reverb | -17.4 | 192 | -16.0 | -5.56 | -5.85 | 182 | -4.4 -> -5.0 | -54 | 8 kHz | 86 % | 1:05 -> 1:20 |

What the numbers show, without judging them: the two pad-heavy families measure dark (centroid around 200 Hz)
and wide (side within 5 dB of mid); the slowcore piece is the brightest and close to mono (side 18 dB under
mid: guitars, bass and drums sit near the centre).

### Known limits

- No sung words. "Vocals" adds a synthesised vowel that follows the melody or holds chord tones.
- The instruments are simple models. How close they come to the families is for Elias to say; nothing here
  was tuned by ear.
- The word rules know a fixed list (see the hint under the plan in the page). Free text beyond it is reported
  as not understood.
- One piece = one seed. There is no "Again" (same idea, played differently) in the Style Lab yet.

### Listening questions for Elias (the five free test pieces)

Three per family. Nothing in the generator or the chain gets tuned before the answers are written down here.

**A. Ambient keys + pads** (`1-ambient-keys-lofi.mp3`: hall 55 %, high-cut 10 kHz, hiss -56 dB)

1. Is there enough empty space between the notes of the keys, or does too much (or too little) happen?

   Answer:

2. It measures dark (centroid 241 Hz). Too dull, about right, or too bright?

   Answer:

3. The reverb tail (hall, RT60 4.5 s): too long, about right, or too short?

   Answer:

**B. Bedroom demo** (`2-bedroom-demo-lofi.mp3`: saturation 45 %, wow / flutter 50 %, bedroom mic 70 %, hiss -50 dB)

1. Does it come across as a home tape recording, or as clean synths with effects on top? Which knob would
   you push first: saturation, wow / flutter or bedroom mic?

   Answer:

2. Hiss at -50 dBFS: too much, about right, or can you not hear it?

   Answer:

3. The guitar figure repeats the same picking pattern in every bar, and a drum machine ticks under it. Keep
   both, vary the figure, or drop the drum machine?

   Answer:

**C. Dream-folk vocal** (`3-dream-folk-lofi.mp3`: hall 50 %, vocal blur 50 %, high-cut 11 kHz)

1. The wordless synth voice: usable as a stand-in for a voice, or does it break the mood (then vocals off
   would be the default for this family)?

   Answer:

2. Voice against guitar: too loud, about right, or too quiet?

   Answer:

3. Reverb on the whole piece: too washed out, right, or too dry?

   Answer:

**D. Slowcore guitar** (`4-slowcore-lofi.mp3`: saturation 50 %, small room 35 %, bedroom mic 50 %)

1. Slow and dragging enough (64 BPM, hits up to 12 ms off the grid), or too stiff?

   Answer:

2. The guitars are a plucked-string model. Close enough to work with, or too thin? And the distorted middle
   part: too much, right, or too little?

   Answer:

3. Drums: too loud, about right, or too quiet?

   Answer:

**E. Slowed + reverb** (`5-slowed-reverb-lofi.mp3`: 86 % speed = -2.6 semitones, hall, high-cut 8 kHz)

1. Is 86 % speed slow enough, or should it go further (the knob goes to 75 %)?

   Answer:

2. It measures very dark (centroid 182 Hz). Blurry in the way you want, or just muddy?

   Answer:

3. The faint pulse on the first beat: keep it, make it louder, or none?

   Answer:
