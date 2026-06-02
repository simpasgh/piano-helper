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
from reconcile import NoteEvent, align, reconcile as reconcile_docs, to_events


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


# === Reconciliation (Slice 3) ============================================================
# reconcile(primary=Clarity, secondary=oemer) takes Clarity as the SKELETON and emits the
# winner's REAL <note> per matched slot, resolving ONLY safe classes A/B/E. Classes C/D are
# no-ops this slice. Every heuristic tiebreaks to Clarity; the output must never be worse than
# Clarity-alone. Robustness: never raises, returns primary on any failure / empty secondary.


def _emitted_pitches(xml_bytes, staff=None):
    """Parse a reconciled doc and return [(step, alter, octave), ...] of its real notes, in
    document order, optionally filtered to a staff (1/2)."""
    root = ET.fromstring(xml_bytes)
    out = []
    for part in root.findall("part"):
        # A reconciled Clarity skeleton stays 2-part: derive staff from the part clef.
        part_staff = 2 if part.find(".//clef/sign") is not None and (
            part.findtext(".//clef/sign") or ""
        ).strip().upper() == "F" else 1
        for note in part.iter("note"):
            if staff is not None and part_staff != staff:
                continue
            pitch = note.find("pitch")
            if pitch is None:
                continue
            step = pitch.findtext("step")
            octave = int(pitch.findtext("octave"))
            alter = int(pitch.findtext("alter") or "0")
            out.append((step, alter, octave))
    return out


def _clarity_one_treble(notes, fifths=0):
    """A Clarity-shape doc with ONE treble (G-clef) part, given fifths. notes = list of
    note-XML strings for measure 1."""
    attrs = (
        "<attributes><divisions>4</divisions>"
        "<key><fifths>%d</fifths></key>"
        "<time><beats>4</beats><beat-type>4</beat-type></time>"
        "<clef><sign>G</sign><line>2</line></clef>"
        "</attributes>" % fifths
    )
    return (
        '<?xml version="1.0"?><score-partwise version="4.0">'
        '<part-list><score-part id="P1"><part-name>RH</part-name></score-part></part-list>'
        '<part id="P1"><measure number="1">%s%s</measure></part>'
        "</score-partwise>" % (attrs, "".join(notes))
    ).encode("utf-8")


def _oemer_one_treble(notes):
    """An oemer-shape doc, one part, notes carry <staff>1, divisions=4, one measure."""
    attrs = (
        "<attributes><divisions>4</divisions>"
        "<key><fifths>0</fifths></key>"
        "<time><beats>4</beats><beat-type>4</beat-type></time>"
        '<clef number="1"><sign>G</sign><line>2</line></clef>'
        "</attributes>"
    )
    return (
        '<?xml version="1.0"?><score-partwise version="4.0">'
        '<part-list><score-part id="P1"><part-name>M</part-name></score-part></part-list>'
        '<part id="P1"><measure number="1">%s%s</measure></part>'
        "</score-partwise>" % (attrs, "".join(notes))
    ).encode("utf-8")


# --- Class A: agree -> Clarity passthrough -----------------------------------------------


def test_class_a_agree_keeps_clarity():
    # Both engines read C5 quarter at onset 0. No conflict: Clarity's element is emitted as-is.
    primary = _clarity_one_treble([_note("C", 5, 4)])
    secondary = _oemer_one_treble([_note("C", 5, 4, staff=1)])
    out = reconcile_docs(primary, secondary)
    assert _emitted_pitches(out) == [("C", 0, 5)]


# --- Class B: pitch mismatch votes -------------------------------------------------------


def test_class_b_diatonicity_picks_diatonic_candidate():
    # C major (fifths 0). Clarity read C#5 (non-diatonic, pc 1); oemer read C5 (diatonic). A
    # lone non-diatonic alter is the likely misread -> oemer's diatonic C5 wins.
    primary = _clarity_one_treble([_note("C", 5, 4, alter=1)], fifths=0)
    secondary = _oemer_one_treble([_note("C", 5, 4, staff=1)])
    out = reconcile_docs(primary, secondary)
    assert _emitted_pitches(out) == [("C", 0, 5)]


def test_class_b_range_rejects_out_of_range():
    # Clarity read an absurd octave (C12 -> MIDI 156, out of range); oemer read C5 (in range).
    # Range sanity rejects the out-of-range candidate even though Clarity is primary.
    primary = _clarity_one_treble([_note("C", 12, 4)])
    secondary = _oemer_one_treble([_note("C", 5, 4, staff=1)])
    out = reconcile_docs(primary, secondary)
    assert _emitted_pitches(out) == [("C", 0, 5)]


def test_class_b_voice_leading_no_longer_overrides_clarity():
    # REGRESSION (2026-06-02 QA on Icarus): the voice-leading prior was REMOVED because on clean
    # input it overrode CORRECT Clarity readings with oemer's wrong pitch. Here a previous note
    # (A4) is agreed, then Clarity reads G5 (interval 10 from A4) and oemer reads B4 (interval 2).
    # The OLD code let oemer's smaller-interval B4 win; the conservative vote KEEPS Clarity's G5
    # because both candidates are diatonic + in range (no strong positive signal for oemer).
    primary = _clarity_one_treble([_note("A", 4, 4), _note("G", 5, 4)])
    secondary = _oemer_one_treble(
        [_note("A", 4, 4, staff=1), _note("B", 4, 4, staff=1)]
    )
    out = reconcile_docs(primary, secondary)
    assert _emitted_pitches(out) == [("A", 0, 4), ("G", 0, 5)]


def test_class_b_all_else_equal_keeps_clarity():
    # Two candidates that no heuristic can separate: both diatonic, both in range, both an
    # equal interval from no-previous-note context, no tie. Must tiebreak to Clarity.
    # C major; clarity E5 vs oemer G5 (both diatonic, both near tessitura, no prev note).
    # With no previous note the voice-leading prior cannot fire, so Clarity wins.
    primary = _clarity_one_treble([_note("E", 5, 4)])
    secondary = _oemer_one_treble([_note("G", 5, 4, staff=1)])
    out = reconcile_docs(primary, secondary)
    assert _emitted_pitches(out) == [("E", 0, 5)]


def test_class_b_both_diatonic_in_range_keeps_clarity_safety():
    # Safety net: when both candidates are plausible Clarity must not be overridden by oemer.
    primary = _clarity_one_treble([_note("D", 5, 4)])
    secondary = _oemer_one_treble([_note("F", 5, 4, staff=1)])
    out = reconcile_docs(primary, secondary)
    assert _emitted_pitches(out) == [("D", 0, 5)]


