"""Unit tests for the OMR worker preprocessing (#109).

Covers the rasterization changes we own: the DPI value, multi-page handling
(vertical stitch), and the oemer deskew gating. These are the levers that raise raw
OMR fidelity for clean vector PDFs.

Run locally with: python3 -m pytest omr-worker/test_worker.py

Note on CI: the repo's CI (.github/workflows/ci.yml) is a Node pipeline (typecheck +
vitest + build) and does not run pytest, so these Python tests are not a CI gate today.
A lightweight JS source-guard test (src/omr-worker.test.ts) locks the worker wiring
(DPI constant, all-pages rasterization, deskew flag) inside the existing vitest run so a
regression here is still caught in CI. See tech-lead.md.

boto3 is an install-time dependency of worker.py but is not needed for the pure
preprocessing functions, so it is stubbed before import to keep these tests runnable on
any machine (including CI, if it ever grows a pytest step).
"""

import sys
import types

# Stub the S3 stack so importing worker.py does not require boto3 to be installed.
for _name in ("boto3", "botocore", "botocore.client", "botocore.exceptions"):
    if _name not in sys.modules:
        sys.modules[_name] = types.ModuleType(_name)
if not hasattr(sys.modules["botocore.client"], "Config"):
    sys.modules["botocore.client"].Config = object
if not hasattr(sys.modules["botocore.exceptions"], "ClientError"):
    sys.modules["botocore.exceptions"].ClientError = type(
        "ClientError", (Exception,), {}
    )

import pytest  # noqa: E402

import worker  # noqa: E402

Image = pytest.importorskip("PIL.Image")


def test_dpi_is_in_the_swept_sweet_spot():
    # The old workflow rasterized at 300 DPI; #109 raised it to 400 for denser pixels.
    # The #112 sweep (250/300/350/400/500 on icarus.pdf, judged by recall AND fidelity
    # vs the source PDF) then found 400 was PAST oemer's sweet spot and 350 recovers more
    # genuine LH chord tones with zero fabricated accidentals. Pin the value to the swept
    # range: above the old 300 baseline but not back up at the 400 that hurt chord
    # separation. A future edit must not silently drift outside this measured band.
    assert 300 < worker.PDF_RASTER_DPI <= 400
    assert worker.PDF_RASTER_DPI == 350


def test_oemer_command_disables_deskew_on_pdf_path():
    cmd = worker.oemer_command("/tmp/page.png", "/tmp/out", without_deskew=True)
    assert cmd == ["oemer", "/tmp/page.png", "-o", "/tmp/out", "--without-deskew"]


def test_oemer_command_keeps_deskew_for_raster_images():
    # A scanned PNG/JPEG may be skewed, so deskew stays on (no flag).
    cmd = worker.oemer_command("/tmp/page.png", "/tmp/out", without_deskew=False)
    assert cmd == ["oemer", "/tmp/page.png", "-o", "/tmp/out"]
    assert "--without-deskew" not in cmd


def _make_png(path, size, color):
    Image.new("RGB", size, color).save(path)


def test_single_page_stitch_is_a_plain_copy(tmp_path):
    src = tmp_path / "page-1.png"
    _make_png(src, (120, 90), (10, 20, 30))
    dest = tmp_path / "stitched.png"

    out = worker.stitch_pages_vertical([str(src)], str(dest))

    assert out == str(dest)
    with Image.open(out) as im:
        assert im.size == (120, 90)
        assert im.mode == "RGB"


def test_multi_page_stitch_stacks_vertically(tmp_path):
    a = tmp_path / "page-1.png"
    b = tmp_path / "page-2.png"
    _make_png(a, (100, 60), (200, 0, 0))   # red, narrower
    _make_png(b, (140, 40), (0, 0, 200))   # blue, wider
    dest = tmp_path / "stitched.png"

    worker.stitch_pages_vertical([str(a), str(b)], str(dest))

    with Image.open(dest) as im:
        # Width is the widest page; height is the sum (no page dropped).
        assert im.size == (140, 100)
        # Page 1 sits at the top, page 2 directly below it.
        assert im.getpixel((0, 0)) == (200, 0, 0)
        assert im.getpixel((0, 80)) == (0, 0, 200)
        # The narrow first page leaves a white-background gutter, not garbage.
        assert im.getpixel((120, 10)) == (255, 255, 255)


def test_stitch_preserves_document_page_order(tmp_path):
    # pdftoppm names pages page-1/page-01/page-001; sorted() must keep them in order.
    first = tmp_path / "page-1.png"
    second = tmp_path / "page-2.png"
    third = tmp_path / "page-3.png"
    _make_png(first, (10, 10), (255, 0, 0))
    _make_png(second, (10, 10), (0, 255, 0))
    _make_png(third, (10, 10), (0, 0, 255))
    dest = tmp_path / "stitched.png"

    worker.stitch_pages_vertical([str(first), str(second), str(third)], str(dest))

    with Image.open(dest) as im:
        assert im.size == (10, 30)
        assert im.getpixel((5, 5)) == (255, 0, 0)     # page 1
        assert im.getpixel((5, 15)) == (0, 255, 0)    # page 2
        assert im.getpixel((5, 25)) == (0, 0, 255)    # page 3


def test_stitch_rejects_empty_page_list(tmp_path):
    with pytest.raises(RuntimeError):
        worker.stitch_pages_vertical([], str(tmp_path / "stitched.png"))


def test_stitch_rejects_too_many_pages(tmp_path):
    # A crafted many-page 10 MB vector PDF must not be able to drive an unbounded stitch
    # (OOM risk on the Always Free VM). Reject before opening any page image.
    paths = [
        str(tmp_path / ("page-%03d.png" % i))
        for i in range(worker.MAX_STITCH_PAGES + 1)
    ]
    # The files need not exist: the page-count guard fires before any Image.open.
    with pytest.raises(RuntimeError):
        worker.stitch_pages_vertical(paths, str(tmp_path / "stitched.png"))


def test_stitch_rejects_oversized_total_area(tmp_path, monkeypatch):
    # Lower the pixel cap so a couple of small pages exceed it, proving the area guard
    # rejects (raising) instead of allocating a giant canvas. Two pages stay under the
    # page-count cap, so this isolates the AREA guard.
    # Cap = 2000: a single 40x40 page (1600 px) still opens (Pillow bomb guard is 2x cap),
    # but the two-page total (3200 px) trips the pre-allocation area guard.
    monkeypatch.setattr(worker, "MAX_STITCH_PIXELS", 2000)
    a = tmp_path / "page-1.png"
    b = tmp_path / "page-2.png"
    _make_png(a, (40, 40), (0, 0, 0))   # 1600 px each, 3200 total > 2000
    _make_png(b, (40, 40), (0, 0, 0))
    with pytest.raises(RuntimeError):
        worker.stitch_pages_vertical([str(a), str(b)], str(tmp_path / "stitched.png"))


