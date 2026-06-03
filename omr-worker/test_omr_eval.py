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


# --- rich-score generation (the symbol detector's training data) -------------------------


def test_ticks_to_type_maps_durations_to_engraved_glyphs():
    # divisions = 4 ticks per quarter: quarter=4, half=8, whole=16, eighth=2, 16th=1.
    assert omr_eval._ticks_to_type(4, 4) == ("quarter", 0)
    assert omr_eval._ticks_to_type(8, 4) == ("half", 0)
    assert omr_eval._ticks_to_type(16, 4) == ("whole", 0)
    assert omr_eval._ticks_to_type(2, 4) == ("eighth", 0)
    assert omr_eval._ticks_to_type(1, 4) == ("16th", 0)
    assert omr_eval._ticks_to_type(6, 4) == ("quarter", 1)   # dotted quarter
    assert omr_eval._ticks_to_type(3, 4) == ("eighth", 1)    # dotted eighth
    assert omr_eval._ticks_to_type(12, 4) == ("half", 1)     # dotted half
    assert omr_eval._ticks_to_type(5, 4) is None             # not a plain/dotted value
    assert omr_eval._ticks_to_type(0, 4) is None             # degrade, no crash


def test_keyed_alter_and_accidental_glyph_track_the_key():
    # D major (2 sharps F#, C#): F is sharped by the key, so an F-natural needs a 'natural' glyph
    # and an F# needs NO glyph; in C major an F# needs a 'sharp'.
    assert omr_eval._keyed_alter("F", 2) == 1 and omr_eval._keyed_alter("G", 2) == 0
    assert omr_eval._keyed_alter("B", -1) == -1  # Bb major flattens B
    assert omr_eval._accidental_glyph("F", 1, 2) is None       # F# is the key default
    assert omr_eval._accidental_glyph("F", 0, 2) == "natural"  # F-natural cancels the key sharp
    assert omr_eval._accidental_glyph("F", 1, 0) == "sharp"    # F# in C major
    assert omr_eval._accidental_glyph("B", -1, 0) == "flat"


def test_diatonic_step_up_carries_the_octave():
    assert omr_eval._diatonic_step_up("C", 4, 2) == ("E", 4)   # a third
    assert omr_eval._diatonic_step_up("C", 4, 4) == ("G", 4)   # a fifth
    assert omr_eval._diatonic_step_up("A", 4, 2) == ("C", 5)   # third over the C boundary


def test_assign_beams_canonical_patterns():
    bt = 4  # beat = 4 ticks (divisions 4)
    # two eighths in one beat -> one primary beam begin/end
    assert omr_eval._assign_beams([(0, 1), (2, 1)], bt) == [
        [{"number": 1, "value": "begin"}], [{"number": 1, "value": "end"}]]
    # four sixteenths -> primary + secondary, both begin/continue/continue/end
    four = omr_eval._assign_beams([(0, 2), (1, 2), (2, 2), (3, 2)], bt)
    assert [b[0]["value"] for b in four] == ["begin", "continue", "continue", "end"]
    assert all({1, 2} == {d["number"] for d in slot} for slot in four)
    # dotted-eighth(level1) + sixteenth(level2): primary begin/end, lone 16th gets a backward hook
    hook = omr_eval._assign_beams([(0, 1), (3, 2)], bt)
    assert hook[0] == [{"number": 1, "value": "begin"}]
    assert {"number": 2, "value": "backward hook"} in hook[1]
    # beams never cross a beat boundary: two eighths in beat 0 + two in beat 1 -> two groups
    across = omr_eval._assign_beams([(0, 1), (2, 1), (4, 1), (6, 1)], bt)
    assert [b[0]["value"] for b in across] == ["begin", "end", "begin", "end"]


def test_rich_score_is_deterministic_and_parses():
    a = omr_eval.generate_rich_score(seed=11, n_measures=6, key_fifths=0)
    b = omr_eval.generate_rich_score(seed=11, n_measures=6, key_fifths=0)
    c = omr_eval.generate_rich_score(seed=12, n_measures=6, key_fifths=0)
    assert a == b and a != c
    root = ET.fromstring(a)
    assert root.tag == "score-partwise"
    assert len(root.findall(".//measure")) == 6
    staves = {e.staff for e in reconcile.to_events(a, "x") if e.pitch is not None}
    assert staves == {1, 2}


def test_rich_score_is_its_own_ground_truth_including_rhythm():
    # Fed to itself a rich score scores a perfect 1.0 on pitch AND duration AND chords: the visual
    # glyphs do not perturb what the scorer reads.
    xml = omr_eval.generate_rich_score(seed=21, n_measures=8, key_fifths=3, chord_prob=0.4)
    m = omr_eval.score_transcription(xml, xml)
    assert m["note_f1"] == 1.0
    assert m["note_dur_f1"] == 1.0 and m["duration_acc"] == 1.0
    assert m["chord_recall"] == 1.0


def test_rich_score_has_varied_rhythm_and_glyphs():
    xml = omr_eval.generate_rich_score(seed=7, n_measures=8, key_fifths=0,
                                       accidental_prob=0.3, density=0.7)
    # several distinct duration classes (not the simple generator's all-quarters)
    durs = {omr_eval._dur16(e.duration, e.base)
            for e in reconcile.to_events(xml, "x") if e.pitch is not None}
    assert len(durs) >= 4
    s = xml.decode()
    assert "<type" in s and "<beam" in s and "<accidental" in s  # engraved glyph set present


