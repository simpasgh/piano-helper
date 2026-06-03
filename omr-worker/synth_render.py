#!/usr/bin/env python3
"""Render a synthetic score (MusicXML bytes) to a training image PLUS pixel-exact notehead
labels, the data foundation for our own trained notehead detector.

Pipeline: verovio engraves the MusicXML to SVG (it knows the perfect notehead positions
because we generated the score), then a headless Chromium (Playwright) rasterizes that SVG
and, crucially, reports getBoundingClientRect() for every notehead glyph and staff line. The
browser is the reference SVG renderer, so those rectangles are the EXACT pixel boxes in the
screenshot's own coordinate space. That is why the labels are free and perfect: no nested
viewBox / transform / glyph-metric math, no hand-tuned notehead size. This is the crux the
roadmap calls out ("extract each notehead's bounding box from the rendered SVG ... sanity-check
by overlaying a few boxes on the render").

Why Chromium and not cairosvg: cairosvg needs a system libcairo that Windows (this GPU box)
does not have; Playwright Chromium is the portable, faithful rasterizer here.

This is dataset-GENERATION code (committed per the roadmap), run on the GPU PC. It is NOT the
never-raise prod worker: it raises loudly on a malformed render so a label bug cannot pass
silently into training data.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import List, Optional, Tuple

# Guarded so the pure label logic (RenderedScore / yolo_lines) imports and unit-tests even in an
# env without verovio (mirrors geom_omr's GEOM_AVAILABLE contract). engrave_svg checks the flag.
VEROVIO_AVAILABLE = False
try:
    import verovio
    # generate_random_score omits the visual <type> on notes (it grades pitch, not rhythm), so
    # verovio logs a harmless "Unsupported note-type-value ''" per note. Silence it so a big
    # build's log stays readable; the notes still engrave correctly (quarter spacing from duration).
    verovio.enableLog(False)
    VEROVIO_AVAILABLE = True
except Exception:
    pass

# A staff space (interline) in verovio user units at the default unit=9 (=> 2*unit*10). We do
# not hardcode it; we read it from the rendered staff lines. Kept here only as documentation.

# --- Multi-class symbol taxonomy ---------------------------------------------------------
# The YOLO classes the FULL-SYMBOL detector learns. This is the step past noteheads-only: the
# exact decode reads durations (head fill + stem + flag/beam + dot), key + per-note accidentals,
# clefs, and rests FROM the engraved glyphs, so each must be a detectable class.
#
# Design notes:
#   - Heads split filled vs open. Open covers half AND whole; whole-vs-half is recovered from STEM
#     presence (a whole note has no stem), so two head classes suffice.
#   - Accidentals keep the double variants (lossless). Key-signature accidentals are NOT a separate
#     class: they use the IDENTICAL glyph as an inline accidental, so they map to accidental_*; the
#     decode separates key-sig from inline by x-position (right after the clef vs after a notehead).
#   - flag / rest / timesig are one class each (the specific value is read geometrically / from the
#     surrounding beams + stem). clefs split G/F/C (incl. the mid-score "change" codepoints).
CLASS_NAMES = [
    "notehead_filled",          # 0  E0A4 noteheadBlack (quarter / eighth / shorter)
    "notehead_open",            # 1  E0A3 half, E0A2 whole, E0A0 double-whole
    "stem",                     # 2  (shape)
    "flag",                     # 3  any flagN
    "beam",                     # 4  (shape)
    "dot",                      # 5  augmentation dot (shape)
    "accidental_sharp",         # 6  E262
    "accidental_flat",          # 7  E260
    "accidental_natural",       # 8  E261
    "accidental_double_sharp",  # 9  E263
    "accidental_double_flat",   # 10 E264
    "clef_g",                   # 11 E050 gClef / E07A gClefChange
    "clef_f",                   # 12 E062 fClef / E07C fClefChange
    "clef_c",                   # 13 E05C cClef / E07B cClefChange
    "rest",                     # 14 any rest glyph
    "timesig",                  # 15 a single time-signature digit
    "tie",                      # 16 a tie / slur arc (shape)
    "ottava",                   # 17 an 8va / 8vb bracket (g.octave)
]
CLASS_INDEX = {name: i for i, name in enumerate(CLASS_NAMES)}

# SMuFL glyph code (hex, from a <use xlink:href="#XXXX-...">) -> class, for the glyph-bearing
# groups (notehead / accid / keyAccid / clef). Verified against rendered Verovio SVG.
_GLYPH_CLASS = {
    "E0A4": "notehead_filled",
    "E0A3": "notehead_open", "E0A2": "notehead_open", "E0A0": "notehead_open",
    "E262": "accidental_sharp", "E260": "accidental_flat", "E261": "accidental_natural",
    "E263": "accidental_double_sharp", "E264": "accidental_double_flat",
    "E050": "clef_g", "E07A": "clef_g",
    "E062": "clef_f", "E07C": "clef_f",
    "E05C": "clef_c", "E07B": "clef_c",
}
# CSS class (verovio <g class>) -> our class, for SHAPE groups (no glyph code) and for the
# glyph-bearing groups whose class is INDEPENDENT of the specific glyph code (flag/rest/meterSig).
_SHAPE_CLASS = {"stem": "stem", "beam": "beam", "dots": "dot", "tie": "tie", "octave": "ottava"}
_CODE_INDEPENDENT_CLASS = {"flag": "flag", "rest": "rest", "meterSig": "timesig"}
# Verovio groups that carry a glyph code we must look up to pick the class.
_CODE_DEPENDENT = ("notehead", "accid", "keyAccid", "clef")


def glyph_to_class(css_class: Optional[str], glyph_code: Optional[str]) -> Optional[int]:
    """Map one rendered verovio group (its CSS class + the SMuFL code of its first <use>, if any)
    to a YOLO class index, or None if it is not a class we label. PURE: this is the testable core
    of the multi-class label extraction (no browser needed). Key-signature accidentals (keyAccid)
    map to the same accidental_* classes as inline ones (identical glyph)."""
    base = (css_class or "").split()[0] if css_class else ""
    name: Optional[str] = None
    if base in _SHAPE_CLASS:
        name = _SHAPE_CLASS[base]
    elif base in _CODE_INDEPENDENT_CLASS:
        name = _CODE_INDEPENDENT_CLASS[base]
    elif base in _CODE_DEPENDENT:
        name = _GLYPH_CLASS.get((glyph_code or "").upper())
    return CLASS_INDEX.get(name) if name else None


# JS run inside the rendered page: collect the rendered pixel geometry of every SYMBOL glyph and
# every staff line, in the SAME coordinate space as the screenshot we take next. Each symbol is
# {cls (verovio css class), code (SMuFL hex of its first <use>, or null), x, y, w, h}; the pure
# glyph_to_class above turns (cls, code) into our YOLO class. Zero-area elements (e.g. verovio's
# empty <g class="accid"/> placeholder it emits for every note) are dropped here.
_MEASURE_JS = r"""
() => {
  const rectOf = (el) => { const r = el.getBoundingClientRect();
                           return [r.x, r.y, r.width, r.height]; };
  const codeOf = (el) => {
    const u = el.querySelector('use');
    if (!u) return null;
    const h = u.getAttribute('xlink:href') || u.getAttribute('href') || '';
    const m = h.match(/#([0-9A-Fa-f]{3,5})/);
    return m ? m[1].toUpperCase() : null;
  };
  // Interline (staff space) in px, to give thin shapes a sane minimum size: a stem is a vertical
  // line whose getBoundingClientRect WIDTH is ~0 (the stroke is excluded), so a w>0 filter would
  // drop almost every stem. Estimate the interline from the median staff-line gap.
  const lineYs = [...document.querySelectorAll('g.staff > path')]
    .map(p => p.getBoundingClientRect().y).sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < lineYs.length; i++) { const g = lineYs[i] - lineYs[i - 1]; if (g > 1) gaps.push(g); }
  gaps.sort((a, b) => a - b);
  const interline = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 10;
  const minDim = Math.max(2, interline * 0.15);  // ~a stem stroke width

  const symbols = [];
  const push = (el, cls, code) => {
    let [x, y, w, h] = rectOf(el);
    if (w <= 0 && h <= 0) return;  // truly empty (e.g. verovio's empty <g class="accid"/>)
    if (w < minDim) { x -= (minDim - w) / 2; w = minDim; }   // pad a hairline stem to a real box
    if (h < minDim) { y -= (minDim - h) / 2; h = minDim; }
    symbols.push({ cls, code, x, y, w, h });
  };
  const groups = 'g.notehead, g.accid, g.keyAccid, g.flag, g.clef, g.rest, ' +
                 'g.stem, g.beam, g.dots, g.tie, g.octave';
  document.querySelectorAll(groups).forEach((el) => {
    // A beamed run draws its notes' stems inside the beam group; skip a beam nested in another
    // beam so a single beam stack is not counted twice.
    if (el.classList.contains('beam') && el.parentElement &&
        el.parentElement.closest('g.beam')) return;
    push(el, (el.getAttribute('class') || '').split(' ')[0], codeOf(el));
  });
  // Time signature: one box PER digit (the <use> children of g.meterSig), not the whole stack.
  document.querySelectorAll('g.meterSig use').forEach((u) => push(u, 'meterSig', null));
  const staves = [...document.querySelectorAll('g.staff')].map(s =>
    [...s.querySelectorAll(':scope > path')].map(rectOf)
  );
  return { symbols, staves };
}
"""


@dataclass
class RenderedScore:
    """One rendered score: the PNG bytes plus pixel-space MULTI-CLASS labels. Each symbol is
    (class_idx, x, y, w, h) with (x, y) the top-left corner, in the screenshot's pixel space."""
    png: bytes
    width: int
    height: int
    symbols: List[Tuple[int, float, float, float, float]] = field(default_factory=list)
    staves: List[List[Tuple[float, float, float, float]]] = field(default_factory=list)

    def boxes_for(self, class_idx: int) -> List[Tuple[float, float, float, float]]:
        """The (x, y, w, h) boxes of one class."""
        return [(x, y, w, h) for (c, x, y, w, h) in self.symbols if c == class_idx]

    def noteheads(self) -> List[Tuple[float, float, float, float]]:
        """Filled + open notehead boxes (for the geometric decode / the overlay sanity-check)."""
        heads = {CLASS_INDEX["notehead_filled"], CLASS_INDEX["notehead_open"]}
        return [(x, y, w, h) for (c, x, y, w, h) in self.symbols if c in heads]

    def notehead_centers(self) -> List[Tuple[float, float]]:
        return [(x + w / 2.0, y + h / 2.0) for (x, y, w, h) in self.noteheads()]

    def class_counts(self) -> dict:
        """{class_name: count} over all symbols, for dataset-balance reporting."""
        out: dict = {}
        for (c, _x, _y, _w, _h) in self.symbols:
            out[CLASS_NAMES[c]] = out.get(CLASS_NAMES[c], 0) + 1
        return out

    def yolo_lines(self) -> List[str]:
        """YOLO label rows: 'class xc yc w h', all normalized to [0,1] by image size."""
        out = []
        for (cls, x, y, w, h) in self.symbols:
            xc = (x + w / 2.0) / self.width
            yc = (y + h / 2.0) / self.height
            out.append(f"{cls} {xc:.6f} {yc:.6f} {w / self.width:.6f} {h / self.height:.6f}")
        return out

    def staff_line_ys(self) -> List[List[float]]:
        """Per-staff list of the 5 staff-line y-centers (pixels), for decode / debugging."""
        res = []
        for lines in self.staves:
            ys = sorted(y + h / 2.0 for (x, y, w, h) in lines)
            res.append(ys)
        return res


