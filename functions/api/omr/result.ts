/// <reference types="@cloudflare/workers-types" />

import { resultKey, errorKey, isValidJobId } from "../../../src/omr-server";

interface Env {
  OMR_BUCKET: R2Bucket;
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
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

  const err = await env.OMR_BUCKET.get(errorKey(jobId));
  if (err) {
    const reason = await err.text();
    return json({ error: reason || "OMR failed." }, 422);
  }

  return json({ status: "pending" }, 404);
};