def test_class_b_keeps_clarity_chord_when_both_diatonic():
    # REGRESSION (2026-06-02 QA on Icarus, case a). Clarity reads a clean C-major chord
    # G3 + C4 + E4 (all diatonic). oemer misreads the C4 member as B3. The OLD voice-leading
    # prior could have flipped the C4 to oemer's B3 (B3 is a smaller step from a nearby note);
    # the conservative vote KEEPS Clarity's C4 because both B3 and C4 are diatonic + in range, so
    # no strong positive signal favors oemer. The chord stays {G3, C4, E4}.
    primary = _clarity_one_treble(
        [
            _note("G", 3, 4),
            _note("C", 4, 4, chord=True),
            _note("E", 4, 4, chord=True),
        ]
    )
    # oemer lists the same chord but reads the middle member as B3.
    secondary = _oemer_one_treble(
        [
            _note("G", 3, 4, staff=1),
            _note("B", 3, 4, staff=1, chord=True),
            _note("E", 4, 4, staff=1, chord=True),
        ]
    )
    out = reconcile_docs(primary, secondary)
    assert _emitted_pitches(out) == [("G", 0, 3), ("C", 0, 4), ("E", 0, 4)]


def test_class_b_declines_swap_that_would_duplicate_chord_pitch():
    # REGRESSION (2026-06-02 QA on Icarus, case b - the duplicate-pitch bug). Clarity reads a
    # 2-note chord {C2, G#2}. The G#2 member is NON-diatonic in C major, and oemer reads that
    # member as C2 (diatonic), so the diatonicity vote WANTS to swap G#2 -> C2. But C2 already
    # exists as the other chord member, so applying the swap would emit an invalid chord with two
    # identical C2 pitches. The duplicate guard DECLINES the swap; the chord stays {C2, G#2}.
    primary = _clarity_one_treble(
        [
            _note("C", 2, 4),
            _note("G", 2, 4, alter=1, chord=True),  # G#2, non-diatonic
        ]
    )
    secondary = _oemer_one_treble(
        [
            _note("C", 2, 4, staff=1),
            _note("C", 2, 4, staff=1, chord=True),  # oemer reads the 2nd member as C2 too
        ]
    )
    out = reconcile_docs(primary, secondary)
    # No duplicate emitted: the second member stays Clarity's G#2, not a second C2.
    assert _emitted_pitches(out) == [("C", 0, 2), ("G", 1, 2)]


def test_class_b_genuine_diatonicity_correction_still_applies():
    # REGRESSION (2026-06-02, case c - confirm the GOOD signal survives the conservative rewrite).
    # C major. Clarity reads a lone F#4 (non-diatonic, no chord context); oemer reads the diatonic
    # F4. The diatonicity vote (the one strong positive signal kept) still flips F#4 -> F4.
    primary = _clarity_one_treble([_note("F", 4, 4, alter=1)])  # F#4 non-diatonic
    secondary = _oemer_one_treble([_note("F", 4, 4, staff=1)])  # F4 diatonic
    out = reconcile_docs(primary, secondary)
    assert _emitted_pitches(out) == [("F", 0, 4)]


# --- Class E: duration mismatch ----------------------------------------------------------


def test_class_e_metric_completeness_vote():
    # 4/4, divisions=4 -> a full bar is 16 ticks. Clarity read the note as a quarter (dur 4)
    # which UNDER-fills the bar; oemer read it as a whole note (dur 16) which EXACTLY completes
    # the bar. Metric-completeness picks oemer's whole note.
    primary = _clarity_one_treble([_note("C", 5, 4)])
    secondary = _oemer_one_treble([_note("C", 5, 16, staff=1)])
    out = reconcile_docs(primary, secondary)
    root = ET.fromstring(out)
    durs = [int(n.findtext("duration")) for n in root.iter("note") if n.find("pitch") is not None]
    assert durs == [16]


def test_class_e_clarity_tie_chain_wins():
    # Same pitch, different duration, BUT Clarity's note carries a tie start: a tie is a
    # deliberate duration signal, so Clarity ALWAYS wins regardless of the metric vote.
    primary = _clarity_one_treble([_note("C", 5, 4, tie=["start"])])
    secondary = _oemer_one_treble([_note("C", 5, 16, staff=1)])
    out = reconcile_docs(primary, secondary)
    root = ET.fromstring(out)
    note = next(n for n in root.iter("note") if n.find("pitch") is not None)
    assert int(note.findtext("duration")) == 4
    assert any(t.get("type") == "start" for t in note.findall("tie"))


# --- Class C / D: no-ops this slice ------------------------------------------------------


def test_class_c_oemer_only_note_is_ignored():
    # oemer has an EXTRA note (D5) Clarity lacks. Slice 3 does NOT add oemer-only notes, so the
    # reconciled output keeps ONLY Clarity's C5; D5 is dropped (TODO slice4).
    primary = _clarity_one_treble([_note("C", 5, 4)])
    secondary = _oemer_one_treble(
        [_note("C", 5, 4, staff=1), _note("D", 5, 4, staff=1)]
    )
    out = reconcile_docs(primary, secondary)
    assert _emitted_pitches(out) == [("C", 0, 5)]


def test_class_c_clarity_only_note_is_kept():
    # Clarity has a note oemer lacks (D5). Clarity is the skeleton, so its note is KEPT as-is.
    primary = _clarity_one_treble([_note("C", 5, 4), _note("D", 5, 4)])
    secondary = _oemer_one_treble([_note("C", 5, 4, staff=1)])
    out = reconcile_docs(primary, secondary)
    assert _emitted_pitches(out) == [("C", 0, 5), ("D", 0, 5)]


def test_class_d_timing_mismatch_keeps_clarity_ignores_oemer():
    # Same pitch but onsets differ beyond eps (Clarity at 0, oemer half a bar late at 8). They
    # do NOT align as a matched pair, so it is class D: Clarity's note is kept, oemer's ignored.
    primary = _clarity_one_treble([_note("C", 5, 4)])
    secondary = _oemer_one_treble(
        [_rest(8, staff=1), _note("C", 5, 4, staff=1)]
    )
    out = reconcile_docs(primary, secondary)
    assert _emitted_pitches(out) == [("C", 0, 5)]


