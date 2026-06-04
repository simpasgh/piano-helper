#!/usr/bin/env python3
"""Tests for ottava (8va / 8vb) bracket handling in the geometric OMR engine.

Three tiers, mirroring test_geom_omr.py:
  - PURE shift tests (ottava_delta_at + the decode-shift in BOTH the notehead-only and the
    full-symbol paths): build synthetic staves + noteheads / glyph boxes by hand with gray=None,
    and assert a notehead inside an 8va span decodes one octave HIGHER, an 8vb one LOWER, and a
    note outside any span is UNCHANGED (the never-worse guarantee). These run everywhere (no numpy).
  - A numpy raster test for detect_ottavas: a thin DASHED horizontal rule above a staff is detected
    as a span; a THICK solid beam is NOT; a sloped/curved line is NOT.
  - Robustness: every public ottava function returns a safe default on garbage instead of raising.

The reverie real-raster before/after evidence lives in the handoff (C:\\tmp\\ottava_e2e.py); these
tests lock the geometry/shift logic independent of any image or trained model.
"""

import pytest

import geom_omr


# --- PURE: ottava_delta_at ----------------------------------------------------------------

class TestOttavaDeltaAt:
    def test_no_spans_is_zero(self):
        assert geom_omr.ottava_delta_at(100.0, []) == 0
        assert geom_omr.ottava_delta_at(100.0, None) == 0

    def test_inside_8va_span_is_plus_one(self):
        assert geom_omr.ottava_delta_at(150.0, [(100.0, 200.0, 1)]) == 1

    def test_inside_8vb_span_is_minus_one(self):
        assert geom_omr.ottava_delta_at(150.0, [(100.0, 200.0, -1)]) == -1

    def test_outside_span_is_zero(self):
        assert geom_omr.ottava_delta_at(250.0, [(100.0, 200.0, 1)]) == 0
        assert geom_omr.ottava_delta_at(50.0, [(100.0, 200.0, 1)]) == 0

    def test_on_the_boundary_is_inside(self):
        # the span is inclusive on both ends.
        assert geom_omr.ottava_delta_at(100.0, [(100.0, 200.0, 1)]) == 1
        assert geom_omr.ottava_delta_at(200.0, [(100.0, 200.0, 1)]) == 1

    def test_reversed_span_endpoints_are_normalized(self):
        # x0 > x1 still defines the same interval.
        assert geom_omr.ottava_delta_at(150.0, [(200.0, 100.0, 1)]) == 1

    def test_stacked_spans_sum(self):
        # the rare overlapping case sums (a 15ma-as-two-8va would be +2).
        assert geom_omr.ottava_delta_at(150.0, [(100.0, 200.0, 1), (120.0, 180.0, 1)]) == 2

    def test_garbage_span_skipped_not_raised(self):
        assert geom_omr.ottava_delta_at(150.0, [("x", None, 1), (100.0, 200.0, 1)]) == 1

    def test_garbage_rep_x_is_zero(self):
        assert geom_omr.ottava_delta_at("nope", [(100.0, 200.0, 1)]) == 0


# --- PURE: the shift in the NOTEHEAD-ONLY decode tail (_decode_staves_to_musicxml) --------
# gray=None means detect_ottavas is never called inside the tail, so we patch the spans in by
# monkeypatching detect_ottavas (the tail calls it only when gray is not None; with gray=None it
# uses [[]], i.e. NO shift -> the never-worse path). To exercise the shift we pass a non-None gray
# sentinel and stub detect_ottavas to return our hand-built spans. The sentinel never has to be a
# real image because detect_barlines/detect_ottavas are both stubbed/guarded for it.

def _octaves(xml_bytes):
    import xml.etree.ElementTree as ET
    return [int(o.text) for o in ET.fromstring(xml_bytes).iter("octave")]