# --- Clarity-OMR engine wiring (#135) ----------------------------------------------------


def test_clarity_command_shape():
    cmd = worker.clarity_command(
        "/venv/bin/python", "/clarity/omr.py", "/in/score.pdf", "/out/clarity.musicxml",
        "/work",
    )
    assert cmd == [
        "/venv/bin/python",
        "/clarity/omr.py",
        "/in/score.pdf",
        "-o",
        "/out/clarity.musicxml",
        "--device",
        "cpu",
        "--fast",
        "--work-dir",
        "/work",
    ]


def test_run_clarity_returns_none_when_env_unset(tmp_path, monkeypatch):
    # With CLARITY_OMR_DIR / CLARITY_PYTHON unset, run_clarity must return None (no crash)
    # so process_job falls back to oemer.
    monkeypatch.delenv("CLARITY_OMR_DIR", raising=False)
    monkeypatch.delenv("CLARITY_PYTHON", raising=False)
    assert worker.run_clarity(str(tmp_path / "score.pdf"), str(tmp_path)) is None


def test_run_clarity_returns_none_when_paths_missing(tmp_path, monkeypatch):
    # Env set but pointing at non-existent script/python -> None, not an exception.
    monkeypatch.setenv("CLARITY_OMR_DIR", str(tmp_path / "nope"))
    monkeypatch.setenv("CLARITY_PYTHON", str(tmp_path / "nopython"))
    assert worker.run_clarity(str(tmp_path / "score.pdf"), str(tmp_path)) is None


# --- Slice 1: concurrent engine scheduling with same fallback selection ------------------
# select_primary_result runs Clarity + oemer CONCURRENTLY but keeps the EXACT old selection
# precedence (Clarity > oemer; homr is the caller's last resort). These tests pin: which
# output is chosen, that the two engines truly overlap (wall-clock is max, not sum), that a
# per-engine timeout / failure degrades to the survivor, and that PNG/JPEG skips Clarity.

import subprocess  # noqa: E402
import threading  # noqa: E402
import time as _time  # noqa: E402


def _slow_runner(label, seconds, return_value, log_list, lock):
    """A fake engine runner that sleeps `seconds` (simulating a subprocess wall-clock) then
    returns return_value, recording its start/end so concurrency can be asserted."""

    def run():
        with lock:
            log_list.append(("start", label, _time.monotonic()))
        _time.sleep(seconds)
        with lock:
            log_list.append(("end", label, _time.monotonic()))
        return return_value

    return run


def test_select_both_succeed_chooses_clarity():
    # Both primaries produce output. Selection precedence is unchanged: Clarity wins.
    result, source = worker.select_primary_result(
        lambda: "/clarity.musicxml",
        lambda: "/oemer.musicxml",
        is_pdf_input=True,
    )
    assert result == "/clarity.musicxml"
    assert source == "clarity"


def test_select_clarity_fails_oemer_succeeds_chooses_oemer():
    # Clarity fails (returns None, e.g. error or timeout); we degrade to the oemer survivor.
    result, source = worker.select_primary_result(
        lambda: None,
        lambda: "/oemer.musicxml",
        is_pdf_input=True,
    )
    assert result == "/oemer.musicxml"
    assert source == "oemer"


def test_select_both_fail_returns_none():
    # Both primaries fail: the selector returns None so the caller tries homr / the sentinel.
    result, source = worker.select_primary_result(
        lambda: None,
        lambda: None,
        is_pdf_input=True,
    )
    assert result is None
    assert source is None


def test_select_png_jpeg_skips_clarity_runs_only_oemer():
    # Clarity is PDF-only; for a raster upload it must NOT be launched. If the selector ever
    # called the Clarity runner here it would raise, proving Clarity is skipped.
    def clarity_must_not_run():
        raise AssertionError("Clarity must not run for a non-PDF input")

    result, source = worker.select_primary_result(
        clarity_must_not_run,
        lambda: "/oemer.musicxml",
        is_pdf_input=False,
    )
    assert result == "/oemer.musicxml"
    assert source == "oemer"


def test_select_runs_engines_concurrently_wall_clock_is_max_not_sum():
    # The whole point of Slice 1: the two engines OVERLAP. With a 0.3s Clarity and a 0.3s
    # oemer, a sequential flow would take ~0.6s; concurrent takes ~0.3s. Assert both via the
    # interleaved start/end log (oemer starts before Clarity ends) AND the total wall-clock.
    events = []
    lock = threading.Lock()
    delay = 0.3
    clarity = _slow_runner("clarity", delay, "/clarity.musicxml", events, lock)
    oemer = _slow_runner("oemer", delay, "/oemer.musicxml", events, lock)

    start = _time.monotonic()
    result, source = worker.select_primary_result(clarity, oemer, is_pdf_input=True)
    elapsed = _time.monotonic() - start

    # Output selection still Clarity (both succeeded).
    assert result == "/clarity.musicxml"
    assert source == "clarity"
    # Wall-clock is ~max(delay), not the ~2*delay a sequential run would cost. Generous
    # upper bound (1.5*delay) to stay robust on a loaded CI box while still failing a
    # sequential implementation (which would need ~2*delay).
    assert elapsed < delay * 1.5, "engines must overlap (wall-clock ~max, not sum)"
    # And prove overlap directly: both engines were running at the same time, i.e. the
    # second start happened before the first end.
    starts = sorted(t for kind, _, t in events if kind == "start")
    ends = sorted(t for kind, _, t in events if kind == "end")
    assert starts[1] < ends[0], "second engine started before the first finished"


def test_run_oemer_timeout_counts_as_failure(tmp_path, monkeypatch):
    # A subprocess that exceeds the per-engine timeout raises TimeoutExpired; run_oemer must
    # treat that as a FAILURE (return None) so the ensemble degrades to the survivor.
    def fake_run(*args, **kwargs):
        raise subprocess.TimeoutExpired(cmd="oemer", timeout=kwargs.get("timeout"))

    monkeypatch.setattr(worker.subprocess, "run", fake_run)
    assert worker.run_oemer(str(tmp_path / "page.png"), str(tmp_path), timeout=0.01) is None


