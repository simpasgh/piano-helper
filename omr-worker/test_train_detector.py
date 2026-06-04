#!/usr/bin/env python3
"""Tests for train_detector's CLI parser, focused on the --workers Windows fix. Pure: importing
train_detector pulls in argparse only (ultralytics is imported inside train(), never at parse
time), so this runs without torch/ultralytics/GPU."""

import train_detector


def test_workers_defaults_to_zero():
    # 0 is the Windows fix: the default ultralytics workers=8 hangs the dataloader pre-epoch-1.
    args = train_detector.build_parser().parse_args(["--data", "d.yaml"])
    assert args.workers == 0


def test_workers_override():
    args = train_detector.build_parser().parse_args(["--data", "d.yaml", "--workers", "4"])
    assert args.workers == 4


def test_core_args_parse_for_the_full_run():
    args = train_detector.build_parser().parse_args(
        ["--data", "d.yaml", "--epochs", "60", "--imgsz", "1536", "--batch", "4", "--mosaic", "0"])
    assert args.epochs == 60
    assert args.imgsz == 1536
    assert args.batch == "4"   # kept a string so "-1" (auto) is accepted; main() ints it
    assert args.mosaic == 0.0


def test_data_is_required():
    import pytest
    with pytest.raises(SystemExit):
        train_detector.build_parser().parse_args([])
