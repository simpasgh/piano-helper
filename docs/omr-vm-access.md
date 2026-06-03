# OMR VM access (Hetzner cx33 worker)

How to get SSH access to the always-on OMR inference box from a new machine
(e.g. the Windows GPU PC). The box runs CPU inference and the deploy target lives
at `/opt/piano-helper`.

- **Host:** `root@91.98.116.201`
- **Box:** Hetzner cx33, CPU-only, always-on. Runs `omr-worker.service`.
- **Existing key (on the Mac):** `~/.ssh/oci_omr` (+ `oci_omr.pub`).

> Never commit a private key to this repo. This file holds instructions only.
> The server's `/etc/piano-helper-omr.env` contains a Gemini API key flagged for
> rotation, so anyone with shell access can read it.

## Option A (recommended): give this machine its own key

No secret leaves the Mac. Each machine gets its own key, revocable independently.

1. On **this PC** (PowerShell), generate a key and print the public half:

   ```powershell
   ssh-keygen -t ed25519 -f $HOME\.ssh\oci_omr -C "windows-pc-omr"
   type $HOME\.ssh\oci_omr.pub
   ```

2. Send that one public-key line to whoever holds Mac access. From the **Mac**
   (which can already log in) authorize it on the box:

   ```bash
   ssh -i ~/.ssh/oci_omr root@91.98.116.201 \
     "echo 'PASTE_THE_WINDOWS_PUB_LINE_HERE' >> ~/.ssh/authorized_keys"
   ```

3. Connect from this PC:

   ```powershell
   ssh -i $HOME\.ssh\oci_omr root@91.98.116.201
   ```

## Option B: reuse the existing key

Move both `~/.ssh/oci_omr` and `~/.ssh/oci_omr.pub` from the Mac over a channel
you control (USB stick, password-manager secure file, or `scp` directly between
the machines). Never paste a private key through chat, email, or Slack.

On this PC, drop both files into `C:\Users\<you>\.ssh\`, lock down the private
key, then connect:

```powershell
icacls "$HOME\.ssh\oci_omr" /inheritance:r /grant:r "$($env:USERNAME):R"
ssh -i $HOME\.ssh\oci_omr root@91.98.116.201
```

## Deploy / restart the worker (once you have access)

```bash
ssh -i ~/.ssh/oci_omr root@91.98.116.201
cd /opt/piano-helper
sudo -u ubuntu git fetch origin && sudo -u ubuntu git reset --hard origin/main
systemctl restart omr-worker.service
```

Prod env flags live in `/etc/piano-helper-omr.env`
(`OMR_ENSEMBLE=1`, `OMR_ENSEMBLE_REFEREE=1`, `OMR_LLM=0`). Do not change them
without a deliberate decision. See
[docs/context/own-engine-roadmap.md](context/own-engine-roadmap.md) for the
full engine roadmap and box details.
