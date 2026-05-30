import { describe, it, expect } from "vitest";
import { FIRST_MIDI, LAST_MIDI, pitchClass, pitchHue, noteColor } from "./piano";

describe("pitchHue", () => {
  it("anchors C / Do (pitch class 0) on the brand violet hue 276", () => {
    expect(pitchHue(60)).toBe(276); // middle C
    expect(pitchHue(0)).toBe(276);
    expect(pitchHue(108)).toBe(276); // C8
  });

  it("follows hue = (276 + pc * 30) mod 360 for the spec reference pitches", () => {
    // pc 3 (D#): 276 + 90 = 366 -> 6
    expect(pitchHue(63)).toBe(6);
    // pc 6 (F#): 276 + 180 = 456 -> 96
    expect(pitchHue(66)).toBe(96);
    // pc 11 (B): 276 + 330 = 606 -> 246
    expect(pitchHue(71)).toBe(246);
  });

  it("matches the full pitch-class hue table", () => {
    const table = [276, 306, 336, 6, 36, 66, 96, 126, 156, 186, 216, 246];
    for (let pc = 0; pc < 12; pc++) {
      expect(pitchHue(60 + pc)).toBe(table[pc]);
    }
  });

  it("wraps mod 360 (every hue stays in [0, 360))", () => {
    for (let m = FIRST_MIDI; m <= LAST_MIDI; m++) {
      const h = pitchHue(m);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(360);
    }
  });

  it("depends only on pitch class: octaves share a hue", () => {
    expect(pitchHue(60)).toBe(pitchHue(72)); // C4 and C5
    for (let m = FIRST_MIDI; m <= LAST_MIDI - 12; m++) {
      expect(pitchHue(m)).toBe(pitchHue(m + 12));
    }
  });

  it("handles negative midi via the pitch-class normalization", () => {
    expect(pitchClass(-1)).toBe(11);
    expect(pitchHue(-1)).toBe(246); // same as B
  });
});

describe("noteColor", () => {
  it("builds the spec hsl strings for C / Do (hue 276)", () => {
    const c = noteColor(60);
    expect(c.hue).toBe(276);
    expect(c.whiteFill).toBe("hsl(276, 85%, 62%)");
    expect(c.blackFill).toBe("hsl(276, 70%, 50%)");
    expect(c.glow).toBe("hsl(276, 90%, 68%)");
    expect(c.activeFill).toBe("hsl(276, 95%, 72%)");
    expect(c.activeWhiteKey).toBe("hsl(276, 85%, 66%)");
    expect(c.activeBlackKey).toBe("hsl(276, 80%, 60%)");
  });

  it("returns the same precomputed object for the same pitch class (cached table)", () => {
    expect(noteColor(60)).toBe(noteColor(72)); // identity, not just equality
  });
});
