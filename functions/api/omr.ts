/// <reference types="@cloudflare/workers-types" />

import { validateUpload, uploadKey } from "../../src/omr-server";

interface Env {
  OMR_BUCKET: R2Bucket;
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface FilePart {
  arrayBuffer(): Promise<ArrayBuffer>;
  type: string;
}

function isFilePart(value: unknown): value is FilePart {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { arrayBuffer?: unknown }).arrayBuffer === "function"
  );
}

// Extract the raw bytes plus content type from the request. Prefers a multipart
// "file" field; falls back to the raw request body when no form part is present.
async function readUpload(
  request: Request,
): Promise<{ bytes: ArrayBuffer; contentType: string | null }> {
  const reqType = request.headers.get("content-type") ?? "";
  if (reqType.includes("multipart/form-data")) {
    const form = await request.formData();
    // The Workers runtime returns a File for a file field, but this types version
    // narrows FormData.get() to string | null. Feature-detect arrayBuffer at runtime
    // instead of relying on the (overly narrow) static type.
    const entry = form.get("file") as unknown;
    if (isFilePart(entry)) {
      return {
        bytes: await entry.arrayBuffer(),
        contentType: entry.type || null,
      };
    }
  }
  // Fallback: raw body, trust the request Content-Type header.
  const bytes = await request.arrayBuffer();
  return {
    bytes,
    contentType: reqType ? reqType.split(";")[0].trim() : null,
  };
}

// Accept a sheet-music upload, validate it, and store it in R2 under
// uploads/<jobId>. An external always-on worker (omr-worker/) polls R2, runs the
// OMR engine, and writes results/<jobId>.musicxml back. There is no GitHub Actions
// dispatch and no token here: the worker discovers the upload by listing R2.
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.OMR_BUCKET) {
    return json({ error: "OMR is not configured." }, 503);
  }

  let upload: { bytes: ArrayBuffer; contentType: string | null };
  try {
    upload = await readUpload(request);
  } catch {
    return json({ error: "Could not read the uploaded file." }, 400);
  }

  const { bytes, contentType } = upload;
  const check = validateUpload(contentType, bytes.byteLength);
  if (!check.ok) {
    return json({ error: check.error ?? "Invalid upload." }, check.status);
  }

  const jobId = crypto.randomUUID();
  const key = uploadKey(jobId);

  try {
    await env.OMR_BUCKET.put(key, bytes, {
      httpMetadata: { contentType: contentType ?? undefined },
    });
  } catch {
    return json({ error: "Failed to store the upload." }, 502);
  }

  return json({ jobId }, 202);
};
