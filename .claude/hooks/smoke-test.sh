#!/usr/bin/env bash
# Smoke-test a deployed Piano Helper build. Usage: smoke-test.sh [url]
# Falls back to the PROD_URL env var. Passes only if the site is up AND the built
# JS bundle is actually served (catches blank/placeholder deploys).
set -euo pipefail

URL="${1:-${PROD_URL:-}}"
if [ -z "$URL" ]; then
  echo "FAIL: no URL given and PROD_URL is not set" >&2
  exit 1
fi
URL="${URL%/}"

echo "Smoke-testing $URL"

html=$(curl -fsSL --max-time 20 "$URL/") || {
  echo "FAIL: $URL/ did not return a successful response" >&2
  exit 1
}

asset=$(printf '%s' "$html" | grep -oE '/assets/[A-Za-z0-9._-]+\.js' | head -1 || true)
if [ -z "$asset" ]; then
  echo "FAIL: no built JS bundle referenced in HTML (blank or placeholder deploy?)" >&2
  exit 1
fi

code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$URL$asset")
if [ "$code" != "200" ]; then
  echo "FAIL: asset $asset returned HTTP $code" >&2
  exit 1
fi

echo "PASS: $URL is up and serving $asset"
