#!/usr/bin/env python3
"""Photo-style augmentation to bridge the sim-to-real gap for the notehead detector.

Verovio renders are pristine; real input is a PHONE PHOTO of a physical page: uneven lighting,
paper grain, soft shadows, motion blur, sensor noise, and JPEG artifacts. Training only on clean
renders overfits to clean input, so we domain-randomize toward photos. These transforms are all
PHOTOMETRIC (they change pixels, not geometry), so the notehead boxes are UNCHANGED -- the
geometric jitter (perspective/rotation/scale) is left to YOLO's online augmentation, which warps
boxes correctly. Keeping augmentation box-preserving here avoids any label drift.

numpy + PIL only (both already required). Deterministic given a seed so a dataset rebuild is
reproducible. Each effect fires with its own probability; intensities are mild and stacked.
"""
from __future__ import annotations

import io
from typing import Optional

import numpy as np
from PIL import Image


def _smooth_field(h: int, w: int, rng: np.random.Generator, lo: int = 3) -> np.ndarray:
    """A low-frequency field in [0,1]: random lo x lo grid bilinearly upsampled to (h, w). Used
    for paper tone and lighting gradients (both are smooth, large-scale intensity variations)."""
    grid = rng.random((lo, lo)).astype(np.float32)
    return np.asarray(Image.fromarray((grid * 255).astype(np.uint8)).resize((w, h), Image.BILINEAR),
                      dtype=np.float32) / 255.0


def augment(png_or_image, seed: int, strength: float = 1.0) -> bytes:
    """Apply a randomized photo-style pipeline. Accepts PNG bytes or a PIL image; returns PNG
    bytes. Boxes/labels are unaffected (photometric only). NEVER raises; returns input on error."""
    try:
        if isinstance(png_or_image, (bytes, bytearray)):
            im = Image.open(io.BytesIO(png_or_image)).convert("RGB")
        else:
            im = png_or_image.convert("RGB")
        rng = np.random.default_rng(seed)
        arr = np.asarray(im, dtype=np.float32) / 255.0
        h, w, _ = arr.shape

        # 1) Paper tone: tint toward an off-white/cream and modulate by a smooth grain field, so
        #    the "white" background is no longer a flat 1.0 (real paper never is).
        if rng.random() < 0.9:
            tone = 0.85 + 0.15 * _smooth_field(h, w, rng)[..., None]   # [0.85,1.0] field
            cream = np.array([1.0, 0.985, 0.94], dtype=np.float32)     # subtle warm paper
            arr = arr * tone * cream

        # 2) Uneven lighting / soft shadow gradient across the page.
        if rng.random() < 0.8:
            light = 0.6 + 0.4 * _smooth_field(h, w, rng, lo=2)[..., None]  # [0.6,1.0]
            arr = arr * (1.0 - 0.5 * strength) + arr * light * (0.5 * strength) + arr * 0.0
            arr = arr * (0.7 + 0.3 * light)

        # 3) A hard-ish cast shadow band (e.g. the photographer's hand / page curl).
        if rng.random() < 0.35:
            band = _smooth_field(h, w, rng, lo=4)[..., None]
            shadow = 1.0 - 0.35 * strength * (band > 0.6)
            arr = arr * shadow

        # 4) Mild blur (focus / motion). Done via PIL after recomposing.
        arr = np.clip(arr, 0.0, 1.0)
        im2 = Image.fromarray((arr * 255).astype(np.uint8))
        if rng.random() < 0.6:
            from PIL import ImageFilter
            radius = float(rng.uniform(0.4, 1.6) * strength)
            im2 = im2.filter(ImageFilter.GaussianBlur(radius=radius))

        arr = np.asarray(im2, dtype=np.float32) / 255.0
        # 5) Sensor noise (gaussian) + a touch of per-pixel speckle.
        if rng.random() < 0.8:
            sigma = float(rng.uniform(0.005, 0.03) * strength)
            arr = arr + rng.normal(0.0, sigma, arr.shape).astype(np.float32)
        arr = np.clip(arr, 0.0, 1.0)

        out_im = Image.fromarray((arr * 255).astype(np.uint8))
        # 6) JPEG recompression artifacts (real photos are JPEGs).
        buf = io.BytesIO()
        if rng.random() < 0.85:
            q = int(rng.integers(35, 80))
            out_im.save(buf, format="JPEG", quality=q)
            out_im = Image.open(buf).convert("RGB")
            buf = io.BytesIO()
        out_im.save(buf, format="PNG")
        return buf.getvalue()
    except Exception:
        # Never corrupt a build: fall back to the original bytes if anything goes wrong.
        if isinstance(png_or_image, (bytes, bytearray)):
            return bytes(png_or_image)
        b = io.BytesIO()
        png_or_image.convert("RGB").save(b, format="PNG")
        return b.getvalue()
