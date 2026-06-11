"""Unit tests for zeus_crops.py (Stage A of OMR_SEQ2SEQ): the olimpic crop margin convention,
the pickle entry shape (both pure), and the crop/exit-code flow with the staff detection
stubbed (no real detection model anywhere in this engine; detect_systems itself is covered by
test_geom_omr.py)."""
import pickle
import sys
import types

import pytest

# Stub the S3 stack like test_worker.py (zeus_crops itself never needs it, but keeping the
# import environment uniform across the worker test files costs nothing).
for _name in ("boto3", "botocore", "botocore.client", "botocore.exceptions"):
    if _name not in sys.modules:
        sys.modules[_name] = types.ModuleType(_name)
if not hasattr(sys.modules["botocore.client"], "Config"):
    sys.modules["botocore.client"].Config = object
if not hasattr(sys.modules["botocore.exceptions"], "ClientError"):
    sys.modules["botocore.exceptions"].ClientError = type("ClientError", (Exception,), {})

import zeus_crops  # noqa: E402


# --- pure helpers --------------------------------------------------------------------------


def test_crop_box_olimpic_margin():
    # System y 100..200 (height 100) -> margin 50 on all four sides.
    assert zeus_crops.crop_box(100, 200, 300, 700, 1000, 2000) == (50, 250, 250, 750)


def test_crop_box_clamps_to_image_bounds():
    cy1, cy2, cx1, cx2 = zeus_crops.crop_box(10, 110, 5, 95, 150, 100)
    assert (cy1, cx1) == (0, 0)          # margin 50 underflows -> clamp at 0
    assert (cy2, cx2) == (149, 99)       # and overflows -> clamp at the last index


def test_crop_box_margin_is_half_system_height():
    # Taller system -> proportionally larger margin (0.5 x height, the olimpic convention).
    cy1, cy2, _cx1, _cx2 = zeus_crops.crop_box(400, 600, 0, 100, 2000, 2000)
    assert cy1 == 300 and cy2 == 700


def test_pickle_entry_shape_matches_the_x4_convention():
    e = zeus_crops.pickle_entry("p1-s3", b"\x89PNGbytes")
    assert sorted(e) == ["image", "lmx", "musicxml", "path"]
    assert e["path"] == "crops/p1-s3"
    assert e["image"] == b"\x89PNGbytes"
    assert e["lmx"] == "measure"
    assert e["musicxml"] == ""


# --- the crop flow (detection stubbed) -----------------------------------------------------

np = pytest.importorskip("numpy")
Image = pytest.importorskip("PIL.Image")


@pytest.fixture()
def page(monkeypatch):
    """A white 400x300 page with an inked band and a stubbed two-staff detection forming one
    grand-staff pair (rows 100..240)."""
    if not zeus_crops.CROPS_AVAILABLE:
        pytest.skip("geom stack unavailable")
    gray = np.ones((400, 300), dtype=np.float32)
    gray[150:161, 20:281] = 0.0  # ink inside the pair band fixes the x extent
    staves = [[100.0, 110.0, 120.0, 130.0, 140.0], [200.0, 210.0, 220.0, 230.0, 240.0]]
    monkeypatch.setattr(zeus_crops.geom_omr, "detect_systems", lambda g: staves)
    monkeypatch.setattr(zeus_crops.geom_omr, "_pair_staves", lambda s: [(0, 1)])
    return gray


def test_build_entries_crops_the_pair_with_margin(page):
    entries = zeus_crops.build_entries(page)
    assert len(entries) == 1
    assert entries[0]["path"] == "crops/p1-s1"
    # y 100..240 (height 140, margin 70) -> rows 30..310; x ink 20..280 -> cols 0..299 clamped.
    # Read the size straight off the PNG IHDR header (other tests shrink PIL's global
    # decompression-bomb guard, so Image.open here would be order-dependent).
    png = entries[0]["image"]
    assert png[:8] == b"\x89PNG\r\n\x1a\n"
    width, height = __import__("struct").unpack(">II", png[16:24])
    assert (width, height) == (299, 280)


def test_build_entries_skips_fully_undetected_pairs(page, monkeypatch):
    monkeypatch.setattr(zeus_crops.geom_omr, "_pair_staves", lambda s: [(None, None)])
    assert zeus_crops.build_entries(page) == []


def test_main_writes_the_pickle_in_document_order(tmp_path, page, monkeypatch):
    monkeypatch.setattr(zeus_crops.geom_omr, "_to_gray", lambda p: page)
    out = tmp_path / "zeus" / "crops.pickle"
    rc = zeus_crops.main(["page.png", "-o", str(out)])
    assert rc == 0
    with open(out, "rb") as fh:
        data = pickle.load(fh)
    assert [e["path"] for e in data] == ["crops/p1-s1"]
    assert data[0]["lmx"] == "measure"


def test_main_exits_2_when_no_systems(tmp_path, page, monkeypatch):
    monkeypatch.setattr(zeus_crops.geom_omr, "_to_gray", lambda p: page)
    monkeypatch.setattr(zeus_crops, "build_entries", lambda g: [])
    out = tmp_path / "crops.pickle"
    assert zeus_crops.main(["page.png", "-o", str(out)]) == zeus_crops.EXIT_NO_SYSTEMS
    assert not out.exists()  # a decline never leaves a pickle behind


def test_main_exits_2_on_unreadable_raster(tmp_path, monkeypatch):
    if not zeus_crops.CROPS_AVAILABLE:
        pytest.skip("geom stack unavailable")
    monkeypatch.setattr(zeus_crops.geom_omr, "_to_gray", lambda p: None)
    out = tmp_path / "crops.pickle"
    assert zeus_crops.main(["missing.png", "-o", str(out)]) == zeus_crops.EXIT_NO_SYSTEMS
