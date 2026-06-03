#!/usr/bin/env python3
"""Tests for rhythm_repair.repair_measure_durations (pitch-safe bar completion). Pure stdlib; builds
fixtures with the tested llm_omr builder so they are always well-formed, and reads them back with
reconcile.to_events / omr_eval so the assertions match how the metric sees durations.

The repair completes a flagged bar to the time signature ONLY by resizing / adding RESTS; it never
touches a pitched note's duration (the measured reason is in the module docstring: stretching a note
regresses real transcriptions because short bars are dominated by DROPPED notes, not misreads). So
these tests assert two things: bars get COMPLETED, and pitched durations are NEVER changed.

Two layers:
  - MECHANISM tests call the repair with the corroboration/first-last GATES OFF (exact_min=0,
    over_max=1, min_bars=1, skip_first_last=False) to isolate one bar at a time.
  - GATE tests exercise the corroboration guard, the first/last-measure skip, and the multi-voice
    skip with realistic multi-bar scores at the DEFAULT gates.
"""
import xml.etree.ElementTree as ET

import llm_omr
import omr_eval
import reconcile
import rhythm_repair


# --- fixture helpers ---------------------------------------------------------------------

def _xml(measures, divisions=4, beats=4, beat_type=4):
    return llm_omr.score_json_to_musicxml(
        {"divisions": divisions, "time": {"beats": beats, "beat_type": beat_type},
         "measures": measures})


def _note(dur, step, octave=5, alter=0):
    p = {"step": step, "octave": octave}
    if alter:
        p["alter"] = alter
    return {"duration": dur, "pitches": [p]}


def _chord(dur, pitches):
    return {"duration": dur, "pitches": [{"step": s, "octave": o} for (s, o) in pitches]}


def _rest(dur):
    return {"duration": dur, "rest": True}


def _good():
    """A measure both of whose staves sum exactly to a 4/4 bar (two half notes each)."""
    return {"staff1": [_note(8, "C"), _note(8, "D")],
            "staff2": [_note(8, "C", 3), _note(8, "E", 3)]}


def _evs(xml):
    return reconcile.to_events(xml, "x")


def _durs(xml, measure, staff, pitched_only=False):
    """Non-chord <duration> values for a (measure number, staff), in document order."""
    out = []
    for e in _evs(xml):
        if e.measure == measure and e.staff == staff and not e.is_chord:
            if pitched_only and e.pitch is None:
                continue
            out.append(e.duration)
    return out


def _rest_durs(xml, measure, staff):
    return [e.duration for e in _evs(xml)
            if e.measure == measure and e.staff == staff and e.pitch is None]


def _onsets(xml, measure, staff, pitched_only=False):
    return [e.onset for e in _evs(xml)
            if e.measure == measure and e.staff == staff and not e.is_chord
            and (e.pitch is not None or not pitched_only)]


def _open(xml):
    """Repair with the corroboration / first-last gates OFF, to isolate the bar mechanism."""
    return rhythm_repair.repair_measure_durations(
        xml, exact_min=0.0, over_max=1.0, min_bars=1, skip_first_last=False)


# --- MECHANISM: pitch-safe completion (gates off) ----------------------------------------

