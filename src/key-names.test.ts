// Unit tests for the key-signature naming helpers (Smart Edit SIGNATURE EDITING, SIG-4). Pure, no
// DOM, so they pin the circle-of-fifths data + the spoken names the pill / popover / announce read.

import { describe, it, expect } from "vitest";
import {
  CIRCLE_OF_FIFTHS,
  keyForFifths,
  keyMajorName,
  accidentalCountPhrase,
  keyRowLabel,
  keyPillLabel,
  keyPillAria,
} from "./key-names";

describe("CIRCLE_OF_FIFTHS", () => {
  it("lists the 15 keys from 7 flats to 7 sharps, fifths strictly increasing", () => {
    expect(CIRCLE_OF_FIFTHS).toHaveLength(15);
    expect(CIRCLE_OF_FIFTHS.map((k) => k.fifths)).toEqual([
      -7, -6, -5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6, 7,
    ]);
  });

  it("names the conventional major + relative minor per signature", () => {
    expect(keyForFifths(0)).toMatchObject({ major: "C major", minor: "A minor" });
    expect(keyForFifths(2)).toMatchObject({ major: "D major", minor: "B minor" });
    expect(keyForFifths(-3)).toMatchObject({ major: "E flat major", minor: "C minor" });
    expect(keyForFifths(1)).toMatchObject({ major: "G major", minor: "E minor" });
    expect(keyForFifths(-1)).toMatchObject({ major: "F major", minor: "D minor" });
  });
});

describe("keyForFifths clamps out-of-range values", () => {
  it("clamps above +7 and below -7", () => {
    expect(keyForFifths(99).fifths).toBe(7);
    expect(keyForFifths(-99).fifths).toBe(-7);
  });
});

describe("keyMajorName (the pill label + announce shorthand)", () => {
  it("returns the major name for a signature", () => {
    expect(keyMajorName(0)).toBe("C major");
    expect(keyMajorName(2)).toBe("D major");
    expect(keyMajorName(-2)).toBe("B flat major");
    expect(keyMajorName(7)).toBe("C sharp major");
    expect(keyMajorName(-7)).toBe("C flat major");
  });
});

describe("accidentalCountPhrase", () => {
  it("reads no accidentals, singular, and plural correctly", () => {
    expect(accidentalCountPhrase(0)).toBe("no sharps or flats");
    expect(accidentalCountPhrase(1)).toBe("1 sharp");
    expect(accidentalCountPhrase(2)).toBe("2 sharps");
    expect(accidentalCountPhrase(-1)).toBe("1 flat");
    expect(accidentalCountPhrase(-3)).toBe("3 flats");
  });
});

describe("keyRowLabel (the spoken option name)", () => {
  it("leads with the accidental count, then major or relative minor", () => {
    expect(keyRowLabel(0)).toBe("no sharps or flats, C major or A minor");
    expect(keyRowLabel(2)).toBe("2 sharps, D major or B minor");
    expect(keyRowLabel(-3)).toBe("3 flats, E flat major or C minor");
  });

  it("every row label is em-dash and en-dash free (project style rule)", () => {
    for (const k of CIRCLE_OF_FIFTHS) {
      const label = keyRowLabel(k.fifths);
      expect(label).not.toContain("—");
      expect(label).not.toContain("–");
    }
  });
});

describe("keyPillLabel / keyPillAria (region-aware pill, MID-1)", () => {
  it("the INITIAL region (atMeasure 1 / undefined) keeps the clean v1 label + aria", () => {
    expect(keyPillLabel(0)).toBe("C major");
    expect(keyPillLabel(2, 1)).toBe("D major"); // measure 1 = the initial region, no qualifier
    expect(keyPillAria(0)).toBe("Key signature: C major. Change the key.");
    expect(keyPillAria(2, 1)).toBe("Key signature: D major. Change the key.");
  });

  it("a MID-PIECE region (atMeasure > 1) adds the (m. N) qualifier + names the region in aria", () => {
    expect(keyPillLabel(2, 5)).toBe("D major (m. 5)");
    expect(keyPillAria(2, 5)).toBe(
      "Key signature: D major, in effect from measure 5. Change the key from measure 5.",
    );
    expect(keyPillLabel(-3, 12)).toBe("E flat major (m. 12)");
  });

  it("the region-aware strings are em-dash and en-dash free (project style rule)", () => {
    for (const m of [1, 3, 7]) {
      for (const k of CIRCLE_OF_FIFTHS) {
        expect(keyPillLabel(k.fifths, m)).not.toMatch(/[—–]/);
        expect(keyPillAria(k.fifths, m)).not.toMatch(/[—–]/);
      }
    }
  });
});
