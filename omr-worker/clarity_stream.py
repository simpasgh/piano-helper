#!/usr/bin/env python3
"""Block-by-block Clarity-OMR driver: emit MusicXML per staff system as Stage B decodes it.

WHY. End-to-end Clarity on the CPU box is ~19s fixed load + ~9s per staff system (measured on
cx33, infrastructure.md 2026-06-04), and the stock CLI (omr.py) BUFFERS all output to the end, so
the browser waits for the whole file. But Clarity's own pipeline ALREADY loads the model once and
then decodes system by system in a loop -- it just does not surface the intermediate results. This
driver runs that exact pipeline in ONE warm process and writes a cumulative MusicXML the moment each
system finishes, so the worker can fuse + publish real rhythm per system. Same total time
(~19 + 9N), first real block at ~28s instead of ~75s for a 6-system page.

CORRECTNESS GUARANTEE. We reuse Clarity's OWN Stage A crops (no new sub-cropping, so no
out-of-distribution risk), Clarity's OWN Stage B decode, and Clarity's OWN assemble + export. The
FINAL emit (all systems) calls assemble + export over the COMPLETE prediction set, exactly as the
stock CLI does, so the last system file is byte-equivalent to a stock whole-file run. The earlier
emits are assemble + export over a growing PREFIX of those same predictions: each is a valid score
of systems 1..k. The intermediate emits are extra read-only work; they cannot change the final.

We DRIVE Clarity's seams; we do NOT modify /opt/clarity-omr. This file is OUR artifact (lives in
omr-worker/, runs in Clarity's venv with CLARITY_OMR_DIR on sys.path). If Clarity refactors the
private helpers we import, this driver fails cleanly (non-zero exit) and the worker falls back to
the stock whole-file path -- a pure refinement, never worse.

CONTRACT (stdout/exit, read by worker.run_clarity_stream):
  - Per finished system, one line:  STREAM <k> <total> <abs/path/to/system-NNNN.musicxml>
    where the file holds the cumulative MusicXML for systems 1..k (k is 1-based).
  - The LAST system's file is also copied to the requested --output path (the complete result).
  - Exit 0 on success (>=1 system emitted), exit 3 if Stage A found no systems, non-zero on any
    error. The worker treats anything other than the emitted prefix files as "fall back".

USAGE (mirrors clarity_command's knobs, fixed to omr.py --fast values):
  python clarity_stream.py <pdf> --omr-dir <CLARITY_OMR_DIR> -o <out.musicxml>
      --emit-dir <dir> [--work-dir <dir>] [--device cpu] [--fast]

This module is import-safe WITHOUT torch/Clarity present (the heavy imports happen inside main()),
so the worker's own venv can import nothing here -- it only ever runs this as a subprocess in
Clarity's venv. The unit tests exercise the pure argv builder + the prefix-emit bookkeeping with
Clarity stubbed.
"""
from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path
from typing import Callable, Dict, List, Optional, Sequence


# omr.py builds these Stage-A/Stage-B values for its --fast CPU mode (see /opt/clarity-omr/omr.py
# and src/pdf_to_musicxml.build_parser). We mirror them EXACTLY so our crops + decode + assembly
# match a stock `omr.py --fast` whole-file run, which is what makes the final emit equivalent.
_FAST_BEAM_WIDTH = 2
_DEFAULT_BEAM_WIDTH = 5
_PDF_DPI = 300
_IMAGE_HEIGHT = 250
_IMAGE_MAX_WIDTH = 2500
_LENGTH_PENALTY_ALPHA = 0.4
_MAX_DECODE_STEPS = 512
_CONFIDENCE = 0.25
_IOU = 0.45
_DEDUPE_IOU = 0.85

# Per-system output file pattern (1-based, zero-padded so a lexical sort is document order).
EMIT_PREFIX = "system-"
EMIT_SUFFIX = ".musicxml"

# The single line we print per finished system. Parsed by the worker; keep the shape stable.
STREAM_LINE_PREFIX = "STREAM"

# Exit code meaning "Stage A detected no staff systems" (a clean decline, like geom exit 2), so the
# worker can distinguish "nothing here" from a crash. Any OTHER non-zero exit is an error; either
# way the worker falls back to whole-file fusion.
EXIT_NO_SYSTEMS = 3


