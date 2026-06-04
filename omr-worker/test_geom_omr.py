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
