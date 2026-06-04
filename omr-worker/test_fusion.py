#!/usr/bin/env python3
"""Tests for fusion.fuse (geom pitch + Clarity rhythm). Pure stdlib, runs anywhere the worker deps
(reconcile/omr_eval/llm_omr) import. Build both engines' inputs with the tested llm_omr builder so
the fixtures are always well-formed."""
import xml.etree.ElementTree as ET

import fusion
import llm_omr
import omr_eval
import reconcile


def _xml(measures, divisions=4, time=None):
    return llm_omr.score_json_to_musicxml(
        {"divisions": divisions, "time": time or {"beats": 4, "beat_type": 4}, "measures": measures})


def _durs(xml):
    return sorted(omr_eval._dur16(e.duration, e.base) for e in reconcile.to_events(xml, "x"))


def _midis(xml):
    return sorted(reconcile._pitch_to_midi(e.pitch) for e in reconcile.to_events(xml, "x")
                  if e.pitch is not None)


def _time(xml):
    """The (beats, beat-type) text of the fused document's first <time>, or None if it has none.
    Read straight from the XML (independent of fusion._read_time) so the assertion proves what the
    document declares, and returns None rather than raising so a no-<time> regression fails with a
    readable meter mismatch instead of an AttributeError."""
    t = ET.fromstring(xml).find(".//time")
    return (t.findtext("beats"), t.findtext("beat-type")) if t is not None else None


def _strip_time(xml):
    """Remove every <time> element so the input declares no meter (exercises the 4/4 fallback)."""
    root = ET.fromstring(xml)
    for attrs in root.iter("attributes"):
        for t in attrs.findall("time"):
            attrs.remove(t)
    return ET.tostring(root, encoding="utf-8", xml_declaration=True)


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
    # geom has an extra note clarity missed; matched notes borrow, the extra keeps a quarter. Here the
    # matched borrows (two eighths = 4 sixteenths) leave 12 of the 16-cap bar free, so the unmatched
    # chord still takes a full quarter (room >= a quarter): the capacity clamp is a no-op here.
    geom = _xml([{"staff1": [{"duration": 1, "pitches": [{"step": "C", "octave": 5}]},
                             {"duration": 1, "pitches": [{"step": "E", "octave": 5}]},
                             {"duration": 1, "pitches": [{"step": "G", "octave": 5}]}], "staff2": []}])
    clarity = _xml([{"staff1": [{"duration": 2, "pitches": [{"step": "C", "octave": 5}]},
                                {"duration": 2, "pitches": [{"step": "G", "octave": 5}]}], "staff2": []}])
    fused = fusion.fuse(geom, clarity)
    assert _durs(fused) == [2, 2, 4]      # C,G borrow eighth; E (unmatched) -> quarter fallback


def test_fuse_unmatched_chord_clamps_to_remaining_bar_room():
    # ROOT-CAUSE FIX (reverie m17 / tctab over-read). geom reads a half + four short notes (the
    # screenshot's "La" + "Do Si Do Si"); Clarity read the same bar but ordered the four shorts
    # differently (C B B C vs geom's C B C B), so geom's LAST short fails to align to any Clarity
    # chord. The matched borrows already fill 8 + 2 + 2 + 2 = 14 of the 16-sixteenth (4/4) bar, so a
    # blind quarter (4) on the unmatched note would sum the bar to 18 == 4.5 beats (the bug). The
    # capacity clamp gives the unmatched note clamp(room=2, 1, 4) = an eighth, so the bar sums to 16.
    geom = _xml([{"staff1": [
        {"duration": 1, "pitches": [{"step": "A", "octave": 4}]},   # half "La"
        {"duration": 1, "pitches": [{"step": "C", "octave": 6}]},   # "Do"
        {"duration": 1, "pitches": [{"step": "B", "octave": 5}]},   # "Si"
        {"duration": 1, "pitches": [{"step": "C", "octave": 6}]},   # "Do"
        {"duration": 1, "pitches": [{"step": "B", "octave": 5}]},   # "Si" (the one that fails to align)
    ], "staff2": []}])
    clarity = _xml([{"staff1": [
        {"duration": 8, "pitches": [{"step": "A", "octave": 4}]},   # half
        {"duration": 2, "pitches": [{"step": "C", "octave": 6}]},   # eighth
        {"duration": 2, "pitches": [{"step": "B", "octave": 5}]},   # eighth
        {"duration": 2, "pitches": [{"step": "B", "octave": 5}]},   # eighth (re-ordered vs geom)
        {"duration": 2, "pitches": [{"step": "C", "octave": 6}]},   # eighth (re-ordered vs geom)
    ], "staff2": []}])
    fused = fusion.fuse(geom, clarity)
    assert _midis(fused) == [69, 83, 83, 84, 84]   # geom's pitches preserved (A4 + C6/B5 x2)
    assert sum(_durs(fused)) == 16                  # the bar is metrically whole, NOT 18 (4.5 beats)
    # the unmatched short note took an eighth (room), not the old blind quarter
    assert _durs(fused) == [2, 2, 2, 2, 8]


