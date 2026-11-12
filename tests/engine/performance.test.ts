import { describe, expect, it } from 'vitest';
import {
  BEATS_PER_BAR,
  createRng,
  generate,
  HUMANIZE_MAX_MS,
  HUMANIZE_MIN_MS,
  LEAD_IN_SEC,
  MODES,
  PAD_HIGH,
  PAD_LOW,
  scoreTime,
  VELOCITY_MAX,
  VELOCITY_MIN,
  type Params,
  type Piece,
} from '../../src/engine';
import { extremeParams, Problems, randomParams } from './helpers';

function batch(): Piece[] {
  const rng = createRng(8086);
  const sets: Partial<Params>[] = extremeParams();
  for (let i = 0; i < 240; i++) sets.push(randomParams(rng));
  for (const mode of MODES) {
    for (let seed = 1; seed <= 20; seed++) sets.push({ seed, mode });
  }
  return sets.map((p) => generate(p));
}

const pieces = batch();

function beatDurations(piece: Piece): number[] {
  const out: number[] = [];
  for (let i = 1; i < piece.beatTimes.length; i++) out.push(piece.beatTimes[i] - piece.beatTimes[i - 1]);
  return out;
}

describe('velocities', () => {
  it('are soft: every velocity inside 22..78', () => {
    let lo = 127;
    let hi = 0;
    for (const piece of pieces) {
      for (const n of piece.notes) {
        expect(Number.isInteger(n.velocity)).toBe(true);
        expect(n.velocity).toBeGreaterThanOrEqual(VELOCITY_MIN);
        expect(n.velocity).toBeLessThanOrEqual(VELOCITY_MAX);
        lo = Math.min(lo, n.velocity);
        hi = Math.max(hi, n.velocity);
      }
    }
    expect(VELOCITY_MIN).toBe(22);
    expect(VELOCITY_MAX).toBe(78);
    console.log(`[perform] velocity range over ${pieces.length} pieces: ${lo}..${hi}`);
  });

  it('melody is a bit above the accompaniment; echoes are the softest role', () => {
    const sum = { melody: 0, bass: 0, harmony: 0, echo: 0 };
    const count = { melody: 0, bass: 0, harmony: 0, echo: 0 };
    for (const piece of pieces) {
      for (const n of piece.notes) {
        sum[n.role] += n.velocity;
        count[n.role]++;
      }
    }
    const mean = {
      melody: sum.melody / count.melody,
      bass: sum.bass / count.bass,
      harmony: sum.harmony / count.harmony,
      echo: sum.echo / count.echo,
    };
    console.log(
      `[perform] mean velocity: melody ${mean.melody.toFixed(1)}, bass ${mean.bass.toFixed(1)}, harmony ${mean.harmony.toFixed(1)}, echo ${mean.echo.toFixed(1)}`,
    );
    expect(mean.melody).toBeGreaterThan(mean.bass + 4);
    expect(mean.melody).toBeGreaterThan(mean.harmony + 4);
    expect(mean.echo).toBeLessThan(mean.harmony);
  });

  it('A2 is softer than A and the closing note is softer than the average melody note', () => {
    let a = 0;
    let a2 = 0;
    let nA = 0;
    let nA2 = 0;
    let closingBelow = 0;
    for (const piece of pieces) {
      const melody = piece.notes.filter((n) => n.role === 'melody');
      let mean = 0;
      for (const n of melody) {
        mean += n.velocity / melody.length;
        if (n.section === 'A') {
          a += n.velocity;
          nA++;
        }
        if (n.section === 'A2') {
          a2 += n.velocity;
          nA2++;
        }
      }
      if (piece.notes[piece.notes.length - 1].velocity < mean) closingBelow++;
    }
    expect(a2 / nA2).toBeLessThan(a / nA - 2);
    expect(closingBelow / pieces.length).toBeGreaterThan(0.95);
  });

  it('phrases have an arc: velocities vary inside a piece', () => {
    for (const piece of pieces) {
      const melody = piece.notes.filter((n) => n.role === 'melody').map((n) => n.velocity);
      if (melody.length < 8) continue;
      expect(Math.max(...melody) - Math.min(...melody)).toBeGreaterThanOrEqual(4);
    }
  });
});

