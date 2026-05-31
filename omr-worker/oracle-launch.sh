#!/usr/bin/env bash
#
# oracle-launch.sh - capacity-retry launcher for the Piano Helper OMR worker on an
# Oracle Cloud Always Free ARM VM (VM.Standard.A1.Flex).
#
# Oracle's Always Free ARM capacity is chronically exhausted in single-AD home
# regions (e.g. eu-madrid-1), so a single `instance launch` returns:
#   "Out of host capacity" / "Out of capacity for shape ... in availability domain"
# This script loops `oci compute instance launch` with jittered backoff, retrying
# ONLY on transient capacity/5xx errors, and stops on success or on a real error
# (auth, quota, bad OCID, limit-exceeded). When a slot frees up the VM is created
# and provisioned by oracle-cloud-init.yaml.
#
# It does NOT create any cloud resources by itself beyond the one instance launch,
# and every shape it requests is inside the Always Free allotment, so it stays $0.
# See ORACLE.md for the full manual setup and how to get each OCID.
#
# ---------------------------------------------------------------------------
# Config: set these via environment or a config file. NOTHING is hardcoded and no
# secrets/OCIDs are committed. Source a file or export the vars before running:
#   set -a; . ./oracle.env; set +a; ./oracle-launch.sh
# A template lives at oracle.env.example (copy it to oracle.env, fill in, do NOT
# commit oracle.env - it is gitignored).
# ---------------------------------------------------------------------------
#
# Required (no defaults; the script refuses to run without them):
#   OCI_COMPARTMENT_ID   Compartment OCID to create the instance in (often the
#                        tenancy root OCID for a personal account).
#   OCI_SUBNET_ID        Subnet OCID (public subnet of your VCN) for the VNIC.
#   OCI_IMAGE_ID         Image OCID: Canonical Ubuntu 22.04 aarch64 (ARM). See
#                        ORACLE.md for the one-liner that finds it for your region.
#   OCI_AD               Availability domain name, e.g. "AbCd:EU-MADRID-1-AD-1".
#   OCI_SSH_KEY_PATH     Path to your SSH PUBLIC key (e.g. ~/.ssh/oci_omr.pub).
#
# Optional (sane defaults shown):
#   OCI_SHAPE            default VM.Standard.A1.Flex (the Always Free ARM shape)
#   OCI_OCPUS            default 4   (full Always Free ARM allotment)
#   OCI_MEM_GB           default 24  (full Always Free ARM allotment)
#   OCI_DISPLAY_NAME     default piano-helper-omr
#   OCI_BOOT_VOLUME_GB   default 50  (Always Free includes up to 200 GB total block
#                                     storage; 50 is comfortable for the ML stack)
#   OCI_CLOUD_INIT_FILE  default ./oracle-cloud-init.yaml (relative to this script)
#   OCI_PROFILE          default DEFAULT (the ~/.oci/config profile to use)
#   RETRY_SLEEP_MIN      default 30  (seconds, lower bound of backoff jitter)
#   RETRY_SLEEP_MAX      default 90  (seconds, upper bound of backoff jitter)
#   MAX_ATTEMPTS         default 0   (0 = retry forever until success/fatal)
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log() { printf '%s [oracle-launch] %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*"; }
die() { log "FATAL: $*"; exit 1; }

# --- preflight ---------------------------------------------------------------
command -v oci >/dev/null 2>&1 || die "oci CLI not found. Install it and run 'oci setup config' first (see ORACLE.md)."

: "${OCI_COMPARTMENT_ID:?set OCI_COMPARTMENT_ID (compartment OCID; see ORACLE.md)}"
: "${OCI_SUBNET_ID:?set OCI_SUBNET_ID (subnet OCID; see ORACLE.md)}"
: "${OCI_IMAGE_ID:?set OCI_IMAGE_ID (Ubuntu 22.04 aarch64 image OCID; see ORACLE.md)}"
: "${OCI_AD:?set OCI_AD (availability domain name; see ORACLE.md)}"
: "${OCI_SSH_KEY_PATH:?set OCI_SSH_KEY_PATH (path to your SSH PUBLIC key)}"

OCI_SHAPE="${OCI_SHAPE:-VM.Standard.A1.Flex}"
OCI_OCPUS="${OCI_OCPUS:-4}"
OCI_MEM_GB="${OCI_MEM_GB:-24}"
OCI_DISPLAY_NAME="${OCI_DISPLAY_NAME:-piano-helper-omr}"
OCI_BOOT_VOLUME_GB="${OCI_BOOT_VOLUME_GB:-50}"
OCI_CLOUD_INIT_FILE="${OCI_CLOUD_INIT_FILE:-$SCRIPT_DIR/oracle-cloud-init.yaml}"
OCI_PROFILE="${OCI_PROFILE:-DEFAULT}"
RETRY_SLEEP_MIN="${RETRY_SLEEP_MIN:-30}"
RETRY_SLEEP_MAX="${RETRY_SLEEP_MAX:-90}"
MAX_ATTEMPTS="${MAX_ATTEMPTS:-0}"

[ -f "$OCI_SSH_KEY_PATH" ] || die "SSH public key not found at OCI_SSH_KEY_PATH=$OCI_SSH_KEY_PATH"
[ -f "$OCI_CLOUD_INIT_FILE" ] || die "cloud-init file not found at $OCI_CLOUD_INIT_FILE"
case "$OCI_SSH_KEY_PATH" in
  *.pub) : ;;
  *) log "WARNING: OCI_SSH_KEY_PATH does not end in .pub. Make sure this is the PUBLIC key, not the private key." ;;
esac

