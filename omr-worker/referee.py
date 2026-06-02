#!/usr/bin/env python3
"""Free visual-diff PDF referee (Slice 6, PURE module): a tiebreaker that arbitrates
isolated-notehead PITCH disputes the free heuristics in reconcile.py cannot confidently
resolve, by re-engraving each candidate with Verovio and scoring which rendering's notehead
POSITION best matches the original PDF crop.

Design + the Slice 5 real-PDF validation that justifies the scope and threshold live in
docs/context/tech-lead.md (the "free visual-diff PDF referee" design entry, the Slice 5
spike entry, and the Slice 5 real-PDF validation entry with the GO call). This module is a
faithful port of the validated throwaway harness /tmp/referee_real3.py.

THIS slice is PURE module + tests only. It is NOT wired into worker.py or reconcile.py yet
(mirrors how Slice 2 built reconcile.py pure before Slice 3 wired it). With the code present
but not called, and Verovio not yet installed on the prod worker, prod is unaffected.

THE METHOD (validated on 4 real MuseScore PDFs, cross-font Leland-vs-Leipzig):
  - Register candidate-to-original by STAFF (align the top staff line + scale by interline).
    A pitch dispute IS the vertical position, so we do NOT vertical-slide the template.
  - SUPPRESS the 5 staff-line rows in BOTH crops (the identical lines otherwise dominate
    the cross-correlation and drown the notehead).
  - Score = best normalized cross-correlation (NCC) over a SMALL HORIZONTAL slide only
    (absorbs x-registration error). This makes the score driven by notehead POSITION,
    which is font- and scan-robust.
  - DECLINE (return None) unless the winner beats the loser by a confidence margin. A
    low-margin or noisy comparison must never guess.

SCOPE (validated): fire ONLY on isolated-notehead pitch disputes of an OCTAVE (rock-solid)
or a THIRD-or-larger interval (strong, gated by the margin). DECLINE step/2nd disputes
(margin erodes to negative under a quarter-interline vertical misregistration), all
duration disputes, and dense/beamed regions.

NEVER-RAISE CONTRACT: every public function wraps its work so any failure (import missing,
render error, bad crop, cairo error) returns the SAFE DEFAULT (None / decline / False),
never throws. The prod worker does not have Verovio, so the module must import cleanly even
when verovio/cairosvg are absent (REFEREE_AVAILABLE then reports False and callers degrade).
"""

from __future__ import annotations

import io
from typing import Optional, Tuple

# --- Guarded imports ---------------------------------------------------------------------
# The prod worker venv does NOT have verovio yet (a separate infra task installs it + the
# system libcairo2 on the cx33 box). NEVER let an ImportError escape: if either dependency
# is missing the module must still import fine and expose REFEREE_AVAILABLE=False so callers
# (and the tests) can degrade. numpy is already in requirements.txt (both engines need it),
# but we guard it too so a degenerate env still imports.
REFEREE_AVAILABLE = False
_IMPORT_ERROR: Optional[str] = None

try:
    import numpy as np  # noqa: F401  (used throughout when available)
    import verovio  # noqa: F401
    import cairosvg  # noqa: F401
    from PIL import Image  # noqa: F401
    from scipy import ndimage  # noqa: F401

    REFEREE_AVAILABLE = True
except Exception as exc:  # pragma: no cover - exercised only in a verovio-less env
    # Catch Exception (not just ImportError) so a half-broken native dep (e.g. cairocffi
    # failing to dlopen libcairo at import) also degrades instead of crashing the worker.
    _IMPORT_ERROR = repr(exc)


# --- Tunables (validated in Slice 5; see tech-lead.md) -----------------------------------

# Decline-on-low-margin threshold. The winner must beat the loser's NCC by at least this to
# be returned; otherwise referee_pick returns None (decline). Slice 5 real-PDF baseline
# margins were +0.30..+0.62 for octave/third on clean input, so 0.10 leaves wide headroom
# while still declining the noisy/ambiguous comparisons that erode below it.
MARGIN_THRESHOLD = 0.10

