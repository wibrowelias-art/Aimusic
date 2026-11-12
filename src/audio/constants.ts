/**
 * Every tunable constant of the sound engine, with units.
 *
 * Nobody tuned these by ear (Claude cannot hear). They are moderate starting points.
 * Change a value here, re-run `npx vitest run tests/audio`, and log the measured
 * numbers before/after in TUNING.md.
 */

/** Hz. Every context and every generated buffer runs at this rate (the sample set is 48 kHz). */
export const SAMPLE_RATE = 48000;

// ---------------------------------------------------------------------------
// Piano sampler
// ---------------------------------------------------------------------------

/** dB relative to a buffer's own peak. The first sample above it is the hammer onset. */
export const ONSET_THRESHOLD_DB = -40;
/** Seconds of buffer scanned for the peak when detecting the onset. */
export const ONSET_SCAN_SEC = 2;
/**
 * Seconds. Playback starts this much before the detected onset, so the hammer
 * lands ONSET_PREROLL_SEC after note.time (the same small delay for every note).
 */
export const ONSET_PREROLL_SEC = 0.002;
/** Seconds. Linear fade-in of every voice (removes the step at the buffer start). Done when the hammer lands. */
export const VOICE_ATTACK_SEC = 0.002;

/** Semitones. Largest pitch shift for pitches inside the sampled range (minor-third sampling). */
export const MAX_SHIFT_IN_RANGE_SEMITONES = 1;
/** Semitones. Pitches outside the sampled range use the edge sample, shift clamped to this. */
export const MAX_SHIFT_SEMITONES = 12;

/** dB. Trim on every piano voice. Sets the piano level before normalisation. */
export const PIANO_GAIN_DB = 12;
/** Voice gain = (velocity / 127) ^ exponent. */
export const VELOCITY_GAIN_EXPONENT = 1.7;

/**
 * Velocity-dependent low-pass per voice (softer = darker).
 * cutoff = LO * (HI / LO) ^ clamp((v - V_LO) / (V_HI - V_LO), 0, 1) * 2 ^ (KEYTRACK * (pitch - 60) / 12)
 */
export const VOICE_LP_VELOCITY_LO = 16; // MIDI velocity
export const VOICE_LP_VELOCITY_HI = 84; // MIDI velocity
export const VOICE_LP_HZ_LO = 1800; // Hz at VELOCITY_LO, pitch C4
export const VOICE_LP_HZ_HI = 12000; // Hz at VELOCITY_HI, pitch C4
/** Octaves of cutoff per octave of pitch. */
export const VOICE_LP_KEYTRACK = 1 / 3;
export const VOICE_LP_HZ_MIN = 600; // Hz, clamp
export const VOICE_LP_HZ_MAX = 16000; // Hz, clamp
/** Filter Q (0.707 = Butterworth, no resonance peak). */
export const VOICE_LP_Q = 0.707;

/**
 * Per-sample level smoothing. The source set is uneven between neighbours
 * (RMS 1 s: F#3 -32.9, A3 -35.3, C4 -28.0 dBFS). At load time a straight line is
 * fitted through manifest.rmsDb over the MIDI number, and every sample is moved
 * towards that line by at most this many dB. See `computeLevelCorrections`.
 *
 * `LEVEL_CORRECTION_TABLE_DB` documents the result for the shipped set (layer 4).
 */
export const LEVEL_CORRECTION_MAX_DB = 4;
/**
 * dB per sample, generated from manifest.rmsDb by `computeLevelCorrections`
 * (rounded to 0.1). Documentation only: the engine recomputes it at load time,
 * and tests/audio/samples.test.ts fails if this table and the manifest disagree.
 */
export const LEVEL_CORRECTION_TABLE_DB: Readonly<Record<string, number>> = {
  'F#1': 0.8,
  A1: 1.7,
  C2: 3.3,
  'D#2': -0.8,
  'F#2': -1.0,
  A2: -1.0,
  C3: -0.3,
  'D#3': -3.9,
  'F#3': 3.0,
  A3: 4.0,
  C4: -3.6,
  'D#4': -1.2,
  'F#4': -3.3,
  A4: -0.1,
  C5: 2.5,
  'D#5': -2.2,
  'F#5': -4.0,
  A5: -0.6,
  C6: 1.4,
  'D#6': -0.5,
  'F#6': 0.7,
  A6: 2.3,
  C7: 2.5,
};

// ---------------------------------------------------------------------------
// Pedal / damper
// ---------------------------------------------------------------------------

/** Seconds. Time constant of the damper release (setTargetAtTime): -8.7 dB per tau. */
export const DAMPER_TAU_SEC = 0.35;
/** MIDI. From this pitch up there are no dampers: the voice rings until the sample ends. F#6 = 90. */
export const DAMPER_FREE_FROM_MIDI = 90;
/** Seconds. Time constant used when the same pitch is struck again while it still rings. */
export const RETRIGGER_TAU_SEC = 0.12;
/** A released voice is stopped after this many time constants (9 tau = -78 dB). */
export const RELEASE_STOP_TAUS = 9;

