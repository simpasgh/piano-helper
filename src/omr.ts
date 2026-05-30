// Browser-side OMR client: submit a scan and poll for the resulting MusicXML.
// DOM-free and dependency-injectable so it can be unit-tested with fakes.

type FetchFn = typeof fetch;

export async function submitOmr(file: File, fetchFn: FetchFn = fetch): Promise<string> {
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
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Poll /api/omr/result until the job resolves. Returns MusicXML on 200, throws the
// server reason on 422, throws on timeout. Treats 404 as "still pending".
export async function pollOmrResult(
  jobId: string,
  options: PollOptions = {},
): Promise<string> {
  const {
    fetchFn = fetch,
    intervalMs = 3000,
    timeoutMs = 300000,
    sleep = defaultSleep,
    now = () => Date.now(),
  } = options;

  const start = now();
  const url = `/api/omr/result?jobId=${encodeURIComponent(jobId)}`;

  for (;;) {
    const res = await fetchFn(url, { method: "GET" });

    if (res.status === 200) {
      return await res.text();
    }
    if (res.status === 422) {
      const message = await readError(res, "OMR could not read this sheet.");
      throw new Error(message);
    }
    // 404 (pending) or any transient status: keep waiting until timeout.
    if (now() - start >= timeoutMs) {
      throw new Error("Scan timed out. Please try again.");
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
