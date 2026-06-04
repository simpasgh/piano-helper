// Unit tests for the time-signature naming helpers (Smart Edit SIGNATURE EDITING, SIG-3 + the MID-1
// region-aware pill). Pure, no DOM, so they pin the meter strings the pill / popover / announce read.

import { describe, it, expect } from "vitest";
import {
  PRESET_METERS,
  meterSlashLabel,
  meterSpokenLabel,
  meterCellLabel,
  timePillLabel,
  timePillAria,
} from "./time-names";

describe("meter label helpers", () => {
  it("slashes the meter for the pill + announce, words it for aria, names the cell", () => {
    expect(meterSlashLabel(4, 4)).toBe("4/4");
    expect(meterSlashLabel(6, 8)).toBe("6/8");
    expect(meterSpokenLabel(4, 4)).toBe("4 4"); // no slash: a screen reader must not say a date/fraction
    expect(meterCellLabel(3, 4)).toBe("3 4 time");
  });

  it("PRESET_METERS covers the 7 common piano meters", () => {
    expect(PRESET_METERS).toHaveLength(7);
    expect(PRESET_METERS).toContainEqual({ beats: 4, beatType: 4 });
    expect(PRESET_METERS).toContainEqual({ beats: 12, beatType: 8 });
  });
});

describe("timePillLabel / timePillAria (region-aware pill, MID-1)", () => {
  it("the INITIAL region (atMeasure 1 / undefined) keeps the clean v1 label + aria", () => {
    expect(timePillLabel(4, 4)).toBe("4/4");
    expect(timePillLabel(3, 4, 1)).toBe("3/4"); // measure 1 = the initial region, no qualifier
    expect(timePillAria(4, 4)).toBe("Time signature: 4 4. Change the time signature.");
    expect(timePillAria(3, 4, 1)).toBe("Time signature: 3 4. Change the time signature.");
  });

  it("a MID-PIECE region (atMeasure > 1) adds the (m. N) qualifier + names the region in aria", () => {
    expect(timePillLabel(3, 4, 5)).toBe("3/4 (m. 5)");
    expect(timePillAria(3, 4, 5)).toBe(
      "Time signature: 3 4, in effect from measure 5. Change the time signature from measure 5.",
    );
    expect(timePillLabel(6, 8, 9)).toBe("6/8 (m. 9)");
  });

  it("the region-aware strings are em-dash and en-dash free (project style rule)", () => {
    for (const m of [1, 4, 8]) {
      for (const meter of PRESET_METERS) {
        expect(timePillLabel(meter.beats, meter.beatType, m)).not.toMatch(/[—–]/);
        expect(timePillAria(meter.beats, meter.beatType, m)).not.toMatch(/[—–]/);
      }
    }
  });
});