// ---------------------------------------------------------------------------
// Piano bus tone (lo-fi)
// ---------------------------------------------------------------------------

/** Hz. Bus low-pass at lofi 0 and at lofi 1 (exponential interpolation in between). */
export const LOFI_LP_HZ_CLEAN = 9000;
export const LOFI_LP_HZ_FULL = 2200;
export const LOFI_LP_Q = 0.707;
/** Hz. Gentle bus high-pass (12 dB/oct). */
export const PIANO_HP_HZ = 70;
export const PIANO_HP_Q = 0.707;

// ---------------------------------------------------------------------------
// Tape wobble (detune LFOs on every piano source and pad oscillator)
// ---------------------------------------------------------------------------

/** Hz. Two incommensurate wow LFOs make the movement slightly irregular. */
export const WOW_A_HZ = 0.37;
export const WOW_B_HZ = 0.53;
/** Cents (peak) at lofi 1. A + B = 14 cents is the largest possible wow excursion. */
export const WOW_A_CENTS = 9;
export const WOW_B_CENTS = 5;
/** Hz and cents (peak) at lofi 1 of the light flutter. */
export const FLUTTER_HZ = 6.1;
export const FLUTTER_CENTS = 1.2;
/** Depth = lofi ^ exponent * cents above. 1 = linear. */
export const WOBBLE_DEPTH_EXPONENT = 1;

// ---------------------------------------------------------------------------
// Reverb (procedural impulse response + ConvolverNode per stem)
// ---------------------------------------------------------------------------

/** Seconds of silence at the start of the impulse response. */
export const REVERB_PREDELAY_SEC = 0.025;
/** Seconds. The diffuse tail fades in over this time after the pre-delay. */
export const REVERB_BUILDUP_SEC = 0.03;
/** IR length = pre-delay + rt60 * this (1.0 = the mid band is 60 dB down where the IR ends). */
export const REVERB_LENGTH_FACTOR = 1.0;
/** Seconds. Raised-cosine fade to exactly zero at the end of the IR. */
export const REVERB_END_FADE_SEC = 0.3;
/** Hz. Low-cut over the whole IR (2 x 12 dB/oct). */
export const REVERB_LOWCUT_HZ = 120;
/**
 * Bands of the diffuse tail: [low Hz, high Hz, RT60 multiplier, spectral density in dB at t = 0].
 * Low and mid bands start with the same density per Hz and decay with the requested
 * RT60; the high bands start a little lower and decay faster (damping).
 */
export const REVERB_BANDS: readonly (readonly [number, number, number, number])[] = [
  [120, 400, 1.0, 0],
  [400, 1600, 1.0, 0],
  [1600, 3600, 0.8, -2],
  [3600, 7500, 0.55, -5],
  [7500, 16000, 0.3, -9],
];
/**
 * Hz. Reference band of the level normalisation: the IR is scaled so that a
 * signal in this band leaves the convolver with the energy it went in with.
 * "Wet -4 dB" therefore means: reverberant energy 4 dB below the direct energy
 * for mid-band content, whatever the reverb size.
 */
export const REVERB_REF_BAND_HZ: readonly [number, number] = [500, 1000];
/** Number of discrete early reflections per channel. */
export const REVERB_EARLY_COUNT = 6;
/** Seconds after the pre-delay in which the early reflections fall. */
export const REVERB_EARLY_WINDOW_SEC = 0.07;
/** Share of the IR energy carried by the early reflections. */
export const REVERB_EARLY_ENERGY_SHARE = 0.06;
/** Fixed seed of the IR noise (the IR depends only on sample rate and rt60). */
export const REVERB_SEED = 0x51ab1e;

/** dB. Dry and wet level of the piano stem (wet = reverberant energy re direct, see REVERB_REF_BAND_HZ). */
export const PIANO_DRY_DB = 0;
export const PIANO_WET_DB = -4;
/** dB. Dry and wet level of the pad stem. */
export const PAD_DRY_DB = 0;
export const PAD_WET_DB = -2;

// ---------------------------------------------------------------------------
// Pad synth
// ---------------------------------------------------------------------------

export const PAD_OSC_TYPE: OscillatorType = 'triangle';
/** Cents. The two main oscillators sit at -/+ this. */
export const PAD_DETUNE_CENTS = 6;
/** Stereo position of the two main oscillators (-/+), 0..1. */
export const PAD_SPREAD = 0.35;
/** dB. Level of the sine one octave up, relative to one main oscillator. */
export const PAD_OCTAVE_DB = -14;
/** Hz. Voice low-pass. */
export const PAD_LP_HZ = 1000;
export const PAD_LP_Q = 0.5;
/** Seconds until the attack has reached 95 % (setTargetAtTime, tau = attack / 3). */
export const PAD_ATTACK_SEC = 2.2;
/** Seconds until the release has fallen by 40 dB (setTargetAtTime, tau = release / 4.6). */
export const PAD_RELEASE_SEC = 3.5;
/** A released pad voice is stopped after this many release times (2 = -80 dB). */
export const PAD_STOP_RELEASES = 2;
/** dB. Level of one pad voice at velocity 127 and params.pad = 1. Voice gain scales with v / 127. */
export const PAD_GAIN_DB = -19;

