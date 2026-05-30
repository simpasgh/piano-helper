// Pure, dependency-free OMR helpers. No Cloudflare types so this typechecks and
// unit-tests in plain Node. Shared by the POST/GET handlers and mirrored client-side.

export const ALLOWED_MIME = new Set<string>([
  "application/pdf",
  "image/png",
  "image/jpeg",
]);

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB

export type ValidationResult =
  | { ok: true }
  | { ok: false; status: number; error: string };

export function validateUpload(input: {
  contentType: string;
  size: number;
}): ValidationResult {
  if (!ALLOWED_MIME.has(input.contentType)) {
    return {
      ok: false,
      status: 415,
      error: "Unsupported file type. Use PDF, PNG, or JPEG.",
    };
  }
  if (input.size > MAX_UPLOAD_BYTES) {
    return {
      ok: false,
      status: 413,
      error: "File too large. Maximum size is 10 MB.",
    };
  }
  return { ok: true };
}

export function uploadKey(jobId: string): string {
  return `uploads/${jobId}`;
}

export function resultKey(jobId: string): string {
  return `results/${jobId}.musicxml`;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(s: string): boolean {
  return UUID_RE.test(s);
}
