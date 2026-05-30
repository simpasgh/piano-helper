/// <reference types="@cloudflare/workers-types" />

import { resultKey, isValidJobId } from "../../../src/omr-server";

interface Env {
  OMR_BUCKET: R2Bucket;
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Read the OMR result for a job from R2. Returns 200 + MusicXML once the worker
// has written results/<jobId>.musicxml, or 404 { status: "pending" } while absent.
// Recognition failure is carried inside the MusicXML (an omr-status="failed"
// sentinel the worker writes) and detected client-side, so there is no separate
// error key or 422 path here.
export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.OMR_BUCKET) {
    return json({ error: "OMR is not configured." }, 503);
  }

  const url = new URL(request.url);
  const jobId = url.searchParams.get("jobId");
  if (!isValidJobId(jobId)) {
    return json({ error: "Missing or invalid jobId." }, 400);
  }

  const xml = await env.OMR_BUCKET.get(resultKey(jobId));
  if (xml) {
    return new Response(xml.body, {
      status: 200,
      headers: { "Content-Type": "application/vnd.recordare.musicxml+xml" },
    });
  }

  return json({ status: "pending" }, 404);
};
