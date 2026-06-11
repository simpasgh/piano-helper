<!-- Produced 2026-06-11 by a 22-agent review workflow: 5 code mappers (decode core, fusion, serving, training, metrics history), 4 web research scouts (SOTA end-to-end OMR, competitive landscape, data/training feasibility, camera + measure alignment), 3 competing strategies (incremental / hybrid-retrain / leapfrog), each adversarially verified through evidence, constraints, and impact lenses, then synthesized. Only items that survived adversarial review appear in the program. -->

# Piano Helper OMR: Engine Review + Improvement Program (2026-06-11)

Synthesis of 5 code maps, 4 research scouts, and 3 strategy proposals with adversarial verdicts (evidence / constraints / impact lenses). Only items that survived review appear in the program; refuted items are logged in section 3 so they are never retried blind. Ship rule throughout: never-worse per piece on the box real_eval (note_f1 primary), clean scans preferably byte-identical, every new engine/flag exposed in /admin.

---

## 1. Capability matrix

| Dimension | State | Authoritative numbers | Mechanism / evidence |
|---|---|---|---|
| **Clean sparse scans** | Strong, at/near SOTA | tctab 0.995, icarus 0.990, liminality 0.946, reverie 0.881 note_f1; CC0 sparse 5/26 >= 0.85 (odetojoy 0.984, minuet 0.968, greensleeves 0.894, carolbells 0.879, gymnopedie 0.867) | Trained YOLO noteheads (saturated: 97-101% head recall in every regime) + classical decode; staff extraction by thinness + adaptive imgsz (#182), barlines (#180), ottava detector. own-engine-roadmap.md:66,88-90 (post-insert positions; grep for content, line refs rot as entries are prepended) |
| **Clean dense scans** | Critical weakness, largest headroom | CC0-26 mean 0.342; 20/26 pieces < 0.5; ignore-measure pitch recall 0.68-0.93 (2-3x recoverable) | Measure over-segmentation: dense chord/stem stacks clear 0.7 barline coverage and survive unless carving a < 0.5x-median measure (geom_omr.py:954-998, module comment 903-922); chord merging at fixed 1.2sp (geom_omr.py:866-900); no missing-bar repair on the clean path (geom_omr.py:1028 is photo-only). cc0_eval_expanded.log |
| **Phone photos** | Mid; ahead of the field in measurement, walls localized | icarus 0.887, reverie 0.663 (DP ceiling 0.703; residual = entirely missed 8th staff), liminality 0.625 (94% of 0.663 ceiling), tctab 0.144 (4/22 staves, detection-bound); mean ~0.580, up from ~0.18 raw via #224/#227/#228/#229/#230/#233/#238 | All photo behavior hangs off use_dw (dewarp kept), which is why clean stays byte-identical (geom_detector.py:198-256). Wall split: reverie/liminality decode-bound (measure-number shift), tctab detection-bound. tech-lead.md:212-221 |
| **Rhythm / durations** | Good on clean PDFs, ZERO on photos | Fusion note_dur_f1: liminality 0.946, tctab 0.940, icarus 0.949, reverie 0.865; duration_acc 0.94-1.0. Geom standalone: duration_acc 0.0 (every note duration:1, geom_omr.py:1621) | Wholly borrowed from Clarity via NW pitch-class alignment (fusion.py:124-178); single point of failure, no second source. Photos never reach Clarity (PDF-only: worker.py:1733, 1774, 1785, 1798), so photo rhythm is zero **by construction** |
| **Key signature** | Exact on PDFs, broken on photos | Clarity detects key exactly (+4/-3, zero false positives on C); borrow lifted non-C note_f1 0.41 -> 0.84 (PR #220), C byte-identical | _rekey_geom feeds --key-fifths (worker.py:805-824); never fires on photos (no Clarity), so every photo decodes under the C-major assumption; the oracle-keyed eval masks this prod hole |
| **Time signature** | Borrowed, one known fragility | Non-4/4 borrow shipped (#191), 4/4-equivalent normalization (#194); liminality 2/4 correct | fuse adopts Clarity's first <time> for the whole piece with no bar-sum sanity check before adoption (fusion.py:344-377) |
| **Ties** | Borrowed, PDF-only | #232 carries Clarity ties through the borrow (metric-neutral); #235 drops ties spanning rests | Ties ride only on NW-matched chords (fusion.py:277); an alignment miss silently drops holds; zero ties on photos |
| **Ottava** | Good with documented conservative gaps | Reverie clean 0.476 -> 0.881 (classical detector); photo mode +0.192 (reverie 0.471 -> 0.663, #233) | Dashed-rule scan with vertical-isolation gate (geom_omr.py:1209-1261); treble 8vb in the inter-staff gap never scanned, 15ma reads +1 octave, reverie m16-17 continuation deliberately skipped (caps reverie clean at 0.881) |
| **Chords** | Good clean | chord_recall: icarus 0.964, tctab 0.942, reverie 0.882, liminality 0.758 | x-cluster anchoring at 1.2sp; dense runs merge into false chords (the dense-wall second stage) |
| **Speed / serving** | Workable, single-box | geom ~5s/page; Clarity 19s load + 9s/system (icarus ~75-100s, tctab ~217s); first streamed partial ~28s; oemer ~180s/page; 1200s engine cap, 15-min client budget | One sequential worker on cx33 (4 vCPU / 7GB cgroup): head-of-line blocking, unauthenticated/unrate-limited upload (functions/api/omr.ts:60-90), manual SSH worker deploys. Progressive block streaming live (R2 flags: GEOM=1, GEOM_FUSION=1, PROGRESSIVE=1, PROGRESSIVE_BLOCKS=1) |

Cross-cutting structural facts: the engine selection ladder is wins-first with **no quality comparison anywhere** (worker.py:1767-1868); ~2,630 lines of ensemble/referee machinery are doubly dead and aimed at the wrong engine pair (Clarity vs oemer); the measure grid is per-system, locally greedy, concatenated with zero global constraint (geom_omr.py:1655-1684); nearly everything binarizes at a single gray < 0.5 ink threshold (geom_omr.py:220, 644, 1111; only photo ottava uses 0.62).

---

## 2. Where we stand vs the world

**Field truths (converging across all sources):**
- Pianoform is the universally worst texture: SMB benchmark OMR-NED 57.4 for pianoform vs 92-98 for monophony/quartets (arxiv 2506.10488). Our dense-CC0 wall at 0.25-0.35 is the **industry-wide frontier**, not us trailing.
- Everyone degrades 2-3x from synthetic to real scans (Zeus 11.3% -> 17.7% SER; SMT++ 5.6% -> 10-28% CER; Transcoda 18.5 -> 64.0 OMR-NED zero-shot).
- **No public real phone-photo benchmark exists.** All published "camera" numbers are synthetic distortions (Camera-PrIMuS/Camera-GrandStaff lineage). Our 4-piece real-photo gate already measures something academia does not publish.
- VLMs are not a threat: GPT-4o scored 4.0% on optical note recognition (MusiXQA); frontier models misread basic time signatures from images.

**Per competitor:**
- **Soundslice** (commercial leader): best of six in Scoring Notes' test, near-perfect on a 650-measure clean part, continuous shipping; yet independently measured at ~34.5% SER on real scanned editions. Its real moat is partly UX: a confidence-flagged human-correction flow. We have no equivalent.
- **PlayScore 2**: excellent clean PDFs, explicit photo cliff ("a poor quality photo will inevitably lead to inaccurate playback"). Photo robustness is our clearest differentiation axis against consumer incumbents.
- **Audiveris 5.10.x** (open, classical): ~80-90% on clean 300-DPI scans; powers MuseScore's stale, community-panned PDF import. Architecturally our ancestor with a weaker detector. On icarus our fusion (0.99) already beats Clarity-alone (0.899) and oemer (0.914); Audiveris produced half of oemer's notes and 0 ties.
- **homr** (open, AGPL): closest analog of our exact mission (camera photo -> MusicXML), no published metrics, last release Aug 2025. Benchmark target, not code source.
- **Zeus/OLiMPiC** (academic pianoform SOTA): CRNN at 2.30% CER GrandStaff / 18.40% TEDn on real scans; deliberately anti-transformer for data-scarcity reasons, which independently validates our hybrid choice after the full-symbol defeat.
- **Newzik/Enote/Klangio**: marketing claims, zero public benchmarks. The "best in the world" title currently sits in an evidence vacuum.

**What "objectively best piano OMR" measurably means (4 falsifiable targets):**
1. **Dense pianoform:** CC0-26 mean note_f1 toward the 0.68-0.93 ignore-measure ceilings; SMB pianoform OMR-NED better than the published SMT baseline (57.4).
2. **Real phone photos:** publish the only real phone-photo piano benchmark (our captures, CC0 sources) and lead it; internal target photo mean note_f1 >= 0.8.
3. **External yardsticks:** TEDn on OLiMPiC-scanned at or under Zeus's 18.40; Camera-GrandStaff numbers alongside.
4. **Error-tolerant UX:** surface low-agreement measures from the fusion alignment as a correction flow (the Soundslice lesson: converts a 0.6-0.9 engine into a ~1.0 user outcome). Product-side lever, cheap once cross-engine alignment exists.

---

## 3. Refuted / closed paths (measured dead; do not retry without a genuinely new angle)

| Path | Result | Source |
|---|---|---|
| LLM-vision as primary engine | exact-F1 0.39, chord_recall 0, octaves systematically wrong | own-engine-roadmap.md:715 |
| Audiveris swap or ties-only merge | half of oemer's note count, 0 ties at any DPI | tech-lead.md:602-622 |
| Classical tie-arc raster detection | ~11% precision (1 TP / 8 FP) | tech-lead.md:639-644 |
| Pitch fabrication (#113 chord completion) | metrics up, fidelity down; REVERTED; principle: never fabricate pitches | tech-lead.md:682-726 |
| Blanket same-pitch tie merge (#121) | indistinguishable from re-strikes without engine markup | tech-lead.md |
| Note-stretching rhythm repair | regressed (7/9 edits stretched correct notes); rests-only is correct | rhythm-repair memory |
| Full 18-class symbol engine swap | note_dur_f1 worse on ALL 4 pieces (stem recall 0.054); weights inert; only its key/clef classes validated | full-symbol-trained-eval memory |
| Notehead photo-augment retrain | +0.003 (noise); detector already photo-robust, mAP identical in all 4 train/eval cells | eval_photo_detector.json |
| 3-lever photo sweep (faint-staff recovery, multi-page dewarp, barline clump-merge) | all improved CPU proxies, all failed/regressed the real note_f1 gate; tctab 4->15 staves recovered for ZERO gain | photo-measure-alignment-wall memory |
| Unconditional gap-crossing barline guard | tctab -0.003; only the conditional narrow-measure version shipped (#227) | dense-segmentation memory |
| "More staves wins" illumination gate | fails reverie (more staves, lower f1) | adaptive-illum memory |
| 8-interline ottava cluster gate; interline hardening; global deskew; DPI 400/500; page-split alone for tctab | each measured worse or no headroom | roadmap + memories |
| CPU proxy metrics as gates (staff/barline counts) | do NOT predict note_f1; only the real gate counts | standing measured truth |
| synth_augment as photo proxy | predicted 0.91, real 0.18; real captures mandatory | real-photos memory |
| MUSCIMA++ / CVC-MUSCIMA / Smashcima-derived data | CC BY-NC-SA; product-tainting; excluded from all training | research:data-training |
| Billion-param end-to-end (LEGATO class) | beaten by 59M synthetic-only Transcoda; untrainable on 16GB, unservable on cx33 | research:sota-e2e |
| **Newly closed by this review:** standalone strip-level seq2seq rhythm-only channel | REFUTED by impact lens: wrong metric (polishes durations of notes in wrong measures), dominated by running Clarity on photos; allowed only as a double-contingent probe inside the seq2seq program | hybrid verdict |
| **Newly demoted:** faint-ink barline threshold and barline-edge snap zone as strategy pillars | reverie's residual is a missed staff, not barlines ("diminishing returns on barline tweaks are now measured"); both reduced to hours-scale diagnostics | incremental verdicts |

---

## 4. The program

Ordered by impact-per-effort within each horizon. **[P]** = independent / parallelizable across sessions. Every item ships flag-gated where it touches prod, gated on per-piece never-worse box real_eval + the local photo gate, clean byte-identical where structurally possible.

### NOW (days; nearly all parallel)

**N1. Photo-to-PDF shim: run Clarity + full fusion on phone photos** [P, and a prerequisite for X2/X5/L1]
- *What:* Wrap non-PDF uploads as a one-page PDF for **Clarity only**; geom keeps consuming the original raster (this makes the status-quo floor structural, not assumed). Raw-wrap variant behind one new boolean /admin flag (flags accept only "0"/"1", flag_config.py:44); dewarped-raster variant as a follow-up flag only if Clarity's Stage A collapses on raw photos. Also probe the tctab 2-page stitch as two single-page wraps (precondition data for L1).
- *Wall:* Photo rhythm/key/ties/streaming are zero **by construction** (worker.py:1733; fusion/stream branches gated on is_pdf_input at 1774/1785/1798). The flagship input currently ships rhythm-blind with a C-major assumption that the oracle-keyed eval masks; non-C prod photos are roughly halved today (0.41 vs 0.84 transposed-icarus measurement).
- *Expected:* photo note_dur_f1 ~0 -> large fraction of clean fusion's 0.86-0.95 where Clarity's staff detection holds; photo note_f1 never-worse (Clarity None = today's output); unlocks cross-engine arbitration and progressive streaming on photos.
- *First experiment + gate:* wrap the 5 real photos, count Clarity systems found (raw and dewarped variants). Gate: >= 50% of systems on >= 2 photos. Pre-register which photo pieces are non-C. Then full fusion through the local photo gate: note_f1 AND note_dur_f1 never-worse per photo, clean 4 byte-identical (PDF path untouched).
- *Effort:* days. Highest impact-per-effort item in the entire review (unanimous across all three strategies' verdicts).

**N2. UVDoc pretrained learned dewarp probe** [P]
- *What:* Run UVDoc (8M params, MIT, pretrained, ~1-3s/page CPU) per page **before** stitching on the photo path; adopt only behind the existing staves-increase guard + never-worse note_f1 gate.
- *Wall:* tctab photo geometry (0.144 vs 0.995 clean; single 2D displacement field cannot straighten a 2-page stitch, the open Unit-2).
- *First experiment + gate:* half a day; rectified tctab pages through eval_candidate.py. Gate: tctab note_f1 strictly up AND the other 3 pieces never-worse (5 photos, 4 pieces; tctab = 2 photos). On fail, the only second life is a fine-tune on **synthetically warped renders** (known fields); real-capture warp recovery is not a thing. Treat probe-fail as probable kill (page-split prior is against).
- *Effort:* half-day probe; days if adopted.

**N3. 80-photo eval expansion (and future public benchmark)** [P]
- *What:* Photograph the 26 printed CC0 pieces under 3 lighting/angle conditions. Validation gate: per-piece **clean-to-photo degradation ratios** match the 4 real pieces' ratios (NOT absolute means; the CC0 set is density-dominated at clean mean 0.342, so absolute-mean comparison fails on composition).
- *Wall:* measured single-capture noise (+-0.01-0.05 per piece) currently swallows small photo deltas; this de-risks every future photo lever and later becomes the published phone-photo benchmark (section 2, target 2). Also photograph icarus_emaj/ebmaj for the non-C photo gate (feeds N1/X5).
- *Effort:* an afternoon of capture + a day of scoring.

**N4. Local Clarity install + fusion-mode cc0_eval** [P, prerequisite for X2 gating]
- *What:* Stand up Clarity in a local venv (free, GPU-accelerable on the 5060 Ti) and extend cc0_eval.py to fusion mode. Surfaced by three constraint verdicts: today the dense CC0 numbers are geom-only local runs, and any Clarity-dependent change is ungateable without either this or stealing hours from the single prod worker.
- *Effort:* 1-2 days.

**N5. Diagnostics bundle (hours each, all measurement-only, run before any code)** [P]
- (a) **Barline-vs-notehead separation** on canon/nocturne: fraction of FALSE barline candidates with a detected head within 0.5sp of their x vs TRUE candidates. Gate for X1's veto: >= 70% false / < 10% true overlap.
- (b) **Chord-merge incidence**: count truth onsets merged at the fixed 1.2sp threshold on dense CC0; compute the adaptive threshold from **inter-chord** gaps (exclude within-chord pairs). Feeds X1's clustering half.
- (c) **Snap-zone incidence** (demoted incremental item): truth notes within 0.5sp of a decoded bar edge AND wrong-side bucketed (_segment_to_measures is zero-tolerance half-open on mean-head rep_x, geom_omr.py:1655-1672). Gate: >= 1% of notes on >= 3 pieces, else skip forever. If built: leftmost-head rep_x first, in isolation.
- (d) **gcov 0.5-vs-0.62 instrumentation** (demoted): aimed at icarus's unattributed 0.887 residual, NOT reverie (its residual is a missed staff). Cap 1-2 days total; kill below 2 true bars recovered / <= 1 false candidate.

### NEXT (week-scale)

**X1. Notehead-aware density-adaptive segmentation** [P; run before X2, re-baseline between]
- *What:* (a) Barline veto using the saturated detector's head positions as side-information: veto only candidates that are BOTH non-gap-crossing AND carving an anomalous measure (intersection with the #227 condition makes the clean no-op structural). (b) Density-adaptive chord clustering from inter-chord gap statistics, replacing the fixed 1.2sp anchor.
- *Wall:* dense clean (the largest measured headroom; the false bars ARE chord stacks per the module's own comment, geom_omr.py:903-922).
- *Expected:* dense CC0 mean 0.342 -> 0.40-0.45 per piece, bounded by the measured 0.451 unconditional-guard reference on canon. Clean 4 byte-identical (verified empirically on the gate, not just asserted).
- *Gate:* N5(a)/(b) diagnostics pass first; then per-piece never-worse on CC0-26 + clean.
- *Effort:* ~1 week. No cross-engine dependency, no new harness: the cleanest constraint fit in the program.

**X2. Cross-engine measure-grid arbitration (NW measure-remap first)**
- *What:* The fusion already aligns chords (fusion.py:124-178) but discards Clarity's measure numbers (fusion.py:173-177). Ship in order: (b) carry Clarity's (measure, idx) through the existing NW match, majority-vote a geom-to-Clarity measure mapping, renumber/merge before _build (no system-correspondence assumption); (c) lone-staff rescue on photos: assign NW-matched geom chords their Clarity measure directly, replacing the rhythm-blind 4-onsets/bar even binning (geom_omr.py:1118-1127, 1655); (a) count-arbitration DP only if the measurement study clears it.
- *Wall:* photo measure-number misalignment + dense over-segmentation; flagged by the fusion map as "unexplored signal the orchestrator already has in hand"; literature precedent Waloschek ISMIR'19 (99.5% DTW measure concordance), Bugge ISMIR'11 (barlines as anchors).
- *First experiment + gate:* measurement-only script comparing geom vs Clarity vs truth measure counts per system on the 4 clean + failing dense pieces, ALSO recording (i) geom-vs-Clarity system correspondence via anchor chords and (ii) Clarity's count error **direction** (its one known dense behavior, the tctab over-read, points the wrong way; if Clarity over-counts on dense, build only the NW-remap half). Abandon criterion pre-registered.
- *Depends:* N1 (photos), N4 (dense gating). *Effort:* 1-2 weeks honest (not the proposed one week; lands in fusion.py, the single point of failure for every borrow).

**X3. Trained barline/measure detector: oracle swap first** [P with X1/X2 (GPU vs CPU work)]
- *What:* Fine-tune YOLOv8n as a barline+measure detector on the **NC-filtered** MeasureDetector corpus (drop all CVC-MUSCIMA/MUSCIMA++-derived pages; CC BY-NC-SA is product-tainting) + synth_render pages with barlines added as a labeled class (x-positions exact from the Verovio SVG). Budget 2 GPU nights (workers=0 tax).
- *Decisive probe before any integration:* offline ORACLE SWAP, feeding detector barline x's into _segment_to_measures over 26 CC0 + 5 photos, scored on note_f1, zero prod code. Gate: >= +0.05 on >= 5 dense pieces AND never-worse on the clean 4. If the oracle swap doesn't move note_f1, the component is dead regardless of detection metrics.
- *Integration (only on gate pass):* trigger on detector-vs-classical **disagreement with a confidence margin**, not the width-anomaly flag (#227 already harvests that); clean byte-identity proven empirically on the gate. Expected per-piece (canon ~0.45, nocturne ~0.30), set by the oracle swap, never a mean projection. Photo-path version depends on L3's photo data tier.
- *Effort:* probe 2 days; build weeks if it passes.

**X4. Pretrained seq2seq bake-off (go/no-go for the bet)** [P]
- *What:* SMT camera-grandstaff (MIT), Zeus (CC BY-SA), Transcoda (AGPL, benchmark-only, never vendored) on system crops from geom's deployed staff detection; LMX/bekern -> MusicXML; scored on the real gates. Run **locally** (never on the prod box). Also run homr, Audiveris, oemer on the same images for the first head-to-head positioning numbers.
- *Gate (two-sided, fail semantics pre-registered):* GREENLIGHT if any checkpoint reads any dense CC0 piece at note_f1 >= 0.5 OR pitch-class recall >= 0.85 anywhere (decode salvageable via fusion borrow). Before declaring NO-GO on all-below-0.3: run a control (Camera-GrandStaff sample through the same harness) and 3-6 measure sub-crops matching the training distribution; if the control fails too, the verdict is "harness", not "model class".
- *Effort:* 1-2 weeks honest (three stacks, two converters). This single experiment decides the entire LATER program.

**X5. symbols_full key/clef salvage (contingent)** [P]
- *What:* ONLY if N1 shows Clarity Stage A collapsing on photo rasters. Reuse the inert 18-class detector's validated classes (key exact, clef_g mAP 0.995) as a key source for photos + clef oracle for lone staves (today hard-defaulted to treble, geom_omr.py:735). Plausibility guard defined concretely: out-of-key pitch-class fraction before vs after re-key.
- *Gate:* exact key on the transposed photos (N3 capture) AND fifths == 0 on all 5 C photos (zero false positives). *Effort:* days. Keep the transposed-photo gate expansion regardless of which key source wins.

### LATER (gated, month+)

**L1. tctab geometry program (strictly precondition-gated)**
- Preconditions from NOW/NEXT: N1's page-split probe must show Clarity gives tctab a measure-assignment path, OR X3's detector must work on photos. The refuted sweep proved recovered staves without a measure grid score ZERO (4->15 staves, flat note_f1); no staff-detection work starts until the assignment path exists.
- (a) **Stable-paths grayscale staff finder** spike: 2-3 day timeboxed **vectorized-DP** prototype (seam-carving style, not literal Dijkstra; a 25MP stitch in Python graph form is minutes, not seconds) through eval_candidate.py. Kill rule pre-committed: flat note_f1 at 15+ staves found = stop (staff count is a refuted proxy).
- (b) **Trained photo staff segmenter** (TrOMR mold, 98-99% P/R precedent on real phone photos): probe re-gated END-TO-END: recovered staves + an oracle measure grid through the existing decode, scored on tctab note_f1; month-class, after L3 exists.

**L2. PDMX synthetic page factory** (behind X4 greenlight only)
- Verovio-only v1 (drop dual-engraver scope creep); PDMX solo-piano filter -> system + page images with LMX targets (ufal linearizer) + transpose-and-slice + Augraphy degradation. Pilot: 1,000 scores, gated on >= 95% lossless LMX round-trip + 20-page manual overlay check (render path has no CI) + density histogram covering the canon/nocturne notes-per-measure band the current generator structurally cannot produce (one event stream per staff, 3-note chord cap, no tuplets: omr_eval.py:688-706). Cap corpus to what training consumes.

**L3. Photo training-data tier with registered labels** (own costed item, split from the data factory)
- Geometric labels (staff y-ranges, barline x's, measure boxes) come from **known-warp synthetic** only, where boxes transfer exactly. Real print-and-photograph captures (the TrOMR CMSD recipe, merge-SER 0.969 -> 0.019, the largest documented photo gain anywhere) require an explicit fiducial/homography registration design + a label-accuracy gate (overlay IoU vs hand-drawn boxes on a 20-page sample) before any detector trains on them. Honest sizing: TrOMR's gain took ~10,000 photographed pages; budget a semi-automated capture rig, start at ~500 pages, scale only if the fine-tune moves the real photo gate. Hard rule: train/eval disjoint (PDMX renders train; photographed CC0 pieces are eval-only).

**L4. The seq2seq third engine + referee + serving** (the bet; see section 5)
- **Engine:** Zeus-class CRNN (~30-60M params, 192px strips, LMX output) trained on L2 data, 16GB-feasible (Transcoda: 6h on a 5090 for 310K pages -> ~1-3 days here). Kill gate recalibrated to the hardware: fixed sample-presentation budget with a **CER-trajectory** criterion at compute-matched presentations (never the proposed absolute 48h/2x, which conflates schedule with architecture); train under WSL2 to recover multiprocess dataloading; length-bucket targets against 16GB fragmentation. Sold as **dense-clean-first**; photo gains are explicitly marginal (+~0.04 DP ceilings) until L1/L3 fix cropping; tctab out of scope for the engine itself. CER is an iteration proxy only; ship/kill stays on box note_f1.
- **Referee v2:** run fusion and seq2seq concurrently, align with the existing DP machinery, select per piece (later per system) on ground-truth-free signals (cross-engine note overlap, bar-sum-vs-meter corroboration, notehead-coverage by the saturated detector). Default ALWAYS the current fusion; never switch where fusion's internal corroboration is high. Offline first experiment costs zero prod code (outputs already on the box): gate = picks the winner >= 80% AND strict never-worse (delta <= 0) on benchmark pieces, the 0.05 tolerance reserved for off-benchmark analysis. Report selector accuracy separately for clean vs photo. Both flags (engine + referee) into the /admin allowlist with the two guard tests. With three engines, aligned 2-of-3 voting becomes possible (ROVER/ISRI precedent: halves error).
- **Serving:** int8 ONNX/OpenVINO warm driver (clarity_stream pattern, isolated venv). Validate decoder-loop export parity on 10 systems BEFORE int8 calibration. Budget: <= 10s/system, < 1.5GB RSS in a 4-vCPU/7GB container, note_f1 delta vs fp32 <= 0.005, fp16/fp32 fallback. The YOLO OpenVINO export is a hygiene PR (never-worse, NOT byte-identical; saves ~3s of a ~100s job), never scheduled before X4.

**L5. Measurability (trimmed)**
- One-off OLiMPiC-scanned TEDn run (2-3 days): wrap system images as one-page PDFs so the measured artifact is the real fusion, not geom's duration:1 skeleton (TEDn scores durations; geom-alone goes in as a separate ablation row). Compare against Zeus 18.40. Publish the N3 photo set as the first real phone-photo piano benchmark. SMB OMR-NED later. note_f1 remains the **only** ship gate; aligned metrics are diagnostics and marketing.

**Sequencing summary:** N1-N5 are all parallel and fit 1-2 sessions. X1 before X2 (re-baseline dense numbers between them; both draw on the same over-segmentation headroom and must not double-count it). X3's probe and X4 run parallel on separate resources. The entire LATER block except L1(a) hangs off X4's gate.

---

## 5. The bet

**The single highest-leverage architectural bet is the Zeus-class sequence decoder shipped as a third fusion citizen behind an agreement referee, with the photo-to-PDF shim as the no-regret floor laid first.** The reasoning chain is short and each link is measured. Both remaining walls are barline-placement failures of context-free visual heuristics: the grid is per-system, locally greedy, concatenated with zero global or musical constraint (geom_omr.py:1655-1684), and the classical lever line has measurably hit diminishing returns (#227 recovered a third of its proven headroom; the photo sweep failed outright; reverie's barline residual is exhausted). An autoregressive decoder emits barlines as tokens conditioned on what the music requires, which is precisely the failure class it sidesteps, and the 2024-2026 field evidence says this works at solo-dev scale: Zeus (CRNN, no transformer) holds the best pianoform camera number (2.54% CER), and 59M-param Transcoda, trained in 6 GPU-hours on synthetic data alone, beats billion-param LEGATO on real scans. This is a genuinely new angle, not a re-litigation of the full-symbol defeat: that engine lost because per-glyph rhythm **detection** is brittle (stem recall 0.054); sequence decoding reads rhythm and structure as context. The referee is what makes a wins-dense-loses-sparse engine shippable at all under the never-worse contract, because the current ladder contains no quality comparison anywhere (worker.py:1767-1868), and it doubles as the confidence signal for the Soundslice-style correction UX. Honest scope: this bet wins the dense-clean wall (0.342 -> 0.5+ bounded by the 0.68-0.93 ceilings) and adds the first rhythm second-source; photo gains stay marginal until L1/L3 fix what the engine is cropped from, and tctab needs its own geometry program.

**Kill criteria, pre-registered:** (1) X4 bake-off: all pretrained checkpoints below 0.3 note_f1 everywhere WITH the Camera-GrandStaff control reproducing published CER and sub-crop inputs also failing - the model class cannot read our distribution; defer the program and keep the positioning numbers. (2) Training: CER trajectory flat or diverging on GrandStaff-LMX at compute-matched sample presentations - architecture or loop is wrong; stop before the data factory bill. (3) Referee: offline study picks the per-piece winner < 80% of the time or violates strict never-worse on any benchmark piece - the engine stays an inert checkpoint until the selector improves; nothing ships. (4) Serving: decoder ONNX export cannot reach greedy-decode parity, or the model misses <= 10s/system / < 1.5GB RSS with fp32 fallback also failing - the cx33 constraint wins; the engine is eval-only until rearchitected. Every gate is real note_f1 on the box; CER/TEDn/staff counts steer iteration but never ship anything.

**Why this beats the alternatives as the bet.** Pure incrementalism (X1/X2/X3) is the right NOW/NEXT program and is funded above, but its own verdicts show it asymptoting: the best classical items are bounded by the 0.451 unconditional-guard reference and the 0.66-0.70 DP ceilings, well short of the 0.68-0.93 recall already sitting under the measure grid. Component retraining (measure detector, staff segmenter) survives review only as adjudicators inside the classical frame and inherits its global-constraint blindness. The sequence decoder is the only surviving path that changes what the system fundamentally knows while respecting every hard constraint: trains in days on the 5060 Ti, serves in seconds on the cx33 CPU, costs nothing, ships flag-gated piece-by-piece, and never touches geom's pitch anchor. If X4 greenlights, this is 3-6 months of gated work to the only defensible version of "best piano OMR in the world": leading the dense-pianoform frontier nobody has cracked, on public yardsticks plus a real phone-photo benchmark only we can publish.
