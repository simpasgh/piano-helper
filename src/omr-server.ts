// Pure, framework-free helpers for the OMR Pages Functions. No R2, no fetch, no
// Cloudflare globals here so this stays unit-testable in plain Vitest.

export const MAX_UPLOAD_BYTES = 12 * 1024 * 1024; // 12 MB

export const GITHUB_REPO = "simpasgh/piano-helper";
export const DISPATCH_EVENT_TYPE = "omr-job";

export type OmrExt = "png" | "jpg" | "jpeg" | "pdf";

// Map an accepted MIME type to the file extension carried in the dispatch payload.
// Returns null for any type we do not accept. jpeg maps to "jpg" for a tidy key,
// while the payload still validates jpg/jpeg/png/pdf downstream.
const MIME_TO_EXT: Record<string, OmrExt> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "application/pdf": "pdf",
};

export function mimeToExt(contentType: string | null | undefined): OmrExt | null {
  if (!contentType) return null;
  // Strip any parameters, e.g. "image/png; charset=binary".
  const base = contentType.split(";")[0].trim().toLowerCase();
  return MIME_TO_EXT[base] ?? null;
}

export interface UploadValidation {
  ok: boolean;
  status: number; // HTTP status to use on failure
  error?: string;
  ext?: OmrExt;
}

// Validate a candidate upload by MIME type and byte length. Pure: callers pass in
// the already-known contentType and size.
export function validateUpload(
  contentType: string | null | undefined,
  size: number,
): UploadValidation {
  const ext = mimeToExt(contentType);
  if (!ext) {
    return {
      ok: false,
      status: 400,
      error: "Unsupported file type. Upload a PNG, JPEG, or PDF.",
    };
  }
  if (!Number.isFinite(size) || size <= 0) {
    return { ok: false, status: 400, error: "Empty file." };
  }
  if (size > MAX_UPLOAD_BYTES) {
    return {
      ok: false,
      status: 400,
      error: `File too large. Max ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))} MB.`,
    };
  }
  return { ok: true, status: 202, ext };
}

export interface DispatchRequest {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: string;
}

// Build the repository_dispatch HTTP request to fire the OMR Actions workflow.
export function buildDispatchRequest(
  token: string,
  jobId: string,
  ext: OmrExt,
): DispatchRequest {
  return {
    url: `https://api.github.com/repos/${GITHUB_REPO}/dispatches`,
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "piano-helper-omr",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({
      event_type: DISPATCH_EVENT_TYPE,
      client_payload: { jobId, ext },
    }),
  };
}

// A jobId is always a crypto.randomUUID() we minted. Validate the shape before
// using it as an R2 key so the result endpoint never reads an attacker-shaped key.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isValidJobId = (jobId: string | null | undefined): jobId is string =>
  typeof jobId === "string" && UUID_RE.test(jobId);

export const uploadKey = (jobId: string): string => `uploads/${jobId}`;
export const resultKey = (jobId: string): string => `results/${jobId}.musicxml`;
export const errorKey = (jobId: string): string => `results/${jobId}.error`;
