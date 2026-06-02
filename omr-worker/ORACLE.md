# Landing the OMR worker on an Oracle Always Free ARM VM

This is the exact, copy-pasteable procedure to move the Piano Helper OMR worker off the
interim Mac/launchd host onto a free, 24/7 Oracle Cloud `VM.Standard.A1.Flex` (ARM,
4 OCPU / 24 GB, Ubuntu 22.04). The only real blocker is Oracle ARM capacity in single-AD
home regions, so step 8 runs a capacity-retry loop that hammers LaunchInstance until a slot
frees up.

Everything here stays inside **Oracle Always Free**. Nothing below costs money. Cost traps
are called out explicitly with `COST:`.

Files in this directory used by the procedure:
- `oracle-launch.sh` - the capacity-retry launcher.
- `oracle-cloud-init.yaml` - first-boot provisioning (installs deps + worker + systemd).
- `oracle.env.example` - template for the OCIDs the launcher needs (copy to `oracle.env`).
- `omr-worker.service`, `worker.py`, `requirements*.txt` - the worker itself (reused as-is).

---

## 0. What you need before starting

- An Oracle Cloud account (free signup). A **credit card is required at signup for identity
  verification**, but Always Free resources never charge it. COST: do NOT "upgrade to
  Pay As You Go" and do NOT launch any shape other than `VM.Standard.A1.Flex`; the guard in
  `oracle-launch.sh` refuses other shapes, but be careful in the console too.
- The OCI CLI installed locally (it runs from your Mac, not the VM).
- Your four Cloudflare R2 credentials (same ones the Mac host uses). You get them from the
  Cloudflare dashboard: R2 -> Manage R2 API Tokens -> Create API token, permission
  **Object Read and Write**, scoped to bucket `piano-helper-omr`. That yields an Access Key
  ID, a Secret Access Key, and the S3 endpoint `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`.

---

## 1. Create the Oracle account (skip if you have one)

1. Go to https://www.oracle.com/cloud/free/ and sign up.
2. Pick your **home region** carefully: Always Free ARM can ONLY launch in your home region
   and it cannot be changed later. A region with multiple availability domains has more
   chances of free capacity than a single-AD region (eu-madrid-1 is single-AD and is the one
   that has been exhausted for us). If you are creating a fresh account, prefer a multi-AD
   region near you.
3. Finish identity verification. Wait until the tenancy is provisioned.

---

## 2. Install + configure the OCI CLI (API key auth)

```bash
# macOS install (Homebrew):
brew install oci-cli

# Configure. This walks you through creating an API signing key and writes ~/.oci/config.
oci setup config
```

`oci setup config` prompts for:
- **user OCID** - in the console: top-right profile -> "My profile" -> OCID (copy).
- **tenancy OCID** - profile menu -> "Tenancy: ..." -> OCID (copy).
- **region** - your home region key, e.g. `eu-madrid-1`.
- key generation - say yes; it writes `~/.oci/oci_api_key.pem` (private) and `.pub`.

Then **upload the public API key** to your user so the CLI can authenticate:
- Console -> My profile -> API keys -> Add API key -> paste `~/.oci/oci_api_key_public.pem`
  (or upload the file). `oci setup config` prints the exact path.

Verify auth works:

```bash
oci iam region list --output table   # should print a table, not an auth error
```

---

## 3. Generate the VM SSH key (separate from the API key)

This is the key you use to SSH into the VM, NOT the API key above.

```bash
ssh-keygen -t ed25519 -f ~/.ssh/oci_omr -C piano-helper-omr
# Creates ~/.ssh/oci_omr (private) and ~/.ssh/oci_omr.pub (public).
```

---

## 4. Create the network (one-time, free)

Easiest path: in the console use the **VCN wizard** (Networking -> Virtual Cloud Networks ->
Create VCN -> "Create VCN with Internet Connectivity"). This makes a VCN, a **public
subnet**, an internet gateway, and a route table in a couple of clicks. All free.

