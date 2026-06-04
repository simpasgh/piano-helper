# Own OMR engine — roadmap & build handoff

Self-contained plan so any session (esp. the one on the GPU PC) can pick up and execute
without the prior machine's local memory. Newest status at the top. NO em dashes in generated
text (project rule). Ship every code change through the gated flow (see "Constraints" below).

## STATUS: fusion keeps 4/4 for cut-time-equivalent meters (a Clarity 2/2 misread no longer relabels 4/4) (2026-06-04)

Follow-up to PR #191. `fusion.fuse` now keeps the 4/4 default when Clarity's borrowed meter is
metrically EQUIVALENT to 4/4 (`beats == beat_type`: the 2/2, 4/4, 8/8 family, all bar capacity 16 at
divisions=4), while still borrowing genuinely-different meters (2/4 cap 8, 3/4 cap 12, 6/8 cap 12, ...).
The whole fix is a one-line guard in `fuse` right after the borrow: `if beats == beat_type: beats,
beat_type = 4, 4`. WHY: Clarity misreads some genuine 4/4 pieces as 2/2 (cut time); at divisions=4 the
borrow was already metric-NEUTRAL (2/2 and 4/4 share bar capacity 16, byte-identical rhythm_repair
behaviour), but it printed a cut-time glyph on a 4/4 piece. The guard means a cut-time misread can no
longer relabel a genuine 4/4 piece; a TRUE 2/2 would render as cut time only once Clarity actually
distinguishes it (it does not today). Pure rendering fix, never-raise; CANNOT regress
note_f1/note_dur_f1/duration_acc because the bar capacity is unchanged.

VALIDATED on the box (`fusion_repair_eval.py`, before AND after via `RHY_SRC=/tmp/rhy`): every printed
number is IDENTICAL (liminality cap=[8] 1/56 -> 0/56; tctab cap=[16] 49/134 -> 12/134; icarus cap=[16]
6/47 -> 0/47; reverie cap=[16] 4/32 -> 1/32; no metric move on any piece). The only behaviour change is
the declared `<time>`: on the real cached engine outputs the fused meter now flips tctab 2/2 -> 4/4 and
icarus 2/2 -> 4/4, while liminality stays 2/4 and reverie stays 4/4. Unit tests in test_fusion.py:
2/2 -> 4/4, 8/8 -> 4/4, 2/4 -> 2/4, 3/4 -> 3/4.

## STATUS: fusion borrows Clarity's real TIME SIGNATURE (rhythm-repair now helps non-4/4) (2026-06-04)

Shipped PR #191; deployed to cx33 (ed1f003). The geom+Clarity fusion (prod-primary, `OMR_GEOM_FUSION=1`)
now declares Clarity's real `<time>` instead of hardcoding 4/4. `fusion._read_time` (never-raise,
mirrors `_read_fifths`) reads Clarity's `<beats>/<beat-type>`, threaded through `_build` into
`score_json_to_musicxml`; falls back to 4/4 on a no/garbage/senza-misura `<time>`. `divisions` stays 4
(LOAD-BEARING: the borrowed durations are `omr_eval._dur16` SIXTEENTHS and divisions=4 makes a duration
value of N == N ticks, so the borrowed numbers are usable as-is; only `<time>` changes). The KEY still
comes from geom; a non-C key borrow remains the next enhancement, pending a non-C validation piece (all
4 eval pieces are C major). The time sig is meter-agnostic to `omr_eval`'s per-(measure,staff)
(midi,dur16) scoring, so this CANNOT regress note_f1/note_dur_f1/duration_acc.

WHY IT MATTERS: rhythm_repair only repairs toward a CORROBORATED capacity (a meter a strong majority of
bars already sum to), so on the user's 2/4 "liminality" (which fusion declared 4/4) the repair was a
clean no-op. Borrowing the real meter lets it engage on non-4/4 pieces.

VALIDATED on the box (`fusion_repair_eval.py`, deployed code): liminality flips from `cap=[] / 0/0 -> 0/0`
to `cap=[8] / 1/56 -> 0/56` (its one incomplete bar completed); NO regression on note_dur_f1 /
duration_acc / note_f1 on any of the 4 pieces.

