import { describe, it, expect, vi } from "vitest";
import { submitOmr, pollOmrResult } from "./omr";

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function textResponse(body: string, status: number): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/xml" } });
}

const fakeFile = (): File =>
  new File([new Uint8Array([1, 2, 3])], "scan.png", { type: "image/png" });

describe("submitOmr", () => {
  it("POSTs multipart form data and returns the jobId", async () => {
    const fetchFn = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ jobId: "job-1" }, 202),
    ) as unknown as typeof fetch;

    const jobId = await submitOmr(fakeFile(), fetchFn);
    expect(jobId).toBe("job-1");

    const call = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe("/api/omr");
    expect(call[1].method).toBe("POST");
    expect(call[1].body).toBeInstanceOf(FormData);
    expect((call[1].body as FormData).get("file")).toBeInstanceOf(File);
  });

  it("throws the server error when submission fails", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({ error: "File too large." }, 400),
    ) as unknown as typeof fetch;

    await expect(submitOmr(fakeFile(), fetchFn)).rejects.toThrow("File too large.");
  });
});

describe("pollOmrResult", () => {
  it("returns the MusicXML after pending 404s then a 200", async () => {
    const responses = [
      jsonResponse({ status: "pending" }, 404),
      jsonResponse({ status: "pending" }, 404),
      textResponse("<score-partwise/>", 200),
    ];
    let i = 0;
    const fetchFn = vi.fn(async () => responses[i++]) as unknown as typeof fetch;
    const sleep = vi.fn(async () => {});

    const xml = await pollOmrResult("job-1", {
      fetchFn,
      sleep,
      intervalMs: 10,
      timeoutMs: 1000,
      now: () => 0,
    });

    expect(xml).toBe("<score-partwise/>");
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("throws the server message on 422", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({ error: "Could not detect any staves." }, 422),
    ) as unknown as typeof fetch;

    await expect(
      pollOmrResult("job-1", { fetchFn, sleep: async () => {}, now: () => 0 }),
    ).rejects.toThrow("Could not detect any staves.");
  });

  it("throws on timeout while still pending", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({ status: "pending" }, 404),
    ) as unknown as typeof fetch;
    // Advance the clock past the timeout on the second now() read.
    const times = [0, 0, 9999];
    let t = 0;
    const now = () => times[Math.min(t++, times.length - 1)];

    await expect(
      pollOmrResult("job-1", {
        fetchFn,
        sleep: async () => {},
        intervalMs: 10,
        timeoutMs: 1000,
        now,
      }),
    ).rejects.toThrow("timed out");
  });
});
