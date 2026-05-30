# Infrastructure context

Hosting, CI/CD, release workflow, tooling, costs. Append durable learnings at the top of
the relevant section, dated.

## Hard constraint: everything free

All infra/tooling must be **free with no caps or only very large ones**. Never add a paid
service or a tier that could realistically hit a ceiling. Call out any cap explicitly.

Accounts available:
- **Cloudflare** — owns the `todeo.app` domain. Host = **Cloudflare Pages** (free:
  unlimited bandwidth/requests, 500 builds/month).
- **Vercel** — free Hobby only (100 GB/mo, non-commercial). Caps; not the primary host.
- **GitHub** — free; repo is **public**, so **GitHub Actions minutes are unlimited**.

## Hosting

- **Cloudflare Pages**, deployed to the free `*.pages.dev` URL (no DNS setup). A custom
  `todeo.app` subdomain can be added later.
- Build command `npm run build`, output dir `dist/`.

## CI/CD

- **2026-05-30 - OMR trigger (planned, not built) adds a Cloudflare Pages Function proxy + a GitHub PAT secret + an R2 bucket, all free.** The async OMR pipeline (issue #5) will be triggered by a Pages Function in this same Pages project (`functions/api/`), so no separate Worker or project. It needs: a GitHub fine-grained PAT (minimal scope: this repo, Actions read/write) stored as a Function secret to fire `repository_dispatch`; an R2 binding on the Function, plus an R2 S3 API token as an Actions secret so the runner can read the upload and write the result. Pages Functions bill on the Workers free tier (100k requests/day shared with Workers, 10ms CPU/invocation), which a thin dispatch + R2-put proxy stays well under (OMR itself runs on the runner). R2 free tier: 10 GB-month storage, 1M Class A + 10M Class B ops/month, used for both the upload and the MusicXML result. Caps to watch (both very large for a hobby OMR tool): the 100k/day combined Functions+Workers request quota and the R2 monthly op counts. Full rationale and rejected alternatives are in tech-lead.md (same date).

- **2026-05-30:** Bumped all JS actions to their Node 24-native majors ahead of GitHub's
  2026-06-16 force-switch of runner actions from Node 20 to Node 24 (full removal
  2026-09-16): `actions/checkout` v4 -> v5, `actions/setup-node` v4 -> v5,
  `cloudflare/wrangler-action` v3 -> v4 (deploy only). Also moved the build's own
  `node-version` from 20 to 22 since Node 20 hit EOL in April 2026. Note: `wrangler-action`
  v4 now installs Wrangler CLI v4 by default (our `pages deploy dist` usage is compatible).

- **CI (`.github/workflows/ci.yml`)** runs on every PR/push: typecheck + build + unit tests.
  This is the required status check that gates merges.
- **Deploy (`.github/workflows/deploy.yml`)** runs on push to `main`: build -> deploy to
  Cloudflare Pages (wrangler) -> **smoke test the live prod URL**.
- **Code review runs locally** through the Claude Code subscription (Tech Lead + /code-review),
  NOT a CI Claude action, to avoid Anthropic API charges.

## Release / merge rules

See [../workflow.md](../workflow.md). Summary: trunk-based, short-lived branches rebased on
`main`; PR + passing CI + up-to-date + linear history required before merge; deploy + prod
smoke test after merge.

## Deploy gating (so `main` stays green before infra exists)

`deploy.yml` is guarded by `if: vars.DEPLOY_ENABLED == 'true'`. Until that repo variable is
set, the deploy job is skipped, so merging to `main` never fails on missing Cloudflare
secrets. Flip it to `true` only after the Cloudflare project + secrets are in place.

Repo **variables** (Settings -> Secrets and variables -> Actions -> Variables):
- `DEPLOY_ENABLED` = `true` to turn deploys on.
- `CF_PAGES_PROJECT` = Cloudflare Pages project name (defaults to `piano-helper` if unset).
- `PROD_URL` = stable prod URL to smoke-test (defaults to the per-deploy URL Cloudflare returns).

Repo **secrets**: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.

## Live deployment (done)

- **Prod URL:** https://piano-helper.pages.dev (smoke test green).
- **Cloudflare account:** `pasculli.simone@gmail.com` (account ID stored as the
  `CLOUDFLARE_ACCOUNT_ID` repo secret, not committed since the repo is public).
- **Pages project:** `piano-helper`, production branch `main`.
- Local `wrangler` is authenticated via OAuth (scopes incl. `pages (write)`), so manual
  `wrangler pages deploy dist` works from this machine without any token.

## Setup status

- [x] Cloudflare Pages project created (`piano-helper`).
- [x] First deploy live + smoke test green.
- [x] Repo variables `PROD_URL`, `CF_PAGES_PROJECT` set.
- [x] Repo secret `CLOUDFLARE_ACCOUNT_ID` set.
- [x] Repo secret `CLOUDFLARE_API_TOKEN` set (dedicated `piano-helper-deploy` token,
      Account > Cloudflare Pages > Edit; separate from the todeo/finpilot tokens).
- [x] Repo variable `DEPLOY_ENABLED=true` (CI deploy + prod smoke test verified green).
