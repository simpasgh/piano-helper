// Pure, framework-free helpers for the admin feature-flag endpoint (functions/api/flags.ts) and the
// admin UI (src/admin.ts). No R2, no fetch, no Cloudflare globals here so it stays unit-testable in
// plain Vitest, exactly like src/omr-server.ts.
//
// These flags are OMR worker behaviour. The admin page writes an allowlisted subset of them to an R2
// config object (config/omr-flags.json); the always-on worker reads that object each poll cycle and
// applies it onto its os.environ, so a toggle takes effect with no restart. This module owns the
// ALLOWLIST and the validation so a malformed or malicious POST can never write an unknown key (and
// the paid OMR_LLM flag is deliberately absent, so it can never be enabled from the web).

// The exact env-var names the worker reads. MUST stay in sync with omr-worker/flag_config.py
// KNOWN_FLAGS (a source-guard test in flags-server.test.ts reads that file as text and asserts the
// two lists match). OMR_LLM is intentionally NOT here: it calls a paid API, so it is box-env-only.
export const KNOWN_FLAGS = [
  "OMR_ENSEMBLE",
  "OMR_ENSEMBLE_REFEREE",
  "OMR_GEOM",
  "OMR_GEOM_PRIMARY",
  "OMR_GEOM_FUSION",
  "OMR_PHOTO_CLARITY",
  "OMR_UVDOC",
  "OMR_PROGRESSIVE",
  "OMR_PROGRESSIVE_PAGES",
  "OMR_PROGRESSIVE_BLOCKS",
] as const;

export type FlagKey = (typeof KNOWN_FLAGS)[number];

// The R2 config shape: every value is the string "0" or "1" (matching how the worker reads env vars).
export type FlagConfig = Partial<Record<FlagKey, "0" | "1">>;

const KNOWN_FLAG_SET: ReadonlySet<string> = new Set(KNOWN_FLAGS);

// Coerce a single flag value to "1"/"0" or null if it is not a recognizable on/off value. Accepts the
// canonical strings, the booleans the admin UI sends, and the numbers 0/1, so the endpoint is lenient
// about value shape while still rejecting anything ambiguous.
function coerceFlagValue(value: unknown): "0" | "1" | null {
  if (value === "1" || value === true || value === 1) return "1";
  if (value === "0" || value === false || value === 0) return "0";
  return null;
}

// Sanitize an untrusted POST body into a clean FlagConfig: keep ONLY known flag keys whose value
// coerces to "0"/"1", drop everything else. Returns null when the input is not a plain object (so the
// caller can 400). Unknown keys and bad values are silently dropped rather than failing the whole
// request, so the object written to R2 can only ever contain allowlisted flags with "0"/"1" values.
export function sanitizeFlagConfig(input: unknown): FlagConfig | null {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }
  const out: FlagConfig = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!KNOWN_FLAG_SET.has(key)) continue;
    const coerced = coerceFlagValue(value);
    if (coerced !== null) out[key as FlagKey] = coerced;
  }
  return out;
}

// Whether a flag value (as read back from the config) is the "on" string. Used by the UI to seed
// toggles; the worker has its own equivalent in Python.
export function isFlagOn(value: "0" | "1" | undefined): boolean {
  return value === "1";
}

// Compare in constant time across the candidate length so a wrong token of the RIGHT length cannot
// leak a matching prefix via response timing. A length mismatch short-circuits (the secret's own
// entropy, not its hidden length, is the protection); that is standard and adequate for a
// high-entropy shared secret checked over the network.
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Validate an Authorization header against the configured admin token. FAILS CLOSED: an unset or
// empty token rejects every request, so a missing secret never leaves the endpoint open. Expects the
// header value "Bearer <token>".
export function isAuthorized(
  authHeader: string | null | undefined,
  token: string | null | undefined,
): boolean {
  if (!token) return false; // fail closed: no configured secret => nobody is authorized.
  if (typeof authHeader !== "string") return false;
  const prefix = "Bearer ";
  if (!authHeader.startsWith(prefix)) return false;
  return safeEqual(authHeader.slice(prefix.length), token);
}
