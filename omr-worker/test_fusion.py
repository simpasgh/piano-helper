#!/usr/bin/env python3
"""Tests for fusion.fuse (geom pitch + Clarity rhythm). Pure stdlib, runs anywhere the worker deps
(reconcile/omr_eval/llm_omr) import. Build both engines' inputs with the tested llm_omr builder so
the fixtures are always well-formed."""
import fusion
import llm_omr
import omr_eval
import reconcile


def _xml(measures, divisions=4):
    return llm_omr.score_json_to_musicxml(
        {"divisions": divisions, "time": {"beats": 4, "beat_type": 4}, "measures": measures})


def _durs(xml):
    return sorted(omr_eval._dur16(e.duration, e.base) for e in reconcile.to_events(xml, "x"))


def _midis(xml):
    return sorted(reconcile._pitch_to_midi(e.pitch) for e in reconcile.to_events(xml, "x")
                  if e.pitch is not None)


def test_fuse_keeps_geom_pitch_borrows_clarity_duration():
    # geom: pitches right, durations all the placeholder 1; clarity: same pitches, real durations.
    geom = _xml([{"staff1": [{"duration": 1, "pitches": [{"step": "C", "octave": 5}]},
                             {"duration": 1, "pitches": [{"step": "D", "octave": 5}]}], "staff2": []}])
    clarity = _xml([{"staff1": [{"duration": 4, "pitches": [{"step": "C", "octave": 5}]},
                                {"duration": 8, "pitches": [{"step": "D", "octave": 5}]}], "staff2": []}])
    fused = fusion.fuse(geom, clarity)
    assert _midis(fused) == [72, 74]      # pitches preserved from geom (C5, D5)
    assert _durs(fused) == [4, 8]         # durations borrowed from clarity (quarter, half)


def test_fuse_aligns_by_pitch_class_when_geom_octave_differs():
    # geom read D one octave higher than clarity; pitch-class alignment must still match them so the
    # duration is borrowed onto geom's (kept) octave.
    geom = _xml([{"staff1": [{"duration": 1, "pitches": [{"step": "C", "octave": 5}]},
                             {"duration": 1, "pitches": [{"step": "D", "octave": 6}]}], "staff2": []}])
    clarity = _xml([{"staff1": [{"duration": 2, "pitches": [{"step": "C", "octave": 5}]},
                                {"duration": 8, "pitches": [{"step": "D", "octave": 5}]}], "staff2": []}])
    fused = fusion.fuse(geom, clarity)
    assert _midis(fused) == [72, 86]      # geom's octaves kept (C5=72, D6=86)
    assert _durs(fused) == [2, 8]         # both still borrow their clarity duration


def test_fuse_unmatched_geom_chord_keeps_quarter_fallback():
    # geom has an extra note clarity missed; matched notes borrow, the extra keeps a quarter.
    geom = _xml([{"staff1": [{"duration": 1, "pitches": [{"step": "C", "octave": 5}]},
                             {"duration": 1, "pitches": [{"step": "E", "octave": 5}]},
                             {"duration": 1, "pitches": [{"step": "G", "octave": 5}]}], "staff2": []}])
    clarity = _xml([{"staff1": [{"duration": 2, "pitches": [{"step": "C", "octave": 5}]},
                                {"duration": 2, "pitches": [{"step": "G", "octave": 5}]}], "staff2": []}])
    fused = fusion.fuse(geom, clarity)
    assert _durs(fused) == [2, 2, 4]      # C,G borrow eighth; E (unmatched) -> quarter fallback


def test_fuse_preserves_chords():
    # a 2-note chord in geom borrows one duration and stays a chord.
    geom = _xml([{"staff1": [], "staff2": [
        {"duration": 1, "pitches": [{"step": "C", "octave": 3}, {"step": "E", "octave": 3}]}]}])
    clarity = _xml([{"staff1": [], "staff2": [
        {"duration": 8, "pitches": [{"step": "C", "octave": 3}, {"step": "E", "octave": 3}]}]}])
    fused = fusion.fuse(geom, clarity)
    assert _midis(fused) == [48, 52]      # C3, E3
    assert _durs(fused) == [8, 8]         # the chord's two notes share the borrowed half-note


class TestNeverRaises:
    def test_both_none(self):
        assert fusion.fuse(None, None) is None

    def test_no_clarity_returns_geom_unchanged(self):
        geom = _xml([{"staff1": [{"duration": 1, "pitches": [{"step": "C", "octave": 5}]}], "staff2": []}])
        assert fusion.fuse(geom, None) == geom

    def test_unparseable_clarity_returns_geom(self):
        geom = _xml([{"staff1": [{"duration": 1, "pitches": [{"step": "C", "octave": 5}]}], "staff2": []}])
        assert fusion.fuse(geom, b"<not xml") == geom

    def test_no_geom_returns_clarity(self):
        clarity = _xml([{"staff1": [{"duration": 4, "pitches": [{"step": "C", "octave": 5}]}], "staff2": []}])
        assert fusion.fuse(None, clarity) == clarity

    def test_garbage_geom_falls_back_to_clarity(self):
        clarity = _xml([{"staff1": [{"duration": 4, "pitches": [{"step": "C", "octave": 5}]}], "staff2": []}])
        assert fusion.fuse(b"<not xml", clarity) == clarity


def test_nw_alignment_basic():
    # direct check of the aligner: [C,E,G] vs [C,G] matches positions 0->0 and 2->1.
    C, E, G = frozenset({0}), frozenset({4}), frozenset({7})
    assert fusion._nw([C, E, G], [C, G]) == [(0, 0), (2, 1)]