# A pitch dispute is "refereeable" only at an octave or a third-or-larger interval. A step
# (2nd) is too tight: its margin goes negative under a quarter-interline vertical error.
MIN_REFEREEABLE_SEMITONES = 3  # a minor third; steps (1-2 semitones) are out of scope.

# Verovio engraving font. The original may be ANY engraver (cross-font is the real case);
# the position-based method is font-robust, so the candidate font choice is not load-bearing.
_VEROVIO_FONT = "Leipzig"

# Worker rasterization DPI. The candidate render is rescaled to the ORIGINAL crop's detected
# interline before comparison, so absolute DPI parity is not required for correctness; we
# still default to the worker's 350 DPI so a standalone candidate render has glyph sizes in
# the same ballpark as the worker's PDF rasterization (the validated harness convention).
WORKER_DPI = 350

# Staff-relative crop extent, in interlines above the top line / below the bottom line.
_ABOVE = 5
_BELOW = 5

_STEPS = ("C", "D", "E", "F", "G", "A", "B")
# Semitone offset of each diatonic step within an octave (C=0).
_STEP_SEMITONE = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}

# Minimal one-note / one-measure MusicXML. EMPTY <part-name> is REQUIRED: a "P" part label
# otherwise contaminates the crop (Slice 5 gotcha). The clef sign/line are filled per call.
_XML_TMPL = """<?xml version="1.0"?>
<score-partwise version="3.1"><part-list><score-part id="P1"><part-name></part-name></score-part></part-list>
<part id="P1"><measure number="1"><attributes><divisions>4</divisions>
<key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time>
<clef><sign>{clef_sign}</sign><line>{clef_line}</line></clef></attributes>
<note><pitch><step>{step}</step><octave>{octave}</octave></pitch><duration>16</duration><type>whole</type></note>
</measure></part></score-partwise>"""

_CLEF_LINE = {"G": 2, "F": 4, "C": 3}


# --- Scope predicates (PURE, no verovio dependency) --------------------------------------

def pitch_interval_semitones(pitch_a, pitch_b) -> Optional[int]:
    """Absolute semitone distance between two (step, alter, octave) tuples, or None if
    either is malformed/None. PURE; works without verovio. Used to classify a dispute."""
    try:
        midi_a = _pitch_tuple_to_midi(pitch_a)
        midi_b = _pitch_tuple_to_midi(pitch_b)
        if midi_a is None or midi_b is None:
            return None
        return abs(midi_a - midi_b)
    except Exception:
        return None


def is_refereeable_dispute(
    interval_semitones: Optional[int],
    is_isolated: bool,
    is_pitch_dispute: bool,
) -> bool:
    """True ONLY for an isolated-notehead PITCH dispute of an octave or a third-or-larger
    interval. PURE; no verovio needed, so callers can gate cheaply BEFORE any render.

    Validated scope (see tech-lead.md Slice 5):
      - octave (12 semitones): solid, fire.
      - third-or-larger (>= 3 semitones): ok, paired with the margin gate in referee_pick.
      - step / 2nd (1-2 semitones): ALWAYS decline (margin erodes negative under jitter).
      - duration disputes (is_pitch_dispute False): out of scope, weak pixel signal.
      - dense/beamed (is_isolated False): the wrong head slides onto a neighbor; decline.

    Never raises; returns False on any malformed input.
    """
    try:
        if not is_pitch_dispute:
            return False
        if not is_isolated:
            return False
        if interval_semitones is None:
            return False
        if interval_semitones < MIN_REFEREEABLE_SEMITONES:
            return False
        return True
    except Exception:
        return False


def _pitch_tuple_to_midi(pitch) -> Optional[int]:
    """(step, alter, octave) -> MIDI number, or None if malformed. PURE."""
    try:
        step, alter, octave = pitch
        step = str(step).upper()
        if step not in _STEP_SEMITONE:
            return None
        return 12 * (int(octave) + 1) + _STEP_SEMITONE[step] + int(alter)
    except Exception:
        return None


# --- Rendering ---------------------------------------------------------------------------

