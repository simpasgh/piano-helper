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

- **2026-05-30 — Input is MusicXML, not MIDI.** MIDI carries no real notation (no
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
