#!/usr/bin/env python3
"""OMR evaluation foundation: the MEASUREMENT substrate for the own-engine ambition.

You cannot build (or honestly claim) "more accurate" without a way to measure it. This module
is engine-agnostic: it grades any MusicXML transcription against a ground-truth MusicXML, and
it generates deterministic synthetic scores (for eval volume + future training data). It is the
first rung of building our own OMR engine, and it is what produces the Gemini baseline number.

Two pieces, both PURE stdlib (reuse reconcile.to_events for parsing + llm_omr's tested MusicXML
builder for generation), so they run anywhere with no new dependency and no API key:

  score_transcription(pred_xml, truth_xml) -> metrics
      Note-level precision / recall / F1 plus chord correctness, comparing the two scores as
      multisets of (measure, staff, midi) so the metric is robust to rhythm/onset differences
      (we grade WHAT notes were read, per measure+hand, not their exact tick placement).

  generate_random_score(seed, ...) -> MusicXML bytes
      A deterministic random piano grand-staff score (the MusicXML IS its own ground truth).
      Built via llm_omr.score_json_to_musicxml so the output is always well-formed.

NEVER raises into a caller: score_transcription degrades to zeros on unparseable input.
"""

from __future__ import annotations

import random
from collections import Counter
from typing import Dict, List, Optional

import reconcile
import llm_omr


# --- Scoring -----------------------------------------------------------------------------

def _pitched_by_cell(xml_bytes) -> Dict:
    """Parse MusicXML -> {(measure, staff): Counter of midi}. Rests ignored. Robust: returns {}
    on parse failure (reconcile.to_events already never raises)."""
    out: Dict = {}
    for e in reconcile.to_events(xml_bytes, "x"):
        midi = reconcile._pitch_to_midi(e.pitch)
        if midi is None:
            continue
        out.setdefault((e.measure, e.staff), Counter())[midi] += 1
    return out


def _chords_by_cell(xml_bytes) -> Dict:
    """Parse MusicXML -> {(measure, staff): Counter of frozenset(midi)} of the CHORDS (onset
    slots with >= 2 pitched notes) in each measure+hand.

    Keyed by (measure, staff) and NOT by raw onset on purpose: a raw onset is a per-document
    tick (lcm of that doc's <divisions>), so two engines that read the same chord but emit
    different <divisions> would never align. Comparing the multiset of chord pitch-sets per
    measure+hand is tick-base-invariant (and matches the note metric's "grade WHAT per
    measure+hand, not exact tick placement" philosophy). A chord in the wrong beat of the right
    measure still counts; a chord moved to another measure does not."""
    onset_slots: Dict = {}
    for e in reconcile.to_events(xml_bytes, "x"):
        midi = reconcile._pitch_to_midi(e.pitch)
        if midi is None:
            continue
        onset_slots.setdefault((e.measure, e.staff, e.onset), set()).add(midi)
    cells: Dict = {}
    for (measure, staff, _onset), midis in onset_slots.items():
        if len(midis) >= 2:
            cells.setdefault((measure, staff), Counter())[frozenset(midis)] += 1
    return cells


def score_transcription(pred_xml, truth_xml) -> Dict:
    """Grade a predicted MusicXML transcription against a ground-truth MusicXML.

    Returns a dict:
      note_precision/recall/f1 : note-level, comparing (measure, staff, midi) MULTISETS (so a
        right note in the right measure+hand counts even if the rhythm/onset differs). NOTE:
        midi is exact incl. octave (C4 != C5, an octave error is a full miss), and duration is
        NOT scored (a right pitch with the wrong duration still counts). This is a pitch-accuracy
        metric, not a full transcription score.
      n_truth / n_pred / n_matched : the underlying counts.
      chord_recall : fraction of TRUTH chords (>=2 notes at one onset) whose exact pitch set
        appears in the same (measure, staff) of the prediction. Tick-base-invariant (keyed by
        measure+hand, not raw onset), so a different <divisions> does not falsely zero it.
        1.0 if there are no truth chords.
      per_measure : per (measure, staff) {truth, pred, matched} note counts, for inspection.

    Engine-agnostic and never raises; unparseable input yields zeros.
    """
    try:
        truth = _pitched_by_cell(truth_xml)
        pred = _pitched_by_cell(pred_xml)

        cells = set(truth) | set(pred)
        n_truth = n_pred = n_matched = 0
        per_measure: List[Dict] = []
        for cell in sorted(cells):
            t = truth.get(cell, Counter())
            p = pred.get(cell, Counter())
            matched = sum((t & p).values())
            tn, pn = sum(t.values()), sum(p.values())
            n_truth += tn
            n_pred += pn
            n_matched += matched
            per_measure.append(
                {"measure": cell[0], "staff": cell[1], "truth": tn, "pred": pn, "matched": matched}
            )

        # 0 when the denominator is 0 (nothing predicted / nothing to match, incl. garbage
        # input that parses to no notes) - the documented "degrade to zeros" contract.
        precision = n_matched / n_pred if n_pred else 0.0
        recall = n_matched / n_truth if n_truth else 0.0
        f1 = (2 * precision * recall / (precision + recall)) if (precision + recall) else 0.0

        truth_chords = _chords_by_cell(truth_xml)
        pred_chords = _chords_by_cell(pred_xml)
        n_truth_chords = sum(sum(c.values()) for c in truth_chords.values())
        if n_truth_chords:
            chord_hits = 0
            for cell, t_sets in truth_chords.items():
                p_sets = pred_chords.get(cell, Counter())
                chord_hits += sum((t_sets & p_sets).values())  # multiset intersection of pitch-sets
            chord_recall = chord_hits / n_truth_chords
        else:
            chord_recall = 1.0

        return {
            "note_precision": round(precision, 4),
            "note_recall": round(recall, 4),
            "note_f1": round(f1, 4),
            "n_truth": n_truth,
            "n_pred": n_pred,
            "n_matched": n_matched,
            "chord_recall": round(chord_recall, 4),
            "n_truth_chords": n_truth_chords,
            "per_measure": per_measure,
        }
    except Exception:
        return {
            "note_precision": 0.0,
            "note_recall": 0.0,
            "note_f1": 0.0,
            "n_truth": 0,
            "n_pred": 0,
            "n_matched": 0,
            "chord_recall": 0.0,
            "n_truth_chords": 0,
            "per_measure": [],
        }


