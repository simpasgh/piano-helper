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

- **2026-05-30 - OMR compute moved OFF GitHub Actions to an Oracle Always Free ARM VM (issue #5, PR #18).**
  Reason: running OMR on Actions runners uses Actions as the app's runtime compute backend, which
  breaks GitHub's Actions usage policy and risks account suspension. The "public repo = unlimited
  minutes" point from the earlier spike does not make this allowed. `.github/workflows/omr.yml` was
  DELETED. New backend: an always-on Python worker (`omr-worker/`, committed in the repo) on an
  Oracle Cloud Always Free `VM.Standard.A1.Flex` (Ubuntu 22.04 ARM), run by systemd
  (`omr-worker.service`, restart on failure). Cost stays $0: Oracle Always Free ARM (up to 4 OCPU /
  24 GB) plus the existing free Cloudflare R2.
  - **Trigger is now "VM polls R2 `uploads/*`"** (default every 5s, env `OMR_POLL_SECONDS`). There is
    NO `repository_dispatch` and NO GitHub PAT anymore. The Pages Function `POST /api/omr` only
    validates and writes the upload to R2 and returns 202 `{jobId}`; it notifies nobody.
  - **R2 transport contract unchanged:** input `uploads/<jobId>`, output
    `results/<jobId>.musicxml`, plus the failure-sentinel MusicXML when both engines fail. R2 bucket
    is still `piano-helper-omr` with the `OMR_BUCKET` Pages binding.
  - **Credential moves:** the four R2 S3 creds (`R2_S3_ENDPOINT`, `R2_ACCESS_KEY_ID`,
    `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`) move from GitHub Actions secrets to VM env vars in a
    root-owned `/etc/piano-helper-omr.env` (chmod 600), loaded by the systemd unit. The Pages
    Function secret `GITHUB_DISPATCH_TOKEN` and var `GITHUB_REPOSITORY` are now UNUSED and should be
    removed from the Pages project; the GitHub fine-grained PAT can be revoked.
  - **Runbook** (provision Ubuntu ARM deps: `apt install poppler-utils python3 python3-venv`, venv +
    `pip install -r requirements.txt`; set the four R2 env vars; install + enable the systemd unit)
    lives in `omr-worker/README.md`, with a keep-alive note: Oracle reclaims Always Free VMs that sit
    under ~20% CPU over a 7-day window, so a tiny periodic CPU nudge (cron) keeps the worker alive.
  - The "OMR Actions workflow built" and "OMR trigger ... repository_dispatch" entries below are
    SUPERSEDED by this one (kept for history).

- **2026-05-30 - OMR Actions workflow built + R2 bucket `piano-helper-omr` created (issue #5).**
  Added `.github/workflows/omr.yml`: triggers ONLY on `repository_dispatch` (event_type
  `omr-job`, fired by the Pages Function) and manual `workflow_dispatch` (a `jobId` input
  for testing). No `pull_request`/`push` trigger, so it can never run on a PR or on a push
  to `main` and cannot fail a required check or turn `main` red before the secrets exist.
  `concurrency: omr-<jobId>` coalesces duplicate dispatches; `permissions: contents: read`.
  Steps: checkout -> validate jobId (rejects anything outside `[A-Za-z0-9_-]`) -> setup
  Python 3.10 -> install `poppler-utils` + `pip install oemer` -> `aws s3 cp` the upload
  from `s3://$R2_BUCKET/uploads/<jobId>` (AWS CLI is preinstalled on `ubuntu-latest`) ->
  sniff MIME and rasterize PDFs first page with `pdftoppm -png -r 300` -> run oemer ->
  homr fallback (`pip install homr`) only if oemer fails -> if BOTH fail, write a minimal
  valid `score-partwise` **error sentinel** MusicXML (work-title "OMR failed",
  `omr-status=failed`) so the browser poll terminates instead of hanging -> `aws s3 cp`
  `result.musicxml` to `s3://$R2_BUCKET/results/<jobId>.musicxml` with
  `--content-type application/vnd.recordare.musicxml+xml`. **Something always lands at the
  result key.**

  **R2 bucket `piano-helper-omr` was created** via local OAuth wrangler:
  `npx wrangler r2 bucket create piano-helper-omr` (Standard storage; confirmed via
  `wrangler r2 bucket list`). The default-bound binding name wrangler suggests is
  `piano_helper_omr`, but the Pages Function contract requires the binding be named
  **`OMR_BUCKET`** (set that name when adding the R2 binding to the Pages project).

  **Interface contract (must match the Pages Function the app agent built):**
  - R2 keys: input `uploads/<jobId>` (raw bytes, original content-type),
    output `results/<jobId>.musicxml` (UTF-8 MusicXML).
  - Dispatch: `repository_dispatch` event_type `omr-job`,
    client_payload `{ jobId, contentType, filename }`.

  **Secret/var names, BOTH sides:**
  - Actions secrets the workflow reads (4): `R2_S3_ENDPOINT`, `R2_ACCESS_KEY_ID`,
    `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` (value `piano-helper-omr`). The workflow maps
    the first three onto `AWS_*` env and sets `AWS_DEFAULT_REGION=auto`.
  - Pages Function (app agent owns; documented here only): R2 binding **`OMR_BUCKET`**,
    secret `GITHUB_DISPATCH_TOKEN` (fine-grained PAT, this repo, Actions read+write),
    var `GITHUB_REPOSITORY` = `simpasgh/piano-helper`.

  **RUNBOOK (copy-paste; run from the repo root). Tokens are NOT minted here on purpose;
  each must be created by hand in the dashboard, then wired in.**

  1) R2 bucket (DONE, listed here for reproducibility):
  ```bash
  npx wrangler r2 bucket create piano-helper-omr
  ```

  2) Mint the R2 S3 API token: Cloudflare dashboard -> R2 -> "Manage R2 API Tokens" ->
     "Create API token". Permission **Object Read & Write**, scope to bucket
     `piano-helper-omr`. Copy the **Access Key ID**, **Secret Access Key**, and the
     **S3 endpoint** (`https://<ACCOUNT_ID>.r2.cloudflarestorage.com`). Then set the four
     Actions secrets:
  ```bash
  gh secret set R2_S3_ENDPOINT      --body 'https://<ACCOUNT_ID>.r2.cloudflarestorage.com'
  gh secret set R2_ACCESS_KEY_ID    --body '<R2_ACCESS_KEY_ID>'
  gh secret set R2_SECRET_ACCESS_KEY --body '<R2_SECRET_ACCESS_KEY>'
  gh secret set R2_BUCKET           --body 'piano-helper-omr'
  ```

  3) Mint the GitHub fine-grained PAT for the Pages Function: GitHub -> Settings ->
     Developer settings -> Fine-grained tokens -> "Generate new token". Resource owner
     `simpasgh`, repository access = only `simpasgh/piano-helper`, Repository permissions:
     **Actions: Read and write** (this is what allows firing `repository_dispatch`). Copy
     the token; it is the Pages Function's `GITHUB_DISPATCH_TOKEN`.

  4) Wire the Pages Function bindings (Cloudflare dashboard -> Workers & Pages ->
     `piano-helper` -> Settings):
     - Functions -> R2 bucket bindings: add binding **`OMR_BUCKET`** -> bucket
       `piano-helper-omr` (do this for Production, and Preview if used).
     - Environment variables and secrets:
       - secret `GITHUB_DISPATCH_TOKEN` = the PAT from step 3 (encrypt),
       - var `GITHUB_REPOSITORY` = `simpasgh/piano-helper`.
     - Note: the R2 binding can also be declared in `wrangler.toml` /
       `wrangler.jsonc` under `[[r2_buckets]]` with `binding = "OMR_BUCKET"`,
       `bucket_name = "piano-helper-omr"` if the Function build reads config from file.

  5) Smoke-test the runner path without the Function: upload any PNG to
     `uploads/<jobId>` in R2, then
     `gh workflow run omr.yml -f jobId=<jobId>`, and check that
     `results/<jobId>.musicxml` appears.

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

