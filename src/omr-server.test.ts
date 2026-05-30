import { describe, it, expect } from "vitest";
import {
  mimeToExt,
  validateUpload,
  buildDispatchRequest,
  MAX_UPLOAD_BYTES,
  uploadKey,
  resultKey,
  errorKey,
} from "./omr-server";

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

  it("rejects an unsupported type with 400", () => {
    const v = validateUpload("image/gif", 1000);
    expect(v.ok).toBe(false);
    expect(v.status).toBe(400);
    expect(v.error).toBeTruthy();
  });

  it("rejects an empty file with 400", () => {
    const v = validateUpload("image/png", 0);
    expect(v.ok).toBe(false);
    expect(v.status).toBe(400);
  });

  it("rejects a file over the size cap with 400", () => {
    const v = validateUpload("application/pdf", MAX_UPLOAD_BYTES + 1);
    expect(v.ok).toBe(false);
    expect(v.status).toBe(400);
  });

  it("accepts a file exactly at the size cap", () => {
    const v = validateUpload("application/pdf", MAX_UPLOAD_BYTES);
    expect(v.ok).toBe(true);
  });
});

describe("buildDispatchRequest", () => {
  it("builds the repository_dispatch request with the contract payload", () => {
    const req = buildDispatchRequest("tok123", "job-abc", "png");
    expect(req.url).toBe("https://api.github.com/repos/simpasgh/piano-helper/dispatches");
    expect(req.method).toBe("POST");
    expect(req.headers.Authorization).toBe("Bearer tok123");
    expect(req.headers.Accept).toBe("application/vnd.github+json");
    expect(req.headers["User-Agent"]).toBe("piano-helper-omr");
    expect(req.headers["X-GitHub-Api-Version"]).toBe("2022-11-28");

    const body = JSON.parse(req.body);
    expect(body).toEqual({
      event_type: "omr-job",
      client_payload: { jobId: "job-abc", ext: "png" },
    });
  });
});

describe("R2 key helpers", () => {
  it("derives upload, result, and error keys from a job id", () => {
    expect(uploadKey("abc")).toBe("uploads/abc");
    expect(resultKey("abc")).toBe("results/abc.musicxml");
    expect(errorKey("abc")).toBe("results/abc.error");
  });
});
