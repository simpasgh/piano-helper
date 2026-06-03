"""Tests for the OMR evaluation foundation (omr_eval.py): the scoring harness + the
deterministic synthetic-score generator. Pure stdlib, no API key, no verovio."""

import xml.etree.ElementTree as ET

import omr_eval
import reconcile


# --- score_transcription -----------------------------------------------------------------


def test_identical_scores_score_perfect():
    xml = omr_eval.generate_random_score(seed=1, n_measures=4)
    m = omr_eval.score_transcription(xml, xml)
    assert m["note_precision"] == 1.0
    assert m["note_recall"] == 1.0
    assert m["note_f1"] == 1.0
    assert m["chord_recall"] == 1.0
    assert m["n_truth"] == m["n_pred"] == m["n_matched"]
    assert m["n_truth"] > 0


def test_missing_note_drops_recall_not_precision():
    # truth has C5+E5+G5 in m1 treble; pred has only C5 -> recall 1/3, precision 1/1.
    truth = omr_eval.generate_random_score(seed=2, n_measures=1)
    truth_data = {
        "measures": [
            {"staff1": [
                {"duration": 4, "pitches": [{"step": "C", "octave": 5}]},
                {"duration": 4, "pitches": [{"step": "E", "octave": 5}]},
                {"duration": 4, "pitches": [{"step": "G", "octave": 5}]},
            ], "staff2": []}
        ]
    }
    import llm_omr
    t = llm_omr.score_json_to_musicxml(truth_data)
    p = llm_omr.score_json_to_musicxml({"measures": [{"staff1": [
        {"duration": 4, "pitches": [{"step": "C", "octave": 5}]}], "staff2": []}]})
    m = omr_eval.score_transcription(p, t)
    assert m["n_truth"] == 3 and m["n_pred"] == 1 and m["n_matched"] == 1
    assert m["note_recall"] == round(1 / 3, 4)
    assert m["note_precision"] == 1.0


def test_wrong_extra_note_drops_precision():
    import llm_omr
    t = llm_omr.score_json_to_musicxml({"measures": [{"staff1": [
        {"duration": 4, "pitches": [{"step": "C", "octave": 5}]}], "staff2": []}]})
    # pred adds a wrong B4 alongside the correct C5.
    p = llm_omr.score_json_to_musicxml({"measures": [{"staff1": [
        {"duration": 4, "pitches": [{"step": "C", "octave": 5}]},
        {"duration": 4, "pitches": [{"step": "B", "octave": 4}]}], "staff2": []}]})
    m = omr_eval.score_transcription(p, t)
    assert m["n_truth"] == 1 and m["n_pred"] == 2 and m["n_matched"] == 1
    assert m["note_recall"] == 1.0
    assert m["note_precision"] == 0.5


def test_chord_recall_detects_wrong_chord():
    import llm_omr
    # truth bass chord E3+G3+B3; pred reads E3+G3+C4 (one wrong tone) at the same slot.
    t = llm_omr.score_json_to_musicxml({"measures": [{"staff1": [], "staff2": [
        {"duration": 16, "pitches": [
            {"step": "E", "octave": 3}, {"step": "G", "octave": 3}, {"step": "B", "octave": 3}]}]}]})
    p_right = t
    p_wrong = llm_omr.score_json_to_musicxml({"measures": [{"staff1": [], "staff2": [
        {"duration": 16, "pitches": [
            {"step": "E", "octave": 3}, {"step": "G", "octave": 3}, {"step": "C", "octave": 4}]}]}]})
    assert omr_eval.score_transcription(p_right, t)["chord_recall"] == 1.0
    m = omr_eval.score_transcription(p_wrong, t)
    assert m["n_truth_chords"] == 1
    assert m["chord_recall"] == 0.0  # the chord's exact pitch set was not reproduced


