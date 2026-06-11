#!/usr/bin/env python3
"""Tests for the geometric pitch OMR engine (omr-worker/geom_omr.py).

Two tiers:
  - PURE geometry tests (decode_pitch) run EVERYWHERE: they assert that a notehead at a KNOWN
    y position relative to known staff lines decodes to the correct (step, octave) for treble
    and bass clef. This is the CORE correctness test of the whole engine and needs no verovio,
    no trained model, and no GPU.
  - PIL-rendered tests DRAW a synthetic staff (5 lines + filled noteheads at known positions)
    and assert the full detect -> decode path recovers those pitches. They SKIP cleanly when
    numpy/scipy/PIL are unavailable (GEOM_AVAILABLE False).

Plus never-raise-on-garbage tests for the robustness contract.
"""

import pytest

import geom_omr


# --- PURE geometry tier: decode_pitch (runs everywhere) ----------------------------------

class TestDecodePitchTreble:
    """Treble (G) clef: bottom line = E4, then each line/space up is one diatonic step.
    Staff lines top-to-bottom at y = 10,20,30,40,50 (interline 10, half-step 5 px)."""

    LINES = [10.0, 20.0, 30.0, 40.0, 50.0]

    def test_bottom_line_is_e4(self):
        assert geom_omr.decode_pitch(50.0, self.LINES, "G") == ("E", 0, 4)

    def test_line2_is_g4(self):
        # second line from the bottom (y=40), where the G clef curls -> G4
        assert geom_omr.decode_pitch(40.0, self.LINES, "G") == ("G", 0, 4)

    def test_middle_line_is_b4(self):
        assert geom_omr.decode_pitch(30.0, self.LINES, "G") == ("B", 0, 4)

    def test_top_line_is_f5(self):
        assert geom_omr.decode_pitch(10.0, self.LINES, "G") == ("F", 0, 5)

    def test_first_space_is_f4(self):
        # space just above the bottom line (y=45) -> F4
        assert geom_omr.decode_pitch(45.0, self.LINES, "G") == ("F", 0, 4)

    def test_space_above_top_line_is_g5(self):
        # top line is F5 (position 8); the space just above it (y=5, position 9) is G5
        assert geom_omr.decode_pitch(5.0, self.LINES, "G") == ("G", 0, 5)

    def test_middle_c_one_ledger_below(self):
        # one whole interline below the bottom line (y=60) is middle C4
        assert geom_omr.decode_pitch(60.0, self.LINES, "G") == ("C", 0, 4)

    def test_unordered_lines_are_normalized(self):
        # bottom-to-top order must give the same answer (the decode sorts internally)
        rev = list(reversed(self.LINES))
        assert geom_omr.decode_pitch(40.0, rev, "G") == ("G", 0, 4)


class TestDecodePitchBass:
    """Bass (F) clef: bottom line = G2, line 4 from the bottom = F3 (where the F clef dots
    straddle). Same staff geometry."""

    LINES = [10.0, 20.0, 30.0, 40.0, 50.0]

    def test_bottom_line_is_g2(self):
        assert geom_omr.decode_pitch(50.0, self.LINES, "F") == ("G", 0, 2)

    def test_line4_is_f3(self):
        # fourth line from the bottom (y=20), between the F-clef dots -> F3
        assert geom_omr.decode_pitch(20.0, self.LINES, "F") == ("F", 0, 3)

    def test_middle_line_is_d3(self):
        assert geom_omr.decode_pitch(30.0, self.LINES, "F") == ("D", 0, 3)

    def test_top_line_is_a3(self):
        assert geom_omr.decode_pitch(10.0, self.LINES, "F") == ("A", 0, 3)

    def test_middle_c_two_ledger_above(self):
        # C4 sits two interlines above the bass top line (y=10 -> A3); y=0 -> C4
        assert geom_omr.decode_pitch(0.0, self.LINES, "F") == ("C", 0, 4)


class TestDecodePitchRobustness:
    """decode_pitch never raises and returns None on malformed input."""

    def test_none_lines(self):
        assert geom_omr.decode_pitch(10.0, None, "G") is None

    def test_too_few_lines(self):
        assert geom_omr.decode_pitch(10.0, [10.0], "G") is None

    def test_degenerate_lines_same_y(self):
        assert geom_omr.decode_pitch(10.0, [10.0, 10.0, 10.0, 10.0, 10.0], "G") is None

    def test_garbage_y(self):
        # a non-numeric y must not raise
        assert geom_omr.decode_pitch("x", [10.0, 20.0, 30.0, 40.0, 50.0], "G") is None

    def test_unknown_clef_defaults_to_treble(self):
        # an unknown clef falls back to treble rather than raising
        assert geom_omr.decode_pitch(50.0, [10.0, 20.0, 30.0, 40.0, 50.0], "Z") == ("E", 0, 4)


# --- Shared decode tail: _decode_staves_to_musicxml (PURE, runs everywhere) --------------
# BOTH transcribers funnel their per-staff noteheads through this one helper: the classical
# geom_omr.transcribe_geometric (detect_noteheads source) and the trained
# geom_detector.transcribe_with_detector (YOLO + _assign_to_staves source). Only the notehead
# source differs; this is the shared decode/build tail, so testing it here locks the trained
# path to the classical baseline's decode. It needs no image and no numpy (decode_pitch,
# group_chords, _chords_to_measures and the MusicXML builder are all pure).

class TestDecodeStavesToMusicxml:
    TREBLE = [10.0, 20.0, 30.0, 40.0, 50.0]      # staff index 0 -> treble (G) clef
    BASS = [110.0, 120.0, 130.0, 140.0, 150.0]   # staff index 1 -> bass (F) clef

    def test_emits_grand_staff_with_decoded_pitches(self):
        # treble head on line 2 (y=40 -> G4), bass head on the bottom line (y=150 -> G2).
        out = geom_omr._decode_staves_to_musicxml(
            [self.TREBLE, self.BASS], [[(150.0, 40.0)], [(150.0, 150.0)]]
        )
        assert out is not None
        assert b"score-partwise" in out
        assert b"<step>G</step>" in out
        # both hands carried through to the two-staff part
        assert b"<staff>1</staff>" in out and b"<staff>2</staff>" in out

    def test_same_x_heads_become_one_chord(self):
        # two treble heads at nearly the same x (y=50 -> E4, y=40 -> G4) group into one chord,
        # so the second note carries a <chord/> tag.
        out = geom_omr._decode_staves_to_musicxml(
            [self.TREBLE], [[(150.0, 50.0), (152.0, 40.0)]]
        )
        assert out is not None
        assert b"<chord" in out  # ElementTree serializes the empty element as "<chord />"

    def test_key_fifths_applies_accidental(self):
        # an F head in a 1-sharp key (G major) must decode as F#, i.e. carry an <alter>1</alter>.
        # y=45 on the treble staff is the first space -> F4; key_fifths=1 sharps F.
        out = geom_omr._decode_staves_to_musicxml([self.TREBLE], [[(150.0, 45.0)]], key_fifths=1)
        assert out is not None
        assert b"<step>F</step>" in out and b"<alter>1</alter>" in out

    def test_no_heads_returns_none(self):
        assert geom_omr._decode_staves_to_musicxml([self.TREBLE, self.BASS], [[], []]) is None

    def test_never_raises_on_garbage(self):
        # malformed inputs return None instead of raising (the module's robustness contract).
        assert geom_omr._decode_staves_to_musicxml(None, None) is None
        # heads list shorter than staves: the missing staff is treated as empty.
        assert geom_omr._decode_staves_to_musicxml([self.TREBLE], []) is None
        # a degenerate staff (one line) is skipped, not crashed on.
        assert geom_omr._decode_staves_to_musicxml([[10.0]], [[(1.0, 2.0)]]) is None


# --- PIL-rendered tier: full detect -> decode (skips without numpy/scipy/PIL) -------------

