/**
 * Sanity ranges for rendered audio. Written BEFORE the first render was measured;
 * every later change must be logged in TUNING.md with the numbers that motivated it.
 * (Changed once after the Phase 1 baseline: RT60 and tail, see TUNING.md section 1.)
 */
export const AUDIO_TARGETS = {
  /** Sample peak of the mix: strictly below -1 dBFS, and not uselessly quiet. */
  peakDb: { min: -6, max: -1 },
  /** Whole-file RMS of the mix. Sparse soft piano sits low. */
  rmsDb: { min: -36, max: -16 },
  /** Share of 50 ms frames of the PIANO stem below -50 dBFS (piano incl. its reverb). */
  pianoSilenceRatio: { min: 0, max: 0.85 },
  /** Centroid of the long-term spectrum of the mix: "soft" = low mids, no fizz. */
  centroidHz: { min: 200, max: 1600 },
  /**
   * RT60 of the generated impulse response in the 500-1000 Hz band (T30), seconds:
   * the 3..6 s range of the reverb knob with 5 % measuring margin on both sides.
   */
  rt60Sec: { min: 2.85, max: 6.3 },
  /** Mid-band RT60 may deviate this much (relative) from the requested reverbSize. */
  rt60Tolerance: 0.05,
  /** Broadband T30 divided by the requested reverbSize (the damped highs pull it below 1). */
  rt60BroadRatio: { min: 0.85, max: 1.05 },
  /** Seconds from the last release until piano+pad fall below -60 dBFS for good (must not hang). */
  tailSec: { min: 0, max: 14 },
  /** Seconds from the last piano ONSET until piano+pad fall below -60 dBFS for good. */
  ringOutSec: { min: 3, max: 30 },
} as const;
