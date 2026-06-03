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