requires_geom = pytest.mark.skipif(
    not geom_omr.GEOM_AVAILABLE,
    reason="numpy/scipy/PIL not available (GEOM_AVAILABLE False)",
)


def _draw_staff(noteheads, clef_zone=True, width=400, interline=16, top=40):
    """Draw a synthetic single staff: 5 horizontal lines + filled-ellipse noteheads at the
    given (x, y) centers. Returns a float32 grayscale ndarray in [0,1] (0=ink, 1=white) and
    the 5 staff-line y-centers. noteheads is a list of (x_center, y_center)."""
    import numpy as np
    from PIL import Image, ImageDraw

    height = top + interline * 4 + 80
    im = Image.new("L", (width, height), 255)
    d = ImageDraw.Draw(im)
    lines = [top + i * interline for i in range(5)]
    for ly in lines:
        d.line([(0, ly), (width, ly)], fill=0, width=2)
    if clef_zone:
        # a dark blob in the clef zone (far left) to confirm detect_noteheads excludes it
        d.rectangle([6, top, 6 + interline, top + interline * 4], fill=0)
    rx = int(interline * 0.62)
    ry = int(interline * 0.5)
    for (x, y) in noteheads:
        d.ellipse([x - rx, y - ry, x + rx, y + ry], fill=0)
    gray = np.asarray(im, dtype=np.float32) / 255.0
    return gray, [float(l) for l in lines]


@requires_geom
class TestDetectAndDecode:
    def test_detect_systems_finds_one_staff(self):
        gray, lines = _draw_staff([(200, 40 + 2 * 16)])
        staves = geom_omr.detect_systems(gray)
        assert len(staves) == 1
        # detected line centers are close to the drawn ones
        import numpy as np
        got = np.array(sorted(staves[0]))
        want = np.array(sorted(lines))
        assert np.allclose(got, want, atol=2.0)

    def test_detect_noteheads_recovers_known_positions(self):
        # three heads at distinct x, on the second line (G4), middle line (B4), top line (F5)
        interline, top = 16, 40
        lines_y = [top + i * interline for i in range(5)]
        heads_in = [(150, lines_y[3]), (220, lines_y[2]), (300, lines_y[0])]
        gray, lines = _draw_staff(heads_in, interline=interline, top=top)
        found = geom_omr.detect_noteheads(gray, lines)
        assert len(found) == 3
        import numpy as np
        fx = sorted(c[0] for c in found)
        assert np.allclose(fx, [150, 220, 300], atol=interline)

    def test_full_decode_treble_pitches(self):
        # heads on line2 (G4), middle (B4), top (F5) decode correctly through the full path
        interline, top = 16, 40
        lines_y = [top + i * interline for i in range(5)]
        heads_in = [(150, lines_y[3]), (220, lines_y[2]), (300, lines_y[0])]
        gray, lines = _draw_staff(heads_in, interline=interline, top=top)
        found = geom_omr.detect_noteheads(gray, lines)
        decoded = sorted(
            (geom_omr.decode_pitch(y, lines, "G") for (x, y) in found),
            key=lambda p: (p[2], p[0]),
        )
        assert ("G", 0, 4) in decoded
        assert ("B", 0, 4) in decoded
        assert ("F", 0, 5) in decoded

    def test_chord_grouping_stacks_same_x(self):
        # two heads at nearly the same x (a chord) + one far away (separate onset)
        interline, top = 16, 40
        lines_y = [top + i * interline for i in range(5)]
        heads = [(150, lines_y[4]), (152, lines_y[2]), (320, lines_y[0])]
        chords = geom_omr.group_chords(heads, interline)
        assert len(chords) == 2
        # the first chord has both stacked heads
        assert len(chords[0]) == 2

    def test_transcribe_geometric_emits_musicxml(self):
        interline, top = 16, 40
        lines_y = [top + i * interline for i in range(5)]
        heads_in = [(150, lines_y[3]), (240, lines_y[2]), (330, lines_y[0])]
        gray, _ = _draw_staff(heads_in, interline=interline, top=top)
        out = geom_omr.transcribe_geometric(gray)
        assert out is not None
        assert b"score-partwise" in out
        assert b"<step>" in out


# --- Never-raise-on-garbage (robustness contract) ----------------------------------------

class TestNeverRaises:
    def test_transcribe_none(self):
        assert geom_omr.transcribe_geometric(None) is None

    def test_transcribe_bad_path(self):
        assert geom_omr.transcribe_geometric("/no/such/file/xyz.png") is None

    @requires_geom
    def test_transcribe_blank_image(self):
        import numpy as np
        blank = np.ones((200, 300), dtype=np.float32)  # all white, no staff
        assert geom_omr.transcribe_geometric(blank) is None

    @requires_geom
    def test_detect_systems_blank(self):
        import numpy as np
        blank = np.ones((200, 300), dtype=np.float32)
        assert geom_omr.detect_systems(blank) == []

    @requires_geom
    def test_detect_noteheads_no_staff(self):
        import numpy as np
        blank = np.ones((200, 300), dtype=np.float32)
        assert geom_omr.detect_noteheads(blank, [10, 20, 30, 40, 50]) == []

    def test_group_chords_empty(self):
        assert geom_omr.group_chords([], 10.0) == []

    def test_group_chords_bad_interline(self):
        assert geom_omr.group_chords([(1.0, 2.0)], 0) == []


# --- Barlines -> real measures ------------------------------------------------------------


def test_segment_to_measures_by_barlines():
    # treble chords at x=10/60/110; barlines at 0,50,100,150 -> 3 measures, one note each, x-ordered.
    treble = [(10.0, [("C", 0, 5)]), (60.0, [("D", 0, 5)]), (110.0, [("E", 0, 5)])]
    measures = geom_omr._segment_to_measures(treble, [], [0.0, 50.0, 100.0, 150.0])
    assert len(measures) == 3
    steps = [mm["staff1"][0]["pitches"][0]["step"] for mm in measures]
    assert steps == ["C", "D", "E"]


def test_segment_to_measures_falls_back_without_barlines():
    # no barlines -> legacy 4-per-bar binning (identical to _chords_to_measures).
    treble = [(float(i), [("C", 0, 5)]) for i in range(8)]
    assert geom_omr._segment_to_measures(treble, [], []) == \
        geom_omr._chords_to_measures([[("C", 0, 5)]] * 8, [])


# --- Per-line staff DEWARP (camera OMR) ---------------------------------------------------
# dewarp_staff_lines straightens tilted / perspective-curved staff lines so the row-projection
# staff detector survives a phone photo. The contract under test: it is a byte-identical IDENTITY
# on a flat (clean) page, it RECOVERS staff detection on a warped one, and it never raises.


def _draw_page(width=900, height=1200, n_staves=6, interline=12, slope=0.0, curve=0.0):
    """Draw a synthetic multi-staff page (n_staves evenly spaced 5-line staves) with an optional
    linear tilt (slope = px of vertical drift per px of x from the page centre) and parabolic
    curvature (curve = px of bow at the page edges). Returns a float32 grayscale ndarray in [0,1]
    (0=ink, 1=white). No anti-aliasing (integer-rounded 2px lines) so the result is deterministic."""
    import numpy as np
    g = np.ones((height, width), np.float32)
    xc = width / 2.0
    margin = int(1.6 * interline * 5)
    tops = np.linspace(margin, height - margin, n_staves)
    base_ys = [[t + k * interline for k in range(5)] for t in tops]
    for x in range(width):
        dy = slope * (x - xc) + curve * ((x - xc) / xc) ** 2
        for staff in base_ys:
            for by in staff:
                y = int(round(by + dy))
                if 1 <= y < height - 1:
                    g[y - 1:y + 1, x] = 0.0
    return g