def test_fuse_unmatched_chord_floors_to_a_sixteenth_when_bar_already_full():
    # When the matched borrows ALONE already fill (or overfill) the bar, an unmatched geom chord still
    # must keep a positive duration (a dropped notehead would regress geom's pitch edge), so it floors
    # to ONE sixteenth -- the least it can add -- rather than the blind quarter that would overfill
    # harder. geom: two notes; Clarity matches only the first and gives it a whole note (16 = the full
    # bar). The unmatched second note gets a sixteenth, not a quarter.
    geom = _xml([{"staff1": [{"duration": 1, "pitches": [{"step": "C", "octave": 5}]},
                             {"duration": 1, "pitches": [{"step": "E", "octave": 5}]}], "staff2": []}])
    clarity = _xml([{"staff1": [{"duration": 16, "pitches": [{"step": "C", "octave": 5}]}],
                     "staff2": []}])
    fused = fusion.fuse(geom, clarity)
    assert _midis(fused) == [72, 76]    # both geom pitches kept (C5, E5)
    assert _durs(fused) == [1, 16]      # unmatched E5 floors to a sixteenth (was a quarter), C5 whole


def test_fuse_lone_unmatched_chord_fills_the_bar_as_a_held_note():
    # ROOT-CAUSE FIX (reverie bass m4/m6/m8). geom reads a held whole-note bass triad as the SOLE
    # onset of its (measure, staff) voice; it fails pitch-class alignment to any Clarity chord (here
    # Clarity read nothing in that hand), so it is UNMATCHED. The OLD fallback capped it at a quarter
    # and rhythm_repair then padded a dotted-half rest -> the user's "1/4 note + 3/4 pause" symptom.
    # A lone unmatched onset is a HELD note (geom detects no rests), so it must FILL the 4/4 bar.
    geom = _xml([{"staff1": [], "staff2": [
        {"duration": 1, "pitches": [{"step": "G", "octave": 2},
                                    {"step": "B", "octave": 2},
                                    {"step": "D", "octave": 3}]}]}])
    clarity = _xml([{"staff1": [{"duration": 4, "pitches": [{"step": "C", "octave": 5}]}], "staff2": []}])
    fused = fusion.fuse(geom, clarity)
    assert _midis(fused) == [43, 47, 50]   # geom's bass triad preserved (G2, B2, D3)
    assert _durs(fused) == [16, 16, 16]    # the lone unmatched chord FILLS the 4/4 bar (whole), not a quarter
    # and the bar is metrically whole, so rhythm_repair leaves it alone (no padded dotted-half rest).
    assert sum(_durs(fused)) == 48         # three whole notes, one per voice-note, each the full 16-cap bar


def test_fuse_lone_unmatched_chord_fills_non_4_4_bar_to_capacity():
    # The fill is the bar's CAPACITY, not a hardcoded whole note: in 2/4 (capacity 8) a lone unmatched
    # held chord fills to a HALF note (8), so it stays inside the meter (liminality m8 staff2). This is
    # what makes the held-note fill safe on a non-4/4 piece.
    geom = _xml([{"staff1": [], "staff2": [{"duration": 1, "pitches": [{"step": "G", "octave": 2}]}]}],
                time={"beats": 2, "beat_type": 4})
    clarity = _xml([{"staff1": [{"duration": 4, "pitches": [{"step": "C", "octave": 5}]}], "staff2": []}],
                   time={"beats": 2, "beat_type": 4})
    fused = fusion.fuse(geom, clarity)
    assert _time(fused) == ("2", "4")
    assert _midis(fused) == [43]           # geom's bass note preserved (G2)
    assert _durs(fused) == [8]             # fills the 2/4 bar to a half note (capacity 8), not a whole


