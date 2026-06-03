#!/usr/bin/env python3
"""Tests for synth_render's pure label logic: the multi-class glyph -> YOLO mapping and the
RenderedScore label rows. These need no verovio/playwright, so they run in CI; the heavy render
path is covered by the dataset build + the visual overlay sanity-check, not unit tests."""
import io

import synth_render as sr


def _rs(width=1000, height=500, symbols=None, staves=None):
    return sr.RenderedScore(
        png=b"", width=width, height=height,
        symbols=symbols or [], staves=staves or [],
    )


# --- taxonomy + glyph_to_class -----------------------------------------------------------

def test_class_names_and_index_are_consistent():
    assert sr.CLASS_INDEX["notehead_filled"] == 0
    assert len(sr.CLASS_NAMES) == len(sr.CLASS_INDEX)
    assert all(sr.CLASS_NAMES[i] == n for n, i in sr.CLASS_INDEX.items())


def test_glyph_to_class_noteheads_by_smufl_code():
    assert sr.glyph_to_class("notehead", "E0A4") == sr.CLASS_INDEX["notehead_filled"]  # black
    assert sr.glyph_to_class("notehead", "E0A3") == sr.CLASS_INDEX["notehead_open"]    # half
    assert sr.glyph_to_class("notehead", "E0A2") == sr.CLASS_INDEX["notehead_open"]    # whole
    assert sr.glyph_to_class("notehead", "e0a4") == sr.CLASS_INDEX["notehead_filled"]  # case


def test_glyph_to_class_accidentals_and_keysig_share_classes():
    assert sr.glyph_to_class("accid", "E262") == sr.CLASS_INDEX["accidental_sharp"]
    assert sr.glyph_to_class("accid", "E260") == sr.CLASS_INDEX["accidental_flat"]
    assert sr.glyph_to_class("accid", "E261") == sr.CLASS_INDEX["accidental_natural"]
    assert sr.glyph_to_class("accid", "E263") == sr.CLASS_INDEX["accidental_double_sharp"]
    # a key-signature accidental uses the IDENTICAL glyph -> same class (decode splits by position)
    assert sr.glyph_to_class("keyAccid", "E260") == sr.CLASS_INDEX["accidental_flat"]
    assert sr.glyph_to_class("keyAccid", "E262") == sr.CLASS_INDEX["accidental_sharp"]


def test_glyph_to_class_clefs_including_mid_score_change_codepoints():
    assert sr.glyph_to_class("clef", "E050") == sr.CLASS_INDEX["clef_g"]   # gClef
    assert sr.glyph_to_class("clef", "E07A") == sr.CLASS_INDEX["clef_g"]   # gClefChange
    assert sr.glyph_to_class("clef", "E062") == sr.CLASS_INDEX["clef_f"]   # fClef
    assert sr.glyph_to_class("clef", "E07C") == sr.CLASS_INDEX["clef_f"]   # fClefChange
    assert sr.glyph_to_class("clef", "E05C") == sr.CLASS_INDEX["clef_c"]   # cClef
    assert sr.glyph_to_class("clef", "E07B") == sr.CLASS_INDEX["clef_c"]   # cClefChange


def test_glyph_to_class_shape_and_code_independent_groups():
    # shape groups (no glyph code): class from the CSS class
    assert sr.glyph_to_class("stem", None) == sr.CLASS_INDEX["stem"]
    assert sr.glyph_to_class("beam", None) == sr.CLASS_INDEX["beam"]
    assert sr.glyph_to_class("dots", None) == sr.CLASS_INDEX["dot"]
    assert sr.glyph_to_class("tie", None) == sr.CLASS_INDEX["tie"]
    assert sr.glyph_to_class("octave", None) == sr.CLASS_INDEX["ottava"]
    # code-independent glyph groups: one class regardless of the specific code
    assert sr.glyph_to_class("flag", "E242") == sr.CLASS_INDEX["flag"]
    assert sr.glyph_to_class("rest", "E4E5") == sr.CLASS_INDEX["rest"]
    assert sr.glyph_to_class("meterSig", None) == sr.CLASS_INDEX["timesig"]


