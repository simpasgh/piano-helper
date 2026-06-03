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

# JS run inside the rendered page: collect the rendered pixel geometry of every notehead glyph
# and every staff line, in the SAME coordinate space as the screenshot we take next.
_MEASURE_JS = r"""
() => {
  const rectOf = (el) => { const r = el.getBoundingClientRect();
                           return [r.x, r.y, r.width, r.height]; };
  const noteheads = [...document.querySelectorAll('g.notehead')].map(rectOf);
  const staves = [...document.querySelectorAll('g.staff')].map(s =>
    [...s.querySelectorAll(':scope > path')].map(rectOf)
  );
  return { noteheads, staves };
}
"""


@dataclass
class RenderedScore:
    """One rendered score: the PNG bytes plus pixel-space labels (top-left x,y,w,h)."""
    png: bytes
    width: int
    height: int
    noteheads: List[Tuple[float, float, float, float]] = field(default_factory=list)
    staves: List[List[Tuple[float, float, float, float]]] = field(default_factory=list)

    def notehead_centers(self) -> List[Tuple[float, float]]:
        return [(x + w / 2.0, y + h / 2.0) for (x, y, w, h) in self.noteheads]

    def yolo_lines(self, cls: int = 0) -> List[str]:
        """YOLO label rows: 'cls xc yc w h', all normalized to [0,1] by image size."""
        out = []
        for (x, y, w, h) in self.noteheads:
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

        noteheads = [(float(a), float(b), float(c), float(d)) for (a, b, c, d) in geo["noteheads"]]
        staves = [
            [(float(a), float(b), float(c), float(d)) for (a, b, c, d) in lines]
            for lines in geo["staves"]
        ]
        return RenderedScore(png=png, width=w_px, height=h_px, noteheads=noteheads, staves=staves)


def draw_overlay(png: bytes, boxes: List[Tuple[float, float, float, float]],
                 staff_lines: Optional[List[List[float]]] = None) -> bytes:
    """Draw notehead boxes (red) + optional staff-line marks (blue) on the PNG, for the visual
    label sanity-check. Returns PNG bytes. (top-left x,y,w,h boxes.)"""
    import io
    from PIL import Image, ImageDraw

    im = Image.open(io.BytesIO(png)).convert("RGB")
    d = ImageDraw.Draw(im)
    for (x, y, w, h) in boxes:
        d.rectangle([x, y, x + w, y + h], outline=(220, 30, 30), width=2)
        d.line([x + w / 2, y, x + w / 2, y + h], fill=(220, 30, 30), width=1)  # center vline
    if staff_lines:
        for ys in staff_lines:
            for yy in ys:
                d.line([0, yy, im.width, yy], fill=(40, 90, 220), width=1)
    out = io.BytesIO()
    im.save(out, format="PNG")
    return out.getvalue()
