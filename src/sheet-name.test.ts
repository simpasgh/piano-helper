import { describe, it, expect } from "vitest";
import {
  DEFAULT_SHEET_NAME,
  MAX_SHEET_NAME_LENGTH,
  OSMD_PLACEHOLDER_TITLE,
  normalizeSheetName,
  deriveDefaultSheetName,
  resolveEditedSheetName,
} from "./sheet-name";

describe("normalizeSheetName", () => {
  it("trims and collapses internal whitespace", () => {
    expect(normalizeSheetName("  Moonlight   Sonata\n")).toBe("Moonlight Sonata");
  });

  it("returns empty string for null, undefined, or all-whitespace", () => {
    expect(normalizeSheetName(null)).toBe("");
    expect(normalizeSheetName(undefined)).toBe("");
    expect(normalizeSheetName("   \t\n ")).toBe("");
  });

  it("caps overly long names at MAX_SHEET_NAME_LENGTH and re-trims", () => {
    const long = "a".repeat(MAX_SHEET_NAME_LENGTH + 25);
    expect(normalizeSheetName(long).length).toBe(MAX_SHEET_NAME_LENGTH);
  });

  it("does not leave a trailing space after the length cap", () => {
    // A space landing exactly on the cap boundary must be trimmed off.
    const value = "x".repeat(MAX_SHEET_NAME_LENGTH - 1) + " more";
    expect(normalizeSheetName(value)).toBe("x".repeat(MAX_SHEET_NAME_LENGTH - 1));
  });
});

describe("deriveDefaultSheetName", () => {
  it("prefers the MusicXML title when present", () => {
    expect(deriveDefaultSheetName("song.musicxml", "Clair de Lune")).toBe("Clair de Lune");
  });

  it("falls back to the file name with its extension stripped", () => {
    expect(deriveDefaultSheetName("Prelude in C.musicxml", null)).toBe("Prelude in C");
    expect(deriveDefaultSheetName("scale.MID", "")).toBe("scale");
  });

  it("keeps a dot that is not a short file extension", () => {
    expect(deriveDefaultSheetName("J.S. Bach", null)).toBe("J.S. Bach");
  });

  it("falls back to DEFAULT_SHEET_NAME when nothing is usable", () => {
    expect(deriveDefaultSheetName("", "")).toBe(DEFAULT_SHEET_NAME);
    expect(deriveDefaultSheetName(null, undefined)).toBe(DEFAULT_SHEET_NAME);
    expect(deriveDefaultSheetName("   ", "  ")).toBe(DEFAULT_SHEET_NAME);
  });

  it("normalizes a messy title before using it", () => {
    expect(deriveDefaultSheetName(null, "  Étude   No. 3 \n")).toBe("Étude No. 3");
  });

  it("skips OSMD's 'Untitled Score' placeholder and uses the stripped file name (#64)", () => {
    expect(deriveDefaultSheetName("moonlight-sonata.musicxml", OSMD_PLACEHOLDER_TITLE)).toBe(
      "moonlight-sonata",
    );
    expect(deriveDefaultSheetName("moonlight-sonata.xml", "Untitled Score")).toBe(
      "moonlight-sonata",
    );
    expect(deriveDefaultSheetName("moonlight-sonata.mxl", "Untitled Score")).toBe(
      "moonlight-sonata",
    );
  });

  it("matches the placeholder case- and whitespace-insensitively (#64)", () => {
    expect(deriveDefaultSheetName("prelude.musicxml", "  untitled score  ")).toBe("prelude");
    expect(deriveDefaultSheetName("prelude.musicxml", "UNTITLED SCORE")).toBe("prelude");
  });

  it("falls through the placeholder to DEFAULT_SHEET_NAME when there is no file name (#64)", () => {
    expect(deriveDefaultSheetName(null, OSMD_PLACEHOLDER_TITLE)).toBe(DEFAULT_SHEET_NAME);
    expect(deriveDefaultSheetName("", "Untitled Score")).toBe(DEFAULT_SHEET_NAME);
  });
});

describe("resolveEditedSheetName", () => {
  it("uses the normalized edit when it has content", () => {
    expect(resolveEditedSheetName("  My Practice Piece ", "Old Name")).toBe(
      "My Practice Piece",
    );
  });

  it("reverts to the current name when the edit is blank", () => {
    expect(resolveEditedSheetName("   ", "Clair de Lune")).toBe("Clair de Lune");
    expect(resolveEditedSheetName("", "Clair de Lune")).toBe("Clair de Lune");
  });

  it("falls back to DEFAULT_SHEET_NAME when both edit and current name are blank", () => {
    expect(resolveEditedSheetName("", "")).toBe(DEFAULT_SHEET_NAME);
  });

  it("caps a long edit at MAX_SHEET_NAME_LENGTH", () => {
    const long = "z".repeat(MAX_SHEET_NAME_LENGTH + 10);
    expect(resolveEditedSheetName(long, "Old").length).toBe(MAX_SHEET_NAME_LENGTH);
  });
});