def test_fuse_clamp_respects_non_4_4_capacity():
    # The clamp reads the resolved meter's capacity, so it sizes the fallback to a NON-4/4 bar too.
    # 2/4 (capacity 8 sixteenths): a matched quarter (4) leaves 4 of room, and the unmatched chord
    # takes clamp(4, 1, 4) = a quarter, filling the 2/4 bar exactly (not overfilling past 8).
    geom = _xml([{"staff1": [{"duration": 1, "pitches": [{"step": "C", "octave": 5}]},
                             {"duration": 1, "pitches": [{"step": "G", "octave": 5}]}], "staff2": []}],
                time={"beats": 2, "beat_type": 4})
    clarity = _xml([{"staff1": [{"duration": 4, "pitches": [{"step": "C", "octave": 5}]}], "staff2": []}],
                   time={"beats": 2, "beat_type": 4})
    fused = fusion.fuse(geom, clarity)
    assert _time(fused) == ("2", "4")
    assert sum(_durs(fused)) == 8       # quarter (borrowed) + quarter (clamped) == the 2/4 bar
    assert _durs(fused) == [4, 4]


def test_bar_fallback_durs_unit():
    # Direct unit on the pure sizer. A LONE unmatched chord (the bar's ONLY onset) FILLS the bar (a
    # held note = the capacity). With >= 2 onsets, each unmatched chord instead takes clamp(room, 1,
    # quarter), splitting the leftover room greedily and capped at a quarter each. Matched ints always
    # pass through. The two cases provably coexist: one onset fills, two onsets clamp.
    f = fusion._bar_fallback_durs
    assert f([None], 16, 4) == [16]                           # LONE unmatched -> fills the 4/4 bar (whole note)
    assert f([None], 8, 4) == [8]                             # LONE unmatched in 2/4 -> fills to a half (capacity)
    assert f([None], 12, 4) == [12]                           # LONE unmatched in 3/4 -> fills to a dotted half
    assert f([None], None, 4) == [4]                          # LONE unmatched, unknown capacity -> blind quarter
    assert f([None, None], 16, 4) == [4, 4]                   # TWO unmatched onsets (NOT lone) -> clamp, never fill
    assert f([8, 2, 2, 2, None], 16, 4) == [8, 2, 2, 2, 2]   # reverie TREBLE shape: last note -> eighth (#201 clamp)
    assert f([16, None], 16, 4) == [16, 1]                    # >=2 onsets, bar already full -> sixteenth floor
    assert f([14, None, None], 16, 4) == [14, 2, 1]           # 2 room split: 2 then floored to 1
    assert f([None, None], None, 4) == [4, 4]                 # unknown capacity -> blind quarters
    assert f([2, None, 2], 16, 4) == [2, 4, 2]                # room 12 -> a full quarter (no clamp)
    # A MATCHED chord whose borrowed dur16 rounded to 0 (a sub-sixteenth Clarity read) is degenerate,
    # NOT an unmatched slot: it takes the blind fallback like the no-capacity path and does NOT draw on
    # the unmatched-room budget, so its size never depends on whether a sibling happened to be unmatched.
    assert f([12, 0, None], 16, 4) == [12, 4, 4]              # matched-0 -> quarter; only None takes room
    assert f([12, 0], 16, 4) == [12, 4]                       # no unmatched -> early path, matched-0 -> quarter


def test_fuse_preserves_chords():
    # a 2-note chord in geom borrows one duration and stays a chord.
    geom = _xml([{"staff1": [], "staff2": [
        {"duration": 1, "pitches": [{"step": "C", "octave": 3}, {"step": "E", "octave": 3}]}]}])
    clarity = _xml([{"staff1": [], "staff2": [
        {"duration": 8, "pitches": [{"step": "C", "octave": 3}, {"step": "E", "octave": 3}]}]}])
    fused = fusion.fuse(geom, clarity)
    assert _midis(fused) == [48, 52]      # C3, E3
    assert _durs(fused) == [8, 8]         # the chord's two notes share the borrowed half-note