# --- markup preservation + robustness ----------------------------------------------------


def test_clarity_tie_and_spelling_markup_survives_reconciliation():
    # Clarity's element carries a tie start AND an explicit alter (spelling). On a class-A
    # agreement the REAL Clarity element is emitted, so its tie + alter survive untouched.
    primary = _clarity_one_treble([_note("B", 4, 4, alter=-1, tie=["start"])])
    secondary = _oemer_one_treble([_note("B", 4, 4, staff=1, alter=-1)])
    out = reconcile_docs(primary, secondary)
    root = ET.fromstring(out)
    note = next(n for n in root.iter("note") if n.find("pitch") is not None)
    assert note.findtext("pitch/step") == "B"
    assert note.findtext("pitch/alter") == "-1"
    assert any(t.get("type") == "start" for t in note.findall("tie"))


def test_reconcile_returns_primary_on_malformed_secondary():
    primary = _clarity_one_treble([_note("C", 5, 4)])
    out = reconcile_docs(primary, b"<not-valid<<<")
    assert out == primary  # secondary unparseable -> Clarity unchanged, byte-identical.


def test_reconcile_empty_secondary_passthrough():
    primary = _clarity_one_treble([_note("C", 5, 4)])
    assert reconcile_docs(primary, b"") == primary
    assert reconcile_docs(primary, None) == primary


def test_reconcile_returns_primary_on_malformed_primary():
    # A malformed PRIMARY cannot be a skeleton: return it unchanged (never raise).
    bad = b"<broken<<<"
    assert reconcile_docs(bad, _oemer_one_treble([_note("C", 5, 4, staff=1)])) == bad


def test_reconcile_no_matches_returns_primary():
    # Disjoint material (different staves entirely) -> no matched pairs -> Clarity unchanged.
    primary = _clarity_one_treble([_note("C", 5, 4)])
    secondary = _oemer_one_treble([_rest(16, staff=1)])  # only a rest, no pitched match
    out = reconcile_docs(primary, secondary)
    assert _emitted_pitches(out) == [("C", 0, 5)]


# --- swap fidelity: a vote-for-oemer must change ONLY the voted field --------------------
# Regression guards for two bugs where emitting oemer's WHOLE element corrupted the Clarity
# skeleton: (1) it dropped/added a <chord/> member, turning a chord into a sequence (or vice
# versa) and overflowing the bar; (2) it carried oemer's NATIVE <duration> in oemer's own
# <divisions> base into the Clarity document, multiplying the note's length. A pitch vote must
# change pitch ONLY; a duration vote must write the duration in the CLARITY document's base.


def _oemer_div(divisions, notes, fifths=0):
    """An oemer-shape doc with a CUSTOM <divisions> (so we can exercise a base mismatch vs the
    div=4 Clarity skeleton). notes = note-XML strings already sized for `divisions`."""
    attrs = (
        "<attributes><divisions>%d</divisions>"
        "<key><fifths>%d</fifths></key>"
        "<time><beats>4</beats><beat-type>4</beat-type></time>"
        '<clef number="1"><sign>G</sign><line>2</line></clef>'
        "</attributes>" % (divisions, fifths)
    )
    return (
        '<?xml version="1.0"?><score-partwise version="4.0">'
        '<part-list><score-part id="P1"><part-name>M</part-name></score-part></part-list>'
        '<part id="P1"><measure number="1">%s%s</measure></part>'
        "</score-partwise>" % (attrs, "".join(notes))
    ).encode("utf-8")


def test_class_b_swap_preserves_clarity_chord_membership():
    # Clarity reads a 2-note chord: C5 (root) + F#5 (<chord/> member, NON-diatonic in C major).
    # oemer reads the same chord but lists it E5 (root) + C5 (<chord/> member): the matched
    # disagreeing pair is Clarity's F#5 chord-member vs oemer's E5 chord-ROOT (no <chord/>).
    # The diatonicity vote picks oemer's E5. The swap must keep the note a <chord/> MEMBER:
    # dropping the marker would turn the chord into two sequential quarters and overflow the bar.
    primary = _clarity_one_treble(
        [_note("C", 5, 4), _note("F", 5, 4, alter=1, chord=True)]
    )
    secondary = _oemer_one_treble(
        [_note("E", 5, 4, staff=1), _note("C", 5, 4, staff=1, chord=True)]
    )
    out = reconcile_docs(primary, secondary)
    root = ET.fromstring(out)
    notes = [n for n in root.iter("note") if n.find("pitch") is not None]
    assert [n.findtext("pitch/step") for n in notes] == ["C", "E"]  # F#5 corrected to E5
    # The corrected note is STILL a chord member (shares C5's onset); membership preserved.
    assert notes[0].find("chord") is None
    assert notes[1].find("chord") is not None
    # Durations untouched (a pitch vote changes pitch only): both still quarter (dur 4).
    assert [n.findtext("duration") for n in notes] == ["4", "4"]


def test_class_b_swap_keeps_clarity_duration_across_divisions():
    # Clarity divisions=4 reads C#5 quarter (dur 4, non-diatonic). oemer divisions=16 reads the
    # same slot as C5 quarter (dur 16 in ITS base). The diatonicity vote picks oemer's C5. The
    # emitted note must keep CLARITY's duration (4), NOT oemer's native 16 (which in the div=4
    # document would be a quadruple-length note that overflows the bar).
    primary = _clarity_one_treble([_note("C", 5, 4, alter=1)], fifths=0)
    secondary = _oemer_div(16, [_note("C", 5, 16, staff=1)])
    out = reconcile_docs(primary, secondary)
    note = next(
        n for n in ET.fromstring(out).iter("note") if n.find("pitch") is not None
    )
    assert note.findtext("pitch/step") == "C"
    assert note.find("pitch/alter") is None  # C natural now
    assert note.findtext("duration") == "4"  # CLARITY's base, not oemer's 16


def test_class_e_swap_writes_duration_in_clarity_base_across_divisions():
    # Class E across DIFFERENT divisions: Clarity div=4 reads C5 as a quarter (dur 4, under-fills
    # the 4/4 bar); oemer div=16 reads the same C5 as a whole note (dur 64 in its base) which
    # completes the bar. Metric-completeness picks oemer's whole note, BUT the written duration
    # must be in CLARITY's base: a whole note at div=4 is 16 ticks, NOT oemer's raw 64.
    primary = _clarity_one_treble([_note("C", 5, 4)])
    secondary = _oemer_div(16, [_note("C", 5, 64, staff=1)])
    out = reconcile_docs(primary, secondary)
    note = next(
        n for n in ET.fromstring(out).iter("note") if n.find("pitch") is not None
    )
    assert note.findtext("pitch/step") == "C"
    assert note.findtext("duration") == "16"  # whole note in div=4, not oemer's 64


