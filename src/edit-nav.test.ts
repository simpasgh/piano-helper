// Unit tests for the pure edit navigation + pitch-default logic (Smart Edit ADD-a-note v1 + the
// P2 delete-neighbor parity fix). No DOM / WASM: these take plain data.

import { describe, it, expect } from "vitest";
import {
  staffNavOrder,
  stepStaffNav,
  keyboardDefaultPitch,
  mouseDefaultPitch,
  musicalNeighborAfterDelete,
  type StaffNavTarget,
  type PrevNoteCandidate,
} from "./edit-nav";
import { midiFromPitch, type ModelPitch } from "./edit-model";

const p = (step: ModelPitch["step"], octave: number, alter = 0): ModelPitch => ({ step, octave, alter });

describe("staffNavOrder (notes + rests interleaved by onset)", () => {
  it("walks note, note, REST, note in document time so a keyboard user can land on a gap", () => {
    // RH C5@0, D5@0.5, [rest]@1.0, F5@1.5.
    const notes = [
      { id: 0, onsetSec: 0, midi: 72 },
      { id: 1, onsetSec: 0.5, midi: 74 },
      { id: 3, onsetSec: 1.5, midi: 77 },
    ];
    const rests = [{ id: 0, onsetSec: 1.0 }];
    expect(staffNavOrder(notes, rests)).toEqual<StaffNavTarget[]>([
      { kind: "note", id: 0 },
      { kind: "note", id: 1 },
      { kind: "rest", id: 0 },
      { kind: "note", id: 3 },
    ]);
  });

  it("on an onset tie, the rest sorts AFTER notes at that onset; notes sub-sort by midi", () => {
    const notes = [
      { id: 0, onsetSec: 0, midi: 55 }, // G3
      { id: 1, onsetSec: 0, midi: 48 }, // C3 (lower midi, comes first)
    ];
    const rests = [{ id: 0, onsetSec: 0 }];
    expect(staffNavOrder(notes, rests)).toEqual<StaffNavTarget[]>([
      { kind: "note", id: 1 }, // C3
      { kind: "note", id: 0 }, // G3
      { kind: "rest", id: 0 }, // rest last at the shared onset
    ]);
  });

  it("a score with no rests is just the notes in musical order", () => {
    const notes = [
      { id: 1, onsetSec: 1, midi: 60 },
      { id: 0, onsetSec: 0, midi: 62 },
    ];
    expect(staffNavOrder(notes, [])).toEqual<StaffNavTarget[]>([
      { kind: "note", id: 0 },
      { kind: "note", id: 1 },
    ]);
  });
});

describe("stepStaffNav", () => {
  const order: StaffNavTarget[] = [
    { kind: "note", id: 0 },
    { kind: "note", id: 1 },
    { kind: "rest", id: 0 },
    { kind: "note", id: 3 },
  ];

  it("with no selection, +1 lands on the first and -1 on the last", () => {
    expect(stepStaffNav(order, null, 1)).toEqual({ kind: "note", id: 0 });
    expect(stepStaffNav(order, null, -1)).toEqual({ kind: "note", id: 3 });
  });

  it("steps onto the rest from the note before it (the no-pointer add path)", () => {
    expect(stepStaffNav(order, { kind: "note", id: 1 }, 1)).toEqual({ kind: "rest", id: 0 });
    expect(stepStaffNav(order, { kind: "rest", id: 0 }, -1)).toEqual({ kind: "note", id: 1 });
    expect(stepStaffNav(order, { kind: "rest", id: 0 }, 1)).toEqual({ kind: "note", id: 3 });
  });

  it("wraps at the ends", () => {
    expect(stepStaffNav(order, { kind: "note", id: 3 }, 1)).toEqual({ kind: "note", id: 0 });
    expect(stepStaffNav(order, { kind: "note", id: 0 }, -1)).toEqual({ kind: "note", id: 3 });
  });

  it("returns null for an empty order", () => {
    expect(stepStaffNav([], null, 1)).toBeNull();
  });
});

