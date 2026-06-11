#!/usr/bin/env python3
"""STAGE A of the L4 Zeus path (OMR_SEQ2SEQ): grand-staff system crops + the zeus pickle.

Runs as a subprocess in the GEOM venv (GEOM_PYTHON: numpy/PIL available; geom_omr lives
beside this file), exactly like geom_detector.py. Input is the rasterized stitched page PNG
the worker already produces for geom (worker.rasterize_if_pdf); output is ONE pickle holding
every detected grand-staff system crop, in document order, in the exact dataset shape the
stock zeus CLI consumes (--test).

CROP CONVENTION (copied from the X4 spike, C:/Users/pascu/omr-train/x4/make_crops_real.py,
the olimpic margin): detect_systems + _pair_staves from geom_omr give the grand-staff pairs;
each crop is the pair's staffline-extent bbox (y from the top staff's first line to the
bottom staff's last line; x from the band's ink extent) grown by 0.5 x system height on ALL
four sides, clamped to the image bounds. PICKLE CONVENTION (copied from make_pickles_real.py):
a list of dicts {"path": <synthetic name>, "image": <PNG bytes>, "lmx": "measure",
"musicxml": ""} -- the dummy lmx makes the dataset loadable in prediction-only mode.

EXIT CODES (read by worker.run_zeus_crops): 0 with >= 1 system written, 2 when no system was
detected (a clean decline, like geom_detector's exit 2), 1 on any error. The worker treats
anything other than exit 0 + a non-empty pickle as "decline" and keeps the fused result.
"""
from __future__ import annotations

import argparse
import io
import os
import pickle
import sys
from typing import List, Tuple

# Guarded imports, mirroring geom_omr: this module must stay IMPORTABLE in the worker venv
# (tests exercise the pure helpers below) even if numpy/PIL are absent there.
CROPS_AVAILABLE = False
try:
    import numpy as np
    from PIL import Image

    import geom_omr

    CROPS_AVAILABLE = geom_omr.GEOM_AVAILABLE
except Exception:  # pragma: no cover - exercised only in a numpy/PIL-less env
    CROPS_AVAILABLE = False

# Exit code meaning "no grand-staff system detected" (a clean decline; mirrors geom exit 2).
EXIT_NO_SYSTEMS = 2

# The olimpic margin: each side of the pair bbox grows by this fraction of the system height.
MARGIN_FRACTION = 0.5

# The dummy LMX every pickle entry carries (prediction-only mode; the token exists in the
# model's tag vocabulary, so the dataset loads without <unk> noise).
DUMMY_LMX = "measure"


def crop_box(y1: float, y2: float, x1: float, x2: float,
             page_h: int, page_w: int) -> Tuple[int, int, int, int]:
    """The olimpic margin convention (make_crops_real.py): grow the pair's staffline-extent
    bbox by MARGIN_FRACTION x system height on ALL four sides, clamped to the image bounds.
    Returns (cy1, cy2, cx1, cx2): rows are cropped [cy1:cy2], cols [cx1:cx2]. PURE."""
    height = max(y2 - y1, 1.0)
    m = MARGIN_FRACTION * height
    cy1, cy2 = max(int(y1 - m), 0), min(int(y2 + m), page_h - 1)
    cx1, cx2 = max(int(x1 - m), 0), min(int(x2 + m), page_w - 1)
    return cy1, cy2, cx1, cx2


def pickle_entry(name: str, png_bytes: bytes) -> dict:
    """One zeus dataset entry, byte-for-byte the make_pickles_real.py shape. PURE."""
    return {"path": "crops/%s" % name, "image": png_bytes, "lmx": DUMMY_LMX, "musicxml": ""}


def build_entries(gray) -> List[dict]:
    """Detect every grand-staff pair on the (possibly multi-page stitched) raster and crop it
    with the olimpic margin, top-to-bottom = document order. Returns the pickle entry list
    ([] when nothing was detected). Loop logic copied from make_crops_real.crop_systems."""
    staves = geom_omr.detect_systems(gray)
    pairs = geom_omr._pair_staves(staves)
    H, W = gray.shape
    entries: List[dict] = []
    for si, (ti, bi) in enumerate(pairs):
        idxs = [i for i in (ti, bi) if i is not None]
        if not idxs:
            continue
        y1 = min(staves[i][0] for i in idxs)
        y2 = max(staves[i][-1] for i in idxs)
        band = gray[int(y1):int(y2) + 1]
        ink_cols = np.where((band < 0.5).any(axis=0))[0]
        x1, x2 = (float(ink_cols[0]), float(ink_cols[-1])) if len(ink_cols) else (0.0, W - 1.0)
        cy1, cy2, cx1, cx2 = crop_box(float(y1), float(y2), x1, x2, H, W)
        crop = (np.clip(gray[cy1:cy2, cx1:cx2], 0, 1) * 255).astype(np.uint8)
        if crop.size == 0:
            continue
        buf = io.BytesIO()
        Image.fromarray(crop).save(buf, format="PNG")
        entries.append(pickle_entry("p1-s%d" % (si + 1), buf.getvalue()))
    return entries


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        description="Crop grand-staff systems from a page raster into a zeus pickle.")
    parser.add_argument("image", help="Rasterized (stitched) page PNG.")
    parser.add_argument("-o", "--output", required=True, help="Output pickle path.")
    args = parser.parse_args(argv)

    if not CROPS_AVAILABLE:
        print("zeus_crops: numpy/PIL/geom unavailable", file=sys.stderr, flush=True)
        return 1
    gray = geom_omr._to_gray(args.image)
    if gray is None:
        print("zeus_crops: cannot read raster %r" % args.image, file=sys.stderr, flush=True)
        return EXIT_NO_SYSTEMS
    try:
        entries = build_entries(gray)
    except Exception as err:
        print("zeus_crops: crop failed (%r)" % err, file=sys.stderr, flush=True)
        return 1
    if not entries:
        print("zeus_crops: no grand-staff systems detected", file=sys.stderr, flush=True)
        return EXIT_NO_SYSTEMS
    out_dir = os.path.dirname(os.path.abspath(args.output))
    os.makedirs(out_dir, exist_ok=True)
    with open(args.output, "wb") as fh:
        pickle.dump(entries, fh)
    print("zeus_crops: %d system(s) -> %s" % (len(entries), args.output), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
