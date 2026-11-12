# Assets

Every sample, impulse response and font used by Ambient Lab, with source and licence.
Rule: nothing goes into the repo unless it is listed here with a clear licence.
No copyrighted recordings, no ripped audio, no licence-unclear files.

## Audio samples

| Asset | Files | Author | Licence | Source |
| --- | --- | --- | --- | --- |
| Salamander Grand Piano V3 (Yamaha C5), velocity layer 4 of 16, 23 notes F#1..C7 in minor thirds | `public/samples/piano/*.mp3`, `public/samples/piano/manifest.json` | Alexander Holm | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) | <https://github.com/sfzinstruments/SalamanderGrandPiano> (mirror of <https://archive.org/details/SalamanderGrandPianoV3>) |

Changes made to the piano samples (CC BY requires stating them): one velocity layer
picked, the silent lead-in before the hammer trimmed, converted from 48 kHz / 24 bit
FLAC to MP3 (LAME VBR q4, 48 kHz stereo). No EQ, no level change. The conversion is
reproducible with `npm run samples:fetch` (`scripts/fetch-samples.mjs`); the URL and
SHA-256 of every original file are stored in `manifest.json`.

Attribution shown in the app: "Piano: Salamander Grand Piano V3 by Alexander Holm, CC BY 3.0".

## Impulse responses

None are shipped. The reverb impulse response is generated in code at run time
(seeded noise shaped by a decay curve). It contains no recorded material.

## Noise, rain, pad

None are shipped. Tape hiss, rain and the pad are synthesised in code at run time.

## Fonts

| Asset | Files | Author | Licence | Source |
| --- | --- | --- | --- | --- |
| Inter (variable) | bundled from the npm package `@fontsource-variable/inter` | The Inter Project Authors (Rasmus Andersson) | [SIL Open Font License 1.1](https://openfontlicense.org/) | <https://github.com/rsms/inter>, packaged by <https://fontsource.org/fonts/inter> |

## Icons

| Asset | Files | Author | Licence | Source |
| --- | --- | --- | --- | --- |
| Lucide icons | bundled from the npm package `lucide` | Lucide Contributors | [ISC](https://github.com/lucide-icons/lucide/blob/main/LICENSE) (parts derived from Feather, MIT) | <https://lucide.dev> |

## Reference tracks

None are shipped and none are stored. A track dropped into the "Reference" box is decoded in the browser, five
numbers are read from it (tempo, key, note density, brightness, reverb length) and the audio is discarded. It is
not uploaded, not saved and not used as sound material.

## Music

All notes are generated from a seed by the code in `src/engine`. The repo contains
no transcriptions, no MIDI files of existing music and no reference recordings.

## Style Lab

- Built-in generator (`src/sketch`): no samples and no recordings. Every voice (pad, organ, keys, bell,
  plucked string, bass, drums, wordless voice, noise bed) is synthesised in code; every note comes from the
  seeded composer.

- Generated songs: made by the ElevenLabs Music API under the owner's account. They are stored in
  `renders/style` on the owner's computer (git-ignored) and are never committed. What may be done with them
  (for example commercial use) follows the plan and terms of that account, not this repo.
- Lo-fi chain: no recorded material. The small-room impulse response (`src/postfx/room.ts`), the hall
  (`src/audio/reverb.ts`) and the hiss / room tone (`src/postfx/hiss.ts`) are synthesised in code from seeded noise.
- Mock mode: the test signal (`server/mock.ts`) is three sine tones and noise bursts made in code.
- Reference tracks named in `STYLES.md`: no audio of them was downloaded, analysed or stored. The file holds
  public facts and attributed descriptions only.
- Lyrics helper: the sentence frames in `src/style/lyrics.ts` were written for this project.
