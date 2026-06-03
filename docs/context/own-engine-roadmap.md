# Own OMR engine — roadmap & build handoff

Self-contained plan so any session (esp. the one on the GPU PC) can pick up and execute
without the prior machine's local memory. Newest status at the top. NO em dashes in generated
text (project rule). Ship every code change through the gated flow (see "Constraints" below).

## STATUS: geom is a never-worse FALLBACK on cx33; BARLINES shipped, detection-robustness next (2026-06-03)

The trained detector is deployed to the cx33 prod worker with `OMR_GEOM=1`, but it runs as a
LAST-RESORT FALLBACK, not a primary (PR #178): tried only when the Clarity/oemer ensemble produces
nothing. It was briefly wired wins-first (PR #172) and that regressed prod (it fabricates rhythm),
so it was demoted the same day.

A REAL-SCORE eval (the user's own MuseScore pieces icarus/reverie/liminality/tctab as PDF +
MusicXML ground truth; harness + pieces on the box at `/opt/geom-omr/eval/real_scores`, see memory
[[geom-improvement-priorities]]) reordered the levers. geom found up to 93% of the pitches but
binned them 4-per-measure, so per-measure note_f1 collapsed to ~0.29: BARLINES, not rhythm, were
the biggest gap.

SHIPPED (PR #180): `detect_barlines` (vertical runs crossing the inter-staff gap, which stems do
not) + the decode now segments chords into real measures by x-position. Measured lift on the real
pieces: liminality note_f1 0.29 -> **0.95** (chord_recall 0.09 -> 0.79), tctab 0.28 -> 0.71, icarus
0.15 -> 0.39. A rhythm-aware duration metric was added first (PR #179: `duration_acc`/`note_dur_f1`)
so the gap is measurable.

NEXT LEVERS (in order): (1) **detection robustness** -- reverie found only 50 of 185 notes and
icarus's `detect_systems` found 5 staves not 6, so the trained YOLO detector and/or staff detection
fail on some real engravings; barlines/rhythm cannot help notes never found. Investigate with the
real_eval harness on reverie/icarus. (2) **rhythm / durations** -- still `duration: 1`; needs
note-type CV (head fill open/filled, stems, flags/beams, dots; `detect_noteheads` already computes a
fill ratio). (3) key-signature detection. (4) re-promote geom from fallback once it is genuinely
competitive (the per-note `referee.py` only arbitrates ALIGNED candidates, so that needs a
whole-output selector). Deploy + rollback: docs/context/infrastructure.md and omr-worker/README.md.

## STATUS: trained notehead detector works, beats baseline (GPU PC, 2026-06-03)

Executed THE NEXT STEP on the GPU PC (RTX 5060 Ti, 16GB, Blackwell sm_120). The trained
detector plan works and clears the bar. New code (all in `omr-worker/`, research-only, NOT wired
into the worker): `synth_render.py`, `synth_dataset.py`, `synth_augment.py`, `train_detector.py`,
`geom_detector.py`, `eval_detector.py`, `deepscores_to_yolo.py` (+ tests). Heavy artifacts (venv,
datasets, runs, weights) live OUTSIDE the repo under `~/omr-train` and are gitignored.

Headline (held-out SYNTHETIC, primary benchmark; an 8-epoch model, detection saturates by epoch
2: notehead recall 1.0 / mAP50 0.995, so a short run already suffices):
- C-major set (120 scores, where the decode needs no key): **trained exact-F1 0.924, octave 1.0**,
  chord 0.41, vs the classical detector on the SAME set 0.416 / 0.792 / 0.0. This PASSES the 0.90
  free-baseline bar and the prior classical-clean 0.774. The roadmap's headline question ("does
  the trained detector push exact-F1 toward/past 0.90?") is answered YES, with PERFECT octave.
- ALL keys (240 scores, key prior applied): trained 0.866 / octave 0.998 / chord 0.36, vs
  classical 0.338 / 0.716 / 0.0. Detection note-recall ~0.98 (26443 of 26954) vs classical ~0.95.
- The detector is the win the roadmap predicted: it removes the classical detector's ~0.82
  notehead-recall cap (here ~0.98-1.0), and the EXACT geometric decode then gives octave 1.0.

Found + fixed a decode gap (orthogonal to the detector): `decode_pitch` returned alter=0 always,
so every accidental in a non-C key read a semitone wrong (this also explains why our mixed-key
classical numbers sat well below 0.774). Added the key prior `geom_omr.keyed_alter` +
`decode_pitch(..., fifths=)` (the "key prior" the module was always meant to add). With the key
applied, the trained engine across all 240 mixed-key scores reaches 0.866 exact-F1 / octave
0.998 (without the key it was ~0.62 on the same scores, every accidental read a semitone flat).
Reading the key signature FROM the image is still a separate (classical, no-GPU) recognition
rung; we proved the decode is exact once the key is known.

Trained on REAL scores too (DeepScoresV2). The synthetic detector only ever saw our single
Verovio font, so we added REAL typeset music: DeepScoresV2 "dense" (1714 LilyPond-engraved pages
in multiple fonts: Gonville/Emmentaler/Beethoven). License is CC BY 4.0 = commercial-OK with
attribution (MUSCIMA++/CVC-MUSCIMA are CC BY-NC and are deliberately NOT used). `deepscores_to_yolo.py`
converts its noteheads to our YOLO format (1362 train / 352 val pages, 280k / 76k boxes; labels
visually verified). Fine-tuning the synthetic model on synthetic+DeepScores combined (6 epochs,
`--mosaic 0` because dense pages + mosaic both spill VRAM and shrink the tiny real noteheads):
- On the held-out REAL DeepScores val: mAP50 0.875 / recall 0.874 / precision 0.993 (up from the
  synthetic-only model's 0.799 / 0.780 / 0.892 on the same real pages: real data mainly bought
  precision 0.89->0.99 and tighter localization mAP50-95 0.50->0.66).
- NO synthetic regression: still 0.924 exact-F1 / octave 1.0 on the C-major synthetic set. So the
  combined model is a strict improvement (same synthetic, better real). Weights:
  `~/omr-train/runs/notehead_real/weights/best.pt`.
- Pretrained OMR detectors found online were NOT usable as a drop-in notehead source: v-dvorak
  /omr-layout-analysis is layout-only (staves/systems), dmgonzalez8/OMR has no license + noteheads
  unclear. So the win is the DeepScores DATA (CC BY) trained into our own detector, not someone
  else's weights. (For real PHONE PHOTOS, still apply `synth_augment.py` on top - see below.)

Remaining gaps / next rungs (in priority order):
1. Longer/cleaner training run for final weights (detection already saturates fast).
2. Real-PHOTO number: `synth_augment.py` (paper tone, uneven light, shadow, blur, sensor noise,
   JPEG) is built + unit-tested but NOT yet baked into a training run; build an augmented dataset
   (over synthetic AND DeepScores), retrain, and measure on icarus.pdf to get the phone-photo
   number. DeepScores is clean typeset, so it improves printed-score generality but is not itself
   a photo benchmark.
3. Key-signature DETECTION from the engraved keySig (count sharps/flats) to remove the oracle-key
   assumption.
4. chord_recall (~0.4) and barline-based measures (the cheaper non-GPU rungs).
5. Deploy weights to the cx33 box (CPU inference) ONLY after it beats baseline AND passes QA.

Gotchas worth not re-learning (this box, Windows):
- Blackwell sm_120 needs the CUDA 12.8 torch wheel (`pip install torch --index-url
  .../whl/cu128`); older cu118/cu121 wheels import fine but have no sm_120 kernels.
- At imgsz 1280, batch=16 oversubscribes the 16GB card; on Windows WDDM that does NOT OOM, it
  SPILLS VRAM into system RAM and runs ~10x slower (0.3 vs 3 it/s). Use batch=8 (~11-12GB, no
  spill). Watch the GPU_mem column: >16G = spilling.
- DENSE real pages (DeepScores: hundreds of noteheads each) + mosaic (combines 4 images) spike to
  ~20G and spill. For dense real-data fine-tunes use `--mosaic 0` and batch=4 (~6-7GB); mosaic
  also shrinks the already-tiny real noteheads, so disabling it helps accuracy there too.
- cairosvg has no system libcairo on Windows, so SVG->PNG goes through Playwright Chromium, which
  ALSO gives pixel-exact notehead/staff boxes via getBoundingClientRect (free perfect labels).

## Goal

Build OUR OWN optical-music-recognition engine for the app: the most accurate we can for
PIANO scores, eventually from PHONE PHOTOS of physical scores (not just clean PDFs). It is the
product/moat: free per-scan on our own infra, tunable, private, ours to improve. Gemini/LLMs
are a baseline + possible data-labeler + fallback, NOT the destination.

## Where we are (measured, durable)

Bar to beat (the existing free engines, graded by `omr_eval.score_transcription` vs ground truth):
- Clarity / oemer exact note-F1 ~**0.90** (icarus Clarity 0.899 / chord_recall 0.643; oemer 0.914 / 0.464).

What we tried and learned:
- **LLM-vision (gemini-2.5-flash, single-shot)**: exact-F1 **0.39**, pitch-class 0.75, chord_recall 0, octaves broken. Worse than baseline. It gets note NAMES right but OCTAVES wrong. DISABLED in prod (`OMR_LLM=0` on the cx33; never-worse). The Gemini key used during testing is in the cx33 env + old chat transcripts: ROTATE IT. Useful roles for an LLM later: data-labeler / fallback / maybe octave-corrected, not primary.
- **Geometric pipeline** (`omr-worker/geom_omr.py`, shipped PR #167, research-only/not wired to prod): staff detection + classical (no-training) notehead detection + EXACT geometric pitch decode + chord grouping.
  - Clean Verovio renders: exact-F1 **0.774**, **octave accuracy 0.972**, pitch-class 0.796.
  - Real icarus.pdf: exact-recall 0.41, **octave 0.55**, pitch-class 0.747, notehead detection recall ~0.82, chord_recall ~0.
  - **KEY FINDING: the pitch/octave DECODE is provably exact (0.972 octave on clean) and beats the LLM's octave problem. The bottleneck is the DETECTOR** (finding notehead centers + staff geometry accurately on real input), NOT the pitch logic. Do NOT ML-ify the decode.

## THE NEXT STEP (what to build on the GPU PC)

Train a **notehead + staffline DETECTOR** (YOLO-style, e.g. ultralytics YOLOv8n/s) on FREE synthetic
data, then feed its detections into the existing exact geometric decoder. This is the real-score
accuracy unlock and the one place a GPU helps. Inference of the trained model is small/fast and
will run on the CPU cx33 box for free; the GPU is only for the (occasional) training run.

Step by step:

1. **Confirm the GPU.** `nvidia-smi`; in python `import torch; torch.cuda.is_available()` (CUDA)
   or MPS on Apple Silicon. Set up a venv: `pip install ultralytics torch` (CUDA build) + the
   repo's omr-worker deps (numpy, scipy, pillow, verovio, cairosvg). Verovio is needed to render
   synthetic scores.

2. **Generate a labeled synthetic dataset (free, unlimited, perfectly labeled).**
   - Use `omr_eval.generate_random_score(seed, ...)` (in `omr-worker/omr_eval.py`) to make
     thousands of in-key grand-staff scores (vary seed, measures, key, chord_prob). The MusicXML
     is its own ground truth.
   - Render each with **Verovio** to a PNG. Verovio's SVG carries per-element positions: extract
     each notehead's bounding box from the rendered SVG (the `<g class="note"|"notehead">`
     elements / their `@transform` + glyph extents, or `toolkit.getElementsAtTime` + the element
     map) to produce YOLO-format labels (class = notehead [+ optionally staffline], box = head
     bbox). This is the crux: we get pixel-perfect notehead boxes for free because we generated
     the score. Sanity-check by overlaying a few boxes on the render.
   - Apply photo-style AUGMENTATION (perspective/rotation, lighting/shadow gradient, blur, sensor
     noise, JPEG artifacts, paper texture) so the detector survives real photos (domain
     randomization, bridges the sim-to-real gap). Keep a clean-only and an augmented split.

3. **Train** YOLOv8n/s (transfer from the pretrained COCO weights). A small model + a few
   thousand images + ~50-100 epochs is ~minutes-to-an-hour on a decent NVIDIA GPU. Save weights
   (small, a few MB).

4. **Integrate + measure.** Add a detector-backed notehead source to `geom_omr.py` (keep the
   classical detector as a fallback; never-raise contract), feed detections into the EXISTING
   `decode_pitch` (already exact). Re-measure with `omr_eval.score_transcription`:
   - PRIMARY portable benchmark: held-out SYNTHETIC scores (self-contained, no external files) -
     report exact-F1, octave accuracy, pitch-class, chord_recall.
   - SECONDARY: real icarus.pdf vs ground truth `icarus.mscz` (see "Access" - needs the file).
   - Compare to: classical detector (clean exact-F1 0.774 / real 0.41, octave 0.55), the 0.90
     baseline, and the LLM (0.39 / 0.75). Headline question: does the trained detector push real
     octave accuracy and exact-F1 toward/past 0.90?

5. **Deploy for inference** (when it beats the classical pipeline): copy the weights to the cx33
   box; geom_omr runs detection on CPU (ms-fast). Only wire geom_omr into `worker.process_job`
   AFTER it measurably beats the baseline and passes the project's QA gate (it is research-only
   until then; mirror how reconcile.py was pure-before-wired).

Cheaper non-GPU rungs that also help (do opportunistically): robust per-staff interline/ledger
estimation, deskew, barline detection (also fixes the per-measure metric + chord onsets),
adaptive binarization for photos. But the classical detector caps ~0.82 notehead recall even on
clean renders, so the trained detector is the real unlock.

## Key modules / functions to reuse (all in `omr-worker/`)

- `omr_eval.py`: `score_transcription(pred_xml, truth_xml)` (note P/R/F1 + chord_recall, never-raises),
  `generate_random_score(seed, ...)`, `mscx_to_truth_musicxml(mscx)`.
- `geom_omr.py` (PR #167): `detect_staves`, `detect_noteheads`, `decode_pitch`,
  `transcribe_geometric`. The detector is what you are upgrading; the decode stays.
- `llm_omr.py`: `score_json_to_musicxml(json)` (deterministic MusicXML builder - emit your
  transcription through this), `_midi_to_pitch`.
- `referee.py`: `_staff_lines`, `_find_notehead_x`, `_suppress_lines` (classical CV helpers).
- `reconcile.py`: `to_events`, `_pitch_to_midi`.

## Access / environment

- Repo deploy to the always-on worker (cx33 Hetzner, CPU-only, runs inference): git checkout at
  `/opt/piano-helper`; update with `cd /opt/piano-helper && sudo -u ubuntu git fetch origin &&
  sudo -u ubuntu git reset --hard origin/main` then `systemctl restart omr-worker.service`. SSH
  `root@91.98.116.201` with key `~/.ssh/oci_omr` (this key lives on the Mac - COPY IT to the PC
  if you need to deploy/measure on the box from there; training does NOT need the box).
- Prod env flags (`/etc/piano-helper-omr.env`): `OMR_ENSEMBLE=1`, `OMR_ENSEMBLE_REFEREE=1`,
  `OMR_LLM=0` (LLM disabled). Do NOT change these without a deliberate decision; geom_omr is not
  wired into the worker yet.
- Ground-truth scores for the real-score eval: `icarus.mscz`, `Liminility.mscz` (on the Mac at
  `~/Documents/MuseScore4/Scores/`). For the PC, the SYNTHETIC eval is fully self-contained and is
  the primary benchmark; copy the .mscz files over only for the secondary real-score check.

## Constraints (hard)

- FREE tooling: training on the user's own GPU = $0; inference free on the cx33. No paid service
  without explicit OK. (LLM API is opt-in + budget-capped + currently off.)
- Every module NEVER raises (returns a safe default) - the project's robustness contract.
- Ship via the GATED flow: `feat/`|`fix/`|`chore/` branch, `npm test` + `npm run build` +
  `cd omr-worker && python3 -m pytest -q` all green, open a PR, wait for CI
  (`gh pr checks <pr> --watch`), merge `--squash --delete-branch`. Tech-lead reviews before merge.
- PUSH GOTCHA: a pre-push guard rejects `git push -u origin HEAD` and `commit && push` chained.
  Run `git add`, `git commit`, and `git push origin refs/heads/<branch>:refs/heads/<branch>` as
  SEPARATE commands with an explicit refspec.
- End commit messages with: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- NO em dashes anywhere in generated text.
- Keep heavy training scripts / large datasets OUT of the repo (gitignore them); commit only the
  engine code, the dataset-GENERATION code, tests, and (small) trained weights or a download link.
