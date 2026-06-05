#!/usr/bin/env python3
"""Tests for the FULL-SYMBOL decode (geom_omr.decode_symbols_to_musicxml + helpers): reading
durations, key signature, per-note accidentals, clefs, and rests FROM the detected glyph boxes.

All PURE: they build synthetic glyph boxes (class_idx, x, y, w, h) by hand and assert the decoded
MusicXML, with gray=None so no numpy/verovio/torch/GPU is needed (decode_pitch, the geometry
helpers, the segmenter, and the MusicXML builder are all pure). This locks the duration/key/
accidental/clef geometry the trained detector feeds, independent of the detector itself."""

import geom_omr


def test_taxonomy_matches_single_source_of_truth():
    # geom_omr decodes the detector's class INDICES via CLASS_NAMES, which MUST equal the taxonomy
    # the dataset is labeled with (synth_render.CLASS_NAMES, the roadmap's single source of truth),
    # or every class index would be misread. This guards against drift between the two.
    import synth_render
    assert geom_omr.CLASS_NAMES == synth_render.CLASS_NAMES


def C(name):
    """Class index for a taxonomy name (the engine's own copy of the shared taxonomy)."""
    return geom_omr.CLASS_NAMES.index(name)


def box(name, cx, cy, w=16.0, h=16.0, conf=0.9):
    """A detected symbol (cls, x_topleft, y_topleft, w, h, conf) centered at (cx, cy)."""
    return (C(name), cx - w / 2.0, cy - h / 2.0, w, h, conf)


# Treble staff: lines 100..180 (interline 20), bottom line 180 == E4. Bass: 300..380, bottom == G2.
TREBLE = [100.0, 120.0, 140.0, 160.0, 180.0]
BASS = [300.0, 320.0, 340.0, 360.0, 380.0]


# --- decode_note_duration (pure mapping) -------------------------------------------------

class TestDecodeNoteDuration:
    def test_quarter(self):
        assert geom_omr.decode_note_duration(filled=True, has_stem=True) == ("quarter", 0, 4)

    def test_eighth_from_one_beam(self):
        assert geom_omr.decode_note_duration(True, True, n_beams=1) == ("eighth", 0, 2)

    def test_eighth_from_one_flag(self):
        assert geom_omr.decode_note_duration(True, True, n_flags=1) == ("eighth", 0, 2)

    def test_sixteenth_from_two_beams(self):
        assert geom_omr.decode_note_duration(True, True, n_beams=2) == ("16th", 0, 1)

    def test_subdivision_uses_max_of_beam_and_flag(self):
        assert geom_omr.decode_note_duration(True, True, n_beams=1, n_flags=2) == ("16th", 0, 1)

    def test_half_is_open_with_stem(self):
        assert geom_omr.decode_note_duration(filled=False, has_stem=True) == ("half", 0, 8)

    def test_whole_is_open_no_stem(self):
        assert geom_omr.decode_note_duration(filled=False, has_stem=False) == ("whole", 0, 16)

    def test_dotted_quarter(self):
        assert geom_omr.decode_note_duration(True, True, n_dots=1) == ("quarter", 1, 6)

    def test_dotted_eighth(self):
        assert geom_omr.decode_note_duration(True, True, n_beams=1, n_dots=1) == ("eighth", 1, 3)

    def test_double_dotted_half(self):
        assert geom_omr.decode_note_duration(False, True, n_dots=2) == ("half", 2, 14)

    def test_32nd_clamps_to_sixteenth_ticks(self):
        # level 3 names 32nd but divisions=4 cannot hold 0.5 ticks, so ticks clamp to a 16th (1).
        name, dots, ticks = geom_omr.decode_note_duration(True, True, n_beams=3)
        assert (name, dots, ticks) == ("32nd", 0, 1)

    def test_never_raises_on_garbage(self):
        assert geom_omr.decode_note_duration("x", None, n_beams="y") == ("quarter", 0, 4)


# --- key-signature detection -------------------------------------------------------------

def _empty_syms():
    return {name: [] for name in geom_omr.CLASS_NAMES}


def _xywh(cx, cy, w=16.0, h=16.0):
    return (cx - w / 2.0, cy - h / 2.0, w, h)