def render_candidate(
    step: str,
    octave: int,
    clef: str = "G",
    alter: int = 0,
    dpi: int = WORKER_DPI,
):
    """Engrave a minimal one-note/one-measure MusicXML for `step``octave` in `clef` with
    Verovio -> SVG -> rasterize via cairosvg, COMPOSITED ON A WHITE BACKGROUND first (the
    transparent-bg gotcha: cairosvg renders a transparent bg and Verovio emits no white
    rect, so a naive grayscale read turns the page all-black).

    Returns a float32 grayscale ndarray in [0, 1] (0=ink, 1=white), or None on ANY failure.
    Never raises.

    `dpi` controls the render resolution so glyph sizes track the worker's 350 DPI
    rasterization; the comparison in referee_pick rescales the candidate to the original
    crop's interline anyway, so this only needs to be in the same ballpark.
    """
    if not REFEREE_AVAILABLE:
        return None
    try:
        clef = str(clef).upper()
        clef_line = _CLEF_LINE.get(clef, 2)
        xml = _XML_TMPL.format(
            clef_sign=clef, clef_line=clef_line,
            step=str(step).upper(), octave=int(octave),
        )
        toolkit = verovio.toolkit()
        toolkit.setOptions({
            "pageWidth": 2000,
            "pageHeight": 1200,
            "scale": 40,
            "adjustPageHeight": True,
            "adjustPageWidth": True,
            "header": "none",
            "footer": "none",
            "font": _VEROVIO_FONT,
        })
        if not toolkit.loadData(xml):
            return None
        svg = toolkit.renderToSVG(1)
        if not svg:
            return None
        # Scale the raster width with DPI so the glyph is sized like a 350 DPI worker render.
        # The validated harness used output_width=1600 at the default 350; scale linearly.
        output_width = max(200, int(round(1600 * (dpi / float(WORKER_DPI)))))
        png = cairosvg.svg2png(
            bytestring=svg.encode("utf-8"),
            background_color="white",
            output_width=output_width,
        )
        return _png_to_white_composited_gray(png)
    except Exception:
        return None


def _png_to_white_composited_gray(png_bytes):
    """PNG bytes -> float32 grayscale ndarray in [0,1], compositing any alpha onto white
    first. Returns None on failure. Never raises."""
    if not REFEREE_AVAILABLE:
        return None
    try:
        im = Image.open(io.BytesIO(png_bytes))
        if im.mode in ("RGBA", "LA"):
            bg = Image.new("RGB", im.size, "white")
            bg.paste(im, mask=im.split()[-1])
            im = bg
        return np.asarray(im.convert("L"), dtype=np.float32) / 255.0
    except Exception:
        return None


# --- Image analysis primitives (faithful port of /tmp/referee_real3.py) -------------------

def _staff_lines(gray, x0=None, x1=None):
    """Detect the 5 staff-line y-centers: rows that are near-full-width ink. Returns
    (interline, [y0..y4]) or (None, lines) if fewer than 5 are found. Never raises."""
    try:
        h, w = gray.shape
        if x0 is None:
            x0, x1 = 0, w
        sub = gray[:, x0:x1]
        roww = (sub < 0.5).sum(axis=1)
        th = 0.5 * (x1 - x0)
        rows = [i for i, v in enumerate(roww) if v > th]
        if not rows:
            return None, None
        clusters, cur = [], [rows[0]]
        for r in rows[1:]:
            if r - cur[-1] <= 3:
                cur.append(r)
            else:
                clusters.append(sum(cur) / len(cur))
                cur = [r]
        clusters.append(sum(cur) / len(cur))
        if len(clusters) < 5:
            return None, clusters
        return (clusters[4] - clusters[0]) / 4, clusters[:5]
    except Exception:
        return None, None


