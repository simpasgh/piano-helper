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

## Assets

- **2026-05-30 - Piano audio (issue #13) streams from the Tone.js sample CDN, not our infra.** The
  sampled piano (Salamander Grand, CC-BY 3.0) loads mp3 buffers at runtime from
  `https://tonejs.github.io/audio/salamander/` (official, uncapped, free). No mp3s in the repo, no R2
  bucket, no bandwidth on our Pages project for audio. ~30 small mp3 files, fetched lazily in the
  background; if the CDN is unreachable the app falls back to the synth.

## CI/CD

- **2026-05-31 - OMR engine migration (#135): Clarity-OMR is now the PRIMARY engine for PDF uploads (so ties survive PDF -> MusicXML); oemer -> homr -> failure sentinel stays as the fallback. Deploy artifacts + runbook shipped, NOT yet installed on the live host.** Worker change is in `omr-worker/worker.py` (other role owns that file). Infra side:
  - **How it runs:** Clarity (github.com/clquwu/Clarity-OMR, GPL-3.0, pure Python, CPU-only, Apple Silicon + Linux ARM) lives in its OWN separate py3.11 venv and is invoked by `worker.py` as a subprocess, exactly like oemer. The worker does NOT import Clarity, so its torch / ultralytics-YOLO / transformers stack never collides with oemer's onnxruntime / opencv / numpy band in the existing `omr-worker/.venv`. PDF uploads try Clarity first; PNG/JPEG skip it and go straight to oemer.
  - **Two env vars + fallback:** `worker.py` reads `CLARITY_OMR_DIR` (the cloned repo dir, must contain `omr.py`) and `CLARITY_PYTHON` (that repo's venv python). If either is unset, or the script is missing, `run_clarity` returns None and the worker silently falls back to oemer. So the worker.py change is SAFE to deploy before Clarity is installed: until both vars point at a real install, PDFs just keep using oemer. Invocation argv: `[CLARITY_PYTHON, <DIR>/omr.py, <pdf>, "-o", <out.musicxml>, "--device", "cpu", "--fast", "--work-dir", <workdir>]`.
  - **Footprint:** ~1.5 GB venv (mostly torch CPU) + a ~336 MB ONE-TIME HuggingFace model download (yolo.pt + model.safetensors + a timm backbone) on first run. ~15s CPU per page.
  - **Free-tier guard / model caching:** the ONLY rate limit in the whole pipeline is HuggingFace's unauthenticated model-download THROTTLE on that one-time fetch. It is NOT a per-request or per-scan cost, so we never hit a usage cap and stay inside the free / no-paid-service rule. Mitigate the first-fetch throttle by caching the model on the worker host (it persists in the HF cache dir, e.g. `~/.cache/huggingface`, after the first run so later scans never re-download) and optionally by setting a FREE `HF_TOKEN` env var for the initial download only. Warm it once by hand after install.
  - **Artifacts created/edited this session:** new `omr-worker/requirements-clarity.txt` (documents the clone + py3.11 venv + `pip install -r <repo>/requirements.txt` install rather than re-pinning torch; Clarity deps deliberately NOT added to `requirements.txt` so the engines stay isolated). `omr-worker/README.md` gained a "Clarity-OMR (primary engine for PDFs)" section (install, model caching, optional free HF_TOKEN, GPL-3.0, the two env vars + fallback). README env-file blocks (Linux `/etc/piano-helper-omr.env` and Mac `~/piano-helper-omr/omr.env`) and the systemd-service note now show the two `CLARITY_*` vars belong alongside the R2 creds; `omr-worker.service`'s existing `EnvironmentFile` already passes them through, so the live unit needs no edit.
  - **LIVE DEPLOY (Mac, launchd-managed) still pending and is a TWO-part manual step:** (1) the `worker.py` change is the long-running launchd process, so it does not go live until copied into `~/piano-helper-omr/worker.py` and the service is kickstarted: `launchctl kickstart -k gui/$(id -u)/com.pianohelper.omr` (same gotcha as every prior worker.py redeploy below). (2) Clarity itself only runs once its venv is installed AND `CLARITY_OMR_DIR` + `CLARITY_PYTHON` are added to `~/piano-helper-omr/omr.env` (then re-kickstart so `run.sh` re-sources the env). Until then the deployed worker transparently falls back to oemer for PDFs, so `main` stays green and the migration is reversible (drop the two vars to revert to oemer-first).
- **2026-05-31 - OMR tie spike, ML engine install footprints (all FREE/CPU/ARM, no shipping yet): Clarity-OMR installs cleanly, olimpic/Zeus has a TensorFlow version trap.** Clarity-OMR (GPL-3.0): `pip install -r requirements.txt` in a py3.11 venv just works on Apple Silicon (~1.5 GB venv, torch CPU) + ~336 MB one-time HuggingFace model download (`yolo.pt` + `model.safetensors` + a timm backbone), reads PDF directly, ~15s CPU per page. olimpic/Zeus (CC BY-SA, TensorFlow): its `requirements.txt` pins `tensorflow~=2.12.0` which **has NO wheel for macOS arm64 / py3.11** (pip: available versions start at 2.13.0) - install `tensorflow==2.15.1` instead (last Keras-2 line; arm64 wheel exists, loads the 2024 weights fine). Zeus also needs the input pre-sliced into single staff systems and a hand-built dataset pickle, so it is NOT a drop-in worker engine. Both stay inside the free/no-caps rule. NB on the Oracle ARM Linux move: same TF-version caveat would apply (use 2.15+, CPU build).
- **2026-05-31 - OMR tie spike: Audiveris is FREE and installable within our constraints, but was rejected on fidelity (see tech-lead.md), so no infra change. If ever revisited: Audiveris 5.10.2 ships a self-contained jpackage bundle that carries its OWN JRE + arm64 Tesseract/Leptonica + pdfbox, so it needs NO system Java, Tesseract, or poppler.** AGPL-3.0 (free). macOS arm64 `.dmg` and Ubuntu 22.04/24.04 arm... note: the published .deb assets are x86_64 only, so the Oracle ARM VM would need the macOS-style bundle equivalent or a from-source/Gradle build (JRE bundled either way). Bundle is ~70 MB DMG / ~250 MB installed. The DMG has an AGPL click-through SLA: attach non-interactively with `printf 'Y\n' | hdiutil attach <dmg> -nobrowse`. Batch CLI: `Audiveris.app/Contents/MacOS/Audiveris -batch -export -output <dir> -- <input.pdf|png>` (reads PDF directly via pdfbox, no pdftoppm). Stays inside the free/no-caps rule; it just doesn't recover ties on our material.
- **2026-05-31 - TWO DEPLOY PATHS, don't conflate them. A change goes live by ONE of two mechanisms depending on which file it touched:**
  - **Frontend (`src/**`, `index.html`, anything in the Vite app) -> Cloudflare Pages auto-deploys on push to `main`.** No Mac worker, no `launchctl`, no manual step. A hard refresh (or new bundle hash) is all the user needs. The `src/score.ts` tie-merge fix (#123/#124) is frontend: confirmed live in prod bundle `index-B93iGaIx.js` (greps `tieId`), so restarting the OMR worker does NOTHING for it.
  - **OMR engine (`omr-worker/worker.py`) -> manual redeploy to the live Mac worker + `launchctl kickstart -k gui/$(id -u)/com.pianohelper.omr`.** Cloudflare deploys never touch this process; see the per-PR redeploy entries below.
  - **Trap:** "the OMR fix didn't work, do I restart the server?" is often a frontend fix that's already live, OR an engine-ceiling limit (e.g. oemer dropping `<tie>` markup so the frontend tie-merge can't fire on a scanned PDF, per #121). Check WHICH file the fix touched before reaching for `launchctl`.
- **2026-05-31 - Legal posture + cost-scaling analysis (founder request). General guidance, not legal advice.** Captured so future sessions do not redo it.
  - **Legal:** we host no catalog, users bring their own scores, OMR is a transformation tool (a scanner/format-converter). Keep uploads **transient (convert then discard)** to minimize copyright + privacy exposure. The R2 contract already deletes `uploads/<jobId>` after processing, which is the right default. Do NOT build a shared/public library of copyrighted scores (that converts us from a transient tool into a host/distributor and forfeits the simplest legal posture). DMCA safe harbor (17 USC 512) is the fallback if we ever store user content: it needs a registered DMCA agent ($6 USPTO filing, one-time, the only legal cost worth noting) + a notice/takedown flow. ToS must put upload responsibility on the user, disclaim OMR accuracy ("as is, no warranty"), and forbid redistributing others' copyrighted output. Privacy: transient processing keeps us nearly out of GDPR/CCPA scope (no stored personal data, nothing to export/delete); a saved-library feature flips that on and pulls in retention + disclosure + deletion duties. Audio import = higher risk lane (copyrighted recordings, plus the earlier YouTube-ToS no-go in product.md): sequence **user-owned-audio only**, never URL ingestion.
  - **Cost cliff in numbers:** the binding limit is **throughput/queue wait, NOT dollars** (the host is free). The interim Mac worker is serial, ~4-5 min/scan (was 6.5 at 400 DPI, now 350), one scan at a time. ~12-15 scans/hr theoretical; realistically ~100-200 scans/day before queue waits turn user-hostile (>10-15 min), and far less since the Mac is not 24/7. Product.md already pegs the design ceiling at **~600-1000 conversions/month**. The Cloud Run fallback's real cap is ~50 instance-hours/mo of CPU-active time at ~2 GiB (the 360,000 GiB-s tier), ≈ ~600-1000 scans/mo, with cold starts + the 60-min request cap as awkwardness, not blockers.
  - **Scaling path (free as long as possible):** (1) move off the Mac onto the committed **Oracle Always Free ARM A1** (up to 4 OCPU / 24 GB) via the capacity-retry = $0, true 24/7, biggest single throughput win; add a real queue so bursts wait gracefully instead of failing. Serves up to ~100-200+ scans/day. (2) Add a **2nd/3rd free worker** (another Oracle tenancy/region, or the Cloud Run fallback as a parallel overflow consumer) behind the same R2 queue = $0, ~2-3x throughput. (3) **FIRST PAID STEP (conscious choice, founder sign-off):** one small dedicated-CPU VM (Hetzner CX22 ~EUR 4-5/mo, or a DigitalOcean/Vultr ~$6/mo box, or Cloud Run with min-instances) running the same host-agnostic worker. Serves low thousands of scans/mo. GUESS on per-box throughput; depends on core count.
  - **Trigger metric:** act when **median queue wait > ~5 min** OR sustained **> ~150 scans/day** OR monthly conversions approach ~600-800 (the free-tier knee). Cheapest correct action at that moment is **adding a free parallel worker (Oracle/Cloud Run), not paying.** Only pay when free parallelism is exhausted AND volume still climbs.
  - **Revenue vs compute:** at base scale ($39 one-time Pro, Stripe ~2.9% + $0.30 = ~$37.84 net per sale) ONE Pro sale funds ~7-9 months of the first paid VM (~EUR 4-5/mo). Compute is NOT the business constraint; **conversion rate is.** Even a 1% free->paid rate on ~1,250 activated users/mo = ~12-13 sales = ~$470/mo net, dwarfing any free-tier-overflow compute bill. The cost cliff is real for UX (queue wait) but trivial for the P&L.
  - **Recommendation:** cheapest viable architecture for the base scenario (~1,250 activated users/mo, a few thousand scans/mo) = **Oracle ARM A1 worker + R2 job queue + the per-user conversion cap (3/day, 10/mo) from product.md**, all $0. That cap plus one free 24/7 box keeps a few-thousand-scans/mo product inside free tier. First paid step if forced: a single ~EUR 4-5/mo Hetzner CX22 as a 2nd parallel worker, funded many times over by a single Pro sale. Keep the worker host-agnostic (already true) so this stays config-only.
- **2026-05-31 - Deployed #119 (#118/#112) to the live Mac worker: lowered `PDF_RASTER_DPI` 400 -> 350 in `omr-worker/worker.py` and restarted launchd. Clean.** PR #119 drops the rasterization DPI from 400 to 350. Confirmed the worktree/origin-main source has `PDF_RASTER_DPI = 350` (`git show origin/main:omr-worker/worker.py`). Live file was still at 400. Backed up the live 400-DPI file to `~/piano-helper-omr/worker.py.bak-118-dpi350-20260531-142728`, copied the new worker.py over `~/piano-helper-omr/worker.py`, then `launchctl kickstart -k gui/$(id -u)/com.pianohelper.omr`. Did NOT touch `omr.env` (R2 creds, left untouched) or the plist/run.sh. **Verification:** live file now greps `PDF_RASTER_DPI = 350`; launchd `state = running`, new pid 74764; `worker.log` shows a single fresh clean line `2026-05-31T14:27:35 OMR worker started; bucket=piano-helper-omr interval=5.0s` with no FATAL/traceback. Same restart-required gotcha as before: worker.py is the long-running launchd process, so a code change does not go live until copied in and the job is kickstarted.
- **2026-05-31 - REVERTED #113 on the live Mac worker: redeployed `omr-worker/worker.py` back to the #109 state and restarted launchd. The LH chord-completion post-pass (which fabricated spurious sharps) is GONE from the live worker.** PR #116 reverts the #113/#114 `complete_lh_chords` post-pass. Since the worker runs locally (not touched by Cloudflare Pages deploys), the live `~/piano-helper-omr/worker.py` was still the OLD #113 code until this redeploy. **Deploy steps (same as #113):** confirmed the worktree source `omr-worker/worker.py` (16788 bytes) was byte-identical to the prior #109 backup `worker.py.bak-20260531-124128` (`diff` empty), had `complete_lh_chords` x0 and all #109 markers, and `ast.parse`-checked clean with the deploy venv python. Backed up the live #113 file (27563 bytes) to `~/piano-helper-omr/worker.py.bak-#113-20260531-131709`, copied the reverted file (27563 -> 16788 bytes), then `launchctl kickstart -k gui/$(id -u)/com.pianohelper.omr`. Did NOT touch `omr.env` (still May 30 13:00, 507 bytes, untouched) or the plist. **Verification:** live file now has `complete_lh_chords` x0 (reverted code gone) and the #109 markers survive (`PDF_RASTER_DPI` x4 lines, `stitch_pages_vertical` x2, `--without-deskew` x3 - not a stale/partial deploy). launchd `state = running`, new pid 61074; `worker.log` shows a single fresh clean line `2026-05-31T13:17:13 OMR worker started; bucket=piano-helper-omr interval=5.0s` with no FATAL/traceback. **Log slice for QA:** pre-restart offset was 17159446 bytes / 1741 lines; QA should read this run from **line 1742 onward**. QA owns the live re-scan to confirm the fabricated accidentals are gone.
- **2026-05-31 - Oracle Always Free ARM launch tooling now EXISTS in the repo (the "do the oracle thingy" deliverable). It is written but NOT yet run; landing the VM is still gated on the user running it with their own OCI creds + on Oracle ARM capacity freeing up.** New files under `omr-worker/`: (1) `oracle-launch.sh` - the capacity-retry launcher: loops `oci compute instance launch` for `VM.Standard.A1.Flex` (default full Always Free 4 OCPU / 24 GB, configurable), retries on `Out of host capacity` / `Out of capacity for shape` / `InternalError` / 429 / 5xx with jittered 30-90s backoff (forever by default, `MAX_ATTEMPTS` caps it), and STOPS on real errors (`NotAuthenticated`/`NotAuthorized`/`LimitExceeded`/`InvalidParameter`/etc). It is idempotent (detects an already-RUNNING `piano-helper-omr` instance and exits), takes all OCIDs via env/`oracle.env` (no hardcoded secrets/OCIDs), and has cost guards that REFUSE any non-Always-Free shape and cap ARM at 4 OCPU / 24 GB. (2) `oracle-cloud-init.yaml` - `#cloud-config` user-data referenced by the launcher: on first boot installs `poppler-utils`+python venv+git, clones the repo to `/opt/piano-helper`, builds the venv with the SAME two-step install the Mac uses (`pip install -r requirements.txt` then `pip install --no-deps -r requirements-oemer.txt`, so it does NOT pull `onnxruntime-gpu`), installs+enables `omr-worker.service`, and adds the keep-alive cron. It deliberately does NOT write the R2 creds (user-data is readable from instance metadata), so the unit is enabled-but-not-started until you SSH in once and create `/etc/piano-helper-omr.env`, then `systemctl restart omr-worker`. (3) `oracle.env.example` - template for the 5 required OCIDs (compartment, subnet, image, AD, ssh pub key) with the exact `oci ... list` one-liners to find each; copy to `oracle.env` (gitignored). (4) `ORACLE.md` - precise copy-pasteable manual runbook (account+region choice, `oci setup config` API-key auth, VCN wizard, collecting OCIDs, running the retry loop, finishing the worker on the VM, end-to-end R2 verify, decommissioning the Mac). (5) `omr-worker/.gitignore` - keeps `oracle.env`, `*.env`, and `.venv/` out of git. Keep-alive is the same `*/15` cron CPU nudge already documented, now auto-installed by cloud-init. All stays $0: only A1.Flex/E2.1.Micro allowed, 50 GB boot inside the 200 GB Always Free block-storage, ephemeral (free) public IP not a reserved one, no upgrade to PAYG. Both shell scripts pass `bash -n`. **Open: capacity in home region eu-madrid-1 (single AD) is still the blocker; if creating a fresh tenancy, pick a MULTI-AD region for better free-capacity odds since Always Free only launches in the home region and it cannot be changed.**
- **2026-05-31 - BE-hosting research refresh (free-tier states re-confirmed for the OMR-worker host decision).** Re-checked the live 2026 free tiers of every candidate against the "$0, no caps or only very large" rule. Findings: **Fly.io** has NO permanent free tier (2-hour / 7-day trial then a card is mandatory; minimum ~$5/mo) -> disqualified. **Railway** removed its free tier in Aug 2023; now a one-time $5 trial credit (card required at signup) then $1/mo credit, not enough to run an always-on worker -> disqualified. **Render** free tier is web-services only (750 instance-hours/workspace/mo, spins down after 15 min idle, ~1 min cold start); **background workers are paid from $7/mo** and the OMR worker is a background poller, so Render's free tier does not fit our shape -> disqualified for the worker (a web-service rewrite would still cold-start and is not a clean fit). **Hugging Face Spaces** CPU Basic is genuinely free (2 vCPU / 16 GB) but **sleeps after 48h idle** and storage is ephemeral (persistent storage is $5+/mo); could host a Gradio/FastAPI OMR endpoint but not a 24/7 R2 poller, and it is not designed as a backend worker -> niche fit, not ideal. **Google Cloud Run** free tier unchanged (180k vCPU-s, 360k GiB-s, 2M req/mo per billing account, scale-to-zero); the only non-free wrinkle remains **Artifact Registry 0.5 GB free** then $0.10/GB-mo, so a multi-GB oemer image costs ~$0.25-0.30/mo unless slimmed -> still the documented fallback. **Oracle Always Free ARM (A1.Flex, 4 OCPU / 24 GB)** remains the only truly-$0 always-on option with free egress, still blocked only by capacity in home region eu-madrid-1 (single AD, no alternate region). **Net: the existing decision stands** - Oracle ARM via capacity-retry is the target, Cloud Run is the fallback, and the owner's Mac via launchd is the current interim host. No new option beats this under the free constraint. Pain point: the Mac host is "always-on" only while awake/online, so it is not 24/7; landing the Oracle ARM VM (or the Cloud Run rewrite) is still the open migration.
- **2026-05-31 - BE surface, fully enumerated from repo config.** What we actually run server-side: (1) **Cloudflare Pages** static hosting of the Vite `dist/` build (free: unlimited bandwidth/requests, 500 builds/mo), prod `https://piano-helper.pages.dev`. (2) **Cloudflare Pages Functions** = the only "API" - just two thin endpoints, `functions/api/omr.ts` (`POST /api/omr`, validates upload, writes `uploads/<jobId>` to R2, returns 202) and `functions/api/omr/result.ts` (`GET /api/omr/result?jobId=`, reads `results/<jobId>.musicxml` from R2 or 404 pending). They bill on the Workers free tier (100k req/day, 10ms CPU/invocation) and bundle automatically from `wrangler.jsonc`. (3) **Cloudflare R2** bucket `piano-helper-omr` as the job transport (free: 10 GB-mo storage, 1M Class A + 10M Class B ops/mo). (4) **The OMR worker** (`omr-worker/worker.py`), the only heavy compute: a long-running Python process that polls R2 `uploads/*`, runs `oemer 0.1.8` (primary) with `homr` fallback, writes MusicXML back. Deps are a big ML stack (torch/onnxruntime/opencv/scipy/sklearn) + `pdftoppm` (poppler). **There is NO Dockerfile in the repo** (no `Dockerfile*` anywhere); the worker ships as raw `worker.py` + `requirements.txt` + a `systemd` unit (`omr-worker.service`, for the Oracle path) and runs today on the owner's Mac under launchd. (5) **GitHub Actions** CI (`ci.yml`) + deploy (`deploy.yml`); deploy gated on `DEPLOY_ENABLED`. Audio is NOT our infra (Tone.js Salamander CDN). So the entire BE is Cloudflare-free-tier except the one always-on worker, which is the only thing without a permanent free 24/7 home.
- **2026-05-31 - Deployed #114 / #113 (`omr-worker/worker.py`) to the live Mac worker and restarted launchd. Worker.py now carries the left-hand chord-completion post-pass.** PR #114 (origin/main commit f4b17e6, branch commit b263aad) adds an additive `complete_lh_chords` MusicXML post-pass that runs on the engine result before upload: it learns the dominant detected LH chord shape and completes lone left-hand notes (matching duration) to that shape, keeping the existing note as the lowest. It self-guards and returns the input bytes unchanged on any failure. **Deploy steps (same as #109):** extracted the canonical source with `git show origin/main:omr-worker/worker.py` (708 lines / 27563 bytes), confirmed it was identical to the worktree HEAD copy, `ast.parse`-checked it with the deploy venv python, backed up the live file to `~/piano-helper-omr/worker.py.bak-20260531-124133`, copied the new file (16788 -> 27563 bytes), then `launchctl kickstart -k gui/$(id -u)/com.pianohelper.omr`. Did NOT touch `omr.env` or the plist. **Verification:** deployed file is byte-identical to origin/main and parses clean; marker grep present: `complete_lh_chords` x4, `LH_STAFF` x2, and the #109 markers still intact (`PDF_RASTER_DPI` x4, `--without-deskew` x3, `stitch_pages_vertical` x2 - not a stale/partial deploy). **Restart timestamp: 2026-05-31 12:41:34 CEST** (`2026-05-31T12:41:34` in the log). launchd state running, new pid 49842; `worker.log` shows a single fresh clean line `OMR worker started; bucket=piano-helper-omr interval=5.0s` with no FATAL/traceback. **Log slice for QA:** the pre-restart offset was 17142528 bytes / 1550 lines; QA should read this run's lines from **line 1551 onward (byte offset 17142528)** to avoid older runs. QA owns the live LH-chord fidelity scan next.
- **2026-05-31 - Deployed #109 (`omr-worker/worker.py`) to the live Mac worker and restarted launchd. RESTART IS NOW REQUIRED for any worker.py change.** PR #110 (commit 2a3b2a7) raised pdftoppm DPI 300->400, rasterizes ALL PDF pages and stitches them vertically, passes oemer `--without-deskew` on the vector-PDF path, and adds DoS caps on the stitched bitmap. Deploy steps: verified the worktree's `omr-worker/worker.py` matched `origin/main` (`git diff origin/main -- omr-worker/worker.py` empty), backed up the deployed copy to `~/piano-helper-omr/worker.py.bak-20260531-114714`, copied the new file (10623 -> 16788 bytes), then `launchctl kickstart -k gui/$(id -u)/com.pianohelper.omr`. New pid 27882 (was 85614), state running, no exit error; `worker.log` showed a single clean line `OMR worker started; bucket=piano-helper-omr interval=5.0s` with no traceback. **Pillow: already present in the venv (`~/piano-helper-omr/.venv`, Python 3.11), PIL 12.2.0 - no install needed** (the new stitching code imports PIL lazily; if a future host lacks it, `~/piano-helper-omr/.venv/bin/pip install Pillow`, free). **Gotcha reinforced:** unlike the oemer venv upgrade (#88), which an in-flight job picks up because oemer runs as a subprocess, `worker.py` IS the long-running launchd process, so a code change to it does NOT go live until you copy it in and restart the service (`launchctl kickstart -k gui/$(id -u)/com.pianohelper.omr`, or bootout+bootstrap). Cloudflare deploys never touch this worker. QA owns the live fidelity test next.
- **2026-05-31 - ROOT CAUSE of "messed up" scans (#88): oemer 0.1.5 crashes on numpy >= 1.24, so EVERY scan silently fell back to homr, which flattens a grand staff into one part.** numpy removed the `np.int` alias in 1.24; oemer 0.1.5 uses `dtype=np.int` in `staffline_extraction.py`, so the live Mac worker (numpy 2.4.6) failed oemer on every job since the venv was last reinstalled (`oemer failed ... non-zero exit status 1` in `~/piano-helper-omr/worker.log`). homr 0.6.2 needs numpy>=2.2.6 and scipy/sklearn/opencv need >=1.24, so you CANNOT just downgrade numpy: oemer 0.1.5 and homr are mutually exclusive on one numpy. **Fix:** upgrade to **oemer 0.1.8** (uses `np.int64`, works on numpy 2.x), installed **`--no-deps`** because 0.1.8 declares `onnxruntime-gpu` (no ARM/macOS wheel); the CPU `onnxruntime` provides the same module. Encoded as a two-step install: `pip install -r requirements.txt` (homr, boto3, oemer's runtime deps) then `pip install --no-deps -r requirements-oemer.txt` (oemer==0.1.8). Verified on icarus.pdf: oemer 0.1.8 yields 1 part / **2 staves** (G+F clefs), 27 measures (matches source), 128 notes split 72/56 across hands; homr produced a single collapsed `upper` part. The live Mac venv was upgraded in place (oemer runs as a subprocess, so new jobs pick up 0.1.8 with no worker restart). **Note for the Oracle ARM VM: same two-step install; do NOT let `requirements.txt` pull onnxruntime-gpu.**
- **2026-05-30 - OMR worker is now deployed and LIVE, running locally on the owner's Mac (interim host) via launchd. Oracle Madrid confirmed capacity-exhausted.**
  Acted on the hosting research below. Oracle Always Free in the home region eu-madrid-1 is
  out of capacity for BOTH free shapes: a real LaunchInstance attempt for `VM.Standard.A1.Flex`
  returned "Out of capacity for shape VM.Standard.A1.Flex in availability domain AD-1" (and
  E2.1.Micro was already exhausted). Madrid has a single AD and Always Free only launches in the
  home region, so there is no alternate AD/region to try. Rather than block on the capacity-retry
  or build the Cloud Run fallback, the worker was deployed locally to ship the feature now ($0).
  - **What runs:** `~/piano-helper-omr/` holds `worker.py` (copied from this branch, unchanged),
    a Python 3.11 venv (`oemer` 0.1.5, `homr` 0.6.2, `boto3`), `run.sh` (sources creds, fixes
    PATH, execs the worker), and `omr.env` (the 4 R2 creds, chmod 600, NOT in git). System dep
    `pdftoppm` via `brew install poppler`. A **LaunchAgent** `com.pianohelper.omr`
    (`~/Library/LaunchAgents/com.pianohelper.omr.plist`, RunAtLoad + KeepAlive) keeps it polling
    and restarts on crash; logs to `~/piano-helper-omr/worker.log`. R2 token: a dedicated Account
    API token scoped to the `piano-helper-omr` bucket, Object Read & Write.
  - **Validated end to end:** uploaded a synthetic PNG to `uploads/<uuid>`; the worker downloaded
    it, ran oemer (downloaded its model, ran clean), fell back to homr (also ran clean), both
    correctly found no staffs on the synthetic image, wrote the failure sentinel to
    `results/<uuid>.musicxml`, and deleted the upload. Confirms the full transport + both engines
    are functional on Apple Silicon / Python 3.11.
  - **Caveat / migration:** "always-on" only holds while the Mac is awake and online, so this is
    interim, not 24/7. Migrate later to the Oracle ARM VM (via the capacity-retry below) or the
    Cloud Run fallback; the worker code is host-agnostic so the move is config-only. Manage the
    Mac service with `launchctl bootout/bootstrap gui/$(id -u) <plist>`.

- **2026-05-30 - Worker-hosting decision: Oracle ARM stays primary; Google Cloud Run (request-based, scale-to-zero) is the fallback. Fly.io and GCP-VM rejected.**
  Research for "where to run the always-on OMR worker for $0". Decision:
  - **PRIMARY: keep the committed Oracle Always Free ARM VM design** and add an **automated
    capacity-retry** to actually get the instance. Oracle ARM (A1.Flex, up to 4 OCPU / 24 GB)
    is the only option that is permanently free AND gives a free external IP + free egress to
    R2, and the worker already runs there unchanged (systemd + venv, ~0 rework). The blocker is
    pure capacity ("Out of host capacity" in home region eu-madrid-1, both ARM and E2.1.Micro).
    Always Free can only launch in the tenancy home region, so no alternate region/AD. Standard
    fix is a retry loop hitting the LaunchInstance API every 1-5 min (OCI CLI / a small script /
    a community tool) until a slot frees up. Realistic: people get an A1 within hours-to-days
    this way; it is worth automating since it is free and needs no code change. Effort: ~1-2h to
    stand up the retry script, then unattended wait.
  - **FALLBACK (if Oracle never frees up): re-architect the worker as a Cloud Run service with
    request-based billing, pinged by Cloud Scheduler.** Cloud Run free tier (per billing account,
    monthly, never expires): 180,000 vCPU-s, 360,000 GiB-s, 2,000,000 requests. With
    `min-instances=0` it scales to zero and bills ONLY while a request is in flight, so idle
    polling costs nothing. No external IP needed (egress to R2 is outbound HTTPS; first 1 GiB/mo
    egress free, and our payloads are tiny MusicXML + small uploads, so egress stays ~$0).
    Cloud Scheduler free tier = 3 jobs/account; one job pings the service every 1-2 min to run a
    single poll cycle, satisfying the 1-2 min processing SLA. Compute math: a 2 GiB / 1 vCPU
    instance burns 1 vCPU-s + 2 GiB-s per wall-second. Idle polls (a few seconds each, ~43k/mo at
    1/min) are trivial. The risk is heavy `oemer` inference: at ~2 GiB the 360,000 GiB-s cap is
    the binding limit = ~180,000 instance-seconds = ~50 instance-hours/mo of actual CPU-active
    time. That is plenty for a hobby tool (hundreds of ~1-3 min inferences/mo) but IS a real cap,
    so it must be watched. Request timeout max is 60 min, well above a single oemer run. Effort:
    medium (~4-8h): containerize the worker, flip the long poll loop into a one-shot "process one
    job then exit" HTTP handler, push image, wire Cloud Scheduler + the 4 R2 env vars as secrets.
  - **Cloud Run hidden-cost watch:** the one non-free wrinkle is **Artifact Registry**: free tier
    is only **0.5 GB** stored, and an `oemer`/PyTorch/onnx image is multi-GB. Overage is ~$0.10/GB-
    month, so a ~3 GB image is ~$0.25-0.30/mo, i.e. a small BUT NONZERO ongoing charge, which
    violates the "$0, no ongoing charges" rule. Mitigations before adopting: slim the image
    aggressively (CPU-only torch wheels, multi-stage build, strip caches) to fit closer to 0.5 GB,
    and/or keep only the latest tag (no history) so stored bytes stay minimal. If it cannot be
    brought to ~$0, this fallback is disqualified and Oracle retry is the only path.
  - **Rejected:** **Fly.io** has NO free tier in 2026 (only a 2-hour / 7-day trial, then a card is
    required; legacy Hobby allowances are grandfathered only) -> not permanently free, off the
    table. **GCP Compute Engine e2-micro VM** rejected earlier on the ~$3-4/mo external-IPv4
    charge. **GitHub Actions** as runtime rejected earlier (Actions ToS). Render/Railway/other free
    PaaS spin down or are trial-only and were not pursued.
  - Net: try to land the Oracle ARM VM via automated capacity-retry (zero rework, truly $0). Only
    if that fails for good, do the Cloud Run rewrite, and only after proving the image can be kept
    inside (or negligibly past) the 0.5 GB Artifact Registry free tier.

- **2026-05-30 - OMR compute moved OFF GitHub Actions to an always-on R2-polling worker (issue #5).**
  Reason: running OMR on Actions runners uses Actions as the app's runtime compute backend, which
  breaks GitHub's Actions usage policy and risks account suspension. The "public repo = unlimited
  minutes" point from the earlier spike does not make this allowed. `.github/workflows/omr.yml` was
  DELETED. New backend: an always-on Python worker (`omr-worker/`, committed in the repo). It is
  host-agnostic; the plan was an Oracle Cloud Always Free `VM.Standard.A1.Flex` (Ubuntu 22.04 ARM)
  under systemd (`omr-worker.service`, restart on failure), but Oracle Madrid was capacity-exhausted,
  so it currently runs on the owner's Mac via launchd (see the "OMR worker deployed on the Mac" entry
  below). Cost stays $0 either way (free host + the existing free Cloudflare R2).
  - **Trigger is now "the worker polls R2 `uploads/*`"** (default every 5s, env `OMR_POLL_SECONDS`).
    There is NO `repository_dispatch` and NO GitHub PAT anymore. The Pages Function `POST /api/omr`
    only validates and writes the upload to R2 and returns 202 `{jobId}`; it notifies nobody.
  - **R2 transport contract unchanged:** input `uploads/<jobId>`, output
    `results/<jobId>.musicxml`, plus the failure-sentinel MusicXML when both engines fail. R2 bucket
    is still `piano-helper-omr` with the `OMR_BUCKET` Pages binding (declared in-code in
    `wrangler.jsonc`, so no manual dashboard binding step is needed).
  - **Credential moves:** the four R2 S3 creds (`R2_S3_ENDPOINT`, `R2_ACCESS_KEY_ID`,
    `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`) move from GitHub Actions secrets to the worker host's env
    (Linux: root-owned `/etc/piano-helper-omr.env`, chmod 600, loaded by the systemd unit). The Pages
    Function secret `GITHUB_DISPATCH_TOKEN` and var `GITHUB_REPOSITORY` are now UNUSED and should be
    removed from the Pages project; the GitHub fine-grained PAT can be revoked.
  - **Runbook** (install deps `poppler-utils python3 python3-venv`, venv + `pip install -r
    requirements.txt`; set the four R2 env vars; run the worker under systemd or launchd) lives in
    `omr-worker/README.md`, with a keep-alive note for the Oracle path: Oracle reclaims Always Free
    VMs that sit under ~20% CPU over a 7-day window, so a tiny periodic CPU nudge keeps it alive.
  - The "OMR runner workflow shipped", "OMR Actions workflow built", and "OMR trigger ...
    repository_dispatch" entries below are SUPERSEDED by this one (kept for history).

- **2026-05-30 - OMR runner workflow (issue #5) shipped: `.github/workflows/omr.yml`. SUPERSEDED (see above), the workflow was deleted.** Trigger: `repository_dispatch` event_type `omr-job`, fired by the `/api/omr` Pages Function with `client_payload { jobId, ext }`. Steps: validate jobId against a strict UUID regex and ext against an allowlist (png/jpg/jpeg/pdf) BEFORE using either in an S3 key or filename (guards key/path injection from the untrusted payload, which arrives via `env:` vars and is referenced as `"$VAR"`, never interpolated into a script body); install `libgl1`+`libglib2.0-0` (opencv for oemer) and `poppler-utils` (pdftoppm for PDF page 1 -> PNG); `pip install oemer`; pull `uploads/<jobId>` from R2; run `oemer <img> -o out` (model weights download on first run, 25-min step timeout); push `results/<jobId>.musicxml` back. An `if: failure()` step writes `results/<jobId>.error` so the frontend can surface a 422. R2 access uses the aws CLI with `--endpoint-url $R2_S3_ENDPOINT` and the `R2_*` Actions secrets. **R2 + aws CLI v2 checksum gotcha:** recent aws CLI v2 adds request/response integrity checksums R2 rejects, so the job sets `AWS_REQUEST_CHECKSUM_CALCULATION=when_required` and `AWS_RESPONSE_CHECKSUM_VALIDATION=when_required` and passes `--checksum-algorithm CRC32` on each `cp`. Public-repo Actions minutes are unlimited, so heavy ML OMR runs here, not in the Function.

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

- **2026-05-30 - Deploy must omit the positional output dir.** Adding `wrangler.jsonc` with `pages_build_output_dir: "dist"` (needed to declare the `OMR_BUCKET` R2 binding on the Pages deployment) changes the deploy command: `wrangler pages deploy` now reads the output dir, R2 binding, and bundles `functions/` from config. Per Cloudflare docs, passing a positional dir (`pages deploy dist`) bypasses that config, so `deploy.yml` was changed to `pages deploy --project-name=... --branch=main` (no `dist`). CI (`ci.yml`) gained a `npx tsc -p functions/tsconfig.json` step so Function type regressions fail the PR (the root `tsc` only compiles `src/`).

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

Architecture as of 2026-05-30: the worker polls R2; no Actions, no PAT.

- [x] R2 bucket `piano-helper-omr` created (`wrangler r2 bucket create`).
- [x] `.github/workflows/omr.yml` DELETED (OMR no longer runs on Actions; ToS reasons).
- [x] Worker committed at `omr-worker/` (`worker.py`, `omr-worker.service`,
      `requirements.txt`, `README.md` runbook).
- [ ] Provision the worker host (Oracle Always Free ARM VM was the plan; currently the
      owner's Mac via launchd) and install deps per `omr-worker/README.md`. (manual)
      Tooling now exists: run `omr-worker/oracle-launch.sh` (capacity-retry) +
      `oracle-cloud-init.yaml`; full step-by-step in `omr-worker/ORACLE.md`.
- [ ] Mint R2 S3 API token (Object Read & Write, bucket `piano-helper-omr`). (manual)
- [ ] On the host, set the four R2 env vars (Linux: `/etc/piano-helper-omr.env`, chmod 600):
      `R2_S3_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET=piano-helper-omr`.
- [ ] Run the worker (Linux: `systemctl enable --now omr-worker.service`; macOS: launchd).
- [ ] On the Oracle path, add the idle keep-alive (Oracle reclaims idle Always Free VMs).
      Now auto-installed by `oracle-cloud-init.yaml` (a `*/15` CPU-nudge cron), so this is
      handled once the VM lands via the launch tooling.
- [ ] Bind on Pages project: R2 binding `OMR_BUCKET` -> `piano-helper-omr` (also declared in
      `wrangler.jsonc`). (app + infra)
- [ ] Remove the now-unused Pages secret `GITHUB_DISPATCH_TOKEN` and var
      `GITHUB_REPOSITORY`; revoke the GitHub fine-grained PAT.
- [ ] End-to-end smoke: upload to `uploads/<jobId>` (UUID), confirm the worker writes
      `results/<jobId>.musicxml` and deletes the upload.
