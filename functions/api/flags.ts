/// <reference types="@cloudflare/workers-types" />

import {
  sanitizeFlagConfig,
  isAuthorized,
  type FlagConfig,
} from "../../src/flags-server";

interface Env {
  OMR_BUCKET: R2Bucket;
  // Shared admin secret, set as a Secret env var in the Cloudflare Pages dashboard. Unset => every
  // request is rejected (fail closed), so a missing secret never leaves this endpoint open.
  ADMIN_TOKEN: string;
}

// R2 key holding the live OMR feature-flag override the worker polls (omr-worker/flag_config.py
// CONFIG_KEY). Kept in sync with that constant.
const CONFIG_KEY = "config/omr-flags.json";

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Shared precondition check for both verbs: R2 must be bound and the request must carry the matching
// Bearer token. isAuthorized fails closed when ADMIN_TOKEN is unset, so an unconfigured admin secret
// returns the SAME 401 as a wrong token (no pre-auth oracle that reveals whether the secret is set
// yet). Returns an error Response, or null when allowed.
function gate(request: Request, env: Env): Response | null {
  if (!env.OMR_BUCKET) return json({ error: "OMR is not configured." }, 503);
  if (!isAuthorized(request.headers.get("Authorization"), env.ADMIN_TOKEN)) {
    return json({ error: "Unauthorized." }, 401);
  }
  return null;
}

// Read the current override config from R2 (the allowlisted, validated subset), or {} if none has been
// written yet.
async function readConfig(env: Env): Promise<FlagConfig> {
  const obj = await env.OMR_BUCKET.get(CONFIG_KEY);
  if (!obj) return {};
  try {
    return sanitizeFlagConfig(JSON.parse(await obj.text())) ?? {};
  } catch {
    return {};
  }
}

// GET /api/flags -> the current flag override config. Token-gated so the page is fully walled.
export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const blocked = gate(request, env);
  if (blocked) return blocked;
  return json({ flags: await readConfig(env) }, 200);
};

// POST /api/flags -> replace the flag override config. The body is an object of flag -> "0"/"1";
// sanitizeFlagConfig keeps only allowlisted flags with valid values (OMR_LLM and any unknown key are
// dropped), so the worker can only ever be handed allowlisted flags. Takes effect on the worker within
// one poll cycle (~5s), no restart.
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const blocked = gate(request, env);
  if (blocked) return blocked;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Body must be JSON." }, 400);
  }
  const sanitized = sanitizeFlagConfig(body);
  if (sanitized === null) {
    return json({ error: "Body must be a flag object." }, 400);
  }

  try {
    await env.OMR_BUCKET.put(CONFIG_KEY, JSON.stringify(sanitized), {
      httpMetadata: { contentType: "application/json" },
    });
  } catch {
    return json({ error: "Failed to store the flags." }, 502);
  }
  return json({ flags: sanitized }, 200);
};
