import { describe, it, expect } from "vitest";
import {
  hasBothHands,
  uniqueOnsets,
  nextOnset,
  prevOnset,
  scoreTimeToSeek,
  seekToScoreTime,
  formatClock,
  controlsEnabledForScore,
  SEEK_RANGE,
} from "./playback";
import type { VisNote } from "./visualizer";
import type { Hand } from "./piano";
import { buildStaffClefTimeline, handFromClefInEffect } from "./piano";

const note = (time: number, midi = 60): VisNote => ({ midi, time, duration: 0.5 });
const handNote = (hand: Hand, midi = 60): VisNote => ({ midi, time: 0, duration: 0.5, hand });

describe("hasBothHands", () => {
  it("is true when both a right and a left note exist", () => {
    expect(hasBothHands([handNote("right"), handNote("left")])).toBe(true);
  });

  it("is false when only right-hand notes exist", () => {
    expect(hasBothHands([handNote("right"), handNote("right")])).toBe(false);
  });

  it("is false when only left-hand notes exist", () => {
    expect(hasBothHands([handNote("left"), handNote("left")])).toBe(false);
  });

  it("is false when all notes are unknown", () => {
    expect(hasBothHands([handNote("unknown"), handNote("unknown")])).toBe(false);
  });

  it("is false for an empty list", () => {
    expect(hasBothHands([])).toBe(false);
  });

  it("is false with a right-hand note plus only unknowns", () => {
    expect(hasBothHands([handNote("right"), handNote("unknown")])).toBe(false);
  });

  // Issue #87 acceptance: an OMR-collapsed single staff (treble then bass) must split into
  // both hands so the per-hand controls appear. This mirrors extractScore's single-staff
  // path (clef-in-effect per measure) end to end on the pure helpers it composes.
  it("a single staff that switches treble->bass tags BOTH hands -> hasBothHands true", () => {
    const timeline = buildStaffClefTimeline(
      [
        { staffId: 0, measureIndex: 0, clef: "treble" },
        { staffId: 0, measureIndex: 9, clef: "bass" },
      ],
      12,
    );
    const t = timeline.get(0)!;
    // Notes scattered before and after the switch, all on the one staff.
    const measureOf = [0, 3, 8, 9, 10, 11];
    const notes: VisNote[] = measureOf.map((m, i) => ({
      midi: 60 + i,
      time: i,
      duration: 0.5,
      hand: handFromClefInEffect(t[m]),
    }));
    expect(hasBothHands(notes)).toBe(true);
    expect(notes.filter((n) => n.hand === "right").length).toBeGreaterThan(0);
    expect(notes.filter((n) => n.hand === "left").length).toBeGreaterThan(0);
  });

  it("a stable single-staff treble part stays one hand -> hasBothHands false", () => {
    const timeline = buildStaffClefTimeline(
      [{ staffId: 0, measureIndex: 0, clef: "treble" }],
      4,
    );
    const t = timeline.get(0)!;
    const notes: VisNote[] = [0, 1, 2, 3].map((m, i) => ({
      midi: 60 + i,
      time: i,
      duration: 0.5,
      hand: handFromClefInEffect(t[m]),
    }));
    expect(hasBothHands(notes)).toBe(false);
  });
});

describe("uniqueOnsets", () => {
  it("returns sorted, de-duplicated onset times", () => {
    const notes = [note(2, 64), note(0, 60), note(2, 67), note(1, 62), note(0, 48)];
    expect(uniqueOnsets(notes)).toEqual([0, 1, 2]);
  });

  it("returns an empty array for no notes", () => {
    expect(uniqueOnsets([])).toEqual([]);
  });
});

describe("nextOnset", () => {
  const onsets = [0, 1, 2, 3];

  it("returns the first onset strictly after the current time", () => {
    expect(nextOnset(onsets, 1)).toBe(2);
  });

  it("skips the current onset when sitting exactly on it", () => {
    expect(nextOnset(onsets, 2)).toBe(3);
  });

  it("returns null at or after the last onset", () => {
    expect(nextOnset(onsets, 3)).toBeNull();
    expect(nextOnset(onsets, 5)).toBeNull();
  });

  it("returns the first onset from before the start", () => {
    expect(nextOnset(onsets, -1)).toBe(0);
  });
});

describe("prevOnset", () => {
  const onsets = [0, 1, 2, 3];

  it("returns the last onset strictly before the current time", () => {
    expect(prevOnset(onsets, 2.5)).toBe(2);
  });

  it("steps back past the current onset when sitting exactly on it", () => {
    expect(prevOnset(onsets, 2)).toBe(1);
  });

  it("returns null at or before the first onset", () => {
    expect(prevOnset(onsets, 0)).toBeNull();
    expect(prevOnset(onsets, -1)).toBeNull();
  });
});

describe("scoreTimeToSeek / seekToScoreTime", () => {
  it("maps the midpoint to half the range", () => {
    expect(scoreTimeToSeek(5, 10)).toBe(SEEK_RANGE / 2);
  });

  it("clamps out-of-range times", () => {
    expect(scoreTimeToSeek(-1, 10)).toBe(0);
    expect(scoreTimeToSeek(20, 10)).toBe(SEEK_RANGE);
  });

  it("returns 0 for a zero-duration score", () => {
    expect(scoreTimeToSeek(5, 0)).toBe(0);
  });

  it("round-trips a slider value back to seconds", () => {
    expect(seekToScoreTime(SEEK_RANGE / 2, 10)).toBeCloseTo(5);
    expect(seekToScoreTime(SEEK_RANGE, 10)).toBeCloseTo(10);
    expect(seekToScoreTime(0, 10)).toBe(0);
  });
});

describe("formatClock", () => {
  it("formats seconds as m:ss with zero-padding", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(5)).toBe("0:05");
    expect(formatClock(84)).toBe("1:24");
    expect(formatClock(605)).toBe("10:05");
  });

  it("floors fractional seconds", () => {
    expect(formatClock(59.9)).toBe("0:59");
  });

  it("clamps negative and non-finite values to 0:00", () => {
    expect(formatClock(-3)).toBe("0:00");
    expect(formatClock(NaN)).toBe("0:00");
  });
});

describe("controlsEnabledForScore", () => {
  it("enables play/export/transport when a score is loaded", () => {
    expect(controlsEnabledForScore(true)).toBe(true);
  });

  it("disables them when no score is loaded", () => {
    expect(controlsEnabledForScore(false)).toBe(false);
  });
});
