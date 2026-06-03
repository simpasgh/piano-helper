#!/usr/bin/env python3
"""Build a YOLO-format synthetic MULTI-CLASS symbol-detection dataset from generate_rich_score
scores: the training data for the full-symbol detector (heads, stems, flags, beams, dots,
accidentals, clefs, rests, time-sig digits, ties, ottava).

Each sample is a Verovio-rendered grand-staff score (its MusicXML is its own ground truth) with
pixel-exact, multi-class boxes from synth_render (read from the engraved SVG geometry, no hand
labeling). We domain-randomize the score (measures, key, chord/accidental/rest density, rhythm
density, and the harder clef-change / ottava / ledger modes) AND the rendering (page width,
pixels-per-interline) so the detector survives the scale/layout variety of real phone photos. The
val split also keeps each score's ground-truth MusicXML so the SAME held-out scores drive the
end-to-end transcription eval (detector -> decode -> omr_eval.score_transcription).

Layout written (ultralytics-ready):
    <out>/images/{train,val}/<stem>.png
    <out>/labels/{train,val}/<stem>.txt        # 'class xc yc w h' normalized, multi-class
    <out>/val_truth/<stem>.musicxml            # ground truth for end-to-end eval
    <out>/val_manifest.json                    # [{stem, musicxml, params, counts}, ...]
    <out>/data.yaml                            # ultralytics dataset config (all symbol classes)

Run:
    python synth_dataset.py <out_dir> --train 1500 --val 200 [--seed 0]

Heavy output (images/labels/runs) is gitignored; only this generator is committed.
"""
from __future__ import annotations

import argparse
import json
import os
import random
import sys
from collections import Counter
from typing import Dict, Optional, Tuple

import omr_eval
import synth_render as sr


def _sample_params(rng: random.Random, idx: int, fixed_key: Optional[int] = None) -> Dict:
    """Deterministic per-sample randomization of the rich score + the render scale/layout.
    fixed_key pins key_fifths (e.g. 0 for a C-major set that isolates detection from the key
    decode); None randomizes it over ALL keys for training variety. The harder modes
    (clef changes / ottava / ledger-heavy) fire on a minority of samples so those rarer glyphs
    appear without dominating the set."""
    return {
        "seed": rng.randrange(2**31),
        "n_measures": rng.randint(4, 12),
        "key_fifths": fixed_key if fixed_key is not None else rng.randint(-7, 7),
        "chord_prob": round(rng.uniform(0.1, 0.5), 3),
        "accidental_prob": round(rng.uniform(0.05, 0.35), 3),
        "rest_prob": round(rng.uniform(0.05, 0.2), 3),
        "density": round(rng.uniform(0.3, 0.85), 3),
        "tie_prob": round(rng.uniform(0.0, 0.15), 3),
        "clef_changes": rng.random() < 0.25,
        "ottava": rng.random() < 0.2,
        "ledger_heavy": rng.random() < 0.2,
        "page_width": rng.choice([1400, 1600, 1800, 2100]),
        "px_per_interline": round(rng.uniform(20.0, 34.0), 2),
    }


def _render_sample(renderer: "sr.ScoreRenderer", p: Dict) -> Tuple[bytes, sr.RenderedScore]:
    """Generate rich MusicXML for params p, render it, return (musicxml, RenderedScore)."""
    xml = omr_eval.generate_rich_score(
        seed=p["seed"], n_measures=p["n_measures"], key_fifths=p["key_fifths"],
        chord_prob=p["chord_prob"], accidental_prob=p["accidental_prob"],
        rest_prob=p["rest_prob"], density=p["density"], tie_prob=p["tie_prob"],
        clef_changes=p["clef_changes"], ottava=p["ottava"], ledger_heavy=p["ledger_heavy"],
    )
    rs = renderer.render(xml, page_width=p["page_width"], px_per_interline=p["px_per_interline"])
    return xml, rs


def _write_sample(out: str, split: str, stem: str, rs: sr.RenderedScore) -> None:
    img_path = os.path.join(out, "images", split, stem + ".png")
    lbl_path = os.path.join(out, "labels", split, stem + ".txt")
    with open(img_path, "wb") as f:
        f.write(rs.png)
    lines = rs.yolo_lines()
    with open(lbl_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + ("\n" if lines else ""))


def build(out: str, n_train: int, n_val: int, seed0: int = 0,
          px_per_interline: float = 26.0, fixed_key: Optional[int] = None) -> None:
    for split in ("train", "val"):
        os.makedirs(os.path.join(out, "images", split), exist_ok=True)
        os.makedirs(os.path.join(out, "labels", split), exist_ok=True)
    os.makedirs(os.path.join(out, "val_truth"), exist_ok=True)

    rng = random.Random(seed0)
    plan = [("train", i) for i in range(n_train)] + [("val", i) for i in range(n_val)]
    manifest = []
    n_boxes = 0
    class_totals: Counter = Counter()
    done = 0

    with sr.ScoreRenderer(px_per_interline=px_per_interline) as renderer:
        for split, i in plan:
            stem = f"{split}_{i:06d}"
            # Resample on the rare render failure (e.g. a combo that spills to 2 pages) so one
            # bad draw never aborts a long build.
            for attempt in range(5):
                p = _sample_params(rng, i, fixed_key=fixed_key)
                try:
                    xml, rs = _render_sample(renderer, p)
                    break
                except Exception as e:
                    if attempt == 4:
                        print(f"  !! giving up on {stem}: {e!r}", file=sys.stderr)
                        rs = None
                    continue
            if rs is None:
                continue
            _write_sample(out, split, stem, rs)
            n_boxes += len(rs.symbols)
            counts = rs.class_counts()
            class_totals.update(counts)
            if split == "val":
                xml_path = os.path.join(out, "val_truth", stem + ".musicxml")
                with open(xml_path, "wb") as f:
                    f.write(xml)
                manifest.append({"stem": stem, "musicxml": f"val_truth/{stem}.musicxml",
                                 "image": f"images/val/{stem}.png", "params": p,
                                 "n_boxes": len(rs.symbols), "counts": counts})
            done += 1
            if done % 25 == 0 or done == len(plan):
                print(f"  {done}/{len(plan)} rendered, {n_boxes} boxes so far")

    with open(os.path.join(out, "val_manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)

    names = "\n".join(f"  {i}: {name}" for i, name in enumerate(sr.CLASS_NAMES))
    data_yaml = (
        f"path: {os.path.abspath(out)}\n"
        "train: images/train\n"
        "val: images/val\n"
        f"names:\n{names}\n"
    )
    with open(os.path.join(out, "data.yaml"), "w", encoding="utf-8") as f:
        f.write(data_yaml)
    # Per-class totals expose class imbalance (rare glyphs like double accidentals / clef_c /
    # ottava) so the next build can boost their probabilities if a class trains poorly.
    dist = {name: class_totals.get(name, 0) for name in sr.CLASS_NAMES}
    print(f"DONE: {done} images, {n_boxes} boxes across {len(sr.CLASS_NAMES)} classes.")
    print(f"class distribution: {dist}")
    print(f"data.yaml at {out}/data.yaml")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Build synthetic YOLO notehead dataset")
    ap.add_argument("out", help="output dataset directory")
    ap.add_argument("--train", type=int, default=1500)
    ap.add_argument("--val", type=int, default=200)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--key", type=int, default=None,
                    help="pin key_fifths (e.g. 0 for a C-major eval set); default random")
    args = ap.parse_args(argv)
    build(args.out, args.train, args.val, seed0=args.seed, fixed_key=args.key)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