def test_fuse_borrows_clarity_time_signature():
    # Clarity declares 2/4; the fused output must declare 2/4 too (not the old hardcoded 4/4) so a
    # non-4/4 piece renders at its true meter and rhythm_repair can corroborate the bar capacity.
    # geom keeps 4/4-faked time but its pitches/measures pass through unchanged.
    geom = _xml([{"staff1": [{"duration": 1, "pitches": [{"step": "C", "octave": 5}]},
                             {"duration": 1, "pitches": [{"step": "D", "octave": 5}]}], "staff2": []}])
    clarity = _xml([{"staff1": [{"duration": 4, "pitches": [{"step": "C", "octave": 5}]},
                                {"duration": 4, "pitches": [{"step": "D", "octave": 5}]}], "staff2": []}],
                   time={"beats": 2, "beat_type": 4})
    fused = fusion.fuse(geom, clarity)
    assert _time(fused) == ("2", "4")     # meter borrowed from clarity, not the hardcoded 4/4
    assert _midis(fused) == [72, 74]      # geom's pitches still preserved (C5, D5)
    assert _durs(fused) == [4, 4]         # clarity's durations still borrowed (two quarters)


def test_fuse_borrowed_meter_and_durations_are_consistent():
    # A 3/4 piece (capacity 12 sixteenths at divisions=4): the borrowed meter and the borrowed
    # durations must AGREE so the bar is metrically whole (three quarters fill the 3/4 bar). This
    # guards against declaring a meter whose capacity does not match the durations fusion emits.
    geom = _xml([{"staff1": [{"duration": 1, "pitches": [{"step": "C", "octave": 5}]},
                             {"duration": 1, "pitches": [{"step": "E", "octave": 5}]},
                             {"duration": 1, "pitches": [{"step": "G", "octave": 5}]}], "staff2": []}])
    clarity = _xml([{"staff1": [{"duration": 4, "pitches": [{"step": "C", "octave": 5}]},
                                {"duration": 4, "pitches": [{"step": "E", "octave": 5}]},
                                {"duration": 4, "pitches": [{"step": "G", "octave": 5}]}], "staff2": []}],
                   time={"beats": 3, "beat_type": 4})
    fused = fusion.fuse(geom, clarity)
    assert _time(fused) == ("3", "4")     # 3/4 borrowed from clarity
    assert sum(_durs(fused)) == 12        # three borrowed quarters == the 3/4 bar capacity (3*4)


def test_fuse_falls_back_to_4_4_when_clarity_has_no_time():
    # Clarity stripped of its <time>: _read_time returns None and the fused output declares 4/4.
    # geom deliberately declares a NON-4/4 meter (3/4) so this proves the fallback is the 4/4 default
    # and NOT geom's meter leaking through: a fuse-reads-geom-time bug would make the output 3/4 here.
    geom = _xml([{"staff1": [{"duration": 1, "pitches": [{"step": "C", "octave": 5}]}], "staff2": []}],
                time={"beats": 3, "beat_type": 4})
    clarity = _xml([{"staff1": [{"duration": 4, "pitches": [{"step": "C", "octave": 5}]}], "staff2": []}])
    fused = fusion.fuse(geom, _strip_time(clarity))
    assert _time(fused) == ("4", "4")     # no usable clarity <time> -> 4/4 fallback (NOT geom's 3/4)
    assert _midis(fused) == [72]          # geom's pitch still preserved
    assert _durs(fused) == [4]            # clarity's duration still borrowed


