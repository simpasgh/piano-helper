import { describe, it, expect } from "vitest";
import { buildSalamanderSampleMap, SALAMANDER_BASE_URL } from "./sampler";

describe("buildSalamanderSampleMap", () => {
  const map = buildSalamanderSampleMap();

  it("maps natural notes to their plain mp3 filename", () => {
    expect(map["A0"]).toBe("A0.mp3");
    expect(map["C1"]).toBe("C1.mp3");
    expect(map["A4"]).toBe("A4.mp3");
  });

  it("maps sharps to the 's' filename spelling", () => {
    expect(map["D#1"]).toBe("Ds1.mp3");
    expect(map["F#1"]).toBe("Fs1.mp3");
    expect(map["D#4"]).toBe("Ds4.mp3");
    expect(map["F#7"]).toBe("Fs7.mp3");
  });

  it("includes the lowest sample A0 but not non-existent C0/D#0/F#0", () => {
    expect(map["A0"]).toBe("A0.mp3");
    expect(map["C0"]).toBeUndefined();
    expect(map["D#0"]).toBeUndefined();
    expect(map["F#0"]).toBeUndefined();
  });

  it("includes the top sample C8 but no higher partial-octave samples", () => {
    expect(map["C8"]).toBe("C8.mp3");
    expect(map["A8"]).toBeUndefined();
    expect(map["D#8"]).toBeUndefined();
    expect(map["F#8"]).toBeUndefined();
  });

  it("covers A/C/D#/F# in each full octave 1..7", () => {
    for (let octave = 1; octave <= 7; octave++) {
      expect(map[`A${octave}`]).toBe(`A${octave}.mp3`);
      expect(map[`C${octave}`]).toBe(`C${octave}.mp3`);
      expect(map[`D#${octave}`]).toBe(`Ds${octave}.mp3`);
      expect(map[`F#${octave}`]).toBe(`Fs${octave}.mp3`);
    }
  });

  it("has the expected sample count (1 + 7*4 + 1 = 30)", () => {
    expect(Object.keys(map).length).toBe(30);
  });

  it("every filename ends in .mp3 and uses 's' not '#'", () => {
    for (const file of Object.values(map)) {
      expect(file.endsWith(".mp3")).toBe(true);
      expect(file).not.toContain("#");
    }
  });

  it("exposes the official Tone.js Salamander CDN base url", () => {
    expect(SALAMANDER_BASE_URL).toBe("https://tonejs.github.io/audio/salamander/");
  });
});
