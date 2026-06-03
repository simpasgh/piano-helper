#!/usr/bin/env python3
"""Apply synth_augment's photo-style augmentation to a YOLO dataset split, producing photo-like
COPIES with the labels unchanged (augmentation is photometric, so the notehead boxes do not move).
This bridges the sim-to-real gap toward PHONE PHOTOS: train on clean + augmented so the detector
survives paper grain, uneven light, shadows, blur, sensor noise, and JPEG artifacts.

Labels dir is derived from the images dir by the YOLO convention (.../images/... -> .../labels/...).
Parallelized across CPU cores (Pool); deterministic per image (crc32 of the filename) so a rerun
reproduces the same variants. Pure offline tooling; run on the GPU box during dataset prep.

    python augment_dataset.py <src_images_dir> <out_images_dir> [--strength 1.0] [--workers N]
"""
from __future__ import annotations

import argparse
import glob
import os
import shutil
import zlib
from multiprocessing import Pool

import synth_augment as sa


def _labels_dir(images_dir: str) -> str:
    # replace the LAST 'images' path segment with 'labels' (YOLO convention). Raise if there is no
    # 'images' segment, so we never silently co-mingle labels into the image dir (out_labels would
    # otherwise equal out_images) or fail to find the source labels.
    parts = images_dir.replace("\\", "/").rstrip("/").split("/")
    for i in range(len(parts) - 1, -1, -1):
        if parts[i] == "images":
            parts[i] = "labels"
            return os.path.normpath("/".join(parts))
    raise ValueError(f"images dir must contain an 'images' path segment (YOLO convention): {images_dir}")


def _augment_one(task):
    src_img, out_img, src_lbl, out_lbl, strength = task
    try:
        with open(src_img, "rb") as f:
            data = f.read()
        seed = zlib.crc32(os.path.basename(src_img).encode()) & 0x7FFFFFFF
        out = sa.augment(data, seed=seed, strength=strength)
        with open(out_img, "wb") as f:
            f.write(out)
        if os.path.exists(src_lbl):
            shutil.copy2(src_lbl, out_lbl)
        else:  # background image (no boxes): write an empty label so YOLO treats it as negative
            open(out_lbl, "w").close()
        return 1
    except Exception as e:  # never let one bad image kill the batch
        return f"ERR {os.path.basename(src_img)}: {e!r}"


def build(src_images: str, out_images: str, strength: float, workers: int) -> None:
    src_labels = _labels_dir(src_images)
    out_labels = _labels_dir(out_images)
    os.makedirs(out_images, exist_ok=True)
    os.makedirs(out_labels, exist_ok=True)

    imgs = []
    for ext in ("*.png", "*.jpg", "*.jpeg"):
        imgs += glob.glob(os.path.join(src_images, ext))
    tasks = []
    for src in imgs:
        stem = os.path.splitext(os.path.basename(src))[0]
        tasks.append((
            src,
            os.path.join(out_images, os.path.basename(src)),
            os.path.join(src_labels, stem + ".txt"),
            os.path.join(out_labels, stem + ".txt"),
            strength,
        ))
    ok = 0
    errs = []
    with Pool(processes=workers) as pool:
        for i, r in enumerate(pool.imap_unordered(_augment_one, tasks, chunksize=8), 1):
            if r == 1:
                ok += 1
            else:
                errs.append(r)
            if i % 200 == 0:
                print(f"  {i}/{len(tasks)} augmented")
    print(f"DONE: {ok}/{len(tasks)} augmented -> {out_images}")
    for e in errs[:10]:
        print("  ", e)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Photo-augment a YOLO dataset split")
    ap.add_argument("src_images")
    ap.add_argument("out_images")
    ap.add_argument("--strength", type=float, default=1.0)
    ap.add_argument("--workers", type=int, default=max(1, (os.cpu_count() or 4) - 2))
    args = ap.parse_args(argv)
    build(args.src_images, args.out_images, args.strength, args.workers)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