describe('rubato', () => {
  it('beatTimes: bars * 4 + 1 strictly increasing values, lead-in of at least 0.05 s, bar lines consistent', () => {
    for (const piece of pieces) {
      expect(piece.beatTimes.length).toBe(piece.bars * BEATS_PER_BAR + 1);
      expect(piece.beatTimes[0]).toBeGreaterThanOrEqual(0.05);
      expect(piece.beatTimes[0]).toBe(LEAD_IN_SEC);
      for (const d of beatDurations(piece)) expect(d).toBeGreaterThan(0);
      expect(piece.barTimes.length).toBe(piece.bars + 1);
      piece.barTimes.forEach((t, bar) => expect(t).toBe(piece.beatTimes[bar * BEATS_PER_BAR]));
      expect(piece.durationSec).toBe(piece.beatTimes[piece.beatTimes.length - 1]);
    }
  });

  it('the mean tempo stays within 8 % of params.tempo', () => {
    let worst = 0;
    for (const piece of pieces) {
      const beats = piece.bars * BEATS_PER_BAR;
      const mean = (beats * 60) / (piece.beatTimes[beats] - piece.beatTimes[0]);
      const deviation = mean / piece.params.tempo - 1;
      worst = Math.max(worst, Math.abs(deviation));
      expect(Math.abs(deviation)).toBeLessThan(0.08);
      // Rubato only ever stretches the mean a little; it never rushes.
      expect(deviation).toBeLessThanOrEqual(1e-6);
    }
    console.log(`[perform] worst mean-tempo deviation: ${(100 * worst).toFixed(2)} %`);
  });

  it('is smooth: neighbouring beats differ by a few percent, single beats stay within -10 % / +45 % of nominal', () => {
    let slowest = 0;
    let fastest = Infinity;
    let jump = 0;
    for (const piece of pieces) {
      const nominal = 60 / piece.params.tempo;
      const durs = beatDurations(piece);
      for (let i = 0; i < durs.length; i++) {
        slowest = Math.max(slowest, durs[i] / nominal);
        fastest = Math.min(fastest, durs[i] / nominal);
        if (i > 0) jump = Math.max(jump, durs[i] / durs[i - 1], durs[i - 1] / durs[i]);
      }
    }
    console.log(
      `[perform] beat length / nominal: ${fastest.toFixed(3)}..${slowest.toFixed(3)}, largest step between neighbouring beats ${((jump - 1) * 100).toFixed(1)} %`,
    );
    expect(fastest).toBeGreaterThan(0.9);
    expect(slowest).toBeLessThan(1.45);
    expect(jump).toBeLessThan(1.12);
  });

  it('the tempo drifts: beat lengths are not constant', () => {
    for (const piece of pieces) {
      const durs = beatDurations(piece).slice(0, -8);
      expect(Math.max(...durs) / Math.min(...durs)).toBeGreaterThan(1.01);
    }
  });

  it('ends with a clear ritardando: the last beats get longer and longer, the last one at least 15 % over nominal', () => {
    for (const piece of pieces) {
      const nominal = 60 / piece.params.tempo;
      const durs = beatDurations(piece);
      const tail = durs.slice(-4);
      for (let i = 1; i < tail.length; i++) expect(tail[i]).toBeGreaterThan(tail[i - 1]);
      expect(tail[3] / nominal).toBeGreaterThan(1.15);
      const body = durs.slice(0, -8);
      const bodyMean = body.reduce((a, b) => a + b, 0) / body.length;
      expect(tail[3] / bodyMean).toBeGreaterThan(1.15);
    }
  });

  it('scoreTime interpolates the tempo map linearly', () => {
    for (const piece of pieces.slice(0, 40)) {
      const last = piece.bars * BEATS_PER_BAR;
      for (let beat = 0; beat <= last; beat += 7) expect(scoreTime(piece, beat)).toBe(piece.beatTimes[beat]);
      expect(scoreTime(piece, 2.5)).toBeCloseTo((piece.beatTimes[2] + piece.beatTimes[3]) / 2, 9);
      expect(scoreTime(piece, 0.25)).toBeCloseTo(piece.beatTimes[0] + 0.25 * (piece.beatTimes[1] - piece.beatTimes[0]), 9);
      let prev = -1;
      for (let beat = 0; beat <= last; beat += 0.5) {
        const t = scoreTime(piece, beat);
        expect(t).toBeGreaterThan(prev);
        prev = t;
      }
      // Outside the piece it clamps.
      expect(scoreTime(piece, -3)).toBe(piece.beatTimes[0]);
      expect(scoreTime(piece, last + 10)).toBe(piece.durationSec);
    }
  });
});

