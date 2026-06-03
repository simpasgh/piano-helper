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


import synth_render as sr


def test_ds_category_to_class_maps_the_real_taxonomy():
    m = d2y._ds_category_to_class
    # heads: black -> filled; half/whole/double-whole (+ Small + On/InSpace variants) -> open
    assert m("noteheadBlackOnLine") == "notehead_filled"
    assert m("noteheadBlackInSpaceSmall") == "notehead_filled"
    assert m("noteheadHalfOnLine") == "notehead_open"
    assert m("noteheadWholeInSpace") == "notehead_open"
    assert m("noteheadDoubleWholeOnLineSmall") == "notehead_open"
    # shapes + flags
    assert m("stem") == "stem" and m("beam") == "beam"
    assert m("flag8thUp") == "flag" and m("flag16thDownSmall") == "flag" and m("flag128thUp") == "flag"
    # the augmentation dot, but NOT the repeat dot
    assert m("augmentationDot") == "dot" and m("repeatDot") is None
    # accidentals incl. doubles + small variants; key-sig accidentals fold into the same classes
    assert m("accidentalSharp") == "accidental_sharp" and m("accidentalSharpSmall") == "accidental_sharp"
    assert m("accidentalDoubleSharp") == "accidental_double_sharp"
    assert m("accidentalDoubleFlat") == "accidental_double_flat"
    assert m("keySharp") == "accidental_sharp" and m("keyFlat") == "accidental_flat"
    assert m("keyNatural") == "accidental_natural"
    # clefs: G/F/C; the octave-marker + percussion clefs are dropped
    assert m("clefG") == "clef_g" and m("clefF") == "clef_f"
    assert m("clefCAlto") == "clef_c" and m("clefCTenor") == "clef_c"
    assert m("clef8") is None and m("clef15") is None and m("clefUnpitchedPercussion") is None
    # rests (incl. all values) but NOT the multi-measure rest bar / number
    assert m("restQuarter") == "rest" and m("rest8th") == "rest" and m("restDoubleWhole") == "rest"
    assert m("restHBar") is None and m("restHNr") is None
    # time signatures, tie (but not slur), ottava
    assert m("timeSig4") == "timesig" and m("timeSigCommon") == "timesig"
    assert m("tie") == "tie" and m("slur") is None
    assert m("ottavaBracket") == "ottava"
    # out-of-taxonomy categories are dropped
    for other in ("articStaccatoAbove", "dynamicF", "ornamentTrill", "fingering3",
                  "tupletBracket", "staff", "ledgerLine", "brace", "tremolo1"):
        assert m(other) is None


def test_category_class_map_only_deepscores_set_and_valid_indices():
    cats = {
        "25": {"name": "noteheadBlackOnLine", "annotation_set": "deepscores"},
        "33": {"name": "noteheadWholeOnLine", "annotation_set": "deepscores"},
        "2": {"name": "clefG", "annotation_set": "deepscores"},
        "9": {"name": "articStaccatoAbove", "annotation_set": "deepscores"},  # dropped (None)
        "157": {"name": "noteheadBlackOnLine", "annotation_set": "muscima++"},  # excluded set
    }
    cmap = d2y._category_class_map(cats)
    assert cmap == {
        "25": sr.CLASS_INDEX["notehead_filled"],
        "33": sr.CLASS_INDEX["notehead_open"],
        "2": sr.CLASS_INDEX["clef_g"],
    }


def test_taxonomy_is_shared_with_synth_render():
    assert d2y.CLASS_NAMES is sr.CLASS_NAMES  # single source of truth for the class set