class TestNoteheadPathShift:
    TREBLE = [10.0, 20.0, 30.0, 40.0, 50.0]   # bottom line y=50 == E4

    def test_note_inside_8va_decodes_one_octave_higher(self, monkeypatch):
        # treble head on line 2 (y=40 -> written G4); an 8va span covering its x -> sounding G5.
        monkeypatch.setattr(geom_omr, "detect_ottavas",
                            lambda gray, staves: [[(100.0, 200.0, 1)]])
        monkeypatch.setattr(geom_omr, "detect_barlines",
                            lambda gray, staves: [[] for _ in staves])
        out = geom_omr._decode_staves_to_musicxml(
            [self.TREBLE], [[(150.0, 40.0)]], gray=object())
        assert out is not None
        assert 5 in _octaves(out) and 4 not in _octaves(out)  # G5, not G4

    def test_note_inside_8vb_decodes_one_octave_lower(self, monkeypatch):
        monkeypatch.setattr(geom_omr, "detect_ottavas",
                            lambda gray, staves: [[(100.0, 200.0, -1)]])
        monkeypatch.setattr(geom_omr, "detect_barlines",
                            lambda gray, staves: [[] for _ in staves])
        out = geom_omr._decode_staves_to_musicxml(
            [self.TREBLE], [[(150.0, 40.0)]], gray=object())  # written G4 -> sounding G3
        assert out is not None
        assert 3 in _octaves(out) and 4 not in _octaves(out)

    def test_note_outside_span_is_unchanged(self, monkeypatch):
        # the head's x (150) is OUTSIDE the span (300..400): written octave kept (never-worse).
        monkeypatch.setattr(geom_omr, "detect_ottavas",
                            lambda gray, staves: [[(300.0, 400.0, 1)]])
        monkeypatch.setattr(geom_omr, "detect_barlines",
                            lambda gray, staves: [[] for _ in staves])
        out = geom_omr._decode_staves_to_musicxml(
            [self.TREBLE], [[(150.0, 40.0)]], gray=object())
        assert out is not None
        assert 4 in _octaves(out) and 5 not in _octaves(out)  # still G4

    def test_gray_none_applies_no_shift(self):
        # the DEPLOYED never-worse guarantee: with gray=None the tail builds NO ottava spans, so the
        # output is byte-identical to a run where detect_ottavas would have returned nothing.
        out = geom_omr._decode_staves_to_musicxml([self.TREBLE], [[(150.0, 40.0)]], gray=None)
        assert out is not None
        assert 4 in _octaves(out)  # written G4, no shift


# --- PURE: the shift in the FULL-SYMBOL decode (_decode_staff via ottava boxes) -----------

def _C(name):
    return geom_omr.CLASS_NAMES.index(name)


def _box(name, cx, cy, w=16.0, h=16.0, conf=0.9):
    return (_C(name), cx - w / 2.0, cy - h / 2.0, w, h, conf)


class TestFullSymbolPathShift:
    # Treble staff lines 100..180 (interline 20), bottom line 180 == E4.
    TREBLE = [100.0, 120.0, 140.0, 160.0, 180.0]

    def test_note_under_ottava_box_above_shifts_up(self):
        # a filled head on line 2 (y=160 -> written G4) with a stem (quarter), under an ottava box
        # placed ABOVE the staff top and covering the head x -> sounding G5.
        syms = [
            _box("notehead_filled", 150, 160),
            _box("stem", 150, 140, w=4, h=44),
            _box("ottava", 150, 70, w=200, h=10),  # centered well above top line (100)
        ]
        out = geom_omr.decode_symbols_to_musicxml([self.TREBLE], syms, key_fifths=0)
        assert out is not None
        assert 5 in _octaves(out) and 4 not in _octaves(out)

    def test_note_under_ottava_box_below_shifts_down(self):
        # an ottava box centered BELOW the staff bottom (180) -> 8vb -> written G4 sounds G3.
        syms = [
            _box("notehead_filled", 150, 160),
            _box("stem", 150, 140, w=4, h=44),
            _box("ottava", 150, 250, w=200, h=10),  # centered below bottom line (180)
        ]
        out = geom_omr.decode_symbols_to_musicxml([self.TREBLE], syms, key_fifths=0)
        assert out is not None
        assert 3 in _octaves(out) and 4 not in _octaves(out)

    def test_note_outside_ottava_box_x_is_unchanged(self):
        # the ottava box covers x in [400, 600]; the head at x=150 is outside it -> unchanged.
        syms = [
            _box("notehead_filled", 150, 160),
            _box("stem", 150, 140, w=4, h=44),
            _box("ottava", 500, 70, w=200, h=10),
        ]
        out = geom_omr.decode_symbols_to_musicxml([self.TREBLE], syms, key_fifths=0)
        assert out is not None
        assert 4 in _octaves(out) and 5 not in _octaves(out)

    def test_no_ottava_box_is_unchanged(self):
        # the never-worse guarantee for the full-symbol path: no ottava class box -> written octave.
        syms = [
            _box("notehead_filled", 150, 160),
            _box("stem", 150, 140, w=4, h=44),
        ]
        out = geom_omr.decode_symbols_to_musicxml([self.TREBLE], syms, key_fifths=0)
        assert out is not None
        assert 4 in _octaves(out)


