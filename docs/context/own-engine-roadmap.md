# Own OMR engine — roadmap & build handoff

Self-contained plan so any session (esp. the one on the GPU PC) can pick up and execute
without the prior machine's local memory. Newest status at the top. NO em dashes in generated
text (project rule). Ship every code change through the gated flow (see "Constraints" below).

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