def test_run_clarity_timeout_counts_as_failure(tmp_path, monkeypatch):
    # Same contract for Clarity: a timeout -> None, no exception into process_job.
    script = tmp_path / "omr.py"
    script.write_text("# stub")
    python = tmp_path / "python"
    python.write_text("#!/bin/sh\n")
    monkeypatch.setenv("CLARITY_OMR_DIR", str(tmp_path))
    monkeypatch.setenv("CLARITY_PYTHON", str(python))

    def fake_run(*args, **kwargs):
        raise subprocess.TimeoutExpired(cmd="clarity", timeout=kwargs.get("timeout"))

    monkeypatch.setattr(worker.subprocess, "run", fake_run)
    assert worker.run_clarity(str(tmp_path / "score.pdf"), str(tmp_path), timeout=0.01) is None


def test_select_one_engine_times_out_other_used():
    # Concretely model "one engine times out": its runner returns None (the runners convert
    # a TimeoutExpired into None). If Clarity times out, oemer is used; if oemer times out,
    # Clarity is used. The survivor's output is chosen, never the sentinel.
    # Clarity times out -> oemer wins.
    result, source = worker.select_primary_result(
        lambda: None,            # clarity timed out
        lambda: "/oemer.musicxml",
        is_pdf_input=True,
    )
    assert (result, source) == ("/oemer.musicxml", "oemer")
    # oemer times out -> Clarity wins (still the higher-precedence survivor).
    result, source = worker.select_primary_result(
        lambda: "/clarity.musicxml",
        lambda: None,            # oemer timed out
        is_pdf_input=True,
    )
    assert (result, source) == ("/clarity.musicxml", "clarity")


def test_engine_timeout_seconds_default_and_override(monkeypatch):
    monkeypatch.delenv("OMR_ENGINE_TIMEOUT_SECONDS", raising=False)
    assert worker.engine_timeout_seconds() == worker.DEFAULT_ENGINE_TIMEOUT_SECONDS
    monkeypatch.setenv("OMR_ENGINE_TIMEOUT_SECONDS", "42")
    assert worker.engine_timeout_seconds() == 42
    # Garbage or non-positive falls back to the default (never disables the runaway guard).
    monkeypatch.setenv("OMR_ENGINE_TIMEOUT_SECONDS", "nonsense")
    assert worker.engine_timeout_seconds() == worker.DEFAULT_ENGINE_TIMEOUT_SECONDS
    monkeypatch.setenv("OMR_ENGINE_TIMEOUT_SECONDS", "0")
    assert worker.engine_timeout_seconds() == worker.DEFAULT_ENGINE_TIMEOUT_SECONDS


# --- OMR_ENSEMBLE flag gating (Slice 1) --------------------------------------------------
# The concurrent select_primary_result path ships behind OMR_ENSEMBLE (default OFF) so prod
# latency is unchanged until QA validates the parallel path. Flag OFF must take the LEGACY
# Clarity-first short-circuit (oemer NOT run when Clarity succeeds on a PDF, no upfront
# rasterization on the Clarity happy path). Flag ON must run both engines concurrently.


def test_ensemble_enabled_truthy_parsing(monkeypatch):
    # Default (unset) is OFF: prod stays on the legacy short-circuit.
    monkeypatch.delenv("OMR_ENSEMBLE", raising=False)
    assert worker.ensemble_enabled() is False
    # "1" and "true" (case-insensitive, whitespace-tolerant) are ON.
    for on in ("1", "true", "TRUE", " True ", "tRuE"):
        monkeypatch.setenv("OMR_ENSEMBLE", on)
        assert worker.ensemble_enabled() is True, on
    # Everything else is OFF (never accidentally enables the parallel path in prod).
    for off in ("0", "false", "False", "", "yes", "on", "2", "garbage"):
        monkeypatch.setenv("OMR_ENSEMBLE", off)
        assert worker.ensemble_enabled() is False, off


def test_legacy_pdf_clarity_success_does_not_run_oemer(tmp_path, monkeypatch):
    # FLAG OFF, the load-bearing prod guarantee: when Clarity succeeds on a PDF, oemer is
    # NEVER run and the PDF is NEVER rasterized (so latency stays ~15s, not ~max(engines)).
    monkeypatch.delenv("OMR_ENSEMBLE", raising=False)
    clarity_out = tmp_path / "clarity.musicxml"
    clarity_out.write_text("<score/>")

    monkeypatch.setattr(worker, "run_clarity", lambda *a, **k: str(clarity_out))

    def oemer_must_not_run(*a, **k):
        raise AssertionError("oemer must not run when Clarity succeeds (legacy short-circuit)")

    def raster_must_not_run(*a, **k):
        raise AssertionError("PDF must not be rasterized on the Clarity happy path")

    monkeypatch.setattr(worker, "run_oemer", oemer_must_not_run)
    monkeypatch.setattr(worker, "rasterize_if_pdf", raster_must_not_run)

    result, source = worker._select_legacy(
        "job", str(tmp_path / "input.bin"), str(tmp_path), is_pdf_input=True
    )
    assert (result, source) == (str(clarity_out), "clarity")


def test_legacy_pdf_clarity_fails_falls_back_to_oemer(tmp_path, monkeypatch):
    # FLAG OFF: Clarity fails -> rasterize -> oemer (sequential fallback, unchanged).
    monkeypatch.delenv("OMR_ENSEMBLE", raising=False)
    oemer_out = tmp_path / "oemer.musicxml"
    oemer_out.write_text("<score/>")

    monkeypatch.setattr(worker, "run_clarity", lambda *a, **k: None)
    monkeypatch.setattr(worker, "rasterize_if_pdf", lambda *a, **k: ("/img.png", True))
    monkeypatch.setattr(worker, "run_oemer", lambda *a, **k: str(oemer_out))

    def homr_must_not_run(*a, **k):
        raise AssertionError("homr must not run when oemer succeeds")

    monkeypatch.setattr(worker, "run_homr", homr_must_not_run)

    result, source = worker._select_legacy(
        "job", str(tmp_path / "input.bin"), str(tmp_path), is_pdf_input=True
    )
    assert (result, source) == (str(oemer_out), "oemer")


def test_legacy_png_skips_clarity_runs_oemer(tmp_path, monkeypatch):
    # FLAG OFF, raster upload: Clarity is PDF-only so it is skipped; oemer runs directly.
    monkeypatch.delenv("OMR_ENSEMBLE", raising=False)
    oemer_out = tmp_path / "oemer.musicxml"
    oemer_out.write_text("<score/>")

    def clarity_must_not_run(*a, **k):
        raise AssertionError("Clarity must not run for a non-PDF input")

    monkeypatch.setattr(worker, "run_clarity", clarity_must_not_run)
    monkeypatch.setattr(worker, "rasterize_if_pdf", lambda *a, **k: ("/img.png", False))
    monkeypatch.setattr(worker, "run_oemer", lambda *a, **k: str(oemer_out))

    result, source = worker._select_legacy(
        "job", str(tmp_path / "input.bin"), str(tmp_path), is_pdf_input=False
    )
    assert (result, source) == (str(oemer_out), "oemer")


