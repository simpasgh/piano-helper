# QA context

Accumulated quality knowledge for Piano Helper. Newest entries first. QA owns this file.

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