class TestDetectKeyFifths:
    def test_two_sharps(self):
        syms = _empty_syms()
        syms["clef_g"] = [_xywh(15, 140, 20, 60)]
        syms["accidental_sharp"] = [_xywh(46, 140, 12, 22), _xywh(66, 140, 12, 22)]
        syms["timesig"] = [_xywh(95, 140, 10, 40)]
        syms["notehead_filled"] = [_xywh(200, 160)]
        clefs = geom_omr._staff_clefs(syms)
        assert geom_omr._detect_key_fifths(syms, clefs, 20.0) == 2

    def test_three_flats(self):
        syms = _empty_syms()
        syms["clef_g"] = [_xywh(15, 140, 20, 60)]
        syms["accidental_flat"] = [_xywh(46, 140, 12, 22), _xywh(64, 140, 12, 22),
                                   _xywh(82, 140, 12, 22)]
        syms["timesig"] = [_xywh(110, 140, 10, 40)]
        syms["notehead_filled"] = [_xywh(220, 160)]
        clefs = geom_omr._staff_clefs(syms)
        assert geom_omr._detect_key_fifths(syms, clefs, 20.0) == -3

    def test_c_major_no_accidentals(self):
        syms = _empty_syms()
        syms["clef_g"] = [_xywh(15, 140, 20, 60)]
        syms["notehead_filled"] = [_xywh(120, 160)]
        clefs = geom_omr._staff_clefs(syms)
        assert geom_omr._detect_key_fifths(syms, clefs, 20.0) == 0

    def test_inline_accidental_after_timesig_not_counted_as_key(self):
        # a sharp glyph RIGHT of the time signature (inline on a note) must not inflate the key.
        syms = _empty_syms()
        syms["clef_g"] = [_xywh(15, 140, 20, 60)]
        syms["accidental_sharp"] = [_xywh(46, 140, 12, 22),    # key sig (before timesig)
                                    _xywh(190, 160, 12, 22)]   # inline on the note (after timesig)
        syms["timesig"] = [_xywh(95, 140, 10, 40)]
        syms["notehead_filled"] = [_xywh(210, 160)]
        clefs = geom_omr._staff_clefs(syms)
        assert geom_omr._detect_key_fifths(syms, clefs, 20.0) == 1

    def test_no_clef_returns_none(self):
        syms = _empty_syms()
        syms["notehead_filled"] = [_xywh(120, 160)]
        assert geom_omr._detect_key_fifths(syms, [], 20.0) is None


# --- end-to-end decode_symbols_to_musicxml (pure; gray=None) -----------------------------

