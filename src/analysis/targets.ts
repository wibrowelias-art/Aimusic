/**
 * Sanity ranges for rendered audio. Written BEFORE the first render was measured;
 * every later change must be logged in TUNING.md with the numbers that motivated it.
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
  /** Measured RT60 of the generated impulse response, absolute bounds in seconds. */
  rt60Sec: { min: 3, max: 6 },
  /** Measured RT60 may deviate this much (relative) from the requested reverbSize. */
  rt60Tolerance: 0.2,
  /** Seconds from the last release until piano+pad fall below -60 dBFS for good. */
  tailSec: { min: 2, max: 14 },
} as const;
