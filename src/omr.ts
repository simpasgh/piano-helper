// Client module for the OMR pipeline. Mirrors the server validation, POSTs the raw
// file to /api/omr, then polls /api/omr/result until the MusicXML is ready.
// fetch, the poll interval, attempt cap, and sleep are injectable so this is unit-testable.

const ALLOWED_MIME = new Set<string>([
  "application/pdf",
  "image/png",
  "image/jpeg",
]);
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB, mirrors functions/api/_omr.ts
const DEFAULT_INTERVAL_MS = 3000;
// A cold oemer run on a runner (model download + inference, plus a possible homr
// fallback and pip installs) can take several minutes, so poll generously.
const DEFAULT_MAX_ATTEMPTS = 300; // ~15 minutes at 3s

// The runner writes this sentinel MusicXML to the result key when both engines
// fail, so the browser stops polling. Detect it and surface a real error instead
// of silently loading a near-empty score. Kept in sync with .github/workflows/omr.yml.
const FAILURE_SENTINEL_RE = /name="omr-status"\s*>\s*failed/;

export function isFailureSentinel(xml: string): boolean {
  return FAILURE_SENTINEL_RE.test(xml);
}

type FetchFn = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

type SleepFn = (ms: number) => Promise<void>;

export interface OmrOptions {
  fetch?: FetchFn;
  intervalMs?: number;
  maxAttempts?: number;
  sleep?: SleepFn;
}

const realSleep: SleepFn = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Returns an error message if the file is unusable, or null if it passes.
export function validateSheetFile(file: File): string | null {
  if (!ALLOWED_MIME.has(file.type)) {
    return "Unsupported file type. Use PDF, PNG, or JPEG.";
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return "File too large. Maximum size is 10 MB.";
  }
  return null;
}

export async function requestOmr(
  file: File,
  opts: OmrOptions = {},
): Promise<{ jobId: string }> {
  const doFetch = opts.fetch ?? fetch;
  const res = await doFetch(
    `/api/omr?filename=${encodeURIComponent(file.name)}`,
    {
      method: "POST",
      headers: { "Content-Type": file.type },
      body: file,
    },
  );

  if (res.status === 503) {
    throw new Error("OMR is not configured");
  }
  if (res.status !== 202) {
    throw new Error(await errorMessage(res, "Failed to start OMR job"));
  }

  const data = (await res.json()) as { jobId?: string };
  if (!data.jobId) {
    throw new Error("OMR job did not return a jobId");
  }
  return { jobId: data.jobId };
}

export async function pollOmrResult(
  jobId: string,
  opts: OmrOptions = {},
): Promise<string> {
  const doFetch = opts.fetch ?? fetch;
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const sleep = opts.sleep ?? realSleep;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const res = await doFetch(
      `/api/omr/result?jobId=${encodeURIComponent(jobId)}`,
    );

    if (res.status === 200) {
      const xml = await res.text();
      if (isFailureSentinel(xml)) {
        throw new Error(
          "Could not recognize any notes in this sheet. Try a clearer scan.",
        );
      }
      return xml;
    }
    if (res.status === 503) {
      throw new Error("OMR is not configured");
    }
    if (res.status !== 404) {
      throw new Error(await errorMessage(res, "OMR result check failed"));
    }
    // 404 means still pending: wait and retry.
    await sleep(intervalMs);
  }

  throw new Error("OMR timed out. The sheet may be too complex to convert.");
}

export async function convertSheetToMusicXml(
  file: File,
  opts: OmrOptions = {},
): Promise<string> {
  const { jobId } = await requestOmr(file, opts);
  return pollOmrResult(jobId, opts);
}

async function errorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const data = (await res.json()) as { error?: string };
    if (data && typeof data.error === "string") return data.error;
  } catch {
    // Body was not JSON; fall through to the generic message.
  }
  return `${fallback} (${res.status})`;
}
