import { describe, it, expect } from "vitest";
import { fallingBarActive } from "./visualizer";

describe("fallingBarActive (issue #131)", () => {
  const note = (time: number, duration: number) => ({ time, duration });

  it("is active only inside the note's own half-open time window", () => {
    const n = note(2, 1); // sounds during [2, 3)
    expect(fallingBarActive(n, 1.99)).toBe(false); // before arrival
    expect(fallingBarActive(n, 2)).toBe(true); // onset (inclusive)
    expect(fallingBarActive(n, 2.5)).toBe(true); // sustaining
    expect(fallingBarActive(n, 3)).toBe(false); // release edge is exclusive
    expect(fallingBarActive(n, 3.01)).toBe(false); // after release
  });

  it("hands active to the onset note at a legato same-pitch seam (issue #131)", () => {
    // Back-to-back, no gap: note2 starts exactly when note1 ends. The inclusive-end bug
    // lit both for the seam frame; the half-open window gives it to the arriving note only.
    const first = note(0, 1); // [0, 1)
    const second = note(1, 1); // [1, 2)
    expect(fallingBarActive(first, 1)).toBe(false); // releasing twin goes dark
    expect(fallingBarActive(second, 1)).toBe(true); // arriving note lights
  });

  it("does not light two same-pitch notes in sequence at once", () => {
    // Same pitch, gap-separated: [0,1) then [2,3). The bug lit both via the pitch set.
    const first = note(0, 1);
    const second = note(2, 1);
    // While the first is sounding, the upcoming second stays inactive.
    expect(fallingBarActive(first, 0.5)).toBe(true);
    expect(fallingBarActive(second, 0.5)).toBe(false);
    // In the gap, neither is active.
    expect(fallingBarActive(first, 1.5)).toBe(false);
    expect(fallingBarActive(second, 1.5)).toBe(false);
    // When the second arrives, only it is active.
    expect(fallingBarActive(first, 2.5)).toBe(false);
    expect(fallingBarActive(second, 2.5)).toBe(true);
  });

  it("treats overlapping (true chord-like) windows independently per note", () => {
    // Distinct pitches that genuinely overlap are each active on their own window;
    // the helper is per-note, so simultaneous real chords still light correctly.
    const a = note(1, 2); // [1, 3)
    const b = note(1.5, 1); // [1.5, 2.5)
    expect(fallingBarActive(a, 2)).toBe(true);
    expect(fallingBarActive(b, 2)).toBe(true);
    expect(fallingBarActive(a, 2.8)).toBe(true);
    expect(fallingBarActive(b, 2.8)).toBe(false);
  });
});
