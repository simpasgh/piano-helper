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
    the canned input bytes, put_object captures every written body + its metadata, delete_object is
    a no-op. result_is_complete is monkeypatched to False so the job always processes.

    `put_body` is the LAST body written (the complete result for almost every test). `puts` records
    EVERY write as {"body", "metadata"} so the progressive tests can assert the partial-then-complete
    sequence and the omr-status metadata."""

    def __init__(self, input_bytes=b"", is_pdf=False, metadata=None):
        self._input_bytes = input_bytes
        self._is_pdf = is_pdf
        self._metadata = metadata or {}
        self.put_body = None
        self.puts = []

    def download_file(self, Bucket, Key, dest):
        with open(dest, "wb") as fh:
            fh.write(self._input_bytes)

    def head_object(self, Bucket, Key):
        return {"Metadata": dict(self._metadata)}

    def put_object(self, Bucket, Key, Body, ContentType, Metadata=None):
        self.put_body = Body
        self.puts.append({"body": Body, "metadata": dict(Metadata or {})})

    def delete_object(self, Bucket, Key):
        pass


def _drive_process_job(monkeypatch, client, is_pdf=True):
    """Run process_job against a _FakeClient, stubbing result_is_complete (no real head_object) and
    sniff_mime (no real `file` binary). is_pdf controls the sniffed mime."""
    monkeypatch.setattr(worker, "result_is_complete", lambda *a, **k: False)
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

    def fake_repair(body, *a, **k):
        order.append("repair")
        return body

    monkeypatch.setattr(worker.reconcile, "reconcile", fake_reconcile)
    monkeypatch.setattr(worker, "merge_to_grand_staff", fake_merge)
    monkeypatch.setattr(worker, "normalize_ties", fake_normalize)
    monkeypatch.setattr(worker.rhythm_repair, "repair_measure_durations", fake_repair)

    client = _FakeClient(input_bytes=b"%PDF-1.4 fake")
    _drive_process_job(monkeypatch, client, is_pdf=True)

    # The rhythm repair runs LAST, after merge+normalize, so it reads the final grand-staff layout.
    assert order == ["reconcile", "merge", "normalize", "repair"], order
    # The reconciled bytes (post all no-op transforms) are what gets written.
    assert client.put_body == b"<reconciled/>"


def test_post_transforms_repair_broken_bar_end_to_end(tmp_path, monkeypatch):
    # Exercise the REAL (unstubbed) post-transform chain through process_job: a single engine
    # returns a 1-part grand staff with five good 4/4 bars and one short middle bar (only 14 of 16
    # beats). merge/normalize are no-ops on this shape, and the rhythm repair must COMPLETE the
    # middle bar pitch-safely (a trailing rest, pitched notes untouched) so it sums to the time
    # signature. Proves the wiring works end to end and never raises on real merged output.
    import llm_omr
    import xml.etree.ElementTree as ET

    def _n(dur, step, octave=5):
        return {"duration": dur, "pitches": [{"step": step, "octave": octave}]}

    good = {"staff1": [_n(8, "C"), _n(8, "D")], "staff2": [_n(8, "C", 3), _n(8, "E", 3)]}
    broken = {"staff1": [_n(12, "C"), _n(2, "D")], "staff2": [_n(8, "C", 3), _n(8, "E", 3)]}
    body = llm_omr.score_json_to_musicxml(
        {"divisions": 4, "time": {"beats": 4, "beat_type": 4},
         "measures": [good, good, broken, good, good]})
    engine_out = tmp_path / "engine.musicxml"
    engine_out.write_bytes(body)

    monkeypatch.setattr(worker, "run_clarity", lambda *a, **k: str(engine_out))

    client = _FakeClient(input_bytes=b"%PDF-1.4 fake")
    _drive_process_job(monkeypatch, client, is_pdf=True)

    # The written body must have the middle bar (measure 3) completed: the two notes keep their
    # durations (12 + 2) and a rest(2) is added so staff 1 sums to a full 4/4 bar.
    root = ET.fromstring(client.put_body)
    m3 = [m for m in root.iter("measure") if m.get("number") == "3"][0]
    s1 = [n for n in m3.findall("note") if n.findtext("staff") == "1" and n.find("chord") is None]
    pitched = [int(n.findtext("duration")) for n in s1 if n.find("rest") is None]
    rests = [int(n.findtext("duration")) for n in s1 if n.find("rest") is not None]
    assert pitched == [12, 2], pitched          # notes untouched (never stretched)
    assert rests == [2]                          # the gap completed with a rest
    assert sum(pitched) + sum(rests) == 16


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


def test_default_job_with_ensemble_on_runs_ensemble(tmp_path, monkeypatch):
    # FLAG ON: the ensemble runs (the default accurate path).
    monkeypatch.setenv("OMR_ENSEMBLE", "1")
    ran = {"ensemble": False}

    def fake_ensemble(*a, **k):
        ran["ensemble"] = True
        return None, None

    monkeypatch.setattr(worker, "_select_ensemble", fake_ensemble)
    monkeypatch.setattr(worker, "merge_to_grand_staff", lambda b: b)
    monkeypatch.setattr(worker, "normalize_ties", lambda b: b)

    client = _FakeClient(input_bytes=b"%PDF-1.4 fake")
    _drive_process_job(monkeypatch, client, is_pdf=True)
    assert ran["ensemble"] is True


def test_llm_used_when_available(tmp_path, monkeypatch):
    # When the LLM transcriber is available, its bytes are used as the result and the geometry
    # engines are NOT run.
    monkeypatch.setattr(worker.llm_omr, "llm_available", lambda: True)
    monkeypatch.setattr(worker.llm_omr, "transcribe", lambda image: b"<score-partwise/>")

    def engines_must_not_run(*a, **k):
        raise AssertionError("geometry engines must not run when the LLM produced a result")

    monkeypatch.setattr(worker, "_select_ensemble", engines_must_not_run)
    monkeypatch.setattr(worker, "_select_legacy", engines_must_not_run)
    monkeypatch.setattr(worker, "merge_to_grand_staff", lambda b: b)
    monkeypatch.setattr(worker, "normalize_ties", lambda b: b)

    client = _FakeClient(input_bytes=b"\x89PNG fake")
    _drive_process_job(monkeypatch, client, is_pdf=False)
    assert client.put_body == b"<score-partwise/>"


# --- Trained geometric engine (OMR_GEOM, default OFF) -------------------------------------

def test_geom_enabled_truthy_parsing(monkeypatch):
    # Default (unset) is OFF: prod is unaffected until the flag is deliberately set on the box.
    monkeypatch.delenv("OMR_GEOM", raising=False)
    assert worker.geom_enabled() is False
    for on in ("1", "true", "TRUE", " True ", "tRuE"):
        monkeypatch.setenv("OMR_GEOM", on)
        assert worker.geom_enabled() is True, on
    for off in ("0", "false", "", "yes", "on", "2", "garbage"):
        monkeypatch.setenv("OMR_GEOM", off)
        assert worker.geom_enabled() is False, off


def test_geom_command_shape():
    # Pure argv builder (mirrors clarity_command): image, --weights, -o out, --device cpu.
    cmd = worker.geom_command("py", "geom_detector.py", "/img.png", "/w.pt", "/out.musicxml")
    assert cmd[0] == "py" and cmd[1] == "geom_detector.py" and cmd[2] == "/img.png"
    assert cmd[cmd.index("--weights") + 1] == "/w.pt"
    assert cmd[cmd.index("-o") + 1] == "/out.musicxml"
    assert cmd[cmd.index("--device") + 1] == "cpu"
    assert "--key-fifths" not in cmd


def test_geom_command_key_fifths():
    # key_fifths=None -> no --key-fifths (geom assumes C major); an int -> --key-fifths <n> so the
    # decode reads that key. The fusion path passes Clarity's detected key on non-C pieces.
    assert "--key-fifths" not in worker.geom_command("py", "g.py", "/i.png", "/w.pt", "/o.musicxml")
    keyed = worker.geom_command("py", "g.py", "/i.png", "/w.pt", "/o.musicxml", key_fifths=4)
    assert keyed[keyed.index("--key-fifths") + 1] == "4"
    flat = worker.geom_command("py", "g.py", "/i.png", "/w.pt", "/o.musicxml", key_fifths=-3)
    assert flat[flat.index("--key-fifths") + 1] == "-3"


def test_rekey_geom_unit():
    # Non-zero Clarity key: rerun_keyed is called with that key and its bytes are used.
    seen = []
    out = worker._rekey_geom(b"<s>C</s>", b"<s><fifths>3</fifths></s>",
                             lambda ck: (seen.append(ck), b"<s>KEYED</s>")[1])
    assert seen == [3] and out == b"<s>KEYED</s>"

    # C major (fifths 0): no rerun, original C-assumed geom bytes (the common case stays identical).
    def _no_rerun(ck):
        raise AssertionError("must not re-run geom on a C-major (fifths 0) piece")
    assert worker._rekey_geom(b"<s>C</s>", b"<s><fifths>0</fifths></s>", _no_rerun) == b"<s>C</s>"

    # No Clarity bytes, or a re-run that fails (None) -> original geom bytes; never raises.
    assert worker._rekey_geom(b"<s>C</s>", None, _no_rerun) == b"<s>C</s>"
    assert worker._rekey_geom(b"<s>C</s>", b"<s><fifths>2</fifths></s>", lambda ck: None) == b"<s>C</s>"


def test_run_geom_returns_none_without_env(tmp_path, monkeypatch):
    # GEOM_PYTHON / GEOM_WEIGHTS unset -> None (fall back), never raises.
    monkeypatch.delenv("GEOM_PYTHON", raising=False)
    monkeypatch.delenv("GEOM_WEIGHTS", raising=False)
    assert worker.run_geom(str(tmp_path / "x.png"), str(tmp_path)) is None


def test_geom_off_by_default_does_not_run(tmp_path, monkeypatch):
    # OMR_GEOM unset: geom NEVER runs (prod default), so the existing pipeline is byte-identical.
    monkeypatch.delenv("OMR_GEOM", raising=False)
    monkeypatch.setenv("OMR_ENSEMBLE", "1")

    def geom_must_not_run(*a, **k):
        raise AssertionError("geom must not run when OMR_GEOM is unset")

    monkeypatch.setattr(worker, "run_geom", geom_must_not_run)
    monkeypatch.setattr(worker, "_select_ensemble", lambda *a, **k: (None, None))
    monkeypatch.setattr(worker.llm_omr, "llm_available", lambda: False)
    monkeypatch.setattr(worker, "merge_to_grand_staff", lambda b: b)
    monkeypatch.setattr(worker, "normalize_ties", lambda b: b)

    client = _FakeClient(input_bytes=b"\x89PNG fake")
    _drive_process_job(monkeypatch, client, is_pdf=False)  # no AssertionError = geom skipped


def test_geom_not_run_when_a_primary_succeeds(tmp_path, monkeypatch):
    # geom is a FALLBACK, not a primary: if any earlier engine produces a result, geom never runs.
    monkeypatch.setenv("OMR_GEOM", "1")
    monkeypatch.setenv("OMR_ENSEMBLE", "1")
    monkeypatch.setattr(worker.llm_omr, "llm_available", lambda: False)
    ens_out = tmp_path / "ens.musicxml"
    ens_out.write_text("<score>ensemble</score>")
    monkeypatch.setattr(worker, "_select_ensemble", lambda *a, **k: (str(ens_out), "ensemble"))

    def geom_must_not_run(*a, **k):
        raise AssertionError("geom must not run when a primary engine succeeded")

    monkeypatch.setattr(worker, "run_geom", geom_must_not_run)
    monkeypatch.setattr(worker, "merge_to_grand_staff", lambda b: b)
    monkeypatch.setattr(worker, "normalize_ties", lambda b: b)

    client = _FakeClient(input_bytes=b"\x89PNG fake")
    _drive_process_job(monkeypatch, client, is_pdf=False)
    assert client.put_body == b"<score>ensemble</score>"


def test_geom_used_as_fallback_when_all_else_fails(tmp_path, monkeypatch):
    # OMR_GEOM on, every primary declines (the would-be failure-sentinel case): geom fills in,
    # because a pitch transcription beats a sentinel. geom can only win when body is still None.
    monkeypatch.setenv("OMR_GEOM", "1")
    monkeypatch.setenv("OMR_ENSEMBLE", "1")
    monkeypatch.setattr(worker.llm_omr, "llm_available", lambda: False)
    monkeypatch.setattr(worker, "_select_ensemble", lambda *a, **k: (None, None))
    geom_out = tmp_path / "geom.musicxml"
    geom_out.write_text("<score>geom</score>")
    monkeypatch.setattr(worker, "run_geom", lambda *a, **k: str(geom_out))
    monkeypatch.setattr(worker, "merge_to_grand_staff", lambda b: b)
    monkeypatch.setattr(worker, "normalize_ties", lambda b: b)

    client = _FakeClient(input_bytes=b"\x89PNG fake")
    _drive_process_job(monkeypatch, client, is_pdf=False)
    assert client.put_body == b"<score>geom</score>"


def test_geom_fallback_declines_writes_sentinel(tmp_path, monkeypatch):
    # Every primary declines AND geom (fallback) also returns None -> failure sentinel, no crash.
    # Also guards that the ensemble still runs first (geom no longer pre-empts it).
    monkeypatch.setenv("OMR_GEOM", "1")
    monkeypatch.setenv("OMR_ENSEMBLE", "1")
    ran = {"ensemble": False}

    def fake_ensemble(*a, **k):
        ran["ensemble"] = True
        return None, None

    monkeypatch.setattr(worker, "_select_ensemble", fake_ensemble)
    monkeypatch.setattr(worker, "run_geom", lambda *a, **k: None)
    monkeypatch.setattr(worker.llm_omr, "llm_available", lambda: False)

    client = _FakeClient(input_bytes=b"\x89PNG fake")
    _drive_process_job(monkeypatch, client, is_pdf=False)
    assert ran["ensemble"] is True
    assert client.put_body == worker.FAILURE_SENTINEL


def test_geom_fallback_pdf_rasterizes_lazily(tmp_path, monkeypatch):
    # PDF fallback branch: all primaries decline, so geom rasterizes the (still-on-disk) PDF
    # lazily in the fallback and produces a result. Guards the is_pdf_input branch at the geom
    # raster prep, which the non-PDF tests above never exercise.
    monkeypatch.setenv("OMR_GEOM", "1")
    monkeypatch.setenv("OMR_ENSEMBLE", "1")
    monkeypatch.setattr(worker.llm_omr, "llm_available", lambda: False)
    monkeypatch.setattr(worker, "_select_ensemble", lambda *a, **k: (None, None))

    rastered = {"n": 0}

    def fake_raster(path, workdir):
        rastered["n"] += 1
        return ("/fake/stitched.png", True)

    monkeypatch.setattr(worker, "rasterize_if_pdf", fake_raster)
    geom_out = tmp_path / "geom.musicxml"
    geom_out.write_text("<score>geompdf</score>")
    seen = {}

    def fake_run_geom(image, workdir, **k):
        seen["image"] = image
        return str(geom_out)

    monkeypatch.setattr(worker, "run_geom", fake_run_geom)
    monkeypatch.setattr(worker, "merge_to_grand_staff", lambda b: b)
    monkeypatch.setattr(worker, "normalize_ties", lambda b: b)

    client = _FakeClient(input_bytes=b"%PDF-1.4 fake")
    _drive_process_job(monkeypatch, client, is_pdf=True)
    assert client.put_body == b"<score>geompdf</score>"
    assert rastered["n"] >= 1  # geom lazily rasterized the PDF in the fallback
    assert seen["image"] == "/fake/stitched.png"  # geom got the stitched raster, not a stale path


def test_geom_primary_truthy_parsing(monkeypatch):
    monkeypatch.delenv("OMR_GEOM_PRIMARY", raising=False)
    assert worker.geom_primary() is False
    for on in ("1", "true", "TRUE", " True "):
        monkeypatch.setenv("OMR_GEOM_PRIMARY", on)
        assert worker.geom_primary() is True, on
    for off in ("0", "false", "", "garbage"):
        monkeypatch.setenv("OMR_GEOM_PRIMARY", off)
        assert worker.geom_primary() is False, off


def test_geom_primary_wins_first(tmp_path, monkeypatch):
    # OMR_GEOM + OMR_GEOM_PRIMARY: geom runs FIRST and wins; NO other engine runs.
    monkeypatch.setenv("OMR_GEOM", "1")
    monkeypatch.setenv("OMR_GEOM_PRIMARY", "1")
    geom_out = tmp_path / "geom.musicxml"
    geom_out.write_text("<score>geom</score>")
    monkeypatch.setattr(worker, "run_geom", lambda *a, **k: str(geom_out))

    def must_not_run(*a, **k):
        raise AssertionError("no other engine may run when geom (primary) produced a result")

    monkeypatch.setattr(worker, "_select_ensemble", must_not_run)
    monkeypatch.setattr(worker, "_select_legacy", must_not_run)
    monkeypatch.setattr(worker.llm_omr, "llm_available", lambda: False)
    monkeypatch.setattr(worker, "merge_to_grand_staff", lambda b: b)
    monkeypatch.setattr(worker, "normalize_ties", lambda b: b)

    client = _FakeClient(input_bytes=b"\x89PNG fake")
    _drive_process_job(monkeypatch, client, is_pdf=False)
    assert client.put_body == b"<score>geom</score>"


def test_geom_primary_declines_falls_through_to_ensemble(tmp_path, monkeypatch):
    # OMR_GEOM_PRIMARY on but geom declines (None): the existing ensemble still runs (never-worse
    # for the jobs geom cannot handle, even in primary mode).
    monkeypatch.setenv("OMR_GEOM", "1")
    monkeypatch.setenv("OMR_GEOM_PRIMARY", "1")
    monkeypatch.setenv("OMR_ENSEMBLE", "1")
    monkeypatch.setattr(worker, "run_geom", lambda *a, **k: None)
    ran = {"ensemble": False}

    def fake_ensemble(*a, **k):
        ran["ensemble"] = True
        return None, None

    monkeypatch.setattr(worker, "_select_ensemble", fake_ensemble)
    monkeypatch.setattr(worker.llm_omr, "llm_available", lambda: False)

    client = _FakeClient(input_bytes=b"\x89PNG fake")
    _drive_process_job(monkeypatch, client, is_pdf=False)
    assert ran["ensemble"] is True


def test_fusion_enabled_truthy_parsing(monkeypatch):
    monkeypatch.delenv("OMR_GEOM_FUSION", raising=False)
    assert worker.fusion_enabled() is False
    for on in ("1", "true", "TRUE", " True "):
        monkeypatch.setenv("OMR_GEOM_FUSION", on)
        assert worker.fusion_enabled() is True, on
    for off in ("0", "false", "", "garbage"):
        monkeypatch.setenv("OMR_GEOM_FUSION", off)
        assert worker.fusion_enabled() is False, off


def test_geom_fusion_fuses_geom_and_clarity(tmp_path, monkeypatch):
    # OMR_GEOM + OMR_GEOM_FUSION on a PDF: geom + Clarity both run, fusion.fuse combines them, and
    # NO later engine runs.
    monkeypatch.setenv("OMR_GEOM", "1")
    monkeypatch.setenv("OMR_GEOM_FUSION", "1")
    geom_out = tmp_path / "geom.musicxml"; geom_out.write_text("<score>geom</score>")
    clar_out = tmp_path / "clarity.musicxml"; clar_out.write_text("<score>clarity</score>")
    monkeypatch.setattr(worker, "rasterize_if_pdf", lambda p, w: ("/fake/stitched.png", True))
    monkeypatch.setattr(worker, "run_geom", lambda *a, **k: str(geom_out))
    monkeypatch.setattr(worker, "run_clarity", lambda *a, **k: str(clar_out))
    seen = {}

    def fake_fuse(g, c):
        seen["g"], seen["c"] = g, c
        return b"<score>fused</score>"

    monkeypatch.setattr(worker.fusion, "fuse", fake_fuse)

    def must_not_run(*a, **k):
        raise AssertionError("no later engine runs when fusion produced a result")

    monkeypatch.setattr(worker, "_select_ensemble", must_not_run)
    monkeypatch.setattr(worker, "_select_legacy", must_not_run)
    monkeypatch.setattr(worker.llm_omr, "llm_available", lambda: False)
    monkeypatch.setattr(worker, "merge_to_grand_staff", lambda b: b)
    monkeypatch.setattr(worker, "normalize_ties", lambda b: b)

    client = _FakeClient(input_bytes=b"%PDF-1.4 fake")
    _drive_process_job(monkeypatch, client, is_pdf=True)
    assert client.put_body == b"<score>fused</score>"
    assert seen["g"] == b"<score>geom</score>"      # geom bytes handed to the fusion
    assert seen["c"] == b"<score>clarity</score>"   # clarity bytes handed to the fusion


def test_geom_fusion_rekeys_geom_under_clarity_key(tmp_path, monkeypatch):
    # Non-C piece: Clarity detects the key (here 4 sharps); the worker re-decodes geom under that key
    # so geom's pitch carries the right accidentals, and the RE-KEYED geom bytes are what gets fused.
    monkeypatch.setenv("OMR_GEOM", "1")
    monkeypatch.setenv("OMR_GEOM_FUSION", "1")
    geom_c = tmp_path / "geom_c.musicxml"; geom_c.write_text("<score>geomC</score>")
    geom_k = tmp_path / "geom_k.musicxml"; geom_k.write_text("<score>geomKEYED</score>")
    clar = tmp_path / "clarity.musicxml"; clar.write_text("<score><fifths>4</fifths></score>")
    monkeypatch.setattr(worker, "rasterize_if_pdf", lambda p, w: ("/fake/stitched.png", True))
    keys = []

    def fake_run_geom(image, workdir, **k):
        keys.append(k.get("key_fifths"))
        return str(geom_k) if k.get("key_fifths") else str(geom_c)

    monkeypatch.setattr(worker, "run_geom", fake_run_geom)
    monkeypatch.setattr(worker, "run_clarity", lambda *a, **k: str(clar))
    seen = {}

    def fake_fuse(g, c):
        seen["g"], seen["c"] = g, c
        return b"<score>fused</score>"

    monkeypatch.setattr(worker.fusion, "fuse", fake_fuse)

    def must_not_run(*a, **k):
        raise AssertionError("no later engine runs when fusion produced a result")

    monkeypatch.setattr(worker, "_select_ensemble", must_not_run)
    monkeypatch.setattr(worker, "_select_legacy", must_not_run)
    monkeypatch.setattr(worker.llm_omr, "llm_available", lambda: False)
    monkeypatch.setattr(worker, "merge_to_grand_staff", lambda b: b)
    monkeypatch.setattr(worker, "normalize_ties", lambda b: b)

    client = _FakeClient(input_bytes=b"%PDF-1.4 fake")
    _drive_process_job(monkeypatch, client, is_pdf=True)
    assert client.put_body == b"<score>fused</score>"
    assert 4 in keys                                  # geom re-decoded under Clarity's detected key
    assert seen["g"] == b"<score>geomKEYED</score>"   # the re-keyed geom bytes were fused


def test_geom_fusion_cmajor_does_not_rekey(tmp_path, monkeypatch):
    # Clarity reports C major (fifths 0): geom is NOT re-decoded; the C-assumed geom bytes are fused
    # unchanged, so the common case stays byte-identical (the key fix is never-worse).
    monkeypatch.setenv("OMR_GEOM", "1")
    monkeypatch.setenv("OMR_GEOM_FUSION", "1")
    geom_c = tmp_path / "geom_c.musicxml"; geom_c.write_text("<score>geomC</score>")
    clar = tmp_path / "clarity.musicxml"; clar.write_text("<score><fifths>0</fifths></score>")
    monkeypatch.setattr(worker, "rasterize_if_pdf", lambda p, w: ("/fake/stitched.png", True))

    def fake_run_geom(image, workdir, **k):
        if k.get("key_fifths"):
            raise AssertionError("geom must not be re-run for a C-major (fifths 0) piece")
        return str(geom_c)

    monkeypatch.setattr(worker, "run_geom", fake_run_geom)
    monkeypatch.setattr(worker, "run_clarity", lambda *a, **k: str(clar))
    seen = {}

    def fake_fuse(g, c):
        seen["g"] = g
        return b"<score>fused</score>"

    monkeypatch.setattr(worker.fusion, "fuse", fake_fuse)

    def must_not_run(*a, **k):
        raise AssertionError("no later engine runs when fusion produced a result")

    monkeypatch.setattr(worker, "_select_ensemble", must_not_run)
    monkeypatch.setattr(worker, "_select_legacy", must_not_run)
    monkeypatch.setattr(worker.llm_omr, "llm_available", lambda: False)
    monkeypatch.setattr(worker, "merge_to_grand_staff", lambda b: b)
    monkeypatch.setattr(worker, "normalize_ties", lambda b: b)

    client = _FakeClient(input_bytes=b"%PDF-1.4 fake")
    _drive_process_job(monkeypatch, client, is_pdf=True)
    assert seen["g"] == b"<score>geomC</score>"       # C-assumed geom bytes fused unchanged


def test_geom_fusion_non_pdf_uses_geom_alone(tmp_path, monkeypatch):
    # Clarity is PDF-only; on a non-PDF upload the fusion runs geom alone (clarity bytes None).
    monkeypatch.setenv("OMR_GEOM", "1")
    monkeypatch.setenv("OMR_GEOM_FUSION", "1")
    geom_out = tmp_path / "geom.musicxml"; geom_out.write_text("<score>geom</score>")
    monkeypatch.setattr(worker, "run_geom", lambda *a, **k: str(geom_out))

    def clarity_must_not_run(*a, **k):
        raise AssertionError("clarity is PDF-only; it must not run for a non-PDF upload")

    monkeypatch.setattr(worker, "run_clarity", clarity_must_not_run)
    seen = {}

    def fake_fuse(g, c):
        seen["g"], seen["c"] = g, c
        return g  # fuse(geom, None) -> geom unchanged

    monkeypatch.setattr(worker.fusion, "fuse", fake_fuse)
    monkeypatch.setattr(worker.llm_omr, "llm_available", lambda: False)
    monkeypatch.setattr(worker, "merge_to_grand_staff", lambda b: b)
    monkeypatch.setattr(worker, "normalize_ties", lambda b: b)

    client = _FakeClient(input_bytes=b"\x89PNG fake")
    _drive_process_job(monkeypatch, client, is_pdf=False)
    assert client.put_body == b"<score>geom</score>"
    assert seen["c"] is None  # no clarity for non-PDF


# --- PHOTO-TO-PDF shim (OMR_PHOTO_CLARITY): Clarity rhythm/key/ties on photo uploads -------------


def test_photo_clarity_enabled_truthy_parsing(monkeypatch):
    monkeypatch.delenv("OMR_PHOTO_CLARITY", raising=False)
    assert worker.photo_clarity_enabled() is False
    for on in ("1", "true", "TRUE", " True "):
        monkeypatch.setenv("OMR_PHOTO_CLARITY", on)
        assert worker.photo_clarity_enabled() is True, on
    for off in ("0", "false", "", "garbage"):
        monkeypatch.setenv("OMR_PHOTO_CLARITY", off)
        assert worker.photo_clarity_enabled() is False, off


def test_geom_command_dump_clarity_pdf_arg():
    # The dump path rides on geom's CLI only when requested; the default argv is unchanged.
    base = worker.geom_command("py", "s.py", "img.png", "w.pt", "out.xml")
    assert "--dump-clarity-pdf" not in base
    dumped = worker.geom_command("py", "s.py", "img.png", "w.pt", "out.xml",
                                 dump_clarity_pdf="/work/clarity-input.pdf")
    assert dumped[-2:] == ["--dump-clarity-pdf", "/work/clarity-input.pdf"]
    assert dumped[: len(base)] == base


def test_photo_clarity_runs_clarity_on_geom_dump(tmp_path, monkeypatch):
    # OMR_PHOTO_CLARITY on a NON-PDF upload: geom dumps its dewarped raster as a one-page PDF,
    # Clarity runs on THAT dump (never the original photo), and the fusion gets both bytes.
    monkeypatch.setenv("OMR_GEOM", "1")
    monkeypatch.setenv("OMR_GEOM_FUSION", "1")
    monkeypatch.setenv("OMR_PHOTO_CLARITY", "1")
    geom_out = tmp_path / "geom.musicxml"; geom_out.write_text("<score>geom</score>")
    clar_out = tmp_path / "clarity.musicxml"; clar_out.write_text("<score>clarity</score>")
    seen = {}

    def fake_run_geom(image, workdir, **k):
        dump = k.get("dump_clarity_pdf")
        seen["dump_arg"] = dump
        if dump:
            with open(dump, "wb") as fh:
                fh.write(b"%PDF-1.4 shim")
        return str(geom_out)

    def fake_run_clarity(pdf_path, workdir, **k):
        seen["clarity_input"] = pdf_path
        return str(clar_out)

    monkeypatch.setattr(worker, "run_geom", fake_run_geom)
    monkeypatch.setattr(worker, "run_clarity", fake_run_clarity)

    def fake_fuse(g, c):
        seen["g"], seen["c"] = g, c
        return b"<score>fused</score>"

    monkeypatch.setattr(worker.fusion, "fuse", fake_fuse)
    monkeypatch.setattr(worker.llm_omr, "llm_available", lambda: False)
    monkeypatch.setattr(worker, "merge_to_grand_staff", lambda b: b)
    monkeypatch.setattr(worker, "normalize_ties", lambda b: b)

    client = _FakeClient(input_bytes=b"\x89PNG fake")
    _drive_process_job(monkeypatch, client, is_pdf=False)
    assert client.put_body == b"<score>fused</score>"
    assert seen["clarity_input"] == seen["dump_arg"]  # Clarity read the DUMP, not the photo
    assert seen["clarity_input"].endswith("clarity-input.pdf")
    assert seen["g"] == b"<score>geom</score>"
    assert seen["c"] == b"<score>clarity</score>"


def test_photo_clarity_no_dump_skips_clarity(tmp_path, monkeypatch):
    # geom produced a result but NO dump file (dump failed / older geom): Clarity must not run and
    # the output is geom's bytes unchanged -- the structural never-worse floor. With progressive on
    # there is also no redundant partial (nothing to refine to), so exactly one complete write.
    monkeypatch.setenv("OMR_GEOM", "1")
    monkeypatch.setenv("OMR_GEOM_FUSION", "1")
    monkeypatch.setenv("OMR_PHOTO_CLARITY", "1")
    monkeypatch.setenv("OMR_PROGRESSIVE", "1")
    geom_out = tmp_path / "geom.musicxml"; geom_out.write_text("<score>geom</score>")
    monkeypatch.setattr(worker, "run_geom", lambda *a, **k: str(geom_out))  # never writes the dump

    def clarity_must_not_run(*a, **k):
        raise AssertionError("no dump PDF was written, so Clarity must not run")

    monkeypatch.setattr(worker, "run_clarity", clarity_must_not_run)
    monkeypatch.setattr(worker.fusion, "fuse", lambda g, c: g)  # fuse(geom, None) -> geom
    monkeypatch.setattr(worker.llm_omr, "llm_available", lambda: False)
    monkeypatch.setattr(worker, "merge_to_grand_staff", lambda b: b)
    monkeypatch.setattr(worker, "normalize_ties", lambda b: b)

    client = _FakeClient(input_bytes=b"\x89PNG fake")
    _drive_process_job(monkeypatch, client, is_pdf=False)
    assert len(client.puts) == 1, "no Clarity refine -> no partial, one complete write"
    assert client.put_body == b"<score>geom</score>"


def test_photo_clarity_geom_none_skips_clarity(tmp_path, monkeypatch):
    # geom declined entirely: there is no dump and no geom bytes, so Clarity must not run and the
    # job falls through to the later engines exactly as with the flag off.
    monkeypatch.setenv("OMR_GEOM", "1")
    monkeypatch.setenv("OMR_GEOM_FUSION", "1")
    monkeypatch.setenv("OMR_PHOTO_CLARITY", "1")
    monkeypatch.setattr(worker, "run_geom", lambda *a, **k: None)

    def clarity_must_not_run(*a, **k):
        raise AssertionError("geom declined, so the shim must not run Clarity")

    monkeypatch.setattr(worker, "run_clarity", clarity_must_not_run)
    monkeypatch.setattr(worker.fusion, "fuse", lambda g, c: g)
    monkeypatch.setattr(worker.llm_omr, "llm_available", lambda: False)
    fell_through = {}

    def fake_legacy(job_id, input_path, workdir, is_pdf_input):
        fell_through["legacy"] = True
        return None, None

    monkeypatch.setattr(worker, "_select_legacy", fake_legacy)

    client = _FakeClient(input_bytes=b"\x89PNG fake")
    _drive_process_job(monkeypatch, client, is_pdf=False)
    assert fell_through.get("legacy") is True  # the pre-shim fallback chain ran unchanged


# --- UVDoc guarded rectify (OMR_UVDOC): photo-only learned-dewarp candidate ----------------------


def test_uvdoc_enabled_truthy_parsing(monkeypatch):
    monkeypatch.delenv("OMR_UVDOC", raising=False)
    assert worker.uvdoc_enabled() is False
    for on in ("1", "true", "TRUE", " True "):
        monkeypatch.setenv("OMR_UVDOC", on)
        assert worker.uvdoc_enabled() is True, on
    for off in ("0", "false", "", "garbage"):
        monkeypatch.setenv("OMR_UVDOC", off)
        assert worker.uvdoc_enabled() is False, off


def test_geom_command_try_uvdoc_arg():
    # --try-uvdoc rides on geom's CLI only when requested; the default argv is unchanged.
    base = worker.geom_command("py", "s.py", "img.png", "w.pt", "out.xml")
    assert "--try-uvdoc" not in base
    flagged = worker.geom_command("py", "s.py", "img.png", "w.pt", "out.xml", try_uvdoc=True)
    assert flagged[-1] == "--try-uvdoc"
    assert flagged[:-1] == base


def test_uvdoc_photo_upload_threads_try_uvdoc(tmp_path, monkeypatch):
    # OMR_UVDOC on a NON-PDF upload: the geom run carries try_uvdoc=True.
    monkeypatch.setenv("OMR_GEOM", "1")
    monkeypatch.setenv("OMR_GEOM_FUSION", "1")
    monkeypatch.setenv("OMR_UVDOC", "1")
    geom_out = tmp_path / "geom.musicxml"; geom_out.write_text("<score>geom</score>")
    seen = {}

    def fake_run_geom(image, workdir, **k):
        seen["try_uvdoc"] = k.get("try_uvdoc")
        return str(geom_out)

    monkeypatch.setattr(worker, "run_geom", fake_run_geom)
    monkeypatch.setattr(worker.fusion, "fuse", lambda g, c: g)
    monkeypatch.setattr(worker.llm_omr, "llm_available", lambda: False)
    monkeypatch.setattr(worker, "merge_to_grand_staff", lambda b: b)
    monkeypatch.setattr(worker, "normalize_ties", lambda b: b)

    client = _FakeClient(input_bytes=b"\x89PNG fake")
    _drive_process_job(monkeypatch, client, is_pdf=False)
    assert seen["try_uvdoc"] is True
    assert client.put_body == b"<score>geom</score>"


def test_uvdoc_pdf_upload_never_tries_uvdoc(tmp_path, monkeypatch):
    # Flag ON but the upload is a PDF: try_uvdoc must be False (PDFs are structurally untouched).
    monkeypatch.setenv("OMR_GEOM", "1")
    monkeypatch.setenv("OMR_GEOM_FUSION", "1")
    monkeypatch.setenv("OMR_UVDOC", "1")
    geom_out = tmp_path / "geom.musicxml"; geom_out.write_text("<score>geom</score>")
    seen = {}

    def fake_run_geom(image, workdir, **k):
        seen["try_uvdoc"] = k.get("try_uvdoc")
        return str(geom_out)

    monkeypatch.setattr(worker, "rasterize_if_pdf", lambda p, w: ("/fake/stitched.png", True))
    monkeypatch.setattr(worker, "run_geom", fake_run_geom)
    monkeypatch.setattr(worker, "run_clarity", lambda *a, **k: None)
    monkeypatch.setattr(worker.fusion, "fuse", lambda g, c: g)
    monkeypatch.setattr(worker.llm_omr, "llm_available", lambda: False)
    monkeypatch.setattr(worker, "merge_to_grand_staff", lambda b: b)
    monkeypatch.setattr(worker, "normalize_ties", lambda b: b)

    client = _FakeClient(input_bytes=b"%PDF-1.4 fake")
    _drive_process_job(monkeypatch, client, is_pdf=True)
    assert seen["try_uvdoc"] is False


def test_uvdoc_off_photo_upload_does_not_try(tmp_path, monkeypatch):
    # Flag unset: the geom argv decision is False, exactly today's behavior.
    monkeypatch.delenv("OMR_UVDOC", raising=False)
    monkeypatch.setenv("OMR_GEOM", "1")
    monkeypatch.setenv("OMR_GEOM_FUSION", "1")
    geom_out = tmp_path / "geom.musicxml"; geom_out.write_text("<score>geom</score>")
    seen = {}

    def fake_run_geom(image, workdir, **k):
        seen["try_uvdoc"] = k.get("try_uvdoc")
        return str(geom_out)

    monkeypatch.setattr(worker, "run_geom", fake_run_geom)
    monkeypatch.setattr(worker.fusion, "fuse", lambda g, c: g)
    monkeypatch.setattr(worker.llm_omr, "llm_available", lambda: False)
    monkeypatch.setattr(worker, "merge_to_grand_staff", lambda b: b)
    monkeypatch.setattr(worker, "normalize_ties", lambda b: b)

    client = _FakeClient(input_bytes=b"\x89PNG fake")
    _drive_process_job(monkeypatch, client, is_pdf=False)
    assert seen["try_uvdoc"] is False


def test_uvdoc_rekey_rerun_also_tries_uvdoc(tmp_path, monkeypatch):
    # The rekey rerun goes through the same _geom_body, so a photo upload's re-keyed geom run
    # makes the SAME guarded UVDoc decision as the first run (deterministic raster choice).
    monkeypatch.setenv("OMR_GEOM", "1")
    monkeypatch.setenv("OMR_GEOM_FUSION", "1")
    monkeypatch.setenv("OMR_PHOTO_CLARITY", "1")
    monkeypatch.setenv("OMR_UVDOC", "1")
    geom_out = tmp_path / "geom.musicxml"; geom_out.write_text("<score>geom</score>")
    clar_out = tmp_path / "clarity.musicxml"
    clar_out.write_text("<score><key><fifths>2</fifths></key></score>")
    calls = []

    def fake_run_geom(image, workdir, **k):
        calls.append(dict(k))
        dump = k.get("dump_clarity_pdf")
        if dump:
            with open(dump, "wb") as fh:
                fh.write(b"%PDF-1.4 shim")
        return str(geom_out)

    monkeypatch.setattr(worker, "run_geom", fake_run_geom)
    monkeypatch.setattr(worker, "run_clarity", lambda *a, **k: str(clar_out))
    monkeypatch.setattr(worker.fusion, "fuse", lambda g, c: g)
    monkeypatch.setattr(worker.llm_omr, "llm_available", lambda: False)
    monkeypatch.setattr(worker, "merge_to_grand_staff", lambda b: b)
    monkeypatch.setattr(worker, "normalize_ties", lambda b: b)

    client = _FakeClient(input_bytes=b"\x89PNG fake")
    _drive_process_job(monkeypatch, client, is_pdf=False)
    rekey_calls = [k for k in calls if k.get("key_fifths")]
    assert rekey_calls, "Clarity reported fifths=2, so the rekey rerun must have fired"
    assert all(k.get("try_uvdoc") is True for k in calls), calls


def test_geom_fusion_takes_precedence_over_primary(tmp_path, monkeypatch):
    # With both OMR_GEOM_FUSION and OMR_GEOM_PRIMARY set, fusion runs and geom-primary does not
    # re-run geom or override the fused result (geom runs exactly once, for the fusion).
    monkeypatch.setenv("OMR_GEOM", "1")
    monkeypatch.setenv("OMR_GEOM_FUSION", "1")
    monkeypatch.setenv("OMR_GEOM_PRIMARY", "1")
    geom_out = tmp_path / "geom.musicxml"; geom_out.write_text("<score>geom</score>")
    calls = {"geom": 0}

    def counting_geom(*a, **k):
        calls["geom"] += 1
        return str(geom_out)

    monkeypatch.setattr(worker, "rasterize_if_pdf", lambda p, w: ("/fake/s.png", True))
    monkeypatch.setattr(worker, "run_geom", counting_geom)
    monkeypatch.setattr(worker, "run_clarity", lambda *a, **k: None)
    monkeypatch.setattr(worker.fusion, "fuse", lambda g, c: b"<score>fused</score>")
    monkeypatch.setattr(worker.llm_omr, "llm_available", lambda: False)
    monkeypatch.setattr(worker, "merge_to_grand_staff", lambda b: b)
    monkeypatch.setattr(worker, "normalize_ties", lambda b: b)

    client = _FakeClient(input_bytes=b"%PDF-1.4 fake")
    _drive_process_job(monkeypatch, client, is_pdf=True)
    assert client.put_body == b"<score>fused</score>"
    assert calls["geom"] == 1  # geom ran once (for the fusion), not again for primary


def test_llm_falls_back_to_engines_when_it_returns_none(tmp_path, monkeypatch):
    # If the LLM returns None (any failure), the worker falls back to the existing engines.
    monkeypatch.setattr(worker.llm_omr, "llm_available", lambda: True)
    monkeypatch.setattr(worker.llm_omr, "transcribe", lambda image: None)
    clarity_out = tmp_path / "clarity.musicxml"
    clarity_out.write_text("<score/>")
    monkeypatch.setattr(worker, "run_clarity", lambda *a, **k: str(clarity_out))
    monkeypatch.setattr(worker, "merge_to_grand_staff", lambda b: b)
    monkeypatch.setattr(worker, "normalize_ties", lambda b: b)

    client = _FakeClient(input_bytes=b"\x89PNG fake")
    _drive_process_job(monkeypatch, client, is_pdf=False)
    assert client.put_body is not None  # fell back to the engine path


def test_llm_off_by_default_keeps_existing_flow(tmp_path, monkeypatch):
    # With the LLM unavailable (default), behavior is exactly the legacy/ensemble flow.
    monkeypatch.setattr(worker.llm_omr, "llm_available", lambda: False)

    def transcribe_must_not_run(image):
        raise AssertionError("LLM must not run when unavailable")

    monkeypatch.setattr(worker.llm_omr, "transcribe", transcribe_must_not_run)
    clarity_out = tmp_path / "clarity.musicxml"
    clarity_out.write_text("<score/>")
    monkeypatch.setattr(worker, "run_clarity", lambda *a, **k: str(clarity_out))
    monkeypatch.setattr(worker, "merge_to_grand_staff", lambda b: b)
    monkeypatch.setattr(worker, "normalize_ties", lambda b: b)

    client = _FakeClient(input_bytes=b"%PDF-1.4 fake")
    _drive_process_job(monkeypatch, client, is_pdf=True)
    assert client.put_body is not None


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


# --- PROGRESSIVE publishing (OMR_PROGRESSIVE / OMR_PROGRESSIVE_PAGES) ----------------------------
# Fast-then-refine + per-page streaming wired into process_job, plus the partial-aware idempotency
# gate. The pure stamp/append helpers are covered in test_progressive.py; these test the WIRING:
# which bodies get written, in what order, and with what omr-status metadata.
import llm_omr as _pg_llm  # noqa: E402


def _pg_xml(steps, octave=5):
    """A MusicXML fixture with one single-quarter-note measure per step letter, built with the tested
    llm_omr builder so it matches the real geom/fusion output shape (1 part, 2 staves)."""
    measures = [
        {"staff1": [{"duration": 4, "pitches": [{"step": s, "octave": octave}]}], "staff2": []}
        for s in steps
    ]
    return _pg_llm.score_json_to_musicxml(
        {"divisions": 4, "time": {"beats": 4, "beat_type": 4}, "measures": measures})


def _mcount(body):
    """Number of <measure> elements in a result body (its size, for asserting a growing score)."""
    import xml.etree.ElementTree as ET

    return len(ET.fromstring(body).findall("part/measure"))


class _HeadClient:
    """Stand-in exposing only head_object, for result_is_complete: returns the given metadata, or
    raises a 404 ClientError when missing=True."""

    def __init__(self, metadata=None, missing=False):
        self._metadata = metadata
        self._missing = missing

    def head_object(self, Bucket, Key):
        if self._missing:
            err = worker.ClientError()
            err.response = {"Error": {"Code": "404"}}
            raise err
        return {"Metadata": dict(self._metadata or {})}


def test_result_is_complete_partial_metadata_reprocesses():
    # A partial result (omr-status=partial) must NOT satisfy the gate: the upload is still present
    # and the job has to finish, so process_job reprocesses instead of stranding at the partial.
    assert worker.result_is_complete(_HeadClient(metadata={"omr-status": "partial"}), "b", _JOB_ID) is False


def test_result_is_complete_complete_metadata_skips():
    assert worker.result_is_complete(_HeadClient(metadata={"omr-status": "complete"}), "b", _JOB_ID) is True


def test_result_is_complete_legacy_unmarked_counts_as_complete():
    # A pre-progressive result has no metadata; it was always a finished write, so it counts complete.
    assert worker.result_is_complete(_HeadClient(metadata={}), "b", _JOB_ID) is True


def test_result_is_complete_missing_result_is_false():
    assert worker.result_is_complete(_HeadClient(missing=True), "b", _JOB_ID) is False


def test_result_is_complete_reads_status_case_insensitively():
    # The crash-recovery guarantee (a partial never satisfies the gate) must survive the R2 endpoint
    # returning the metadata key in a different case than boto3's usual lowercase.
    assert worker.result_is_complete(_HeadClient(metadata={"Omr-Status": "partial"}), "b", _JOB_ID) is False
    assert worker.result_is_complete(_HeadClient(metadata={"OMR-STATUS": "complete"}), "b", _JOB_ID) is True


def test_progressive_skips_writing_an_unmarked_partial(tmp_path, monkeypatch):
    # If stamp_partial ever failed to add the in-body marker (its never-raise fallback returns the
    # input unstamped), the partial MUST NOT be written to the result key: an unmarked body reads as a
    # COMPLETE result client-side and would stop polling early. So only the complete write happens.
    monkeypatch.setenv("OMR_GEOM", "1")
    monkeypatch.setenv("OMR_GEOM_FUSION", "1")
    monkeypatch.setenv("OMR_PROGRESSIVE", "1")
    geom_out = tmp_path / "geom.musicxml"
    geom_out.write_bytes(_pg_xml(["C"]))
    clar_out = tmp_path / "clarity.musicxml"
    clar_out.write_text("<score>clarity</score>")
    monkeypatch.setattr(worker, "rasterize_if_pdf", lambda p, w: ("/fake.png", True))
    monkeypatch.setattr(worker, "run_geom", lambda *a, **k: str(geom_out))
    monkeypatch.setattr(worker, "run_clarity", lambda *a, **k: str(clar_out))
    monkeypatch.setattr(worker.fusion, "fuse", lambda g, c: b"<score>fused</score>")
    monkeypatch.setattr(worker.llm_omr, "llm_available", lambda: False)
    monkeypatch.setattr(worker, "merge_to_grand_staff", lambda b: b)
    monkeypatch.setattr(worker, "normalize_ties", lambda b: b)
    # Simulate stamping failing to mark the body (returns it unstamped).
    monkeypatch.setattr(worker.progressive, "stamp_partial", lambda b, v: b)

    client = _FakeClient(input_bytes=b"%PDF-1.4 fake")
    _drive_process_job(monkeypatch, client, is_pdf=True)
    assert len(client.puts) == 1, "the unmarked partial was skipped; only the complete write happened"
    assert client.puts[0]["metadata"]["omr-status"] == "complete"
    assert client.puts[0]["body"] == b"<score>fused</score>"


def test_progressive_fusion_publishes_geom_partial_then_fused_complete(tmp_path, monkeypatch):
    # FAST-THEN-REFINE: OMR_GEOM + OMR_GEOM_FUSION + OMR_PROGRESSIVE on a PDF publishes geom's
    # pitch-only result as a PARTIAL (the browser shows all notes in ~5s), then the fused result as
    # the COMPLETE. Two writes, with the right omr-status metadata and the partial's in-body marker.
    monkeypatch.setenv("OMR_GEOM", "1")
    monkeypatch.setenv("OMR_GEOM_FUSION", "1")
    monkeypatch.setenv("OMR_PROGRESSIVE", "1")
    geom_out = tmp_path / "geom.musicxml"
    geom_out.write_bytes(_pg_xml(["C", "D"]))
    clar_out = tmp_path / "clarity.musicxml"
    clar_out.write_text("<score>clarity</score>")
    monkeypatch.setattr(worker, "rasterize_if_pdf", lambda p, w: ("/fake.png", True))
    monkeypatch.setattr(worker, "run_geom", lambda *a, **k: str(geom_out))
    monkeypatch.setattr(worker, "run_clarity", lambda *a, **k: str(clar_out))
    monkeypatch.setattr(worker.fusion, "fuse", lambda g, c: b"<score>fused</score>")
    monkeypatch.setattr(worker.llm_omr, "llm_available", lambda: False)
    monkeypatch.setattr(worker, "merge_to_grand_staff", lambda b: b)
    monkeypatch.setattr(worker, "normalize_ties", lambda b: b)

    client = _FakeClient(input_bytes=b"%PDF-1.4 fake")
    _drive_process_job(monkeypatch, client, is_pdf=True)

    assert len(client.puts) == 2, "one partial then one complete"
    partial, complete = client.puts[0], client.puts[1]
    assert partial["metadata"]["omr-status"] == "partial"
    assert b'name="omr-status">partial' in partial["body"]   # marker the browser reads
    assert b'name="omr-version">1' in partial["body"]
    assert complete["metadata"]["omr-status"] == "complete"
    assert complete["body"] == b"<score>fused</score>"


def test_progressive_non_pdf_publishes_no_partial(tmp_path, monkeypatch):
    # A non-PDF has no Clarity refine, so there is nothing to refine TO: the geom result is the
    # final answer. We publish it once (complete) with no redundant partial.
    monkeypatch.setenv("OMR_GEOM", "1")
    monkeypatch.setenv("OMR_GEOM_FUSION", "1")
    monkeypatch.setenv("OMR_PROGRESSIVE", "1")
    geom_out = tmp_path / "geom.musicxml"
    geom_out.write_bytes(_pg_xml(["C"]))
    monkeypatch.setattr(worker, "run_geom", lambda *a, **k: str(geom_out))

    def clarity_must_not_run(*a, **k):
        raise AssertionError("clarity is PDF-only; it must not run for a non-PDF upload")

    monkeypatch.setattr(worker, "run_clarity", clarity_must_not_run)
    monkeypatch.setattr(worker.fusion, "fuse", lambda g, c: g)  # fuse(geom, None) -> geom
    monkeypatch.setattr(worker.llm_omr, "llm_available", lambda: False)
    monkeypatch.setattr(worker, "merge_to_grand_staff", lambda b: b)
    monkeypatch.setattr(worker, "normalize_ties", lambda b: b)

    client = _FakeClient(input_bytes=b"\x89PNG fake")
    _drive_process_job(monkeypatch, client, is_pdf=False)
    assert len(client.puts) == 1, "no refine on a non-PDF, so no partial"
    assert client.puts[0]["metadata"]["omr-status"] == "complete"


def test_progressive_photo_clarity_publishes_geom_partial_then_fused_complete(tmp_path, monkeypatch):
    # With the photo-to-PDF shim ON, a photo job DOES have a refine (Clarity on geom's dump takes
    # minutes), so the fast-then-refine shape applies to photos too: geom's pitch partial first,
    # the fused result as the complete.
    monkeypatch.setenv("OMR_GEOM", "1")
    monkeypatch.setenv("OMR_GEOM_FUSION", "1")
    monkeypatch.setenv("OMR_PHOTO_CLARITY", "1")
    monkeypatch.setenv("OMR_PROGRESSIVE", "1")
    geom_out = tmp_path / "geom.musicxml"
    geom_out.write_bytes(_pg_xml(["C", "D"]))
    clar_out = tmp_path / "clarity.musicxml"
    clar_out.write_text("<score>clarity</score>")

    def fake_run_geom(image, workdir, **k):
        dump = k.get("dump_clarity_pdf")
        if dump:
            with open(dump, "wb") as fh:
                fh.write(b"%PDF-1.4 shim")
        return str(geom_out)

    monkeypatch.setattr(worker, "run_geom", fake_run_geom)
    monkeypatch.setattr(worker, "run_clarity", lambda *a, **k: str(clar_out))
    monkeypatch.setattr(worker.fusion, "fuse", lambda g, c: b"<score>fused</score>")
    monkeypatch.setattr(worker.llm_omr, "llm_available", lambda: False)
    monkeypatch.setattr(worker, "merge_to_grand_staff", lambda b: b)
    monkeypatch.setattr(worker, "normalize_ties", lambda b: b)

    client = _FakeClient(input_bytes=b"\x89PNG fake")
    _drive_process_job(monkeypatch, client, is_pdf=False)

    assert len(client.puts) == 2, "one geom partial then one fused complete"
    partial, complete = client.puts[0], client.puts[1]
    assert partial["metadata"]["omr-status"] == "partial"
    assert b'name="omr-status">partial' in partial["body"]
    assert complete["metadata"]["omr-status"] == "complete"
    assert complete["body"] == b"<score>fused</score>"


def test_progressive_off_fusion_writes_once_complete(tmp_path, monkeypatch):
    # Progressive OFF (prod default): the fusion path writes EXACTLY ONCE (the complete result), no
    # partial, so behavior is byte-identical to before the progressive feature.
    monkeypatch.setenv("OMR_GEOM", "1")
    monkeypatch.setenv("OMR_GEOM_FUSION", "1")
    monkeypatch.delenv("OMR_PROGRESSIVE", raising=False)
    geom_out = tmp_path / "geom.musicxml"
    geom_out.write_text("<score>geom</score>")
    clar_out = tmp_path / "clarity.musicxml"
    clar_out.write_text("<score>clarity</score>")
    monkeypatch.setattr(worker, "rasterize_if_pdf", lambda p, w: ("/fake.png", True))
    monkeypatch.setattr(worker, "run_geom", lambda *a, **k: str(geom_out))
    monkeypatch.setattr(worker, "run_clarity", lambda *a, **k: str(clar_out))
    monkeypatch.setattr(worker.fusion, "fuse", lambda g, c: b"<score>fused</score>")
    monkeypatch.setattr(worker.llm_omr, "llm_available", lambda: False)
    monkeypatch.setattr(worker, "merge_to_grand_staff", lambda b: b)
    monkeypatch.setattr(worker, "normalize_ties", lambda b: b)

    client = _FakeClient(input_bytes=b"%PDF-1.4 fake")
    _drive_process_job(monkeypatch, client, is_pdf=True)
    assert len(client.puts) == 1, "progressive off => single complete write"
    assert client.puts[0]["metadata"]["omr-status"] == "complete"
    assert client.put_body == b"<score>fused</score>"


def test_fusion_per_page_streams_and_accumulates(tmp_path, monkeypatch):
    # PER-PAGE: three pages, each transcribed independently and APPENDED. Pages 1 and 2 are published
    # as partials (a growing score); page 3 (the last) is returned as the complete body. The measure
    # count grows 1 -> 2 -> 3 as pages accumulate.
    monkeypatch.setattr(worker, "split_pdf_pages", lambda i, w: ["p1", "p2", "p3"])
    pages = {"p1": _pg_xml(["C"]), "p2": _pg_xml(["D"]), "p3": _pg_xml(["E"])}
    monkeypatch.setattr(worker, "_transcribe_one_page", lambda pdf, d: pages[pdf])

    published = []
    final = worker._fusion_per_page("job", "in.pdf", str(tmp_path), lambda b: published.append(b))

    assert len(published) == 2, "pages 1 and 2 publish partials; page 3 is the returned complete"
    assert _mcount(published[0]) == 1
    assert _mcount(published[1]) == 2
    assert _mcount(final) == 3


def test_fusion_per_page_single_page_returns_none(tmp_path, monkeypatch):
    # A single-page PDF has nothing to stream, so per-page declines (returns None) and never even
    # transcribes; the caller falls back to whole-file fusion (which is concurrent and simpler).
    monkeypatch.setattr(worker, "split_pdf_pages", lambda i, w: ["only.pdf"])
    transcribed = []
    monkeypatch.setattr(worker, "_transcribe_one_page", lambda *a: transcribed.append(1))
    result = worker._fusion_per_page("job", "in.pdf", str(tmp_path), lambda b: None)
    assert result is None
    assert transcribed == []


def test_fusion_per_page_skips_pages_with_no_content(tmp_path, monkeypatch):
    # A page that recognizes nothing is skipped (no empty publish), but the run continues: page 1 is
    # a partial, page 2 contributes nothing, page 3 completes with 2 measures total.
    monkeypatch.setattr(worker, "split_pdf_pages", lambda i, w: ["p1", "p2", "p3"])
    pages = {"p1": _pg_xml(["C"]), "p2": None, "p3": _pg_xml(["E"])}
    monkeypatch.setattr(worker, "_transcribe_one_page", lambda pdf, d: pages[pdf])
    published = []
    final = worker._fusion_per_page("job", "in.pdf", str(tmp_path), lambda b: published.append(b))
    assert len(published) == 1
    assert _mcount(published[0]) == 1
    assert _mcount(final) == 2


def test_fusion_per_page_all_pages_empty_returns_none(tmp_path, monkeypatch):
    monkeypatch.setattr(worker, "split_pdf_pages", lambda i, w: ["p1", "p2"])
    monkeypatch.setattr(worker, "_transcribe_one_page", lambda *a: None)
    published = []
    result = worker._fusion_per_page("job", "in.pdf", str(tmp_path), lambda b: published.append(b))
    assert result is None and published == []


def test_transcribe_one_page_fuses_geom_and_clarity(tmp_path, monkeypatch):
    monkeypatch.setattr(worker, "_geom_page_body", lambda pdf, d: b"<geom/>")
    clar = tmp_path / "c.musicxml"
    clar.write_bytes(b"<clar/>")
    monkeypatch.setattr(worker, "run_clarity", lambda pdf, d, **k: str(clar))
    seen = {}
    monkeypatch.setattr(worker.fusion, "fuse", lambda g, c: seen.update(g=g, c=c) or b"<fused/>")
    out = worker._transcribe_one_page("p.pdf", str(tmp_path))
    assert out == b"<fused/>"
    assert seen["g"] == b"<geom/>" and seen["c"] == b"<clar/>"


def test_transcribe_one_page_clarity_fail_degrades_to_geom(tmp_path, monkeypatch):
    # A page whose Clarity failed must never drop below the geom (placeholder-rhythm) layer.
    monkeypatch.setattr(worker, "_geom_page_body", lambda pdf, d: b"<geom/>")
    monkeypatch.setattr(worker, "run_clarity", lambda pdf, d, **k: None)
    monkeypatch.setattr(worker.fusion, "fuse", lambda g, c: g if c is None else b"<fused/>")
    out = worker._transcribe_one_page("p.pdf", str(tmp_path))
    assert out == b"<geom/>"


def test_transcribe_one_page_both_fail_returns_none(tmp_path, monkeypatch):
    monkeypatch.setattr(worker, "_geom_page_body", lambda pdf, d: None)
    monkeypatch.setattr(worker, "run_clarity", lambda pdf, d, **k: None)

    def fuse_must_not_run(g, c):
        raise AssertionError("nothing recognized on the page; fuse must not run")

    monkeypatch.setattr(worker.fusion, "fuse", fuse_must_not_run)
    assert worker._transcribe_one_page("p.pdf", str(tmp_path)) is None


def test_transcribe_one_page_collapses_two_part_clarity_to_grand_staff(tmp_path, monkeypatch):
    # A clarity-only page (geom failed) returns Clarity's RAW output, which can be 2 parts. Per-page
    # append_measures concatenates the first <part>, so the page must collapse to ONE grand-staff part
    # first or the bass staff is silently dropped. Uses the REAL fusion.fuse + merge_to_grand_staff.
    two_part = (
        b'<?xml version="1.0"?><score-partwise version="4.0">'
        b'<part-list><score-part id="P1"><part-name>RH</part-name></score-part>'
        b'<score-part id="P2"><part-name>LH</part-name></score-part></part-list>'
        b'<part id="P1"><measure number="1"><attributes><divisions>1</divisions>'
        b'<key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time>'
        b'<clef><sign>G</sign><line>2</line></clef></attributes>'
        b'<note><pitch><step>C</step><octave>5</octave></pitch><duration>4</duration>'
        b'<type>whole</type></note></measure></part>'
        b'<part id="P2"><measure number="1"><attributes>'
        b'<clef><sign>F</sign><line>4</line></clef></attributes>'
        b'<note><pitch><step>C</step><octave>3</octave></pitch><duration>4</duration>'
        b'<type>whole</type></note></measure></part></score-partwise>'
    )
    clar = tmp_path / "c.musicxml"
    clar.write_bytes(two_part)
    monkeypatch.setattr(worker, "_geom_page_body", lambda pdf, d: None)        # geom failed
    monkeypatch.setattr(worker, "run_clarity", lambda pdf, d, **k: str(clar))  # clarity only
    out = worker._transcribe_one_page("p.pdf", str(tmp_path))
    import xml.etree.ElementTree as ET

    root = ET.fromstring(out)
    assert len(root.findall("part")) == 1, "collapsed to one grand-staff part"
    # Both the treble C5 and the bass C3 survive (the bass staff is not dropped on append).
    octaves = sorted(n.findtext("octave") for n in root.findall(".//pitch"))
    assert octaves == ["3", "5"], octaves


def test_split_pdf_pages_missing_binary_returns_empty(tmp_path, monkeypatch):
    def boom(*a, **k):
        raise FileNotFoundError("pdfseparate not installed")

    monkeypatch.setattr(worker.subprocess, "run", boom)
    assert worker.split_pdf_pages("in.pdf", str(tmp_path)) == []


def test_split_pdf_pages_sorts_numerically_not_lexically(tmp_path, monkeypatch):
    # pdfseparate's %d is not zero-padded, so page-10 must sort AFTER page-2, not before it.
    out_dir = tmp_path / "pages"

    def fake_run(cmd, check=True):
        out_dir.mkdir(exist_ok=True)
        for n in (1, 2, 10):
            (out_dir / ("page-%d.pdf" % n)).write_text("x")

    monkeypatch.setattr(worker.subprocess, "run", fake_run)
    pages = worker.split_pdf_pages("in.pdf", str(tmp_path))
    assert [worker._page_index(p) for p in pages] == [1, 2, 10]


def test_progressive_pages_wired_into_process_job(tmp_path, monkeypatch):
    # WIRING: OMR_PROGRESSIVE + OMR_PROGRESSIVE_PAGES routes a multi-page PDF through _fusion_per_page,
    # whose partials plus the returned complete are the three writes. The whole-file geom path must
    # not run when per-page produced a result.
    monkeypatch.setenv("OMR_GEOM", "1")
    monkeypatch.setenv("OMR_GEOM_FUSION", "1")
    monkeypatch.setenv("OMR_PROGRESSIVE", "1")
    monkeypatch.setenv("OMR_PROGRESSIVE_PAGES", "1")

    def fake_per_page(job_id, input_path, workdir, publish_partial):
        publish_partial(_pg_xml(["C"]))          # page 1 partial
        publish_partial(_pg_xml(["C", "D"]))     # page 2 partial
        return _pg_xml(["C", "D", "E"])          # page 3 -> complete

    monkeypatch.setattr(worker, "_fusion_per_page", fake_per_page)

    def whole_file_geom_must_not_run(*a, **k):
        raise AssertionError("whole-file fusion must not run when per-page produced a result")

    monkeypatch.setattr(worker, "run_geom", whole_file_geom_must_not_run)
    monkeypatch.setattr(worker.llm_omr, "llm_available", lambda: False)
    monkeypatch.setattr(worker, "merge_to_grand_staff", lambda b: b)
    monkeypatch.setattr(worker, "normalize_ties", lambda b: b)

    client = _FakeClient(input_bytes=b"%PDF-1.4 fake")
    _drive_process_job(monkeypatch, client, is_pdf=True)

    assert [p["metadata"]["omr-status"] for p in client.puts] == ["partial", "partial", "complete"]
    assert _mcount(client.puts[2]["body"]) == 3


# --- BLOCK-BY-BLOCK streaming (OMR_PROGRESSIVE_BLOCKS) -------------------------------------------
# One warm Clarity invocation emits each staff system's CUMULATIVE rhythm as it decodes; the worker
# fuses geom's whole-page pitch with the growing Clarity prefix and publishes per system. The hard
# guarantee under test: the assembled FINAL equals today's whole-file fusion on the same input.

def _grand_staff_geom(steps_treble, steps_bass=None, octave=5):
    """A geom-shaped MusicXML (geom's faked rhythm = every note duration 1, no <time> borrow) with
    one quarter-ish note per step letter, built via the real llm_omr builder so fusion.fuse reads it
    exactly as it reads real geom output. divisions=4; geom uses duration 1 (a 16th) as its fake."""
    measures = [
        {"staff1": [{"duration": 1, "pitches": [{"step": s, "octave": octave}]}],
         "staff2": ([{"duration": 1, "pitches": [{"step": steps_bass[i], "octave": 3}]}]
                    if steps_bass and i < len(steps_bass) else [])}
        for i, s in enumerate(steps_treble)
    ]
    return _pg_llm.score_json_to_musicxml({"divisions": 4, "key_fifths": 0,
                                           "time": {"beats": 4, "beat_type": 4}, "measures": measures})


def _clarity_doc(steps, durations, octave=5):
    """A Clarity-shaped MusicXML carrying real durations (the rhythm geom borrows). One note per step;
    durations are 16th-units at divisions=4 (4 = quarter). Single staff is enough for fusion's staff-1
    alignment in these tests."""
    measures = [
        {"staff1": [{"duration": d, "pitches": [{"step": s, "octave": octave}]}], "staff2": []}
        for s, d in zip(steps, durations)
    ]
    return _pg_llm.score_json_to_musicxml({"divisions": 4, "key_fifths": 0,
                                           "time": {"beats": 4, "beat_type": 4}, "measures": measures})


def test_progressive_blocks_enabled_truthy_parsing(monkeypatch):
    for value, expected in (("1", True), ("true", True), ("TRUE", True), ("0", False),
                            ("", False), ("yes", False)):
        monkeypatch.setenv("OMR_PROGRESSIVE_BLOCKS", value)
        assert worker.progressive_blocks_enabled() is expected
    monkeypatch.delenv("OMR_PROGRESSIVE_BLOCKS", raising=False)
    assert worker.progressive_blocks_enabled() is False


def test_parse_stream_line_valid_and_invalid():
    assert worker._parse_stream_line("STREAM 1 6 /tmp/emit/system-0001.musicxml") == (
        1, 6, "/tmp/emit/system-0001.musicxml")
    # A path with spaces is preserved (split into at most 4 fields).
    assert worker._parse_stream_line("STREAM 2 6 /tmp/a b/sys.xml") == (2, 6, "/tmp/a b/sys.xml")
    # Non-stream / malformed lines are ignored.
    assert worker._parse_stream_line("[stage-b-eval] 1/6 ...") is None
    assert worker._parse_stream_line("STREAM x 6 /p") is None
    assert worker._parse_stream_line("STREAM 1 6") is None
    assert worker._parse_stream_line("") is None
    assert worker._parse_stream_line(None) is None


def test_run_clarity_stream_returns_none_when_env_unset(tmp_path, monkeypatch):
    monkeypatch.delenv("CLARITY_OMR_DIR", raising=False)
    monkeypatch.delenv("CLARITY_PYTHON", raising=False)
    called = []
    assert worker.run_clarity_stream("in.pdf", str(tmp_path),
                                     lambda i, t, b: called.append(i)) is None
    assert called == []  # never even spawned


def test_fusion_block_stream_final_equals_whole_file_fusion(tmp_path, monkeypatch):
    # THE correctness guarantee: the body block-streaming returns for the COMPLETE write is identical
    # to today's whole-file fusion (fusion.fuse(geom_whole, clarity_whole)). We stub run_clarity_stream
    # to drive on_system with CUMULATIVE Clarity prefixes (system 1, then systems 1..2) and return the
    # whole Clarity doc, exactly like the real driver. geom + fusion.fuse + merge are REAL here.
    geom_whole = _grand_staff_geom(["C", "D"], steps_bass=["E", "F"])
    clarity_whole = _clarity_doc(["C", "D"], [4, 8])      # quarter then half
    clarity_prefix1 = _clarity_doc(["C"], [4])            # just system 1 so far

    geom_out = tmp_path / "geom.musicxml"
    geom_out.write_bytes(geom_whole)
    monkeypatch.setattr(worker, "rasterize_if_pdf", lambda p, w: ("/fake.png", True))
    monkeypatch.setattr(worker, "run_geom", lambda *a, **k: str(geom_out))

    def fake_stream(pdf_path, workdir, on_system, timeout=None):
        on_system(1, 2, clarity_prefix1)   # only the non-last systems publish
        return clarity_whole               # the warm run's final cumulative result

    monkeypatch.setattr(worker, "run_clarity_stream", fake_stream)

    def geom_body():
        with open(geom_out, "rb") as fh:
            return fh.read()

    published = []
    final = worker._fusion_block_stream(
        "job", "in.pdf", str(tmp_path), geom_body,
        lambda b, systems_total=None, systems_done=None: published.append(
            (b, systems_total, systems_done)))

    # The complete body is byte-identical to the whole-file fusion path.
    assert final == worker.fusion.fuse(geom_whole, clarity_whole)
    # Exactly one partial was published (system 1; the last system is the returned complete).
    assert len(published) == 1
    body, total, done = published[0]
    # FINISHED-ONLY: the partial contains ONLY the first system's measure (the Clarity prefix had 1
    # measure), not all of geom's 2 measures. The pending system is absent so the client skeletons it.
    assert _mcount(body) == 1
    # The frontier is stamped raw on the partial body (worker.publish_partial stamps it into XML; here
    # the raw body is handed straight through, so we assert the kwargs the callback forwarded).
    assert (total, done) == (2, 1)


def test_fusion_block_stream_stream_unavailable_returns_none(tmp_path, monkeypatch):
    # If the warm Clarity stream is unavailable (env unset, no systems, crash), block-streaming
    # declines (returns None) so process_job falls back to whole-file fusion. geom must not matter.
    monkeypatch.setattr(worker, "run_clarity_stream", lambda *a, **k: None)
    published = []
    result = worker._fusion_block_stream("job", "in.pdf", str(tmp_path),
                                         lambda: b"<geom/>", lambda b: published.append(b))
    assert result is None
    assert published == []


def test_fusion_block_stream_single_system_no_partial_still_final(tmp_path, monkeypatch):
    # A 1-system page streams nothing before the final (on_system fires only for NON-last systems),
    # but the final fuse must still run with geom's pitch + the whole Clarity result.
    geom_whole = _grand_staff_geom(["C"], steps_bass=["E"])
    clarity_whole = _clarity_doc(["C"], [4])
    monkeypatch.setattr(worker, "run_clarity_stream", lambda p, w, cb, timeout=None: clarity_whole)
    published = []
    final = worker._fusion_block_stream("job", "in.pdf", str(tmp_path),
                                        lambda: geom_whole, lambda b: published.append(b))
    assert published == []  # nothing published before the final on a single system
    assert final == worker.fusion.fuse(geom_whole, clarity_whole)


def test_progressive_blocks_wired_into_process_job(tmp_path, monkeypatch):
    # WIRING: OMR_PROGRESSIVE + OMR_PROGRESSIVE_BLOCKS routes a PDF through _fusion_block_stream. Its
    # partials carry omr-status=partial with a MONOTONIC omr-version, and the returned body is the
    # complete write. The whole-file geom path + per-page path must not run.
    monkeypatch.setenv("OMR_GEOM", "1")
    monkeypatch.setenv("OMR_GEOM_FUSION", "1")
    monkeypatch.setenv("OMR_PROGRESSIVE", "1")
    monkeypatch.setenv("OMR_PROGRESSIVE_BLOCKS", "1")

    def fake_block_stream(job_id, input_path, workdir, geom_body, publish_partial):
        # Each partial holds ONLY the finished systems + carries the frontier (total, done).
        publish_partial(_pg_xml(["C"]), systems_total=3, systems_done=1)        # system 1 partial
        publish_partial(_pg_xml(["C", "D"]), systems_total=3, systems_done=2)   # system 2 partial
        return _pg_xml(["C", "D", "E"])        # final -> complete

    monkeypatch.setattr(worker, "_fusion_block_stream", fake_block_stream)

    def must_not_run(*a, **k):
        raise AssertionError("the whole-file / per-page path must not run when block-stream produced a result")

    monkeypatch.setattr(worker, "run_geom", must_not_run)
    monkeypatch.setattr(worker, "_fusion_per_page", must_not_run)
    monkeypatch.setattr(worker.llm_omr, "llm_available", lambda: False)

    client = _FakeClient(input_bytes=b"%PDF-1.4 fake")
    _drive_process_job(monkeypatch, client, is_pdf=True)

    statuses = [p["metadata"]["omr-status"] for p in client.puts]
    assert statuses == ["partial", "partial", "complete"]
    # Monotonic omr-version on the partials (1 then 2), in the body the browser reads.
    assert b'name="omr-version">1' in client.puts[0]["body"]
    assert b'name="omr-version">2' in client.puts[1]["body"]
    # The system FRONTIER is stamped INTO each partial body so the client lays out the loader.
    assert b'name="omr-systems-total">3' in client.puts[0]["body"]
    assert b'name="omr-systems-done">1' in client.puts[0]["body"]
    assert b'name="omr-systems-total">3' in client.puts[1]["body"]
    assert b'name="omr-systems-done">2' in client.puts[1]["body"]
    # The COMPLETE write carries no frontier (it is the whole score, no per-system loader).
    assert b'omr-systems-total' not in client.puts[2]["body"]
    assert _mcount(client.puts[2]["body"]) == 3


def test_progressive_blocks_falls_back_to_whole_file_when_unavailable(tmp_path, monkeypatch):
    # If block-streaming declines (returns None), process_job must fall through to the existing
    # whole-file fusion path (single complete write, no partial), so it is never worse than today.
    monkeypatch.setenv("OMR_GEOM", "1")
    monkeypatch.setenv("OMR_GEOM_FUSION", "1")
    monkeypatch.setenv("OMR_PROGRESSIVE", "1")
    monkeypatch.setenv("OMR_PROGRESSIVE_BLOCKS", "1")
    monkeypatch.delenv("OMR_PROGRESSIVE_PAGES", raising=False)

    monkeypatch.setattr(worker, "_fusion_block_stream", lambda *a, **k: None)  # streaming unavailable
    geom_out = tmp_path / "geom.musicxml"
    geom_out.write_bytes(_pg_xml(["C"]))
    clar_out = tmp_path / "clarity.musicxml"
    clar_out.write_text("<score>clarity</score>")
    monkeypatch.setattr(worker, "rasterize_if_pdf", lambda p, w: ("/fake.png", True))
    monkeypatch.setattr(worker, "run_geom", lambda *a, **k: str(geom_out))
    monkeypatch.setattr(worker, "run_clarity", lambda *a, **k: str(clar_out))
    monkeypatch.setattr(worker.fusion, "fuse", lambda g, c: b"<score>fused</score>")
    monkeypatch.setattr(worker.llm_omr, "llm_available", lambda: False)
    monkeypatch.setattr(worker, "merge_to_grand_staff", lambda b: b)
    monkeypatch.setattr(worker, "normalize_ties", lambda b: b)

    client = _FakeClient(input_bytes=b"%PDF-1.4 fake")
    _drive_process_job(monkeypatch, client, is_pdf=True)

    # Fast-then-refine is still ON (OMR_PROGRESSIVE), so the whole-file path publishes the geom partial
    # then the fused complete. The key assertion: block-stream declined and we did NOT strand the job.
    assert client.puts[-1]["metadata"]["omr-status"] == "complete"
    assert client.puts[-1]["body"] == b"<score>fused</score>"


class _FakePopen:
    """Stand-in for subprocess.Popen used as a context manager: yields the given stdout LINES (so the
    driver's STREAM lines are parsed), exposes a readable stderr, and returns the given exit code from
    wait(). Used to drive run_clarity_stream's read loop with NO real subprocess / torch."""

    def __init__(self, lines, returncode=0, stderr_text=""):
        import io

        self.stdout = iter(lines)
        self.stderr = io.StringIO(stderr_text)
        self._returncode = returncode

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def wait(self, timeout=None):
        return self._returncode

    def kill(self):
        pass


def test_run_clarity_stream_parses_lines_and_reads_system_files(tmp_path, monkeypatch):
    # Drive the REAL run_clarity_stream read loop with a fake Popen: it emits 3 STREAM lines whose
    # files we pre-write. on_system must fire for systems 1 and 2 (NOT the last), each handed the
    # cumulative bytes of that system's file, and the returned final is the last system's bytes.
    monkeypatch.setenv("CLARITY_OMR_DIR", str(tmp_path))            # any existing dir
    fake_py = tmp_path / "py"
    fake_py.write_text("x")
    monkeypatch.setenv("CLARITY_PYTHON", str(fake_py))
    # The driver script must exist beside worker.py; it does (clarity_stream.py is committed there).

    emit_dir = tmp_path / "clarity-stream-emit"
    emit_dir.mkdir(parents=True, exist_ok=True)
    files = {}
    lines = []
    for k in (1, 2, 3):
        p = emit_dir / ("system-%04d.musicxml" % k)
        body = ("<sys>%d</sys>" % k).encode("utf-8")
        p.write_bytes(body)
        files[k] = body
        lines.append("STREAM %d 3 %s\n" % (k, p))
    # Interleave a non-STREAM progress line to prove it is ignored.
    lines.insert(1, "[stage-b-eval] 1/3 ...\n")

    monkeypatch.setattr(worker.subprocess, "Popen", lambda *a, **k: _FakePopen(lines, returncode=0))

    seen = []
    final = worker.run_clarity_stream(
        "in.pdf", str(tmp_path), lambda i, t, b: seen.append((i, t, b))
    )
    # Systems 1 and 2 published (the last is the returned complete), with the right cumulative bytes.
    assert [(i, t) for (i, t, _b) in seen] == [(1, 3), (2, 3)]
    assert seen[0][2] == files[1]
    assert seen[1][2] == files[2]
    # The returned final is the last system's bytes (no -o file was written by the fake driver).
    assert final == files[3]


def test_run_clarity_stream_nonzero_exit_returns_none(tmp_path, monkeypatch):
    # A non-zero driver exit (e.g. EXIT_NO_SYSTEMS or a crash) must yield None so process_job falls
    # back to whole-file fusion, even if some systems were emitted first.
    monkeypatch.setenv("CLARITY_OMR_DIR", str(tmp_path))
    fake_py = tmp_path / "py"
    fake_py.write_text("x")
    monkeypatch.setenv("CLARITY_PYTHON", str(fake_py))
    monkeypatch.setattr(
        worker.subprocess, "Popen",
        lambda *a, **k: _FakePopen([], returncode=worker.clarity_stream.EXIT_NO_SYSTEMS,
                                   stderr_text="no staff systems detected"),
    )
    seen = []
    assert worker.run_clarity_stream("in.pdf", str(tmp_path),
                                     lambda i, t, b: seen.append(i)) is None
    assert seen == []


# --- drop_ties_across_rests (a held note cannot cross a rest) -----------------------------

import xml.etree.ElementTree as _dt_ET  # noqa: E402


def _dt_note(step, octave, dur, staff=1, tie=None):
    t = ""
    if tie:
        t = "".join("<tie type='%s'/>" % x for x in tie)
        t += "<notations>%s</notations>" % "".join("<tied type='%s'/>" % x for x in tie)
    return ("<note><pitch><step>%s</step><octave>%d</octave></pitch>"
            "<duration>%d</duration>%s<staff>%d</staff></note>" % (step, octave, dur, t, staff))


def _dt_rest(dur, staff=1):
    return "<note><rest/><duration>%d</duration><staff>%d</staff></note>" % (dur, staff)


def _dt_doc(measures):
    body = "".join("<measure number='%d'>%s</measure>" % (i + 1, "".join(ns))
                   for i, ns in enumerate(measures))
    return ("<?xml version='1.0'?><score-partwise><part id='P1'>%s</part></score-partwise>"
            % body).encode("utf-8")


def _dt_tie_types(xml_bytes):
    return [t.get("type") for n in _dt_ET.fromstring(xml_bytes).iter("note")
            for t in n.findall("tie")]


def test_drop_ties_across_rests_strips_tie_spanning_a_rest():
    # C5 tie-start, a REST, then C5 tie-stop in the SAME staff: the held note crosses a silence,
    # which is impossible -> BOTH tie ends (and their engraved <tied> arcs) are removed.
    doc = _dt_doc([[_dt_note("C", 5, 4, tie=["start"]), _dt_rest(12)],
                   [_dt_note("C", 5, 4, tie=["stop"])]])
    out = worker.drop_ties_across_rests(doc)
    assert _dt_tie_types(out) == []          # no <tie> markup left
    assert b"<tied" not in out               # no engraved arc left
    # pitch/duration untouched: the two C5 notes and the rest all survive.
    notes = list(_dt_ET.fromstring(out).iter("note"))
    assert sum(1 for n in notes if n.find("rest") is not None) == 1
    assert sum(1 for n in notes if n.find("pitch") is not None) == 2


def test_drop_ties_across_rests_keeps_valid_cross_barline_tie():
    # C5 filling its bar (whole note) tied to the next bar's C5, NO rest between -> tie preserved.
    doc = _dt_doc([[_dt_note("C", 5, 16, tie=["start"])],
                   [_dt_note("C", 5, 4, tie=["stop"])]])
    assert _dt_tie_types(worker.drop_ties_across_rests(doc)) == ["start", "stop"]


def test_drop_ties_across_rests_ignores_rest_in_other_staff():
    # A rest in staff 2 between two staff-1 tied notes must NOT break the staff-1 tie.
    doc = _dt_doc([[_dt_note("C", 5, 16, staff=1, tie=["start"]), _dt_rest(16, staff=2)],
                   [_dt_note("C", 5, 4, staff=1, tie=["stop"])]])
    assert _dt_tie_types(worker.drop_ties_across_rests(doc)) == ["start", "stop"]


def test_drop_ties_across_rests_keeps_tie_when_rest_precedes_start():
    # A rest BEFORE the tie-start (not strictly between the two ends) must not drop the tie.
    doc = _dt_doc([[_dt_rest(8), _dt_note("C", 5, 8, tie=["start"])],
                   [_dt_note("C", 5, 4, tie=["stop"])]])
    assert _dt_tie_types(worker.drop_ties_across_rests(doc)) == ["start", "stop"]


def test_drop_ties_across_rests_no_tie_doc_is_clean_noop():
    # An oemer-style document with zero ties is returned with no tie markup (never fabricates one).
    doc = _dt_doc([[_dt_note("C", 5, 4), _dt_rest(12)], [_dt_note("C", 5, 4)]])
    out = worker.drop_ties_across_rests(doc)
    assert b"<tie" not in out