def build_stream_argv(python: str, script: str, pdf_path: str, omr_dir: str, out_path: str,
                      emit_dir: str, work_dir: str, device: str = "cpu",
                      fast: bool = True) -> List[str]:
    """Build the argv to run THIS driver as a subprocess in Clarity's venv. Pure so worker tests can
    assert the shape without spawning anything (mirrors worker.clarity_command). --fast pins beam-2
    (the ~9s/system CPU mode), matching the stock CLI."""
    argv = [
        python,
        script,
        pdf_path,
        "--omr-dir",
        omr_dir,
        "-o",
        out_path,
        "--emit-dir",
        emit_dir,
        "--work-dir",
        work_dir,
        "--device",
        device,
    ]
    if fast:
        argv.append("--fast")
    return argv


def emit_path(emit_dir: Path, index_1based: int) -> Path:
    """Absolute path of the cumulative MusicXML file for systems 1..index_1based."""
    return emit_dir / ("%s%04d%s" % (EMIT_PREFIX, index_1based, EMIT_SUFFIX))


def _print_stream(index_1based: int, total: int, path: Path) -> None:
    """Emit the one progress line the worker parses, flushed so the worker sees it promptly."""
    print("%s %d %d %s" % (STREAM_LINE_PREFIX, index_1based, total, path), flush=True)


def _build_crop_rows(pdf_path: Path, work_dir: Path, weights: Path, deps) -> List[Dict]:
    """Render the PDF and run Stage A to produce Clarity's OWN per-system crop rows, in document
    order. This replicates the NON-manual branch of pdf_to_musicxml.main with the stock defaults, so
    the crops are identical to a stock run. Returns the crop-row dicts (the Stage B manifest). Stage A
    (YOLO) selects its own device like the stock pipeline; only Stage B is pinned to --device."""
    pages_dir = work_dir / "pages"
    page_images = deps["render_pdf_pages"](pdf_path, pages_dir, dpi=max(72, _PDF_DPI))
    if not page_images:
        raise RuntimeError("No pages rendered from PDF: %s" % pdf_path)

    YoloStageA = deps["YoloStageA"]
    YoloStageAConfig = deps["YoloStageAConfig"]
    dedupe = deps["_dedupe_page_crop_rows_keep_latest"]

    stage_a = YoloStageA(
        YoloStageAConfig(
            weights_path=weights,
            confidence_threshold=_CONFIDENCE,
            iou_threshold=_IOU,
            dedupe_iou_threshold=_DEDUPE_IOU,
            enforce_full_width_crops=True,
            full_width_left_page_edge=True,
            full_width_right_page_edge=False,
        )
    )
    all_rows: List[Dict] = []
    for page_index, page_image in enumerate(page_images):
        detections = stage_a.detect_regions(page_image)
        crops_dir = work_dir / "crops" / ("page_%04d" % (page_index + 1))
        crops = stage_a.crop_staff_regions(page_image, detections, crops_dir)
        page_rows: List[Dict] = []
        for crop in crops:
            sample_id = "page_%04d:%s" % (page_index + 1, Path(crop.crop_path).stem)
            page_rows.append(
                {
                    "sample_id": sample_id,
                    "crop_path": str(Path(crop.crop_path).resolve()),
                    "system_index": int(crop.system_index),
                    "staff_index": int(crop.staff_index),
                    "page_index": int(page_index),
                    "bbox": {
                        "x_min": float(crop.bbox.x_min),
                        "y_min": float(crop.bbox.y_min),
                        "x_max": float(crop.bbox.x_max),
                        "y_max": float(crop.bbox.y_max),
                    },
                }
            )
        all_rows.extend(dedupe(page_rows))
    return all_rows


