import { describe, it, expect } from "vitest";
import { fallingBarActive, barRect, hitTestBars, type BarLayout } from "./visualizer";
import { buildKeyLayout, type KeyGeometry } from "./piano";

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

describe("barRect / hitTestBars (issue #6 correction UI)", () => {
  // A full-width 88-key layout at 880px so each white key is a round 10px-ish column, with the
  // keybed near the bottom and a 5s look-ahead. keyboardTop=400, pps=80, so a bar's bottom at
  // currentTime == its time sits exactly at the keybed.
  const KEYS: KeyGeometry[] = buildKeyLayout(880);
  const layout: BarLayout = {
    keyByMidi: new Map(KEYS.map((k) => [k.midi, k])),
    firstVisibleMidi: 21,
    lastVisibleMidi: 108,
    keyboardTop: 400,
    pps: 80,
    lookAhead: 5,
  };
  const eb = (k: KeyGeometry) => k; // expose a key for centroid math
  const keyOf = (midi: number) => eb(KEYS.find((k) => k.midi === midi)!);

  // A note whose bar's bottom edge is exactly at the keybed when currentTime === note.time.
  const noteAt = (midi: number, time: number, duration = 1) => ({ midi, time, duration });

  it("returns a rect matching the renderer geometry for an on-screen bar", () => {
    const n = noteAt(60, 0, 1); // at t=0 the bar bottom == keyboardTop (400)
    const r = barRect(n, 0, layout)!;
    expect(r).not.toBeNull();
    // bottom = keyboardTop - delta*pps = 400; height = duration*pps = 80; top = 320.
    expect(r.top).toBeCloseTo(320, 5);
    expect(r.height).toBeCloseTo(80, 5);
    expect(r.clamped).toBe(false);
  });

  it("hit-test inside a bar returns that note's index", () => {
    const notes = [noteAt(60, 0, 1)];
    const k = keyOf(60);
    const r = barRect(notes[0], 0, layout)!;
    const cx = r.x + r.width / 2;
    const cy = r.top + r.height / 2;
    expect(hitTestBars(notes, cx, cy, 0, layout)).toBe(0);
    // Just outside the key column horizontally -> miss.
    expect(hitTestBars(notes, k.x - 5, cy, 0, layout)).toBeNull();
  });

  it("returns null for a click off any bar", () => {
    const notes = [noteAt(60, 0, 1)];
    expect(hitTestBars(notes, 1, 1, 0, layout)).toBeNull(); // top-left corner, no bar there
  });

  it("topmost (last-drawn) bar wins on overlap", () => {
    // Two notes on the SAME key/time so their rects coincide; the later index is drawn on top
    // and must win the hit-test (we scan from the end).
    const notes = [noteAt(60, 0, 1), noteAt(60, 0, 1)];
    const r = barRect(notes[0], 0, layout)!;
    const cx = r.x + r.width / 2;
    const cy = r.top + r.height / 2;
    expect(hitTestBars(notes, cx, cy, 0, layout)).toBe(1);
  });

  it("respects currentTime: the same bar moves down the screen as time advances", () => {
    const n = noteAt(60, 2, 1); // arrives at t=2
    // At t=0 the bar is high (delta=2 -> bottom = 400 - 160 = 240, top = 160).
    const early = barRect(n, 0, layout)!;
    // At t=2 the bar has reached the keybed (bottom = 400, top = 320).
    const late = barRect(n, 2, layout)!;
    expect(late.top).toBeGreaterThan(early.top);
    // A click at the early top position hits at t=0 but misses at t=2 (the bar moved away).
    const cx = early.x + early.width / 2;
    const cy = early.top + early.height / 2;
    expect(hitTestBars([n], cx, cy, 0, layout)).toBe(0);
    expect(hitTestBars([n], cx, cy, 2, layout)).toBeNull();
  });

  it("returns null for a bar outside the look-ahead window (off-screen)", () => {
    const n = noteAt(60, 10, 1); // 10s away, look-ahead is 5s
    expect(barRect(n, 0, layout)).toBeNull();
  });

  it("flags a clamped off-window bar and the hit-test skips it (not selectable)", () => {
    // MIDI 12 is below firstVisibleMidi (21); it clamps to the edge column.
    const n = noteAt(12, 0, 1);
    const r = barRect(n, 0, layout)!;
    expect(r.clamped).toBe(true);
    const cx = r.x + r.width / 2;
    const cy = r.top + r.height / 2;
    expect(hitTestBars([n], cx, cy, 0, layout)).toBeNull();
  });
});
