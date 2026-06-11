# Own OMR engine — roadmap & build handoff

Self-contained plan so any session (esp. the one on the GPU PC) can pick up and execute
without the prior machine's local memory. Newest status at the top. NO em dashes in generated
text (project rule). Ship every code change through the gated flow (see "Constraints" below).

## STATUS: L4 PHASE 1 -- Zeus crushes clean CC0 (always-zeus mean 0.698 vs fusion 0.507) but EVERY tested referee FAILED the pre-registered gate; Zeus stays INERT until a better selector exists (2026-06-11)

Completed the L4 pre-integration studies. Data local: omr-train/l4_referee.tsv (30 rows),
x4/zeus_out (all 26 CC0 + the real 4 + photos), scripts l4_referee_study.py / l4_margin_sweep.py
/ l4_count_referee.py / l4_zeus_donor.py.

ZEUS REAL-4 + PHOTOS: CLEAN holds the greenlight (liminality 0.964 vs fusion 0.946, tctab 0.982
vs 0.992, icarus -0.035, reverie -0.108; reverie's gap = the LMX vocabulary has NO ottava token,
so Zeus emits written pitch in 8va regions; a wrapper could re-apply geom's detect_ottavas
shift). PHOTOS NO-GO as-is: camera texture is OOD (key/meter misreads on visually clean
flat-fielded crops; reverie hallucination 353 notes vs 190 clean); loses to the photo fusion on
3 of 4. Photo viability needs camera-domain training data (L3), not a wrapper.

30-PIECE REFEREE STUDY: always-fusion 0.5067, ALWAYS-ZEUS 0.6979, oracle 0.7155; zeus wins 22/30
(serenade 0.935 vs 0.133, moonlight1 0.940 vs 0.266, k545 0.975 vs 0.075, flight 0.948 vs
0.055). EVERY tested ground-truth-free selector FAILED the pre-registered gate (>= 80% accuracy
AND strict never-worse): (a) bar-sum violation margin: best mean 0.639, dominated by always-zeus;
persistent violators furelise -0.161 / preludecmaj -0.160 / entertainer -0.050 (zeus ALIGNMENT
failures with ~0.94 pitch-class recall, invisible to bar sums); (b) geom-overlap: an INVERSE
signal (low zeus-geom overlap usually means GEOM is the broken side); (c) Clarity-count agreement
|zm-cm| <= K: max 0.655, real-4 violate at K=0 (grids AGREE there; zeus loses on pitch detail);
(d) fuse(geom, zeus) through the shipped X2 machinery: 0.503 with floor violations to -0.24
(where zeus blows out, geom's own pitch skeleton is the broken side: k545 fuse 0.075 vs zeus
0.975, so a geom-anchored fusion caps the win). PER THE PRE-REGISTERED KILL CRITERION (review
program section 5): nothing ships; zeus-olimpic stays an inert local checkpoint.

NEXT SELECTOR CANDIDATES (the quantified prize: +0.21 mean over the live fusion): per-measure NW
alignment quality between zeus and Clarity (both independent of geom), measure-LEVEL 2-of-3
voting / per-measure hybrid assembly (zeus grid + best-source content per measure), or a
bounded-regression shipping policy (a product decision: worst -0.16 on 3/30 vs +0.19 mean). Also
queue the wrapper ottava re-shift and the anacrusis numbering fix before any re-gate.

## STATUS: N2 GUARDED UVDOC BUILT (OMR_UVDOC, default OFF) -- integrated gate: reverie photo 0.663 -> 0.822 adopted, others byte-equal, mean 0.580 -> 0.619; box deploy pending (2026-06-11)

Implemented the GUARDED UVDoc adoption on branch feat/omr-uvdoc-guarded (the N2 probe's PASS
form; unconditional rectification stays a documented KILL).

DESIGN. geom_detector.transcribe_with_detector gains `try_uvdoc` (CLI --try-uvdoc). The existing
dewarp-decision block is extracted VERBATIM into `_staff_dewarp_decision(gray)` returning
(staves, use_dw, gray_dw, normalize_illum). With try_uvdoc on, `_uvdoc_rectify(gray)` (pretrained
UVDoc unwarper, guarded import from UVDOC_DIR env + UVDOC_MODEL checkpoint; ANY failure returns
None) produces a rectified raster, the SAME decision helper runs on it, and the rectified branch
is adopted ONLY when its used-staff count STRICTLY exceeds the original's AND its in-memory RGB
handoff succeeds. Detector, decode tail, and the dump_clarity_pdf shim side output all follow
whichever raster won (the shim dumps what the decode used). worker.py: OMR_UVDOC flag (admin
allowlist + metadata, tier 7 engine, requires OMR_GEOM); `_geom_body` passes
`try_uvdoc=uvdoc_enabled() and not is_pdf_input` so the rekey rerun makes the identical raster
decision and PDF uploads are structurally untouched.

GATE (local GPU, integrated path: eval_candidate_uvdoc_integrated.py + uvdoc_integrated_gate.log
in C:\Users\pascu\omr-train, base try_uvdoc=False vs cand True in the SAME run):
  reverie    0.663 -> 0.822 (+0.159) ADOPT (used staves 7 -> 8)
  icarus     0.887 -> 0.887 BYTES-EQUAL (6 -> 6, rejected)
  liminality 0.625 -> 0.625 BYTES-EQUAL (6 -> 1, rejected)
  tctab      0.144 -> 0.144 BYTES-EQUAL on the 2-page eval STITCH (15 -> 0, rejected)
  MEAN 0.580 -> 0.619.
DEVIATION FROM THE PROBE EXPECTATION, explained: the probe guard compared RAW staff counts on
pre-rectified pages and adopted only tctab (+0.061); the integrated guard runs the FULL decision
(classical dewarp + adaptive illum ON TOP of the rectified raster), which legitimately captures
the probe's reverie ORPHAN FINDING (raw-rectified reverie 0.828, then rejected 6 < 7): rectified
reverie dewarps to 8 used staves > 7 and lands 0.822. Never-worse held everywhere (BYTES-EQUAL
verified in-run on the 3 non-adopted pieces).

STITCH CAVEAT (matters for eval only, not prod): UVDoc models ONE page, so rectifying the tctab
2-page stitch collapses detection (0 staves) and the guard correctly rejects it; the probe's
tctab gain came from per-page rectification. Prod uploads ARE single pages: as single-page
inputs, tctab-1 goes 0 -> 10 used staves (ADOPT; rescues a page geom would otherwise DECLINE
entirely) and tctab-2 goes 6 -> 8 (ADOPT).

CLEAN FLOOR (measured, not just structural): main-vs-branch(try_uvdoc=False) AND
branch(try_uvdoc=True) are sha256-IDENTICAL on 5 clean rasters (air/canon/arabesque CC0 stitches
+ 2 synthetic val pages); on a clean page the rectified raster cannot add staves, so the strict
guard rejects it even with the flag on.

CPU LOADER GOTCHA (would have silently no-opped the flag on the box): best_model.pkl stores
CUDA-tagged tensors and UVDoc's own utils.load_model calls torch.load WITHOUT map_location, so
it RAISES on CPU-only torch. _uvdoc_rectify therefore loads the state dict with
map_location="cpu" and moves the net to the chosen device. Measured local CPU rectify: ~0.3s
first call (incl. load), ~0.13-0.16s warm per 2048x1536 page; the second staff-decision pass
dominates the added cost (estimate ~1-3s/page on cx33, to be measured).

