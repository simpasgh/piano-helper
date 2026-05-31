import { describe, it, expect } from "vitest";
import { layoutSheetLabels, type NotePosition } from "./sheet-labels";

// MIDI references: 60 = C4 (Do / C), 64 = E4 (Mi / E), 67 = G4 (Sol / G),
// 61 = C#4 (Do# / C#).

describe("layoutSheetLabels", () => {
  it("returns no labels in off mode", () => {
    const notes: NotePosition[] = [{ midi: 60, x: 100, y: 50 }];
    expect(layoutSheetLabels(notes, "off")).toEqual([]);
  });

  it("labels a single note 6px above the notehead with no octave", () => {
    const notes: NotePosition[] = [{ midi: 60, x: 100, y: 50 }];
    const items = layoutSheetLabels(notes, "solfege");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ text: "Do", x: 100, y: 44, midi: 60 });
  });

  it("uses letter text in letters mode and solfege text in solfege mode", () => {
    const notes: NotePosition[] = [{ midi: 61, x: 10, y: 20 }];
    expect(layoutSheetLabels(notes, "letters")[0].text).toBe("C#");
    expect(layoutSheetLabels(notes, "solfege")[0].text).toBe("Do#");
  });

  // Issues #56/#58: the overlay must print the sheet's flat spelling, not the always-sharp
  // enharmonic, so it agrees with the staff beneath it.
  it("honors a note's flat spelling over the always-sharp MIDI name", () => {
    // MIDI 61 sounds the same as C#, but the sheet prints it as Db (step D, alter -1).
    const flatDb: NotePosition[] = [{ midi: 61, x: 10, y: 20, spelling: { letter: "D", alter: -1 } }];
    expect(layoutSheetLabels(flatDb, "letters")[0].text).toBe("Db");
    expect(layoutSheetLabels(flatDb, "solfege")[0].text).toBe("Reb");
  });

  it("falls back to the always-sharp name when a note has no spelling (no regression)", () => {
    const noSpelling: NotePosition[] = [{ midi: 61, x: 10, y: 20 }];
    expect(layoutSheetLabels(noSpelling, "letters")[0].text).toBe("C#");
    expect(layoutSheetLabels(noSpelling, "solfege")[0].text).toBe("Do#");
  });

  it("stacks a 3-note chord top-note-highest, one label per note, 11px gap", () => {
    // Three noteheads at the same x; y grows downward so the highest pitch (G4)
    // has the smallest y (top of staff).
    const notes: NotePosition[] = [
      { midi: 60, x: 200, y: 80 }, // C4, lowest pitch, lowest on staff
      { midi: 64, x: 200, y: 68 }, // E4
      { midi: 67, x: 200, y: 56 }, // G4, highest pitch, top notehead
    ];
    const items = layoutSheetLabels(notes, "letters");
    expect(items).toHaveLength(3);
    // All share the chord center-x.
    expect(items.every((i) => i.x === 200)).toBe(true);
    // Ordered top-of-stack first (highest pitch / smallest y first).
    expect(items.map((i) => i.text)).toEqual(["G", "E", "C"]);
    expect(items.map((i) => i.midi)).toEqual([67, 64, 60]);
    // Top notehead y is 56; lowest label sits 6px above it (50), stack grows up
    // by 11px per label: 50, 39, 28 from bottom to top.
    const sortedByY = [...items].sort((a, b) => a.y - b.y);
    expect(sortedByY.map((i) => i.y)).toEqual([28, 39, 50]);
    // The top note (G) is the highest label.
    expect(items[0].y).toBe(28);
  });

  it("drops the lower-voice label of the denser chord but keeps both top notes", () => {
    // Two chords whose x positions are closer than a label width (labels would
    // overlap left-right). The later chord collapses to its top note only.
    const notes: NotePosition[] = [
      { midi: 60, x: 100, y: 80 }, // chord A low
      { midi: 67, x: 100, y: 56 }, // chord A top
      { midi: 62, x: 103, y: 78 }, // chord B low (very close in x)
      { midi: 69, x: 103, y: 54 }, // chord B top
    ];
    const items = layoutSheetLabels(notes, "letters");
    const midis = items.map((i) => i.midi);
    // Chord A keeps both (full), chord B collapses to its top note (A4 = 69).
    expect(midis).toContain(67); // A top kept
    expect(midis).toContain(60); // A low kept
    expect(midis).toContain(69); // B top kept (melody always labeled)
    expect(midis).not.toContain(62); // B low dropped
  });

  it("favors the active (cursor) chord when an adjacent pair is too dense", () => {
    const notes: NotePosition[] = [
      { midi: 60, x: 100, y: 80 }, // left chord low (not active)
      { midi: 67, x: 100, y: 56 }, // left chord top
      { midi: 62, x: 103, y: 78, active: true }, // right chord low, ACTIVE
      { midi: 69, x: 103, y: 54, active: true }, // right chord top, ACTIVE
    ];
    const items = layoutSheetLabels(notes, "letters");
    const midis = items.map((i) => i.midi);
    // The active right chord stays full; the left chord collapses to its top.
    expect(midis).toContain(69); // active top
    expect(midis).toContain(62); // active low kept
    expect(midis).toContain(67); // left top kept
    expect(midis).not.toContain(60); // left low dropped
  });
});