class TestPitchSafeCompletion:
    def test_short_rest_free_bar_is_padded_pitch_untouched(self):
        # A 4/4 bar of [dotted-half(12), eighth(2)] = 14 is short by 2. With no rest present we pad
        # a trailing rest; the two pitched notes keep their durations (we never stretch a note).
        xml = _xml([{"staff1": [_note(12, "C"), _note(2, "D")], "staff2": []}])
        out = _open(xml)
        assert _durs(out, 1, 1, pitched_only=True) == [12, 2]   # pitches untouched
        assert _rest_durs(out, 1, 1) == [2]                     # gap padded with a rest(2)
        assert sum(_durs(out, 1, 1)) == 16

    def test_dropped_note_bar_pads_does_not_stretch_survivors(self):
        # THE key regression guard. [quarter(4), quarter(4)] = 8 in a 4/4 bar: a half-note of content
        # is missing. The old "stretch the unique candidate" logic would have doubled a quarter to a
        # half (which the real-piece diagnostic proved WRONG); the correct, never-worse action is to
        # pad the gap with a rest and leave both correct quarters alone.
        xml = _xml([{"staff1": [_note(4, "C"), _note(4, "D")], "staff2": []}])
        out = _open(xml)
        assert _durs(out, 1, 1, pitched_only=True) == [4, 4]    # survivors NOT stretched
        assert _rest_durs(out, 1, 1) == [8]                     # the dropped time is a rest
        assert sum(_durs(out, 1, 1)) == 16

    def test_chord_bar_padded_chord_preserved(self):
        # A short rest-free bar containing a chord is padded; the chord is left intact.
        xml = _xml([{"staff1": [], "staff2": [_chord(2, [("C", 3), ("E", 3)]), _note(12, "G", 3)]}])
        out = _open(xml)
        assert _durs(out, 1, 2, pitched_only=True) == [2, 12]   # chord + note untouched
        assert _rest_durs(out, 1, 2) == [2]
        midis = sorted(reconcile._pitch_to_midi(e.pitch) for e in _evs(out)
                       if e.pitch is not None and e.staff == 2)
        assert midis == [48, 52, 55]                            # C3, E3, G3 all preserved
        assert any(e.is_chord for e in _evs(out))               # still a chord

    def test_overfull_rest_free_bar_left_unchanged(self):
        # [half, half, quarter] = 20 OVERFLOWS a 4/4 bar and has no rest to shrink. Shrinking a
        # pitched note is the same unsafe guess as stretching one, so the bar is left UNCHANGED.
        xml = _xml([{"staff1": [_note(8, "C"), _note(8, "D"), _note(4, "E")], "staff2": []}])
        assert _open(xml) == xml


class TestRestResize:
    def test_rest_grows_to_complete_short_bar(self):
        xml = _xml([{"staff1": [_note(4, "C"), _note(4, "D"), _rest(4)], "staff2": []}])
        out = _open(xml)
        assert _durs(out, 1, 1, pitched_only=True) == [4, 4]
        assert _rest_durs(out, 1, 1) == [8]                     # 4 -> 8 absorbs the deficit

    def test_rest_shrinks_to_zero_is_removed_on_overfull_bar(self):
        xml = _xml([{"staff1": [_note(8, "C"), _note(8, "D"), _rest(4)], "staff2": []}])
        out = _open(xml)
        assert _durs(out, 1, 1, pitched_only=True) == [8, 8]
        assert _rest_durs(out, 1, 1) == []                      # rest shrunk to 0 -> removed
        assert sum(_durs(out, 1, 1)) == 16

    def test_rest_too_small_for_overflow_leaves_bar_unchanged(self):
        # Overfull by 4 but the only rest is a 2: it cannot absorb the overflow without going
        # negative, and we never touch a pitched note, so the bar is left unchanged.
        xml = _xml([{"staff1": [_note(8, "C"), _note(8, "D"), _note(4, "E"), _rest(2)], "staff2": []}])
        assert _open(xml) == xml


