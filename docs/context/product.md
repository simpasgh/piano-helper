# Product context

Market, competitors, features, business, roadmap. Append durable learnings at the top of
the relevant section, dated.

## Vision

Drop in piano sheet music (PDF/image) and watch it play as a Synthesia-style falling-notes
performance on an animated piano, with the score highlighted in sync. Make the fragmented
"scan -> convert -> visualize" workflow a single seamless experience.

## Roadmap (slices)

1. **Falling-notes visualizer** — done (MIDI, then MusicXML input).
2. **Synced sheet view** — done (OSMD sheet + highlight cursor synced to the falling notes).
3. **OMR** — convert sheet PDF/image to MusicXML by wrapping an existing engine
   (open-source [oemer](https://github.com/BreezeWhite/oemer) or the klang.io API).
4. **Correction UI** — review and fix OMR mistakes before playback.

## Decisions

### 2026-05-31 - OMR backlog reconciliation against the Clarity-OMR migration (#135/#142)

The PDF recognition engine changed: Clarity-OMR is now PRIMARY for PDFs (reads the PDF directly via
pymupdf + YOLO, tie-aware, 145 notes on icarus vs oemer's 109/128, two stdlib post-transforms
merge_to_grand_staff + normalize_ties). oemer/homr survive ONLY as a fallback and for PNG/JPEG
uploads. Reviewed the 7 open OMR tickets against this; verdicts (orchestrator to apply via gh):

- **#112 (DPI sweep) -> CLOSE as obsolete.** The whole ticket is about tuning pdftoppm DPI feeding
  oemer. Clarity reads the PDF directly and does NOT rasterize on the PDF path, so the sweep no longer
  governs PDF recall. DPI only matters for the PNG/JPEG fallback path now, which is not where the
  fidelity complaints came from. Done as a primary-path lever.
- **#88 (raise raw OMR fidelity, engine selection) -> CLOSE as obsolete.** This spike's central
  question, "engine selection ... whether running both and picking the better MusicXML is feasible,"
  has been ANSWERED and ACTED on: we evaluated Audiveris, olimpic/Zeus, and Clarity, and shipped
  Clarity as primary. The spike's premise (oemer/homr config + preprocessing + which engine) is spent.
  Remaining fidelity gains are either engine-internal Clarity tuning (full-beam/DPI, an engine-side
  question per #135) or handled by the correction UI. File any future engine-tuning as a fresh,
  Clarity-specific ticket rather than reopening this oemer-era umbrella.
- **#130 (evidence-based tie-arc raster post-pass) -> CLOSE as wontfix.** The ticket explicitly
  self-conditions: "If the new engine captures ties cleanly on real scores, this may be unnecessary,
  close as wontfix." Clarity now emits ties natively and recovered the icarus RH E6 cross-barline tie
  end to end. The spike's raster detector was oemer-geometry-specific (notehead_extraction.extract,
  staff_pred) at 1/9 precision; it is moot against a tie-aware engine. The ONE residual gap (terminal
  dangling LH tie on the final measure) is an engine-side pairing/DPI question, not a raster post-pass.
- **#118 (close honest recall gaps without fabricating) -> RE-SCOPE.** Still valid (recall is never
  "done" and fabrication-safety is permanent), but the body is oemer-era. Stale claims to fix: (1)
  "oemer+homr worker" -> now "Clarity-OMR primary for PDFs (oemer/homr fallback + image path)"; (2)
  "~109-128 range depending on DPI" -> "Clarity ~145 notes on icarus; the per-DPI numbers were the
  oemer path and are stale for PDFs"; (3) "only 4 of 27 bars retained a triad" -> re-measure on
  Clarity output (not yet quantified per-bar). Candidate levers also drift: drop the DPI-sweep (#112)
  and stronger-engine (#88) levers (both resolved by the migration); the remaining honest lever is the
  correction UI (#6/#105). Keep the no-fabrication acceptance and the fidelity-on-icarus-by-eye gate.
- **#113 (complete LH chords post-pass) -> CLOSE as wontfix.** Already attempted in #114 and REVERTED
  in #116 as fabrication (pattern-stamped a guessed harmony, invented Fa# across natural triads). The
  approach is forbidden by the no-fabrication rule regardless of engine, AND Clarity's higher recall
  (145 vs 109) recovers more LH tones for free, so the premise ("LH triads 4 -> >=10 via post-pass")
  is both unsafe and partly obsolete. Genuine remaining LH gaps go through the correction UI.
- **#105 (correction UI #6a: pitch nudge + delete) -> KEEP as-is.** Engine-agnostic UI work on the
  in-memory score.notes array. The Clarity migration does not touch it; if anything it raises its
  value as the one honest fidelity escape hatch.
- **#6 (correction UI epic) -> KEEP as-is.** Engine-agnostic parent epic, now the active feature. The
  migration reinforces it: native ties reduce one error class, but octave/chord/recall errors remain,
  so a human-in-the-loop review step is still the linchpin (per the phased roadmap).

Net: 4 closes (#112, #88, #130, #113), 1 re-scope (#118), 2 keep (#105, #6). The Clarity migration
retired the oemer-era preprocessing/engine-selection/post-pass cluster; the durable backlog is now
the correction UI line plus a fresh Clarity-specific tuning ticket if/when needed.

### 2026-05-31 - Monetization model: launch FREE, gate on conversion volume, add a one-time Pro unlock later (NOT a subscription at launch)

- **Chosen model: free product with a hard daily/monthly conversion cap, plus a future one-time
  "Pro" unlock (lifetime, ~$29-39) that raises the cap. NOT a freemium subscription at launch.**
  Rationale: a solo founder on free-only infra cannot honestly promise "unlimited conversions"
  because every OMR scan burns real CPU on a single free VM (the throughput ceiling). A
  subscription creates an ongoing support + churn + billing burden that does not fit a hobby-scale
  free-infra product. A one-time unlock matches Synthesia's proven model (~$29-39 one-time), needs
  no churn management, and the cash can directly fund the one paid thing we would ever buy
  (overflow compute) without committing to recurring server cost.
- **The compute cost cliff is the load-bearing constraint, not pricing psychology.** One oemer
  conversion takes ~3-6.5 min of CPU wall-time (infra round-2 entry: ~6.5 min at 400 DPI, now 350
  DPI so somewhat faster, call it ~4-5 min, GUESS). The conversions are strictly serial on one
  worker, so the ceiling is TIME, not dollars: ~12-20 conversions per CPU-hour, so even running the
  free VM 24/7 caps the whole product at very roughly ~290-480 conversions/day GROSS, and far less
  in practice because the Mac interim host is not 24/7. The Cloud Run fallback is capped at ~50
  instance-hours/mo of CPU-active time = only ~600-1000 conversions/MONTH before it leaves the free
  tier. **That ~600-1000 conversions/month is the real product ceiling to design pricing around.**
- **Free-tier cap to stay solvent (recommendation): 3 conversions/day and 10/month per user,
  unauthenticated, keyed by a soft signal (cookie/localStorage + light IP rate-limit).** This keeps
  total demand under the VM ceiling at low user counts and makes "unlimited" a paid-only promise we
  can throttle. NEVER ship "unlimited free conversions"; it is the one thing that makes the product
  lose money per user the moment it outgrows the free VM.
- **Kill metrics the founder must watch:** (1) **conversions/day vs the worker ceiling** (when the
  queue wait exceeds ~10 min consistently, the free VM is saturated and you are about to pay for
  compute or degrade UX); (2) **free->paid conversion on the Pro unlock** (need it to clear the
  blended cost of overflow compute; if < ~1% you do not have a business, only a cost center).
- **Why not a subscription (PlayScore ~$35-50/yr, Soundslice ~$50/yr, learning-app norm ~$120/yr):**
  those companies pay for staff + servers and amortize via recurring revenue. We have neither cost
  base nor the operational appetite. A subscription also implies an SLA on conversion speed we
  cannot give on one free VM. Revisit a subscription ONLY if conversion volume forces paid compute
  AND retention data shows repeat weekly use (the learning-app pattern). Full numbers + 3-scenario
  revenue model delivered to the founder 2026-05-31.

### 2026-05-31 - Naming & domains

- Leading name: **PlayMyScore** (playmyscore.com + .app confirmed available via whois). Brandable
  and doubles as the keyword "play my sheet music." Use the consumer term "sheet music" (not
  "score") in SEO/landing copy even though the brand says "Score".
- Other confirmed-free .com (+.app): sheetfall, notecade, fallkeys, keysfall.
- Top original picks Notefall and Scrollo have BOTH .com and .app taken (branding tax, deprioritized).
- DNS NS/SOA absence + whois "No match" is a strong availability signal; registrar checkout is the
  final word. Avoid trademark-crowded music words (Aria, Cadenza, Cascade, Lumina).

### 2026-05-31 - Go-to-market plan (90-day, solo founder)

- Positioning: **"Synthesia, but it reads YOUR sheet music. No catalog, no lock-in, free."**
  Audience anchor = adult self-taught beginner who has a specific piece they want to play.
- Honesty-as-feature: surface the "review and fix" step near upload + in an FAQ; pre-empts the #1
  launch complaint ("the notes were wrong"). NEVER market "perfect transcription"; we win on
  experience + free + bring-your-own-sheet, not accuracy.
- Channel rank for a solo founder: (1) **SEO** (compounding, exact-match intent: "sheet music to
  synthesia", "convert sheet music to falling notes", "synthesia alternative free no download");
  (2) **Reddit/communities** (r/piano, r/pianolearning, adult-beginner FB groups; lead with a demo
  clip not a link, reply to every comment for 24-48h, honor self-promo rules); (3) **shareable demo
  loop**.
- KEY insight tying GTM to infra: the viral share-unit must be a **PRE-RENDERED watch-only clip**,
  NOT a live conversion, so virality does not melt the ~600-1000/mo worker ceiling. The in-app
  "share your result" must produce a watch-only replay that does NOT re-run OMR.
- Launch sequencing (stagger, never same-day blast): soft launch -> Product Hunt (Tue/Wed 00:01 PT)
  -> Show HN -> big Reddit posts. PH/HN buy credibility + a small first cohort, not a hockey stick.
  Durable growth = the slow SEO keyword cluster + the clip flywheel, both started day one.
- GTM metrics: **activation rate** (upload-started -> conversion-completed -> playback-started,
  target >25%), **share rate**, and **top ACTIVATING source** (not top by raw volume).

### 2026-05-31 - Soundslice threat read (the one competitor that could copy the wedge)

- Soundslice is the only player with BOTH OMR quality AND the product surface to copy the wedge.
  But honest probability they ship a true falling-notes mode in 12-18mo is **LOW (~20-30%)**.
- Why low: audience mismatch (they serve notation-literate musicians + teachers, not non-readers);
  founder (Holovaty) is customer-led and anti-gamification; falling notes has no clear ROI for their
  B2B/teacher/embed revenue; their roadmap is all notation-centric depth (dynamics, stems, audio
  transcription "holy grail"). Their piano view is a static key-lighting aid, NOT a falling runway.
- Risk is **INCIDENTAL not strategic**: falling notes is ~1 engineer-month for them, so NEVER let
  the feature be our moat. Defensible moat = the COMBINATION (free + no-account + non-reader +
  falling-notes-first) sold to a segment they deliberately do not serve. Their scanning is paywalled
  + sign-up-gated; our no-account, free-at-moment-of-need first run is a structural edge.
- Do NOT compete on OMR accuracy (we lose). Early-warning signals: a piano-roll/falling toggle ships,
  scanning becomes free/expanded, beginner/"learn without reading music" messaging appears, or a free
  consumer mobile app. Monitor their blog RSS + Holovaty's feed; quarterly check for "falling".

- The Gap 1 diff audit (the gating deliverable) ran and SETTLED the question: ties, arpeggio
  rolls, and metadata (title/tempo/dynamics) are all ENGINE-dropped by oemer (absent from its raw
  MusicXML), not lost in our pipeline. There is no fabrication-safe pipeline fix for any of them.
- The one "audible + maybe fixable" gap (cross-bar ties) was REJECTED for build: icarus's LH is
  un-tied whole-note triads that share tones across barlines, so reconstructing the dropped tie by
  merging adjacent same-pitch notes would silence legitimately re-struck notes (an audible
  regression, the #113 overreach class). User chose "defer build, close #121 on the audit."
- **Net:** #121 closed as a completed spike (deliverable = the audit). Build work (stronger recall
  + native tie/arpeggio/metadata) deferred to #88; user corrections go through the #6/#105 UI. No
  app code changed; this was an honest "the engine, not our code, is the ceiling here" finding.

### 2026-05-31 - icarus re-scan round 3: NEW ticket for arpeggios + ties + diff audit, do NOT bury in #118

- **Context:** user re-scanned icarus.pdf after the 350-DPI merge (#118/#120). Verdict "better
  but still not there." Three explicit gaps: (1) broad "audit ALL diffs PDF vs output, not just
  headline ones"; (2) arpeggios (arpeggiato, rolled chords with the wavy vertical line) still
  not generated; (3) ties across barlines (e.g. the final two tied whole notes in 4/4, incl. one
  in the bass staff) not reproduced as one sustained sound.
- **Decision: file ONE NEW ticket, not extend #118.** #118 is scoped specifically to "honest
  recall gaps without fabricating pitches" (arpeggios landing as RESTS, dropped notes, collapsed
  LH chords) and is mid-flight after the #113 revert. The new asks are a different shape:
  arpeggio and tie handling are about preserving *articulation/duration semantics* that exist in
  the MusicXML or need to be read from it, plus a structured *diff-audit* deliverable. Folding a
  diff audit + two new feature behaviors into a recall ticket would muddy its acceptance criteria
  and its measurable target. Keep #118 tight; the new ticket can reference and de-dupe against it.
- **Overlap call on arpeggios:** #118 already notes "arpeggios as rests" as a RECALL symptom (the
  notes vanish). The NEW ticket owns the *positive* behavior: once the pitches survive, render the
  chord as a rolled/sequential strike (or at minimum a simultaneous chord, never a rest). If #118
  ships first and stops arpeggios becoming rests, the new ticket's arpeggio item shrinks to the
  roll articulation only. Cross-link both; whoever lands first updates the other.
- **Why a spike-flavored first step, not a straight feature:** we do not yet know whether oemer
  even emits <arpeggiate> or correct <tie>/<tied> for icarus, or whether it drops them upstream.
  The honest first deliverable is the diff audit (read the generated MusicXML against the PDF and
  enumerate every divergence), which tells us if these are parser gaps in OUR pipeline (cheap fix)
  or engine gaps in oemer (harder). Label type:spike + type:feature, area:omr + area:viz,
  priority:high. The audit gates the build.
- **Hard constraint carried forward (post-#113):** never fabricate pitches. Ties and arpeggios
  must be read from the MusicXML oemer produces, not invented. If oemer drops a tie, we may
  reconnect two adjacent same-pitch notes ONLY when both already exist; we never add a missing
  note to complete a tie. Arpeggio roll is presentation of pitches already detected.
- **Success measure:** structured diff table for icarus.pdf (per measure: pitches, durations,
  ties, arpeggios, dynamics, tempo, title) with each row marked match/miss/extra; plus the two
  named cases pass end to end (rolled chord plays as a roll or chord not a rest; final tied whole
  notes sustain across the barline as one note in both staves).

### 2026-05-31 - OMR fidelity round 2: ship LH chord-completion post-pass, NOT the DPI sweep

- **Context:** after #109 (400 DPI + stitch + no-deskew, merged + deployed), QA's icarus.pdf
  end-to-end run showed the headline LH-chord gap only partly closed (oemer recovers an LH
  chord in just 12 of 27 measures, 8 dyads + 4 triads, where the source has a triad in nearly
  every one of the first ~16 bars) AND total recall DROPPED 128 -> 109 with scan time up to
  ~6.5 min. Open follow-ups: #112 (DPI sweep 300/350/400/500), #88 (umbrella fidelity spike),
  #6/#105 (correction UI, deferred).
- **Decision: the single next increment is a bounded MusicXML post-processing pass that
  completes detected left-hand chords, NOT the DPI sweep and NOT an oemer+homr ensemble.**
  Filed as the next #88 child.
- **Why override the "DPI sweep first" prior:** the sweep is cheap but low-ceiling and the
  evidence says DPI is already past oemer's sweet spot (300 -> 400 LOST 19 notes). A sweep
  yields a tuning number, not the feature the user asked for, and costs ~6.5 min per data
  point. It is worth running as a quick parallel tuning chore (keep #112 open, priority:med),
  but it is not THE leverage move and will not close the LH-triad gap.
- **Why not the ensemble (yet):** running both engines and picking/merging the better
  MusicXML is the right long-term move but is research-shaped for one PR: two different
  MusicXML schemas, homr is only a crash fallback today (unproven on a real grand staff), and
  "merge two scores" reintroduces note-invention risk. Keep it in the #88 spike, not this PR.
- **Why chord-completion is the highest-leverage tight slice:** the user's literal complaint
  is "left hand collapses to single notes." The fix is additive and bounded: where oemer
  already emitted a left-hand chord shape, complete same-rhythm LH single-notes/dyads to that
  detected shape. It targets the exact reported gap, fits one PR, and is measurable on
  icarus.pdf (LH triad count 4 -> target, dyad+ measures 12 -> target, total recall 109 -> up).
- **Scope discipline / non-goals:** chord completion ONLY. Explicitly DEFER octave/pitch
  repair (gap 2: that path fabricates wrong pitches, high risk) and rhythm correction to the
  #88 spike. The pass must be conservative: never invent a chord in a measure where oemer
  found no LH chord evidence, and never touch the right-hand/melody staff. Stays on free
  tooling (pure Python in worker.py on the MusicXML already produced), R2 contract untouched.

### 2026-05-31 - OMR fidelity: first #88 child is image preprocessing, defer note heuristics

- **Context:** user re-scanned their clean 1-page vector PDF icarus.pdf (the #88 fixture).
  Result "better than before but still not accurate." Observed gaps: (1) left-hand bass
  triads collapse to single/2-note; (2) right-hand rhythm drift mm. 9-15; (3) octave/pitch
  slips; (4) lost tempo/dynamic/title (cosmetic).
- **Scoped ONE shippable ticket: worker-side image preprocessing only** (raise pdftoppm DPI
  300 -> 400-600, run oemer `--without-deskew` on the vector-PDF path, optional gated
  grayscale/binarization). Labels: type:fix, area:omr, priority:high. First concrete child
  of spike #88.
- **Key technical fact:** oemer has NO DPI/quality flag (CLI is just `-o`, `--use-tf`,
  `--save-cache`, `-d/--without-deskew`). The raster we hand it is the ONLY preprocessing
  lever we own. So the highest-leverage free move is upstream, in `rasterize_if_pdf`. oemer
  auto-deskews by default; for an already-straight vector PDF that can warp it, hence
  `--without-deskew` on the PDF path only (keep deskew for photo/PNG inputs).
- **Deferred deliberately:** chord-completion and rhythm-correction post-processing on the
  MusicXML (gaps 1+2). That is note-level inference, high-risk (can fabricate wrong notes),
  belongs in a separate #88 spike. Better input pixels should recover SOME dropped tones for
  free, so we ship the safe pixel win first and measure. Metadata recovery (gap 4) stays out
  as cosmetic: src/sheet-name.ts fallback already handles the missing title gracefully.
- **Rationale:** smallest slice that moves fidelity, zero new note-invention risk, stays on
  free tooling (Pillow/OpenCV/poppler on the Oracle VM), R2 transport contract untouched.
  Acceptance is measurable: before/after note-head counts per measure on icarus.pdf, plus
  wall-clock time cap.

### 2026-05-31 - Issue #6 correction UI: DEFER from autonomous sweep, split into slices

- **Recommendation: do NOT one-shot #6 in an unattended backlog burn.** The full ask (select a
  note, change pitch/duration, add/delete, re-sync sheet + falling + audio, persist) is a
  multi-PR feature for this codebase. The pipeline is strictly one-way and read-only today:
  `MusicXML -> osmd.load -> extractScore -> ScoreData.notes -> visualizer + Tone.Part`. There is
  no note identity (`VisNote` has no id), no canvas hit-testing, no selection model, and no
  persistence layer at all.
- **The hard part is OSMD, not audio.** Rebuilding playback after an edit is cheap (`loadNotes`
  already rebuilds the `Tone.Part` from `score.notes`). Making an edit survive on the printed
  sheet means mutating the OSMD model + re-render, or re-serializing MusicXML and reloading, while
  keeping the highlight cursor and `stepTimes` correct. That is research-shaped, not a weekend
  feature.
- **Thin first slice that dodges OSMD (proposed #6a):** click a falling BAR to select it, then
  nudge its pitch +/- a semitone (arrow keys / two buttons) plus DELETE a spurious note. Implement
  against the in-memory `score.notes` array only: add an id to `VisNote`, add canvas hit-testing
  (the visualizer already computes every bar's geometry), mutate `midi` / splice, then reuse
  `visualizer.setNotes` + the existing Part rebuild. Audio and falling view re-sync for free.
  Leave the OSMD sheet out of v1: the edited bar visibly diverges from the printed sheet, which is
  honest and avoids the MusicXML round-trip. Wrong pitch is the most common OMR error a beginner
  can both spot and fix; delete is trivial. OUT of v1: duration edit, add-note, write-back to the
  sheet, persistence.
- **Why defer the one-shot:** even the thin slice adds the app's first editing interaction and
  first mutable selection model, and forces a product call the agent can't make: when an edit makes
  the falling view disagree with the SYNCED sheet (our differentiator), what does the user see?
  That needs a designer/PM spike first.
- **Split:** spike (selection affordance canvas vs sheet, sheet-divergence behavior) -> #6a (pitch
  nudge + delete, falling-view only) -> #6b duration -> #6c add note -> #6d sheet write-back +
  persist. Each follow-up is weekend-sized once the spike sets the interaction model. Keep #6
  priority:med.

### 2026-05-30 - Issue #37 per-hand control: two mute toggles, not sliders

- **Decision: ship two per-hand MUTE toggles, "Right hand" and "Left hand", both default ON
  (audible).** Tapping one mutes that hand's AUDIO while its notes keep falling silently. Solo
  is achieved by muting the other hand, so there is NO separate solo control. This is the
  smallest control that delivers the ticket's core practice value ("bring up one hand, quiet
  the other") and reads instantly.
- **The toggles appear ONLY when the loaded score has BOTH a right-hand and a left-hand note
  set.** For single-staff or audio-derived scores (no reliable hand split, all "unknown" per
  #36), they stay hidden and the single master volume governs playback. This is the graceful
  fallback the ticket asks for.
- **OUT of scope for v1 (explicitly deferred):** per-hand volume sliders, a balance slider,
  presets ("melody focus" / "accompaniment focus"), cross-session persistence of the mute
  state, and per-hand timbre. Revisit only if playtests ask for partial balance rather than a
  hard mute.
- Builds directly on #36 (shipped), which tags every `score.notes` entry with
  `hand: "left" | "right" | "unknown"` from the MusicXML staff (treble = right, bass = left).
- Muting is audio-only: notes keep falling so the player still sees the muted hand's part,
  which is what makes "watch one hand while hearing the other" work.

### 2026-05-30 - Issue #19 audio-to-score: drop YouTube, ship file-upload-only reduced slice

- **YouTube URL ingestion: NO-GO.** YouTube ToS prohibit accessing content through any means
  other than the playback page, embed player, or explicitly authorized means, and bar
  third-party download/extraction tools. A hosted public app that pulls audio from a pasted
  YouTube URL is a clear ToS breach (breach of contract) and a known DMCA/anti-circumvention
  risk. Google actively enforces (blocks/DMCA against downloader services). Independent of
  legality, our runtime can't do it anyway: Cloudflare Workers can't run yt-dlp/ffmpeg/native
  binaries, so YouTube extraction is also technically off-table here.
- **Decision: drop YouTube from #19 scope entirely (option a), do NOT block the whole ticket.**
  File upload of audio the user owns (MP3/WAV) carries no YouTube-ToS problem and is the part
  that delivers value. No human legal gate is needed to ship audio-file upload. Revisit
  YouTube only if we ever embed the official player without extracting audio (different
  feature, different value).
- **First slice (demo-grade, free/client-side):** file-upload MP3/WAV -> in-browser pitch
  detection producing a single-line melody track that feeds the existing score.ts ->
  visualizer + synced sheet pipeline. Use a client-side model (e.g. Spotify Basic Pitch /
  ONNX in-browser, or a monophonic pitch-detector like pYIN/CREPE-tiny via WASM) so transcription
  runs on the user's device at zero hosting cost and within the no-native-binary constraint.
  Scope it as **monophonic / dominant-melody transcription**, not full polyphonic piano.
  Full polyphonic two-hand transcription is a research project, explicitly out of this slice.
- **Set expectations in copy:** "best for single-melody clips", show a correction step (reuse
  slice 4 correction UI rationale), since automatic transcription is approximate.
- **Recommendation to orchestrator: SHIP-REDUCED-SLICE (file-upload-only, monophonic).**

### 2026-05-30 - Slice 3 (OMR) is async, not instant (issue #4 spike)

- OMR ships as a job-based "upload now, ready in a short wait (minutes)" flow, not real-time
  conversion. A free GitHub Actions job runs open-source oemer (homr fallback) to produce
  MusicXML that feeds the existing visualizer. Real-time in-browser/serverless was ruled out:
  no free tier can run the heavy ML pipeline in a request.
- Product/UX: upload copy and flow must set the expectation of a short processing wait, not
  instant. Show progress/job state. Slice 4 correction UI still applies since OMR accuracy on
  real scans is imperfect.
- Stays within the free/uncapped constraint: no paid OMR API (klang.io ruled out on
  cost/caps, 20s demo then paid).
- Known UX tradeoff: the wait is a friction point. Revisit if a faster free path (mature
  browser-WASM OMR, better free tier) appears.

## Market (researched 2026-05-30)

- The pieces exist **separately**: OMR tools (Scan2Notes/klang.io, PlayScore, ScanScore,
  Newzik; open-source oemer/homr/SheetVision/cadenCV) and Synthesia-style visualizers
  (Synthesia, NoteRain). Nobody offers a polished single "drop a score, watch it play" flow.
  **That seamless flow is the differentiator.**
- OMR is the hard part; accuracy on real-world scans is imperfect even for commercial tools,
  so a correction step is expected (ScanScore highlights likely errors for review).
- Audio/YouTube -> notes (e.g. PianoConvert) is a different, very popular input worth
  considering later; arguably easier and higher-demand than scanned sheets.

## Business / constraints

- Must stay on **free, uncapped (or very-large-cap) tooling** — see
  [infrastructure.md](infrastructure.md).