# === Slice 4: class D (timing) + class C (one-engine-only), each behind its sub-gate ======
# Both sub-gates default OFF and additionally require OMR_ENSEMBLE. With ONLY OMR_ENSEMBLE on
# (the Slice-3 behavior) classes C/D stay no-ops; they activate only when their own sub-gate
# is also set. Every correction tiebreaks to Clarity; a declined correction is always OK.


import pytest  # noqa: E402


@pytest.fixture
def ensemble_on(monkeypatch):
    monkeypatch.setenv("OMR_ENSEMBLE", "1")
    return monkeypatch


def _clarity_one_treble_rest_then_note(rest_dur, note, fifths=0):
    """A Clarity treble part whose measure is [rest, note] (the safe class-D shape)."""
    attrs = (
        "<attributes><divisions>4</divisions>"
        "<key><fifths>%d</fifths></key>"
        "<time><beats>4</beats><beat-type>4</beat-type></time>"
        "<clef><sign>G</sign><line>2</line></clef>"
        "</attributes>" % fifths
    )
    body = _rest(rest_dur) + note
    return (
        '<?xml version="1.0"?><score-partwise version="4.0">'
        '<part-list><score-part id="P1"><part-name>RH</part-name></score-part></part-list>'
        '<part id="P1"><measure number="1">%s%s</measure></part>'
        "</score-partwise>" % (attrs, body)
    ).encode("utf-8")


# --- Sub-gate behavior: C/D are no-ops with only OMR_ENSEMBLE on -------------------------


def test_timing_disabled_by_default_is_noop(monkeypatch):
    # OMR_ENSEMBLE on but OMR_ENSEMBLE_TIMING unset: class D stays the Slice-3 no-op (Clarity
    # note kept at its onset, oemer's timing ignored).
    monkeypatch.setenv("OMR_ENSEMBLE", "1")
    monkeypatch.delenv("OMR_ENSEMBLE_TIMING", raising=False)
    # Clarity: [rest dur 4, C5 quarter] -> note onset 4, bar ends at 8 (INCOMPLETE, cap 16).
    primary = _clarity_one_treble_rest_then_note(4, _note("C", 5, 4))
    # oemer places the SAME C5 at onset 12 (bar would complete: 12+4==16).
    secondary = _oemer_one_treble([_rest(12, staff=1), _note("C", 5, 4, staff=1)])
    out = reconcile_docs(primary, secondary)
    root = ET.fromstring(out)
    rest = next(n for n in root.iter("note") if n.find("rest") is not None)
    assert rest.findtext("duration") == "4"  # leading rest UNCHANGED -> D was a no-op


def test_add_disabled_by_default_is_noop(monkeypatch):
    # OMR_ENSEMBLE on but OMR_ENSEMBLE_ADD unset: an oemer-only note is DROPPED (Slice-3 no-op).
    monkeypatch.setenv("OMR_ENSEMBLE", "1")
    monkeypatch.delenv("OMR_ENSEMBLE_ADD", raising=False)
    primary = _clarity_one_treble([_note("C", 5, 4)])
    secondary = _oemer_one_treble(
        [_note("C", 5, 4, staff=1), _note("E", 5, 4, staff=1)]
    )
    out = reconcile_docs(primary, secondary)
    assert _emitted_pitches(out) == [("C", 0, 5)]  # E5 NOT added


def test_subgate_requires_parent_ensemble(monkeypatch):
    # The sub-gate is ON but the PARENT OMR_ENSEMBLE is OFF: still a no-op (sub-gates AND the
    # parent flag must both be set). reconcile.add_enabled() must be False here.
    monkeypatch.delenv("OMR_ENSEMBLE", raising=False)
    monkeypatch.setenv("OMR_ENSEMBLE_ADD", "1")
    monkeypatch.setenv("OMR_ENSEMBLE_TIMING", "1")
    assert reconcile.add_enabled() is False
    assert reconcile.timing_enabled() is False


def test_subgate_helpers_truthy_parsing(monkeypatch):
    monkeypatch.setenv("OMR_ENSEMBLE", "1")
    monkeypatch.setenv("OMR_ENSEMBLE_TIMING", "true")
    monkeypatch.setenv("OMR_ENSEMBLE_ADD", "0")
    assert reconcile.timing_enabled() is True
    assert reconcile.add_enabled() is False


# --- Class D: timing mismatch (gated by OMR_ENSEMBLE_TIMING) -----------------------------


def test_class_d_metric_completeness_shifts_note(ensemble_on):
    # Clarity: [rest dur 4, C5 quarter] -> note at onset 4, bar ends at 8 (INCOMPLETE; cap 16).
    # oemer reads the SAME C5 at onset 12, which makes the bar EXACTLY complete (12+4==16). The
    # metric-completeness vote picks oemer's onset; the safe shape (note is last, preceded by a
    # rest) lets us resize ONLY the leading rest, so the note moves to onset 12.
    ensemble_on.setenv("OMR_ENSEMBLE_TIMING", "1")
    primary = _clarity_one_treble_rest_then_note(4, _note("C", 5, 4))
    secondary = _oemer_one_treble([_rest(12, staff=1), _note("C", 5, 4, staff=1)])
    out = reconcile_docs(primary, secondary)
    root = ET.fromstring(out)
    rest = next(n for n in root.iter("note") if n.find("rest") is not None)
    assert rest.findtext("duration") == "12"  # leading rest grown 4 -> 12, note now at onset 12
    note = next(n for n in root.iter("note") if n.find("pitch") is not None)
    assert note.findtext("duration") == "4"  # the note's OWN duration is untouched


def test_class_d_ambiguous_keeps_clarity(ensemble_on):
    # Clarity's bar is ALREADY complete ([rest dur 12, C5 quarter] -> 12+4==16). oemer reads the
    # note earlier (onset 4) which would NOT complete the bar. Ambiguous/Clarity-complete -> keep.
    ensemble_on.setenv("OMR_ENSEMBLE_TIMING", "1")
    primary = _clarity_one_treble_rest_then_note(12, _note("C", 5, 4))
    secondary = _oemer_one_treble([_rest(4, staff=1), _note("C", 5, 4, staff=1)])
    out = reconcile_docs(primary, secondary)
    root = ET.fromstring(out)
    rest = next(n for n in root.iter("note") if n.find("rest") is not None)
    assert rest.findtext("duration") == "12"  # unchanged -> Clarity kept


