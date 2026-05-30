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

## Note name labels (issue #11)

- **2026-05-30 — Spec for showing note names on keys and falling notes.** Concrete, ready to
  implement.

  **1. Naming system + toggle.** Default to **solfege, fixed-Do** (Do Re Mi Fa Sol La Si).
  Rationale: this is a learning tool and the issue itself uses solfege ("Do Si Re"). Italian
  fixed-Do is the convention in most of Europe and Latin America where solfege learners live,
  and fixed-Do maps one pitch to one syllable so it does not depend on key, which keeps the
  rendering logic trivial (pitch class -> label, no key analysis). We use **"Si"** for the
  7th degree (Italian/French), not "Ti". Provide a 3-state cycle control (see topbar below):
  **Solfege -> Letters -> Off**. Letter mode uses C D E F G A B. Do not implement movable-Do
  in v1 (it needs the score key and reharmonization handling that we do not have yet).

  **2. Placement.** Labels live in two places:
  - **Piano keys (always on when labels are enabled):** draw the label centered horizontally
    near the **bottom of every white key** (baseline about 10px above the key bottom). Do NOT
    label black keys on the key face. There is no horizontal room (black key ~14px wide) and
    accidental names are 2-3 glyphs. The natural-key labels alone give the learner a reference
    grid; the black key is read as "the sharp/flat next to Do", which is how beginners orient.
  - **Falling note bars (the head only):** draw the label inside the **bottom of the bar**
    (the leading edge, the part about to land) for BOTH white and black notes, but only when
    the bar is wide enough and tall enough (see gating below). This is where the eye is, so it
    is the highest-value spot and it is what makes black-note names visible.

  **3. When labels show.** Controlled by the topbar toggle (default **Solfege ON**). When on:
  - Key-face labels: render on all 52 white keys, always.
  - Falling-bar labels: render only if the bar's drawn width >= 16px AND bar height >= 18px,
    to avoid clutter on dense fast passages and grace notes. The **active (currently sounding)
    key** always gets its label drawn even if narrow, in the brighter active color, because
    that is the note the player needs right now.
  - When toggle is Off: no labels anywhere; falling bars and keys render exactly as today.

  **4. Accidentals + octave.**
  - **Key face: no octave number, natural pitch class only.** White keys show the 7 naturals
    (Do Re Mi Fa Sol La Si / C D E F G A B). Octave clutter is not worth it at ~20px wide.
  - **Falling bar: name plus octave on white-note bars when width allows; black notes show the
    accidental name with no octave.** Format:
    - Solfege sharps: `Do#`, `Re#`, `Fa#`, `Sol#`, `La#` (use sharp spelling only, ASCII `#`).
    - Letter sharps: `C#`, `D#`, `F#`, `G#`, `A#`.
    - White-note octave is appended ONLY in letter mode and ONLY on the bar (e.g. `C4`), since
      letter+number is the familiar scientific-pitch format. In solfege mode show the syllable
      with no number (octave numbering is not idiomatic for fixed-Do). Keep it simple: solfege
      = syllable only; letters = letter + octave on bars, letter only on keys.
  - Always sharps, never flats, in v1. We derive from MIDI pitch class and have no key context,
    so a single consistent spelling avoids wrong enharmonics.

  **5. Readability + color.**
  - **Key-face label color:** `#5b4a72` (muted purple-gray) on the light `#f2ecf8` white key.
    Contrast ratio ~5.2:1, passes AA for small text. On the **active** white key (fill turns
    `#b14bff`) switch the label to `#1a0f2b` for contrast against the bright accent.
  - **Falling-bar label color:** `#ffffff` at full opacity, with a 1px `rgba(0,0,0,0.45)` text
    shadow (set `ctx.shadowColor`/`shadowBlur=2` while drawing text, then reset) so it stays
    legible over both the `#b14bff` and `#8a2fe0` bar fills. White on `#b14bff` is ~3.3:1, the
    shadow plus bold weight carries it for short glyph strings.
  - **Font:** `600 11px -apple-system, system-ui, sans-serif` for key faces; `700 12px` for
    falling-bar labels. `ctx.textAlign = "center"`, `ctx.textBaseline = "bottom"` for keys and
    `"alphabetic"` positioned inside the bar head for bars. Never scale below 11px; if the key
    width cannot fit the glyph at 11px (very narrow stage), skip the key-face labels for that
    render rather than shrinking (legibility floor over completeness).
  - Draw all text AFTER the key/bar fills, and reset `ctx.shadowBlur = 0` before/after text so
    the glow on bars does not bleed into glyphs.

  **6. Topbar control.** Add a small **pill cycle button** to the existing `.controls` group,
  to the right of Play and before the track name. Label reflects current state:
  `Names: Solfege` -> `Names: Letters` -> `Names: Off`, cycling on click. Reuse the existing
  button gradient style but render it slightly smaller/secondary (e.g. add a `.toggle` class:
  `padding: 0.4rem 0.75rem; font-size: 0.8rem`). Default state on load: **Solfege**. Persist
  the choice in `localStorage` (`pianoHelper.noteNames`) so it survives reloads. The naming
  function lives next to `midiToName` in `src/piano.ts` (add `midiToLabel(midi, mode)` so the
  visualizer asks piano.ts for the string and stays presentation-only).

## Open UX questions

- Seek/scrub control and a progress/time indicator.
- Tempo control (playback speed) separate from the score's notated tempo.
- Hand/voice coloring (left vs right hand) like Synthesia.
