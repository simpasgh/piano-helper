// Browser-side OMR client: submit a scan and poll for the resulting MusicXML.
// DOM-free and dependency-injectable so it can be unit-tested with fakes.
//
// Compute runs on an external always-on worker that polls R2 (omr-worker/). The
// worker always writes results/<jobId>.musicxml; on recognition failure it writes
// a valid-but-empty MusicXML carrying an omr-status="failed" sentinel instead of a
// separate error object. So the result endpoint only ever returns 200 (ready) or
// 404 (pending), and this client detects the sentinel and raises a real error so
// the app never silently loads a blank score as success.

type FetchFn = typeof fetch;

// Matches the sentinel the worker writes when both OMR engines fail. Kept in sync
// with omr-worker/worker.py (FAILURE_SENTINEL) and functions/api/omr/result.ts.
const FAILURE_SENTINEL_RE = /name="omr-status"\s*>\s*failed/;

export function isFailureSentinel(xml: string): boolean {
  return FAILURE_SENTINEL_RE.test(xml);
}

// Matches the omr-status="partial" marker the worker stamps on a PROGRESSIVE in-progress result
// (omr-worker/progressive.py stamp_partial): the score-so-far, written to the result key while the
// rest is still being recognized. A partial is rendered AND polling continues; only a complete
// (unmarked) result or the failure sentinel ends the poll. Kept in sync with progressive.py.
const PARTIAL_SENTINEL_RE = /name="omr-status"\s*>\s*partial/;
// The monotonic version the worker stamps beside the status, so the client re-renders a partial
// only when it actually changed (a repeat poll of the same partial is a no-op).
const PARTIAL_VERSION_RE = /name="omr-version"\s*>\s*(\d+)/;

export function isPartial(xml: string): boolean {
  return PARTIAL_SENTINEL_RE.test(xml);
}

function partialVersion(xml: string): number {
  const match = xml.match(PARTIAL_VERSION_RE);
  return match ? Number(match[1]) : 0;
}

// Sentinel thrown by pollOmrResult when the caller abandons the wait (the #86 Cancel
// button / Escape key). The OMR job keeps running server-side and cannot truly abort,
// so this is a CLIENT-SIDE abandon: the poll loop stops and rejects with this error.
// It is NOT a real failure, so the scan caller checks isCancelled() and swallows it
// (no alert, no "Scan failed" status), distinguishing it from a genuine error.
export const OMR_CANCELLED = "OMR_CANCELLED";

export function isCancelled(err: unknown): boolean {
  return err instanceof Error && err.message === OMR_CANCELLED;
}

export interface SubmitOptions {
  fetchFn?: FetchFn;
}

export async function submitOmr(
  file: File,
  options: SubmitOptions = {},
): Promise<string> {
  const { fetchFn = fetch } = options;
  const form = new FormData();
  form.append("file", file);

  const res = await fetchFn("/api/omr", { method: "POST", body: form });
  if (!res.ok) {
    const message = await readError(res, "Failed to submit the scan.");
    throw new Error(message);
  }

  const data = (await res.json()) as { jobId?: string };
  if (!data.jobId) {
    throw new Error("Server did not return a job id.");
  }
  return data.jobId;
}

export interface PollOptions {
  fetchFn?: FetchFn;
  intervalMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  // Returns true once the user has abandoned the wait (Cancel / Escape). Checked
  // before each request and before each sleep so a cancel takes effect promptly;
  // when it returns true the loop rejects with OMR_CANCELLED.
  isCancelledRequested?: () => boolean;
  // Called for each PROGRESSIVE partial result (omr-status="partial") so the caller can render the
  // score-so-far while polling continues. Receives the MusicXML and its monotonic version, and is
  // invoked only when the version increases (an unchanged partial is not re-rendered). Awaited, so
  // the caller can serialize an async render before the next poll. The poll still RESOLVES only on
  // the final complete result (or rejects on failure / cancel / timeout), so a caller that omits
  // onPartial simply waits for the complete result exactly as before.
  onPartial?: (xml: string, version: number) => void | Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Poll /api/omr/result until the job resolves. Returns the COMPLETE MusicXML on 200,
// unless that MusicXML is the failure sentinel (then it throws a friendly error). When
// progressive publishing is on the worker writes earlier PARTIAL results to the same key
// (omr-status="partial"); each is passed to options.onPartial and polling continues, so
// the score-so-far renders while the rest is still computing. Treats 404 as "still
// pending" and throws on timeout. A cold worker run (model download + inference + the
// progressive refine) can take several minutes, hence the generous default timeout.
export async function pollOmrResult(
  jobId: string,
  options: PollOptions = {},
): Promise<string> {
  const {
    fetchFn = fetch,
    intervalMs = 3000,
    timeoutMs = 900000, // 15 minutes
    sleep = defaultSleep,
    now = () => Date.now(),
    isCancelledRequested = () => false,
    onPartial,
  } = options;

  const start = now();
  const url = `/api/omr/result?jobId=${encodeURIComponent(jobId)}`;
  // Highest partial version rendered so far, so a repeat poll of the same partial is a no-op.
  let lastPartialVersion = -1;

  for (;;) {
    if (isCancelledRequested()) {
      throw new Error(OMR_CANCELLED);
    }
    const res = await fetchFn(url, { method: "GET" });

    if (res.status === 200) {
      const xml = await res.text();
      if (isFailureSentinel(xml)) {
        throw new Error(
          "Could not recognize any notes in this sheet. Try a clearer scan.",
        );
      }
      if (isPartial(xml)) {
        // An in-progress result: hand it to the caller to render, then KEEP polling for the
        // complete one. Dedupe by the embedded version so the same partial is not re-rendered.
        const version = partialVersion(xml);
        if (onPartial && version > lastPartialVersion) {
          lastPartialVersion = version;
          await onPartial(xml, version);
        }
        // Fall through to the wait below (200 does not match the non-2xx error checks).
      } else {
        // No partial marker and not the failure sentinel: this is the final complete result.
        return xml;
      }
    }
    // Fail fast on a definitive error (bad jobId, OMR not configured) instead of
    // polling uselessly for the full timeout. 404 is "pending"; other 5xx are
    // treated as transient and retried.
    if (res.status !== 404 && res.status >= 400 && res.status < 500) {
      const message = await readError(res, "Scan failed. Please try again.");
      throw new Error(message);
    }
    if (res.status === 503) {
      const message = await readError(res, "OMR is not available right now.");
      throw new Error(message);
    }
    // 404 (pending) or a transient 5xx: keep waiting until timeout.
    if (now() - start >= timeoutMs) {
      throw new Error("Scan timed out. Please try again.");
    }
    if (isCancelledRequested()) {
      throw new Error(OMR_CANCELLED);
    }
    await sleep(intervalMs);
  }
}

async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const data = (await res.json()) as { error?: string };
    return data.error || fallback;
  } catch {
    return fallback;
  }
}
