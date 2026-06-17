#!/usr/bin/env python3
"""Geometric pitch OMR engine (rung 1 of building our own OMR engine), CPU-only, no GPU,
no model training.

WHY THIS EXISTS. The LLM-vision transcriber (gemini-2.5-flash) reads note NAMES well
(pitch-class F1 ~0.75) but gets OCTAVES wrong (exact note-F1 ~0.39 global). Octave is not
a guess: music encodes pitch SPATIALLY. A notehead's vertical position relative to the 5
staff lines plus the clef DETERMINISTICALLY fixes step + octave. So once you have the staff
geometry, the notehead centers, and the clef, pitch is a MEASUREMENT, not a prediction.
This module measures it.

WHAT IT DOES (all numpy/scipy/PIL; no torch, no onnx, no API):
  - staff-line + system detection (extends referee._staff_lines to find EVERY 5-line group
    on the page, not just the first),
  - a CLASSICAL notehead detector: remove the staff lines, morphologically close the open
    notehead rings, connected-components, keep blobs whose size/fill match a notehead (in
    the spirit of referee._find_notehead_x but across the whole staff),
  - decode_pitch(notehead_center_y, staff_lines, clef) -> (step, alter, octave) by pure
    line/space counting from the clef reference line,
  - chord grouping (noteheads sharing an x-cluster become one chord) + treble/bass staff
    assignment from system order,
  - transcribe_geometric(...) -> MusicXML bytes via the EXISTING tested builder
    llm_omr.score_json_to_musicxml (1-part / 2-staff grand staff).

ROBUSTNESS CONTRACT (same as reconcile/referee): every public function NEVER raises. Any
failure returns the safe default (None / [] / a decline). Guarded imports: numpy/scipy/PIL
may be absent in a degenerate env; GEOM_AVAILABLE then reports False and callers degrade.

RESEARCH ONLY. This module is NOT wired into worker.process_job (mirrors how reconcile.py
was pure-before-wired). It does not touch prod, env flags, the LLM/ensemble config, or the
live worker.
"""

from __future__ import annotations

import bisect
from typing import List, Optional, Tuple

# --- Guarded imports ---------------------------------------------------------------------
# numpy/scipy/PIL are in requirements.txt, but guard them so a degenerate env still imports
# and exposes GEOM_AVAILABLE=False (tests skip the geometry tier cleanly).
GEOM_AVAILABLE = False
_IMPORT_ERROR: Optional[str] = None

try:
    import numpy as np  # noqa: F401
    from scipy import ndimage  # noqa: F401
    from PIL import Image  # noqa: F401

    GEOM_AVAILABLE = True
except Exception as exc:  # pragma: no cover - exercised only in a numpy/scipy/PIL-less env
    _IMPORT_ERROR = repr(exc)

import llm_omr  # PURE stdlib MusicXML builder; always importable.

# The shared 18-class symbol taxonomy is the SINGLE source of truth (synth_render.CLASS_NAMES, per
# the roadmap), used by the full-symbol decode below to turn the detector's class INDICES into glyph
# roles. synth_render imports verovio under a guard, so this is safe even on a verovio-less box
# (CLASS_NAMES is pure data). Guarded so a degenerate env still imports geom_omr (the pitch-only
# path is unaffected; the full-symbol decode then declines safely on an empty taxonomy).
try:
    from synth_render import CLASS_NAMES  # noqa: E402
except Exception:  # pragma: no cover - synth_render is a committed sibling; this is belt-and-braces
    CLASS_NAMES = []


# --- Pitch geometry (PURE: no numpy needed, runs everywhere) -----------------------------

_STEPS = ("C", "D", "E", "F", "G", "A", "B")
# Diatonic-step index (C=0..B=6) -> semitone within the octave, for sanity only. Not used by
# decode_pitch directly; the decode is a pure diatonic-position count.

# A "staff position" is counted in DIATONIC half-steps (line OR space) measured UP from the
# bottom staff line (position 0 = bottom line). Each adjacent line<->space is +1 position.
# The pitch at each position is fixed once we know what diatonic note the bottom line is.
#
# Clef -> the (step, octave) sitting ON THE BOTTOM staff line (position 0):
#   Treble (G clef, G4 on line 2 = position 2): bottom line (position 0) is E4.
#   Bass   (F clef, F3 on line 4 = position 6): bottom line (position 0) is G2.
#   Alto   (C clef, C4 on the middle line = position 4): bottom line is F3.
# We support treble + bass (the piano grand staff); alto is included for completeness.
_BOTTOM_LINE_NOTE = {
    "G": ("E", 4),   # treble
    "F": ("G", 2),   # bass
    "C": ("F", 3),   # alto (middle-line C4)
}

# Key-signature accidentals by the circle of fifths: sharps add in the order F C G D A E B,
# flats in the reverse order B E A D G C F. A key with `fifths` sharps (>0) or flats (<0)
# sharps/flats exactly the first |fifths| steps of that order. This is the "key prior" the
# decode docstring refers to: staff geometry gives the diatonic STEP, the key gives its ALTER.
_SHARP_ORDER = ("F", "C", "G", "D", "A", "E", "B")
_FLAT_ORDER = ("B", "E", "A", "D", "G", "C", "F")


def keyed_alter(step: str, fifths: int) -> int:
    """The accidental (+1 sharp / -1 flat / 0 natural) that key signature `fifths` applies to a
    diatonic step. PURE. fifths>0 = sharp keys, fifths<0 = flat keys, 0 = C major (all natural)."""
    try:
        f = int(fifths)
        if f > 0 and step in _SHARP_ORDER[:f]:
            return 1
        if f < 0 and step in _FLAT_ORDER[: -f]:
            return -1
        return 0
    except Exception:
        return 0


def _step_octave_to_diatonic_index(step: str, octave: int) -> int:
    """Absolute diatonic index: C0 -> 0, D0 -> 1, ... B0 -> 6, C1 -> 7, ... Monotonic in
    pitch height across octaves. PURE."""
    return 7 * octave + _STEPS.index(step)


def _diatonic_index_to_step_octave(idx: int) -> Tuple[str, int]:
    """Inverse of _step_octave_to_diatonic_index. PURE."""
    octave = idx // 7
    step = _STEPS[idx % 7]
    return step, octave


def decode_pitch(
    notehead_center_y: float,
    staff_lines: List[float],
    clef: str = "G",
    fifths: int = 0,
) -> Optional[Tuple[str, int, int]]:
    """Pure-geometry pitch decode: a notehead's vertical pixel center -> (step, alter, octave).

    Args:
        notehead_center_y: notehead vertical CENTER in pixels (image space, y grows DOWN).
        staff_lines: the 5 staff-line y-centers in pixels, TOP-to-bottom (ascending y). The
            element order is normalized internally, so a bottom-to-top list also works.
        clef: "G" (treble), "F" (bass), or "C" (alto). Defaults to treble.
        fifths: key signature (sharps>0 / flats<0). Staff geometry fixes the diatonic STEP and
            octave; the key fixes the ALTER (e.g. an F on the staff is F# in a 3-sharp key). With
            the default 0 (C major) alter is 0, the original natural-only behavior. This is the
            "key prior" the module was designed to add later; per-note accidentals (which would
            override the key for one note) are still not read by this geometric pass.

    Returns (step, alter, octave) or None on malformed input. NEVER raises.
    """
    try:
        clef = (str(clef) or "G").upper()
        ref = _BOTTOM_LINE_NOTE.get(clef)
        if ref is None:
            ref = _BOTTOM_LINE_NOTE["G"]
        lines = [float(v) for v in staff_lines]
        if len(lines) < 2:
            return None
        # Normalize to ascending y (top line first). The bottom line is the largest y.
        lines = sorted(lines)
        top_y = lines[0]
        bottom_y = lines[-1]
        n_gaps = len(lines) - 1  # 4 for a normal staff
        if bottom_y <= top_y or n_gaps <= 0:
            return None
        interline = (bottom_y - top_y) / n_gaps  # pixels per line-to-line gap
        if interline <= 0:
            return None
        half = interline / 2.0  # pixels per ONE diatonic position (line->space)

        # Position counted UP from the bottom line. y grows DOWN, so a smaller y is a higher
        # position. position 0 == bottom line. A notehead ABOVE the bottom line (smaller y)
        # gives a positive position; below gives negative (ledger lines below the staff).
        position = (bottom_y - notehead_center_y) / half
        # Round to the nearest diatonic position (each integer is a line or a space).
        pos = int(round(position))

        bottom_step, bottom_octave = ref
        base_idx = _step_octave_to_diatonic_index(bottom_step, bottom_octave)
        step, octave = _diatonic_index_to_step_octave(base_idx + pos)
        return step, keyed_alter(step, fifths), octave
    except Exception:
        return None


# --- Staff / system detection (numpy) ----------------------------------------------------

def _to_gray(image_path_or_gray):
    """Accept a file path OR an ndarray, return a float32 grayscale ndarray in [0,1]
    (0=ink, 1=white). Returns None on any failure. NEVER raises."""
    if not GEOM_AVAILABLE:
        return None
    try:
        if isinstance(image_path_or_gray, np.ndarray):
            g = image_path_or_gray.astype(np.float32)
            if g.ndim == 3:
                g = g.mean(axis=2)
            if g.max() > 1.5:  # looks like 0..255
                g = g / 255.0
            return np.clip(g, 0.0, 1.0)
        Image.MAX_IMAGE_PIXELS = 1_000_000_000
        im = Image.open(str(image_path_or_gray)).convert("L")
        return np.asarray(im, dtype=np.float32) / 255.0
    except Exception:
        return None


def _gray_to_uint8_rgb(gray):
    """Convert a float [0,1] grayscale array (0=ink, 1=white) to an HxWx3 uint8 RGB array so a
    DEWARPED image can be handed straight to the YOLO detector in-memory (no temp PNG round-trip).
    The detector replicates a single channel internally, so an R=G=B image is equivalent to the
    original raster. Returns None on any failure so the caller falls back to the original image
    path. NEVER raises."""
    if not GEOM_AVAILABLE or gray is None:
        return None
    try:
        arr = np.asarray(gray, np.float32)
        if arr.ndim != 2:
            return None
        u8 = (np.clip(arr, 0.0, 1.0) * 255.0).astype(np.uint8)
        return np.repeat(u8[:, :, None], 3, axis=2)
    except Exception:
        return None


def _row_ink(gray) -> "np.ndarray":
    """Per-row ink fraction (fraction of dark pixels in each row)."""
    return (gray < 0.5).mean(axis=1)


def _illum_paper_guard(gray, grid: int = 48):
    """Shared paper-brightness estimate behind BOTH illumination decisions. BLOCK-MAX downsample on a
    grid x grid lattice (paper is the bright majority in any block, so the per-cell max ignores the
    darker ink), then a 5-cell MAX-dilate so an isolated fully-inked cell (dense beams / chords)
    borrows its lit neighbours and is not mistaken for shadow. Returns (block, guard) -- both the
    (gh, gw) downsampled fields -- or (None, None) on a degenerate shape so callers no-op. The guard's
    5th-percentile is the EVEN-LIT no-op test (normalize_illumination); its MIN is the DEEP-BROAD-SHADOW
    test (_illum_has_deep_shadow). NEVER raises."""
    if not GEOM_AVAILABLE or gray is None:
        return None, None
    try:
        h, w = gray.shape
        gh = max(1, min(grid, h))
        gw = max(1, min(grid, w))
        bs_y, bs_x = h // gh, w // gw
        if bs_y < 1 or bs_x < 1:
            return None, None
        H2, W2 = gh * bs_y, gw * bs_x
        block = gray[:H2, :W2].reshape(gh, bs_y, gw, bs_x).max(axis=(1, 3))  # per-cell brightest pixel
        guard = ndimage.maximum_filter(block, size=5, mode="nearest")
        return block, guard
    except Exception:
        return None, None


def normalize_illumination(gray, grid: int = 48, floor: float = 0.25, even_thresh: float = 0.7):
    """Flat-field uneven lighting on a PHONE PHOTO of a page so the geometry detectors survive it.

    WHY. detect_systems / detect_barlines / detect_ottavas all key on a fixed `gray < 0.5` ink
    threshold, which assumes the paper is near-white. A photo darkens the "white" unevenly: a cast
    shadow or dim corner can push the LOCAL background below 0.5, where whole rows read as full-width
    ink, the interline estimate is polluted, and the staff/barline geometry collapses. Measured on
    the 4 real pieces, a strength-1.5 shadow roughly HALVES the detected staves (e.g. liminality
    6 -> 3, tctab 22 -> 6), dropping every head whose staff is lost and crashing note_f1 (~0.95 ->
    ~0.69) -- even though the trained NOTEHEAD detector still finds ~all heads (it is tone-robust).
    So the photo cliff is staff geometry, not the detector; this is the lever that fixes it.

    HOW. Estimate the smooth paper-brightness field by BLOCK-MAX downsample (paper is the bright
    majority in any block, so the max ignores the darker ink), upsample (bilinear), and divide it
    out so the background renormalizes to ~1.0 everywhere while ink stays well below 0.5.

    NEVER-WORSE-ON-CLEAN GUARD. If the page is already evenly lit (the 5th-percentile block paper is
    bright, > even_thresh) the input is returned UNCHANGED, so a clean render is a no-op. The
    per-cell paper estimate is max-dilated across the block grid first, so DENSE ink (a page of beams
    / chords) borrows the paper level of its lit neighbours and is NOT mistaken for shadow -- the
    no-op holds on clean DENSE pages, not just bright sparse ones. Only a BROAD shadow, whose
    interior cells are all dark, pushes the 5th percentile below the threshold and triggers the
    flat-field.

    gray is float [0,1] (0=ink, 1=white). Returns the same shape/dtype. NEVER raises; returns the
    input on any failure so a degenerate image cannot break the detectors."""
    if not GEOM_AVAILABLE or gray is None:
        return gray
    try:
        # block = per-cell brightest pixel; guard = its 5-cell max-dilation. Even-lit GUARD (the no-op
        # decision only): dilating means an isolated FULLY inked cell (dense beams/chords with no white)
        # borrows its lit neighbours and is NOT read as shadow -- a CLEAN dense page therefore stays a
        # no-op. A BROAD shadow's interior cells are dark even after dilation (their neighbours are
        # shadowed too), so a real shadow still trips the guard. The CORRECTION below uses the UN-dilated
        # per-cell `block` paper so the flat-field stays accurate (dilating the field under-corrects it).
        block, guard = _illum_paper_guard(gray, grid)
        if block is None:
            return gray
        h, w = gray.shape
        if float(np.percentile(guard, 5)) > even_thresh:
            return gray  # evenly lit -> no-op (clean is unchanged)
        bg = np.asarray(
            Image.fromarray((np.clip(block, 0.0, 1.0) * 255.0).astype(np.uint8)).resize(
                (w, h), Image.BILINEAR), dtype=np.float32) / 255.0
        bg = np.maximum(bg, floor)  # floor avoids a divide blow-up in an all-ink / deep-shadow block
        return np.clip(gray / bg, 0.0, 1.0).astype(np.float32)
    except Exception:
        return gray


# Deep-broad-shadow threshold: guard.min() below this trips the cue. Single-sourced here so the
# clean-raster verdict applies the SAME threshold to its already-computed guard without a second call.
_ILLUM_DEEP_SHADOW_THRESH = 0.25