def test_fuse_normalizes_4_4_equivalent_meter_to_4_4():
    # REFINEMENT (follow-up to PR #191): Clarity misreads some genuine 4/4 pieces as 2/2 (cut time).
    # A meter with beats == beat-type (2/2, 4/4, 8/8) has the SAME bar capacity as 4/4 (16 sixteenths
    # at divisions=4), so borrowing it is metric-neutral but prints the wrong glyph (cut time on a
    # 4/4 piece). fuse keeps the 4/4 default for these, so a cut-time MISREAD cannot relabel a genuine
    # 4/4 piece. Pitches and borrowed durations are unchanged (only the printed meter is corrected).
    geom = _xml([{"staff1": [{"duration": 1, "pitches": [{"step": "C", "octave": 5}]},
                             {"duration": 1, "pitches": [{"step": "D", "octave": 5}]}], "staff2": []}])
    clarity = _xml([{"staff1": [{"duration": 8, "pitches": [{"step": "C", "octave": 5}]},
                                {"duration": 8, "pitches": [{"step": "D", "octave": 5}]}], "staff2": []}],
                   time={"beats": 2, "beat_type": 2})
    fused = fusion.fuse(geom, clarity)
    assert _time(fused) == ("4", "4")     # 2/2 (cut time, == 4/4 capacity) normalised to the 4/4 default
    assert _midis(fused) == [72, 74]      # geom's pitches still preserved (C5, D5)
    assert _durs(fused) == [8, 8]         # clarity's durations still borrowed (two half notes)


def test_fuse_normalizes_8_8_to_4_4():
    # 8/8 is another member of the beats == beat-type family (capacity 16): also normalised to 4/4.
    geom = _xml([{"staff1": [{"duration": 1, "pitches": [{"step": "C", "octave": 5}]}], "staff2": []}])
    clarity = _xml([{"staff1": [{"duration": 16, "pitches": [{"step": "C", "octave": 5}]}], "staff2": []}],
                   time={"beats": 8, "beat_type": 8})
    assert _time(fusion.fuse(geom, clarity)) == ("4", "4")


def test_fuse_still_borrows_genuinely_different_meter():
    # The refinement normalises ONLY 4/4-equivalent meters (beats == beat-type). A genuinely different
    # meter (different bar capacity) still borrows Clarity's real one so a non-4/4 piece renders at its
    # true width and rhythm_repair can corroborate the capacity. 2/4 (cap 8) and 3/4 (cap 12) borrow.
    def _fused_meter(beats, beat_type):
        geom = _xml([{"staff1": [{"duration": 1, "pitches": [{"step": "C", "octave": 5}]}], "staff2": []}])
        clarity = _xml([{"staff1": [{"duration": 4, "pitches": [{"step": "C", "octave": 5}]}], "staff2": []}],
                       time={"beats": beats, "beat_type": beat_type})
        return _time(fusion.fuse(geom, clarity))
    assert _fused_meter(2, 4) == ("2", "4")   # 2/4 (cap 8) genuinely different -> borrowed unchanged
    assert _fused_meter(3, 4) == ("3", "4")   # 3/4 (cap 12) genuinely different -> borrowed unchanged


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


class TestReadTime:
    """_read_time reads a real meter and degrades to None (caller falls back to 4/4) on anything
    unusable, never raising."""

    def test_reads_declared_meter(self):
        xml = _xml([{"staff1": [{"duration": 4, "pitches": [{"step": "C", "octave": 5}]}],
                     "staff2": []}], time={"beats": 3, "beat_type": 8})
        assert fusion._read_time(xml) == (3, 8)

    def test_none_when_no_time(self):
        xml = _xml([{"staff1": [{"duration": 4, "pitches": [{"step": "C", "octave": 5}]}],
                     "staff2": []}])
        assert fusion._read_time(_strip_time(xml)) is None

    def test_none_on_garbage_beats(self):
        xml = b'<score-partwise><part><measure><attributes><time>' \
              b'<beats>x</beats><beat-type>4</beat-type></time></attributes></measure></part></score-partwise>'
        assert fusion._read_time(xml) is None

    def test_none_on_zero_beat_type(self):
        xml = b'<score-partwise><part><measure><attributes><time>' \
              b'<beats>4</beats><beat-type>0</beat-type></time></attributes></measure></part></score-partwise>'
        assert fusion._read_time(xml) is None

    def test_none_on_time_without_numeric_children(self):
        # A <time> present but with no <beats>/<beat-type> (senza-misura) -> None, per the docstring.
        xml = b'<score-partwise><part><measure><attributes><time><senza-misura/></time>' \
              b'</attributes></measure></part></score-partwise>'
        assert fusion._read_time(xml) is None

    def test_never_raises_on_unparseable(self):
        assert fusion._read_time(b"<not xml") is None
        assert fusion._read_time(None) is None
