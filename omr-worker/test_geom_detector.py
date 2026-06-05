#!/usr/bin/env python3
"""Tests for geom_detector's pure helpers (no torch/ultralytics needed, so they run in CI where
the detector stack is absent): the image-size-aware imgsz policy and the head->staff assignment.

The YOLO inference itself (NoteheadDetector.detect / transcribe_with_detector) needs the torch
venv + weights and is exercised by the real-score eval on the box, not in CI. The DEWARP GATE in
transcribe_with_detector is tested here with a STUB detector (no torch), since it is the
never-worse-on-clean mechanism and is pure control flow given the detector output."""
import pytest

import geom_detector
import geom_omr

requires_geom = pytest.mark.skipif(
    not geom_omr.GEOM_AVAILABLE,
    reason="numpy/scipy/PIL not available (GEOM_AVAILABLE False)",
)


class TestAutoImgsz:
    def test_single_page_is_base(self):
        # a ~A4 page rastered at 350 DPI is ~2893x4094; its long side <= ref -> the 1280 base.
        assert geom_detector._auto_imgsz((4094, 2893)) == 1280

    def test_just_under_ref_is_base(self):
        assert geom_detector._auto_imgsz((4096, 2893)) == 1280

    def test_two_page_scales_up(self):
        # a 2-page stitch (~8188 tall) scales imgsz up so noteheads keep their single-page size.
        # 1280 * 8188/4096 = 2559 -> rounded to a multiple of 32 -> 2560.
        assert geom_detector._auto_imgsz((8188, 2893)) == 2560

    def test_interior_value_exercises_the_proportional_formula(self):
        # an intermediate height (below the cap) must return a PROPORTIONAL imgsz, not the cap, so a
        # cap-only stub would fail: 1280 * 6144/4096 = 1920 exactly (a multiple of 32, < cap 2560).
        assert geom_detector._auto_imgsz((6144, 2893)) == 1920

    def test_caps_at_max(self):
        # an absurdly tall image is clamped so CPU cost stays bounded.
        assert geom_detector._auto_imgsz((100000, 2893)) == 2560

    def test_long_side_is_width_too(self):
        # the policy keys on the LONGEST side, not specifically the height.
        assert geom_detector._auto_imgsz((2893, 8188)) == 2560

    def test_bad_input_returns_base(self):
        assert geom_detector._auto_imgsz(None) == 1280
        assert geom_detector._auto_imgsz(()) == 1280


class TestAssignToStaves:
    def test_assigns_each_head_to_nearest_staff(self):
        # two staves; a head inside each band goes to that staff.
        staves = [[100.0, 110.0, 120.0, 130.0, 140.0], [300.0, 310.0, 320.0, 330.0, 340.0]]
        centers = [(50.0, 120.0, 0.9), (60.0, 320.0, 0.9)]
        per_staff = geom_detector._assign_to_staves(centers, staves)
        assert [len(p) for p in per_staff] == [1, 1]
        assert per_staff[0][0] == (50.0, 120.0)
        assert per_staff[1][0] == (60.0, 320.0)

    def test_drops_stray_far_from_every_staff(self):
        # interline = 10, max_interlines default 7 -> a head 1000 px from the only staff is dropped.
        staves = [[100.0, 110.0, 120.0, 130.0, 140.0]]
        centers = [(50.0, 1200.0, 0.9)]
        per_staff = geom_detector._assign_to_staves(centers, staves)
        assert per_staff == [[]]

    def test_empty_inputs(self):
        assert geom_detector._assign_to_staves([], []) == []
        assert geom_detector._assign_to_staves([(1.0, 2.0, 0.5)], []) == []