describe('humanised timing', () => {
  it('humanizeMs is 15..40 and every onset stays inside the bound, never before time 0', () => {
    const seen = new Set<number>();
    const problems = new Problems();
    let largest = 0;
    expect(HUMANIZE_MIN_MS).toBe(15);
    expect(HUMANIZE_MAX_MS).toBe(40);
    for (const piece of pieces) {
      expect(piece.humanizeMs).toBeGreaterThanOrEqual(15);
      expect(piece.humanizeMs).toBeLessThanOrEqual(40);
      seen.add(piece.humanizeMs);
      for (const n of piece.notes) {
        const offset = n.time - scoreTime(piece, n.startBeat);
        largest = Math.max(largest, Math.abs(offset) / (piece.humanizeMs / 1000));
        problems.check(Math.abs(offset) <= piece.humanizeMs / 1000, () => `note ${n.id}: offset ${offset} s, bound ${piece.humanizeMs} ms`);
        problems.check(n.time >= 0, () => `note ${n.id}: time ${n.time}`);
      }
    }
    expect(problems.list).toEqual([]);
    console.log(`[perform] largest onset offset: ${(100 * largest).toFixed(1)} % of humanizeMs`);
    expect(seen.size).toBeGreaterThan(15);
  });

  it('the offsets are really there: spread of a few milliseconds, both early and late', () => {
    for (const piece of pieces) {
      if (piece.notes.length < 20) continue;
      const offsets = piece.notes.map((n) => n.time - scoreTime(piece, n.startBeat));
      const mean = offsets.reduce((a, b) => a + b, 0) / offsets.length;
      const sd = Math.sqrt(offsets.reduce((a, b) => a + (b - mean) * (b - mean), 0) / offsets.length);
      expect(sd * 1000).toBeGreaterThan(2);
      expect(Math.min(...offsets)).toBeLessThan(0);
      expect(Math.max(...offsets)).toBeGreaterThan(0);
    }
  });

  it('notes written on the same beat are rolled low to high', () => {
    let chords = 0;
    for (const piece of pieces) {
      const groups = new Map<number, { pitch: number; time: number }[]>();
      for (const n of piece.notes) {
        const g = groups.get(n.startBeat);
        if (g) g.push(n);
        else groups.set(n.startBeat, [n]);
      }
      for (const group of groups.values()) {
        if (group.length < 2) continue;
        chords++;
        const byPitch = group.slice().sort((a, b) => a.pitch - b.pitch);
        for (let i = 1; i < byPitch.length; i++) {
          expect(byPitch[i].pitch).toBeGreaterThan(byPitch[i - 1].pitch);
          expect(byPitch[i].time).toBeGreaterThanOrEqual(byPitch[i - 1].time);
        }
        // The whole roll fits inside the humanise window.
        expect(byPitch[byPitch.length - 1].time - byPitch[0].time).toBeLessThanOrEqual((2 * piece.humanizeMs) / 1000);
      }
    }
    expect(chords).toBeGreaterThan(500);
  });
});