def _find_notehead_x(gray, sp):
    """Find the candidate notehead x by connected components after removing staff lines and
    the clef/key/meter zone. In a one-note measure the meter "4/4" digits are notehead-sized
    blobs, so take the RIGHTMOST qualifying blob (the notehead sits right of the meter), and
    binary-close vertically first so an OPEN notehead ring split by a removed staff line
    rejoins. Returns the notehead x center, or None. Never raises."""
    try:
        mask = (gray < 0.5)
        roww = mask.sum(axis=1)
        g2 = mask.copy()
        g2[roww > 0.5 * gray.shape[1], :] = False  # remove staff lines
        g2 = ndimage.binary_closing(
            g2, structure=np.ones((max(1, int(sp * 0.3)), 1))
        )
        g2[:, : int(0.40 * gray.shape[1])] = False  # remove clef/key/meter zone
        lbl, n = ndimage.label(g2)
        cands = []
        for i in range(1, n + 1):
            ys, xs = np.where(lbl == i)
            ww = xs.max() - xs.min() + 1
            hh = ys.max() - ys.min() + 1
            if 0.6 * sp < ww < 2.6 * sp and 0.5 * sp < hh < 2.2 * sp and len(ys) > 0.3 * ww * hh:
                cands.append((xs.mean(), len(ys)))
        if not cands:
            return None
        return max(cands, key=lambda c: c[0])[0]  # rightmost = the notehead
    except Exception:
        return None


def _suppress_lines(gray, lines, sp):
    """Set a ~0.1-interline band around each staff line to white so the notehead/stem glyph
    drives the NCC, not the 5 identical lines. Returns a copy. Never raises."""
    try:
        out = gray.copy()
        band = max(1, int(round(sp * 0.10)))
        for ly in lines:
            y = int(round(ly))
            out[max(0, y - band): y + band + 1, :] = 1.0
        return out
    except Exception:
        return gray


def _ncc(a, b):
    """Normalized cross-correlation of two equal-shape arrays. 0 on a degenerate input."""
    a = a.astype(np.float64) - a.mean()
    b = b.astype(np.float64) - b.mean()
    da = np.sqrt((a * a).sum())
    db = np.sqrt((b * b).sum())
    if da == 0 or db == 0:
        return 0.0
    return float((a * b).sum() / (da * db))


def _hslide_best(template, region, max_dx):
    """Best NCC of template vs region over a small HORIZONTAL slide only (+/- max_dx px).
    Vertical is NOT slid: a pitch dispute IS the vertical position. Returns -2.0 if the
    crops are not the same height (a registration failure). Never raises."""
    try:
        th, tw = template.shape
        rh, rw = region.shape
        if th != rh:
            return -2.0
        best = -2.0
        for dx in range(-max_dx, max_dx + 1):
            if dx < 0:
                t, r = template[:, -dx:], region[:, : tw + dx]
            elif dx > 0:
                t, r = template[:, : tw - dx], region[:, dx:]
            else:
                t, r = template, region
            w = min(t.shape[1], r.shape[1])
            if w < 3:
                continue
            # Compare INK (1 - gray) so the correlation is over notehead presence.
            best = max(best, _ncc(1.0 - t[:, :w], 1.0 - r[:, :w]))
        return best
    except Exception:
        return -2.0


# --- Crop builders -----------------------------------------------------------------------

def _original_band(pdf_crop, staff_geometry):
    """Build the staff-suppressed original comparison band from the disputed-note crop.

    `staff_geometry` carries the KNOWN staff geometry for this crop (the caller detects it
    once per system; we do not re-detect on the original to avoid registration drift):
        {"lines": [y0,y1,y2,y3,y4], "x_center": <notehead x in the crop>}
    All coordinates are in `pdf_crop` pixel space. Returns (band, sp, height, width) or
    None. Never raises.
    """
    try:
        lines = [float(v) for v in staff_geometry["lines"]]
        if len(lines) < 5:
            return None
        x_center = float(staff_geometry["x_center"])
        sp = (lines[4] - lines[0]) / 4
        if sp <= 0:
            return None
        half = int(round(sp * 1.0))
        y0 = int(round(lines[0] - _ABOVE * sp))
        y1 = int(round(lines[4] + _BELOW * sp))
        x0 = int(round(x_center - half))
        x1 = int(round(x_center + half))
        h, w = pdf_crop.shape
        y0, y1 = max(0, y0), min(h, y1)
        x0, x1 = max(0, x0), min(w, x1)
        if y1 - y0 < 3 or x1 - x0 < 3:
            return None
        band = pdf_crop[y0:y1, x0:x1]
        band = _suppress_lines(band, [l - y0 for l in lines], sp)
        return band, sp, (y1 - y0), (x1 - x0)
    except Exception:
        return None


