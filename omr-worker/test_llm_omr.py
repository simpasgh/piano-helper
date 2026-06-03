"""Unit tests for the LLM-vision transcriber (llm_omr.py).

Covers the PURE, deterministic parts (no network, no API key):
  - score_json_to_musicxml builds a valid 1-part/2-staff grand staff, gets CHORDS right
    (the whole reason this engine exists), handles rests, two staves via backup, and the
    measure-1 attributes;
  - _extract_json tolerates ```json fences and surrounding prose;
  - gating (llm_enabled / llm_available) is off without the flag + key;
  - transcribe() never raises and returns None when unavailable;
  - a fake-provider end-to-end (monkeypatched HTTP) proves the wiring image->JSON->MusicXML.

reconcile.to_events is reused to read the built MusicXML back into comparable note events.
"""

import xml.etree.ElementTree as ET

import llm_omr
import reconcile


# --- score_json_to_musicxml: the deterministic builder -----------------------------------


def _events(xml_bytes):
    return reconcile.to_events(xml_bytes, "llm")


def test_builder_gets_a_chord_right():
    # The icarus failure case: a bass (staff 2) chord of three stacked notes. The builder must
    # emit them as ONE onset with two <chord/> members (a real 3-note chord), not 3 separate
    # notes at different times.
    data = {
        "divisions": 4,
        "key_fifths": 0,
        "time": {"beats": 4, "beat_type": 4},
        "measures": [
            {
                "staff1": [
                    {"duration": 16, "pitches": [{"step": "G", "octave": 5}]}
                ],
                "staff2": [
                    {
                        "duration": 16,
                        "pitches": [
                            {"step": "E", "octave": 3},
                            {"step": "G", "octave": 3},
                            {"step": "B", "octave": 3},
                        ],
                    }
                ],
            }
        ],
    }
    xml = llm_omr.score_json_to_musicxml(data)
    assert xml is not None
    events = _events(xml)
    # staff 2 should hold exactly 3 pitched notes, all at the SAME onset, two of them chord members.
    bass = [e for e in events if e.staff == 2 and e.pitch is not None]
    assert len(bass) == 3
    assert len({e.onset for e in bass}) == 1  # all coincident = a real chord
    assert sum(1 for e in bass if e.is_chord) == 2  # first note + 2 chord members
    assert {(e.pitch[0], e.pitch[2]) for e in bass} == {("E", 3), ("G", 3), ("B", 3)}
    # staff 1 holds the single G5.
    treble = [e for e in events if e.staff == 1 and e.pitch is not None]
    assert len(treble) == 1 and treble[0].pitch == ("G", 0, 5)


def test_builder_emits_attributes_and_two_staves():
    data = {
        "divisions": 2,
        "key_fifths": -1,
        "time": {"beats": 3, "beat_type": 4},
        "measures": [
            {
                "staff1": [{"duration": 6, "pitches": [{"step": "C", "octave": 5}]}],
                "staff2": [{"duration": 6, "pitches": [{"step": "C", "octave": 3}]}],
            }
        ],
    }
    xml = llm_omr.score_json_to_musicxml(data)
    root = ET.fromstring(xml)
    assert root.findtext(".//divisions") == "2"
    assert root.findtext(".//key/fifths") == "-1"
    assert root.findtext(".//time/beats") == "3"
    assert root.findtext(".//staves") == "2"
    signs = [c.findtext("sign") for c in root.findall(".//clef")]
    assert signs == ["G", "F"]
    # A backup separates the two staves.
    assert root.find(".//backup/duration") is not None


def test_builder_handles_rests_and_alters():
    data = {
        "divisions": 4,
        "measures": [
            {
                "staff1": [
                    {"rest": True, "duration": 8},
                    {"duration": 8, "pitches": [{"step": "B", "alter": -1, "octave": 4}]},
                ],
                "staff2": [],
            }
        ],
    }
    xml = llm_omr.score_json_to_musicxml(data)
    events = _events(xml)
    rest = [e for e in events if e.pitch is None]
    assert len(rest) == 1
    bflat = [e for e in events if e.pitch is not None]
    assert bflat and bflat[0].pitch == ("B", -1, 4)


