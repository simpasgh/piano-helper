import { describe, it, expect } from "vitest";
import { chooseVideoFormat, buildExportFilename } from "./recorder";

describe("chooseVideoFormat", () => {
  it("prefers VP9 WebM when everything is supported", () => {
    const format = chooseVideoFormat(() => true);
    expect(format).toEqual({ mimeType: "video/webm;codecs=vp9,opus", extension: "webm" });
  });

  it("falls back to VP8 WebM when VP9 is unsupported", () => {
    const format = chooseVideoFormat((t) => !t.includes("vp9"));
    expect(format).toEqual({ mimeType: "video/webm;codecs=vp8,opus", extension: "webm" });
  });

  it("falls back to MP4 when WebM is unsupported", () => {
    const format = chooseVideoFormat((t) => t.startsWith("video/mp4"));
    expect(format).toEqual({ mimeType: "video/mp4", extension: "mp4" });
  });

  it("returns null when nothing is supported", () => {
    expect(chooseVideoFormat(() => false)).toBeNull();
  });
});

describe("buildExportFilename", () => {
  const now = new Date("2026-05-30T09:15:42Z");

  it("slugifies the track label and strips the (N notes) annotation", () => {
    expect(buildExportFilename("Clair de Lune (240 notes)", "webm", now)).toBe(
      "piano-helper-clair-de-lune-2026-05-30-09-15-42.webm",
    );
  });

  it("strips a file extension from the label", () => {
    expect(buildExportFilename("test-scale.wav (5 notes)", "webm", now)).toBe(
      "piano-helper-test-scale-2026-05-30-09-15-42.webm",
    );
  });

  it("uses the given container extension", () => {
    expect(buildExportFilename("Song", "mp4", now)).toBe(
      "piano-helper-song-2026-05-30-09-15-42.mp4",
    );
  });

  it("falls back to 'performance' when the label has no usable text", () => {
    expect(buildExportFilename("(12 notes)", "webm", now)).toBe(
      "piano-helper-performance-2026-05-30-09-15-42.webm",
    );
  });
});
