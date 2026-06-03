#!/usr/bin/env python3
"""Tests for synth_render's pure label logic (the part that turns rendered geometry into YOLO
labels). These need no verovio/playwright, so they run in CI; the heavy render path is covered by
the dataset build + the visual overlay sanity-check, not unit tests."""
import io

import synth_render as sr


def _rs(width=1000, height=500, noteheads=None, staves=None):
    return sr.RenderedScore(
        png=b"", width=width, height=height,
        noteheads=noteheads or [], staves=staves or [],
    )


def test_yolo_lines_normalizes_center_and_size():
    # one box at top-left (100,200) size 40x30 in a 1000x500 image
    rs = _rs(noteheads=[(100.0, 200.0, 40.0, 30.0)])
    lines = rs.yolo_lines()
    assert len(lines) == 1
    cls, xc, yc, w, h = lines[0].split()
    assert cls == "0"
    assert abs(float(xc) - (120.0 / 1000)) < 1e-6   # (100+40/2)/1000
    assert abs(float(yc) - (215.0 / 500)) < 1e-6    # (200+30/2)/500
    assert abs(float(w) - (40.0 / 1000)) < 1e-6
    assert abs(float(h) - (30.0 / 500)) < 1e-6


def test_yolo_lines_custom_class():
    rs = _rs(noteheads=[(0.0, 0.0, 10.0, 10.0)])
    assert rs.yolo_lines(cls=3)[0].startswith("3 ")


def test_yolo_lines_empty():
    assert _rs(noteheads=[]).yolo_lines() == []


def test_notehead_centers():
    rs = _rs(noteheads=[(10.0, 20.0, 4.0, 6.0), (0.0, 0.0, 2.0, 2.0)])
    assert rs.notehead_centers() == [(12.0, 23.0), (1.0, 1.0)]


def test_staff_line_ys_sorted_centers():
    # staff lines given out of order; method returns ascending y-centers
    staff = [(0.0, 50.0, 100.0, 2.0), (0.0, 10.0, 100.0, 2.0), (0.0, 30.0, 100.0, 2.0)]
    rs = _rs(staves=[staff])
    ys = rs.staff_line_ys()
    assert len(ys) == 1
    assert ys[0] == [11.0, 31.0, 51.0]  # y + h/2, sorted


def test_draw_overlay_returns_png():
    # 8x8 white PNG via PIL, then overlay a box; result must be a valid PNG image.
    from PIL import Image
    buf = io.BytesIO()
    Image.new("RGB", (8, 8), (255, 255, 255)).save(buf, format="PNG")
    out = sr.draw_overlay(buf.getvalue(), [(1.0, 1.0, 3.0, 3.0)], [[2.0]])
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
