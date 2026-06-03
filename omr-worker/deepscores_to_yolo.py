#!/usr/bin/env python3
"""Convert the DeepScoresV2 dataset (real LilyPond-typeset music, CC BY 4.0) into a YOLO
MULTI-CLASS symbol-detection dataset, so our full-symbol detector trains on REAL engraved scores,
not only our own Verovio renders. DeepScores is the license-safe real-data choice: CC BY 4.0
permits commercial use with attribution (MUSCIMA++/CVC-MUSCIMA are CC BY-NC and are NOT used).

ATTRIBUTION (required by CC BY 4.0): Tuggener et al., "The DeepScoresV2 Dataset and Benchmark
for Music Object Detection", ICPR 2020 (https://zenodo.org/records/4012193).

DeepScoresV2 annotation format (obb_anns JSON, one per split, e.g. deepscores_train.json):
  categories : {cat_id: {name, annotation_set, color}}  (136 fine-grained classes)
  images     : [{id, filename, width, height, ann_ids:[...]}]
  annotations: {ann_id: {a_bbox:[x1,y1,x2,y2], o_bbox:[8 coords], cat_id:[per annotation_set],
                         area, img_id, comments}}

We map each DeepScores category NAME onto the shared synth_render.CLASS_NAMES taxonomy (the SAME
classes the synthetic generator emits), via _ds_category_to_class, and write the annotation's
axis-aligned a_bbox under that class index. Categories outside our taxonomy (articulations,
dynamics, ornaments, fingerings, slurs, staff/ledger lines, tuplet/brace marks, ...) are dropped.
Key-signature accidentals (keySharp/keyFlat/keyNatural) fold into the accidental_* classes, exactly
as in synth_render (the glyph is identical; the decode separates them by position).

Pure stdlib + the shared taxonomy from synth_render. Run after extracting ds2_dense.tar.gz:
    python deepscores_to_yolo.py <deepscores_root> <out_yolo_dir>
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import shutil
from typing import Dict, List, Optional, Tuple

from synth_render import CLASS_NAMES, CLASS_INDEX


def _ds_category_to_class(name: str) -> Optional[str]:
    """Map a DeepScoresV2 category name onto our shared symbol taxonomy, or None to drop it. PURE.
    Mirrors synth_render's SMuFL-code mapping but keyed on DeepScores' descriptive names. Order
    matters: double accidentals before single; augmentationDot is NOT repeatDot; the octave-marker
    clefs (clef8/clef15) and percussion clef are dropped; the multi-measure rest bar/number
    (restHBar/restHNr) and slurs are dropped (slurs are not ties)."""
    n = (name or "").strip()
    nl = n.lower()
    if nl.startswith("noteheadblack"):
        return "notehead_filled"
    if nl.startswith(("noteheadhalf", "noteheadwhole", "noteheaddoublewhole")):
        return "notehead_open"
    if n == "stem":
        return "stem"
    if n == "beam":
        return "beam"
    if nl.startswith("flag") and len(n) > 4 and n[4].isdigit():
        return "flag"   # flag8thUp..flag128thDown; excludes non-duration flags (e.g. flagInternal*)
    if n == "augmentationDot":
        return "dot"
    if "doublesharp" in nl:
        return "accidental_double_sharp"
    if "doubleflat" in nl:
        return "accidental_double_flat"
    if nl.startswith("accidentalsharp") or nl == "keysharp":
        return "accidental_sharp"
    if nl.startswith("accidentalflat") or nl == "keyflat":
        return "accidental_flat"
    if nl.startswith("accidentalnatural") or nl == "keynatural":
        return "accidental_natural"
    if nl == "clefg":
        return "clef_g"
    if nl == "cleff":
        return "clef_f"
    if nl.startswith("clefc"):   # clefCAlto, clefCTenor (clef8/clef15/percussion are dropped)
        return "clef_c"
    if nl.startswith("rest") and n not in ("restHBar", "restHNr"):
        return "rest"
    if nl.startswith("timesig"):
        return "timesig"
    if n == "tie":
        return "tie"
    if nl == "ottavabracket":
        return "ottava"
    return None


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


def _category_class_map(categories: Dict) -> Dict[str, int]:
    """{cat_id (str) -> our class index} for every fine-grained 'deepscores' category that maps to
    our taxonomy (via _ds_category_to_class). cat_id[0] of every annotation is from this set; the
    parallel 'muscima++' ids are intentionally excluded."""
    out: Dict[str, int] = {}
    for cid, c in categories.items():
        if c.get("annotation_set") != "deepscores":
            continue
        mapped = _ds_category_to_class(str(c.get("name", "")))
        if mapped is not None:
            out[str(cid)] = CLASS_INDEX[mapped]
    return out


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


def convert_split(json_path: str, root: str, out: str, split: str) -> Tuple[int, int, Dict[str, int]]:
    data = json.load(open(json_path, encoding="utf-8"))
    cats = data.get("categories", {})
    anns = data.get("annotations", {})
    images = data.get("images", [])
    cls_map = _category_class_map(cats)
    if not cls_map:
        raise ValueError("no mappable categories found; check the annotation_set / format")

    img_out = os.path.join(out, "images", split)
    lbl_out = os.path.join(out, "labels", split)
    os.makedirs(img_out, exist_ok=True)
    os.makedirs(lbl_out, exist_ok=True)

    src_dir = _images_dir(root, images[0]["filename"]) if images else None
    if src_dir is None:
        raise FileNotFoundError("could not locate the image directory under the dataset root")

    n_img = n_box = 0
    per_class: Dict[str, int] = {}
    for im in images:
        fn = im["filename"]
        W, H = float(im["width"]), float(im["height"])
        rows: List[str] = []
        img_classes: List[int] = []
        for aid in im.get("ann_ids", []):
            ann = anns.get(str(aid)) or anns.get(aid)
            if not ann:
                continue
            cls = cls_map.get(_cat_of(ann))
            if cls is None:
                continue  # a category outside our taxonomy (artic / dynamic / slur / staff / ...)
            box = _to_yolo(ann.get("a_bbox", []), W, H)
            if box is None:
                continue
            rows.append(("%d %.6f %.6f %.6f %.6f") % ((cls,) + box))
            img_classes.append(cls)
        src = os.path.join(src_dir, fn)
        if not os.path.exists(src):
            continue  # tally + counts updated only for images we actually write (no over-count)
        stem = os.path.splitext(fn)[0]
        shutil.copy2(src, os.path.join(img_out, fn))
        with open(os.path.join(lbl_out, stem + ".txt"), "w", encoding="utf-8") as f:
            f.write("\n".join(rows) + ("\n" if rows else ""))
        n_img += 1
        n_box += len(rows)
        for cls in img_classes:
            per_class[CLASS_NAMES[cls]] = per_class.get(CLASS_NAMES[cls], 0) + 1
    return n_img, n_box, per_class


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="DeepScoresV2 -> YOLO multi-class symbol dataset")
    ap.add_argument("root", help="extracted DeepScoresV2 dense root")
    ap.add_argument("out", help="output YOLO dataset dir")
    args = ap.parse_args(argv)

    splits = _find_jsons(args.root)
    if "train" not in splits:
        raise SystemExit("no train json found under " + args.root)
    totals = {}
    for split, jp in splits.items():
        ni, nb, per_class = convert_split(jp, args.root, args.out, split)
        totals[split] = (ni, nb)
        print(f"  {split}: {ni} images, {nb} boxes  (from {os.path.basename(jp)})")
        print(f"    classes: {dict(sorted(per_class.items()))}")

    names = "\n".join(f"  {i}: {name}" for i, name in enumerate(CLASS_NAMES))
    with open(os.path.join(args.out, "data.yaml"), "w", encoding="utf-8") as f:
        f.write(f"path: {os.path.abspath(args.out)}\n")
        f.write("train: images/train\n")
        f.write("val: images/%s\n" % ("val" if "val" in splits else "train"))
        f.write(f"names:\n{names}\n")
    print("DONE:", totals, "-> data.yaml at", os.path.join(args.out, "data.yaml"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
