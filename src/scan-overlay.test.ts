import { describe, it, expect } from "vitest";
import { scanOverlayTitle, shouldApplyResult } from "./scan-overlay";

describe("scanOverlayTitle", () => {
  it("uses the scan heading for an OMR sheet scan", () => {
    expect(scanOverlayTitle("scan")).toBe("Scanning your sheet");
  });

  it("uses the transcribe heading for an audio job", () => {
    expect(scanOverlayTitle("audio")).toBe("Transcribing your audio");
  });

  it("never emits an em or en dash (project punctuation rule)", () => {
    for (const kind of ["scan", "audio"] as const) {
      const title = scanOverlayTitle(kind);
      expect(title).not.toMatch(/[–—]/);
    }
  });
});

describe("shouldApplyResult", () => {
  it("applies a normal job that is still active and not cancelled", () => {
    expect(shouldApplyResult(1, 1, false)).toBe(true);
  });

  it("drops a job that finishes AFTER the user cancelled it", () => {
    // Same generation (no restart), but the cancel flag is set: the late audio result
    // must not load after the overlay closed.
    expect(shouldApplyResult(1, 1, true)).toBe(false);
  });

  it("drops job A's late result when a restart (job B) has bumped the generation", () => {
    // Cancel-then-restart: showScanOverlay resets cancelRequested to false for job B, so
    // job A's late finish sees cancelled=false but a higher current generation and is dropped.
    expect(shouldApplyResult(1, 2, false)).toBe(false);
  });

  it("drops a superseded job even if it is also cancelled", () => {
    expect(shouldApplyResult(1, 2, true)).toBe(false);
  });
});