def stream_systems(crop_rows: Sequence[Dict], work_dir: Path, emit_dir: Path,
                   decode_one: Callable[[Dict], List[str]],
                   assemble_and_export: Callable[[Sequence[Dict], Path], None],
                   on_emit: Optional[Callable[[int, int, Path], None]] = None) -> List[Path]:
    """Decode each crop in document order; after each, assemble + export the growing PREFIX of
    predictions and write the cumulative MusicXML for systems 1..k. Returns the emitted file paths in
    order. PURE of Clarity specifics: decode_one (crop_row -> tokens) and assemble_and_export
    (prediction_rows, out_path -> writes MusicXML) are injected, so the bookkeeping is unit-testable
    with stubs. Raises only if a callback raises (main() wraps the whole run)."""
    emit_dir.mkdir(parents=True, exist_ok=True)
    total = len(crop_rows)
    predictions: List[Dict] = []
    emitted: List[Path] = []
    for index, row in enumerate(crop_rows, start=1):
        tokens = decode_one(row)
        pred = dict(row)
        pred["tokens"] = list(tokens)
        predictions.append(pred)
        out = emit_path(emit_dir, index)
        assemble_and_export(predictions, out)
        emitted.append(out)
        if on_emit is not None:
            on_emit(index, total, out)
    return emitted


def _load_clarity(omr_dir: Path) -> Dict:
    """Import Clarity's pipeline seams from CLARITY_OMR_DIR (we run in Clarity's venv with torch).
    Returns a dict of the callables/classes the driver needs. Kept inside a function so importing
    clarity_stream.py in the WORKER venv (no torch, no Clarity) never triggers these heavy imports;
    the worker only ever runs this module as a subprocess in Clarity's venv. Raises on any missing
    seam so main() can fall the worker back to whole-file fusion."""
    omr_dir = omr_dir.resolve()
    if str(omr_dir) not in sys.path:
        sys.path.insert(0, str(omr_dir))

    from src.pdf_to_musicxml import render_pdf_pages, _dedupe_page_crop_rows_keep_latest
    from src.models.yolo_stage_a import YoloStageA, YoloStageAConfig
    from src.model_assets import (
        default_stage_a_weights,
        default_stage_b_checkpoint,
        ensure_default_stage_a_weights,
        ensure_default_stage_b_checkpoint,
    )
    from src.cli import (
        run_assemble,
        run_export,
        _decode_stage_b_tokens,
        _encode_staff_image,
        _load_stage_b_crop_tensor,
        _load_stage_b_checkpoint_payload,
        _load_stage_b_state_dict,
        _prepare_decoder_memory_cache,
        _prepare_model_for_inference,
    )
    from src.tokenizer.vocab import build_default_vocabulary
    from src.train.train import _prepare_model_for_dora
    from src.train.model_factory import (
        ModelFactoryConfig,
        build_stage_b_components,
        model_factory_config_from_checkpoint_payload,
    )

    return {
        "render_pdf_pages": render_pdf_pages,
        "_dedupe_page_crop_rows_keep_latest": _dedupe_page_crop_rows_keep_latest,
        "YoloStageA": YoloStageA,
        "YoloStageAConfig": YoloStageAConfig,
        "default_stage_a_weights": default_stage_a_weights,
        "default_stage_b_checkpoint": default_stage_b_checkpoint,
        "ensure_default_stage_a_weights": ensure_default_stage_a_weights,
        "ensure_default_stage_b_checkpoint": ensure_default_stage_b_checkpoint,
        "run_assemble": run_assemble,
        "run_export": run_export,
        "_decode_stage_b_tokens": _decode_stage_b_tokens,
        "_encode_staff_image": _encode_staff_image,
        "_load_stage_b_crop_tensor": _load_stage_b_crop_tensor,
        "_load_stage_b_checkpoint_payload": _load_stage_b_checkpoint_payload,
        "_load_stage_b_state_dict": _load_stage_b_state_dict,
        "_prepare_decoder_memory_cache": _prepare_decoder_memory_cache,
        "_prepare_model_for_inference": _prepare_model_for_inference,
        "build_default_vocabulary": build_default_vocabulary,
        "_prepare_model_for_dora": _prepare_model_for_dora,
        "ModelFactoryConfig": ModelFactoryConfig,
        "build_stage_b_components": build_stage_b_components,
        "model_factory_config_from_checkpoint_payload": model_factory_config_from_checkpoint_payload,
    }