# Guard against accidentally requesting a paid (non-Always-Free) shape.
if [ "$OCI_SHAPE" != "VM.Standard.A1.Flex" ] && [ "$OCI_SHAPE" != "VM.Standard.E2.1.Micro" ]; then
  die "OCI_SHAPE=$OCI_SHAPE is NOT an Always Free shape. Refusing to launch to avoid charges. Use VM.Standard.A1.Flex."
fi
# Guard the Always Free ARM ceiling (4 OCPU / 24 GB total across all A1 instances).
if [ "$OCI_SHAPE" = "VM.Standard.A1.Flex" ]; then
  if [ "$OCI_OCPUS" -gt 4 ] 2>/dev/null; then die "OCI_OCPUS=$OCI_OCPUS exceeds the Always Free ARM max of 4 OCPU."; fi
  if [ "$OCI_MEM_GB" -gt 24 ] 2>/dev/null; then die "OCI_MEM_GB=$OCI_MEM_GB exceeds the Always Free ARM max of 24 GB."; fi
fi

# --- idempotency: bail out if the instance already exists and is healthy -----
existing="$(oci compute instance list \
  --compartment-id "$OCI_COMPARTMENT_ID" \
  --display-name "$OCI_DISPLAY_NAME" \
  --lifecycle-state RUNNING \
  --profile "$OCI_PROFILE" \
  --query 'data[0].id' --raw-output 2>/dev/null || true)"
if [ -n "${existing:-}" ] && [ "$existing" != "null" ]; then
  log "An instance named '$OCI_DISPLAY_NAME' is already RUNNING ($existing). Nothing to do."
  log "If you want a fresh one, terminate it in the console first, or change OCI_DISPLAY_NAME."
  exit 0
fi

log "Config summary:"
log "  shape=$OCI_SHAPE ocpus=$OCI_OCPUS mem=${OCI_MEM_GB}GB boot=${OCI_BOOT_VOLUME_GB}GB"
log "  display-name=$OCI_DISPLAY_NAME ad=$OCI_AD profile=$OCI_PROFILE"
log "  compartment=$OCI_COMPARTMENT_ID"
log "  subnet=$OCI_SUBNET_ID"
log "  image=$OCI_IMAGE_ID"
log "  cloud-init=$OCI_CLOUD_INIT_FILE ssh-pub-key=$OCI_SSH_KEY_PATH"
log "  backoff=${RETRY_SLEEP_MIN}-${RETRY_SLEEP_MAX}s max-attempts=${MAX_ATTEMPTS:-forever}"

shape_config="{\"ocpus\": $OCI_OCPUS, \"memoryInGBs\": $OCI_MEM_GB}"

# --- the capacity-retry loop -------------------------------------------------
attempt=0
while :; do
  attempt=$((attempt + 1))
  log "Attempt $attempt: oci compute instance launch ..."

  set +e
  out="$(oci compute instance launch \
    --compartment-id "$OCI_COMPARTMENT_ID" \
    --availability-domain "$OCI_AD" \
    --shape "$OCI_SHAPE" \
    --shape-config "$shape_config" \
    --subnet-id "$OCI_SUBNET_ID" \
    --image-id "$OCI_IMAGE_ID" \
    --display-name "$OCI_DISPLAY_NAME" \
    --boot-volume-size-in-gbs "$OCI_BOOT_VOLUME_GB" \
    --assign-public-ip true \
    --ssh-authorized-keys-file "$OCI_SSH_KEY_PATH" \
    --user-data-file "$OCI_CLOUD_INIT_FILE" \
    --profile "$OCI_PROFILE" \
    --wait-for-state RUNNING \
    2>&1)"
  rc=$?
  set -e

  if [ "$rc" -eq 0 ]; then
    log "SUCCESS: instance launched and reached RUNNING."
    echo "$out" | grep -Ei '"id"|"display-name"|"lifecycle-state"' || true
    log "Next: find its public IP, SSH in, watch /var/log/omr-bootstrap.log, then"
    log "create /etc/piano-helper-omr.env and 'sudo systemctl restart omr-worker'. See ORACLE.md."
    exit 0
  fi

  # Decide: transient (retry) vs fatal (stop). Match on the error text OCI returns.
  if echo "$out" | grep -qiE 'Out of host capacity|Out of capacity for shape|too busy|InternalError|ServiceUnavailable|TooManyRequests|429|50[0-9]'; then
    : # transient, fall through to backoff
  elif echo "$out" | grep -qiE 'NotAuthenticated|NotAuthorized|Authorization failed|invalid.*key|InvalidParameter|LimitExceeded|QuotaExceeded|already exists|CannotParseRequest|NotFound'; then
    log "Non-retryable error from OCI. Stopping so you can fix config/creds:"
    echo "$out" | sed 's/^/    /'
    die "fix the above and re-run."
  else
    # Unknown error: log it but treat as transient so a one-off blip does not abort
    # an overnight wait. If it is truly fatal it will keep printing and you can stop.
    log "Unrecognized error (treating as transient; Ctrl-C if it is a real config issue):"
    echo "$out" | sed 's/^/    /'
  fi

  if [ "$MAX_ATTEMPTS" -gt 0 ] && [ "$attempt" -ge "$MAX_ATTEMPTS" ]; then
    die "reached MAX_ATTEMPTS=$MAX_ATTEMPTS without landing an instance. Capacity still exhausted."
  fi

  # Jittered backoff to avoid hammering the API in lockstep.
  span=$((RETRY_SLEEP_MAX - RETRY_SLEEP_MIN))
  if [ "$span" -lt 1 ]; then span=1; fi
  sleep_for=$((RETRY_SLEEP_MIN + RANDOM % (span + 1)))
  log "Capacity not available yet. Sleeping ${sleep_for}s before retry."
  sleep "$sleep_for"
done