def test_glyph_to_class_unknown_or_empty_is_none():
    assert sr.glyph_to_class("accid", None) is None          # empty placeholder <g class=accid/>
    assert sr.glyph_to_class("notehead", "FFFF") is None      # unknown notehead code
    assert sr.glyph_to_class("ledgerLines", None) is None     # not a labeled class
    assert sr.glyph_to_class("", None) is None
    assert sr.glyph_to_class(None, None) is None


# --- RenderedScore label rows ------------------------------------------------------------

def test_yolo_lines_normalizes_center_and_size_with_class():
    # one notehead_filled (class 0) box at top-left (100,200) size 40x30 in a 1000x500 image
    rs = _rs(symbols=[(0, 100.0, 200.0, 40.0, 30.0)])
    lines = rs.yolo_lines()
    assert len(lines) == 1
    cls, xc, yc, w, h = lines[0].split()
    assert cls == "0"
    assert abs(float(xc) - (120.0 / 1000)) < 1e-6   # (100+40/2)/1000
    assert abs(float(yc) - (215.0 / 500)) < 1e-6    # (200+30/2)/500
    assert abs(float(w) - (40.0 / 1000)) < 1e-6
    assert abs(float(h) - (30.0 / 500)) < 1e-6


def test_yolo_lines_emits_each_class_index():
    rs = _rs(symbols=[(0, 0.0, 0.0, 10.0, 10.0), (6, 5.0, 5.0, 4.0, 8.0), (12, 1.0, 1.0, 9.0, 20.0)])
    assert [l.split()[0] for l in rs.yolo_lines()] == ["0", "6", "12"]


def test_yolo_lines_empty():
    assert _rs(symbols=[]).yolo_lines() == []


def test_boxes_for_and_noteheads_and_counts():
    rs = _rs(symbols=[(0, 10.0, 20.0, 4.0, 6.0),     # filled head
                      (1, 30.0, 40.0, 4.0, 6.0),     # open head
                      (2, 31.0, 41.0, 1.0, 20.0)])   # stem
    assert rs.boxes_for(2) == [(31.0, 41.0, 1.0, 20.0)]
    assert sorted(rs.noteheads()) == [(10.0, 20.0, 4.0, 6.0), (30.0, 40.0, 4.0, 6.0)]
    assert rs.notehead_centers() == [(12.0, 23.0), (32.0, 43.0)]
    assert rs.class_counts() == {"notehead_filled": 1, "notehead_open": 1, "stem": 1}


def test_staff_line_ys_sorted_centers():
    staff = [(0.0, 50.0, 100.0, 2.0), (0.0, 10.0, 100.0, 2.0), (0.0, 30.0, 100.0, 2.0)]
    rs = _rs(staves=[staff])
    ys = rs.staff_line_ys()
    assert len(ys) == 1
    assert ys[0] == [11.0, 31.0, 51.0]  # y + h/2, sorted


def test_draw_overlay_returns_png():
    from PIL import Image
    buf = io.BytesIO()
    Image.new("RGB", (40, 40), (255, 255, 255)).save(buf, format="PNG")
    out = sr.draw_overlay(buf.getvalue(), [(0, 1.0, 1.0, 3.0, 3.0), (6, 10.0, 10.0, 4.0, 8.0)], [[2.0]])
    assert out[:8] == b"\x89PNG\r\n\x1a\n"
    Image.open(io.BytesIO(out)).verify()  # raises if not a valid image


def test_size_outer_svg_replaces_dimensions():
    svg = '<svg width="840px" height="184px" version="1.1" id="x"><defs/></svg>'
    out = sr._size_outer_svg(svg, 2800, 613)
    assert 'width="2800px"' in out and 'height="613px"' in out
    assert '840px' not in out and '184px' not in out


def test_viewbox_wh_reads_definition_scale():
    svg = '<svg width="1px" height="1px"><svg class="definition-scale" viewBox="0 0 21000 4600">'
    assert sr._viewbox_wh(svg) == (21000.0, 4600.0)
