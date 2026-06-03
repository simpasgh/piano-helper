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
) -> Optional[Tuple[str, int, int]]:
    """Pure-geometry pitch decode: a notehead's vertical pixel center -> (step, alter, octave).

    Args:
        notehead_center_y: notehead vertical CENTER in pixels (image space, y grows DOWN).
        staff_lines: the 5 staff-line y-centers in pixels, TOP-to-bottom (ascending y). The
            element order is normalized internally, so a bottom-to-top list also works.
        clef: "G" (treble), "F" (bass), or "C" (alto). Defaults to treble.

    Returns (step, alter, octave) or None on malformed input. NEVER raises.

    alter is always 0: pure staff geometry gives the LINE/SPACE (the diatonic step + octave);
    sharps/flats come from accidentals/key, which this geometric pass does not read. That is
    fine for the pitch-class/octave question we are measuring (and a later pass can add the
    key prior, exactly as reconcile._diatonic_pitch_classes does).
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
        return step, 0, octave
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


def _row_ink(gray) -> "np.ndarray":
    """Per-row ink fraction (fraction of dark pixels in each row)."""
    return (gray < 0.5).mean(axis=1)


def detect_systems(gray) -> List[List[float]]:
    """Detect EVERY 5-line staff group on the page. Returns a list of staves, each a list of
    5 staff-line y-centers (top-to-bottom). NEVER raises; returns [] on failure.

    Method: a staff line is a near-full-width dark row. Cluster contiguous dark rows into
    line centers (a thick line spans a few rows), then chop the ordered line list into groups
    of 5 by looking for a LARGE vertical gap (the inter-staff gap is much bigger than the
    interline within a staff). This extends referee._staff_lines (which returns only the
    first 5) to the whole page.
    """
    if not GEOM_AVAILABLE or gray is None:
        return []
    try:
        h, w = gray.shape
        roww = (gray < 0.5).sum(axis=1)
        # A staff line is a near-full-width dark row, but noteheads/stems sitting ON the line
        # interrupt it, so a strict 0.5*w threshold misses lines in dense music. Use a softer
        # 0.35*w fraction: a true staff line still clears it (noteheads cover only a small
        # fraction of the width), while text/sparse rows do not. Clustering + the 5-per-staff
        # grouping below reject the occasional false-positive dark row.
        th = 0.35 * w
        rows = [i for i, v in enumerate(roww) if v > th]
        if not rows:
            return []
        # Cluster contiguous dark rows into line centers.
        centers: List[float] = []
        cur = [rows[0]]
        for r in rows[1:]:
            if r - cur[-1] <= 3:
                cur.append(r)
            else:
                centers.append(sum(cur) / len(cur))
                cur = [r]
        centers.append(sum(cur) / len(cur))
        if len(centers) < 5:
            return []

        # Typical interline = median of small gaps between consecutive line centers.
        gaps = [centers[i + 1] - centers[i] for i in range(len(centers) - 1)]
        gaps_sorted = sorted(gaps)
        med_gap = gaps_sorted[len(gaps_sorted) // 2]
        if med_gap <= 0:
            return []
        # A break BETWEEN staves is a gap much larger than the interline.
        break_th = med_gap * 2.5

        groups: List[List[float]] = []
        cur_group = [centers[0]]
        for i in range(1, len(centers)):
            if centers[i] - centers[i - 1] > break_th:
                groups.append(cur_group)
                cur_group = [centers[i]]
            else:
                cur_group.append(centers[i])
        groups.append(cur_group)

        # Keep only groups of exactly 5 lines (a well-formed staff). If a group has a multiple
        # of 5 (two staves merged because the inter-staff gap was small), split it evenly.
        staves: List[List[float]] = []
        for grp in groups:
            if len(grp) == 5:
                staves.append([float(v) for v in grp])
            elif len(grp) > 5 and len(grp) % 5 == 0:
                for k in range(0, len(grp), 5):
                    staves.append([float(v) for v in grp[k : k + 5]])
            # groups that are not a clean multiple of 5 are dropped (noise / partial detection)
        return staves
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


# --- Full pipeline -----------------------------------------------------------------------

def _clef_for_staff_index(idx_in_system: int) -> str:
    """Within a grand staff, the upper staff is treble (G), the lower is bass (F). We pair
    consecutive detected staves; even index -> treble, odd -> bass."""
    return "G" if idx_in_system % 2 == 0 else "F"


def transcribe_geometric(image_path_or_gray) -> Optional[bytes]:
    """Tie it together: detect staves, detect noteheads per staff, decode each to a pitch by
    geometry, group chords, assign treble/bass, and emit a 1-part / 2-staff grand-staff
    MusicXML via llm_omr.score_json_to_musicxml. Returns MusicXML bytes, or None if nothing
    usable was found. NEVER raises.

    Measure structure: this geometric pass does NOT read barlines yet, so it places ALL of a
    staff's chords into a SINGLE measure per hand. The eval metric grades pitch per
    (measure, staff) multiset and is rhythm-agnostic, but a single bucket would lump every
    measure together; to keep the comparison fair against a multi-measure ground truth we
    distribute chords across measures EVENLY in time order (best-effort). The headline pitch
    /octave/chord numbers are what matter; exact bar placement is a later (barline) pass.
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

        # Pair staves into grand-staff systems: (treble, bass), (treble, bass), ...
        # treble accumulates all upper-staff chords, bass all lower-staff chords, in page
        # order. We then split each hand's chord stream into measures.
        treble_chords: List[List[Tuple[str, int, int]]] = []
        bass_chords: List[List[Tuple[str, int, int]]] = []

        for idx, staff_lines in enumerate(staves):
            sp = _interline(staff_lines)
            if sp is None:
                continue
            clef = _clef_for_staff_index(idx)
            heads = detect_noteheads(gray, staff_lines)
            if not heads:
                continue
            chords = group_chords(heads, sp)
            for chord in chords:
                pitches = []
                for (_x, y) in chord:
                    p = decode_pitch(y, staff_lines, clef)
                    if p is not None:
                        pitches.append(p)
                if not pitches:
                    continue
                if clef == "G":
                    treble_chords.append(pitches)
                else:
                    bass_chords.append(pitches)

        if not treble_chords and not bass_chords:
            return None

        measures = _chords_to_measures(treble_chords, bass_chords)
        if not measures:
            return None

        data = {
            "divisions": 4,
            "key_fifths": 0,
            "time": {"beats": 4, "beat_type": 4},
            "measures": measures,
        }
        return llm_omr.score_json_to_musicxml(data)
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