def _max_rowink(g):
    """Peak per-row dark fraction. A straight full-width line gives ~1.0; a tilted line smears
    across rows and drops it, so this rises as the dewarp straightens the lines."""
    import numpy as np
    return float((g < 0.5).mean(axis=1).max())


@requires_geom
class TestDewarpStaffLines:
    def test_flat_page_is_identity_object(self):
        # A flat (already-horizontal) page yields a ~0 displacement field, so the dewarp returns the
        # SAME object. The detector path keys off that identity to stay byte-identical on clean.
        flat = _draw_page()
        assert geom_omr.dewarp_staff_lines(flat) is flat
        assert len(geom_omr.detect_systems(flat)) == 6  # detection already works flat

    def test_recovers_tilted_staves(self):
        tilt = _draw_page(slope=0.05)
        raw = len(geom_omr.detect_systems(tilt))
        out = geom_omr.dewarp_staff_lines(tilt)
        assert out is not tilt                                  # a warped page IS remapped
        rec = len(geom_omr.detect_systems(out))
        assert rec > raw                                        # more staves recovered than raw
        assert rec >= 5                                         # nearly all 6 drawn staves back
        assert _max_rowink(out) > _max_rowink(tilt) + 0.2       # lines are straighter

    def test_recovers_curved_staves(self):
        curved = _draw_page(slope=0.0, curve=22.0)
        raw = len(geom_omr.detect_systems(curved))
        out = geom_omr.dewarp_staff_lines(curved)
        assert out is not curved
        assert len(geom_omr.detect_systems(out)) > raw
        assert _max_rowink(out) > _max_rowink(curved) + 0.2

    def test_blank_and_small_return_input_object(self):
        import numpy as np
        blank = np.ones((300, 400), np.float32)
        assert geom_omr.dewarp_staff_lines(blank) is blank     # no staff structure -> identity
        small = np.zeros((8, 8), np.float32)
        assert geom_omr.dewarp_staff_lines(small) is small     # below the size floor -> identity

    def test_never_raises_on_junk(self):
        import numpy as np
        assert geom_omr.dewarp_staff_lines(None) is None
        rng = np.random.default_rng(0)
        for bad in [np.random.RandomState(0).rand(120, 160).astype(np.float32),
                    np.zeros((50, 50, 3), np.float32),         # 3-D -> returned unchanged
                    rng.random((200, 200)).astype(np.float32)]:
            assert geom_omr.dewarp_staff_lines(bad) is not None


@requires_geom
class TestGrayToUint8Rgb:
    def test_converts_2d_float_to_hwc_uint8(self):
        import numpy as np
        g = np.linspace(0.0, 1.0, 20 * 30).reshape(20, 30).astype(np.float32)
        rgb = geom_omr._gray_to_uint8_rgb(g)
        assert rgb is not None
        assert rgb.shape == (20, 30, 3) and rgb.dtype == np.uint8
        # the three channels are identical (a grayscale image replicated)
        assert (rgb[..., 0] == rgb[..., 1]).all() and (rgb[..., 1] == rgb[..., 2]).all()

    def test_returns_none_on_bad_input(self):
        import numpy as np
        assert geom_omr._gray_to_uint8_rgb(None) is None
        assert geom_omr._gray_to_uint8_rgb(np.zeros((5, 5, 3), np.float32)) is None  # not 2-D


@requires_geom
def test_estimate_interline_from_profile():
    # the per-row darkness profile of evenly spaced staff lines recovers the interline (approx).
    import numpy as np
    g = _draw_page(interline=12)
    prof = (g < 0.5).astype(np.float32).mean(axis=1)
    il = geom_omr._estimate_interline_from_profile(prof)
    assert il is not None and abs(il - 12) <= 2


def _draw_grand_staff_with_barlines(barline_xs, width=400, interline=16, top=40, gap=64):
    """Two 5-line staves (a grand staff) with vertical barlines spanning the treble top line to
    the bass bottom line. Returns (gray, treble_lines, bass_lines)."""
    import numpy as np
    from PIL import Image, ImageDraw
    treble = [top + i * interline for i in range(5)]
    bass = [treble[-1] + gap + i * interline for i in range(5)]
    im = Image.new("L", (width, int(bass[-1] + 60)), 255)
    d = ImageDraw.Draw(im)
    for ly in treble + bass:
        d.line([(0, ly), (width, ly)], fill=0, width=2)
    for bx in barline_xs:
        d.line([(bx, treble[0]), (bx, bass[-1])], fill=0, width=2)
    gray = np.asarray(im, dtype=np.float32) / 255.0
    return gray, [float(v) for v in treble], [float(v) for v in bass]


@requires_geom
def test_detect_barlines_finds_grand_staff_barlines():
    import numpy as np
    xs = [40, 140, 240, 340]  # 4 barlines -> 3 measures
    gray, _treble, _bass = _draw_grand_staff_with_barlines(xs)
    staves = geom_omr.detect_systems(gray)
    assert len(staves) == 2
    bl = geom_omr.detect_barlines(gray, staves)
    assert bl[0] == bl[1]  # treble + bass of a pair share one barline list
    assert len(bl[0]) == len(xs)
    assert np.allclose(np.array(bl[0]), xs, atol=3.0)


@requires_geom
def test_detect_systems_rejects_intruder_rows_above():
    """A staff detected as 7 near-full-width rows: two partial-width INTRUDER rows (a beam / dense
    note row) evenly spaced ABOVE the 5 real staff lines. The staff must still be found with its 5
    real lines, not dropped (the icarus failure: a 7-line group was discarded whole). Spacing alone
    cannot separate the intruders here (they sit at the interline), so the ink tiebreak must."""
    import numpy as np
    from PIL import Image, ImageDraw

    width, interline, top = 400, 16, 80
    im = Image.new("L", (width, top + interline * 4 + 80), 255)
    d = ImageDraw.Draw(im)
    real_lines = [top + i * interline for i in range(5)]
    for ly in real_lines:
        d.line([(0, ly), (width, ly)], fill=0, width=2)  # full-width staff lines (high ink)
    for k in (2, 1):  # two intruder rows, one and two interlines above the top staff line
        iy = top - k * interline
        d.line([(0, iy), (int(width * 0.5), iy)], fill=0, width=3)  # half width -> lower ink
    gray = np.asarray(im, dtype=np.float32) / 255.0
    staves = geom_omr.detect_systems(gray)
    assert len(staves) == 1
    got = np.array(sorted(staves[0]))
    assert np.allclose(got, np.array(sorted(float(l) for l in real_lines)), atol=2.0)


@requires_geom
def test_detect_systems_keeps_staff_with_trailing_intruder():
    """reverie failure: a staff detected as 6 rows = 5 evenly-spaced staff lines + 1 partial-width
    intruder row just BELOW at an irregular gap. The 5 real lines must be recovered."""
    import numpy as np
    from PIL import Image, ImageDraw

    width, interline, top = 400, 16, 60
    im = Image.new("L", (width, top + interline * 4 + 80), 255)
    d = ImageDraw.Draw(im)
    real_lines = [top + i * interline for i in range(5)]
    for ly in real_lines:
        d.line([(0, ly), (width, ly)], fill=0, width=2)
    d.line([(0, real_lines[-1] + 11), (int(width * 0.6), real_lines[-1] + 11)], fill=0, width=4)
    gray = np.asarray(im, dtype=np.float32) / 255.0
    staves = geom_omr.detect_systems(gray)
    assert len(staves) == 1
    got = np.array(sorted(staves[0]))
    assert np.allclose(got, np.array(sorted(float(l) for l in real_lines)), atol=2.0)