def test_builder_emits_optin_visual_elements():
    # type/dots/accidental/beams are emitted ONLY when the event carries them, in MusicXML order
    # (after duration: type, dot, accidental, staff; beam after staff). They engrave the glyphs the
    # symbol detector trains on but must not change the pitch/duration the scorer reads.
    data = {
        "divisions": 4,
        "measures": [{"staff1": [
            {"duration": 3, "type": "eighth", "dots": 1,
             "pitches": [{"step": "F", "alter": 1, "octave": 5, "accidental": "sharp"}],
             "beams": [{"number": 1, "value": "begin"}]},
            {"duration": 1, "type": "16th",
             "pitches": [{"step": "G", "octave": 5}],
             "beams": [{"number": 1, "value": "end"}, {"number": 2, "value": "backward hook"}]},
        ], "staff2": []}]
    }
    xml = llm_omr.score_json_to_musicxml(data)
    root = ET.fromstring(xml)
    notes = root.findall(".//note")
    assert notes[0].findtext("type") == "eighth"
    assert len(notes[0].findall("dot")) == 1
    assert notes[0].findtext("accidental") == "sharp"
    assert [b.text for b in notes[0].findall("beam")] == ["begin"]
    assert {b.get("number"): b.text for b in notes[1].findall("beam")} == {"1": "end", "2": "backward hook"}
    # child order on the dotted eighth: duration, type, dot, accidental, staff, beam
    tags = [c.tag for c in notes[0]]
    assert tags == ["pitch", "duration", "type", "dot", "accidental", "staff", "beam"]


def test_builder_visuals_are_invisible_to_the_scorer():
    # The SAME notes with and without visual markup must lower to identical (pitch, duration, onset)
    # events, so a rich score stays its own ground truth.
    plain = {"divisions": 4, "measures": [{"staff1": [
        {"duration": 2, "pitches": [{"step": "C", "octave": 5}]},
        {"duration": 2, "pitches": [{"step": "D", "octave": 5}]}], "staff2": []}]}
    rich = {"divisions": 4, "measures": [{"staff1": [
        {"duration": 2, "type": "eighth", "pitches": [{"step": "C", "octave": 5}],
         "beams": [{"number": 1, "value": "begin"}]},
        {"duration": 2, "type": "eighth", "pitches": [{"step": "D", "octave": 5}],
         "beams": [{"number": 1, "value": "end"}]}], "staff2": []}]}
    ep = [(e.pitch, e.duration, e.onset) for e in _events(llm_omr.score_json_to_musicxml(plain))]
    er = [(e.pitch, e.duration, e.onset) for e in _events(llm_omr.score_json_to_musicxml(rich))]
    assert ep == er


def test_builder_direction_consumes_no_duration():
    # A <direction> (octave-shift) pseudo-event emits a <direction> child but does not advance the
    # bar cursor, so the staff backup is computed from the notes only.
    data = {"divisions": 4, "measures": [{"staff1": [
        {"duration": 4, "pitches": [{"step": "C", "octave": 5}]},
        {"direction": {"octave_shift": {"type": "down", "size": 8}}},
        {"duration": 4, "pitches": [{"step": "D", "octave": 5}]}],
        "staff2": [{"duration": 8, "pitches": [{"step": "C", "octave": 3}]}]}]}
    xml = llm_omr.score_json_to_musicxml(data)
    root = ET.fromstring(xml)
    assert root.find(".//direction/direction-type/octave-shift") is not None
    assert root.findtext(".//backup/duration") == "8"  # two quarters, direction not counted
    events = _events(xml)
    treble = sorted((e.onset for e in events if e.staff == 1 and e.pitch is not None))
    assert treble == [0, 4]  # the direction did not shift the second note's onset
    bass = [e for e in events if e.staff == 2 and e.pitch is not None]
    assert bass and bass[0].onset == 0


def test_builder_mid_measure_clef_change():
    # measure 2 declares a clef change on staff 1; the first measure keeps the default G/F.
    data = {"divisions": 4, "measures": [
        {"staff1": [{"duration": 4, "pitches": [{"step": "C", "octave": 5}]}], "staff2": []},
        {"clefs": [{"number": 1, "sign": "F", "line": 4}],
         "staff1": [{"duration": 4, "pitches": [{"step": "C", "octave": 3}]}], "staff2": []},
    ]}
    root = ET.fromstring(llm_omr.score_json_to_musicxml(data))
    measures = root.findall(".//measure")
    m1_signs = [c.findtext("sign") for c in measures[0].findall("attributes/clef")]
    m2_signs = [c.findtext("sign") for c in measures[1].findall("attributes/clef")]
    assert m1_signs == ["G", "F"]      # default grand staff
    assert m2_signs == ["F"]           # the mid-piece clef change