def test_ensemble_pdf_runs_both_engines(tmp_path, monkeypatch):
    # FLAG ON: BOTH primaries run for a PDF (oemer is launched even though Clarity wins), so
    # oemer's output is available for reconciliation (Slice 3). Records each call. When both
    # succeed reconcile fires and the source is "ensemble"; the result is the reconciled file.
    monkeypatch.setenv("OMR_ENSEMBLE", "1")
    clarity_out = tmp_path / "clarity.musicxml"
    clarity_out.write_text("<score/>")
    oemer_out = tmp_path / "oemer.musicxml"
    oemer_out.write_text("<score/>")
    calls = []

    def fake_clarity(*a, **k):
        calls.append("clarity")
        return str(clarity_out)

    def fake_oemer(*a, **k):
        calls.append("oemer")
        return str(oemer_out)

    monkeypatch.setattr(worker, "run_clarity", fake_clarity)
    monkeypatch.setattr(worker, "run_oemer", fake_oemer)
    monkeypatch.setattr(worker, "rasterize_if_pdf", lambda *a, **k: ("/img.png", True))

    result, source = worker._select_ensemble(
        "job", str(tmp_path / "input.bin"), str(tmp_path), is_pdf_input=True
    )
    # Both engines ran, so reconcile fired: source is "ensemble" and the result is the new
    # reconciled file (not either engine's raw output).
    assert source == "ensemble"
    assert result == str(tmp_path / "reconciled.musicxml")
    assert set(calls) == {"clarity", "oemer"}, "both engines must run under the flag"


def test_ensemble_pdf_raster_failure_still_runs_clarity(tmp_path, monkeypatch):
    # FLAG ON: a PDF whose rasterization fails must NOT crash the job; Clarity reads the PDF
    # directly and still runs (raster engines disabled).
    monkeypatch.setenv("OMR_ENSEMBLE", "1")
    clarity_out = tmp_path / "clarity.musicxml"
    clarity_out.write_text("<score/>")

    def boom(*a, **k):
        raise RuntimeError("pdftoppm exploded")

    monkeypatch.setattr(worker, "rasterize_if_pdf", boom)
    monkeypatch.setattr(worker, "run_clarity", lambda *a, **k: str(clarity_out))

    def oemer_must_not_run(*a, **k):
        raise AssertionError("oemer must not run when rasterization failed")

    monkeypatch.setattr(worker, "run_oemer", oemer_must_not_run)

    result, source = worker._select_ensemble(
        "job", str(tmp_path / "input.bin"), str(tmp_path), is_pdf_input=True
    )
    assert (result, source) == (str(clarity_out), "clarity")


# --- reconcile wiring (Slice 3) ----------------------------------------------------------

_JOB_ID = "12345678-1234-1234-1234-123456789abc"


class _FakeClient:
    """Minimal S3 stand-in for driving process_job end-to-end in-process: download_file writes
    the canned input bytes, put_object captures the written body, delete_object is a no-op.
    result_exists is monkeypatched to False so the job always processes."""

    def __init__(self, input_bytes=b"", is_pdf=False, metadata=None):
        self._input_bytes = input_bytes
        self._is_pdf = is_pdf
        self._metadata = metadata or {}
        self.put_body = None

    def download_file(self, Bucket, Key, dest):
        with open(dest, "wb") as fh:
            fh.write(self._input_bytes)

    def head_object(self, Bucket, Key):
        return {"Metadata": dict(self._metadata)}

    def put_object(self, Bucket, Key, Body, ContentType):
        self.put_body = Body

    def delete_object(self, Bucket, Key):
        pass


def _drive_process_job(monkeypatch, client, is_pdf=True):
    """Run process_job against a _FakeClient, stubbing result_exists (no real head_object) and
    sniff_mime (no real `file` binary). is_pdf controls the sniffed mime."""
    monkeypatch.setattr(worker, "result_exists", lambda *a, **k: False)
    monkeypatch.setattr(
        worker, "sniff_mime", lambda p: "application/pdf" if is_pdf else "image/png"
    )
    worker.process_job(client, "bucket", _JOB_ID)


def test_ensemble_both_engines_reconcile_before_merge_and_normalize(tmp_path, monkeypatch):
    # FLAG ON + BOTH engines succeed: reconcile MUST run on (clarity, oemer) BEFORE the shared
    # merge_to_grand_staff -> normalize_ties post-transforms. Order guard: record the call
    # sequence and assert reconcile precedes both post-transforms.
    monkeypatch.setenv("OMR_ENSEMBLE", "1")
    clarity_out = tmp_path / "clarity.musicxml"
    clarity_out.write_text("<score/>")
    oemer_out = tmp_path / "oemer.musicxml"
    oemer_out.write_text("<score/>")

    order = []

    monkeypatch.setattr(worker, "run_clarity", lambda *a, **k: str(clarity_out))
    monkeypatch.setattr(worker, "run_oemer", lambda *a, **k: str(oemer_out))
    monkeypatch.setattr(worker, "rasterize_if_pdf", lambda *a, **k: ("/img.png", True))

    def fake_reconcile(primary, secondary, input_pdf=None):
        order.append("reconcile")
        return b"<reconciled/>"

    def fake_merge(body):
        order.append("merge")
        return body

    def fake_normalize(body):
        order.append("normalize")
        return body

    monkeypatch.setattr(worker.reconcile, "reconcile", fake_reconcile)
    monkeypatch.setattr(worker, "merge_to_grand_staff", fake_merge)
    monkeypatch.setattr(worker, "normalize_ties", fake_normalize)

    client = _FakeClient(input_bytes=b"%PDF-1.4 fake")
    _drive_process_job(monkeypatch, client, is_pdf=True)

    assert order == ["reconcile", "merge", "normalize"], order
    # The reconciled bytes (post both no-op transforms) are what gets written.
    assert client.put_body == b"<reconciled/>"