describe('durations, pedal and pad', () => {
  it('notes are sorted by time then pitch with ids in order, positive durations, released by durationSec', () => {
    const problems = new Problems();
    for (const piece of pieces) {
      piece.notes.forEach((n, i) => {
        problems.check(n.id === i, () => `id ${n.id} at index ${i}`);
        problems.check(n.duration > 0.05, () => `note ${i}: duration ${n.duration}`);
        problems.check(n.time + n.duration <= piece.durationSec + 1e-9, () => `note ${i} ends after durationSec`);
        if (i > 0) {
          const p = piece.notes[i - 1];
          problems.check(n.time > p.time || (n.time === p.time && n.pitch >= p.pitch), () => `note ${i} out of order`);
        }
      });
    }
    expect(problems.list).toEqual([]);
  });

  it('no two notes of the same pitch overlap: at least 10 ms between release and the next strike', () => {
    let closest = Infinity;
    for (const piece of pieces) {
      const lastEnd = new Map<number, number>();
      for (const n of piece.notes) {
        const end = lastEnd.get(n.pitch);
        if (end !== undefined) {
          expect(n.time - end).toBeGreaterThanOrEqual(0.01);
          closest = Math.min(closest, n.time - end);
        }
        lastEnd.set(n.pitch, n.time + n.duration);
      }
      const padEnd = new Map<number, number>();
      for (const n of piece.pad) {
        const end = padEnd.get(n.pitch);
        if (end !== undefined) expect(n.time - end).toBeGreaterThanOrEqual(0.01);
        padEnd.set(n.pitch, n.time + n.duration);
      }
    }
    console.log(`[perform] smallest same-pitch gap: ${(closest * 1000).toFixed(1)} ms`);
  });

  it('key-down time follows the score duration through the tempo map (or is shorter when the same pitch returns)', () => {
    for (const piece of pieces.slice(0, 60)) {
      for (const n of piece.notes) {
        const written = scoreTime(piece, n.startBeat + n.durBeats) - scoreTime(piece, n.startBeat);
        expect(n.duration).toBeLessThanOrEqual(written + (2 * piece.humanizeMs) / 1000 + 0.13);
      }
    }
  });

  it('pedal: down shortly after each chord starts, up shortly before the next one, last up at the end', () => {
    for (const piece of pieces) {
      expect(piece.pedal.length).toBe(piece.chords.length * 2);
      piece.chords.forEach((chord, i) => {
        const down = piece.pedal[2 * i];
        const up = piece.pedal[2 * i + 1];
        expect(down.down).toBe(true);
        expect(up.down).toBe(false);
        expect(down.time - chord.startTime).toBeGreaterThanOrEqual(0.04);
        expect(down.time - chord.startTime).toBeLessThanOrEqual(0.12);
        if (i < piece.chords.length - 1) {
          expect(chord.endTime - up.time).toBeGreaterThanOrEqual(0.05);
          expect(chord.endTime - up.time).toBeLessThanOrEqual(0.11);
        } else {
          expect(up.time).toBe(piece.durationSec);
        }
        expect(up.time).toBeGreaterThan(down.time);
      });
      for (let i = 1; i < piece.pedal.length; i++) expect(piece.pedal[i].time).toBeGreaterThan(piece.pedal[i - 1].time);
    }
  });

  it('durationSec is the last release: final pedal up and the end of the closing note', () => {
    for (const piece of pieces) {
      let lastRelease = 0;
      for (const n of piece.notes) lastRelease = Math.max(lastRelease, n.time + n.duration);
      for (const n of piece.pad) lastRelease = Math.max(lastRelease, n.time + n.duration);
      lastRelease = Math.max(lastRelease, piece.pedal[piece.pedal.length - 1].time);
      expect(Math.abs(lastRelease - piece.durationSec)).toBeLessThan(1e-9);
      // Length follows the params: bars at the nominal tempo, plus rubato (never more than 5 % longer).
      const nominal = piece.bars * BEATS_PER_BAR * (60 / piece.params.tempo);
      expect(piece.durationSec).toBeGreaterThan(nominal);
      expect(piece.durationSec).toBeLessThan(nominal * 1.05 + 0.1);
    }
  });

  it('pad: always present, 2-3 soft chord tones per chord between C3 and C5, lowest note a root or fifth', () => {
    expect(PAD_LOW).toBe(48);
    expect(PAD_HIGH).toBe(72);
    const problems = new Problems();
    for (const piece of pieces) {
      const tag = `seed ${piece.params.seed}`;
      problems.check(piece.pad.length >= piece.chords.length * 2, () => `${tag}: only ${piece.pad.length} pad notes`);
      let cursor = 0;
      piece.chords.forEach((chord, i) => {
        // Pad notes are sorted by time, so the notes of a chord are consecutive.
        const notes = [];
        while (cursor < piece.pad.length && piece.pad[cursor].time === chord.startTime) notes.push(piece.pad[cursor++]);
        problems.check(notes.length === 2 || notes.length === 3, () => `${tag}: ${notes.length} pad notes on ${chord.name}`);
        if (notes.length === 0) return;
        const pitches = notes.map((n) => n.pitch);
        for (const n of notes) {
          problems.check(n.pitch >= PAD_LOW && n.pitch <= PAD_HIGH, () => `${tag}: pad pitch ${n.pitch} outside C3..C5`);
          problems.check(chord.pitchClasses.includes(n.pitch % 12), () => `${tag}: pad pitch ${n.pitch} not in ${chord.name}`);
          problems.check(piece.scale.includes(n.pitch % 12), () => `${tag}: pad pitch ${n.pitch} not in the scale`);
          problems.check(n.velocity >= 20 && n.velocity <= 50, () => `${tag}: pad velocity ${n.velocity}`);
          const end = n.time + n.duration;
          if (i < piece.chords.length - 1) {
            // Released a little before the next chord.
            problems.check(end < chord.endTime && chord.endTime - end < 0.05, () => `${tag}: pad note ends at ${end}`);
          } else {
            problems.check(Math.abs(end - piece.durationSec) < 1e-6, () => `${tag}: last pad note ends at ${end}`);
          }
        }
        // Sorted by pitch inside the chord, no doubled pitch, no clusters, a root or fifth at the bottom.
        for (let k = 1; k < pitches.length; k++) {
          problems.check(pitches[k] - pitches[k - 1] >= 3, () => `${tag}: pad pitches ${pitches.join(',')} too close`);
        }
        const lowest = (pitches[0] - chord.root + 120) % 12;
        problems.check(lowest === 0 || lowest === 7, () => `${tag}: lowest pad note of ${chord.name} is ${pitches[0]}`);
      });
      problems.check(cursor === piece.pad.length, () => `${tag}: pad notes that do not start with a chord`);
    }
    expect(problems.list).toEqual([]);
  });

  it('the pad moves little from chord to chord (voice leading)', () => {
    let moves = 0;
    let total = 0;
    for (const piece of pieces.slice(0, 120)) {
      const groups = piece.chords.map((c) => piece.pad.filter((n) => n.time === c.startTime).map((n) => n.pitch));
      for (let i = 1; i < groups.length; i++) {
        const centre = (g: number[]): number => g.reduce((a, b) => a + b, 0) / g.length;
        total += Math.abs(centre(groups[i]) - centre(groups[i - 1]));
        moves++;
      }
    }
    expect(total / moves).toBeLessThan(4);
  });
});