@requires_geom
def test_detect_systems_splits_merged_staves():
    """Two staves whose inter-staff gap is only ~1.5 interlines (smaller than a normal system gap)
    cluster into one 10-line run. _extract_staves must still return BOTH staves (greedy
    non-overlapping windows), where the old even-split-on-multiples-of-5 was the only path."""
    import numpy as np
    from PIL import Image, ImageDraw

    width, interline, top = 400, 16, 40
    upper = [top + i * interline for i in range(5)]
    lower = [upper[-1] + int(interline * 1.5) + i * interline for i in range(5)]
    im = Image.new("L", (width, lower[-1] + 40), 255)
    d = ImageDraw.Draw(im)
    for ly in upper + lower:
        d.line([(0, ly), (width, ly)], fill=0, width=2)
    gray = np.asarray(im, dtype=np.float32) / 255.0
    staves = geom_omr.detect_systems(gray)
    assert len(staves) == 2
    assert np.allclose(sorted(staves[0]), np.array(sorted(float(l) for l in upper)), atol=2.0)
    assert np.allclose(sorted(staves[1]), np.array(sorted(float(l) for l in lower)), atol=2.0)


@requires_geom
def test_detect_systems_keeps_isolated_staff_with_one_irregular_gap():
    """An isolated, well-formed staff whose one interior gap is a little wide (1.5x the interline:
    a thicker engraved line or a mild local warp) must still be kept. The original code kept any
    group of exactly 5 unconditionally, so the new code must not drop it to the uniformity gate."""
    import numpy as np
    from PIL import Image, ImageDraw

    width, interline, top = 400, 16, 60
    ys = [top, top + interline, top + 2 * interline, top + 3 * interline,
          top + 3 * interline + int(1.5 * interline)]  # last gap = 1.5 * interline
    im = Image.new("L", (width, ys[-1] + 60), 255)
    d = ImageDraw.Draw(im)
    for ly in ys:
        d.line([(0, ly), (width, ly)], fill=0, width=2)
    gray = np.asarray(im, dtype=np.float32) / 255.0
    staves = geom_omr.detect_systems(gray)
    assert len(staves) == 1
    assert np.allclose(sorted(staves[0]), np.array([float(y) for y in ys]), atol=2.0)


@requires_geom
def test_detect_systems_splits_tightly_merged_staves_even_when_seam_is_inkier():
    """Two staves set so tightly that the inter-staff gap EQUALS the interline (all 10 lines evenly
    spaced) must split into 2 staves even when the lines near the seam are the darkest, which would
    fool a window scored by ink. The even multiple-of-5 split handles this positionally."""
    import numpy as np
    from PIL import Image, ImageDraw

    width, interline, top = 400, 16, 40
    ys = [top + i * interline for i in range(10)]  # all 9 gaps equal the interline
    im = Image.new("L", (width, ys[-1] + 60), 255)
    d = ImageDraw.Draw(im)
    for i, ly in enumerate(ys):
        if 2 <= i <= 7:  # interior seam lines drawn full-width + thicker (highest ink)
            d.line([(0, ly), (width, ly)], fill=0, width=3)
        else:            # outer lines narrower (lower ink) so an ink rule would prefer the seam
            d.line([(0, ly), (int(width * 0.6), ly)], fill=0, width=2)
    gray = np.asarray(im, dtype=np.float32) / 255.0
    staves = geom_omr.detect_systems(gray)
    assert len(staves) == 2
    assert np.allclose(sorted(staves[0]), np.array([float(y) for y in ys[:5]]), atol=2.0)
    assert np.allclose(sorted(staves[1]), np.array([float(y) for y in ys[5:]]), atol=2.0)


@requires_geom
def test_detect_systems_picks_thin_staff_over_thick_inky_beam():
    """A 6-row region = a full-width thick BEAM one interline above 5 thin staff lines whose lower
    lines are partly occluded by a chord (lower ink). An ink-only rule would keep the inky beam and
    drop a real line; thinness must win so the 5 real staff lines are chosen, not the beam."""
    import numpy as np
    from PIL import Image, ImageDraw

    width, interline, top = 400, 16, 80
    staff = [top + i * interline for i in range(5)]
    im = Image.new("L", (width, staff[-1] + 60), 255)
    d = ImageDraw.Draw(im)
    d.line([(0, top - interline), (width, top - interline)], fill=0, width=8)  # thick full-width beam
    for i, ly in enumerate(staff):
        if i >= 3:  # lower real lines occluded by a chord -> only ~45% width (lower ink), still thin
            d.line([(0, ly), (int(width * 0.45), ly)], fill=0, width=2)
        else:
            d.line([(0, ly), (width, ly)], fill=0, width=2)
    gray = np.asarray(im, dtype=np.float32) / 255.0
    staves = geom_omr.detect_systems(gray)
    assert len(staves) == 1
    assert np.allclose(sorted(staves[0]), np.array([float(y) for y in staff]), atol=2.0)


@requires_geom
def test_detect_barlines_ignores_stems():
    # a real barline spans both staves; a STEM lives in one staff and must NOT be detected.
    import numpy as np
    from PIL import Image, ImageDraw
    interline, top, gap = 16, 40, 64
    treble = [top + i * interline for i in range(5)]
    bass = [treble[-1] + gap + i * interline for i in range(5)]
    im = Image.new("L", (400, int(bass[-1] + 60)), 255)
    d = ImageDraw.Draw(im)
    for ly in treble + bass:
        d.line([(0, ly), (400, ly)], fill=0, width=2)
    d.line([(50, treble[0]), (50, bass[-1])], fill=0, width=2)      # barline: spans both staves
    d.line([(200, treble[0]), (200, treble[-1])], fill=0, width=2)  # stem: treble only
    gray = np.asarray(im, dtype=np.float32) / 255.0
    staves = geom_omr.detect_systems(gray)
    bl = geom_omr.detect_barlines(gray, staves)
    assert any(abs(x - 50) <= 3 for x in bl[0])       # the barline IS found
    assert not any(abs(x - 200) <= 3 for x in bl[0])  # the stem is NOT


# --- Illumination normalization (phone-photo staff-detection robustness) ------------------
#
# A photo darkens the "white" paper unevenly; the fixed gray<0.5 ink threshold in
# detect_systems/detect_barlines/detect_ottavas then reads shadowed paper as full-width ink and
# the staff geometry collapses. normalize_illumination flat-fields the lighting so the threshold
# holds, and is a NO-OP on an evenly-lit (clean) page so the clean path is byte-identical.


@requires_geom
def test_normalize_illumination_noop_on_even_lighting():
    # an evenly-lit page (white paper + some ink) is returned UNCHANGED (the never-worse guard).
    import numpy as np
    gray, _ = _draw_staff([(200, 40 + 2 * 16)])
    out = geom_omr.normalize_illumination(gray)
    assert np.array_equal(out, gray)


@requires_geom
def test_normalize_illumination_lifts_shadowed_background():
    # a smooth shadow pushes the white background below 0.5 (where it reads as ink); normalization
    # must lift the shadowed PAPER back above 0.5 while keeping the INK well below it.
    import numpy as np
    h, w = 300, 300
    gray = np.ones((h, w), dtype=np.float32)
    gray[40, :] = 0.0                       # one full-width ink line (a staff line)
    shade = np.ones(h, dtype=np.float32)
    shade[:] = np.linspace(1.0, 0.42, h)    # smooth vertical shadow to 0.42 at the bottom
    shadowed = gray * shade[:, None]
    # precondition: the lower background really did fall below 0.5 (raw threshold would mis-read it)
    assert shadowed[290, 150] < 0.5
    out = geom_omr.normalize_illumination(shadowed)
    assert out[290, 150] > 0.5              # shadowed paper recovered to "white"
    assert out[40, 150] < 0.5              # the ink line stays ink


