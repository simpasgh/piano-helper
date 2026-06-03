#!/usr/bin/env python3
"""Convert the DeepScoresV2 dataset (real LilyPond-typeset music, CC BY 4.0) into a YOLO
notehead-detection dataset, so our detector trains on REAL engraved scores, not only our own
Verovio renders. DeepScores is the license-safe real-data choice: CC BY 4.0 permits commercial
use with attribution (MUSCIMA++/CVC-MUSCIMA are CC BY-NC and are deliberately NOT used).

ATTRIBUTION (required by CC BY 4.0): Tuggener et al., "The DeepScoresV2 Dataset and Benchmark
for Music Object Detection", ICPR 2020 (https://zenodo.org/records/4012193).

DeepScoresV2 annotation format (obb_anns JSON, one per split, e.g. deepscores_train.json):
  categories : {cat_id: {name, annotation_set, color}}  (135 fine-grained classes)
  images     : [{id, filename, width, height, ann_ids:[...]}]
  annotations: {ann_id: {a_bbox:[x1,y1,x2,y2], o_bbox:[8 coords], cat_id:[per annotation_set],
                         area, img_id, comments}}
We keep every category whose name starts with "notehead" (noteheadBlackOnLine, ...InSpace,
...Half..., ...Whole..., small variants) and emit its axis-aligned a_bbox as a single YOLO class
0 = notehead. Everything else (rests, clefs, stems, beams) is dropped.

Pure stdlib. Run after extracting ds2_dense.tar.gz:
    python deepscores_to_yolo.py <deepscores_root> <out_yolo_dir>
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import shutil
from typing import Dict, List, Optional, Tuple


def _find_jsons(root: str) -> Dict[str, str]:
    """Map split -> annotation json path. DeepScoresV2 dense ships deepscores_train.json and
    deepscores_test.json; we map test -> val."""
    out: Dict[str, str] = {}
    for j in glob.glob(os.path.join(root, "**", "*.json"), recursive=True):
        b = os.path.basename(j).lower()
        if "train" in b:
            out["train"] = j
        elif "test" in b or "val" in b:
            out["val"] = j
    return out


def _images_dir(root: str, sample_filename: str) -> Optional[str]:
    """Locate the dir that actually holds the image files (DeepScores puts them under images/)."""
    for cand in glob.glob(os.path.join(root, "**", sample_filename), recursive=True):
        return os.path.dirname(cand)
    return None


def _notehead_cat_ids(categories: Dict) -> set:
    # Only the fine-grained 'deepscores' annotation set (ids ~25-40: noteheadBlack/Half/Whole/
    # DoubleWhole x OnLine/InSpace x small). cat_id[0] of every annotation is from this set, so we
    # match against it. The parallel 'muscima++' notehead ids are intentionally excluded.
    return {str(cid) for cid, c in categories.items()
            if str(c.get("name", "")).lower().startswith("notehead")
            and c.get("annotation_set") == "deepscores"}


def _cat_of(ann: Dict) -> str:
    """The DeepScores (fine-grained) category id of an annotation. cat_id is a list aligned to
    annotation_sets (deepscores is first); tolerate a scalar too."""
    cid = ann.get("cat_id")
    if isinstance(cid, list):
        return str(cid[0]) if cid else ""
    return str(cid)


def _to_yolo(a_bbox: List[float], W: float, H: float) -> Optional[Tuple[float, float, float, float]]:
    try:
        x1, y1, x2, y2 = [float(v) for v in a_bbox[:4]]
        if x2 < x1:
            x1, x2 = x2, x1
        if y2 < y1:
            y1, y2 = y2, y1
        xc = (x1 + x2) / 2.0 / W
        yc = (y1 + y2) / 2.0 / H
        w = (x2 - x1) / W
        h = (y2 - y1) / H
        if w <= 0 or h <= 0 or not (0 <= xc <= 1) or not (0 <= yc <= 1):
            return None
        return xc, yc, min(w, 1.0), min(h, 1.0)
    except Exception:
        return None


def convert_split(json_path: str, root: str, out: str, split: str) -> Tuple[int, int]:
    data = json.load(open(json_path, encoding="utf-8"))
    cats = data.get("categories", {})
    anns = data.get("annotations", {})
    images = data.get("images", [])
    nh_ids = _notehead_cat_ids(cats)
    if not nh_ids:
        raise ValueError("no notehead categories found; check the annotation_set / format")

    img_out = os.path.join(out, "images", split)
    lbl_out = os.path.join(out, "labels", split)
    os.makedirs(img_out, exist_ok=True)
    os.makedirs(lbl_out, exist_ok=True)

    src_dir = _images_dir(root, images[0]["filename"]) if images else None
    if src_dir is None:
        raise FileNotFoundError("could not locate the image directory under the dataset root")

    n_img = n_box = 0
    for im in images:
        fn = im["filename"]
        W, H = float(im["width"]), float(im["height"])
        rows: List[str] = []
        for aid in im.get("ann_ids", []):
            ann = anns.get(str(aid)) or anns.get(aid)
            if not ann or _cat_of(ann) not in nh_ids:
                continue
            box = _to_yolo(ann.get("a_bbox", []), W, H)
            if box is None:
                continue
            rows.append("0 %.6f %.6f %.6f %.6f" % box)
        src = os.path.join(src_dir, fn)
        if not os.path.exists(src):
            continue
        stem = os.path.splitext(fn)[0]
        shutil.copy2(src, os.path.join(img_out, fn))
        with open(os.path.join(lbl_out, stem + ".txt"), "w", encoding="utf-8") as f:
            f.write("\n".join(rows) + ("\n" if rows else ""))
        n_img += 1
        n_box += len(rows)
    return n_img, n_box


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="DeepScoresV2 -> YOLO notehead dataset")
    ap.add_argument("root", help="extracted DeepScoresV2 dense root")
    ap.add_argument("out", help="output YOLO dataset dir")
    args = ap.parse_args(argv)

    splits = _find_jsons(args.root)
    if "train" not in splits:
        raise SystemExit("no train json found under " + args.root)
    totals = {}
    for split, jp in splits.items():
        ni, nb = convert_split(jp, args.root, args.out, split)
        totals[split] = (ni, nb)
        print(f"  {split}: {ni} images, {nb} notehead boxes  (from {os.path.basename(jp)})")

    with open(os.path.join(args.out, "data.yaml"), "w", encoding="utf-8") as f:
        f.write(f"path: {os.path.abspath(args.out)}\n")
        f.write("train: images/train\n")
        f.write("val: images/%s\n" % ("val" if "val" in splits else "train"))
        f.write("names:\n  0: notehead\n")
    print("DONE:", totals, "-> data.yaml at", os.path.join(args.out, "data.yaml"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
