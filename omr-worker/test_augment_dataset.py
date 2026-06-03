#!/usr/bin/env python3
"""Test the pure path logic in augment_dataset (deriving the YOLO labels dir from the images dir).
The actual augmentation/IO is covered by the dataset build, not unit tests."""
import os

import pytest

import augment_dataset as ad


def test_labels_dir_basic():
    assert ad._labels_dir("a/b/images/train") == os.path.normpath("a/b/labels/train")


def test_labels_dir_replaces_last_images_segment():
    # a path that contains 'images' twice: only the LAST one becomes 'labels'
    assert ad._labels_dir("images/x/images/val") == os.path.normpath("images/x/labels/val")


def test_labels_dir_backslashes():
    assert ad._labels_dir("C:\\x\\images\\val") == os.path.normpath("C:/x/labels/val")


def test_labels_dir_trailing_slash():
    assert ad._labels_dir("a/images/train/") == os.path.normpath("a/labels/train")


def test_labels_dir_raises_without_images_segment():
    # no 'images' segment -> must raise, not silently co-mingle labels into the image dir
    with pytest.raises(ValueError):
        ad._labels_dir("C:/data/aug_train")
