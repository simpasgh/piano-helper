import { describe, it, expect } from "vitest";
import { recomputeDuration } from "./note-edit";
import type { VisNote } from "./visualizer";

const note = (over: Partial<VisNote> = {}): VisNote => ({
  midi: 60,
  time: 0,
  duration: 1,
  hand: "right",
  ...over,
});

// recomputeDuration is the score-duration helper used by the in-place reload after an edit
// (see reloadNotes in main.ts). Pitch editing routes through the notation model; see
// edit-model.test.ts / edit-commands.test.ts.
describe("recomputeDuration", () => {
  it("returns the latest note end", () => {
    const notes = [note({ time: 0, duration: 1 }), note({ time: 2, duration: 1.5 })];
    expect(recomputeDuration(notes)).toBe(3.5);
  });

  it("takes the max end, not document order (a later note may end earlier)", () => {
    const notes = [note({ time: 4, duration: 2 }), note({ time: 0, duration: 1 })];
    expect(recomputeDuration(notes)).toBe(6);
  });

  it("is 0 for an empty score", () => {
    expect(recomputeDuration([])).toBe(0);
  });
});
