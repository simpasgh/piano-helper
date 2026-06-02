"""Unit tests for the ensemble OMR reconciliation core (Slice 2).

Covers the PURE `to_events` lowering + `align` bucketing in reconcile.py:
  - divisions-mismatch normalization (two engines with different <divisions> still align);
  - chord members sharing an onset;
  - <backup>/<forward> moving the within-measure cursor;
  - clef-based staff mapping for Clarity's 2-part shape vs oemer's <staff> shape;
  - alignment buckets (matched / only_a / only_b), including a pitch DISAGREEMENT landing
    in `matched` and a missing note landing in only_a;
  - malformed XML returning [] without raising (the #113 robustness contract).

reconcile.py imports only stdlib (xml.etree, math, dataclasses), so these tests need no
boto3 stubbing and no engines installed.

Run locally with: python3 -m pytest omr-worker/test_reconcile.py
"""

import xml.etree.ElementTree as ET

import reconcile  # noqa: E402
from reconcile import NoteEvent, align, to_events


# --- Fixture builders --------------------------------------------------------------------


def _oemer_xml(divisions, measures):
    """Build oemer-shape MusicXML: ONE part, notes carry <staff>1/2. `measures` is a list of
    lists of note-XML strings (one inner list per measure)."""
    body = []
    for i, notes in enumerate(measures, start=1):
        attrs = ""
        if i == 1:
            attrs = (
                "<attributes><divisions>%d</divisions>"
                "<key><fifths>0</fifths></key>"
                "<time><beats>4</beats><beat-type>4</beat-type></time>"
                '<clef number="1"><sign>G</sign><line>2</line></clef>'
                '<clef number="2"><sign>F</sign><line>4</line></clef>'
                "</attributes>" % divisions
            )
        body.append('<measure number="%d">%s%s</measure>' % (i, attrs, "".join(notes)))
    return (
        '<?xml version="1.0"?><score-partwise version="4.0">'
        "<part-list><score-part id=\"P1\"><part-name>M</part-name></score-part></part-list>"
        '<part id="P1">%s</part></score-partwise>' % "".join(body)
    ).encode("utf-8")


def _clarity_xml(divisions, treble_measures, bass_measures):
    """Build Clarity-shape MusicXML: TWO parts (no <staff>), staff decided by clef sign.
    Part 1 = G clef (treble), part 2 = F clef (bass)."""

    def _part(part_id, sign, line, measures):
        body = []
        for i, notes in enumerate(measures, start=1):
            attrs = ""
            if i == 1:
                attrs = (
                    "<attributes><divisions>%d</divisions>"
                    "<key><fifths>0</fifths></key>"
                    "<time><beats>4</beats><beat-type>4</beat-type></time>"
                    "<clef><sign>%s</sign><line>%d</line></clef>"
                    "</attributes>" % (divisions, sign, line)
                )
            body.append(
                '<measure number="%d">%s%s</measure>' % (i, attrs, "".join(notes))
            )
        return '<part id="%s">%s</part>' % (part_id, "".join(body))

    return (
        '<?xml version="1.0"?><score-partwise version="4.0">'
        "<part-list>"
        '<score-part id="P1"><part-name>RH</part-name></score-part>'
        '<score-part id="P2"><part-name>LH</part-name></score-part>'
        "</part-list>"
        "%s%s</score-partwise>"
        % (
            _part("P1", "G", 2, treble_measures),
            _part("P2", "F", 4, bass_measures),
        )
    ).encode("utf-8")


def _note(step, octave, duration, staff=None, chord=False, alter=None, tie=None):
    parts = []
    if chord:
        parts.append("<chord/>")
    pitch = "<step>%s</step>" % step
    if alter is not None:
        pitch += "<alter>%d</alter>" % alter
    pitch += "<octave>%d</octave>" % octave
    parts.append("<pitch>%s</pitch>" % pitch)
    parts.append("<duration>%d</duration>" % duration)
    if tie:
        for t in tie:
            parts.append('<tie type="%s"/>' % t)
    if staff is not None:
        parts.append("<staff>%d</staff>" % staff)
    return "<note>%s</note>" % "".join(parts)


