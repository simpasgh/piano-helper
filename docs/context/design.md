# Design context

UX, visual design, interaction decisions. Append durable learnings at the top of the
relevant section, dated.

## Sharp / flat (accidental) visualization review (issue #40)

- **2026-05-30 - Review/spike: how accidentals are labeled and positioned today, plus a
  Designer + PM assessment.** This is a documented assessment, not a code change. The UI was
  NOT verifiable live from this agent worktree (single preview server is bound elsewhere, see
  qa.md); findings come from reading the rendering/labeling code.

  ### Current behavior (cited)

  - **Everything reduces to a MIDI number very early, discarding notation spelling.**
    `extractScore` in `src/score.ts:28` sets `midi = note.halfTone + 12`. OSMD's actual spelling
    (the MusicXML `<step>` + `<alter>`, e.g. "Db" vs "C#") is thrown away at this line; only the
    integer pitch survives into `VisNote`. Same collapse on the sheet overlay path:
    `src/sheet-overlay.ts:53` pushes `midi: source.halfTone + 12`.
  - **Labels are a fixed, ALWAYS-SHARP lookup by pitch class.** `src/piano.ts:92-95` defines
    `LETTER_CLASSES = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"]` and
    `SOLFEGE_CLASSES = ["Do","Do#","Re","Re#","Mi","Fa","Fa#","Sol","Sol#","La","La#","Si"]`.
    `midiToLabel` / `midiToBarLabel` (`src/piano.ts:99-115`) index those by
    `pc = ((midi % 12) + 12) % 12`. There is NO flat spelling anywhere in the codebase (a grep
    for `flat`/`♭`/`.alter` finds none in `src/`). So a Db, Eb, Gb, Ab, Bb always render as
    "C#"/"Do#", "D#"/"Re#", "F#"/"Fa#", "G#"/"Sol#", "A#"/"La#".
  - **Falling-note bar label:** `src/visualizer.ts:247` calls `midiToBarLabel(note.midi, mode)`.
    Letters mode appends the octave ("C#4"); solfege mode is octave-free ("Do#"). The name is
    fitted to the bar by `fitBarLabel` (#39) and centered inside it. A "#" is one extra glyph, so
    on narrow black-key bars the 2-3 char accidental name is more likely to shrink or be omitted
    than a 1-char white-note name (#39 width cap), but it does fit or omit, never spill.
  - **Black keys carry NO key-face label.** `drawKeyLabels` (`src/visualizer.ts:341,348`) does
    `if (key.black) continue;` for the width measurement and the draw, so the 36 black keys (every
    accidental) never get a name printed on the keybed. Only the 52 white keys are labeled on the
    keyboard. (Black faces are too narrow for a legible glyph; this is the #11 decision.)
  - **Position / lane reads correctly as "an accidental".** Black keys are laid out at
    `buildKeyLayout` (`src/piano.ts:48-51`) straddling the gap between their neighboring white
    keys, narrower (`blackWidth = whiteWidth * 0.62`). A falling accidental bar fills the full
    black-key width (`noteBarWidth`, `black=true` -> ratio 1.0, `src/piano.ts:25-27`), so it lands
    on the visibly-black, narrower, offset lane. Color also tracks pitch class (#12 hue wheel), so
    C# (magenta 306deg) is visibly distinct from C (violet 276deg). So the POSITION + width + hue
    all read "this is a black-key / accidental note" even with no flat option. That part is good.
  - **Enharmonic handling: NONE.** Because spelling is dropped at the `halfTone -> midi` step, the
    same pitch is ALWAYS shown as the sharp spelling regardless of key signature or musical
    context. A piece in Db major (5 flats) whose score literally prints "Db", "Eb", "Gb", "Ab",
    "Bb" will show "C#"/"D#"/"F#"/"G#"/"A#" on the falling bars AND on the sheet overlay, directly
    contradicting the printed sheet sitting next to them. Consistent across both naming modes and
    both views (falling + overlay), since all four read the same fixed array.
  - **Consistency across modes / Names toggle: fully consistent (it is one code path).** Solfege,
    letters, and off all flow through `midiToLabel`/`midiToBarLabel`; the falling bars, the sheet
    overlay (`src/sheet-labels.ts:104,128`), and the key faces all read the same array. So there is
    no inconsistency BETWEEN surfaces, but every surface is uniformly always-sharp.

  ### Designer assessment

  - **Verdict: the always-sharp labeling is a real learning-UX problem; the position/color cues
    are good and should stay.** Two distinct issues, ranked:
  - **(High) Spelling contradicts the sheet.** The headline product promise is "watch your sheet
    music play" with the OSMD sheet synced to the falling notes. When the sheet prints "Bb" (its
    `<alter>` is -1) but the falling bar and the overlay label both say "A#", the two synced views
    disagree about the name of the same note. For a learner this is actively confusing: the whole
    point of the synced view is that the falling note IS that sheet note. This is the single
    highest-value fix and is fully determined by data we currently discard (OSMD already knows the
    correct spelling). Fix = thread the spelling (step + alter, or OSMD's AccidentalEnum) from
    `extractScore`/`sheet-overlay` into the label instead of recomputing from MIDI. This restores
    flats for free for sheet-derived scores; audio-transcribed scores (no notation) legitimately
    fall back to the current pitch-class default.
  - **(Medium) No name on black keys at the keyboard.** A beginner who reads the falling "Do#" but
    cannot find which black key it is gets no help from the keybed, which only labels whites. A
    small accidental cue on the lit black key (the pressed-key state already hues it, #12) would
    close the loop "the name fell, here is the physical key". This is more of an enhancement than a
    bug; lower priority than the spelling contradiction.
  - **(Low) Default-spelling choice when there is NO context (audio / single notes).** When we have
    no key signature (audio-transcribed scores, or any note with no notation), some default is
    unavoidable. Always-sharp is a defensible default (it matches piano fingering charts and the
    existing solfege "always-sharp, Si not Ti" decision in #11), so keep always-sharp as the
    FALLBACK, not the universal rule. Do NOT invent a fancier context-free enharmonic guesser; it
    is not worth the complexity and would still be wrong half the time without a key signature.
  - **Keep as-is:** the pitch-class hue (#12), the narrower offset black-key lane, the full-width
    black bar, and the #39 fit/omit behavior. The accidental's POSITION and COLOR already read
    correctly; only the printed NAME is wrong for flat-key contexts. Do not redesign the lane.

  ### Product Manager assessment (enharmonic-for-learners)

  - **For learners, the correct spelling is the one printed on THEIR sheet, full stop.** A learner
    is matching the falling note to the staff in front of them. If their score says "Eb" and the app
    says "D#", they second-guess themselves; the app is teaching a contradiction. So enharmonic
    correctness is not academic pedantry here, it is core to the "follow your own sheet" value prop.
  - **But scope it to what we already know.** We only have reliable spelling for SHEET-derived scores
    (MusicXML carries `<alter>`/key signature; OSMD resolves it). Audio-transcribed scores (#19) have
    no notation, so there is no "right" enharmonic answer; the always-sharp default is fine there and
    we should NOT block the spelling fix on solving context-free enharmonics. Ship "respect the
    sheet's spelling when we have a sheet; default always-sharp otherwise."
  - **Priority: low-to-medium overall (matches the issue's `priority:low`), but the spelling fix is
    the high-value slice within it** because it is cheap (data already exists) and removes an active
    contradiction in the flagship synced view. The black-key-name enhancement is a genuine nice-to-have
    that can wait.

  ### Follow-up tickets filed (see PR body for numbers)

  1. **Respect the sheet's accidental spelling (flats) instead of always-sharp.** Thread OSMD's note
     spelling (step + alter / AccidentalEnum) through `extractScore` + the sheet overlay into the
     label, so a Db-major piece shows "Db/Reb" not "C#/Do#" on both the falling bar and the overlay,
     matching the synced sheet. Always-sharp stays as the fallback when there is no notation
     (audio-transcribed scores). HIGH value within this issue. Ships with tests (pure label mapping).
  2. **Show an accidental's name on the lit black key (keyboard).** Beginners cannot currently find
     which physical black key a falling "Do#" maps to, because `drawKeyLabels` skips black keys. Add a
     small cue (label on press, or a compact glyph) so the falling name connects to the physical key.
     Enhancement, medium-low priority.
  3. **(Optional) Add flat solfege spellings (e.g. "Reb", "Mib") to the label vocabulary.** Depends on
     #1; once spelling is threaded through, solfege mode needs flat tokens, not just the current
     always-sharp `SOLFEGE_CLASSES`. Captured so the solfege side of the flats work is not forgotten.

## Heroicons across the toolbar/transport (issue #48)

- **2026-05-30 - Adopted Heroicons (MIT) as the toolbar/transport icon language.** Follow-up to
  #46. Every toolbar/transport control now carries an inline Heroicons SVG so the bar speaks one
  consistent, professional icon language instead of ad-hoc glyphs. The #46 three-tier palette
  (one filled-violet Play hero, raised-neutral loaders, ghost utilities) and grouping are
  unchanged; this layer is icons + a small amount of icon/label layout CSS.

  ### Icon mapping (control -> Heroicon -> variant -> why)

  | Control | Heroicon | Variant | Rationale |
  | --- | --- | --- | --- |
  | Play | `play` | solid | Primary action; solid = the active/primary cue, and the hero is the one filled control |
  | Pause | `pause` | solid | Same hero, filled state; swapped in-place by JS (see below) |
  | Previous note | `backward` | outline | Conventional skip-back double-triangle; ghost satellite of Play |
  | Next note | `forward` | outline | Conventional skip-forward double-triangle; ghost satellite of Play |
  | Load MusicXML | `document-arrow-up` | outline | Upload a document (the .xml/.musicxml file) |
  | Scan sheet (PDF/image) | `camera` | outline | Capture/scan a sheet image |
  | From audio (MP3/WAV) | `musical-note` | outline | Audio source |
  | Export video | `arrow-down-tray` | outline | Download/export the rendered output |
  | Names toggle | `eye` | outline | Show/hide note names = a visibility toggle |

  ### Convention (standardized)

  - **Outline is the default; solid is reserved for the single Play/Pause hero.** Outline =
    "available action / utility"; solid = "the one primary, active control". This keeps the #46
    "one accent per viewport" read: the only filled icon sits on the only filled button.
  - **Sizing.** 18px in labeled action buttons (loaders, Export, Play); 16px in the compact Names
    pill; 20px in the square step satellites (prev/next), matching their larger glyph slot.
  - **Stroke weight 1.5** (the Heroicons native outline weight), kept as authored so icons look
    correct at any size.
  - **Color via `currentColor`.** Every icon inherits its button's tier color through
    `currentColor`, so hover/active/disabled (which change the button's text color/opacity) carry
    the icon for free. NO icon hardcodes a hue, so a future re-theme of the palette tokens moves
    the icons too. (Heroicons ship a hardcoded `#0F172A`; the inlined copies strip it.)
  - **Icon + label rows.** The loaders, Export, Play, and Names keep their text labels next to the
    icon (icon-then-text, gap ~0.45rem; ~0.35rem for the compact Names pill). Prev/next stay
    icon-only with `aria-label`. Play's label/aria-label/icon path are all swapped together by JS
    on play<->pause.
  - **Accessibility.** Icons are `aria-hidden="true" focusable="false"`; the button's own text
    label or `aria-label` carries the meaning, so the icon swap is purely visual.

  ### Verification caveat

  Same preview-port limit as #46/#36/#37: the dev preview server (port 5173) is bound to a
  different worktree, so no live in-browser pass from this agent worktree. Verified by a real
  WebKit static render (qlmanage) of the built CSS + header (all nine icons read correctly: the
  document-up loader, camera, musical note, download tray, eye, skip-back/forward triangles, and
  the solid Play triangle on the violet hero), the 11 new markup guards, and `npm run build`
  green. The 720px breakpoint and the live play<->pause icon swap remain for the post-merge QA
  gate.

## Toolbar redesign v2 (issue #46)

- **2026-05-30 - Research-led fix for the all-violet toolbar + broken step buttons.** The #34
  pass added hierarchy (ghost vs filled) but left the palette monochrome: the three loaders AND
  Play are all the same saturated violet gradient, so the bar still reads as "purple everywhere"
  with no real primary. The prev/next step glyphs (`◄|` and `|►`, an arrow jammed against a pipe)
  render as broken little marks, not as "step one note back / forward". This entry replaces the
  #34 palette and step-button treatment; the grouping, ghost-vs-filled split, focus ring, and
  responsive rules from #34 mostly stand and are only refined.

  **Research basis (proven patterns, not guesswork).** Key findings that drove each decision:
  - *Single accent per viewport / 60-30-10.* The dominant fix for the "everything looks the
    same" problem in dark UIs is a contrast/text hierarchy plus ONE high-contrast accent element
    per viewport, not coloring every control. So only ONE class of control should carry the
    filled violet gradient; spraying it across four buttons is exactly the anti-pattern #46 calls
    out. (raxxo "Dark Mode Design That Doesn't Look AI", HYPE4 60-30-10, IxDF UI color palette.)
  - *Near-white, never pure #fff, on dark.* Production dark UIs use ~#F5F5F7 to cut halation; our
    `--text #e8e0f5` already follows this, keep it and stop using `#ffffff` for button labels.
  - *Classic transport icons.* "Stick to classic icons, triangles for play, bars for pause; the
    audience should not need a legend." Play is the single hero; step controls are quiet
    satellites. (Microsoft media controls, Balsamiq, think.design.)
  - *Step = skip-previous / skip-next glyph.* The universally-read "step by one" control is a
    triangle pointing at a vertical bar (skip-previous `⏮`-style and skip-next `⏭`-style): bar on
    the OUTSIDE, triangle pointing toward it. That is the conventional, instantly-legible shape;
    our reversed `◄|` (bar inside, on the right) is why it looked broken. (SF Symbols
    `backward.end` / `forward.end`, Material `skip_previous` / `skip_next`, icons8 skip set.)
  - *Accessibility.* Visible focus ring, ARIA labels, AA contrast (4.5:1 text / 3:1 large). All
    preserved; the new colors are contrast-checked below.

  ### 1. New color scheme (REQUIRED) - violet brand + ONE functional accent

  Direction in one line: keep violet as the BRAND identity (wordmark, glow, falling notes,
  sliders all stay violet, the whole visualizer is tuned to it), but stop using violet as the
  button-fill for everything. Give the toolbar a real hierarchy with ONE filled-accent action
  class, ghost everything else, and a distinct, calmer surface so the bar reads as a tool, not a
  purple slab. The single biggest change: Play becomes the ONE saturated-violet hero, and the
  file loaders drop from "three loud violet pills" to a quieter SECONDARY tier.

  **Token block (replace the existing toolbar tokens in `:root`).** Keep the four brand anchors
  and the brand ramp; revise the surfaces and add the secondary tier:

  ```css
  :root {
    /* existing brand anchors (UNCHANGED, the visualizer depends on these) */
    --bg: #0a0712;
    --accent: #b14bff;
    --accent-glow: rgba(177, 75, 255, 0.6);
    --text: #e8e0f5;

    /* brand ramp (UNCHANGED) */
    --accent-deep: #7a2fd6;
    --accent-gradient: linear-gradient(135deg, var(--accent-deep), var(--accent));

    /* toolbar surfaces - calmer, less violet-tinted so the bar is a neutral tool surface */
    --bar-surface: rgba(16, 14, 22, 0.92);   /* near-neutral dark, only a hair of violet */
    --bar-border: rgba(232, 224, 245, 0.10); /* neutral hairline, not violet */
    --group-divider: rgba(232, 224, 245, 0.12);

    /* SECONDARY tier (NEW): the file loaders. A quiet raised surface, NOT filled violet.
       This is the key palette move that breaks the monochrome: loaders are no longer
       primary-violet, they are neutral raised buttons that only tint violet on hover. */
    --secondary-bg: rgba(255, 255, 255, 0.07);
    --secondary-bg-hover: rgba(255, 255, 255, 0.11);
    --secondary-bg-active: rgba(177, 75, 255, 0.18);
    --secondary-border: rgba(232, 224, 245, 0.16);
    --secondary-border-hover: rgba(177, 75, 255, 0.5);

    /* GHOST tier (transport step, Names, Export): even quieter, transparent fill */
    --ghost-bg: rgba(255, 255, 255, 0.03);
    --ghost-bg-hover: rgba(177, 75, 255, 0.12);
    --ghost-bg-active: rgba(177, 75, 255, 0.2);
    --ghost-border: rgba(232, 224, 245, 0.14);
    --ghost-border-hover: rgba(177, 75, 255, 0.5);

    /* text tiers (UNCHANGED) */
    --text-muted: rgba(232, 224, 245, 0.6);
    --text-faint: rgba(232, 224, 245, 0.4);

    /* focus ring (UNCHANGED) */
    --focus-ring: #d9a6ff;
  }
  ```

  **Three-tier button hierarchy (this is the whole fix):**
  - **PRIMARY (filled violet gradient), exactly ONE control: `#play-btn`.** Play is the single
    hero, per "one accent per viewport". It keeps `--accent-gradient`, white-ish label, extra
    padding, and a resting `--accent-glow`. Nothing else is filled violet. This alone removes the
    "purple everywhere" read because now there is exactly one purple button on the bar.
  - **SECONDARY (raised neutral surface), the three `.file-btn` loaders.** They were filled
    violet in #34; now they are a light raised neutral surface (`--secondary-bg`, subtle border,
    full `--text` label). They are clearly clickable and clearly more prominent than ghost
    controls (solid-ish fill vs transparent), but they no longer compete with Play for the violet.
    On hover they tint violet (`--secondary-bg-active` border `--secondary-border-hover`) so the
    brand still answers the touch. Rationale: loading a score is the main ENTRY action, so it
    earns a solid raised tier, but the transport Play is the main IN-APP action and deserves the
    sole accent fill.
  - **GHOST (transparent + border), everything else:** `#export-btn`, `.toggle` (Names + hand
    mutes), `.step-btn` (prev/next), `.tempo-readout`. Recede until hovered. Unchanged in spirit
    from #34, only the token values calm down (neutral border instead of violet-tinted at rest).

  **Why this is not "add a second brand color":** #46 says "not monochrome violet" and "sensible
  accent usage". We deliberately do NOT introduce a competing hue (teal, etc), which would fight
  the pitch-class hue wheel in the visualizer (#12) and the violet identity. Instead the
  hierarchy comes from SURFACE/LUMINANCE tiers (filled-violet hero, raised-neutral secondary,
  transparent ghost) plus the existing text tiers. This is the "contrast hierarchy fixes 80% of
  the sameness" finding applied literally: three visibly different button SURFACES on one calm
  neutral bar reads as intentional and non-monochrome, while keeping exactly one brand accent.
  A bar with one violet hero, a row of neutral raised loaders, and quiet ghost utilities has
  obvious primary/secondary/ghost hierarchy that the all-violet bar lacked.

  **Contrast check (AA).** `--text #e8e0f5` on `--bar-surface rgba(16,14,22,0.92)` over the dark
  stage is ~14:1 (far past AA). Secondary `--secondary-bg` raised pills carry full `--text`
  labels, so legibility rides on text (~12:1), border carries "clickable" (the #34 rule, kept).
  Play's near-white label on the violet gradient keeps the #34 ~3.3:1-plus-weight treatment
  (large/bold text, clears the 3:1 large-text bar). Focus ring `--focus-ring #d9a6ff` clears AA
  on both the neutral surface and the violet fill.

  ### 2. Step buttons (REQUIRED) - conventional skip-previous / skip-next glyphs

  Replace the broken `◄|` / `|►` markup with the conventional skip glyphs and give them a clear
  satellite treatment flanking the Play hero.

  - **Glyph: use the skip-previous / skip-next Unicode triangles, bar on the OUTSIDE.**
    - Prev note: `⏮` (U+23EE, BLACK LEFT-POINTING DOUBLE TRIANGLE WITH VERTICAL BAR) OR the
      cleaner single-step `⏮`-style. To keep it unambiguous as "one note" (not "skip to start"),
      use the SINGLE triangle + bar: prev = `\23F4`-with-bar is not standard, so use the
      well-supported pair **`⏮` (prev) and `⏭` (next)** which every OS renders as the familiar
      skip-track shape. These are the instantly-read "step to the adjacent item" glyphs.
    - The bar sits on the OUTSIDE edge (left bar for prev, right bar for next) with the
      triangle(s) pointing toward it. That outside-bar orientation is the entire reason it reads
      as "step": the old markup put the bar inside/right which looked like a glitch.
  - **Implementation note for the Tech Lead:** emoji-variation selectors can make `⏮`/`⏭` render
    as full-color emoji on some platforms, which looks toy-like on a pro toolbar. Force the
    text/mono presentation. Two safe options: (a) append the text-presentation selector U+FE0E
    (`&#9198;&#65038;` for `⏮`, `&#9197;&#65038;`... note next is U+23ED `&#9197;`) so it renders
    as a monochrome glyph; OR (b, PREFERRED for full control) drop inline SVG icons so the icon
    is crisp, currentColor-tinted, and identical cross-platform. If using SVG, the shape is: two
    stacked triangles (or one triangle) + a 2px vertical bar on the outside edge, 16x16,
    `fill: currentColor`, so it inherits the ghost label color and the hover `#fff`-ish brighten.
    Keep the existing `aria-label="Previous note"` / `"Next note"` and `title` so the glyph
    change is purely visual; screen readers are unaffected.
  - **Sizing + states.** Step buttons stay GHOST tier (transparent, satellite of Play). Make them
    square-ish so the icon centers cleanly: `min-width: 2.6rem`, equal vertical/horizontal padding
    so the glyph is optically centered next to the taller Play. Icon size ~1rem. States:
    - resting: ghost bg + neutral border, glyph at `--text`.
    - hover (`:not(:disabled)`): `--ghost-bg-hover`, border `--ghost-border-hover`, glyph
      brightens toward `#fff`-ish (`--text` -> near-white). The whole button lifts subtly.
    - active: `--ghost-bg-active`, `translateY(1px)` (the #34 press feel).
    - disabled: `opacity: 0.4`, `cursor: not-allowed`, NO hover. This is the resting state before
      a score loads (the buttons start `disabled`), so disabled must look clearly inert, not just
      dim-but-clickable. Keep the glyph visible but faded so the affordance is "will work once a
      score is loaded".
    - focus-visible: the shared `--focus-ring` (unchanged).
  - **Placement: tight transport cluster.** Group prev / Play / next as a tight unit (gap
    `0.4rem`) so the two steps visually flank the hero, THEN a wider gap before the seek slider.
    This grouping is what makes them read as "the two things you do to the current note" around
    Play, matching every media transport bar. The seek slider + time readout trail to the right
    as the scrub sub-group.

  ### 3. Grouping (REQUIRED, refine #34) - input / output / settings / transport

  Keep the #34 `.group` + hairline-divider structure (it survives the responsive wrap well), with
  these refinements so the four conceptual groups read as deliberate:
  - Dividers use the new NEUTRAL `--group-divider` (not violet `--bar-border`), so the grouping
    is structural, not another violet element. Keep them 1px, ~1.4rem tall, centered, wrapping
    with their group via `.group + .group::before`.
  - The `.controls` row is the first three groups: **source/input** (3 loaders) | **output**
    (Export) | **settings** (Names, hand mutes, tempo), with `#track-name` + `#sound-status`
    pushed right via `margin-left: auto`.
  - The `.transport` row IS the fourth group (transport): the tight prev/Play/next cluster, then
    the seek scrub + time readout. No inner DOM change needed beyond a small wrapper if the Tech
    Lead wants the tight-cluster gap; a flex gap tweak on `.transport` plus a wrapper around
    prev/Play/next is cleanest, but keep every existing `id=` intact.
  - **Bar surface.** Repoint `.topbar` background to the new calmer `--bar-surface` and bottom
    border to the neutral `--bar-border`. Keep the #34 depth shadow and the violet wordmark `<h1>`
    (the wordmark stays the ONE violet text element, which is good: brand leads, buttons calm).

  ### 4. Coordinate with #44 and #33 (REQUIRED, do not implement #44)

  - **#44 (editable sheet name in the bar, not built yet):** leave room. `#track-name` currently
    trails right after `margin-left: auto`. When #44 lands it will likely become an editable field
    in/near that slot. Do NOT build it here, but do NOT hard-pin the right side so tightly that an
    editable name field could not slot in. Keeping `#track-name` as the right-trailing flexible
    element (as today) leaves that door open. No structural change needed; just don't remove the
    `margin-left: auto` flex behavior.
  - **#33 (mobile, shipped):** every responsive rule must still hold. The tier change is
    color-only on the loaders (still `.file-btn`, still `button`), so the 720px `min-height: 44px`
    tap targets, the `<h1>`/`#track-name`/`#sound-status` hide, the slider thumb growth, and the
    divider-hide all still apply unchanged. The new step-button `min-width: 2.6rem` must not drop
    below the 720px `min-width: 44px` rule (it won't; the phone rule overrides upward). Re-verify
    the loaders still wrap two-per-row at 380px and that the neutral secondary surface is visible
    at 44px height (it is; surface + border are height-independent).

  ### REQUIRED checklist (ship in this order)

  1. Replace the toolbar tokens in `:root` (section 1): calmer neutral `--bar-surface` /
     `--bar-border` / `--group-divider`, add the `--secondary-*` tier, calm the `--ghost-*` tier.
  2. Demote the three `.file-btn` loaders from PRIMARY (filled violet) to SECONDARY (raised
     neutral). Leave `#play-btn` as the SOLE filled-violet PRIMARY hero.
  3. Replace the prev/next `.step-btn` glyph markup with conventional skip-previous / skip-next
     icons (prefer inline SVG, `fill: currentColor`; else `⏮`/`⏭` with U+FE0E text-presentation),
     bar on the outside. Keep `aria-label`/`title`. Square-ish ghost styling + the four states.
  4. Tighten the transport into a prev/Play/next cluster (gap ~0.4rem) then the scrub sub-group.
  5. Point group dividers at the neutral `--group-divider`; repoint `.topbar` to the new surface
     + neutral border. Keep the depth shadow and violet wordmark.
  6. Re-verify #33 breakpoints (900 / 720 / 380) and leave the `#track-name` right-trailing slot
     open for #44.

  NICE-TO-HAVE (defer): a play-triangle glyph on `#play-btn` (needs the label-swap logic touched);
  a subtle inner top-highlight on the secondary pills; backdrop blur on the bar.

## Aesthetic

- **Neon-on-dark** "Synthesia" look: purple accent (`--accent: #b14bff`) glowing falling
  notes on a near-black stage (`--bg: #0a0712`), light keyboard at the bottom.
- Falling note bars have a soft glow (canvas `shadowBlur`); white-key notes are brighter
  than black-key notes.

## Per-hand mute toggles (issue #37)

- **2026-05-30 - Spec for the two per-hand MUTE toggles.** CSS-first, no new JS menu, no new
  deps. PM-decided behavior: two toggles, "Right hand" and "Left hand", both default ON
  (audible); tapping one mutes that hand's AUDIO while its notes keep falling silently. Solo =
  mute the other hand (no separate solo control). Shown ONLY when the score has both a right-
  and a left-hand note set; single-staff and audio-derived scores keep them hidden and the
  single master volume governs playback.

  **Placement.** Inside the settings `.group` of the toolbar (the #34 source/output/settings
  cluster), between the Names toggle and the `.tempo` group. They live in a
  `<div id="hand-mutes" class="hand-mutes" role="group" aria-label="Mute by hand" hidden>`.
  The container's `hidden` attribute is removed by the Tech Lead's `loadNotes` only when the
  score has both hands, so on single-staff/audio scores the row simply is not there. The
  `.hand-mutes` flex wraps with the rest of `.controls` at <=720px (#33), so it never crowds.

  **Each toggle is a real `<button class="toggle hand-toggle" aria-pressed="false">`** reusing
  the existing #34 ghost-pill `.toggle` base (so it matches the Names button), with a text
  label ("Right hand" / "Left hand", not icon-only) and a small color swatch. `aria-pressed`
  is the state: `true` = that hand is muted. Tap target stays >=44px on phones because
  `.toggle` already gets `min-height: 44px` in the #33 720px block.

  **Muted affordance is MORE than color (colorblind-safe).** When `aria-pressed="true"`:
  (a) `opacity: 0.55` dims the whole pill, (b) the label gets `text-decoration: line-through`
  (a strikethrough = "this hand is silenced"), and (c) the swatch dims to `opacity: 0.5`. The
  `aria-pressed` state itself is the screen-reader cue. So muted is signalled by dim + strike +
  swatch fade, never by hue alone.

  **Swatch matches the #36 rail colors** so the control ties back to the falling-note hand cue:
  right = near-white `rgba(255, 255, 255, 0.92)`, left = near-dark `rgba(10, 7, 18, 0.85)`.
  Both are 11px rounded squares with a faint border so the near-dark left swatch stays visible
  on the dark bar. This is the same dark-left / light-right luminance pairing the rails use.

  **Why mute, not sliders (v1 scope).** Volume sliders / balance / presets / per-hand timbre /
  cross-session persistence are explicitly OUT for v1 (PM decision). A binary mute per hand is
  the smallest control that delivers "practice one hand at a time" and reads instantly; sliders
  would add a second axis of fiddliness for marginal practice value. Revisit only if playtests
  ask for partial balance.

## Top toolbar redesign (issue #34)

- **2026-05-30 - Spec to redesign the top toolbar: UX, color scheme, button styling.**
  Vanilla HTML + CSS only, no framework, no new deps. Works within the existing
  `.topbar` / `.topbar-rows` / `.controls` / `.transport` markup plus a few wrapper divs,
  and within the shipped 900 / 720 / 380 breakpoints (do not break #33). The slider thumb
  mechanics from #33 stay; only their colors may change. Goal: the bar reads as intentional
  and grouped, primary actions stand out, secondary actions recede, and the play button is
  the visual hero of the transport row.

  **Direction in one line:** keep the violet brand anchor, but stop painting *every* control
  as a filled violet pill. Only true primary actions get the filled gradient. Everything else
  becomes a quiet "ghost" control (transparent fill, subtle border) so the bar gains hierarchy
  and breathing room. This is the single change that fixes the "crammed, everything shouts"
  problem.

  ### 1. Color scheme / tokens (REQUIRED)

  Keep `--accent: #b14bff` as the brand anchor (no reason to move it; the whole visualizer,
  sliders, and glow system are tuned to it). Extend `:root` with a small, named token set so
  the toolbar stops hardcoding `rgba(177,75,255,...)` and `#7a2fd6` inline. Exact block to
  paste into `:root` (keep the four existing tokens, add the rest):

  ```css
  :root {
    /* existing brand anchors (unchanged) */
    --bg: #0a0712;
    --accent: #b14bff;
    --accent-glow: rgba(177, 75, 255, 0.6);
    --text: #e8e0f5;

    /* brand ramp */
    --accent-deep: #7a2fd6;            /* darker gradient stop, already used inline */
    --accent-gradient: linear-gradient(135deg, var(--accent-deep), var(--accent));

    /* toolbar surfaces */
    --bar-surface: rgba(18, 11, 30, 0.88);   /* the topbar background */
    --bar-border: rgba(177, 75, 255, 0.22);  /* bottom hairline + group dividers */

    /* ghost / secondary controls */
    --ghost-bg: rgba(255, 255, 255, 0.04);
    --ghost-bg-hover: rgba(177, 75, 255, 0.14);
    --ghost-bg-active: rgba(177, 75, 255, 0.22);
    --ghost-border: rgba(232, 224, 245, 0.18);
    --ghost-border-hover: rgba(177, 75, 255, 0.55);

    /* text tiers */
    --text-muted: rgba(232, 224, 245, 0.6);  /* track name, tempo label, time readout */
    --text-faint: rgba(232, 224, 245, 0.4);  /* disabled glyphs, sound status */

    /* focus ring (one ring for every control) */
    --focus-ring: #d9a6ff;                   /* lighter violet, clears AA on the dark bar */
  }
  ```

  Rationale for the focus ring being a separate lighter token: `--accent` at `#b14bff` on the
  near-black bar is fine, but a focus ring sitting *next to* a filled-accent button needs to be
  distinguishable from the button itself, so `--focus-ring: #d9a6ff` (lighter) reads clearly
  against both the dark surface and the violet fill. Use it everywhere instead of the current
  `outline: 2px solid var(--accent)`.

  ### 2. Visual grouping (REQUIRED)

  Cluster `.controls` into three labeled-by-position groups with thin dividers between them.
  Minimal DOM: wrap runs of existing children in `<div class="group">`. New ordering of the
  `.controls` row, left to right:

  - **Group: source/input** (`<div class="group group-source">`): the three `.file-btn`
    labels (Load MusicXML, Scan sheet, From audio) in their current order.
  - divider
  - **Group: output** (`<div class="group group-output">`): `#export-btn`.
  - divider
  - **Group: settings** (`<div class="group group-settings">`): `#names-btn` toggle, then the
    `.tempo` group.
  - then the flexible status text `#track-name` and `#sound-status` (NOT in a group, they sit
    after a `margin-left: auto` push so they trail to the right and can truncate).

  `.transport` stays its own row (the second `.topbar-rows` child) and is itself the fourth
  conceptual group (play/step/scrub); it needs no inner sub-groups.

  Group + divider CSS:

  ```css
  .group {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  /* vertical hairline divider between groups, drawn as a flex child */
  .group + .group::before {
    content: "";
    align-self: center;
    width: 1px;
    height: 1.4rem;
    margin: 0 0.25rem;
    background: var(--bar-border);
  }
  /* push status text to the right so groups stay left-packed */
  #track-name { margin-left: auto; }
  ```

  `.controls { gap }` drops from `0.75rem` to `0.6rem` because the dividers now carry the
  visual separation that the wide gap used to fake. Within a group, controls sit at `0.5rem`
  gap so they read as a cluster; the divider + its `0.5rem` margins give a clear ~1rem visual
  break between groups without a big empty gap.

  Note: the `.group + .group::before` divider approach means the divider belongs to the *second*
  group and collapses cleanly when a group wraps to a new line (the pseudo-element wraps with
  its group). This is what makes it survive the responsive breakpoints (see section 5).

  ### 3. Button hierarchy + states (REQUIRED)

  Two tiers. The shared `button, .file-btn` gradient rule today makes everything tier-1, which
  is the core problem. Split it:

  **Tier 1, PRIMARY (filled gradient, prominent).** Only:
  - the three `.file-btn` loaders (loading a score is the main entry action), and
  - `#play-btn` (the primary transport action, slightly larger than the rest).

  Primary styling:
  ```css
  /* primary = file loaders + play */
  .file-btn,
  #play-btn {
    background: var(--accent-gradient);
    color: #ffffff;
    border: 1px solid transparent;
    border-radius: 8px;
    padding: 0.5rem 1rem;
    font-size: 0.9rem;
    font-weight: 600;
    cursor: pointer;
    transition: filter 0.15s ease, box-shadow 0.15s ease,
                transform 0.05s ease, opacity 0.15s ease;
  }
  .file-btn:hover,
  #play-btn:hover:not(:disabled) {
    filter: brightness(1.12);
    box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.08) inset,
                0 2px 10px rgba(122, 47, 214, 0.45);
  }
  .file-btn:active,
  #play-btn:active:not(:disabled) {
    filter: brightness(0.95);
    transform: translateY(1px);
    box-shadow: none;
  }
  #play-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  /* play is the hero of the transport: a touch larger + a resting glow */
  #play-btn {
    min-width: 5rem;
    padding: 0.5rem 1.4rem;
    box-shadow: 0 0 14px var(--accent-glow);
  }
  ```

  **Tier 2, SECONDARY / GHOST (transparent fill + border).** Everything else: `#export-btn`,
  `.toggle` (Names), and `.step-btn` (prev/next). They recede until hovered.

  ```css
  /* secondary / ghost = export, names toggle, step buttons */
  #export-btn,
  .toggle,
  .step-btn {
    background: var(--ghost-bg);
    color: var(--text);
    border: 1px solid var(--ghost-border);
    border-radius: 8px;
    padding: 0.45rem 0.9rem;
    font-size: 0.85rem;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.15s ease, border-color 0.15s ease,
                color 0.15s ease, transform 0.05s ease, opacity 0.15s ease;
  }
  #export-btn:hover:not(:disabled),
  .toggle:hover:not(:disabled),
  .step-btn:hover:not(:disabled) {
    background: var(--ghost-bg-hover);
    border-color: var(--ghost-border-hover);
    color: #ffffff;
  }
  #export-btn:active:not(:disabled),
  .toggle:active:not(:disabled),
  .step-btn:active:not(:disabled) {
    background: var(--ghost-bg-active);
    transform: translateY(1px);
  }
  #export-btn:disabled,
  .toggle:disabled,
  .step-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  ```

  **Toggle (`#names-btn`) specifics.** It stays ghost (it is a setting, not an action). Keep it
  slightly more compact than other ghost buttons to read as a state pill: override to
  `padding: 0.4rem 0.75rem; font-size: 0.8rem`. The cycling label (`Names: Solfege` etc) is the
  state indicator; no extra active-state color needed beyond the ghost `:active`.

  **Step buttons (`.step-btn`).** Keep the existing `min-width: 2.4rem` and the centered glyph;
  they inherit the ghost styling above. Because they are now ghost (not filled), prev/next read
  as quiet satellites around the filled Play, which is exactly the intended transport hierarchy.

  **Focus for ALL buttons (REQUIRED, replaces the scattered `outline: var(--accent)`):**
  ```css
  button:focus-visible,
  .file-btn:focus-visible,
  .toggle:focus-visible,
  .step-btn:focus-visible {
    outline: 2px solid var(--focus-ring);
    outline-offset: 2px;
  }
  ```
  Apply the same `--focus-ring` to the slider/readout focus states (replace their
  `outline: 2px solid var(--accent)` with `var(--focus-ring)`), so the whole bar has one
  consistent ring color. Keep `outline-offset: 3px` on the sliders (they need the extra gap so
  the ring clears the thumb glow).

  **`#play-btn` text/icon (NICE-TO-HAVE).** v1 keeps the text label "Play" / "Pause". A play
  triangle glyph (`&#9654;`) + the word, or icon-only, is a nice follow-up but needs the
  Tech Lead's label-swap logic touched; not required for this pass.

  ### 4. Hierarchy + polish details (REQUIRED unless marked)

  - **Bar surface + depth.** `.topbar { background: var(--bar-surface) }`,
    `border-bottom: 1px solid var(--bar-border)`, and add a soft downward shadow so the bar
    floats above the light sheet panel: `box-shadow: 0 1px 0 rgba(255,255,255,0.03) inset,
    0 6px 18px rgba(0,0,0,0.35)`. The inset top highlight is a 1px lit edge that makes the bar
    read as a raised surface, not a flat block. Keep `z-index: 2`.
  - **Backdrop blur (NICE-TO-HAVE).** The bar is static (not redrawn per frame), so a
    `backdrop-filter: blur(8px)` is safe and makes the semi-transparent surface feel like
    frosted glass over the stage. Add it with a graceful fallback (the solid-ish
    `--bar-surface` already looks fine without it). Pair with
    `-webkit-backdrop-filter: blur(8px)`. Skip if you want the focused pass; purely cosmetic.
  - **Bar padding / height.** Keep `padding: 0.75rem 1.25rem` and the two-row stack. Bump
    `.topbar-rows { gap: 0.6rem }` (unchanged) but tighten `.controls { gap: 0.6rem }` per
    section 2. No fixed bar height; it stays content-sized so wrapping still works.
  - **`<h1>` "Piano Helper" treatment.** Make it a quiet wordmark, not a heading that competes
    with the buttons. Keep `font-size: 1.1rem; font-weight: 600` but set
    `color: var(--accent)` with a faint glow `text-shadow: 0 0 10px var(--accent-glow)` and
    `letter-spacing: 0.04em`. This turns the title into the one branded violet element in the
    text layer (since the buttons are now mostly ghost), so the violet identity still leads the
    bar. It is already hidden at <=720px (#33), so it costs nothing on phones.
  - **Dividers.** Use the `--bar-border` hairline from section 2 (1px, `1.4rem` tall, centered).
    Do not use full-height dividers; the short centered rule looks more intentional and matches
    the bar's compact feel.
  - **Tempo + readout colors.** Point `.tempo-label` and `.track-name` at `--text-muted`,
    `.sound-status` and `.time-readout`'s dimmed text at `--text-faint` (replace the ad-hoc
    `opacity` values where convenient; opacity-on-text is fine to keep, the tokens just unify
    the muted greys). The slider tracks keep their existing
    `linear-gradient(90deg, var(--accent-deep), var(--accent))` (now expressible via tokens).

  ### 5. Responsive continuity (REQUIRED)

  The redesign degrades cleanly through the shipped breakpoints; only small additions needed.

  - **>900px (desktop).** Full layout: four groups with dividers, status text trailing right via
    `margin-left: auto`. Play is the larger filled hero in the transport row.
  - **900px (tablet).** Existing block tightens `.topbar` gap/padding. Groups + dividers stay;
    nothing to change. Confirm `.controls { gap: 0.6rem }` already set here (it is); the divider
    margins keep groups distinct at the tighter gap.
  - **720px (phone).** `<h1>`, `#track-name`, `.sound-status` already hide (#33). Because the
    dividers are `.group + .group::before` pseudo-elements that wrap WITH their group, they keep
    separating groups even as `.controls` wraps to multiple lines. **REQUIRED addition:** when a
    group wraps to its own line the leading divider can look orphaned at a line start, so hide
    dividers at this breakpoint for cleanliness:
    ```css
    @media (max-width: 720px) {
      .group + .group::before { display: none; }
      .group { gap: 0.5rem; }
    }
    ```
    Group `gap` plus the existing wrap gives enough separation on phone without the rules. Touch
    sizing from #33 is unaffected: the `min-height: 44px` rules already target `button`,
    `.file-btn`, `.toggle`, `.step-btn`, which still match after the tier split (the ghost
    buttons are still `button`/`.toggle`/`.step-btn`). The `#play-btn` `min-width: 5rem` sits
    comfortably inside the 44px-tall wrapped transport row. Verify the ghost border is still
    visible at 44px (it is; border is unaffected by min-height).
  - **380px (narrow phone).** No toolbar-specific change needed beyond #33's existing rules; the
    three loaders wrap two-per-row as before, now as filled primary pills, and the settings group
    (Names + tempo) sits below. Ghost buttons and the filled loaders both keep their 44px targets.

  **One contrast check to honor:** the ghost buttons rely on a 1px `--ghost-border` at
  `rgba(232,224,245,0.18)` for their resting affordance. On the `--bar-surface` that border is
  faint by design (ghost), but the button TEXT is full `--text` (`#e8e0f5`) which clears AA on
  the dark bar, so the control is never ambiguous: text carries legibility, border carries
  "this is clickable", hover/focus make it unmistakable. Do not drop the resting border or the
  ghost buttons become invisible flat text.

  ### REQUIRED checklist (ship in this order)

  1. Paste the extended `:root` token block (section 1).
  2. Wrap `.controls` children into `.group` divs (source / output / settings) and add
     `margin-left: auto` to `#track-name`; add the `.group` + `.group + .group::before` divider
     CSS (section 2). Drop `.controls` gap to `0.6rem`.
  3. Split the shared `button, .file-btn` rule into PRIMARY (`.file-btn`, `#play-btn`) and
     GHOST (`#export-btn`, `.toggle`, `.step-btn`) with the four states each (section 3).
  4. Make `#play-btn` the hero: `min-width: 5rem; padding: 0.5rem 1.4rem` + resting glow.
  5. Add the unified `:focus-visible` ring using `--focus-ring`; swap the sliders' and tempo
     readout's `outline ... var(--accent)` to `var(--focus-ring)` (keep their `offset: 3px`).
  6. Restyle `.topbar`: `--bar-surface` bg, `--bar-border` bottom, the depth `box-shadow`.
  7. Restyle `<h1>` as the violet wordmark (accent color + faint glow + letter-spacing).
  8. Point muted text (`.tempo-label`, `.track-name`, `.sound-status`, `.time-readout`) at the
     `--text-muted` / `--text-faint` tokens.
  9. At <=720px: `.group + .group::before { display: none }`.

  NICE-TO-HAVE (defer for a focused pass): `backdrop-filter: blur(8px)` on the bar; a play
  triangle glyph on `#play-btn`; converting the remaining inline slider gradient hex to the
  `--accent-deep` / `--accent-gradient` tokens (cosmetic refactor, no visual change).

## Left vs right hand on falling notes (issue #36)

- **2026-05-30 - Spec for distinguishing left-hand vs right-hand falling notes.** Canvas-2D
  ready spec for `drawFallingNotes` in `src/visualizer.ts`. No new deps, no DOM. Each note
  now carries `hand: "left" | "right" | "unknown"` ("right" = treble, "left" = bass,
  "unknown" = single-staff or audio-derived, no hand info). `VisNote` gets the new field.

  **Chosen treatment: a hand accent stripe on one EDGE of the bar.** Keep the bar body in
  its full issue #12 pitch-class color (hue = pitch, unchanged). Paint a thin vertical
  stripe inside the rounded rect, on the **left edge for left-hand** notes and the **right
  edge for right-hand** notes. The bar's own colored corner radius still frames it; the
  stripe sits flush to the inner edge. This adds a second, orthogonal channel (which side
  the marker is on) so hue keeps meaning pitch while side means hand. Clarity over subtlety:
  side-of-bar is a hard binary the eye reads in peripheral vision as bars stream down a lane.

  Rejected alternatives, briefly: recoloring the whole bar by hand destroys the #12 pitch
  palette (the primary pitch cue); an opacity/saturation shift collides with the #33
  off-range dimming (alpha 0.35 already means "off-screen") and is too quiet for a learning
  aid; corner-shape differences are illegible at speed and fight the uniform r=4 rounding.

  **1. Exact stripe geometry + values.**
  - **Width:** `STRIPE_W = Math.max(3, Math.min(6, w * 0.16))` px. Clamped 3-6px so it is
    visible on a ~13px black-key bar at 320px (issue #33) yet never eats a wide bar's hue.
  - **Inset:** the stripe is drawn 1px inside the bar so the bar's rounded corner still shows
    around it. Left-hand stripe rect: `x + 1, top + 1, STRIPE_W, barHeight - 2`. Right-hand
    stripe rect: `x + w - 1 - STRIPE_W, top + 1, STRIPE_W, barHeight - 2`. Square corners on
    the stripe are fine (it is masked visually by sitting inside the rounded body); use a
    plain `fillRect`, not `roundRect`, to keep it cheap.
  - **Color (fixed, NOT pitch-derived, NOT hand-hued):** a single neutral so it stays legible
    over all 12 hues and over both white-key (L62%) and black-key (L50%) fills.
    - **Left hand:** near-black `rgba(10, 7, 18, 0.85)` (the stage `#0a0712` at 0.85 alpha).
      Reads as a dark inset rail. Dark-on-color is unambiguous over every L50-62% hue.
    - **Right hand:** bright `rgba(255, 255, 255, 0.92)` (near-white). Light-on-color, the
      polar opposite of the left rail.
    - This dark-left / light-right pairing is itself a second cue beyond side: even if a bar
      is half-clipped at a screen edge, dark-rail vs light-rail still tells the hand. The
      pairing is also colorblind-safe (pure luminance contrast, no hue).
  - **No glow on the stripe.** Set `ctx.shadowBlur = 0` for the stripe `fillRect` (the bar
    fill before it set a hue glow; reset it, draw the stripe, and the contact stroke below
    re-sets its own shadow). One `fillStyle` + one `fillRect` per non-unknown bar. Within the
    per-bar budget (the #12 rule allows one fill + shadow assignments; this is one extra flat
    fill with shadow off, no gradient, no measureText).

  **2. "Unknown" fallback = identical to today.** When `note.hand === "unknown"` (or the
  field is absent), draw NO stripe. The bar renders exactly as the current #12 + #27 code:
  full pitch-class fill, hue glow, active brightening, contact stroke, top label. Single-staff
  and audio-derived scores look pixel-for-pixel unchanged. Guard with a single
  `if (note.hand === "left" || note.hand === "right")` around the stripe block.

  **3. Layering order (precise, so effects do not fight).** Per bar, in this sequence:
  1. Body `fill()` (pitch hue + hue glow), unchanged from #12/#27.
  2. **Stripe:** if hand is left/right, `ctx.shadowBlur = 0`, set the neutral
     `fillStyle`, `fillRect` the edge rail. The stripe sits ON TOP of the body fill, inside
     the rounded corner, BELOW the contact stroke and label.
  3. Contact glow stroke (#27), unchanged: re-walk the rounded-rect path and `stroke()` with
     `colors.glow`, `shadowBlur 22`. The stroke is the full bar outline, so it frames the
     stripe too; they do not collide (stroke is on the path edge, stripe is inset 1px).
  4. Name label (#27): collected and drawn after the fill pass with `shadowBlur` reset. The
     label is centered (`x + w/2`) and the stripe is at most 6px on one edge, so for any bar
     wide enough to show a label (`w >= 16`) the centered glyph clears a 6px edge rail with
     room to spare. No label reposition needed. If profiling ever shows a 1-2 glyph label
     brushing a fat stripe on a borderline-narrow active bar, nudge the label x by
     `+STRIPE_W/2` when `hand === "left"` and `-STRIPE_W/2` when `hand === "right"` to recenter
     in the remaining body width; treat that as optional polish, not required.

  **4. Off-range clamped bars (#33).** These already draw at `globalAlpha 0.35` and get no
  label and no contact stroke. Keep the stripe ON them (it inherits the 0.35 alpha), so a
  dimmed off-edge note still shows its hand. The stripe alphas above multiply with 0.35 and
  stay readable as a darker/lighter rail; no special-casing.

  **5. Keyboard + landing bloom are untouched.** Hand is a falling-note cue only. The lit
  key, landing bloom, and key-face labels stay pitch-hued (#12); a key can be pressed by
  either hand and the keyboard is a shared position display, so coloring keys by hand would
  be ambiguous and is out of scope. The falling lane carries the hand signal; by the time a
  note lands the player has already read which hand from the descending bar.

  **6. Optional legend (NICE-TO-HAVE, defer).** A tiny static key somewhere in the topbar
  ("dark edge = left, light edge = right") would teach the convention faster, but the
  dark-left / light-right + side-of-bar pairing is learnable from one or two notes and the
  bar is already busy. Skip for v1; revisit only if playtests show confusion.

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

## Contact glow + label move (issue #27)

- **2026-05-30 - Note name must always FIT the falling bar: scale font to the bar, anchor INSIDE it, omit when truly too small (#39).**
  Correction to the #27 label rule. The #27 spec used a fixed `600 11px` glyph at a fixed
  `y = top + 14` with a coarse `w >= 16 && barHeight >= 22` gate PLUS an "always label the
  active note" override. On short/small bars this broke three ways: (a) a brief note is only a
  few px tall, so `top + 14` placed the name BELOW the bar's bottom edge (detached, floating in
  the lane); (b) the active-note override forced a full-size 11px name onto a ~6px bar, so the
  label was taller AND wider than the note it belonged to (the "oversized pill" look); (c) the
  fixed 11px width could exceed a narrow black-key bar, spilling sideways. Fix = the simplest of
  the ticket's suggested approaches, combined:
  - **Scale the font to the bar, with a floor and a ceiling.** Font size is derived from the bar
    HEIGHT (the binding dimension for short notes): `size = clamp(MIN_LABEL_PX, floor(height *
    LABEL_HEIGHT_RATIO), MAX_LABEL_PX)`, with `MIN_LABEL_PX = 8`, `MAX_LABEL_PX = 12`,
    `LABEL_HEIGHT_RATIO = 0.55`. A tall note keeps the familiar ~11-12px name; a short note shrinks
    its name to match instead of overflowing. The ceiling means we never grow the name larger than
    the old look on a fat bar.
  - **Then also fit the WIDTH; shrink further or drop.** Estimate glyph width as `size *
    LABEL_CHAR_WIDTH_RATIO` per character (`0.62`, a safe monospace-ish upper bound for system-ui
    digits/letters), plus a `LABEL_GUTTER` (2px) each side. If the name does not fit the bar width
    at the height-derived size, reduce the size until it does; if it still does not fit at
    `MIN_LABEL_PX`, OMIT the label. So a name never spills past the bar's left/right edges.
  - **Anchor the name INSIDE the bar, vertically centered.** New baseline is the bar's vertical
    center (`y = top + height/2`, `textBaseline middle`), not a fixed offset from the top. On a
    short bar the centered name sits squarely within the (small) bar; on a tall bar it rides near
    the upper-middle, still clear of the contact point at the bottom edge. `x = x + w/2`,
    `textAlign center` unchanged.
  - **Fallback when truly too small = omit (no forced label).** The "always label the active note"
    override is REMOVED: forcing a legible-min name onto a sub-8px bar is exactly the bug. When a
    bar cannot seat a single `MIN_LABEL_PX` glyph within BOTH its width and height, the name is
    omitted for that note. Identity is still carried by horizontal position (a piano is a position
    display), the active-key hue fill + key-face label at the keybed, and the sheet-view labels
    (#17). A staccato note simply shows no in-bar name, which reads as intentional, not broken.
  - **Why not truncate/abbreviate:** solfege/letter names are already 1-4 chars (e.g. "Sol#",
    "C#4"); truncating "Sol#" to "S" loses the note, so on a bar too small for the whole name,
    omit beats a one-letter stub. Width-fit handles the common narrow-bar case by shrinking, and
    omit is the clean floor. No ellipsis, no per-char truncation logic.
  - **Pure + testable:** the whole decision is a DOM-free helper `fitBarLabel(barWidth, barHeight,
    charCount)` in `src/piano.ts` returning `{ show, fontSize }`, unit-tested across very short
    notes, normal notes, narrow black-key bars, and long (letters+octave) names. The visualizer
    only consumes the result and paints. Effects untouched: #27 contact stroke, #36 hand stripe,
    #38 no-wider-than-note rule (the label is centered and width-constrained, so it can never
    exceed the bar), and the #33 off-range dimmed bars (still no label).

- **2026-05-30 - Note entry must be clean: NO element wider than the note at the keybed (#38).**
  Follow-up correction to #27. The landing bloom that #27 kept (a soft hue pool the full key width,
  meant to make the KEY read as lit) was visually reading as a separate rectangular strip sticking
  out past the note on both sides at the entry point, which looked like a leftover box artifact. The
  PM/design call: that wider-than-note pool is not worth the artifact it creates. Remove it. The
  single contact cue at the keybed is now the #27 glow STROKE alone, which traces the note's own
  rounded-rect outline and so is exactly the note's width, never wider. The "key looks lit" sense is
  carried by the active-key hue fill on the keyboard itself (the key face turns the note's hue), which
  already exists and is a cleaner signal than a bloom overhanging the lane. Rule going forward: any
  highlight drawn at the note's point of entry into the keyboard must be constrained to the note's
  width (use the bar width, not the full key width). The full-keybed resting glow strip is fine: it is
  an ambient band across the whole keyboard, not a per-note box, so it never reads as one note's
  highlight being too wide.

- **2026-05-30 — Replace the note-name "label box" on the contact point with a top-anchored
  light label plus a glow-on-contact border.** Canvas-2D-ready spec for `drawFallingNotes`
  / `drawLandingBloom` in `src/visualizer.ts`. No new deps, no DOM.

  **1. Label moves from the bar BOTTOM (leading edge, where it lands) to just inside the bar
  TOP (trailing edge).** New anchor: `y = top + 14`, still `x = x + w/2`, `textAlign center`,
  `textBaseline alphabetic`. Rationale: the bottom is exactly where the eye watches for the
  contact flash, so it must stay clear; the top rides with the note, sits inside the colored
  fill for contrast, and never collides with the key-face labels or the active-key hue flip.
  Putting the name "on the key" was rejected: short bars have no key to write on, and it
  would fight `drawKeyLabels` and the active-key fill.

  **2. Lighter label treatment (drop the "box" feel).** Was `700 12px` solid `#ffffff`. Now
  `600 11px` at `rgba(255,255,255,0.82)`, keep the `rgba(0,0,0,0.5)` 2px text shadow for
  legibility over L62% hues. Reads as a quiet annotation, not a stamped chip. Do not go below
  11px (legibility floor).

  **3. Visibility gate raised for the new anchor.** Was `w >= 16 && barHeight >= 18`. Now
  `w >= 16 && barHeight >= 22` (the top-anchored glyph + inset needs ~22px before it would
  crowd the freed contact point). Keep the `isActive` override so the sounding note is always
  named even when narrow.

  **4. Contact glow border (the "hit" cue).** A note is "in contact" when
  `isActive && bottom >= keyboardTop - 10` (leading edge within a 10px band of the keybed,
  AND sounding). After the bar `fill()`, re-walk the same rounded-rect path and `stroke()`
  once: `lineWidth 2`, `strokeStyle = colors.glow` (per-pitch hue), `shadowColor = colors.glow`,
  `shadowBlur 22`, `globalAlpha 0.9`, then reset. This is one extra stroke only on the small
  "sounding-and-touching" set, within budget (same class as the bloom). The stroke sits just
  outside the fill so it reads as a crisp neon outline igniting on the bar edge.

  **5. Make the contact border DISTINCT from the existing active-fill.** Lower the active
  bar's body `shadowBlur` from `26` to `20` so the brighter `activeFill` alone is the gentle
  "this is playing" cue, and the stroked border becomes the separate "touching right now"
  cue. Three tiers: falling (`shadowBlur 18`, no stroke); active above the keys (`activeFill`
  + `shadowBlur 20`, no stroke); active at contact (`activeFill` + `20` body PLUS the `glow`
  stroke with `shadowBlur 22`). Without lowering the active blur, a bar glowing hard high
  above the keyboard would not let the hit read as its own event.

  **6. Keep `drawLandingBloom` but dial it back so the effects do not double up.** Both the
  bar stroke and the bloom now stack at the same x. Lower bloom `globalAlpha` 0.55 -> 0.4 and
  `BLOOM_HEIGHT` 22 -> 16, keep `shadowBlur 16` and the per-pitch `colors.glow`. The stroked
  border is the sharp signal; the bloom is the soft hue pool washing onto the keys (so the
  KEY, not just the bar, still reads as lit). Removing the bloom entirely was rejected for
  losing that key-lit sense.

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

## Responsive / mobile (issue #33)

- **2026-05-30 - Spec to make the whole site usable down to a 320px phone.** No new deps,
  CSS plus a small amount of TS in `visualizer.ts` and `piano.ts`. The app shell is a flex
  column: `.topbar` (auto height), `#sheet` (42% height), `#stage` (flex: 1). The keyboard
  is a fixed `KEYBOARD_HEIGHT = 140` strip at the bottom of the canvas; `buildKeyLayout` lays
  all 88 keys (52 white) across the full canvas width. At 320px that is ~6px white keys and
  ~3.8px black keys, unreadable. This is the core problem; the topbar and sheet are secondary.

  **1. Breakpoints + minimum width.** Support down to **320px** (smallest common phone, iPhone
  SE). Use **two** breakpoints on top of the existing one, all `max-width` (the codebase is
  desktop-first), so the cascade reads desktop -> tablet -> phone:
  - **`@media (max-width: 900px)`** = tablet / small laptop. Reflow the topbar (loosen the
    single-row assumption), nothing else changes.
  - **`@media (max-width: 720px)`** = phone (this block already exists; extend it). Keyboard
    shrinks, controls collapse, sheet drops in height.
  - Keep one extra hook **`@media (max-width: 380px)`** ONLY for the few things that still
    overflow at true 320-380px (hide more labels). Do not add more than these three.
  No `min-width` / mobile-first rewrite: the existing CSS is desktop-first and the ticket is a
  focused pass, not a refactor.

  **2. Topbar reflow.** Today `.topbar` is `h1` + `.topbar-rows` (a flex column holding
  `.controls` and `.transport`). `.controls` already `flex-wrap: wrap`; `.transport` does not.
  - **REQUIRED. At <=720px, drop the `<h1>` title** (`display: none`). It costs a full line and
    "Piano Helper" is not needed once you are in the app. Reclaims the most space cheaply.
  - **REQUIRED. Make `.transport` wrap too:** add `flex-wrap: wrap`. The seek slider keeps
    `flex: 1; min-width: 120px`, so prev/play/next stay on the first line and the slider takes
    the rest, wrapping the readout below only if forced.
  - **REQUIRED. Reduce topbar padding** at <=720px: `padding: 0.5rem 0.75rem` and
    `.topbar-rows { gap: 0.45rem }`, `.controls { gap: 0.5rem }` so wrapped rows pack tighter.
  - **REQUIRED. Hide the lowest-value text at <=720px** (extend the existing block):
    `#track-name` and `.sound-status` -> `display: none`. They are status text, not controls,
    and the file-button labels already tell the user what loaded. `.time-readout` is already
    hidden here; keep it. The seek slider's `aria-valuetext` still carries position for AT.
  - **REQUIRED. At <=380px, hide the file-button text and show a glyph instead** is NICE-TO-HAVE
    (see below). For the REQUIRED pass, just let `.controls` wrap the three loaders onto two
    lines; they fit two-per-row at 320px with the smaller padding below. The Names toggle and
    tempo group stay visible.
  - **REQUIRED. Touch targets.** Apple HIG is 44px; we currently undershoot. Bump at <=720px:
    - Buttons / `.file-btn`: `min-height: 44px` and `padding: 0.6rem 0.9rem` (keep font 0.9rem).
    - `.toggle`: `min-height: 44px` (it is `0.4rem` vertical today, too short for thumb).
    - `.step-btn`: set `min-width: 44px; min-height: 44px` (today it shrinks to 2.1rem ~ 34px
      at this breakpoint; reverse that for touch). Glyphs stay centered.
    - **Slider thumbs to 24px at <=720px** (`#seek-slider` and `#tempo-slider` thumbs are 18px
      / 16px). A 24px thumb plus the existing vertical input padding clears a comfortable touch
      target while staying inside the 44px row. Recompute `margin-top` on the webkit thumb so it
      stays centered on the track (seek track 5px -> `margin-top: -9.5px`; tempo track 4px ->
      `margin-top: -10px`). Bump the input vertical `padding` to `10px 0` so the tappable band
      around the thin track is finger-sized.
  - **NICE-TO-HAVE. File buttons collapse to icon + accessible label at <=380px** (e.g. a
    file/scan/wave glyph with the text in `aria-label` / `title`). Cleaner at 320px but needs
    glyph choices and an `aria-label` per button; skip for the first pass.

  **3. Canvas + keyboard sizing (the core change).** Two required moves, both small:
  - **REQUIRED. Make `KEYBOARD_HEIGHT` responsive by width, not a constant.** Replace the fixed
    `140` with a function of canvas width so a phone keyboard is not absurdly tall relative to
    its hair-thin keys. Rule: `keyboardHeight = clamp(96, width * 0.18, 140)`. At >=778px wide
    this is the current 140; at 390px it is ~96 (the floor); the floor keeps the key faces tall
    enough to read the note-name labels (issue #11 baseline is 10px from the bottom). Compute it
    in `resize()` from `this.width`, store as `this.keyboardHeight`, and use that field
    everywhere `KEYBOARD_HEIGHT` is read today (`keyboardTop()`, the `height - KEYBOARD_HEIGHT`
    pixels-per-second math, the `fillRect`/`strokeRect` key draws, `KEYBOARD_HEIGHT * 0.62`
    black-key height, and the `top + KEYBOARD_HEIGHT - 10` label baseline). The `* 0.62` and
    `- 10` ratios stay; only the base value goes responsive.
  - **REQUIRED. Show fewer keys on narrow widths so each key is finger- and eye-legible.** All
    88 keys at 320px is unusable. `buildKeyLayout(totalWidth)` currently always spans
    `FIRST_MIDI..LAST_MIDI`. Give it an explicit range: `buildKeyLayout(totalWidth, firstMidi,
    lastMidi)` defaulting to `FIRST_MIDI`/`LAST_MIDI` so desktop is unchanged. In `resize()`
    pick the range from width:
    - `width >= 760`: full 88 keys, `21..108` (unchanged).
    - `480 <= width < 760`: **61 keys, `36..96`** (C2..C7), the common controller range.
    - `width < 480`: **49 keys, `36..84`** (C2..C6), 29 white keys -> ~13px white keys at 380px,
      ~11px at 320px, legible and tappable enough to watch.
    All ranges **start and end on C** so the keyboard begins on a white key (no half-cut black
    key at the left edge) and `buildKeyLayout`'s "black key centered on the previous white
    boundary" math stays clean. Center is automatic: `buildKeyLayout` already spreads the chosen
    white-key count across the full `totalWidth`, so a narrower range simply means wider keys
    filling the same canvas, no extra centering code.
    - **Off-range notes.** A note whose MIDI falls outside the visible range still plays (audio
      is unaffected) but has no key column. For the falling bar, **clamp its x to the nearest
      edge key and dim it**: draw at the first/last key's x-range at `globalAlpha 0.35` so the
      player sees "there is a note off the left/right edge" without a crash or an off-canvas
      bar. This is the simplest correct behavior; a scrolling/auto-ranging keyboard is out of
      scope. Most beginner repertoire (the target content) sits inside C2..C6.
  - **NICE-TO-HAVE.** Auto-fit the visible range to the loaded score's actual min/max MIDI
    (so a piece living in C3..C5 fills the phone with big keys). Better UX but needs the score
    range plumbed into `resize()`; defer.

  **4. Sheet view (`#sheet`).** OSMD renders an SVG at a layout width it picks; on a phone the
  default can overflow or render microscopic.
  - **REQUIRED. Reduce `#sheet` height at <=720px to `34%`** and at <=380px to `30%`, giving the
    keyboard + falling-notes area (the thing you actually play from) more of the short phone
    viewport. Keep `overflow-y: auto`.
  - **REQUIRED. Horizontal scroll, do NOT zoom-to-fit.** Set `#sheet { overflow-x: auto }` at
    <=720px and let OSMD lay the system out at a readable size; the user swipes horizontally to
    read across a wide system. Zoom-to-fit would shrink noteheads (and the #17 note-name
    overlay) below legibility on a narrow screen. The #17 overlay is already a child of the
    scrolled box so it scrolls with the SVG in both axes, no extra work.
  - **NICE-TO-HAVE.** Call OSMD's `zoom` to a width-aware factor (e.g. 0.7 on phones) so a system
    fits with fewer measures per line and less horizontal swiping. This is a behavior change in
    the render path; coordinate with Tech Lead and defer.

  **5. Touch + orientation.**
  - **REQUIRED. Confirm seek/tempo drag works by touch.** Native `<input type=range>` is
    touch-draggable by default; nothing in the current CSS adds hover-only behavior that blocks
    it (the `:hover` rules only grow the glow, they do not gate interaction). The one thing to
    add: `#seek-slider, #tempo-slider { touch-action: none }` so a horizontal drag on the thumb
    scrubs instead of scrolling the page. Body is `overflow: hidden` so there is no page scroll
    to fight, but `touch-action: none` makes the intent explicit and avoids gesture ambiguity on
    the wrapped topbar.
  - **REQUIRED (lightweight). Rotate-to-landscape hint on narrow portrait.** The keyboard is far
    more usable in landscape (more width = wider keys = more octaves). Show a **non-blocking,
    auto-hiding** hint, not a modal:
    - **When:** `@media (max-width: 540px) and (orientation: portrait)`.
    - **What:** a single pill anchored bottom-center, `position: fixed; bottom: 12px; left: 50%;
      transform: translateX(-50%)`, text **"Rotate for a wider keyboard"**, reusing the violet
      button gradient, `border-radius: 999px; padding: 0.5rem 0.9rem; font-size: 0.8rem;
      box-shadow: 0 0 12px var(--accent-glow); z-index: 5; pointer-events: none`. A small
      rotate glyph (`&#x21BB;`) prefix is fine.
    - **Behavior:** purely CSS, no JS. It is shown only by the media query, so rotating to
      landscape removes the portrait condition and the hint disappears automatically (the
      "auto-hide on rotate" requirement is satisfied for free). `pointer-events: none` makes it
      non-blocking. Add a CSS `animation` that fades it to `opacity: 0` after ~4s
      (`@keyframes` with `animation-fill-mode: forwards`) so it also auto-hides if the user
      stays in portrait. No dismiss button needed (keeps it dependency-free and uncluttered).
    - Markup: one `<div id="rotate-hint" aria-hidden="true">` at the end of `#app`. `aria-hidden`
      because it is advisory and the app is fully operable in portrait.
  - **NICE-TO-HAVE.** Persist a "dismissed" flag so the hint never reappears after first rotate;
    skip for v1 (the 4s fade plus rotate-removal already keeps it from nagging).

  **REQUIRED checklist (ship this, in this order):**
  1. Add breakpoints `@media (max-width: 900px)` and `@media (max-width: 380px)`; extend the
     existing `@media (max-width: 720px)`.
  2. At <=720px: hide `<h1>`, `#track-name`, `.sound-status`; `.transport { flex-wrap: wrap }`;
     tighten topbar padding/gaps as specified.
  3. At <=720px: buttons/`.file-btn`/`.toggle`/`.step-btn` get `min-height: 44px`
     (`.step-btn` also `min-width: 44px`); slider thumbs grow to 24px with corrected
     `margin-top` and `10px 0` input padding.
  4. Make `KEYBOARD_HEIGHT` a width-derived field `clamp(96, width*0.18, 140)` computed in
     `resize()`; replace every `KEYBOARD_HEIGHT` read with the field.
  5. Add a range to `buildKeyLayout(width, firstMidi, lastMidi)`; in `resize()` pick
     `21..108` / `36..96` / `36..84` by width thresholds 760 / 480; clamp+dim off-range
     falling bars at `globalAlpha 0.35`.
  6. At <=720px: `#sheet { height: 34%; overflow-x: auto }`; at <=380px `height: 30%`.
  7. `#seek-slider, #tempo-slider { touch-action: none }`.
  8. Add `#rotate-hint` pill, shown only at `max-width: 540px and (orientation: portrait)`,
     `pointer-events: none`, 4s fade-out, removed automatically on rotate.

  Everything under NICE-TO-HAVE (icon-only file buttons, score-aware auto key range, OSMD zoom,
  persisted hint dismissal) is explicitly deferred so the first pass stays simple.

## Open UX questions

- ~~Hand/voice coloring (left vs right hand) like Synthesia.~~ RESOLVED in issue #36: a
  dark-left / light-right edge accent stripe on the falling bar, keeping the #12 pitch hue on
  the body. See the "Left vs right hand on falling notes (issue #36)" spec above.
