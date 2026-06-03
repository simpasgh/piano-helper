#!/usr/bin/env python3
"""Tests for the pure conversion logic in deepscores_to_yolo (bbox math + category filtering).
The heavy file IO / image copy path is exercised by the actual dataset build, not unit tests."""
import deepscores_to_yolo as d2y


def test_to_yolo_normalizes():
    # bbox [100,200,140,260] in a 1000x500 image
    box = d2y._to_yolo([100, 200, 140, 260], 1000, 500)
    assert box is not None
    xc, yc, w, h = box
    assert abs(xc - 0.12) < 1e-6     # (100+140)/2 / 1000
    assert abs(yc - 0.46) < 1e-6     # (200+260)/2 / 500
    assert abs(w - 0.04) < 1e-6
    assert abs(h - 0.12) < 1e-6


def test_to_yolo_swapped_corners():
    # x2<x1 and y2<y1 should be normalized, not produce negative sizes
    box = d2y._to_yolo([140, 260, 100, 200], 1000, 500)
    assert box is not None and box[2] > 0 and box[3] > 0


def test_to_yolo_rejects_degenerate():
    assert d2y._to_yolo([100, 200, 100, 260], 1000, 500) is None  # zero width
    assert d2y._to_yolo([], 1000, 500) is None
    assert d2y._to_yolo([0, 0, 10, 10], 0, 500) is None           # zero image width


def test_cat_of_list_takes_deepscores_set():
    # cat_id is [deepscores_id, muscima_id]; we use the deepscores (first) id
    assert d2y._cat_of({"cat_id": ["25", "157"]}) == "25"
    assert d2y._cat_of({"cat_id": "25"}) == "25"  # tolerate scalar


def test_notehead_cat_ids_only_deepscores_set():
    cats = {
        "25": {"name": "noteheadBlackOnLine", "annotation_set": "deepscores"},
        "33": {"name": "noteheadWholeOnLine", "annotation_set": "deepscores"},
        "2": {"name": "clefG", "annotation_set": "deepscores"},
        "157": {"name": "noteheadFullSmall", "annotation_set": "muscima++"},  # excluded
    }
    ids = d2y._notehead_cat_ids(cats)
    assert ids == {"25", "33"}
