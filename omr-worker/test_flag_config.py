"""Tests for flag_config.apply_overrides: the R2-backed live OMR flag override that the worker reads
each poll cycle and applies onto os.environ (so the admin page toggles flags with no restart)."""
import json
import os
import sys
import types

# Stub botocore.exceptions so importing flag_config does not require boto3 installed.
for _name in ("botocore", "botocore.exceptions"):
    if _name not in sys.modules:
        sys.modules[_name] = types.ModuleType(_name)
if not hasattr(sys.modules["botocore.exceptions"], "ClientError"):
    sys.modules["botocore.exceptions"].ClientError = type("ClientError", (Exception,), {})

import pytest  # noqa: E402

import flag_config  # noqa: E402

ClientError = sys.modules["botocore.exceptions"].ClientError


class _Body:
    def __init__(self, data):
        self._data = data

    def read(self):
        return self._data


class _FakeClient:
    """get_object returns the canned JSON bytes, raises ClientError when `missing`, or raises a given
    error. Mirrors the boto3 S3 get_object surface flag_config uses."""

    def __init__(self, body=None, missing=False, error=None):
        self._body = body
        self._missing = missing
        self._error = error

    def get_object(self, Bucket, Key, Range=None):
        if self._error is not None:
            raise self._error
        if self._missing:
            raise ClientError()
        return {"Body": _Body(self._body)}


def _client_with(config):
    return _FakeClient(body=json.dumps(config).encode("utf-8"))


@pytest.fixture(autouse=True)
def _isolate(monkeypatch):
    # apply_overrides captures env defaults ONCE and mutates os.environ DIRECTLY (which monkeypatch
    # does not auto-revert), so reset the capture and snapshot/restore the known flag env per test.
    monkeypatch.setattr(flag_config, "_ENV_DEFAULTS", None)
    saved = {f: os.environ.get(f) for f in flag_config.KNOWN_FLAGS}
    yield
    for flag, value in saved.items():
        if value is None:
            os.environ.pop(flag, None)
        else:
            os.environ[flag] = value


def test_present_flag_is_applied(monkeypatch):
    monkeypatch.delenv("OMR_PROGRESSIVE", raising=False)
    flag_config.apply_overrides(_client_with({"OMR_PROGRESSIVE": "1"}), "bucket")
    assert os.environ.get("OMR_PROGRESSIVE") == "1"


def test_absent_flag_reverts_to_env_default(monkeypatch):
    # Box env has OMR_GEOM=1; a config that omits it must leave it at that default, not turn it off.
    monkeypatch.setenv("OMR_GEOM", "1")
    flag_config.apply_overrides(_client_with({"OMR_PROGRESSIVE": "1"}), "bucket")
    assert os.environ.get("OMR_GEOM") == "1"
    assert os.environ.get("OMR_PROGRESSIVE") == "1"


def test_config_can_turn_off_an_env_flag(monkeypatch):
    monkeypatch.setenv("OMR_GEOM_FUSION", "1")
    flag_config.apply_overrides(_client_with({"OMR_GEOM_FUSION": "0"}), "bucket")
    assert os.environ.get("OMR_GEOM_FUSION") == "0"


def test_missing_config_reverts_all_to_env(monkeypatch):
    monkeypatch.setenv("OMR_GEOM", "1")
    monkeypatch.delenv("OMR_PROGRESSIVE", raising=False)
    # Apply an override turning PROGRESSIVE on...
    flag_config.apply_overrides(_client_with({"OMR_PROGRESSIVE": "1"}), "bucket")
    assert os.environ.get("OMR_PROGRESSIVE") == "1"
    # ...then the config disappears -> revert to captured env defaults (PROGRESSIVE was unset).
    flag_config.apply_overrides(_FakeClient(missing=True), "bucket")
    assert os.environ.get("OMR_PROGRESSIVE") is None
    assert os.environ.get("OMR_GEOM") == "1"


def test_unknown_and_paid_keys_are_ignored(monkeypatch):
    monkeypatch.delenv("OMR_LLM", raising=False)
    flag_config.apply_overrides(_client_with({"OMR_LLM": "1", "BOGUS": "1"}), "bucket")
    assert os.environ.get("OMR_LLM") is None  # the excluded paid flag is never applied from R2
    assert os.environ.get("BOGUS") is None


def test_invalid_value_reverts_to_default(monkeypatch):
    monkeypatch.setenv("OMR_GEOM", "1")
    flag_config.apply_overrides(_client_with({"OMR_GEOM": "maybe"}), "bucket")
    assert os.environ.get("OMR_GEOM") == "1"  # invalid value -> restore default, never garbage


def test_never_raises_on_garbage_or_nonobject_body():
    flag_config.apply_overrides(_FakeClient(body=b"not json at all"), "bucket")
    flag_config.apply_overrides(_FakeClient(body=b"[1, 2, 3]"), "bucket")  # valid json, not a dict


def test_never_raises_on_client_or_read_error():
    flag_config.apply_overrides(_FakeClient(missing=True), "bucket")
    flag_config.apply_overrides(_FakeClient(error=RuntimeError("boom")), "bucket")
