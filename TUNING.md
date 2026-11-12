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