def _rest(duration, staff=None):
    s = "<staff>%d</staff>" % staff if staff is not None else ""
    return "<note><rest/><duration>%d</duration>%s</note>" % (duration, s)


def _backup(duration):
    return "<backup><duration>%d</duration></backup>" % duration


def _forward(duration):
    return "<forward><duration>%d</duration></forward>" % duration


# --- to_events: divisions, chords, cursor ------------------------------------------------


def test_divisions_mismatch_still_aligns():
    # Engine A: divisions=4 (quarter = 4 ticks). Engine B: divisions=16 (quarter = 16).
    # Both play the SAME quarter-note melody C5 D5 in one treble measure. After to_events +
    # align the per-stream bases differ (4 vs 16) but the onsets must line up, so the two
    # notes MATCH, none left unmatched.
    a = to_events(_oemer_xml(4, [[_note("C", 5, 4, staff=1), _note("D", 5, 4, staff=1)]]), "a")
    b = to_events(_oemer_xml(16, [[_note("C", 5, 16, staff=1), _note("D", 5, 16, staff=1)]]), "b")

    res = align(a, b)
    assert len(res["matched"]) == 2
    assert res["only_a"] == []
    assert res["only_b"] == []
    # The matched pairs agree on pitch (same melody).
    for ea, eb in res["matched"]:
        assert ea.pitch == eb.pitch


def test_chord_members_share_onset():
    # A C-major triad: C5 then E5,G5 as <chord/> members. All three share onset 0; only the
    # base note advanced the cursor. The next note (D5) sits at the post-chord onset.
    notes = [
        _note("C", 5, 4, staff=1),
        _note("E", 5, 4, staff=1, chord=True),
        _note("G", 5, 4, staff=1, chord=True),
        _note("D", 5, 4, staff=1),
    ]
    events = to_events(_oemer_xml(4, [notes]), "a")
    by_pitch = {e.pitch[0]: e for e in events}
    assert by_pitch["C"].onset == 0
    assert by_pitch["E"].onset == 0
    assert by_pitch["G"].onset == 0
    assert by_pitch["E"].is_chord is True
    assert by_pitch["G"].is_chord is True
    assert by_pitch["C"].is_chord is False
    # D5 follows the chord by exactly ONE note duration (chord members did not advance time).
    assert by_pitch["D"].onset == by_pitch["C"].duration


def test_backup_and_forward_move_the_cursor():
    # divisions=4. Treble: a half note (dur 8) at onset 0. Then a <backup> of 8 rewinds to
    # the measure start, and a staff-2 note (in the same oemer measure) sits at onset 0 again.
    # Then a <forward> of 4 skips a beat and a final staff-2 note lands at onset 4.
    measure = [
        _note("C", 5, 8, staff=1),
        _backup(8),
        _note("C", 3, 4, staff=2),
        _forward(4),
        _note("E", 3, 4, staff=2),
    ]
    events = to_events(_oemer_xml(4, [measure]), "a")
    treble = [e for e in events if e.staff == 1]
    bass = [e for e in events if e.staff == 2]
    assert len(treble) == 1 and treble[0].onset == 0
    # Bass C3 went back to the measure start; E3 is a forward-skip later.
    bass_by_pitch = {e.pitch[0]: e for e in bass}
    assert bass_by_pitch["C"].onset == 0
    assert bass_by_pitch["E"].onset == 8  # backup to 0, +4 dur C3 -> 4, +4 forward -> 8


def test_backup_past_zero_clamps():
    # A pathological backup larger than the cursor must clamp at 0, not go negative.
    measure = [_note("C", 5, 4, staff=1), _backup(99), _note("C", 3, 4, staff=2)]
    events = to_events(_oemer_xml(4, [measure]), "a")
    bass = [e for e in events if e.staff == 2][0]
    assert bass.onset == 0


# --- staff mapping: oemer <staff> vs Clarity clef ----------------------------------------


def test_oemer_staff_mapping_uses_explicit_staff():
    measure = [_note("C", 5, 4, staff=1), _note("C", 3, 4, staff=2)]
    events = to_events(_oemer_xml(4, [measure]), "oemer")
    staves = {e.pitch[0]: e.staff for e in events}
    assert staves["C"] in (1, 2)  # both are C; check each event
    assert {e.staff for e in events} == {1, 2}


