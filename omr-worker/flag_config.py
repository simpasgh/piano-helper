#!/usr/bin/env python3
"""Live OMR feature-flag overrides from R2, so the admin page can toggle engine flags with NO restart.

The worker reads config/omr-flags.json (written by the token-gated /api/flags Pages Function) at the
top of each poll cycle and applies the known flags onto os.environ. Every flag check in the worker
stack reads os.environ PER JOB (worker.*_enabled, reconcile.referee_enabled, llm_omr.llm_enabled), so
mutating os.environ is picked up uniformly with no per-module change.

The ORIGINAL env values are captured ONCE at startup (before any override is applied), so an absent or
deleted config reverts cleanly to the box env: the config is authoritative only for the flags it
lists, and a flag it omits (or a missing config entirely) falls back to the captured env default.
Side-effect-free beyond os.environ. NEVER raises (a flag hiccup must not kill the poll loop).

OMR_LLM is deliberately NOT a known flag here (it calls a paid API), so it can never be toggled from
the web; it stays box-env-only. KNOWN_FLAGS MUST match src/flags-server.ts (a JS source-guard test in
src/flags-server.test.ts reads this file as text and asserts the two lists agree).
"""
from __future__ import annotations

import json
import os
import time

from botocore.exceptions import ClientError

CONFIG_KEY = "config/omr-flags.json"

# Read at most this many bytes of the config object. A real config is ~200 bytes (7 flags); a Range
# read means a giant/malicious object cannot be fully buffered + parsed in the poll thread (it just
# truncates -> parse error -> no override). Defense in depth on top of the write-side allowlist.
_MAX_CONFIG_BYTES = 65536

KNOWN_FLAGS = (
    "OMR_ENSEMBLE",
    "OMR_ENSEMBLE_REFEREE",
    "OMR_GEOM",
    "OMR_GEOM_PRIMARY",
    "OMR_GEOM_FUSION",
    "OMR_PHOTO_CLARITY",
    "OMR_UVDOC",
    "OMR_SEQ2SEQ",
    "OMR_PROGRESSIVE",
    "OMR_PROGRESSIVE_PAGES",
    "OMR_PROGRESSIVE_BLOCKS",
)

_VALID_VALUES = ("0", "1")

# Original env value of each known flag, captured the first time apply_overrides runs (before any
# override has been applied), so a dropped flag / missing config reverts to it. None until captured.
_ENV_DEFAULTS = None


def _capture_defaults():
    global _ENV_DEFAULTS
    if _ENV_DEFAULTS is None:
        _ENV_DEFAULTS = {flag: os.environ.get(flag) for flag in KNOWN_FLAGS}


def _restore(flag):
    """Reset a flag to its captured env default (remove it if it was originally unset)."""
    default = _ENV_DEFAULTS.get(flag) if _ENV_DEFAULTS else None
    if default is None:
        os.environ.pop(flag, None)
    else:
        os.environ[flag] = default


def _read_override(client, bucket):
    """Fetch + parse config/omr-flags.json, returning the dict or {} if absent/unreadable/garbage.
    Reads at most _MAX_CONFIG_BYTES (Range) so a huge object cannot be buffered in the poll thread.
    NEVER raises: a NoSuchKey (no config yet) or any S3/parse error degrades to no override."""
    try:
        obj = client.get_object(
            Bucket=bucket, Key=CONFIG_KEY, Range="bytes=0-%d" % (_MAX_CONFIG_BYTES - 1)
        )
        data = json.loads(obj["Body"].read())
        return data if isinstance(data, dict) else {}
    except ClientError:
        return {}  # NoSuchKey (no config yet) or any S3 error -> no override.
    except Exception:
        return {}  # parse error / odd body -> no override.


def apply_overrides(client, bucket):
    """Apply the R2 flag override onto os.environ. For each KNOWN flag: present with "0"/"1" -> that
    value; absent or invalid -> restore the captured env default. So the config is authoritative for
    the flags it lists and the box env is the fallback for the rest. NEVER raises."""
    try:
        _capture_defaults()
        override = _read_override(client, bucket)
        for flag in KNOWN_FLAGS:
            value = override.get(flag)
            if value in _VALID_VALUES:
                os.environ[flag] = value
            else:
                _restore(flag)
    except Exception as err:
        # Never raise into the poll loop, but leave a breadcrumb (the inner read already degrades to
        # no-override, so reaching here is unexpected) rather than failing silently.
        try:
            print(time.strftime("%Y-%m-%dT%H:%M:%S"), "flag_config apply_overrides failed:", repr(err), flush=True)
        except Exception:
            pass