def test_ensemble_single_engine_reconcile_is_passthrough(tmp_path, monkeypatch):
    # FLAG ON but only ONE engine (oemer) succeeds: reconcile is NOT called (it would be a
    # pass-through anyway). The survivor's bytes flow straight to the post-transforms, so this
    # is byte-identical to single-engine = no regression vs Slice 1.
    monkeypatch.setenv("OMR_ENSEMBLE", "1")
    oemer_out = tmp_path / "oemer.musicxml"
    oemer_out.write_text("<score/>")

    called = {"reconcile": False}

    monkeypatch.setattr(worker, "run_clarity", lambda *a, **k: None)
    monkeypatch.setattr(worker, "run_oemer", lambda *a, **k: str(oemer_out))
    monkeypatch.setattr(worker, "rasterize_if_pdf", lambda *a, **k: ("/img.png", True))

    def fake_reconcile(primary, secondary, input_pdf=None):
        called["reconcile"] = True
        return primary

    monkeypatch.setattr(worker.reconcile, "reconcile", fake_reconcile)

    result, source = worker._select_ensemble(
        "job", str(tmp_path / "input.bin"), str(tmp_path), is_pdf_input=True
    )
    assert (result, source) == (str(oemer_out), "oemer")
    assert called["reconcile"] is False, "reconcile must not run with only one engine"


def test_job_is_fast_reads_metadata_and_never_raises():
    # Truthy spellings of the fast flag -> True; absent/empty/missing -> False (accurate).
    assert worker.job_is_fast(_FakeClient(metadata={"fast": "1"}), "b", "j") is True
    assert worker.job_is_fast(_FakeClient(metadata={"fast": "true"}), "b", "j") is True
    assert worker.job_is_fast(_FakeClient(metadata={"fast": "0"}), "b", "j") is False
    assert worker.job_is_fast(_FakeClient(metadata={}), "b", "j") is False
    assert worker.job_is_fast(_FakeClient(), "b", "j") is False

    class _Boom:
        def head_object(self, Bucket, Key):
            raise RuntimeError("metadata read failed")

    # A read failure must default to accurate (False), never raise.
    assert worker.job_is_fast(_Boom(), "b", "j") is False


def test_fast_flag_takes_legacy_path_even_when_ensemble_on(tmp_path, monkeypatch):
    # FLAG ON but the upload is tagged fast=1: the worker takes the single-engine legacy path
    # and NEVER runs the ensemble (no oemer, no reconcile), trading accuracy for ~5x latency.
    monkeypatch.setenv("OMR_ENSEMBLE", "1")
    clarity_out = tmp_path / "clarity.musicxml"
    clarity_out.write_text("<score/>")
    monkeypatch.setattr(worker, "run_clarity", lambda *a, **k: str(clarity_out))

    def ensemble_must_not_run(*a, **k):
        raise AssertionError("ensemble must not run for a fast-tagged job")

    monkeypatch.setattr(worker, "_select_ensemble", ensemble_must_not_run)
    monkeypatch.setattr(worker, "merge_to_grand_staff", lambda b: b)
    monkeypatch.setattr(worker, "normalize_ties", lambda b: b)

    client = _FakeClient(input_bytes=b"%PDF-1.4 fake", metadata={"fast": "1"})
    _drive_process_job(monkeypatch, client, is_pdf=True)
    assert client.put_body is not None  # the legacy Clarity path produced the result


def test_default_job_with_ensemble_on_runs_ensemble(tmp_path, monkeypatch):
    # FLAG ON and NO fast flag: the ensemble runs (the default accurate path).
    monkeypatch.setenv("OMR_ENSEMBLE", "1")
    ran = {"ensemble": False}

    def fake_ensemble(*a, **k):
        ran["ensemble"] = True
        return None, None

    monkeypatch.setattr(worker, "_select_ensemble", fake_ensemble)
    monkeypatch.setattr(worker, "merge_to_grand_staff", lambda b: b)
    monkeypatch.setattr(worker, "normalize_ties", lambda b: b)

    client = _FakeClient(input_bytes=b"%PDF-1.4 fake")  # no fast metadata
    _drive_process_job(monkeypatch, client, is_pdf=True)
    assert ran["ensemble"] is True


def test_flag_off_never_calls_reconcile(tmp_path, monkeypatch):
    # FLAG OFF (prod default): the legacy path runs and reconcile is NEVER called.
    monkeypatch.delenv("OMR_ENSEMBLE", raising=False)
    clarity_out = tmp_path / "clarity.musicxml"
    clarity_out.write_text("<score/>")

    monkeypatch.setattr(worker, "run_clarity", lambda *a, **k: str(clarity_out))

    def reconcile_must_not_run(*a, **k):
        raise AssertionError("reconcile must not run when OMR_ENSEMBLE is OFF")

    monkeypatch.setattr(worker.reconcile, "reconcile", reconcile_must_not_run)
    monkeypatch.setattr(worker, "merge_to_grand_staff", lambda b: b)
    monkeypatch.setattr(worker, "normalize_ties", lambda b: b)

    client = _FakeClient(input_bytes=b"%PDF-1.4 fake")
    _drive_process_job(monkeypatch, client, is_pdf=True)
    # Legacy Clarity short-circuit produced the result; reconcile was never invoked.
    assert client.put_body is not None


# --- reconcile Slice-4 sub-gates at the worker boundary ----------------------------------
# Class C/D live entirely in reconcile.py (self-gated by OMR_ENSEMBLE_TIMING / OMR_ENSEMBLE_ADD),
# so the worker flow is UNCHANGED. These drive the REAL reconcile through _reconcile_paths to
# confirm that with only OMR_ENSEMBLE on the riskier classes stay no-ops, and activate per sub-gate.

_CLARITY_GAP = (
    '<?xml version="1.0"?><score-partwise version="4.0">'
    '<part-list><score-part id="P1"><part-name>RH</part-name></score-part></part-list>'
    '<part id="P1"><measure number="1">'
    "<attributes><divisions>4</divisions><key><fifths>0</fifths></key>"
    "<time><beats>4</beats><beat-type>4</beat-type></time>"
    "<clef><sign>G</sign><line>2</line></clef></attributes>"
    "<note><pitch><step>C</step><octave>5</octave></pitch><duration>4</duration></note>"
    "<note><rest/><duration>4</duration></note>"
    "<note><pitch><step>G</step><octave>5</octave></pitch><duration>4</duration></note>"
    "<note><rest/><duration>4</duration></note>"
    "</measure></part></score-partwise>"
).encode("utf-8")