def test_class_d_unsafe_shape_is_declined(ensemble_on):
    # NOT the safe shape: the disputed Clarity note is FOLLOWED by another note (not last in the
    # cell), so shifting it would move the following note. We must DECLINE (keep Clarity) rather
    # than corrupt the measure. Clarity: [rest 4, C5 quarter, G5 quarter]; oemer puts C5 at 12.
    ensemble_on.setenv("OMR_ENSEMBLE_TIMING", "1")
    attrs = (
        "<attributes><divisions>4</divisions>"
        "<key><fifths>0</fifths></key>"
        "<time><beats>4</beats><beat-type>4</beat-type></time>"
        "<clef><sign>G</sign><line>2</line></clef>"
        "</attributes>"
    )
    body = _rest(4) + _note("C", 5, 4) + _note("G", 5, 4)
    primary = (
        '<?xml version="1.0"?><score-partwise version="4.0">'
        '<part-list><score-part id="P1"><part-name>RH</part-name></score-part></part-list>'
        '<part id="P1"><measure number="1">%s%s</measure></part>'
        "</score-partwise>" % (attrs, body)
    ).encode("utf-8")
    secondary = _oemer_one_treble([_rest(12, staff=1), _note("C", 5, 4, staff=1)])
    out = reconcile_docs(primary, secondary)
    root = ET.fromstring(out)
    rest = next(n for n in root.iter("note") if n.find("rest") is not None)
    assert rest.findtext("duration") == "4"  # leading rest UNCHANGED -> declined


def test_class_d_does_not_shift_later_notes(ensemble_on):
    # A D correction must never shift the rest of the measure. In the safe shape the corrected
    # note is the LAST note, so by construction nothing follows it. Verify the only mutation is
    # the leading rest's duration: the note's onset moves but no extra elements appear/disappear.
    ensemble_on.setenv("OMR_ENSEMBLE_TIMING", "1")
    primary = _clarity_one_treble_rest_then_note(4, _note("C", 5, 4))
    secondary = _oemer_one_treble([_rest(12, staff=1), _note("C", 5, 4, staff=1)])
    out = reconcile_docs(primary, secondary)
    root = ET.fromstring(out)
    notes = list(root.iter("note"))
    assert len(notes) == 2  # still exactly [rest, note], no inserted/removed elements
    assert notes[0].find("rest") is not None
    assert notes[1].find("pitch") is not None


# --- Class C: oemer-only ADD (gated by OMR_ENSEMBLE_ADD) ---------------------------------


def _clarity_treble_gap():
    """Clarity treble measure [C5 quarter @0, <gap @4>, G5 quarter @8, rest 4 @12] in 4/4,
    div=4 -> a genuine empty onset slot at 4."""
    attrs = (
        "<attributes><divisions>4</divisions>"
        "<key><fifths>0</fifths></key>"
        "<time><beats>4</beats><beat-type>4</beat-type></time>"
        "<clef><sign>G</sign><line>2</line></clef>"
        "</attributes>"
    )
    body = _note("C", 5, 4) + _rest(4) + _note("G", 5, 4) + _rest(4)
    return (
        '<?xml version="1.0"?><score-partwise version="4.0">'
        '<part-list><score-part id="P1"><part-name>RH</part-name></score-part></part-list>'
        '<part id="P1"><measure number="1">%s%s</measure></part>'
        "</score-partwise>" % (attrs, body)
    ).encode("utf-8")


def test_class_c_add_when_diatonic_fills_gap_in_range(ensemble_on):
    # oemer has an E5 at onset 4 where Clarity has a gap (an empty slot). E5 is diatonic (C major),
    # in range, and adding it (dur 4) does not overflow. ALL gates pass -> ADD at the right slot.
    ensemble_on.setenv("OMR_ENSEMBLE_ADD", "1")
    primary = _clarity_treble_gap()
    secondary = _oemer_one_treble(
        [
            _note("C", 5, 4, staff=1),
            _note("E", 5, 4, staff=1),
            _note("G", 5, 4, staff=1),
            _rest(4, staff=1),
        ]
    )
    out = reconcile_docs(primary, secondary)
    # The added E5 lands BETWEEN C5 and G5 (onset 4), in document order.
    assert _emitted_pitches(out) == [("C", 0, 5), ("E", 0, 5), ("G", 0, 5)]
    # And it carries the CLARITY-base duration (4), not oemer's native ticks.
    root = ET.fromstring(out)
    e5 = next(
        n for n in root.iter("note")
        if n.find("pitch") is not None and n.findtext("pitch/step") == "E"
    )
    assert e5.findtext("duration") == "4"


def test_class_c_add_dropped_when_non_diatonic(ensemble_on):
    # oemer's gap note is C#5 (non-diatonic in C major). The diatonicity gate fails -> DROP.
    ensemble_on.setenv("OMR_ENSEMBLE_ADD", "1")
    primary = _clarity_treble_gap()
    secondary = _oemer_one_treble(
        [
            _note("C", 5, 4, staff=1),
            _note("C", 5, 4, staff=1, alter=1),
            _note("G", 5, 4, staff=1),
            _rest(4, staff=1),
        ]
    )
    out = reconcile_docs(primary, secondary)
    assert _emitted_pitches(out) == [("C", 0, 5), ("G", 0, 5)]  # C#5 NOT added


def test_class_c_add_dropped_when_out_of_range(ensemble_on):
    # oemer's gap note is an absurd C12 (out of MIDI range). The range gate fails -> DROP.
    ensemble_on.setenv("OMR_ENSEMBLE_ADD", "1")
    primary = _clarity_treble_gap()
    secondary = _oemer_one_treble(
        [
            _note("C", 5, 4, staff=1),
            _note("C", 12, 4, staff=1),
            _note("G", 5, 4, staff=1),
            _rest(4, staff=1),
        ]
    )
    out = reconcile_docs(primary, secondary)
    assert _emitted_pitches(out) == [("C", 0, 5), ("G", 0, 5)]  # C12 NOT added


