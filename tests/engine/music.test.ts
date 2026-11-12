import { describe, expect, it } from 'vitest';
import {
  BEATS_PER_BAR,
  createRng,
  generate,
  MELODY_FLOOR,
  MELODY_HALF_RANGE,
  melodyRange,
  MODES,
  motifOnsets,
  MUD_LIMIT,
  MUD_MIN_INTERVAL,
  PASSING_SHARE,
  type Note,
  type Params,
  type Piece,
} from '../../src/engine';
import { barOf, chordAtBar, extremeParams, melodyInScoreOrder, Problems, randomParams } from './helpers';

function batch(): Piece[] {
  const rng = createRng(31337);
  const sets: Partial<Params>[] = extremeParams();
  for (let i = 0; i < 260; i++) sets.push(randomParams(rng));
  for (const mode of MODES) {
    for (let seed = 1; seed <= 25; seed++) sets.push({ seed, mode, key: (seed * 5) % 12 });
  }
  return sets.map((p) => generate(p));
}

/** Pieces with ordinary settings: 25 seeds per mode at the default params. */
function ordinary(): Piece[] {
  const out: Piece[] = [];
  for (const mode of MODES) {
    for (let seed = 1; seed <= 25; seed++) out.push(generate({ seed, mode }));
  }
  return out;
}

const pieces = batch();

describe('notes and chords', () => {
  it('every note is a chord tone of its chord, or a marked passing tone that is not', () => {
    for (const piece of pieces) {
      for (const n of piece.notes) {
        const chord = chordAtBar(piece, barOf(n));
        const inChord = chord.pitchClasses.includes(n.pitch % 12);
        expect(inChord).toBe(!n.passing);
      }
    }
  });

  it('passing tones stay a small share: at most 15 % by construction, under 20 % everywhere', () => {
    let passing = 0;
    let all = 0;
    let worst = 0;
    for (const piece of pieces) {
      const count = piece.notes.filter((n) => n.passing).length;
      passing += count;
      all += piece.notes.length;
      worst = Math.max(worst, count / piece.notes.length);
      expect(count).toBeLessThanOrEqual(Math.floor(PASSING_SHARE * piece.notes.length));
      expect(count / piece.notes.length).toBeLessThan(0.2);
    }
    console.log(`[music] passing tones: ${(100 * (passing / all)).toFixed(1)} % of all notes, worst piece ${(100 * worst).toFixed(1)} %`);
    // They do occur.
    expect(passing).toBeGreaterThan(0);
  });

  it('passing tones are short, on weak positions, between two chord tones, connected by step, never a semitone above a chord tone', () => {
    let checked = 0;
    for (const piece of pieces) {
      const melody = melodyInScoreOrder(piece);
      melody.forEach((n, i) => {
        if (!n.passing) return;
        checked++;
        expect(n.role).toBe('melody');
        expect(n.durBeats).toBeLessThanOrEqual(1);
        // Weak: not on beat 1 or 3 of the bar.
        expect(n.startBeat % 2).not.toBe(0);
        const chord = chordAtBar(piece, barOf(n));
        expect(chord.pitchClasses).not.toContain((n.pitch + 11) % 12);
        expect(i).toBeGreaterThan(0);
        expect(i).toBeLessThan(melody.length - 1);
        const before = melody[i - 1];
        const after = melody[i + 1];
        expect(before.passing).toBe(false);
        expect(after.passing).toBe(false);
        const rising = before.pitch < n.pitch && n.pitch < after.pitch;
        const falling = before.pitch > n.pitch && n.pitch > after.pitch;
        expect(rising || falling).toBe(true);
        // A scale step to at least one neighbour: no scale tone lies strictly between.
        const stepTo = (other: Note): boolean => {
          const lo = Math.min(n.pitch, other.pitch);
          const hi = Math.max(n.pitch, other.pitch);
          for (let p = lo + 1; p < hi; p++) {
            if (piece.scale.includes(p % 12)) return false;
          }
          return true;
        };
        expect(stepTo(before) || stepTo(after)).toBe(true);
      });
    }
    expect(checked).toBeGreaterThan(100);
  });
});

