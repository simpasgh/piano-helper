#!/usr/bin/env python3
"""Tests for the end-to-end eval accumulator (omr-worker/eval_detector.py).

The trained-detector PATH needs torch + a model and is research-only (not unit-tested here);
geom_detector is imported lazily inside evaluate(), so `import eval_detector` is torch-free.
These cover the PURE accounting in _accumulate, in particular that its chord counts still match
the canonical omr_eval.score_transcription after we stopped calling it (it had re-parsed both
XMLs only for chord_recall / n_truth_chords, discarding its note metrics)."""

import eval_detector
import omr_eval


def test_accumulate_self_score_is_perfect():
    # a score graded against itself: every note and every chord matches.
    truth = omr_eval.generate_random_score(seed=9, n_measures=8, chord_prob=0.5)
    s = omr_eval.score_transcription(truth, truth)
    assert s["n_truth_chords"] >= 1  # the seed actually produced chords to exercise the path

    acc = eval_detector._new_acc()
    eval_detector._accumulate(acc, truth, truth)

    # note accounting: pred == truth -> exact == n_truth == n_pred.
    assert acc["exact"] == acc["n_truth"] == acc["n_pred"]
    assert acc["n_truth"] > 0
    # chord accounting must equal the canonical scorer's count, every chord hit.
    assert acc["truth_chords"] == s["n_truth_chords"]
    assert acc["chord_hits"] == s["n_truth_chords"]


def test_accumulate_wrong_chord_counts_as_miss():
    # truth bass chord E3+G3+B3; pred reads one tone wrong -> 1 truth chord, 0 hits (matches
    # omr_eval.score_transcription's chord_recall == 0.0 on the same input).
    import llm_omr

    truth = llm_omr.score_json_to_musicxml({"measures": [{"staff1": [], "staff2": [
        {"duration": 16, "pitches": [
            {"step": "E", "octave": 3}, {"step": "G", "octave": 3}, {"step": "B", "octave": 3}]}]}]})
    pred = llm_omr.score_json_to_musicxml({"measures": [{"staff1": [], "staff2": [
        {"duration": 16, "pitches": [
            {"step": "E", "octave": 3}, {"step": "G", "octave": 3}, {"step": "C", "octave": 4}]}]}]})

    acc = eval_detector._new_acc()
    eval_detector._accumulate(acc, pred, truth)
    assert acc["truth_chords"] == 1
    assert acc["chord_hits"] == 0


def test_accumulate_none_pred_counts_truth_only():
    # the detector produced nothing for this sample: truth chords/notes are still counted, no hits.
    truth = omr_eval.generate_random_score(seed=9, n_measures=8, chord_prob=0.5)
    n_chords = omr_eval.score_transcription(truth, truth)["n_truth_chords"]
    assert n_chords >= 1

    acc = eval_detector._new_acc()
    eval_detector._accumulate(acc, None, truth)
    assert acc["n_truth"] > 0 and acc["n_pred"] == 0 and acc["exact"] == 0
    assert acc["truth_chords"] == n_chords
    assert acc["chord_hits"] == 0


def test_accumulate_matches_score_transcription_chord_recall():
    # end-to-end: a partial-credit case (pred drops some of truth's chords) must yield the same
    # micro chord_recall through _accumulate/_summary as omr_eval.score_transcription reports.
    import llm_omr

    truth = llm_omr.score_json_to_musicxml({"measures": [{"staff1": [], "staff2": [
        {"duration": 8, "pitches": [{"step": "C", "octave": 3}, {"step": "E", "octave": 3}]},
        {"duration": 8, "pitches": [{"step": "D", "octave": 3}, {"step": "F", "octave": 3}]}]}]})
    # pred reproduces only the first chord (and gets the second wrong) -> 1 of 2 truth chords.
    pred = llm_omr.score_json_to_musicxml({"measures": [{"staff1": [], "staff2": [
        {"duration": 8, "pitches": [{"step": "C", "octave": 3}, {"step": "E", "octave": 3}]},
        {"duration": 8, "pitches": [{"step": "D", "octave": 3}, {"step": "G", "octave": 3}]}]}]})

    s = omr_eval.score_transcription(pred, truth)
    assert s["n_truth_chords"] == 2

    acc = eval_detector._new_acc()
    eval_detector._accumulate(acc, pred, truth)
    summary = eval_detector._summary(acc)
    assert summary["chord_recall"] == s["chord_recall"]