After it exists, make sure the public subnet's security list allows inbound TCP 22 (SSH)
from your IP. COST: none. The worker needs NO inbound port itself (it only makes outbound
HTTPS to R2); port 22 is only so you can administer the box.

CLI alternative if you prefer (creates VCN + subnet); the console wizard is faster, so it is
not reproduced here.

---

## 5. Collect the five OCIDs into `oracle.env`

```bash
cd omr-worker
cp oracle.env.example oracle.env
```

Now fill in `oracle.env`. Run each command and paste the result. `oci setup config` already
authenticated you, so these just read your tenancy.

```bash
# Compartment OCID (personal accounts usually use the tenancy root compartment):
oci iam compartment list --compartment-id-in-subtree true \
  --query 'data[].{name:name,id:id}' --output table
# If you have no sub-compartments, use your TENANCY OCID (from ~/.oci/config, the
# 'tenancy=' line) as OCI_COMPARTMENT_ID.

# Availability domain NAME (used for OCI_AD):
oci iam availability-domain list --query 'data[].name' --output table

# Subnet OCID (the PUBLIC subnet from the VCN wizard):
export C=ocid1.compartment.oc1..xxxxx   # your compartment from above
oci network subnet list --compartment-id "$C" \
  --query 'data[].{name:"display-name",id:id,public:"prohibit-public-ip-on-vnic"}' --output table
# Pick the subnet whose public flag is false (public IPs allowed).

# Image OCID: Canonical Ubuntu 22.04 aarch64 for the A1.Flex shape, in your region:
oci compute image list --compartment-id "$C" \
  --operating-system "Canonical Ubuntu" --operating-system-version "22.04" \
  --shape VM.Standard.A1.Flex \
  --query 'data[0].{name:"display-name",id:id}' --output table
```

Put the values into `oracle.env`:
- `OCI_COMPARTMENT_ID` = compartment (or tenancy) OCID
- `OCI_AD` = the AD name string
- `OCI_SUBNET_ID` = public subnet OCID
- `OCI_IMAGE_ID` = the Ubuntu 22.04 aarch64 image OCID
- `OCI_SSH_KEY_PATH` = `~/.ssh/oci_omr.pub`

Leave the optional vars commented to take the full 4 OCPU / 24 GB Always Free allotment.

`oracle.env` is gitignored, so it is never committed.

---

## 6. (Optional) Dry-run the config

```bash
set -a; . ./oracle.env; set +a
# Sanity-check the CLI sees your tenancy and the image resolves:
oci compute image get --image-id "$OCI_IMAGE_ID" --query 'data."display-name"' --raw-output
```

---

## 7. Run the capacity-retry launcher

```bash
cd omr-worker
set -a; . ./oracle.env; set +a
./oracle-launch.sh 2>&1 | tee oracle-launch.log
```

What it does:
- Loops `oci compute instance launch` with the A1.Flex shape (4 OCPU / 24 GB) and the
  `oracle-cloud-init.yaml` user-data.
- On `Out of host capacity` / `InternalError` / 5xx / 429 it sleeps a jittered 30-90s and
  retries, forever by default (set `MAX_ATTEMPTS` to cap it).
- On a real error (auth, quota, bad OCID) it stops and prints the message so you can fix it.
- On success it prints the instance id and exits.

This can take minutes to days depending on capacity. It is safe to leave running. To run it
unattended in the background:

```bash
nohup ./oracle-launch.sh > oracle-launch.log 2>&1 &
tail -f oracle-launch.log
```

Re-running after a success is safe: it detects the already-RUNNING `piano-helper-omr`
instance and exits without launching a second one.

---

## 8. Once the VM lands: finish the worker (the only manual on-VM step)

The cloud-init already installed poppler + the venv + the worker + the systemd unit and
enabled it, but it did NOT write the R2 credentials (secrets are kept out of user-data). So
the unit is enabled but not yet running. Finish it:

```bash
# Get the public IP:
set -a; . ./oracle.env; set +a
oci compute instance list --compartment-id "$OCI_COMPARTMENT_ID" \
  --display-name piano-helper-omr --lifecycle-state RUNNING \
  --query 'data[0].id' --raw-output | tee /tmp/inst_id
oci compute instance list-vnics --instance-id "$(cat /tmp/inst_id)" \
  --query 'data[0]."public-ip"' --raw-output

# SSH in (first boot's pip install of the ML stack can take 10-20 min; watch the log):
ssh -i ~/.ssh/oci_omr ubuntu@<PUBLIC_IP>
tail -n 50 -f /var/log/omr-bootstrap.log    # wait for "Bootstrap complete."

# Write the R2 creds (root-owned, chmod 600). Same four values the Mac host uses:
sudo tee /etc/piano-helper-omr.env >/dev/null <<'ENV'
R2_S3_ENDPOINT=https://<ACCOUNT_ID>.r2.cloudflarestorage.com
R2_ACCESS_KEY_ID=<access-key-id>
R2_SECRET_ACCESS_KEY=<secret-access-key>
R2_BUCKET=piano-helper-omr
# OMR_POLL_SECONDS=5
ENV
sudo chmod 600 /etc/piano-helper-omr.env

# Start the worker:
sudo systemctl restart omr-worker.service
systemctl status omr-worker.service --no-pager
journalctl -u omr-worker.service -f
```

You want a clean startup line like:
`OMR worker started; bucket=piano-helper-omr interval=5.0s` with no traceback.

---

## 9. Verify it processes jobs end to end

From your Mac (or anywhere with the R2 creds), drop a test upload and watch for a result:

```bash
# Using the AWS CLI against R2 (R2 rejects newer checksums, so set these):
export AWS_ACCESS_KEY_ID=<access-key-id>
export AWS_SECRET_ACCESS_KEY=<secret-access-key>
export AWS_REQUEST_CHECKSUM_CALCULATION=when_required
export AWS_RESPONSE_CHECKSUM_VALIDATION=when_required
EP=https://<ACCOUNT_ID>.r2.cloudflarestorage.com
JOB=$(uuidgen)

aws s3 cp ./some-sheet.png "s3://piano-helper-omr/uploads/$JOB" \
  --endpoint-url "$EP" --checksum-algorithm CRC32
# Within a poll cycle or two the worker writes the result and DELETES the upload:
aws s3 ls "s3://piano-helper-omr/results/$JOB.musicxml" --endpoint-url "$EP"
```

A `results/<JOB>.musicxml` appearing (and the `uploads/<JOB>` disappearing) means success.
Best real test: upload sheet music through the live app and confirm the performance renders.

---

## 10. Decommission the Mac interim host (after the VM is proven)

Once the VM is confirmed processing jobs, stop the Mac launchd worker so two workers do not
race for the same uploads:

```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.pianohelper.omr.plist
```

(Keep the Mac runtime dir as a fallback until you trust the VM.)

---

## Keep-alive (already wired by cloud-init)

Oracle can reclaim Always Free compute that stays under ~20% CPU over a 7-day window. The
cloud-init installs a light user cron that burns a few CPU-seconds every 15 minutes to stay
above the floor. Nothing to do; just know it is there:

```bash
crontab -l   # shows the '# omr-keepalive' line
```

---

## Cost guardrails (read once)

- Only `VM.Standard.A1.Flex` (and the tiny `E2.1.Micro`) are Always Free. `oracle-launch.sh`
  refuses any other shape and caps ARM at 4 OCPU / 24 GB.
- Always Free includes up to **200 GB total block storage**; the script's default 50 GB boot
  volume is well inside it. Do not create extra block volumes.
- Egress on Always Free includes **10 TB/month** outbound, far beyond our tiny MusicXML
  traffic. No egress cost.
- A public IP on an Always Free VM is free. COST: a RESERVED public IP that is left
  unattached can incur a small charge; we use an ephemeral public IP (`--assign-public-ip
  true`), which is free while attached.
- Do NOT upgrade the tenancy to Pay As You Go. Staying on the Always Free account is what
  keeps everything $0.