@requires_geom
def test_detect_systems_recovers_shadowed_staff():
    # the integration: a staff sitting under a cast shadow (its background driven below 0.5) is
    # STILL detected, because detect_systems flat-fields first. Without normalization the shadow
    # band reads as full-width ink and the staff is lost (the measured strength-1.5 photo cliff).
    import numpy as np
    gray, lines = _draw_staff([(200, 40 + 2 * 16)], width=400, interline=16, top=40)
    h, w = gray.shape
    band = np.ones(h, dtype=np.float32)
    y0 = int(lines[0] - 24); y1 = int(lines[-1] + 24)
    band[y0:y1] = 0.45                       # uniform cast shadow over the whole staff
    shadowed = np.clip(gray * band[:, None], 0.0, 1.0)
    # precondition: in the shadow band the (non-line) paper is below the ink threshold
    assert shadowed[int(lines[0]) + 8, 350] < 0.5
    staves = geom_omr.detect_systems(shadowed)
    assert len(staves) == 1
    got = np.array(sorted(staves[0]))
    assert np.allclose(got, np.array(sorted(lines)), atol=2.0)


def test_normalize_illumination_never_raises():
    # robustness contract: degenerate inputs return safely (the input or a guarded default), no raise.
    assert geom_omr.normalize_illumination(None) is None
    if geom_omr.GEOM_AVAILABLE:
        import numpy as np
        tiny = np.ones((1, 1), dtype=np.float32)
        out = geom_omr.normalize_illumination(tiny)
        assert out is not None and out.shape == (1, 1)


@requires_geom
def test_normalize_illumination_noop_on_dense_clean_page():
    # A CLEAN (uniformly white bg) but DENSE page -- many fully-inked grid cells (beams / chord
    # clusters) -- must still be a no-op. The cell-brightness guard is max-dilated so an isolated
    # inked cell borrows its lit neighbours; without that, >5% fully-inked cells would trip the
    # guard and normalization would alter a clean page (the never-worse-on-clean regression).
    import numpy as np
    g = np.ones((480, 480), dtype=np.float32)        # grid=48 -> 10x10 px cells
    for r in range(0, 48, 4):                         # ink ~6% of cells, isolated (4 cells apart)
        for c in range(0, 48, 4):
            g[r * 10:(r + 1) * 10, c * 10:(c + 1) * 10] = 0.0
    assert (g < 0.5).mean() > 0.05                    # genuinely dense (would trip a density guard)
    out = geom_omr.normalize_illumination(g)
    assert np.array_equal(out, g)                     # no-op: clean dense page is unchanged


@requires_geom
def test_detect_barlines_recovers_under_shadow():
    # the other shadow call site: a barline spanning a grand staff under a cast shadow (background
    # driven below 0.5) is STILL found, because detect_barlines flat-fields first.
    import numpy as np
    from PIL import Image, ImageDraw
    interline, top, gap = 16, 40, 64
    treble = [top + i * interline for i in range(5)]
    bass = [treble[-1] + gap + i * interline for i in range(5)]
    im = Image.new("L", (400, int(bass[-1] + 60)), 255)
    d = ImageDraw.Draw(im)
    for ly in treble + bass:
        d.line([(0, ly), (400, ly)], fill=0, width=2)
    d.line([(50, treble[0]), (50, bass[-1])], fill=0, width=2)   # barline spans both staves
    gray = np.asarray(im, dtype=np.float32) / 255.0
    band = np.ones(gray.shape[0], dtype=np.float32)
    band[int(treble[0] - 20):int(bass[-1] + 20)] = 0.45         # broad cast shadow over the system
    shadowed = np.clip(gray * band[:, None], 0.0, 1.0)
    assert shadowed[int(treble[2]), 300] < 0.5                   # precondition: paper reads as ink
    staves = geom_omr.detect_systems(shadowed)
    bl = geom_omr.detect_barlines(shadowed, staves)
    assert any(abs(x - 50) <= 3 for row in bl for x in row)      # the barline survives the shadow


# --- Adaptive illumination on the dewarp (warped-photo) path -------------------------------
#
# The flat-field rescues a deep broad shadow but HURTS a photo that is only mildly uneven (it
# over-corrects the gradient and amplifies noise in the dense row projection). On the kept-dewarp
# path geom_detector decides per photo via _illum_has_deep_shadow and threads a normalize_illum flag
# through detect_systems / detect_barlines / detect_ottavas / _decode_staves_to_musicxml. The flag
# defaults True, so the classical engine and the clean upload path are byte-identical.


@requires_geom
def test_illum_has_deep_shadow_true_only_for_a_deep_broad_shadow():
    import numpy as np
    # evenly lit (a few thin staff-like lines on white): every dilated paper cell stays bright -> False
    even = np.ones((480, 480), np.float32)
    even[100:300:8, 40:440] = 0.0
    assert geom_omr._illum_has_deep_shadow(even) is False
    # a DEEP, BROAD shadow over a corner: a whole block neighbourhood goes well below 0.25 -> True
    deep = np.ones((480, 480), np.float32)
    deep[:160, :160] = 0.15
    assert geom_omr._illum_has_deep_shadow(deep) is True
    # a MILD gradient whose darkest paper never dips below the threshold -> False (flat-field would hurt)
    mild = np.linspace(1.0, 0.45, 480, dtype=np.float32)[:, None] * np.ones((1, 480), np.float32)
    assert geom_omr._illum_has_deep_shadow(mild) is False
    # the threshold is a parameter: the same mild page reads as a shadow under a high enough threshold
    assert geom_omr._illum_has_deep_shadow(mild, thresh=0.6) is True
    # a CLEAN but DENSE page (fully-inked isolated cells, no white in them) must NOT read as a deep
    # shadow: the 5-cell dilation lets each inked cell borrow its lit neighbours. Without that dilation
    # guard.min() would be 0 and the flat-field would wrongly be KEPT on a clean page on the dewarp path.
    dense = np.ones((480, 480), np.float32)
    for r in range(0, 48, 4):
        for c in range(0, 48, 4):
            dense[r * 10:(r + 1) * 10, c * 10:(c + 1) * 10] = 0.0
    assert (dense < 0.5).mean() > 0.05                       # genuinely dense
    assert geom_omr._illum_has_deep_shadow(dense) is False


def test_illum_has_deep_shadow_safe_on_garbage():
    # robustness contract: never raises, returns False (drop) on degenerate input
    assert geom_omr._illum_has_deep_shadow(None) is False
    if geom_omr.GEOM_AVAILABLE:
        import numpy as np
        assert geom_omr._illum_has_deep_shadow(np.ones((1, 1), np.float32)) is False


@requires_geom
def test_detectors_normalize_illum_flag_gates_the_flatfield(monkeypatch):
    # the wiring: normalize_illum=True invokes normalize_illumination in each detector; False skips it.
    real = geom_omr.normalize_illumination
    calls = []

    def spy(g, *a, **k):
        calls.append(1)
        return real(g, *a, **k)

    monkeypatch.setattr(geom_omr, "normalize_illumination", spy)
    gray, lines = _draw_staff([(200, 72)], width=400, interline=16, top=40)
    staves = [lines]
    for fn, args in ((geom_omr.detect_systems, (gray,)),
                     (geom_omr.detect_barlines, (gray, staves)),
                     (geom_omr.detect_ottavas, (gray, staves))):
        calls.clear()
        fn(*args, normalize_illum=True)
        assert calls, fn.__name__ + " with True must flat-field"
        calls.clear()
        fn(*args, normalize_illum=False)
        assert not calls, fn.__name__ + " with False must skip the flat-field"


