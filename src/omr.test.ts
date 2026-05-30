import { describe, it, expect, vi } from "vitest";
import {
  validateSheetFile,
  requestOmr,
  pollOmrResult,
  convertSheetToMusicXml,
} from "./omr";

// Minimal File-like stub: jsdom is not enabled, so we fake the bits omr.ts reads.
function fakeFile(opts: { name?: string; type: string; size: number }): File {
  return {
    name: opts.name ?? "scan.png",
    type: opts.type,
    size: opts.size,
  } as unknown as File;
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function textResponse(status: number, body: string): Response {
  return {
    status,
    text: async () => body,
    json: async () => {
      throw new Error("not json");
    },
  } as unknown as Response;
}

const noSleep = vi.fn(async () => {});

describe("validateSheetFile", () => {
  it("returns null for allowed types within the size cap", () => {
    expect(validateSheetFile(fakeFile({ type: "image/png", size: 10 }))).toBe(
      null,
    );
    expect(
      validateSheetFile(fakeFile({ type: "application/pdf", size: 10 })),
    ).toBe(null);
  });

  it("rejects an unsupported type", () => {
    const msg = validateSheetFile(fakeFile({ type: "image/gif", size: 10 }));
    expect(msg).toMatch(/Unsupported/);
  });

  it("rejects an oversize file", () => {
    const msg = validateSheetFile(
      fakeFile({ type: "image/png", size: 11 * 1024 * 1024 }),
    );
    expect(msg).toMatch(/too large/i);
  });
});

describe("requestOmr", () => {
  it("POSTs the file and returns the jobId on 202", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        jsonResponse(202, { jobId: "job-123" }),
    );
    const file = fakeFile({ name: "my scan.png", type: "image/png", size: 5 });
    const out = await requestOmr(file, { fetch: fetchMock });

    expect(out).toEqual({ jobId: "job-123" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/omr?filename=my%20scan.png");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe(file);
  });

  it("throws a clear error when OMR is not configured (503)", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(503, { error: "x" }));
    await expect(
      requestOmr(fakeFile({ type: "image/png", size: 5 }), {
        fetch: fetchMock,
      }),
    ).rejects.toThrow("OMR is not configured");
  });

  it("surfaces the server error message on other failures", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(415, { error: "Unsupported file type." }),
    );
    await expect(
      requestOmr(fakeFile({ type: "image/png", size: 5 }), {
        fetch: fetchMock,
      }),
    ).rejects.toThrow("Unsupported file type.");
  });
});

describe("pollOmrResult", () => {
  it("polls past a 404 then resolves the MusicXML on 200", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(404, { status: "pending" }))
      .mockResolvedValueOnce(textResponse(200, "<score-partwise/>"));

    const xml = await pollOmrResult("job-123", {
      fetch: fetchMock as any,
      sleep: noSleep,
    });

    expect(xml).toBe("<score-partwise/>");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(noSleep).toHaveBeenCalledTimes(1); // one wait between the two polls
  });

  it("throws when OMR becomes unconfigured (503)", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(503, { error: "x" }));
    await expect(
      pollOmrResult("job-123", { fetch: fetchMock, sleep: noSleep }),
    ).rejects.toThrow("OMR is not configured");
  });

  it("times out after maxAttempts of pending", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(404, { status: "pending" }),
    );
    await expect(
      pollOmrResult("job-123", {
        fetch: fetchMock,
        sleep: noSleep,
        maxAttempts: 3,
      }),
    ).rejects.toThrow(/timed out/i);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe("convertSheetToMusicXml", () => {
  it("chains request + poll into the final MusicXML", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(202, { jobId: "job-9" }))
      .mockResolvedValueOnce(textResponse(200, "<score/>"));

    const xml = await convertSheetToMusicXml(
      fakeFile({ type: "image/png", size: 5 }),
      { fetch: fetchMock as any, sleep: noSleep },
    );
    expect(xml).toBe("<score/>");
  });
});