def test_class_c_add_dropped_when_would_overflow(ensemble_on):
    # Clarity already fills the whole bar (4 quarters, no gap). oemer has an EXTRA diatonic E5 in
    # an occupied slot; adding it would overflow the bar. The gap/overflow gate fails -> DROP.
    ensemble_on.setenv("OMR_ENSEMBLE_ADD", "1")
    primary = _clarity_one_treble(
        [_note("C", 5, 4), _note("D", 5, 4), _note("E", 5, 4), _note("F", 5, 4)]
    )
    secondary = _oemer_one_treble(
        [
            _note("C", 5, 4, staff=1),
            _note("D", 5, 4, staff=1),
            _note("E", 5, 4, staff=1),
            _note("F", 5, 4, staff=1),
            _note("G", 5, 4, staff=1),
        ]
    )
    out = reconcile_docs(primary, secondary)
    assert _emitted_pitches(out) == [
        ("C", 0, 5),
        ("D", 0, 5),
        ("E", 0, 5),
        ("F", 0, 5),
    ]  # G5 NOT added (would overflow)


def test_class_c_clarity_only_kept_by_default(ensemble_on):
    # A Clarity-only note oemer lacks is KEPT (Clarity has better recall). Even with ADD on.
    ensemble_on.setenv("OMR_ENSEMBLE_ADD", "1")
    ensemble_on.setenv("OMR_ENSEMBLE_TIMING", "1")
    primary = _clarity_one_treble([_note("C", 5, 4), _note("D", 5, 4)])
    secondary = _oemer_one_treble([_note("C", 5, 4, staff=1)])
    out = reconcile_docs(primary, secondary)
    assert _emitted_pitches(out) == [("C", 0, 5), ("D", 0, 5)]  # D5 kept


def test_class_c_clarity_only_kept_even_when_suspicious(ensemble_on):
    # A slightly suspicious Clarity-only note (non-diatonic C#5) is STILL kept by default: we
    # never drop a Clarity note (better recall). Default = keep.
    ensemble_on.setenv("OMR_ENSEMBLE_ADD", "1")
    primary = _clarity_one_treble([_note("C", 5, 4), _note("C", 5, 4, alter=1)])
    secondary = _oemer_one_treble([_note("C", 5, 4, staff=1)])
    out = reconcile_docs(primary, secondary)
    assert _emitted_pitches(out) == [("C", 0, 5), ("C", 1, 5)]  # C#5 kept


def test_class_c_add_robust_on_malformed_secondary(ensemble_on):
    # Robustness: even with the ADD gate on, a malformed secondary returns the primary unchanged.
    ensemble_on.setenv("OMR_ENSEMBLE_ADD", "1")
    primary = _clarity_one_treble([_note("C", 5, 4)])
    out = reconcile_docs(primary, b"<broken<<<")
    assert out == primary


# === Slice 6b: class B residual visual-diff referee (gated by OMR_ENSEMBLE_REFEREE) =======
# The referee is consulted ONLY for residual class-B pitch disputes the FREE heuristics could
# not separate, ONLY in its proven scope (isolated notehead, interval >= a third), and ONLY when
# the OMR_ENSEMBLE_REFEREE sub-gate (+ parent OMR_ENSEMBLE) is on AND an input_pdf is supplied.
# It ADJUDICATES between the two existing candidates (A=Clarity, B=oemer): a pick of oemer wins,
# a decline/None/failure keeps the heuristic result (Clarity). Never introduces a third pitch.
# These tests stub referee_pick (and the localizer) so they need NO verovio.

import referee as _referee_mod  # noqa: E402


@pytest.fixture
def referee_on(monkeypatch):
    """OMR_ENSEMBLE + OMR_ENSEMBLE_REFEREE on, referee.REFEREE_AVAILABLE forced True, and the
    localizer stubbed to a non-None crop so the referee path is reached without verovio. The
    individual test sets referee.referee_pick to control the verdict."""
    monkeypatch.setenv("OMR_ENSEMBLE", "1")
    monkeypatch.setenv("OMR_ENSEMBLE_REFEREE", "1")
    monkeypatch.setattr(_referee_mod, "REFEREE_AVAILABLE", True)
    # render_candidate would need verovio; stub it to a harmless sentinel (the stubbed
    # referee_pick ignores it anyway).
    monkeypatch.setattr(_referee_mod, "render_candidate", lambda *a, **k: object())
    # Localizer returns a non-None (crop, geometry) so the referee_pick branch is exercised.
    monkeypatch.setattr(
        reconcile,
        "_localize_dispute",
        lambda *a, **k: ("CROP", {"lines": [0, 1, 2, 3, 4], "x_center": 2}),
    )
    return monkeypatch


# A residual, in-scope class-B fixture: C major, Clarity E5 vs oemer G5 (interval 3 = a minor
# third), both diatonic, both in range, no previous note, ISOLATED. The heuristics fall through
# to the Clarity tiebreak, so this is exactly the residual the referee arbitrates.
def _residual_third_dispute():
    primary = _clarity_one_treble([_note("E", 5, 4)])
    secondary = _oemer_one_treble([_note("G", 5, 4, staff=1)])
    return primary, secondary


def test_referee_subgate_off_never_calls_referee(monkeypatch):
    # OMR_ENSEMBLE on but OMR_ENSEMBLE_REFEREE unset: the referee is NEVER consulted; the residual
    # class-B dispute tiebreaks to Clarity (Slice-3 behavior), byte-identical to no referee.
    monkeypatch.setenv("OMR_ENSEMBLE", "1")
    monkeypatch.delenv("OMR_ENSEMBLE_REFEREE", raising=False)
    monkeypatch.setattr(_referee_mod, "REFEREE_AVAILABLE", True)
    called = {"localize": False, "pick": False}
    monkeypatch.setattr(
        reconcile, "_localize_dispute",
        lambda *a, **k: called.__setitem__("localize", True) or ("CROP", {}),
    )
    monkeypatch.setattr(
        _referee_mod, "referee_pick",
        lambda *a, **k: called.__setitem__("pick", True) or "b",
    )
    primary, secondary = _residual_third_dispute()
    out = reconcile_docs(primary, secondary, input_pdf="RASTER")
    assert _emitted_pitches(out) == [("E", 0, 5)]  # Clarity kept
    assert called == {"localize": False, "pick": False}  # referee never touched