def test_builder_returns_none_on_empty_or_garbage():
    assert llm_omr.score_json_to_musicxml({}) is None
    assert llm_omr.score_json_to_musicxml({"measures": []}) is None
    assert llm_omr.score_json_to_musicxml({"measures": "nope"}) is None
    assert llm_omr.score_json_to_musicxml("not a dict") is None
    # A measure with no usable events -> no content -> None.
    assert llm_omr.score_json_to_musicxml({"measures": [{"staff1": [], "staff2": []}]}) is None


def test_builder_skips_bad_pitch_without_raising():
    # A garbage step is skipped; the event degrades to a rest rather than raising.
    data = {"measures": [{"staff1": [{"duration": 4, "pitches": [{"step": "H", "octave": 5}]}]}]}
    xml = llm_omr.score_json_to_musicxml(data)
    # Either None (no usable content) or a valid doc with a rest; never an exception.
    if xml is not None:
        ET.fromstring(xml)  # parses


# --- _extract_json -----------------------------------------------------------------------


def test_extract_json_plain():
    assert llm_omr._extract_json('{"a": 1}') == {"a": 1}


def test_extract_json_fenced():
    assert llm_omr._extract_json('```json\n{"a": 1}\n```') == {"a": 1}
    assert llm_omr._extract_json('```\n{"a": 2}\n```') == {"a": 2}


def test_extract_json_with_prose():
    assert llm_omr._extract_json('Here is the score:\n{"a": 3}\nDone.') == {"a": 3}


def test_extract_json_garbage_returns_none():
    assert llm_omr._extract_json("no json here") is None
    assert llm_omr._extract_json("") is None


# --- gating + never-raise ----------------------------------------------------------------


def test_gating_off_without_flag(monkeypatch):
    monkeypatch.delenv("OMR_LLM", raising=False)
    assert llm_omr.llm_enabled() is False
    assert llm_omr.llm_available() is False


def test_gating_requires_key(monkeypatch):
    monkeypatch.setenv("OMR_LLM", "1")
    monkeypatch.setenv("OMR_LLM_PROVIDER", "anthropic")
    monkeypatch.delenv("OMR_LLM_API_KEY", raising=False)
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    assert llm_omr.llm_enabled() is True
    assert llm_omr.llm_available() is False  # no key
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    assert llm_omr.llm_available() is True


def test_transcribe_returns_none_when_unavailable(monkeypatch):
    monkeypatch.delenv("OMR_LLM", raising=False)
    assert llm_omr.transcribe("/nonexistent.png") is None


def test_transcribe_never_raises_on_bad_image(monkeypatch, tmp_path):
    # Available (flag + key) but the image path is garbage: must return None, not raise.
    monkeypatch.setenv("OMR_LLM", "1")
    monkeypatch.setenv("OMR_LLM_PROVIDER", "anthropic")
    monkeypatch.setenv("OMR_LLM_API_KEY", "sk-test")
    assert llm_omr.transcribe(str(tmp_path / "missing.png")) is None


# --- fake-provider end-to-end (no network) -----------------------------------------------


def test_transcribe_end_to_end_with_fake_provider(monkeypatch, tmp_path):
    # Stub image encoding + the provider call so we exercise the full transcribe() wiring
    # (encode -> call -> extract_json -> build MusicXML) without a real API or image.
    monkeypatch.setenv("OMR_LLM", "1")
    monkeypatch.setenv("OMR_LLM_PROVIDER", "anthropic")
    monkeypatch.setenv("OMR_LLM_API_KEY", "sk-test")
    monkeypatch.setattr(llm_omr, "_encode_image", lambda p: ("Zm9v", "image/png"))

    canned = (
        '```json\n{"divisions":4,"measures":[{"staff1":[{"duration":16,'
        '"pitches":[{"step":"C","octave":5}]}],"staff2":[{"duration":16,'
        '"pitches":[{"step":"C","octave":3},{"step":"E","octave":3}]}]}]}\n```'
    )
    monkeypatch.setattr(llm_omr, "_call_provider", lambda *a, **k: canned)

    xml = llm_omr.transcribe(str(tmp_path / "any.png"))
    assert xml is not None
    events = reconcile.to_events(xml, "llm")
    bass = [e for e in events if e.staff == 2 and e.pitch is not None]
    assert len(bass) == 2 and len({e.onset for e in bass}) == 1  # the C+E chord


