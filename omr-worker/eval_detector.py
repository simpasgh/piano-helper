#!/usr/bin/env python3
"""End-to-end transcription eval on held-out synthetic scores: the roadmap's PRIMARY portable
benchmark. Runs the classical geom_omr pipeline AND the trained-detector pipeline on the SAME val
images and grades both against ground truth, so the comparison is apples-to-apples (only the
notehead source differs).

Metrics (micro-averaged over all val notes), defined to match the roadmap's quoted numbers:
  exact P/R/F1   : (measure, staff, midi) multiset match incl. octave  (== omr_eval note metric)
  pitch_class    : recall on (midi % 12) ignoring octave
  octave_acc     : exact_matched / pitch_class_matched -> of the notes whose NAME is right, the
                   fraction whose OCTAVE is also right. (pitch_class * octave_acc == exact_recall;
                   verified 0.796 * 0.972 == 0.774 against the roadmap's geom_omr clean numbers.)
  chord_recall   : fraction of truth chords whose exact pitch-set appears in the right cell.

Run:
    python eval_detector.py --dataset C:/Users/pascu/omr-train/synth1 \
        --weights C:/Users/pascu/omr-train/runs/notehead1/weights/best.pt
"""
from __future__ import annotations

import argparse
import json
import os
from collections import Counter
from typing import Dict, Optional

import omr_eval
import geom_omr


def _pool_by_staff(by_cell: Dict) -> Dict:
    """Re-key {(measure, staff): Counter} -> {staff: Counter} (sum across measures). A
    measure-AGNOSTIC view: a note read with the right pitch in the right HAND but the wrong
    measure still counts. The gap between this and the measure-keyed metric isolates how much the
    rhythm-less measure binning (not the detector/decode) is costing us."""
    out: Dict = {}
    for (m, staff), c in by_cell.items():
        out.setdefault(staff, Counter()).update(c)
    return out


def _accumulate(acc: Dict, pred_xml: Optional[bytes], truth_xml: bytes) -> None:
    """Add one sample's counts into the running micro-average accumulator."""
    truth = omr_eval._pitched_by_cell(truth_xml)
    pred = omr_eval._pitched_by_cell(pred_xml) if pred_xml else {}
    for cell in set(truth) | set(pred):
        t = truth.get(cell, Counter())
        p = pred.get(cell, Counter())
        acc["exact"] += sum((t & p).values())
        tpc, ppc = Counter(), Counter()
        for m, n in t.items():
            tpc[m % 12] += n
        for m, n in p.items():
            ppc[m % 12] += n
        acc["pc"] += sum((tpc & ppc).values())
        acc["n_truth"] += sum(t.values())
        acc["n_pred"] += sum(p.values())
    # duration-aware: fold dur16 into the key to count notes read with the RIGHT pitch AND
    # duration (the rhythm signal the pitch-only `exact` count ignores). duration_acc in _summary
    # is dur_exact / exact = of the pitch-correct notes, the fraction also rhythm-correct.
    truth_d = omr_eval._pitched_dur_by_cell(truth_xml)
    pred_d = omr_eval._pitched_dur_by_cell(pred_xml) if pred_xml else {}
    for cell in set(truth_d) | set(pred_d):
        acc["dur_exact"] += sum((truth_d.get(cell, Counter()) & pred_d.get(cell, Counter())).values())
    # measure-agnostic (staff-pooled) exact matches, to isolate the measure-binning cost.
    truth_sp, pred_sp = _pool_by_staff(truth), _pool_by_staff(pred)
    for staff in set(truth_sp) | set(pred_sp):
        acc["exact_sp"] += sum((truth_sp.get(staff, Counter()) & pred_sp.get(staff, Counter())).values())
    # chords (>= 2 notes at one onset), accumulated to a micro chord recall. Parse the chord
    # maps with omr_eval._chords_by_cell and count via the SHARED omr_eval._chord_hit_counts (the
    # same routine score_transcription uses), so the micro chord_recall cannot drift from the
    # per-sample scorer. The old code called omr_eval.score_transcription only for these two
    # numbers, which re-parsed BOTH XMLs for note metrics that were then discarded; going
    # straight to the chord helper drops two redundant parses per sample.
    truth_chords = omr_eval._chords_by_cell(truth_xml)
    pred_chords = omr_eval._chords_by_cell(pred_xml) if pred_xml else {}
    ntc, hits = omr_eval._chord_hit_counts(truth_chords, pred_chords)
    acc["truth_chords"] += ntc
    acc["chord_hits"] += hits