def _page(slope=0.0, h=1200, w=900, il=12):
    """A multi-staff page (separated 5-line staves, side margins) with an optional linear tilt
    (slope = px drift per px from centre). slope 0 -> a clean, already-horizontal page."""
    import numpy as np
    g = np.ones((h, w), np.float32)
    xc = w / 2.0
    for x in range(120, w - 120):
        dy = slope * (x - xc)
        for t in np.linspace(120, h - 120, 6):
            for k in range(5):
                y = int(round(t + k * il + dy))
                if 1 <= y < h - 1:
                    g[y - 1:y + 1, x] = 0.0
    return g


class _StubDetector:
    """Records the image it was asked to detect on (to assert which one the gate chose) and returns
    no centers, so transcribe_with_detector stops right after the detect() call. The dewarp gate runs
    before that, so the recorded image reveals the gate's decision without needing real YOLO."""

    def __init__(self):
        self.calls = []

    def detect(self, image, imgsz=None):
        self.calls.append(image)
        return []


@requires_geom
class TestDewarpGate:
    """The never-worse-on-clean gate: transcribe_with_detector keeps the dewarp ONLY when it
    increases the detected staff count (a warped photo), and otherwise feeds the ORIGINAL raster to
    the detector (a clean page), so clean stays byte-identical."""

    def test_clean_page_feeds_raw_image_to_detector(self, monkeypatch):
        monkeypatch.setattr(geom_detector, "DETECTOR_AVAILABLE", True)
        clean = _page(slope=0.0)  # already horizontal -> dewarp cannot add staves -> rejected
        det = _StubDetector()
        geom_detector.transcribe_with_detector(clean, det)
        assert det.calls, "staves should be detected on the clean page, so detect() is called"
        assert det.calls[0] is clean  # the ORIGINAL array (no dewarp) -> byte-identical clean path

    def test_warped_page_feeds_dewarped_image_to_detector(self, monkeypatch):
        import numpy as np
        monkeypatch.setattr(geom_detector, "DETECTOR_AVAILABLE", True)
        warped = _page(slope=0.05)  # tilted -> raw detection collapses, dewarp recovers more staves
        det = _StubDetector()
        geom_detector.transcribe_with_detector(warped, det)
        assert det.calls
        src = det.calls[0]
        assert src is not warped  # the dewarp WAS applied
        # the dewarped raster is handed to the detector as an HxWx3 uint8 image (via _gray_to_uint8_rgb)
        assert isinstance(src, np.ndarray) and src.ndim == 3 and src.dtype == np.uint8

    def test_detector_unavailable_returns_none(self, monkeypatch):
        monkeypatch.setattr(geom_detector, "DETECTOR_AVAILABLE", False)
        assert geom_detector.transcribe_with_detector(_page(), _StubDetector()) is None


class _FixedDetector:
    """Returns a preset list of (x, y, conf) centres regardless of the image, so the full
    assign -> decode tail of transcribe_with_detector runs under test without real YOLO."""

    def __init__(self, centers):
        self.centers = centers

    def detect(self, image, imgsz=None):
        return list(self.centers)


@requires_geom
def test_transcribe_kept_dewarp_runs_decode_tail(monkeypatch):
    # End-to-end through the KEPT-dewarp path: the detector's centres are placed on the DEWARPED
    # staves (the same space transcribe_with_detector computes internally), so assign + decode must
    # produce valid MusicXML. If the wiring fed the centres against the wrong (raw) staff space, the
    # heads would be dropped by _assign_to_staves and the decode would yield None -> this would fail.
    monkeypatch.setattr(geom_detector, "DETECTOR_AVAILABLE", True)
    warped = _page(slope=0.05)
    gray_dw = geom_omr.dewarp_staff_lines(warped)
    staves = geom_omr.detect_systems(gray_dw)
    assert len(staves) > len(geom_omr.detect_systems(warped))  # the gate will keep this dewarp
    centers = [(warped.shape[1] / 2.0, sorted(s)[2], 0.9) for s in staves]  # one head per staff
    out = geom_detector.transcribe_with_detector(warped, _FixedDetector(centers))
    assert out is not None and b"score-partwise" in out
