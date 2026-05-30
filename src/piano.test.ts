import { describe, it, expect } from "vitest";
import {
  FIRST_MIDI,
  LAST_MIDI,
  isBlackKey,
  buildKeyLayout,
  midiToName,
  midiToLabel,
  midiToBarLabel,
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

  it("restricts to a sub-range and tiles its white keys across the full width", () => {
    // C2..C7 (issue #33 narrow window): 36..96, endpoints inclusive and both C.
    const window = buildKeyLayout(WIDTH, 36, 96);
    expect(window[0].midi).toBe(36);
    expect(window[window.length - 1].midi).toBe(96);
    const whites = window.filter((k) => !k.black);
    const whiteWidth = WIDTH / whites.length;
    expect(whites[0].x).toBeCloseTo(0, 6);
    const last = whites[whites.length - 1];
    expect(last.x + last.width).toBeCloseTo(WIDTH, 6);
    expect(whites[0].width).toBeCloseTo(whiteWidth, 6);
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

describe("midiToLabel", () => {
  it("maps every pitch class to its letter (always sharp, never flat)", () => {
    const letters = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
    // C4..B4 covers all 12 pitch classes once.
    for (let pc = 0; pc < 12; pc++) {
      expect(midiToLabel(60 + pc, "letters")).toBe(letters[pc]);
    }
  });

  it("maps every pitch class to its fixed-Do solfege syllable (Si, not Ti)", () => {
    const solfege = [
      "Do", "Do#", "Re", "Re#", "Mi", "Fa", "Fa#", "Sol", "Sol#", "La", "La#", "Si",
    ];
    for (let pc = 0; pc < 12; pc++) {
      expect(midiToLabel(60 + pc, "solfege")).toBe(solfege[pc]);
    }
  });

  it("never carries an octave on the pitch-class label, in either mode", () => {
    expect(midiToLabel(21, "letters")).toBe("A"); // A0
    expect(midiToLabel(108, "letters")).toBe("C"); // C8
    expect(midiToLabel(60, "solfege")).toBe("Do");
    expect(midiToLabel(72, "solfege")).toBe("Do"); // one octave up, same syllable
  });

  it("is octave-invariant for the same pitch class", () => {
    for (let m = FIRST_MIDI; m <= LAST_MIDI - 12; m++) {
      expect(midiToLabel(m, "letters")).toBe(midiToLabel(m + 12, "letters"));
      expect(midiToLabel(m, "solfege")).toBe(midiToLabel(m + 12, "solfege"));
    }
  });

  it("returns an empty string in off mode", () => {
    expect(midiToLabel(60, "off")).toBe("");
    expect(midiToLabel(61, "off")).toBe("");
  });

  it("spells the boundary pitch classes correctly", () => {
    expect(midiToLabel(60, "letters")).toBe("C"); // pc 0
    expect(midiToLabel(71, "letters")).toBe("B"); // pc 11
    expect(midiToLabel(60, "solfege")).toBe("Do");
    expect(midiToLabel(71, "solfege")).toBe("Si");
  });
});

describe("midiToBarLabel", () => {
  it("appends the octave in letters mode using the midiToName convention", () => {
    expect(midiToBarLabel(60, "letters")).toBe("C4"); // middle C
    expect(midiToBarLabel(21, "letters")).toBe("A0");
    expect(midiToBarLabel(108, "letters")).toBe("C8");
    expect(midiToBarLabel(61, "letters")).toBe("C#4");
    expect(midiToBarLabel(70, "letters")).toBe("A#4");
  });

  it("matches midiToName for the letter-with-octave bar label", () => {
    for (let m = FIRST_MIDI; m <= LAST_MIDI; m++) {
      expect(midiToBarLabel(m, "letters")).toBe(midiToName(m));
    }
  });

  it("never appends an octave in solfege mode", () => {
    expect(midiToBarLabel(60, "solfege")).toBe("Do");
    expect(midiToBarLabel(61, "solfege")).toBe("Do#");
    expect(midiToBarLabel(72, "solfege")).toBe("Do");
    expect(midiToBarLabel(71, "solfege")).toBe("Si");
  });

  it("returns an empty string in off mode", () => {
    expect(midiToBarLabel(60, "off")).toBe("");
  });
});