_OEMER_FILLS_GAP = (
    '<?xml version="1.0"?><score-partwise version="4.0">'
    '<part-list><score-part id="P1"><part-name>M</part-name></score-part></part-list>'
    '<part id="P1"><measure number="1">'
    "<attributes><divisions>4</divisions><key><fifths>0</fifths></key>"
    "<time><beats>4</beats><beat-type>4</beat-type></time>"
    '<clef number="1"><sign>G</sign><line>2</line></clef></attributes>'
    "<note><pitch><step>C</step><octave>5</octave></pitch><duration>4</duration><staff>1</staff></note>"
    "<note><pitch><step>E</step><octave>5</octave></pitch><duration>4</duration><staff>1</staff></note>"
    "<note><pitch><step>G</step><octave>5</octave></pitch><duration>4</duration><staff>1</staff></note>"
    "<note><rest/><duration>4</duration><staff>1</staff></note>"
    "</measure></part></score-partwise>"
).encode("utf-8")


def _steps(xml_bytes):
    import xml.etree.ElementTree as ET

    root = ET.fromstring(xml_bytes)
    return [
        n.findtext("pitch/step")
        for n in root.iter("note")
        if n.find("pitch") is not None
    ]


def test_worker_reconcile_add_noop_with_only_ensemble_flag(tmp_path, monkeypatch):
    # OMR_ENSEMBLE on, ADD sub-gate OFF: the oemer-only E5 is NOT added (Slice-3 behavior).
    monkeypatch.setenv("OMR_ENSEMBLE", "1")
    monkeypatch.delenv("OMR_ENSEMBLE_ADD", raising=False)
    primary = tmp_path / "clarity.musicxml"
    primary.write_bytes(_CLARITY_GAP)
    secondary = tmp_path / "oemer.musicxml"
    secondary.write_bytes(_OEMER_FILLS_GAP)

    out_path = worker._reconcile_paths(str(primary), str(secondary), str(tmp_path))
    with open(out_path, "rb") as fh:
        steps = _steps(fh.read())
    assert steps == ["C", "G"]  # E5 NOT added


def test_worker_reconcile_add_activates_with_subgate(tmp_path, monkeypatch):
    # OMR_ENSEMBLE on AND OMR_ENSEMBLE_ADD on: the corroborated oemer-only E5 is added.
    monkeypatch.setenv("OMR_ENSEMBLE", "1")
    monkeypatch.setenv("OMR_ENSEMBLE_ADD", "1")
    primary = tmp_path / "clarity.musicxml"
    primary.write_bytes(_CLARITY_GAP)
    secondary = tmp_path / "oemer.musicxml"
    secondary.write_bytes(_OEMER_FILLS_GAP)

    out_path = worker._reconcile_paths(str(primary), str(secondary), str(tmp_path))
    with open(out_path, "rb") as fh:
        steps = _steps(fh.read())
    assert steps == ["C", "E", "G"]  # E5 added into the gap


# --- Slice 6b: referee raster plumbing through _reconcile_paths ---------------------------
# The referee input (rasterized original) is threaded process_job -> _select_ensemble ->
# _reconcile_paths -> reconcile(input_pdf=...). It is loaded into an array ONLY when the
# OMR_ENSEMBLE_REFEREE sub-gate is on; with the gate off the raster is never decoded and
# input_pdf is None (byte-identical to Slice 4). reconcile is stubbed to capture the kwarg.


def test_reconcile_paths_passes_no_raster_when_referee_off(tmp_path, monkeypatch):
    # Referee sub-gate OFF: _load_referee_raster returns None without decoding, and reconcile is
    # called with input_pdf=None. A raster_path is supplied but must be IGNORED.
    monkeypatch.setenv("OMR_ENSEMBLE", "1")
    monkeypatch.delenv("OMR_ENSEMBLE_REFEREE", raising=False)
    primary = tmp_path / "clarity.musicxml"
    primary.write_bytes(_CLARITY_GAP)
    secondary = tmp_path / "oemer.musicxml"
    secondary.write_bytes(_OEMER_FILLS_GAP)

    seen = {}

    def fake_reconcile(p, s, input_pdf=None):
        seen["input_pdf"] = input_pdf
        return p

    monkeypatch.setattr(worker.reconcile, "reconcile", fake_reconcile)
    # raster_path points at a NON-image so a decode would fail loudly if it were attempted.
    bogus = tmp_path / "raster.png"
    bogus.write_bytes(b"not an image")
    worker._reconcile_paths(str(primary), str(secondary), str(tmp_path), str(bogus))
    assert seen["input_pdf"] is None  # gate off -> no decode, input_pdf None


def test_reconcile_paths_loads_raster_when_referee_on(tmp_path, monkeypatch):
    # Referee sub-gate ON: the raster is decoded to a grayscale ndarray and passed as input_pdf.
    # numpy + Pillow are worker-venv deps (both engines need them); skip cleanly where absent so
    # the suite still runs in a minimal CI/dev env, matching how the referee tests skip verovio.
    pytest.importorskip("numpy")
    pytest.importorskip("PIL")
    monkeypatch.setenv("OMR_ENSEMBLE", "1")
    monkeypatch.setenv("OMR_ENSEMBLE_REFEREE", "1")
    primary = tmp_path / "clarity.musicxml"
    primary.write_bytes(_CLARITY_GAP)
    secondary = tmp_path / "oemer.musicxml"
    secondary.write_bytes(_OEMER_FILLS_GAP)

    # Write a tiny real PNG so Pillow can decode it.
    from PIL import Image

    raster = tmp_path / "raster.png"
    Image.new("RGB", (8, 8), "white").save(raster)

    seen = {}

    def fake_reconcile(p, s, input_pdf=None):
        seen["input_pdf"] = input_pdf
        return p

    monkeypatch.setattr(worker.reconcile, "reconcile", fake_reconcile)
    worker._reconcile_paths(str(primary), str(secondary), str(tmp_path), str(raster))
    arr = seen["input_pdf"]
    assert arr is not None
    assert arr.shape == (8, 8)  # grayscale array of the raster


def test_load_referee_raster_none_path_is_none(monkeypatch):
    monkeypatch.setenv("OMR_ENSEMBLE", "1")
    monkeypatch.setenv("OMR_ENSEMBLE_REFEREE", "1")
    assert worker._load_referee_raster(None) is None


def test_load_referee_raster_decode_failure_is_none(tmp_path, monkeypatch):
    # A corrupt/non-image raster degrades to None (never raises into process_job).
    monkeypatch.setenv("OMR_ENSEMBLE", "1")
    monkeypatch.setenv("OMR_ENSEMBLE_REFEREE", "1")
    bad = tmp_path / "bad.png"
    bad.write_bytes(b"definitely not a png")
    assert worker._load_referee_raster(str(bad)) is None


# --- merge_to_grand_staff (#135) ---------------------------------------------------------