@requires_geom
def test_decode_forwards_normalize_illum(monkeypatch):
    # _decode_staves_to_musicxml threads its normalize_illum into detect_barlines / detect_ottavas so
    # they share the staves' illumination space; the default keeps both flat-fielding (byte-identical).
    import numpy as np
    captured = {}

    def fake_barlines(gray, staves, normalize_illum=True, photo=False, heads=None):
        captured["barlines"] = normalize_illum
        return [[] for _ in staves]

    def fake_ottavas(gray, staves, normalize_illum=True, photo=False):
        captured["ottavas"] = normalize_illum
        return [[] for _ in staves]

    monkeypatch.setattr(geom_omr, "detect_barlines", fake_barlines)
    monkeypatch.setattr(geom_omr, "detect_ottavas", fake_ottavas)
    staves = [[40.0, 56.0, 72.0, 88.0, 104.0], [200.0, 216.0, 232.0, 248.0, 264.0]]
    heads = [[(100.0, 72.0)], [(100.0, 232.0)]]
    gray = np.ones((320, 400), np.float32)
    geom_omr._decode_staves_to_musicxml(staves, heads, gray=gray, normalize_illum=False)
    assert captured == {"barlines": False, "ottavas": False}
    captured.clear()
    geom_omr._decode_staves_to_musicxml(staves, heads, gray=gray)  # default -> flat-field
    assert captured == {"barlines": True, "ottavas": True}


# --- Conditional extra-barline removal (dense-score over-segmentation) ---------------------
#
# A dense chord/stem stack clears the >70%-pair-height test WITHOUT crossing the inter-staff gap, so
# it reads as a false barline and over-segments the measure. _drop_extra_barlines removes such a
# candidate ONLY when it is an EXTRA one (carves a measure narrower than half the system's median
# measure width), so a uniformly-segmented system is provably untouched (the strict never-worse the
# simple gap-only guard could not give -- tctab's one near-blank-gap real barline). PURE; no image.


def test_drop_extra_barlines_keeps_uniform_even_when_all_weak():
    # the core never-worse case: UNIFORM spacing is untouched regardless of gap score -- even if every
    # candidate reads as non-gap-crossing, none is anomalously close, so nothing is dropped.
    xs = [0.0, 100.0, 200.0, 300.0, 400.0]
    assert geom_omr._drop_extra_barlines(xs, [0.1] * len(xs)) == xs
    assert geom_omr._drop_extra_barlines(xs, [1.0] * len(xs)) == xs


def test_drop_extra_barlines_keeps_well_spaced_weak():
    # the tctab analog: a uniform strong grid with ONE weak (near-blank-gap) but WELL-SPACED real
    # barline. It is not in a narrow measure, so it survives (the -0.003 the gap-only guard cost).
    xs = [0.0, 100.0, 200.0, 300.0, 400.0]
    scores = [1.0, 1.0, 0.05, 1.0, 1.0]   # the x=200 barline does not cross the gap, but is spaced
    assert geom_omr._drop_extra_barlines(xs, scores) == xs


def test_drop_extra_barlines_drops_close_weak():
    # a false weak barline (x=120) anomalously close to a real one (x=100) is dropped; the rest stay.
    xs = [0.0, 100.0, 120.0, 200.0, 300.0]
    scores = [1.0, 1.0, 0.0, 1.0, 1.0]
    assert geom_omr._drop_extra_barlines(xs, scores) == [0.0, 100.0, 200.0, 300.0]


def test_drop_extra_barlines_keeps_close_strong():
    # two GAP-CROSSING barlines genuinely close (a real short measure, e.g. a pickup) are BOTH kept --
    # closeness alone never drops; the candidate must also fail the gap-crossing test.
    xs = [0.0, 100.0, 120.0, 200.0, 300.0]
    scores = [1.0, 1.0, 1.0, 1.0, 1.0]
    assert geom_omr._drop_extra_barlines(xs, scores) == xs


def test_drop_extra_barlines_discriminates_by_gap_score():
    # when two close candidates are both weak, the WEAKER (lower gap darkness) is the false one
    # dropped: a real-but-cluttered barline (x=100, score 0.30) beats a stack column (x=118, 0.05).
    xs = [0.0, 100.0, 118.0, 200.0, 300.0, 400.0]
    scores = [1.0, 0.30, 0.05, 1.0, 1.0, 1.0]
    assert geom_omr._drop_extra_barlines(xs, scores) == [0.0, 100.0, 200.0, 300.0, 400.0]


def test_drop_extra_barlines_drops_cluster_of_false():
    # several false barlines bunched inside one real measure are all removed (iterates to convergence).
    xs = [0.0, 100.0, 115.0, 130.0, 200.0, 300.0]
    scores = [1.0, 1.0, 0.0, 0.0, 1.0, 1.0]
    assert geom_omr._drop_extra_barlines(xs, scores) == [0.0, 100.0, 200.0, 300.0]


# --- Wide-measure split: recover a faded barline (photo under-segmentation) ----------------
# _insert_missing_barlines splits a measure wider than _BAR_WIDE_FRAC x the system median at its
# strongest interior gap-crossing column, but only when that column crosses the gap about as strongly
# as the kept bars (self-calibrated) -- the inverse of _drop_extra_barlines. gcov is per-column gap
# darkness. These are pure (no image); they lock the geometry that lifted the liminality photo +0.179.

def _gcov(n, peaks, val=0.9):
    import numpy as np
    g = np.zeros(n, dtype=np.float32)
    for p in peaks:
        g[p] = val
    return g


def test_insert_missing_barlines_splits_wide_measure_at_strong_column():
    # bars at 0/100/200/400: the 200->400 gap is 2x the 100 median, and a strong gap-crossing column
    # sits at 300 (a faded real bar) -> it is recovered, restoring an even grid.
    xs = [0.0, 100.0, 200.0, 400.0]
    g = _gcov(450, [0, 100, 200, 300, 400])
    assert geom_omr._insert_missing_barlines(xs, g, sp=16.0) == [0.0, 100.0, 200.0, 300.0, 400.0]


def test_insert_missing_barlines_uniform_grid_unchanged():
    # no over-wide measure -> nothing inserted even with strong ink everywhere (strict never-worse).
    xs = [0.0, 100.0, 200.0, 300.0, 400.0]
    g = _gcov(450, list(range(0, 450, 5)))
    assert geom_omr._insert_missing_barlines(xs, g, sp=16.0) == xs


def test_insert_missing_barlines_no_strong_column_unchanged():
    # an over-wide measure whose interior has only WEAK gap darkness (0.3 < calibrated thr) is NOT
    # split -- the precision gate that stops photo clutter from fabricating a bar.
    xs = [0.0, 100.0, 200.0, 400.0]
    g = _gcov(450, [0, 100, 200, 400])
    g[300] = 0.3
    assert geom_omr._insert_missing_barlines(xs, g, sp=16.0) == xs


def test_insert_missing_barlines_splits_triple_wide_measure_twice():
    # a 3x-wide measure (200->500) with two faded bars at 300/400 is split at BOTH (iterates).
    xs = [0.0, 100.0, 200.0, 500.0]
    g = _gcov(560, [0, 100, 200, 300, 400, 500])
    assert geom_omr._insert_missing_barlines(xs, g, sp=16.0) == [0.0, 100.0, 200.0, 300.0, 400.0, 500.0]


def test_insert_missing_barlines_rejects_sustained_dark_band():
    # a slur / tie / hairpin / smudge sagging into the gap reads as a WIDE dark band (not a thin line).
    # It clears the gap-darkness threshold but the thinness gate rejects it -> NO false split.
    import numpy as np
    xs = [0.0, 100.0, 200.0, 400.0]
    g = _gcov(450, [0, 100, 200, 400])
    g[280:340] = 0.9  # a 60px continuous dark band inside the over-wide 200..400 measure
    assert geom_omr._insert_missing_barlines(xs, g, sp=16.0) == xs


def test_best_thin_barcol_picks_thin_over_band():
    import numpy as np
    seg = np.zeros(200, dtype=np.float32)
    seg[20:90] = 0.9   # a wide band (rejected)
    seg[150] = 0.8     # a thin bar (accepted)
    assert geom_omr._best_thin_barcol(seg, thr=0.5, maxw=10) == 150
    # band only -> nothing qualifies
    seg2 = np.zeros(200, dtype=np.float32); seg2[20:90] = 0.9
    assert geom_omr._best_thin_barcol(seg2, thr=0.5, maxw=10) is None


