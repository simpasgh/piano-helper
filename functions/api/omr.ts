// Cloudflare Pages Function: POST /api/omr
// Validates an uploaded sheet (PDF/PNG/JPEG), stores it in R2, and fires a GitHub
// repository_dispatch so a runner can do the heavy OMR offline. Returns a jobId.
import { uploadKey, validateUpload } from "./_omr";

const DEFAULT_REPO = "simpasgh/piano-helper";

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
    // Fail soft (not 500) until infra wires the binding + secret in prod.
    if (!env.OMR_BUCKET || !env.GITHUB_DISPATCH_TOKEN) {
      return json({ error: "OMR is not configured" }, 503);
    }

    const contentType = request.headers.get("Content-Type") || "";
    const url = new URL(request.url);
    const filename = url.searchParams.get("filename") || "sheet";

    const body = await request.arrayBuffer();
    const check = validateUpload({ contentType, size: body.byteLength });
    if (!check.ok) {
      return json({ error: check.error }, check.status);
    }

    const jobId = crypto.randomUUID();
    await env.OMR_BUCKET.put(uploadKey(jobId), body, {
      httpMetadata: { contentType },
    });

    const repo = env.GITHUB_REPOSITORY || DEFAULT_REPO;
    const dispatch = await fetch(
      `https://api.github.com/repos/${repo}/dispatches`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.GITHUB_DISPATCH_TOKEN}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "piano-helper-omr",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          event_type: "omr-job",
          client_payload: { jobId, contentType, filename },
        }),
      },
    );

    if (!dispatch.ok) {
      const detail = await dispatch.text().catch(() => "");
      return json(
        { error: `Failed to start OMR job (${dispatch.status}). ${detail}` },
        502,
      );
    }

    return json({ jobId }, 202);
  } catch (err) {
    return json({ error: (err as Error).message || "Unexpected error" }, 500);
  }
};
