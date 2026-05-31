# Tech Lead context

Technical memory: architecture, stack, decisions, gotchas. Append durable learnings
at the top of the relevant section, dated.

## Stack

- **Vite + TypeScript** (vanilla, no framework). Canvas-heavy rendering, so a UI
  framework adds little.
- **opensheetmusicdisplay (OSMD)** renders MusicXML to SVG and provides the sheet
  highlight cursor.
- **Tone.js** for synthesis (PolySynth) and the playback transport/clock.
- Canvas 2D for the falling notes and the piano keyboard.
- **Vitest** for unit tests.

## Architecture

- `src/main.ts` — glue: file load, OSMD setup, Tone.js scheduling, the rAF render loop,
  transport controls, and cursor sync.
- `src/score.ts` — `extractScore(osmd)` walks the score with a cloned iterator and
  converts each note's whole-note timestamp/length into absolute seconds. Returns
  `{ notes, stepTimes, duration }`.
- `src/visualizer.ts` — `Visualizer` class: piano layout, falling-note bars, active-key
  highlight. Pure rendering given a current time.
- `src/piano.ts` — 88-key geometry (MIDI 21..108), white/black key layout, name helpers.

**Sync invariant:** the falling notes and the sheet cursor are both driven from the same
note timestamps (`score.notes[i].time` and `score.stepTimes`). They cannot drift apart by
construction; tempo only changes playback speed, not sync.

## Decisions

