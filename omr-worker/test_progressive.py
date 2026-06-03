#!/usr/bin/env python3
"""Tests for progressive.py (stamp_partial + append_measures). Pure stdlib; build fixtures with the
tested llm_omr builder so they match the real geom/fusion output shape (1 part / 2 staves, no
<identification>). The stamp_partial assertions mirror the byte-level regexes the browser client uses
in src/omr.ts, so a drift between worker and client is caught here."""
import re
import xml.etree.ElementTree as ET

import llm_omr
import progressive

# The exact patterns src/omr.ts uses to read the markers. Kept here so a worker-side rename of the
# field or value breaks this test (the worker and client must agree on the wire format).
_PARTIAL_RE = re.compile(r'name="omr-status"\s*>\s*partial')
_FAILED_RE = re.compile(r'name="omr-status"\s*>\s*failed')
_VERSION_RE = re.compile(r'name="omr-version"\s*>\s*(\d+)')


def _xml(measures, divisions=4):
    return llm_omr.score_json_to_musicxml(
        {"divisions": divisions, "time": {"beats": 4, "beat_type": 4}, "measures": measures})


def _one_note_measures(steps, octave=5):
    """One measure per step letter, each a single staff-1 quarter note, so a fixture's measure count
    is just len(steps)."""
    return [{"staff1": [{"duration": 4, "pitches": [{"step": s, "octave": octave}]}], "staff2": []}
            for s in steps]


# --- stamp_partial ------------------------------------------------------------------------------

def test_stamp_partial_marks_status_and_version_for_the_client():
    base = _xml(_one_note_measures(["C", "D"]))
    stamped = progressive.stamp_partial(base, 1)
    # The browser's partial + version regexes both match; the failure regex must NOT (a partial is
    # not a failure).
    assert _PARTIAL_RE.search(stamped.decode("utf-8"))
    assert _VERSION_RE.search(stamped.decode("utf-8")).group(1) == "1"
    assert not _FAILED_RE.search(stamped.decode("utf-8"))


def test_stamp_partial_inserts_identification_before_part_list():
    # The score-partwise schema requires <identification> to precede <part-list>; OSMD/music21 reject
    # the reverse. The fusion/geom builders emit no identification, so we create one in the right spot.
    stamped = progressive.stamp_partial(_xml(_one_note_measures(["C"])), 3)
    root = ET.fromstring(stamped)
    tags = [child.tag for child in root]
    assert "identification" in tags and "part-list" in tags
    assert tags.index("identification") < tags.index("part-list")


def test_stamp_partial_is_idempotent_on_reversion():
    # Re-stamping (e.g. a later page bumps the version) replaces the fields in place rather than
    # appending duplicates, so exactly one status + one version field exist.
    once = progressive.stamp_partial(_xml(_one_note_measures(["C"])), 1)
    twice = progressive.stamp_partial(once, 2)
    root = ET.fromstring(twice)
    fields = root.findall("identification/miscellaneous/miscellaneous-field")
    by_name = {}
    for f in fields:
        by_name.setdefault(f.get("name"), []).append(f.text)
    assert by_name.get("omr-status") == ["partial"]
    assert by_name.get("omr-version") == ["2"]


def test_stamp_partial_preserves_the_score_notes():
    base = _xml(_one_note_measures(["C", "E", "G"]))
    stamped = progressive.stamp_partial(base, 1)
    assert len(ET.fromstring(stamped).findall(".//note")) == 3  # all notes survive the stamp


def test_stamp_partial_returns_input_unchanged_on_garbage():
    # NEVER raises: un-parseable bytes come back exactly as given (degrade to an unmarked == complete
    # result rather than corrupt anything).
    junk = b"not xml at all"
    assert progressive.stamp_partial(junk, 1) == junk


def test_is_partial_marked_detects_the_in_body_marker():
    stamped = progressive.stamp_partial(_xml(_one_note_measures(["C"])), 1)
    assert progressive.is_partial_marked(stamped) is True


def test_is_partial_marked_false_for_unmarked_or_garbage():
    # The guard that stops an unmarked body being written to the result key: a complete (unmarked)
    # score and junk both read as "not a partial".
    assert progressive.is_partial_marked(_xml(_one_note_measures(["C"]))) is False
    assert progressive.is_partial_marked(b"not xml at all") is False


# --- append_measures ----------------------------------------------------------------------------

def test_append_measures_none_accumulated_returns_page_unchanged():
    page = _xml(_one_note_measures(["C", "D"]))
    assert progressive.append_measures(None, page) == page


def test_append_measures_concatenates_and_renumbers_sequentially():
    page1 = _xml(_one_note_measures(["C", "D"]))      # measures 1, 2
    page2 = _xml(_one_note_measures(["E", "F", "G"]))  # measures 1, 2, 3 (will renumber to 3, 4, 5)
    merged = progressive.append_measures(page1, page2)
    root = ET.fromstring(merged)
    parts = root.findall("part")
    assert len(parts) == 1, "stays one continuous grand-staff part"
    numbers = [m.get("number") for m in parts[0].findall("measure")]
    assert numbers == ["1", "2", "3", "4", "5"], numbers


def test_append_measures_keeps_all_notes_from_both_pages():
    page1 = _xml(_one_note_measures(["C", "D"]))
    page2 = _xml(_one_note_measures(["E", "F", "G"]))
    merged = progressive.append_measures(page1, page2)
    assert len(ET.fromstring(merged).findall(".//note")) == 5  # 2 + 3 notes


def test_append_measures_accumulates_across_three_pages():
    acc = None
    for steps in (["C"], ["D", "E"], ["F", "G", "A"]):
        acc = progressive.append_measures(acc, _xml(_one_note_measures(steps)))
    numbers = [m.get("number") for m in ET.fromstring(acc).findall("part/measure")]
    assert numbers == ["1", "2", "3", "4", "5", "6"], numbers


def test_append_measures_empty_page_returns_accumulated():
    page1 = _xml(_one_note_measures(["C"]))
    assert progressive.append_measures(page1, b"") == page1


def test_append_measures_returns_accumulated_on_garbage_page():
    # A malformed page must never drop already-published measures: we keep the accumulated doc.
    page1 = _xml(_one_note_measures(["C", "D"]))
    assert progressive.append_measures(page1, b"<not-xml") == page1