describe('registers and the left hand', () => {
  it('melody: within 10 semitones of the register in A and A2, up to an octave further in B, never below C3', () => {
    const problems = new Problems();
    for (const piece of pieces) {
      const register = piece.params.register;
      const [lo, hi] = melodyRange(register);
      expect(lo).toBe(Math.max(MELODY_FLOOR, register - MELODY_HALF_RANGE));
      expect(hi).toBe(register + MELODY_HALF_RANGE);
      for (const n of piece.notes) {
        if (n.role !== 'melody') continue;
        problems.check(n.pitch >= MELODY_FLOOR, () => `melody pitch ${n.pitch} below C3`);
        if (n.section === 'B') {
          problems.check(
            Math.abs(n.pitch - register) <= MELODY_HALF_RANGE + 12,
            () => `B melody pitch ${n.pitch} too far from register ${register}`,
          );
        } else {
          problems.check(n.pitch >= lo && n.pitch <= hi, () => `${n.section} melody pitch ${n.pitch} outside ${lo}..${hi}`);
        }
      }
    }
    expect(problems.list).toEqual([]);
  });

  it('B sits in another register than A (mean melody pitch differs) in most pieces', () => {
    let shifted = 0;
    let total = 0;
    for (const piece of ordinary()) {
      const mean = (section: string): number | null => {
        const ps = piece.notes.filter((n) => n.role === 'melody' && n.section === section).map((n) => n.pitch);
        return ps.length > 0 ? ps.reduce((a, b) => a + b, 0) / ps.length : null;
      };
      const a = mean('A');
      const b = mean('B');
      if (a === null || b === null) continue;
      total++;
      if (Math.abs(a - b) >= 2.5) shifted++;
    }
    expect(total).toBeGreaterThan(90);
    expect(shifted / total).toBeGreaterThan(0.8);
  });

  it('the left hand stays under the melody in every chord span', () => {
    for (const piece of pieces) {
      for (const chord of piece.chords) {
        const inSpan = piece.notes.filter((n) => barOf(n) >= chord.startBar && barOf(n) < chord.startBar + chord.bars);
        const melody = inSpan.filter((n) => n.role === 'melody').map((n) => n.pitch);
        const left = inSpan.filter((n) => n.role === 'bass' || n.role === 'harmony').map((n) => n.pitch);
        if (melody.length === 0 || left.length === 0) continue;
        expect(Math.max(...left)).toBeLessThan(Math.min(...melody));
      }
    }
  });

  it('no mud: below C3 two different pitches of one chord span are at least a fifth apart', () => {
    for (const piece of pieces) {
      for (const chord of piece.chords) {
        const low = new Set(
          piece.notes
            .filter((n) => barOf(n) >= chord.startBar && barOf(n) < chord.startBar + chord.bars && n.pitch < MUD_LIMIT)
            .map((n) => n.pitch),
        );
        const sorted = [...low].sort((a, b) => a - b);
        for (let i = 1; i < sorted.length; i++) {
          expect(sorted[i] - sorted[i - 1]).toBeGreaterThanOrEqual(MUD_MIN_INTERVAL);
        }
      }
    }
  });

  it('bass notes are chord roots in a low octave; echoes repeat a melody pitch class softly', () => {
    for (const piece of pieces) {
      for (const n of piece.notes) {
        const chord = chordAtBar(piece, barOf(n));
        if (n.role === 'bass') {
          expect(n.pitch % 12).toBe(chord.root);
          expect(n.pitch).toBeLessThan(MUD_LIMIT);
          expect(n.pitch).toBeGreaterThanOrEqual(33);
        }
        if (n.role === 'echo') {
          expect(n.pitch).toBeGreaterThanOrEqual(MELODY_FLOOR);
          const source = piece.notes.find(
            (m) =>
              m.role === 'melody' &&
              m.pitch % 12 === n.pitch % 12 &&
              m.startBeat < n.startBeat &&
              n.startBeat - m.startBeat <= 3,
          );
          expect(source).toBeDefined();
        }
      }
    }
  });

  it('the left hand is sparse: fewer accompaniment notes than melody notes overall', () => {
    let melody = 0;
    let other = 0;
    const roles = { bass: 0, harmony: 0, echo: 0 };
    for (const piece of ordinary()) {
      for (const n of piece.notes) {
        if (n.role === 'melody') melody++;
        else {
          other++;
          roles[n.role]++;
        }
      }
    }
    console.log(
      `[music] default params, 100 pieces: melody ${melody}, bass ${roles.bass}, harmony ${roles.harmony}, echo ${roles.echo}`,
    );
    expect(other).toBeLessThan(melody);
    expect(roles.bass).toBeGreaterThan(0);
    expect(roles.harmony).toBeGreaterThan(0);
    expect(roles.echo).toBeGreaterThan(0);
  });
});

