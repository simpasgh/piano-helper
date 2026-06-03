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


def _row_ink(gray) -> "np.ndarray":
    """Per-row ink fraction (fraction of dark pixels in each row)."""
    return (gray < 0.5).mean(axis=1)


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


def detect_systems(gray) -> List[List[float]]:
    """Detect EVERY 5-line staff group on the page. Returns a list of staves, each a list of
    5 staff-line y-centers (top-to-bottom). NEVER raises; returns [] on failure.

    Method: a staff line is a near-full-width dark row. Cluster contiguous dark rows into line
    centers (a thick line spans a few rows) and record each cluster's peak ink fraction, then hand
    the centers to _extract_staves, which pulls out runs of 5 evenly-spaced lines (rejecting
    intruder rows like beams / dense note rows / text that also clear the width threshold). This
    extends referee._staff_lines (which returns only the first 5) to the whole page and is robust
    to real engravings where a staff is detected as 6-7 lines.
    """
    if not GEOM_AVAILABLE or gray is None:
        return []
    try:
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

def detect_barlines(gray, staves: List[List[float]]) -> List[List[float]]:
    """Detect barline x-positions per grand-staff pair. Returns a list aligned with `staves`:
    out[i] is the sorted barline x-centers for the grand staff staff i belongs to (the treble and
    bass of a pair share one list). NEVER raises; returns empty lists on failure so the decode
    falls back to even binning.

    A barline is a near-vertical dark run spanning the FULL grand-staff height (treble top to bass
    bottom). The discriminator vs a stem is the INTER-STAFF GAP: a stem lives inside one staff, but
    a barline crosses the blank gap between the treble and bass staves, so requiring high dark
    coverage over the whole pair height rejects stems, beams, and noteheads. Pairs staves as
    (treble=2i, bass=2i+1), matching _clef_for_staff_index. A column is a barline if it is dark
    over >70% of the pair height AND narrow (a few px); a wide dark run is a beam/blob, not a line.
    """
    out: List[List[float]] = [[] for _ in staves]
    if not GEOM_AVAILABLE or gray is None or not staves:
        return out
    try:
        h, w = gray.shape
        mask = gray < 0.5
        npairs = (len(staves) + 1) // 2
        for pi in range(npairs):
            ti, bi = 2 * pi, 2 * pi + 1
            top = sorted(float(v) for v in staves[ti])
            bot = sorted(float(v) for v in staves[bi]) if bi < len(staves) else top
            y0 = max(0, int(round(top[0])))
            y1 = min(h - 1, int(round(bot[-1])))
            if y1 - y0 < 4:
                continue
            sp = _interline(top) or 1.0
            band = mask[y0:y1 + 1, :]
            cov = band.sum(axis=0) / float(band.shape[0])  # per-column dark fraction over the pair
            barcol = cov > 0.7
            xs: List[float] = []
            maxw = max(2, int(round(0.6 * sp)))
            x = 0
            while x < w:
                if barcol[x]:
                    s = x
                    while x < w and barcol[x]:
                        x += 1
                    if (x - s) <= maxw:  # thin -> a line; wide -> a beam/blob, skip
                        xs.append((s + x - 1) / 2.0)
                else:
                    x += 1
            xs.sort()
            for idx in (ti, bi):
                if idx < len(staves):
                    out[idx] = xs
        return out
    except Exception:
        return [[] for _ in staves]


# --- Full pipeline -----------------------------------------------------------------------

def _clef_for_staff_index(idx_in_system: int) -> str:
    """Within a grand staff, the upper staff is treble (G), the lower is bass (F). We pair
    consecutive detected staves; even index -> treble, odd -> bass."""
    return "G" if idx_in_system % 2 == 0 else "F"


def _decode_staves_to_musicxml(
    staves: List[List[float]],
    per_staff_heads: List[List[Tuple[float, float]]],
    key_fifths: int = 0,
    gray=None,
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

    Returns MusicXML bytes, or None if nothing usable was found. NEVER raises.
    """
    try:
        barlines = detect_barlines(gray, staves) if gray is not None else [[] for _ in staves]

        def staff_chords(idx, clef):
            # [(rep_x, [pitch...]), ...] for one staff, x-ordered. Keeping each chord's center x
            # is what lets _segment_to_measures place it into the right bar.
            if idx >= len(staves):
                return []
            sp = _interline(staves[idx])
            if sp is None:
                return []
            heads = per_staff_heads[idx] if idx < len(per_staff_heads) else []
            out = []
            for chord in group_chords(heads, sp):
                pitches, xs = [], []
                for (x, y) in chord:
                    p = decode_pitch(y, staves[idx], clef, fifths=key_fifths)
                    if p is not None:
                        pitches.append(p)
                        xs.append(x)
                if pitches:
                    out.append((sum(xs) / len(xs), pitches))
            return out

        # Process each grand-staff PAIR (treble=2i, bass=2i+1) as one system, segmenting its chords
        # into measures by that system's detected barlines; concatenate measures across systems.
        measures: List[dict] = []
        any_chord = False
        for pi in range((len(staves) + 1) // 2):
            ti, bi = 2 * pi, 2 * pi + 1
            treble = staff_chords(ti, "G")
            bass = staff_chords(bi, "F")
            if treble or bass:
                any_chord = True
            blx = barlines[ti] if ti < len(barlines) else []
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
