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


@requires_geom
class TestAdaptiveIllumination:
    """transcribe_with_detector flat-fields the warped-photo decode ADAPTIVELY: it keeps the
    flat-field only when the dewarped page has a genuine deep broad shadow (reverie), and drops it
    otherwise (liminality / tctab, which the flat-field over-corrects). The decision is scoped to the
    KEPT-dewarp path, so the clean upload path stays byte-identical (always flat-fields)."""

    @staticmethod
    def _capture_decode(monkeypatch):
        # capture the normalize_illum the decode tail is called with, the observable decision.
        captured = {}

        def fake_decode(staves, per_staff, key_fifths=0, gray=None, normalize_illum=True, photo=False):
            captured["normalize_illum"] = normalize_illum
            return b"<score-partwise/>"

        monkeypatch.setattr(geom_detector, "DETECTOR_AVAILABLE", True)
        monkeypatch.setattr(geom_omr, "_decode_staves_to_musicxml", fake_decode)
        return captured

    def _run_warped(self, monkeypatch):
        warped = _page(slope=0.05)
        staves = geom_omr.detect_systems(geom_omr.dewarp_staff_lines(warped))
        centers = [(warped.shape[1] / 2.0, sorted(s)[2], 0.9) for s in staves]
        return geom_detector.transcribe_with_detector(warped, _FixedDetector(centers))

    def test_deep_shadow_keeps_the_flatfield(self, monkeypatch):
        captured = self._capture_decode(monkeypatch)
        monkeypatch.setattr(geom_omr, "_illum_has_deep_shadow", lambda g, *a, **k: True)
        assert self._run_warped(monkeypatch) == b"<score-partwise/>"
        assert captured["normalize_illum"] is True

    def test_no_deep_shadow_drops_the_flatfield(self, monkeypatch):
        captured = self._capture_decode(monkeypatch)
        monkeypatch.setattr(geom_omr, "_illum_has_deep_shadow", lambda g, *a, **k: False)
        assert self._run_warped(monkeypatch) == b"<score-partwise/>"
        assert captured["normalize_illum"] is False

    def test_clean_page_never_flips(self, monkeypatch):
        # a clean (already-horizontal) page never dewarps, so the decision is bypassed entirely and
        # the flat-field stays ON even though _illum_has_deep_shadow would vote to drop it.
        captured = self._capture_decode(monkeypatch)
        monkeypatch.setattr(geom_omr, "_illum_has_deep_shadow", lambda g, *a, **k: False)
        clean = _page(slope=0.0)
        staves = geom_omr.detect_systems(clean)
        centers = [(clean.shape[1] / 2.0, sorted(s)[2], 0.9) for s in staves]
        assert geom_detector.transcribe_with_detector(clean, _FixedDetector(centers)) == b"<score-partwise/>"
        assert captured["normalize_illum"] is True

    def test_dropping_flatfield_loses_staves_reverts_never_worse(self, monkeypatch):
        # never-worse guard: if dropping the flat-field detects FEWER staves than the flat-fielded
        # detection that justified the dewarp, keep the flat-field rather than ship worse geometry.
        # illum-off here returns a single staff -- NON-EMPTY but fewer than the dewarped count -- so
        # the guard must still revert, proving it is count-based, not merely emptiness-based.
        captured = self._capture_decode(monkeypatch)
        monkeypatch.setattr(geom_omr, "_illum_has_deep_shadow", lambda g, *a, **k: False)
        real_ds = geom_omr.detect_systems
        one_staff = [[10.0, 20.0, 30.0, 40.0, 50.0]]
        monkeypatch.setattr(geom_omr, "detect_systems",
                            lambda g, normalize_illum=True: (one_staff if not normalize_illum
                                                             else real_ds(g, normalize_illum=True)))
        assert self._run_warped(monkeypatch) == b"<score-partwise/>"
        assert captured["normalize_illum"] is True  # reverted: illum-off lost staves vs flat-fielded


