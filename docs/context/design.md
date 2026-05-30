# Design context

UX, visual design, interaction decisions. Append durable learnings at the top of the
relevant section, dated.

## Aesthetic

- **Neon-on-dark** "Synthesia" look: purple accent (`--accent: #b14bff`) glowing falling
  notes on a near-black stage (`--bg: #0a0712`), light keyboard at the bottom.
- Falling note bars have a soft glow (canvas `shadowBlur`); white-key notes are brighter
  than black-key notes.

## Layout

- **2026-05-30 — Split view:** sheet music on top (~42% height, light panel, scrollable),
  falling notes + keyboard below. Mirrors how a player reads notation while watching keys.
- A glow strip sits just above the keyboard where notes "land."

## Interaction

- Top bar: Load file, Play/Pause, current track name.
- The sheet highlight cursor (OSMD default green box) follows playback in lockstep with the
  falling notes and the lit key. **Open polish item:** recolor the cursor to the purple
  accent for brand cohesion.

## Open UX questions

- Seek/scrub control and a progress/time indicator.
- Tempo control (playback speed) separate from the score's notated tempo.
- Hand/voice coloring (left vs right hand) like Synthesia.
