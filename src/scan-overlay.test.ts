import { describe, it, expect } from "vitest";
import { scanOverlayTitle } from "./scan-overlay";

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