def engrave_svg(
    musicxml: bytes,
    page_width: int = 2100,
    page_height: int = 60000,
    scale: int = 50,
) -> str:
    """MusicXML bytes -> single-page SVG string via verovio. page_height is a generous max with
    adjustPageHeight so the whole score lands on ONE page (we render page 1 only). Raises if the
    score does not fit on one page (so we never silently drop systems)."""
    if not VEROVIO_AVAILABLE:
        raise RuntimeError("verovio is not available in this environment")
    tk = verovio.toolkit()
    tk.setOptions({
        "pageWidth": page_width,
        "pageHeight": page_height,
        "scale": scale,
        "adjustPageHeight": True,
        "header": "none",
        "footer": "none",
        "breaks": "auto",
    })
    if not tk.loadData(musicxml.decode("utf-8")):
        raise ValueError("verovio.loadData failed on synthetic MusicXML")
    pages = tk.getPageCount()
    if pages != 1:
        raise ValueError(f"score spilled to {pages} pages; raise page_height or shrink the score")
    return tk.renderToSVG(1)


def _viewbox_wh(svg: str) -> Tuple[float, float]:
    """Read the inner definition-scale viewBox 'minx miny W H' -> (W, H) user units."""
    m = re.search(r'class="definition-scale"[^>]*viewBox="\s*([\d.+-]+)\s+([\d.+-]+)\s+([\d.+-]+)\s+([\d.+-]+)"', svg)
    if not m:
        # fall back to any viewBox on the document
        m = re.search(r'viewBox="\s*([\d.+-]+)\s+([\d.+-]+)\s+([\d.+-]+)\s+([\d.+-]+)"', svg)
    if not m:
        raise ValueError("no viewBox found in verovio SVG")
    return float(m.group(3)), float(m.group(4))