### OMR (issue #5) setup status

Architecture as of 2026-05-30 (PR #18): VM worker polls R2; no Actions, no PAT.

- [x] R2 bucket `piano-helper-omr` created (`wrangler r2 bucket create`).
- [x] `.github/workflows/omr.yml` DELETED (OMR no longer runs on Actions; ToS reasons).
- [x] VM worker committed at `omr-worker/` (`worker.py`, `omr-worker.service`,
      `requirements.txt`, `README.md` runbook).
- [ ] Provision the Oracle Always Free ARM VM (Ubuntu 22.04, `VM.Standard.A1.Flex`) and
      install deps per `omr-worker/README.md`. (manual)
- [ ] Mint R2 S3 API token (Object Read & Write, bucket `piano-helper-omr`). (manual)
- [ ] On the VM, set the four R2 env vars in `/etc/piano-helper-omr.env` (chmod 600):
      `R2_S3_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET=piano-helper-omr`.
- [ ] Install + enable the systemd unit (`systemctl enable --now omr-worker.service`).
- [ ] Add the idle keep-alive cron (Oracle reclaims idle Always Free VMs).
- [ ] Bind on Pages project: R2 binding `OMR_BUCKET` -> `piano-helper-omr`. (app + infra)
- [ ] Remove the now-unused Pages secret `GITHUB_DISPATCH_TOKEN` and var
      `GITHUB_REPOSITORY`; revoke the GitHub fine-grained PAT.
- [ ] End-to-end smoke: upload to `uploads/<jobId>` (UUID), confirm the worker writes
      `results/<jobId>.musicxml` and deletes the upload.
