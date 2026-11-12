/** "Match my own song": the tone side. Brightness and reverb length of the file set chain knobs. */
import type { SongMatch } from '../analysis/rhythm';
import { HALL_RT60_SEC, ROOM_RT60_SEC } from '../postfx/constants';
import { normalizePostFx, type PostFxSettings } from '../postfx/settings';

/** High-cut corner per Hz of spectral centroid (a centroid of 800 Hz gives 9.6 kHz). */
export const MATCH_HIGHCUT_PER_CENTROID = 12;

export function matchFx(match: Pick<SongMatch, 'brightnessHz' | 'decaySec'>, preset: PostFxSettings): PostFxSettings {
  const next: Partial<PostFxSettings> = { ...preset, highCutHz: match.brightnessHz * MATCH_HIGHCUT_PER_CENTROID };
  if (match.decaySec !== null) {
    // Nearer to the hall or to the small room, and more of it the longer the file rings.
    const hall = match.decaySec > (HALL_RT60_SEC + ROOM_RT60_SEC) / 2 / 2;
    next.roomType = hall ? 'hall' : 'room';
    next.room = Math.min(1, match.decaySec / (hall ? HALL_RT60_SEC : ROOM_RT60_SEC) / 1.5);
  }
  return normalizePostFx(next);
}
