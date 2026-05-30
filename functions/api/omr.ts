/// <reference types="@cloudflare/workers-types" />

import {
  validateUpload,
  buildDispatchRequest,
  uploadKey,
} from "../../src/omr-server";

interface Env {
  OMR_BUCKET: R2Bucket;
  GITHUB_DISPATCH_TOKEN: string;
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
  return { bytes, contentType: reqType ? reqType.split(";")[0].trim() : null };
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  let upload: { bytes: ArrayBuffer; contentType: string | null };
  try {
    upload = await readUpload(request);
  } catch {
    return json({ error: "Could not read the uploaded file." }, 400);
  }

  const { bytes, contentType } = upload;
  const check = validateUpload(contentType, bytes.byteLength);
  if (!check.ok || !check.ext) {
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

  const dispatch = buildDispatchRequest(env.GITHUB_DISPATCH_TOKEN, jobId, check.ext);
  let dispatchRes: Response;
  try {
    dispatchRes = await fetch(dispatch.url, {
      method: dispatch.method,
      headers: dispatch.headers,
      body: dispatch.body,
    });
  } catch {
    // Best-effort cleanup so a failed dispatch does not leak orphan uploads.
    await env.OMR_BUCKET.delete(key).catch(() => {});
    return json({ error: "Could not reach the OMR job dispatcher." }, 502);
  }

  if (!dispatchRes.ok) {
    await env.OMR_BUCKET.delete(key).catch(() => {});
    return json({ error: "Failed to start the OMR job." }, 502);
  }

  return json({ jobId }, 202);
};