def _size_outer_svg(svg: str, w_px: int, h_px: int) -> str:
    """Force the OUTER <svg> width/height (px) so Chromium rasterizes at our chosen scale; the
    inner definition-scale viewBox then maps user units -> pixels uniformly. Raises if the
    substitution does not happen (e.g. a verovio version reorders the attributes), so a mis-sized
    render can never silently desync the labels from the pixels."""
    out, n = re.subn(
        r'(<svg\b[^>]*?)\swidth="[^"]*"\s+height="[^"]*"',
        rf'\1 width="{w_px}px" height="{h_px}px"',
        svg,
        count=1,
    )
    if n != 1:
        raise ValueError("could not set outer <svg> width/height; verovio attribute layout changed")
    return out


class ScoreRenderer:
    """Persistent headless-Chromium renderer (launch the browser once, reuse for many scores).

    Usage:
        with ScoreRenderer(px_per_interline=26) as r:
            rs = r.render(musicxml_bytes)
    """

    def __init__(self, px_per_interline: float = 26.0, interline_units: float = 180.0):
        # interline (staff space) is 180 verovio user units at scale-independent internal unit;
        # confirmed from the probe (staff lines at y=540,720,...). We scale so one interline maps
        # to px_per_interline pixels, giving every image an identical notehead pixel size.
        self._k = float(px_per_interline) / float(interline_units)
        self._pw = None
        self._browser = None
        self._page = None

    def __enter__(self):
        from playwright.sync_api import sync_playwright
        self._pw = sync_playwright().start()
        self._browser = self._pw.chromium.launch(args=["--force-color-profile=srgb"])
        self._page = self._browser.new_page(device_scale_factor=1)
        return self

    def __exit__(self, *exc):
        try:
            if self._browser:
                self._browser.close()
        finally:
            if self._pw:
                self._pw.stop()
        return False

    def render(self, musicxml: bytes, page_width: int = 2100,
               px_per_interline: Optional[float] = None) -> RenderedScore:
        # Optional per-call scale override (scale domain-randomization across the dataset so the
        # detector survives the varying resolutions of real phone photos).
        k = self._k if px_per_interline is None else float(px_per_interline) / 180.0
        svg = engrave_svg(musicxml, page_width=page_width)
        vbw, vbh = _viewbox_wh(svg)
        w_px = max(1, int(round(vbw * k)))
        h_px = max(1, int(round(vbh * k)))
        svg_sized = _size_outer_svg(svg, w_px, h_px)

        page = self._page
        page.set_viewport_size({"width": w_px, "height": h_px})
        html = (
            "<!doctype html><html><head><meta charset='utf-8'>"
            "<style>*{margin:0;padding:0;border:0}html,body{background:#fff}</style></head>"
            f"<body>{svg_sized}</body></html>"
        )
        page.set_content(html, wait_until="load")
        geo = page.evaluate(_MEASURE_JS)
        png = page.screenshot(clip={"x": 0, "y": 0, "width": w_px, "height": h_px})

        symbols: List[Tuple[int, float, float, float, float]] = []
        for s in geo["symbols"]:
            cls = glyph_to_class(s.get("cls"), s.get("code"))
            if cls is None:
                continue  # a verovio group we do not label (or an empty placeholder)
            symbols.append((cls, float(s["x"]), float(s["y"]), float(s["w"]), float(s["h"])))
        staves = [
            [(float(a), float(b), float(c), float(d)) for (a, b, c, d) in lines]
            for lines in geo["staves"]
        ]
        return RenderedScore(png=png, width=w_px, height=h_px, symbols=symbols, staves=staves)