describe('motif and form in the notes', () => {
  it('bar 0 starts with the motif: first onset on beat 0, as many opening notes as the motif has', () => {
    for (const piece of pieces) {
      const melody = melodyInScoreOrder(piece);
      const count = piece.motif.steps.length;
      expect(melody.length).toBeGreaterThanOrEqual(count + 1);
      expect(melody[0].startBeat).toBe(0);
      expect(melody[0].section).toBe('A');
      for (const n of melody.slice(0, count)) expect(n.section).toBe('A');
    }
  });

  it('with ordinary settings the opening statement has the rhythm of the motif as written and follows its contour', () => {
    for (const piece of ordinary()) {
      const melody = melodyInScoreOrder(piece);
      const count = piece.motif.steps.length;
      const opening = melody.slice(0, count);
      expect(opening.map((n) => n.startBeat)).toEqual(motifOnsets(piece.motif));
      for (let i = 1; i < count; i++) {
        const motifMove = Math.sign(piece.motif.steps[i] - piece.motif.steps[i - 1]);
        const played = Math.sign(opening[i].pitch - opening[i - 1].pitch);
        // Same direction as the motif (a repeat in the motif stays a repeat).
        expect(played).toBe(motifMove);
      }
    }
  });

  it('every section has notes with ordinary settings, and A2 is thinner than A', () => {
    let densityA = 0;
    let densityA2 = 0;
    const all = ordinary();
    for (const piece of all) {
      const perSection = (name: string): number => piece.notes.filter((n) => n.section === name).length;
      for (const s of piece.sections) expect(perSection(s.name)).toBeGreaterThan(0);
      densityA += perSection('A') / piece.sections[0].bars / all.length;
      densityA2 += perSection('A2') / piece.sections[2].bars / all.length;
    }
    console.log(`[music] default params: A ${densityA.toFixed(2)} notes/bar, A2 ${densityA2.toFixed(2)} notes/bar`);
    expect(densityA2).toBeLessThan(densityA);
  });

  it('ends on a long tone of the tonic triad: the last onset is a melody note of at least one bar', () => {
    for (const piece of pieces) {
      const last = piece.notes[piece.notes.length - 1];
      const lastChord = piece.chords[piece.chords.length - 1];
      expect(lastChord.degree).toBe(0);
      expect(last.role).toBe('melody');
      expect(last.passing).toBe(false);
      expect(last.section).toBe('A2');
      const interval = (last.pitch - lastChord.root + 120) % 12;
      expect([0, 3, 4, 7]).toContain(interval);
      expect(lastChord.pitchClasses).toContain(last.pitch % 12);
      expect(last.durBeats).toBeGreaterThanOrEqual(BEATS_PER_BAR);
      // Nothing starts after it, and it sits in the last or second to last bar, on the bar line.
      for (const n of piece.notes) expect(n.startBeat).toBeLessThanOrEqual(last.startBeat);
      expect(barOf(last)).toBeGreaterThanOrEqual(piece.bars - 2);
      expect(last.startBeat % BEATS_PER_BAR).toBe(0);
      // It is held to the very end of the piece.
      expect(Math.abs(last.time + last.duration - piece.durationSec)).toBeLessThan(1e-5);
    }
  });

  it('silence is whole bars between phrases: playing bars form runs, silent bars form gaps, no long dead stretch', () => {
    let runBars = 0;
    let runs = 0;
    let gapBars = 0;
    let gaps = 0;
    for (const piece of ordinary()) {
      const active = new Array<boolean>(piece.bars).fill(false);
      for (const n of piece.notes) active[barOf(n)] = true;
      let run = 0;
      let gap = 0;
      for (let bar = 0; bar <= piece.bars; bar++) {
        if (bar < piece.bars && active[bar]) {
          if (gap > 0) {
            gapBars += gap;
            gaps++;
            // Default params (35 % silent bars): no gap longer than 5 bars.
            expect(gap).toBeLessThanOrEqual(5);
          }
          gap = 0;
          run++;
        } else {
          if (run > 0) {
            runBars += run;
            runs++;
          }
          run = 0;
          gap++;
        }
      }
      // The piece does not trail off into more than one silent bar.
      expect(gap).toBeLessThanOrEqual(2);
    }
    console.log(
      `[music] default params: phrases of ${(runBars / runs).toFixed(2)} bars on average, gaps of ${(gapBars / gaps).toFixed(2)} bars`,
    );
    expect(runBars / runs).toBeGreaterThan(1.8);
    expect(runBars / runs).toBeLessThan(5);
    expect(gapBars / gaps).toBeGreaterThanOrEqual(1);
    expect(gapBars / gaps).toBeLessThan(2.5);
  });

  it('with no rests asked and enough notes every bar plays', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const piece = generate({ seed, restProbability: 0, density: 2 });
      const active = new Set(piece.notes.map((n) => barOf(n)));
      expect(active.size).toBe(piece.bars);
    }
  });

  it('the melody moves slowly: onsets on the half-beat grid, mostly a beat or more apart with ordinary settings', () => {
    let gaps = 0;
    let slow = 0;
    for (const piece of ordinary()) {
      const melody = melodyInScoreOrder(piece);
      for (const n of piece.notes) expect((n.startBeat * 2) % 1).toBe(0);
      for (let i = 1; i < melody.length; i++) {
        gaps++;
        if (melody[i].startBeat - melody[i - 1].startBeat >= 1) slow++;
      }
    }
    expect(slow / gaps).toBeGreaterThan(0.85);
  });

  it('notes ring: key-down times of at least half a beat, bass notes are long', () => {
    const problems = new Problems();
    for (const piece of pieces) {
      for (const n of piece.notes) {
        problems.check(n.durBeats >= 0.5, () => `note at beat ${n.startBeat} lasts ${n.durBeats} beats`);
        problems.check(n.startBeat + n.durBeats <= piece.bars * BEATS_PER_BAR, () => `note at beat ${n.startBeat} runs past the end`);
      }
    }
    expect(problems.list).toEqual([]);
    let total = 0;
    let count = 0;
    for (const piece of ordinary()) {
      for (const n of piece.notes) {
        total += n.durBeats;
        count++;
      }
    }
    expect(total / count).toBeGreaterThan(1.5);
  });
});