# --- _ottava_spans_from_boxes (pure) ------------------------------------------------------

class TestOttavaSpansFromBoxes:
    TREBLE = [100.0, 120.0, 140.0, 160.0, 180.0]  # interline 20

    def _syms(self, boxes):
        s = {name: [] for name in geom_omr.CLASS_NAMES}
        s["ottava"] = boxes
        return s

    def test_box_above_is_plus_one(self):
        spans = geom_omr._ottava_spans_from_boxes(
            self._syms([(40.0, 60.0, 200.0, 10.0)]), self.TREBLE, 20.0)  # y-center 65 < top 100
        assert spans == [(40.0, 240.0, 1)]

    def test_box_below_is_minus_one(self):
        spans = geom_omr._ottava_spans_from_boxes(
            self._syms([(40.0, 240.0, 200.0, 10.0)]), self.TREBLE, 20.0)  # y-center 245 > bottom 180
        assert spans == [(40.0, 240.0, -1)]

    def test_empty_is_empty(self):
        assert geom_omr._ottava_spans_from_boxes(self._syms([]), self.TREBLE, 20.0) == []

    def test_never_raises_on_garbage(self):
        assert geom_omr._ottava_spans_from_boxes({"ottava": "nope"}, self.TREBLE, 20.0) == []
        assert geom_omr._ottava_spans_from_boxes({}, [1.0], 20.0) == []


# --- numpy raster tier: detect_ottavas ----------------------------------------------------

requires_geom = pytest.mark.skipif(
    not geom_omr.GEOM_AVAILABLE,
    reason="numpy/scipy/PIL not available (GEOM_AVAILABLE False)",
)


def _draw_staff_with_band(band_draw, width=1000, interline=16, top=120):
    """A single 5-line staff with a caller-drawn mark in the band above it. band_draw(d, lines, sp)
    draws onto the PIL ImageDraw. Returns (gray, staff_lines). The staff is drawn WIDE (~60
    interlines) so a full-system dashed rule clears the >=40-interline span gate the way a real
    score does (the gate exists to reject a few-interline local mark)."""
    import numpy as np
    from PIL import Image, ImageDraw
    im = Image.new("L", (width, top + interline * 4 + 120), 255)
    d = ImageDraw.Draw(im)
    lines = [top + i * interline for i in range(5)]
    for ly in lines:
        d.line([(0, ly), (width, ly)], fill=0, width=2)
    band_draw(d, lines, interline)
    gray = np.asarray(im, dtype=np.float32) / 255.0
    return gray, [float(l) for l in lines]