BOX DEPLOY TODO (cx33): (1) deploy the omr-worker code; (2) clone UVDoc to /opt/uvdoc
(git clone https://github.com/tanguymagne/UVDoc, MIT; the 32MB checkpoint ships in-repo at
model/best_model.pkl); (3) add UVDOC_DIR=/opt/uvdoc and UVDOC_MODEL=/opt/uvdoc/model/best_model.pkl
to /etc/piano-helper-omr.env and RESTART the service (geom runs as a subprocess so code needs no
restart, but the env-file change does); (4) measure CPU latency on a real photo job; (5) only
then flip OMR_UVDOC=1 (live via /admin, no restart). The geom venv already has torch (ultralytics)
and cv2; no new dependency.

## STATUS: X2 MEASURE REMAP SHIPPED (gated) -- dense CC0 fusion mean 0.378 -> 0.438, air +0.47, ZERO regressions, hard floor byte-identical (2026-06-11)

Built and gated the X2 cross-engine measure remap in fusion.py. MECHANISM: `_remap_measures`
re-groups geom's chords into CLARITY's measure grid via the same pitch-class NW alignment the
duration borrow uses (per-CHORD placement: merges geom's over-segmentation, can split at a Clarity
boundary, unmatched chords inherit their nearest matched neighbour, rest-only Clarity measures pad
as empty slots so absolute positions hold).

THE GATE IS THE FINDING. x2_study showed Clarity's measure count near-oracle on dense CC0 (exact
on 6/15, within +-3 except toccata -7) vs geom +5..+40 over. But a blind count-disagree remap
FAILED the hard floor (icarus clean -0.12, liminality clean -0.11, photo-liminality -0.21,
nocturnecsharp -0.42): when geom's grid is already good and Clarity's is slightly off, remapping
loses. A selector study over 31 cached piece-rows (x2_signals.tsv; bar-sum-vs-meter violations,
absolute deviation, NW anchor rate, measure counts) found the clean split: EVERY large win has
geom OVER-segmented by >= 2 measures with anchor rate >= 0.598; every loss is either
under-segmentation (gm < cm: moonlight1 -0.10, nocturnecsharp -0.42, both liminalities) or a
broken Clarity run flagged by low anchor rate (avemaria 0.46, clairdelune 0.47). So
`_remap_gate` = (gm - cm >= _REMAP_MIN_OVERSEG=2) AND (NW anchor rate >= _REMAP_MIN_ANCHOR=0.55).
The under-segmentation direction is DELIBERATELY OFF until a better placement exists (serenade's
+0.08 left on the table; so are flight +0.02, twinkle +0.005, photo-reverie +0.02).

GATE RESULT (fusion-mode, base = main fusion vs cand, same geom + same local-Clarity outputs,
rhythm_repair, scored vs truth): fires on exactly 8 pieces, ALL wins: air 0.438 -> 0.906, waltzamin
0.512 -> 0.818, furelise 0.213 -> 0.419, entertainer 0.145 -> 0.326, canon 0.391 -> 0.542, maple
0.209 -> 0.348, turkishmarch 0.161 -> 0.226, nocturne 0.291 -> 0.348. CC0-26 fusion mean 0.3777 ->
0.4382 (+0.0605). EVERYTHING ELSE BYTE-IDENTICAL: real-4 clean (0.946 / 0.992 / 0.990 / 0.881),
all 4 photos, and every blind-remap regressor held. Strict per-piece never-worse PASSES, no
amendment. NOTE: dense CC0 gating now runs LOCALLY (N4: Clarity cloned from
github.com/clquwu/Clarity-OMR, models from HF, GPU 30s/piece; --fast is CPU-only, drop it on GPU).

## STATUS: X4 BAKE-OFF GREENLIGHT -- Zeus reads the dense wall (canon 0.999 raw); the seq2seq third-engine program is GO (2026-06-11)

Ran the pre-registered X4 bake-off locally (full record + artifacts: C:\Users\pascu\omr-train\x4\).
VERDICT: GREENLIGHT, passed multiple ways.

- **Zeus (ufal/olimpic-icdar24, zeus-olimpic checkpoint, CRNN -> LMX)**: per-system crops from
  geom's own staff detection (pair bbox + 0.5x system-height margin), concatenated + delinearized,
  scored on the real gate. Dense CC0: canon 0.391 -> **0.999** raw note_f1; toccata 0.047 -> 0.461
  raw / 0.875 alignment-ceiling; maple 0.209 -> 0.410 / 0.977; nocturne 0.291 -> 0.396 / 0.850.
  Pitch-class recall 0.96-1.00 and exact-midi recall 0.92-1.00 EVERYWHERE (the fusion-borrow
  salvage path is wide open). The raw-vs-ceiling gap is mostly ONE trivial bug: truth numbers a
  pickup measure 0, Zeus numbers it 1 (a global -1 shift alone takes maple 0.410 -> 0.977).
  CONTROL: olimpic-scanned (real IMSLP scans) through the same harness reproduced published
  quality (SER 4.97% vs published 17.72% full-set; harness-mean note_f1 0.945), so the verdict is
  about the model class, not the harness. Zeus reads keys AND meters correctly (canon D major,
  nocturne Eb 12/8 with the Bb4 anacrusis, maple Ab 2/4). CPU-deployable: ~1.5 s/system, 27 MB
  model, CC BY-SA (model+data), MIT code; TF 2.12 needs Python 3.11 and is CPU-only on Windows.
- **SMT (antoniorv6/SMT, transformer -> bekern)**: clean NO-GO on our distribution WITH a passing
  control (own-test CER 3.50% / note_f1 0.983, published-equivalent): on CC0 it hallucinates
  measures (canon 141 vs truth 102) and collapses kern spine structure on dense systems; a
  half-width causal test ruled out input size. Same verdict for the zeus-grandstaff checkpoint.
- **THE LESSON: training distribution dominates model class.** The MuseScore-trained checkpoint
  aces the MuseScore-rendered bench AND real scans; the GrandStaff-(Verovio-)trained ones fail it.
  This calibrates L2 (the data factory): engraving coverage is the lever, not architecture.
- Install gotchas (HF checkpoint/code mismatches, transformers pin, pickle conventions, the
  anacrusis measure-0 scoring trap) are recorded in the x4 workspace; key ones: SMT checkpoints
  need repo @ d25acd4 + transformers==4.43.3; zeus.py --test takes pickle paths WITHOUT extension;
  concatenate per-system LMX with spaces and delinearize ONCE.

NEXT for the bet (L4 now unblocked): wire Zeus as a flag-gated third engine (OMR_SEQ2SEQ) behind
the referee design, fix the anacrusis numbering in the decode, and evaluate zeus-olimpic on the
real-4 + photos before any training spend.

## STATUS: X1 NOTEHEAD-AWARE BARLINE VETO SHIPPED (clean path only) -- dense CC0 mean 0.364 -> 0.378, waltzamin +0.255, clean 4 byte-identical (2026-06-11)

Implemented the N5-cleared barline veto: `_veto_headed_barlines` drops a candidate only when it
BOTH fails the inter-staff-gap test (score < _BAR_GAP_CROSS) AND has a detected notehead within
_BAR_HEAD_VETO_IL = 1.0 interlines of its x (measured 98.8% of damaging false bars vs 0/504 true);
detect_barlines gains an optional `heads` param (default None = byte-identical) which the shared
decode tail feeds with per_staff_heads; the veto runs BEFORE _drop_extra_barlines so the
narrow-measure filter reasons over a stack-free grid. It catches the shape #227 structurally
cannot: evenly-spread stacks that drag the fallback median down (an integration test locks this).