class TestBackupAdjustment:
    def test_staff1_pad_preserves_staff2_onsets(self):
        # Padding staff 1 lengthens its fill; the cross-staff <backup> must grow by the same amount
        # so staff 2 still rewinds to the measure start. Assert staff-2 onsets are unchanged.
        xml = _xml([{"staff1": [_note(12, "C"), _note(2, "D")],     # 14, short by 2
                     "staff2": [_note(4, "C", 3), _note(4, "D", 3),
                                _note(4, "E", 3), _note(4, "F", 3)]}])
        assert _onsets(xml, 1, 2) == [0, 4, 8, 12]                  # before
        out = _open(xml)
        assert _durs(out, 1, 1, pitched_only=True) == [12, 2]       # staff 1 notes untouched
        assert sum(_durs(out, 1, 1)) == 16                          # staff 1 completed via a rest
        assert _onsets(out, 1, 2) == [0, 4, 8, 12]                  # staff 2 still anchored at 0

    def test_staff2_pad_goes_to_measure_end_not_before_backup(self):
        # A staff-2 pad must land at the MEASURE END (after staff-2 notes), not before the
        # cross-staff <backup>, or it would fall into staff 1's timeline and shift staff-2 onsets.
        xml = _xml([{"staff1": [_note(4, "C"), _note(4, "D"), _note(4, "E"), _note(4, "F")],
                     "staff2": [_note(4, "C", 3), _note(4, "D", 3), _note(4, "E", 3)]}])
        out = _open(xml)
        assert _onsets(out, 1, 1) == [0, 4, 8, 12]                  # staff 1 untouched
        assert _onsets(out, 1, 2, pitched_only=True) == [0, 4, 8]   # staff-2 notes still at 0
        assert _rest_durs(out, 1, 2) == [4]
        assert _onsets(out, 1, 2) == [0, 4, 8, 12]                  # the pad sits at the bar end


# --- GATE tests (default thresholds) -----------------------------------------------------

class TestCorroboration:
    def test_bails_when_meter_mislabeled(self):
        # Every bar sums to 8 but the score DECLARES 4/4 (capacity 16): exactly the fusion 2/4-as-4/4
        # case. No bar corroborates capacity 16, so the repair is a clean no-op (byte-identical) and
        # the score is NOT polluted with a phantom half-bar rest in every measure.
        measures = [{"staff1": [_note(4, "C"), _note(4, "D")],
                     "staff2": [_note(4, "C", 3), _note(4, "E", 3)]} for _ in range(6)]
        xml = _xml(measures)
        assert rhythm_repair.repair_measure_durations(xml) == xml

    def test_completes_outlier_when_meter_corroborated(self):
        # Five good 4/4 bars + one short middle bar: capacity 16 is corroborated, so the outlier is
        # completed with a rest (pitched notes untouched) while the rest are no-ops.
        target = {"staff1": [_note(12, "C"), _note(2, "D")],
                  "staff2": [_note(8, "C", 3), _note(8, "E", 3)]}
        measures = [_good(), _good(), target, _good(), _good()]
        out = rhythm_repair.repair_measure_durations(_xml(measures))
        assert _durs(out, 3, 1, pitched_only=True) == [12, 2]      # measure 3 notes untouched
        assert sum(_durs(out, 3, 1)) == 16                         # but completed via a rest


class TestSkips:
    def test_first_and_last_measures_skipped(self):
        broken = {"staff1": [_note(12, "C"), _note(2, "D")],
                  "staff2": [_note(8, "C", 3), _note(8, "E", 3)]}
        measures = [broken, _good(), broken, _good(), broken]      # broken at first, middle, last
        out = rhythm_repair.repair_measure_durations(_xml(measures))
        assert _rest_durs(out, 1, 1) == []                         # first: untouched (no pad)
        assert _rest_durs(out, 5, 1) == []                         # last: untouched (no pad)
        assert sum(_durs(out, 3, 1)) == 16                         # middle: completed

    def test_multivoice_staff_skipped(self):
        # A staff with two voices cannot be summed as one line: it must be left untouched even
        # though naively summing its notes would look overfull.
        xml = _multivoice_doc()
        assert rhythm_repair.repair_measure_durations(
            xml, exact_min=0.0, over_max=1.0, min_bars=1, skip_first_last=False) == xml


# --- never-raise / no-op contract --------------------------------------------------------

