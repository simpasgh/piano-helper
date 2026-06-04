#!/usr/bin/env python3
"""Train the MULTI-CLASS symbol detector (YOLOv8) on the synthetic + DeepScores datasets, then
hand its detections to the geometric decode (geom_omr / geom_detector): noteheads -> exact pitch,
and the rest of the symbols (head fill, stem, flag, beam, dot, accidentals, clefs, rests, time-sig,
ties, ottava) -> durations, key, accidentals, clefs (the "measure, do not predict" thesis past
noteheads). The class set comes from the dataset's data.yaml (synth_render.CLASS_NAMES), so this
trainer is class-agnostic; it was the single-class notehead trainer and now scales to all symbols
with no code change beyond the docs.

Design choices that matter for MUSIC (not generic COCO):
  - fliplr=0 and flipud=0: a flipped score is geometrically INVALID (it would teach mirrored
    staff/notehead relationships), so both flips are OFF. This is the one default we must change.
  - small rotation/perspective + hsv + mosaic: cheap robustness toward real phone photos without
    changing what a glyph is.
  - the trained weights are a few MB and run fast on the CPU cx33 box.

Run (after synth_dataset.py / deepscores_to_yolo.py build <ds>/data.yaml):
    python train_detector.py --data <ds>/data.yaml --epochs 60 --imgsz 1536 --batch 4 \
        --workers 0 --mosaic 0 --project C:/Users/pascu/omr-train/runs --name symbols1
Best weights land at <project>/<name>/weights/best.pt.

WINDOWS GOTCHA: keep --workers 0. The default ultralytics multiprocessing dataloader (workers=8)
HANGS pre-epoch-1 on this Windows box (the worker processes never spawn; a 12-minute run logged 0
epochs). workers=0 (a single-process loader) trains fine. For DENSE real pages (DeepScores) at a
high imgsz, also use --mosaic 0: a mosaic batch of 4 dense pages spills past the 16G card.
"""
from __future__ import annotations

import argparse


def train(data: str, model: str, epochs: int, imgsz: int, batch, project: str,
          name: str, device: str, mosaic: float = 1.0, workers: int = 0) -> str:
    from ultralytics import YOLO

    yolo = YOLO(model)  # transfer-learn from the pretrained COCO checkpoint (or a prior .pt)
    yolo.train(
        data=data,
        epochs=epochs,
        imgsz=imgsz,
        batch=batch,
        device=device,
        project=project,
        name=name,
        # 0 = single-process loader. The default 8 HANGS pre-epoch-1 on this Windows box.
        workers=workers,
        patience=20,
        # --- augmentation tuned for sheet music ---
        fliplr=0.0,          # MUST: horizontal flip invalidates clef/staff geometry
        flipud=0.0,          # MUST: vertical flip invalidates pitch geometry
        degrees=2.0,         # mild rotation (phone photos are rarely perfectly square)
        perspective=0.0004,  # mild perspective (photo of a physical page)
        translate=0.1,
        scale=0.5,           # scale jitter -> resolution robustness
        hsv_h=0.0, hsv_s=0.3, hsv_v=0.4,  # lighting/paper-tone variation; no hue shift (B/W music)
        # mosaic combines 4 images; on DENSE real pages (DeepScores, hundreds of noteheads each)
        # it both explodes target-memory past 16GB and shrinks the already-tiny real noteheads, so
        # we make it tunable and disable it (mosaic=0) for dense real-data fine-tunes.
        mosaic=mosaic,
        close_mosaic=10,
        # noteheads are small + dense; keep more candidate boxes per image.
        verbose=True,
    )
    best = f"{project}/{name}/weights/best.pt"
    print(f"BEST_WEIGHTS={best}")
    return best


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(description="Train YOLOv8 multi-class symbol detector")
    ap.add_argument("--data", required=True, help="path to dataset data.yaml")
    ap.add_argument("--model", default="yolov8s.pt", help="base checkpoint (yolov8n/s/m.pt)")
    ap.add_argument("--epochs", type=int, default=60)
    ap.add_argument("--imgsz", type=int, default=1280)
    ap.add_argument("--batch", default="16", help="int batch, or -1 for auto")
    ap.add_argument("--project", default="C:/Users/pascu/omr-train/runs")
    ap.add_argument("--name", default="symbols1")
    ap.add_argument("--device", default="0", help="'0' for first GPU, 'cpu' otherwise")
    ap.add_argument("--mosaic", type=float, default=1.0,
                    help="mosaic aug prob; set 0 for dense real pages (memory + small noteheads)")
    ap.add_argument("--workers", type=int, default=0,
                    help="dataloader workers; KEEP 0 on Windows (default 8 hangs pre-epoch-1)")
    return ap


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    batch = int(args.batch)
    train(args.data, args.model, args.epochs, args.imgsz, batch,
          args.project, args.name, args.device, mosaic=args.mosaic, workers=args.workers)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