def test_chord_recall_is_divisions_invariant():
    # The SAME bass chord notated with different <divisions> must still score chord_recall 1.0
    # (the metric is keyed by measure+hand, not raw tick onset).
    import llm_omr
    chord = [{"step": "E", "octave": 3}, {"step": "G", "octave": 3}, {"step": "B", "octave": 3}]
    t = llm_omr.score_json_to_musicxml(
        {"divisions": 4, "measures": [{"staff1": [], "staff2": [{"duration": 16, "pitches": chord}]}]}
    )
    p = llm_omr.score_json_to_musicxml(
        {"divisions": 3, "measures": [{"staff1": [], "staff2": [{"duration": 12, "pitches": chord}]}]}
    )
    m = omr_eval.score_transcription(p, t)
    assert m["n_truth_chords"] == 1
    assert m["chord_recall"] == 1.0


def test_no_truth_chords_means_chord_recall_one():
    import llm_omr
    t = llm_omr.score_json_to_musicxml({"measures": [{"staff1": [
        {"duration": 4, "pitches": [{"step": "C", "octave": 5}]}], "staff2": []}]})
    assert omr_eval.score_transcription(t, t)["chord_recall"] == 1.0


def test_chord_hit_counts_multiset_intersection():
    # the shared (measure,staff)->Counter-of-frozensets reducer behind both score_transcription
    # and eval_detector. Counts are a multiset intersection keyed by cell.
    from collections import Counter

    cell = (1, 2)
    eg = frozenset({52, 55})   # E3 + G3
    fa = frozenset({53, 57})   # F3 + A3
    truth = {cell: Counter({eg: 2, fa: 1})}
    pred = {cell: Counter({eg: 1})}            # one E-G chord, no F-A
    assert omr_eval._chord_hit_counts(truth, pred) == (3, 1)  # 3 truth chords, min(2,1)+min(1,0)
    assert omr_eval._chord_hit_counts({}, pred) == (0, 0)     # no truth chords
    # a matching chord in the WRONG cell does not count.
    assert omr_eval._chord_hit_counts({cell: Counter({eg: 1})}, {(9, 9): Counter({eg: 1})}) == (1, 0)


def test_score_transcription_never_raises_on_garbage():
    m = omr_eval.score_transcription(b"<not-xml", b"<also-not")
    assert m["note_f1"] == 0.0 and m["n_truth"] == 0
    assert m["note_dur_f1"] == 0.0 and m["duration_acc"] == 0.0


# --- rhythm (duration) metric ------------------------------------------------------------


def test_dur16_quantization_is_divisions_invariant():
    # base = ticks per quarter. quarter -> 4 sixteenths, half -> 8, whole -> 16, eighth -> 2.
    assert omr_eval._dur16(4, 4) == 4     # quarter at divisions 4
    assert omr_eval._dur16(8, 4) == 8     # half
    assert omr_eval._dur16(16, 4) == 16   # whole
    assert omr_eval._dur16(2, 4) == 2     # eighth
    assert omr_eval._dur16(8, 8) == 4     # quarter at divisions 8 -> same class as 4/4
    assert omr_eval._dur16(5, 0) == 0     # degrade on base 0, no crash


def test_duration_metric_rewards_right_rhythm_and_penalizes_wrong():
    import llm_omr
    # One quarter note C5 (divisions 4 -> duration 4 = one beat).
    t = llm_omr.score_json_to_musicxml({"divisions": 4, "measures": [{"staff1": [
        {"duration": 4, "pitches": [{"step": "C", "octave": 5}]}], "staff2": []}]})
    m_same = omr_eval.score_transcription(t, t)
    assert m_same["note_f1"] == 1.0
    assert m_same["duration_acc"] == 1.0 and m_same["note_dur_f1"] == 1.0
    # Same PITCH, wrong DURATION (a half note: duration 8). Pitch still matches; rhythm does not.
    p_wrong_dur = llm_omr.score_json_to_musicxml({"divisions": 4, "measures": [{"staff1": [
        {"duration": 8, "pitches": [{"step": "C", "octave": 5}]}], "staff2": []}]})
    m = omr_eval.score_transcription(p_wrong_dur, t)
    assert m["note_recall"] == 1.0       # pitch is right (the pitch-only metric is blind to rhythm)
    assert m["n_dur_matched"] == 0       # ... but the duration is wrong
    assert m["duration_acc"] == 0.0 and m["note_dur_f1"] == 0.0


