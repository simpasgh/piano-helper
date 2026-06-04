"""Tests for clarity_stream.py: the block-by-block Clarity DRIVER. The torch/Clarity-dependent paths
(_load_clarity / _prepare_stage_b / main's heavy section) only run in Clarity's venv on the box, so
these cover the PURE, box-free surface: the subprocess argv builder, the emit-path naming, the
STREAM-line contract, and the per-system PREFIX-emit bookkeeping (stream_systems) with the decode +
assemble callbacks STUBBED. clarity_stream's top level is pure stdlib, so it imports here without
torch.
"""
from pathlib import Path

import clarity_stream


def test_build_stream_argv_fast_shape():
    argv = clarity_stream.build_stream_argv(
        "/venv/python", "/wk/clarity_stream.py", "/in.pdf", "/opt/clarity-omr",
        "/wk/out.musicxml", "/wk/emit", "/wk/work", device="cpu", fast=True,
    )
    assert argv[0] == "/venv/python"
    assert argv[1] == "/wk/clarity_stream.py"
    assert argv[2] == "/in.pdf"
    assert "--omr-dir" in argv and argv[argv.index("--omr-dir") + 1] == "/opt/clarity-omr"
    assert "-o" in argv and argv[argv.index("-o") + 1] == "/wk/out.musicxml"
    assert "--emit-dir" in argv and argv[argv.index("--emit-dir") + 1] == "/wk/emit"
    assert "--work-dir" in argv and argv[argv.index("--work-dir") + 1] == "/wk/work"
    assert "--device" in argv and argv[argv.index("--device") + 1] == "cpu"
    assert "--fast" in argv  # beam-2 CPU mode, matching omr.py --fast


def test_build_stream_argv_omits_fast_when_false():
    argv = clarity_stream.build_stream_argv(
        "/p", "/s", "/in.pdf", "/omr", "/o", "/e", "/w", device="cpu", fast=False,
    )
    assert "--fast" not in argv


def test_emit_path_is_zero_padded_document_order():
    emit_dir = Path("/tmp/emit")
    p1 = clarity_stream.emit_path(emit_dir, 1)
    p2 = clarity_stream.emit_path(emit_dir, 2)
    p10 = clarity_stream.emit_path(emit_dir, 10)
    assert p1.name == "system-0001.musicxml"
    assert p2.name == "system-0002.musicxml"
    assert p10.name == "system-0010.musicxml"
    # Zero-padding means a lexical sort is document order (system-0002 before system-0010).
    assert sorted([p10.name, p1.name, p2.name]) == [p1.name, p2.name, p10.name]


def test_stream_systems_emits_growing_prefix_per_system(tmp_path):
    # Three crops; each emit must assemble the FULL prefix of predictions so far. We capture what the
    # assemble callback is handed at each step and prove it grows 1 -> 2 -> 3, in document order.
    crop_rows = [
        {"sample_id": "s1", "crop_path": "c1.png"},
        {"sample_id": "s2", "crop_path": "c2.png"},
        {"sample_id": "s3", "crop_path": "c3.png"},
    ]
    tokens_by_crop = {"c1.png": ["A"], "c2.png": ["B"], "c3.png": ["C"]}
    seen_prefixes = []

    def decode_one(row):
        return tokens_by_crop[row["crop_path"]]

    def assemble_and_export(prediction_rows, out_path):
        # Record the (sample_id, tokens) prefix handed in, and write a marker file so the path exists.
        seen_prefixes.append([(p["sample_id"], tuple(p["tokens"])) for p in prediction_rows])
        Path(out_path).write_text("xml-%d" % len(prediction_rows), encoding="utf-8")

    emits = []
    emitted = clarity_stream.stream_systems(
        crop_rows, tmp_path, tmp_path / "emit",
        decode_one=decode_one,
        assemble_and_export=assemble_and_export,
        on_emit=lambda k, total, path: emits.append((k, total, path)),
    )

    # One emit per system, growing prefix each time.
    assert [len(p) for p in seen_prefixes] == [1, 2, 3]
    assert seen_prefixes[0] == [("s1", ("A",))]
    assert seen_prefixes[1] == [("s1", ("A",)), ("s2", ("B",))]
    assert seen_prefixes[2] == [("s1", ("A",)), ("s2", ("B",)), ("s3", ("C",))]
    # on_emit fired per system with the 1-based index and the right total.
    assert [(k, total) for (k, total, _p) in emits] == [(1, 3), (2, 3), (3, 3)]
    assert len(emitted) == 3
    assert emitted[-1] == clarity_stream.emit_path(tmp_path / "emit", 3)
    # The final emit file holds the COMPLETE (3-prediction) assembly.
    assert emitted[-1].read_text(encoding="utf-8") == "xml-3"


def test_stream_systems_decode_is_per_crop_in_order(tmp_path):
    # decode_one must be called once per crop, in document order (so the warm model decodes systems
    # top-to-bottom, matching the stock loop).
    crop_rows = [{"sample_id": "s%d" % i, "crop_path": "c%d" % i} for i in range(1, 4)]
    decoded_order = []

    def decode_one(row):
        decoded_order.append(row["crop_path"])
        return ["tok"]

    clarity_stream.stream_systems(
        crop_rows, tmp_path, tmp_path / "emit",
        decode_one=decode_one,
        assemble_and_export=lambda preds, out: Path(out).write_text("x", encoding="utf-8"),
    )
    assert decoded_order == ["c1", "c2", "c3"]