def test_transcribe_returns_none_when_provider_returns_nothing(monkeypatch, tmp_path):
    monkeypatch.setenv("OMR_LLM", "1")
    monkeypatch.setenv("OMR_LLM_PROVIDER", "anthropic")
    monkeypatch.setenv("OMR_LLM_API_KEY", "sk-test")
    monkeypatch.setattr(llm_omr, "_encode_image", lambda p: ("Zm9v", "image/png"))
    monkeypatch.setattr(llm_omr, "_call_provider", lambda *a, **k: None)
    assert llm_omr.transcribe(str(tmp_path / "any.png")) is None


# --- monthly budget cap ------------------------------------------------------------------


def _enable_llm(monkeypatch, tmp_path):
    monkeypatch.setenv("OMR_LLM", "1")
    monkeypatch.setenv("OMR_LLM_PROVIDER", "anthropic")
    monkeypatch.setenv("OMR_LLM_API_KEY", "sk-test")
    monkeypatch.setenv("OMR_LLM_USAGE_FILE", str(tmp_path / "usage.json"))


def test_record_call_increments_and_resets_monthly(monkeypatch, tmp_path):
    _enable_llm(monkeypatch, tmp_path)
    monkeypatch.setenv("OMR_LLM_EST_COST_PER_CALL_EUR", "0.5")
    llm_omr._record_call()
    llm_omr._record_call()
    state = llm_omr._read_usage()
    assert state["calls"] == 2
    assert abs(state["eur"] - 1.0) < 1e-6
    assert state["month"] == llm_omr._month_key()
    # A stale prior month is reset on the next record.
    import json as _json

    with open(str(tmp_path / "usage.json"), "w") as fh:
        _json.dump({"month": "1999-01", "eur": 999.0, "calls": 99}, fh)
    llm_omr._record_call()
    state = llm_omr._read_usage()
    assert state["month"] == llm_omr._month_key() and state["calls"] == 1


def test_budget_exceeded_blocks_the_call(monkeypatch, tmp_path):
    _enable_llm(monkeypatch, tmp_path)
    monkeypatch.setenv("OMR_LLM_MONTHLY_BUDGET_EUR", "20")
    import json as _json

    with open(str(tmp_path / "usage.json"), "w") as fh:
        _json.dump({"month": llm_omr._month_key(), "eur": 20.0, "calls": 1}, fh)
    assert llm_omr._budget_exceeded() is True

    def provider_must_not_run(*a, **k):
        raise AssertionError("provider must not be called once the budget is reached")

    monkeypatch.setattr(llm_omr, "_encode_image", lambda p: ("Zm9v", "image/png"))
    monkeypatch.setattr(llm_omr, "_call_provider", provider_must_not_run)
    assert llm_omr.transcribe(str(tmp_path / "any.png")) is None


def test_budget_zero_means_no_cap(monkeypatch, tmp_path):
    _enable_llm(monkeypatch, tmp_path)
    monkeypatch.setenv("OMR_LLM_MONTHLY_BUDGET_EUR", "0")
    import json as _json

    with open(str(tmp_path / "usage.json"), "w") as fh:
        _json.dump({"month": llm_omr._month_key(), "eur": 999.0, "calls": 1}, fh)
    assert llm_omr._budget_exceeded() is False


def test_budget_helpers_never_raise_on_bad_usage_file(monkeypatch, tmp_path):
    # An unreadable/garbage usage file must not raise; _budget_exceeded reads it as 0 spent.
    monkeypatch.setenv("OMR_LLM_USAGE_FILE", str(tmp_path / "nope" / "usage.json"))
    assert llm_omr._budget_exceeded() is False
    llm_omr._record_call()  # creates the dir, no raise


def test_transcribe_records_a_call_within_budget(monkeypatch, tmp_path):
    _enable_llm(monkeypatch, tmp_path)
    monkeypatch.setenv("OMR_LLM_MONTHLY_BUDGET_EUR", "20")
    monkeypatch.setattr(llm_omr, "_encode_image", lambda p: ("Zm9v", "image/png"))
    monkeypatch.setattr(
        llm_omr,
        "_call_provider",
        lambda *a, **k: '{"measures":[{"staff1":[{"duration":4,"pitches":[{"step":"C","octave":5}]}]}]}',
    )
    out = llm_omr.transcribe(str(tmp_path / "any.png"))
    assert out is not None
    assert llm_omr._read_usage().get("calls") == 1