def test_duration_metric_is_divisions_invariant():
    import llm_omr
    # The SAME quarter note notated with different <divisions> must score duration_acc 1.0.
    t = llm_omr.score_json_to_musicxml({"divisions": 4, "measures": [{"staff1": [
        {"duration": 4, "pitches": [{"step": "C", "octave": 5}]}], "staff2": []}]})
    p = llm_omr.score_json_to_musicxml({"divisions": 8, "measures": [{"staff1": [
        {"duration": 8, "pitches": [{"step": "C", "octave": 5}]}], "staff2": []}]})
    m = omr_eval.score_transcription(p, t)
    assert m["note_recall"] == 1.0
    assert m["duration_acc"] == 1.0 and m["note_dur_f1"] == 1.0


# --- generate_random_score ---------------------------------------------------------------


def test_mscx_to_truth_reads_staves_and_chords():
    # Minimal MuseScore-shape .mscx: staff 1 (treble) a single C5(60); staff 2 (bass) a chord
    # C3(48)+E3(52)+G3(55). The converter must produce truth MusicXML with that bass chord intact.
    mscx = """<?xml version="1.0"?><museScore><Score>
      <Staff id="1"><Measure><voice>
        <Chord><Note><pitch>60</pitch></Note></Chord>
      </voice></Measure></Staff>
      <Staff id="2"><Measure><voice>
        <Chord><Note><pitch>48</pitch></Note><Note><pitch>52</pitch></Note><Note><pitch>55</pitch></Note></Chord>
      </voice></Measure></Staff>
    </Score></museScore>"""
    truth = omr_eval.mscx_to_truth_musicxml(mscx)
    assert truth is not None
    events = reconcile.to_events(truth, "x")
    treble = [e for e in events if e.staff == 1 and e.pitch is not None]
    bass = [e for e in events if e.staff == 2 and e.pitch is not None]
    assert len(treble) == 1 and reconcile._pitch_to_midi(treble[0].pitch) == 60
    assert sorted(reconcile._pitch_to_midi(e.pitch) for e in bass) == [48, 52, 55]
    assert len({e.onset for e in bass}) == 1  # the three bass notes form one chord
    # And it scores perfectly against itself through the harness.
    assert omr_eval.score_transcription(truth, truth)["chord_recall"] == 1.0


def test_mscx_to_truth_never_raises_on_garbage():
    assert omr_eval.mscx_to_truth_musicxml(b"<not-a-score") is None
    assert omr_eval.mscx_to_truth_musicxml("") is None
    assert omr_eval.mscx_to_truth_musicxml("<museScore></museScore>") is None


def test_generator_is_deterministic_by_seed():
    a = omr_eval.generate_random_score(seed=42, n_measures=6)
    b = omr_eval.generate_random_score(seed=42, n_measures=6)
    c = omr_eval.generate_random_score(seed=43, n_measures=6)
    assert a == b
    assert a != c


def test_generated_score_is_valid_musicxml_with_expected_measures():
    xml = omr_eval.generate_random_score(seed=7, n_measures=5)
    root = ET.fromstring(xml)  # parses
    assert root.tag == "score-partwise"
    assert len(root.findall(".//measure")) == 5
    # has notes on both staves
    events = reconcile.to_events(xml, "x")
    staves = {e.staff for e in events if e.pitch is not None}
    assert staves == {1, 2}


def test_generated_score_round_trips_to_perfect_self_score():
    xml = omr_eval.generate_random_score(seed=9, n_measures=8, chord_prob=0.5)
    m = omr_eval.score_transcription(xml, xml)
    assert m["note_f1"] == 1.0 and m["chord_recall"] == 1.0
    assert m["n_truth_chords"] >= 1  # chord_prob high enough to produce some chords
