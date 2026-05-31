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
