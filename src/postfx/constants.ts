/**
 * Fixed numbers of the lo-fi chain: how a knob position (0..1) turns into dB, Hz, cents
 * and seconds. Change one here, note it in TUNING.md with the measured before/after.
 */

/** The input is brought to this loudness before the chain, so every knob acts on the same level. */
export const CHAIN_INPUT_LUFS = -18;
/** Loudness of the finished file. */
export const TARGET_LUFS = -16;
/** Largest allowed distance from the target after mastering, LU. */
export const TARGET_LUFS_TOLERANCE = 0.5;
/** Sample-peak ceiling of the limiter, dBFS. Leaves room for MP3 encoding overshoot. */
export const CEILING_DB = -1.5;
/** The 4x oversampled peak must stay under this, dBFS. */
export const TRUE_PEAK_MAX_DB = -1;

// --- Tape --------------------------------------------------------------------------------
/** Saturation drive in dB at knob 0+ and at knob 1 (gain in front of a tanh curve). */
export const SAT_DRIVE_DB_MIN = -6;
export const SAT_DRIVE_DB_MAX = 12;
/** Points of the tanh table. */
export const SAT_CURVE_POINTS = 4097;
/** Wow: two slow sines with rates that never line up. Depth in cents at knob 1. */
export const TAPE_WOW_A_HZ = 0.37;
export const TAPE_WOW_B_HZ = 0.53;
export const TAPE_WOW_A_CENTS = 14;
export const TAPE_WOW_B_CENTS = 8;
/** Flutter: a fast, shallow sine. */
export const TAPE_FLUTTER_HZ = 6.1;
export const TAPE_FLUTTER_CENTS = 3;
/** Drift: two very slow sines. Depth in cents at knob 1. */
export const TAPE_DRIFT_A_HZ = 0.043;
export const TAPE_DRIFT_B_HZ = 0.017;
export const TAPE_DRIFT_A_CENTS = 12;
export const TAPE_DRIFT_B_CENTS = 8;
/** Q values of the two cascaded low-pass stages (4th order Butterworth). */
export const HIGH_CUT_Q: readonly [number, number] = [0.5412, 1.3066];

// --- Room --------------------------------------------------------------------------------
/** RT60 of the small room and of the hall, seconds (500-1000 Hz band). */
export const ROOM_RT60_SEC = 0.45;
export const HALL_RT60_SEC = 4.5;
/** Wet gain at knob 1 (the impulse responses have unit energy gain in the mid band). */
export const ROOM_WET_AT_FULL = 0.9;
export const HALL_WET_AT_FULL = 0.9;
/** Extra hall send of the "slowed" stage at 25 % slower. */
export const SLOWED_HALL_WET_AT_FULL = 0.6;
/** Small room: pre-delay, early reflection window, bands [loHz, hiHz, rt60 multiplier, dB per Hz]. */
export const ROOM_PREDELAY_SEC = 0.003;
export const ROOM_EARLY_WINDOW_SEC = 0.028;
export const ROOM_EARLY_COUNT = 7;
export const ROOM_EARLY_ENERGY_SHARE = 0.45;
export const ROOM_BANDS: readonly (readonly [number, number, number, number])[] = [
  [120, 400, 1.15, 0],
  [400, 1600, 1.0, 0],
  [1600, 5000, 0.7, -2],
  [5000, 9000, 0.4, -6],
];
export const ROOM_REF_BAND_HZ: readonly [number, number] = [500, 1000];
export const ROOM_SEED = 0x7a11c0de;

// --- Bedroom mic ---------------------------------------------------------------------------
/** Stereo width at knob 1 (1 = unchanged, 0 = mono). */
export const MIC_WIDTH_AT_FULL = 0.25;
/** Low-mid boost: centre, Q, gain in dB at knob 1. */
export const MIC_LOWMID_HZ = 280;
export const MIC_LOWMID_Q = 0.9;
export const MIC_LOWMID_DB_AT_FULL = 5;
/** Low-cut corner at knob 0+ and at knob 1, Hz (12 dB/oct). */
export const MIC_LOWCUT_HZ_MIN = 40;
export const MIC_LOWCUT_HZ_MAX = 90;
/** Compressor: threshold at knob 0+ and knob 1 (dBFS), ratio at knob 1, knee, attack, release. */
export const MIC_COMP_THRESHOLD_DB_MIN = -14;
export const MIC_COMP_THRESHOLD_DB_MAX = -24;
export const MIC_COMP_RATIO_AT_FULL = 3.5;
export const MIC_COMP_KNEE_DB = 12;
export const MIC_COMP_ATTACK_SEC = 0.02;
export const MIC_COMP_RELEASE_SEC = 0.25;

// --- Noise ---------------------------------------------------------------------------------
/** Hiss band and room-tone band, Hz. */
export const HISS_BAND_HZ: readonly [number, number] = [2500, 11000];
export const TONE_BAND_HZ: readonly [number, number] = [60, 350];
/** Share of the noise power that is room tone (the rest is hiss). */
export const TONE_POWER_SHARE = 0.35;

// --- Vocal blur ----------------------------------------------------------------------------
/** Low-pass corner of the vocal stem at knob 0+ and at knob 1, Hz. */
export const VOCAL_LP_HZ_MAX = 9000;
export const VOCAL_LP_HZ_MIN = 2200;
/** Hall send of the vocal stem at knob 1. */
export const VOCAL_HALL_WET_AT_FULL = 0.8;

// --- Master --------------------------------------------------------------------------------
/** Look-ahead and release of the peak limiter, seconds. */
export const LIMITER_LOOKAHEAD_SEC = 0.005;
export const LIMITER_RELEASE_SEC = 0.12;
/** The reverb may ring this long after the input ends, seconds. */
export const TAIL_MAX_SEC = 6;
/** Fade at the very end, seconds. */
export const END_FADE_SEC = 0.8;
