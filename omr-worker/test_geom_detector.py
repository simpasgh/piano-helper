#!/usr/bin/env python3
"""Tests for geom_detector's pure helpers (no torch/ultralytics needed, so they run in CI where
the detector stack is absent): the image-size-aware imgsz policy and the head->staff assignment.

The YOLO inference itself (NoteheadDetector.detect / transcribe_with_detector) needs the torch
venv + weights and is exercised by the real-score eval on the box, not in CI."""
import geom_detector


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