def test_clarity_staff_mapping_uses_clef_sign():
    # Clarity has NO <staff>: the treble part (G clef) -> staff 1, bass part (F clef) -> 2.
    xml = _clarity_xml(
        4,
        treble_measures=[[_note("C", 5, 4), _note("D", 5, 4)]],
        bass_measures=[[_note("C", 3, 4), _note("E", 3, 4)]],
    )
    events = to_events(xml, "clarity")
    treble = [e for e in events if e.staff == 1]
    bass = [e for e in events if e.staff == 2]
    assert sorted(e.pitch[2] for e in treble) == [5, 5]  # octave 5 -> RH
    assert sorted(e.pitch[2] for e in bass) == [3, 3]  # octave 3 -> LH


def test_clarity_vs_oemer_align_across_shapes():
    # Same music in BOTH shapes: a treble C5,D5 and a bass C3,E3, one measure. oemer encodes
    # it as one part with <staff>; Clarity as two parts by clef. After to_events both produce
    # the same 4 events per cell, so align matches all 4 with nothing unmatched.
    oemer = to_events(
        _oemer_xml(
            8,
            [[
                _note("C", 5, 8, staff=1),
                _backup(8),
                _note("C", 3, 8, staff=2),
            ]],
        ),
        "oemer",
    )
    clarity = to_events(
        _clarity_xml(
            4,
            treble_measures=[[_note("C", 5, 4)]],
            bass_measures=[[_note("C", 3, 4)]],
        ),
        "clarity",
    )
    res = align(oemer, clarity)
    assert len(res["matched"]) == 2  # treble C5 pair + bass C3 pair
    assert res["only_a"] == []
    assert res["only_b"] == []
    for ea, eb in res["matched"]:
        assert ea.staff == eb.staff
        assert ea.pitch == eb.pitch


# --- alignment buckets -------------------------------------------------------------------


def test_pitch_disagreement_lands_in_matched():
    # Same onset+staff, DIFFERENT pitch: a note both engines saw but read differently. It
    # must bucket in `matched` (a slot conflict to be voted later), NOT in only_a/only_b.
    a = to_events(_oemer_xml(4, [[_note("C", 5, 4, staff=1)]]), "a")
    b = to_events(_oemer_xml(4, [[_note("D", 5, 4, staff=1)]]), "b")
    res = align(a, b)
    assert len(res["matched"]) == 1
    assert res["only_a"] == []
    assert res["only_b"] == []
    ea, eb = res["matched"][0]
    assert ea.pitch != eb.pitch  # matched-with-different-pitch


def test_missing_note_lands_in_only_a():
    # Engine A has two notes in the measure; engine B dropped the second. The first matches;
    # the second is present in A only.
    a = to_events(
        _oemer_xml(4, [[_note("C", 5, 4, staff=1), _note("D", 5, 4, staff=1)]]), "a"
    )
    b = to_events(_oemer_xml(4, [[_note("C", 5, 4, staff=1)]]), "b")
    res = align(a, b)
    assert len(res["matched"]) == 1
    assert len(res["only_a"]) == 1
    assert res["only_a"][0].pitch[0] == "D"
    assert res["only_b"] == []


def test_extra_note_lands_in_only_b():
    a = to_events(_oemer_xml(4, [[_note("C", 5, 4, staff=1)]]), "a")
    b = to_events(
        _oemer_xml(4, [[_note("C", 5, 4, staff=1), _note("D", 5, 4, staff=1)]]), "b"
    )
    res = align(a, b)
    assert len(res["matched"]) == 1
    assert res["only_a"] == []
    assert len(res["only_b"]) == 1
    assert res["only_b"][0].pitch[0] == "D"


def test_different_staff_does_not_match():
    # Same onset+pitch but DIFFERENT staff (RH vs LH) is NOT the same slot; both unmatched.
    a = to_events(_oemer_xml(4, [[_note("C", 5, 4, staff=1)]]), "a")
    b = to_events(_oemer_xml(4, [[_backup(0), _note("C", 5, 4, staff=2)]]), "b")
    res = align(a, b)
    assert res["matched"] == []
    assert len(res["only_a"]) == 1 and res["only_a"][0].staff == 1
    assert len(res["only_b"]) == 1 and res["only_b"][0].staff == 2


