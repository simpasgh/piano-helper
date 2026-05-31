import { describe, it, expect, vi } from "vitest";
import {
  submitOmr,
  pollOmrResult,
  isFailureSentinel,
  isCancelled,
  OMR_CANCELLED,
} from "./omr";

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

const SENTINEL_XML = `<?xml version="1.0"?>
<score-partwise>
  <identification>
    <miscellaneous>
      <miscellaneous-field name="omr-status">failed</miscellaneous-field>
    </miscellaneous>
  </identification>
</score-partwise>`;

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
      jsonResponse({ error: "File too large." }, 413),
    ) as unknown as typeof fetch;

    await expect(submitOmr(fakeFile(), fetchFn)).rejects.toThrow("File too large.");
  });
});

describe("isFailureSentinel", () => {
  it("detects the worker's failure sentinel MusicXML", () => {
    expect(isFailureSentinel(SENTINEL_XML)).toBe(true);
  });

  it("does not flag a real score", () => {
    expect(isFailureSentinel("<score-partwise><part/></score-partwise>")).toBe(false);
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

  it("throws a friendly error when the result is the failure sentinel", async () => {
    const fetchFn = vi.fn(async () =>
      textResponse(SENTINEL_XML, 200),
    ) as unknown as typeof fetch;

    await expect(
      pollOmrResult("job-1", { fetchFn, sleep: async () => {}, now: () => 0 }),
    ).rejects.toThrow("Could not recognize any notes");
  });

  it("fails fast on a definitive client error instead of polling", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({ error: "Missing or invalid jobId." }, 400),
    ) as unknown as typeof fetch;
    const sleep = vi.fn(async () => {});

    await expect(
      pollOmrResult("job-1", { fetchFn, sleep, now: () => 0 }),
    ).rejects.toThrow("Missing or invalid jobId.");
    expect(sleep).not.toHaveBeenCalled();
  });

  it("fails fast when OMR is not configured (503)", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({ error: "OMR is not configured." }, 503),
    ) as unknown as typeof fetch;
    const sleep = vi.fn(async () => {});

    await expect(
      pollOmrResult("job-1", { fetchFn, sleep, now: () => 0 }),
    ).rejects.toThrow("OMR is not configured.");
    expect(sleep).not.toHaveBeenCalled();
  });

  it("rejects with the cancelled sentinel when cancel is requested before the first poll", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({ status: "pending" }, 404),
    ) as unknown as typeof fetch;
    const sleep = vi.fn(async () => {});

    await expect(
      pollOmrResult("job-1", {
        fetchFn,
        sleep,
        now: () => 0,
        isCancelledRequested: () => true,
      }),
    ).rejects.toThrow(OMR_CANCELLED);
    // It bailed before issuing any request, so the abandon is immediate.
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("rejects with the cancelled sentinel when cancel is requested mid-poll", async () => {
    let cancelled = false;
    const fetchFn = vi.fn(async () => {
      // Request the cancel after the first pending response comes back.
      cancelled = true;
      return jsonResponse({ status: "pending" }, 404);
    }) as unknown as typeof fetch;
    const sleep = vi.fn(async () => {});

    await expect(
      pollOmrResult("job-1", {
        fetchFn,
        sleep,
        intervalMs: 10,
        timeoutMs: 100000,
        now: () => 0,
        isCancelledRequested: () => cancelled,
      }),
    ).rejects.toThrow(OMR_CANCELLED);
    // Polled once, then saw the cancel before sleeping and bailed without waiting.
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("isCancelled distinguishes the cancelled sentinel from a real failure", async () => {
    // The sentinel error is recognized...
    const cancelErr = await pollOmrResult("job-1", {
      fetchFn: (async () => jsonResponse({}, 404)) as unknown as typeof fetch,
      sleep: async () => {},
      now: () => 0,
      isCancelledRequested: () => true,
    }).catch((e) => e);
    expect(isCancelled(cancelErr)).toBe(true);

    // ...but a genuine failure is NOT, so the caller will surface it.
    expect(isCancelled(new Error("Scan failed. Please try again."))).toBe(false);
    expect(isCancelled(new Error("Could not recognize any notes"))).toBe(false);
    expect(isCancelled("not an error")).toBe(false);
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
