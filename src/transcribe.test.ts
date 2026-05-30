import { describe, it, expect } from "vitest";
import { noteEventsToVisNotes } from "./transcribe";
import type { NoteEventTime } from "@spotify/basic-pitch";

function event(
  pitchMidi: number,
  startTimeSeconds: number,
  durationSeconds: number,
): NoteEventTime {
  return { pitchMidi, startTimeSeconds, durationSeconds, amplitude: 0.5 };
}

describe("noteEventsToVisNotes", () => {
  it("maps pitch/time/duration into the VisNote shape", () => {
    const out = noteEventsToVisNotes([event(60, 1.5, 0.5)]);
    expect(out).toEqual([{ midi: 60, time: 1.5, duration: 0.5 }]);
  });

  it("rounds fractional MIDI pitches to the nearest key", () => {
    const out = noteEventsToVisNotes([event(60.4, 0, 1), event(67.6, 0, 1)]);
    expect(out.map((n) => n.midi)).toEqual([60, 68]);
  });

  it("sorts notes by start time", () => {
    const out = noteEventsToVisNotes([
      event(64, 2, 0.5),
      event(60, 0, 0.5),
      event(62, 1, 0.5),
    ]);
    expect(out.map((n) => n.time)).toEqual([0, 1, 2]);
  });

  it("drops pitches outside the 88-key range", () => {
    const out = noteEventsToVisNotes([
      event(20, 0, 1), // below A0 (21)
      event(60, 0, 1),
      event(109, 0, 1), // above C8 (108)
    ]);
    expect(out.map((n) => n.midi)).toEqual([60]);
  });

  it("drops notes with non-positive duration", () => {
    const out = noteEventsToVisNotes([
      event(60, 0, 0),
      event(62, 0, -0.2),
      event(64, 0, 0.3),
    ]);
    expect(out.map((n) => n.midi)).toEqual([64]);
  });

  it("clamps negative start times to zero", () => {
    const out = noteEventsToVisNotes([event(60, -0.05, 0.4)]);
    expect(out[0].time).toBe(0);
  });

  it("returns an empty array for no events", () => {
    expect(noteEventsToVisNotes([])).toEqual([]);
  });
});
