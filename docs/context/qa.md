# QA context

Accumulated quality knowledge for Piano Helper. Newest entries first. QA owns this file.

## Post-merge QA results (newest first)

- 2026-05-30: PR #79 (Bug 2 / issue #44 follow-up: sheet rename now also updates the title
  drawn on the OSMD-rendered score, not just the toolbar label + tab title) -> **PASS** on
  `main` (merge commit 73c4284, deployed to https://piano-helper.pages.dev, smoke green).
  Local 5173 preview was stale (main worktree pinned at 453e37d, pre-#79), so drove LIVE
  against PROD in real Chromium via Playwright. Injected a 2-staff grand-staff MusicXML with
  `<work-title>Original Work Title</work-title>` (treble C5-G5 RH / bass C3-G3 LH).
  - Case 1 (original title): rendered SVG `<text>` reads "Original Work Title" (x=482,
    centered), toolbar = "Original Work Title", `document.title` = "Original Work Title -
    Piano Helper". The Piano part-name `<text>` (x=50) is separate and untouched.
  - Case 2 (rename via `#sheet-name` -> `#sheet-name-input` -> Enter to "Renamed By QA"):
    ALL THREE update. SVG title `<text>` -> "Renamed By QA" and RECENTERS (x 482 -> 502, no
    "Original Work Title" remnant anywhere on the sheet); toolbar -> "Renamed By QA"; tab
    title -> "Renamed By QA - Piano Helper". This is the exact Bug 2 fix.
  - Case 3 (cursor survives re-render): the green cursor stayed visible after the rename's
    `osmd.render()` and tracked on seek. Cursor `img.style.left` @0.0/@0.5/@0.9 after rename
    = 178.044/362.111/468.286px (monotonic), and @0.5 matched the pre-rename 362.111px exactly,
    so `resyncCursor(scoreTime)` restored the playhead to the right step.
  - Case 4 (rename WHILE playing): prod's audio clock DID run (time-readout 0:00 -> 0:01
    across the rename; cursor 220.311px -> 262.578px), unlike the known headless-suspended
    local env. Renamed mid-play to "Renamed While Playing": SVG title updated, playback kept
    advancing, cursor kept tracking, no stall. So the re-render + resync survives a live
    transport.
  - Case 5 (rename to the SAME text): no-op, no flicker, SVG `<text>` identical before/after
    (x=444 both), ZERO new console errors. Matches `updateSheetTitle`'s
    `sheet.TitleString === name` early return (main.ts:392-401).
  - Console: 0 errors, 0 pageerrors across load + rename + play + seek + no-op.
  - Mechanism (main.ts:392-401 `updateSheetTitle`): writes `osmd.Sheet.TitleString = name`,
    `osmd.render()`, then `resyncCursor(scoreTime)` + `renderSheetLabels(...)` since the
    re-render resets both the cursor and the label overlay. No-op for audio scores (`!hasSheet`)
    and when title already matches. Regression checklist clean: hand mutes + Balance present,
    solfege labels render, falling notes meet the keyboard, contact glow + hand caps render.
  - Driver + fixture (transient): qa-pr79-drive.mjs in worktree root (where node resolves the
    local `playwright`, freshly `npm i -D`'d here); grand.musicxml + screenshots at /tmp/qa-pr79/.
  - GOTCHA confirmed: the local dev preview (port 5173) is owned by the main checkout worktree
    and can lag merged `main` by several commits. Before trusting a local-preview QA run, check
    its served commit; when stale, drive PROD (whose bundle you can grep for the fix, e.g.
    `TitleString` appeared 7x in /assets/index-*.js here) instead.

- 2026-05-30: PR #78 (Bug 1: in-flight falling notes glow halo removed; only the keybed
  contact note glows) -> **PASS** on `main` (merge commit 2533c9c, deployed to
  https://piano-helper.pages.dev, smoke green). Drove live against the merged code (grand-staff
  MusicXML, Play, mid-playback frame): mid-screen falling pills (Re/La/Fa/Sol/Mi/Do at various
  heights) render as flat solid colored bars with NO halo; the bars touching the keyboard
  (purple Do, green Sol) show the bright #27 contact glow border. Console clean.
  - Bug 1 acceptance MET: in-flight bars calm, only the contact note highlighted.
  - Code delta is a single `ctx.shadowBlur` 18/20 -> 0 on the body fill (visualizer.ts:219);
    every neighbor reads its own state independently so the blast radius is just the body glow.
  - Regression checklist, no concerns: #27 contact glow still fires (shadowBlur 22, only when
    isActive && !muted && bar at keybed, visualizer.ts:255-265) and was observed bright on the
    contact bars; #36 hand caps render (light=R/dark=L, visualizer.ts:231-242); pitch hues and
    #67 two-pole name labels render; #54 muted ghosting and #33 off-range dim untouched.
  - No independent re-drive required: the observed frame exercises exactly the changed path.

