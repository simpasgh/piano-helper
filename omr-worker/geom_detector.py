#!/usr/bin/env python3
"""Trained-detector notehead source for the geometric OMR engine.

geom_omr.py is deliberately torch-free (classical CV only) so it stays light on the CPU worker.
This module is the OPTIONAL upgrade: a YOLOv8 notehead detector (trained on synthetic data, see
train_detector.py) that replaces ONLY geom_omr.detect_noteheads. Everything downstream is reused
unchanged from geom_omr: detect_systems (staff geometry), group_chords, decode_pitch (the EXACT
pitch/octave decode), and the measure distribution. The roadmap's key finding is that the decode
is already exact (0.972 octave on clean) and the DETECTOR is the bottleneck, so we swap exactly
that one part and keep the proven rest.

Guarded import (DETECTOR_AVAILABLE) so a torch-less env degrades cleanly, mirroring geom_omr's
GEOM_AVAILABLE contract. NEVER raises from a public function; returns a safe default instead.
"""
from __future__ import annotations

from typing import List, Optional, Tuple

import geom_omr

DETECTOR_AVAILABLE = False
_IMPORT_ERROR: Optional[str] = None
try:
    from ultralytics import YOLO  # noqa: F401
    import numpy as np
    DETECTOR_AVAILABLE = True
except Exception as exc:  # pragma: no cover - only in a torch-less env
    _IMPORT_ERROR = repr(exc)


class NoteheadDetector:
    """Lazy-loaded YOLO notehead detector. Construct with a weights path; the model loads on the
    first detect() call. detect() returns global notehead centers (x, y, conf) in image pixels."""

    def __init__(self, weights: str, conf: float = 0.25, iou: float = 0.5,
                 imgsz: int = 1280, max_det: int = 2000, device: str = "0"):
        self.weights = weights
        self.conf = conf
        self.iou = iou
        self.imgsz = imgsz
        self.max_det = max_det
        self.device = device
        self._model = None

    def _load(self):
        if self._model is None:
            self._model = YOLO(self.weights)
        return self._model

    def detect(self, image) -> List[Tuple[float, float, float]]:
        """Run the detector on an image (file path, or HxW / HxWx3 uint8 ndarray). Returns a list
        of (x_center, y_center, confidence) in pixel coords. NEVER raises; [] on failure."""
        if not DETECTOR_AVAILABLE:
            return []
        try:
            model = self._load()
            res = model.predict(
                source=image, imgsz=self.imgsz, conf=self.conf, iou=self.iou,
                max_det=self.max_det, device=self.device, verbose=False,
            )
            if not res:
                return []
            r = res[0]
            if r.boxes is None or len(r.boxes) == 0:
                return []
            xywh = r.boxes.xywh.cpu().numpy()      # (n, 4): x_center, y_center, w, h
            confs = r.boxes.conf.cpu().numpy()
            return [(float(x), float(y), float(c)) for (x, y, _w, _h), c in zip(xywh, confs)]
        except Exception:
            return []


def _assign_to_staves(
    centers: List[Tuple[float, float, float]],
    staves: List[List[float]],
    max_interlines: float = 7.0,
) -> List[List[Tuple[float, float]]]:
    """Assign each detected notehead to its nearest staff (by vertical distance to the staff's
    line span), within max_interlines of the staff. Returns per-staff lists of (x, y). A head too
    far from every staff (stray detection) is dropped. NEVER raises."""
    try:
        per_staff: List[List[Tuple[float, float]]] = [[] for _ in staves]
        spans = []
        for lines in staves:
            sl = sorted(float(v) for v in lines)
            sp = geom_omr._interline(sl) or 1.0
            spans.append((sl[0], sl[-1], sp))
        for (x, y, _c) in centers:
            best, best_d = -1, None
            for i, (top, bottom, sp) in enumerate(spans):
                # distance from y to the [top, bottom] interval, in pixels
                if y < top:
                    d = top - y
                elif y > bottom:
                    d = y - bottom
                else:
                    d = 0.0
                if best_d is None or d < best_d:
                    best, best_d = i, d
            if best >= 0:
                top, bottom, sp = spans[best]
                if best_d <= max_interlines * sp:
                    per_staff[best].append((float(x), float(y)))
        return per_staff
    except Exception:
        return [[] for _ in staves]


def transcribe_with_detector(image, detector: NoteheadDetector,
                             key_fifths: int = 0) -> Optional[bytes]:
    """End-to-end transcription using the TRAINED detector for noteheads and geom_omr for staff
    geometry + the exact pitch decode. Mirrors geom_omr.transcribe_geometric but swaps the
    notehead source: the trained YOLO detector + _assign_to_staves replace the classical
    detect_noteheads. Everything downstream (chord grouping, the exact pitch decode, treble/bass
    split, measure distribution, MusicXML) is the SHARED geom_omr._decode_staves_to_musicxml
    tail, so this path cannot drift from the classical baseline it is benchmarked against.
    Returns MusicXML bytes or None. NEVER raises.

    image: a file path (preferred, YOLO reads it directly) or an ndarray.
    key_fifths: key signature passed to decode_pitch so accidentals come from the key (default 0
        = C major). A real deployment detects this from the engraved key signature; the synthetic
        eval can pass the known key to measure the decode ceiling.
    """
    if not (DETECTOR_AVAILABLE and geom_omr.GEOM_AVAILABLE):
        return None
    try:
        gray = geom_omr._to_gray(image)
        if gray is None:
            return None
        staves = geom_omr.detect_systems(gray)
        if not staves:
            return None

        centers = detector.detect(image)
        if not centers:
            return None
        # Trained notehead source: detect globally, then assign each head to its staff so the
        # per-staff lists are index-aligned with staves for the shared decode tail.
        per_staff = _assign_to_staves(centers, staves)
        return geom_omr._decode_staves_to_musicxml(staves, per_staff, key_fifths=key_fifths, gray=gray)
    except Exception:
        return None


def main(argv=None) -> int:
    """CLI entry so the worker can run this engine as a SUBPROCESS in its own torch venv (the same
    pattern Clarity uses), keeping the torch/ultralytics stack out of the worker's venv. Reads a
    raster image and writes MusicXML to --out. Exit 0 = wrote a result; 2 = nothing recognized or
    the detector stack is unavailable (the worker then falls back to the existing engines)."""
    import argparse
    import sys

    ap = argparse.ArgumentParser(
        description="Trained geometric OMR engine (YOLO noteheads + exact pitch decode)")
    ap.add_argument("image", help="raster image path (PNG/JPG); a PDF must be rasterized first")
    ap.add_argument("--weights", required=True, help="trained YOLO notehead weights (.pt)")
    ap.add_argument("-o", "--out", required=True, help="output MusicXML path")
    ap.add_argument("--device", default="cpu", help="'cpu' (the inference box) or '0' for a GPU")
    ap.add_argument("--key-fifths", type=int, default=0,
                    help="key signature for the decode (default 0 = C major). Reading the key FROM "
                         "the image is a separate rung, so non-C keys decode accidentals as natural "
                         "until that lands.")
    args = ap.parse_args(argv)

    if not DETECTOR_AVAILABLE:
        print("geom_detector: detector stack unavailable (%s)" % _IMPORT_ERROR, file=sys.stderr)
        return 2
    detector = NoteheadDetector(args.weights, device=args.device)
    xml = transcribe_with_detector(args.image, detector, key_fifths=args.key_fifths)
    if not xml:
        return 2
    with open(args.out, "wb") as f:
        f.write(xml)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