TWO_PART_XML = b"""<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list>
    <score-part id="P1"><part-name/></score-part>
    <score-part id="P2"><part-name/></score-part>
  </part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>2</divisions>
        <time><beats>2</beats><beat-type>2</beat-type></time>
        <clef><sign>G</sign><line>2</line></clef>
      </attributes>
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>4</duration><type>half</type></note>
    </measure>
  </part>
  <part id="P2">
    <measure number="1">
      <attributes>
        <divisions>2</divisions>
        <time><beats>2</beats><beat-type>2</beat-type></time>
        <clef><sign>F</sign><line>4</line></clef>
      </attributes>
      <note><pitch><step>C</step><octave>3</octave></pitch><duration>4</duration><type>half</type></note>
    </measure>
  </part>
</score-partwise>
"""

# Bass-first document order (the F-clef part is written FIRST): the merge must still put
# the treble (G) on staff 1 and bass (F) on staff 2 by clef sign, not document order.
TWO_PART_BASS_FIRST_XML = b"""<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list>
    <score-part id="P1"><part-name/></score-part>
    <score-part id="P2"><part-name/></score-part>
  </part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>2</divisions><clef><sign>F</sign><line>4</line></clef></attributes>
      <note><pitch><step>C</step><octave>3</octave></pitch><duration>4</duration><type>half</type></note>
    </measure>
  </part>
  <part id="P2">
    <measure number="1">
      <attributes><divisions>2</divisions><clef><sign>G</sign><line>2</line></clef></attributes>
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>4</duration><type>half</type></note>
    </measure>
  </part>
</score-partwise>
"""

ONE_PART_XML = b"""<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name/></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>2</divisions><staves>2</staves>
        <clef number="1"><sign>G</sign><line>2</line></clef>
        <clef number="2"><sign>F</sign><line>4</line></clef>
      </attributes>
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>4</duration><type>half</type><staff>1</staff></note>
    </measure>
  </part>
</score-partwise>
"""


def test_merge_to_grand_staff_collapses_two_parts():
    import xml.etree.ElementTree as ET

    out = worker.merge_to_grand_staff(TWO_PART_XML)
    root = ET.fromstring(out)
    parts = root.findall("part")
    assert len(parts) == 1, "two parts collapse to one grand-staff part"

    score_parts = root.find("part-list").findall("score-part")
    assert len(score_parts) == 1, "part-list drops the second score-part"

    measure = parts[0].find("measure")
    assert measure.find("attributes/staves").text == "2"

    notes = measure.findall("note")
    assert len(notes) == 2
    # Treble note (C5) on staff 1, bass note (C3) on staff 2.
    treble = notes[0]
    bass = notes[1]
    assert treble.findtext("pitch/octave") == "5"
    assert treble.findtext("staff") == "1"
    assert bass.findtext("pitch/octave") == "3"
    assert bass.findtext("staff") == "2"
    # A <backup> separates the two staves so the bass rewinds to the measure start.
    backup = measure.find("backup")
    assert backup is not None
    assert backup.findtext("duration") == "4"


def test_merge_to_grand_staff_assigns_staff_by_clef_not_order():
    import xml.etree.ElementTree as ET

    out = worker.merge_to_grand_staff(TWO_PART_BASS_FIRST_XML)
    root = ET.fromstring(out)
    notes = root.find("part/measure").findall("note")
    # Even though the F-clef part came first in the document, the G-clef treble note is
    # emitted first on staff 1 and the bass note on staff 2.
    assert notes[0].findtext("pitch/octave") == "5"  # treble C5
    assert notes[0].findtext("staff") == "1"
    assert notes[1].findtext("pitch/octave") == "3"  # bass C3
    assert notes[1].findtext("staff") == "2"


def test_merge_to_grand_staff_noop_on_single_part():
    # oemer already emits one grand-staff part; the merge must leave it byte-identical.
    out = worker.merge_to_grand_staff(ONE_PART_XML)
    assert out == ONE_PART_XML


# A measure where OMR dropped a treble note, so the treble fill (one half note, duration 2)
# is SHORTER than the bass fill (one whole note, duration 4). The <backup> must rewind by
# the TREBLE advance (2), not the bass duration (4); a bass_dur backup would over-rewind
# past the measure start and play the bass early (falling-bar + cursor timing skew).
MISMATCHED_FILL_XML = b"""<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list>
    <score-part id="P1"><part-name/></score-part>
    <score-part id="P2"><part-name/></score-part>
  </part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>1</divisions><clef><sign>G</sign><line>2</line></clef></attributes>
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>2</duration><type>half</type></note>
    </measure>
  </part>
  <part id="P2">
    <measure number="1">
      <attributes><divisions>1</divisions><clef><sign>F</sign><line>4</line></clef></attributes>
      <note><pitch><step>C</step><octave>3</octave></pitch><duration>4</duration><type>whole</type></note>
    </measure>
  </part>
</score-partwise>
"""


def test_merge_to_grand_staff_backup_uses_treble_advance_not_bass():
    # Bug-2 regression: treble advance is 2, bass fill is 4. The <backup> must equal the
    # treble advance (2) so staff 2 rewinds exactly to the measure start, not 4 (which would
    # over-rewind past the start). MUST fail against the old bass_dur backup.
    import xml.etree.ElementTree as ET

    out = worker.merge_to_grand_staff(MISMATCHED_FILL_XML)
    measure = ET.fromstring(out).find("part/measure")
    backup = measure.find("backup")
    assert backup is not None
    assert backup.findtext("duration") == "2", "backup rewinds by the treble advance, not bass"


# --- normalize_ties (#135) ---------------------------------------------------------------

CROSS_PITCH_TIE_XML = b"""<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name/></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <note><pitch><step>A</step><octave>4</octave></pitch><duration>4</duration>
        <tie type="start"/><type>half</type>
        <notations><tied type="start"/></notations></note>
    </measure>
    <measure number="2">
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration>
        <tie type="stop"/><type>half</type>
        <notations><tied type="stop"/></notations></note>
    </measure>
  </part>
</score-partwise>
"""

DANGLING_START_XML = b"""<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name/></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <note><pitch><step>C</step><octave>2</octave></pitch><duration>4</duration>
        <tie type="start"/><type>whole</type>
        <notations><tied type="start"/></notations></note>
    </measure>
    <measure number="2">
      <note><pitch><step>C</step><octave>2</octave></pitch><duration>4</duration><type>whole</type></note>
    </measure>
  </part>
</score-partwise>
"""