def test_referee_no_input_pdf_never_calls_referee(monkeypatch):
    # Sub-gate ON but NO input_pdf passed (e.g. raster failed): referee path is never entered.
    monkeypatch.setenv("OMR_ENSEMBLE", "1")
    monkeypatch.setenv("OMR_ENSEMBLE_REFEREE", "1")
    monkeypatch.setattr(_referee_mod, "REFEREE_AVAILABLE", True)
    called = {"pick": False}
    monkeypatch.setattr(
        _referee_mod, "referee_pick",
        lambda *a, **k: called.__setitem__("pick", True) or "b",
    )
    primary, secondary = _residual_third_dispute()
    out = reconcile_docs(primary, secondary)  # input_pdf defaults to None
    assert _emitted_pitches(out) == [("E", 0, 5)]  # Clarity kept
    assert called["pick"] is False


def test_referee_unavailable_is_noop(monkeypatch):
    # Sub-gate ON, input_pdf supplied, but REFEREE_AVAILABLE False (verovio absent on the worker):
    # the referee path short-circuits to decline; the residual dispute keeps Clarity.
    monkeypatch.setenv("OMR_ENSEMBLE", "1")
    monkeypatch.setenv("OMR_ENSEMBLE_REFEREE", "1")
    monkeypatch.setattr(_referee_mod, "REFEREE_AVAILABLE", False)
    called = {"pick": False}
    monkeypatch.setattr(
        _referee_mod, "referee_pick",
        lambda *a, **k: called.__setitem__("pick", True) or "b",
    )
    primary, secondary = _residual_third_dispute()
    out = reconcile_docs(primary, secondary, input_pdf="RASTER")
    assert _emitted_pitches(out) == [("E", 0, 5)]  # Clarity kept
    assert called["pick"] is False  # never reached referee_pick


def test_referee_pick_oemer_wins_on_residual_in_scope(referee_on):
    # The residual, in-scope dispute routes to the referee, and the referee's pick of 'b' (oemer)
    # OVERRIDES the Clarity tiebreak. The output adopts oemer's G5 (only the pitch; class B).
    referee_on.setattr(_referee_mod, "referee_pick", lambda *a, **k: "b")
    primary, secondary = _residual_third_dispute()
    out = reconcile_docs(primary, secondary, input_pdf="RASTER")
    assert _emitted_pitches(out) == [("G", 0, 5)]  # oemer's pick adopted


def test_referee_pick_clarity_keeps_clarity(referee_on):
    # The referee explicitly picks 'a' (Clarity): Clarity stays. (Same result as the tiebreak,
    # but confirms an 'a' verdict is honored and never swaps.)
    referee_on.setattr(_referee_mod, "referee_pick", lambda *a, **k: "a")
    primary, secondary = _residual_third_dispute()
    out = reconcile_docs(primary, secondary, input_pdf="RASTER")
    assert _emitted_pitches(out) == [("E", 0, 5)]


def test_referee_decline_keeps_clarity(referee_on):
    # The referee DECLINES (None, e.g. below the confidence margin): keep the heuristic result.
    referee_on.setattr(_referee_mod, "referee_pick", lambda *a, **k: None)
    primary, secondary = _residual_third_dispute()
    out = reconcile_docs(primary, secondary, input_pdf="RASTER")
    assert _emitted_pitches(out) == [("E", 0, 5)]  # Clarity kept on decline


def test_referee_out_of_scope_step_never_calls_referee(referee_on):
    # A residual class-B dispute of a STEP (2nd, interval 2) is OUT of the referee's scope:
    # is_refereeable_dispute returns False, so referee_pick is NEVER called and Clarity is kept.
    called = {"pick": False}
    referee_on.setattr(
        _referee_mod, "referee_pick",
        lambda *a, **k: called.__setitem__("pick", True) or "b",
    )
    # C major; Clarity D5 vs oemer E5 (interval 2 = a 2nd), both diatonic + in range, no prev.
    primary = _clarity_one_treble([_note("D", 5, 4)])
    secondary = _oemer_one_treble([_note("E", 5, 4, staff=1)])
    out = reconcile_docs(primary, secondary, input_pdf="RASTER")
    assert _emitted_pitches(out) == [("D", 0, 5)]  # Clarity kept
    assert called["pick"] is False  # step dispute never reaches the referee


def test_referee_not_called_when_heuristics_already_decided(referee_on):
    # When the FREE heuristics ALREADY separated the pair (here: diatonicity picks oemer's C5 over
    # Clarity's non-diatonic C#5), the dispute is NOT residual, so the referee is not consulted -
    # the heuristic decision stands on its own.
    called = {"pick": False}
    referee_on.setattr(
        _referee_mod, "referee_pick",
        lambda *a, **k: called.__setitem__("pick", True) or "a",  # would pick Clarity
    )
    primary = _clarity_one_treble([_note("C", 5, 4, alter=1)], fifths=0)  # C#5 non-diatonic
    secondary = _oemer_one_treble([_note("C", 5, 4, staff=1)])  # C5 diatonic
    out = reconcile_docs(primary, secondary, input_pdf="RASTER")
    assert _emitted_pitches(out) == [("C", 0, 5)]  # heuristic (diatonicity) result, not referee
    assert called["pick"] is False


def test_referee_localization_none_keeps_clarity(referee_on):
    # The localizer cannot place the note (returns None): the referee declines (no crop). This is
    # the SHIPPED state (robust localization is the remaining blocker) - a correct no-op.
    referee_on.setattr(reconcile, "_localize_dispute", lambda *a, **k: None)
    referee_on.setattr(_referee_mod, "referee_pick", lambda *a, **k: "b")  # would pick oemer
    primary, secondary = _residual_third_dispute()
    out = reconcile_docs(primary, secondary, input_pdf="RASTER")
    assert _emitted_pitches(out) == [("E", 0, 5)]  # localization None -> Clarity kept


def test_referee_pick_raising_keeps_clarity(referee_on):
    # referee_pick raising must NEVER propagate: _maybe_referee_pitch swallows it and declines,
    # keeping the heuristic result (Clarity). Preserves the never-raise contract.
    def _boom(*a, **k):
        raise RuntimeError("referee blew up")

    referee_on.setattr(_referee_mod, "referee_pick", _boom)
    primary, secondary = _residual_third_dispute()
    out = reconcile_docs(primary, secondary, input_pdf="RASTER")  # must not raise
    assert _emitted_pitches(out) == [("E", 0, 5)]  # Clarity kept


