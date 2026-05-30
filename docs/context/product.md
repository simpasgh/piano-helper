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