@requires_geom
class TestClarityPdfDump:
    """The photo-to-PDF shim side output (OMR_PHOTO_CLARITY): transcribe_with_detector with
    dump_clarity_pdf set ALSO writes the raster the decode used (dewarped when the dewarp was
    kept), flat-fielded, as a one-page PDF for the PDF-only Clarity engine. The dump is
    best-effort: it can never perturb or abort the decode."""

    def test_clean_page_dump_writes_a_pdf(self, tmp_path, monkeypatch):
        monkeypatch.setattr(geom_detector, "DETECTOR_AVAILABLE", True)
        out = tmp_path / "clarity-input.pdf"
        det = _StubDetector()
        geom_detector.transcribe_with_detector(_page(), det, dump_clarity_pdf=str(out))
        assert det.calls, "the decode ran (staves found, detect() reached)"
        assert out.read_bytes().startswith(b"%PDF")

    def test_warped_page_dumps_the_dewarped_raster(self, tmp_path, monkeypatch):
        monkeypatch.setattr(geom_detector, "DETECTOR_AVAILABLE", True)
        out = tmp_path / "clarity-input.pdf"
        geom_detector.transcribe_with_detector(
            _page(slope=0.05), _StubDetector(), dump_clarity_pdf=str(out))
        assert out.read_bytes().startswith(b"%PDF")

    def test_no_dump_arg_writes_nothing(self, tmp_path, monkeypatch):
        # The default (None) leaves the workdir untouched: no side file, behavior unchanged.
        monkeypatch.setattr(geom_detector, "DETECTOR_AVAILABLE", True)
        geom_detector.transcribe_with_detector(_page(), _StubDetector())
        assert list(tmp_path.iterdir()) == []

    def test_dump_failure_never_breaks_the_decode(self, tmp_path, monkeypatch):
        # An unwritable target (a DIRECTORY path) makes the dump fail silently; the decode
        # still runs to detect() exactly as without the dump.
        monkeypatch.setattr(geom_detector, "DETECTOR_AVAILABLE", True)
        det = _StubDetector()
        geom_detector.transcribe_with_detector(_page(), det, dump_clarity_pdf=str(tmp_path))
        assert det.calls

    def test_write_clarity_pdf_bad_input_returns_false(self, tmp_path):
        assert geom_detector._write_clarity_pdf(None, str(tmp_path / "x.pdf")) is False


def _staff_page(nstaves, h=1200, w=900, il=12):
    """A clean (horizontal) page with exactly `nstaves` separated 5-line staves, so two pages with
    different counts give the UVDoc guard a deterministic strictly-more / equal / fewer signal."""
    import numpy as np
    g = np.ones((h, w), np.float32)
    anchors = np.linspace(120, h - 120, nstaves) if nstaves > 1 else [120.0]
    for x in range(120, w - 120):
        for t in anchors:
            for k in range(5):
                y = int(round(t + k * il))
                if 1 <= y < h - 1:
                    g[y - 1:y + 1, x] = 0.0
    return g


class _RecordingFixedDetector:
    """Records every image handed to detect() AND returns preset centres, so both the gate's
    chosen raster and the decode tail are observable without real YOLO."""

    def __init__(self, centers):
        self.centers = centers
        self.calls = []

    def detect(self, image, imgsz=None):
        self.calls.append(image)
        return list(self.centers)