class TestDecodeSymbolsToMusicxml:
    def test_pitch_key_duration_and_clefs(self):
        # treble: F4 head (y=170) + stem + one beam, in a 1-sharp key -> F#4 eighth.
        # bass:   open head, no stem, at y=360 (B2) -> whole note.
        symbols = [
            box("clef_g", 15, 140, 20, 60),
            box("clef_f", 15, 330, 20, 50),
            box("accidental_sharp", 45, 140, 12, 22),       # key signature: 1 sharp
            box("notehead_filled", 200, 170),               # F4
            box("stem", 207, 150, 3, 40),                   # stem up from the head
            box("beam", 207, 131, 40, 6),                   # one beam over the stem -> eighth
            box("notehead_open", 200, 360),                 # B2, open + no stem -> whole
        ]
        out = geom_omr.decode_symbols_to_musicxml([TREBLE, BASS], symbols, key_fifths=None)
        assert out is not None
        assert b"<fifths>1</fifths>" in out
        assert b"<step>F</step>" in out and b"<alter>1</alter>" in out
        assert b"<type>eighth</type>" in out
        assert b"<type>whole</type>" in out
        assert b"<sign>G</sign>" in out and b"<sign>F</sign>" in out

    def test_inline_accidental_overrides_key(self):
        # G major (1 sharp) sharps F; an explicit NATURAL glyph just left of an F head makes it
        # F-natural (alter 0) for that note, overriding the key, and engraves a <natural>.
        symbols = [
            box("clef_g", 15, 140, 20, 60),
            box("accidental_sharp", 45, 140, 12, 22),       # key sig -> fifths 1
            box("accidental_natural", 235, 170, 12, 22),    # inline, just left of the F head
            box("notehead_filled", 260, 170),               # F4, stem-less -> quarter
        ]
        out = geom_omr.decode_symbols_to_musicxml([TREBLE], symbols, key_fifths=None)
        assert out is not None
        assert b"<step>F</step>" in out
        assert b"<alter>1</alter>" not in out          # the key sharp was overridden
        assert b"<accidental>natural</accidental>" in out

    def test_clef_detected_not_assumed_by_index(self):
        # a BASS clef on the FIRST (index-0) staff: the note on the bottom line must decode as G2
        # (F clef), NOT E4 (the old treble-by-index assumption).
        symbols = [
            box("clef_f", 15, 340, 20, 50),
            box("notehead_filled", 200, 380),   # bottom line; F clef -> G2
        ]
        out = geom_omr.decode_symbols_to_musicxml([BASS], symbols, key_fifths=0)
        assert out is not None
        assert b"<step>G</step>" in out and b"<octave>2</octave>" in out
        assert b"<sign>F</sign>" in out

    def test_clefless_bass_staff_decodes_as_bass_not_treble(self):
        # the detector MISSED the bass clef glyph. The bass note on the bottom line must still
        # decode as G2 (F clef, the by-index fallback the output is labeled with), NOT E4 (treble):
        # the clef-less default_sign must match the printed clef so pitch and label cannot desync.
        symbols = [
            box("clef_g", 15, 140, 20, 60),     # treble clef present
            box("notehead_filled", 200, 180),   # treble bottom line -> E4
            box("notehead_filled", 200, 380),   # bass bottom line, NO bass clef glyph -> must be G2
        ]
        out = geom_omr.decode_symbols_to_musicxml([TREBLE, BASS], symbols, key_fifths=0)
        assert out is not None
        assert b"<sign>F</sign>" in out                              # labeled bass (by index)
        assert b"<step>G</step>" in out and b"<octave>2</octave>" in out  # and DECODED as bass

    def test_rest_glyph_emitted(self):
        symbols = [
            box("clef_g", 15, 140, 20, 60),
            box("notehead_filled", 120, 160),   # a note so the score is non-empty
            box("rest", 220, 140, 14, 28),       # a rest glyph
        ]
        out = geom_omr.decode_symbols_to_musicxml([TREBLE], symbols, key_fifths=0)
        assert out is not None
        assert b"<rest" in out

    def test_two_beams_make_a_sixteenth(self):
        symbols = [
            box("clef_g", 15, 140, 20, 60),
            box("notehead_filled", 200, 160),
            box("stem", 207, 130, 3, 36),
            box("beam", 207, 131, 36, 5),   # primary beam
            box("beam", 207, 138, 36, 5),   # secondary beam stacked below -> 16th
        ]
        out = geom_omr.decode_symbols_to_musicxml([TREBLE], symbols, key_fifths=0)
        assert out is not None
        assert b"<type>16th</type>" in out

    def test_beamed_eighth_without_a_detected_stem_still_reads_eighth(self):
        # The trained `stem` class detects poorly (~20-30% of beamed heads), so the duration decode
        # must associate a beam by the notehead's x-COLUMN, not via the stem. A filled head with a
        # beam in its column and NO stem box must still read eighth, not fall back to quarter.
        symbols = [
            box("clef_g", 15, 140, 20, 60),
            box("notehead_filled", 200, 170),   # filled head, no stem detected
            box("beam", 195, 140, 30, 6),        # a beam ~1.5 interlines above, in the head column
        ]
        out = geom_omr.decode_symbols_to_musicxml([TREBLE], symbols, key_fifths=0)
        assert out is not None
        assert b"<type>eighth</type>" in out
        assert b"<type>quarter</type>" not in out

    def test_chord_stacks_pitches_with_shared_duration(self):
        # two heads at the same x (a chord) share one stem -> one event, two <pitch>, one <chord/>.
        symbols = [
            box("clef_g", 15, 140, 20, 60),
            box("notehead_filled", 200, 180),   # E4
            box("notehead_filled", 201, 160),   # G4 (same x cluster)
            box("stem", 207, 130, 3, 52),
        ]
        out = geom_omr.decode_symbols_to_musicxml([TREBLE], symbols, key_fifths=0)
        assert out is not None
        assert b"<chord" in out
        assert b"<step>E</step>" in out and b"<step>G</step>" in out

    def test_pairs_grand_staves_by_gap_not_index(self):
        # A dropped MIDDLE staff (the real-photo case _pair_staves fixes): the page is
        # treble1 / [bass1 missing] / treble2 / bass2, detected as 3 staves. Index parity would pair
        # (0,1) = (treble1, treble2) and read treble2 (and everything below) under the WRONG clef.
        # _pair_staves groups by vertical gap: staff 0 is a lone treble (a big system gap sits below
        # it) and staves 1+2 are the surviving pair, so the bottom staff decodes under the F clef
        # (G2 on its bottom line), not treble (E4 by index).
        s0 = [100.0, 120.0, 140.0, 160.0, 180.0]   # lone treble; ~20-interline gap to the next system
        s1 = [500.0, 520.0, 540.0, 560.0, 580.0]   # treble of the surviving pair
        s2 = [620.0, 640.0, 660.0, 680.0, 700.0]   # bass of the pair (only ~6 interlines below s1)
        symbols = [box("notehead_filled", 200, 700)]   # on s2's bottom line, NO clef glyph
        out = geom_omr.decode_symbols_to_musicxml([s0, s1, s2], symbols, key_fifths=0)
        assert out is not None
        assert b"<step>G</step>" in out and b"<octave>2</octave>" in out  # bass-decoded (paired by gap)
        assert b"<sign>F</sign>" in out                                   # and labeled bass
        assert b"<step>E</step>" not in out                              # NOT the treble-by-index misread