def test_referee_localization_raising_keeps_clarity(referee_on):
    # Localization raising is also swallowed -> decline -> Clarity. Never propagates.
    def _boom(*a, **k):
        raise RuntimeError("localize blew up")

    referee_on.setattr(reconcile, "_localize_dispute", _boom)
    referee_on.setattr(_referee_mod, "referee_pick", lambda *a, **k: "b")
    primary, secondary = _residual_third_dispute()
    out = reconcile_docs(primary, secondary, input_pdf="RASTER")  # must not raise
    assert _emitted_pitches(out) == [("E", 0, 5)]  # Clarity kept


def test_referee_chorded_slot_not_isolated_never_picks(referee_on):
    # A class-B dispute inside a CHORD (the disputed note shares its onset with a chord member) is
    # NOT an isolated notehead, so is_refereeable_dispute(is_isolated=False) declines and the
    # referee is not consulted. Clarity chord: [G5, C6(chord member)] at onset 0; oemer reads the
    # G5 as E5 (interval 3 = a third, residual + in scope BY INTERVAL, but NOT isolated because
    # the slot holds two pitched notes). Must keep Clarity without consulting the referee.
    called = {"pick": False}
    referee_on.setattr(
        _referee_mod, "referee_pick",
        lambda *a, **k: called.__setitem__("pick", True) or "b",
    )
    primary = _clarity_one_treble([_note("G", 5, 4), _note("C", 6, 4, chord=True)])
    secondary = _oemer_one_treble([_note("E", 5, 4, staff=1), _note("C", 6, 4, staff=1, chord=True)])
    out = reconcile_docs(primary, secondary, input_pdf="RASTER")
    # The disputed G5-vs-E5 is at a chorded onset -> not isolated -> referee not consulted; the
    # heuristic tiebreak keeps Clarity's G5. C6 agrees, stays.
    assert ("G", 0, 5) in _emitted_pitches(out)
    assert called["pick"] is False


def test_referee_scope_predicate_called_with_real_referee_when_available(referee_on):
    # Sanity: with REFEREE_AVAILABLE True and the real scope predicates (not stubbed), an in-scope
    # third dispute reaches referee_pick. We stub ONLY referee_pick; pitch_interval_semitones and
    # is_refereeable_dispute run for real, confirming the wiring uses them correctly.
    seen = {}

    def _pick(pdf_crop, staff_geometry, cand_a, cand_b):
        seen["called"] = True
        return None  # decline so the result stays Clarity regardless.

    referee_on.setattr(_referee_mod, "referee_pick", _pick)
    primary, secondary = _residual_third_dispute()
    out = reconcile_docs(primary, secondary, input_pdf="RASTER")
    assert seen.get("called") is True  # the real scope predicates admitted this dispute
    assert _emitted_pitches(out) == [("E", 0, 5)]


# --- Sub-gate + pure-helper unit tests (Slice 6b) ----------------------------------------


def test_referee_subgate_requires_parent(monkeypatch):
    # OMR_ENSEMBLE_REFEREE on but parent OMR_ENSEMBLE off -> referee_enabled() is False.
    monkeypatch.delenv("OMR_ENSEMBLE", raising=False)
    monkeypatch.setenv("OMR_ENSEMBLE_REFEREE", "1")
    assert reconcile.referee_enabled() is False


def test_referee_subgate_truthy_parsing(monkeypatch):
    monkeypatch.setenv("OMR_ENSEMBLE", "1")
    monkeypatch.setenv("OMR_ENSEMBLE_REFEREE", "true")
    assert reconcile.referee_enabled() is True
    monkeypatch.setenv("OMR_ENSEMBLE_REFEREE", "0")
    assert reconcile.referee_enabled() is False


def test_pitch_vote_is_residual_true_when_unseparated():
    # Both diatonic + in range, no octave-jump split, no prev note: nothing separates -> residual.
    c = NoteEvent(measure=1, onset=0, staff=1, pitch=("E", 0, 5), duration=4, is_chord=False)
    o = NoteEvent(measure=1, onset=0, staff=1, pitch=("G", 0, 5), duration=4, is_chord=False)
    dia = reconcile._diatonic_pitch_classes(0)
    assert reconcile._pitch_vote_is_residual(c, o, dia, None) is True


def test_pitch_vote_is_residual_false_when_diatonicity_decides():
    # Clarity C#5 (non-diatonic) vs oemer C5 (diatonic): diatonicity SEPARATES -> not residual.
    c = NoteEvent(measure=1, onset=0, staff=1, pitch=("C", 1, 5), duration=4, is_chord=False)
    o = NoteEvent(measure=1, onset=0, staff=1, pitch=("C", 0, 5), duration=4, is_chord=False)
    dia = reconcile._diatonic_pitch_classes(0)
    assert reconcile._pitch_vote_is_residual(c, o, dia, None) is False


def test_pitch_vote_is_residual_ignores_voice_leading():
    # REGRESSION (2026-06-02): voice-leading was REMOVED from _vote_pitch, so it no longer makes a
    # dispute non-residual. With a prev note A4 (MIDI 69), Clarity G5 vs oemer B4 (both diatonic,
    # both in range) is now RESIDUAL despite the differing melodic intervals. prev_midi is unused.
    c = NoteEvent(measure=1, onset=4, staff=1, pitch=("G", 0, 5), duration=4, is_chord=False)
    o = NoteEvent(measure=1, onset=4, staff=1, pitch=("B", 0, 4), duration=4, is_chord=False)
    dia = reconcile._diatonic_pitch_classes(0)
    assert reconcile._pitch_vote_is_residual(c, o, dia, 69) is True


def test_isolated_slots_excludes_chord_and_coincident():
    # One isolated note (m1 onset 0), a chord stack (m1 onset 4 has two pitched notes) -> only the
    # isolated slot is returned; rests are ignored.
    events = [
        NoteEvent(measure=1, onset=0, staff=1, pitch=("C", 0, 5), duration=4, is_chord=False),
        NoteEvent(measure=1, onset=4, staff=1, pitch=("E", 0, 5), duration=4, is_chord=False),
        NoteEvent(measure=1, onset=4, staff=1, pitch=("G", 0, 5), duration=4, is_chord=True),
        NoteEvent(measure=1, onset=8, staff=1, pitch=None, duration=4, is_chord=False),
    ]
    slots = reconcile._isolated_slots(events)
    assert (1, 1, 0) in slots
    assert (1, 1, 4) not in slots  # chorded onset is not isolated
    assert (1, 1, 8) not in slots  # rest is not a notehead