# A distinct color per class for the overlay (RGB). Deterministic so the sanity-check images are
# stable across runs. Index-aligned with CLASS_NAMES.
_CLASS_COLORS = [
    (220, 30, 30), (30, 140, 30), (30, 90, 220), (200, 120, 0), (150, 30, 200),
    (0, 160, 160), (210, 0, 120), (120, 90, 40), (90, 90, 90), (210, 60, 60),
    (60, 60, 210), (0, 130, 70), (130, 0, 130), (170, 110, 0), (0, 100, 160),
    (190, 30, 90), (70, 150, 70), (150, 70, 150),
]


def draw_overlay(png: bytes,
                 symbols: List[Tuple[int, float, float, float, float]],
                 staff_lines: Optional[List[List[float]]] = None,
                 label: bool = True) -> bytes:
    """Draw the multi-class symbol boxes (one color per class) + optional staff-line marks (faint
    blue) on the PNG, for the visual label sanity-check the roadmap calls for. `symbols` is a list
    of (class_idx, x, y, w, h). Returns PNG bytes. NEVER part of the prod worker."""
    import io
    from PIL import Image, ImageDraw

    im = Image.open(io.BytesIO(png)).convert("RGB")
    d = ImageDraw.Draw(im)
    if staff_lines:
        for ys in staff_lines:
            for yy in ys:
                d.line([0, yy, im.width, yy], fill=(150, 180, 230), width=1)
    for (cls, x, y, w, h) in symbols:
        color = _CLASS_COLORS[cls % len(_CLASS_COLORS)]
        d.rectangle([x, y, x + w, y + h], outline=color, width=2)
        if label and 0 <= cls < len(CLASS_NAMES):
            d.text((x, max(0, y - 9)), CLASS_NAMES[cls][:6], fill=color)
    out = io.BytesIO()
    im.save(out, format="PNG")
    return out.getvalue()