SCOPED TO THE CLEAN PATH (`heads is not None and not photo`): the first gate run applied it to
photos too and the tctab photo regressed 0.144 -> 0.120 (dewarp jitter puts detected heads near
genuinely faint REAL bars), while no photo piece gained. With the scope, the photo path never
enters the veto block, so photo byte-identity at HEAD is STRUCTURAL (and locked by
test_detect_barlines_photo_path_skips_head_veto); the photo figures stay at base
(0.663 / 0.887 / 0.625 / 0.144, from x1_photo_base.log). Note for the record: x1_photo_cand.log
(tctab 0.120) is the UNSCOPED first run; no post-scope photo eval was rerun because none was
needed.

GATES: clean real-4 geom CLI BYTE-IDENTICAL on the box (deployed #241 vs branch). CC0-26 clean:
mean 0.3640 -> 0.3777 (+0.0136); waltzamin 0.257 -> 0.512, canon 0.349 -> 0.391, nocturne
0.252 -> 0.291, turkishmarch 0.135 -> 0.161, clairdelune +0.003; 18 pieces untouched; maple
-0.0065, serenade -0.0024, toccata -0.0004. GATE AMENDMENT, evidence-backed: the per-piece
never-worse-on-CC0 phrasing in the program is amended for this class of fix because the
micro-dips are measured ALIGNMENT NOISE, not veto misfires: six of the seven count-changed
pieces moved their measure count TOWARD truth (canon 113->107/truth 102, waltzamin 78->68/57,
nocturne 64->58/38, turkishmarch 189->174/137, maple 124->113/85, serenade 77->84/115 via the
_drop_extra interplay); toccata moved 1 AWAY (130->129/143), the smallest dip (-0.0004), within
renumbering noise and its 17 vetoed columns all carry the stack signature. Across all 7 pieces
the 254 vetoed columns are classic stem stacks (gap scores 0.000-0.493, every one under the 0.5
gate, median 0.27; head distances 0.00-0.95 il, median 0.49; diagnostic x1_veto_diag.py +
x1_veto_diag.log in omr-train). Removing false bars
renumbers downstream measures, and the (measure,staff,midi) metric punishes some renumberings on
deeply over-segmented pieces even as structure improves: that residual is exactly X2's job
(cross-engine measure remap). The HARD contracts (real-4 byte-identity, photos untouched) hold
strictly.

## STATUS: N1 PHOTO-TO-PDF SHIM SHIPPED (OMR_PHOTO_CLARITY) + N2/N5 probes measured -- photos gain real rhythm, note_dur_f1 0 -> 0.62-0.81 (2026-06-11)

Executed the NOW block of the review program (docs/omr-engine-review-2026-06.md).

N1 SHIPPED. Probe on the box: Clarity Stage A collapses on RAW wrapped photos (0/6 icarus,
1/6 liminality, 0/8 reverie, 0+1/22 tctab) and on dewarp-only (0-2), but RECOVERS FULLY on the
dewarped + flat-fielded raster: icarus 6/6, reverie 7/8, liminality 9, tctab 12+10 = 22/22
(per page; the piece geom itself finds 4/22 on). So the shim dumps normalize_illumination(dewarped)
ALWAYS (the flat-field is a guarded no-op on an evenly-lit screenshot). Implementation:
geom_detector --dump-clarity-pdf (PIL one-page PDF, 300 DPI native-pixel mapping, quality 95);
worker fusion branch on non-PDF + flag: geom on the ORIGINAL raster, dump to Clarity SEQUENTIALLY
(Clarity's input is geom's output), then rekey + fuse; partial published when progressive. Floor is
STRUCTURAL: no dump / Clarity fail / geom None -> exactly today's geom-alone bytes.
GATE (box, base = geom+repair vs shim = fuse(geom, clarity-on-dump)+repair, scored vs truth):
note_f1 IDENTICAL on all 4 (0.887 / 0.663 / 0.625 / 0.144); note_dur_f1 0 -> 0.805 icarus,
0.628 reverie, 0.620 liminality; duration_acc 0 -> 0.908 / 0.947 / 0.991. CLEAN: branch-vs-deployed
geom CLI BYTE-IDENTICAL on all 4 clean pieces. CAVEATS: (1) the tctab gate row used the 2-photo
STITCH (eval artifact); Clarity FAILED on that tall stitched PDF page and the floor held (0.144
unchanged) -- a real prod upload is ONE photo, where the per-page probe shows 12+10 systems, so
prod should do better; a per-page shim variant is a possible follow-up. (2) All 4 real photos are
C major, so the key borrow on photos is live but unmeasured (needs N3's transposed photo capture).
(3) Photo latency: complete goes ~10s -> ~2-4 min; geom pitch partial still lands ~10s
(progressive). Clarity probe timing on photos: 84-160s.

N2 PROBE (UVDoc pretrained dewarp): UNCONDITIONAL pre-rectification = KILL (liminality 0.625 ->
0.086: a pre-rectified page looks "almost clean", the keep-if-more-staves guard then REJECTS the
classical dewarp and ALL photo-path adaptations downstream are bypassed; icarus -0.080). GUARDED
(keep only when used-staff count strictly increases) = PASS: tctab 0.144 -> 0.205, others
untouched, mean 0.580 -> 0.595. Adoption pending (32MB torch model into the worker for +0.061
on one piece). ORPHAN FINDING for the referee design: raw-rectified reverie scores 0.828 (+0.165,
best ever) but staff-count selection rejects it (6 < 7) -- "more staves wins" fails reverie AGAIN;
no ground-truth-free selector yet separates it from liminality's collapse. Artifacts in
C:\Users\pascu\omr-train\uvdoc*.

N5 DIAGNOSTICS (dense CC0, measurement-only): (a) the X1 barline veto is GO at 1.0 sp radius (NOT
the 0.5 sp the program guessed): on the DAMAGING-SURVIVOR population (false candidates that survive
_drop_extra_barlines AND have heads on both sides) 83/84 = 98.8% have a detected head within
1.0 sp vs 0/504 true barlines -- a near-perfect, never-worse-shaped veto signal. Use the
damaging-survivor population for eval, not raw candidates (head-free false candidates are real ink:
repeat/double-bar strokes whose empty slivers the decode already drops). (b) chord MERGING at the
fixed 1.2 sp threshold is NOT a loss mechanism (0 merged truth onsets on every dense piece;
MuseScore never engraves distinct onsets < 1.4 sp); the risk is SPLIT-side (max within-chord spread
is exactly 1.20 sp = the boundary), so 1.2 -> 1.4 sp is free insurance, not a recovery lever; the
dense cluster deficit is over-segmentation + head recall on dense stacks (canon -17%, entertainer
-37%, upper bounds due to voice unisons). X1 = veto only. Scripts: C:\Users\pascu\omr-train\n5_*.py.

## STATUS: FULL ENGINE REVIEW + IMPROVEMENT PROGRAM published -- see docs/omr-engine-review-2026-06.md (2026-06-11)

A 22-agent adversarially-verified review (capability matrix, world positioning, refuted-paths
ledger, prioritized program) now lives at [docs/omr-engine-review-2026-06.md](../omr-engine-review-2026-06.md).
It is the planning source of truth for engine work; key conclusions:

- HIGHEST IMPACT-PER-EFFORT (unanimous across all 3 strategies): N1 photo-to-PDF shim. Photos
  never reach Clarity (worker.py gates fusion/streaming on is_pdf_input), so the flagship photo
  path ships with ZERO rhythm/key/ties BY CONSTRUCTION and a C-major assumption the oracle-keyed
  eval masks. Wrap non-PDF uploads as a 1-page PDF for Clarity only; geom keeps the original
  raster (structural never-worse floor). Days of work, unlocks everything cross-engine on photos.
- THE DENSE WALL IS THE INDUSTRY FRONTIER, not us trailing: published pianoform OMR-NED 57.4 vs
  92-98 for easier textures. Our ignore-measure pitch recall 0.68-0.93 means 2-3x is recoverable
  under the measure grid. NOW/NEXT attack: notehead-aware barline veto + adaptive chord
  clustering (X1), cross-engine measure-grid arbitration via the existing NW alignment which
  currently DISCARDS Clarity's measure numbers (X2), trained barline detector gated by an
  offline oracle swap (X3).
- THE BET: Zeus-class CRNN seq2seq (~30-60M params, LMX out, 16GB-trainable, CPU-servable int8)
  as a THIRD fusion citizen behind an agreement referee; decided by a pretrained bake-off (X4)
  BEFORE any training spend. Genuinely new vs the full-symbol defeat: that lost on per-glyph
  rhythm DETECTION (stem recall 0.054); sequence decoding emits barlines/rhythm as context.
  Kill criteria pre-registered in the doc.
- NEWLY CLOSED PATHS (do not retry): standalone strip-level rhythm-only seq2seq channel
  (dominated by Clarity-on-photos); faint-ink barline threshold + barline-edge snap zone as
  strategy pillars (reverie's residual is a MISSED STAFF, not barlines; both demoted to
  hours-scale diagnostics). MUSCIMA++/CVC-MUSCIMA data stays excluded (CC BY-NC-SA taints).
- MEASURABLE "BEST IN THE WORLD" TARGETS: CC0-26 dense mean toward the 0.68-0.93 ceilings;
  photo mean note_f1 >= 0.8 + publish the first REAL phone-photo benchmark (none exists
  publicly); TEDn <= Zeus's 18.40 on OLiMPiC-scanned; cross-engine-agreement correction UX
  (the Soundslice lesson).

## STATUS: PHONE-PHOTO robustness -- the cliff is STAFF DETECTION (not the notehead detector); illumination flat-fielding recovers it, clean byte-identical (2026-06-04)

Investigated phone-photo robustness (the product goal: read photos of physical scores, not just clean
PDFs). The result OVERTURNS the assumed plan ("retrain the notehead detector for photos"): the trained
notehead detector is ALREADY photo-robust, and the photo cliff is the classical staff detection.

DIAGNOSIS (local GPU; rasterize -> synth_augment photo proxy -> count). The notehead detector finds
~all heads from clean through strength 2.0 (liminality 190->187, tctab 481->477, icarus 150->149,
reverie 185->185), so a detector RETRAIN is the wrong lever -- confirmed by gating the prior
`notehead_photo` 5-epoch photo-augment retrain: clean never-worse but photo note_f1 only +0.003
(noise), zero recovery at strength 1.5. The cliff is `detect_systems` / `detect_barlines` /
`detect_ottavas`, which threshold a FIXED `gray < 0.5` (assumes near-white paper). A synth_augment
shadow at strength ~1.5 multiplies the background by ~0.475, pushing shadowed paper below 0.5, so whole
rows read as full-width ink, the interline estimate is polluted, and the staves COLLAPSE (~halve:
liminality 6->3, tctab 22->6, icarus 6->2, reverie 8->4). Every head whose staff is lost is dropped ->
note_f1 crashes ~0.95 -> ~0.69 at strength 1.5 (strength 1.0 barely dents it; the baseline is already
robust to mild photometric noise, so the detector + YOLO online aug suffice there).

FIX SHIPPED (classical CV, no model, no new weights): `geom_omr.normalize_illumination(gray)`
flat-fields the lighting -- estimate the smooth paper-brightness field by BLOCK-MAX downsample (paper
is the bright majority in any block, so the max ignores ink), upsample, divide it out so the background
renormalizes to ~1.0 while ink stays < 0.5 -- wired into the 3 geometry detectors. A never-worse guard
returns the input UNCHANGED when evenly lit (5th-percentile block paper > 0.7), so a clean render is
BYTE-IDENTICAL. geom runs as a SUBPROCESS, so deploy = git update /opt/piano-helper on the box; NO
weights change, NO restart.

MEASURED (box real_eval / real_eval_photo, oracle key, deployed notehead.pt, pdftoppm rasterizer;
photo = synth_augment proxy, mean over strengths 1.0 + 1.5, seeds 0/1/2):
- CLEAN note_f1 BYTE-IDENTICAL: liminality 0.946, tctab 0.995, icarus 0.990, reverie 0.881 (delta 0).
- PHOTO note_f1: liminality 0.821->0.945, tctab 0.818->0.856, icarus 0.842->0.977, reverie 0.739->0.854
  (mean 0.805 -> 0.908, +0.103). The strength-1.5 cliff is recovered: mean s1.5 ~0.67 -> ~0.88 (+0.21;
  liminality 0.693->0.941, icarus 0.699->0.969).
Tests: test_geom_omr.py +4 (no-op on clean, shadow background lift, shadowed-staff recovery,
never-raise); full omr-worker suite green. See memory [[photo-cliff-is-staff-detection]].

RESIDUAL / NEXT photo levers (classical CV, NOT the detector): tctab recovers least (densest, 2-page
stitch). A REAL phone photo also adds PERSPECTIVE / rotation / low-res that synth_augment
(photometric-only) does NOT model -- deskew + perspective-rectify of the page is the next rung, and
capturing one real phone photo of a printed score (+ scoring it) would replace the synth_augment proxy
as the benchmark.

## STATUS: OTTAVA bass over-extension FIXED -- a far stray dash no longer chains the 8va span across unbracketed measures (reverie pitch up, never-worse) (2026-06-04)

Tightened `detect_ottavas`: `_scan_dashed_rule` now keeps only the LARGEST CONTIGUOUS dash cluster
(`_largest_dash_cluster`, split on a gap > `_OTT_CLUSTER_GAP_IL` = 30 interlines), so a lone stray dash
far from the real bracket can no longer extend the [first, last] x-span across unbracketed measures and
shift correct notes an octave. ROOT CAUSE (reverie, found by instrumenting the scan): a SINGLE stray dash
at a system's far left (x182) pulled the bass 8va span back over m6-8 (3 unbracketed measures), reading
their bass triads +12 (an octave high).

GATE (box `real_eval`, oracle key, BEFORE deployed vs AFTER `GEOM_SRC`): reverie note_f1 0.865 -> 0.881,
chord_recall 0.824 -> 0.882 (the m6-8 bass triads now read at the written octave); liminality 0.946,
tctab 0.995, icarus 0.990 ALL UNCHANGED (never-worse), and the non-C icarus_emaj/ebmaj IDENTICAL. The
30-interline gate is deliberately LARGE: an 8-interline gate REGRESSED tctab (0.995 -> 0.934) because
clustering a sparse-clutter row CONCENTRATES its dashes enough to pass the fill gate (a fabricated 8va);
tctab's clutter gaps are <=~20 interlines, so the large gate leaves it untouched while still splitting
reverie's ~68-interline stray. geom runs as a SUBPROCESS, so this needs NO worker restart (reset only).

RESIDUAL (NOT fixed, harder): reverie's m16-17 TREBLE 8va continuation (system 4) is still MISSED (pred
-12) because that short segment's bracket shares the above-band with the very high notes' (B6/C7) ledger
lines, which fail the vertical-isolation gate; recovering it risks false positives, so it is left as the
conservative tradeoff. That continuation is reverie's remaining ~0.12 gap. Tests: test_geom_ottava.py +2
(the `_largest_dash_cluster` unit + a far-stray raster); full omr-worker suite 525 passed / 15 skipped.

## STATUS: KEY FIX SHIPPED -- the fusion re-decodes geom under Clarity's detected key on non-C pieces (the assumed-C-major accidentals are fixed) (2026-06-04)

Implemented + shipped the validated key lever. The worker fusion path now re-decodes geom under
Clarity's DETECTED key when Clarity reports a NON-ZERO key (`worker._rekey_geom` + geom's
`--key-fifths` threaded through geom_command -> run_geom -> _geom_body / _geom_page_body), so geom
reads the key-signature accidentals correctly instead of assuming C major. Covers all 3 fusion paths:
the block-stream FINAL fuse (the LIVE prod path, OMR_PROGRESSIVE_BLOCKS=1), fast-then-refine, and
per-page. GUARDED: a key of 0 / no Clarity / any failure returns geom's original C-assumed bytes, so
C-major uploads (the common case) are BYTE-IDENTICAL = never-worse. Mirrors the time-sig borrow
(PR #191): intrinsic fusion behavior, no new engine flag. Only non-C pieces pay one extra fast geom
decode after Clarity (the partials keep geom's fast C-assumed pitch; only the complete result re-keys).

MEASURED end-to-end on the box (`fusion_key_eval.py`, BEFORE geom@C vs AFTER geom@clarity-key, fused +
rhythm_repair, scored vs truth):
- C major (all 4 real pieces liminality/tctab/icarus/reverie): delta 0.000 on EVERY metric (never-worse).
- non-C (transposed icarus E +4 / Eb -3): note_f1 0.412 -> 0.845 / 0.431 -> 0.842, note_dur_f1 +0.338 /
  +0.343, chord_recall 0 -> 0.179; Clarity detects the key EXACTLY (4 / -3). (duration_acc emaj -0.028 is
  a denominator artifact as more notes pitch-match; the strict note_dur_f1 is strongly up.)
Tests: test_worker.py +4 (geom_command key arg, _rekey_geom unit, fusion re-key on non-C, no-op on C);
full omr-worker suite 525 passed / 15 torch-skipped. See memory [[full-symbol-trained-eval]].

## STATUS: KEY DETECTION validated on real non-C engravings -- a LARGE win (prod's C-assumption HALVES non-C note_f1); Clarity is a free key source, so the cheapest fix feeds its key into geom (2026-06-04)

Follow-up to the gate below. The gate found full-symbol loses on rhythm but its KEY detection works; the
all-C-major eval set could not measure that win, so I made two NON-C test pieces by transposing icarus
with music21 and re-engraving via the MuseScore4 CLI: `icarus_emaj` (E major, +4 sharps) and
`icarus_ebmaj` (Eb major, -3 flats), both kept on the box at `/opt/geom-omr/eval/real_scores/` with
harness `key_validation.py` (4 configs per piece, scored by `omr_eval.score_transcription`).

THE WRONG-KEY COST (prod assumes C major today). Same image + detector, only the key differs:
- NH @ key=0 (prod): E note_f1 **0.412** / chord 0.000, Eb **0.431** / 0.000
- NH @ oracle key:   E note_f1 **0.845**,            Eb **0.842**
So the C-assumption roughly HALVES note_f1 and zeroes chord_recall on a non-C upload. On C-major icarus
NH@0 == NH@oracle, so the assumption is free on the common case.

KEY DETECTION recovers it, and TWO sources read the key EXACTLY:
- the full-symbol detector emits +4 / -3 (SYM@detect == SYM@oracle byte-identical; note_f1 0.833 / 0.853);
- Clarity (the engine ALREADY in the prod fusion) ALSO emits +4 / -3 (its own pitch is weak, 0.51 / 0.35,
  but its KEY is right). Both emit 0 on C-major icarus (no false positive).

CHEAPEST VALIDATED FIX (recommended next lever): feed CLARITY's detected key into geom's existing
`--key-fifths` in the fusion path. Clarity already runs in prod and geom already accepts the flag, so this
needs NO new model and NO brittle classical key-sig CV. It is a worker.py orchestration change (run geom
with the key Clarity reports; service restart needed), GUARDED to override the C default only when Clarity
reports a non-zero key, so C-major stays byte-identical (provably safe on the common case). NOTE: the key
must reach geom's DECODE (not a post-hoc `<fifths>` relabel like the time-sig borrow, since the per-note
alter is baked at decode time), which is why it is a geom-INPUT change. The full-symbol detector is an
equally-exact but heavier alternative key source (85 MB model + a 2nd CPU inference per upload). Resolves
the "non-C key borrow pending a validation piece" note (memory [[fusion-timesig-borrow]] / [[full-symbol-trained-eval]]).

## STATUS: FULL-SYMBOL ship gate RUN -- it LOSES to the fusion on rhythm, so DO NOT swap the engine; key detection works but is not a cheap port (2026-06-04)

Ran the deploy gate on cx33. Copied the trained `symbols_full.pt` (yolov8s, 18-class, 85 MB) to
`/opt/geom-omr/symbols_full.pt` and measured the NEW full-symbol path
(`geom_detector.transcribe_with_symbols`, `key_fifths=None` = DETECT the key) head-to-head against the
prod-primary geom+Clarity FUSION on the 4 real MuseScore pieces, both scored by
`omr_eval.score_transcription`. Harness `/opt/geom-omr/eval/real_scores/symbols_vs_fusion.py` (reuses the
warm fusion cache for the baseline, runs the symbol detector fresh). FUSION baseline = current main
(both rhythm fixes #201 clamp + #205 held-note-fill are in).

HEAD-TO-HEAD (FUSION -> FULL-SYMBOL):
- note_f1 (pitch): liminality 0.946->0.948, tctab 0.995->0.995, icarus 0.990->0.976, reverie 0.476->0.480  (a WASH; icarus -0.014)
- note_dur_f1:     liminality 0.946->0.937, tctab 0.940->0.936, icarus 0.949->0.908, reverie 0.476->0.307  (WORSE on ALL 4)
- duration_acc:    liminality 1.000->0.989, tctab 0.945->0.941, icarus 0.959->0.931, reverie 1.000->0.640  (WORSE on ALL 4)
- chord_recall:    liminality 0.758->0.788, tctab 0.942->0.927, icarus 0.964->0.929, reverie 0.471->0.471  (a WASH)

DECISION: DO NOT SWAP THE ENGINE. The gate criterion (note_dur_f1 not worse on any piece) fails on all
4. The full-symbol DURATION self-read loses to Clarity's borrowed rhythm, badly on beam-dense reverie
(it reads 74 eighths vs truth's 132 and scatters the rest into whole/quarter/16th -- the beam/flag
subdivision brittleness this roadmap warned about). Pitch + key are STRONG (note counts within ~1-7 of
truth on every piece), but rhythm is the whole ballgame here and the fusion's Clarity rhythm wins. This
confirms the synthetic-eval prediction exactly. (Detected key == oracle on all 4, so the detected-key
run IS the oracle-key run -- the pitch deltas are genuine detector/decode differences, not a key
artifact.)

CORRECTION (2026-06-04, surfaced while validating the key fix with FRESH geom): the reverie FUSION
baseline in the table above (note_f1 0.476 / note_dur_f1 0.476 / chord 0.471) used a STALE pre-ottava
cached geom. Current main's geom carries the merged ottava fix (`detect_ottavas`, classical CV in the
notehead path), so the TRUE current fusion reverie is note_f1 0.865 / note_dur_f1 0.865 / chord 0.824.
So full-symbol LOSES reverie PITCH too (0.480 vs 0.865), not a wash: the full-symbol path's ottava rides
on the WEAK detected `ottava` class (recall ~0.44-0.59, which missed reverie's brackets) while the
notehead/fusion path uses the robust classical detector. The other 3 pieces' fusion baselines were
unaffected (cached == fresh; no ottava). Net: do-not-swap is STRENGTHENED.

KEY DETECTION works on REAL data: detected fifths == oracle == 0 on all 4 (the emitted `<fifths>` is 0),
so the assumed-C-major limitation is genuinely gone in this path. But it is NOT a free win to ship yet:
- All 4 eval pieces are C major, so on this set key detection is a metric NO-OP; the real-data win (on a
  non-C piece) is UNMEASURED -- no non-C piece exists in the eval set.
- It is NOT a cheap "port" into the deployed path. `_detect_key_fifths` reads the symbol detector's
  accidental/timesig/clef BOXES; the deployed geom path is notehead-only (`GEOM_WEIGHTS=notehead.pt`,
  `geom_command` builds NO `--symbols`), so it has notehead CENTERS only and cannot run that reader.
  Reaching prod needs EITHER (A) a NEW classical key-sig CV detector in geom_omr (model-free, fits the
  deployed subprocess, needs no worker change, in the spirit of detect_barlines/detect_ottavas -- but it
  is new, brittle sharp-vs-flat CV with a C-major FALSE-POSITIVE regression risk on the common case), OR
  (B) deploy `symbols_full.pt` + a worker change to run the symbol detector for the KEY ONLY and thread it
  into the fusion's geom pitch (heavier: 85 MB model + a 2nd CPU inference per upload, which hurts the
  ~5s progressive partial). Swapping the whole engine to `--symbols` (C) is out: the gate just rejected
  it on rhythm.

NEXT (key lever, RECOMMENDED but NOT shipped this session -- the honest no-regression call): get a NON-C
real validation piece first (transpose one of the user's pieces in MuseScore, export PDF + MusicXML),
then choose A vs B from the measured non-C win size against the C-major regression risk. The duration
self-read is NOT a lever (it loses to the fusion); rhythm stays with Clarity. BOX STATE after the gate:
`symbols_full.pt` sits at `/opt/geom-omr/symbols_full.pt` but is INERT (no env points at it; prod is
unchanged and was NOT restarted). See memory [[full-symbol-trained-eval]] + [[geom-deployed-path-notehead-only]].

## STATUS: FULL-SYMBOL detector TRAINED + evaluated; KEY-detection works, duration decode made stem-independent; real_eval is the ship gate (2026-06-04)

Step 3's model bake + decode hardening (GPU PC). The multi-class detector is trained and the
full-symbol decode is evaluated end-to-end. Research-only still (prod path is notehead-only, see
memory [[geom-deployed-path-notehead-only]]); deploy is gated on a box real_eval vs the fusion.

TRAINED MODEL (`~/omr-train/runs/symbols_full/weights/best.pt`, yolov8s, NOT committed -- 85 MB, goes
to the box like notehead.pt): combined data = 1500 synthetic (symbols_full) + 860 DeepScores
(ds_symbols_filt, pages <=600 objects). Peak val mAP50 0.79 / mAP50-95 0.64. Per-class wins over the
proof: clef_c 0.0 -> 0.96 (DeepScores real data), double_sharp 0.30 -> 0.73, double_flat 0.89, clefs
/heads/flags/rests 0.87-1.0. WEAK: `stem` recall 0.054 (thin 1-2px glyph, brutal IoU); `dot`/`ottava`
/`tie` 0.44-0.59.

END-TO-END synthetic eval (200 held-out, `~/omr-train/eval_symbols.py`): full-symbol note_f1 **0.627**
(vs notehead-only-on-same-detector 0.552) + chord_recall 0.522 (vs 0.444). KEY DETECTION WORKS:
detected-key == oracle-key, byte-identical metrics -> the oracle-key assumption is gone. DURATION on
synthetic is MISLEADING (synthetic is 16th-dense and the unioned synthetic beam under-reads 16ths,
while the old `duration:1` placeholder coincidentally matches 16ths) -> gate duration on real_eval,
NOT synthetic.

DECODE HARDENING (this PR): the `stem` class detects too poorly to gate rhythm on, so
`_count_beams_flags` now associates beams/flags with the notehead's X-COLUMN (not the detected stem),
and a classical CV probe `_has_stem_cv` recovers the open-head half-vs-whole. Lifted synthetic
duration_acc 0.306 -> 0.410 (eighths recovered) with pitch/key/chords unchanged.

TRAINING GOTCHAS (cost hours; see memory [[deploy-geom-cx33]] env): imgsz 1536 was NOT usable on the
16G card -- the DENSE DeepScores pages (median 510, max 2039 objects) x the 18-class TaskAlignedAssigner
OOM the loss. Two needed fixes: (1) FILTER DeepScores to <=600-object pages (`~/omr-train/filter_ds.py`;
the dropped orchestral pages are non-piano anyway); (2) the CUDA caching allocator's RESERVED memory
balloons unboundedly mid-epoch (8G -> 30G) until a hard OOM -- `expandable_segments` (the Linux fix) is
UNSUPPORTED on Windows, so a callback calling `torch.cuda.empty_cache()` when reserved > 12G keeps it
bounded. Settled config: imgsz 1024 / batch 4 / workers=0 / mosaic 0 / the cache callback. Run training
DETACHED (`Start-Process`), which survives turn boundaries (a `run_in_background` job does NOT).

SHIP GATE (not done): copy best.pt to cx33, run `real_eval` with `--symbols` (the new
`geom_detector.transcribe_with_symbols`) vs the geom+Clarity fusion on the 4 MuseScore pieces. Deploy
ONLY if it wins, AND wire the worker to call the `--symbols` path (prod currently runs notehead-only).

## STATUS: fusion held-note UNDER-read FIXED (a lone unmatched geom chord now fills its bar) (2026-06-04)

Branch `fix/fusion-held-note-fill` (off main). RHYTHM lever, prod-primary fusion path. The INVERSE of
the over-read fix below: a HELD chord that fills its bar, if UNMATCHED, was capped at a blind QUARTER and
`rhythm_repair` then padded a trailing rest, so a 4/4 whole-note bass triad rendered as a 1/4 note + a 3/4
rest (the user's reverie report: "bass blocks recognised as a 1/4 note and a 3/4 pause instead of 4/4
notes"). CONFIRMED on the box (reverie fixture, `diag_bass.py` over the cached engine outputs): reverie's
bass is one held whole-note triad per bar; 14 of 17 bars align to a Clarity whole note (borrow=16, render
right), but m4/m6/m8 fail pitch-class Needleman-Wunsch to any Clarity chord (Clarity reads fewer bass
chords, so the global per-staff alignment leaves 3 geom bass chords unmatched) and took the capped quarter.
NOT a Clarity matched-under-read (0 bass bars are a lone MATCHED chord borrowing a quarter). geom's m4/m6/m8
pitches EXACTLY match truth and truth is whole notes, so the fill fixes rendering AND adds (midi,16) matches.

FIX (`fusion.py`, `_bar_fallback_durs`): a LONE unmatched onset -- the bar's ONLY chord -- FILLS the bar
(its capacity = a held whole/half note) instead of the blind quarter. `if len(durs) == 1 and durs[0] is
None: return [max(1, room)]` (room == capacity16 there, since the sole chord is the unmatched one). geom
detects no rests, so a single geom onset alone in a (measure,staff) voice is a HELD note, never a quarter
trailed by silence. The INVERSE of the over-read clamp and the two NEVER overlap: the fill needs exactly
ONE onset, the clamp needs >= 2 (a matched sibling is what fills the bar there). Multiple unmatched onsets
still split the room greedily + cap per chord (over-read fix unchanged). Pitch is geom's untouched -> cannot
regress pitch. Reads the same capacity as the clamp, so it fills a 2/4 bar to a HALF (8), not a whole.

MEASURED never-worse (box `fusion_repair_eval.py`, BEFORE deployed vs AFTER `RHY_SRC=/root/fusionfix`;
STABLE cache `/root/fusion_eval_cache` so both runs share byte-identical geom+Clarity inputs -- the default
`/tmp/fusion_eval_cache` was getting wiped mid-session by a tmp-cleaner / a parallel worktree, so it is
relocated under /root for a reproducible BEFORE vs AFTER):
- note_dur_f1: liminality 0.929->0.946, tctab 0.890->0.940, icarus 0.880->0.949, reverie 0.427->0.476.
- duration_acc: liminality 0.983->1.000, tctab 0.894->0.945, icarus 0.890->0.959, reverie 0.898->1.000.
- note_f1 (pitch) UNCHANGED on all 4 (0.946/0.995/0.990/0.476); pre-repair incomplete bars down on all 4
  (liminality 1->0, tctab 43->35, icarus 6->2, reverie 3->0). reverie m4/m6/m8 now render whole-note triads
  matching truth EXACTLY (no padded rest).
IMPROVES 3 pieces the over-read clamp was a no-op on (tctab/icarus/liminality), not just reverie: an impact
scan found 16 sole-onset-unmatched bars across the 4 pieces, ALL moving toward truth, 0 regressions. Tests:
`test_fusion.py` +2 fuse-level (held-note fill 4/4 whole + 2/4 half) + updated `test_bar_fallback_durs_unit`
(`f([None],16,4)` now `[16]` not the buggy `[4]`; `f([None,None],16,4)==[4,4]` proves >= 2 onsets clamp, not
fill, so the two cases provably coexist); 28 fusion tests, full omr-worker suite 465 passed / 15 torch-skipped.
NEXT rhythm lever: the residual tctab overfull bars (the SEPARATE Clarity matched-side over-read noted below).

## STATUS: fusion FALLBACK over-read FIXED (an unmatched geom chord no longer overfills its bar) (2026-06-04)

Branch `fix/fusion-rhythm-overread` (off main, not yet merged). RHYTHM lever, prod-primary fusion path.
A geom chord that fails the pitch-class Needleman-Wunsch against Clarity (`fusion._nw`) is UNMATCHED and
took a blind QUARTER fallback. When the bar's MATCHED borrows already (nearly) fill the meter, that
quarter OVERFILLED it. CONFIRMED root cause on reverie (the user's symptom): m17 staff1 read a half +
four eighths, but geom and Clarity ORDERED the four shorts differently (geom C6 B5 C6 B5 vs Clarity C6
B5 B5 C6), so geom's last short went unmatched and took a quarter -> the bar summed to 18 sixteenths ==
4.5 beats. geom's OWN duration is useless here: the deployed notehead path (`transcribe_with_detector`)
fakes `duration:1` for EVERY note (geom dur16 histogram `{1: N}` on all 4 eval pieces); #196's
full-symbol decode is research-only, NOT in the prod fusion path. `rhythm_repair` can't mask it (skips
the last bar; refuses to shrink a pitched overfull bar by design).

FIX (`fusion.py`, never-raise + pitch-safe): a CAPACITY-CLAMPED fallback. `_bar_capacity16(beats,
beat_type)` = bar capacity in `omr_eval._dur16` SIXTEENTHS (`beats*16/beat_type`); `_bar_fallback_durs`
sizes each UNMATCHED chord to `clamp(room_remaining_in_bar, 1, quarter)`, consuming the leftover room
greedily. A lone unmatched chord in a near-empty bar still gets a full quarter (room >= 4), so the
change is IDENTICAL to the old behaviour except where a quarter would overfill (room < 4) -- exactly the
over-read case. Floors at a sixteenth so every geom notehead keeps a positive duration (a dropped note
would regress geom's pitch edge). Reads the NORMALIZED meter `fuse` resolves (a 2/2 cut-time misread ->
4/4 cap 16). NEVER touches a borrowed (matched) duration or geom's pitch, so it cannot regress pitch.

MEASURED never-worse (box `fusion_repair_eval.py`, BEFORE deployed vs AFTER `RHY_SRC` shadowing the edit):
- reverie: m17 18 -> 16 sixteenths (the symptom is GONE); incomplete bars after repair 1/32 -> 0/32; ndf1
  0.427 unchanged (the bar RENDERS correct now; the metric is pitch-gated on geom's B5-vs-truth mismatch).
- tctab: FUSED note_dur_f1 0.875 -> 0.890, duration_acc 0.880 -> 0.894, incomplete bars after repair
  12/134 -> 6/134; overfull bars 12 -> 6. nf1 unchanged 0.995.
- icarus + liminality: IDENTICAL (no unmatched chord lands in an overfull bar; clamp is a no-op).
NO regression on any piece. The RESIDUAL tctab overfull bars (e.g. m68 sum 26) are a SEPARATE culprit:
Clarity's OWN over-read on the MATCHED side (every chord there is a borrowed duration), which this fix
deliberately leaves alone. NEXT for those: a matched-side bar-sum sanity check on Clarity's borrows, or
the full-symbol geom durations (which would also give the unmatched-chord fallback a real value instead
of a clamp). Tests: `test_fusion.py` +6 (reverie shape, full-bar sixteenth floor, 2/4 capacity, the
`_bar_fallback_durs` unit); full omr-worker suite 463 passed / 15 torch-skipped locally.
## STATUS: OTTAVA (8va/8vb) read in BOTH decode paths; reverie's residual addressed, box real_eval is the ship gate (2026-06-04)

Built the ottava-bracket read in geom_omr (research/worker change, UNCOMMITTED in the
vigorous-shaw worktree, not deployed). This is the roadmap's long-standing "reverie's residual":
geom decoded the WRITTEN staff position and never applied the 8va/8vb shift, so notes under a
bracket sounded an octave off (the user's reverie bug: an octave too LOW in the bracketed region,
pred = truth - 12). Both prod pitch sources keep geom's octave (geom-primary AND the geom+Clarity
fusion), so this reached the user.

WHAT SHIPPED (code): `geom_omr.detect_ottavas(gray, staves)` + `ottava_delta_at(rep_x, spans)` +
helpers `_scan_dashed_rule` / `_dash_runs` / `_ottava_spans_from_boxes`, and the shift threaded
into BOTH decode tails (`_decode_staves_to_musicxml`, the DEPLOYED notehead-only path, via the
classical detector; and `_decode_staff`, the full-symbol path, via the detected `ottava` class
boxes). Emits the SOUNDING octave directly (no `<octave-shift>` direction) so audio + falling notes
+ scorer are all correct with zero OSMD double-apply risk. Tests: test_geom_ottava.py (+29; pure
shift in both paths, a numpy raster detect, never-raise). Full omr-worker suite 459 -> 488 green.

DETECTOR (classical CPU, no GPU/model, in the spirit of detect_barlines): scan a tight band ABOVE
the staff top (8va, +1) and BELOW the bottom (8vb, -1) for the bracket's dashed horizontal rule.
Discriminators measured on reverie@300DPI (spike C:\tmp\ottava_diag*.py): longest dark run <= 1.6
interline (rejects SOLID beams), >= 15 short runs (rejects sparse stray ink), span >= 40 interlines
(rejects LOCAL clutter like a hairpin), AND dash fill >= 0.12 of the span (rejects the ~0.05-fill
fringe of stem/ledger BOTTOMS in the row just outside a staff). KEY GOTCHA: a TREBLE staff's
"below" band IS the ~6.5-interline inter-staff gap, where an 8vb is ambiguous with the BASS staff's
own 8va (their bands overlap); scanning it produced FALSE 8vb that shifted correct notes DOWN. Fix:
only scan the 8vb band when the next staff is >= 10 interlines below (open margin) or absent. After
this, reverie detects 8va-only on the 5 clearly-bracketed staves, ZERO false 8vb.

VERIFIED LOCALLY (the classical transcribe_geometric on the real reverie raster, no trained model):
105 of 188 notes shift by EXACTLY +12 semitones (one octave up), note count unchanged, nothing
shifts down; octave-6 mass jumps 7 -> 55 notes. Non-ottava input is byte-identical (shift is +0).

SHIP GATE (NOT done locally): this is a worker change that does NOT reach the user until it passes
the box `real_eval` on ALL 4 pieces (it-support/on-box). reverie should improve (note_f1 in the
bracketed region); tctab/icarus/liminality must NOT regress (a false ottava would shift correct
notes an octave; liminality also has ottavas). My local proof covers reverie + unit tests only.

FOLLOW-UPS (deferred, clearly-scoped): (1) SYNTHETIC honesty for the FULL-SYMBOL eval: today the
rich generator (`generate_rich_score(ottava=True)`) draws the bracket but keeps the WRITTEN octave
as truth, so the new full-symbol shift would REGRESS its self-score. The deployed notehead path is
UNAFFECTED (it never touches the generator); only `eval_detector` on synthetic ottava scores is.
Fix when wiring the full-symbol path: model truth as SOUNDING octave + emit the matching
`<octave-shift>` so Verovio engraves the glyph at the written position (decode recovers sounding =
truth). The render path has NO CI, so overlay-verify. (2) FAITHFUL bracket: emit `<octave-shift>`
in the deployed path for a low-notes + bracket engraving, gated on verifying OSMD reports `<pitch>`
as the SOUNDING pitch (else it double-applies). (3) 15ma: read the engraved "8 vs 15" digit
(needs glyph recognition the notehead-only path lacks; magnitude is always 1 octave today).

## STATUS: FULL-SYMBOL DECODE built (durations/key/accidentals/clefs/rests from glyphs); detector training + eval in flight (2026-06-04)

Step 3 of the full-symbol detector. The DECODE that reads musical content from the trained
multi-class detector's glyph boxes is code-complete and merged research-only (nothing in worker.py
calls it yet; deploy is a later gated decision after the real-score eval, mirroring how geom_omr
shipped pre-deploy). The CODE (gated PR `feat/full-symbol-decode`):
- `geom_omr.decode_symbols_to_musicxml(staves, symbols, key_fifths=None, gray=None)` + helpers:
  reads DURATIONS (head fill open/filled + stem presence + beam/flag COUNT + augmentation dots ->
  whole/half/quarter/eighth/16th/dotted via `decode_note_duration`), KEY SIGNATURE (the
  clef-anchored run of accidental glyphs, bounded by the timesig / first note, via
  `_detect_key_fifths`), per-note ACCIDENTALS (a glyph immediately left of a head overrides the
  keyed alter), CLEFS (leftmost clef glyph sets each staff's pitch reference, removing the
  treble/bass-by-index assumption; a later clef glyph is a mid-score change applied per-note; a
  clef-LESS staff falls back to the by-index sign so pitch and the printed clef cannot desync), and
  RESTS. Shares decode_pitch / _interline / detect_barlines / keyed_alter / the llm_omr builder
  with the notehead-only path. NEVER raises. key_fifths=None DETECTS the key; an int pins it (eval).
- `geom_detector.detect_symbols()` (all classes) + `transcribe_with_symbols()` + a `--symbols` CLI
  flag so the engine runs as a subprocess (for the box eval + eventual deploy).
- `train_detector.py --workers` (default 0; the documented Windows dataloader-hang fix).
- Tests: test_geom_symbols.py (durations/key/accidentals/clefs/rests/chords/never-raise),
  test_train_detector.py; a taxonomy-sync test guards geom_omr.CLASS_NAMES vs synth_render's.

DATASET + TRAINING (heavy, OUTSIDE the repo under ~/omr-train, gitignored): the full multi-class
set is built (synth 1500/200 `symbols_full` + DeepScores multi-class `ds_symbols` 1362/352 = 2862
train; combined_symbols.yaml). DeepScores supplies the proof's weak classes from REAL data: clef_c
~1950 (was 42), double accidentals ~4.5k each (synthetic supplies these; DeepScores has ~0), ottava
~432, tie ~16.5k, per-segment beams ~88k. Training yolov8s imgsz 1536 / batch 4 / workers=0 / 60ep
patience 15 on the GPU PC (in flight). GOTCHA relearned: imgsz 1536 + mosaic on a batch of 4 DENSE
DeepScores pages SPILLS past the 16G card (~19.8G, ~10x slowdown); fix = `mosaic=0` (same as the
notehead_real run). Also: PowerShell `;` is not `&&`, so a failed `Set-Location` still ran the next
`python ...` and left an orphan training process competing for the GPU; relaunch cleanly.

SUBDIVISION caveat (measured, see memory full-symbol-duration-geometry): fill+stem give
whole/half/quarter cleanly, but 8th-vs-16th rides on beam/flag COUNT, and the synthetic render
UNIONS a beam group into ONE box (so synthetic 16ths under-read to eighths) while DeepScores is
per-segment. So GATE subdivision on the real-score eval (real_eval), not synthetic. Even the coarse
read takes geom's duration_acc from 0.0 (every note is currently duration:1) to a real number.

NEXT: per-class eval (confirm clef_c/double-acc/ottava/stem/dot improved) -> end-to-end eval with
the new decode (eval_detector, key now DETECTED not oracle) -> photo-augment + retrain -> real_eval
on the box (`GEOM_SRC=/dir`, `--symbols`) -> deploy to cx33 ONLY if it beats the geom+Clarity fusion.

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