describe("keyboardDefaultPitch (ADD-2: previous note's pitch, else middle line)", () => {
  const candidates: PrevNoteCandidate[] = [
    { onsetSec: 0, staff: 1, voice: 1, pitch: p("C", 5) },
    { onsetSec: 0.5, staff: 1, voice: 1, pitch: p("D", 5) }, // the nearest earlier note in v1/s1
    { onsetSec: 0.5, staff: 2, voice: 2, pitch: p("C", 3) }, // a different staff/voice, ignored
  ];

  it("defaults to the PREVIOUS sounding note's pitch in the same voice + staff", () => {
    // Rest at 1.0 on staff 1, voice 1: the nearest earlier same-voice note is D5@0.5.
    expect(keyboardDefaultPitch(1.0, 1, 1, candidates)).toEqual(p("D", 5));
  });

  it("ignores notes in a different voice/staff and notes at/after the rest", () => {
    // Rest at 0.5 staff 1 voice 1: only C5@0 is strictly earlier in that voice (D5 is at 0.5, not before).
    expect(keyboardDefaultPitch(0.5, 1, 1, candidates)).toEqual(p("C", 5));
  });

  it("falls back to the treble middle line (B4) when there is no previous note (staff 1)", () => {
    expect(keyboardDefaultPitch(0, 1, 1, candidates)).toEqual(p("B", 4));
  });

  it("falls back to the bass middle line (D3) on staff 2 with no previous note", () => {
    expect(keyboardDefaultPitch(0, 2, 1, [])).toEqual(p("D", 3));
  });
});

describe("mouseDefaultPitch (ADD-2: the clicked staff line/space)", () => {
  it("0 steps = the staff middle line (B4 treble / D3 bass)", () => {
    expect(mouseDefaultPitch(1, 0, 0)).toEqual(p("B", 4));
    expect(mouseDefaultPitch(2, 0, 0)).toEqual(p("D", 3));
  });

  it("positive steps move UP diatonically from the middle line (C major)", () => {
    // From B4: +1 = C5, +2 = D5 (key-sig aware, C major naturals).
    expect(mouseDefaultPitch(1, 0, 1)).toEqual(p("C", 5));
    expect(mouseDefaultPitch(1, 0, 2)).toEqual(p("D", 5));
  });

  it("negative steps move DOWN diatonically", () => {
    // From B4: -1 = A4, -2 = G4.
    expect(mouseDefaultPitch(1, 0, -1)).toEqual(p("A", 4));
    expect(mouseDefaultPitch(1, 0, -2)).toEqual(p("G", 4));
  });

  it("is key-signature aware (D major: a step up from B4 to C is C#)", () => {
    // fifths=2 (D major): C takes a sharp. From B4 up one diatonic step => C#5.
    expect(mouseDefaultPitch(1, 2, 1)).toEqual(p("C", 5, 1));
  });
});

describe("musicalNeighborAfterDelete (P2: delete/redo select identically)", () => {
  it("selects the next note in (onset, midi) order after the deleted one", () => {
    // Remaining (post-delete) RH: C5@0, E5@1, F5@1.5. Deleted D5@0.5 -> next is E5 (id 2).
    const remaining = [
      { id: 0, onsetSec: 0, midi: 72 },
      { id: 2, onsetSec: 1, midi: 76 },
      { id: 3, onsetSec: 1.5, midi: 77 },
    ];
    expect(musicalNeighborAfterDelete(remaining, 0.5, 74)).toBe(2);
  });

  it("selects the PREVIOUS note when the deleted note was the musical last", () => {
    const remaining = [
      { id: 0, onsetSec: 0, midi: 72 },
      { id: 1, onsetSec: 0.5, midi: 74 },
    ];
    // Deleted F5@1.5 (after everything) -> the last remaining (id 1).
    expect(musicalNeighborAfterDelete(remaining, 1.5, 77)).toBe(1);
  });

  it("picks by MUSICAL order, not document order (grand-staff divergence the fix targets)", () => {
    // Document order (as the model stores it after a backup) is RH then LH, so the handle AT the
    // deleted position by DOCUMENT index would be the first LH note. Musically, the next note after
    // the deleted RH D5@0.5 is the RH E5@1.0, NOT the LH C3@0.0. The musical neighbor must be E5.
    const remaining = [
      { id: 0, onsetSec: 0, midi: 72 }, // RH C5
      { id: 2, onsetSec: 1.0, midi: 76 }, // RH E5  (musical next after the deleted D5@0.5)
      { id: 3, onsetSec: 0, midi: 48 }, // LH C3  (document-adjacent, but earlier in time)
    ];
    expect(musicalNeighborAfterDelete(remaining, 0.5, 74)).toBe(2); // E5, the musical neighbor
  });

  it("returns null when no notes remain", () => {
    expect(musicalNeighborAfterDelete([], 0, 60)).toBeNull();
  });

  it("on an onset tie, 'after' means a higher midi at the same onset", () => {
    // Deleted C3@0 (midi 48); remaining at onset 0 are E3(52), G3(55). Next is E3 (the lowest above).
    const remaining = [
      { id: 1, onsetSec: 0, midi: 52 },
      { id: 2, onsetSec: 0, midi: 55 },
    ];
    expect(musicalNeighborAfterDelete(remaining, 0, 48)).toBe(1);
    // sanity: midiFromPitch is the same scale the ids use
    expect(midiFromPitch(p("E", 3))).toBe(52);
  });
});
