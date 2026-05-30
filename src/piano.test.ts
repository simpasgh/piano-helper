import { describe, it, expect } from "vitest";
import {
  FIRST_MIDI,
  LAST_MIDI,
  isBlackKey,
  buildKeyLayout,
  midiToName,
  midiToLabel,
  midiToBarLabel,
  handFromStaffIndex,
  handFromClef,
  handFromPitch,
  HAND_SPLIT_MIDI,
  isHandMuted,
  noteBarWidth,
  fitBarLabel,
  barGlyphIsDark,
  labelableFallingNotes,
  approachingKeyMidis,
  KEY_LABEL_LOOK_AHEAD,
  MIN_LABEL_PX,
  MIN_OVERFLOW_PX,
  MAX_LABEL_PX,
  LABEL_CHAR_WIDTH_RATIO,
  LABEL_GUTTER,
  type LabelNote,
} from "./piano";

// MIDI helpers for the glyph-ink tests: pitch class 0 = C (=> Do), 60 = C4.
const C4 = 60; // Do, violet (dark bar -> light glyph)
const E4 = 64; // Mi, orange (light bar -> dark glyph)
const F4 = 65; // Fa, yellow-green (light bar -> dark glyph)
const G4 = 67; // Sol, green (light bar -> dark glyph)
const A4 = 69; // La, cyan (light bar -> dark glyph)
const B4 = 71; // Si, blue (dark bar -> light glyph)

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

describe("handFromStaffIndex", () => {
  it("returns unknown for a single-staff part (cannot split hands)", () => {
    expect(handFromStaffIndex(0, 1)).toBe("unknown");
    expect(handFromStaffIndex(0, 0)).toBe("unknown");
  });

  it("returns unknown for a negative index (defensive guard)", () => {
    expect(handFromStaffIndex(-1, 2)).toBe("unknown");
  });

  it("maps a two-staff grand staff: index 0 is right, index 1 is left", () => {
    expect(handFromStaffIndex(0, 2)).toBe("right");
    expect(handFromStaffIndex(1, 2)).toBe("left");
  });

  it("treats any non-first staff as the left hand", () => {
    // A 3-staff organ part still maps index 0 to right and everything below to left.
    expect(handFromStaffIndex(0, 3)).toBe("right");
    expect(handFromStaffIndex(2, 3)).toBe("left");
  });
});

describe("handFromClef (clef is the primary hand signal, robust to staff order)", () => {
  it("maps treble clef to the right hand and bass clef to the left hand", () => {
    expect(handFromClef("treble")).toBe("right");
    expect(handFromClef("bass")).toBe("left");
  });

  it("returns null for clefs with no hand convention so the caller can fall back", () => {
    expect(handFromClef("other")).toBeNull();
  });
});

describe("handFromPitch (issue #70: split audio-derived scores by pitch)", () => {
  it("splits at middle C: the boundary and above are the right hand", () => {
    expect(HAND_SPLIT_MIDI).toBe(60);
    expect(handFromPitch(60)).toBe("right"); // middle C is the boundary
    expect(handFromPitch(72)).toBe("right");
    expect(handFromPitch(LAST_MIDI)).toBe("right");
  });

  it("maps everything below middle C to the left hand", () => {
    expect(handFromPitch(59)).toBe("left");
    expect(handFromPitch(48)).toBe("left");
    expect(handFromPitch(FIRST_MIDI)).toBe("left");
  });

  it("never returns 'unknown' so the per-hand controls become reachable", () => {
    for (let m = FIRST_MIDI; m <= LAST_MIDI; m++) {
      expect(handFromPitch(m)).not.toBe("unknown");
    }
  });
});