@requires_geom
class TestDetectOttavasRaster:
    def test_dashed_rule_above_is_detected_as_8va(self):
        import numpy as np

        def draw(d, lines, sp):
            y = lines[0] - 2 * sp  # ~2 interlines above the top line
            x = int(2 * sp)
            # a long dashed horizontal rule: short dashes (~0.7 interline) with ~equal gaps.
            dash = max(4, int(0.7 * sp))
            gap = max(4, int(0.9 * sp))
            while x < 960:
                d.line([(x, y), (x + dash, y)], fill=0, width=2)
                x += dash + gap

        gray, lines = _draw_staff_with_band(draw)
        staves = geom_omr.detect_systems(gray)
        assert len(staves) == 1
        spans = geom_omr.detect_ottavas(gray, staves)
        assert len(spans[0]) == 1
        x0, x1, delta = spans[0][0]
        assert delta == 1                         # ABOVE the staff -> 8va (+1)
        assert x1 - x0 > 20 * geom_omr._interline(lines)  # spans most of the staff width

    def test_far_stray_dash_does_not_extend_span(self):
        # A real dashed rule PLUS a lone stray dash far to the left (e.g. inter-staff clutter at a
        # system's far edge) must NOT chain the bracket span across the empty gap (reverie's bass 8va
        # over-extension, which shifted 3 unbracketed measures an octave). The span covers the real
        # rule only; the stray, separated by a gap beyond the cluster gate, is dropped.
        def draw(d, lines, sp):
            y = lines[0] - 2 * sp
            dash, gap = max(4, int(0.7 * sp)), max(4, int(0.9 * sp))
            sx = int(7 * sp)  # a lone stray dash, past the left margin (xcut) but far from the rule
            d.line([(sx, y), (sx + dash, y)], fill=0, width=2)
            x = int(50 * sp)  # the real rule, ~43 interlines right of the stray (gap > cluster gate)
            for _ in range(28):
                d.line([(x, y), (x + dash, y)], fill=0, width=2)
                x += dash + gap

        gray, lines = _draw_staff_with_band(draw, width=1600)
        staves = geom_omr.detect_systems(gray)
        spans = geom_omr.detect_ottavas(gray, staves)
        assert len(spans[0]) == 1
        x0, _x1, _delta = spans[0][0]
        assert x0 > 40 * geom_omr._interline(lines)  # span starts at the real rule, not the stray

    def test_thick_solid_beam_above_is_not_detected(self):
        def draw(d, lines, sp):
            y = int(lines[0] - 2 * sp)
            # a thick SOLID horizontal bar (a beam): one long run, far longer than a dash.
            d.line([(int(2 * sp), y), (960, y)], fill=0, width=max(6, int(0.5 * sp)))

        gray, _ = _draw_staff_with_band(draw)
        staves = geom_omr.detect_systems(gray)
        spans = geom_omr.detect_ottavas(gray, staves)
        assert spans[0] == []  # a solid beam is not an ottava

    def test_short_local_dash_run_is_not_detected(self):
        # a SHORT dashed mark (a few dashes spanning only a few interlines, e.g. a hairpin or a
        # rehearsal mark) must NOT be read as a full-width ottava bracket.
        def draw(d, lines, sp):
            y = lines[0] - 2 * sp
            x = int(2 * sp)
            dash, gap = max(4, int(0.7 * sp)), max(4, int(0.9 * sp))
            for _ in range(5):  # only ~5 dashes -> short span, few runs
                d.line([(x, y), (x + dash, y)], fill=0, width=2)
                x += dash + gap

        gray, _ = _draw_staff_with_band(draw)
        staves = geom_omr.detect_systems(gray)
        spans = geom_omr.detect_ottavas(gray, staves)
        assert spans[0] == []

    def test_no_mark_above_is_not_detected(self):
        gray, _ = _draw_staff_with_band(lambda d, lines, sp: None)
        staves = geom_omr.detect_systems(gray)
        spans = geom_omr.detect_ottavas(gray, staves)
        assert spans[0] == []


def test_largest_dash_cluster_drops_far_stray():
    # Pure helper: keep the largest contiguous run cluster; drop a run separated by a gap > max_gap.
    f = geom_omr._largest_dash_cluster
    assert f([(0, 2), (5, 7), (8, 10), (200, 202)], 50) == [(0, 2), (5, 7), (8, 10)]  # far stray dropped
    assert f([(0, 2), (5, 7)], 50) == [(0, 2), (5, 7)]   # a single tight cluster is unchanged
    assert f([(0, 2), (100, 102)], 50) == [(0, 2)]        # ties keep the leftmost cluster
    assert f([], 50) == []                                 # degenerate inputs never raise
    assert f([(3, 5)], 50) == [(3, 5)]


# --- Robustness: never raises -------------------------------------------------------------

class TestOttavaNeverRaises:
    def test_detect_ottavas_none_gray(self):
        assert geom_omr.detect_ottavas(None, [[10.0, 20.0, 30.0, 40.0, 50.0]]) == [[]]

    def test_detect_ottavas_no_staves(self):
        assert geom_omr.detect_ottavas(None, []) == []

    @requires_geom
    def test_detect_ottavas_blank_image(self):
        import numpy as np
        blank = np.ones((300, 400), dtype=np.float32)
        staves = [[100.0, 116.0, 132.0, 148.0, 164.0]]
        assert geom_omr.detect_ottavas(blank, staves) == [[]]

    def test_detect_ottavas_degenerate_staff(self):
        # a one-line "staff" has no interline -> skipped, not crashed on.
        assert geom_omr.detect_ottavas(None, [[10.0]]) == [[]]