def _illum_has_deep_shadow(gray, grid: int = 48, thresh: float = _ILLUM_DEEP_SHADOW_THRESH) -> bool:
    """True when the page carries a DEEP, BROAD shadow: a region dark enough that even the 5-cell
    max-dilated paper estimate (see _illum_paper_guard) dips below `thresh`. This is the cue, on the
    DEWARP (warped-photo) path ONLY, to KEEP the flat-field (normalize_illumination): such a shadow
    pushes the local background below the gray<0.5 ink threshold, so renormalising it rescues the
    staff / barline / ottava geometry there.

    The flip side is why the dewarp path needs this at all: a photo that is merely UNEVEN but has no
    deep shadow (every dilated cell stays bright) is HURT by the flat-field -- it over-corrects the
    mild gradient and amplifies noise in the dense row projection, splitting/merging staves. Measured
    on the 4 real phone photos (dewarped): reverie's genuine deep shadow gives guard.min() ~= 0.18 (so
    KEEP, it gains +0.06 note_f1), while every other piece is >= 0.30 (so DROP, lifting liminality
    +0.20 and tctab +0.07); 0.25 sits in that gap with ~0.05-0.07 margin either side. The 5-cell
    dilation makes this a region test, not a single-cell fluke (the dark patch must span a block
    neighbourhood). NEVER raises; returns False (drop) on a degenerate image, where the geom path is
    unreliable regardless and the caller re-checks the staff count before committing."""
    _block, guard = _illum_paper_guard(gray, grid)
    if guard is None:
        return False
    try:
        return bool(float(guard.min()) < float(thresh))
    except Exception:
        return False


# CLEAN-RASTER GATE (P2, OMR_CLEAN_RASTER). A flat, well-lit scan exported as PNG/JPEG should take
# the PDF-quality pipeline (concurrent Clarity on a clean wrap + the zeus referee), but is_pdf_input
# is a pure container check, so today such an image is routed "photo": zeus is gated out and Clarity
# only via the dewarp+flat-field shim. This classifier decides whether a NON-PDF raster is clean
# enough to promote, reusing the SAME classical signals the photo adaptations are built on.
#
# HIGH-PRECISION for the "clean" verdict: a false-clean (a photo misrouted as clean) is the
# dangerous direction because it drops the photo adaptations AND would run zeus on a camera-OOD crop.
# So every condition must hold, and each is the photo-detecting side of an existing decision:
#   (1) staves are detected on the RAW raster (>= _CLEAN_MIN_STAVES). The count is taken with
#       normalize_illum=False, i.e. on the raw raster matching NO flat-field, so a mildly-gradient
#       photo cannot be silently flat-fielded into passing this condition (the dangerous false-clean
#       direction). A clean scan's horizontal lines are fully detected on the raw raster anyway (the
#       flat-field is a guarded no-op on an even page), a blank/garbage image or a badly warped photo
#       finds none, and this is strictly MORE conservative than the default.
#   (2) NO deep broad shadow (guard.min() >= the _illum_has_deep_shadow threshold): the SAME cue the
#       dewarp path uses to KEEP the flat-field. A cast shadow / dim corner trips it -> photo. The
#       guard is the already-computed paper field, so the block-max/maximum_filter runs ONCE here.
#   (3) the dewarp does NOT recover extra staves (dewarp staves <= raw staves, both counted with
#       normalize_illum=False on the raw raster): this is the AUTHORITATIVE never-worse-on-clean guard
#       from transcribe_with_detector. A clean page's lines are already straight so dewarping cannot
#       add staves; a tilted/curved photo's count jumps.
#   (4) enough RESOLUTION for Clarity (estimated interline >= _CLEAN_MIN_INTERLINE, or, when the
#       interline cannot be estimated, raster min-dimension >= _CLEAN_MIN_DIM): a clean-but-tiny
#       screenshot can pass (1)-(3) yet rasterize to a few-pixel interline that degrades Clarity, so a
#       low resolution floor rejects it. Calibrated so every clean calibration raster stays clean:
#       the synthetic clean test page estimates interline 16 and the dense CC0 clean rasters 24-26, so
#       a floor of 10 clears them by >= 6 while rejecting a tiny screenshot (interline ~4-8). See the
#       module test calibration note.
_CLEAN_MIN_STAVES = 1
# Resolution floor for condition (4). 10 keeps the synthetic clean page (interline 16, margin +6) and
# the dense CC0 clean rasters (interline 24-26, margin >= +14) CLEAN while rejecting a few-pixel-
# interline screenshot. Conservative-low on purpose: a real 300-DPI scan has interline ~20-30, so
# production clean scans clear it comfortably. The remaining gap between 10 and 16 is a residual to
# re-verify at the box-enable gate on the real clean-4 + val rasters.
_CLEAN_MIN_INTERLINE = 10.0
# Fallback floor used ONLY when the interline cannot be estimated (estimator returned None): the raw
# raster's min dimension. The clean calibration rasters have min-dim 520 (synthetic) to 2975 (dense),
# so 400 only rejects a pathologically tiny raster and never the clean set.
_CLEAN_MIN_DIM = 400


def clean_raster_verdict(image_path_or_gray) -> dict:
    """Classify a raster as clean (a flat well-lit scan) vs photo, with the per-signal margins so a
    caller (and the calibration test) can inspect WHY. Returns a dict:
        {"clean": bool, "raw_staves": int, "dewarp_staves": int, "guard_min": float,
         "deep_shadow": bool, "interline": Optional[float], "min_dim": int, "available": bool}
    "clean" is True ONLY when ALL high-precision conditions hold (see the module note above). On any
    failure / unavailable geom stack it returns clean=False (decline = stay on today's photo path).
    NEVER raises."""
    out = {"clean": False, "raw_staves": 0, "dewarp_staves": 0, "guard_min": 0.0,
           "deep_shadow": True, "interline": None, "min_dim": 0, "available": GEOM_AVAILABLE}
    if not GEOM_AVAILABLE:
        return out
    try:
        gray = _to_gray(image_path_or_gray)
        if gray is None or gray.ndim != 2 or gray.size == 0:
            return out
        out["min_dim"] = int(min(gray.shape))
        # (1) raw staves, counted on the TRULY raw raster (normalize_illum=False, matching no
        # flat-field) so a mildly-gradient photo cannot be flat-fielded into passing condition (1).
        staves_raw = detect_systems(gray, normalize_illum=False)
        out["raw_staves"] = len(staves_raw)
        # (2) deep broad shadow cue, derived from the SINGLE paper-field computed here (block-max +
        # maximum_filter runs once): guard.min() < the _illum_has_deep_shadow threshold is the cue.
        _block, guard = _illum_paper_guard(gray)
        if guard is not None:
            try:
                out["guard_min"] = float(guard.min())
                out["deep_shadow"] = bool(out["guard_min"] < _ILLUM_DEEP_SHADOW_THRESH)
            except Exception:
                out["guard_min"] = 0.0
                out["deep_shadow"] = True
        else:
            # degenerate paper field: match _illum_has_deep_shadow, which returns False here.
            out["deep_shadow"] = False
        # (3) does the dewarp recover extra staves? (it adds none on an already-straight page). Both
        # counts are on the raw raster (normalize_illum=False) so the comparison is like-for-like.
        gray_dw = dewarp_staff_lines(gray)
        staves_dw = staves_raw if gray_dw is gray else detect_systems(gray_dw, normalize_illum=False)
        out["dewarp_staves"] = len(staves_dw)
        # (4) resolution floor: estimated interline >= _CLEAN_MIN_INTERLINE, or, when the interline
        # cannot be estimated, min-dimension >= _CLEAN_MIN_DIM. Keeps Clarity off few-pixel rasters.
        interline = _estimate_interline_from_profile(_row_ink(gray))
        out["interline"] = interline
        if interline is not None:
            resolution_ok = float(interline) >= _CLEAN_MIN_INTERLINE
        else:
            resolution_ok = out["min_dim"] >= _CLEAN_MIN_DIM
        out["clean"] = bool(
            out["raw_staves"] >= _CLEAN_MIN_STAVES
            and not out["deep_shadow"]
            and out["dewarp_staves"] <= out["raw_staves"]
            and resolution_ok
        )
        return out
    except Exception:
        out["clean"] = False
        return out


