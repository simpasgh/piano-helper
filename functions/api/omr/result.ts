// Cloudflare Pages Function: GET /api/omr/result?jobId=...
// Reads the MusicXML the runner wrote to R2. 404 while pending, 200 with the XML
// once ready, so R2 itself stays server-side.
import { isUuid, resultKey } from "../_omr";

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export const onRequestGet = async (context: {
  request: Request;
  env: Record<string, any>;
}): Promise<Response> => {
  const { request, env } = context;
  try {
    if (!env.OMR_BUCKET) {
      return json({ error: "OMR is not configured" }, 503);
    }

    const url = new URL(request.url);
    const jobId = url.searchParams.get("jobId") || "";
    if (!isUuid(jobId)) {
      return json({ error: "Invalid or missing jobId" }, 400);
    }

    const object = await env.OMR_BUCKET.get(resultKey(jobId));
    if (!object) {
      return json({ status: "pending" }, 404);
    }

    return new Response(object.body, {
      status: 200,
      headers: { "Content-Type": "application/vnd.recordare.musicxml+xml" },
    });
  } catch (err) {
    return json({ error: (err as Error).message || "Unexpected error" }, 500);
  }
};