# --- Synthetic score generation (deterministic; the MusicXML is its own ground truth) -----

# Diatonic scale-degree -> semitone offset within an octave (major), for building in-key pitches.
_MAJOR = [0, 2, 4, 5, 7, 9, 11]
_PC_TO_STEP_ALTER = {
    0: ("C", 0), 1: ("C", 1), 2: ("D", 0), 3: ("E", -1), 4: ("E", 0), 5: ("F", 0),
    6: ("F", 1), 7: ("G", 0), 8: ("A", -1), 9: ("A", 0), 10: ("B", -1), 11: ("B", 0),
}


def _midi_to_pitch(midi: int) -> Dict:
    pc = midi % 12
    octave = midi // 12 - 1
    step, alter = _PC_TO_STEP_ALTER[pc]
    return {"step": step, "alter": alter, "octave": octave}


def generate_random_score(
    seed: int,
    n_measures: int = 8,
    key_fifths: int = 0,
    divisions: int = 4,
    chord_prob: float = 0.25,
) -> bytes:
    """Generate a deterministic random piano grand-staff score as MusicXML bytes. Same seed +
    args => byte-identical output. The notes are drawn from the key's major scale; the bass
    staff sometimes stacks a diatonic chord (so the eval set exercises chord correctness).

    Built through llm_omr.score_json_to_musicxml, so the document is always well-formed and is
    its OWN ground truth (feed the same bytes as both pred and truth -> perfect score)."""
    rng = random.Random(seed)
    tonic_pc = (key_fifths * 7) % 12
    scale = [(tonic_pc + d) % 12 for d in _MAJOR]

    def diatonic_midi(low_octave: int, span: int) -> int:
        degree = rng.randrange(len(scale))
        octave = low_octave + rng.randrange(span)
        pc = scale[degree]
        return (octave + 1) * 12 + pc

    measures = []
    quarter = divisions
    for _ in range(n_measures):
        # 4/4: four quarter-beats per staff; each beat is one quarter note (keep rhythm simple
        # so durations always sum to capacity -> valid bars).
        staff1 = []
        staff2 = []
        for _beat in range(4):
            # treble: a single melody note around C5..C6.
            staff1.append({"duration": quarter, "pitches": [_midi_to_pitch(diatonic_midi(4, 2))]})
            # bass: sometimes a chord (root + diatonic third + fifth), else a single note.
            root = diatonic_midi(2, 2)
            if rng.random() < chord_prob:
                pitches = [_midi_to_pitch(root)]
                for interval in (3, 7):  # a stacked-ish chord (approximate third + fifth)
                    pitches.append(_midi_to_pitch(root + interval))
                staff2.append({"duration": quarter, "pitches": pitches})
            else:
                staff2.append({"duration": quarter, "pitches": [_midi_to_pitch(root)]})
        measures.append({"staff1": staff1, "staff2": staff2})

    data = {
        "divisions": divisions,
        "key_fifths": key_fifths,
        "time": {"beats": 4, "beat_type": 4},
        "measures": measures,
    }
    out = llm_omr.score_json_to_musicxml(data)
    return out if out is not None else b""
