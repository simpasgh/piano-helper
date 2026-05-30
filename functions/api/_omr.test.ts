import { describe, it, expect } from "vitest";
import {
  MAX_UPLOAD_BYTES,
  validateUpload,
  normalizeMime,
  uploadKey,
  resultKey,
  isUuid,
} from "./_omr";

describe("validateUpload", () => {
  it("accepts png, jpeg, and pdf within the size cap", () => {
    for (const contentType of ["image/png", "image/jpeg", "application/pdf"]) {
      expect(validateUpload({ contentType, size: 1024 })).toEqual({ ok: true });
    }
  });

  it("rejects an unsupported mime type with 415", () => {
    const r = validateUpload({ contentType: "image/gif", size: 1024 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(415);
  });

  it("rejects an empty mime type with 415", () => {
    const r = validateUpload({ contentType: "", size: 1024 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(415);
  });

  it("rejects an oversize file with 413", () => {
    const r = validateUpload({
      contentType: "image/png",
      size: MAX_UPLOAD_BYTES + 1,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(413);
  });

  it("accepts a file exactly at the size cap", () => {
    expect(
      validateUpload({ contentType: "image/png", size: MAX_UPLOAD_BYTES }),
    ).toEqual({ ok: true });
  });

  it("accepts a type that carries parameters or odd casing", () => {
    expect(
      validateUpload({ contentType: "image/png; charset=binary", size: 1024 }),
    ).toEqual({ ok: true });
    expect(
      validateUpload({ contentType: "IMAGE/JPEG", size: 1024 }),
    ).toEqual({ ok: true });
  });
});

describe("normalizeMime", () => {
  it("strips parameters and lowercases", () => {
    expect(normalizeMime("application/pdf; q=0.9")).toBe("application/pdf");
    expect(normalizeMime("  Image/PNG ")).toBe("image/png");
  });
});

describe("R2 key helpers", () => {
  it("builds the upload key under uploads/", () => {
    expect(uploadKey("abc")).toBe("uploads/abc");
  });

  it("builds the result key under results/ with a .musicxml suffix", () => {
    expect(resultKey("abc")).toBe("results/abc.musicxml");
  });
});

describe("isUuid", () => {
  it("accepts a canonical v4 uuid", () => {
    expect(isUuid("9b2e7c1a-3d4f-4a8b-9c0d-1e2f3a4b5c6d")).toBe(true);
  });

  it("rejects malformed or empty ids", () => {
    expect(isUuid("")).toBe(false);
    expect(isUuid("not-a-uuid")).toBe(false);
    expect(isUuid("9b2e7c1a3d4f4a8b9c0d1e2f3a4b5c6d")).toBe(false);
    expect(isUuid("../results/secret")).toBe(false);
  });
});
