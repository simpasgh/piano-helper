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
