import { describe, it, expect } from "vitest";
import { nudgePitch, deleteNote, recomputeDuration, hasEdits } from "./note-edit";
import type { VisNote } from "./visualizer";

const note = (over: Partial<VisNote> = {}): VisNote => ({
  midi: 60,
  time: 0,
  duration: 1,
  hand: "right",
  ...over,
});

describe("nudgePitch (issue #6)", () => {
  it("shifts the pitch by delta and marks the note edited", () => {
    const notes = [note({ midi: 60 })];
    const up = nudgePitch(notes, 0, 1);
    expect(up[0].midi).toBe(61);
    expect(up[0].edited).toBe(true);
    const down = nudgePitch(notes, 0, -1);
    expect(down[0].midi).toBe(59);
    expect(down[0].edited).toBe(true);
  });

  it("clears the printed spelling so the honest MIDI-sharp name shows after a manual nudge", () => {
    const notes = [note({ midi: 61, spelling: { letter: "D", alter: -1 } })]; // a "Db"
    const out = nudgePitch(notes, 0, 1);
    expect(out[0].spelling).toBeUndefined();
  });

  it("clamps at the bottom of the keyboard (MIDI 21, A0)", () => {
    const notes = [note({ midi: 21 })];
    const out = nudgePitch(notes, 0, -1);
    expect(out[0].midi).toBe(21); // pinned, not 20
    expect(out[0].edited).toBe(true);
  });

  it("clamps at the top of the keyboard (MIDI 108, C8)", () => {
    const notes = [note({ midi: 108 })];
    const out = nudgePitch(notes, 0, 1);
    expect(out[0].midi).toBe(108); // pinned, not 109
  });

  it("is immutable: it returns a new array and new note, leaving the input untouched", () => {
    const original = note({ midi: 60, spelling: { letter: "C", alter: 0 } });
    const notes = [original];
    const out = nudgePitch(notes, 0, 1);
    expect(out).not.toBe(notes);
    expect(out[0]).not.toBe(original);
    // Input object and array are unchanged.
    expect(original.midi).toBe(60);
    expect(original.edited).toBeUndefined();
    expect(original.spelling).toEqual({ letter: "C", alter: 0 });
    expect(notes[0]).toBe(original);
  });

  it("leaves other notes referenced unchanged (shares the untouched objects)", () => {
    const a = note({ midi: 60 });
    const b = note({ midi: 64 });
    const out = nudgePitch([a, b], 0, 1);
    expect(out[1]).toBe(b); // untouched note is the same object reference
  });

  it("is a no-op shallow copy for an out-of-range index", () => {
    const notes = [note()];
    const out = nudgePitch(notes, 5, 1);
    expect(out).not.toBe(notes);
    expect(out).toEqual(notes);
  });
});

describe("deleteNote (issue #6)", () => {
  it("removes the note at the index, returning a new shorter array", () => {
    const a = note({ midi: 60 });
    const b = note({ midi: 64 });
    const c = note({ midi: 67 });
    const out = deleteNote([a, b, c], 1);
    expect(out).toEqual([a, c]);
    expect(out).not.toBe([a, c]);
  });

  it("is immutable: input array and its notes are untouched", () => {
    const a = note({ midi: 60 });
    const b = note({ midi: 64 });
    const notes = [a, b];
    const out = deleteNote(notes, 0);
    expect(notes).toEqual([a, b]); // input unchanged
    expect(out[0]).toBe(b); // surviving note shared by reference
  });

  it("returns a shallow copy unchanged for an out-of-range index", () => {
    const notes = [note()];
    const out = deleteNote(notes, 9);
    expect(out).not.toBe(notes);
    expect(out).toEqual(notes);
  });
});

describe("recomputeDuration (issue #6)", () => {
  it("returns the latest note end", () => {
    const notes = [note({ time: 0, duration: 1 }), note({ time: 2, duration: 1.5 })];
    expect(recomputeDuration(notes)).toBe(3.5);
  });

  it("shrinks after a delete removes the last note", () => {
    const notes = [note({ time: 0, duration: 1 }), note({ time: 4, duration: 2 })];
    expect(recomputeDuration(notes)).toBe(6);
    const out = deleteNote(notes, 1);
    expect(recomputeDuration(out)).toBe(1);
  });

  it("is unchanged by a pitch nudge (a nudge never moves time/duration)", () => {
    const notes = [note({ time: 0, duration: 1 }), note({ time: 1, duration: 1 })];
    const before = recomputeDuration(notes);
    const out = nudgePitch(notes, 0, 1);
    expect(recomputeDuration(out)).toBe(before);
  });

  it("is 0 for an empty score", () => {
    expect(recomputeDuration([])).toBe(0);
  });
});

describe("hasEdits (issue #6)", () => {
  it("is false on a freshly loaded score and true once a note is nudged", () => {
    const notes = [note(), note()];
    expect(hasEdits(notes)).toBe(false);
    expect(hasEdits(nudgePitch(notes, 0, 1))).toBe(true);
  });
});