CLARITY METER-DETECTION NUANCE (surfaced, not a blocker): Clarity reads tctab and icarus as 2/2 (truth
4/4), reverie as 4/4, liminality as 2/4. At divisions=4, 2/2 and 4/4 share capacity 16, so borrowing
2/2 for tctab/icarus is metric-neutral and the repair behavior is byte-identical (same incomplete-bar
counts); only the printed time-signature glyph differs (cut-time vs 4/4). This is a Clarity
meter-detection limit, not a fusion one. RESOLVED in the follow-up above (the capacity-aware
refinement: `fuse` keeps the 4/4 default when Clarity's borrowed meter is metrically equivalent to it,
so a cut-time misread cannot relabel a genuine 4/4 piece); tctab/icarus now declare 4/4.

## STATUS: FULL-SYMBOL detector DATA PIPELINE shipped (steps 1-2); GPU train + decode is step 3 (2026-06-04)

The moat's data foundation is in. Two gated PRs merged: rich synthetic generation (#186) and
multi-class label extraction (#188). This is the build-up to a trained MULTI-CLASS symbol detector
that feeds the EXACT geometric decode of durations/key/accidentals/clefs/rests (the "measure, do
not predict" thesis extended past noteheads). Nothing is wired into the worker yet (research-only,
same contract as geom_omr was pre-deploy).

THE TAXONOMY (18 classes, single source of truth = `synth_render.CLASS_NAMES`, shared by BOTH the
synthetic generator and the DeepScores converter): notehead_filled, notehead_open, stem, flag,
beam, dot, accidental_{sharp,flat,natural,double_sharp,double_flat}, clef_{g,f,c}, rest, timesig,
tie, ottava. Heads split filled vs open (whole-vs-half is recovered from STEM presence, not a class).
Key-signature accidentals fold into accidental_* (identical glyph; the decode separates key-sig from
inline by x-position).

WHAT SHIPPED:
- `omr_eval.generate_rich_score` (#186): deterministic rich grand-staff scores (whole..sixteenth +
  dotted durations with correct beams, rests, dense chords, ALL keys with per-note accidentals,
  ties, clef-changes to bass/alto, ottava brackets, ledger-heavy). The MusicXML is its OWN ground
  truth: every visual glyph is INVISIBLE to reconcile.to_events, so a rich score self-scores 1.0 on
  pitch + duration + chords.
- `llm_omr.score_json_to_musicxml` (#186/#188): emits OPT-IN visual elements (type/dot/accidental/
  beam/tie, mid-measure clef changes, octave-shift direction) only when the event carries them, so
  the prod LLM path and the simple generator are byte-identical and unaffected.
- `synth_render` (#188): `glyph_to_class(css_class, smufl_code)` (pure, tested) + a render JS that
  reads every symbol group's SMuFL glyph code + pixel box via Playwright getBoundingClientRect.
  RenderedScore + draw_overlay are multi-class. Overlay sanity-check passed on every glyph type.
- `synth_dataset` (#188): builds the rich multi-class YOLO dataset + data.yaml (all classes) + a
  per-class distribution report.
- `deepscores_to_yolo` (#188): maps DeepScoresV2's 136 categories onto the SAME taxonomy (69 map;
  the rest dropped). Real data supplies the ties/ottava/clef_c that synthetic is sparse on.
- `train_detector` is now class-agnostic (reads data.yaml).

GOTCHAS worth not re-learning (verified live on this PC; the render path has NO CI coverage, so a
label bug ships green -- always overlay-check a few renders after touching synth_render):
- Verovio emits an EMPTY `<g class="accid"/>` placeholder for EVERY note (only ~the real ones get a
  glyph child). Filter by rendered bbox: drop only when BOTH w<=0 and h<=0; an empty placeholder is
  0x0, a real glyph has area.
- A STEM is a vertical line whose getBoundingClientRect WIDTH is ~0 (stroke excluded), so a naive
  w>0 filter drops ~90% of stems. Pad thin shapes to a minimum derived from the interline.
- Verovio NESTS the beamed notes' heads + stems INSIDE `<g class="beam">`, so the group's rect wraps
  the whole run (~4-5x oversized). The beam box must come from g.beam's DIRECT `<polygon>/<path>`
  strokes, not its getBoundingClientRect.
- Mid-score clef-CHANGE codepoints differ from the opening clef: E07A gClefChange, E07B cClefChange,
  E07C fClefChange (vs E050 gClef / E05C cClef / E062 fClef). Notehead codes: E0A4 black (filled),
  E0A3 half, E0A2 whole (open). Accidentals: E262 sharp, E260 flat, E261 natural, E263 dbl-sharp,
  E264 dbl-flat.
- verovio + playwright(chromium) are now pip-installed in the base Python 3.12 on this PC (the venv
  from the prior GPU session is gone). torch/ultralytics are NOT installed (step 3 needs the cu128
  wheel for Blackwell sm_120, per the older STATUS gotchas). Heavy datasets live OUTSIDE the repo
  under C:\Users\pascu\omr-train (gitignored); a couple of overlay sanity images are in omr-train/smoke.

STEP 3 (GPU, this PC) -- the remaining work to make it a real engine:
1. Build the full multi-class dataset: `python synth_dataset.py <out> --train 1500 --val 200` (each
   sample is a Playwright render, so this takes a while) + `python deepscores_to_yolo.py <ds_root>
   <out>` for real data; combine (see the prior combined.yaml approach).
2. Train multi-class YOLO (`train_detector.py --data <out>/data.yaml`); set up the cu128 torch venv
   first. Detection saturates fast for noteheads but the rarer symbols (double accidentals, clef_c,
   ottava) need enough epochs/examples; watch the per-class metrics.
3. Extend the EXACT decode in `geom_omr` / `geom_detector` to READ durations (head fill + stem +
   flag/beam + dots), key (count the clef-anchored sharps/flats), per-note accidentals, clefs, and
   rests FROM the detected glyphs (measure, do not predict) -- this is the payoff: it turns geom's
   duration_acc 0.0 into a real rhythm read and removes the oracle-key assumption.
4. Apply `synth_augment` photo augmentation; eval on `/opt/geom-omr/eval/real_scores/real_eval.py`
   (the user's 4 MuseScore pieces). Deploy weights+code to cx33 ONLY after it beats the current
   geom+Clarity fusion AND passes the eval.

## STATUS: rhythm REPAIR shipped (pitch-safe bar completion); note-stretching measured + REJECTED (2026-06-04)

Shipped `omr-worker/rhythm_repair.py`, the FINAL worker post-transform (runs after
`merge_to_grand_staff` + `normalize_ties` in process_job). It makes each measure's per-staff
durations sum to a CORROBORATED time signature, but PITCH-SAFELY only: it grows/shrinks/removes a
rest, or pads a short rest-free bar with a trailing rest. It NEVER changes a pitched note's duration
and never adds/deletes a note, so it is mathematically incapable of lowering note_dur_f1 /
duration_acc (the scorer ignores rests). Pure stdlib, never-raise.

MEASURED DEAD END (do NOT re-add naively): the obvious "disambiguate with the time signature" idea
-- when a bar is short by one note's worth of a simple misread (eighth-vs-quarter, a missed dot),
stretch THAT note -- was built (unique-culprit-only) and REGRESSED the real pieces (fusion
note_dur_f1 tctab 0.875 -> 0.863). A per-edit diagnostic vs ground truth (`repair_diag.py` on the
box) showed 7 of 9 such edits stretched a note that was ALREADY CORRECT: the bar was short because a
note was DROPPED, not misread, and from the bar sum alone you cannot tell an under-read note from a
correct note beside a missing one. In real engine output missing notes dominate. A metric WIN at
this layer is impossible anyway: the dropped note's PITCH is unrecoverable post-hoc and the rhythm
metric keys on (midi, dur16), so you cannot earn a duration match without first recovering the pitch.

VALIDATION (fusion path = geom + Clarity, the prod primary; harness `fusion_repair_eval.py` on the
box at /opt/geom-omr/eval/real_scores): NO regression on note_dur_f1 / duration_acc / note_f1 on any
of the 4 pieces, and the incomplete-bar count dropped tctab 49->12, icarus 6->0, reverie 4->1 (the
remaining bars are OVERFULL, left untouched by design since shrinking a pitched note is the same
unsafe guess). liminality is a clean no-op: it is really 2/4 but fusion hardcodes 4/4, so the
corroboration guard (a capacity is trusted only when a strong majority of bars already sum to it)
refuses to act. So the deliverable is a RENDERING fix: incomplete bars now render at true width with
the missing beat shown as a rest (the user's reported symptom), guaranteed never-worse on the metric.

NEXT (for a real rhythm metric win): needs per-note duration CONFIDENCE from the engine (then a
targeted low-confidence-only edit is safe) or recovering the DROPPED notes (a detection problem),
not a bar-sum post-transform. (UPDATE: borrowing Clarity's real `<time>` SHIPPED in PR #191, so the
repair now helps non-4/4 pieces like liminality; see the top STATUS. divisions still stays 4.)

## STATUS: PROGRESSIVE delivery shipped (notes in ~5s, rhythm refines) (2026-06-04)

OMR is now PROGRESSIVE (gated, default OFF): the worker writes the result key MULTIPLE times per job so
the browser renders the first notes while the rest computes, instead of waiting ~100s for the whole
file. `OMR_PROGRESSIVE` = fast-then-refine (geom's pitch-only result published as an omr-status=partial
in ~5s, then the fused geom+Clarity result as the complete). `OMR_PROGRESSIVE_PAGES` = per-page
streaming for multi-page PDFs (each page transcribed + fused + appended in document order, so measure 1
shows while measure 20 is still being recognized). This is a DELIVERY change, orthogonal to engine
ACCURACY: the engine output is byte-identical, just published incrementally. Architecture + rollout are
in tech-lead.md / infrastructure.md (2026-06-04). The accuracy levers below are unchanged: RHYTHM /
durations is still the top engine lever (and the reason fast-then-refine helps so much - the geom
partial already has every pitch, only the slow Clarity rhythm is what the user now waits on in the
background instead of up front).

## STATUS: detection robustness SHIPPED; geom runs PRIMARY on cx33; rhythm is next (2026-06-03)

geom is now the PRIMARY engine on the cx33 worker (`OMR_GEOM=1` + `OMR_GEOM_PRIMARY=1`, wins-first,
box at `2ce71a6`). The role is an env toggle (PR #181): drop `OMR_GEOM_PRIMARY` to demote it to the
never-worse fallback. The user re-confirmed primary after the detection fix below, accepting the
documented caveat that geom still fabricates rhythm. See memory deploy-geom-cx33.

DETECTION ROBUSTNESS shipped (PR #182), the lever the previous STATUS flagged. A real-score eval
showed the YOLO detector was NOT the bottleneck (it finds ~truth-count heads on every piece);
`detect_systems` was. Real engravings interleave near-full-width INTRUDER rows (a beam over beamed
eighths, a dense note/ledger row, tempo text) among the 5 staff lines, inflating a staff to 6-7
detected lines; the old "keep only groups whose size is a multiple of 5" rule then dropped the whole
staff (icarus detected 5 staves not 6; reverie 4 not 8, orphaning 135 of 185 found heads).
`geom_omr._extract_staves` now cuts the page into regions and picks the 5 real lines by THINNESS (a
staff line is a thin full-width rule; a beam/text/dense-note row is thicker), and
`geom_detector._auto_imgsz` scales the YOLO imgsz with the image long side (a 2-page stitch was
downscaled too far at imgsz 1280: tctab 321 heads -> 470). Real-score note_f1 (oracle key):
liminality 0.946 (no regression), tctab 0.719 -> 0.995, icarus 0.394 -> 0.990, reverie 0.136 -> 0.476.

NEXT LEVERS (in order): (1) **rhythm / durations** -- now the top lever AND urgent because geom is
primary: every note still gets `duration: 1` (duration_acc 0.0 on all 4 pieces), so wins-first geom
ships rhythm-uniform transcriptions ahead of Clarity on every upload. Needs note-type CV (head fill
open/filled, stems, flags/beams, dots; `detect_noteheads` already computes a fill ratio). (2)
key-signature detection (removes the oracle-key assumption). (3) **ottava / 8va** -- reverie's
residual: all 185 heads are found and the first half decodes perfectly, but its truth has 4
`<octave-shift>` brackets and geom reads the WRITTEN position (pred = truth - 12 in the bracketed
region; liminality has ottavas too but they cover little of the piece). (4) chords.

Eval harness recreated at `/opt/geom-omr/eval/real_scores/real_eval.py` on the box (rasterize at 350
DPI, run the deployed `transcribe_with_detector`, score vs MusicXML with the oracle key; set
`GEOM_SRC=/dir` to test un-merged engine files before deploy). GOTCHA: GitHub CI runs only the JS
typecheck/build/test, NOT the omr-worker pytest suite, so a red Python test can hide behind a green
CI; run `cd omr-worker && python3 -m pytest -q` locally before merge.

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