def _candidate_band(candidate_gray, target_sp, target_h, target_w):
    """Render-space candidate -> a staff-registered, staff-suppressed band matching the
    original band's (sp, h, w). Detects the candidate's staff, rescales interline to the
    original, locates its notehead, crops the same staff-relative band. Returns the band
    ndarray or None. Never raises."""
    try:
        if candidate_gray is None:
            return None
        sp, lines = _staff_lines(candidate_gray)
        if sp is None or not lines or len(lines) < 5 or sp <= 0:
            return None
        scale = target_sp / sp
        nh = max(3, int(candidate_gray.shape[0] * scale))
        nw = max(3, int(candidate_gray.shape[1] * scale))
        resized = np.asarray(
            Image.fromarray((candidate_gray * 255).astype(np.uint8)).resize(
                (nw, nh), Image.BILINEAR
            ),
            dtype=np.float32,
        ) / 255.0
        sp2, lines2 = _staff_lines(resized)
        if sp2 is None or not lines2 or len(lines2) < 5:
            return None
        nx = _find_notehead_x(resized, target_sp)
        if nx is None:
            return None
        half = target_w // 2
        cx0 = max(0, int(round(nx - half)))
        cx1 = min(resized.shape[1], cx0 + target_w)
        y0 = max(0, int(round(lines2[0] - _ABOVE * target_sp)))
        y1 = min(resized.shape[0], int(round(lines2[4] + _BELOW * target_sp)))
        if y1 - y0 < 3 or cx1 - cx0 < 3:
            return None
        band = resized[y0:y1, cx0:cx1]
        band = _suppress_lines(band, [l - y0 for l in lines2], target_sp)
        # Exact-fit to the original band dims so the compare is staff-registered.
        band = np.asarray(
            Image.fromarray((np.clip(band, 0, 1) * 255).astype(np.uint8)).resize(
                (target_w, target_h), Image.BILINEAR
            ),
            dtype=np.float32,
        ) / 255.0
        return band
    except Exception:
        return None


# --- The referee -------------------------------------------------------------------------

def score_candidate(pdf_crop, staff_geometry, candidate_gray) -> Optional[float]:
    """Score ONE candidate render against the original crop (staff-registered, lines
    suppressed, horizontal-slide NCC). Returns the NCC in [-1, 1], or None on failure.
    Never raises. Exposed for tests + diagnostics."""
    if not REFEREE_AVAILABLE:
        return None
    try:
        built = _original_band(pdf_crop, staff_geometry)
        if built is None:
            return None
        band, sp, bh, bw = built
        cand = _candidate_band(candidate_gray, sp, bh, bw)
        if cand is None:
            return None
        max_dx = max(2, int(sp * 0.5))
        score = _hslide_best(cand, band, max_dx)
        if score <= -1.5:  # registration failure sentinel
            return None
        return score
    except Exception:
        return None


def referee_pick(pdf_crop, staff_geometry, candidate_a, candidate_b) -> Optional[str]:
    """Decide which candidate's notehead best matches the original PDF crop.

    Args:
        pdf_crop: float32 grayscale ndarray in [0,1] of the disputed-note neighborhood from
            the ORIGINAL PDF raster (0=ink, 1=white).
        staff_geometry: {"lines": [y0..y4], "x_center": <notehead x>} in pdf_crop pixels.
        candidate_a, candidate_b: candidate render grayscale ndarrays from render_candidate
            (each may be None if its render failed).

    Returns 'a' or 'b' if the winner beats the loser by NCC margin >= MARGIN_THRESHOLD;
    otherwise None (DECLINE). DECLINE is the safe default: a low-margin or noisy comparison
    must NEVER guess. Returns None if Verovio is unavailable or anything fails. Never raises.
    """
    if not REFEREE_AVAILABLE:
        return None
    try:
        score_a = score_candidate(pdf_crop, staff_geometry, candidate_a)
        score_b = score_candidate(pdf_crop, staff_geometry, candidate_b)
        if score_a is None or score_b is None:
            return None  # a candidate could not be scored -> decline
        margin = abs(score_a - score_b)
        if margin < MARGIN_THRESHOLD:
            return None  # too close to call -> decline
        return "a" if score_a > score_b else "b"
    except Exception:
        return None
