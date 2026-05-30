import { describe, it, expect } from "vitest";
import {
  mimeToExt,
  validateUpload,
  MAX_UPLOAD_BYTES,
  uploadKey,
  resultKey,
  isValidJobId,
} from "./omr-server";

describe("isValidJobId", () => {
  it("accepts a crypto.randomUUID shape", () => {
    expect(isValidJobId(crypto.randomUUID())).toBe(true);
    expect(isValidJobId("3f2504e0-4f89-41d3-9a0c-0305e82c3301")).toBe(true);
  });

  it("rejects empty, malformed, or injection-shaped ids", () => {
    expect(isValidJobId(null)).toBe(false);
    expect(isValidJobId("")).toBe(false);
    expect(isValidJobId("../results/secret")).toBe(false);
    expect(isValidJobId("not-a-uuid")).toBe(false);
    expect(isValidJobId("3f2504e0-4f89-41d3-9a0c-0305e82c3301.musicxml")).toBe(false);
  });
});

describe("mimeToExt", () => {
  it("maps accepted MIME types to extensions", () => {
    expect(mimeToExt("image/png")).toBe("png");
    expect(mimeToExt("image/jpeg")).toBe("jpg");
    expect(mimeToExt("application/pdf")).toBe("pdf");
  });

  it("ignores parameters and casing", () => {
    expect(mimeToExt("image/PNG; charset=binary")).toBe("png");
  });

  it("rejects unsupported and empty types", () => {
    expect(mimeToExt("image/gif")).toBeNull();
    expect(mimeToExt("")).toBeNull();
    expect(mimeToExt(null)).toBeNull();
    expect(mimeToExt(undefined)).toBeNull();
  });
});

describe("validateUpload", () => {
  it("accepts a valid png within the size limit", () => {
    const v = validateUpload("image/png", 1000);
    expect(v.ok).toBe(true);
    expect(v.status).toBe(202);
    expect(v.ext).toBe("png");
  });

  it("rejects an unsupported type with 415", () => {
    const v = validateUpload("image/gif", 1000);
    expect(v.ok).toBe(false);
    expect(v.status).toBe(415);
    expect(v.error).toBeTruthy();
  });

  it("rejects an empty file with 400", () => {
    const v = validateUpload("image/png", 0);
    expect(v.ok).toBe(false);
    expect(v.status).toBe(400);
  });

  it("rejects a file over the size cap with 413", () => {
    const v = validateUpload("application/pdf", MAX_UPLOAD_BYTES + 1);
    expect(v.ok).toBe(false);
    expect(v.status).toBe(413);
  });

  it("accepts a file exactly at the size cap", () => {
    const v = validateUpload("application/pdf", MAX_UPLOAD_BYTES);
    expect(v.ok).toBe(true);
  });
});

describe("R2 key helpers", () => {
  it("derives upload and result keys from a job id", () => {
    expect(uploadKey("abc")).toBe("uploads/abc");
    expect(resultKey("abc")).toBe("results/abc.musicxml");
  });
});
