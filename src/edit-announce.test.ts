import { describe, it, expect } from "vitest";
import {
  durationEditAnnounce,
  keySetAnnounce,
  timeSetAnnounce,
} from "./edit-announce";

// No em dashes in any announce string (project + user style). Asserted on every produced string below.
const NO_DASH = /[—–]/;

describe("durationEditAnnounce (Designer P3-6 / TIE-E)", () => {
  const fill = "fill the bar"; // the noteValueName("", 0) fallback the orchestrator passes

  it("a plain step names the pitch + from->to value", () => {
    const s = durationEditAnnounce(
      { outcome: "stepped", fromName: "quarter", toName: "half", dottedSnap: false },
      "quarter",
      "D5",
      fill,
    );
    expect(s).toBe("D5 quarter to half");
    expect(s).not.toMatch(NO_DASH);
  });

  // Item 5: the OFF-LADDER SNAP announce must INCLUDE the pitch token (it used to drop it).
  it("an off-ladder SNAP names the PITCH then the from->to value (regression: pitch was dropped)", () => {
    const s = durationEditAnnounce(
      { outcome: "stepped", fromName: "dotted quarter", toName: "half", dottedSnap: true },
      "dotted quarter",
      "D5",
      fill,
    );
    expect(s).toBe("D5 dotted quarter to half");
    expect(s.startsWith("D5")).toBe(true); // the pitch leads, exactly like the plain step
    expect(s).toContain("D5"); // the load-bearing assertion: the pitch token is present
    expect(s).not.toMatch(NO_DASH);
  });

  it("a snap that lands on a no-name fill value uses the fill fallback, still with the pitch", () => {
    const s = durationEditAnnounce(
      { outcome: "stepped", fromName: "dotted quarter", toName: "", dottedSnap: true },
      "dotted quarter",
      "G4",
      fill,
    );
    expect(s).toBe("G4 dotted quarter to fill the bar");
    expect(s).toContain("G4");
  });

  it("a cross-barline tie create names the sounding value", () => {
    const s = durationEditAnnounce(
      { outcome: "tied", fromName: "quarter", toName: "half", dottedSnap: false },
      "quarter",
      "C4",
      fill,
    );
    expect(s).toBe("C4 lengthened across the bar to half");
  });

  it("a tie remove reads from->to with the tie note", () => {
    const s = durationEditAnnounce(
      { outcome: "untied", fromName: "half", toName: "quarter", dottedSnap: false },
      "half",
      "C4",
      fill,
    );
    expect(s).toBe("C4 half to quarter, tie removed");
  });

  it("a clamp reads as filling the bar", () => {
    const s = durationEditAnnounce(
      { outcome: "clamped", fromName: "quarter", toName: "", dottedSnap: false },
      "quarter",
      "C4",
      fill,
    );
    expect(s).toBe("C4 lengthened to fill the bar");
  });
});

describe("keySetAnnounce (MID-4)", () => {
  it("a START edit (no measure) keeps the v1 string", () => {
    const s = keySetAnnounce({ name: "D major", atMeasure: undefined, removed: false, priorName: "D major" });
    expect(s).toBe("Key signature set to D major.");
    expect(s).not.toMatch(NO_DASH);
  });

  it("a mid-piece SET names the measure", () => {
    const s = keySetAnnounce({ name: "E flat major", atMeasure: 3, removed: false, priorName: "D major" });
    expect(s).toBe("Key signature set to E flat major from measure 3.");
  });

  // Item 6: a mid-piece REMOVE reads as a REMOVAL, not a set.
  it("a mid-piece REMOVE reads as a removal naming the measure + the reverted-to key", () => {
    const s = keySetAnnounce({ name: "C major", atMeasure: 3, removed: true, priorName: "C major" });
    expect(s).toBe("Removed the key change at measure 3; back to C major.");
    expect(s).not.toMatch(/set to/); // the load-bearing distinction from the SET wording
    expect(s).not.toMatch(NO_DASH);
  });

  it("removed=true at measure 1 (the initial region) is NOT a mid-piece removal (no own decl to drop)", () => {
    // Defensive: a measure-1 / start target never takes the mid-piece remove branch in the model, so even
    // if removed somehow arrived true with atMeasure<=1, the announce stays the v1 set string.
    const s = keySetAnnounce({ name: "C major", atMeasure: 1, removed: true, priorName: "C major" });
    expect(s).toBe("Key signature set to C major.");
  });
});

describe("timeSetAnnounce (SIG-5 / MID-4)", () => {
  it("a START edit, all bars fit, keeps the v1 string", () => {
    const s = timeSetAnnounce({ meter: "3/4", atMeasure: null, mismatchedBars: 0, removed: false, priorMeter: "3/4" });
    expect(s).toBe("Time signature set to 3/4.");
    expect(s).not.toMatch(NO_DASH);
  });

  it("a START edit with mismatched bars appends the guardrail (singular + plural)", () => {
    expect(
      timeSetAnnounce({ meter: "3/4", atMeasure: null, mismatchedBars: 1, removed: false, priorMeter: "3/4" }),
    ).toBe("Time signature set to 3/4. 1 bar no longer fills the bar; adjust their note lengths.");
    expect(
      timeSetAnnounce({ meter: "3/4", atMeasure: null, mismatchedBars: 2, removed: false, priorMeter: "3/4" }),
    ).toBe("Time signature set to 3/4. 2 bars no longer fill the bar; adjust their note lengths.");
  });

  it("a mid-piece SET names the measure", () => {
    const s = timeSetAnnounce({ meter: "3/4", atMeasure: 5, mismatchedBars: 0, removed: false, priorMeter: "4/4" });
    expect(s).toBe("Time signature set to 3/4 from measure 5.");
  });

  // Item 6: a mid-piece REMOVE reads as a REMOVAL, not a set.
  it("a mid-piece REMOVE reads as a removal naming the measure + the reverted-to meter", () => {
    const s = timeSetAnnounce({ meter: "4/4", atMeasure: 5, mismatchedBars: 0, removed: true, priorMeter: "4/4" });
    expect(s).toBe("Removed the time change at measure 5; back to 4/4.");
    expect(s).not.toMatch(/set to/);
    expect(s).not.toMatch(NO_DASH);
  });
});
