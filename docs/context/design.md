# Design context

UX, visual design, interaction decisions. Append durable learnings at the top of the
relevant section, dated.

## Aesthetic

- **Neon-on-dark** "Synthesia" look: purple accent (`--accent: #b14bff`) glowing falling
  notes on a near-black stage (`--bg: #0a0712`), light keyboard at the bottom.
- Falling note bars have a soft glow (canvas `shadowBlur`); white-key notes are brighter
  than black-key notes.

## Visualizer color + polish (issue #12)

- **2026-05-30 — Beautify the piano + falling-notes view: pitch-class palette + bar/key/
  landing polish.** Concrete, Canvas-2D-ready spec. Data constraint: a note carries only
  `{ midi, time, duration }`, so coloring is by **pitch class (0-11)**, never by hand/voice.
  The purple identity is kept as the anchor of the wheel.

  **0. Helpers to add (in `src/piano.ts`, presentation strings/colors live here).**
  Add `pitchClass(midi)` (already inline as `((midi % 12) + 12) % 12`) and a pure color
  helper `noteColor(midi, { black, active })` returning the hex/hsl strings below. The
  visualizer stays presentation-light and asks piano.ts for colors, mirroring how it asks
  for labels.

  **1. Palette: pitch-class hue wheel, purple-anchored.**
  Map pitch class to hue around the full wheel so all 12 notes are distinguishable, but
  rotate the wheel so **C (Do) lands on the brand violet**, keeping purple as the visual home
  key. The chromatic circle reads as a smooth rainbow that loops back to violet at the octave.

  - **Hue rule:** `hue = (276 + pc * 30) mod 360` degrees. (276deg is the hue of `#b14bff`.)
    This gives, by pitch class 0..11 (C, C#, D, D#, E, F, F#, G, G#, A, A#, B):

    | pc | note | hue | role |
    | --- | --- | --- | --- |
    | 0  | C  / Do   | 276 | violet (brand anchor) |
    | 1  | C# / Do#  | 306 | magenta |
    | 2  | D  / Re   | 336 | pink-red |
    | 3  | D# / Re#  | 6   | red |
    | 4  | E  / Mi   | 36  | orange |
    | 5  | F  / Fa   | 66  | amber-yellow |
    | 6  | F# / Fa#  | 96  | yellow-green |
    | 7  | G  / Sol  | 126 | green |
    | 8  | G# / Sol# | 156 | teal-green |
    | 9  | A  / La   | 186 | cyan |
    | 10 | A# / La#  | 216 | azure |
    | 11 | B  / Si   | 246 | indigo-blue |

  - **Saturation / lightness (white-key vs black-key notes).** Keep the existing "white notes
    brighter than black notes" depth cue, now per hue:
    - **White-key note bar fill:** `hsl(hue, 85%, 62%)`.
    - **Black-key note bar fill:** `hsl(hue, 70%, 50%)` (more saturated-dark so it still reads
      as a recessed/inner note, same role purple `#8a2fe0` played before).
    - These S/L values are fixed per row; **only hue varies by pitch class**, so the
      brightness depth between white and black notes is constant across the wheel.

  - **Colorblind reasoning.** Differentiation never relies on hue alone: (a) every bar also
    carries its **solfege/letter label** (issue #11) which is the primary identifier; (b)
    **screen X position is the pitch** (a piano is a position display), so two same-hue
    octaves are never adjacent and the player reads pitch from where the bar falls, not its
    color; (c) white-vs-black notes differ in lightness (62% vs 50%) as well as hue. So the
    palette is decorative reinforcement, not the sole channel. We intentionally do not place
    a pure-red and pure-green note next to each other as the only cue; adjacent pitch classes
    are 30deg apart and also one key apart horizontally.

  - **Legibility on `#0a0712`.** All fills sit at L 50-62% with high S, which is bright on the
    near-black stage (every hue clears ~4:1 luminance contrast against `#0a0712`). The white
    `#ffffff` bar labels with the existing `rgba(0,0,0,0.45)` 2px shadow stay legible over
    every hue at these lightnesses (worst case is the L62% yellow-green band; the dark shadow
    plus 700 weight carries it, same mechanism that already carries white-on-`#b14bff`). Do
    not lighten fills past L 62% or the white labels start to wash out.

  **2. Falling-note bars.**
  - **Fill:** flat `hsl(...)` per the table above (no vertical gradient per bar; a per-note
    gradient is wasted cost in the rAF loop and the glow already gives dimension). Keep
    rounded corners at **r=4**.
  - **Glow:** keep `ctx.shadowBlur = 18`, but set **`ctx.shadowColor` to the note's own hue**
    instead of the single ACCENT. Use a slightly brighter glow color than the fill so it reads
    as emission: `hsl(hue, 90%, 68%)`. This is the one change that makes the wheel sing on the
    dark stage. Cost is identical to today (one shadowColor assignment per bar, which already
    happens).
  - **Active (sounding) bar emphasis.** When `active.has(note.midi)`, bump the fill to
    `hsl(hue, 95%, 72%)` and `shadowBlur` to `26` for that bar only. Cheap, and it ties the
    falling bar to the lit key and the landing flash below.
  - **Order:** still fill all bars first, collect label geometry, then draw labels with
    `shadowBlur` reset (unchanged from #11 so glow never bleeds into glyphs).

  **3. Landing effect (the one tasteful impact cue).**
  Replace the static purple glow strip with a **hue-reactive landing strip + per-key flash**:
  - **Resting strip:** keep the 30px vertical gradient above the keyboard, but neutral so it
    does not fight the colors: `rgba(177,75,255,0)` -> `rgba(177,75,255,0.18)` (dimmer than
    today's 0.35). Build this gradient **once per frame**, not per note.
  - **Impact flash:** for each currently-active midi, draw a short vertical bloom directly
    above that key's x-range at the strip: a rounded rect (key width, ~22px tall) filled with
    the **note's glow hue** `hsl(hue, 90%, 68%)` at alpha ramped by how recently it landed.
    Cheap version with no new per-note timing state: alpha = `0.55` constant while the note is
    active (active set is already computed). Set `shadowColor` to the same hue, `shadowBlur
    16`, draw, reset. This is at most "number of simultaneously sounding notes" draws per
    frame (a handful), not per visible bar, so it stays within budget.

  **4. Keyboard.**
  - **Resting white key:** keep `#f2ecf8`. **Resting black key:** keep `#100b1a`. Keep the
    `#2a2238` white-key stroke and the `#15101f` keybed fill behind them.
  - **Active (pressed) key color = the sounding note's hue**, so the key, its falling bar, and
    its landing flash all share one color:
    - **Active white key fill:** `hsl(hue, 85%, 66%)` (slightly lighter than the bar so a
      pressed key still reads as a lit surface, not a hole).
    - **Active black key fill:** `hsl(hue, 80%, 60%)`.
  - **Active key-face label** (white keys, issue #11): keep switching to the dark `#1a0f2b`
    for contrast; it stays >= 4.5:1 against every active-hue fill at L66%. Resting label color
    stays `#5b4a72`.

  **5. Background / ambiance.**
  Add a **single cheap vertical gradient** behind everything instead of `clearRect` to
  transparent, for depth: top `#0a0712` -> bottom `#120b1f` (a hair of violet lift toward the
  keyboard so the stage feels lit from the keys up). Build it once on `resize()` (cache the
  CanvasGradient, it depends only on height) and `fillRect` the whole canvas each frame in
  place of `clearRect`. No per-note cost. Do not add vignettes, noise, or radial gradients;
  too expensive in the rAF loop for the payoff.

  **6. Accessibility + performance budget (must read before implementing).**
  - **Must not drop frames on dense passages.** The render runs every rAF over every visible
    note. Per-bar work stays at exactly **one `fillStyle` + one `shadowColor` + one
    `shadowBlur` + one `fill`** (same as today). Do not add per-bar gradients, per-bar
    `measureText`, or extra shadow passes.
  - **Reuse gradients per frame, not per note.** The landing strip gradient and the background
    gradient are frame- or resize-scoped; never create a `createLinearGradient` inside the
    note loop.
  - **No `shadowBlur` on labels beyond the existing 2px text shadow.** Glow is for bars and
    landing flashes only. Always reset `ctx.shadowBlur = 0` before any text pass.
  - **Precompute hues if needed.** `hsl()` string building per bar is fine, but if profiling
    shows it hot, cache a `pc -> {fill, glow}` lookup table (12 entries x white/black) at
    module load; values are static. Prefer this table to recomputing strings each frame.
  - **Colorblind + contrast recap:** color is reinforcement, never the only signal (label +
    X-position + lightness carry identity); all fills clear luminance contrast on `#0a0712`;
    white bar labels keep the dark shadow; active key-face labels flip to `#1a0f2b`.
  - **Scope guard:** palette + bar glow recolor + active-key hue + one landing flash + bg
    gradient. No new note metadata, no libraries, no DOM/layout changes.

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

## Sheet note-name labels (issue #17)

- **2026-05-30 — Spec for note names on the SHEET (OSMD/SVG) view.** Follow-up to #11
  (names on falling bars + keys). Implemented as an absolutely-positioned HTML overlay on
  top of the OSMD SVG inside `#sheet`. No new deps. Reuses `midiToLabel(midi, mode)` from
  `src/piano.ts`. Behavior wiring (reading notehead geometry out of OSMD) is the Tech
  Lead's; this is the visual + layout contract.

  **1. Color: single flat color, not the #12 hue wheel.** Use **`#7a2fd6`** (the brand
  violet, the darker stop of the button gradient) for all sheet labels. Reasoning: the
  staff is a light `#f6f2fb` panel and the #12 wheel was tuned for L 50-62% fills on the
  near-black stage. Several of those hues (amber `#f`, yellow-green, cyan) drop well under
  4.5:1 on `#f6f2fb` and would be illegible as 11px text. A consistent dark violet (a)
  passes AA on the light panel (contrast ~5.6:1 on `#f6f2fb`), (b) stays on-brand, (c) does
  not compete with the black notation the way red did, and (d) reads as "annotation layer,
  not part of the score." The falling bars already carry the per-pitch color, so
  cross-surface color identity is preserved where it has room; on the cramped staff,
  legibility wins. Do NOT use red (the #17 reference): red on a light staff fights
  accidentals and looks like an error mark.
  - **Halo for legibility over ledger lines / stems / the green cursor.** Each label gets a
    1px crisp text outline in the panel color so it never smears into a staff line:
    `text-shadow: 0 0 2px #f6f2fb, 0 0 2px #f6f2fb, 0 0 3px #f6f2fb;` (triple-stack the same
    light shadow to fake a halo, cheap, no canvas). This punches a light gap around each
    glyph so the violet stays readable even where it overlaps OSMD's green highlight box.
    Do not add an opaque rounded background chip; it would hide the noteheads behind it on
    dense staves.

  **2. Font.** `system-ui, -apple-system, sans-serif`, **`9px`, weight `600`**.
  Deliberately smaller and lighter than the falling-bar labels (`700 12px`) because staff
  vertical space is tight and there can be one label per chord note. `letter-spacing:
  0.01em`, `line-height: 1`, `white-space: nowrap`. `text-align: center`, each label
  positioned by its own center-x. Never scale below 9px; if a label cannot fit, skip it for
  that render rather than shrinking (legibility floor, same rule as #11).

  **3. Vertical placement.** Anchor each label's baseline **6px above the top notehead of
  its stack** (the highest-pitched notehead at that x). Reference the notehead's SVG bbox
  top, not the staff top, so labels track ledger-line notes up and down.
  - **Collision avoidance with the staff above (multi-line / two-hand grand staff).** If the
    6px offset would place a label within 4px of the bounding box of any glyph on the system
    above, clamp the label down to sit just below that system's baseline gap instead, never
    overlapping a higher staff's notes. Simplest rule the Tech Lead can implement: cap the
    label's top at `staffSystemTop + 2px` for the system it belongs to.
  - **Accidentals / measure + tempo numbers.** Labels sit above noteheads, accidentals sit
    left of noteheads, so they rarely collide; the halo handles the rare brush. OSMD's
    measure numbers and tempo text render above the top staff line on the left margin; since
    labels are centered on noteheads (which are right of the clef/margin) they do not reach
    that zone. No special-casing needed beyond the halo.

  **4. Chord stacking: one label per notehead, stacked vertically.** When a chord has
  multiple noteheads at one x, render one label per pitch, stacked **top note highest**
  (matching the chord's pitch order, so the visual order of labels mirrors the visual order
  of noteheads). All labels in a chord share the same center-x (the chord's notehead x).
  - **Vertical gap between stacked labels: 11px** (1px more than the 9px glyph cap height so
    they never touch). The lowest label in the stack sits 6px above the top notehead; each
    additional label stacks upward by 11px.
  - **Density rule (when noteheads are too close).** This stacked-above approach decouples
    label spacing from notehead spacing, so close-together chord tones never crowd their
    labels. But if two adjacent chords (different x) are horizontally closer than the wider
    of their two labels (i.e. labels would overlap left-right), **drop the lower-voice label
    of the denser pair** and keep the top-note label of each chord. Priority for keeping
    labels when space is scarce: (1) the note under the active OSMD cursor, (2) top note of
    each chord, (3) remaining chord tones top-down. This keeps the melody line always
    labeled.

  **5. Octave: omit on the sheet.** No octave numbers anywhere in the sheet labels, both
  solfege and letter modes. Justification: the staff position already encodes octave
  unambiguously (that is what a staff is for), so a number is pure clutter here, and chord
  stacks would balloon in width. This differs from the falling-bar rule (#11) where letter
  mode appends octave, because the bar view has no staff to show register. Sheet = syllable
  or bare letter only (`Do`, `Re#`, `C`, `F#`). Always-sharp spelling, ASCII `#`, same as
  #11.

  **6. Behavior / layering the design depends on.**
  - **Overlay element:** a single `<div>` (e.g. `#sheet-labels`) positioned `absolute`
    inside `#sheet` (which must be `position: relative`), sized to match the OSMD SVG,
    `pointer-events: none` so it never blocks scroll or clicks, `z-index: 1` so it sits
    **above** the OSMD SVG and above the green cursor box (the halo keeps both readable).
  - **Re-layout triggers:** rebuild label positions on score load, on the Names toggle
    (Solfege/Letters/Off), and on resize. Because `#sheet` is `overflow-y: auto` and scrolls
    independently, the overlay must scroll WITH the SVG. Put the overlay in the same
    scrolling content box as the SVG (a child of the scrolled container that grows with the
    SVG height), so scroll needs no JS, the layer translates natively. Only resize and
    re-render (which changes notehead x/y) require recomputing positions.
  - **Off mode:** set the overlay `display: none` (or skip building it). No labels anywhere
    on the sheet; OSMD renders exactly as today.

## Tempo slider (issue #14)

- **2026-05-30 — Spec for the playback-speed slider.** Ready to implement, no new deps. A
  native `<input type="range">` styled to match the violet pills; behavior wiring is the Tech
  Lead's.

  **1. Placement.** Add a `.tempo` control group inside `.controls`, **after the Names toggle,
  before `#track-name`**. Group is `display: inline-flex; align-items: center; gap: 0.5rem`.
  Order inside: a small static label `Tempo`, then the slider, then the numeric readout. The
  readout is the reset affordance (see 4), so it is the last item the eye lands on.

  **2. Range / default / step.** `min="25" max="200" value="100" step="5"`. Percent of notated
  score tempo. Step 5 gives clean keyboard increments (arrow = 5%, the practical practice
  granularity) and lands exactly on 100. Readout **is** a percentage.

  **3. Readout.** A `<span id="tempo-readout">` showing e.g. `100%`. Sits immediately right of
  the slider. Font `600 0.8rem`, color `var(--text)` at `opacity: 0.85`, `min-width: 3.2ch`,
  `text-align: right` so the row does not jitter as digits change. The `Tempo` label left of
  the slider is `0.8rem`, `opacity: 0.55` (matches `.track-name` muted weight).

  **4. Reset.** **Click the readout to snap back to 100%.** Simplest discoverable affordance
  (double-click on a thin slider track is easy to miss). Give the readout `cursor: pointer`,
  `title="Reset to 100%"`, and make it a real `<button>` (so it is keyboard/Enter operable and
  focusable) styled flat: no gradient, transparent background, no border, inherit the readout
  type above; add a subtle `:hover { opacity: 1 }`.

  **5. Visual styling (match the violet pills).** Slider width `120px` (`max-width: 120px`).
  - **Track:** height `4px`, `border-radius: 2px`, background
    `linear-gradient(90deg, #7a2fd6, var(--accent))` (same gradient the buttons use), so the
    track reads as part of the brand.
  - **Thumb:** `16px` circle, `background: #f2ecf8` (the white-key tone), `border: 2px solid
    var(--accent)`, `border-radius: 50%`, `box-shadow: 0 0 6px var(--accent-glow)` for the neon
    halo. `cursor: pointer`. Style for both `::-webkit-slider-thumb` (with
    `-webkit-appearance: none`) and `::-moz-range-thumb`; set `appearance: none` on the input.
  - **Focus:** keyboard focus on the slider shows `outline: 2px solid var(--accent); outline-
    offset: 3px` (do not remove the default outline without replacing it). Same outline on the
    readout button when focused.
  - **Accessibility:** `aria-label="Playback tempo, percent of score speed"` on the input;
    `aria-valuetext` is provided natively by the range. Thumb is 16px and the input has
    `padding: 6px 0` so the vertical hit target clears ~28px (>= 24px AA target). Track gradient
    on `--bg` and the `#f2ecf8` thumb both clear 4:1 contrast. Reset button label is the visible
    `%` text plus the `title`.

  **6. Responsive.** When the header gets narrow, the **`Tempo` text label hides first**
  (`@media (max-width: 720px) { .tempo > .tempo-label { display: none } }`) since the slider +
  `%` readout are self-explanatory together. Below that, the slider shrinks to `max-width: 88px`
  before anything wraps. `#track-name` is already the flexible/truncating element, so the tempo
  group keeps its intrinsic size and the track name gives way. Do not let the slider drop under
  `72px` wide (thumb travel gets too coarse for 5% steps).

## Playback transport: seek + step (issue #29)

- **2026-05-30 — Spec for the scrub timeline + prev/next-note step buttons.** Ready to
  implement, no new deps. Native `<input type="range">` + buttons styled to match the violet
  pills; behavior wiring is the Tech Lead's.

  **1. A dedicated second topbar row, not inline.** The seek bar must be wide for usable thumb
  travel, so it gets its own `.transport` row below `.controls`. The topbar becomes a
  two-row vertical stack: wrap both rows in a `.topbar-rows` flex column (`flex: 1; min-width:
  0`) so the seek bar and track name can shrink instead of overflowing, and keep `<h1>` to its
  left. Change `.topbar { align-items: center }` to `flex-start` so the title pins to the top
  of the taller stack.

  **2. Relocate `#play-btn` into the transport row.** Play moves out of `.controls` (where it
  sat among the file loaders) into `.transport`, clustered with prev/next. Order in
  `.transport`: `#prev-note-btn`, `#play-btn`, `#next-note-btn`, then the wide `#seek-slider`
  (`flex: 1`), then `#time-readout` on the right. Rationale: Play, prev, next, and seek all
  operate on a loaded score, so they belong together; the loaders (Load/Scan/From audio),
  Export, Names, and tempo stay in the top `.controls` row.

  **3. Seek slider range is fixed `0..1000` (per-mille), not seconds.** Map `value/1000 *
  duration` to time; drive `value` from playback position each frame (throttled is fine). A
  fixed range keeps native step granularity smooth and avoids resetting `max` on every load.
  Track styling mirrors `#tempo-slider`: `height 5px`, `border-radius 3px`, gradient
  `linear-gradient(90deg, #7a2fd6, var(--accent))` painted on `::-webkit-slider-runnable-track`
  / `::-moz-range-track`. Firefox `::-moz-range-progress` fills the played portion in
  `var(--accent)`. Thumb is an 18px `#f2ecf8` circle, `2px solid var(--accent)`, `box-shadow
  0 0 8px var(--accent-glow)`, growing to 12px glow + `scale(1.08)` on hover/active for drag
  feedback. Input has `padding: 8px 0` so the vertical hit target clears ~28px (>= 24px AA).
  Disabled state: `opacity 0.4`, no glow, `cursor: not-allowed`.

  **4. Step buttons use Unicode transport glyphs, no icon lib.** Prev `◀|`
  (`&#9664;&#124;`), Next `|▶` (`&#124;&#9654;`) (standard skip-to-prev/next marks). Glyph is
  wrapped in an `aria-hidden` span; the accessible name comes from `aria-label` ("Previous
  note" / "Next note") on the button. `title` surfaces the keyboard shortcut ("Previous note
  (Left arrow)" etc). `.step-btn` is compact: `min-width 2.4rem`, `padding 0.5rem 0.6rem`,
  inheriting the existing button gradient + hover/disabled rules (no extra color work).

  **5. Keyboard-shortcut hints live in tooltips, not visible text.** Space = play/pause,
  Left/Right = prev/next note. Surface via `title` on Play and the step buttons rather than a
  visible hint line, to keep the neon bar uncluttered. A muted `0.7rem` line under the
  transport row is the place if an always-visible hint is wanted later (skip for v1).

  **6. Time readout.** `#time-readout` shows `current / total` as `m:ss` (e.g. `0:00 /
  3:24`), `font-variant-numeric: tabular-nums`, `min-width 9ch`, `text-align right` so digits
  do not jitter. It is `aria-hidden`; instead set the slider's `aria-valuetext` to the same
  `m:ss` string so screen-reader users get position without a duplicate live region.

  **7. Lifecycle + responsive.** All four interactive transport elements start `disabled`,
  enabled together when a score loads (same lifecycle as today's Play). Responsive: hide
  `#time-readout` first under 720px, then shrink step-button `min-width` to `2.1rem`; the seek
  bar's `flex: 1` + `min-width: 120px` keeps it usable.

## Open UX questions

- Hand/voice coloring (left vs right hand) like Synthesia.
