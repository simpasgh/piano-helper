import { describe, it, expect, vi } from "vitest";
import {
  submitOmr,
  pollOmrResult,
  isFailureSentinel,
  isPartial,
  partialFrontier,
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

    const jobId = await submitOmr(fakeFile(), { fetchFn });
    expect(jobId).toBe("job-1");

    const call = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe("/api/omr");
    expect(call[1].method).toBe("POST");
    expect(call[1].body).toBeInstanceOf(FormData);
    expect((call[1].body as FormData).get("file")).toBeInstanceOf(File);
    // The upload never carries a "fast" field (the fast-scan opt-out was removed; every scan
    // is the full accurate path now).
    expect((call[1].body as FormData).get("fast")).toBeNull();
  });

  it("throws the server error when submission fails", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({ error: "File too large." }, 413),
    ) as unknown as typeof fetch;

    await expect(submitOmr(fakeFile(), { fetchFn })).rejects.toThrow("File too large.");
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

// A progressive in-progress result: the omr-status="partial" + omr-version markers the worker
// stamps (omr-worker/progressive.py). The body is otherwise a normal score so it renders.
const partialXml = (version: number, body = "<part/>") =>
  `<score-partwise><identification><miscellaneous>` +
  `<miscellaneous-field name="omr-status">partial</miscellaneous-field>` +
  `<miscellaneous-field name="omr-version">${version}</miscellaneous-field>` +
  `</miscellaneous></identification>${body}</score-partwise>`;

// A block-by-block streaming partial: it ALSO carries the system frontier (omr-systems-total /
// omr-systems-done) the worker stamps for the per-system loader.
const partialXmlWithFrontier = (
  version: number,
  total: number,
  done: number,
  body = "<part/>",
) =>
  `<score-partwise><identification><miscellaneous>` +
  `<miscellaneous-field name="omr-status">partial</miscellaneous-field>` +
  `<miscellaneous-field name="omr-version">${version}</miscellaneous-field>` +
  `<miscellaneous-field name="omr-systems-total">${total}</miscellaneous-field>` +
  `<miscellaneous-field name="omr-systems-done">${done}</miscellaneous-field>` +
  `</miscellaneous></identification>${body}</score-partwise>`;

describe("isPartial", () => {
  it("detects the worker's partial marker", () => {
    expect(isPartial(partialXml(1))).toBe(true);
  });

  it("does not flag a complete score or the failure sentinel", () => {
    expect(isPartial("<score-partwise><part/></score-partwise>")).toBe(false);
    expect(isPartial(SENTINEL_XML)).toBe(false);
  });
});

describe("partialFrontier", () => {
  it("parses the system frontier a block-streaming partial carries", () => {
    expect(partialFrontier(partialXmlWithFrontier(2, 6, 3))).toEqual({
      total: 6,
      done: 3,
    });
  });

  it("returns null for a partial with no frontier (fast-then-refine / per-page)", () => {
    expect(partialFrontier(partialXml(1))).toBeNull();
  });

  it("returns null when only one frontier field is present", () => {
    const onlyTotal =
      `<score-partwise><identification><miscellaneous>` +
      `<miscellaneous-field name="omr-systems-total">6</miscellaneous-field>` +
      `</miscellaneous></identification></score-partwise>`;
    expect(partialFrontier(onlyTotal)).toBeNull();
  });

  it("accepts done == 0 (lead-in: nothing finalized, system 0 active)", () => {
    expect(partialFrontier(partialXmlWithFrontier(1, 4, 0))).toEqual({
      total: 4,
      done: 0,
    });
  });

  it("accepts done == total (all systems finalized in this partial)", () => {
    expect(partialFrontier(partialXmlWithFrontier(3, 4, 4))).toEqual({
      total: 4,
      done: 4,
    });
  });

  it("rejects a nonsensical frontier (done past total, or zero systems)", () => {
    expect(partialFrontier(partialXmlWithFrontier(1, 4, 5))).toBeNull();
    expect(partialFrontier(partialXmlWithFrontier(1, 0, 0))).toBeNull();
  });
});