@requires_geom
class TestUvdocGuard:
    """The GUARDED UVDoc candidate (OMR_UVDOC / --try-uvdoc): transcribe_with_detector ALSO runs
    the full staff decision on a UVDoc-rectified raster and adopts it ONLY when its used-staff
    count strictly exceeds the original branch's. Pure control flow under test (_uvdoc_rectify is
    stubbed, no torch); the real model is exercised by the local GPU gate, not CI."""

    @staticmethod
    def _capture_decode(monkeypatch):
        captured = {}

        def fake_decode(staves, per_staff, key_fifths=0, gray=None, normalize_illum=True, photo=False):
            captured["staves"] = staves
            captured["gray"] = gray
            captured["photo"] = photo
            return b"<score-partwise/>"

        monkeypatch.setattr(geom_detector, "DETECTOR_AVAILABLE", True)
        monkeypatch.setattr(geom_omr, "_decode_staves_to_musicxml", fake_decode)
        return captured

    def test_try_uvdoc_false_never_calls_rectify(self, monkeypatch):
        # The byte-identity lock: the default (and every PDF upload) must never touch UVDoc.
        monkeypatch.setattr(geom_detector, "DETECTOR_AVAILABLE", True)

        def must_not_run(gray):
            raise AssertionError("try_uvdoc=False must never call _uvdoc_rectify")

        monkeypatch.setattr(geom_detector, "_uvdoc_rectify", must_not_run)
        det = _StubDetector()
        geom_detector.transcribe_with_detector(_page(), det)
        assert det.calls  # the normal decode path still ran to detect()

    def test_adopts_rectified_when_strictly_more_staves(self, monkeypatch):
        import numpy as np
        captured = self._capture_decode(monkeypatch)
        orig, rect = _staff_page(2), _staff_page(6)
        # fixture precondition: the rectified page really yields strictly more staves
        assert len(geom_omr.detect_systems(rect)) > len(geom_omr.detect_systems(orig))
        monkeypatch.setattr(geom_detector, "_uvdoc_rectify", lambda g: rect)
        det = _RecordingFixedDetector([(450.0, 132.0, 0.9)])
        out = geom_detector.transcribe_with_detector(orig, det, try_uvdoc=True)
        assert out == b"<score-partwise/>"
        assert captured["gray"] is rect  # the decode ran on the RECTIFIED raster
        # the detector saw the rectified raster via the in-memory RGB handoff, not the original
        src = det.calls[0]
        assert isinstance(src, np.ndarray) and src.ndim == 3 and src.dtype == np.uint8
        assert len(captured["staves"]) == len(geom_omr.detect_systems(rect))

    def test_rejects_rectified_on_equal_staves(self, monkeypatch):
        captured = self._capture_decode(monkeypatch)
        orig, rect = _staff_page(3), _staff_page(3)
        monkeypatch.setattr(geom_detector, "_uvdoc_rectify", lambda g: rect)
        det = _RecordingFixedDetector([(450.0, 132.0, 0.9)])
        assert geom_detector.transcribe_with_detector(orig, det, try_uvdoc=True) == b"<score-partwise/>"
        assert det.calls[0] is orig  # equal count -> STRICT guard rejects, original raster kept
        assert captured["gray"] is not rect

    def test_rejects_rectified_on_fewer_staves(self, monkeypatch):
        captured = self._capture_decode(monkeypatch)
        orig, rect = _staff_page(4), _staff_page(2)
        monkeypatch.setattr(geom_detector, "_uvdoc_rectify", lambda g: rect)
        det = _RecordingFixedDetector([(450.0, 132.0, 0.9)])
        assert geom_detector.transcribe_with_detector(orig, det, try_uvdoc=True) == b"<score-partwise/>"
        assert det.calls[0] is orig
        assert captured["gray"] is not rect

    def test_rectify_failure_is_a_noop(self, monkeypatch):
        # _uvdoc_rectify returning None (unset env / model failure) keeps the original path.
        captured = self._capture_decode(monkeypatch)
        orig = _staff_page(3)
        monkeypatch.setattr(geom_detector, "_uvdoc_rectify", lambda g: None)
        det = _RecordingFixedDetector([(450.0, 132.0, 0.9)])
        assert geom_detector.transcribe_with_detector(orig, det, try_uvdoc=True) == b"<score-partwise/>"
        assert det.calls[0] is orig
        assert len(captured["staves"]) == len(geom_omr.detect_systems(orig))

    def test_adopted_branch_dumps_the_rectified_raster(self, monkeypatch, tmp_path):
        # The shim contract: dump_clarity_pdf must capture whichever raster the decode used,
        # which on an adopted UVDoc branch is the RECTIFIED one.
        self._capture_decode(monkeypatch)
        orig, rect = _staff_page(2), _staff_page(6)
        monkeypatch.setattr(geom_detector, "_uvdoc_rectify", lambda g: rect)
        dumped = {}

        def fake_dump(gray, path):
            dumped["gray"] = gray
            dumped["path"] = path
            return True

        monkeypatch.setattr(geom_detector, "_write_clarity_pdf", fake_dump)
        geom_detector.transcribe_with_detector(
            orig, _RecordingFixedDetector([(450.0, 132.0, 0.9)]),
            dump_clarity_pdf=str(tmp_path / "clarity-input.pdf"), try_uvdoc=True)
        assert dumped["gray"] is rect

    def test_uvdoc_rectify_env_unset_returns_none(self, monkeypatch):
        monkeypatch.delenv("UVDOC_DIR", raising=False)
        monkeypatch.delenv("UVDOC_MODEL", raising=False)
        assert geom_detector._uvdoc_rectify(_page()) is None

    def test_uvdoc_rectify_missing_paths_return_none(self, monkeypatch, tmp_path):
        monkeypatch.setenv("UVDOC_DIR", str(tmp_path / "no-such-clone"))
        monkeypatch.setenv("UVDOC_MODEL", str(tmp_path / "no-such-model.pkl"))
        assert geom_detector._uvdoc_rectify(_page()) is None

    def test_cli_try_uvdoc_threads_to_transcribe(self, monkeypatch, tmp_path):
        monkeypatch.setattr(geom_detector, "DETECTOR_AVAILABLE", True)
        seen = {}

        def fake_transcribe(image, detector, key_fifths=0, dump_clarity_pdf=None, try_uvdoc=False):
            seen["try_uvdoc"] = try_uvdoc
            return b"<score-partwise/>"

        monkeypatch.setattr(geom_detector, "transcribe_with_detector", fake_transcribe)
        out = tmp_path / "o.xml"
        rc = geom_detector.main(["img.png", "--weights", "w.pt", "-o", str(out), "--try-uvdoc"])
        assert rc == 0 and seen["try_uvdoc"] is True
        rc = geom_detector.main(["img.png", "--weights", "w.pt", "-o", str(out)])
        assert rc == 0 and seen["try_uvdoc"] is False
