#!/usr/bin/env python3
"""Build a YOLO-format synthetic notehead-detection dataset from generate_random_score scores.

Each sample is a Verovio-rendered grand-staff score (its MusicXML is its own ground truth) with
pixel-exact notehead boxes from synth_render. We domain-randomize the score (measures, key,
chord density) AND the rendering (page width, pixels-per-interline) so the detector survives the
scale/layout variety of real phone photos. The val split also keeps each score's ground-truth
MusicXML so the SAME held-out scores drive the end-to-end transcription eval (detector ->
decode_pitch -> omr_eval.score_transcription), the roadmap's primary portable benchmark.

Layout written (ultralytics-ready):
    <out>/images/{train,val}/<stem>.png
    <out>/labels/{train,val}/<stem>.txt        # 'class xc yc w h' normalized
    <out>/val_truth/<stem>.musicxml            # ground truth for end-to-end eval
    <out>/val_manifest.json                    # [{stem, musicxml, params}, ...]
    <out>/data.yaml                            # ultralytics dataset config

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
from typing import Dict, Optional, Tuple

import omr_eval
import synth_render as sr


def _sample_params(rng: random.Random, idx: int, fixed_key: Optional[int] = None) -> Dict:
    """Deterministic per-sample randomization of the score + the render scale/layout. fixed_key
    pins key_fifths (e.g. 0 for a C-major eval set that isolates detection from the orthogonal
    key-signature decode); None randomizes it for training variety."""
    return {
        "seed": rng.randrange(2**31),
        "n_measures": rng.randint(6, 16),
        "key_fifths": fixed_key if fixed_key is not None else rng.randint(-4, 4),
        "chord_prob": round(rng.uniform(0.1, 0.5), 3),
        "page_width": rng.choice([1400, 1600, 1800, 2100]),
        "px_per_interline": round(rng.uniform(20.0, 34.0), 2),
    }


def _render_sample(renderer: "sr.ScoreRenderer", p: Dict) -> Tuple[bytes, sr.RenderedScore, bytes]:
    """Generate MusicXML for params p, render it, return (musicxml, RenderedScore)."""
    xml = omr_eval.generate_random_score(
        seed=p["seed"], n_measures=p["n_measures"],
        key_fifths=p["key_fifths"], chord_prob=p["chord_prob"],
    )
    rs = renderer.render(xml, page_width=p["page_width"], px_per_interline=p["px_per_interline"])
    return xml, rs


def _write_sample(out: str, split: str, stem: str, rs: sr.RenderedScore) -> None:
    img_path = os.path.join(out, "images", split, stem + ".png")
    lbl_path = os.path.join(out, "labels", split, stem + ".txt")
    with open(img_path, "wb") as f:
        f.write(rs.png)
    with open(lbl_path, "w", encoding="utf-8") as f:
        f.write("\n".join(rs.yolo_lines()) + ("\n" if rs.noteheads else ""))


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
            n_boxes += len(rs.noteheads)
            if split == "val":
                xml_path = os.path.join(out, "val_truth", stem + ".musicxml")
                with open(xml_path, "wb") as f:
                    f.write(xml)
                manifest.append({"stem": stem, "musicxml": f"val_truth/{stem}.musicxml",
                                 "image": f"images/val/{stem}.png", "params": p,
                                 "n_noteheads": len(rs.noteheads)})
            done += 1
            if done % 25 == 0 or done == len(plan):
                print(f"  {done}/{len(plan)} rendered, {n_boxes} notehead boxes so far")

    with open(os.path.join(out, "val_manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)

    data_yaml = (
        f"path: {os.path.abspath(out)}\n"
        "train: images/train\n"
        "val: images/val\n"
        "names:\n"
        "  0: notehead\n"
    )
    with open(os.path.join(out, "data.yaml"), "w", encoding="utf-8") as f:
        f.write(data_yaml)
    print(f"DONE: {done} images, {n_boxes} notehead boxes. data.yaml at {out}/data.yaml")


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
