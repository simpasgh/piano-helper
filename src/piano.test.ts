import { describe, it, expect } from "vitest";
import {
  FIRST_MIDI,
  LAST_MIDI,
  isBlackKey,
  buildKeyLayout,
  midiToName,
} from "./piano";

describe("isBlackKey", () => {
  it("flags the five accidentals in an octave", () => {
    // Black pitch classes are C#, D#, F#, G#, A# (1,3,6,8,10).
    const black = [22, 25, 27, 30, 32]; // A#0 C#1 D#1 F#1 G#1
    for (const m of black) expect(isBlackKey(m)).toBe(true);
  });

  it("treats naturals as white keys", () => {
    const whites = [21, 23, 24, 60, 62, 64, 65, 67, 69, 71]; // includes middle C (60)
    for (const m of whites) expect(isBlackKey(m)).toBe(false);
  });

  it("is periodic across octaves", () => {
    for (let m = FIRST_MIDI; m <= LAST_MIDI - 12; m++) {
      expect(isBlackKey(m)).toBe(isBlackKey(m + 12));
    }
  });
});

describe("buildKeyLayout", () => {
  const WIDTH = 880;
  const layout = buildKeyLayout(WIDTH);

  it("produces one geometry per key from A0 to C8 (88 keys)", () => {
    expect(layout).toHaveLength(LAST_MIDI - FIRST_MIDI + 1);
    expect(layout).toHaveLength(88);
    expect(layout[0].midi).toBe(FIRST_MIDI);
    expect(layout[layout.length - 1].midi).toBe(LAST_MIDI);
  });

  it("has 52 white keys that tile the full width with no gaps", () => {
    const whites = layout.filter((k) => !k.black);
    expect(whites).toHaveLength(52);
    const whiteWidth = WIDTH / 52;
    // White keys are laid left to right, edge to edge.
    whites.forEach((k, i) => {
      expect(k.x).toBeCloseTo(i * whiteWidth, 6);
      expect(k.width).toBeCloseTo(whiteWidth, 6);
    });
    const last = whites[whites.length - 1];
    expect(last.x + last.width).toBeCloseTo(WIDTH, 6);
  });

  it("makes black keys narrower than white keys and centers them on a boundary", () => {
    const whiteWidth = WIDTH / 52;
    const blackWidth = whiteWidth * 0.62;
    for (const k of layout.filter((k) => k.black)) {
      expect(k.width).toBeCloseTo(blackWidth, 6);
      // Center sits on a boundary between two whites: an integer multiple of whiteWidth.
      const ratio = (k.x + k.width / 2) / whiteWidth;
      expect(Math.abs(ratio - Math.round(ratio))).toBeCloseTo(0, 6);
    }
  });
});

describe("midiToName", () => {
  it("names reference pitches correctly", () => {
    expect(midiToName(21)).toBe("A0");
    expect(midiToName(60)).toBe("C4"); // middle C
    expect(midiToName(69)).toBe("A4"); // A440
    expect(midiToName(108)).toBe("C8");
  });

  it("uses sharps for accidentals", () => {
    expect(midiToName(61)).toBe("C#4");
    expect(midiToName(70)).toBe("A#4");
  });
});