TERMINAL_DANGLING_START_XML = b"""<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name/></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <note><pitch><step>G</step><octave>2</octave></pitch><duration>4</duration>
        <tie type="start"/><type>whole</type>
        <notations><tied type="start"/></notations></note>
    </measure>
  </part>
</score-partwise>
"""

TIE_FREE_XML = b"""<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name/></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><type>whole</type></note>
    </measure>
  </part>
</score-partwise>
"""


def _ties_in(xml_bytes):
    import xml.etree.ElementTree as ET

    root = ET.fromstring(xml_bytes)
    return [t.get("type") for t in root.iter("tie")]


def _tied_in(xml_bytes):
    import xml.etree.ElementTree as ET

    root = ET.fromstring(xml_bytes)
    return [t.get("type") for t in root.iter("tied")]


def test_normalize_ties_drops_cross_pitch_tie():
    # A start on A4 and a stop on C4 is not a real tie (different pitches). Both ends drop;
    # the notes survive as separate re-attacks.
    out = worker.normalize_ties(CROSS_PITCH_TIE_XML)
    assert _ties_in(out) == [], "cross-pitch tie markup removed"
    assert _tied_in(out) == []
    # Both notes still present.
    import xml.etree.ElementTree as ET

    assert len(ET.fromstring(out).findall(".//note")) == 2


def test_normalize_ties_closes_dangling_start_to_next_same_pitch():
    # The model emitted a tie=start on C2 with no stop; the next measure has a same-pitch
    # C2. normalize_ties must add a matching stop so OSMD/mergeTiedNotes can fold them.
    out = worker.normalize_ties(DANGLING_START_XML)
    import xml.etree.ElementTree as ET

    root = ET.fromstring(out)
    notes = root.findall(".//note")
    assert [t.get("type") for t in notes[0].findall("tie")] == ["start"]
    assert [t.get("type") for t in notes[1].findall("tie")] == ["stop"]
    assert [t.get("type") for t in notes[1].find("notations").findall("tied")] == ["stop"]


def test_normalize_ties_drops_terminal_dangling_start():
    # A tie=start with NO following same-pitch note cannot be paired; drop it rather than
    # fabricate a stop. The note remains, untied.
    out = worker.normalize_ties(TERMINAL_DANGLING_START_XML)
    assert _ties_in(out) == []
    assert _tied_in(out) == []
    import xml.etree.ElementTree as ET

    assert len(ET.fromstring(out).findall(".//note")) == 1


def test_normalize_ties_noop_on_tie_free_input():
    # oemer output has zero ties; normalize_ties must not invent any.
    out = worker.normalize_ties(TIE_FREE_XML)
    assert _ties_in(out) == []
    assert _tied_in(out) == []


# A held LH CHORD: C4 and E4 in the SAME staff each tied across a barline, with BOTH a
# start (measure 1) and an explicit stop (measure 2). The stops are interleaved (the m2
# stops appear in E4-then-C4 order, the opposite of the m1 C4-then-E4 starts), so the old
# "first different-pitch stop -> drop both ends" loop would corrupt them. Pitch-matched
# pairing must leave BOTH ties intact.
INTERLEAVED_CHORD_TIE_XML = b"""<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name/></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration>
        <tie type="start"/><type>half</type><staff>2</staff>
        <notations><tied type="start"/></notations></note>
      <note><chord/><pitch><step>E</step><octave>4</octave></pitch><duration>4</duration>
        <tie type="start"/><type>half</type><staff>2</staff>
        <notations><tied type="start"/></notations></note>
    </measure>
    <measure number="2">
      <note><pitch><step>E</step><octave>4</octave></pitch><duration>4</duration>
        <tie type="stop"/><type>half</type><staff>2</staff>
        <notations><tied type="stop"/></notations></note>
      <note><chord/><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration>
        <tie type="stop"/><type>half</type><staff>2</staff>
        <notations><tied type="stop"/></notations></note>
    </measure>
  </part>
</score-partwise>
"""


def test_normalize_ties_keeps_interleaved_chord_ties():
    # Bug-1 regression: a tied chord whose start/stop markers interleave by pitch. Both the
    # C4 and the E4 tie must survive (both starts keep their start, both stops keep their
    # stop, nothing dropped). This MUST fail against the old "drop both on pitch mismatch"
    # code, which nuked a sibling's legitimate tie when it hit the wrong-pitch stop first.
    import xml.etree.ElementTree as ET

    out = worker.normalize_ties(INTERLEAVED_CHORD_TIE_XML)
    assert sorted(_ties_in(out)) == ["start", "start", "stop", "stop"]
    assert sorted(_tied_in(out)) == ["start", "start", "stop", "stop"]

    root = ET.fromstring(out)
    notes = root.findall(".//note")
    assert len(notes) == 4, "no notes dropped"

    def tie_for(step, octave, want):
        for n in notes:
            if n.findtext("pitch/step") == step and n.findtext("pitch/octave") == octave:
                if want in [t.get("type") for t in n.findall("tie")]:
                    return True
        return False

    assert tie_for("C", "4", "start"), "C4 keeps its start"
    assert tie_for("E", "4", "start"), "E4 keeps its start"
    assert tie_for("C", "4", "stop"), "C4 keeps its stop"
    assert tie_for("E", "4", "stop"), "E4 keeps its stop"


# A model cross-pitch false positive: a start on pitch X (A4) with NO same-pitch follower,
# and a dangling stop on a different pitch Y (C4) with no preceding same-pitch start. The
# starts pass drops the A4 start (no A4 follower) and the stops pass drops the C4 stop (no
# preceding C4 start). Both markers must vanish, both notes survive.
CROSS_PITCH_FALSE_POSITIVE_XML = b"""<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name/></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <note><pitch><step>A</step><octave>4</octave></pitch><duration>4</duration>
        <tie type="start"/><type>half</type>
        <notations><tied type="start"/></notations></note>
    </measure>
    <measure number="2">
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration>
        <tie type="stop"/><type>half</type>
        <notations><tied type="stop"/></notations></note>
    </measure>
  </part>
</score-partwise>
"""


def test_normalize_ties_drops_cross_pitch_false_positive():
    # The A4 start has no A4 follower (dropped in the starts pass) and the C4 stop has no
    # preceding C4 start (dropped in the stops pass). Both invalid markers vanish.
    import xml.etree.ElementTree as ET

    out = worker.normalize_ties(CROSS_PITCH_FALSE_POSITIVE_XML)
    assert _ties_in(out) == [], "cross-pitch start and stop both removed"
    assert _tied_in(out) == []
    assert len(ET.fromstring(out).findall(".//note")) == 2, "both notes survive"