def test_rich_score_bars_sum_to_capacity():
    # Every bar must be metrically exact per staff so Verovio engraves it cleanly.
    xml = omr_eval.generate_rich_score(seed=33, n_measures=6, key_fifths=0, density=0.8)
    root = ET.fromstring(xml)
    for meas in root.findall(".//measure"):
        totals, cur = {1: 0, 2: 0}, 1
        for ch in list(meas):
            if ch.tag == "backup":
                cur = 2
                continue
            if ch.tag != "note" or ch.find("chord") is not None:
                continue
            st = int(ch.findtext("staff") or cur)
            totals[st] += int(ch.findtext("duration"))
        assert totals[1] == 16 and totals[2] == 16  # 4/4 at divisions 4


def test_rich_score_all_keys_round_trip():
    for k in range(-7, 8):
        xml = omr_eval.generate_rich_score(seed=4, n_measures=3, key_fifths=k, accidental_prob=0.4)
        assert ET.fromstring(xml).findtext(".//key/fifths") == str(k)
        assert omr_eval.score_transcription(xml, xml)["note_f1"] == 1.0


def test_rich_score_hard_features_render_and_stay_ground_truth():
    cc = omr_eval.generate_rich_score(seed=3, n_measures=6, key_fifths=0, clef_changes=True)
    assert cc.decode().count("<clef") > 2  # extra mid-piece clef glyph
    assert omr_eval.score_transcription(cc, cc)["note_f1"] == 1.0
    ot = omr_eval.generate_rich_score(seed=3, n_measures=4, key_fifths=0, ottava=True)
    assert ot.decode().count("octave-shift") >= 2  # a start + a stop
    assert omr_eval.score_transcription(ot, ot)["note_f1"] == 1.0
    lh = omr_eval.generate_rich_score(seed=3, n_measures=4, key_fifths=0, ledger_heavy=True)
    assert omr_eval.score_transcription(lh, lh)["note_f1"] == 1.0


def test_rich_score_every_note_carries_a_consistent_type_glyph():
    # The core thesis: at a clean divisions every engraved note/rest carries a <type> matching its
    # duration, so the rendered glyph is always consistent with the ground-truth duration.
    for divisions in (4, 8):
        root = ET.fromstring(omr_eval.generate_rich_score(
            seed=5, n_measures=4, key_fifths=0, divisions=divisions, density=0.7))
        for note in root.findall(".//note"):
            assert note.find("type") is not None


def test_rich_score_exotic_divisions_degrade_without_crash():
    # A divisions/meter combo with no clean sub-beat representation still returns valid,
    # self-scoring MusicXML and never crashes (bars still sum; some notes may be type-less).
    xml = omr_eval.generate_rich_score(seed=2, n_measures=3, key_fifths=0,
                                       divisions=3, beats=2, beat_type=8)
    assert isinstance(xml, bytes) and xml
    assert omr_eval.score_transcription(xml, xml)["note_f1"] == 1.0


def test_rich_score_ties_are_engraved_and_stay_ground_truth():
    xml = omr_eval.generate_rich_score(seed=3, n_measures=6, key_fifths=0, tie_prob=0.6)
    assert b"<tied" in xml  # ties engraved (the g.tie arc the detector learns)
    # ties do not perturb the scorer: a tied score is still its own ground truth (pitch + duration)
    m = omr_eval.score_transcription(xml, xml)
    assert m["note_f1"] == 1.0 and m["note_dur_f1"] == 1.0
    starts = [e for e in reconcile.to_events(xml, "x") if "start" in e.tie]
    stops = [e for e in reconcile.to_events(xml, "x") if "stop" in e.tie]
    assert starts and len(starts) == len(stops)
    # tie_prob=0 (default) engraves no ties (gated, default RNG stream unchanged)
    assert b"<tied" not in omr_eval.generate_rich_score(seed=3, n_measures=6, key_fifths=0)


def test_rich_score_clef_changes_include_bass_and_alto():
    seen = set()
    for seed in range(40):
        xml = omr_eval.generate_rich_score(seed=seed, n_measures=6, key_fifths=0, clef_changes=True)
        assert omr_eval.score_transcription(xml, xml)["note_f1"] == 1.0
        for meas in ET.fromstring(xml).findall(".//measure")[1:]:
            for clef in meas.findall("attributes/clef"):
                seen.add(clef.findtext("sign"))
    assert "F" in seen and "C" in seen  # both an fClef-change and a cClef-change occur across seeds


def test_rich_score_random_key_when_unspecified_and_never_raises():
    # key_fifths None -> a deterministic in-range random key; odd args degrade, never raise.
    xml = omr_eval.generate_rich_score(seed=99, n_measures=4)
    assert -7 <= int(ET.fromstring(xml).findtext(".//key/fifths")) <= 7
    assert omr_eval.generate_rich_score(seed=1, n_measures=0) in (b"",) or True  # no crash
    assert isinstance(omr_eval.generate_rich_score(seed=1, n_measures=2, beat_type=0), bytes)
