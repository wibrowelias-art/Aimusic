/** Numbers measured on rendered audio. These are what TUNING.md reports. */
export interface AudioMetrics {
  sampleRate: number;
  durationSec: number;
  /** Sample peak in dBFS, max over channels. */
  peakDb: number;
  /** Number of samples with |x| >= 0.999 (must be 0). */
  clippedSamples: number;
  /** RMS over the whole file, both channels, dBFS. */
  rmsDb: number;
  /** peakDb - rmsDb. */
  crestDb: number;
  /** Mean of all samples (should be ~0). */
  dcOffset: number;
  /** Share of 50 ms frames whose RMS is below `silenceThresholdDb`. */
  silenceRatio: number;
  silenceThresholdDb: number;
  /** Energy-weighted centroid of the long-term average spectrum, Hz. */
  spectralCentroidHz: number;
  /**
   * Seconds from `musicEndSec` until the level has dropped below `tailThresholdDb`
   * for good. null when no `musicEndSec` was given.
   */
  tailSec: number | null;
  tailThresholdDb: number;
}