def test_insert_missing_barlines_none_gcov_and_degenerate_are_noops():
    assert geom_omr._insert_missing_barlines([0.0, 100.0, 400.0], None, sp=16.0) == [0.0, 100.0, 400.0]
    assert geom_omr._insert_missing_barlines([0.0], _gcov(10, [0]), sp=16.0) == [0.0]
    assert geom_omr._insert_missing_barlines([], None, sp=16.0) == []


def test_drop_extra_barlines_never_raises_on_degenerate():
    # robustness contract: too-few candidates, length mismatch, and empties all return the input.
    assert geom_omr._drop_extra_barlines([], []) == []
    assert geom_omr._drop_extra_barlines([1.0, 2.0], [0.0, 0.0]) == [1.0, 2.0]      # n < 3
    assert geom_omr._drop_extra_barlines([1.0, 2.0, 3.0], [0.0]) == [1.0, 2.0, 3.0]  # mismatch


@requires_geom
def test_detect_barlines_drops_non_gap_crossing_stack():
    # INTEGRATION: a dense chord/stem STACK that clears >70% of the pair height but is BLANK across
    # the inter-staff gap, sitting close to a real barline, must be filtered out while the real
    # uniformly-spaced barlines survive. This is the dense over-segmentation the fix targets.
    import numpy as np
    from PIL import Image, ImageDraw
    interline, top, gap = 16, 40, 64
    treble = [top + i * interline for i in range(5)]
    bass = [treble[-1] + gap + i * interline for i in range(5)]
    im = Image.new("L", (340, int(bass[-1] + 60)), 255)
    d = ImageDraw.Draw(im)
    for ly in treble + bass:
        d.line([(0, ly), (340, ly)], fill=0, width=2)
    for bx in (50, 150, 250):                                  # 3 real, uniform, gap-crossing barlines
        d.line([(bx, treble[0]), (bx, bass[-1])], fill=0, width=2)
    # a stack at x=170 (20px from the real barline at 150): dark over the treble and bass note rows
    # but BLANK across the inter-staff gap centre (it does not cross it, unlike a real barline).
    d.line([(170, treble[0]), (170, treble[-1] + 12)], fill=0, width=2)  # treble half of the stack
    d.line([(170, bass[0] - 12), (170, bass[-1])], fill=0, width=2)      # bass half of the stack
    gray = np.asarray(im, dtype=np.float32) / 255.0
    staves = geom_omr.detect_systems(gray)
    assert len(staves) == 2
    bl = geom_omr.detect_barlines(gray, staves)
    for bx in (50, 150, 250):
        assert any(abs(x - bx) <= 3 for x in bl[0]), f"real barline {bx} lost"
    assert not any(abs(x - 170) <= 6 for x in bl[0]), "non-gap-crossing stack not filtered"


# --- Grand-staff pairing by gap (robust to a missing staff): the photo decode hardening ---

class TestPairStaves:
    """_pair_staves groups detected staves into (treble, bass) pairs by VERTICAL gap, not index
    parity, so a staff lost mid-page no longer flips the clef of every staff below it."""

    @staticmethod
    def _staff(center, il=10.0):
        return [center - 2 * il + i * il for i in range(5)]  # 5 lines centred on `center`, interline il

    def test_clean_even_reduces_to_consecutive(self):
        # 3 fully-detected systems (intra gap 10 il, inter gap 26 il) MUST give the legacy
        # consecutive pairing, so the clean path is byte-identical to before.
        cs = [100, 200, 460, 560, 820, 920]
        staves = [self._staff(c) for c in cs]
        assert geom_omr._pair_staves(staves) == [(0, 1), (2, 3), (4, 5)]

    def test_missing_middle_staff_does_not_cascade(self):
        # T1 B1 | T2 (B2 lost) | T3 B3. Index parity (2i, 2i+1) would pair T2 with T3 -- both treble,
        # an octave + wrong-hand cascade for the rest of the page. Gap pairing keeps T2 lone and
        # re-pairs T3+B3 correctly.
        cs = [100, 200, 460, 720, 820]  # gaps: 100(intra), 260(inter), 260(inter), 100(intra)
        staves = [self._staff(c) for c in cs]
        assert geom_omr._pair_staves(staves) == [(0, 1), (2, None), (3, 4)]

    def test_lone_staff_at_end(self):
        cs = [100, 200, 460]  # T1 B1 | T2 (lone, its bass undetected)
        staves = [self._staff(c) for c in cs]
        assert geom_omr._pair_staves(staves) == [(0, 1), (2, None)]

    def test_never_raises_on_degenerate(self):
        assert geom_omr._pair_staves([]) == []
        assert isinstance(geom_omr._pair_staves([[1.0]]), list)  # one short staff -> no crash


@pytest.mark.skipif(not geom_omr.GEOM_AVAILABLE, reason="needs numpy/PIL")
def test_detect_barlines_skips_lone_staff_on_photo():
    # A LONE staff (grand-staff partner undetected) has no inter-staff gap, so a per-column dark scan
    # reads every STEM as a barline. On the PHOTO path detect_barlines must return NO barlines for it
    # (-> even binning) rather than over-segmenting on stems. On the clean/classical path (photo=False)
    # it keeps the legacy single-staff scan, so clean ODD-staff pages stay byte-identical.
    import numpy as np
    from PIL import Image, ImageDraw
    interline, top = 16, 40
    lines = [top + i * interline for i in range(5)]
    im = Image.new("L", (340, int(lines[-1] + 60)), 255)
    d = ImageDraw.Draw(im)
    for ly in lines:
        d.line([(0, ly), (340, ly)], fill=0, width=2)
    for sx in (60, 120, 180, 240):  # stems that would read as false barlines without the lone skip
        d.line([(sx, lines[0]), (sx, lines[-1])], fill=0, width=2)
    gray = np.asarray(im, dtype=np.float32) / 255.0
    staves = geom_omr.detect_systems(gray)
    assert len(staves) == 1
    assert geom_omr.detect_barlines(gray, staves, photo=True) == [[]]   # photo: skip the lone staff
    assert geom_omr.detect_barlines(gray, staves, photo=False)[0]       # clean: legacy scan (non-empty)


@pytest.mark.skipif(not geom_omr.GEOM_AVAILABLE, reason="needs numpy/PIL")
def test_detect_barlines_photo_recovers_faint_barline():
    # A FAINT / partial barline covering ~55% of the pair height is below the clean 0.70 coverage bar
    # but above the photo 0.45 bar: photo=False misses it (clean byte-identical), photo=True recovers
    # it (the camera under-segmentation fix). The two full barlines at 50/250 set the measure scale.
    import numpy as np
    from PIL import Image, ImageDraw
    interline, top, gap = 16, 40, 64
    treble = [top + i * interline for i in range(5)]
    bass = [treble[-1] + gap + i * interline for i in range(5)]
    y0, y1 = treble[0], bass[-1]
    im = Image.new("L", (340, int(y1 + 60)), 255)
    d = ImageDraw.Draw(im)
    for ly in treble + bass:
        d.line([(0, ly), (340, ly)], fill=0, width=2)
    for bx in (50, 250):
        d.line([(bx, y0), (bx, y1)], fill=0, width=2)        # full barlines
    d.line([(150, y0), (150, int(y0 + 0.55 * (y1 - y0)))], fill=0, width=2)  # ~55% coverage -> faint
    gray = np.asarray(im, dtype=np.float32) / 255.0
    staves = geom_omr.detect_systems(gray)
    assert len(staves) == 2
    clean = geom_omr.detect_barlines(gray, staves, photo=False)[0]
    photo = geom_omr.detect_barlines(gray, staves, photo=True)[0]
    assert not any(abs(x - 150) <= 4 for x in clean), "faint barline must be missed on the clean path"
    assert any(abs(x - 150) <= 4 for x in photo), "faint barline must be recovered on the photo path"