- **2026-05-31 - #131 PRE-MERGE REVIEW: PASS. `fix/active-highlight-same-pitch` makes the brighter falling-bar "active" fill per-NOTE, fixing a same-pitch double-light. No blocking findings.**
  The bug: `drawFallingNotes` set `isActive = active.has(note.midi)` where `active` is the pitch-keyed
  `activeMidis` set, so EVERY bar of a given pitch lit at once (two stacked "La" both bright, even the
  in-flight twin). Fix introduces a pure `fallingBarActive(note, currentTime) = currentTime >= note.time
  && currentTime < note.time + note.duration` (half-open) and uses it as the per-bar gate; `activeMidis`
  was refactored to reuse the same helper. Why it is correct and safe:
  - **Per-note gate is right and flows everywhere it should.** `isActive` now drives the bright fill, the
    contact glow (`inContact = isActive && !muted && bottom >= keyboardTop - 10`), AND the glyph ink
    (`barGlyphIsDark(note.midi, { active: isActive && !muted, black })`). All three were already keyed off
    the single `isActive` local, so swapping its source from the pitch-set to the per-note window fixes the
    fill, glow, and contrast-matched ink in one shot with no extra wiring. `barGlyphIsDark`'s signature is
    unchanged (`{active, black}`), so the call shape is identical.
  - **Half-open upper bound is the load-bearing detail, not a cosmetic tweak.** The old code used `<=`
    (inclusive) in `activeMidis`. With a legato same-pitch repeat where `note2.time === note1.time +
    note1.duration`, an inclusive end would light BOTH the releasing twin and the arriving onset for the
    seam frame. The half-open `[time, time+duration)` hands the highlight cleanly to the onset note. The
    test `hands active to the onset note at a legato same-pitch seam` pins exactly this (first goes dark,
    second lights, at t == seam).
  - **`activeMidis` refactor is behavior-preserving EXCEPT the intended boundary tightening.** It changed
    `<= n.time + n.duration` to the helper's `<`. This is deliberate and documented (design.md): the
    keyboard key light and the bar must not drift on the release rule, so the key now also goes dark exactly
    at `time+duration`. A key being lit for one extra frame at the precise release instant is not a
    user-visible regression, and unifying the rule is the correct call. The keyboard-key light stays
    pitch-keyed by design (a physical key is one object); only the bar fill became per-note. That divergence
    (key pitch-keyed vs bar per-note on repeated pitches) is intentional and recorded in design.md.
  - **Separate boundary in `approachingKeyMidis` (piano.ts:535) is correctly left ALONE.** It keeps its own
    inclusive `<= n.time + n.duration + LABEL_TIME_EPSILON` because it gates which keys to LABEL (a look-ahead
    concern), not which bar is sounding. The half-open change is scoped to `fallingBarActive` only.
  - **Sync invariant untouched.** No change to `score.ts`, timestamps, `stepTimes`, scheduling, or the render
    clock. `fallingBarActive` is a pure read of `note.time`/`note.duration` against the same `currentTime` the
    whole render loop uses, so falling notes and sheet cursor still share one timestamp source.
  - **Test adequacy: GOOD.** New `src/visualizer.test.ts` (4 cases) covers the half-open window edges
    (onset inclusive, release exclusive), the legato seam handoff, the sequential same-pitch no-double-light
    (the actual #131 regression), and genuine overlapping/chord windows lighting independently. Pure helper,
    so unit tests are the right level; the canvas wiring is exercised by the existing render path. 312/312
    tests + build green. No security review warranted (no network/auth/file/dep change; pure rendering math).

- **2026-05-31 - OMR TIE SPIKE, olimpic/Zeus (Sheet Music Transformer) trial: CORROBORATES Clarity. Zeus ALSO recovers ties on icarus and independently flags the SAME held LH low whole notes near the end - but it is far less practical to run than Clarity. Net: two independent ML engines agree the real tie is machine-detectable; Clarity remains the practical pick.**
  Trialed `ufal/olimpic-icdar24` Zeus model (`zeus-olimpic-1.0-2024-02-12.model`, CC BY-SA) on icarus. Results (delinearized LMX -> MusicXML, summed over the 3 systems): **144 notes / 4 `<tied>` (3 start, 1 stop), ALL 4 ties in the correct system** (the m17-26 grand staff that actually carries the ties). The tied notes: a RH A4->C4 whole tie (INVALID - a tie must be same-pitch, so a misrecognition) and **LH G2 + E3 whole notes marked tie=start near the end** = the held LH low tie the spike targeted. So Zeus, like Clarity (which flagged C2+G2 in the same spot), detects the LH held tie START but leaves it UNPAIRED (no stop) - the identical dangling-start failure mode. Two independent models landing on the same LH low notes is strong evidence the tie is genuinely recoverable; the open problem is start/stop pairing on the final measure, not detection.
  - **Why Zeus is NOT the practical pick despite working:** it only recognizes ONE staff-system at a time (no page/PDF entrypoint), so the trial required: hand-slicing icarus into 3 grand-staff system crops (reused Clarity's YOLO bbox geometry to do it), fabricating a dummy dataset pickle with placeholder gold `.lmx`/`.musicxml` per system (its predict CLI is built for benchmarking against gold, `create_pickle.py` even asserts single-line LMX), and working around a bug in its `delinearize` CLI (`os.path.splitext(filename) + ".musicxml"` concatenates a tuple - use the `-` stdin path instead). It is TensorFlow (Keras-2 era), CC BY-SA, ~27 MB model. Contrast Clarity: one command, reads the PDF directly, auto-detects systems via YOLO, ~15s CPU. For integration into `worker.py`, Clarity is the realistic candidate; Zeus is a research baseline that confirms the result but would need a custom system-segmentation + tiling harness to use.

- **2026-05-31 - OMR TIE SPIKE FOLLOW-UP: Clarity-OMR is the FIRST engine to emit ANY ties on icarus, and it landed one on the correct held LH low whole notes. It also beats oemer on note recall and is ~12x faster on CPU. Most promising tie path found so far, but NOT drop-in: tie pairing is buggy (the real LH ties came out as dangling starts) and it emits 2 parts instead of 1-part/2-staves. Worth a deeper eval, still research-grade.**
  Trialed Clarity-OMR (github.com/clquwu/Clarity-OMR, GPL-3.0) on icarus.pdf in an isolated py3.11 venv (`/tmp/clarity-venv`), CPU `--fast` mode. Numbers vs the oemer baseline (130 notes / 27 measures / 0 ties):
  - **Fidelity:** 145 `<note>` (141 pitched) / ~26 measures per part / 2 parts / 0 slurs. MORE notes than oemer (some may be hallucinated; it is a transformer model).
  - **TIES: 4 `<tied>` (3 start, 1 stop)** - the first non-zero tie count from ANY engine on icarus. Locations: RH E6 m14->m15 (a fully paired tie, real-ness unverified) and **LH C2 + G2 whole notes in m26 marked tie=start** - that IS the held LH low whole-note tie across the barline the spike was chasing.
  - **The catch (why it is not drop-in):** those two LH ties are UNPAIRED starts (`unmatched_tie_starts: 2` in its run JSON) - the model saw the held note begin but did not close it into the final measure, so in raw form OSMD/`mergeTiedNotes` (#123) still cannot fold them (it needs matched start+stop). So the held note would STILL re-strike as-is. The tie detector is close but the start/stop matching in `assemble_score.py` / model output is imperfect on the last measure. NB: it also carries a same-pitch-across-barline tie HEURISTIC (`_insert_ties`, assemble_score.py:581) - the exact thing #121 rejected - so on a re-struck-chord score like icarus expect SOME false-positive ties too.
  - **Structure diff:** emits 2 separate `<part>`s (one per staff) rather than oemer's 1 part / 2 `<staves>`. Falling-notes don't care (pitch+time only), but OSMD would render two instruments instead of a grand staff - frontend/`score.ts` impact to check before any adoption.
  - **Cost/limits (all FREE, fits constraints):** GPL-3.0, pure Python, CPU-only, ARM/Apple-Silicon fine. Pipeline = YOLO staff detection (auto-segments systems, so NO manual slicing needed, unlike olimpic-SMT) -> transformer token recognition -> music21 MusicXML export. Footprint: ~1.5 GB venv (mostly torch), ~336 MB one-time HuggingFace model download (`yolo.pt` + `model.safetensors` + a timm backbone). **Speed: ~15s CPU inference on icarus (1 page) vs oemer's ~180s** - it is FASTER, not slower (the survey's "slow" rating was for multi-page/large beam; `--fast` beam-2 on one page is quick). Reads PDF directly via pymupdf (no pdftoppm).
  - **Verdict:** the only engine that demonstrably recovers ties on our own material. Next step if pursued: run at full beam (not `--fast`) + 350 DPI to see if the LH tie pairs close, assess the 2-part structure against `score.ts`, and quantify false-positive ties from the `_insert_ties` heuristic on re-struck chords. Not shipped; spike only.

- **2026-05-31 - OMR ENGINE TIE SPIKE (option 2: swap/augment engine): VERDICT = do NOT switch to Audiveris, and do NOT bolt it on as a tie pass. On icarus it recovers HALF the notes oemer does AND still emits zero ties. Stick with oemer; treat ties as an engine-ceiling problem. The forward bets are the human-in-the-loop correction UI (#6) and, if we want an ML engine swap, a tie-aware model (Clarity-OMR / olimpic-SMT), NOT Audiveris.**
  Empirical, head-to-head on `/Users/simonepasculli/Documents/MuseScore4/Scores/icarus.pdf` (scratch under `/tmp`, oemer via `~/piano-helper-omr/.venv`):
  - **Ground-truth ties in icarus:** the score is mostly RE-STRUCK chords/arpeggios (why the #121 blind same-pitch merge was rejected), with a small number of genuine tie curves visible: the **held LH low whole-note tied across the barline near the end** (bottom-right of system 3) plus a tied treble whole note at the very end. So ties DO exist to recover; they are just sparse.
  - **oemer 0.1.8 baseline (350 DPI, `--without-deskew`):** 130 `<note>` (123 pitched), 27 measures, 1 part, 2 staves, **0 `<tied>` / 0 `<tie>` / 0 slurs.** Confirms the known drop-all-ties behavior exactly.
  - **Audiveris 5.10.2 (latest, macOS arm64 DMG, batch `-export`):** at its internal ~300 DPI PDF render -> **64 notes, 24 measures, 0 ties, 0 slurs**; re-run on our 350-DPI PNG (interline 24-25) -> **63 notes, 24 measures, 0 ties, 0 slurs.** Both runs logged `SlursBuilder ... Slurs: 0` and `No reliable beam height found` — Audiveris detected ZERO curves to even classify, so the 0 ties is a curve-RECOGNITION failure on this clean-but-thin-tie MuseScore PDF, not an export limitation. (The survey confirms Audiveris #513/#596 DO export `<tied>` when a curve is detected; it just isn't, here.) Bumping resolution did not unlock it.
  - **Why this kills both sub-options:** (a) straight swap regresses note recall ~2x (63 vs 130) and loses 3 measures while STILL giving 0 ties — pure loss; (b) "oemer for notes + Audiveris only for ties, then merge" adds nothing because Audiveris found 0 ties on the very file we care about, and cross-aligning two engines' note streams to transplant a tie marker is brittle.
  - **Survey of free tie-capable engines (CPU/ARM, free):** oemer = none (no notations code at all); homr = slur/tie code exists but is DISABLED/"really bad" (its issue #81); MuseScore "PDF import" = it IS Audiveris under the hood, same ceiling; **Audiveris** = exports `<tied>` but failed to detect the curve here; **olimpic / Sheet Music Transformer (SMT)** = MIT, pianoform-tuned, `tied:start/stop` in its vocabulary by design (best clean tie story, research-grade); **Clarity-OMR** = GPL-3.0, dedicated tie/slur token branch, has a slow CPU mode (the homr author rates its ties best-in-class). If we ever do an engine swap FOR ties, evaluate Clarity-OMR / olimpic-SMT, not Audiveris.
  - **Integration cost if we ever revisit Audiveris:** it ships a self-contained jpackage bundle with its own JRE + arm64 Tesseract/Leptonica + pdfbox (no system Java/Tesseract/poppler needed), AGPL-3.0, Ubuntu .deb available for the Oracle ARM move. So it's installable within the free/host constraints — the blocker is purely that it doesn't recover the ties, not licensing or footprint.

- **2026-05-31 - #127 PRE-MERGE REVIEW: APPROVE-WITH-NITS (non-blocking). `feat/nocturne-theme` (commit 6d14f1f) remaps the violet `:root` tokens + canvas literals to a brass/ebony/ivory palette and re-anchors `pitchHue` 276 -> 40. No blocking findings.**
  Pure visual/color change (no network/auth/file/dep), so no security review. 308/308 tests + build green. Verified the three review asks:
  - **(1) No leftover violet LITERALS anywhere in src/index.html.** Grepped the full tree (not just changed files) for every violet hex used by the old theme (`#b14bff`, `#7a2fd6`, `#d9a6ff`, `#f2ecf8`, `#f7f2ff`, `#f6f2fb`, `#100b1a`, `#15101f`, `#2a2238`, `#1a0f2b`, `#5b4a72`, `#0a0712`, `#120b1f`) and the rgba forms (`177,75,255` / `232,224,245` / `10,7,18` / `20,12,32`): ZERO hits in non-test source. index.html has no inline color literals at all. The grep DID surface 5 stale "violet"/"purple" WORDS in comments (`visualizer.ts:234` "deep violet" describing a hand-cap example, `piano.ts:552` "instead of violet" which is correct/intentional, `style.css:4` correct, and `style.css:318/362/363` "filled-violet"/"Tints violet on hover" now describe brass). These are cosmetic comment drift, NOT leftover styling. Non-blocking nit; flagged to author.
  - **(2) Re-anchor math + test expectations are CORRECT.** `pitchHue = (40 + pc*30) % 360` updated in all three sites (the fn, `PITCH_CLASS_COLORS`, `PITCH_CLASS_GLYPH_DARK`). Independently recomputed the full 12-entry hue table and the `visualizer-color.test.ts` reference values (pc3=130, pc6=220, pc11=10, wrap correct) - all match. Independently recomputed the contrast-aware glyph-ink groupings via the exact `hslToRgb` + Rec.601 `rgbLuminance` >= 0.6 on `whiteFill hsl(h,85%,62%)`: C(0.743)/E(0.725)/F(0.687) are LIGHT bars -> dark ink (`barGlyphIsDark`=true), G(0.403)/A(0.552)/B(0.553) are dark bars -> light ink (false). Exactly what `piano.test.ts` now asserts and what design.md records (light-bar C/E/F, dark-bar G/A/B). D#(0.688) and F(0.687) sit just above the 0.6 threshold - correct but close; the threshold is unchanged so no concern.
  - **(3) No contrast/accessibility regression.** Recomputed WCAG AA ratios: ivory text `#efe9dc` on ebony `#0b0a0d` = 16.3:1; brass `#d8a23a` as text on ebony = 8.6:1; near-black ink `#1a140d` on brass Play hero = 7.96:1 (the white-on-brass trap is correctly avoided via `--on-accent`); focus ring `#f0c66b` on bg = 12.2:1; sheet ink `#6b4f1f` on cream `#f6f1e6` = 6.75:1. All pass AA for normal text. design.md's cited figures (~15.8 / ~8.9 / ~7) are slightly off but conservative-enough and not load-bearing. NIT: the empty-sheet placeholder `#8a7a5c` on cream = 3.71:1, below AA 4.5:1 for body text but >= 3:1 (the old `#7a7088` was 4.0:1, also sub-AA, so NOT a regression introduced here); it is a one-line non-interactive hint, acceptable, flag for a future darken to ~`#6f6043` if we want strict AA. Play-hero ink against the gradient's DEEP-brass end `#a9761f` = 4.61:1, still AA.
  - **Sync invariant untouched:** zero changes to timestamps, `score.ts`, scheduling, or the render clock - only fill/stroke colors and one hue constant. Verdict APPROVE; nits (stale comment words, one sub-AA placeholder hint) are non-blocking and can ship or be swept in a follow-up.
- **2026-05-31 - PHASED PRODUCT ROADMAP delivered to founder: 3 phases (MVP polish -> growth -> evolution), each feature tagged effort (S/M/L) + free/Pro tier, with an honest engine-ceiling vs product-work split.**
  Written from product.md (monetization: free + ~$39 one-time Pro, ~600-1000 conversions/month compute ceiling on the single serial OMR worker) and the OMR audit reality in this file (#121: ties/arpeggios/metadata are all engine-dropped; #112: DPI past its sweet spot; #113 revert: NEVER fabricate pitches; #6: correction UI split into a spike + #6a-d slices). Key sequencing calls recorded so a future session does not relitigate:
  - **Correction UI (#6a: click a falling bar, pitch-nudge +/- semitone, delete) is the Phase 1 linchpin and the FIRST thing to build.** It is the only honest answer to the engine ceiling: oemer drops ties/arpeggios/metadata and slips octaves/chords, and we are forbidden from fabricating the fix (#113 revert). A human-in-the-loop correction step is what turns "approximate scan" into "a score I trust," and trust is the precondition for ANY paid feature. It also unblocks Export and Saved Library (no point exporting/saving a wrong score). It is product work we fully control, NOT gated by the engine. Effort M for #6a (first mutable selection model + canvas hit-testing + score.notes mutation; needs the designer/PM sheet-divergence spike first). Free tier. Later slices #6b duration / #6c add-note / #6d sheet write-back + persist follow in Phase 2/3.
  - **Pro paywall plumbing lands in Phase 2, AFTER correction UI + saved library + export exist to justify paying, but the conversion-cap meter ships WITH accounts.** Shipping the unlock before there is something worth ~$39 (export, higher conversion cap, saved library) trains users that Pro is empty. The free cap (3/day, 10/month per product.md) is the load-bearing free->paid lever and the only thing that keeps us under the worker ceiling, so it must exist as soon as accounts do. One-time unlock only, NO subscription (no recurring billing burden, fits free infra). Effort M (license check + cap metering; a payment provider that needs no server we run, e.g. a hosted checkout that returns a license key we store against the account).
  - **OMR fidelity (#88 stronger engine / oemer+homr ensemble) is mostly engine-ceiling and belongs in Phase 3, NOT Phase 1.** The cheap pixel levers are exhausted (DPI sweep #112 found 350 is the sweet spot; #109 preprocessing shipped; #113 fabrication reverted). Remaining gains (native tie/arpeggio/metadata capture, better recall) need a stronger engine or an ensemble, which is research-shaped (two MusicXML schemas, merge reintroduces note-invention risk) and does not fit a weekend slice. The correction UI gives users the fidelity escape hatch in Phase 1 at near-zero engine risk, which is exactly why fidelity work is correctly deferred behind it.
  - **Audio import (monophonic, client-side per #19) is a Phase 2 funnel expander, not a fidelity play.** It runs in-browser at zero hosting cost, so it does NOT consume the OMR worker ceiling: the cheapest way to widen the input funnel and reach users with no sheet PDF. It reuses the correction UI (transcription is approximate), so it is correctly sequenced after #6a.
  - **Export (MIDI/MusicXML/video) is the clearest Pro feature.** MIDI/MusicXML export is S (re-serialize score.notes); video export already has scaffolding (exportVideo in main.ts). Only worth gating once correction UI makes the exported score trustworthy: Phase 2, Pro tier.
  - **The "if you only do 3 things" call: (1) #6a correction UI, (2) accounts + saved library + the conversion-cap meter, (3) Pro unlock + export, in that order.** Everything else (audio import, stronger engine) is downstream of trust + retention + the ability to charge. Full writeup delivered to the founder this date.

- **2026-05-31 - TIE-ARC RASTER DETECTION SPIKE (feasibility only, no code shipped): QUALIFIED FEASIBLE but NOT worth shipping yet. The geometry mapping is solid; the arc detector as prototyped is too false-positive-heavy (1 true / 9 fired on icarus). Recommend deferring to #88 unless a much stricter detector is built and validated on a multi-file corpus.**
  Spike question: can we recover oemer-dropped cross-bar ties by detecting the tie ARC in the raster between two same-pitch noteheads? Scratch code under `/tmp/tie_spike/` (`dump_noteheads.py`, `arc_detect.py`, `crops.py`).
  - **GEOMETRY: SOLVED, reliable.** oemer's NoteHead objects carry `bbox`, `staff_line_pos`, `track`, `id`. Running the pipeline in-process up through `notehead_extraction.extract()` (replicate `ete.generate_pred` -> register layers -> `staff_extract` -> `note_extract`) yields 144 noteheads, ALL with valid bboxes. CRITICAL COORD FACT: bboxes are in oemer's INTERNAL resized space (1611x2280 = the teaser PNG dims), NOT the original raster (2893x4094). To probe pixels, resize the raster to teaser dims (or crop the teaser, but the teaser has colored annotation overlays so use a clean resized raster). Pitch on the MusicXML note is derivable from `staff_line_pos` + clef (`build_system.G_CLEF_POS_TO_PITCH` / `F_CLEF_POS_TO_PITCH`), and Voice.note_ids index the global notes layer, so NoteHead.id maps to MusicXML order. So WHERE-to-look and WHICH-note-to-tag are both reconstructable. (`--save-cache` only pickles model preds, NOT NoteHeads; must re-run extraction in-process.)
  - **ARC DETECTION: PROTOTYPED, but precision is poor.** Strategy: for same-track same-`staff_line_pos` same-y right-adjacent notehead pairs, crop the gap, strip staff lines (near-full rows) and stems/barlines (near-full cols), require >=55% horizontal coverage + low-residual shallow quadratic (an arc). On icarus: 72 candidate pairs -> detector fired on 9.
  - **GROUND TRUTH on icarus (visually verified every hit against the source raster): 1 TRUE POSITIVE, 8 FALSE POSITIVES.** The one real hit (track0 pos-1 y~1432, the LH bass-clef whole-note pair across a barline) shows an unmistakable curved tie arc and was correctly caught. The other 8 are consecutive melody noteheads with NO arc; the detector latched onto STAFF LINES and LEDGER LINES running between/under the noteheads (the staff-line removal heuristic is too weak when a notehead sits ON a line, e.g. pos15/pos16 ledger-line notes). Precision ~11%, which is unshippable: false ties would SUSTAIN notes that should re-attack, the exact #121/#116 overreach class but now firing on the melody.
  - **VERDICT: QUALIFIED NO for now.** The approach is fabrication-safe in PRINCIPLE (it keys on actual raster evidence, not "same pitch twice = tie", so it dodges the #121 reject rationale) and the one true tie proves the signal exists and is detectable. But the prototype detector cannot yet separate a tie arc from a staff/ledger line reliably. To ship, the detector needs: (a) a much stronger staff/ledger-line mask (use oemer's `staff_pred` layer, which we already have, to subtract known staff pixels before arc fitting, instead of the brittle row-fill heuristic), (b) require the arc to BOW AWAY from the noteheads with a minimum sagitta and live OUTSIDE the staff-line set, (c) reject when the two noteheads are at different actual pitches (the pos15/pos16-on-a-line false matches suggest staff_line_pos alone is ambiguous near ledger lines). Effort to do that right and validate on a multi-score corpus is real (est. 1-2 focused days), and a single-file precision of 11% means we cannot trust a quick fix. Main risk: a confidently-wrong sustain on the melody is more audible/harmful than the current honest re-attack. RECOMMENDED NEXT STEP: park this under #88 (stronger engine that captures ties natively is the cleaner fix); only revive the raster post-pass if #88 stalls AND someone first uses `staff_pred` to get precision/recall to a validated high bar on >1 file. Do NOT wire the current detector into worker.py.

- **2026-05-31 - #123 PRE-MERGE REVIEW: APPROVE. `fix/omr-tied-notes` merges true MusicXML ties into one sustained note. This is NOT the #121-rejected blanket same-pitch merge; it is the safe complement, and it does not contradict the #121 audit.**
  Reviewed `fix/omr-tied-notes` (commit f9b6342, `src/score.ts` + `src/score.test.ts`). `extractScore` now
  tags each note with a per-Tie id (`note.NoteTie`, `tie.StartNote` marks the chain head) into a `RawNote[]`,
  and a pure `mergeTiedNotes` folds tie-continuation durations into the chain's start note. Verdict APPROVE,
  no blocking findings. Why this is correct and safe:
  - **The #121 reject and this fix are different problems with the SAME object property.** #121 rejected
    fabricating ties oemer DROPPED (no `<tie>` in oemer output, so a blanket "merge adjacent same-pitch whole
    notes" would silence icarus's legitimately re-struck LH block triads). This fix only acts on ties the
    source XML ACTUALLY declares: it keys on `note.NoteTie`, which OSMD populates ONLY from real `<tie>`/`<tied>`
    markup. Verified empirically (jsdom probe): a score with two repeated G2 whole notes and NO `<tie>` markup
    yields `note.NoteTie === undefined` on both, so the merge never fires. OSMD does not invent ties on
    coincidental repeats. So this fix CANNOT corrupt block-chord LH parts (the #121 fear) and does not relitigate
    #121: it serves real-tie source files (MusicXML uploads, music21 output), while oemer scans that drop the
    tie marker simply get no merge (unchanged, still re-attacked, which #121 already accepted as engine-ceiling).
  - **No double-counting (the load-bearing fact, verified by jsdom probe).** Each tied segment's
    `note.Length.RealValue` reports ONLY its own segment length (a 3-measure tied whole note = `len=1` on all
    three segments, NOT a summed 3 on the start). OSMD does NOT pre-sum the tie into the start note's Length.
    So `extractScore`'s old code emitted three full-length restruck notes, and `mergeTiedNotes` summing the
    three segment durations (1+1+1 -> 3 whole notes) reconstructs the correct sustain. (Aside: `tie.Duration.RealValue`
    came back as 3 too, but the code does not use it; summing segment Lengths is equivalent and is what the
    tests pin.)
  - **Sync invariant intact.** The merge only EXTENDS the start note's `duration`; it never changes any note
    `time` and never touches `stepTimes` (still pushed once per iterator step). Falling notes (note.time) and the
    sheet cursor (stepTimes) stay from the one timestamp source. Playback (`main.ts:233-239`) schedules ONE
    `triggerAttackRelease` per `score.notes` entry with `note.duration`, so a merged tie = one held attack
    instead of N re-attacks. Exactly the #123 fix.
  - **Edge cases checked:** independent simultaneous tie chains (a tied chord) merge separately by tieId (test
    covers it); an orphan continuation with no recorded start is emitted standalone (never dropped) and does NOT
    register itself as a start, so it cannot absorb a later segment; the output `VisNote` is a fresh object that
    strips `tieId`/`isTieStart`, so no tie metadata leaks downstream.
  - **Test-env limitation (not a defect):** the suite cannot drive full `extractScore` under jsdom because
    `osmd.cursor` is undefined without a render (no real SVG layout), so the shipped real-parse test validates
    `note.NoteTie`/`StartNote` via `Sheet.SourceMeasures` (the same object graph `extractScore` reads) plus pure
    `mergeTiedNotes` cases. That is the established pattern in this repo and adequately pins the contract. 308/308
    tests + build green. No security review warranted: pure parsing logic, no network/auth/dep/file-handling change.

- **2026-05-31 - #121 GAP 1 DIFF AUDIT: oemer raw output vs OUR pipeline on icarus.pdf. Verdict: ties + arpeggios + ALL metadata are ENGINE-DROPPED (absent from oemer's raw MusicXML), NOT pipeline-dropped. No cheap parse/render fix exists for them; only cross-bar ties are worth a pipeline fix in Gap 2.**
  Generated the RAW oemer MusicXML locally at 350 DPI exactly like the worker (`pdftoppm -r 350`, then `oemer img -o out --without-deskew`) and diffed it per-measure against the source score images. Captured BEFORE any of our post-processing, so engine gaps are distinguishable from pipeline gaps.
  - **GOTCHA (cost ~40 min): oemer 0.1.5 crashes on numpy >= 1.24** with `AttributeError: module 'numpy' has no attribute 'int'` at `staffline_extraction.py:327` (`np.array(rr, dtype=np.int)`, a removed alias). It exits NON-ZERO with an EMPTY `-o` dir, so it looks like a silent no-op. Fix: `pip install 'numpy<1.24'` (1.23.5 works; opencv-python warns it wants numpy>=2 but still runs). The OMR worker image MUST pin numpy<1.24 or oemer produces nothing.
  - **GOTCHA: run oemer in the FOREGROUND.** Running it inside a backgrounded subshell produced an empty `-o` dir every time even when exit was 0; the output never persisted (the bg sandbox CWD/temp is ephemeral). A plain foreground `oemer ... -o /abs/out` wrote `out/page-1.musicxml` fine. oemer names output `<basename-sans-ext>.musicxml` from `ete.py:202/211` (so `page-1.png` -> `page-1.musicxml`, NOT `page-1.png.musicxml`).
  - **Raw oemer global counts (decisive, via `xml.etree`):** 27 measures, 130 notes, 7 rests, 30 `<chord>` flags; `tie`=0, `tied`=0, `arpeggiate`=0, `notations`=0, `slur`=0, `dynamics`=0, `direction`=0, `metronome`=0, `fermata`=0. divisions=16, fifths=0 (C major), clef1=G clef2=F. CAVEAT: time `<beats>`/`<beat-type>` came back None in this run (oemer wrote an odd time block) even though the bars sum to 4/4. METADATA is fabricated, not real: `work-title`="Page-1" (the input filename), `movement-title`=None, `creator`="Transcribed by Oemer" (type=composer, a hard-coded placeholder, NOT "Simone Pasculli"), one `<sound tempo>` (a DEFAULT 90/120 that varies per run, NOT the real Andante). So oemer emits real pitches + durations + chords + clef/key, plus PLACEHOLDER title/composer/tempo, and drops ties, rolls, dynamics, real tempo, real title and composer.
  - **Per-measure recall (this exact 350-DPI run; oemer is NONDETERMINISTIC run-to-run, so trust the classification not the literal pitches): RH IS noisier than the #112 sweep suggested.** RH M1-6 = a stepwise `Xh Xq Xq` melody (M1 `C5h C5q D5q`, M2 `B4h B4q C5q`, ...); M6 even got the fast tail `E5h D5e C5e D5q`. M7 `C5w`. M8 `G5h A5q B5q`. M9/13 = the FAST groups recovered as `C6h +E5h E6e F6e E6q` (a dyad then beamed eighths) -> the "fast groups become rests" symptom is GONE; only M16/M21/M25/M26/M27 RH are rests. LH = a FULL whole-note triad/dyad in nearly every bar 1-24 (M1 `E4 +G3`, M2 `G3 +B3 +E4`, etc), thinning to low `C3/G2/E3` triads M21-24 and single notes (`G2w`) at M26/M27. NOTE: the SPECIFIC pitches here disagree with the source in places (octaves shifted, some chord tones wrong); that is engine recall noise, not a pipeline bug.
  - **TIE classification = ENGINE-DROPPED, but pitch-safe.** Source ties the final RH whole notes across a barline and the LH whole notes near the end; oemer emitted them as SEPARATE notes with NO tie markup (`tie`=0/`tied`=0/`notations`=0) in EVERY run. Where both tied pitches were recovered, the link is simply absent. `src/score.ts` has ZERO tie/tied handling (grep confirmed: only clef-comment hits); sustain relies entirely on OSMD merging a tie into `note.Length.RealValue` (score.ts:160). With no `<tie>` in the XML, OSMD cannot merge, so we re-attack each note instead of sustaining across the bar. Audible re-attack, but NO dropped pitch, NO sync break. (Caveat: when a run ALSO drops the second tied note to a rest, that is a separate recall miss, not a tie-parse gap, and must NOT be "fixed" by fabricating the note.)
  - **ARPEGGIO classification = ENGINE-DROPPED, and harmless to audio.** Source has roll (arpeggiate) squiggles on the RH chord stacks at the start of mm9/11/13/15 (verified by zooming page-1.png: a vertical wavy line left of the stacked notes). oemer emitted the chord NOTES (those bars show `+E5 +C5` chord members) but ZERO `<arpeggiate>`. `src/score.ts` ignores `<arpeggiate>` entirely anyway, and a roll is a pure performance ornament: the pitches still sound, just simultaneously instead of rolled. Costs no pitch and no sync. Lowest priority.
  - **FINAL DECISION (#121 closed on the audit, build deferred): NO Gap 2/3 fix shipped; all three gaps are engine-ceiling.** The earlier draft idea of "safely merge adjacent same-pitch whole notes to reconstruct the dropped tie" was REJECTED on this exact audit data: icarus's LH is wall-to-wall UN-tied whole-note triads that legitimately share tones across barlines (M1 `G3`->M2 `G3`, M1 `E4`->M2 `E4`). With oemer dropping the `<tie>` marker entirely there is NO signal to tell a real tie from a coincidental repeat, so a blanket merge would SILENCE legitimately re-struck LH notes - an audible regression in the opposite direction, the same overreach class as the #113 revert. The "first fills its measure" qualifier does NOT save it (the LH triads also fill their measures). So: ties, arpeggio rolls, and metadata (title/tempo/dynamics) are all engine-ceiling - no fabrication-safe pipeline fix exists. The build (better recall + native tie/arpeggio/metadata capture) belongs to a stronger engine under #88; any user correction would go through the #6/#105 correction UI. Our pipeline already passes through everything oemer DOES emit (pitches, durations, chords, clef, key) correctly, so there is nothing to fix on our side. If a future session is tempted to build the tie merge, re-read this: it WILL corrupt block-chord LH parts.

- **2026-05-31 - #112 DPI SWEEP: lower PDF_RASTER_DPI 400 -> 350 (`fix/omr-dpi-sweep`, commit 6e62835). Pre-merge review APPROVE-WITH-NITS.**
  Real sweep on icarus.pdf (clean 1-page vector, 27 bars, 4/4, C major, NATURAL LH block triads, NO accidentals).
  Each DPI mirrored the worker pipeline exactly (pdftoppm -r DPI, then `oemer img --without-deskew`), parsed the
  MusicXML, and the 350 output was rendered in MuseScore and eyeballed against the source:

  | DPI | total | RH | LH | LH chords>=2 | LH triads>=3 | rests | measures | fabricated alters |
  |-----|-------|----|----|----|----|----|----|----|
  | 250 | 111 | 66 | 45 | 14 | 5 | 4 | 26 (lost 1) | 0 |
  | 300 | 118 | 66 | 52 | 16 | 7 | 10 | 27 | 0 |
  | 350 | 123 | 66 | 57 | 17 | 11 | 7 | 27 | 0 |
  | 400 (was shipped) | 109 | 66 | 43 | 12 | 4 | 8 | 27 | 0 |
  | 500 | 118 | 66 | 52 | 18 | 8 | 6 | 25 (lost 2) | 0 |

  - **350 is the sweet spot:** max genuine LH chord-tone recovery (11 triads vs 400's 4), max total recall (123 vs
    109), keeps all 27 measures, and EVERY recovered LH note is a diatonic C-major natural (m5 C-E-G, m7 A-C-E,
    m8 A-C-F). 400 over-upscaled noteheads and HURT chord separation (collapsed triads to lone bass). 500 starts
    dropping whole measures. Wall-clock ~180s at every DPI in range, so 350 costs nothing in speed.
  - **DPI is fabrication-safe BY CONSTRUCTION** (the key contrast with reverted #113): it only changes raster
    density. It cannot synthesize a pitch the engine did not read. Zero non-natural alters at every DPI confirms it.
    This is the right kind of lever for #118 (close honest recall gaps WITHOUT inventing pitches).
  - **Honest non-result: RH recall is DPI-invariant (66 notes at every DPI).** The RH arpeggio/dropped-note
    symptom is an oemer engine limit, NOT a preprocessing problem. DPI cannot move it; it stays with #88 (stronger
    engine) / #6 (correction UI). Recorded so nobody re-sweeps DPI hoping to fix RH.
  - **Review verdict / NITS (both addressed before merge):** (a) a stale comment at worker.py:266 said "one real
    400 DPI A4 page (~15.5 MP)"; the first commit updated the two MP figures in the resource-guard block but missed
    this third one in `stitch_pages_vertical`. FIXED in the amended commit (now 350 DPI ~11.8 MP). Cosmetic only:
    MAX_STITCH_PAGES/PIXELS are DPI-independent and the guard still holds (verified: 350-DPI A4 = 11.8 MP, 60 pages
    = 708 MP, under the 1 GP cap, ~85x headroom for one page). (b) Pinning `== 350` is correct, not over-brittle: it locks a measured
    decision so a future drift back to 400 trips the test loudly; the looser `300 < dpi <= 400` band is kept
    alongside as the rationale guard. No security-review warranted: no transport/contract/parser/dep change, the
    only edit is a raster-density constant; the OOM guards that bound untrusted multi-page input are untouched.

- **2026-05-31 - #113 REVERTED. Chord-completion fabricated wrong notes; metric went up, fidelity went down.**
  Shipped #113 cleared every gate (CI green, review APPROVE-WITH-NITS, QA triad count rose) and was still
  WRONG on the user's own score. icarus.pdf has NATURAL LH block triads almost every bar; the rendered output
  showed spurious sharps (diesis). Root cause: `complete_lh_chords` learns ONE "dominant" LH chord SHAPE oemer
  detected somewhere in the piece and stamps that interval pattern onto every lone LH note. On icarus the
  dominant detected shape was a D-major-type triad, so the pass fabricated `Fa#` across measures whose real
  harmony is a natural triad. The triad COUNT (the QA acceptance metric) rose precisely because we were inventing
  triads, not recovering them.
  - **Lesson: a count metric (number of triads/notes) is a bad proxy for musical correctness.** Adding
    confidently-wrong notes is worse than missing notes for a learning tool: a student trusts what they see and
    practices a wrong accidental. Never let an OMR post-pass INVENT pitch content the engine did not detect.
    Any future LH-recovery work must derive pitches from the actual score (higher recall: DPI sweep #112,
    a stronger engine #88, or a human-in-the-loop correction UI #6/#105), never by pattern-stamping a guessed
    harmony.
  - **What the revert removed:** the whole `complete_lh_chords` post-pass + helpers, the `xml.etree`/`Counter`
    imports, the `body = complete_lh_chords(body)` call in `process_job`, its Python tests, and the JS
    source-guard block. worker.py is back to its #109 state (PDF_RASTER_DPI=400, vertical stitch,
    `--without-deskew`); the R2 transport contract is untouched.
  - **Still-open genuine gaps (NOT caused by #113, do not chase with fabrication):** oemer reads arpeggios as
    rests and drops some notes. These are recall limits of the engine at this DPI. The honest levers are the DPI
    sweep (#109 data hinted lower DPI may recover recall: 300 DPI gave 128 notes vs 400 DPI's 109 on icarus -
    measure this properly), a better engine (#88), or the correction UI (#6/#105). Measure fidelity by eye
    against the source PDF, not by note count.

- **2026-05-31 - #113 PRE-MERGE REVIEW: APPROVE-WITH-NITS. No blockers; the DOCTYPE drop and the ElementTree billion-laughs vector were both assessed and are acceptable here.**
  Separate skeptical review of `fix/omr-lh-chord-completion` (code-review + security-review since the pass parses
  engine-derived-from-untrusted-upload XML inside the always-on poller). Verdict APPROVE-WITH-NITS.
  - **DOCTYPE drop is ACCEPTABLE, not a blocker.** Confirmed empirically: when `complete_lh_chords` changes the
    tree it re-serializes via `ET.tostring(xml_declaration=True)`, which DROPS oemer's
    `<!DOCTYPE score-partwise PUBLIC ...>` and rewrites the decl with single quotes
    (`<?xml version='1.0' encoding='utf-8'?>`). OSMD does NOT require the DOCTYPE: the existing real-parse
    fixtures in `src/score.test.ts` (SINGLE_STAFF_TREBLE_TO_BASS, GRAND_STAFF, DB_MAJOR_FLATS) all have NO
    DOCTYPE and `osmd.load()` parses them fine, so a DOCTYPE-less completed score loads. The pass-through path
    (no chord changed) returns the ORIGINAL bytes WITH their DOCTYPE intact; only a changed body loses it.
  - **No failure-sentinel collision.** The sentinel is the `else` branch (`body = FAILURE_SENTINEL`) and is NEVER
    run through the pass (the call sits inside `if result_path is not None:`, verified at worker.py:655-662 and
    locked by the JS source-guard). The pass only ADDS `<note><chord/>` siblings; it never writes
    `omr-status`/`failed`, so it cannot fabricate a sentinel match (`FAILURE_SENTINEL_RE` in src/omr.ts).
  - **Namespaced-document failure mode is a clean no-op** (verified): a defaulted-xmlns score makes
    `root.findall("part")` find nothing, so `len(parts) != 1` returns the input unchanged. No crash, no corruption.
  - **Conservative guards hold (verified by running the pass):** RH staff-1 notes are byte-identical in count and
    pitch; a measure whose LH slot is a rest gains nothing; a lone LH note whose `<duration>` does not match a
    detected-chord duration is NOT completed (rhythm guard works); existing pitches/durations are never mutated;
    `_complete_one` re-reads `list(measure)` and `children.index(lead)` by identity each call, so sequential
    insertions in one measure do not use stale indices. Any parse/shape failure returns the ORIGINAL bytes
    (try/except in `complete_lh_chords`), never raises into `process_job`, never emits a sentinel.
  - **NIT / known-risk (not blocking): ElementTree IS vulnerable to billion-laughs.** Confirmed a deeply-nested
    internal-entity payload OOM-kills the Python process (exit 137) inside `ET.fromstring`; expat's default
    expansion budget did not save it at depth ~14. This matters because the input is parsed by the always-on
    poller, and an OS OOM-kill is NOT catchable by the `try/except` (same class of risk as the #109 stitch OOM).
    Why it is NOT a blocker here: the pass parses ENGINE OUTPUT (oemer/homr MusicXML), not the raw upload. oemer
    emits the standard MusicXML PUBLIC/SYSTEM DOCTYPE with NO internal entity subset and does not echo
    user-controlled DTD entities into its output, so an attacker cannot get a malicious internal `<!ENTITY ...>`
    subset into the bytes the pass parses. The OOM vector requires an attacker-controlled internal entity subset,
    which the engine never produces. A namespaced or undefined-entity doc is a clean caught no-op (verified). If a
    future change ever feeds upload-derived or untrusted XML directly into this parser, swap to `defusedxml` or
    disable DTD/entity processing FIRST; leaving a one-line note here so that constraint is not rediscovered.
  - **Tests genuinely cover the contract (RED-GREEN spot-checked):** ran the 14 core Python assertions by hand
    (pytest is not installed in the shell python; boto3 stubbed at import like the existing suite) - pitch
    roundtrip, dominant triad-over-dyad + dyad fallback, the grand-staff fixture completing lones 3/4/5 to (0,4,7)
    with the original kept as lowest, measure-6 rest gains nothing, RH untouched (6 notes identical),
    single-staff + malformed passthrough - all 14 pass. The RH-untouched and no-LH-rest tests would fail if those
    guards were removed (they assert exact pitch lists and empty LH note lists). JS suite 308/308 green
    (no jsdom ERR_MODULE_NOT_FOUND this run), `npm run build` green. Left the diff untouched (no blocker to fix).

- **2026-05-31 - #113: additive LH chord-completion post-pass in `omr-worker/worker.py`, run on engine MusicXML before R2.**
  oemer reads the RH but collapses many LH block chords to single notes (icarus.pdf: 12 of 27 LH
  measures kept a chord, 4 triads, where the source has a triad almost every bar). New pure
  `complete_lh_chords(xml_bytes)` learns the dominant LH chord SHAPE oemer DID detect elsewhere and
  completes lone LH notes (at a chord-matching duration) to that shape, existing note kept as the lowest.
  - **Hook:** in `process_job`, INSIDE the `result_path is not None` (engine-success) branch, after
    reading the engine bytes and BEFORE `client.put_object`: `body = complete_lh_chords(body)`. NOT on
    the failure-sentinel else branch (a sentinel must never be mutated). R2 contract unchanged
    (`results/<jobId>.musicxml`, same content-type).
  - **Conservatism (the whole pass is wrapped in try/except and returns the ORIGINAL bytes on ANY
    failure, never raises into process_job, never emits a sentinel):** uses stdlib
    `xml.etree.ElementTree` (no new dep). Returns input unchanged when: not exactly one `<part>`, no
    `<staff>2</staff>` note anywhere (single-staff part), zero detected LH chords (nothing to learn from),
    or no usable dominant shape. Only ADDS `<chord/>` `<note>` siblings on staff 2; never alters an
    existing note's pitch/duration, never touches staff-1 (RH), never changes part/staff/measure
    structure, divisions, clefs, or time sigs.
  - **Dominant-shape heuristic (`_dominant_pattern`):** tally each detected LH chord-group's interval
    pattern as semitone offsets above its lowest note (root-position major triad = (0,4,7)). Pick the most
    common pattern of size >= 3 (a triad); fall back to the most common size-2 if no triad was detected.
    Ties broken deterministically by (count, len, pattern). Completion only fires on lone LH notes whose
    `<duration>` matches a duration seen on the detected chords (rhythm alignment guard), inserting the
    transposed `<chord/>` notes immediately after the lead in document order.
  - **Pitch helpers (the unit-testable core):** `pitch_to_semitone(step, alter, octave)` (C4 = 60, MIDI
    convention) and `semitone_to_pitch(semitone)` -> canonical SHARP spelling; octave from the absolute
    value so an added note sounds in the right register. Sharps are intentional (sounding pitch is what
    drives playback + the falling-notes/sheet sync; OSMD renders them fine).
  - **Chord grouping gotcha:** `_chord_groups` walks a measure's children in document order; a non-`<note>`
    child (`<backup>`, `<forward>`, `<attributes>`) resets the current group, so a `<backup>` between the
    RH voice and the LH voice correctly separates them. A chord sibling is a `<note>` that has BOTH a
    `<chord/>` child AND a live current group.
  - **Tests:** Python `omr-worker/test_worker.py` +12 (pitch roundtrip, dominant-pattern triad-over-dyad +
    dyad fallback, interval-pattern offsets, a 1-part/2-staff grand-staff fixture asserting lone LH notes
    become the dominant triad with the original as lowest, RH staff-1 notes byte-identical in count+pitch,
    a no-LH-note rest measure gains nothing, chord/triad counts rise, single-staff + multi-part + malformed
    + no-detected-chords all pass through unchanged). pytest 9 -> 21, all pass (Pillow + pytest installed
    in this worktree). JS source-guard `src/omr-worker.test.ts` +1 describe (#113): the function exists, is
    called before `put_object`, only on the engine-success branch (between `if result_path is not None:`
    and `body = FAILURE_SENTINEL`), keys off `LH_STAFF = "2"` + `find("chord")`, no em/en dash. JS suite
    303 -> 308, `npm run build` green. `npm test` first hit the known jsdom ERR_MODULE_NOT_FOUND; a plain
    `npm install` fixed it.
  - **CI gap / NEEDS LIVE QA:** repo CI is Node-only (no pytest gate); the JS source-guard is the
    CI-enforced net. CI does NOT run the OMR engine, so QA must re-scan icarus.pdf on `main` and confirm
    the #113 acceptance table: total notes > 109, RH (staff 1) exactly 66 (unchanged), LH triads 4 -> >= 10,
    LH chord-bearing measures 12 -> >= 18, still 1 part / 2 staves (G + F) / 27 measures, `#hand-mutes`
    visible, no measure that had zero LH notes gains a chord, scan wall-clock not materially worse.

- **2026-05-31 - #109 review fix (BLOCKING): the new all-pages vertical stitch was an unbounded-bitmap OOM vector; added page-count + total-area caps and armed Pillow's bomb guard.**
  Pre-merge review of `fix/omr-raster-preprocessing`. The rest of the diff was clean
  (all subprocess calls are list-form, no `shell=True`; only the UUID-validated jobId
  reaches keys/paths and pdftoppm reads a local temp file, never a shell string; the
  `(image_path, is_pdf)` tuple refactor reaches all call sites incl. the homr fallback;
  `--without-deskew` is gated to the PDF path only via `without_deskew=is_pdf`; page
  ordering is correct because pdftoppm zero-pads to a UNIFORM width within one run so
  `sorted()` == numeric; the R2 transport contract is byte-identical). The one real
  defect: `stitch_pages_vertical` allocated `Image.new("RGB", widest x sum_of_heights)`
  with NO bound. The upload Function caps inputs at 10 MB (`src/omr-server.ts
  MAX_UPLOAD_BYTES`), but a SPARSE vector PDF compresses so well that 10 MB holds
  hundreds of near-empty A4 pages; at 400 DPI each page is ~15.5 MP, so a crafted
  ~200-page PDF stitches to a multi-GP / multi-GB RGB bitmap on a box that ALSO runs the
  oemer PyTorch/onnx stack. The OS OOM-killer is not catchable by `poll_once`, so that
  kills the always-on poller (a single-upload DoS). Also `Image.new` is NOT subject to
  Pillow's decompression-bomb check (that only runs on decode), so Pillow gave zero
  protection here.
  - **Fix (worker.py):** new `MAX_STITCH_PAGES = 60` and `MAX_STITCH_PIXELS = 1_000_000_000`
    (~1 GP). `stitch_pages_vertical` rejects >60 pages BEFORE opening any image, and
    rejects total area > 1 GP AFTER measuring but BEFORE `Image.new` (so the giant canvas
    is never allocated); both raise `RuntimeError`, which `poll_once` already turns into a
    clean failure sentinel instead of a crash. The area check raises inside the `try`, so
    the `finally` still closes every opened page handle (no leak on the reject path). Also
    set `Image.MAX_IMAGE_PIXELS = MAX_STITCH_PIXELS` so a single crafted page can't
    bomb-decode on `Image.open` (the prior code never armed it). 1 GP is ~64x a real A4
    page, so legitimate multi-page scores are unaffected.
  - **Tests:** +3 pytest (too-many-pages rejects before any open, oversized-total-area
    rejects with a lowered cap, both `RuntimeError`) and +1 vitest source-guard locking
    the two caps, both enforcement sites, and the armed `MAX_IMAGE_PIXELS`. pytest 6 -> 9
    (Pillow IS installed in this worktree, all 9 pass), JS suite 302 -> 303, build green.
  - **Gotcha for the area test:** setting `Image.MAX_IMAGE_PIXELS` to the worker constant
    means a too-low monkeypatched cap also trips Pillow's bomb guard (fires at 2x cap) on
    `Image.open` BEFORE the area check. Pick a cap above a single page's pixels but below
    the multi-page total (cap=2000 for two 40x40 pages) to isolate the area `RuntimeError`.

- **2026-05-31 - #109: OMR worker rasterization tuned for clean vector PDFs (DPI 300 -> 400, all pages stitched, oemer deskew off on PDF path).**
  Concrete first child of spike #88. oemer has NO DPI/quality CLI knob (only `-o`,
  `--use-tf`, `--save-cache`, `-d/--without-deskew`), so the raster we hand it in
  `omr-worker/worker.py rasterize_if_pdf` is the only preprocessing lever we own.
  - **DPI 300 -> 400** via new `PDF_RASTER_DPI = 400` constant fed to `pdftoppm -r`.
    Conservative vs 600 for the Oracle Always Free ARM VM memory/time budget. Measured
    before/after on the icarus.pdf fixture (1-page A4 vector): 300 DPI rendered
    2480x3509 (8.7 MP), 400 DPI rendered 3306x4678 (15.5 MP), a 1.78x pixel-density
    gain for the ML engine. Did NOT run the full oemer engine here (heavy ML stack /
    onnxruntime not installed in the worktree); verified the rasterization step only.
  - **All pages, stitched.** Dropped the `-f 1 -l 1` flags so `pdftoppm` renders every
    page; new pure `stitch_pages_vertical(page_paths, dest)` stacks them top-to-bottom
    into one tall PNG (oemer reads ONE image). Chose vertical stitch over "pick best
    page" because it preserves ALL music and the engine scans staves top-to-bottom
    anyway. Single page short-circuits to a plain RGB copy (no compositing). Canvas
    width = widest page, narrower pages left-aligned on white. Uses Pillow, already an
    oemer runtime dep (no new dependency); imported LAZILY inside the function so the
    module stays importable for tests on a host without Pillow.
  - **Deskew off on the PDF path only.** `rasterize_if_pdf` now returns
    `(image_path, is_pdf)`; `process_job` passes `without_deskew=is_pdf` to `run_oemer`,
    which appends `--without-deskew` for the clean (already-orthogonal) vector raster.
    Scanned PNG/JPEG inputs keep deskew on. The argv build is the pure, testable
    `oemer_command(image_path, out_dir, without_deskew)`.
  - **R2 transport contract untouched:** result key, content-type, FAILURE_SENTINEL,
    poll loop all unchanged. `run_homr` fallback still gets the stitched image.
  - **Tests + CI gap:** repo CI (`.github/workflows/ci.yml`) is Node-only (typecheck +
    vitest + build); there is NO pytest gate. Added `omr-worker/test_worker.py` (7 pytest
    cases: DPI > 300 and <= 600, deskew gating both ways, single-page copy, multi-page
    vertical stack with pixel-offset + white-gutter asserts, document page order, empty
    rejection) for a local run (boto3 stubbed at import so it runs without the S3 deps;
    Pillow via `importorskip`). Since pytest is not in CI, also added
    `src/omr-worker.test.ts`: a vitest SOURCE-GUARD that reads `worker.py` as text and
    locks the #109 wiring (DPI constant > 300 and <= 600 passed to pdftoppm, old
    `-f 1 -l 1` gone, `stitch_pages_vertical` called on pages, `without_deskew=is_pdf`,
    R2 contract strings, no em/en dash). This is the same text-guard pattern as
    `toolbar.test.ts` and is what keeps a regression catchable in the green CI. JS suite
    296 -> 302, `npm run build` green. NOTE: `npm test` first hit the known `jsdom`
    ERR_MODULE_NOT_FOUND; a plain `npm install` fixed it.
  - **NEEDS LIVE QA:** CI does not run the OMR engine. QA must scan icarus.pdf on `main`
    and confirm the score still loads (and ideally that LH chord recovery improved).

- **2026-05-31 - #96: mobile file pickers never opened because the file inputs used `hidden` (display:none).**
  The three source buttons in `index.html` are `<label class="file-btn">` wrapping an icon, a label span,
  and a hidden `<input type="file">`. iOS Safari and in-app webviews refuse to forward a label tap to a
  `display:none` input, so the native picker never fired on phones (desktop was fine). Fix is markup + CSS only:
  - Replaced `hidden` with `class="visually-hidden"` on `#file-input`, `#scan-input`, `#audio-input` (accept
    values untouched). New `.visually-hidden` rule in `src/style.css` (1px absolute, clip, opacity 0) keeps the
    input in the layout/hit-testing tree so the implicit label -> input activation survives. Do NOT revert to
    `display:none` here.
  - Anchored it with `.file-btn { position: relative; }` so the 1px input does not affect layout.
  - Added `.file-btn .btn-icon, .file-btn .btn-label { pointer-events: none; }` so a tap on the icon/text still
    counts as a tap on the label (some mobile browsers only activate on the label element itself).
  - `src/main.ts` only listens to `change` and reads `.files`/`.value`/`.disabled`; nothing depended on the
    `hidden` attribute, so handlers are unchanged. No pure logic to unit-test (markup/CSS); `npm test` (296) and
    `npm run build` both green.
  - **NEEDS LIVE MOBILE QA:** CI cannot tap a native picker. QA must confirm on a real phone (iOS Safari first)
    that all three buttons open the picker and a loaded file flows through, and that desktop is visually/behaviorally
    unchanged.
  - NOTE: `npm test` again hit the known `jsdom` ERR_MODULE_NOT_FOUND; a plain `npm install` fixed it without
    touching `package-lock.json`.

- **2026-05-31 - #57: a lit (active) black key now shows its accidental name; resting/approaching black keys stay blank.**
  Issue: `drawKeyLabels` in `src/visualizer.ts` skipped black keys entirely (`if (key.black) continue;`), so a
  beginner who saw a falling "C#"/"Do#" got no cue on the physical black key. Fix is purely additive and does
  NOT touch white-key labels, the 11px legibility floor, or small-screen behavior.
  - **Split the render:** `drawKeyLabels` now keeps only the shared guards (`labelMode !== "off"`,
    `keyboardHeight >= KEY_LABEL_MIN_HEIGHT`) then calls two private passes: `drawWhiteKeyLabels` (unchanged
    behavior, including the `approaching.size === 0` early-out and the all-or-nothing white-width fit at 11px)
    and `drawBlackKeyLabels`. Moving the `approaching.size === 0` return INTO the white pass is the key point:
    a pressed black key must show its name even when nothing is in the look-ahead set, so the black pass gates
    on `active`, not `approaching`.
  - **Black pass:** labels a black key iff it is in `active` (sounding/pressed). Uses a smaller 9px font (white
    is 11px) because the black face is narrow, a 2px gutter (white uses 4px), and the same all-or-nothing width
    fit against the black-key width: if the widest black-key label for the mode would not fit at 9px, no
    black-key labels draw this pass (uniform > ragged). Solfege ("Do#","Reb") is wider than the 2-char letter
    spelling, so the widest is measured across the whole mode like the white row. Name is centered, seated near
    the bottom of the black face (`top + keyboardHeight * 0.62 - 4`), drawn in light "#f2ecf8" to read against
    the lit `noteColor(midi).activeBlackKey` fill. Spelling is `midiToLabel(key.midi, labelMode)` (sharp
    spelling, consistent with the rest of the keyboard; spelling is intentionally NOT threaded here).
  - **Pure logic extracted + tested:** new `keyLabelFits(widestLabelWidth, keyWidth, gutter)` in `src/piano.ts`
    (the all-or-nothing fit predicate, DOM-free). Both the white and black passes call it; the white path's old
    inline `widest + GUTTER > whiteWidth` check is now `!keyLabelFits(...)` (behavior identical). +5 tests in
    `src/piano.test.ts` (fits, exact boundary, overflow, non-positive key width, zero label width). Suite
    291 -> 296, build green.
  - **NEEDS LIVE QA:** this is canvas drawing, so CI cannot see it. QA must confirm in a browser that a pressed
    black key shows its name, the name is legible/centered/contrasts the lit hue, resting black keys stay blank,
    and white-key labels are visually unchanged.
  - NOTE: `npm test` again hit the known `jsdom` ERR_MODULE_NOT_FOUND; a plain `npm install` in the worktree
    fixed it without touching `package-lock.json`.

- **2026-05-31 - #64: `deriveDefaultSheetName` now rejects OSMD's "Untitled Score" placeholder so the file-name fallback runs.**
  When a MusicXML score has no embedded `<work-title>`/`<movement-title>`, OSMD reports the title as the
  non-empty placeholder string `Untitled Score`. The #44 logic treated any non-empty title as real, so
  loading `moonlight-sonata.musicxml` showed "Untitled Score" instead of "moonlight-sonata". Fix in
  `src/sheet-name.ts`: new exported `OSMD_PLACEHOLDER_TITLE = "Untitled Score"` and a private
  `isPlaceholderTitle` that compares the trimmed, lowercased candidate to it; the title branch now requires
  `fromTitle && !isPlaceholderTitle(fromTitle)`, so a placeholder falls through to the extension-stripped
  file name (already handles `.musicxml`/`.xml`/`.mxl` via the existing `\.[A-Za-z0-9]{1,8}$` strip) and
  finally `DEFAULT_SHEET_NAME`. A real embedded title still wins; an empty title still falls through; no
  file name still ends at "Untitled sheet". Tests: +6 in `src/sheet-name.test.ts` (placeholder -> stripped
  name for all three extensions, case/whitespace variants, placeholder + no file name -> default). Suite
  291 green, build green. NOTE: `npm test` first failed with `jsdom` ERR_MODULE_NOT_FOUND; a plain
  `npm install` in the worktree fixed it (the #90 jsdom devDep was not yet installed here).

- **2026-05-31 - #66 fix: `labelableFallingNotes` is now chord-aware (run boundary is a pitch SET per lane, not a single last-midi).**
  The #42 helper tracked one `lastMidiByLane: Map<lane, number>`, so polyphony broke two ways: a repeated
  identical chord (`[C,E]@0` then `[C,E]@1`) was not deduped (returned all-true), and the label of a note
  after a chord depended on which chord note happened to sort last. Fix in `src/piano.ts`
  (`labelableFallingNotes`): group the time-sorted notes into onsets (notes within `LABEL_TIME_EPSILON`),
  split each onset by lane, and compare each lane's onset pitch-SET (`prevSetByLane: Map<lane, Set<number>>`)
  against that lane's previous onset. A note is labeled iff its pitch is NOT in the lane's previous set (a
  run start); held/repeated voices carry over unlabeled. Order-independent by construction (it is set
  membership, never array position). Monophonic input is the one-pitch-per-onset special case, so all 7
  prior tests stay green unchanged. Added 4 tests (chord-all-labeled, repeated-chord dedup, partial-chord
  change labels only the new pitch, post-chord note same under both chord array orders). Suite 284 -> 288,
  build green. Pure helper, no canvas/visualizer change, so no live QA beyond the existing label render.

- **2026-05-31 - #56/#58 SHIPPED: labels now respect the sheet's printed accidentals (show flats), with always-sharp only as the no-notation fallback.**
  Closes the #40 spike's high-value slice. The fix threads each note's printed spelling alongside `midi`
  through BOTH extraction points and into a spelling-aware label function; MIDI still drives color, octave,
  and geometry (only the printed NAME changed, per the scope discipline).
  - **Data model:** new `NoteSpelling { letter: NoteLetter; alter: number }` in `src/piano.ts` (alter is the
    MusicXML `<alter>` semitone shift: +1 sharp, -1 flat, +-2 doubles, 0 natural). Added as an optional
    `spelling?` field on `VisNote` (`src/visualizer.ts`) and `NotePosition` (`src/sheet-labels.ts`). Audio
    scores omit it, so they fall back unchanged.
  - **Label fns:** `midiToLabel(midi, mode, spelling?)` and `midiToBarLabel(midi, mode, spelling?)` now take an
    optional spelling. When present they render `letter`+accidental (letters) or fixed-Do syllable+accidental
    (solfege) via `LETTER_TO_SOLFEGE` + `accidentalSuffix` (#58: "Reb","Mib","Solb","Lab","Sib", and "##"/"bb"
    for doubles, clamped at double). When absent they use the historical always-sharp `LETTER_CLASSES` /
    `SOLFEGE_CLASSES`. Octave is ALWAYS from MIDI even with a spelling (a Cb4/B3 enharmonic keeps the sounding
    octave; acceptable for the common case, no separate octave bookkeeping).
  - **OSMD extraction (`src/score.ts`):** new exported `readSpelling(pitch)` maps `Pitch.FundamentalNote`
    (NoteEnum C=0,D=2,E=4,F=5,G=7,A=9,B=11) -> letter and `Pitch.Accidental` (AccidentalEnum SHARP=0,FLAT=1,
    NONE=2,NATURAL=3,DOUBLESHARP=4,DOUBLEFLAT=5,...) -> alter. Reads `note.TransposedPitch ?? note.Pitch`
    because `note.halfTone` (the MIDI source) is the TRANSPOSED value, so the spelling must come from the
    transposed pitch to agree. `sheet-overlay.ts` imports the same `readSpelling` (single source of truth) and
    reads `source.TransposedPitch ?? source.Pitch` off the GraphicalNote's `sourceNote`.
  - **OSMD API gotchas (verified against a real jsdom parse):** (1) AccidentalEnum is NOT a simple
    sharp=+1/flat=-1 numeric; the .d.ts explicitly warns "do not use the number values for calculation",
    so map via an explicit switch, never arithmetic on the enum. (2) `FundamentalNote` is a NoteEnum whose
    values are the diatonic SEMITONE offsets (D=2, not 1), not a 0..6 step index, so map by the enum members,
    not by `value`. (3) Microtonal/exotic accidentals (quarter-tones, slash, sori/koron) have no plain-letter
    name or piano key, so `readSpelling` returns `undefined` for them and the note falls back to the sharp
    default rather than inventing a spelling.
  - **Tests (+12, suite 272 -> 284):** `piano.test.ts` covers the pure mapping (flat letter + flat solfege for
    the Db-major degrees, always-sharp fallback with no spelling, naturals, sharps, double accidentals, off
    mode). `score.test.ts` adds a REAL-OSMD-parse test (the strong one): a `<alter>-1` Db-major fixture loaded
    through `osmd.load()`, walked via `SourceMeasures[].VerticalSourceStaffEntryContainers[].StaffEntries[].
    VoiceEntries[].Notes[]`, asserting `readSpelling` returns flats/natural/sharp and that they thread into
    "Db"/"Reb" labels. `sheet-labels.test.ts` asserts the overlay honors the flat spelling and falls back
    without one. Build + 284 tests green.
  - **Post-merge QA gate:** loading an actual flat-key MusicXML and reading the on-bar + overlay names in a
    real browser is not reproducible from a static preview without a fixture; the real-parse test pins the
    load-bearing OSMD extraction, the visual confirm is the live QA pass.

- **2026-05-31 - #93 scan-cancel left a prior score's controls stuck disabled until the in-flight /api/omr settled.**
  Follow-up to #86. `cancelScanOverlay` only called `setBusyUI(false)` + `restoreSheetName()` in its
  `if (wasAudio)` branch, so the SCAN path's Play/Export/seek/step stayed disabled (and the toolbar kept
  reading "Scanning sheet...") until `scanSheet`'s `finally` ran, which only happens after `submitOmr`'s
  fetch resolves and `pollOmrResult` next reads `isCancelledRequested()` (the flag is only checked at the
  TOP of the poll loop, i.e. after the in-flight request round-trips). With a slow OMR backend that window
  equals the full submit+poll latency. The audio path was already correct because it tore down synchronously.
  Fix in `src/main.ts`:
  - `cancelScanOverlay` now calls `setBusyUI(false)` + `restoreSheetName()` UNCONDITIONALLY (dropped the
    `wasAudio` special-casing). `setBusyUI(false)`'s not-busy branch re-enables via
    `controlsEnabledForScore(!!score)` (the #86 helper) and `restoreSheetName()` clears the status. Removed
    the now-write-only `overlayKind` module var (TS6133) and its assignments in show/hideScanOverlay;
    `ScanOverlayKind` stays only as `showScanOverlay`'s param type.
  - `scanSheet` now captures `const generation = ++jobGeneration` at the top and gates its `finally` on
    `generation === jobGeneration` (mirrors `transcribeAudio`), so a late settle of an abandoned scan can't
    stomp a newer job's overlay/controls. Idempotency note: when no restart happened the SAME job's gen-gated
    finally re-runs setBusyUI(false)/hideScanOverlay/(restoreSheetName via the catch) after cancel already
    did them; all three are idempotent (restoreSheetName is a no-op without a score and just sets hidden
    flags + re-renders), so the repeat is harmless. The in-flight OMR poll still rejects later with
    OMR_CANCELLED, swallowed by the existing `isCancelled(err)` catch.
  - Tests: extended `src/cancel-controls.test.ts` with a #93 describe block (scan-cancel re-enables a
    still-loaded score's controls synchronously; stays disabled with no score) using the same shared
    `controlsEnabledForScore` predicate model (booting all of main.ts under jsdom is impractical, same as
    #86). Source guards in `src/toolbar.test.ts` lock the wiring: cancelScanOverlay contains
    setBusyUI(false)+restoreSheetName() and NO `wasAudio`, and scanSheet captures `const generation =
    ++jobGeneration` + gates its finally on `generation === jobGeneration`. Suite 272 green, build green.
    Live scan-cancel-with-prior-score + cancel-then-restart in a real browser is the post-merge QA gate.

- **2026-05-31 - #86 cancel-path bug fixes: a cancelled audio job no longer loads its score, and Cancel re-enables a still-loaded score's controls.**
  Code review of the #86 overlay found two blocking defects in the cancel path; both fixed in
  `src/main.ts` with pure-helper-backed regression tests.
  - **BLOCKING 1 (cancelled/superseded audio job still loaded its score):** `loadAudioFile` calls
    `loadNotes` INTERNALLY, so the old `if (cancelRequested) return` in `transcribeAudio` ran only
    AFTER the load had already happened. Worse, `showScanOverlay` resets `cancelRequested=false` when
    a new job starts, so a cancel-then-restart let job A's late result load under job B's overlay.
    Fix: `loadAudioFile(file, shouldApply: () => boolean)` checks the guard immediately before
    `loadNotes` (and before each progress narration). `transcribeAudio` captures its `generation` and
    passes `() => shouldApplyResult(generation, jobGeneration, cancelRequested)`. New pure
    `shouldApplyResult(generation, currentGeneration, cancelled)` in `src/scan-overlay.ts` returns
    `generation === currentGeneration && !cancelled`. The GENERATION check (not just cancelRequested,
    which gets reset per job) is what drops job A under job B. The existing generation-guarded
    `finally` already prevented a stale teardown; this adds the matching load guard.
  - **BLOCKING 2 (cancel left a prior score's Play/Export/seek/step disabled):** `setBusyUI(active)`
    disabled play/export/transport on `active=true` but its not-busy branch never re-enabled them;
    only a successful `loadNotes` did, which never runs on the cancel/abandon path. Fix: the not-busy
    branch now sets `enabled = controlsEnabledForScore(!!score)` (new pure helper in `src/playback.ts`,
    currently just `scoreLoaded`) and writes `playBtn/exportBtn.disabled = !enabled` +
    `setTransportControlsEnabled(enabled)`. `exportVideo`'s finally dropped its now-redundant manual
    re-enable lines (setBusyUI(false) handles it), so there is one source of truth.
  - **Tests:** `shouldApplyResult` 4 cases (normal applies; same-gen+cancelled drops; restart bumps
    gen so job A drops; superseded+cancelled drops) and `controlsEnabledForScore` 2 cases in the pure
    suites. A new jsdom `src/cancel-controls.test.ts` asserts the real disabled-flag behavior on actual
    elements (booting all of main.ts under jsdom pulls in Tone/OSMD/canvas/sampler/rAF, so it mirrors
    setBusyUI's not-busy branch against the shared predicate). Source guards in `src/toolbar.test.ts`
    lock the actual main.ts wiring for both fixes (the `shouldApply` param, the `!shouldApply() return`,
    the `shouldApplyResult(generation, jobGeneration, cancelRequested)` call, and the setBusyUI else
    branch driving `controlsEnabledForScore(!!score)`). Suite 268 green, `npm run build` green. Live
    cancel-with-prior-score + cancel-then-restart in a real browser is the post-merge QA gate.

- **2026-05-31 - Scan/transcribe loading overlay SHIPPED (#86): a blocking stage overlay + a client-side Cancel that abandons the wait, never aborts the server job.**
  Replaced the too-quiet `#track-status` line with a full-stage overlay per the Designer spec (design.md top
  section). One `#scan-overlay` node in `index.html` AFTER `#stage` (role=dialog, aria-modal, aria-busy,
  labelledby/describedby), default `hidden`. Pieces and gotchas:
  - **Overlay covers the stage, NOT the toolbar.** The spec markup is one node inside `#app` with
    `position:absolute; inset:0; z-index:5`. `#app` got `position:relative` (the containing block). With
    `inset:0` it would also cover the toolbar, so `.topbar` got `position:relative; z-index:6` to stack
    ABOVE the overlay; its near-opaque `--bar-surface` (0.92) keeps it clearly visible while the overlay
    blurs/dims only the sheet+stage region below it. This is the spec-faithful way to get "toolbar visible,
    stage covered" without extra wrapper DOM.
  - **Cancel = client-side abandon (the OMR job runs server-side and cannot truly abort).** `pollOmrResult`
    (`src/omr.ts`) gained an injectable `isCancelledRequested?: () => boolean` checked before each request
    AND before each sleep; when true it rejects with `new Error(OMR_CANCELLED)`. New exports `OMR_CANCELLED`
    + `isCancelled(err)` make the sentinel distinguishable from a real failure. `scanSheet`'s catch calls
    `isCancelled(err)` and, if true, just `restoreSheetName()` and returns: NO alert, NO "Scan failed"
    status. The `finally` always runs `setBusyUI(false)` + `hideScanOverlay()`.
  - **Audio path has no abortable poll**, so Cancel for the audio kind tears down the UI immediately
    (`cancelScanOverlay` sets the flag, hides the overlay, `setBusyUI(false)`, `restoreSheetName`) and the
    in-flight `loadAudioFile` result is dropped on completion via a `cancelRequested` guard. A
    `jobGeneration` counter guards `transcribeAudio`'s finally so a cancelled-then-restarted job's late
    finally cannot close the NEWER overlay (the transcription itself keeps running in the background).
  - **A11y:** focus moves to Cancel on open, the prior `document.activeElement` is saved and restored on
    close. Minimal focus trap on the overlay node: Tab/Shift+Tab `preventDefault` + refocus Cancel (the only
    control); Escape routes through `cancelScanOverlay`. The global Space/arrow handler already bails on
    `busy`, so it does not fight the overlay. Reduced-motion `@media` swaps the spin/fade for a gentle
    opacity pulse.
  - **Pure helper + tests:** `src/scan-overlay.ts` `scanOverlayTitle(kind)` (kind->heading) is the only
    testable logic extracted (DOM show/hide stays in main.ts); 3 unit tests incl. a no-dash guard. `omr.test.ts`
    gained 3 cancel tests (cancel-before-first-poll bails with zero fetches, cancel-mid-poll bails before the
    sleep, and `isCancelled` separates the sentinel from real "Scan failed"/"Could not recognize" errors).
    `toolbar.test.ts` gained an #86 markup/CSS guard block (ids, dialog attrs, overlay-after-stage,
    body-extra hide, z-index 5 vs topbar 6, reduced-motion, Cancel/sentinel wiring in main.ts, no-dash).
    Suite 258 green, `npm run build` green. Live in-browser pass (real OMR/audio job + Cancel + Escape +
    focus restore + reduced-motion) is the post-merge QA gate.

- **2026-05-31 - #87 fix-forward (#90): readClefDeclarations dropped EVERY clef on a real collapsed single-staff parse, so the controls still stayed hidden in prod. Two OSMD-extraction gotchas + the first real-parse test.**
  The #87 timeline helpers were correct, but `readClefDeclarations` (the OSMD extraction that feeds them)
  collected ZERO declarations for a single-staff treble->bass score, so `buildStaffClefTimeline` was empty
  and every note resolved to `handFromClefInEffect(undefined) === "unknown"`. CI was green because
  `piano.test.ts`/`playback.test.ts` fed hand-built `ClefDeclaration[]` arrays and never ran the extraction.
  Two compounding OSMD 1.9.9 gotchas (verified by instrumenting a live parse, per #90):
  - **`ParentStaff` is `undefined` on the clef-carrying instruction staff entries of a SINGLE-STAFF
    instrument**, even though the staff has `idInMusicSheet === 0`. The `staffId == null` guard (added for
    the multi-instrument #82/#83 case) therefore discarded the treble AND bass clef. Fix: when an entry has
    no `ParentStaff` AND the whole sheet is one instrument with one staff, attribute the clef to that lone
    staff's `idInMusicSheet` (`sheet.Instruments[0].Staves[0].idInMusicSheet`). Do NOT guess for
    multi-staff/multi-instrument scores; keep the guard there so #73/#82/#36 stay correct.
  - **A mid-piece clef change lives in `LastInstructionsStaffEntries` of the PRECEDING measure**, not
    `FirstInstructionsStaffEntries` of the new measure. The bass clef showed up as `{measure:0, where:last}`.
    `readClefDeclarations` only read the First bucket, so it was missed even once ParentStaff was handled.
    Fix: read BOTH buckets; a `last`-bucket clef is attributed to `measureIndex + 1` (it applies from the
    next measure). To order ties, `ClefDeclaration` gained `source?: "first" | "last"` and
    `buildStaffClefTimeline` lets a `first`-source clef at a measure win over a `last`-source clef carried to
    that same measure (a measure opens with the clef printed at its head). Order-independent (the tie-break
    is by source, not push order). A missing `source` counts as "first" so hand-built arrays keep
    last-write-wins.
  - **`readClefDeclarations(sheet: MusicSheet)` is now EXPORTED and takes the Sheet** (was private, took the
    osmd). `extractScore` calls `readClefDeclarations(osmd.Sheet)`.
  - **First real-OSMD-parse test (`src/score.test.ts`, `// @vitest-environment jsdom`).** This is the gap
    that let the bug ship: there was no test exercising the extraction against a real parse. Added `jsdom`
    (devDep) so a small MusicXML string loads through a real `OpenSheetMusicDisplay`. CANNOT run the full
    `extractScore`: `osmd.render()` drives VexFlow which needs a real Canvas2D (`measureText`/`font`) jsdom
    lacks (throws "Cannot set properties of null (setting 'font')"), and the cursor iterator only exists
    after render. But `osmd.load()` populates the Sheet model WITHOUT rendering, so the test calls
    `readClefDeclarations(osmd.Sheet)` (the exact broken code) and composes the pure helpers
    (`buildStaffClefTimeline` -> `handFromClefInEffect`, `buildStaffClefMap` -> `handFromStaff`) to assert the
    user-visible "both hands" outcome. Stub `HTMLCanvasElement.prototype.getContext = () => null` in
    `beforeAll` to silence jsdom's noisy "Not implemented: getContext" (the parse path does not need a real
    canvas). RED-GREEN VERIFIED: with the old extraction body the two single-staff cases FAIL (collect 0
    decls) and the grand-staff guard still passes; with the fix all 3 pass. Suite 242 green, build green.
  - **Future: if the cursor/iterator path ever needs testing**, you'd need a Canvas2D polyfill (the `canvas`
    npm package or a measureText stub) so `osmd.render()` succeeds; not worth it for this bug since the break
    was entirely in the Sheet-model extraction.

- **2026-05-31 - Hand tagging now branches on staff count: a single COLLAPSED staff splits by the clef IN EFFECT, a real grand staff keeps first-clef-per-staff (#87).**
  Scanning a piano PDF (icarus.pdf, "Andante") makes the OMR engine flatten the grand staff onto ONE
  staff that switches clef mid-piece (treble, then bass at ~measure 9). The old `readStaffClefs` recorded
  only the FIRST clef per staff id (`buildStaffClefMap`), so every note on that one staff (including the
  bass section) tagged "right", `hasBothHands` was false, and `handMutes.hidden` stayed true: the per-hand
  controls never appeared. Fix is CONDITIONAL on the note's instrument staff count, because mid-staff clef
  changes mean opposite things in the two cases:
  - **Multi-staff instrument (`staves.length > 1`)**: UNCHANGED. Still `handFromStaff(buildStaffClefMap...)`
    (first clef per staff, position fallback for C/percussion). A transient clef change on the RH staff
    must NOT move those notes to the LH (this is the #73/#82/#36 invariant; do not regress it).
  - **Single-staff instrument (`staves.length === 1`)**: NEW. Tag each note by the clef in effect at its
    measure via `buildStaffClefTimeline` (carries the previous clef forward across measures that don't
    redeclare one) + `handFromClefInEffect`. A collapsed grand staff now splits into both hands. A stable
    single-staff part (music21 fragments, #70) is unaffected because clef-in-effect == its first clef.
  - **OSMD API used:** `score.ts` reads `it.CurrentMeasureIndex` off the cloned cursor iterator each step
    (public getter on `MusicPartManagerIterator`, preserved across `.clone()`) and looks up the timeline at
    that measure. `readClefDeclarations` collects `{staffId, measureIndex, clef}` once; both lookups
    (`buildStaffClefMap` for multi, `buildStaffClefTimeline` for single) are built from that one pass.
  - **Tests:** the OSMD iterator is still not jsdom-mockable, so coverage lives on the new pure helpers
    in `piano.ts` (`buildStaffClefTimeline` carry-forward / per-staff independence / undefined-before-first,
    `handFromClefInEffect` treble->right, bass->left, undefined/other->unknown) plus two
    `playback.test.ts` integration checks that compose timeline -> handFromClefInEffect -> `hasBothHands`:
    a treble->bass single staff yields BOTH hands (true), a stable treble single staff stays one (false).
    Suite 237 green, `npm run build` green. Live in-browser pass with a real icarus.pdf scan is the
    post-merge QA gate (no OMR/PDF fixture in unit tests).

- **2026-05-30 - Hand tagging is now CLEF-first so the per-hand controls also appear when the piano is two separate single-staff parts (not just a one-instrument grand staff).**
  Reported as "controls show on localhost but not in production". It was NOT a deploy gap: the prod
  bundle matched `main` byte-for-byte (same hash). The two screenshots simply loaded DIFFERENT files,
  a clean grand-staff `twohand` test vs a `Music21 Fragment`. Root cause: `extractScore` in `score.ts`
  only tagged hands when ONE instrument had `staves.length >= 2`. A music21 fragment exports the piano
  as TWO separate `<part>`s (treble part + bass part), each a single-staff instrument, so every note
  fell through to `hand="unknown"`, `hasBothHands` was false, and `#hand-mutes` stayed hidden. Fix:
  new pure `handFromStaff(clef, staffIndexInInstrument, staffCount)` in `piano.ts` that resolves hand
  from the CLEF first (treble=>right, bass=>left), which works for both packagings, and only falls back
  to staff position (multi-staff instrument) when the clef has no hand convention (C/percussion).
  `score.ts` calls it for every note. Verified end to end in the browser: a two-single-staff-part file
  now shows "Right hand / Left hand / Balance"; a single treble part keeps them hidden. Unit-tested via
  `handFromStaff` (the OSMD-dependent `extractScore` itself stays untested, hence the pure helper).
  **Gotcha that cost time:** the dev server on :5173 was a DIFFERENT worktree's process, so HMR never
  reflected this branch's edit; ran this worktree's own `vite` on :5199 to verify the real code.

- **2026-05-30 - Audio-derived scores now split into hands by PITCH so the per-hand controls are reachable (#70 follow-up, PR #80).**
  Symptom: the per-hand mute toggles and the Balance slider never appeared for audio imports. Root
  cause: `transcribeAudioFile` -> `noteEventsToVisNotes` left every note `hand="unknown"`, so
  `hasBothHands(notes)` was always false and `main.ts` kept `#hand-mutes` hidden. Fix: `handFromPitch(midi)`
  in `piano.ts` (`HAND_SPLIT_MIDI = 60`; >= middle C = right, below = left) applied in the pure
  `noteEventsToVisNotes` converter, so it is unit-tested and the Web Audio glue stays untouched. It is a
  heuristic, not ground truth (a left hand can climb above middle C), but it exposes the controls for the
  common melody-over-bass clip; a single-register clip lands on one hand so `hasBothHands` stays false and
  the controls correctly stay hidden. Side effect (intended): the #36 hand-color caps and #54 mute-ghosting
  now also activate for audio scores, keeping the controls and their on-screen feedback coherent. MusicXML
  clef-based tagging in `score.ts` is unchanged. Follow-up idea if hand accuracy ever matters: a per-onset
  split (gap in a chord's pitch spread, or hysteresis around 60) instead of a fixed boundary.

- **2026-05-30 - Sheet rename now updates the OSMD-rendered title, not just the toolbar/tab (#44 follow-up, PR #79).**
  `commitNameEdit` calls `updateSheetTitle(name)`: writes `osmd.Sheet.TitleString = name` (OSMD's setter
  rebuilds the title Label), then `osmd.render()`, then restores the cursor to the current playhead via the
  existing `resyncCursor(scoreTime)` and redraws the note-name overlay (`renderSheetLabels`) the re-render
  clears. No-op when `!hasSheet` (audio scores) or when the title already matches (avoids a needless
  re-render). The sync invariant holds: `scoreTime = transport.seconds * tempoRate` is captured before the
  render and fed back through the same helper `seekScoreTime` uses, so the cursor and falling notes still
  read one clock.

- **2026-05-30 - Falling-bar glow is now ONLY the keybed-contact note, not every in-flight bar (#27/#38, PR #78).**
  Set the body fill's `shadowBlur` to 0 so a falling bar is a clean colored bar; the sole remaining glow is
  the #27 contact stroke that fires only for the bar touching the keyboard (`isActive && !muted &&
  bottom >= keyboardTop - 10`, shadowBlur 22). In-flight notes stay calm and the highlight reads as the
  single contact moment.

- **2026-05-30 - Feature-loss audit after the #76-#80 merge churn: NO regressions.** Cross-checked all
  closed feature issues (#14 tempo, #36/#47 hand color, #37/#49/#54/#60/#65 mutes, #42/#43 labeling,
  #44 rename, #70 balance, #76 visibility) against `origin/main` code AND the deployed bundle
  (https://piano-helper.pages.dev): every feature's code is present, wired, and shipped in the JS. The
  deployed `index.html` id-set is identical to `origin/main`. Static button/aria text lives in `index.html`
  (markup, a Vite vanilla app), so those strings count 0 in the JS bundle but appear in the served HTML;
  that is expected, not a regression.

- **2026-05-30 - Hand tagging now keys off the CLEF, not the staff array index (fixes "muting right hand still plays it").**
  Root cause: `extractScore` tagged hands with `handFromStaffIndex(staves.indexOf(staff), len)`,
  assuming staff index 0 = treble = right. But a MusicXML file can declare its staves bass-first
  (bass on staff 1 / index 0, treble on staff 2 / index 1) - some music21 exports do this. That
  inverted the hands: the bass got "right", the treble melody got "left". Muting "right" then
  silenced the bass while the melody kept sounding, which is exactly what the user heard. The audio
  mute logic itself (Part callback `note.hand === "right" && handMuted.right` -> skip trigger) was
  always correct; the data feeding it was wrong. Verified end-to-end: Tone.Part DOES pass the value
  object (with `hand`) to the callback, and the skip works - the bug was purely the hand label.
  - **Fix:** new pure helper `handFromClef("treble"|"bass"|"other")` in `piano.ts` (treble->right,
    bass->left, other->null). `score.ts` `readStaffClefs(osmd)` reads each staff's opening clef from
    `osmd.Sheet.SourceMeasures[].FirstInstructionsStaffEntries[staffIndex].Instructions` (find the
    `ClefInstruction`, map `ClefType` via `ClefEnum.G`/`ClefEnum.F`), keyed by `staff.idInMusicSheet`.
    Per note: only split when the instrument has >=2 staves (else "unknown", unchanged), prefer the
    clef, fall back to `handFromStaffIndex` for C/percussion clefs. `ClefInstruction`/`ClefEnum` are
    re-exported from the `opensheetmusicdisplay` package root.
  - **OSMD gotchas learned while chasing this:** two separate `<part>` elements (even same name, even
    in a `<part-group>` brace) become two single-staff instruments -> all notes "unknown" -> mute
    buttons hidden. Hands split into right/left ONLY for a single instrument with `<staves>2</staves>`.
    Notes that separate hands by `<voice>` without explicit `<staff>` all collapse onto staff 1.

- **2026-05-30 - Code review of #67 (falling-note label legibility, PR #69): APPROVE.** Two-pole
  contrast-aware glyph ink + width-only overflow for narrow desktop bars. Verified independently:
  - **Luminance table is correct and octave-invariant.** `PITCH_CLASS_GLYPH_DARK` in `piano.ts`
    mirrors `buildNoteColors` exactly (whiteFill 85/62, blackFill 70/50, activeFill 95/72). Recomputed
    by hand: white-fill luminance >= 0.6 for Mi(64)/Fa(65)/Fa#(66)/Sol(67)/Sol#(68)/La(69) -> dark ink;
    Do(60)=0.487 and Si(71)=0.390 -> light ink. Matches the reported washed-out hues. `activeL > whiteL`
    for every pc, so the "active never makes a bar less likely to take dark ink" monotonicity test holds
    (Do flips to dark only when active at L 0.610, harmless). Hue is pitch-class-only, so octave-invariant.
  - **Overflow math is bounded.** Brute-forced w 4..80, h 2..100, chars 1..4: zero width-budget
    violations (rendered name always <= `barWidth*(1+2*0.9)`), font never exceeds `floor(barHeight*0.55)`
    (no vertical overflow, no detached pill, #39 intent preserved), shown font always >= MIN_OVERFLOW_PX 7.
    A 10px/60h/2char bar shows "Do" at full 12px spilling ~4px/side; a 10px/12h bar still omits (height
    floor binds). Existing in-bounds callers default `allowOverflow=false` and are unchanged.
  - **No hot-loop cost.** `barGlyphIsDark` reads the precomputed boolean table; `hslToRgb`/`rgbLuminance`/
    `fillIsLight` run once at module load. The only `measureText` in the file is the pre-existing #33
    keyboard-face label path (line 391), unrelated to falling notes. Paint loop adds one `strokeText` per
    already-fitted label.
  - **No neighbor regressions.** #36 cap, #27 contact glow (`isActive && !muted && bottom>=...`), #54
    ghosting (alpha threaded into the label record + globalAlpha reset discipline), #42/#43 gate
    (`labelMode!=="off" && labelableNote[i]!==false`) all intact. Minor non-blocking note: a MUTED active
    bar draws body with `activeFill` but computes glyph ink with `active:false` (resting). Cosmetic only;
    the bar is at alpha 0.3 and `activeL>whiteL` means polarity never flips the wrong way on a faded
    element. Build green, 199 tests pass, diff em/en-dash clean. Live in-browser pass deferred to the
    post-merge QA gate (preview server still bound to a different worktree).

- **2026-05-30 - Unified note-name labeling SHIPPED (#42 + #43): two pure helpers in `piano.ts`,
  one shared look-ahead, both label systems derive from one model.** One branch
  (`fix/note-name-labeling`), one PR, because the falling-bar names and the keyboard-key names are
  the same "what gets a name, when" question and would conflict if split. No new deps.
  - **#42 root cause (recorded so nobody re-chases it):** the apparent "left hand labels every
    note, right hand only the leading note" was NOT a per-hand code path. The falling-bar label
    gate is purely `fitBarLabel(w, barHeight, chars)` and font size derives from bar HEIGHT
    (`duration * pps`). Right-hand (treble) notes are usually short -> small bar -> name omitted by
    the #39 floor; left-hand (bass) notes are usually long/sustained -> tall bar -> always labeled.
    Hand correlation was incidental (duration-correlated), not intended. Fix = make the decision
    identity-based + hand-agnostic; `fitBarLabel` stays only as a per-frame legibility guard.
  - **Helper 1: `labelableFallingNotes(notes): boolean[]`** (pure, index-aligned to the input
    array). Labels the FIRST note of each run of consecutive same-`midi` notes per HAND lane
    (left/right/unknown dedupe independently via a `Map<lane, lastMidi>`), re-labels on a pitch
    change. Sorts indices BY TIME internally (so "consecutive" means consecutive in playback) then
    maps the decision back to original indices, so an out-of-time-order `notes` array still labels
    the time-first note of a run. `extractScore` emits notes in chronological order and
    `transcribe` sorts by time, so in practice array order == time order, but the helper does not
    rely on it.
  - **Helper 2: `approachingKeyMidis(notes, currentTime, lookAhead = KEY_LABEL_LOOK_AHEAD): Set<number>`**
    (pure). Returns the midis whose key should be labeled now: any note with
    `currentTime in [time - lookAhead - eps, time + duration + eps]` (entered the top of the visible
    lane through end of sounding). Empty set when nothing is approaching. `KEY_LABEL_LOOK_AHEAD = 4`
    is exported and the visualizer's `LOOK_AHEAD` now ALIASES it, so the keyboard-label window and
    the falling-note visible window can never drift apart (a key shows its name exactly while its
    bar is visible).
  - **Visualizer wiring (`src/visualizer.ts`):** `setNotes` precomputes `labelableNote: boolean[]`
    once (not per frame). The falling-note loop switched to an index loop and gates the label block
    on `this.labelableNote[i] !== false` (the `!== false` is a deliberate safe default if the array
    were ever short). `render` computes `approaching = approachingKeyMidis(...)` once per frame
    (O(n), same budget as the existing `activeMidis`) and threads it through `drawKeyboard` ->
    `drawKeyLabels`, which now `continue`s past any white key not in the approaching set and
    early-returns when the set is empty (saving the measureText fit loop in quiet moments). Black
    keys stay unlabeled as before. The #39 fit, #33 off-window dim, #54 muted ghosting, #36 stripe,
    #27 contact glow are all untouched.
  - **Tests: 14 new in `src/piano.test.ts`** (`labelableFallingNotes` 7, `approachingKeyMidis` 7):
    repeated-run dedupe, re-label on pitch change, BOTH-HANDS-CONSISTENCY (identical left vs right
    runs label identically), per-hand independent dedupe, time-order-not-array-order, unknown lane,
    empty; and for keys: nothing-in-window -> empty, enters/leaves window boundary, sounding note
    stays until release, full chord labeled, custom window, default == 4 == lane. Canvas paint stays
    untested (the decision is fully in the two pure helpers). Full suite 165 green, `npm run build`
    green.
  - **Code review (self, tech-lead, high effort):** no findings. Verified no broken call sites
    (helpers are new exports; `drawKeyboard`/`drawKeyLabels` are private), the dedupe lands on the
    time-first run note, and the muted/ghost + off-window-clamp interactions are unchanged.
  - **Verification caveat: could NOT verify the UI live from this agent worktree** (the preview MCP
    server is bound to a different worktree, same limit as #36/#37/#38/#39). Covered by the 14 unit
    tests + build + code reasoning. This is exactly the label-on-screen class that has shipped
    broken-but-green before, so the post-merge live QA gate on `main` is required.

- **2026-05-30 - Editable sheet name SHIPPED (#44): pure naming logic + inline toolbar edit.**
  The user can rename the loaded piece inline in the right-trailing `#track-name` toolbar slot.
  - **Pure module `src/sheet-name.ts` (16 unit tests):** `deriveDefaultSheetName(fileName,
    musicXmlTitle)` (title wins, else file name with extension stripped, else "Untitled sheet"),
    `normalizeSheetName` (collapse whitespace, cap at `MAX_SHEET_NAME_LENGTH` 80, re-trim), and
    `resolveEditedSheetName(edited, current)` (empty edit reverts to current, never blanks). All
    DOM-free so they test without OSMD/jsdom, same pattern as recorder.ts/playback.ts. Gotcha:
    the extension-strip regex is `\.[A-Za-z0-9]{1,8}$` (8 not 5, so ".musicxml" strips) and only
    a final dot+alnum, so a name like "J.S. Bach" (tail "Bach" has no preceding dot) is left alone.
  - **DOM wiring in `src/main.ts`:** the old single `#track-name` span (which packed "name (N
    notes)") was split into `#sheet-name` (a `<button>`, click-to-edit), a hidden `#sheet-name-input`,
    a `#sheet-note-count` span, and a `#track-status` span for transient messages, all inside a
    `#track-name` flex `<div>` that KEEPS `margin-left:auto` so #46's slot reservation and #33's
    `.track-name { display:none }` mobile hide still apply unchanged. Module state `sheetName` /
    `noteCount` / `nameEditing`; `setSheetName` also sets `document.title` and the export filename
    now uses `sheetName` (reusing the title for #15 export per the issue). `showStatus` /
    `restoreSheetName` swap the slot between the editable name and a status message; all the old
    `trackName.textContent = "..."` status writes (scan/transcribe/record/error) route through them.
  - **Edit lifecycle gotcha:** Enter and blur both commit, Escape cancels; the input's `blur`
    handler calls `commitNameEdit` which is a guarded no-op once `nameEditing` is false, so the
    Enter-then-blur and Escape-then-blur double-fires are safe. `loadNotes` calls `cancelNameEdit()`
    first so a rename in progress on an old score is dropped when a new one loads. The global
    keydown shortcut handler already bails on focused INPUT, so typing Space/arrows in the name
    field works natively.
  - **Verification:** 17 new tests (16 sheet-name + 1 toolbar markup guard added to
    `toolbar.test.ts` locking the four new ids + aria-label + maxlength), full suite 165 green,
    `npm run build` green. Code review (high effort, self-run): no findings. Could NOT verify the
    UI live (the preview server is bound to a different worktree, the standing limitation in qa.md);
    open as a live-QA item.

- **2026-05-30 - Heroicons adopted via INLINE SVG, not the npm package (#48).** Toolbar/transport
  icons now use Heroicons (MIT), delivered as inline `<svg>` with paths copied from the official
  set (`tailwindlabs/heroicons` `src/24/{outline,solid}`), NOT the `heroicons` npm package nor any
  React wrapper. Why inline over a dependency: (1) the project is vanilla Vite + TS with no JSX, so
  the React package is unusable and the raw-SVG package would need a `?raw`/loader import per icon
  for zero runtime benefit; (2) zero new deps keeps the bundle-size discipline (the #19 tfjs note)
  and matches the EXISTING pattern - #46 already shipped the step glyphs as inline SVG. This is
  strictly "swap the path data + add a few icons", same delivery mechanism as #46.
  - **Convention:** outline icons use `fill="none" stroke="currentColor" stroke-width="1.5"`
    (Heroicons' native outline weight); the SOLE solid icon is the Play/Pause hero
    (`fill="currentColor"`). `currentColor` is the whole point: every icon inherits its button's
    tier color and the #46 hover/active/disabled treatment with no extra CSS. The hardcoded
    `#0F172A` Heroicons ship on each path is stripped (a markup test asserts it never appears).
  - **JS-swapped icons (the one gotcha).** `setPlaying` used to do `playBtn.textContent = "Play" |
    "Pause"`, and `applyLabelMode` did `namesBtn.textContent = ...`; with an inline `<svg>` in the
    button, that wipes the icon. Fix: each such button wraps its text in a dedicated label span
    (`#play-label`, `#names-label`), and the JS now sets `.textContent` on the SPAN only. For
    Play/Pause the icon also changes shape (triangle <-> two bars), so `setPlaying` swaps the
    single `<path d=...>` between `PLAY_ICON_PATH`/`PAUSE_ICON_PATH` (Heroicons solid play/pause
    path constants in main.ts) and updates the button's `aria-label`. A guard test forbids
    `playBtn.textContent =` / `namesBtn.textContent =` so this regression can't silently return.
  - **Tests.** 11 new markup/CSS guards in `src/toolbar.test.ts` (no jsdom, same text-read pattern
    as #46): each of the 8 inlined Heroicons matched by a fragment of its authentic path, the
    `currentColor`/no-`#0F172A` convention, solid-only-for-Play, and the label-span swap discipline
    (reads `src/main.ts` too now). Full suite 162 green, `npm run build` green.
  - **Verification caveat:** preview port 5173 is bound to a different worktree, so verified by a
    WebKit static render (qlmanage) of the built header + the 11 guards; live in-browser + 720px +
    the play/pause swap remain for the post-merge QA gate.

- **2026-05-30 - Accidental spelling is LOST at `halfTone -> midi` (review #40).** Documented
  during the #40 accidentals review (design.md has the full UX writeup + follow-ups). Root cause for
  any future "show flats / enharmonic spelling" work: `extractScore` (`src/score.ts:28`) and the sheet
  overlay (`src/sheet-overlay.ts:53`) both reduce each note to `note.halfTone + 12`, discarding OSMD's
  notation spelling (the MusicXML `<step>` + `<alter>`, e.g. Db vs C#). Every label downstream then
  recomputes the name from MIDI via a fixed ALWAYS-SHARP array (`LETTER_CLASSES` / `SOLFEGE_CLASSES` in
  `src/piano.ts:92-95`), so flats never appear (no `flat`/`.alter`/`♭` anywhere in `src/`). To honor a
  score's flats, carry the spelling (OSMD `note.Pitch` `Accidental`/`AccidentalEnum`, or step+alter)
  alongside `midi` on `VisNote` from those two extraction points and have the label use it when present,
  falling back to the pitch-class array only when absent (audio-transcribed scores have no spelling).
  The label fit (#39), hue (#12), and black-key lane geometry are all MIDI-driven and correct already;
  only the printed NAME needs the spelling. No code changed in #40 (docs-only spike).

- **2026-05-30 - Muting a hand now ghosts its falling notes (#54), not audio-only.** #37 shipped a
  mute that only skipped a hand's Tone.Part triggers, so muting had zero on-screen effect; with sound
  off it read as a dead button. Fix: the visualizer learns the mute state via `setMutedHands({left,
  right})` (a field, read each frame, pushed from main.ts on every toggle and reset on load). In
  `drawFallingNotes`, a muted bar draws at `globalAlpha 0.3` (composed with the off-window 0.35 via
  `Math.min`), its contact glow is suppressed (`inContact = isActive && !muted && ...`), and its label
  carries the same dimmed alpha. The mute predicate is a pure `isHandMuted(hand, mutedHands)` in
  `piano.ts` (unit-tested: matching hand only, `unknown`/`undefined` never mute) so the alpha and the
  contact gate share one source of truth. Reset `globalAlpha = 1` at the end of each bar iteration and
  after the label pass so a muted bar's dim never leaks. Verified live (post-merge QA gate): muting the
  right hand visibly ghosts the treble bars while bass bars stay full; console clean.

- **2026-05-30 - Falling-note name now ALWAYS fits the bar (#39): pure `fitBarLabel` helper + center-anchor.**
  Fixed the note name overflowing/detaching on short or narrow falling bars. Root cause was the #27
  label rule: a fixed `600 11px` glyph at a fixed `y = top + 14` with a coarse `w >= 16 && barHeight
  >= 22` gate AND an "always label the active note" override. On a brief note (a few px tall),
  `top + 14` placed the name below the bar's bottom edge (detached); the active override stamped a
  full 11px name onto a ~6px bar (taller+wider than the note, the "oversized pill"); and 11px could
  exceed a narrow black-key bar's width (sideways spill). Pieces:
  - **Pure helper `fitBarLabel(barWidth, barHeight, charCount): { show, fontSize }`** in `src/piano.ts`
    (next to the label helpers). Font derives from bar HEIGHT: `size = min(MAX_LABEL_PX 12,
    floor(height * LABEL_HEIGHT_RATIO 0.55))`, then capped by WIDTH: `min(size, floor((width - 2*gutter)
    / (charCount * LABEL_CHAR_WIDTH_RATIO)))` with `LABEL_CHAR_WIDTH_RATIO 0.62`, `LABEL_GUTTER 2`. If
    the result `< MIN_LABEL_PX (8)`, return `show:false` (omit). All constants exported for the tests.
    The char-width estimate (0.62 * size per glyph) is a deliberate upper bound for system-ui so the
    fit math needs NO `ctx.measureText` in the rAF loop (the #12 perf budget: no per-bar measureText).
  - **Visualizer (`src/visualizer.ts`) consumes the result only.** The label-collection block now calls
    `fitBarLabel(w, barHeight, text.length)` and pushes `{x, y, text, fontSize}` only when `show`. The
    "always label active note" override is REMOVED (it was the source of the forced oversized label).
    Anchor moved from `y = top + 14` (alphabetic baseline) to `y = top + barHeight/2` with
    `textBaseline = "middle"`, so the centered name sits INSIDE the bar at any height instead of
    floating below a short one. The text pass sets `ctx.font` per-label (`600 ${fontSize}px system-ui`)
    inside the loop since sizes now vary; everything else (shadow reset discipline, the
    rgba(255,255,255,0.82) fill + 2px dark text shadow) is unchanged from #27.
  - **Does not regress the neighbors.** Centered + width-constrained label can never exceed the bar
    width, honoring #38's no-wider-than-note rule. The #27 contact stroke and #36 hand stripe are
    untouched (label is collected after the fill/stripe/stroke pass, drawn last with glow off). Off-range
    #33 bars still `continue` before the label block, so they stay name-free.
  - **Tests: 10 new in `src/piano.test.ts`** (`fitBarLabel` describe): normal bar -> MAX size, huge bar
    capped at MAX, short ~18px bar scales below MAX but >= MIN, ~6px staccato omitted, narrow 13px
    black-key bar fits-or-omits within width, 6px sliver omitted, 4-char letters+octave name fits, empty
    name omitted, and a fuzz sweep over widths 6-60 / heights 4-80 / 1-4 chars asserting every shown
    label stays within [MIN,MAX] and never exceeds the bar width. Canvas paint stays untested (pure
    geometry is the testable core, same pattern as #38's `noteBarWidth`). Full suite 148 green,
    `npm run build` green.
  - **Gotcha:** `transcribe.test.ts` fails with "Failed to load url @spotify/basic-pitch" if
    `node_modules` is stale in a fresh worktree; `npm install` pulls the dep and the suite goes 148
    green. Not related to any source change.
  - **Verification caveat:** preview MCP server is bound to a DIFFERENT worktree (port 5173,
    gifted-fermi) and reuses it, so no live in-browser visual pass from this agent worktree. Verified by
    the 10 unit tests + the fuzz sweep (the label-fit decision is fully captured in the pure helper),
    `npm run build` green, and code reasoning that the centered+fitted glyph is bounded by the bar.

- **2026-05-30 - Note-entry artifact FIXED (#38): removed `drawLandingBloom`, the only contact
  element wider than the note.** The "rectangular layer wider than the note, sticking out on both
  sides at the keyboard entry" was the per-active-key landing bloom in `src/visualizer.ts`
  (`drawLandingBloom`), a rounded rect drawn at `key.x` with the FULL `key.width` just above the
  keybed (`top - 16`). Falling white-note bars are only `key.width * 0.82` wide and centered, so the
  bloom overhung ~9% of the key on each side: exactly the artifact. (Black-note bars fill their key
  width, so the overhang was white-note-specific.) Removed the method and its call entirely. The #27
  contact-glow stroke is now the sole per-note contact highlight, and it strokes the exact bar path
  (`w` = bar width), so it can never exceed the note's width. NOT removed: the resting glow strip in
  `drawKeyboard` is a full-keybed ambient gradient (`fillRect(0, top-30, width, 30)`), not a per-note
  box, so it does not read as "a box wider than one note" and is untouched. Hand stripe (#36, inset in
  the bar) and note-name labels are unaffected.
  - **Reusable geometry helper added:** `noteBarWidth(keyWidth, black)` + `WHITE_BAR_WIDTH_RATIO`
    (0.82) in `src/piano.ts`, so the bar-width math is named once instead of the inline
    `key.width * (black ? 1 : 0.82)`. The visualizer now calls it. This is the invariant the bloom
    broke (any keybed highlight must use the bar width, never the full key width). Regression coverage:
    3 tests in `src/piano.test.ts` (white = 82%, black = full, and a loop asserting the bar width never
    exceeds the key width so a centered highlight always has non-negative gutter on both sides). Canvas
    paint itself stays untested; the geometry is the testable core.
  - **Verification caveat:** the preview MCP server was bound to a DIFFERENT worktree (port 5173,
    `gifted-fermi-...`) and `preview_start` reused it instead of launching one for this branch, so no
    live in-browser visual pass was possible from the agent worktree. Verified instead by full suite
    (139 green) + `npm run build` green + code reasoning that the only full-key-width draw at the entry
    point was the removed bloom.

- **2026-05-30 - Toolbar redesign v2 SHIPPED (#46): three-tier palette + SVG step icons.**
  Follow-up to #34, which fixed grouping/ghost-vs-filled but left the palette monochrome (all
  three loaders AND Play were the same filled violet gradient) and shipped broken step glyphs
  (`◄|` / `|►`, an arrow jammed against a pipe). Research-led per the Designer spec in design.md.
  Markup/CSS only plus one new dep-free guard test; no JS/behavior change, so the #29 step logic
  and the sync invariant are untouched. Pieces:
  - **Three button tiers (`src/style.css`).** PRIMARY (sole filled-violet hero) = `#play-btn`
    only, applying "one accent per viewport". SECONDARY (new) = the three `.file-btn` loaders,
    demoted from filled violet to a raised NEUTRAL surface (`--secondary-*` tokens) that only
    tints violet on hover. GHOST = `#export-btn`, `.toggle`, `.step-btn` (unchanged in spirit).
    This is the whole fix: exactly one violet button on the bar now, so it stops reading as
    "purple everywhere" and gains a real primary/secondary/ghost hierarchy.
  - **New tokens (`:root`).** Calmer near-neutral `--bar-surface rgba(16,14,22,0.92)` and neutral
    `--bar-border` / `--group-divider` (was violet-tinted), plus the `--secondary-*` raised tier.
    The brand anchors (`--accent`, `--accent-gradient`, glow) and the slider violet are unchanged,
    so the visualizer + sliders + violet wordmark keep the brand identity. Button labels use
    `#f7f2ff` (near-white), not `#ffffff`, on hover/fill.
  - **Step buttons -> inline SVG skip-previous / skip-next (`index.html`).** Replaced the text
    glyphs with two inline `<svg class="step-icon" fill="currentColor">` icons: prev = vertical
    bar on the LEFT + left-pointing triangle (`|◄`), next = right-pointing triangle + bar on the
    RIGHT (`►|`), the universally-read "step one back/forward" shape. `currentColor` means they
    inherit the ghost label color and the hover brighten for free, and they are crisp + identical
    cross-platform (no emoji-variation risk that `⏮`/`⏭` carry). Kept every `id=`, `aria-label`,
    and `title`, so the change is purely visual and main.ts's `prevNoteBtn`/`nextNoteBtn` hooks
    and screen-reader labels are unaffected. Verified the rendered glyphs via qlmanage PNG: they
    read as the standard skip-track controls.
  - **Tight transport cluster (`index.html` + CSS).** Wrapped prev/Play/next in a new
    `.transport-cluster` (gap 0.4rem) so the two step satellites flank the Play hero, then a wider
    `.transport` gap before the seek scrub + time readout. Only new DOM is that one wrapper div;
    no id moved.
  - **Tests (`src/toolbar.test.ts`, NEW, 22 tests).** No jsdom in the project (kept dep-free), so
    the guard reads `index.html` + `src/style.css` as text and asserts: all 14 `id=` hooks main.ts
    queries still exist, the prev/next `aria-label`s + shortcut titles survive, the broken text
    glyphs are gone and exactly two `step-icon` SVGs exist, the `.file-btn` loaders use
    `--secondary-bg` (NOT the accent gradient) while `#play-btn` keeps the gradient, the divider
    uses `--group-divider`, and the #33 mobile contract (`@media (max-width:720px)` + `min-height:
    44px` + `.step-btn { min-width: 44px }`) is intact. This locks the redesign's invariants
    against future markup regressions without adding a browser dep. Full suite 136 green.
  - **Coordinates with #44/#33.** Left `#track-name { margin-left: auto }` as the right-trailing
    flexible slot so the future editable sheet name (#44) can slot in; did NOT build #44. The tier
    change is color-only on the loaders (still `button`/`.file-btn`), so all #33 responsive rules
    still match unchanged.
  - **Verification caveat (same preview-binding limit as #36/#37):** the `preview_start` tool is
    bound to a DIFFERENT worktree (gifted-fermi on port 5173) and reuses it instead of attaching
    to this agent worktree, so the live MCP preview did not reflect these changes. Verified
    instead by: `npm run build` green + confirming the built `dist` carries the SVG icons + tier
    CSS; a real WebKit render via `qlmanage` of the built CSS + header (full desktop toolbar
    screenshot showed the single violet Play hero, neutral loaders, ghost utilities, and correct
    skip glyphs); and the 22-test markup/CSS guard. The phone breakpoint was checked via the unit
    test rather than a live 375px viewport (qlmanage does not honor the media query reliably).

- **2026-05-30 - Per-hand mute SHIPPED (#37): skip the trigger, never rebuild the Part.**
  Two per-hand audio mute toggles (Right/Left), built on the #36 `VisNote.hand` tag. Pieces:
  - **Pure helper `hasBothHands(notes: VisNote[]): boolean`** in `src/playback.ts` (true only
    if at least one `"right"` AND at least one `"left"` note exists; early-exits the loop once
    both are seen). 6 unit tests in `src/playback.test.ts` (both -> true; right-only,
    left-only, all-unknown, empty, right+unknown -> false). This gates the toggles' visibility.
  - **Mute is a per-callback skip, not a Part rebuild.** A module-level
    `const handMuted = { left: false, right: false }` in `src/main.ts` is read FRESH at the top
    of the `Tone.Part` callback: `if (note.hand === "left" && handMuted.left) return;` and the
    same for right, before `triggerAttackRelease`. `"unknown"` always sounds. Toggling a hand
    flips the flag and takes effect from the NEXT onset with zero rescheduling, so it is live
    and cheap. The Part's note projection gained `hand: n.hand` (was `{ time, midi, duration }`).
  - **Why skip-in-callback over a per-hand Tone channel/volume node:** a skipped trigger has no
    downstream side effects, so the sampler/synth swap (`getInstrument`) and the export-video
    path (which records the master output) need NO change. Routing each hand through its own
    gain node would have meant two instruments or a mid-graph split and re-plumbing the export
    tee; the skip is one branch and keeps the single-instrument, single-destination graph.
  - **Visibility + reset in `loadNotes` (`src/main.ts`):** compute `hasBothHands(score.notes)`;
    `handMutes.hidden = !hasBothHands(...)`. On EVERY load reset `handMuted` to
    `{left:false,right:false}` and both buttons' `aria-pressed` to `"false"`, so a hand muted
    on a previous score never silently carries into the next one. Button clicks flip the flag
    and reflect it in `aria-pressed` (true = muted), mirroring the existing `#names-btn` wiring.
  - **Correctness:** muting does NOT stop notes from falling; the visualizer draws from
    `score.notes` by time, fully independent of audio (untouched). A note already sounding when
    its hand is muted keeps ringing until its release completes (mute applies from the next
    onset); accepted for v1, no active-voice tracking added.
  - **Markup/CSS** per the Designer spec in design.md: `#hand-mutes` container (`hidden` by
    default) in the settings `.group`, two `<button class="toggle hand-toggle" aria-pressed>`
    reusing the #34 ghost-pill, muted shown by dim + label strikethrough + swatch fade (more
    than color), swatches matching the #36 rails (right near-white, left near-dark).
  - **Verification caveat:** the preview tool is bound to a different worktree in this setup and
    jsdom is not a project dep, so live in-browser checking was not possible from the agent
    worktree. Covered instead by the 6 `hasBothHands` unit tests (full suite 114 green),
    `npm run build` + the functions typecheck green, a headless run of the mute-gate logic, and
    confirming the built `dist` contains the markup, CSS, and aria-pressed wiring. The skip path
    is plain control flow with no Tone/canvas state, so unit coverage is representative.

- **2026-05-30 - Left/right-hand distinction SHIPPED (#36).** Falling notes now carry which hand plays them and draw a hand cue. Pieces:
  - **Hand derivation.** Pure helper `handFromStaffIndex(index, staffCount): Hand` in `src/piano.ts` (`Hand = "left" | "right" | "unknown"`): `staffCount < 2` or `index < 0` -> `"unknown"`; else index 0 = `"right"` (treble), 1+ = `"left"` (bass). `extractScore` (`src/score.ts`) reads `note.ParentStaff.ParentInstrument.Staves.indexOf(staff)` and `.length` to tag each pushed note, all behind optional-chaining so a malformed score degrades to `"unknown"` instead of throwing. Gotcha: do NOT derive hand from `VoiceEntry.ParentVoice.VoiceId` (a single staff can hold multiple voices); staff index is the right axis. Use `instrument.Staves.indexOf(staff)` (relative), not `staff.idInMusicSheet` (a global counter across instruments, only equal to the staff index for a single-instrument piano).
  - **Type.** `VisNote.hand?: Hand` is optional, so `transcribe.ts` (audio path) and existing tests/callers compile untouched; a missing hand reads as `"unknown"`.
  - **Visual (Designer spec in design.md).** A neutral hand accent stripe on one edge of the bar, body keeps its full pitch-class hue. In `drawFallingNotes` (`src/visualizer.ts`), after the body `fill()` and before the contact stroke: stripe width `max(3, min(6, w * 0.16))`, inset 1px, `shadowBlur = 0`, plain `fillRect`. Left hand = dark rail `rgba(10, 7, 18, 0.85)` on the LEFT edge; right hand = light rail `rgba(255, 255, 255, 0.92)` on the RIGHT edge (dark-vs-light is a colorblind-safe luminance cue on top of the side cue). Guarded by `note.hand === "left" || "right"`, so `"unknown"` (single-staff + audio) draws nothing and renders exactly as before. The stripe block runs before the off-range `continue`, so #33 off-window bars keep a dimmed stripe at their 0.35 alpha.
  - **No score.test.ts** still (OSMD iterator is not jsdom-mockable); the regression test lives on the pure `handFromStaffIndex` (4 cases in `piano.test.ts`, suite 108). Canvas paint intentionally untested. Verified in preview with an injected grand-staff MusicXML.

- **2026-05-30 - Top toolbar redesign SHIPPED (#34).** Pure markup/CSS pass, no JS or test change (per the Designer spec in design.md). The bar was a flat row where every control shouted equally. Fixes:
  - **Design tokens (`:root`).** Added a brand ramp (`--accent-deep #7a2fd6`, `--accent-gradient`), toolbar surfaces (`--bar-surface`, `--bar-border`), ghost-control bg/border tiers, muted text tiers (`--text-muted`, `--text-faint`), and one shared `--focus-ring #d9a6ff`. Everything downstream points at these so a re-theme is a one-block edit.
  - **Grouped controls (`index.html`).** `.controls` children are wrapped in three `.group` divs (source loaders / output / settings). A hairline divider is drawn as `.group + .group::before` (a flex child of the *second* group) so it wraps with its group and never orphans at a line start. `#track-name` / `#sound-status` stay outside the groups and `#track-name { margin-left: auto }` pushes status to the right.
  - **Two-tier button hierarchy (`src/style.css`).** Replaced the single shared button rule with PRIMARY (`.file-btn, #play-btn`: filled `--accent-gradient`, Play is the hero with extra padding + resting glow) and GHOST (`#export-btn, .toggle, .step-btn`: transparent fill + subtle border, brightens on hover). One unified `:focus-visible` ring via `--focus-ring` across all controls; slider track gradients and focus rings also moved onto the tokens.
  - Verified in preview at 961px (3 groups, gradient Play, ghost Export, violet wordmark) and 375px (h1 hidden, 44px tap targets, bar wraps); no console errors.

- **2026-05-30 - Responsive / mobile SHIPPED (#33).** Made the whole app usable on phones, per the Designer spec in design.md. Pieces:
  - **Responsive keybed + key window (`src/visualizer.ts`).** `KEYBOARD_HEIGHT` is no longer a module constant; `resize()` computes an instance `keyboardHeight = clamp(96, width*0.18, 140)` and every former `KEYBOARD_HEIGHT` read uses the field. On narrow widths the visualizer shows a centered sub-window of the 88 keys (full at >=760px, C2..C7 / 36..96 at 480..759, C2..C6 / 36..84 below 480) so keys stay tappable-wide. Gotcha fixed: the old code indexed keys by array position `this.keys[midi - 21]`, which only works for the full 21-start range. Replaced with a `keyByMidi: Map<number, KeyGeometry>` rebuilt in `resize()`, so a sub-range Just Works. Notes outside the visible window clamp to the nearest edge column and draw at `globalAlpha 0.35` (dimmed "off-screen note" hint, no contact glow or label) rather than vanishing. Key-face labels are suppressed below a 110px keyboard floor (`KEY_LABEL_MIN_HEIGHT`) since glyphs crowd on a phone; falling-bar names still render.
  - **`buildKeyLayout(width, firstMidi?, lastMidi?)` (`src/piano.ts`)** gained optional range args defaulting to `FIRST_MIDI..LAST_MIDI`, so all existing callers and tests are unchanged; one new unit test covers a C2..C7 window tiling the full width.
  - **CSS (`src/style.css`)** added a 900px tablet tightening block and expanded the 720px phone block: hide `<h1>` / `.track-name` / `.sound-status`, wrap `.transport`, give every control `min-height: 44px` (`.step-btn` also `min-width: 44px`), grow both slider thumbs to 24px (recentred via `margin-top: -(thumb-track)/2`, seek `-9.5px` / tempo `-10px`, with `10px 0` input padding), and shrink `#sheet` to 34% (30% below 380px) with `overflow-x: auto`. Both sliders get `touch-action: none` so a touch drag moves the thumb instead of scrolling.
  - **`#rotate-hint`** is a CSS-only transient pill (`index.html` + `style.css`): shown only at `max-width: 540px and (orientation: portrait)`, `pointer-events: none`, fades out over 4s, and the orientation media query hides it in landscape. No JS needed (the canvas already relays out on the `resize` that an orientation change fires). Added `viewport-fit=cover` to the viewport meta so the pill respects the safe-area inset.
  - Verified in preview at 375px (narrowed legible keyboard, wrapped touch toolbar, chrome hidden, hint shown) and 961px (full 88 keys, toolbar unchanged); no console errors.

- **2026-05-30 - Contact glow on key hit SHIPPED (#27).** `src/visualizer.ts` only (no test change; pure canvas paint covered by existing color tests). When a sounding bar's leading edge reaches the keybed (`isActive && bottom >= keyboardTop - 10`), it strokes a 2px border in the note's own `colors.glow` (shadowBlur 22, globalAlpha 0.9) so the bar visibly "lights up" on the hit, distinct from the steady active fill. Cheap: the branch fires only for the small set of bars that are both sounding and touching, so the common falling bar pays nothing. Companion tweaks from the Designer spec (design.md): the falling-note name label moved from the bar BOTTOM to near the TOP (`y: top + 14`) so it never covers the contact point, with a raised fit gate (`barHeight >= 22`, was 18) and lighter glyphs (`600 11px`, `rgba(255,255,255,0.82)`); active body glow dialed 26->20 and `drawLandingBloom` softened (height 22->16, alpha 0.55->0.4) so the new contact stroke reads as the brightest cue at the keybed. Verified in preview: the lowest bar touching the keybed shows a bright hued border and the matching key illuminates in the same hue.

- **2026-05-30 - Audio-to-score hardened (#26): input size + duration caps, narrowed accept list.** `src/transcribe.ts` now rejects uploads over `MAX_AUDIO_BYTES` (30 MB) before reading them into memory, and over `MAX_AUDIO_SECONDS` (5 min) after decode but before allocating the resampled buffer / running TFJS inference. Both checks are pure functions (`validateAudioFileSize`, `validateAudioDuration`) returning a user-facing message or null, so they unit-test without a File or AudioContext; they `throw new Error(msg)` which surfaces through main.ts's existing transcription catch (`alert`). The `#audio-input` `accept` was narrowed from `audio/*,.mp3,.wav,.ogg,.flac` to `audio/mpeg,audio/wav,audio/x-wav,.mp3,.wav` to match the advertised MP3/WAV scope (ogg/flac `decodeAudioData` support is browser-dependent and already failed gracefully). The two remaining #26 notes (chunked `frames.push` only matters if the cap is lifted; tfjs pinned at 3.21.0 via basic-pitch) need no action now.

- **2026-05-30 - Code review of #29 (transport): APPROVED, no blockers.** Reviewed seek/tempo interaction, backward-jump cursor rebuild, keyboard focus guard, control lifecycle, and stepping off-by-one. All correct. Non-blocking notes for a future pass: (1) seeking WHILE playing sets `transport.seconds` but does not re-pause, so the clock keeps running and the rAF loop's `updateSeekUI` immediately overwrites the seeked slider value (a live scrub-while-playing nudges then resumes from the new spot, which is acceptable; if a "scrub pauses playback" feel is wanted, pause in the slider `input` handler like `stepNote` does). (2) `onsets` is a subset of `stepTimes` (rests are pushed to `stepTimes` in `extractScore` but excluded from notes), and `resyncCursor` walks `stepTimes`, so a note onset always lands the cursor exactly on its step; consistent by construction. (3) `formatClock` only shows m:ss, so a score > 59:59 rolls minutes past 60 with no h:mm:ss (fine for piano-length pieces). None block merge.

- **2026-05-30 - Playback transport SHIPPED (#29): seek/scrub bar + prev/next-note step + keyboard shortcuts.** Pure helpers in `src/playback.ts` (16 unit tests), DOM/Tone wiring in `main.ts`, layout per the Designer spec in design.md. Key choices and gotchas:
  - **Seek slider is a fixed `0..1000` per-mille range, never seconds.** `max` stays constant across loads; map with `seekToScoreTime(value, duration)` / `scoreTimeToSeek(time, duration)`. Avoids resetting `max` per score and keeps native step granularity smooth.
  - **Seeking inverts the tempo relation.** Score time `= transport.seconds * tempoRate`, so a seek sets `transport.seconds = scoreTime / tempoRate` (guarded `tempoRate > 0`). One `seekScoreTime()` is the single entry point for the slider, the step buttons, and the arrow keys; it sets the transport clock, resyncs the cursor, updates the seek UI, and renders once so a paused seek repaints immediately.
  - **Backward jumps need a cursor rebuild.** OSMD's cursor only moves forward (`.next()`), so `resyncCursor()` does `cursor.reset()` then advances from the start to the target step. The old forward-only `syncCursor()` still handles normal playback.
  - **Stepping uses note onsets, not cursor steps.** `uniqueOnsets(score.notes)` (sorted, de-duped) works for both sheet scores and audio-transcribed scores (which have an empty `stepTimes`). `nextOnset`/`prevOnset` use a 1e-3 epsilon so sitting exactly on an onset advances to the neighbor. Stepping pauses playback first (note-by-note walking is a paused action).
  - **Slider feedback loop guard.** A `userSeeking` flag (set on slider `input`, cleared on `change`) stops the rAF loop from writing the slider value back mid-drag. The rAF loop only drives the slider/readout while `playing`.
  - **Keyboard shortcuts are global** (`window` keydown): Space = play/pause, Left/Right = prev/next note. Handler bails when a form control (`INPUT`/`TEXTAREA`/`SELECT`/contentEditable) is focused, so arrows still adjust the focused seek/tempo slider natively; Space is `preventDefault`ed so a focused button is not also clicked.
  - **Verification caveat (same as #15): real-time playback advancement is only observable with a genuine user gesture.** In the headless preview, programmatic `.click()` and synthetic `KeyboardEvent`s do NOT grant user activation, so `AudioContext.resume()` leaves the context suspended and `transport.seconds` stays frozen (canvas does not animate, seek bar does not move). Driving the Play button via a CDP click (`preview_click`) DID resume the context and the seek bar + time readout + sheet cursor + falling notes all advanced in lockstep. Seek/step logic is fully verifiable headless because it sets `transport.seconds` directly without needing the clock to run.

- **2026-05-30 - Video export SHIPPED (#15) via client-side MediaRecorder (route 1). Decisions + a verification caveat.**
  An "Export video" button records the performance and downloads it; no service, no API, no OAuth (route 2,
  the YouTube Data API, was rejected for its quota + OAuth + token-backend needs, which break the
  free/uncapped/static-host posture). `src/recorder.ts` holds the pure, unit-tested helpers
  (`chooseVideoFormat` over a preference list, `buildExportFilename` slug + timestamp); the browser
  orchestration is `exportVideo()` in `main.ts`.
  - **Decisions:** real-time capture (MediaRecorder is realtime-only; offline faster-than-realtime is not
    possible with it). 30 fps. Container preference WebM `vp9,opus` -> `vp8,opus` -> `webm` -> `mp4`
    fallback (royalty-free, YouTube-friendly). **Records the `#stage` canvas only** (falling notes +
    keyboard); the sheet is a separate SVG and is NOT in the canvas, so the video is the Synthesia-style
    performance area only. No intro/title card (kept simple).
  - **Audio tee:** `Tone.getDestination().connect(streamDest)` where `streamDest =
    rawContext.createMediaStreamDestination()`; combine its audio track with `canvas.captureStream(30)`
    video tracks into one MediaStream for the recorder. `Tone.getContext().rawContext` is cast to
    `AudioContext` (the Tone type is `BaseAudioContext`, which lacks `createMediaStreamDestination`).
  - **Why it does not stop early:** `await Tone.start()` runs first (the Export button click is a real user
    gesture, so the context resumes), then the transport starts and a 100 ms poll waits until the rAF loop's
    end-of-score `rewind()` stops the transport. Recording then stops and the blob downloads.
  - **VERIFICATION CAVEAT (important for future canvas-recording work):** the headless Chromium behind the
    preview tool does NOT encode canvas frames for MediaRecorder, so a `captureStream` + `MediaRecorder`
    recording yields only a ~110-byte header (1 chunk, 0 frames) there, even though the video track exists.
    This is an environment limit, not a bug: format selection, track creation, the audio-tee `connect` (no
    throw), recorder lifecycle, blob+download, and filename were all verified, and the 8 unit tests pass, but
    the actual encoded video bytes can only be validated in a real (non-headless) browser. Do not trust an
    empty-blob result from the preview as a regression.

- **2026-05-30 - Audio-to-score SHIPPED (#19), falling-notes-only slice. Two gotchas worth remembering.**
  Implemented per the spike below. `src/transcribe.ts` owns the model glue: `transcribeAudioFile(file,
  onProgress)` decodes via `AudioContext.decodeAudioData`, resamples to mono 22050 Hz with an
  `OfflineAudioContext`, runs `BasicPitch.evaluateModel`, and maps results through the pure, unit-tested
  `noteEventsToVisNotes` (rounds MIDI, drops out-of-88-key / non-positive-duration notes, sorts by time).
  `loadScoreXml` was split into a shared `loadNotes(ScoreData, name, sheet)` core; the audio path calls it
  with `stepTimes: []` and `sheet=false`.
  - **Gotcha 1 (bundle size):** importing `@spotify/basic-pitch` statically pulls all of TensorFlow.js into
    the main chunk (~3.3 MB / 677 KB gzip on the initial load). Fixed by **lazy `await import("./transcribe")`**
    inside `loadAudioFile`, so tfjs is a separate ~1.8 MB chunk fetched only when a user actually transcribes.
    Keep any future heavy ML deps behind a dynamic import for the same reason.
  - **Gotcha 2 (OSMD cursor is undefined until a sheet loads):** `osmd.cursor` does not exist on a fresh page
    (no MusicXML loaded yet). The audio path must use `osmd.cursor?.hide()` and gate cursor work behind a
    `hasSheet` flag; `rewind()` only resets/shows the cursor when `hasSheet`. Verified end to end: a synthetic
    C-D-E-F-G WAV transcribes to exactly 5 ascending falling notes that play back, no console errors.
  - **Model hosting:** the ~1 MB weights are streamed from jsDelivr
    (`cdn.jsdelivr.net/npm/@spotify/basic-pitch@1.0.1/model/model.json`), same "CDN not repo binaries" pattern
    as the Salamander samples. TFJS resolves the weight shard relative to that URL.

- **2026-05-30 - Audio-to-score runs CLIENT-SIDE with Spotify basic-pitch (TF.js), not on a server (SPIKE #19).**
  Decision: transcribe uploaded audio (MP3/WAV) to note events fully in the browser with
  **`@spotify/basic-pitch`** (the `basic-pitch-ts` port), then build `VisNote[]` directly for a
  falling-notes-only first slice. No sheet view in slice 1. This mirrors the OMR spike's "heavy ML
  can't run in a Pages Function" finding, but here the model is small enough to run on-device, so
  we do NOT need the GitHub Actions detour: transcription happens entirely client-side, no R2, no
  dispatch, no Function.
  - **Model + license:** `@spotify/basic-pitch` is a TensorFlow.js port of Spotify's Basic Pitch,
    **Apache-2.0** (free/permissive, satisfies the hard constraint). The TF.js model is tiny:
    `group1-shard1of1.bin` ~742 KB + `model.json` ~175 KB, so well under 1 MB of weights. Runs in
    the browser via tfjs (WebGL/WASM/CPU backends); no native binaries, no server compute. Polyphonic
    by design (includes onset+offset detectors), so it also covers monophonic piano.
  - **API + output shape (confirmed from source):** `new BasicPitch(model)` then
    `await basicPitch.evaluateModel(audioBuffer, frameCb, percentCb)` accumulates frames/onsets/contours;
    then `noteFramesToTime(addPitchBendsToNoteEvents(contours, outputToNotesPoly(frames, onsets, onsetThresh,
    frameThresh)))` yields `NoteEventTime[] = { pitchMidi, startTimeSeconds, durationSeconds, amplitude }`.
    Input audio may be any sample rate; basic-pitch **resamples to 22050 Hz** internally. The library even
    has a `noteEventsToMidi`-style mapping that already emits `{ midi: pitchMidi, time: startTimeSeconds,
    duration: durationSeconds, velocity: amplitude }`, which is almost exactly our `VisNote`.
  - **Output -> pipeline (the key call): build `VisNote[]` DIRECTLY, bypass OSMD/MusicXML for slice 1.**
    `NoteEventTime` maps 1:1 onto `VisNote`: `{ midi: pitchMidi, time: startTimeSeconds, duration:
    durationSeconds }`. That feeds `visualizer.setNotes` + the `Tone.Part` build (the audio/falling-notes
    path in `loadScoreXml`) with zero notation work. **Cost: no synced sheet view** for audio uploads,
    because the sheet cursor needs OSMD-rendered MusicXML (`stepTimes` comes from the OSMD iterator in
    `src/score.ts`). To get the sheet back later (slice 2) we would quantize note events to a beat grid
    and emit MusicXML (tempo/key/time-sig estimation, note spelling, voice assignment), which is a large
    second effort and inherently lossy. Recommendation: ship falling-notes-only first, treat sheet view
    as a follow-up ticket. The sync invariant is NOT at risk in slice 1: with no cursor, falling notes
    are driven by the same `VisNote.time` values the Part is scheduled from, one timestamp source.
  - **Refactor needed:** `loadScoreXml` currently couples OSMD render + `extractScore` + Part build +
    `setNotes`. Split out a `loadNotes(notes: VisNote[], { name, duration })` that does the Part rebuild +
    `visualizer.setNotes` + transport reset, with NO cursor/sheet steps. The MusicXML path keeps calling
    the OSMD branch; the audio path calls `loadNotes` directly. `score.duration` for the frame-loop rewind
    is `max(time + duration)` over the notes (same formula as `extractScore`).
  - **Decode path:** use the Web Audio API `AudioContext.decodeAudioData` (handles MP3/WAV natively in
    browsers) to get an `AudioBuffer`, take channel 0 (mono) at 22050 Hz (resample via an
    `OfflineAudioContext` or let basic-pitch resample). All standard browser APIs, no extra deps beyond
    `@spotify/basic-pitch` + `@tensorflow/tfjs`.
  - **Riskiest unknowns:** (1) **transcription quality** is the single biggest risk: basic-pitch on a clean
    solo-piano recording is decent but produces spurious/missed notes, octave errors, and ragged on/off
    times; "demo-grade" is realistic, "accurate" is not, and quality degrades hard on dense/poly or noisy
    audio. (2) **tempo/timing**: events are in absolute seconds (good for our seconds-based Part), but there
    is no beat grid, so notes won't look quantized; fine for falling-notes, fatal for clean sheet output.
    (3) **bundle/runtime weight**: tfjs adds a few hundred KB of JS and a WebGL warmup; the model itself is
    sub-1 MB. (4) basic-pitch's npm package pins a tfjs major; verify it coexists with our Vite build.
  - **Verdict: FEASIBLE FIRST SLICE in one ticket** for a demo-grade monophonic/clean-piano MP3/WAV upload
    that plays as falling notes (no sheet), entirely within free tooling. Biggest risk = transcription
    accuracy, so scope the ticket as "demo-grade, clean solo piano" and set expectations accordingly. Sheet
    view from audio is a separate, larger NEEDS-MORE effort (quantize -> MusicXML).

- **2026-05-30 - Sheet note-name labels (issue #17): HTML overlay inside the scrolled `#sheet`, positions read from OSMD SVG bboxes.**
  Labels are an absolutely-positioned `<div id="sheet-labels">` (one `.sheet-label` span per
  notehead) appended INSIDE `#sheet` (now `position: relative` in `src/style.css`), with
  `pointer-events: none` and `z-index: 1`. Because the overlay lives in the same scrolled
  content box as the OSMD SVG, it translates natively on scroll: no scroll handler needed.
  Only re-render and resize move noteheads, so only those recompute positions.
  - **Reading notehead geometry from OSMD (reusable):** after `osmd.render()`, walk
    `osmd.GraphicSheet.MeasureList` (indexed `[staffLineIndex][measureIndex]`, guard undefined
    cells) -> `measure.staffEntries` -> `staffEntry.graphicalVoiceEntries` ->
    `voiceEntry.notes` (`GraphicalNote[]`). Skip rests via `note.sourceNote.isRest()`; MIDI is
    `sourceNote.halfTone + 12`. The rendered `<g>` comes from `getSVGGElement()`, which is a
    VexFlow-subclass method NOT on the public `GraphicalNote` type, so feature-detect it via a
    narrow structural cast (`note as unknown as { getSVGGElement?(): SVGGElement | null }`) and
    skip gracefully when null. Take its `getBoundingClientRect()` (viewport coords) and convert
    into the `#sheet` content box: `x = rect.left - containerRect.left + scrollLeft + rect.width/2`
    (notehead center-x), `y = rect.top - containerRect.top + scrollTop` (notehead top). This is
    the right coordinate space for the absolutely-positioned overlay even when scrolled.
  - **Pure layout split out for testing:** `layoutSheetLabels(notes: NotePosition[], mode): LabelItem[]`
    in `src/sheet-labels.ts` is DOM-free. It groups noteheads sharing an x into chords (epsilon
    0.5px), sorts each chord highest-pitch-first, and stacks labels upward: the lowest label sits
    6px above the top notehead, each higher one +11px. Off mode returns `[]`. Density rule: if two
    adjacent chords are closer in x than the wider of their two top-note labels (approx glyph width
    6px), collapse the lower-priority chord to its top note only (active/cursor chord wins, else the
    leftmost), so the melody/top line is always labeled. No octave on the sheet (uses `midiToLabel`,
    not `midiToBarLabel`). Tests in `src/sheet-labels.test.ts` (6): single note, 3-note chord
    stacked top-highest with 11px gap, off mode, letters vs solfege text, density drop keeping both
    top notes, active-chord priority. The OSMD walking + `getBoundingClientRect` glue lives in
    `src/sheet-overlay.ts` (`renderSheetLabels`) and is browser-only (not unit-tested).
  - **Wiring (`src/main.ts`):** `renderSheetLabels(osmd, sheetContainer, labelMode)` is called
    after `osmd.render()` in `loadScoreXml`, inside `applyLabelMode` (so the Names toggle and the
    startup call both rebuild it; it is a safe no-op before any score renders because
    `osmd.GraphicSheet` is falsy), and on a 150ms-debounced `window.resize` (OSMD `autoResize`
    re-renders the SVG, moving noteheads). Reuses the existing `LabelMode` and Names toggle; no
    second control. Color/font are pure CSS (`#7a2fd6`, `system-ui 600 9px`, triple light-halo
    `text-shadow`). Falling-bar/key labels (#11) and the cursor sync are untouched.

- **2026-05-30 - Tempo slider (issue #14): one rate scales audio bpm + visual score time, sync preserved.**
  A single `tempoRate` (1.0 = 100% = score speed) drives everything. Pure mapping lives in
  `src/tempo.ts` (`tempoPercentToRate`, `clampTempoPercent`, `rateToBpm`), unit-tested in
  `src/tempo.test.ts` (9 tests): 100% -> 1.0 -> `BASE_BPM`, 50 -> 0.5, 200 -> 2.0, range
  endpoints, clamp to [25,200] (and NaN/Infinity -> default 100).
  - **Mechanism (`src/main.ts`):** capture `BASE_BPM = transport.bpm.value` once at startup
    (Tone default 120). Audio speed is driven by `transport.bpm.value = BASE_BPM * tempoRate`;
    Tone live-scales the spacing of the already-scheduled seconds-based `Tone.Part` events, so
    NO Part rebuild on a tempo change. The frame loop computes
    `scoreTime = transport.seconds * tempoRate` and passes THAT (not raw seconds) to
    `visualizer.render`, `syncCursor`, and the `>= score.duration` rewind check. Why it stays
    in sync: Tone's transport is tick-based, so `transport.seconds = ticks*60/(PPQ*bpm)`;
    multiplying by `tempoRate = bpm/BASE_BPM` yields `ticks*60/(PPQ*BASE_BPM)`, independent of
    the current bpm. Score time is therefore continuous across a live tempo change (no jump),
    and audio + falling notes + cursor scale in lockstep.
  - **Build-at-baseline subtlety:** a `Tone.Part` built from numeric (seconds) times converts
    them to ticks using the bpm AT BUILD TIME. So in `loadScoreXml` we set `transport.bpm.value
    = BASE_BPM` BEFORE constructing the Part, then reapply `rateToBpm(tempoRate, BASE_BPM)`
    right after `part.start(0)`. This makes note tick positions rate-independent and keeps sync
    correct even when the tempo was changed before any score was loaded. `rewind()` stops the
    transport and resets position but leaves bpm alone, so the chosen tempo survives a rewind.
  - **UI:** native `<input type="range" min=25 max=200 step=5>` plus a `<button id="tempo-readout">`
    that snaps back to 100% on click/Enter, styled per design.md. `applyTempo(percent)` clamps,
    updates rate + live bpm + slider + readout; wired to slider `input` and readout `click`, and
    called once at startup. Works both before and during playback (live, no rebuild).

- **2026-05-30 - Sampled piano (issue #13): Tone.Sampler with Salamander Grand, lazy-loaded, synth fallback.**
  Swapped the sound source only; no timing/scheduling change, so the sync invariant holds.
  - **Sample set + license:** Salamander Grand Piano by Alexander Holm, **CC-BY 3.0** (free to use and
    redistribute with attribution). Attribution + license noted in `src/sampler.ts` header.
  - **Hosting:** stream mp3 buffers from the official, uncapped Tone.js sample CDN, base URL
    `https://tonejs.github.io/audio/salamander/` (`SALAMANDER_BASE_URL`). No mp3s in the repo, no R2 for
    audio. Satisfies free/uncapped + no-large-binaries constraints.
  - **Sample map is pure + unit-tested:** `buildSalamanderSampleMap()` in `src/sampler.ts` returns the
    Tone.Sampler `note->filename` map at ~one sample per minor third (A/C/D#/F# per octave). 30 entries:
    `A0` only in octave 0, A/C/D#/F# in octaves 1..7, plus `C8` (the partial top octave only ships C8).
    Sharps map to the CDN's "s" filename spelling (`"D#1" -> "Ds1.mp3"`, `"F#1" -> "Fs1.mp3"`); Tone keys
    keep the `#`. Tests in `src/sampler.test.ts` (8). Tone.Sampler itself is not jsdom-testable, so only
    the pure map is covered.
  - **Lazy-load + fallback design (`src/main.ts`):** `startSamplerLoad()` runs at startup (background); it
    only fetches buffers and does not need a running AudioContext, so it never blocks initial render or
    Play. `getInstrument()` returns the sampler when `sampler.loaded` is true, else `ensureSynth()`. The
    Tone.Part callback calls `getInstrument()` **at trigger time** (not captured at Part-build time), so
    playback upgrades to the sampler the moment it finishes loading, even mid-session. On `onerror` (or a
    constructor throw) the sampler is dropped and the synth is used permanently. Sampler volume -6 dB.
  - **Loading UX:** a `#sound-status` span in the header (`.sound-status`, hidden when empty via
    `:empty`) shows "Loading piano sound..." during load, clears on `onload`, and shows
    "Using basic sound (piano samples unavailable)." on failure. Non-blocking and non-fatal.

- **2026-05-30 - Visualizer colors (issue #12): pitch-class hue wheel, purple-anchored.**
  Color math lives in `src/piano.ts` next to the label helpers and is pure/unit-testable:
  `pitchClass(midi)` (normalizes negatives), `pitchHue(midi): number` returns
  `(276 + pc * 30) mod 360` (276deg = brand `#b14bff`, so C/Do anchors violet), and
  `noteColor(midi): NoteColors` returns the hsl strings (`whiteFill` 85/62, `blackFill`
  70/50, `glow` 90/68, `activeFill` 95/72, `activeWhiteKey` 85/66, `activeBlackKey` 80/60).
  Hue depends only on pitch class, so octaves share a hue and a key with multiple sounding
  notes is well-defined. Tests in `src/visualizer-color.test.ts`.
  - **Performance: a precomputed 12-entry `PITCH_CLASS_COLORS` table is built once at module
    load** (one `buildNoteColors` per pc); `noteColor` is a table lookup, so no hsl strings
    are built and no `measureText` runs inside the rAF loop. `noteColor(60) === noteColor(72)`
    (same cached object). Per-bar cost stays one `fillStyle` + one `shadowColor` + one
    `shadowBlur` + one `fill` (same as before #12). The background and resting landing-strip
    gradients are reused per frame/resize, never per note.
  - **Where colors land in `src/visualizer.ts`:** falling bars use white/black fill + glow
    shadowColor per note, active bars bump to `activeFill` + shadowBlur 26 (else 18); active
    white/black key faces use `activeWhiteKey`/`activeBlackKey`; resting strip dimmed to
    `rgba(177,75,255,0.18)`; a new `drawLandingBloom` draws a 22px-tall rounded bloom in each
    sounding note's glow hue (globalAlpha 0.55, shadowBlur 16) above the key, drawn before the
    keybed/keys, at most "notes sounding" draws per frame. Background: `bgGradient` (cached in
    `resize()`, `#0a0712` -> `#120b1f`) is `fillRect`-ed over the whole canvas each frame in
    place of `clearRect` (the fill both clears and paints). Removed the `ACCENT` constant.
    Label discipline from #11 is unchanged: `shadowBlur` reset to 0 before text, dark text
    shadow only, all-or-nothing key-label floor, active bar always labeled.

- **2026-05-30 - OMR code shape (issue #5): Pages Functions + R2 binding + browser poll, pure logic in `src/`.**
  Endpoints (Pages Functions, `functions/api/`): `POST /api/omr` (`functions/api/omr.ts`, `onRequestPost`)
  accepts multipart `file` (raw-body fallback), validates MIME in {png, jpeg, pdf} and size <= 12 MB,
  writes raw bytes to R2 `uploads/<jobId>` (jobId = `crypto.randomUUID()`), fires `repository_dispatch`
  to `simpasgh/piano-helper` (event_type `omr-job`, client_payload `{ jobId, ext }`, ext in
  png|jpg|jpeg|pdf), returns 202 `{ jobId }`. On dispatch failure it best-effort deletes the upload and
  returns 502; bad type/size returns 400 `{ error }`. `GET /api/omr/result?jobId=`
  (`functions/api/omr/result.ts`, `onRequestGet`) returns 200 + MusicXML
  (`application/vnd.recordare.musicxml+xml`) when `results/<jobId>.musicxml` exists, 422 `{ error }` from
  `results/<jobId>.error`, else 404 `{ status: "pending" }`. R2 binding name is `OMR_BUCKET` (set in
  `wrangler.jsonc` at repo root; wrangler-only file, vite ignores it). Token secret `GITHUB_DISPATCH_TOKEN`.
  - **Pure logic in `src/` so tests run without Cloudflare runtime:** `src/omr-server.ts` holds
    MIME->ext, `validateUpload`, `buildDispatchRequest`, and the R2 key helpers; the Functions import it
    and stay thin. `src/omr.ts` is the DOM-free browser client: `submitOmr(file, fetchFn=fetch)` and
    `pollOmrResult(jobId, { fetchFn, intervalMs, timeoutMs, sleep, now })` with injected sleep/now/fetch
    so `src/omr.test.ts` runs instantly with fakes. Tests live in `src/` (Vitest default glob only picked
    up the three `src/*.test.ts`).
  - **`functions/` typechecking is isolated from the app build.** Root `tsconfig.json` has
    `include: ["src"]`, so `tsc` (the `build` step) never compiles `functions/` and the Workers types
    never leak into the DOM-typed app build. A separate `functions/tsconfig.json` (types
    `@cloudflare/workers-types`, lib ES2022 only, no DOM) typechecks the Functions on demand via
    `npx tsc -p functions/tsconfig.json`. Each Function file also has a `/// <reference types="@cloudflare/workers-types" />`.
    Gotcha: this `@cloudflare/workers-types` version narrows `FormData.get()` to `string | null` (no File),
    so an `instanceof File` check fails to typecheck. Fix: cast the entry to `unknown` and feature-detect a
    `arrayBuffer` method (`isFilePart`) in `functions/api/omr.ts`. The Workers runtime does return a File for
    file fields, so this is type-only, not behavioral.
  - **`loadScoreXml` refactor in `src/main.ts`:** extracted `loadScoreXml(xml, name)` containing
    everything from `osmd.load` through the OSMD render, `extractScore`, Tone.Part rebuild,
    `visualizer.setNotes`, trackName, and playBtn enable. `loadScoreFile` now just reads `file.text()` then
    calls it; the OMR path calls the same function with the scan result. Scan UI: a second `.file-btn` file
    input (`#scan-input`), handler disables both inputs + play button while `submitOmr`/`pollOmrResult`
    runs, shows status in the track-name span, restores on success/error; the rAF loop is never blocked.
    `vite dev` does not run Pages Functions, so the live POST path needs `wrangler pages dev` to exercise;
    the contract is covered by unit tests + the functions typecheck.

- **2026-05-30 - OMR compute moved off GitHub Actions to an always-on R2-polling worker (issue #5).**
  This SUPERSEDES the earlier GitHub-Actions OMR runner (`.github/workflows/omr.yml`, now deleted) and
  the `repository_dispatch` trigger. Using GitHub Actions as the app's runtime compute backend violates
  GitHub's Actions usage policy (it is for CI/CD on the repo, not as a free job server) and risks account
  suspension, regardless of the public-repo "unlimited minutes" fact the earlier spike leaned on. New
  backend: a self-contained always-on Python worker (`omr-worker/worker.py`, boto3) that polls Cloudflare
  R2 for new uploads. It is host-agnostic (an Oracle Always Free ARM VM was the plan; it currently runs on
  the owner's Mac via launchd, see infrastructure.md); a systemd unit (`omr-worker/omr-worker.service`,
  `Restart=always`) is shipped for the Linux path. The R2 transport contract is UNCHANGED: input
  `uploads/<jobId>`, output `results/<jobId>.musicxml`, with a failure-sentinel MusicXML
  (`<miscellaneous-field name="omr-status">failed</miscellaneous-field>`) the client detects via
  `isFailureSentinel` / `FAILURE_SENTINEL_RE` in `src/omr.ts` (kept byte-compatible with the worker).
  The browser contract is also unchanged (POST returns 202 `{jobId}`, then poll `/api/omr/result`).
  **Trigger change:** there is no longer any push notification. The Pages Function `POST /api/omr`
  (`functions/api/omr.ts`) now ONLY validates + writes the upload to R2 and returns 202; all
  `repository_dispatch` / GitHub-PAT code was removed and the 503 gate is now `!env.OMR_BUCKET` only.
  `GET /api/omr/result` (`functions/api/omr/result.ts`) only reads `results/<jobId>.musicxml` (200) or
  reports pending (404); the old `.error`/422 path is gone because failure is carried in-XML by the
  sentinel. The worker discovers jobs by listing R2 `uploads/*` (env `OMR_POLL_SECONDS`), so no PAT, no
  webhook, no inbound port. Worker loop per job: validate jobId is a UUID (path-safety, before any S3
  key/filesystem use); skip if `results/<jobId>.musicxml` already exists (idempotent); download;
  rasterize PDFs first page with poppler `pdftoppm -r 300`; run oemer, fall back to homr; on both
  failing, write the sentinel; upload the result, THEN delete `uploads/<jobId>` (delete-after-write so a
  crash mid-job just retries). Per-job and per-cycle exceptions are caught so one bad upload never kills
  the loop. **Code organization (kept from main's structure):** the pure server helpers live in
  `src/omr-server.ts` (so the root `tsc` typechecks them and Vitest runs `src/omr-server.test.ts`); the
  Function code is typechecked in CI by `functions/tsconfig.json` (`npx tsc -p functions/tsconfig.json`),
  and the `OMR_BUCKET` R2 binding is declared in-code via `wrangler.jsonc` (`pages_build_output_dir:
  "dist"`), so no manual dashboard binding step is needed. `omr-worker/` is outside the JS test/build
  entirely (Python; verify with `python3 -m py_compile`). The `GITHUB_DISPATCH_TOKEN` Pages secret and
  `GITHUB_REPOSITORY` var are now unused and should be removed from the Pages project; the four R2 S3
  creds moved from Actions secrets to worker-host env vars. See `omr-worker/README.md` for the runbook.
  The earlier "OMR runs in GitHub Actions" and "OMR trigger via repository_dispatch" entries below are
  SUPERSEDED by this one.

- **2026-05-30 - Note-name labels (issue #11): piano.ts produces strings, visualizer is presentation-only.**
  Two helpers sit next to `midiToName` in `src/piano.ts`: `midiToLabel(midi, mode)` returns the
  pitch-class token only (no octave) for both key faces and solfege, and `midiToBarLabel(midi, mode)`
  appends the octave only in letters mode (so it equals `midiToName` there) and stays octave-free in
  solfege. `type LabelMode = "solfege" | "letters" | "off"`. Both return `""` for off mode. Solfege is
  fixed-Do, always-sharp, "Si" not "Ti". Toggle state lives in `main.ts` (localStorage key
  `pianoHelper.noteNames`, default "solfege"), flows one-way to the visualizer via
  `visualizer.setLabelMode(mode)`; the visualizer holds a `labelMode` field and never reads storage.
  Key-face labels render on the 52 white keys only (black faces too narrow). Legibility floor is
  all-or-nothing: if the widest label for the mode plus a 4px gutter exceeds the white-key width at
  11px, the whole row is skipped (uniform beats a ragged row), never shrink below 11px. Bar labels
  render when drawn width >= 16 and height >= 18, except the active key's bar is always labeled.
  `initLabelMode` and the toggle wrap `localStorage` in try/catch: storage access throws in Safari
  Private Browsing and sandboxed iframes, and it runs at module load before the rAF loop registers,
  so an unguarded throw would abort app startup, not just the labels feature.
  - **shadowBlur gotcha:** the falling-note glow uses `ctx.shadowBlur = 18`. Canvas `fillText`
    inherits the live shadow, so glyphs would smear if drawn under that. Fix: collect bar-label
    geometry during the fill pass, then after all fills set `shadowBlur = 0`, draw text with a small
    `shadowBlur = 2` (rgba(0,0,0,0.45) for legibility over the purple), and reset to 0 again.
    `drawKeyLabels` also sets `shadowBlur = 0` defensively before drawing. See `src/visualizer.ts`
    `drawFallingNotes` / `drawKeyLabels`.

- **2026-05-30 - OMR code-review fixes (issue #5).** Three review-driven changes on top of the initial app code. (1) Failure-sentinel detection: when both engines fail, the runner writes a valid-but-empty `score-partwise` carrying `<miscellaneous-field name="omr-status">failed</miscellaneous-field>` so the browser stops polling; without detection the client would have silently rendered a blank "0 notes" score as success. `src/omr.ts` now exports `isFailureSentinel(xml)` (regex `/name="omr-status"\s*>\s*failed/`, kept in sync with `.github/workflows/omr.yml`) and `pollOmrResult` throws a friendly "Could not recognize any notes" error when it sees the sentinel. (2) Poll timeout raised from ~5 min (120 x 2500 ms) to ~15 min (300 x 3000 ms): a cold oemer run (model download + inference + possible homr install) realistically exceeds 5 min, which would have shown "timed out" on a job that still succeeds. (3) `validateUpload` now normalizes the Content-Type via `normalizeMime` (strip `;` params, lowercase) before the allowlist check, so a legit upload tagged `image/png; charset=binary` is not wrongly 415'd. Also added `console.error` on the sheet-import failure path in `main.ts` for parity with the file-load path. Security review (token handling, R2 path traversal via jobId, workflow shell injection from client_payload, XXE) found nothing: jobId is UUID-validated server-side and re-validated in the workflow against `[A-Za-z0-9_-]` via a job-level env var, `filename`/`contentType` never reach a shell, and the PAT is never echoed.

- **2026-05-30 - OMR pipeline app code implemented (issue #5).** Two Pages Functions plus a client module, matching the frozen R2/dispatch contract. Endpoints: `POST /api/omr` (`functions/api/omr.ts`) reads raw file bytes with `?filename=`, validates MIME (pdf/png/jpeg) and size (<=10 MB) via shared helpers, `OMR_BUCKET.put('uploads/<jobId>', ...)`, fires `repository_dispatch` (event_type `omr-job`, client_payload `{ jobId, contentType, filename }`) to `api.github.com/repos/<repo>/dispatches`, returns 202 `{ jobId }`; 415/413 on bad input, 503 `{ error: "OMR is not configured" }` if `OMR_BUCKET` or `GITHUB_DISPATCH_TOKEN` missing (so prod never 500s pre-wiring), 502 if dispatch fails, 500 on unexpected. `GET /api/omr/result?jobId=` (`functions/api/omr/result.ts`) 400s on non-uuid, reads `results/<jobId>.musicxml`, 404 `{ status: "pending" }` while absent, else 200 with `Content-Type: application/vnd.recordare.musicxml+xml`. Pure helpers live in `functions/api/_omr.ts` (no Cloudflare types, unit-tested): `ALLOWED_MIME`, `MAX_UPLOAD_BYTES`, `validateUpload`, `uploadKey`, `resultKey`, `isUuid`. Env the Functions read: R2 binding `OMR_BUCKET`, secret `GITHUB_DISPATCH_TOKEN`, var `GITHUB_REPOSITORY` (fallback `simpasgh/piano-helper`). Client `src/omr.ts`: `validateSheetFile`, `requestOmr`, `pollOmrResult`, `convertSheetToMusicXml`; fetch/interval/maxAttempts/sleep are injectable for tests (defaults 2500 ms, ~120 attempts). `src/main.ts` refactor: extracted `loadMusicXml(xml, label)` from `loadScoreFile` (the .xml/.musicxml path now calls it), and `#sheet-input` drives upload -> poll -> `loadMusicXml`, updating `#omr-status`. Gotcha: `tsc` only includes `src/`, so `functions/` is not typechecked by `npm run typecheck`; keep it valid TS by hand. Vitest (no config) globs `**/*.test.ts`, so `functions/api/_omr.test.ts` runs alongside src tests.

- **2026-05-30 - OMR trigger: browser upload -> Cloudflare Pages Function proxy -> GitHub `repository_dispatch` -> runner, with R2 as the file transport both ways.** Only a tiny authenticated hop needs a GitHub token, so it lives server-side in a Pages Function (same Pages project, under `functions/api/`, no separate Worker), never in static assets. End-to-end shape: (1) browser POSTs the image/PDF to the Function (`/api/omr`), which holds a GitHub fine-grained PAT (this repo, Actions read/write) as an encrypted secret and has an R2 binding; (2) the Function validates type+size, makes a jobId, writes the upload to R2 (`uploads/<jobId>`), then fires `repository_dispatch` (event_type `omr-job`, client_payload `{ jobId }`), a tiny payload well under the ~10 KB client_payload limit; (3) the Actions workflow (unlimited minutes on a public repo) pulls the image from R2 via an R2 S3 API token (Actions secret), runs oemer (homr fallback), emits MusicXML; (4) the runner writes MusicXML to R2 (`results/<jobId>.musicxml`); (5) the browser polls the Function (`/api/omr/result?jobId=`), which reads R2 and returns 200 + MusicXML when ready or 404 while pending, so R2 stays server-side; (6) the MusicXML feeds the existing extractScore -> visualizer. Why this mechanism: Pages Functions run on the Workers free tier (100k requests/day shared with Workers, 10ms CPU/invocation), which a thin dispatch + R2-put proxy never strains because OMR runs on the runner, not the Function; R2's free tier (10 GB-month, 1M Class A + 10M Class B ops/month) carries both transfer directions and sidesteps both the ~10 KB payload ceiling and the auth-required, zipped Actions-artifact download path. Rejected alternatives: inline base64 image in the dispatch payload (the ~10 KB client_payload limit is far smaller than a real scan); return MusicXML as an Actions artifact (download needs auth even on public repos per actions/upload-artifact#144 and arrives as a zip, forcing extra proxy + unzip); return by committing MusicXML to the repo and reading raw.githubusercontent (works and needs no token, but pollutes git history, needs cleanup, and races on concurrent writes, so kept only as a fallback); embedding a GitHub token in the static frontend for client-side dispatch (leaks a privileged token in public assets, non-starter); an Issues/PR-based trigger carrying the image (still needs a token-holding backend for anonymous users and pollutes Issues); a standalone backend/queue service (a maintained or paid server, which defeats the free static + job-based-Actions design). Abuse/safety (note only, do not build yet): cap upload size and validate MIME at the Function, add a free Cloudflare WAF per-IP rate-limit rule, optionally gate upload with free unlimited Cloudflare Turnstile, and use an Actions concurrency group to coalesce queued runs; public-repo Actions minutes are unlimited so the risk is noise and attention, not cost.

- **2026-05-30 - OMR runs in GitHub Actions, not in-browser or in a serverless function (SPIKE #4).**
  Decision: an asynchronous, job-based pipeline. User uploads a PDF/PNG of sheet music; that
  triggers a GitHub Actions workflow that runs the open-source engine **oemer** (homr is the
  fallback engine) headless on the runner; the job outputs **MusicXML**, which is served back as
  a build/job artifact and fed unchanged into the existing `extractScore` -> visualizer pipeline.
  Real-time, in-request OMR is not feasible on any free tier, so we go offline/async on purpose.
  - **Why GitHub Actions:** the repo is public, so Actions minutes are **unlimited and free**
    (matches the hard constraint). Runners are full Linux VMs with enough CPU/RAM/disk to run
    oemer's PyTorch/onnx pipeline and its multi-hundred-MB models; both oemer and homr already
    ship a headless CLI/Docker path and emit MusicXML directly. Inference is minutes-scale, which
    is fine for an async job but fatal for a request handler.
  - **Rejected - client-side WASM OMR:** no reusable open-source browser OMR engine exists today.
    QuickStave proves it is possible but is proprietary and trained its own TS model; via CheerpJ,
    Audiveris took ~170s and oemer ~100-340s in-browser. Nothing free to adopt, and the runtime
    cost lands on the user's device.
  - **Rejected - Cloudflare Pages Functions / Workers (or similar free serverless):** free tier is
    10ms CPU per request, 3 MB compressed bundle, 128 MB memory. oemer/homr need heavy ML runtimes,
    hundreds of MB of models, and minutes of compute. Categorically impossible, and pushing usage
    up would breach the uncapped rule.
  - **Rejected - klang.io managed API:** free tier is a 20-second demo only, then a ticket-based
    paid subscription. Paid and capped, so it violates the free/uncapped project rule outright.
  - **Integration shape:** input PDF/PNG -> OMR job on a GitHub Actions runner (oemer; homr fallback)
    -> MusicXML artifact -> existing `src/score.ts` `extractScore` -> visualizer. No change to the
    sync invariant: OMR only produces the MusicXML that the current pipeline already consumes.
    Local dev machine can run the same oemer CLI for fast iteration. (Engine wiring + the
    upload/trigger UX are implementation work, not part of this spike.)

- **2026-05-30 - Input is MusicXML, not MIDI.** MIDI carries no real notation (no
  beaming, enharmonic spelling, voicing), so readable sheet music can't be reconstructed
  from it. MusicXML is also exactly what the future OMR stage outputs. Visualizer was
  built first (MIDI) then switched to MusicXML once the sheet view was added.

## Gotchas

- **OSMD pitch -> MIDI:** `note.halfTone + 12` (OSMD halfTone 0 = C0; MIDI C0 = 12).
- **OSMD container needs width to render**; height can be 0. The sheet div must be in the
  DOM and laid out before `osmd.render()`.
- **Tone.js timing == cursor timing.** Advance the OSMD cursor off `Tone.getTransport().seconds`,
  never a separate clock.
- **Preview/dev gotcha:** multiple stale preview frames can each run the app and flood the
  console; verify against a single fresh frame when debugging.
- OSMD's bundle is large (~1.4 MB). Fine for now; revisit code-splitting if startup lags.
