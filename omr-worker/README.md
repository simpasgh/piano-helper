# OMR worker (Oracle Always Free ARM VM)

This is the compute backend for Piano Helper's Optical Music Recognition. It is an
always-on Python worker that polls Cloudflare R2 for uploaded sheet music, runs
`oemer` (with `homr` as a fallback), and writes the resulting MusicXML back to R2.

It replaces the old GitHub Actions runner. Using Actions as the app's runtime compute
backend violates GitHub's Actions usage policy and risks account suspension, so OMR
compute moved to a VM you own. The R2 transport contract is unchanged.

## Why a VM polls R2 (no webhook, no PAT)

The Cloudflare Pages Function `POST /api/omr` only validates the upload and writes it to
`uploads/<jobId>` in R2. It does not notify anyone. This worker discovers new jobs by
listing `uploads/` on a short interval, so there is no `repository_dispatch`, no GitHub
PAT, and no inbound port to open on the VM. The browser still polls
`GET /api/omr/result?jobId=` exactly as before.

R2 contract (must match `functions/api/_omr.ts`):

| Direction | R2 key | Content |
| --- | --- | --- |
| input | `uploads/<jobId>` | raw PDF/PNG/JPEG bytes |
| output | `results/<jobId>.musicxml` | UTF-8 MusicXML |

`<jobId>` is a UUID minted by the Function. The worker re-validates it before using it
in any key or path. If both engines fail, the worker writes a failure-sentinel MusicXML
that the browser detects (`src/omr.ts` `FAILURE_SENTINEL_RE`) so polling terminates.

## Provision (Ubuntu 22.04 ARM, Oracle Always Free)

Create an Always Free `VM.Standard.A1.Flex` shape (ARM, up to 4 OCPU / 24 GB across the
free allocation) with Ubuntu 22.04. Then on the VM:

```bash
# 1. System packages: pdftoppm (PDF rasterizer) + python tooling.
sudo apt-get update
sudo apt-get install -y poppler-utils python3 python3-venv python3-pip file git

# 2. Get the code (this repo) onto the VM.
sudo mkdir -p /opt/piano-helper
sudo chown "$USER" /opt/piano-helper
git clone https://github.com/simpasgh/piano-helper.git /opt/piano-helper
cd /opt/piano-helper/omr-worker

# 3. Python deps in a venv (oemer pulls a large ML stack; this can take a while).
python3 -m venv .venv
./.venv/bin/pip install --upgrade pip
./.venv/bin/pip install -r requirements.txt
# oemer is installed separately and WITHOUT its deps: it pins onnxruntime-gpu (no ARM/macOS
# wheel), so a normal install fails. --no-deps uses the CPU onnxruntime from the step above.
./.venv/bin/pip install --no-deps -r requirements-oemer.txt
```

## Configure R2 credentials

Mint an R2 S3 API token in the Cloudflare dashboard (R2 -> Manage R2 API Tokens ->
Create API token, permission Object Read and Write, scoped to bucket `piano-helper-omr`).
You get an Access Key ID, a Secret Access Key, and an S3 endpoint
(`https://<ACCOUNT_ID>.r2.cloudflarestorage.com`).

Put the four values in a root-owned env file (these are the SAME four creds that used to
be GitHub Actions secrets; they now live only on this VM):

```bash
sudo tee /etc/piano-helper-omr.env >/dev/null <<'ENV'
R2_S3_ENDPOINT=https://<ACCOUNT_ID>.r2.cloudflarestorage.com
R2_ACCESS_KEY_ID=<access-key-id>
R2_SECRET_ACCESS_KEY=<secret-access-key>
R2_BUCKET=piano-helper-omr
# Optional, default 5:
# OMR_POLL_SECONDS=5
ENV
sudo chmod 600 /etc/piano-helper-omr.env
```

## Install and enable the service

The unit file assumes the repo at `/opt/piano-helper`, the venv at
`omr-worker/.venv`, and user `ubuntu`. Edit `omr-worker.service` if yours differ.

```bash
sudo cp /opt/piano-helper/omr-worker/omr-worker.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now omr-worker.service

# Verify:
systemctl status omr-worker.service
journalctl -u omr-worker.service -f
```

## Alternative: run locally on macOS (launchd)

The worker is host-agnostic, so it also runs on a Mac as an interim/zero-cost host while no
Always Free VM has capacity. This is the setup currently in use (Apple Silicon, macOS 15,
Python 3.11). It is "always-on" only while the Mac is awake and online, not 24/7.

```bash
# 1. System dep: pdftoppm (PDF rasterizer) + a modern Python (homr needs 3.10+).
brew install poppler python@3.11

# 2. Standalone runtime dir (kept out of any git worktree so the service is stable).
RT=~/piano-helper-omr
mkdir -p "$RT"
cp omr-worker/worker.py omr-worker/requirements.txt omr-worker/requirements-oemer.txt "$RT/"

# 3. venv + deps (oemer pulls a large ML stack; first oemer run also downloads its model).
/opt/homebrew/opt/python@3.11/bin/python3.11 -m venv "$RT/.venv"
"$RT/.venv/bin/pip" install --upgrade pip
"$RT/.venv/bin/pip" install -r "$RT/requirements.txt"
# oemer separately, without its deps (it pins onnxruntime-gpu, no ARM/macOS wheel).
"$RT/.venv/bin/pip" install --no-deps -r "$RT/requirements-oemer.txt"

# 4. Credentials file (chmod 600), same four R2 values as the VM env file above.
cat > "$RT/omr.env" <<'ENV'
R2_S3_ENDPOINT=https://<ACCOUNT_ID>.r2.cloudflarestorage.com
R2_ACCESS_KEY_ID=<access-key-id>
R2_SECRET_ACCESS_KEY=<secret-access-key>
R2_BUCKET=piano-helper-omr
# OMR_POLL_SECONDS=5
ENV
chmod 600 "$RT/omr.env"
```

Create a launcher `~/piano-helper-omr/run.sh` (chmod +x) that sources `omr.env`, sets
`PATH` to include the venv bin (oemer/homr), `/opt/homebrew/bin` (pdftoppm) and `/usr/bin`
(file), then `exec`s `.venv/bin/python worker.py`. Point a LaunchAgent at it:

```bash
# ~/Library/LaunchAgents/com.pianohelper.omr.plist runs /bin/bash run.sh with
# RunAtLoad + KeepAlive, logging to ~/piano-helper-omr/worker.log.
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.pianohelper.omr.plist
launchctl print  gui/$(id -u)/com.pianohelper.omr   # state should be "running"
tail -f ~/piano-helper-omr/worker.log

# Stop / reload:
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.pianohelper.omr.plist
```

## Test end to end

Upload any PNG to `uploads/<some-uuid>` (dashboard or `aws s3 cp`), then confirm
`results/<some-uuid>.musicxml` appears within a poll cycle or two. The worker deletes the
upload once the result is written, so a processed `uploads/` key disappearing is success.

## Keep-alive note (Oracle reclaims idle Always Free VMs)

Oracle can reclaim Always Free compute that stays under roughly 20% CPU, 20% network, and
20% memory utilization across a 7-day window. OMR is bursty, so an idle worker can drift
below that. To avoid reclamation, run a tiny periodic CPU nudge, for example a user cron
entry that burns a few CPU-seconds every 15 minutes:

```bash
crontab -e
# Add:
*/15 * * * * timeout 20 sh -c 'while :; do :; done' >/dev/null 2>&1
```

This is intentionally light; it exists only to keep the VM above the reclamation floor,
not to do real work.
