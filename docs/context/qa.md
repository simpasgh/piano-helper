# QA context

Accumulated quality knowledge for Piano Helper. Newest entries first. QA owns this file.

## Post-merge QA results (newest first)

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

- Load a grand-staff score: the per-hand mute toggles (`#hand-mutes`) appear; a single-staff
  or audio score keeps them hidden.
- Note names: scale to the bar and stay inside it; truly tiny bars omit the name rather than
  showing an oversized pill (#39).
- Falling notes meet the keyboard with no element wider than the note at the entry (#38).
- Contact glow (#27) and per-hand rail stripes (#36) still render.
- Browser console has no new errors after load, play, and the feature interaction.

## Known gotchas

- 2026-05-30: A toggle's `aria-pressed` style can read as unchanged if you sample
  `getComputedStyle` in the same tick as the click (mid CSS transition). Set the attribute
  and re-read, or wait a frame, before concluding the pressed state does not apply.
- 2026-05-30: Several early features (#37 per-hand mute among them) were merged with the
  delivery agent explicitly unable to verify live. Treat any "could not verify live" line in
  a PR as an open QA item until smoke-tested on `main`.
