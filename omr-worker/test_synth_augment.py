#!/usr/bin/env python3
"""Tests for synth_augment: the photo-style augmentation must preserve image dimensions (so the
notehead boxes stay valid), always return a decodable PNG, and never raise."""
import io

import numpy as np
from PIL import Image

import synth_augment as sa


def _png(w=64, h=48, color=(255, 255, 255)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (w, h), color).save(buf, format="PNG")
    return buf.getvalue()


def test_augment_preserves_dimensions():
    src = _png(80, 50)
    out = sa.augment(src, seed=1)
    im = Image.open(io.BytesIO(out))
    assert im.size == (80, 50)


def test_augment_returns_valid_png():
    out = sa.augment(_png(), seed=7)
    assert out[:8] == b"\x89PNG\r\n\x1a\n"
    Image.open(io.BytesIO(out)).verify()


def test_augment_deterministic_for_seed():
    src = _png(70, 40)
    assert sa.augment(src, seed=5) == sa.augment(src, seed=5)


def test_augment_changes_pixels():
    # a flat white page must come back NOT perfectly flat white (paper tone / lighting / noise).
    src = _png(96, 64, (255, 255, 255))
    out = sa.augment(src, seed=3, strength=1.0)
    arr = np.asarray(Image.open(io.BytesIO(out)).convert("RGB"))
    assert arr.min() < 250  # something darkened the page


def test_augment_accepts_pil_image():
    im = Image.new("RGB", (32, 32), (255, 255, 255))
    out = sa.augment(im, seed=2)
    assert Image.open(io.BytesIO(out)).size == (32, 32)


def test_augment_never_raises_on_garbage():
    # not a valid image -> returns the bytes back, no exception
    out = sa.augment(b"not a png", seed=0)
    assert out == b"not a png"