describe("pollOmrResult progressive partials", () => {
  it("renders each partial then returns the complete result", async () => {
    const responses = [
      textResponse(partialXml(1), 200),
      textResponse(partialXml(2), 200),
      textResponse("<score-partwise><part/></score-partwise>", 200),
    ];
    let i = 0;
    const fetchFn = vi.fn(async () => responses[i++]) as unknown as typeof fetch;
    const sleep = vi.fn(async () => {});
    const partials: Array<{ xml: string; version: number }> = [];

    const xml = await pollOmrResult("job-1", {
      fetchFn,
      sleep,
      now: () => 0,
      onPartial: (xml, version) => {
        partials.push({ xml, version });
      },
    });

    // Both partials are delivered (in order, with their versions), then the complete is returned.
    expect(partials.map((p) => p.version)).toEqual([1, 2]);
    expect(partials[0].xml).toContain('name="omr-status">partial');
    expect(xml).toBe("<score-partwise><part/></score-partwise>");
    // Polled three times (two partials + the complete), sleeping between each.
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("forwards the system frontier of a block-streaming partial to onPartial", async () => {
    const responses = [
      textResponse(partialXmlWithFrontier(1, 6, 1), 200), // system 1 of 6 finalized
      textResponse(partialXmlWithFrontier(2, 6, 2), 200), // system 2 of 6 finalized
      textResponse("<score-partwise><part/></score-partwise>", 200),
    ];
    let i = 0;
    const fetchFn = vi.fn(async () => responses[i++]) as unknown as typeof fetch;
    const frontiers: Array<{ total: number; done: number } | null> = [];

    await pollOmrResult("job-1", {
      fetchFn,
      sleep: async () => {},
      now: () => 0,
      onPartial: (_xml, _version, frontier) => {
        frontiers.push(frontier);
      },
    });

    // The frontier advances with the stream (1 done, then 2 done), out of 6 total.
    expect(frontiers).toEqual([
      { total: 6, done: 1 },
      { total: 6, done: 2 },
    ]);
  });

  it("does not re-render a repeated partial of the same version", async () => {
    const responses = [
      textResponse(partialXml(1), 200),
      textResponse(partialXml(1), 200), // same version: must be ignored
      textResponse("<score-partwise><part/></score-partwise>", 200),
    ];
    let i = 0;
    const fetchFn = vi.fn(async () => responses[i++]) as unknown as typeof fetch;
    const onPartial = vi.fn();

    await pollOmrResult("job-1", {
      fetchFn,
      sleep: async () => {},
      now: () => 0,
      onPartial,
    });

    expect(onPartial).toHaveBeenCalledTimes(1);
    // The frontier-less partial passes null as the third arg (no per-system loader).
    expect(onPartial).toHaveBeenCalledWith(expect.stringContaining("partial"), 1, null);
  });

  it("keeps polling past a partial even when no onPartial handler is given", async () => {
    const responses = [
      textResponse(partialXml(1), 200), // skipped (no handler), not returned
      textResponse("<score-partwise><part/></score-partwise>", 200),
    ];
    let i = 0;
    const fetchFn = vi.fn(async () => responses[i++]) as unknown as typeof fetch;
    const sleep = vi.fn(async () => {});

    const xml = await pollOmrResult("job-1", { fetchFn, sleep, now: () => 0 });

    // The partial is NOT mistaken for the final result; the complete is what resolves.
    expect(xml).toBe("<score-partwise><part/></score-partwise>");
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("awaits an async onPartial before polling again", async () => {
    const order: string[] = [];
    const responses = [
      textResponse(partialXml(1), 200),
      textResponse("<score-partwise><part/></score-partwise>", 200),
    ];
    let i = 0;
    const fetchFn = vi.fn(async () => {
      order.push(`poll-${i}`);
      return responses[i++];
    }) as unknown as typeof fetch;

    await pollOmrResult("job-1", {
      fetchFn,
      sleep: async () => {},
      now: () => 0,
      onPartial: async () => {
        await Promise.resolve();
        order.push("render-partial");
      },
    });

    // The partial render completes before the next poll is issued (poll-0, render, poll-1).
    expect(order).toEqual(["poll-0", "render-partial", "poll-1"]);
  });

  it("throws the failure sentinel even after a partial was rendered", async () => {
    const responses = [
      textResponse(partialXml(1), 200),
      textResponse(SENTINEL_XML, 200),
    ];
    let i = 0;
    const fetchFn = vi.fn(async () => responses[i++]) as unknown as typeof fetch;
    const onPartial = vi.fn();

    await expect(
      pollOmrResult("job-1", {
        fetchFn,
        sleep: async () => {},
        now: () => 0,
        onPartial,
      }),
    ).rejects.toThrow("Could not recognize any notes");
    expect(onPartial).toHaveBeenCalledTimes(1); // the partial still rendered before the failure
  });
});