def _estimate_interline_from_profile(prof1d) -> Optional[float]:
    """Estimate the staff interline (pixels per line-to-line gap) from a 1-D row-darkness profile by
    autocorrelation: the smallest PROMINENT period in roughly [4, len/8] pixels. Staff lines repeat
    at the interline, so the profile's autocorrelation has its first strong peak at that lag. Returns
    a float interline, or None when the profile carries no periodic line structure (blank page /
    failure). Used only to SCALE the dewarp's window and search sizes, so an approximate value is
    fine. NEVER raises."""
    try:
        p = np.asarray(prof1d, np.float32).ravel()
        n = int(p.shape[0])
        if n < 32:
            return None
        p = p - float(p.mean())
        denom = float(np.dot(p, p))
        if not np.isfinite(denom) or denom <= 1e-6:  # blank or NaN-polluted profile -> no estimate
            return None
        lo = 4
        hi = max(lo + 3, min(n // 8, 80))
        ac = np.empty(hi - lo, np.float32)
        for i, lag in enumerate(range(lo, hi)):
            ac[i] = float(np.dot(p[:n - lag], p[lag:])) / denom
        gmax = float(ac.max())
        if gmax <= 0.05:
            return None
        # The first prominent local maximum is the interline (a later, taller peak is a multiple of
        # it or the inter-staff period; we want the fundamental line spacing).
        for i in range(1, ac.shape[0] - 1):
            if ac[i] >= ac[i - 1] and ac[i] > ac[i + 1] and ac[i] >= 0.5 * gmax:
                return float(lo + i)
        return float(lo + int(np.argmax(ac)))
    except Exception:
        return None


def dewarp_staff_lines(gray, nstrips: int = 64, min_shift_px: float = 2.0):
    """Straighten tilted / perspective-curved staff lines on a PHONE PHOTO of a page so the
    row-projection staff detector (detect_systems), the barline detector, and the line/space pitch
    decode all get clean, horizontal geometry. This is THE camera-OMR lever: the trained notehead
    detector already finds the heads on a photo, but detect_systems keys on near-full-width dark ROWS
    and a photographed page's staff lines are tilted AND curved by perspective, so each line smears
    across many rows and the staff is lost (measured: tctab 2 of 22 staves, icarus 4 of 6).
    Straightening the lines recovers detection AND the geometry the pitch decode needs.

    COARSE-TO-FINE 2D DISPLACEMENT FIELD. The page is cut into `nstrips` vertical strips and each
    strip's row-darkness profile is built.

      COARSE (robust global, the validated column-uniform dewarp): cross-correlate each strip's WHOLE
      profile against the centre strip's to find the single best vertical shift that aligns ALL of its
      staves at once. Using the whole profile (every staff + the title/margins) makes the match unique
      and immune to the staff's line-to-line periodicity, so it absorbs the large rotation/perspective
      tilt cheaply and reliably. This alone recovers a rotated page (e.g. icarus).

      FINE (per-band residual, the per-line upgrade): a single per-column shift cannot straighten a
      page where the top staff and the bottom staff slope DIFFERENTLY (perspective gives each line its
      own slope), which leaves residual error that stalls the pitch decode. So, on top of the coarse
      alignment, re-correlate each strip against the centre in horizontal BANDS (~one staff tall),
      searching only a SMALL range around the coarse shift. The small bounded search keeps the match
      unambiguous (no locking onto the wrong staff) while letting each band drift independently, which
      gives every staff its own correction. A band with no staff-line ink gets ~0 residual (it falls
      back to the coarse shift), and the residual is confidence-weighted and smoothed.

    The coarse shift plus the smoothed per-band residual is densified to a full (h, w) vertical
    displacement field and the image is remapped so every staff line becomes horizontal.

    NEVER-WORSE-ON-CLEAN. Two layers. (1) A SPARSE flat page produces a ~0 field, so when the field's
    peak magnitude is below `min_shift_px` the INPUT OBJECT is returned UNCHANGED (identity). (2) A
    DENSE flat page is trickier: its per-column content (noteheads, stems, beams) can nudge the
    correlation off 0 and yield a spurious field even though the lines are already horizontal, so a
    field-magnitude no-op alone is not enough. The AUTHORITATIVE clean guard therefore lives in the
    CALLER (geom_detector.transcribe_with_detector): it keeps the dewarp ONLY when it strictly
    INCREASES the number of detected staves. A clean page's staves are already fully detected, so
    dewarping cannot increase them and the caller falls back to the original raster (byte-identical);
    a warped page's staff count jumps, so the dewarp is kept. This needs no content/line tuning and
    works on faint photo lines because both the raw and dewarped images go through the same detector.

    gray is float [0,1] (0=ink, 1=white). Returns the same shape/dtype dewarped, or the input object
    unchanged on a no-op / any failure (so a degenerate image can never break the engine). NEVER
    raises."""
    if not GEOM_AVAILABLE or gray is None:
        return gray
    try:
        g = np.asarray(gray, np.float32)
        if g.ndim != 2:
            return gray
        h, w = g.shape
        if h < 64 or w < 64 or nstrips < 5:
            return gray
        try:
            swv = np.lib.stride_tricks.sliding_window_view
        except AttributeError:  # pragma: no cover - very old numpy
            return gray
        eps = 1e-6

        dark = (g < 0.5).astype(np.float32)
        edges = np.linspace(0, w, nstrips + 1).astype(int)
        prof = np.zeros((nstrips, h), np.float32)
        for s in range(nstrips):
            x0, x1 = int(edges[s]), int(edges[s + 1])
            if x1 > x0:
                prof[s] = dark[:, x0:x1].mean(axis=1)
        prof = ndimage.gaussian_filter1d(prof, 1.0, axis=1)
        prof -= prof.mean(axis=1, keepdims=True)  # de-mean each strip for correlation

        il = _estimate_interline_from_profile((dark.mean(axis=1)))
        if il is None or il < 3.0 or il > h / 4.0:
            return gray

        # Per-strip energy (norm of the de-meaned profile). A margin strip with no staff lines has
        # ~0 energy and carries NO alignment signal, so it must NOT be searched: its argmax would be
        # garbage. A skipped strip keeps a 0 shift, and on a CLEAN page every inked strip aligns at
        # shift 0 too, so the field is 0 everywhere and the page is a byte-identical no-op (a real page
        # has side margins, so this blank-strip skip is what makes the clean no-op hold there).
        strip_e = np.sqrt((prof * prof).sum(axis=1))
        emax = float(strip_e.max()) if strip_e.size else 0.0
        if emax <= eps:
            return gray
        strip_thresh = 0.1 * emax
        c = nstrips // 2
        if strip_e[c] < strip_thresh:           # centre strip is blank (rare) -> use the inkiest strip
            c = int(np.argmax(strip_e))
        ref = prof[c]

        # COARSE: per-strip whole-profile shift to the centre strip (the validated column-uniform base).
        # The whole profile (all staves + margins) makes the peak unique despite line periodicity.
        maxshift = int(min(max(90, round(10.0 * il)), 0.15 * h))
        offs = np.zeros(nstrips, np.float32)
        for s in range(nstrips):
            if strip_e[s] < strip_thresh:
                continue  # blank margin strip -> 0 shift
            ps = prof[s]
            best, bd = -1e18, 0
            for d in range(-maxshift, maxshift + 1, 2):
                cval = float(np.dot(np.roll(ps, d), ref))
                if cval > best:
                    best, bd = cval, d
            offs[s] = bd
        offs = ndimage.gaussian_filter1d(offs, 2.0)

        # FINE: residual per (strip, band), searched in a SMALL range around the coarse shift. Pre-roll
        # each strip by its (integer) coarse shift so the residual search is centred on 0 for all strips.
        offs_r = np.round(offs).astype(int)
        prof_base = np.stack([np.roll(prof[s], int(offs_r[s])) for s in range(nstrips)])
        bh = max(4, int(round(4.0 * il)))      # band half-height ~ one staff
        rng = max(2, int(round(2.5 * il)))     # residual search range (well under one inter-staff gap)
        bstep = max(2, int(round(3.0 * il)))   # band-centre spacing
        b_lo, b_hi = bh + rng, h - bh - rng
        if b_hi - b_lo >= 2 * bstep:
            bands = np.arange(b_lo, b_hi, bstep)
            nb = int(bands.shape[0])
            resid = np.zeros((nstrips, nb), np.float32)
            wt = np.zeros((nstrips, nb), np.float32)
            bw = 2 * bh
            # A band with no staff-line ink in the centre strip carries no alignment signal; its NCC is
            # flat and argmax would return a biased garbage residual. Skip such GAP bands (leave their
            # residual + weight 0) so they fall back to the robust coarse shift. The threshold is
            # relative to the inkiest band, so a blank inter-staff gap is excluded but every real staff
            # band is kept. This is also what keeps a CLEAN page (pure lines + wide gaps) a no-op.
            band_norms = np.array([float(np.sqrt(np.dot(ref[int(yb) - bh:int(yb) + bh],
                                                        ref[int(yb) - bh:int(yb) + bh]))) for yb in bands])
            gap_thresh = 0.3 * float(band_norms.max()) if band_norms.size else 0.0
            for bi in range(nb):
                yb = int(bands[bi])
                rb_norm = band_norms[bi] + eps
                if band_norms[bi] < gap_thresh:
                    continue  # blank gap band -> no residual (use the coarse shift here)
                ref_band = ref[yb - bh:yb + bh]
                seg = prof_base[:, yb - bh - rng:yb + bh + rng]     # (nstrips, bw + 2*rng)
                if seg.shape[1] < bw:
                    continue
                sw = swv(seg, bw, axis=1)                           # (nstrips, 2*rng+1, bw)
                num = np.einsum("srw,w->sr", sw, ref_band)
                sw_norm = np.sqrt(np.einsum("srw,srw->sr", sw, sw)) + eps
                ncc = num / (sw_norm * rb_norm)
                t_best = np.argmax(ncc, axis=1)
                # window index t maps to residual roll r = rng - t (t = rng is the no-shift centre).
                resid[:, bi] = (rng - t_best).astype(np.float32)
                wt[:, bi] = np.clip(ncc[np.arange(nstrips), t_best], 0.0, 1.0) * rb_norm
            # Confidence-weighted smoothing: an evidence-free band gets ~0 residual (-> falls back to
            # the robust coarse shift); a noisy band is relaxed toward its neighbours.
            r_s = ndimage.gaussian_filter(resid * wt, (1.5, 1.0)) / (
                ndimage.gaussian_filter(wt, (1.5, 1.0)) + eps)
        else:
            bands = np.array([h // 2], np.float32)
            r_s = np.zeros((nstrips, 1), np.float32)

        field_grid = offs[:, None] + r_s                            # (nstrips, nbands), roll amounts
        if float(np.max(np.abs(field_grid))) < float(min_shift_px):
            return gray  # already-flat page -> identity (the clean path stays byte-identical)

        # Densify the (nstrips, nbands) field to (h, w) using the TRUE strip/band positions: np.interp
        # maps each output row to a fractional BAND index and each output column to a fractional STRIP
        # index, then one bilinear sample of field_grid (whose axes are [strip, band]).
        strip_cx = ((edges[:-1] + edges[1:]) / 2.0).astype(np.float32)
        band_idx = np.interp(np.arange(h), bands.astype(np.float32),
                             np.arange(field_grid.shape[1], dtype=np.float32)).astype(np.float32)
        strip_idx = np.interp(np.arange(w), strip_cx,
                              np.arange(nstrips, dtype=np.float32)).astype(np.float32)
        bi_grid, si_grid = np.meshgrid(band_idx, strip_idx, indexing="ij")  # both (h, w)
        field_dense = ndimage.map_coordinates(field_grid, [si_grid, bi_grid], order=1, mode="nearest")

        # Remap (roll convention, matching the coarse correlation): output row y samples input row
        # y - field, so each line lands at its centre-column height. Rolled-in margin is white (paper).
        yy = np.arange(h, dtype=np.float32)
        xx = np.arange(w, dtype=np.float32)
        out_y, out_x = np.meshgrid(yy, xx, indexing="ij")
        in_y = (out_y - field_dense).astype(np.float32)
        out = ndimage.map_coordinates(g, [in_y, out_x], order=1, mode="constant", cval=1.0)
        return np.clip(out, 0.0, 1.0).astype(np.float32)
    except Exception:
        return gray


def _extract_staves(centers: List[float], inks: List[float], thick: List[float],
                    interline: float) -> List[List[float]]:
    """Turn the ordered staff-line-candidate centers into clean 5-line staves.

    Each candidate carries its peak ink fraction (`inks`) and its cluster thickness in rows
    (`thick`). The page is first cut into REGIONS at any gap much larger than the interline (the
    inter-staff / inter-system blank), exactly as the original grouping did, so a staff boundary
    stays intact and a 5-line window can never straddle two staves. Then per region:

      - 5 lines  -> a clean staff, kept as detected (even if one gap is a little irregular; this is
        the common case and the original code kept it unconditionally, so we do too).
      - a multiple of 5 EVENLY spaced -> k staves merged by a small inter-staff gap, split
        positionally into k blocks of 5 (NOT by a scored window, which could straddle the seam).
      - anything else (6, 7, ... lines) -> a staff (or staves) PLUS intruder rows. Real engravings
        interleave near-full-width INTRUDER rows among the 5 staff lines: a beam joining a run of
        eighth notes, a dense ledger/notehead row, or tempo/expression text can each clear the
        width threshold and inflate a staff to 6-7 detected lines (icarus: a 7-line group; reverie:
        6-line groups). The original "keep only multiples of 5" rule then dropped the whole staff.
        pick_windows recovers it by selecting evenly-spaced 5-line windows and, among overlapping
        ones, preferring the THINNEST lines: a staff line is a thin full-width rule, while a beam /
        text band / dense note row is thicker. Thinness (not ink) is the primary signal because a
        chord crossing a staff line can drop that real line's ink BELOW a full-width intruder
        beam's, so an ink-only rule would swap in the intruder; ink and spacing break remaining ties.

    NEVER raises (callers wrap in try). One residual limitation: if a page's near-full-width dark
    rows are DOMINATED by evenly-spaced intruders rather than staff lines (e.g. a wall of full-width
    text bands), the median-gap interline is mis-estimated and the real staff can be missed. Real
    piano sheet music is staff-line dominated, so this does not arise in the target domain, and geom
    is a last-resort fallback regardless."""
    n = len(centers)
    out: List[List[float]] = []
    if n < 5 or interline <= 0:
        return out
    tol = 0.35 * interline  # a gap within +/-35% of the interline counts as one staff step

    def pick_windows(idx: List[int]) -> List[List[float]]:
        m = len(idx)
        cands = []  # (start, max_thickness, -mean_ink, spacing_dev) for each UNIFORM 5-window
        for s in range(m - 4):
            gaps = [centers[idx[s + t + 1]] - centers[idx[s + t]] for t in range(4)]
            dev = max(abs(g - interline) for g in gaps)
            if dev > tol:
                continue  # only evenly-spaced runs can be a staff
            mx_thick = max(thick[idx[s + t]] for t in range(5))
            mean_ink = sum(inks[idx[s + t]] for t in range(5)) / 5.0
            cands.append((s, mx_thick, -mean_ink, dev))
        cands.sort(key=lambda c: (c[1], c[2], c[3]))  # thinnest, then inkiest, then most uniform
        used = [False] * m
        picked = []
        for (s, _mt, _mi, _d) in cands:
            if any(used[s : s + 5]):
                continue
            for t in range(s, s + 5):
                used[t] = True
            picked.append([float(centers[idx[s + t]]) for t in range(5)])
        return picked

    # Cut into regions at a gap much larger than the interline (the inter-staff blank). 2.5x mirrors
    # the original break threshold, so staff boundaries are grouped exactly as before.
    break_gap = 2.5 * interline
    regions: List[List[int]] = []
    region = [0]
    for i in range(1, n):
        if centers[i] - centers[i - 1] > break_gap:
            regions.append(region)
            region = [i]
        else:
            region.append(i)
    regions.append(region)

    for reg in regions:
        m = len(reg)
        if m < 5:
            continue  # too few lines to be a staff
        if m == 5:
            out.append([float(centers[j]) for j in reg])
            continue
        gaps = [centers[reg[t + 1]] - centers[reg[t]] for t in range(m - 1)]
        if m % 5 == 0 and all(abs(g - interline) <= tol for g in gaps):
            for k in range(0, m, 5):  # merged staves, evenly spaced -> split positionally
                out.append([float(centers[reg[k + t]]) for t in range(5)])
            continue
        out.extend(pick_windows(reg))  # staff(s) + intruder rows -> recover the real staff lines

    out.sort(key=lambda s: s[0])
    return out


def detect_systems(gray, normalize_illum: bool = True) -> List[List[float]]:
    """Detect EVERY 5-line staff group on the page. Returns a list of staves, each a list of
    5 staff-line y-centers (top-to-bottom). NEVER raises; returns [] on failure.

    Method: a staff line is a near-full-width dark row. Cluster contiguous dark rows into line
    centers (a thick line spans a few rows) and record each cluster's peak ink fraction, then hand
    the centers to _extract_staves, which pulls out runs of 5 evenly-spaced lines (rejecting
    intruder rows like beams / dense note rows / text that also clear the width threshold). This
    extends referee._staff_lines (which returns only the first 5) to the whole page and is robust
    to real engravings where a staff is detected as 6-7 lines.

    normalize_illum (default True) applies the flat-field first (a no-op on a clean page). The
    dewarp/warped-photo path sets it False when the page has no deep shadow, where flat-fielding an
    only-uneven page over-corrects and splits/merges staves (see _illum_has_deep_shadow).
    """
    if not GEOM_AVAILABLE or gray is None:
        return []
    try:
        if normalize_illum:
            gray = normalize_illumination(gray)  # flat-field photo shadows (no-op on clean)
        h, w = gray.shape
        roww = (gray < 0.5).sum(axis=1)
        # A staff line is a near-full-width dark row, but noteheads/stems sitting ON the line
        # interrupt it, so a strict 0.5*w threshold misses lines in dense music. Use a softer
        # 0.35*w fraction: a true staff line still clears it (noteheads cover only a small
        # fraction of the width), while sparse rows do not. _extract_staves below rejects the
        # near-full-width NON-staff rows (beams, dense note/ledger rows) that also clear it.
        th = 0.35 * w
        rows = [i for i, v in enumerate(roww) if v > th]
        if not rows:
            return []
        # Cluster contiguous dark rows into line centers; record each line's peak ink fraction
        # (its darkest row's width coverage) and its thickness in rows so _extract_staves can tell a
        # thin full-width staff line from a thicker partial intruder row (beam / dense note / text).
        centers: List[float] = []
        inks: List[float] = []
        thick: List[float] = []
        cur = [rows[0]]

        def _flush(c):
            centers.append(sum(c) / len(c))
            inks.append(max(float(roww[r]) for r in c) / w)
            thick.append(float(c[-1] - c[0] + 1))

        for r in rows[1:]:
            if r - cur[-1] <= 3:
                cur.append(r)
            else:
                _flush(cur)
                cur = [r]
        _flush(cur)
        if len(centers) < 5:
            return []

        # Typical interline = median of the small gaps between consecutive line centers (most gaps
        # are intra-staff at the interline; inter-staff and intruder gaps are the minority).
        gaps = sorted(centers[i + 1] - centers[i] for i in range(len(centers) - 1))
        med_gap = gaps[len(gaps) // 2]
        if med_gap <= 0:
            return []
        return _extract_staves(centers, inks, thick, med_gap)
    except Exception:
        return []


def _interline(staff_lines: List[float]) -> Optional[float]:
    try:
        lines = sorted(float(v) for v in staff_lines)
        if len(lines) < 2:
            return None
        sp = (lines[-1] - lines[0]) / (len(lines) - 1)
        return sp if sp > 0 else None
    except Exception:
        return None


_PAIR_MAX_IL = 16.0  # max treble->bass CENTER spacing, in interlines, inside one grand staff.


def _pair_staves(staves: List[List[float]]) -> List[Tuple[Optional[int], Optional[int]]]:
    """Group detected staves into grand-staff (treble_idx, bass_idx) pairs by VERTICAL GAP rather
    than index parity. Returns pairs top-to-bottom; bass_idx is None for a LONE staff whose partner
    went undetected (it is decoded as treble, the page-top role).

    WHY. The old rule (treble = 2i, bass = 2i+1) silently MISPAIRS as soon as detection drops one
    staff in the middle of the page: every staff below the gap flips clef, so a whole bass staff is
    read in treble (an octave off AND in the wrong hand) and note_f1 collapses for the rest of the
    piece. On a real photo a staff is often lost (perspective / low contrast), so this is the
    dominant photo-decode error once the dewarp has recovered most staves. Pairing by the actual
    inter-staff gap is immune: a treble and its bass sit ~10 interlines apart centre-to-centre,
    while the gap to the NEXT system is ~2-4x larger (measured on the eval pieces: intra 9.8-11.6
    il, inter 25.8 il and up), so a small gap joins a pair and a large gap starts a new system.

    On a CLEANLY detected page every staff is present and the gaps alternate small / large, so this
    returns exactly [(0,1),(2,3),...] -- identical to the old parity pairing, leaving the clean path
    byte-identical; it only diverges when a staff is missing (the photo case). NEVER raises; falls
    back to the legacy consecutive pairing on any failure."""
    n = len(staves)
    try:
        if n == 0:
            return []
        centers = [sum(float(v) for v in s) / len(s) for s in staves]
        ils = sorted(v for v in (_interline(s) or 0.0 for s in staves) if v > 0)
        il = ils[len(ils) // 2] if ils else 1.0   # median interline (a robust gap scale)
        thr = _PAIR_MAX_IL * il
        pairs: List[Tuple[Optional[int], Optional[int]]] = []
        i = 0
        while i < n:
            if i + 1 < n and (centers[i + 1] - centers[i]) <= thr:
                pairs.append((i, i + 1))   # small gap -> treble (top) + its bass (bottom)
                i += 2
            else:
                pairs.append((i, None))    # large gap on both sides -> lone staff (treble role)
                i += 1
        return pairs
    except Exception:
        return [(2 * p, 2 * p + 1 if 2 * p + 1 < n else None) for p in range((n + 1) // 2)]


# --- Classical notehead detection (numpy + scipy) ----------------------------------------

def detect_noteheads(gray, staff_lines: List[float]) -> List[Tuple[float, float]]:
    """Detect notehead CENTERS within one staff's vertical neighborhood. Returns a list of
    (x_center, y_center) in pixels. NEVER raises; returns [] on failure.

    Classical pipeline (no training):
      1. Crop a band around the staff (+/- a few interlines for ledger notes).
      2. Binarize, REMOVE the staff lines (zero out near-full-width rows), then morphological
         CLOSE vertically so an open notehead ring split by a removed line rejoins (the
         referee._find_notehead_x trick), and close horizontally a touch to solidify the head.
      3. Connected components; keep blobs whose width/height/fill match a notehead scaled by
         the interline. A stem is tall+thin (rejected); a beam is wide+thin (rejected); the
         clef/meter glyphs at the far left are excluded by an x cutoff.
      4. The blob centroid is the notehead center.
    """
    if not GEOM_AVAILABLE or gray is None:
        return []
    try:
        sp = _interline(staff_lines)
        if sp is None:
            return []
        lines = sorted(float(v) for v in staff_lines)
        top, bottom = lines[0], lines[-1]
        h, w = gray.shape

        # Vertical band: the staff plus room for ledger-line notes above/below.
        y0 = max(0, int(round(top - 6 * sp)))
        y1 = min(h, int(round(bottom + 6 * sp)))
        if y1 - y0 < 3:
            return []
        band = gray[y0:y1, :]

        mask = band < 0.5
        # Remove staff lines: any row that is mostly ink across the width.
        roww = mask.sum(axis=1)
        line_rows = roww > 0.5 * w
        mask = mask.copy()
        mask[line_rows, :] = False

        # Close vertically to rejoin a notehead ring split by a removed (thin) staff line, but
        # keep the kernel SMALL: a large vertical close fuses two vertically-stacked chord
        # noteheads into one blob (the chord-recall killer). A removed line is only a few px,
        # so ~0.3 interline is enough to bridge it without bridging a whole notehead. Then a
        # light horizontal close solidifies the head. Kernel sizes scale with the interline.
        vclose = max(2, int(round(sp * 0.3)))
        hclose = max(1, int(round(sp * 0.25)))
        mask = ndimage.binary_closing(mask, structure=np.ones((vclose, 1)))
        mask = ndimage.binary_closing(mask, structure=np.ones((1, hclose)))

        # Exclude the clef / key / meter zone at the far left (it holds notehead-sized blobs).
        x_cut = int(round(min(w * 0.18, 3.0 * sp)))
        mask[:, :x_cut] = False

        lbl, n = ndimage.label(mask)
        if n == 0:
            return []

        heads: List[Tuple[float, float]] = []
        # Notehead geometry, in interlines. A head is ~1.2-1.5 interline wide and ~1 tall.
        wmin, wmax = 0.55 * sp, 2.6 * sp
        hmin = 0.45 * sp
        # A SINGLE notehead is at most ~1.4 interline tall. A taller-but-head-wide blob is a
        # vertically-stacked CHORD whose heads fused; split it into per-head bands rather than
        # dropping it (this is what recovers chord noteheads).
        single_hmax = 1.6 * sp
        objs = ndimage.find_objects(lbl)
        for i, sl in enumerate(objs, start=1):
            if sl is None:
                continue
            sub = lbl[sl] == i
            ys, xs = np.where(sub)
            if ys.size == 0:
                continue
            ww = xs.max() - xs.min() + 1
            hh = ys.max() - ys.min() + 1
            if not (wmin < ww < wmax) or hh < hmin:
                continue
            area = ys.size
            aspect = ww / float(hh)
            cx_full = xs.mean() + sl[1].start
            y_off = sl[0].start + y0

            if hh <= single_hmax:
                # one notehead: require a solid, roughly-round blob.
                fill = area / float(ww * hh)
                if fill < 0.45:
                    continue
                if aspect < 0.45 or aspect > 3.0:
                    continue
                cy = ys.mean() + y_off
                heads.append((float(cx_full), float(cy)))
            else:
                # a tall column: split into ~interline-tall bands and emit one head per band
                # that is filled enough to be a notehead. Row-projection within the blob; each
                # contiguous run of dense rows is a head.
                rowfill = sub.sum(axis=1)  # ink per row inside the blob bbox
                dense = rowfill > 0.45 * ww  # a row crossing a notehead is mostly ink
                # group contiguous dense rows
                runs = []
                r = 0
                H = sub.shape[0]
                while r < H:
                    if dense[r]:
                        s2 = r
                        while r < H and dense[r]:
                            r += 1
                        runs.append((s2, r - 1))
                    else:
                        r += 1
                for (ra, rb) in runs:
                    band_h = rb - ra + 1
                    if band_h < 0.45 * sp:
                        continue  # too thin to be a head (stem fragment between heads)
                    cy = (ra + rb) / 2.0 + sl[0].start + y0
                    heads.append((float(cx_full), float(cy)))
        heads.sort(key=lambda c: c[0])
        return heads
    except Exception:
        return []


# --- Chord grouping ----------------------------------------------------------------------

def group_chords(
    noteheads: List[Tuple[float, float]],
    interline: float,
) -> List[List[Tuple[float, float]]]:
    """Group noteheads that share an x-cluster into one chord (a chord stacks noteheads at the
    same horizontal position). Returns a list of chords, each a list of (x, y), x-ordered.
    NEVER raises; returns [] on failure.

    Two heads belong to the same chord if their x centers are within ~1.2 interlines (a
    second-interval chord offsets the head by one notehead width, so the tolerance must cover
    that). Heads farther apart are separate onsets.
    """
    try:
        if not noteheads:
            return []
        sp = float(interline)
        if sp <= 0:
            return []
        tol = 1.2 * sp
        ordered = sorted(noteheads, key=lambda c: c[0])
        chords: List[List[Tuple[float, float]]] = []
        cur = [ordered[0]]
        cur_x = ordered[0][0]
        for head in ordered[1:]:
            if head[0] - cur_x <= tol:
                cur.append(head)
                # track the cluster by its first x so a wide chord does not chain-drift.
            else:
                chords.append(sorted(cur, key=lambda c: c[1]))
                cur = [head]
                cur_x = head[0]
        chords.append(sorted(cur, key=lambda c: c[1]))
        return chords
    except Exception:
        return []


# --- Barline detection (numpy) -----------------------------------------------------------
#
# OVER-SEGMENTATION on DENSE pieces (measured: dense-score-decode-measure-segmentation). The
# full-pair-height coverage test (cov > 0.7) is fooled by a DENSE STACK of chords+stems: treble
# notes + bass notes together clear 70% of the pair height WITHOUT crossing the blank INTER-STAFF
# GAP that a real barline crosses, so the stack reads as a false barline and the engine splits the
# measure there (furelise 118 measures vs truth 106, nocturne 88 vs 38). Every note then lands in
# the wrong measure and note_f1 collapses though the pitch reading underneath is good.
#
# The discriminator is the CENTRE OF THE GAP: a real barline is dark across the blank band between
# the treble bottom line and the bass top line; a chord/stem stack is blank there (stems live inside
# one staff). But that signal alone is NOT strict-never-worse: one real tctab barline has a near-blank
# gap centre (pedal/lyric clutter), so dropping every non-gap-crossing candidate costs tctab ~1 note
# (0.995 -> 0.992). The fix (this code) makes the removal CONDITIONAL ON OVER-SEGMENTATION: a non-gap-
# crossing candidate is dropped ONLY when it is an EXTRA barline -- anomalously close to a kept
# neighbour, i.e. it would carve a measure narrower than _BAR_NARROW_FRAC x the system's median
# measure width. A uniformly-segmented system (tctab, every simple piece) has no anomalously-narrow
# measure, so NOTHING is dropped and the output is byte-identical (the strict never-worse guarantee is
# structural, not tuned). The gap-darkness signal still decides WHICH of two too-close candidates is
# the false one (the weaker is dropped). NEVER raises.

_BAR_GAP_CROSS = 0.5    # central-gap dark fraction at/above which a candidate clearly crosses the
#                         inter-staff gap (a real barline); below it the column may be a chord/stem
#                         stack. From the prototyped guard (gcov_centralhalf > 0.5).
_BAR_NARROW_FRAC = 0.5  # a measure narrower than this fraction of the system's median measure width
#                         is anomalous -> the bounding non-gap-crossing candidate is an EXTRA barline.
_BAR_COV = 0.7          # clean: a barline column is dark over >70% of the grand-staff-pair height.
_BAR_COV_PHOTO = 0.45   # photo (dewarped) path: a real phone photo's faint / slightly-skewed barlines
#                         often only reach ~0.45-0.6 pair-height coverage, so they fall under 0.7 and
#                         are MISSED -> the system under-segments, notes scatter across the wrong
#                         measure NUMBERS, and note_f1 craters. Lowering the threshold only on the
#                         dewarp (photo) path recovers them; the inter-staff-gap-crossing score and
#                         _drop_extra_barlines still prune the extra candidates the lower bar admits.
#                         Clean pages never dewarp, so they keep _BAR_COV and stay byte-identical.
#                         0.45 was swept on the real photos: icarus systems 2-3 detect 5 of ~9 barlines
#                         at 0.70 but ~9 at 0.45, lifting icarus note_f1 0.471 -> 0.901 (near its
#                         segmentation-free ceiling 0.939) with the other pieces flat or up; below 0.45
#                         the gain plateaus while false candidates start to appear.
# WIDE-MEASURE SPLIT (photo only, the inverse of _drop_extra_barlines). Even at _BAR_COV_PHOTO some
# real photo barlines fade below the coverage bar entirely, so a system UNDER-segments: one measure
# spans the width of two and every later measure NUMBER shifts, which the (measure,staff,midi) metric
# punishes (reverie photo: optimal order-preserving re-alignment recovers note recall 0.616->0.703,
# liminality 0.444->0.663, i.e. dropped barlines, not pitch, are the residual). _insert_missing_barlines
# recovers a faded bar that still CROSSES the inter-staff gap (high gcov) inside an anomalously WIDE
# measure, self-calibrated to the kept bars so clutter cannot fabricate one. Clean never dewarps so it
# never runs there (byte-identical).
_BAR_WIDE_FRAC = 1.7    # a measure wider than this fraction of the system median holds a missed bar.
_BAR_INSERT_FRAC = 0.8  # a recovered bar must cross the gap >= this fraction as strongly as the
#                         system's median KEPT bar (floored at _BAR_GAP_CROSS) -- the precision gate.


def _drop_extra_barlines(xs: List[float], scores: List[float]) -> List[float]:
    """Remove EXTRA (over-segmenting) barline candidates from one system's sorted x-centers `xs`,
    given each candidate's inter-staff-gap darkness `scores[i]` (0..1; high == clearly crosses the
    gap == a real barline). A candidate is dropped ONLY when BOTH: (a) it sits anomalously close to a
    kept neighbour -- the measure between them is narrower than _BAR_NARROW_FRAC x the system's median
    measure width, AND (b) it does NOT cross the gap (score < _BAR_GAP_CROSS), so it is a false barline
    from a dense chord/stem stack rather than a genuinely short real measure. Among two too-close
    candidates the WEAKER (lower gap score) is the one dropped. The median measure width is taken from
    the RELIABLE grid (the gap-crossing candidates, which are never dropped) so the scale is stable;
    it falls back to all candidates when too few cross the gap. A uniformly-segmented system has no
    anomalously-narrow measure, so NOTHING is dropped and `xs` is returned unchanged (strict
    never-worse). PURE; returns `xs` unchanged on too-few candidates / no usable scale. NEVER raises."""
    try:
        n = len(xs)
        if n < 3 or len(scores) != n:
            return xs
        # Measure-width scale from the candidates that clearly cross the gap (the real grid, never
        # dropped) so it is not pulled down by the false barlines we are trying to remove. Fall back
        # to all candidates when too few cross the gap (a smaller scale -> fewer drops -> still safe).
        strong = [xs[i] for i in range(n) if scores[i] >= _BAR_GAP_CROSS]
        ref = strong if len(strong) >= 3 else xs
        gaps = sorted(ref[i + 1] - ref[i] for i in range(len(ref) - 1))
        if not gaps:
            return xs
        med = gaps[len(gaps) // 2]
        if med <= 0:
            return xs
        narrow = _BAR_NARROW_FRAC * med
        keep = [True] * n
        while True:
            kept = [i for i in range(n) if keep[i]]
            dropped = False
            for j in range(len(kept) - 1):
                a, b = kept[j], kept[j + 1]
                if xs[b] - xs[a] < narrow:
                    lo = a if scores[a] <= scores[b] else b  # the weaker of the too-close pair
                    if scores[lo] < _BAR_GAP_CROSS:          # only drop a non-gap-crossing (false) bar
                        keep[lo] = False
                        dropped = True
                        break
            if not dropped:
                break
        return [xs[i] for i in range(n) if keep[i]]
    except Exception:
        return xs


_BAR_HEAD_VETO_IL = 1.0  # a non-gap-crossing candidate with a detected notehead within this many
#                          interlines of its x is a chord/stem stack, not a barline. Measured on the
#                          dense CC0 set (N5 diagnostics, 2026-06-11): 98.8% (83/84) of the
#                          measure-damaging FALSE candidates that survive _drop_extra_barlines have a
#                          head within 1.0 interline, vs 0 of 504 TRUE barlines (engraving keeps
#                          noteheads clear of real bars; at 0.5 interlines the same signal only
#                          reaches 54% of false bars, so 1.0 is the measured radius). This catches
#                          the over-segmentation _drop_extra_barlines cannot see: false bars that do
#                          NOT carve an anomalously-narrow measure (canon keeps 13 such extra bars).


def _veto_headed_barlines(xs: List[float], scores: List[float], head_xs: List[float],
                          sp: float) -> Tuple[List[float], List[float]]:
    """Remove barline candidates that BOTH fail the inter-staff-gap test (score < _BAR_GAP_CROSS)
    AND have a detected notehead within _BAR_HEAD_VETO_IL interlines of their x. A real barline
    crosses the gap and never carries a head on its column, so such a candidate is a dense
    chord/stem stack read as a bar: the dense-score over-segmentation mechanism. A gap-crossing
    candidate is NEVER vetoed regardless of heads (real barlines are structurally exempt), and
    with no heads / no usable interline everything is kept, so a caller without head information
    is byte-identical. Returns the filtered (xs, scores) PAIR, kept index-aligned for the
    downstream _drop_extra_barlines. PURE; NEVER raises."""
    try:
        if not xs or not head_xs or sp <= 0 or len(scores) != len(xs):
            return xs, scores
        hs = sorted(float(h) for h in head_xs)
        tol = _BAR_HEAD_VETO_IL * sp
        kx: List[float] = []
        ks: List[float] = []
        for x, sc in zip(xs, scores):
            if sc < _BAR_GAP_CROSS:
                i = bisect.bisect_left(hs, x)
                near = min(
                    (hs[i] - x) if i < len(hs) else float("inf"),
                    (x - hs[i - 1]) if i > 0 else float("inf"),
                )
                if near <= tol:
                    continue  # a headed non-gap-crossing column is a stack, not a bar
            kx.append(x)
            ks.append(sc)
        return kx, ks
    except Exception:
        return xs, scores


def _best_thin_barcol(seg, thr: float, maxw: int) -> Optional[int]:
    """Index (within `seg`) of the strongest THIN gap-crossing column, or None if none qualifies. A
    candidate is a contiguous run of gcov >= _BAR_GAP_CROSS whose width is <= maxw (a real barline is a
    thin vertical line); the run's peak must reach `thr`. The width gate rejects a SUSTAINED dark band
    (a slur / tie / hairpin / smudge sagging into the inter-staff gap), which would otherwise clear a
    bare darkness threshold and split a measure at a false bar. Returns the peak of the strongest
    qualifying run. PURE; NEVER raises (caller already guards, but stay defensive)."""
    try:
        m = len(seg)
        best_c, best_v = None, 0.0
        c = 0
        while c < m:
            if float(seg[c]) >= _BAR_GAP_CROSS:
                s = c
                while c < m and float(seg[c]) >= _BAR_GAP_CROSS:
                    c += 1
                if (c - s) <= maxw:  # thin run -> a line, not a band
                    pk = s + int(seg[s:c].argmax())
                    if float(seg[pk]) >= thr and float(seg[pk]) > best_v:
                        best_v, best_c = float(seg[pk]), pk
            else:
                c += 1
        return best_c
    except Exception:
        return None


def _insert_missing_barlines(xs: List[float], gcov, sp: float) -> List[float]:
    """PHOTO-ONLY. Recover a barline that faded BELOW the coverage bar (so its column never became a
    candidate) yet still clearly crosses the inter-staff gap. Symmetric to _drop_extra_barlines: that
    drops an anomalously NARROW measure's extra bar; this SPLITS an anomalously WIDE measure (a gap
    wider than _BAR_WIDE_FRAC x the system's median measure width) at its strongest interior gap-
    crossing column. The split fires ONLY when that column crosses the gap at least _BAR_INSERT_FRAC as
    strongly as the system's MEDIAN kept bar (floored at _BAR_GAP_CROSS), self-calibrating to this
    system so a dense-stack or photo smudge cannot fabricate a bar. A uniformly-segmented system has no
    over-wide measure, so `xs` is returned unchanged (strict never-worse). `gcov` is the per-column
    central-gap dark fraction (None when there is no inter-staff gap -> no-op). PURE; NEVER raises."""
    try:
        if gcov is None or len(xs) < 2 or sp <= 0:
            return xs
        n = len(gcov)
        kept = [float(gcov[int(round(x))]) for x in xs if 0 <= int(round(x)) < n]
        if not kept:
            return xs
        ks = sorted(kept)
        thr = max(_BAR_GAP_CROSS, ks[len(ks) // 2] * _BAR_INSERT_FRAC)
        gaps = sorted(xs[i + 1] - xs[i] for i in range(len(xs) - 1))
        med = gaps[len(gaps) // 2]
        if med <= 0:
            return xs
        wide = _BAR_WIDE_FRAC * med
        margin = max(1, int(round(0.75 * sp)))
        maxw = max(2, int(round(0.6 * sp)))  # a real bar is THIN; a wider dark band is a slur/smudge
        cur = [float(x) for x in xs]
        for _ in range(2 * len(xs) + 8):  # bounded: each pass inserts at most one bar (the bound is
            cur.sort()                    # also the backstop should a dark plateau ever slip the gates)
            inserted = False
            for i in range(len(cur) - 1):
                if cur[i + 1] - cur[i] <= wide:
                    continue
                lo = max(0, int(round(cur[i])) + margin)
                hi = min(n, int(round(cur[i + 1])) - margin)
                if hi - lo < 1:
                    continue
                col = _best_thin_barcol(gcov[lo:hi], thr, maxw)
                if col is not None:
                    cur.append(float(lo + col))
                    inserted = True
                    break
            if not inserted:
                break
        return sorted(cur)
    except Exception:
        return xs


def detect_barlines(gray, staves: List[List[float]], normalize_illum: bool = True,
                    photo: bool = False,
                    heads: Optional[List[List[Tuple[float, float]]]] = None) -> List[List[float]]:
    """Detect barline x-positions per grand-staff pair. Returns a list aligned with `staves`:
    out[i] is the sorted barline x-centers for the grand staff staff i belongs to (the treble and
    bass of a pair share one list). NEVER raises; returns empty lists on failure so the decode
    falls back to even binning. `photo=True` (the dewarp path) lowers the coverage bar to
    _BAR_COV_PHOTO to recover a real photo's faint barlines; clean uploads never dewarp so they keep
    _BAR_COV and are byte-identical.

    heads (optional, index-aligned with staves like the decode's per_staff_heads) supplies the
    detected notehead (x, y) centers as SIDE-INFORMATION for the candidate filter: a
    non-gap-crossing candidate with a head within _BAR_HEAD_VETO_IL interlines of its x is a dense
    chord/stem stack misread as a barline and is vetoed (_veto_headed_barlines) before the
    narrow-measure filter. None (the default) skips the veto entirely, byte-identical to before.

    normalize_illum (default True) applies the flat-field first (a no-op on a clean page); the
    warped-photo decode threads through whatever detect_systems used so barlines share the same
    illumination space as the staves (see _illum_has_deep_shadow).

    A barline is a near-vertical dark run spanning the FULL grand-staff height (treble top to bass
    bottom). The discriminator vs a stem is the INTER-STAFF GAP: a stem lives inside one staff, but
    a barline crosses the blank gap between the treble and bass staves, so requiring high dark
    coverage over the whole pair height rejects stems, beams, and noteheads. Pairs staves via
    _pair_staves (by vertical gap, so a missing staff does not mispair the rest). A column is a
    barline if it is dark over >70% of the pair height AND narrow (a few px); a wide dark run is a
    beam/blob, not a line.

    A DENSE chord/stem stack also clears 70% of the pair height (treble notes + bass notes) WITHOUT
    crossing the blank gap, so it reads as a false barline and OVER-SEGMENTS the measure. Each
    candidate therefore also carries its CENTRE-OF-GAP darkness; `_drop_extra_barlines` removes a
    non-gap-crossing candidate only when it is an EXTRA one (carves an anomalously narrow measure),
    leaving uniformly-segmented systems byte-identical. See the module comment above.
    """
    out: List[List[float]] = [[] for _ in staves]
    if not GEOM_AVAILABLE or gray is None or not staves:
        return out
    try:
        if normalize_illum:
            gray = normalize_illumination(gray)  # flat-field photo shadows (no-op on clean)
        h, w = gray.shape
        mask = gray < 0.5
        for (ti, bi) in _pair_staves(staves):
            if ti is None:
                continue
            top = sorted(float(v) for v in staves[ti])
            if bi is not None:
                bot = sorted(float(v) for v in staves[bi])
            elif photo:
                # PHOTO lone staff (its grand-staff partner went undetected): no inter-staff gap, so
                # the gap-crossing discriminator is gone and a per-column dark scan over a single
                # staff height reads every STEM as a barline -> garbage over-segmentation that
                # scatters the staff's notes across spurious measures. Skip it (-> even binning). A
                # missing partner only arises on a real photo; a clean ODD / single-staff page keeps
                # the legacy single-staff scan below, so the clean path stays byte-identical.
                continue
            else:
                bot = top  # clean / classical lone staff: legacy single-staff scan (byte-identical)
            y0 = max(0, int(round(top[0])))
            y1 = min(h - 1, int(round(bot[-1])))
            if y1 - y0 < 4:
                continue
            sp = _interline(top) or 1.0
            band = mask[y0:y1 + 1, :]
            cov = band.sum(axis=0) / float(band.shape[0])  # per-column dark fraction over the pair
            barcol = cov > (_BAR_COV_PHOTO if photo else _BAR_COV)
            # Per-column darkness across the CENTRAL HALF of the inter-staff gap (treble bottom line
            # to bass top line). A real barline is dark here; a chord/stem stack is blank. gcov stays
            # None when there is no gap (odd staff count -> bot == top), so nothing is discriminated.
            gtop, gbot = top[-1], bot[0]
            gcov = None
            if gbot - gtop >= 3:
                g0 = max(0, int(round(gtop + 0.25 * (gbot - gtop))))
                g1 = min(h, int(round(gtop + 0.75 * (gbot - gtop))))
                if g1 > g0:
                    gband = mask[g0:g1, :]
                    gcov = gband.sum(axis=0) / float(gband.shape[0])
            xs: List[float] = []
            scores: List[float] = []
            maxw = max(2, int(round(0.6 * sp)))
            x = 0
            while x < w:
                if barcol[x]:
                    s = x
                    while x < w and barcol[x]:
                        x += 1
                    if (x - s) <= maxw:  # thin -> a line; wide -> a beam/blob, skip
                        xs.append((s + x - 1) / 2.0)  # left-to-right scan keeps xs sorted
                        # crossing strength = darkest central-gap column the run touches; no gap -> 1.0
                        scores.append(float(gcov[s:x].max()) if gcov is not None else 1.0)
                else:
                    x += 1
            if heads is not None and not photo:
                # Notehead side-information, CLEAN PATH ONLY: a weak (non-gap-crossing) candidate
                # with a head on its column is a chord/stem stack, never a real bar (measured 98.8%
                # vs 0% on clean dense renders, see _BAR_HEAD_VETO_IL). Runs BEFORE the
                # narrow-measure filter so the surviving grid _drop_extra_barlines reasons about is
                # already stack-free. The PHOTO path is excluded: dewarp jitter puts detected heads
                # near genuinely faint real bars (measured: the veto on the photo path cost the
                # tctab photo -0.024 note_f1 while gaining nothing elsewhere), and photos have
                # their own tuned recovery chain (_BAR_COV_PHOTO + _insert_missing_barlines).
                head_xs = [float(hx) for idx in (ti, bi)
                           if idx is not None and idx < len(heads)
                           for (hx, _hy) in heads[idx]]
                xs, scores = _veto_headed_barlines(xs, scores, head_xs, sp)
            xs = _drop_extra_barlines(xs, scores)  # drop EXTRA non-gap-crossing (false) barlines only
            if photo:
                xs = _insert_missing_barlines(xs, gcov, sp)  # recover faded bars in over-wide measures
            for idx in (ti, bi):
                if idx is not None and idx < len(staves):
                    out[idx] = xs
        return out
    except Exception:
        return [[] for _ in staves]


# --- Ottava (8va / 8vb) bracket detection (numpy) ----------------------------------------
#
# WHY THIS EXISTS. An ottava bracket (8va above / 8vb below, the dashed rule + "8") shifts every
# note under it by an octave WITHOUT changing its written staff position. geom decodes the WRITTEN
# position (decode_pitch), so a note under an 8va comes out 12 semitones too LOW (the user's reverie
# bug: it plays an octave low in the bracketed region). reverie's truth has 8va spanners drawn as a
# dashed segment per system on both staves; geom must read them and shift the sounding octave.
#
# This is the NOTEHEAD-ONLY path's detector (the deployed path has only notehead centers, no symbol
# boxes, so the bracket cannot come from a detected glyph class here). It is a classical CPU detector
# in the spirit of detect_barlines: scan a tight band just ABOVE the staff top (8va) and just BELOW
# the staff bottom (8vb) for the bracket's dashed horizontal rule.
#
# DISCRIMINATORS (measured on the 4 real eval pieces; spikes under C:\tmp\ottava_*.py). The dashed
# rule is, on its densest row:
#   - made of SHORT runs: the longest dark run is <= ~1.6 interline (a solid BEAM is one long run,
#     so longest-run rejects beams cleanly),
#   - MANY of them: >= 15 short runs (sparse stray ink along a row -- e.g. a few notehead/stem tops
#     poking into the band -- has only a handful, so the run COUNT rejects it),
#   - spanning a FULL SYSTEM width: the short-run span is >= 40 interlines (LOCAL clutter such as a
#     hairpin or a rehearsal mark spans only a few interlines, so span rejects it),
#   - VERTICALLY ISOLATED: each counted run is near-blank just above AND below it (a lone thin line).
#     This is the precision gate that rejects the two real false-positive sources the first three
#     gates alone let through -- LYRICS (a vocal line's text above a staff, e.g. tctab) and a run of
#     LEDGER LINES under a high passage (e.g. icarus), both of which are many short same-y runs but
#     carry ink (letters / noteheads) in the rows around them. See the isolation constants below.
# On reverie this fires on the clearly-bracketed staves and on NEITHER non-bracketed staff, and the
# box real_eval (350 DPI) shows reverie's octave improves while tctab/icarus/liminality do NOT regress
# (the gate that blocked the pre-isolation version). It is deliberately CONSERVATIVE: a missed bracket
# leaves that note at the written octave (today's behavior, no worse), while a FALSE bracket would
# shift correct notes an octave (a regression), so the thresholds favor precision. NEVER raises.
#
# SIZE (8 vs 15) is out of scope: reading the engraved "8"/"15" digit needs glyph recognition the
# notehead-only path lacks. The magnitude is always 1 octave (size 8), which is by far the common
# case; a 15ma would be under-shifted by one octave, documented as a follow-up.

_OTT_MAX_RUN_IL = 1.6      # a dash is <= this many interlines long; a longer run is a solid beam.
_OTT_MIN_SHORT_RUNS = 15   # a dashed rule has many dashes; fewer is stray ink.
_OTT_MIN_SPAN_IL = 40.0    # the bracket spans most of a system; a few interlines is local clutter.
_OTT_MIN_FILL = 0.12       # dashes fill >= this fraction of their span; sparse stem/ledger fringe
#                            below a staff fills only ~0.05 (a key 8vb precision guard, see below).
# PHOTO MODE (photo=True, set only when the warped-photo dewarp was kept; clean stays byte-identical).
# A printed 8va rule survives a phone photo as a FAINT, BROKEN, locally-smudged dashed line, so the
# clean gates silently drop it and every bracketed note comes out an octave off (the reverie photo
# bug: detect_ottavas found 4 brackets on the clean render but 1 on the photo). The relaxations below
# were each measured on the 4 real photos (C:\Users\pascu\omr-train\ottava_*.py): they lift reverie
# 0.471->0.663 and liminality 0.364->0.446 while leaving the ottava-free icarus/tctab unchanged (no
# fabricated shift). The strict isolation + min-runs + fill gates are KEPT, which is what keeps photo
# clutter from inventing a bracket; only ink/span/long-run are loosened.
_OTT_INK_PHOTO = 0.62      # scan dashes at this darker threshold (vs <0.5): faint photo ink sits at
#                            ~0.55-0.7 gray and is invisible to the clean <0.5 test (fill ~doubles).
_OTT_MIN_SPAN_IL_PHOTO = 24.0  # a genuine short 8va (2-3 measures) spans ~24-38 il; reverie's system-2
#                            8va measures 38.6 il and is killed by the clean 40-il floor.
_OTT_MAX_LONG_PHOTO = 6    # tolerate up to this many over-length runs in a candidate row (a beam or
#                            smudge bleeding into the band) by DROPPING them, instead of the clean
#                            rule's "any long run disqualifies the whole row" -- one smudge otherwise
#                            voids an entire 36-dash rule. More than this many long runs is a real beam
#                            region, not a dashed rule, so the row is still rejected.
_OTT_BELOW_CLEAR_IL = 10.0  # only scan the 8vb band below a staff when the next staff is at least
#                             this far down (open margin). A treble's "below" is the ~6.5-interline
#                             inter-staff gap, where an 8vb is ambiguous with the BASS staff's 8va
#                             (its above-band overlaps), so we skip it there to avoid a false shift.
_OTT_CLUSTER_GAP_IL = 30.0  # split a row's dashes into clusters wherever the gap between consecutive
#                             dashes exceeds this many interlines, and keep only the LARGEST cluster.
#                             A real bracket's dashes are ~1 interline apart, so this large gate fires
#                             ONLY on an EGREGIOUS far stray (reverie: a lone dash ~68 interlines off
#                             chained the bass span over 3 unbracketed measures) and never splits a real
#                             bracket. CAUTION: clustering SHRINKS the span, which RAISES fill (ink/span),
#                             so the fill gate is NOT the backstop against a fabricated shift here -- the
#                             >= _OTT_MIN_SHORT_RUNS vertically-isolated short runs over a >= _OTT_MIN_SPAN_IL
#                             span ARE. The 30 is sized so a SPARSE-clutter row (run gaps <=~20 interlines
#                             on the eval scores) is not split into a dense cluster that clears those gates;
#                             a tighter 8-interline gate did exactly that and fabricated a tctab 8va. So do
#                             NOT relax the isolation / run-count / span gates trusting a fill margin that
#                             clustering removes (precision is empirical on the eval scores, not structural).

# VERTICAL ISOLATION (the precision gate). A true ottava dash is a LONE thin line with a near-blank
# margin just above AND below it. Other horizontal repetitive structures in the band above a staff --
# LYRICS (a vocal line's text, e.g. tctab) and a run of LEDGER LINES under a high passage (e.g.
# icarus) -- also read as many short same-y dark runs and otherwise pass the run/span/fill gates, but
# they have ink (letter bodies / noteheads) packed in the rows immediately around them, so they are
# NOT vertically isolated. A run is kept only when the band [ISO_LO, ISO_HI] interlines ABOVE and
# BELOW it (over the run's own columns) is nearly blank. This is what separates a bracket from
# lyrics/ledger lines (both false-fire WITHOUT it, measured on tctab/icarus), and it also tightens the
# span to the true dashes by dropping a clef/notehead the densest row would otherwise chain in.
_OTT_ISO_LO_IL = 0.25      # the isolation band starts this far above/below the dash row (skips the
_OTT_ISO_HI_IL = 0.75      # dash's own ~2-3px thickness) and ends this far out.
_OTT_ISO_MAX_INK = 0.20    # a run is "isolated" when its above- AND below-band ink fraction is below
#                            this; a tall letter or a notehead-laden ledger row clears it (rejected).


def _dash_runs(rowmask) -> List[Tuple[int, int]]:
    """Contiguous True (dark) runs in a 1D boolean row, as (start, end_inclusive). PURE-ish (numpy
    row in, python list out). NEVER raises."""
    try:
        out: List[Tuple[int, int]] = []
        n = int(rowmask.shape[0])
        x = 0
        while x < n:
            if rowmask[x]:
                s = x
                while x < n and rowmask[x]:
                    x += 1
                out.append((s, x - 1))
            else:
                x += 1
        return out
    except Exception:
        return []


def _largest_dash_cluster(runs: List[Tuple[int, int]], max_gap: float) -> List[Tuple[int, int]]:
    """The largest contiguous sub-sequence of dash runs, splitting wherever the gap between a run's
    end and the next run's start exceeds max_gap. 'Largest' = most runs (ties keep the leftmost). A
    real ottava bracket is ONE cluster (its dashes are ~1 interline apart); a far-away stray dash
    forms its own tiny cluster and is dropped, so it cannot extend the bracket's x-span across
    unbracketed measures. PURE; returns runs unchanged when empty or already one cluster. NEVER raises."""
    try:
        if not runs:
            return runs
        clusters: List[List[Tuple[int, int]]] = []
        cur = [runs[0]]
        for run in runs[1:]:
            if run[0] - cur[-1][1] > max_gap:
                clusters.append(cur)
                cur = [run]
            else:
                cur.append(run)
        clusters.append(cur)
        return max(clusters, key=len)
    except Exception:
        return runs


def _band_ink(gray, ra: int, rb: int, s: int, e: int) -> float:
    """Ink fraction (dark pixels) in rows [ra, rb) over columns [s, e]. Used to test the vertical
    ISOLATION of a candidate dash run. Returns 1.0 (treated as NOT isolated, the conservative default)
    when the band is empty after clamping -- so a run whose isolation band falls entirely off the
    image is rejected rather than fabricating a shift. NEVER raises."""
    try:
        h, w = gray.shape
        ra, rb = max(0, int(ra)), min(h, int(rb))
        s, e = max(0, int(s)), min(w - 1, int(e))
        if rb <= ra or e < s:
            return 1.0
        return float((gray[ra:rb, s:e + 1] < 0.5).mean())
    except Exception:
        return 1.0


def _scan_dashed_rule(gray, y0: int, y1: int, xcut: int, sp: float,
                      photo: bool = False) -> Optional[Tuple[float, float]]:
    """Scan rows [y0, y1) of `gray` for the densest dashed-rule row (an ottava bracket). Returns the
    bracket x-extent (x0, x1) of the best qualifying row, or None if none qualifies. A row qualifies
    when its dark runs are all SHORT (<= _OTT_MAX_RUN_IL interlines, i.e. not a beam), there are
    >= _OTT_MIN_SHORT_RUNS of them that are VERTICALLY ISOLATED (near-blank just above AND below, so a
    lyric line or a ledger-line run is rejected -- see the isolation constants), their span is
    >= _OTT_MIN_SPAN_IL interlines, AND the dashes FILL >= _OTT_MIN_FILL of that span. The fill gate
    separates a real dashed rule (dash + gap, fill ~0.2-0.5) from the sparse fringe of stem/ledger
    BOTTOMS just outside a staff (~0.05). The far-left margin (clef/key/the "8" glyph) is excluded by
    xcut, and only ISOLATED runs set the span, so the span measures the true dashes.

    photo=True loosens three gates for a warped-photo raster (see the _OTT_*_PHOTO constants): a darker
    ink threshold (faint photo dashes), a shorter span floor (a short 8va survives), and tolerance for
    a few over-length runs (a smudge no longer voids the whole row). The strict isolation/min-runs/fill
    gates are unchanged, so photo clutter still cannot fabricate a bracket. NEVER raises."""
    if not GEOM_AVAILABLE or gray is None:
        return None
    try:
        h, w = gray.shape
        y0 = max(0, min(int(y0), h))
        y1 = max(0, min(int(y1), h))
        if y1 - y0 < 1 or sp <= 0:
            return None
        ink_thr = _OTT_INK_PHOTO if photo else 0.5
        max_run = _OTT_MAX_RUN_IL * sp
        min_span = (_OTT_MIN_SPAN_IL_PHOTO if photo else _OTT_MIN_SPAN_IL) * sp
        lo = max(1, int(round(_OTT_ISO_LO_IL * sp)))
        hi = max(lo + 1, int(round(_OTT_ISO_HI_IL * sp)))
        best: Optional[Tuple[int, float, float]] = None  # (n_iso, x0, x1)
        for r in range(y0, y1):
            row = (gray[r, :] < ink_thr).copy()
            if xcut > 0:
                row[:xcut] = False
            runs = _dash_runs(row)
            if len(runs) < _OTT_MIN_SHORT_RUNS:
                continue
            # A long run (a beam / thick rule) disqualifies the row. On clean a single one is fatal; on
            # a photo we tolerate up to _OTT_MAX_LONG_PHOTO of them (a smudge or beam bleeding into the
            # band) by dropping them below, since one stray smudge otherwise voids an entire dash rule.
            long_runs = sum(1 for (s, e) in runs if (e - s + 1) > max_run)
            if long_runs > (_OTT_MAX_LONG_PHOTO if photo else 0):
                continue
            short = [(s, e) for (s, e) in runs if (e - s + 1) <= max_run]
            if len(short) < _OTT_MIN_SHORT_RUNS:
                continue
            # Keep only VERTICALLY ISOLATED runs: near-blank in a thin band just above AND just below
            # the run's own columns. A lone dash passes; a slice through tall lyric text or a
            # notehead-laden ledger run has ink in those bands and is dropped. This both rejects the
            # lyric/ledger false positives and tightens the span to the true dashes.
            iso = [(s, e) for (s, e) in short
                   if _band_ink(gray, r - hi, r - lo, s, e) < _OTT_ISO_MAX_INK
                   and _band_ink(gray, r + lo, r + hi, s, e) < _OTT_ISO_MAX_INK]
            if len(iso) < _OTT_MIN_SHORT_RUNS:
                continue
            # Keep only the largest CONTIGUOUS dash cluster so a far stray dash (e.g. inter-staff
            # clutter at a system's far left) cannot chain the span back over unbracketed measures and
            # shift correct notes an octave. A genuine bracket is one cluster (dashes ~1 interline
            # apart), so this only trims disconnected outliers; it never splits a real dashed rule.
            iso = _largest_dash_cluster(iso, _OTT_CLUSTER_GAP_IL * sp)
            if len(iso) < _OTT_MIN_SHORT_RUNS:
                continue
            span = iso[-1][1] - iso[0][0]
            if span < min_span:
                continue
            ink = sum((e - s + 1) for (s, e) in iso)
            if (ink / span) < _OTT_MIN_FILL:
                continue
            if best is None or len(iso) > best[0]:
                best = (len(iso), float(iso[0][0]), float(iso[-1][1]))
        if best is None:
            return None
        return best[1], best[2]
    except Exception:
        return None


def detect_ottavas(gray, staves: List[List[float]],
                   normalize_illum: bool = True,
                   photo: bool = False) -> List[List[Tuple[float, float, int]]]:
    """Detect ottava (8va / 8vb) brackets per staff. Returns a list index-aligned with `staves`:
    out[i] is a list of spans (x0, x1, delta) on staff i, where delta = +1 for an 8va (a dashed rule
    ABOVE the staff top: the notes SOUND an octave higher, so sounding = written + 1 octave) and
    delta = -1 for an 8vb (a dashed rule BELOW the staff bottom: sounding = written - 1 octave). A
    note whose x falls in [x0, x1] is shifted by delta octaves (see ottava_delta_at).

    Each staff is scanned independently because the bracket is engraved per system on each staff it
    covers (reverie draws it on both the treble and bass of every spanned system). At most one 8va
    and one 8vb span are returned per staff (a system rarely stacks two on one staff); the magnitude
    is always 1 octave (size 8) -- reading the "8 vs 15" digit is out of scope for the notehead-only
    path. normalize_illum (default True) flat-fields first (no-op on clean); the warped-photo decode
    threads through detect_systems' choice so the bracket scan shares the staves' illumination space.
    photo (default False) loosens the dash gates for a warped-photo raster so the faint, broken,
    smudged printed rule still registers (see _scan_dashed_rule); clean keeps photo=False and is
    byte-identical. NEVER raises; returns [[] for _ in staves] on any failure so the decode unchanged."""
    out: List[List[Tuple[float, float, int]]] = [[] for _ in staves]
    if not GEOM_AVAILABLE or gray is None or not staves:
        return out
    try:
        if normalize_illum:
            gray = normalize_illumination(gray)  # flat-field photo shadows (no-op on clean)
        h, w = gray.shape
        # Each staff's top line y, so we can tell how far the NEXT staff sits below (to gate 8vb).
        tops = [sorted(float(v) for v in lines)[0] for lines in staves]
        for i, lines in enumerate(staves):
            sl = sorted(float(v) for v in lines)
            sp = _interline(sl)
            if sp is None:
                continue
            top, bottom = sl[0], sl[-1]
            # Exclude the far-left clef / key / "8" margin so the span measures the dashes only.
            xcut = int(round(min(w * 0.12, 4.0 * sp)))
            spans: List[Tuple[float, float, int]] = []
            # 8va: a dashed rule in a tight band ABOVE the top staff line (~0.4 .. 4 interlines up).
            # The above-band is always safe to scan: it is either the open margin above the system or
            # the wide inter-system gap, neither of which holds another staff's content at this y.
            above = _scan_dashed_rule(gray, int(round(top - 4.0 * sp)),
                                      int(round(top - 0.4 * sp)), xcut, sp, photo=photo)
            if above is not None:
                spans.append((above[0], above[1], 1))
            # 8vb: a dashed rule in a tight band BELOW the bottom staff line. ONLY scanned when the
            # next staff is far below (open margin). For the TREBLE of a grand staff the "below" band
            # is the ~6.5-interline inter-staff gap, whose content (and the BASS staff's own 8va,
            # whose above-band overlaps here) would be misread as a treble 8vb and shift correct
            # notes DOWN an octave (a regression). Skipping the crowded gap keeps the detector
            # precise; a genuine treble-staff 8vb in that gap is the rare case we forgo to never
            # fabricate a shift (the conservative tradeoff the contract demands).
            next_top = tops[i + 1] if i + 1 < len(tops) else None
            below_is_open = next_top is None or (next_top - bottom) >= _OTT_BELOW_CLEAR_IL * sp
            if below_is_open:
                below = _scan_dashed_rule(gray, int(round(bottom + 0.4 * sp)),
                                          int(round(bottom + 4.0 * sp)), xcut, sp, photo=photo)
                if below is not None:
                    spans.append((below[0], below[1], -1))
            out[i] = spans
        return out
    except Exception:
        return [[] for _ in staves]


def ottava_delta_at(rep_x: float, spans: List[Tuple[float, float, int]]) -> int:
    """The summed octave shift (in octaves) of every ottava span containing rep_x. PURE and
    unit-testable. Normally 0 (no bracket) or a single span's delta (+1 for an 8va, -1 for an 8vb);
    summed for the rare stacked case. A note's sounding octave = written octave + this value.
    NEVER raises; returns 0 on any failure."""
    try:
        x = float(rep_x)
        total = 0
        for span in spans or []:
            try:
                x0, x1, delta = float(span[0]), float(span[1]), int(span[2])
            except (TypeError, ValueError, IndexError):
                continue
            lo, hi = (x0, x1) if x0 <= x1 else (x1, x0)
            if lo <= x <= hi:
                total += delta
        return total
    except Exception:
        return 0


# --- Full pipeline -----------------------------------------------------------------------


def _decode_staves_to_musicxml(
    staves: List[List[float]],
    per_staff_heads: List[List[Tuple[float, float]]],
    key_fifths: int = 0,
    gray=None,
    normalize_illum: bool = True,
    photo: bool = False,
) -> Optional[bytes]:
    """Shared decode tail for BOTH notehead sources: the classical detect_noteheads and the
    trained YOLO detector in geom_detector. Takes the detected staff-line groups and the
    per-staff notehead (x, y) centers ALREADY assigned to each staff, and turns them into a
    1-part / 2-staff grand-staff MusicXML. Only the notehead SOURCE differs between the two
    engines; everything from here on (chord grouping, the exact pitch decode, the treble/bass
    split, the measure distribution, the MusicXML payload) is identical, so it lives here once.
    Keeping it shared stops the trained path from silently drifting from the classical baseline
    it is benchmarked against.

    per_staff_heads is index-aligned with staves: per_staff_heads[i] are the (x, y) centers on
    staves[i] (a staff with no heads contributes nothing). The upper staff of each grand-staff
    pair is treble (G), the lower is bass (F); treble accumulates all upper-staff chords and
    bass all lower-staff chords, in page order, then each hand's chord stream is split into
    measures.

    Measure structure: when a grayscale image is passed, detect_barlines finds the REAL bar lines
    per grand-staff system and chords are placed into measures by their x-position (each chord
    keeps its center x for this). Without it (gray=None) the legacy even binning is used (see
    _segment_to_measures / _chords_to_measures). Durations are still a placeholder (every event
    duration:1); reading note durations is a separate rung.

    normalize_illum (default True) is forwarded to detect_barlines / detect_ottavas so they share the
    illumination space of the staves passed in (the warped-photo path may turn the flat-field off; see
    _illum_has_deep_shadow). The classical engine and the clean path keep the default, so both stay
    byte-identical.

    Returns MusicXML bytes, or None if nothing usable was found. NEVER raises.
    """
    try:
        barlines = (detect_barlines(gray, staves, normalize_illum=normalize_illum, photo=photo,
                                    heads=per_staff_heads)
                    if gray is not None else [[] for _ in staves])
        # Ottava (8va / 8vb) brackets per staff: a note under one SOUNDS an octave higher (8va) or
        # lower (8vb) than its written staff position. geom decodes the WRITTEN position, so without
        # this shift a bracketed note is an octave off (the reverie bug). We emit the SOUNDING octave
        # directly (no <octave-shift> direction): reconcile.to_events + OSMD + the scorer all read
        # <octave>, so the audio, falling notes, and grading are all correct, with zero risk of OSMD
        # double-applying a bracket. The tradeoff is the sheet shows the real high notes with ledger
        # lines instead of a low position + an 8va bracket (acceptable, arguably clearer). When no
        # bracket is detected the shift is +0, so non-ottava output is byte-identical to before.
        ottava_spans = (detect_ottavas(gray, staves, normalize_illum=normalize_illum, photo=photo)
                        if gray is not None else [[] for _ in staves])

        def staff_chords(idx, clef):
            # [(rep_x, [pitch...]), ...] for one staff, x-ordered. Keeping each chord's center x
            # is what lets _segment_to_measures place it into the right bar.
            if idx >= len(staves):
                return []
            sp = _interline(staves[idx])
            if sp is None:
                return []
            heads = per_staff_heads[idx] if idx < len(per_staff_heads) else []
            spans = ottava_spans[idx] if idx < len(ottava_spans) else []
            out = []
            for chord in group_chords(heads, sp):
                pitches, xs = [], []
                for (x, y) in chord:
                    p = decode_pitch(y, staves[idx], clef, fifths=key_fifths)
                    if p is not None:
                        pitches.append(p)
                        xs.append(x)
                if pitches:
                    rep_x = sum(xs) / len(xs)
                    # Apply the ottava shift at the chord's rep_x: sounding octave = written + delta.
                    shift = ottava_delta_at(rep_x, spans)
                    if shift:
                        pitches = [(s, a, o + shift) for (s, a, o) in pitches]
                    out.append((rep_x, pitches))
            return out

        # Process each grand-staff PAIR (treble=2i, bass=2i+1) as one system, segmenting its chords
        # into measures by that system's detected barlines; concatenate measures across systems.
        measures: List[dict] = []
        any_chord = False
        for (ti, bi) in _pair_staves(staves):
            treble = staff_chords(ti, "G") if ti is not None else []
            bass = staff_chords(bi, "F") if bi is not None else []
            if treble or bass:
                any_chord = True
            blx = barlines[ti] if (ti is not None and ti < len(barlines)) else []
            measures.extend(_segment_to_measures(treble, bass, blx))

        if not any_chord or not measures:
            return None

        data = {
            "divisions": 4,
            "key_fifths": key_fifths,
            "time": {"beats": 4, "beat_type": 4},
            "measures": measures,
        }
        return llm_omr.score_json_to_musicxml(data)
    except Exception:
        return None


def transcribe_geometric(image_path_or_gray, key_fifths: int = 0) -> Optional[bytes]:
    """Tie it together for the CLASSICAL engine: detect staves, detect noteheads per staff with
    the classical detect_noteheads, then hand off to the shared _decode_staves_to_musicxml tail
    (chord grouping, the exact pitch decode, treble/bass split, measure distribution, MusicXML).
    Returns MusicXML bytes, or None if nothing usable was found. NEVER raises.

    key_fifths: key signature handed to decode_pitch for accidentals (default 0 = C major).

    The trained-detector counterpart is geom_detector.transcribe_with_detector, which differs
    ONLY in the notehead source and shares this exact decode tail.
    """
    if not GEOM_AVAILABLE:
        return None
    try:
        gray = _to_gray(image_path_or_gray)
        if gray is None:
            return None
        staves = detect_systems(gray)
        if not staves:
            return None
        # Classical notehead source: detect per staff. _decode_staves_to_musicxml expects the
        # heads index-aligned with staves, so build one list per staff in page order.
        per_staff_heads = [detect_noteheads(gray, staff_lines) for staff_lines in staves]
        return _decode_staves_to_musicxml(staves, per_staff_heads, key_fifths=key_fifths, gray=gray)
    except Exception:
        return None


def _pitches_to_event(pitches: List[Tuple[str, int, int]]) -> dict:
    """One chord's [(step, alter, octave), ...] -> the llm_omr event dict."""
    return {
        "duration": 1,
        "pitches": [{"step": s, "alter": a, "octave": o} for (s, a, o) in pitches],
    }


def _chords_to_measures(treble_chords, bass_chords) -> List[dict]:
    """Distribute each hand's chord stream across measures. We choose the measure count from
    the per-hand chord counts so neither hand is crammed: n_measures = max over hands of
    ceil(count / 4) (4 onset-slots per 4/4 bar, matching generate_random_score), at least 1.
    Each measure gets a contiguous slice of each hand's stream. NEVER raises."""
    try:
        per_bar = 4
        import math

        nt = len(treble_chords)
        nb = len(bass_chords)
        n_measures = max(1, math.ceil(nt / per_bar), math.ceil(nb / per_bar))

        def slice_for(stream, m):
            start = m * per_bar
            return stream[start : start + per_bar]

        measures = []
        for m in range(n_measures):
            s1 = [_pitches_to_event(c) for c in slice_for(treble_chords, m)]
            s2 = [_pitches_to_event(c) for c in slice_for(bass_chords, m)]
            if not s1 and not s2:
                continue
            measures.append({"staff1": s1, "staff2": s2})
        return measures
    except Exception:
        return []


def _segment_to_measures(treble, bass, barlines) -> List[dict]:
    """Place each hand's (rep_x, pitches) chords into measures. With >=2 barline x-positions a
    measure is the half-open interval [barlines[k], barlines[k+1]) and each chord goes by its
    rep_x -- REAL bars, replacing the rhythm-blind even binning. Without barlines (detection
    declined) it falls back to _chords_to_measures (legacy 4-per-bar). NEVER raises."""
    try:
        edges = sorted(barlines) if barlines else []
        if len(edges) >= 2:
            nmeas = len(edges) - 1

            def bucket(chords):
                buckets = [[] for _ in range(nmeas)]
                for (x, pitches) in chords:
                    k = 0
                    while k < nmeas and x >= edges[k + 1]:
                        k += 1
                    buckets[min(k, nmeas - 1)].append((x, pitches))
                return buckets

            tb, bb = bucket(treble), bucket(bass)
            measures = []
            for m in range(nmeas):
                s1 = [_pitches_to_event(p) for (_x, p) in sorted(tb[m], key=lambda c: c[0])]
                s2 = [_pitches_to_event(p) for (_x, p) in sorted(bb[m], key=lambda c: c[0])]
                if s1 or s2:
                    measures.append({"staff1": s1, "staff2": s2})
            return measures
        return _chords_to_measures([p for (_x, p) in treble], [p for (_x, p) in bass])
    except Exception:
        return []


# --- Full-symbol decode: durations / key / accidentals / clefs / rests FROM glyphs --------
#
# The trained MULTI-CLASS detector (geom_detector) finds EVERY glyph, not just notehead centers:
# heads (filled/open), stems, flags, beams, dots, the 5 accidentals, clefs (g/f/c), rests, the
# time-sig, ties, and ottava. This decode READS the musical content from those glyphs by geometry
# ("measure, do not predict"), extending the exact pitch decode to:
#   - DURATIONS: head fill (open vs filled) + stem presence + beam/flag COUNT + augmentation dots.
#   - KEY SIGNATURE: the run of accidental glyphs between the clef and the first notehead.
#   - per-note ACCIDENTALS: an accidental glyph immediately left of a head overrides the keyed alter.
#   - CLEFS: the leftmost clef glyph sets each staff-region's pitch reference (no treble/bass-by-
#     index assumption); a later clef glyph is a mid-score clef CHANGE from that x onward.
#   - RESTS: rest glyphs become rest events placed by x.
# It SHARES the pitch decode (decode_pitch), interline, barline segmentation (detect_barlines), the
# key prior (keyed_alter), and the MusicXML builder with the notehead-only path. The geometric
# basis is measured in ~/omr-train/inspect_geom.py (see memory full-symbol-duration-geometry):
# fill+stem give whole/half/quarter cleanly; the 8th-vs-16th subdivision rides on beam/flag count
# and is detector-quality-dependent, so it is gated on the real-score eval, not synthetic.
# NEVER raises (the public entry guards; helpers are defensive).

# accidental class name -> chromatic alter, and the inverse for the engraved <accidental> glyph.
_ACCID_ALTER = {
    "accidental_sharp": 1, "accidental_flat": -1, "accidental_natural": 0,
    "accidental_double_sharp": 2, "accidental_double_flat": -2,
}
_ALTER_GLYPH = {2: "double-sharp", 1: "sharp", 0: "natural", -1: "flat", -2: "double-flat"}
# base note value -> ticks at divisions=4 (1 tick == one sixteenth). 32nd is not representable at
# divisions=4 (load-bearing for the fusion), so it clamps to a 16th (32nds are rare in piano).
_DUR_TICKS = {"whole": 16, "half": 8, "quarter": 4, "eighth": 2, "16th": 1, "32nd": 1}
_LEVEL_TYPE = {0: "quarter", 1: "eighth", 2: "16th", 3: "32nd"}
_CLEF_LINE = {"G": 2, "F": 4, "C": 3}


def decode_note_duration(filled, has_stem, n_beams=0, n_flags=0, n_dots=0):
    """Map the measured glyphs around a notehead to (type_name, dots, ticks-at-divisions-4). PURE.
    From the rendered geometry: head FILL splits open (whole/half) from filled (quarter and
    shorter); STEM splits whole (none) from half; beam/flag COUNT gives the subdivision; DOTS
    multiply (1 dot x1.5, 2 dots x1.75). NEVER raises."""
    try:
        nd = max(0, min(int(n_dots), 2))
        if not filled:
            type_name = "half" if has_stem else "whole"
        else:
            level = max(int(n_beams), int(n_flags))
            type_name = _LEVEL_TYPE.get(min(level, 3), "16th") if level > 0 else "quarter"
        base = _DUR_TICKS.get(type_name, 4)
        ticks = base if nd == 0 else int(round(base * (2.0 - 0.5 ** nd)))
        return type_name, nd, max(1, ticks)
    except Exception:
        return "quarter", 0, 4


def _assign_symbols_to_staves(symbols, staves, max_interlines: float = 8.0):
    """Assign every detected symbol (cls, x, y, w, h[, conf]) to its nearest staff by the vertical
    distance from the symbol's center to the staff's line span (mirrors geom_detector._assign_to_
    staves but for all classes; the generous max_interlines keeps ledger notes + their stems/beams
    with their staff). Returns a per-staff dict {class_name: [(x, y, w, h), ...]}. NEVER raises."""
    per_staff = [{name: [] for name in CLASS_NAMES} for _ in staves]
    try:
        spans = []
        for lines in staves:
            sl = sorted(float(v) for v in lines)
            sp = _interline(sl) or 1.0
            spans.append((sl[0], sl[-1], sp))
        for s in symbols:
            try:
                c = int(s[0])
                x, y, w, h = float(s[1]), float(s[2]), float(s[3]), float(s[4])
            except (TypeError, ValueError, IndexError):
                continue
            if not (0 <= c < len(CLASS_NAMES)):
                continue
            cy = y + h / 2.0
            best, best_d = -1, None
            for i, (top, bottom, sp) in enumerate(spans):
                d = 0.0 if top <= cy <= bottom else (top - cy if cy < top else cy - bottom)
                if best_d is None or d < best_d:
                    best, best_d = i, d
            if best >= 0 and best_d <= max_interlines * spans[best][2]:
                per_staff[best][CLASS_NAMES[c]].append((x, y, w, h))
        return per_staff
    except Exception:
        return per_staff


def _staff_clefs(syms):
    """Clef glyphs on a staff as (left_x, right_x, center_x, sign), sorted by center x. The first
    is the opening clef; any later one is a mid-score clef change. NEVER raises."""
    try:
        clefs = []
        for cls, sign in (("clef_g", "G"), ("clef_f", "F"), ("clef_c", "C")):
            for (x, y, w, h) in syms.get(cls, []):
                clefs.append((x, x + w, x + w / 2.0, sign))
        clefs.sort(key=lambda c: c[2])
        return clefs
    except Exception:
        return []


def _first_note_x(syms):
    heads = syms.get("notehead_filled", []) + syms.get("notehead_open", [])
    return min((b[0] for b in heads), default=None)


def _detect_key_fifths(syms, clefs, sp):
    """Read the key signature from the run of accidental glyphs between the opening clef and the
    first notehead (bounded on the right by the time signature if present, else just before the
    first note so a note's own inline accidental is not miscounted). sharps>flats -> +count,
    flats>sharps -> -count, clamped to +/-7. Returns None when it cannot tell (no clef / no notes),
    0 for an empty zone (C major). PURE-ish (reads only boxes). NEVER raises."""
    try:
        if not clefs:
            return None
        first_x = _first_note_x(syms)
        if first_x is None:
            return None
        clef_right = clefs[0][1]
        ts = syms.get("timesig", [])
        zone_right = (min(t[0] for t in ts) if ts else first_x - 1.2 * sp)
        sharps = flats = 0
        for (x, y, w, h) in syms.get("accidental_sharp", []):
            if clef_right - 0.2 * sp < x + w / 2.0 < zone_right:
                sharps += 1
        for (x, y, w, h) in syms.get("accidental_flat", []):
            if clef_right - 0.2 * sp < x + w / 2.0 < zone_right:
                flats += 1
        if sharps > flats:
            return min(7, sharps)
        if flats > sharps:
            return -min(7, flats)
        return 0
    except Exception:
        return None


def _find_stem(head_cx, head_cy, stems, sp):
    """The stem box attached to a notehead: a vertical run within ~0.9 interline of the head center
    x whose y-span reaches the head. Returns (sx, sy, sw, sh) or None. NEVER raises."""
    try:
        best, best_dx = None, None
        for st in stems:
            sx, sy, sw, sh = st
            scx = sx + sw / 2.0
            dx = abs(scx - head_cx)
            if dx < 0.9 * sp and not (sy > head_cy + 2.0 * sp or sy + sh < head_cy - 2.0 * sp):
                if best_dx is None or dx < best_dx:
                    best, best_dx = st, dx
        return best
    except Exception:
        return None


def _count_beams_flags(head_cx, head_cy, stem, beams, flags, sp):
    """(n_beams, n_flags) for a note/chord at (head_cx, head_cy). Associates beams/flags with the
    notehead's X-COLUMN, NOT via the detected stem: the thin `stem` class detects poorly (real-data
    recall ~0.05-0.30, so only ~20-30% of beamed heads get a stem), and a stem-gated association
    then misreads beamed eighths/16ths as quarters. A beam/flag for this note sits in its x-column
    within a stem-length (~5 interlines) above OR below the head. When a stem IS detected it refines
    the column x + the vertical side (free end); when not, the head's own x and both sides are used.
    A 16th run shows 2 stacked beams a column crosses on real/DeepScores detections; the synthetic
    render unions a group to ONE box (under-reads synthetic 16ths -> eighths, gated on real_eval).
    NEVER raises."""
    try:
        if stem is not None:
            sx, sy, sw, sh = stem
            col_x = sx + sw / 2.0
            free_y = sy + sh if head_cy < sy + sh / 2.0 else sy
            y_lo, y_hi = min(head_cy, free_y) - 1.0 * sp, max(head_cy, free_y) + 1.0 * sp
            xt = 0.4 * sp
        else:
            col_x = head_cx
            y_lo, y_hi = head_cy - 5.0 * sp, head_cy + 5.0 * sp
            xt = 0.7 * sp  # the stem (and its beam) sits ~0.6 interline off the head center
        nb = 0
        for (bx, by, bw, bh) in beams:
            bcy = by + bh / 2.0
            if bx - xt <= col_x <= bx + bw + xt and y_lo <= bcy <= y_hi:
                nb += 1
        nf = 0
        for (fx, fy, fw, fh) in flags:
            if abs(fx + fw / 2.0 - col_x) < 1.6 * sp and y_lo <= fy + fh / 2.0 <= y_hi:
                nf += 1
        return nb, nf
    except Exception:
        return 0, 0


def _has_stem_cv(gray, head_cx, head_cy, sp):
    """Classical stem-presence probe on the grayscale image: is there a near-vertical dark run at
    the notehead's left or right side, longer than ~1.5 interlines? Recovers the stem signal the
    trained `stem` class misses (recall ~0.05-0.30). Used ONLY to split an OPEN head into half (has
    stem) vs whole (no stem); filled heads do not need it (fill alone -> quarter-or-shorter). Needs
    numpy (GEOM_AVAILABLE) and the image; returns False without them. NEVER raises."""
    if gray is None or not GEOM_AVAILABLE:
        return False
    try:
        h, w = gray.shape
        for side in (-1, 1):
            cx = int(round(head_cx + side * 0.6 * sp))
            if cx < 1 or cx >= w - 1:
                continue
            col = (gray[:, cx - 1:cx + 2] < 0.5).any(axis=1)  # dark at this x-band, per row
            y0, y1 = max(0, int(head_cy - 4 * sp)), min(h, int(head_cy + 4 * sp))
            run = best = 0
            for r in range(y0, y1):
                if col[r]:
                    run += 1
                    if run > best:
                        best = run
                else:
                    run = 0
            if best >= 1.5 * sp:
                return True
        return False
    except Exception:
        return False


def _count_dots(head_cx, head_right, head_cy, dots, sp):
    """Augmentation dots: dot boxes just right of the head (within ~2.2 interline), at the head's
    vertical level. Capped at 2 (double-dotted). NEVER raises."""
    try:
        n = 0
        for (dx, dy, dw, dh) in dots:
            dcx, dcy = dx + dw / 2.0, dy + dh / 2.0
            if head_right - 0.4 * sp < dcx < head_cx + 2.2 * sp and abs(dcy - head_cy) < 0.9 * sp:
                n += 1
        return min(n, 2)
    except Exception:
        return 0


def _group_heads_into_chords(heads, sp):
    """Group heads [(x, y, w, h, filled), ...] that share an x-cluster into chords (same logic as
    group_chords, carrying the fill flag). Returns a list of chords, each a list of head tuples.
    NEVER raises."""
    try:
        if not heads:
            return []
        ordered = sorted(heads, key=lambda hh: hh[0] + hh[2] / 2.0)
        chords, cur, cur_x = [], [ordered[0]], ordered[0][0] + ordered[0][2] / 2.0
        for hh in ordered[1:]:
            cx = hh[0] + hh[2] / 2.0
            if cx - cur_x <= 1.2 * sp:
                cur.append(hh)
            else:
                chords.append(cur)
                cur, cur_x = [hh], cx
        chords.append(cur)
        return chords
    except Exception:
        return []


def _ottava_spans_from_boxes(syms, staff_lines, sp):
    """Ottava spans for the FULL-SYMBOL path, derived from the detected `ottava` class boxes (the
    notehead-only path has no glyph boxes and uses detect_ottavas on the raster instead). Each box's
    x-range is the bracket span; its center-y vs the staff's line span sets the direction: a box
    centered ABOVE the top line is an 8va (+1, notes sound an octave higher), BELOW the bottom line
    is an 8vb (-1). Returns [(x0, x1, delta), ...] for ottava_delta_at. NEVER raises."""
    try:
        sl = sorted(float(v) for v in staff_lines)
        if len(sl) < 2:
            return []
        top, bottom = sl[0], sl[-1]
        spans = []
        for (x, y, w, h) in syms.get("ottava", []):
            cy = y + h / 2.0
            # Direction from the box's vertical placement relative to the staff. A box that overlaps
            # the staff body (neither clearly above nor below) is ambiguous; default to 8va (the
            # common case) so a slightly-low-detected 8va box still shifts up rather than nullifying.
            delta = -1 if cy > bottom + 0.5 * sp else 1
            spans.append((float(x), float(x + w), delta))
        return spans
    except Exception:
        return []


def _decode_staff(staff_lines, syms, fifths, default_sign="G", gray=None):
    """Decode one staff's glyphs into (events, opening_clef_sign, clef_changes):
      events        : [(rep_x, event_dict), ...] x-ordered (notes/chords with duration+type+dots+
                      pitches incl. inline accidentals, plus rests).
      opening_clef  : the staff's opening clef sign ("G"/"F"/"C") or None if no clef glyph.
      clef_changes  : [(x, sign), ...] for any clef glyph beyond the opening (mid-score change).
    default_sign is the clef assumed when NO clef glyph is detected on the staff; it MUST match the
    by-index opening clef the caller prints ("G" treble / "F" bass), so a missed clef glyph cannot
    desync the decoded pitch from the labeled clef (an octave error in that hand). NEVER raises."""
    try:
        sp = _interline(staff_lines)
        if sp is None:
            return [], None, []
        clefs = _staff_clefs(syms)
        opening = clefs[0][3] if clefs else None

        def active_clef(nx):
            sign = opening or default_sign
            for (lo, ro, xc, s) in clefs:
                if xc <= nx + 0.5 * sp:
                    sign = s
                else:
                    break
            return sign

        # key-signature zone (to exclude key accidentals from inline-accidental matching).
        first_x = _first_note_x(syms)
        clef_right = clefs[0][1] if clefs else -1e18
        ts = syms.get("timesig", [])
        zone_right = (min(t[0] for t in ts) if ts
                      else (first_x - 1.2 * sp if first_x is not None else -1e18))
        inline_acc = []  # (center_x, center_y, alter) for accidentals OUTSIDE the key zone
        for cls, alter in _ACCID_ALTER.items():
            for (x, y, w, h) in syms.get(cls, []):
                xc = x + w / 2.0
                if not (clef_right - 0.2 * sp < xc < zone_right):
                    inline_acc.append((xc, y + h / 2.0, alter))

        stems = syms.get("stem", [])
        beams = syms.get("beam", [])
        flags = syms.get("flag", [])
        dots = syms.get("dot", [])
        # Ottava brackets from the detected `ottava` glyph boxes: a note under one sounds an octave
        # higher (8va) or lower (8vb) than its written position. Same SOUNDING-octave-only treatment
        # as the notehead-only path (we shift <octave>, emit no <octave-shift> direction).
        ottava_spans = _ottava_spans_from_boxes(syms, staff_lines, sp)
        heads = ([(b[0], b[1], b[2], b[3], True) for b in syms.get("notehead_filled", [])]
                 + [(b[0], b[1], b[2], b[3], False) for b in syms.get("notehead_open", [])])

        events = []
        for chord in _group_heads_into_chords(heads, sp):
            rep_x = sum(h[0] + h[2] / 2.0 for h in chord) / len(chord)
            clef = active_clef(rep_x)
            pitches = []
            for (hx, hy, hw, hh, filled) in chord:
                cy = hy + hh / 2.0
                p = decode_pitch(cy, staff_lines, clef, fifths=0)
                if p is None:
                    continue
                step, _a0, octave = p
                # inline accidental immediately left of THIS head (overrides the key for one note).
                alter, best_dx = None, None
                for (axc, ayc, aalter) in inline_acc:
                    dx = hx - axc  # accidental sits just left of the head's left edge
                    if 0.0 < dx < 2.0 * sp and abs(ayc - cy) < 0.7 * sp and (best_dx is None or dx < best_dx):
                        best_dx, alter = dx, aalter
                pd = {"step": step, "octave": octave}
                if alter is None:
                    pd["alter"] = keyed_alter(step, fifths)
                else:
                    pd["alter"] = alter
                    glyph = _ALTER_GLYPH.get(alter)
                    if glyph is not None:
                        pd["accidental"] = glyph
                pitches.append(pd)
            if not pitches:
                continue
            # Ottava shift at this chord's rep_x: written octave -> sounding octave.
            shift = ottava_delta_at(rep_x, ottava_spans)
            if shift:
                for pd in pitches:
                    pd["octave"] = int(pd.get("octave", 4)) + shift
            chord_cy = sum(h[1] + h[3] / 2.0 for h in chord) / len(chord)
            stem = None
            for h in chord:
                stem = _find_stem(h[0] + h[2] / 2.0, h[1] + h[3] / 2.0, stems, sp)
                if stem is not None:
                    break
            nb, nf = _count_beams_flags(rep_x, chord_cy, stem, beams, flags, sp)
            nd = max((_count_dots(h[0] + h[2] / 2.0, h[0] + h[2], h[1] + h[3] / 2.0, dots, sp)
                      for h in chord), default=0)
            filled_any = any(h[4] for h in chord)
            # has_stem only distinguishes an OPEN head (half vs whole); the trained stem class is
            # unreliable, so fall back to a classical CV probe for open heads with no detected stem.
            has_stem = stem is not None
            if not has_stem and not filled_any:
                has_stem = _has_stem_cv(gray, rep_x, chord_cy, sp)
            type_name, dots_n, ticks = decode_note_duration(filled_any, has_stem, nb, nf, nd)
            ev = {"duration": ticks, "type": type_name, "pitches": pitches}
            if dots_n:
                ev["dots"] = dots_n
            events.append((rep_x, ev))

        for (x, y, w, h) in syms.get("rest", []):
            # rests are metric-neutral (the scorer ignores them); a placeholder quarter keeps the
            # event in the right measure (placed by x) and lets rhythm_repair complete the bar.
            events.append((x + w / 2.0, {"rest": True, "duration": 4, "type": "quarter"}))

        events.sort(key=lambda e: e[0])
        clef_changes = [(c[2], c[3]) for c in clefs[1:]]
        return events, opening, clef_changes
    except Exception:
        return [], None, []


def _segment_events_to_measures(treble, bass, barlines, t_changes, b_changes):
    """Bucket each hand's (rep_x, event) stream into measures by barline x (real bars), or fall
    back to ~4 onsets/bar without barlines. A mid-staff clef CHANGE (t_changes/b_changes =
    [(x, sign), ...]) sets that measure's <clef> for staff 1 / staff 2 (invisible to the scorer;
    a rendering nicety). Opening clefs are set by the caller on the GLOBAL first measure. NEVER
    raises."""
    try:
        edges = sorted(barlines) if barlines else []
        clef_by_meas: dict = {}
        if len(edges) >= 2:
            nmeas = len(edges) - 1

            def which(xc):
                k = 0
                while k < nmeas and xc >= edges[k + 1]:
                    k += 1
                return min(k, nmeas - 1)

            tb = [[] for _ in range(nmeas)]
            bb = [[] for _ in range(nmeas)]
            for (x, ev) in treble:
                tb[which(x)].append((x, ev))
            for (x, ev) in bass:
                bb[which(x)].append((x, ev))
            for (xc, sign) in t_changes:
                clef_by_meas.setdefault(which(xc), {})[1] = sign
            for (xc, sign) in b_changes:
                clef_by_meas.setdefault(which(xc), {})[2] = sign
        else:
            import math
            per_bar = 4
            nmeas = max(1, math.ceil(len(treble) / per_bar), math.ceil(len(bass) / per_bar))
            tb = [treble[m * per_bar:(m + 1) * per_bar] for m in range(nmeas)]
            bb = [bass[m * per_bar:(m + 1) * per_bar] for m in range(nmeas)]

        out = []
        for m in range(nmeas):
            s1 = [ev for (_x, ev) in sorted(tb[m], key=lambda c: c[0])]
            s2 = [ev for (_x, ev) in sorted(bb[m], key=lambda c: c[0])]
            if not s1 and not s2:
                continue
            md = {"staff1": s1, "staff2": s2}
            if m in clef_by_meas:
                md["clefs"] = [{"number": num, "sign": sign, "line": _CLEF_LINE.get(sign, 2)}
                               for num, sign in sorted(clef_by_meas[m].items())]
            out.append(md)
        return out
    except Exception:
        return []


def decode_symbols_to_musicxml(staves, symbols, key_fifths=None, gray=None, photo=False):
    """Decode the FULL multi-class symbol set into grand-staff MusicXML, reading durations, key,
    per-note accidentals, clefs, and rests from the glyphs (not just notehead centers). This is the
    trained full-symbol engine's decode tail (geom_detector.transcribe_with_symbols feeds it).

    staves       : per-staff lists of 5 staff-line y-centers (from detect_systems).
    symbols      : global list of detected glyphs (cls, x, y, w, h[, conf]) in image pixels.
    key_fifths   : None -> DETECT the key from the engraved key signature (the deployed behavior);
                   an int pins it (oracle, for the eval ceiling).
    gray         : the grayscale image, for barline detection (real measures). None -> even binning.
    photo        : True on the dewarp (real-photo) path -> detect_barlines lowers its coverage bar to
                   _BAR_COV_PHOTO to recover a photo's faint / skewed barlines. Default False keeps
                   clean uploads byte-identical. Mirrors _decode_staves_to_musicxml's photo flag.

    Returns MusicXML bytes or None. NEVER raises."""
    try:
        if not staves or not symbols:
            return None
        per_staff = _assign_symbols_to_staves(symbols, staves)

        fifths = key_fifths
        if fifths is None:  # detect from the first staff that yields a confident key (treble first)
            for i, staff_lines in enumerate(staves):
                sp = _interline(staff_lines)
                if sp is None:
                    continue
                k = _detect_key_fifths(per_staff[i], _staff_clefs(per_staff[i]), sp)
                if k is not None:
                    fifths = k
                    break
            if fifths is None:
                fifths = 0

        barlines = (detect_barlines(gray, staves, photo=photo)
                    if gray is not None else [[] for _ in staves])

        measures: List[dict] = []
        any_event = False
        first_signs = None
        # Pair grand staves by VERTICAL GAP (_pair_staves), not index parity. Parity (treble=2i,
        # bass=2i+1) silently mispairs the moment detection drops a staff mid-page: every staff below
        # the gap flips clef, so a whole bass staff reads in treble (an octave off AND wrong-hand).
        # _pair_staves is immune and stays byte-identical on a cleanly detected page; bi is None for a
        # lone staff whose partner went undetected (decoded as the page-top treble role). Mirrors the
        # notehead-only _decode_staves_to_musicxml so the two paths cannot drift.
        for (ti, bi) in _pair_staves(staves):
            # default_sign matches the opening clef printed below (treble upper, bass lower of each
            # pair), so a staff with NO detected clef glyph decodes pitch under the SAME clef it is
            # labeled with (no treble/bass desync if the detector misses a clef).
            t_ev, t_open, t_chg = (_decode_staff(staves[ti], per_staff[ti], fifths, default_sign="G", gray=gray)
                                   if ti is not None and ti < len(staves) else ([], None, []))
            b_ev, b_open, b_chg = (_decode_staff(staves[bi], per_staff[bi], fifths, default_sign="F", gray=gray)
                                   if bi is not None and bi < len(staves) else ([], None, []))
            if t_ev or b_ev:
                any_event = True
            if first_signs is None and (t_ev or b_ev):
                first_signs = (t_open or "G", b_open or "F")
            blx = barlines[ti] if (ti is not None and ti < len(barlines)) else []
            measures.extend(_segment_events_to_measures(t_ev, b_ev, blx, t_chg, b_chg))

        if not any_event or not measures:
            return None
        # Opening clefs on the global first measure (detected signs; treble/bass by index is the
        # fallback only when no clef glyph was found). A first measure that already carries a clef
        # CHANGE keeps it.
        t_sign, b_sign = first_signs or ("G", "F")
        if "clefs" not in measures[0]:
            measures[0] = dict(measures[0])
            measures[0]["clefs"] = [
                {"number": 1, "sign": t_sign, "line": _CLEF_LINE.get(t_sign, 2)},
                {"number": 2, "sign": b_sign, "line": _CLEF_LINE.get(b_sign, 4)},
            ]

        data = {
            "divisions": 4,
            "key_fifths": fifths,
            # The timesig GLYPH is detected (it bounds the key-signature zone), but reading its
            # numeric VALUE (the digits) is a separate rung; the meter stays 4/4, consistent with
            # the rest of the pipeline (divisions=4 is load-bearing for the fusion). The fusion can
            # still borrow Clarity's real <time> downstream.
            "time": {"beats": 4, "beat_type": 4},
            "measures": measures,
        }
        return llm_omr.score_json_to_musicxml(data)
    except Exception:
        return None
