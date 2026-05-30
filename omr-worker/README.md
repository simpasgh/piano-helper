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
