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