class TestSegmentEventsToMeasuresClefChange:
    def test_mid_score_clef_change_sets_measure_clef(self):
        # treble events in 3 bars (barlines at 0/100/200/300); a clef change to F at x=150 (bar 2)
        # must set that measure's <clef number=1 sign=F>.
        treble = [(50.0, {"duration": 4, "pitches": [{"step": "C", "alter": 0, "octave": 5}]}),
                  (150.0, {"duration": 4, "pitches": [{"step": "D", "alter": 0, "octave": 5}]}),
                  (250.0, {"duration": 4, "pitches": [{"step": "E", "alter": 0, "octave": 5}]})]
        measures = geom_omr._segment_events_to_measures(
            treble, [], [0.0, 100.0, 200.0, 300.0], t_changes=[(150.0, "F")], b_changes=[])
        assert len(measures) == 3
        assert "clefs" not in measures[0]
        assert measures[1]["clefs"] == [{"number": 1, "sign": "F", "line": 4}]


# --- photo flag threading ----------------------------------------------------------------

def test_decode_symbols_forwards_photo_to_detect_barlines(monkeypatch):
    # decode_symbols_to_musicxml threads its photo flag into detect_barlines so the full-symbol path
    # picks up the photo-tolerant barline-coverage threshold on the dewarp path, exactly like the
    # notehead-only _decode_staves_to_musicxml. gray is a non-None sentinel (the stub ignores it) and
    # the head is FILLED so the only gray consumer (_has_stem_cv, the open-head probe) is never
    # reached, keeping the test pure (no numpy).
    captured = {}

    def fake_barlines(gray, staves, normalize_illum=True, photo=False):
        captured["photo"] = photo
        return [[] for _ in staves]

    monkeypatch.setattr(geom_omr, "detect_barlines", fake_barlines)
    symbols = [box("clef_g", 15, 140, 20, 60), box("notehead_filled", 200, 160)]

    geom_omr.decode_symbols_to_musicxml([TREBLE], symbols, key_fifths=0, gray="sentinel", photo=True)
    assert captured == {"photo": True}
    captured.clear()
    geom_omr.decode_symbols_to_musicxml([TREBLE], symbols, key_fifths=0, gray="sentinel")  # default
    assert captured == {"photo": False}


# --- never-raise (robustness contract) ---------------------------------------------------

class TestNeverRaises:
    def test_none_inputs(self):
        assert geom_omr.decode_symbols_to_musicxml(None, None) is None

    def test_empty_symbols(self):
        assert geom_omr.decode_symbols_to_musicxml([TREBLE], []) is None

    def test_garbage_symbols(self):
        assert geom_omr.decode_symbols_to_musicxml([TREBLE], ["not-a-box", (999,), None]) is None

    def test_degenerate_staff(self):
        assert geom_omr.decode_symbols_to_musicxml([[10.0]], [box("notehead_filled", 5, 5)]) is None

    def test_assign_symbols_never_raises(self):
        assert geom_omr._assign_symbols_to_staves(["junk", None], [TREBLE]) == [
            {name: [] for name in geom_omr.CLASS_NAMES}]