// ---------------------------------------------------------------------------
// Noise bed (procedural loop: tape hiss + rain)
// ---------------------------------------------------------------------------

/** Seconds. Length of the seamless noise loop. */
export const NOISE_LOOP_SEC = 24;
/** dBFS RMS of the hiss at lofi 1 (before normalisation). Amplitude scales with lofi ^ HISS_CURVE. */
export const HISS_RMS_DB_AT_FULL = -46;
export const HISS_CURVE = 1;
/** Hz. Band of the hiss (12 dB/oct edges). */
export const HISS_HP_HZ = 400;
export const HISS_LP_HZ = 8000;

/** dBFS RMS of the rain at rain 1 (before normalisation). Amplitude scales with rain ^ RAIN_CURVE. */
export const RAIN_RMS_DB_AT_FULL = -34;
export const RAIN_CURVE = 1;
/** Hz. Band of the rain wash (12 dB/oct edges). */
export const RAIN_WASH_HP_HZ = 500;
export const RAIN_WASH_LP_HZ = 5000;
/** Slow level movement of the wash: cycles per loop and depth (share of the level, 0..1). */
export const RAIN_SWELL_CYCLES: readonly number[] = [2, 5];
export const RAIN_SWELL_DEPTH: readonly number[] = [0.18, 0.1];
/** Droplet grains per second just above rain 0 and at rain 1. */
export const RAIN_DROPS_PER_SEC_MIN = 60;
export const RAIN_DROPS_PER_SEC_MAX = 260;
/** Hz. Droplet resonance range (log-uniform). */
export const RAIN_DROP_HZ_LO = 1500;
export const RAIN_DROP_HZ_HI = 7000;
/** Seconds. Droplet decay time constant range. */
export const RAIN_DROP_TAU_LO = 0.0008;
export const RAIN_DROP_TAU_HI = 0.004;
export const RAIN_DROP_Q = 3;
/** Relative droplet amplitude = MIN + (1 - MIN) * u^2, u uniform in 0..1. */
export const RAIN_DROP_AMP_MIN = 0.4;
/** Share of the rain energy carried by the droplets (the rest is the wash). */
export const RAIN_DROP_ENERGY_SHARE = 0.2;

/** Seconds. Fade-in at the start and fade-out at the end of the noise stem. */
export const NOISE_FADE_SEC = 1.5;

// ---------------------------------------------------------------------------
// Offline render
// ---------------------------------------------------------------------------

/** Render length = piece.durationSec + reverbSize * FACTOR + EXTRA (seconds). */
export const TAIL_RT60_FACTOR = 1.0;
export const TAIL_EXTRA_SEC = 2.5;
/** dBFS. The mix is normalised to this sample peak. */
export const NORMALIZE_PEAK_DB = -1.5;
/** dBFS. No single stem may peak above this after normalisation (only matters if stems cancel each other). */
export const NORMALIZE_STEM_CEILING_DB = -1.0;
/** dB. Largest boost the normaliser may apply. */
export const NORMALIZE_MAX_BOOST_DB = 18;
/** Seconds. Fade to digital silence at the very end of the render. */
export const END_FADE_SEC = 0.5;

// ---------------------------------------------------------------------------
// WAV export
// ---------------------------------------------------------------------------

/** Fixed seed of the TPDF dither (16 bit export). */
export const DITHER_SEED = 0x0d17be5;

// ---------------------------------------------------------------------------
// Realtime player
// ---------------------------------------------------------------------------

/** Milliseconds between scheduler ticks. */
export const PLAYER_TICK_MS = 100;
/** Seconds scheduled ahead of the playhead (survives 1 s timer throttling in background tabs). */
export const PLAYER_LOOKAHEAD_SEC = 1.5;
/** Seconds between play() and the first sample. */
export const PLAYER_START_DELAY_SEC = 0.12;
/** Seconds. Time constant of the fade when stop() is called. */
export const PLAYER_STOP_TAU_SEC = 0.012;
/** Seconds after stop() until the old graph is torn down. */
export const PLAYER_STOP_TEARDOWN_SEC = 0.1;
/** dB. Master gain when play() gets no gainDb (pass RenderResult.gainDb to match the export). */
export const PLAYER_DEFAULT_GAIN_DB = 4;
/** Safety limiter on the realtime master (DynamicsCompressorNode). Not used offline. */
export const LIMITER_THRESHOLD_DB = -2;
export const LIMITER_KNEE_DB = 0;
export const LIMITER_RATIO = 20;
export const LIMITER_ATTACK_SEC = 0.002;
export const LIMITER_RELEASE_SEC = 0.2;