- 2026-05-30: PR #75 (#70 per-hand volume Balance slider) -> **FAIL** on `main`
  (commit 95bfcb5), bug filed as #76. Drove it live in real Chromium via Playwright against
  the local preview synced to merged `main`. Injected a 2-staff grand MusicXML (treble C6-G6
  RH / bass C2-G2 LH) and a single-staff treble-only MusicXML.
  - PASS: control appears for the two-hands score, readout starts "L100 R100"; slider tracks
    +60 -> "L40 R100" and -60 -> "L100 R40"; clicking the readout resets to even.
  - PASS (audible proof): captured the actual WebAudio gain per note (hooked
    `AudioBufferSourceNode.start` + the connected `GainNode` gain target, since the bundled
    Tone is a separate module instance and prototype-patching `triggerAttackRelease` via a
    second `import` catches nothing). At +60 the per-note gains are exactly {0.40, 1.00}; at
    -60 the mirror. Mute isolation proved the mapping: with +60, muting RIGHT leaves only
    left-hand notes at gain 0.40, muting LEFT leaves only right-hand notes at 1.00. So mute
    layers correctly on top of a non-center balance, and the favored hand stays at full while
    the other is attenuated. Reload resets balance to even and clears mutes. Console clean.
  - FAIL (requirement: control hidden for single-staff/audio scores): the whole `#hand-mutes`
    group (both mute toggles AND the new Balance control) stays VISIBLE on a single-staff
    score. `handMutes.hidden = true` is set, but `.hand-mutes { display: flex }` in style.css
    (since #49) overrides the native `[hidden]` -> `display:none`, so computed display stays
    `flex` (rect 458x30, on screen). Pre-existing bug exposed again by #70. See #76 for fix
    (`.hand-mutes:not([hidden])` guard) + a computed-`display` regression check.
  - Driver + fixtures (transient): /tmp/qa-pr75/drive.mjs, qa-steps34-pr75.mjs,
    qa-vis-pr75.mjs (in the worktree root, where node resolves the local `playwright`);
    grand/single MusicXML at /tmp/qa-pr75/. Screenshots at /tmp/qa-pr75/*.png.

- 2026-05-30: PR #73 (fix: tag hands by clef so muting the right hand works on bass-first
  scores) -> **PASS** on prod (https://piano-helper.pages.dev, main @ be2ccaf). Drove live in
  real Chromium (Playwright). Reproduced the reported bug class with a hand-built bass-first
  MusicXML: `<staves>2</staves>`, staff 1 declared FIRST but bass (F clef, C3 whole note),
  staff 2 the treble melody (G clef, C5/D5/E5/F5). Pre-fix this inverts hands; the fix derives
  hand from clef.
  - Load: "Bass-First QA / 5 notes", play enabled, `#hand-mutes` visible, no console/page
    errors (only benign autoplay AudioContext warnings).
  - Hand tagging correct despite bass-first order: falling-note caps show the C3 bass bar with
    a DARK (left) cap and the C5-F5 melody with LIGHT (right) caps. This is the inverse of the
    bug.
  - Right-hand mute: button goes aria-pressed=true (left stays false); the RIGHT melody notes
    ghost/dim while the LEFT bass Do stays bright. Unmute restores. Left-hand mute: the mirror,
    only the LEFT bass Do ghosts. The audio gate keys off the same `note.hand`, so correct
    ghosting == correct audio mute. The regression (muting silences the WRONG hand) is gone.
  - NOTE on audio: real playback advancing + actual sound output cannot be verified headlessly
    (autoplay-gated AudioContext, no speakers). Verified instead via the on-screen hand cue and
    per-hand ghosting, which share the exact tagging the audio mute uses. Audio audibility
    itself remains technically unverified by automation; the tagging it depends on is verified.
  - Gotcha found: `#track-name` always contains a hidden "No file loaded" placeholder span even
    after a load, so do NOT gate "loaded" on its text. Gate on `#play-btn` becoming enabled.
    Also the canvas id is `#stage` (not note-canvas). Pixel-sampling the minified canvas for cap
    luminance was unreliable (averaged into the bg gradient); the SCREENSHOT is the authoritative
    read for hand-cap color and ghosting. Driver + bass-first fixture: /tmp/qa-pr73/ (transient).

- 2026-05-30: PR #62 (#42 falling-note dedup + #43 approaching-key labels) -> **PASS** on
  prod (https://piano-helper.pages.dev, commit 3b8c6a6). Drove it live in real Chromium via
  Playwright (installed locally: `npm i -D playwright` + `npx playwright install chromium`;
  neither was present before). Injected a 2-staff MusicXML with a RH C5 x3 repeat run + E5,
  a LH G3 x2 run + a C3/E3/G3 chord, turned Names on (Letters), seeked the `#seek-slider`
  across the timeline and screenshotted.
  - #42 dedup: confirmed BOTH hands label only the first bar of a same-pitch run (RH C5 stack
    and LH G3 stack each show one name, repeats blank). The old RH-drop bug is gone. Chord
    pitches each keep their own label.
  - #43 approaching keys: confirmed key-face labels appear ONLY for keys whose note is
    approaching within ~4s or sounding. At a near-end frame with only D5 in window, exactly
    one key ("D") was labeled and every other white key was clean. Chords label every chord
    pitch (C/E/G all shown). Black keys never labeled.
  - No regressions in dimming/ghosting/per-hand color lanes; sheet cursor + note-name dedup
    in the sheet view also correct. Console: only benign "AudioContext was not allowed to
    start" autoplay warnings (headless, no user gesture); zero errors, zero pageerrors.
  - Note: in headless, pressing `#play-btn` does not advance the slider (audio clock gated by
    autoplay policy). Use `#seek-slider` input events to position the cursor for label QA;
    do not rely on real playback advancing time headlessly.
  - Tooling now available in this worktree's node_modules for future live QA: Playwright +
    Chromium. The driver script lives at /tmp/qa-pr62/drive.mjs (transient).

## How to drive the app in a real browser

- Only one dev preview server works at a time and it is bound to whichever worktree started
  it (port 5173). Background agents in their own worktrees cannot get a live preview, which
  is why pre-merge live QA is unreliable from an agent. The **live QA gate runs in the
  worktree that owns the preview server** (the orchestrator's), against `main` synced to the
  just-merged commit.
- There is no auto-loaded demo score (`track-name` reads "No file loaded" on boot). Inject a
  score by feeding a `File` to the hidden `#file-input` via a `DataTransfer` and dispatching
  a `change` event. A minimal two-staff (`<staves>2</staves>`, treble clef on staff 1, bass
  clef on staff 2) MusicXML gives you both hands; use 16th/eighth `<type>` notes to stress
  small-bar label fitting.
- `#seek-slider` drives playback position headlessly: set `.value` and dispatch an `input`
  event to move the cursor without needing audio.
- `#names-btn` cycles Off, Solfege, letters. Turn names on to test label features.

## Standing smoke checklist (run the relevant rows for each change)

- Load a grand-staff score: the per-hand mute toggles AND the Balance slider (both inside
  `#hand-mutes`) appear; a single-staff or audio score keeps them hidden. VERIFY BY COMPUTED
  DISPLAY, not just `el.hidden` (see gotcha below + #76): the `hidden` attr can be set while
  CSS keeps `display:flex`, leaving the control on screen.
- Per-hand Balance (#70): on a two-hands score the readout starts "L100 R100"; sliding to
  +N reads "L(100-N) R100" and -N reads "L100 R(100-N)"; the favored hand plays full and the
  other is attenuated to that percent; mute layers on top (a muted hand is silent regardless
  of balance); clicking the readout and any reload reset to even.
- Note names: scale to the bar and stay inside it; truly tiny bars omit the name rather than
  showing an oversized pill (#39).
- Falling notes meet the keyboard with no element wider than the note at the entry (#38).
- Contact glow (#27) and per-hand rail stripes (#36) still render.
- Browser console has no new errors after load, play, and the feature interaction.

## Known gotchas

- 2026-05-30: An element with an explicit `display` in CSS (e.g. `.hand-mutes { display:flex }`)
  is NOT hidden by setting `el.hidden = true`: the `[hidden]` UA rule (`display:none`) loses
  to the more-specific class rule, so the element stays on screen even though `el.hidden`
  reads `true`. Always confirm "hidden" by computed `display` / `getBoundingClientRect()`,
  not the attribute. This masked #76 (Balance + mute controls visible on single-staff scores)
  through several "the attr is set, looks fine" checks.
- 2026-05-30: To verify the AUDIBLE effect of a velocity/balance change headlessly, do NOT
  try to patch `Tone.<Synth>.prototype.triggerAttackRelease` via a second `import("tone")`:
  the app's bundled Tone is a different module instance, so the patch catches zero calls (and
  Tone prints its banner twice, a tell). Instead hook the single page-level WebAudio graph:
  wrap `AudioBufferSourceNode.prototype.start` and read the gain target on the `GainNode` it
  connected through (capture `connect` to map source->gain, and wrap `AudioParam`
  set/ramp methods to stamp the last gain). The sampler maps per-note velocity to that gain.
  Launch Chromium with `--autoplay-policy=no-user-gesture-required` and start playback with a
  real `.click("#play-btn")` so the transport actually advances (time-readout/seek move).
- 2026-05-30: The bundled /demo and small hand-rolled fixtures are SHORT (a 2-measure score is
  ~4s at 120bpm). A live-playback assertion that runs several seconds after pressing Play can
  capture zero notes because the score already ended/rewound. Seek the `#seek-slider` back to
  0 (input+change) right before each timed capture, or use a longer fixture.
- 2026-05-30: A toggle's `aria-pressed` style can read as unchanged if you sample
  `getComputedStyle` in the same tick as the click (mid CSS transition). Set the attribute
  and re-read, or wait a frame, before concluding the pressed state does not apply.
- 2026-05-30: Several early features (#37 per-hand mute among them) were merged with the
  delivery agent explicitly unable to verify live. Treat any "could not verify live" line in
  a PR as an open QA item until smoke-tested on `main`.