def _summary(acc: Dict) -> Dict:
    nt, npd = acc["n_truth"], acc["n_pred"]
    exact, pc = acc["exact"], acc["pc"]
    prec = exact / npd if npd else 0.0
    rec = exact / nt if nt else 0.0
    f1 = (2 * prec * rec / (prec + rec)) if (prec + rec) else 0.0
    return {
        "exact_precision": round(prec, 4),
        "exact_recall": round(rec, 4),
        "exact_f1": round(f1, 4),
        "pitch_class_recall": round(pc / nt, 4) if nt else 0.0,
        "octave_acc": round(exact / pc, 4) if pc else 0.0,
        # rhythm: of the pitch-correct notes, the fraction also read with the right duration;
        # note_dur_recall is the full pitch+duration recall over all truth notes.
        "duration_acc": round(acc["dur_exact"] / exact, 4) if exact else 0.0,
        "note_dur_recall": round(acc["dur_exact"] / nt, 4) if nt else 0.0,
        # measure-agnostic recall: same notes, graded per-hand instead of per-(measure, hand).
        # If this is much higher than exact_recall, the measure binning is the bottleneck.
        "staff_pooled_recall": round(acc["exact_sp"] / nt, 4) if nt else 0.0,
        # micro chord recall: chord hits / truth chords, matching omr_eval.score_transcription's
        # convention (1.0 when there are no truth chords). _accumulate already tracks both counts.
        "chord_recall": round(acc["chord_hits"] / acc["truth_chords"], 4) if acc["truth_chords"] else 1.0,
        "n_truth": nt, "n_pred": npd, "n_exact": exact,
    }


def _new_acc() -> Dict:
    return {"exact": 0, "pc": 0, "n_truth": 0, "n_pred": 0, "truth_chords": 0,
            "chord_hits": 0, "exact_sp": 0, "dur_exact": 0}


def evaluate(dataset: str, weights: Optional[str], limit: Optional[int] = None,
             device: str = "0", oracle_key: bool = False) -> Dict:
    with open(os.path.join(dataset, "val_manifest.json"), encoding="utf-8") as f:
        manifest = json.load(f)
    if limit:
        manifest = manifest[:limit]

    detector = None
    if weights:
        import geom_detector
        if not geom_detector.DETECTOR_AVAILABLE:
            raise RuntimeError(f"detector unavailable: {geom_detector._IMPORT_ERROR}")
        detector = geom_detector.NoteheadDetector(weights, device=device)

    classical_acc = _new_acc()
    trained_acc = _new_acc()
    for i, item in enumerate(manifest):
        img = os.path.join(dataset, item["image"])
        with open(os.path.join(dataset, item["musicxml"]), "rb") as f:
            truth = f.read()
        # oracle key: feed the known key signature to the decode (upper bound that isolates note
        # reading from key-signature DETECTION, a separate task). Off -> assume C major.
        key = int(item.get("params", {}).get("key_fifths", 0)) if oracle_key else 0
        # classical baseline on the same image
        _accumulate(classical_acc, geom_omr.transcribe_geometric(img, key_fifths=key), truth)
        # trained detector
        if detector is not None:
            import geom_detector
            _accumulate(trained_acc,
                        geom_detector.transcribe_with_detector(img, detector, key_fifths=key), truth)
        if (i + 1) % 25 == 0:
            print(f"  {i + 1}/{len(manifest)} scored")

    out = {"n_val": len(manifest), "classical": _summary(classical_acc)}
    if detector is not None:
        out["trained"] = _summary(trained_acc)
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="End-to-end OMR eval on held-out synthetic scores")
    ap.add_argument("--dataset", required=True, help="dataset dir (with val_manifest.json)")
    ap.add_argument("--weights", default=None, help="trained YOLO weights (.pt); omit for classical-only")
    ap.add_argument("--limit", type=int, default=None, help="score only the first N val scores")
    ap.add_argument("--device", default="0", help="'0' for GPU, 'cpu' to avoid disturbing a run")
    ap.add_argument("--oracle-key", action="store_true",
                    help="feed each score's known key to the decode (isolates note reading from "
                         "key-signature detection)")
    args = ap.parse_args(argv)
    res = evaluate(args.dataset, args.weights, args.limit, device=args.device,
                   oracle_key=args.oracle_key)
    print("\n===== END-TO-END EVAL (held-out synthetic) =====")
    print(json.dumps(res, indent=2))
    print("\nBar to beat: classical clean exact-F1 0.774 / octave 0.972 (roadmap); free baseline 0.90.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
