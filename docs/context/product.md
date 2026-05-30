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
