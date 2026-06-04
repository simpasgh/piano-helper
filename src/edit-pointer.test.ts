// Unit tests for the pitch-drag pointer gate (Smart Edit P1 review note): a drag must begin only
// for the primary LEFT mouse/pen button, so a right-click or a touch-scroll that starts on a note
// does not hijack into a drag (a plain primary click still selects, which is the caller's job).

import { describe, it, expect } from "vitest";
import { shouldStartPitchDrag } from "./edit-pointer";

const ev = (over: Partial<{ button: number; isPrimary: boolean; pointerType: string }> = {}) => ({
  button: 0,
  isPrimary: true,
  pointerType: "mouse",
  ...over,
});

describe("shouldStartPitchDrag", () => {
  it("starts a drag for the primary left mouse button", () => {
    expect(shouldStartPitchDrag(ev())).toBe(true);
  });

  it("starts a drag for a primary left PEN press too", () => {
    expect(shouldStartPitchDrag(ev({ pointerType: "pen" }))).toBe(true);
  });

  it("does NOT start a drag for a right-click (button 2)", () => {
    expect(shouldStartPitchDrag(ev({ button: 2 }))).toBe(false);
  });

  it("does NOT start a drag for a middle-click (button 1)", () => {
    expect(shouldStartPitchDrag(ev({ button: 1 }))).toBe(false);
  });

  it("does NOT start a drag for a touch (a touch-scroll must not hijack into a drag)", () => {
    // A first-finger touch has button 0 + isPrimary true, so only the pointerType gate stops it.
    expect(shouldStartPitchDrag(ev({ pointerType: "touch" }))).toBe(false);
  });

  it("does NOT start a drag for a secondary (non-primary) pointer", () => {
    expect(shouldStartPitchDrag(ev({ isPrimary: false }))).toBe(false);
  });
});