def _prepare_stage_b(deps: Dict, checkpoint: Path, device_name: str):
    """Load the Stage B model ONCE, mirroring evaluate_stage_b_checkpoint._run_stage_b_inference_with
    _progress's load path (the one-time ~19s cost). Returns (decode_kwargs_factory) state so each
    crop's decode reuses the warm model. Raises on a checkpoint that does not load (same guard rails
    as upstream)."""
    import torch

    cleaned_device = str(device_name).strip() if device_name else ""
    device = torch.device(cleaned_device if cleaned_device else ("cuda" if torch.cuda.is_available() else "cpu"))

    vocab = deps["build_default_vocabulary"]()
    payload = deps["_load_stage_b_checkpoint_payload"](checkpoint, device)
    fallback_factory_cfg = deps["ModelFactoryConfig"](stage_b_vocab_size=vocab.size)
    factory_cfg = deps["model_factory_config_from_checkpoint_payload"](
        payload, vocab_size=vocab.size, fallback=fallback_factory_cfg,
    )
    components = deps["build_stage_b_components"](factory_cfg)
    model = components["model"]
    state_dict_raw = payload.get("model_state_dict", payload) if isinstance(payload, dict) else payload
    if not isinstance(state_dict_raw, dict):
        raise RuntimeError("Unsupported checkpoint format: %s" % checkpoint)

    raw_keys = [str(k) for k in state_dict_raw.keys()]
    looks_like_dora = any("lora_" in k for k in raw_keys) or any("modules_to_save" in k for k in raw_keys)
    if looks_like_dora:
        model, _ = deps["_prepare_model_for_dora"](model, components["dora_config"])
        state_dict = state_dict_raw
    else:
        state_dict = deps["_load_stage_b_state_dict"](checkpoint, device)

    model = model.to(device)
    load_result = model.load_state_dict(state_dict, strict=False)
    loaded_keys = max(0, len(state_dict) - len(load_result.unexpected_keys))
    load_ratio = float(loaded_keys) / float(max(1, len(state_dict)))
    if loaded_keys == 0:
        raise RuntimeError("Checkpoint did not load any compatible Stage-B parameters: %s" % checkpoint)
    if load_ratio < 0.50:
        raise RuntimeError(
            "Checkpoint load coverage too low: loaded=%d/%d (%.1f%%)"
            % (loaded_keys, len(state_dict), 100.0 * load_ratio)
        )
    model.eval()
    decode_model = deps["_prepare_model_for_inference"](model)
    token_to_idx = {token: idx for idx, token in enumerate(vocab.tokens)}

    def decode_one(row: Dict, beam_width: int) -> List[str]:
        crop_path = Path(str(row["crop_path"]))
        pixel_values = deps["_load_stage_b_crop_tensor"](
            crop_path,
            image_height=max(32, _IMAGE_HEIGHT),
            image_max_width=max(256, _IMAGE_MAX_WIDTH),
            device=device,
        )
        memory = deps["_encode_staff_image"](decode_model, pixel_values)
        encoder_kv_cache = deps["_prepare_decoder_memory_cache"](decode_model, memory)
        return deps["_decode_stage_b_tokens"](
            model=model,
            pixel_values=pixel_values,
            vocabulary=vocab,
            beam_width=max(1, int(beam_width)),
            max_decode_steps=max(8, _MAX_DECODE_STEPS),
            length_penalty_alpha=float(_LENGTH_PENALTY_ALPHA),
            use_kv_cache=True,
            _precomputed={
                "decode_model": decode_model,
                "memory": memory,
                "encoder_kv_cache": encoder_kv_cache,
                "token_to_idx": token_to_idx,
            },
        )

    return decode_one


