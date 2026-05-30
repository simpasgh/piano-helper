---
description: Smoke-test the live prod deployment (loads, serves assets, app boots)
argument-hint: "[url, defaults to the prod pages.dev URL]"
allowed-tools: Bash, Read
---

Smoke-test the deployed Piano Helper. Target URL: `$1` if given, else the project's prod
`*.pages.dev` URL (see [docs/context/infrastructure.md](../../docs/context/infrastructure.md);
falls back to the `PROD_URL` env var).

Run the script and report pass/fail with details:

```bash
bash .claude/hooks/smoke-test.sh "$1"
```

The smoke test passes only if:
- The site returns HTTP 200.
- The HTML references the built JS bundle (the app actually shipped, not a blank/placeholder).
- The main script asset returns 200.

If it fails, this is a release-blocker: report exactly what failed and stop. Do not declare a
release successful while smoke is red.
