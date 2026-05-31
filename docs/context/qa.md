# QA context

Accumulated quality knowledge for Piano Helper. Newest entries first. QA owns this file.

## Post-merge QA results (newest first)

- 2026-05-31: issue #135 / PR #142 (swap the OMR engine to Clarity-OMR as PRIMARY because it is
  the only free engine that recovers TIES/held notes on our material; oemer stays as fallback.
  Worker `run_clarity` runs the PDF directly in its OWN venv via subprocess, then UNCONDITIONAL
  post-transforms `merge_to_grand_staff` (collapse Clarity's 2 parts to 1 grand-staff part with
  `<staves>2</staves>`) + `normalize_ties` (pitch-matched pairing: close dangling starts across
  barlines, drop cross-pitch false positives) run on the output before R2 upload) -> **PASS**.
  FIRST live end-to-end QA that actually exercises TIES through the DEPLOYED Clarity pipeline
  (the #123 tie-merge QA used a hand-built fixture; #88/#109/#118 ran oemer, which emits ZERO
  ties). Worker `~/piano-helper-omr/worker.py` is the Clarity build (`run_clarity`,
  `merge_to_grand_staff`, `normalize_ties` present), restarted 21:44:11 with `CLARITY_OMR_DIR`/
  `CLARITY_PYTHON` in omr.env; `~/clarity-omr/.venv` + HF cache warmed.
  - FIXTURE = a GENUINE engraved 2-staff piano score with ties across barlines:
    `/Users/simonepasculli/Documents/MuseScore4/Scores/the cut that always bleeds.pdf` (Conan
    Gray arr., 2 pages A4, full grand staff, treble melody + bass block-chord LH, MANY tie/slur
    arcs incl. LH whole-note chords held across barlines). Rendered the source first
    (`pdftoppm -r 120`) to confirm real ties before scanning. icarus.pdf was NOT usable here (it
    has no ties). Reverie.pdf/Liminality.pdf are also genuine grand staffs on disk if needed.
  - REAL DEPLOYED FLOW (R2 transport, exactly as the app does it): `POST
    https://piano-helper.pages.dev/api/omr` multipart `file` (application/pdf) -> 202
    `{"jobId":"51b92cfd-ec85-4a21-ade0-2365353e7fe8"}`. Polled `/api/omr/result?jobId=...` every
    10s -> 404 pending, then **200 + 122169 bytes of real MusicXML** at ~140s. ENGINE PROOF (the
    headline): worker log `51b92cfd... recognized via engine output .../omr-ditdc0ya/
    clarity.musicxml` (NOT `oemer-out`) + `[stage-b-eval] inference on 22 samples (device=cpu,
    beam=2)` -> **Clarity won, no oemer fallback.** Movement-title "Music21 Fragment", music21
    v10.3.0 encoder (Clarity's writer), NOT the omr-status=failed sentinel.
  - ASSERTIONS on the DEPLOYED result vs RAW Clarity (I also ran Clarity directly via
    `set -a; . ~/piano-helper-omr/omr.env; set +a; $CLARITY_PYTHON $CLARITY_OMR_DIR/omr.py
    tied.pdf -o clarity-raw.musicxml --device cpu --fast --work-dir ...` to capture the
    pre-transform output, since the worker's tempdir is deleted post-job):

    | metric | RAW Clarity | DEPLOYED (merge+normalize) | gate |
    | --- | --- | --- | --- |
    | parts | 2 | **1** | (a) PASS |
    | `<staves>2</staves>` | none | **yes (every measure)** | (a) PASS |
    | clefs | 11x G then 11x F (2 parts) | **(num=1,G) + (num=2,F) per measure** | (b) PASS |
    | pitched notes by staff | all untagged | **staff1=250 (RH/treble), staff2=191 (LH/bass)** | (b) PASS |
    | total `<note>` / pitched / rests | 513 / 441 / 72 | **513 / 441 / 72 (identical)** | (d) PASS, 0 dropped |
    | tie start / stop markers | 49 / 50 | **49 / 49** | (c) |
    | VALID tie pairs | 44 | **49** | (c) PASS |
    | unmatched starts / stops | 5 / 6 | **0 / 0** | (c) PASS |

    (c) is the money result: raw Clarity emitted 5 dangling starts + 6 cross-pitch stops (e.g. an
    A4 stop with no preceding A4 start, a G4 start with no follower); `normalize_ties` dropped all
    11 false positives and closed the danglers, leaving **49 perfectly pitch+staff-matched
    start->stop pairs, ZERO unmatched/cross-pitch.** Sample valid pairs span barlines: G4 staff1
    m1->m2, E5 m2->m3, B4 m3->m4, A4 m5->m6, G4 m6->m7. Note count preserved EXACTLY (513/441/72)
    so transforms dropped no notes (d).
  - BROWSER (live OSMD on prod, real Chromium via the sibling todeoapp Playwright install, bundle
    `index-Btv4ZqcA.js`): loaded the deployed result via `#file-input` -> "Music21 Fragment",
    "392 notes" (the 441 pitched collapse via score.ts mergeTiedNotes on the 49 ties),
    `#hand-mutes` display:flex (BOTH hands = grand staff detected), Play enabled, **0
    console.error / 0 pageerror**. Screenshot /tmp/qa135/browser-loaded.png shows a piano-brace
    GRAND STAFF (treble G-clef 2/2 over bass F-clef), **tie/slur ARCS rendered** (long arcs over
    m3->5 and m9->10 in the treble), bass-clef "Do"/"Mi" block chords on staff 2, and falling
    notes colored by hand: **GREEN = Left hand (staff 2), PURPLE/violet = Right hand (staff 1)**,
    green sync cursor on beat 1. Visual confirms ties render and hands color correctly.
  - VERDICT: **PASS** on all four gates: (a) 1 part + `<staves>2</staves>`, (b) treble=staff1 /
    bass=staff2 with G@1/F@2 clefs and 250/191 split, (c) 49 valid tie pairs / 0 unmatched, (d)
    note count preserved 513/441/72. The Clarity swap recovers genuine ties end-to-end through the
    deployed R2 pipeline and the transforms clean its cross-pitch tie noise without dropping notes.
    This CLOSES the #135 post-merge QA gate.
  - METHOD / GOTCHAS for future Clarity-tie QA: (1) icarus.pdf has NO ties -- use a tie-bearing
    engraved score (`the cut that always bleeds.pdf`, Reverie/Liminality on disk are grand staffs
    too). VERIFY ties exist in the SOURCE (`pdftoppm` render) before scanning. (2) Engine attrib
    is in the worker log: `recognized via engine output .../clarity.musicxml` (Clarity) vs
    `.../oemer-out/stitched.musicxml` (fallback); also `[stage-b-eval] ... device=cpu beam=2` is
    the Clarity tell. (3) Clarity `--fast` CPU is ~0.15-0.2 samples/s; a 2-page score segments to
    ~22 staff samples = ~2 min/page; ~140s wall for this job (the app polls 15 min, fine). Do NOT
    run two Clarity jobs at once (I ran a direct probe concurrently and both slowed). (4) To get
    the PRE-transform Clarity output for the note-count/tie-pairing diff, run Clarity directly
    (the worker's tempdir is gone after the job); env via `set -a; . ~/piano-helper-omr/omr.env;
    set +a`. (5) The tie assertion = flatten notes in doc order, pair each `tie type=start` to the
    NEXT same-(step,alter,octave)+same-staff note carrying `tie type=stop`; count unmatched both
    directions. Artifacts under /tmp/qa135/ (tied.pdf, result.musicxml = deployed, clarity-raw.
    musicxml = pre-transform, analyze.py, drive.mjs, browser-loaded.png, source renders).

- 2026-05-31: PR #139 (the LH/RH mute toggles + Balance slider now show for ANY loaded score,
  not just grand-staff: every note gets a real hand, by clef for a 2-staff grand staff,
  otherwise a pitch split at middle C `HAND_SPLIT_MIDI=60` via `handFromPitch`; `#hand-mutes`
  is now unconditionally un-hidden after load, main.ts:257 `handMutes.hidden=false`) ->
  **PASS** on prod (https://piano-helper.pages.dev, served bundle `index-Btv4ZqcA.js`, which
  contains `handFromPitch`, the `mutedHands{left,right}` state + `hand-mutes` wiring). Drove
  live in real Chromium (Playwright 1.59.1 via the sibling todeoapp install). FIRST live QA of
  the always-visible hand controls on a SINGLE-staff score. This CLOSES the #139 gate.
  - FIXTURE = the shipped single-staff demo `https://piano-helper.pages.dev/demo.musicxml`
    ("C Major Scale", 2487 bytes, ONE `<part>` / ONE treble G-clef staff, NO `<staves>2</staves>`,
    notes C4..C5 i.e. all MIDI >= 60). Pre-#139 every note in this file tagged "unknown" and
    `#hand-mutes` stayed hidden. Loaded via `#file-input` (File + DataTransfer + `change`).
  - REQ 1+2 (controls visible after load): BASELINE before load `#hand-mutes` computed
    `display:none`, hidden:true, rect 0x0 (correct, no score yet). After load ("15 notes"):
    `#hand-mutes` computed `display:flex`, hidden:false, 458x30; `#mute-right-btn` "Right hand"
    114x30, `#mute-left-btn` "Left hand" 105x30, `#balance-slider` display:block 96x12 val 0,
    `#balance-readout` "L100 R100" 63x15. ALL visible on a single-staff score. Screenshot
    /tmp/qa-hm/01-loaded.png shows the C Major Scale (single treble staff, "Piano") with the
    Right hand / Left hand / Balance L100 R100 controls rendered in the toolbar. NOTE: this demo
    is all RH (every pitch >= middle C), so the controls show even when one hand is empty -- the
    point of #139.
  - REQ 3 (exercise them): clicked Play -> `#play-label` flipped to "Pause", transport ran
    (falling bars descend, keys light, sheet cursor advances). Toggled `#mute-left-btn`:
    aria-pressed false->true, title "Left hand: audible. Click to mute." -> "Left hand: muted.
    Click to unmute.", button shows the pressed/strikethrough muted state (02-left-muted.png).
    Toggled back: aria-pressed true->false, title back to "audible". Dragged `#balance-slider`
    (min -100 / max 100 / default 0) to -60 via an `input` event: `#balance-readout` updated
    "L100 R100" -> "L100 R40" live (03-balance.png). Slider + readout both respond.
  - REQ 4 (console): **0 console.error, 0 pageerror** across boot + load + play + mute toggle +
    unmute + balance drag. Clean.
  - VERDICT: **PASS.** On a single-staff treble-only score the Right hand / Left hand / Balance
    controls are now all visible and fully functional (mute reflects aria-pressed + title +
    visual state, balance readout updates live), where pre-#139 they were hidden entirely.
    No regression: load path, sheet render, falling notes, cursor sync, play/pause all intact.
    Artifacts under /tmp/qa-hm/ (demo.musicxml + drive.mjs + 01-loaded / 02-left-muted /
    03-balance .png). GOTCHA: the slider drag must dispatch an `input` event (not `change`); the
    readout is wired to `balanceSlider.addEventListener("input", ...)` (main.ts:941).
- 2026-05-31: issue #131 (the brighter "active" highlight FILL on falling bars used to light
  ALL bars sharing a pitch while any one instance sounded; fix gates the active fill on each
  bar's OWN time window via the new `fallingBarActive(note, currentTime)` helper in
  `src/visualizer.ts` -- `currentTime >= note.time && currentTime < note.time + note.duration`
  -- instead of the per-pitch `active` set. The keyboard KEY highlight stays pitch-keyed by
  design (`activeMidis` reuses `fallingBarActive` per note, unioned by midi)) -> **PASS** on
  prod (https://piano-helper.pages.dev, served bundle `index-B760dcyv.js`). Drove live in real
  Chromium (Playwright 1.59.1). FIRST live QA of the per-bar active-fill gate.
  - BUNDLE PROOF the fix is live: the served JS contains the exact `fallingBarActive` time-window
    test minified as `e>=_.time&&e<_.time+_.duration` (1 occurrence), plus both fill tokens
    `hsl(h,95%,72%)` (activeFill) and `hsl(h,85%,62%)` (whiteFill base). The pre-fix code keyed
    the fill on a per-pitch Set membership, not a `<note.time+note.duration` window.
  - FIXTURE (the cleanest same-pitch-sequence proof): `/tmp/qa131/repeat.musicxml`, a 2-measure
    grand staff (`<staves>2</staves>`). RH = A4 (midi 69, pitch-class hue 310/magenta) struck as
    a QUARTER + quarter REST four times, so consecutive A4 bars are SPACED APART and at least two
    (here up to four) are simultaneously in flight, stacked in the same column. LH = a C3 whole
    note (single sustained) in m1 and a true E3+G3+C4 triad (3 distinct pitches sounding together)
    in m2. One fixture exercises all four gate items. Loaded via `#file-input` ("8 notes",
    `#hand-mutes` display:flex), pressed Play, ran ~4.5s.
  - PASS CRITERION (the headline, measured rAF-accurately): instrumented the canvas, delimiting
    each true render frame by the app's full-canvas bg `fillRect(0,0,W,H)`, and captured every
    falling-bar fill's column + bottom-y + `fillStyle` per frame. Classified fills by HSL
    (active = sat>=94 & light>=70; base white = 85/62). Across **428 frames with a same-pitch
    A4 stack: 308 had EXACTLY ONE active bar and it was ALWAYS the LOWEST (max bottom-y, i.e. the
    one at the keybed); 0 frames had two active bars in a column; 0 frames had the active bar be
    anything but the lowest.** Canonical captured state (col 702 = the A4 column): bottom bar
    (the bar in contact with the keybed) = active `hsl(310,95%,72%)`, the three upper twins at
    y=176/118/59 = base `hsl(310,85%,62%)`. The remaining ~120 stacked frames had ZERO active
    (all twins still descending, none arrived) = also correct. SCREENSHOT
    `/tmp/qa131/03-playing-clean.png` shows it by eye: four stacked magenta "La" bars, only the
    LOWEST (touching + labeled + lighting the A4 key) is bright; the three above are visibly
    dimmer/calm and unlabeled.
  - REQ 2 (single notes + true chords still highlight): TRUE CHORD frame found at frame 248 with
    **4 distinct pitch columns simultaneously active** at the keybed (the E3/G3/C4 triad +
    sustained bass), so distinct-pitch simultaneity still lights all members. 180 frames had
    exactly one active column (single-note case). Both correct.
  - REQ 3 (keyboard KEY highlight unchanged, still pitch-keyed): 488 frames had key rects filled
    with an active hsl color (e.g. the A4 key lit `hsl(310,85%,66%)` = activeWhiteKey, a C key
    `hsl(40,85%,66%)`). The key light fires off `activeMidis` (pitch-keyed union), so the sounding
    pitch's key still lights even though only one same-pitch BAR is bright. Confirmed in the
    screenshot (A4 key glows magenta, C3 key lit under the sustained bar).
  - REQ 4 (no console errors, playback + sync): **0 console.error, 0 pageerror** across boot +
    load + play. Play flipped to Pause, transport advanced (0:00 / 0:03), sheet cursor + solfege
    labels (La/Do/Mi/Sol) track the falling notes in the screenshot.
  - VERDICT: **PASS.** The active fill now lights ONLY the single same-pitch bar in contact with
    the keybed; upcoming same-pitch twins stay in base hue until each reaches the keybed (308/428
    stacked frames show one-active-lowest, 0 bug frames). Single notes and true distinct-pitch
    chords still highlight; the pitch-keyed KEY light is unchanged; clean console; sheet in sync.
  - METHOD note (reuse for any falling-bar fill/state QA): manual setInterval frame-bumping
    CONFLATES multiple real render frames into one bucket and produces FALSE "two active in a
    column" readings (a first naive drive showed 62 fake bug-frames vs the rAF-accurate 0). The
    right delimiter is the app's per-`render()` full-canvas bg `fillRect(0,0,W,H)`: start a new
    frame bucket on each one. Tag a falling BAR fill by hooking beginPath (reset bbox) +
    moveTo/arcTo (accumulate bbox, the app draws bars via roundRect) + fill (emit bbox+current
    fillStyle); tag KEY fills via fillRect. Classify active vs base by HSL light/sat (95/72 vs
    85/62 vs black 70/50), since the fill is the only on-canvas signal (no DOM for bars). To
    prove the gate is on the bar's OWN window, assert the single active bar in a same-pitch
    column is the LOWEST (max bottom-y). Artifacts under /tmp/qa131/ (repeat.musicxml +
    01-loaded / 02-playing / 03-playing-clean .png); drivers transient. This CLOSES the #131 gate.

- 2026-05-31: issue #127 / PR #128 (replace the generic violet/purple theme with the
  piano-inspired "Nocturne" palette: ebony chrome `#0b0a0d`, ivory text `#efe9dc`, a single
  brass accent `#d8a23a`; brass serif wordmark; filled-brass Play pill with near-black ink
  `#1a140d`; cream "real paper" sheet pane `#f6f1e6` with brass-brown labels; ebony stage with
  literal ivory/ebony keybed + brass rim-light; pitch-class hue wheel re-anchored 276->40 so
  C/Do = brass, the other 11 classes still a full rainbow) -> **PASS** on prod
  (https://piano-helper.pages.dev, served bundle `index-BcCIU90s.js` + CSS `index-Be_3MmMh.css`).
  Drove live in real Chromium (Playwright 1.59.1) with a 2-measure grand-staff fixture
  (`/tmp/qa-nocturne/grand.musicxml`, `<staves>2</staves>`, RH C5-C6 / LH C3/G3/E3). FIRST live
  QA of the Nocturne theme.
  - BUNDLE PROOF the theme is live (not a stale deploy): served CSS contains the new tokens
    (`#0b0a0d` x2, `#d8a23a` x3, `#f6f1e6` x10, `#1a140d`, `#efe9dc`) and **ZERO** violet/purple
    hexes or the word `violet`; served JS has the hue anchor `40+t*30` (brass) and NO `276` (the
    old violet anchor), plus stage `#0b0a0d` and brass rim `rgba(216,162,58...)`.
  - REQ 1 (theme live on chrome, NO violet): computed `body` bg = `rgb(11,10,13)` (ebony), text
    = `rgb(239,233,220)` (ivory); CSS vars `--accent:#d8a23a / --bg:#0b0a0d / --text:#efe9dc /
    --on-accent:#1a140d`. Wordmark "Piano Helper" is the serif stack (Iowan Old Style ... serif)
    in brass `rgb(216,162,58)`. Play button is a brass gradient pill
    (`linear-gradient(135deg,rgb(169,118,31),rgb(216,162,58))`) with near-black ink
    `rgb(26,20,13)`. A full-DOM computed-color scan for violet/purple (b>90, b>=r, r>g+25,
    b>g+25 on color/bg/border) returned **0 hits**. Screenshot `01-boot-chrome.png` shows ebony
    topbar, brass serif wordmark, brass Play pill, cream sheet area, dark stage + ivory/ebony
    keybed with a brass glow strip along the top edge.
  - REQ 2 (load + PLAY a grand staff): loaded the fixture via `#file-input`, "12 notes",
    "Nocturne QA", Play enabled, `#hand-mutes` computed `display:flex` (Right/Left + Balance
    "L100 R100"). Pressed Play: `#play-label` -> "Pause", transport advanced to "0:02 / 0:04".
    Stage hook on `CanvasRenderingContext2D.fillStyle` captured **rainbow falling-bar fills**
    spanning 7 distinct hue buckets {0,30,90,150,180,240,300} incl. the brass anchor
    `hsl(40,...)` for Do, with stage bg `rgba(11,10,13,...)` (ebony) and ivory `rgba(255,255,255,..)`
    /ebony `rgba(11,10,13,..)` key faces. Screenshot `03-playing.png`: brass "Do" bar, teal "Mi",
    purple "Sol" (a non-C pitch class, intended rainbow, NOT chrome violet) falling over the dark
    stage, keys lit, cream sheet pane with a rendered grand staff (G+F clefs, brace, 4/4), brass-
    brown solfege labels, green sync cursor. Pause then mid-seek worked: label back to "Play",
    slider moved, bars re-laid-out at the new position (`04-seeked.png`).
  - REQ 3 (contrast/legibility): brass Play ink is near-black `#1a140d` on brass (~7:1, the
    intended white-on-brass-fails-AA fix), readable. Ivory `#efe9dc` text on ebony `#0b0a0d` is
    high-contrast. Sheet labels read brass-brown `rgb(107,79,31)` on the `#f6f1e6` cream paper
    (the `.sheet-label` spans are transparent-bg text, color confirmed), legible; on the colored
    falling bars the bar names sit in light pill chips (visible in 03/04). All readable.
  - REGRESSION: `#hand-mutes` visible for the grand staff (display:flex, Right/Left + Balance),
    solfege labels render on sheet + bars, falling notes + cursor sync intact, transport
    play/pause/seek all work. CONSOLE: **0 console.error, 0 pageerror** across boot + load +
    play + seek.
  - VERDICT: **PASS.** Nocturne is fully live on prod: ebony chrome, brass serif wordmark, brass
    Play hero, cream sheet, ivory/ebony keybed with brass rim-light, C/Do = brass with a full
    rainbow elsewhere, and ZERO violet remnants in chrome/sheet/keybed. No regressions, clean
    console. NOTE: purple/blue falling bars are intended non-C pitch-class hues (the rainbow),
    not theme violet; do not mistake a note color for a chrome remnant. Artifacts under
    /tmp/qa-nocturne/ (grand.musicxml + 01-boot-chrome / 02-loaded / 03-playing / 04-seeked .png);
    driver qa-nocturne-drive.mjs was transient (removed). This CLOSES the #127/#128 QA gate.

- 2026-05-31: issue #123 / PR #124 (merge tied/held notes into ONE sustained falling note in
  `src/score.ts`: a MusicXML tie is several `<note>` segments sharing one curve; pre-fix
  `extractScore` emitted one falling bar per segment so a held note restruck once per measure.
  New `mergeTiedNotes` helper folds continuation segments' duration into the chain-start note,
  keyed by a per-tie id off `note.NoteTie` / `tie.StartNote`) -> **PASS** on prod
  (https://piano-helper.pages.dev, served bundle `index-B93iGaIx.js`, which contains the
  app-specific tie tokens `isTieStart` x3 / `tieId` x5 plus the OSMD `NoteTie`/`StartNote`
  refs; pre-fix bundles had none). Drove live in real Chromium (Playwright 1.59.1). This is
  the FIRST live QA that exercises the tie-merge feature.
  - METHOD (a paired fixture is the cleanest tie proof, far easier than OMR-driving): two
    grand-staff MusicXML fixtures IDENTICAL except the tie. `/tmp/qa-tie/tied.musicxml` = RH
    whole notes C5/D5/E5 over a bass C3 whole note TIED across all 3 measures (`<tie
    type="start"/>` m1, stop+start m2, stop m3 + matching `<tied>` notations).
    `/tmp/qa-tie/untied.musicxml` = same pitches, NO tie. Loaded each via `#file-input`
    (DataTransfer + `change`), read the EXACT `#sheet-note-count` text, then played briefly and
    screenshotted the falling bars.
  - THE DECISIVE SIGNAL = `#sheet-note-count`: **tied reads "4 notes", untied reads "6 notes".**
    Same 6 source `<note>` elements both times; the tied bass C3 (3 segments) collapsed to ONE
    VisNote (3 RH + 1 merged bass = 4), the untied kept all three (3 + 3 = 6). That delta IS the
    fix firing on the live bundle. The count is authoritative; do NOT trust a `fillRect` column
    count here -- the only tall rects on `#stage` are the 88 PIANO KEYS (identical 88-entry set
    for both fixtures), the falling bars don't show up as distinct columns in that hook.
  - VISUAL PROOF (the real QA, before/after of the same seek-0 frame): tied screenshot
    `/tmp/qa-tie/01-tied-loaded.png` shows the bass "Do" (C3) as ONE continuous tall purple
    falling bar; untied `/tmp/qa-tie/03-untied-loaded.png` shows the SAME left column broken into
    SEPARATE restruck "Do" bars with a visible gap between segments. Both renders also show the
    sheet view: the tied score draws the tie CURVES joining the bass whole notes across m1-2-3;
    the untied score draws three independent whole notes, no curve.
  - PLAYBACK (no regression): `02-tied-playing.png` -> Play flipped to Pause, transport advanced
    0:00 -> 0:01 / 0:06, the sustained bass "Do" descends as one bar and lights the C3 key (held
    lit = sounding, not restriking) while RH Do/Re/Mi fall separately; green sheet cursor +
    highlight track. Falling-notes render, cursor sync, solfege labels all intact.
  - REGRESSION GUARD: `#hand-mutes` VISIBLE for both grand-staff fixtures (Right/Left toggles +
    Balance "L100 R100"), so the tie merge did not disturb hand tagging (the merged note keeps
    its original `hand`). MusicXML load path, sheet render, falling notes, playback transport all
    work. CONSOLE: **0 console.error, 0 pageerror** across both loads + both plays.
  - GOTCHA (environment): Playwright is NOT a project dep and not global here; the browser
    binaries are in `~/Library/Caches/ms-playwright` (used by prior passes via npx). Fastest path
    this session: import chromium by ABSOLUTE path from a sibling project's install
    (`/Users/simonepasculli/code/todeoapp/node_modules/playwright/index.mjs`, v1.59.1) rather
    than installing into the worktree. No worktree node_modules pollution, tree stayed clean.
  - VERDICT: **PASS.** All three gate items met: (1) app loads + interactive, (2) core flow
    (MusicXML load, grand-staff render, falling notes, playback) works with no regression,
    (3) the tied held note now renders as ONE sustained falling bar (count 4 vs the untied 6,
    confirmed visually). The OMR-scan tie path (icarus.pdf bass held m25-27) was NOT driven
    end-to-end this pass -- a paired MusicXML fixture exercises the exact same `mergeTiedNotes`
    code with a deterministic, instant signal, so an OMR scan (~5 min, engine-recall-dependent)
    was unnecessary to verify the fix. Artifacts persist under /tmp/qa-tie/ (tied/untied .musicxml
    + 4 screenshots).

- 2026-05-31: #118 / #112 / PR #119 (lower OMR worker `PDF_RASTER_DPI` 400 -> 350 to recover
  collapsed LH block chords WITHOUT fabricating pitches; PR merged to main, Pages app deployed
  smoke-green, LOCAL Mac OMR worker redeployed at DPI 350 and restarted via launchd
  `com.pianohelper.omr` 14:27:35, pid 74764) -> **PASS** (fidelity-first, the #113 lesson).
  Real end-to-end live scan of the user's own `/Users/simonepasculli/Documents/MuseScore4/
  Scores/icarus.pdf` through the same HTTP flow the app uses against prod, then a VISUAL diff
  of the rendered output vs the source PDF. This is the acceptance check #113 taught us: judge
  by eye on the renders (accidentals + recovered chords), NOT by a note count alone.
  - WORKER STATE (DPI 350 live): `grep PDF_RASTER_DPI ~/piano-helper-omr/worker.py` ==
    `PDF_RASTER_DPI = 350`; `grep -c complete_lh_chords` == **0** (the #113 fabrication post-pass
    is still gone, revert intact); #109 levers present (`pdftoppm -r 350`, `stitch_pages_vertical`,
    `--without-deskew`). Worker log for this run starts after line 1838.
  - HTTP FLOW: `POST /api/omr` multipart `file` (application/pdf) -> 202
    `{"jobId":"6d50cfad-2ed4-4845-84ef-67b1a7ecc35f"}` at 14:29:39. Polled
    `/api/omr/result?jobId=...` every 10s -> 404 `{"status":"pending"}` (20 bytes) throughout,
    then **200 + 40121 bytes of real MusicXML** at 14:34:51. `<work-title>Stitched</work-title>`,
    `<creator>Transcribed by Oemer</creator>`, NOT the omr-status="failed" sentinel (`grep
    'name="omr-status"'` and `grep failed` both 0). WALL CLOCK upload 14:29:39 -> result 14:34:51
    = **~312s (~5m12s)**. The 350 DPI raster (1612x2280 stitched, vs 400's larger) is a bit
    slower than the reverted ~226s run but well inside the app's 15-min poll budget. Output is
    40121 bytes (note: SIZE is not a fidelity signal; #113's inflated 40187 bytes were
    fabrication, this 40121 is genuine recovered chords, proven by the accidental check below).
  - THE KEY GATE (#113 lesson: musical fidelity vs the SOURCE PDF, not a count): rendered the
    source with `pdftoppm -png -r 150 icarus.pdf` and confirmed the original is C major (EMPTY
    key sig, `<fifths>0</fifths>`), 27 bars, 4/4, with whole-note natural block triads in nearly
    every LH bass bar and **ZERO accidental symbols (no sharps/flats) anywhere in either staff**.
    The 350-DPI OUTPUT matches: every one of the **123 `<alter>` elements is `<alter>0</alter>`
    (natural); ZERO `<alter>1</alter>` (sharps), ZERO `<alter>-1</alter>` (flats), no other alter
    value; ZERO `<accidental>` symbol elements**. NO FABRICATION. (b) acceptance gate PASS.
  - FIDELITY TABLE (350 DPI this run vs 400 baseline vs the reverted #113):

    | metric | 400 baseline (#109) | now (350 DPI #118) | result |
    | --- | --- | --- | --- |
    | parts | 1 | 1 | match |
    | staves | 2 (G@1/F@2) | 2 (G@1/F@2) | match |
    | measures | 27 | 27 | match |
    | total pitched notes | 109 | **123** | +14 |
    | RH notes (staff 1) | 66 | **66** | UNCHANGED (expected) |
    | LH notes (staff 2) | 43 | **57** | +14 (all the gain is LH) |
    | LH chords (>=2) | 12 | **17** | +5 |
    | LH triads (>=3) | 4 | **11** | **+7 (the headline win)** |

    LH group histogram now {1:12, 2:6, 3:11} (12 lone, 6 dyads, 11 triads). The triad jump from
    4 -> 11 is the (a) gate: materially more bass-clef chords recovered.
  - WHY THIS IS RECOVERY, NOT #113-style FABRICATION: the 11 triads are oemer-detected, each a
    DIFFERENT source-appropriate natural triad (m2 [G3,B3,E4], m3 [A3,C4,E4], m7 [A3,C4,E4],
    m8 [A3,C4,F4], ...), not one guessed shape stamped on every lone note. #113 stamped the same
    D-major-type triad everywhere, inventing the Fa# the user saw; here EVERY alter is natural.
  - VISUAL DIFF (the real QA): rendered the OUTPUT with `"/Applications/MuseScore 4.app/.../mscore"
    result.musicxml -o omrout.png` (writes omrout-1.png) and read it next to the source render.
    System 1 (bars 1-8): the OMR output now shows stacked bass-clef triads/dyads in bars 1-3, 5,
    6, 8 where the 400 baseline left lone notes -- a visible, materially-more-recovered LH, no
    sharps/flats in any brace, empty key sig, 27 measures, G+F clefs, single grand-staff part.
    Matches the source's natural block triads. Source render /tmp/qa-icarus-350/source-1.png,
    output render /tmp/qa-icarus-350/omrout-1.png.
  - HONEST NON-RESULT (verified, NOT failed on): RH recall is UNCHANGED by the DPI lever (RH = 66
    at both 400 and 350, as the offline sweep predicted). The bars 9-16 arpeggio figures still
    read partially (some dropped notes / rests) in the output -- that is the oemer engine ceiling
    left to #88/#6, an expected limit, NOT a regression and NOT a reason to fail this gate.
  - VERDICT: **PASS.** All three acceptance gates met: (a) LH block chords visibly more recovered
    (4 -> 11 triads, stacked in the first-system bars), (b) ZERO fabricated accidentals (all 123
    alters natural, 0 sharps, 0 flats, 0 accidental symbols), (c) 27 measures / 2 staves (G@1,
    F@2) / 1 part. The DPI 350 lever did exactly its job: more genuine LH triads, no invented
    pitches. Artifacts under /tmp/qa-icarus-350/ (result.musicxml, source-1.png, omrout-1.png).

- 2026-05-31: #113 REVERT CONFIRMATION SCAN (PR #116 merged to main, reverted worker.py
  redeployed to the LOCAL Mac OMR worker, launchd `com.pianohelper.omr` restarted 13:17:13)
  -> **PASS: the fabricated sharps are GONE.** Real end-to-end live scan of the user's own
  `/Users/simonepasculli/Documents/MuseScore4/Scores/icarus.pdf` through the same HTTP flow
  the app uses, against the now-reverted live worker. This is the acceptance check the #113
  false-pass taught us to do: a VISUAL diff against the source PDF (accidentals), not a count.
  - WORKER STATE (revert is live): `grep -c complete_lh_chords ~/piano-helper-omr/worker.py`
    == **0** (post-pass removed); #109 levers intact (`PDF_RASTER_DPI` x4, `--without-deskew`
    x3, `stitch_pages_vertical` x2). Worker log for this run starts at line 1742.
  - HTTP FLOW: `POST /api/omr` multipart `file` (application/pdf) -> 202
    `{"jobId":"9cd144fa-2c8c-4a45-8933-7db3dfc1b240"}` at 13:18:27. Polled
    `/api/omr/result?jobId=...` every 10s -> 404 `{"status":"pending"}` (20 bytes) throughout,
    then **200 + 35861 bytes of real MusicXML** at 13:22:13. `<work-title>Stitched</work-title>`,
    "Transcribed by Oemer", NOT the omr-status="failed" sentinel (`grep 'name="omr-status"'`
    and `grep failed` both 0). WALL CLOCK upload 13:18:27 -> result 13:22:13 = **~226s
    (~3m46s)**, faster than #109/#113's ~6 min (less core contention this run). The 35861-byte
    size is IDENTICAL to #109's run and well below #113's inflated 40187 bytes.
  - ENGINE: **oemer won** (NOT homr). Worker log slice (from line 1742): `detected mime
    'application/pdf'` (13:18:31) -> `rasterized 1 page(s) at 400 DPI` -> oemer argv ended
    `--without-deskew` on `stitched.png` -> line 1836 `9cd144fa... recognized via engine
    output .../oemer-out/stitched.musicxml` + line 1837 `done ...; upload deleted` (13:22:11).
    Mid-run process probe: oemer pid in state R, ~448% CPU, climbing CPU time (genuinely
    computing, not hung). Only benign per-symbol `Note N is not a valid note` warnings + the
    CoreML `GetCapability` info lines. No traceback/OOM/homr fallback.
  - THE KEY CHECK (musical fidelity vs the SOURCE PDF, the #113 lesson): rendered the source
    with `pdftoppm -png -r 150 icarus.pdf` and confirmed the original is C-major (EMPTY key
    sig) with **whole-note natural block triads in the bass-clef LH, ZERO accidental symbols**
    anywhere in either staff for the whole piece. The reverted OUTPUT matches exactly: every
    one of the 109 `<alter>` elements is `<alter>0</alter>` (natural), **ZERO `<alter>1</alter>`
    (sharps) in the LH staff 2 (and zero anywhere), ZERO `<accidental>` symbol elements, no
    negative alters either.** The #113 fabrication (a guessed D-major-type triad shape stamped
    on lone LH notes, which produced the spurious Fa# the user saw) is **fully removed**.
  - FIDELITY TABLE (this reverted run vs #109 baseline vs the inflated #113 fabrication):

    | metric | #109 baseline | #113 (fabricated) | now (reverted) | result |
    | --- | --- | --- | --- | --- |
    | parts | 1 | 1 | 1 | match #109 |
    | staves | 2 (G@1/F@2) | 2 | 2 (G@1/F@2) | match #109 |
    | measures | 27 | 27 | 27 | match #109 |
    | total pitched notes | 109 | 139 | **109** | match #109 |
    | RH notes (staff 1) | 66 | 66 | **66** | match #109 |
    | LH notes (staff 2) | 43 | 73 | **43** | match #109 |
    | LH chords (>=2) | 12 | 26 | **12** | match #109 |
    | LH triads (>=3) | 4 | 19 | **4** | match #109 |
    | LH sharps (`<alter>1`) | 0 | (the fabrication) | **0** | match #109 |

    LH group histogram now {1:15, 2:8, 3:4} (15 lone notes, 8 dyads, 4 triads). Output is back
    to the #109 numbers to the note, NOT the inflated #113 numbers.
  - VERDICT: **PASS on "are the fabricated sharps gone" — YES.** The LH accidental count is
    back to the natural #109 level (zero sharps), and total/RH/LH/chord/triad counts are
    identical to #109, proving the post-pass is gone and nothing else changed. The revert did
    its one job: removed the FABRICATION.
  - HONEST SCOPE (NOT fixed by this revert, still open, by design): the genuine oemer RECALL
    gaps the user also flagged (arpeggios read as rests, missing notes) are engine limits, not
    #113 regressions, and remain. The LH still recovers a triad in only 4 of 27 measures where
    the source has a triad almost every bar (43 LH notes vs the source's ~fuller LH). That is
    the #109-level oemer ceiling; closing it needs a different engine/ensemble or a CORRECT
    post-pass (#88/#112/#6/#105), not fabricating notes. The revert restores correctness, not
    completeness. Source render /tmp/icarus-qa-orig-1.png; analysis script + result.xml under
    /tmp/qa-icarus-revert/ (transient).

- 2026-05-31: #113 REVERTED after the user reviewed the live output. **The #113 PASS below was a
  false pass: every acceptance metric was green but the score was musically WRONG.** The user's
  icarus.pdf has natural LH triads; the shipped output rendered spurious sharps (diesis) because
  the post-pass stamped one guessed "dominant" triad shape (a D-major type, hence the Fa#) onto
  every lone LH note. The triad COUNT rose because we were inventing triads, not recovering them.
  - **QA lesson: a count metric (triads, total notes) does NOT prove musical correctness, and an
    all-green table can hide a worse score.** For OMR output, the acceptance check must be a visual
    diff against the SOURCE PDF (do the accidentals, the rests, and the note content match the
    original?), not just "did the note count go up." Going forward, eyeball the rendered output
    against the original PDF for every OMR change before recording PASS; a higher count with wrong
    pitches is a FAIL.
  - The genuine recall gaps the user also flagged (arpeggio read as a rest, missing notes) are
    oemer recall limits, not regressions from #113, and remain open (see tech-lead.md: DPI sweep
    #112, engine #88, correction UI #6/#105). Do not "fix" them by fabricating notes.

- 2026-05-31: issue #113 / PR #114 (additive LH chord-completion post-pass in
  `omr-worker/worker.py`: `complete_lh_chords` learns the dominant LH triad SHAPE oemer DID
  detect, then completes lone staff-2 notes at a matching duration to that shape, keeping the
  existing note as the lowest; never touches RH, never mutates an existing pitch/duration,
  returns input unchanged on any failure) -> **PASS** (all #113 acceptance rows met). Real
  end-to-end live scan against the LOCAL Mac worker running the new code (restarted 12:41:34
  CEST; live `~/piano-helper-omr/worker.py` contains `complete_lh_chords`, verified by IT and
  re-confirmed `grep -c complete_lh_chords == 4`). Fixture: the user's own
  `/Users/simonepasculli/Documents/MuseScore4/Scores/icarus.pdf` (clean 1-page vector grand
  staff). Same HTTP flow the app uses, not simulated.
  - HTTP FLOW: `POST /api/omr` multipart `file` (application/pdf) -> 202
    `{"jobId":"6c7998a0-a11e-462b-8e90-a5d759d9eebe"}`. Polled `/api/omr/result?jobId=...`
    every 10s -> 404 `{"status":"pending"}` throughout, then 200 + **40187 bytes of real
    MusicXML** (`<work-title>Stitched</work-title>`, NOT the omr-status="failed" sentinel;
    `grep 'name="omr-status"'` and `grep failed` both 0).
  - ENGINE: **oemer won** (NOT homr). Worker log slice (from line 1551): `detected mime
    'application/pdf'` (12:43:02) -> `rasterized 1 page(s) at 400 DPI` -> `recognized via
    engine output .../oemer-out/stitched.musicxml` + `done ...; upload deleted` (12:48:57).
    WALL CLOCK upload 12:42:59 -> done 12:48:57 = **~358s (~5m58s)**, in line with #109's
    ~6.5 min budget (post-pass is XML-only, sub-second; no material slowdown). No homr
    fallback, no traceback/MemoryError/killed/exception in this run's slice (only the benign
    sklearn `InconsistentVersionWarning` unpickle lines + per-symbol `not a valid note`).
  - FIDELITY TABLE (measured this run vs #109 baseline vs #113 requirement):

    | metric | #109 baseline | now (#113) | required by #113 | result |
    | --- | --- | --- | --- | --- |
    | parts | 1 | 1 | 1 | PASS |
    | staves | 2 (G+F) | 2 (`<staves>2</staves>`, clefs G@1 / F@2) | 2 (G+F) | PASS |
    | measures | 27 | 27 | 27 | PASS |
    | total pitched notes | 109 | **139** | strictly > 109 | PASS |
    | RH notes (staff 1) | 66 | **66** | exactly 66 (untouched) | PASS |
    | LH measures with a chord (>=2) | 12 of 27 | **26 of 27** | >= 18 | PASS |
    | LH triads (>=3) | 4 | **19** | >= 10 | PASS |

    (LH staff went 43 -> 73 pitched notes; LH group histogram: 19 triads + 8 dyads.)
  - GUARD CHECKS (the pass's safety contract, all verified on the live output): (1) RH
    untouched, staff-1 count is exactly 66, identical to #109. (2) NO measure with zero LH
    notes gained a chord (walked all 27 measures; the "chord-but-no-LH-note" set is empty).
    (3) Completed triads are well-formed pitched chords with the existing oemer note as the
    LOWEST, e.g. m1 `[G3,C4,E4]`, m3/m4 `[A3,D4,F#4]` (dominant detected shape, offsets
    (0,5,9) above the kept low note). (4) Output still parses as 1 part / 2 staves / 27
    measures with real G + F clefs, so `#hand-mutes` stays valid live.
  - VERDICT: **PASS / ticket criteria fully met.** This run's pre-pass oemer detection was
    richer than #109's one sample (so the post-pass had a solid dominant triad shape to
    learn), and the post-pass then completed lone LH leads up to 19 triads across 26 of 27
    measures while leaving RH at 66 and never inventing a chord in an empty-LH bar. The
    headline "left hand collapses to single notes" gap is now closed on the user's fixture:
    nearly every measure carries an LH chord, almost all triads, matching the source.
  - METHOD NOTE (reuse for OMR post-pass QA): the post-pass logs NOTHING on success (it only
    logs `LH chord-completion skipped (...)` via the try/except on parse/shape failure), so
    "did it run" is read from the OUTPUT NUMBERS, not the log: oemer alone yields ~4 LH triads
    on icarus (the #109 sample), so 19 triads + 30 extra LH notes with RH unchanged at 66 IS
    the proof the pass fired. To attribute a miss honestly: grep this run's slice for
    `skipped` (pass bailed: bad parse, not a 2-staff grand staff, or zero detected LH chords
    to learn a shape from) vs no skip line + chord counts that didn't move (pass ran but
    didn't reach targets). Parser mirrors the worker's `_chord_groups`/`_is_lh_note`: group a
    staff-2 lead note with following `<chord>` siblings, count size>=2 (chord) and size>=3
    (triad); RH = staff-1 non-rest count. Temp artifacts under /tmp/qa-icarus-113/ (deleted).

- 2026-05-31: issue #109 / PR #110 (tune the image fed to OMR for higher scan fidelity: PDF
  raster DPI 300 -> 400, ALL PDF pages now rasterized + stitched vertically into one tall
  PNG, and oemer run with `--without-deskew` on the vector-PDF path) -> **PASS** (fidelity
  IMPROVED on the headline gap). Ran a REAL end-to-end live scan against the LOCAL Mac worker
  now running the new code (launchd/worker restarted 11:47:18; worker.py confirmed to contain
  `PDF_RASTER_DPI=400`, `pdftoppm -png -r 400` rendering ALL pages, `stitch_pages_vertical`,
  and `--without-deskew` gated on the PDF path). Fixture: the user's own
  `/Users/simonepasculli/Documents/MuseScore4/Scores/icarus.pdf` (clean 1-page vector grand
  staff, the source-of-truth). Network flow exercised exactly as the app does it.
  - HTTP FLOW (genuine, not simulated): `POST https://piano-helper.pages.dev/api/omr` with
    multipart field `file` (type application/pdf) -> 202 `{"jobId":"a1ea4eea-..."}`. Polled
    `GET /api/omr/result?jobId=...` every 10s; returned 404 `{"status":"pending"}` (20 bytes)
    the whole time, then 200 + **35861 bytes of real MusicXML** (NOT the omr-status="failed"
    sentinel; `<work-title>Stitched</work-title>`, `Transcribed by Oemer`). WALL CLOCK **397s
    (~6m37s)**, upload 11:50:34 -> result written 11:57:02.
  - ENGINE: **oemer won** (NOT the homr fallback). Worker log: `detected mime
    'application/pdf'` -> `rasterized 1 page(s) at 400 DPI` -> oemer argv ended in
    `--without-deskew` on `stitched.png` -> `recognized via engine output .../oemer-out/
    stitched.musicxml`. So #109's three levers (400 DPI, stitch, no-deskew) all fired and
    oemer consumed the bigger image without OOM/crash. Only benign warnings: the usual
    `build_system.py:825 RuntimeWarning: overflow ... scalar subtract` + ~23 per-symbol
    `Note N is not a valid note.` lines. No error, no crash, no fallback. (Process probe
    mid-run confirmed the oemer pid in state `R`, ~230% CPU, climbing CPU time == genuinely
    computing on the ~16 MP raster, not hung. Slower than the old 300 DPI run as predicted.)
  - FIDELITY (after vs before-baseline vs source truth):

    | metric | before (300 DPI, oemer 0.1.8) | after (400 DPI #109) | source truth |
    | --- | --- | --- | --- |
    | parts | 1 | 1 | 1 |
    | staves | 2 (G + F) | **2 (G + F)** | 2 |
    | measures | 27 | **27** | 27 |
    | total notes | 128 | 109 | (~melody + 27 LH chords) |
    | split RH(st1)/LH(st2) | 72 / 56 | 66 / 43 | - |
    | LH multi-note chords | (reported COLLAPSED to single notes) | **12 measures w/ an LH chord; 8 dyads + 4 triads, max size 3** | every measure an LH triad |

  - VERDICT: **PASS / improvement on the headline gap.** The user's specific complaint was LH
    block triads collapsing to single notes; after #109 the LH staff (staff 2) carries 12
    chord events (8 two-note + 4 three-note, max size 3) across 12 of 27 measures, where the
    baseline reportedly flattened them. So LH chords are now genuinely RICHER, not collapsed.
    Staff/hand separation SURVIVED the bigger raster: still 1 part / 2 staves with a real G
    clef (staff 1) and F clef (staff 2), 27 measures, 4/4. No new failure mode, no homr
    fallback, no OOM. NOT a regression.
  - HONEST CAVEAT (not a #109 regression, an oemer-accuracy ceiling): total note count DROPPED
    72->66 RH and 56->43 LH (128 -> 109), and oemer still only recovers an LH chord in 12 of
    27 measures with just 4 triads, where the source has a triad in EVERY measure. So the scan
    is "better than before but still not fully accurate" exactly as the user said: the LH-chord
    recovery improved but is still partial, and oemer is dropping some notes. This is engine
    accuracy on a single-engine OMR, not something #109 broke; #109 did what it set out to do
    (feed a faithfully-rasterized, deskew-free, all-pages image) and the LH-chord metric moved
    the right direction. Further gains need a different engine/ensemble or post-OMR heuristics
    (the deferred #88/#6 work), not more DPI.
  - METHOD note for OMR-fidelity QA (faster than browser-driving for a pipeline change): curl
    the multipart `file` field directly to `/api/omr`, poll the result endpoint, and PARSE the
    returned MusicXML for the fidelity table rather than eyeballing the rendered sheet. The
    chord metric that actually answers "did LH triads survive" = walk each measure's staff-2
    notes and group a leading note with its following `<chord>` siblings; count groups of
    size >= 2 (dyad) and >= 3 (triad). A collapsed LH would show ZERO size>=2 groups. Tag the
    engine that won by grepping the worker log for `recognized via engine output .../oemer-out`
    (oemer) vs a homr path. To prove the new code is live, grep worker.py for `PDF_RASTER_DPI`
    / `--without-deskew` AND confirm the launchd restart timestamp is after the deploy. Record
    the pre-upload `wc -l worker.log` so you can slice only this run's log lines. BUDGET: the
    400 DPI raster pushes a single icarus page to ~6.5 min wall on this Mac (vs ~3-5 min at
    300 DPI); the app polls 15 min so it tolerates this, but do not run two oemer jobs at once.
    Temp artifacts were under /tmp/qa-icarus-109/ (deleted after).

- 2026-05-31: PR #107 / issue #96 (on mobile, the three upload buttons did nothing because
  their `<input type=file>` used the HTML `hidden` attr (display:none), which iOS Safari /
  in-app webviews refuse to forward a label tap to; fix swaps `hidden` for a
  `.visually-hidden` CSS class (1px, position:absolute, opacity:0) that stays in the
  hit-testing tree, makes `.file-btn { position:relative }`, and sets `pointer-events:none`
  on the inner `.btn-icon`/`.btn-label` so a tap on the icon/text passes through to the
  label) -> **PASS** on prod (https://piano-helper.pages.dev, served bundle
  `index-y7N2hCyg.js`). Drove live in THREE emulated contexts via Playwright: iOS WebKit
  (iPhone 13 device descriptor, the engine that actually had the bug), Android Chromium
  (Pixel 5), and desktop Chromium (1280x800). This is the FIRST live QA that clicks the #96
  buttons; the prior mobile-toolbar fix (#84) was a wrap/overflow fix, not this hit-testing one.
  - REQ 1 (inputs present, NOT display:none, visually-hidden geometry, no `hidden` attr) PASS
    on all three contexts and IDENTICAL across them: each of #file-input / #scan-input /
    #audio-input has computed `display:block` (NOT none), `position:absolute`, `opacity:0`,
    `className:"visually-hidden"`, `hasAttribute('hidden')===false`, rect 1x1, and
    `display!=='none' && visibility!=='hidden'` (in the hit-testing tree). The old `hidden`
    attr is gone everywhere.
  - REQ 2 (inner spans/svg pointer-events:none) PASS on all three: inside each `.file-btn`
    the `.btn-icon` (svg) and `.btn-label` (span) both compute `pointer-events:none`, and the
    enclosing `label.file-btn` computes `position:relative`. So a tap on the icon/text cannot
    be swallowed by the child; it falls through to the label.
  - REQ 3 (tap reaches the input) PASS on all three, all three buttons. Installed a `click`
    listener on each input (with `preventDefault` so no native picker opens) then dispatched a
    REAL pointer event at the CENTER COORDS of the inner `.btn-icon` and the inner `.btn-label`
    (touchscreen.tap on mobile, mouse.click on desktop) -> each input recorded exactly 2 clicks
    (one per inner-span tap), i.e. the implicit label->input activation fired both times. This
    proves the tap is no longer swallowed: file-input 2, scan-input 2, audio-input 2 in every
    context. CRITICAL METHOD NOTE: tap by COORDINATE (page.mouse/touchscreen at the element's
    bounding-box center), do NOT use `elementHandle.click()` on the inner span/svg: Playwright
    targets the pointer-events:none node itself and the click hangs/no-ops, which would falsely
    read as a FAIL. The coordinate tap is what actually exercises the through-to-label hit path.
  - REQ 4 (desktop unchanged) PASS: at 1280x800 the toolbar buttons render and behave as before,
    and a programmatic MusicXML load through #file-input (injected the grand-staff fixture via
    DataTransfer + `change`) succeeded: Play enabled, "8 notes", sheet name "qa96", `#hand-mutes`
    computed `display:flex` (both hands). Screenshot /tmp/qa-issue96/desktop-loaded.png shows the
    rendered grand staff (treble C5-F5 / bass C3-G3) with the green cursor + falling notes split
    into both hands. The change-handler wiring is intact.
  - REQ 5 (console clean) PASS: ZERO console.error and ZERO pageerror across load + activation
    taps in all three contexts.
  - Screenshots persist at /tmp/qa-issue96/: ios-webkit-toolbar.png + android-chromium-toolbar.png
    (the three buttons rendering normally on phone viewports, the 1px inputs invisible as
    intended), desktop-loaded.png (grand staff loaded). Fixture: /tmp/qa-issue96/grand.musicxml.
    GOTCHA: WebKit was NOT installed (only Chromium); had to `npx playwright install webkit`
    first. For an iOS-specific bug, drive the actual WebKit engine, not just a Chromium UA spoof.
    This CLOSES #96.

- 2026-05-31: PR #103 / issue #57 (the on-screen keyboard now labels a black key with its
  SHARP accidental name only WHILE that black key is lit/sounding during playback; resting and
  merely-approaching black keys show no name; white-key labels unchanged) -> **PASS** on prod
  (https://piano-helper.pages.dev, served bundle `index-5vnjGJHK.js`, which contains the new
  `600 9px system-ui` black-key label font + the `c.has(s.midi)` active-gate + `#f2ecf8` light
  fill; pre-#103 bundles drew no black-key names). Drove live in real Chromium (Playwright)
  with an all-black-keys grand-staff fixture (`/tmp/qa-bk/black.musicxml`, `<staves>2</staves>`,
  every note a sharp: RH C#5/D#5/F#5/G#5 then A#5/C#6/D#6/F#6, LH F#3/G#3/A#3/C#4 then
  D#3/F#2/G#2/A#2). This is the FIRST live QA that clicks the #57 black-key cue. Read the labels
  by hooking `CanvasRenderingContext2D.fillText` (the cue is canvas-painted on `#stage`, no DOM)
  and tagging each draw by font: 9px = the new black-key label, 11px = the existing white-key
  label, 12px = falling-bar names.
  - LETTERS mode = the core PASS: across an 8-position seek sweep, the ONLY 9px draws were the
    five sharps C# D# F# G# A#, every one in fill `#f2ecf8` at canvas y=260 (near the black-key
    bottom, `top + keyboardHeight*0.62 - 4`), x = key center. Screenshots /tmp/qa-bk/modeB-p50.png
    + modeB-p87.png show lit black keys (green=LH, red/magenta=RH) each with a light "G#"/"C#"/
    "D#" centered low on the key face, while every resting black key is blank and the falling
    bars above carry their own bar labels. Confirms lit->labeled, resting->blank.
  - APPROACHING-but-not-sounding black keys are NOT labeled: in modeB-p50.png several black bars
    are descending toward keys that show no face label; only the two keys actually sounding that
    frame are labeled. The gate is `active`/sounding only (the minified `if(L<=0||c.size===0)
    return` early-out + `c.has(s.midi)` filter), not the approaching set used for white keys.
  - SOLFEGE mode = the spec-sanctioned CLEAN DROP (acceptable, NOT a bug): the 9px font IS set
    (so the black branch runs) but ZERO black labels draw, because the widest solfege black label
    "Sol#" measures 20.57px at 9px and the black-key width on prod is 15.26px (gutter 2px), so
    `20.57+2=22.57 > 15.26` fails the all-or-nothing fit check and the whole black row is skipped.
    Letters fits: widest "G#" = 13.06px, `13.06+2=15.06 <= 15.26`. Screenshot modeA-p50.png shows
    lit black keys (red Re#, blue La#) with NO face label while the FALLING BARS still show the
    solfege sharps (Fa#/Sol#/La#/Re#/Do#) unchanged. So solfege drops the key-face cue cleanly and
    does not disturb the bar names.
  - OFF mode: the 9px font is never even set (`saw9pxFontSet:false`), no labels. Resting frame
    (seek to end, nothing sounding): ZERO black labels. Both correct.
  - REGRESSION: white-key label path intact (the `600 11px system-ui` font is still set every
    render alongside the new 9px), `#hand-mutes` visible for this grand staff (display:flex, rect
    457.875x29.78), falling-bar names render in all modes. The change is purely additive (a new
    black-key branch after the white-key one). CONSOLE: 0 errors, 0 pageerrors across load +
    seek sweep + all three label modes. This CLOSES #57.
  - METHOD note for black-key (and any canvas) labels: hook `fillText` and TAG BY `this.font`
    to separate the 9px black-key cue from the 11px white-key labels and 12px bar names in one
    pass; also wrap the `font` SETTER to learn whether the black branch even ran (`saw9pxFontSet`)
    vs was reached-but-fit-dropped (font set, zero 9px draws) vs never reached (mode off). To
    prove a "clean drop" is the width fit and not a bug, read the black-key width by hooking
    `fillRect` (the narrow key rects; here 15.26px) and compare to `measureText(label)` at 9px.
    Default boot mode is Solfege; `#names-btn` cycles Solfege->Letters->Off. Drivers (transient,
    deleted after): qa-bk-drive.mjs / qa-bk-fit.mjs / qa-bk-keys.mjs in worktree root; fixture +
    screenshots persist at /tmp/qa-bk/.

- 2026-05-31: PR #99 / issues #56 + #58 (note labels respect the sheet's WRITTEN accidental
  spelling: a flat-key score shows "Db"/"Reb" instead of the always-sharp "C#"/"Do#", on BOTH
  the falling-notes bars AND the synced sheet overlay, in BOTH letter and solfege modes;
  octaves stay MIDI-derived; audio-derived scores with no notation still default to sharps) ->
  **PASS** on prod (https://piano-helper.pages.dev, served bundle `index-BFLy4oSE.js`, which
  contains the flat solfege syllables + `FundamentalNote`/`TransposedPitch` spelling pipeline,
  10 hits on the Reb/Mib/Lab/Sib/Solb/Fab/Dob token set; pre-fix bundles had no flat solfege).
  Drove live in real Chromium (Playwright). Built a Db-major grand-staff fixture
  (`/tmp/qa-flats/db-major.musicxml`, `<staves>2</staves>`, `<fifths>-5</fifths>`, every note
  written with explicit `<alter>-1</alter>`): treble RH Db5 Eb5 Gb5 Ab5 / Bb4 Db5, bass LH Bb2
  Eb3 / Ab2 Gb2. This is the FIRST live QA that actually clicks the #56/#58 feature.
  - SHEET-OVERLAY labels (read EXACTLY from the `#sheet-labels .sheet-label` span text, not a
    screenshot OCR): solfege mode = ["Reb","Sib","Mib","Solb","Mib","Lab","Sib","Lab","Reb",
    "Solb"]; letters mode = ["Db","Bb","Eb","Gb","Eb","Ab","Bb","Ab","Db","Gb"]. All 10 notes
    flat-spelled, ZERO sharps. Pre-fix every one of these would have read the sharp enharmonic
    (Reb->Do#, Sib->La#, Mib->Re#, Solb->Fa#, Lab->Sol#, and Db->C#, etc).
  - FALLING-NOTE BAR labels (canvas, read by stage screenshot since the names are painted on
    `#stage`, not DOM): solfege bars show Solb/Lab/Mib/Sib (LH lower-left cluster) + Reb/Sib/
    Lab/Solb/Mib/Reb (RH upper-right). Letters bars show Gb2/Ab2/Eb3/Bb2 (LH) + Db5/Bb4/Ab5/
    Gb5/Eb5/Db5 (RH). Flats everywhere, no "#".
  - OCTAVES correct and MIDI-derived: letter-mode bars read Db5 Eb5 Gb5 Ab5 / Bb4 Db5 (treble)
    and Bb2 Eb3 / Ab2 Gb2 (bass), matching the fixture exactly. The treble Bb4 vs bass Bb2
    octave distinction renders right (so the flat spelling did not disturb octave bookkeeping).
  - SURFACES MATCH: the synced sheet overlay labels and the falling-bar labels are the SAME
    spellings, and both sit over a rendered grand staff with a flat key signature (5 flats in
    the brace). Screenshots: /tmp/qa-flats/01-solfege-full.png + 02-letters-full.png show the
    sheet + bars together; 01b/02b-*-stage.png are the cropped canvas reads.
  - CONSOLE: 0 errors, 0 pageerrors across load + names-cycle (solfege->letters). Hand-mute +
    Balance controls correctly visible (two-staff grand staff). This CLOSES #56 and #58.
  - METHOD note (fast + reliable for label QA): the sheet overlay writes literal
    `<span class="sheet-label">` text, so read those spans directly for an EXACT label assertion
    (no OCR). The falling-BAR names are canvas-painted, so those must be read by screenshot.
    Default label mode on boot is "solfege" (localStorage `pianoHelper.noteNames`); `#names-btn`
    cycles solfege->letters->off. Driver (transient): qa-flats-drive.mjs in worktree root
    (deleted after); fixture + screenshots persist at /tmp/qa-flats/.

- 2026-05-31: issue #88 / PR #97 (upgrade OMR worker to oemer 0.1.8 on numpy 2.x so the
  primary engine stops crashing on `np.int` and scanned grand-staff piano scores stop
  collapsing into one part) -> **PASS** on prod (https://piano-helper.pages.dev, bundle
  `index-5TCZSbdV.js`). This is the FIRST real OMR end-to-end QA: prior #88-blocked passes
  could not exercise the scan path. Drove the live site in real Chromium (Playwright) with
  the EXACT user-reported file `/Users/simonepasculli/Documents/MuseScore4/Scores/icarus.pdf`
  (clean 27-measure grand staff: treble melody + bass block chords, 4/4, no key sig).
  - CORE ACCEPTANCE (the proof oemer recovered BOTH staves): after the scan loaded,
    `#hand-mutes` is VISIBLE (`hidden:false`, computed `display:flex`, rect 457.875x29.78 on
    screen) with Right hand + Left hand toggles + Balance "L100 R100". Baseline before load
    was correctly hidden (`display:none`, rect 0x0). Visible == `hasBothHands` true == oemer
    produced both a right- and left-hand note set. The collapsed homr shape would leave it
    hidden. Track read "Page-1 / 119 notes", 0:52 duration. Screenshot /tmp/qa-icarus/02-loaded.png
    shows the rendered GRAND STAFF: a piano brace joining a treble (G-clef) melody staff over
    a bass (F-clef) block-chord staff, 4/4, measure numbers 3/5/7/9, subtitle "Transcribed by
    Oemer" (confirms the oemer engine, not the homr fallback). 04-playing.png: Pause showing,
    0:01/0:52, cursor advanced into m2, a SECOND multi-staff system (m10-20) rendered, falling
    notes split into treble + bass registers with solfege labels.
  - NETWORK proof (full trace captured): `POST /api/omr` -> 202 with a real jobId; ~112 polls
    of `/api/omr/result` returned 404 `{"status":"pending"}` while oemer ran; the final poll
    returned **200 with 39290 bytes of real MusicXML** (`<?xml ... score-partwise PUBLIC
    "-//Recordare//DTD MusicXML 4.0 Partwise...`), NOT the failure sentinel. PAGE ERRORS: 0.
    The 102 "console errors" are EXACTLY one per pending-poll 404 ("Failed to load resource:
    404"); that is expected polling noise, not a regression (the result endpoint returns 404
    until ready by design, src/omr.ts treats 404 as pending).
  - ENGINE-LEVEL proof (ran oemer directly on the rasterized page before the live drive): the
    worker venv at `/Users/simonepasculli/piano-helper-omr/.venv` has oemer 0.1.8 on numpy
    2.4.6; running `oemer page-1.png` produced a 39KB MusicXML with `<staves>2</staves>` (ONE
    part, TWO staves = correct grand-staff shape), BOTH a `<sign>G</sign>` and `<sign>F</sign>`
    clef, 72 notes on staff 1 (treble/RH) + 56 on staff 2 (bass/LH), 27 measures, exit 0, NO
    `np.int` crash, NOT the sentinel. The homr-collapsed failure would have been a single
    staff/one clef/no `<staves>2</staves>`. This is the root-cause fix verified at the engine.
  - WORKER TOPOLOGY (correction to omr-worker/README.md, which describes an Oracle ARM VM):
    in this environment the worker actually runs LOCALLY on this Mac via launchd job
    `com.pianohelper.omr` (plist ~/Library/LaunchAgents/com.pianohelper.omr.plist), code at
    `/Users/simonepasculli/piano-helper-omr/worker.py`, log at `.../worker.log`. It polls R2,
    rasterizes PDFs with poppler `pdftoppm -r 300`, runs oemer (CoreML/CPU onnxruntime) then
    homr. The worker shells oemer as a subprocess, so the in-place venv upgrade took effect
    with no restart. Confirmed it sniffed icarus as `application/pdf` (not the octet-stream of
    old QA fake-PNG injects) and logged "recognized via engine output ...oemer-out/page-1.musicxml".
  - PERFORMANCE GOTCHA (record for future scan QA): on this Mac, oemer 0.1.8 on a single
    300-DPI page took ~3 min wall (700+s user across cores) when run alone, and the prod run
    took ~5 min wall (04:01:13 upload -> 04:06:28 result) because it shared cores with the
    direct probe. So the README's "1-2 min/page" is optimistic here; budget UP TO ~5-6 min and
    do NOT run two oemer jobs at once. The app polls every 3s for 15 min (src/omr.ts), so it
    tolerates this; the scan overlay just stays up the whole time ("Scanning sheet... this can
    take a minute"), which is expected, not a hang. To distinguish hang vs work: oemer pid in
    ps state `R` with climbing CPU time == still computing; the slow tail is the single-threaded
    note-assembly phase AFTER the CoreML inference logs ("Extracting layers of different
    symbols" is the last thing it logs before a long quiet stretch).
  - The benign "Note N is not a valid note" lines oemer prints are per-symbol warnings; it
    still produces a full score. Driver + screenshots (transient): qa-icarus.mjs in worktree
    root (deleted after), screenshots persist at /tmp/qa-icarus/ (02-loaded.png, 04-playing.png)
    and the engine-probe MusicXML at /tmp/qa-icarus/oemer-out/page-1.musicxml. This CLOSES #88.

- 2026-05-31: PR #94 / issue #93 (re-enable controls synchronously on sheet-scan cancel) ->
  **PASS** on prod (https://piano-helper.pages.dev, `main` @ 7121fed, served bundle
  `index-5TCZSbdV.js`; bundle no longer contains `wasAudio`, the dropped branch). Drove live
  in real Chromium (Playwright), re-ran the EXACT #93 repro. This CLOSES #93 and the #86 work.
  - CORE FIX VERIFIED (was the FAIL): load a normal score, start a scan (inject a fake PNG into
    `#scan-input`; OMR 404s per #88, fine), click Cancel -> at the EARLIEST probe (+27ms) the
    overlay is hidden AND Play/Export/seek/prev/next are ALL `disabled=false`, and they stay
    enabled across a dense 2.5s poll (88 samples, 0 bad). Same for Escape (89 samples, 0 bad).
    Pre-fix these were stuck `disabled=true` for the whole ~2-4s in-flight `/api/omr` window.
    The re-enable is now synchronous, exactly matching the audio path. Screenshots:
    /tmp/qa-issue93/03-after-click-cancel.png and 09-status-after-cancel.png (overlay gone,
    "QA93 Score"/"N notes" in the slot, Play purple/enabled).
  - STATUS clears too: `cancelScanOverlay()` -> `restoreSheetName()` HIDES `#track-status`
    (sets `.hidden=true`) and shows `#sheet-name` + `#sheet-note-count`. At +30ms the user-
    VISIBLE status is null and the slot reads the sheet name + count again, so "Scanning
    sheet..." is no longer on screen synchronously.
  - GOTCHA (cost me a re-probe): do NOT assert on `#track-status`.textContent to prove the
    "Scanning sheet..." message is gone. `restoreSheetName` only sets `.hidden=true`; it does
    NOT clear the textContent, so a raw `.textContent` read still returns the stale string even
    though the user sees nothing. Gate on visibility: `el.hidden === true` (and/or rect 0x0)
    for `#track-status` AND `#sheet-name` becoming visible with the score name. The first driver
    pass logged status="Scanning sheet..." at every timepoint and looked like a FAIL until I
    checked `.hidden` (it was true throughout post-cancel).
  - STEP 5 (Play after cancel) PASS: clicked Play immediately after cancel; `#play-label`
    flipped to "Pause" and the transport ran (headless audio clock advanced on prod). The
    restored score is fully usable right away, not after a delay.
  - STEP 6 (cancel-then-restart) PASS: load, scan, Cancel, then immediately inject a second
    scan -> the second overlay shows correctly and STAYED UP for a full 6s watch (0 early
    closes) while the first (abandoned) scan's `/api/omr` settled in the background; controls
    stayed correctly greyed UNDER the second overlay (busy state intact). The `scanSheet`
    generation guard (`if (generation === jobGeneration)` in its finally, main.ts ~656) means
    a late settle of the abandoned scan does not stomp the newer job. Screenshot:
    /tmp/qa-issue93/07-second-overlay-after-6s.png (the 2nd "Scanning your sheet" overlay up).
  - STEP 7 (audio-path regression) PASS: synthesized a ~2s tonal WAV, injected into
    `#audio-input`, caught the transcribe overlay, cancelled -> 0 bad samples over 1.5s
    (overlay hidden + all controls enabled at +30ms). Audio path still cancels cleanly.
  - CONSOLE: only the expected `/api/omr` 404s (OMR backend down, #88), 0 pageerrors. Not a
    failure per #88.
  - METHOD that proved synchronous: poll `el.disabled` + `overlay.hidden` every 25ms for ~2.5s
    starting the tick AFTER the cancel click, then report the nearest sample to +30/100/200/
    500/1000/2000ms. "0 bad samples of 88" is the clean proof the window is gone (vs the #86
    pass where +30..2000ms were all `disabled=true`). Drivers were transient (qa-issue93.mjs,
    qa-issue93-status.mjs in worktree root, deleted after); screenshots persist at
    /tmp/qa-issue93/.

- 2026-05-31: issue #86 (scan/transcribe loading overlay, `#scan-overlay`) -> **FAIL** on prod
  (https://piano-helper.pages.dev, `main`, bundle `index-tvPITG1-.js`). Bug filed as **#93**.
  Drove live in real Chromium (Playwright). Most of the overlay is correct; one path leaves
  the app in a broken-but-no-overlay state.
  - OVERLAY itself PASSES on BOTH paths: scan shows the spinner + "Scanning your sheet" heading
    + body copy + Cancel + the "scan keeps running on our side" note, over a dimmed stage with
    the toolbar fully visible above it (`z-index:5`, `position:absolute`, rect 1280x800 top=0).
    Audio shows "Transcribing your audio". `role=dialog` + `aria-modal=true` + `aria-busy=true`
    present; focus moves to `#scan-overlay-cancel` on open and back to `<body>` on close. Cancel
    AND Escape both hide the overlay synchronously with NO "Scan failed"/alert. Console clean
    except the expected `/api/omr/result` 404 (OMR backend down, #88).
  - FAIL = STEP4 controls-after-cancel regression, but ONLY on the **scan** path (the audio
    path re-enables fine). After Cancel/Escape on a scan, the overlay hides instantly but
    Play/Export/seek/prev/next stay STUCK DISABLED for the full in-flight `/api/omr` round-trip
    (measured `disabled=true` at +30/200/500/1000/2000ms; re-enabled only between +2000-4000ms
    when `submitOmr`'s fetch settled). With a slow-but-healthy backend this window = the whole
    submit+poll latency: the user sees a usable-looking score with dead transport and the
    toolbar still reading "Scanning sheet...". Screenshot proof: /tmp/qa-issue86/BUG-stuck-controls.png
    (overlay gone, Play/step/Export greyed, status still "Scanning sheet...", "QA86 Score" on
    screen). Root cause: `cancelScanOverlay()` (main.ts ~618-627) only calls `setBusyUI(false)`
    in the `if (wasAudio)` branch; the scan path's re-enable lives in `scanSheet`'s `finally`,
    which waits for `submitOmr` + the next poll-loop `isCancelledRequested()` check (omr.ts ~86,
    only read at the TOP of the loop, after the in-flight fetch settles). The #86 review "fix"
    (controlsEnabledForScore in setBusyUI(false), main.ts ~567-574) is correct but the scan
    cancel never calls it synchronously. Fix: have `cancelScanOverlay()` call setBusyUI(false) +
    restoreSheetName() for the scan kind too (idempotent with the late finally; also consider a
    generation guard on scanSheet's finally like transcribeAudio already has).
  - GOTCHA that masked this on the first pass: whether "Play STILL works after cancel" passes is
    a RACE. If the post-cancel Play click lands after the ~2-4s window (fast/404 backend) it
    works; inside the window it is dead. Do NOT sample control state once after a fixed delay;
    POLL `el.disabled` every ~60ms for several seconds after Cancel and assert it is enabled
    IMMEDIATELY (the bug is the window, not the eventual recovery).
  - GOTCHA (audio overlay never appears with a tiny/garbage WAV): a short or invalid WAV fails
    `loadAudioFile` fast, so `transcribeAudio`'s finally hides the overlay before a ~500ms probe;
    you catch only the title text ("Transcribing your audio") on a hidden node. Use a longer,
    genuinely tonal clip (e.g. ~2s @16kHz, fundamental + harmonics + decay) and POLL every ~60ms
    to catch the overlay visible mid-transcription. Caught it visible at +4ms that way.
  - GOTCHA (Playwright evaluate arg passing): `page.evaluate(fn, arg)` passes exactly ONE arg.
    A multi-param inject helper must take a single tuple and destructure (`function inject([id,
    name, type, bytes]) {...}`), else `document.getElementById(id)` is null (id===the whole
    array). Inject a `File` via `DataTransfer` into `#file-input` (MusicXML), `#scan-input`
    (PDF/image), `#audio-input` (audio) + dispatch `change`. A fake PNG (`89 50 4e 47 ...`) is
    enough to trigger the scan overlay since the backend 404s anyway.
  - Drivers (transient, in worktree root where node resolves local playwright): qa-issue86.mjs,
    qa-issue86-timing.mjs, qa-issue86-audio.mjs. Screenshots at /tmp/qa-issue86/.

- 2026-05-31: PR #91 / issue #90 fix-forward (collect clefs from real single-staff OSMD
  parses so collapsed treble->bass scans split into hands) -> **PASS** on prod
  (https://piano-helper.pages.dev, main @ 10a60e9, served bundle `index-S08hI_BF.js`, which
  contains `LastInstructionsStaffEntries` x13). Re-ran the EXACT #90 repro live in real
  Chromium (Playwright): one single-staff part, NO `<staves>`, measure 1 treble (C5 D5 E5 F5)
  then measure 2 bass clef (C3 D3 E3 G3); OSMD renders it as one staff that flips clef
  mid-line. This is the case that was the original FAIL.
  - CORE FIX (was the FAIL): `#hand-mutes` now becomes VISIBLE after load: `hidden` attr
    false, computed `display:flex`, rect 458x30 on screen; Right hand + Left hand toggles +
    Balance slider + readout "L100 R100" all present. Track reads "8 notes". Visibility is
    driven by `handMutes.hidden = !hasBothHands(score.notes)` (main.ts:246), so visible ==
    `hasBothHands` true == both a right- and a left-hand note set exist. Pre-fix this stayed
    hidden.
  - HAND TAGGING correct (authoritative read = the falling-note caps, NOT gain hooks):
    seek-to-0 screenshots show the 4 BASS notes (C3-G3, lower-left register) and the 4 TREBLE
    notes (C5-F5, upper-right register) as two distinct clusters. With LEFT muted, the bass
    cluster (Do/Re/Mi/Sol on the left of the keyboard) goes DIM/GHOSTED while the treble
    cluster (Do/Re/Mi/Fa) stays BRIGHT (#54 ghosting). So treble measure = right hand, bass
    measure = left hand, exactly. The before/after of the same seek-0 frame is the cleanest
    proof.
  - Controls WORK: mute-left aria-pressed false->true and ghosts only the bass; Balance slider
    +60 -> readout "L40 R100", -60 -> "L100 R40". Transport advanced under playback (0:00 ->
    0:03 on the 0:04 score, Pause showing), cursor tracked onto the final bass "Sol".
  - REGRESSION GUARD: a genuine two-staff grand staff (same pitches, `<staves>2</staves>`)
    still renders with the brace as TWO staves, shows the controls, splits low/high registers,
    and mute-right works (aria-pressed true, right cluster ghosts). Unchanged. "8 notes".
  - Console: ZERO errors and ZERO pageerrors across load + mute + balance + play for BOTH the
    single-staff and grand-staff scores. This CLOSES #90 and the #87 work. (icarus.pdf OMR
    path still blocked on the OMR backend, #88; not exercised, per the ticket.)
  - GOTCHA confirmed (do not rely on the gain hook for the per-hand audio proof here): the
    AudioBufferSourceNode.start -> connected GainNode.gain read that worked for #75 is FLAKY
    on this short 2-measure score. Baseline showed 5 `null` gains + 7 `1`s, mute traces gave
    inconsistent counts, and the attenuated 0.40 balance gain never appeared (bundled Tone
    sampler routes through a separate gain the hook misses, plus the ~4s score rewinds
    mid-capture). The VISUAL hand-cap ghosting (seek-0 before/after screenshot) is the
    reliable per-hand evidence for short fixtures; use it instead of gain counts. Screenshots
    at /tmp/qa-pr91/ (transient): A-nomute-seek0.png vs A-leftmute-seek0.png show the split.

- 2026-05-31: #90 (the #87 fix did NOT work against a real OSMD parse: per-hand controls
  stayed hidden for a collapsed single-staff treble->bass scan). Root cause was in
  `readClefDeclarations` extraction, not the hand-tagging helpers: (1) OSMD 1.9.9 leaves
  `ParentStaff === undefined` on the clef instruction entries of a SINGLE-STAFF instrument, so
  the `staffId == null` guard dropped every clef; (2) a mid-piece clef change lives in
  `LastInstructionsStaffEntries` of the PRECEDING measure, but the code only read the First
  bucket. Tech-lead fixed both + added the FIRST real-OSMD-parse regression test
  (`src/score.test.ts`, jsdom, parse-only via `osmd.load()`; full `extractScore`/render cannot
  run in jsdom because VexFlow needs a real Canvas2D). When re-verifying live: load a one-part,
  no-`<staves>`, treble-then-bass MusicXML and confirm `#hand-mutes` becomes visible with 4
  right + 4 left notes. The icarus.pdf OMR path is still blocked on the OMR backend (#88).

- 2026-05-30: PR #80 (Bug 3 / issue #70 follow-up: audio-derived scores now tag each note by
  pitch (MIDI >= 60 = right, below = left) instead of "unknown", so `hasBothHands` can be true
  and the per-hand mute toggles + Balance slider become reachable for two-handed audio clips)
  -> **PASS** on `main` (merge commit 52a0c93, deployed to https://piano-helper.pages.dev,
  smoke green). Local 5173 preview was DOWN (no bundle served), so drove LIVE against PROD in
  real Chromium via Playwright. Confirmed served bundle = `index-6RayvARc.js` (the target).
  Synthesized piano-ish mono 16-bit PCM WAVs in-page (fundamental + 2nd/3rd harmonics, exp
  decay), wrapped in a `File`, injected via `DataTransfer` into `#audio-input` + a `change`
  event. Basic Pitch ran end to end (TF.js fell back from WebGL to CPU/WASM headlessly) and
  transcribed in ~3-4s.
  - BEFORE any import: `#hand-mutes` hidden (attr=true, computed `display:none`, rect 0x0),
    `#play-btn` disabled. This is the boot baseline.
  - Case 1+2 (two-register clip: C3 ~130.81Hz x3 + C5 ~523.25Hz x3): transcribed to "6 notes",
    and `#hand-mutes` flipped VISIBLE: `hidden` attr=false, computed `display:flex`, rect
    458x30 on screen. `#mute-right-btn` ("Right hand") + `#mute-left-btn` ("Left hand") +
    `#balance-slider` + `#balance-readout` ("L100 R100") all present. Screenshot shows a low
    "Do" (C3, left of center) and a high "Do" (C5) falling, i.e. the clip genuinely split into
    both hands. THIS IS THE CORE ACCEPTANCE: controls reachable for a two-handed audio clip,
    where pre-fix they stayed hidden (all notes were "unknown").
  - Case 3 (exercise a control): clicking `#mute-right-btn` flipped its `aria-pressed`
    false->true (left stayed false). With right muted, the high "Do" (right hand) renders
    DIM/ghosted while the low "Do" (left) stays bright purple (#54 ghosting). Dragging
    `#balance-slider` to +60 updated `#balance-readout` "L100 R100" -> "L40 R100". During live
    playback (prod autoplay ran: time 0:00->0:01, transport advanced) the muted right "Do"
    stayed ghosted while the active left "Do" hit the keybed with the bright #27 contact glow,
    so mute layers correctly on top of a non-center balance during a live transport.
  - Case 4 (negative/correctness: single-register clip C5/E5/G5, all >= middle C): transcribed
    to "8 notes" (Do/Mi/Sol/Re, all upper register) and `#hand-mutes` correctly stayed HIDDEN
    (attr=true, computed `display:none`, rect 0x0). Single-register clips read as one hand, so
    the controls are absent. Confirms the split is pitch-driven, not unconditional.
  - Case 5 (console): ZERO real errors and ZERO pageerrors across import + toggle + slider +
    play, for BOTH clips. The only console noise is benign TF.js backend fallback
    ("Initialization of backend webgl failed" / "WebGL is not supported on this device") from
    headless Chromium having no GPU; this is a warning, transcription still succeeds on CPU.
  - GOTCHA (cost me two failed runs): `page.evaluate(stringBody, arg)` in Playwright does NOT
    pass `arg` when the first param is a STRING (it just evals the string and drops args). The
    in-page synth+inject returned `undefined` / the change handler never fired ("No file
    loaded" stuck) until I passed a REAL JS function reference (`page.evaluate(fn, payload)`).
    A `snap("label")`-style helper that RETURNS a string with the label already baked in is
    fine to pass as a no-arg string. The audio `change` handler itself works exactly like the
    file path: it reads `audioInput.files?.[0]`, so `input.files = dt.files` + dispatch
    `change` drives it. (Also `input.files.length` reads 0 right after assignment in headless
    even though transcription proceeds, so do not gate on filesLen; gate on the status
    transitioning to "Transcribing..." then play-btn enabling + the note count un-hiding.)
  - Regression checklist clean: solfege labels render on the falling notes (Do/Mi/Sol/Re),
    key-face approach labels show, falling bars meet the keyboard, #27 contact glow + per-hand
    color still render, and the single-staff/audio HIDE rule (#76/#77) holds (computed
    `display:none`, verified by `getBoundingClientRect`, not just the attr).
  - Driver + screenshots (transient): qa-pr80-v2.mjs + qa-pr80-probe.mjs in the worktree root
    (where node resolves the local `playwright`); screenshots at /tmp/qa-pr80/*.png.

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