class TestNeverRaises:
    def test_none_empty_garbage(self):
        assert rhythm_repair.repair_measure_durations(None) is None
        assert rhythm_repair.repair_measure_durations(b"") == b""
        assert rhythm_repair.repair_measure_durations(b"<not xml") == b"<not xml"

    def test_no_timesig_is_noop(self):
        doc = (b'<?xml version="1.0"?><score-partwise><part id="P1"><measure number="1">'
               b'<note><pitch><step>C</step><octave>4</octave></pitch><duration>2</duration>'
               b'<staff>1</staff></note></measure></part></score-partwise>')
        assert rhythm_repair.repair_measure_durations(doc) == doc

    def test_valid_score_is_byte_identical_noop(self):
        xml = _xml([_good(), _good(), _good(), _good()])
        assert rhythm_repair.repair_measure_durations(xml) == xml


# --- the contract: never lowers the rhythm metrics, and completes the bar ----------------

def test_repair_is_metric_neutral_and_completes_a_dropped_note_bar():
    # TRUTH: every bar sums to 16; a middle bar is [half(8) A, quarter(4) B, quarter(4) C].
    truth_target = {"staff1": [_note(8, "A", 5), _note(4, "B", 5), _note(4, "C", 5)],
                    "staff2": [_note(8, "C", 3), _note(8, "E", 3)]}
    truth = _xml([_good(), _good(), truth_target, _good(), _good(), _good()])

    # PRED: the engine DROPPED C, so the middle bar is short by 4 (the dominant real failure mode).
    pred_target = {"staff1": [_note(8, "A", 5), _note(4, "B", 5)],
                   "staff2": [_note(8, "C", 3), _note(8, "E", 3)]}
    pred = _xml([_good(), _good(), pred_target, _good(), _good(), _good()])
    repaired = rhythm_repair.repair_measure_durations(pred)

    before = omr_eval.score_transcription(pred, truth)
    after = omr_eval.score_transcription(repaired, truth)

    # The repair NEVER lowers the rhythm/pitch metrics (it only adds a rest, which the scorer
    # ignores): A and B keep their correct durations and C stays (legitimately) missing either way.
    assert after["note_dur_f1"] == before["note_dur_f1"]
    assert after["duration_acc"] == before["duration_acc"]
    assert after["note_f1"] == before["note_f1"]
    # ...but the bar is now metrically COMPLETE (the dropped beat shown as a rest), so it renders at
    # its true width instead of squished.
    assert sum(_durs(repaired, 3, 1)) == 16
    assert _durs(repaired, 3, 1, pitched_only=True) == [8, 4]   # surviving notes never stretched


# --- low-level fixtures that need raw XML ------------------------------------------------

def _multivoice_doc():
    """One 4/4 measure whose staff 1 holds TWO voices (voice 1: 4 quarters; voice 2: 4 quarters)
    via an internal <backup>. Summing its eight quarters naively = 32 (looks doubly overfull), so
    the repairer must recognise the multi-voice staff and skip it."""
    return (
        b'<?xml version="1.0"?><score-partwise><part id="P1"><measure number="1">'
        b'<attributes><divisions>4</divisions><time><beats>4</beats><beat-type>4</beat-type></time>'
        b'<clef number="1"><sign>G</sign><line>2</line></clef></attributes>'
        b'<note><pitch><step>C</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><staff>1</staff></note>'
        b'<note><pitch><step>D</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><staff>1</staff></note>'
        b'<note><pitch><step>E</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><staff>1</staff></note>'
        b'<note><pitch><step>F</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><staff>1</staff></note>'
        b'<backup><duration>16</duration></backup>'
        b'<note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><voice>2</voice><staff>1</staff></note>'
        b'<note><pitch><step>D</step><octave>4</octave></pitch><duration>4</duration><voice>2</voice><staff>1</staff></note>'
        b'<note><pitch><step>E</step><octave>4</octave></pitch><duration>4</duration><voice>2</voice><staff>1</staff></note>'
        b'<note><pitch><step>F</step><octave>4</octave></pitch><duration>4</duration><voice>2</voice><staff>1</staff></note>'
        b'</measure></part></score-partwise>')