# --- Notehead-aware barline veto (X1): heads as side-information against dense stacks -------
# _veto_headed_barlines drops a NON-gap-crossing candidate with a detected notehead within
# _BAR_HEAD_VETO_IL interlines of its x (measured on dense CC0: 98.8% of measure-damaging false
# bars vs 0/504 true bars). It catches the over-segmentation _drop_extra_barlines cannot see:
# false bars that do not carve a narrow measure.


def test_veto_headed_barlines_drops_headed_weak():
    xs = [0.0, 100.0, 200.0, 300.0]
    scores = [1.0, 0.1, 1.0, 1.0]
    kx, ks = geom_omr._veto_headed_barlines(xs, scores, [104.0], sp=16.0)  # head 4px from x=100
    assert kx == [0.0, 200.0, 300.0]
    assert ks == [1.0, 1.0, 1.0]  # scores stay index-aligned with the survivors


def test_veto_headed_barlines_keeps_gap_crossing_even_with_head():
    # a REAL barline (gap-crossing) is never vetoed, even with a head right on its column.
    xs = [0.0, 100.0, 200.0]
    scores = [1.0, 0.9, 1.0]
    kx, ks = geom_omr._veto_headed_barlines(xs, scores, [100.0], sp=16.0)
    assert (kx, ks) == (xs, scores)


def test_veto_headed_barlines_keeps_weak_without_nearby_head():
    # the tctab analog: a weak (cluttered-gap) but REAL barline with no head within one interline
    # survives the veto; only _drop_extra_barlines' narrow-measure logic may ever judge it.
    xs = [0.0, 100.0, 200.0]
    scores = [1.0, 0.1, 1.0]
    kx, ks = geom_omr._veto_headed_barlines(xs, scores, [150.0], sp=16.0)
    assert (kx, ks) == (xs, scores)


def test_veto_headed_barlines_radius_is_one_interline():
    xs = [100.0]
    scores = [0.0]
    inside, _ = geom_omr._veto_headed_barlines(xs, scores, [116.0], sp=16.0)   # exactly 1.0 il
    outside, _ = geom_omr._veto_headed_barlines(xs, scores, [117.0], sp=16.0)  # just past it
    assert inside == [] and outside == xs


def test_veto_headed_barlines_degenerate_noops():
    assert geom_omr._veto_headed_barlines([], [], [1.0], 16.0) == ([], [])
    xs, scores = [1.0, 2.0], [0.0, 0.0]
    assert geom_omr._veto_headed_barlines(xs, scores, [], 16.0) == (xs, scores)    # no heads
    assert geom_omr._veto_headed_barlines(xs, scores, [1.0], 0.0) == (xs, scores)  # bad interline
    assert geom_omr._veto_headed_barlines(xs, scores, [1.0], -1.0) == (xs, scores)
    assert geom_omr._veto_headed_barlines(xs, [0.0], [1.0], 16.0) == (xs, [0.0])   # mismatch


@requires_geom
def test_detect_barlines_heads_veto_catches_evenly_spread_stacks():
    # INTEGRATION, the canon mechanism _drop_extra_barlines structurally CANNOT see: only 2 real
    # bars (fewer than 3 strong candidates), so its median-width scale falls back to ALL candidates
    # and the 3 evenly-spread stacks define the median themselves -> nothing is "too close" and
    # every stack SURVIVES the narrow-measure filter. With the stacks' noteheads passed as side
    # information the veto removes all 3; without heads the legacy output keeps them (locks that
    # the veto, not some other filter, is what catches this shape).
    import numpy as np
    from PIL import Image, ImageDraw
    interline, top, gap = 16, 40, 64
    treble = [top + i * interline for i in range(5)]
    bass = [treble[-1] + gap + i * interline for i in range(5)]
    im = Image.new("L", (400, int(bass[-1] + 60)), 255)
    d = ImageDraw.Draw(im)
    for ly in treble + bass:
        d.line([(0, ly), (400, ly)], fill=0, width=2)
    for bx in (40, 340):                                        # only 2 real, gap-crossing bars
        d.line([(bx, treble[0]), (bx, bass[-1])], fill=0, width=2)
    stacks = (115, 190, 265)                                    # evenly spread inside the measure
    for sx in stacks:
        d.line([(sx, treble[0]), (sx, treble[-1] + 12)], fill=0, width=2)
        d.line([(sx, bass[0] - 12), (sx, bass[-1])], fill=0, width=2)
    gray = np.asarray(im, dtype=np.float32) / 255.0
    staves = geom_omr.detect_systems(gray)
    assert len(staves) == 2
    legacy = geom_omr.detect_barlines(gray, staves)
    assert sum(1 for sx in stacks if any(abs(x - sx) <= 6 for x in legacy[0])) == 3, \
        "precondition: the narrow-measure filter alone must NOT catch these stacks"
    heads = [[(float(sx), float(treble[2])) for sx in stacks],
             [(float(sx), float(bass[2])) for sx in stacks]]
    vetoed = geom_omr.detect_barlines(gray, staves, heads=heads)
    for bx in (40, 340):
        assert any(abs(x - bx) <= 3 for x in vetoed[0]), f"real barline {bx} lost"
    assert not any(any(abs(x - sx) <= 6 for x in vetoed[0]) for sx in stacks), \
        "headed stacks must be vetoed"


@requires_geom
def test_decode_passes_heads_to_detect_barlines(monkeypatch):
    # the shared decode tail forwards per_staff_heads as the veto's side information.
    seen = {}
    real = geom_omr.detect_barlines

    def spy(gray, staves, normalize_illum=True, photo=False, heads=None):
        seen["heads"] = heads
        return real(gray, staves, normalize_illum=normalize_illum, photo=photo, heads=heads)

    monkeypatch.setattr(geom_omr, "detect_barlines", spy)
    xs = [40, 140, 240, 340]
    gray, treble, bass = _draw_grand_staff_with_barlines(xs)
    staves = geom_omr.detect_systems(gray)
    per_staff = [[(90.0, treble[2])], [(90.0, bass[2])]]
    out = geom_omr._decode_staves_to_musicxml(staves, per_staff, gray=gray)
    assert out is not None
    assert seen["heads"] is per_staff


@requires_geom
def test_detect_barlines_photo_path_skips_head_veto():
    # PHOTO scope-out: dewarp jitter puts detected heads near genuinely faint real bars (measured:
    # the veto on the photo path cost the tctab photo -0.024), so heads are IGNORED when photo=True
    # and the photo output is byte-identical with or without them.
    import numpy as np
    from PIL import Image, ImageDraw
    interline, top, gap = 16, 40, 64
    treble = [top + i * interline for i in range(5)]
    bass = [treble[-1] + gap + i * interline for i in range(5)]
    im = Image.new("L", (400, int(bass[-1] + 60)), 255)
    d = ImageDraw.Draw(im)
    for ly in treble + bass:
        d.line([(0, ly), (400, ly)], fill=0, width=2)
    for bx in (40, 340):
        d.line([(bx, treble[0]), (bx, bass[-1])], fill=0, width=2)
    stacks = (115, 190, 265)
    for sx in stacks:
        d.line([(sx, treble[0]), (sx, treble[-1] + 12)], fill=0, width=2)
        d.line([(sx, bass[0] - 12), (sx, bass[-1])], fill=0, width=2)
    gray = np.asarray(im, dtype=np.float32) / 255.0
    staves = geom_omr.detect_systems(gray)
    assert len(staves) == 2
    heads = [[(float(sx), float(treble[2])) for sx in stacks],
             [(float(sx), float(bass[2])) for sx in stacks]]
    with_heads = geom_omr.detect_barlines(gray, staves, photo=True, heads=heads)
    without = geom_omr.detect_barlines(gray, staves, photo=True)
    assert with_heads == without  # heads change NOTHING on the photo path