describe("isHandMuted (issue #54: ghost a muted hand's notes)", () => {
  it("is false when neither hand is muted", () => {
    const m = { left: false, right: false };
    expect(isHandMuted("left", m)).toBe(false);
    expect(isHandMuted("right", m)).toBe(false);
  });

  it("mutes only the matching hand", () => {
    expect(isHandMuted("right", { left: false, right: true })).toBe(true);
    expect(isHandMuted("left", { left: false, right: true })).toBe(false);
    expect(isHandMuted("left", { left: true, right: false })).toBe(true);
    expect(isHandMuted("right", { left: true, right: false })).toBe(false);
  });

  it("never mutes unknown or absent hands, even when both hands are muted", () => {
    const both = { left: true, right: true };
    expect(isHandMuted("unknown", both)).toBe(false);
    expect(isHandMuted(undefined, both)).toBe(false);
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

describe("noteBarWidth", () => {
  it("insets a white-note bar to 82% of its key so a gutter frames the lane", () => {
    expect(noteBarWidth(20, false)).toBeCloseTo(16.4);
  });

  it("lets a black-note bar fill its (already narrow) key width", () => {
    expect(noteBarWidth(12, true)).toBe(12);
  });

  it("never exceeds the key width, so a centered contact highlight cannot stick out past the note (issue #38)", () => {
    for (const keyWidth of [8, 13, 20, 33]) {
      for (const black of [false, true]) {
        const w = noteBarWidth(keyWidth, black);
        expect(w).toBeGreaterThan(0);
        expect(w).toBeLessThanOrEqual(keyWidth);
        // A highlight of width `w` centered in the key has equal gutter on both
        // sides, so it is contained within the key and never wider than the note.
        const gutter = (keyWidth - w) / 2;
        expect(gutter).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe("fitBarLabel (issue #39: name must fit the bar)", () => {
  // Helper: the px width the helper assumes a name of `chars` occupies at `size`.
  const estWidth = (chars: number, size: number) =>
    chars * size * LABEL_CHAR_WIDTH_RATIO + 2 * LABEL_GUTTER;

  it("labels a normal bar at a capped, legible size", () => {
    // A tall, wide bar (a held note) gets the max size, never larger than the old look.
    const fit = fitBarLabel(40, 60, 2); // "Re"
    expect(fit.show).toBe(true);
    expect(fit.fontSize).toBe(MAX_LABEL_PX);
  });

  it("never grows the font past the MAX ceiling on a huge bar", () => {
    const fit = fitBarLabel(200, 400, 1);
    expect(fit.fontSize).toBe(MAX_LABEL_PX);
  });

  it("scales the font down to a short bar's height instead of overflowing", () => {
    // A brief note ~18px tall: height ratio 0.55 -> ~9px, still >= MIN, so it shows small.
    const fit = fitBarLabel(40, 18, 2);
    expect(fit.show).toBe(true);
    expect(fit.fontSize).toBeLessThan(MAX_LABEL_PX);
    expect(fit.fontSize).toBeGreaterThanOrEqual(MIN_LABEL_PX);
  });

  it("omits the label on a very short (staccato) bar that cannot seat a legible glyph", () => {
    // A ~6px bar: 6 * 0.55 = 3.3 -> floor 3 < MIN_LABEL_PX (8) -> omitted.
    const fit = fitBarLabel(40, 6, 2);
    expect(fit.show).toBe(false);
  });

  it("shrinks to fit a narrow black-key bar instead of spilling sideways", () => {
    // Narrow bar (13px wide, the #33 small-screen black-key case), tall enough in height.
    const fit = fitBarLabel(13, 60, 2);
    if (fit.show) {
      // Whatever size it chose, the estimated name width must fit within the bar width.
      expect(estWidth(2, fit.fontSize)).toBeLessThanOrEqual(13);
    }
    // And it never claims to show below the legibility floor.
    if (fit.show) expect(fit.fontSize).toBeGreaterThanOrEqual(MIN_LABEL_PX);
  });

  it("omits when even a single MIN-size glyph cannot fit the bar width", () => {
    // A sliver 6px wide cannot hold a MIN_LABEL_PX glyph + gutters -> omit.
    const fit = fitBarLabel(6, 60, 1);
    expect(fit.show).toBe(false);
  });

  it("handles a long letters+octave name (e.g. Sol#4 / C#4) without overflowing", () => {
    // 4 chars on a moderately wide, tall bar: shows, and the fitted width stays in bounds.
    const width = 50;
    const fit = fitBarLabel(width, 60, 4);
    expect(fit.show).toBe(true);
    expect(estWidth(4, fit.fontSize)).toBeLessThanOrEqual(width);
  });

  it("treats an empty name as nothing to show", () => {
    expect(fitBarLabel(40, 60, 0).show).toBe(false);
  });

  it("never returns a shown label whose name exceeds the bar bounds (fuzz over a chord)", () => {
    // Sweep plausible bar sizes and name lengths; any shown label must fit width.
    for (let w = 6; w <= 60; w += 2) {
      for (let h = 4; h <= 80; h += 4) {
        for (let chars = 1; chars <= 4; chars++) {
          const fit = fitBarLabel(w, h, chars);
          if (fit.show) {
            expect(fit.fontSize).toBeGreaterThanOrEqual(MIN_LABEL_PX);
            expect(fit.fontSize).toBeLessThanOrEqual(MAX_LABEL_PX);
            expect(estWidth(chars, fit.fontSize)).toBeLessThanOrEqual(w + 1e-9);
          }
        }
      }
    }
  });
});

describe("fitBarLabel overflow (issue #67: narrow desktop bars keep their name)", () => {
  const estWidth = (chars: number, size: number) =>
    chars * size * LABEL_CHAR_WIDTH_RATIO + 2 * LABEL_GUTTER;

  it("omits a 2-char name on a ~10px desktop white-key bar WITHOUT overflow", () => {
    // Reproduces the bug: in-bounds fit drops the name because it cannot fit 10px.
    expect(fitBarLabel(10, 60, 2, false).show).toBe(false);
  });

  it("shows that same name WITH overflow, gated by the lower floor", () => {
    const fit = fitBarLabel(10, 60, 2, true);
    expect(fit.show).toBe(true);
    expect(fit.fontSize).toBeGreaterThanOrEqual(MIN_OVERFLOW_PX);
  });

  it("still omits when the bar is too SHORT to seat a legible glyph, even with overflow", () => {
    // Height, not width, is the binding floor: a ~12px bar -> floor(12*0.55)=6 < 7 -> omit.
    expect(fitBarLabel(10, 12, 2, true).show).toBe(false);
  });

  it("never lets the font exceed the height-derived size (no vertical overflow)", () => {
    // Overflow only relaxes WIDTH; the font is still bound by bar height.
    const h = 18;
    const fit = fitBarLabel(10, h, 2, true);
    if (fit.show) {
      expect(fit.fontSize).toBeLessThanOrEqual(Math.floor(h * 0.55));
    }
  });

  it("keeps the overflow within the allowed sideways budget (fuzz)", () => {
    // Any shown overflow label must fit bar width plus 0.9 each side.
    for (let w = 8; w <= 40; w += 2) {
      for (let h = 14; h <= 80; h += 4) {
        for (let chars = 1; chars <= 4; chars++) {
          const fit = fitBarLabel(w, h, chars, true);
          if (fit.show) {
            expect(fit.fontSize).toBeGreaterThanOrEqual(MIN_OVERFLOW_PX);
            expect(estWidth(chars, fit.fontSize)).toBeLessThanOrEqual(w * (1 + 2 * 0.9) + 1e-9);
          }
        }
      }
    }
  });
});

describe("barGlyphIsDark (issue #67: contrast-aware label ink)", () => {
  it("uses DARK ink on the light (yellow/green/cyan) hues", () => {
    for (const midi of [E4, F4, G4, A4]) {
      expect(barGlyphIsDark(midi, { active: false, black: false })).toBe(true);
    }
  });

  it("uses LIGHT ink on the dark (violet/blue) hues", () => {
    for (const midi of [C4, B4]) {
      expect(barGlyphIsDark(midi, { active: false, black: false })).toBe(false);
    }
  });

  it("never makes a bar LESS likely to take dark ink when it brightens (active fill)", () => {
    // activeFill is lighter than whiteFill, so an active bar's glyph is dark whenever the
    // resting bar's was, and may additionally flip to dark on borderline hues. Monotonic.
    for (const midi of [C4, E4, F4, G4, A4, B4]) {
      const resting = barGlyphIsDark(midi, { active: false, black: false });
      const sounding = barGlyphIsDark(midi, { active: true, black: false });
      if (resting) expect(sounding).toBe(true);
    }
  });

  it("treats octaves of one pitch class identically (hue depends only on pitch class)", () => {
    expect(barGlyphIsDark(F4, { active: false, black: false })).toBe(
      barGlyphIsDark(F4 + 12, { active: false, black: false }),
    );
  });
});

// Helper: build a LabelNote with sane defaults so each test only states what matters.
function ln(partial: Partial<LabelNote> & { midi: number; time: number }): LabelNote {
  return { duration: 0.5, ...partial };
}

describe("labelableFallingNotes (issue #42: one label per repeated run, both hands)", () => {
  it("labels the first of a repeated same-pitch run and skips the repeats", () => {
    // Do Do Do (same pitch, same hand) -> only the first is labeled.
    const notes = [
      ln({ midi: 60, time: 0, hand: "right" }),
      ln({ midi: 60, time: 1, hand: "right" }),
      ln({ midi: 60, time: 2, hand: "right" }),
    ];
    expect(labelableFallingNotes(notes)).toEqual([true, false, false]);
  });

  it("re-labels when the pitch changes, then again on a new run", () => {
    // Do Do Re Re Do -> label at each pitch change (run start).
    const notes = [
      ln({ midi: 60, time: 0, hand: "right" }),
      ln({ midi: 60, time: 1, hand: "right" }),
      ln({ midi: 62, time: 2, hand: "right" }),
      ln({ midi: 62, time: 3, hand: "right" }),
      ln({ midi: 60, time: 4, hand: "right" }),
    ];
    expect(labelableFallingNotes(notes)).toEqual([true, false, true, false, true]);
  });

  it("applies the SAME rule to both hands: each is labeled identically (issue #42 bug)", () => {
    // A repeated run in the LEFT hand and an identical repeated run in the RIGHT hand
    // must produce the same label pattern; the old code dropped right-hand repeats only
    // as an accident of bar height, which this fixes.
    const left = [
      ln({ midi: 48, time: 0, hand: "left" }),
      ln({ midi: 48, time: 1, hand: "left" }),
      ln({ midi: 50, time: 2, hand: "left" }),
    ];
    const right = [
      ln({ midi: 72, time: 0, hand: "right" }),
      ln({ midi: 72, time: 1, hand: "right" }),
      ln({ midi: 74, time: 2, hand: "right" }),
    ];
    expect(labelableFallingNotes(left)).toEqual([true, false, true]);
    expect(labelableFallingNotes(right)).toEqual([true, false, true]);
  });

  it("dedupes each hand independently so one hand never suppresses the other", () => {
    // Right C repeats while left C also repeats, interleaved in time. Each lane keeps its
    // own run, so the right C and the left C are each labeled on their first occurrence
    // even though they share a pitch.
    const notes = [
      ln({ midi: 60, time: 0, hand: "right" }),
      ln({ midi: 60, time: 0, hand: "left" }),
      ln({ midi: 60, time: 1, hand: "right" }),
      ln({ midi: 60, time: 1, hand: "left" }),
    ];
    expect(labelableFallingNotes(notes)).toEqual([true, true, false, false]);
  });

  it("decides by playback time, not array order, and maps back to input indices", () => {
    // Same pitch, but the array is out of time order. The earliest-by-time note is the
    // run start; the result stays index-aligned to the input array.
    const notes = [
      ln({ midi: 60, time: 2, hand: "right" }), // index 0, latest
      ln({ midi: 60, time: 0, hand: "right" }), // index 1, earliest -> run start
      ln({ midi: 60, time: 1, hand: "right" }), // index 2, middle
    ];
    expect(labelableFallingNotes(notes)).toEqual([false, true, false]);
  });

  it("treats absent hand as a single 'unknown' lane (single-staff / audio scores)", () => {
    const notes = [
      ln({ midi: 64, time: 0 }),
      ln({ midi: 64, time: 1 }),
      ln({ midi: 65, time: 2 }),
    ];
    expect(labelableFallingNotes(notes)).toEqual([true, false, true]);
  });

  it("handles an empty score", () => {
    expect(labelableFallingNotes([])).toEqual([]);
  });
});

describe("approachingKeyMidis (issue #43: only label keys with an approaching note)", () => {
  it("labels nothing when no note is within the look-ahead window", () => {
    // Note starts at t=10, window is 4s, current time 0 -> not yet approaching.
    const notes = [ln({ midi: 60, time: 10, duration: 1 })];
    expect(approachingKeyMidis(notes, 0).size).toBe(0);
  });

  it("includes a key once its note enters the look-ahead window", () => {
    const notes = [ln({ midi: 60, time: 4, duration: 1 })];
    // At t=0 the note's start (4) is exactly one window away -> in window.
    expect([...approachingKeyMidis(notes, 0)]).toEqual([60]);
    // Just before the window opens (note at t=5, t=0) -> not yet.
    expect(approachingKeyMidis([ln({ midi: 60, time: 5, duration: 1 })], 0).size).toBe(0);
  });

  it("keeps a currently-sounding note's key labeled until it finishes", () => {
    const notes = [ln({ midi: 60, time: 0, duration: 2 })];
    expect([...approachingKeyMidis(notes, 1)]).toEqual([60]); // mid-note
    expect(approachingKeyMidis(notes, 2.5).size).toBe(0); // after release
  });

  it("labels every pitch of an approaching chord (readable chords)", () => {
    const notes = [
      ln({ midi: 60, time: 1, duration: 1 }),
      ln({ midi: 64, time: 1, duration: 1 }),
      ln({ midi: 67, time: 1, duration: 1 }),
    ];
    expect([...approachingKeyMidis(notes, 0)].sort((a, b) => a - b)).toEqual([60, 64, 67]);
  });

  it("respects a custom look-ahead window", () => {
    const notes = [ln({ midi: 60, time: 3, duration: 1 })];
    expect(approachingKeyMidis(notes, 0, 2).size).toBe(0); // 3 > 0 + 2
    expect([...approachingKeyMidis(notes, 0, 4)]).toEqual([60]); // 3 <= 0 + 4
  });

  it("defaults the window to KEY_LABEL_LOOK_AHEAD and that matches the visible lane (4s)", () => {
    expect(KEY_LABEL_LOOK_AHEAD).toBe(4);
    const notes = [ln({ midi: 72, time: 4, duration: 1 })];
    expect([...approachingKeyMidis(notes, 0)]).toEqual([72]);
  });

  it("returns an empty set for an empty score", () => {
    expect(approachingKeyMidis([], 5).size).toBe(0);
  });
});
