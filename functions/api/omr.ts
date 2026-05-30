// Cloudflare Pages Function: POST /api/omr
// Validates an uploaded sheet (PDF/PNG/JPEG) and stores it in R2 under uploads/<jobId>.
// An always-on worker on an Oracle Always Free ARM VM polls R2 for new uploads, runs the
// heavy OMR offline, and writes the MusicXML back to results/<jobId>.musicxml. The
// Function does not notify anyone; the worker discovers the job by listing R2.
import { uploadKey, validateUpload } from "./_omr";

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export const onRequestPost = async (context: {
  request: Request;
  env: Record<string, any>;
}): Promise<Response> => {
  const { request, env } = context;
  try {
    // Fail soft (not 500) until infra wires the R2 binding in prod.
    if (!env.OMR_BUCKET) {
      return json({ error: "OMR is not configured" }, 503);
    }

    const contentType = request.headers.get("Content-Type") || "";

    const body = await request.arrayBuffer();
    const check = validateUpload({ contentType, size: body.byteLength });
    if (!check.ok) {
      return json({ error: check.error }, check.status);
    }

    const jobId = crypto.randomUUID();
    await env.OMR_BUCKET.put(uploadKey(jobId), body, {
      httpMetadata: { contentType },
    });

    return json({ jobId }, 202);
  } catch (err) {
    return json({ error: (err as Error).message || "Unexpected error" }, 500);
  }
};