def _make_assemble_and_export(deps: Dict, work_dir: Path):
    """Return assemble_and_export(prediction_rows, out_path): write the prediction prefix to a JSONL,
    run Clarity's run_assemble + run_export over it, producing the cumulative MusicXML at out_path.
    Uses Clarity's OWN assembler/exporter, so the full-prefix emit equals a stock whole-file run."""
    import json

    run_assemble = deps["run_assemble"]
    run_export = deps["run_export"]

    def assemble_and_export(prediction_rows: Sequence[Dict], out_path: Path) -> None:
        # Each emit re-writes the full prefix; the predictions file is tiny vs the per-system decode,
        # so the O(N) rewrite per system (O(N^2) total bookkeeping) is negligible next to N x ~9s.
        preds_path = work_dir / "stage_b_predictions.jsonl"
        with preds_path.open("w", encoding="utf-8") as handle:
            for row in prediction_rows:
                handle.write(json.dumps(row) + "\n")
        assembly_manifest = work_dir / "assembled_score.json"
        run_assemble(
            argparse.Namespace(staff_predictions=preds_path, output_assembly=assembly_manifest)
        )
        out_path.parent.mkdir(parents=True, exist_ok=True)
        run_export(
            argparse.Namespace(assembly_manifest=assembly_manifest, output_musicxml=out_path)
        )

    return assemble_and_export


def _parse_args(argv: Optional[Sequence[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Stream Clarity-OMR MusicXML per staff system.")
    parser.add_argument("pdf", type=Path, help="Input PDF score.")
    parser.add_argument("--omr-dir", type=Path, required=True, help="Clarity-OMR checkout (CLARITY_OMR_DIR).")
    parser.add_argument("-o", "--output", type=Path, required=True, help="Final (complete) MusicXML path.")
    parser.add_argument("--emit-dir", type=Path, required=True, help="Directory for per-system cumulative files.")
    parser.add_argument("--work-dir", type=Path, default=None, help="Working directory for intermediates.")
    parser.add_argument("--device", type=str, default="cpu", help="Stage-B device (cpu or cuda).")
    parser.add_argument("--fast", action="store_true", help="Beam-2 CPU mode (matches omr.py --fast).")
    return parser.parse_args(argv)


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = _parse_args(argv)
    pdf_path = args.pdf.resolve()
    if not pdf_path.exists():
        print("clarity_stream: PDF not found: %s" % pdf_path, file=sys.stderr, flush=True)
        return 1
    work_dir = (args.work_dir or (pdf_path.parent / "clarity-stream-work")).resolve()
    work_dir.mkdir(parents=True, exist_ok=True)
    emit_dir = args.emit_dir.resolve()
    beam_width = _FAST_BEAM_WIDTH if args.fast else _DEFAULT_BEAM_WIDTH

    try:
        deps = _load_clarity(args.omr_dir)
    except Exception as err:  # Clarity import/seam moved -> worker falls back to whole-file fusion.
        print("clarity_stream: cannot load Clarity pipeline (%r)" % err, file=sys.stderr, flush=True)
        return 1

    try:
        project_root = args.omr_dir.resolve()
        weights = deps["ensure_default_stage_a_weights"](project_root)
        checkpoint = deps["ensure_default_stage_b_checkpoint"](project_root)
        crop_rows = _build_crop_rows(pdf_path, work_dir, Path(weights).resolve(), deps)
    except Exception as err:
        print("clarity_stream: Stage A failed (%r)" % err, file=sys.stderr, flush=True)
        return 1
    if not crop_rows:
        print("clarity_stream: no staff systems detected", file=sys.stderr, flush=True)
        return EXIT_NO_SYSTEMS

    try:
        decode_one = _prepare_stage_b(deps, Path(checkpoint).resolve(), args.device)
        assemble_and_export = _make_assemble_and_export(deps, work_dir)
        emitted = stream_systems(
            crop_rows,
            work_dir,
            emit_dir,
            decode_one=lambda row: decode_one(row, beam_width),
            assemble_and_export=assemble_and_export,
            on_emit=_print_stream,
        )
    except Exception as err:
        print("clarity_stream: Stage B / export failed (%r)" % err, file=sys.stderr, flush=True)
        return 1

    if not emitted:
        return EXIT_NO_SYSTEMS
    # The last system's cumulative file is the COMPLETE result; copy it to the requested output too,
    # so a caller that only wants the final (non-streaming) result still gets it at -o.
    try:
        out_path = args.output.resolve()
        out_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(emitted[-1], out_path)
    except Exception as err:
        print("clarity_stream: final copy failed (%r)" % err, file=sys.stderr, flush=True)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