def test_onset_within_eps_matches_beyond_does_not():
    # divisions=8 so a quarter = 8 ticks, EPS_BEATS (1/8 beat) = 1 tick. A 1-tick onset jitter
    # still matches; a half-beat (4-tick) shift does not.
    a = to_events(_oemer_xml(8, [[_note("C", 5, 8, staff=1)]]), "a")
    # B's note starts 1 tick late via a tiny forward: within eps -> match.
    b_close = to_events(_oemer_xml(8, [[_forward(1), _note("C", 5, 8, staff=1)]]), "b")
    res_close = align(a, b_close)
    assert len(res_close["matched"]) == 1

    # B's note starts 4 ticks late (half a beat): beyond eps -> both unmatched.
    b_far = to_events(_oemer_xml(8, [[_forward(4), _note("C", 5, 8, staff=1)]]), "b")
    res_far = align(a, b_far)
    assert res_far["matched"] == []
    assert len(res_far["only_a"]) == 1
    assert len(res_far["only_b"]) == 1


def test_greedy_match_prefers_exact_pitch_on_tie():
    # In one cell A has C5 and D5 at the same onset; B has D5 and C5 at the same onset. The
    # greedy matcher must pair by pitch (C5<->C5, D5<->D5), not by document order, so both
    # pairs agree on pitch and nothing is left over.
    a = to_events(
        _oemer_xml(4, [[_note("C", 5, 4, staff=1), _note("E", 5, 4, staff=1, chord=True)]]),
        "a",
    )
    b = to_events(
        _oemer_xml(4, [[_note("E", 5, 4, staff=1), _note("C", 5, 4, staff=1, chord=True)]]),
        "b",
    )
    res = align(a, b)
    assert len(res["matched"]) == 2
    for ea, eb in res["matched"]:
        assert ea.pitch == eb.pitch


# --- ties / pitch parsing ----------------------------------------------------------------


def test_tie_and_alter_parsed_onto_event():
    notes = [_note("B", 4, 4, staff=1, alter=-1, tie=["start"])]
    events = to_events(_oemer_xml(4, [notes]), "a")
    e = events[0]
    assert e.pitch == ("B", -1, 4)
    assert e.tie == {"start"}


def test_rest_has_none_pitch():
    events = to_events(_oemer_xml(4, [[_rest(4, staff=1)]]), "a")
    assert len(events) == 1
    assert events[0].pitch is None


# --- robustness --------------------------------------------------------------------------


def test_malformed_xml_returns_empty_without_raising():
    assert to_events(b"<not-valid-xml<<<", "a") == []
    assert to_events(b"", "a") == []
    assert to_events(b"not xml at all", "a") == []


def test_empty_score_returns_empty():
    xml = (
        '<?xml version="1.0"?><score-partwise version="4.0">'
        "<part-list></part-list></score-partwise>"
    ).encode("utf-8")
    assert to_events(xml, "a") == []


def test_align_of_empty_streams():
    res = align([], [])
    assert res == {"matched": [], "only_a": [], "only_b": []}


def test_align_does_not_mutate_inputs():
    a = to_events(_oemer_xml(4, [[_note("C", 5, 4, staff=1)]]), "a")
    b = to_events(_oemer_xml(16, [[_note("C", 5, 16, staff=1)]]), "b")
    onsets_before = ([e.onset for e in a], [e.onset for e in b])
    align(a, b)
    assert ([e.onset for e in a], [e.onset for e in b]) == onsets_before


def test_lcm_helpers():
    assert reconcile._lcm(4, 16) == 16
    assert reconcile._lcm(4, 6) == 12
    assert reconcile._lcm_all({4, 16, 3}) == 48
    assert reconcile._lcm_all(set()) == 1


def test_noteevent_equality_ignores_elem():
    # Two events with the same musical content but different elem refs compare equal, so the
    # elem reference does not leak into alignment correctness.
    e1 = NoteEvent(1, 0, 1, ("C", 0, 5), 4, False, set(), "a", ET.Element("note"))
    e2 = NoteEvent(1, 0, 1, ("C", 0, 5), 4, False, set(), "a", ET.Element("note"))
    assert e1 == e2
