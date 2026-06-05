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

    def detect(self, image, imgsz: Optional[int] = None) -> List[Tuple[float, float, float]]:
        """Run the detector on an image (file path, or HxW / HxWx3 uint8 ndarray). Returns a list
        of (x_center, y_center, confidence) in pixel coords. NEVER raises; [] on failure.

        imgsz overrides the instance default for this call (transcribe_with_detector passes an
        image-size-aware value via _auto_imgsz so tall multi-page stitches are not downscaled into
        undetectably-small noteheads)."""
        if not DETECTOR_AVAILABLE:
            return []
        try:
            model = self._load()
            res = model.predict(
                source=image, imgsz=(imgsz or self.imgsz), conf=self.conf, iou=self.iou,
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

    def detect_symbols(self, image, imgsz: Optional[int] = None) -> List[Tuple[int, float, float, float, float, float]]:
        """Run the MULTI-CLASS detector and return every detected glyph as
        (class_idx, x, y, w, h, confidence) with (x, y) the box TOP-LEFT in image pixels (the shape
        geom_omr.decode_symbols_to_musicxml consumes). This is the full-symbol counterpart of
        detect() (which returns notehead centers only). NEVER raises; [] on failure.

        On a single-class (notehead-only) checkpoint this returns just class-0 boxes; on the trained
        full-symbol checkpoint it returns all 18 glyph classes."""
        if not DETECTOR_AVAILABLE:
            return []
        try:
            model = self._load()
            res = model.predict(
                source=image, imgsz=(imgsz or self.imgsz), conf=self.conf, iou=self.iou,
                max_det=self.max_det, device=self.device, verbose=False,
            )
            if not res:
                return []
            r = res[0]
            if r.boxes is None or len(r.boxes) == 0:
                return []
            xywh = r.boxes.xywh.cpu().numpy()   # (n, 4): x_center, y_center, w, h
            clss = r.boxes.cls.cpu().numpy()
            confs = r.boxes.conf.cpu().numpy()
            out = []
            for (xc, yc, w, h), c, cf in zip(xywh, clss, confs):
                out.append((int(c), float(xc - w / 2.0), float(yc - h / 2.0),
                            float(w), float(h), float(cf)))
            return out
        except Exception:
            return []


def _auto_imgsz(shape, base: int = 1280, ref: float = 4096.0, cap: int = 2560) -> int:
    """Pick a YOLO inference size that keeps noteheads detectable on TALL multi-page stitches.

    YOLO resizes the LONGEST image side to imgsz, so notehead pixel size at inference scales with
    imgsz / longest_side. A single ~A4 page rastered at 350 DPI is ~4096 px on its long side, and
    base=1280 (a ~3.2x downscale) detects it well. The worker stitches all PDF pages into one tall
    image, so a 2-page score is ~8192 px tall and base=1280 downscales its noteheads to ~half that
    size, where the detector misses most of them (tctab: 321 heads at 1280 vs 470 at 1920). Scale
    imgsz up in proportion to longest_side / ref so the downscale factor (and thus the inference-time
    notehead size) stays at the single-page value; clamp to [base, cap] so CPU cost stays bounded.
    Returns base on any odd input. NEVER raises."""
    try:
        longest = float(max(shape[0], shape[1]))
        if longest <= ref:
            return base
        imgsz = int(round(base * longest / ref / 32.0)) * 32  # multiple of the YOLO stride
        return max(base, min(cap, imgsz))
    except Exception:
        return base


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
        # DEWARP tilted / perspective-curved staff lines (real phone photos), the camera-OMR lever:
        # detect_systems keys on near-full-width dark rows, which a tilted/curved photographed page
        # smears across rows, so the staff is lost. Straightening the lines recovers detection and the
        # geometry the pitch decode needs.
        #
        # NEVER-WORSE-ON-CLEAN GUARD: keep the dewarp ONLY when it strictly INCREASES the number of
        # detected staves. A clean page's lines are already horizontal, so its staves are fully detected
        # raw and dewarping cannot add any -> we fall back to the ORIGINAL raster and the clean path is
        # byte-identical (detector + staves + barlines all on the untouched image). A warped page's
        # staff count jumps, so the dewarp is kept and the detector, staff geometry, and barlines ALL
        # run on the dewarped image (notehead centres and staff lines share one straightened space).
        staves_raw = geom_omr.detect_systems(gray)
        gray_dw = geom_omr.dewarp_staff_lines(gray)
        use_dw = False
        staves = staves_raw
        # Whether the downstream geometry (these staves, plus barlines + ottavas in the decode tail) is
        # flat-fielded. Default True = today's behavior; the CLEAN path never dewarps, so it keeps True
        # and stays byte-identical. Only the KEPT-dewarp (warped photo) path below may flip it.
        normalize_illum = True
        if gray_dw is not gray:
            staves_dw = geom_omr.detect_systems(gray_dw)
            if len(staves_dw) > len(staves_raw):
                use_dw, staves = True, staves_dw
                # ADAPTIVE ILLUMINATION (warped-photo path only). The flat-field rescues a genuine deep
                # broad shadow but HURTS a photo that is merely uneven (it over-corrects the gradient and
                # amplifies noise in the dense row projection, splitting/merging staves). Keep it only
                # when such a shadow is present, else drop it and re-detect the staves flat-field-free so
                # they share the decode's illumination space. Measured: lifts liminality + tctab, holds
                # reverie (its deep shadow keeps the flat-field). Clean never reaches here.
                normalize_illum = geom_omr._illum_has_deep_shadow(gray_dw)
                if not normalize_illum:
                    staves_ni = geom_omr.detect_systems(gray_dw, normalize_illum=False)
                    # Drop the flat-field only if doing so does not LOSE staves vs the flat-fielded
                    # detection that justified keeping the dewarp (len(staves) == the staves_dw count
                    # here). If illum-off finds fewer (or none), the flat-field was actually helping
                    # detection, so keep it -- the final staves then stay > the raw count (never-worse).
                    if len(staves_ni) >= len(staves):
                        staves = staves_ni
                    else:
                        normalize_illum = True

        # When the dewarp is kept, the detector MUST run on the dewarped raster so its notehead centres
        # share the dewarped staff/barline coordinate space. The dewarped image is handed over in-memory
        # as RGB (no temp PNG). If that conversion fails, ABANDON the dewarp entirely (fall back to the
        # raw staves, the original image, and the default flat-field) rather than mixing a raw-coordinate
        # detection with dewarped staves -- a mismatch would assign heads to the wrong staves. Size the
        # detector to the image it actually runs on (a tall multi-page stitch needs a larger imgsz).
        det_source = image
        if use_dw:
            rgb = geom_omr._gray_to_uint8_rgb(gray_dw)
            if rgb is not None:
                det_source = rgb  # feed the straightened raster to the detector (in-memory, no temp)
            else:
                use_dw, staves, normalize_illum = False, staves_raw, True  # failed -> raw space
        if not staves:
            return None
        work = gray_dw if use_dw else gray
        centers = detector.detect(det_source, imgsz=_auto_imgsz(work.shape))
        if not centers:
            return None
        # Trained notehead source: detect globally, then assign each head to its staff so the
        # per-staff lists are index-aligned with staves for the shared decode tail.
        per_staff = _assign_to_staves(centers, staves)
        return geom_omr._decode_staves_to_musicxml(
            staves, per_staff, key_fifths=key_fifths, gray=work, normalize_illum=normalize_illum)
    except Exception:
        return None


def transcribe_with_symbols(image, detector: NoteheadDetector,
                            key_fifths: Optional[int] = None) -> Optional[bytes]:
    """End-to-end transcription with the trained FULL-SYMBOL detector: staff geometry from geom_omr,
    EVERY glyph (heads/stems/flags/beams/dots/accidentals/clefs/rests/...) from the multi-class
    detector, then geom_omr.decode_symbols_to_musicxml READS durations, key signature, per-note
    accidentals, clefs, and rests from those glyphs ("measure, do not predict"). This is the rung
    past transcribe_with_detector (which reads pitch only and fakes duration:1 + assumes the key).

    image: a file path (preferred) or an ndarray.
    key_fifths: None DETECTS the key from the engraved key signature (the deployed behavior); an int
        pins it (oracle, to measure the decode ceiling on synthetic where the key is known).

    Returns MusicXML bytes or None. NEVER raises."""
    if not (DETECTOR_AVAILABLE and geom_omr.GEOM_AVAILABLE):
        return None
    try:
        gray = geom_omr._to_gray(image)
        if gray is None:
            return None
        staves = geom_omr.detect_systems(gray)
        if not staves:
            return None
        symbols = detector.detect_symbols(image, imgsz=_auto_imgsz(gray.shape))
        if not symbols:
            return None
        return geom_omr.decode_symbols_to_musicxml(staves, symbols, key_fifths=key_fifths, gray=gray)
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
    ap.add_argument("--symbols", action="store_true",
                    help="use the FULL-SYMBOL decode (reads durations/key/accidentals/clefs/rests "
                         "from every glyph) instead of the notehead-only pitch decode")
    ap.add_argument("--key-fifths", type=int, default=None,
                    help="pin the key signature for the decode. Omit it: the notehead-only path "
                         "assumes C major; the --symbols path DETECTS the key from the engraved "
                         "key signature.")
    args = ap.parse_args(argv)

    if not DETECTOR_AVAILABLE:
        print("geom_detector: detector stack unavailable (%s)" % _IMPORT_ERROR, file=sys.stderr)
        return 2
    detector = NoteheadDetector(args.weights, device=args.device)
    if args.symbols:
        xml = transcribe_with_symbols(args.image, detector, key_fifths=args.key_fifths)
    else:
        kf = args.key_fifths if args.key_fifths is not None else 0
        xml = transcribe_with_detector(args.image, detector, key_fifths=kf)
    if not xml:
        return 2
    with open(args.out, "wb") as f:
        f.write(xml)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
