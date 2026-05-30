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

- **2026-05-30 - Hand tagging now keys off the CLEF, not the staff array index (fixes "muting right hand still plays it").**
  Root cause: `extractScore` tagged hands with `handFromStaffIndex(staves.indexOf(staff), len)`,
  assuming staff index 0 = treble = right. But a MusicXML file can declare its staves bass-first
  (bass on staff 1 / index 0, treble on staff 2 / index 1) - some music21 exports do this. That
  inverted the hands: the bass got "right", the treble melody got "left". Muting "right" then
  silenced the bass while the melody kept sounding, which is exactly what the user heard. The audio
  mute logic itself (Part callback `note.hand === "right" && handMuted.right` -> skip trigger) was
  always correct; the data feeding it was wrong. Verified end-to-end: Tone.Part DOES pass the value
  object (with `hand`) to the callback, and the skip works - the bug was purely the hand label.
  - **Fix:** new pure helper `handFromClef("treble"|"bass"|"other")` in `piano.ts` (treble->right,
    bass->left, other->null). `score.ts` `readStaffClefs(osmd)` reads each staff's opening clef from
    `osmd.Sheet.SourceMeasures[].FirstInstructionsStaffEntries[staffIndex].Instructions` (find the
    `ClefInstruction`, map `ClefType` via `ClefEnum.G`/`ClefEnum.F`), keyed by `staff.idInMusicSheet`.
    Per note: only split when the instrument has >=2 staves (else "unknown", unchanged), prefer the
    clef, fall back to `handFromStaffIndex` for C/percussion clefs. `ClefInstruction`/`ClefEnum` are
    re-exported from the `opensheetmusicdisplay` package root.
  - **OSMD gotchas learned while chasing this:** two separate `<part>` elements (even same name, even
    in a `<part-group>` brace) become two single-staff instruments -> all notes "unknown" -> mute
    buttons hidden. Hands split into right/left ONLY for a single instrument with `<staves>2</staves>`.
    Notes that separate hands by `<voice>` without explicit `<staff>` all collapse onto staff 1.

- **2026-05-30 - Code review of #67 (falling-note label legibility, PR #69): APPROVE.** Two-pole
  contrast-aware glyph ink + width-only overflow for narrow desktop bars. Verified independently:
  - **Luminance table is correct and octave-invariant.** `PITCH_CLASS_GLYPH_DARK` in `piano.ts`
    mirrors `buildNoteColors` exactly (whiteFill 85/62, blackFill 70/50, activeFill 95/72). Recomputed
    by hand: white-fill luminance >= 0.6 for Mi(64)/Fa(65)/Fa#(66)/Sol(67)/Sol#(68)/La(69) -> dark ink;
    Do(60)=0.487 and Si(71)=0.390 -> light ink. Matches the reported washed-out hues. `activeL > whiteL`
    for every pc, so the "active never makes a bar less likely to take dark ink" monotonicity test holds
    (Do flips to dark only when active at L 0.610, harmless). Hue is pitch-class-only, so octave-invariant.
  - **Overflow math is bounded.** Brute-forced w 4..80, h 2..100, chars 1..4: zero width-budget
    violations (rendered name always <= `barWidth*(1+2*0.9)`), font never exceeds `floor(barHeight*0.55)`
    (no vertical overflow, no detached pill, #39 intent preserved), shown font always >= MIN_OVERFLOW_PX 7.
    A 10px/60h/2char bar shows "Do" at full 12px spilling ~4px/side; a 10px/12h bar still omits (height
    floor binds). Existing in-bounds callers default `allowOverflow=false` and are unchanged.
  - **No hot-loop cost.** `barGlyphIsDark` reads the precomputed boolean table; `hslToRgb`/`rgbLuminance`/
    `fillIsLight` run once at module load. The only `measureText` in the file is the pre-existing #33
    keyboard-face label path (line 391), unrelated to falling notes. Paint loop adds one `strokeText` per
    already-fitted label.
  - **No neighbor regressions.** #36 cap, #27 contact glow (`isActive && !muted && bottom>=...`), #54
    ghosting (alpha threaded into the label record + globalAlpha reset discipline), #42/#43 gate
    (`labelMode!=="off" && labelableNote[i]!==false`) all intact. Minor non-blocking note: a MUTED active
    bar draws body with `activeFill` but computes glyph ink with `active:false` (resting). Cosmetic only;
    the bar is at alpha 0.3 and `activeL>whiteL` means polarity never flips the wrong way on a faded
    element. Build green, 199 tests pass, diff em/en-dash clean. Live in-browser pass deferred to the
    post-merge QA gate (preview server still bound to a different worktree).

- **2026-05-30 - Unified note-name labeling SHIPPED (#42 + #43): two pure helpers in `piano.ts`,
  one shared look-ahead, both label systems derive from one model.** One branch
  (`fix/note-name-labeling`), one PR, because the falling-bar names and the keyboard-key names are
  the same "what gets a name, when" question and would conflict if split. No new deps.
  - **#42 root cause (recorded so nobody re-chases it):** the apparent "left hand labels every
    note, right hand only the leading note" was NOT a per-hand code path. The falling-bar label
    gate is purely `fitBarLabel(w, barHeight, chars)` and font size derives from bar HEIGHT
    (`duration * pps`). Right-hand (treble) notes are usually short -> small bar -> name omitted by
    the #39 floor; left-hand (bass) notes are usually long/sustained -> tall bar -> always labeled.
    Hand correlation was incidental (duration-correlated), not intended. Fix = make the decision
    identity-based + hand-agnostic; `fitBarLabel` stays only as a per-frame legibility guard.
  - **Helper 1: `labelableFallingNotes(notes): boolean[]`** (pure, index-aligned to the input
    array). Labels the FIRST note of each run of consecutive same-`midi` notes per HAND lane
    (left/right/unknown dedupe independently via a `Map<lane, lastMidi>`), re-labels on a pitch
    change. Sorts indices BY TIME internally (so "consecutive" means consecutive in playback) then
    maps the decision back to original indices, so an out-of-time-order `notes` array still labels
    the time-first note of a run. `extractScore` emits notes in chronological order and
    `transcribe` sorts by time, so in practice array order == time order, but the helper does not
    rely on it.
  - **Helper 2: `approachingKeyMidis(notes, currentTime, lookAhead = KEY_LABEL_LOOK_AHEAD): Set<number>`**
    (pure). Returns the midis whose key should be labeled now: any note with
    `currentTime in [time - lookAhead - eps, time + duration + eps]` (entered the top of the visible
    lane through end of sounding). Empty set when nothing is approaching. `KEY_LABEL_LOOK_AHEAD = 4`
    is exported and the visualizer's `LOOK_AHEAD` now ALIASES it, so the keyboard-label window and
    the falling-note visible window can never drift apart (a key shows its name exactly while its
    bar is visible).
  - **Visualizer wiring (`src/visualizer.ts`):** `setNotes` precomputes `labelableNote: boolean[]`
    once (not per frame). The falling-note loop switched to an index loop and gates the label block
    on `this.labelableNote[i] !== false` (the `!== false` is a deliberate safe default if the array
    were ever short). `render` computes `approaching = approachingKeyMidis(...)` once per frame
    (O(n), same budget as the existing `activeMidis`) and threads it through `drawKeyboard` ->
    `drawKeyLabels`, which now `continue`s past any white key not in the approaching set and
    early-returns when the set is empty (saving the measureText fit loop in quiet moments). Black
    keys stay unlabeled as before. The #39 fit, #33 off-window dim, #54 muted ghosting, #36 stripe,
    #27 contact glow are all untouched.
  - **Tests: 14 new in `src/piano.test.ts`** (`labelableFallingNotes` 7, `approachingKeyMidis` 7):
    repeated-run dedupe, re-label on pitch change, BOTH-HANDS-CONSISTENCY (identical left vs right
    runs label identically), per-hand independent dedupe, time-order-not-array-order, unknown lane,
    empty; and for keys: nothing-in-window -> empty, enters/leaves window boundary, sounding note
    stays until release, full chord labeled, custom window, default == 4 == lane. Canvas paint stays
    untested (the decision is fully in the two pure helpers). Full suite 165 green, `npm run build`
    green.
  - **Code review (self, tech-lead, high effort):** no findings. Verified no broken call sites
    (helpers are new exports; `drawKeyboard`/`drawKeyLabels` are private), the dedupe lands on the
    time-first run note, and the muted/ghost + off-window-clamp interactions are unchanged.
  - **Verification caveat: could NOT verify the UI live from this agent worktree** (the preview MCP
    server is bound to a different worktree, same limit as #36/#37/#38/#39). Covered by the 14 unit
    tests + build + code reasoning. This is exactly the label-on-screen class that has shipped
    broken-but-green before, so the post-merge live QA gate on `main` is required.

- **2026-05-30 - Editable sheet name SHIPPED (#44): pure naming logic + inline toolbar edit.**
  The user can rename the loaded piece inline in the right-trailing `#track-name` toolbar slot.
  - **Pure module `src/sheet-name.ts` (16 unit tests):** `deriveDefaultSheetName(fileName,
    musicXmlTitle)` (title wins, else file name with extension stripped, else "Untitled sheet"),
    `normalizeSheetName` (collapse whitespace, cap at `MAX_SHEET_NAME_LENGTH` 80, re-trim), and
    `resolveEditedSheetName(edited, current)` (empty edit reverts to current, never blanks). All
    DOM-free so they test without OSMD/jsdom, same pattern as recorder.ts/playback.ts. Gotcha:
    the extension-strip regex is `\.[A-Za-z0-9]{1,8}$` (8 not 5, so ".musicxml" strips) and only
    a final dot+alnum, so a name like "J.S. Bach" (tail "Bach" has no preceding dot) is left alone.
  - **DOM wiring in `src/main.ts`:** the old single `#track-name` span (which packed "name (N
    notes)") was split into `#sheet-name` (a `<button>`, click-to-edit), a hidden `#sheet-name-input`,
    a `#sheet-note-count` span, and a `#track-status` span for transient messages, all inside a
    `#track-name` flex `<div>` that KEEPS `margin-left:auto` so #46's slot reservation and #33's
    `.track-name { display:none }` mobile hide still apply unchanged. Module state `sheetName` /
    `noteCount` / `nameEditing`; `setSheetName` also sets `document.title` and the export filename
    now uses `sheetName` (reusing the title for #15 export per the issue). `showStatus` /
    `restoreSheetName` swap the slot between the editable name and a status message; all the old
    `trackName.textContent = "..."` status writes (scan/transcribe/record/error) route through them.
  - **Edit lifecycle gotcha:** Enter and blur both commit, Escape cancels; the input's `blur`
    handler calls `commitNameEdit` which is a guarded no-op once `nameEditing` is false, so the
    Enter-then-blur and Escape-then-blur double-fires are safe. `loadNotes` calls `cancelNameEdit()`
    first so a rename in progress on an old score is dropped when a new one loads. The global
    keydown shortcut handler already bails on focused INPUT, so typing Space/arrows in the name
    field works natively.
  - **Verification:** 17 new tests (16 sheet-name + 1 toolbar markup guard added to
    `toolbar.test.ts` locking the four new ids + aria-label + maxlength), full suite 165 green,
    `npm run build` green. Code review (high effort, self-run): no findings. Could NOT verify the
    UI live (the preview server is bound to a different worktree, the standing limitation in qa.md);
    open as a live-QA item.

- **2026-05-30 - Heroicons adopted via INLINE SVG, not the npm package (#48).** Toolbar/transport
  icons now use Heroicons (MIT), delivered as inline `<svg>` with paths copied from the official
  set (`tailwindlabs/heroicons` `src/24/{outline,solid}`), NOT the `heroicons` npm package nor any
  React wrapper. Why inline over a dependency: (1) the project is vanilla Vite + TS with no JSX, so
  the React package is unusable and the raw-SVG package would need a `?raw`/loader import per icon
  for zero runtime benefit; (2) zero new deps keeps the bundle-size discipline (the #19 tfjs note)
  and matches the EXISTING pattern - #46 already shipped the step glyphs as inline SVG. This is
  strictly "swap the path data + add a few icons", same delivery mechanism as #46.
  - **Convention:** outline icons use `fill="none" stroke="currentColor" stroke-width="1.5"`
    (Heroicons' native outline weight); the SOLE solid icon is the Play/Pause hero
    (`fill="currentColor"`). `currentColor` is the whole point: every icon inherits its button's
    tier color and the #46 hover/active/disabled treatment with no extra CSS. The hardcoded
    `#0F172A` Heroicons ship on each path is stripped (a markup test asserts it never appears).
  - **JS-swapped icons (the one gotcha).** `setPlaying` used to do `playBtn.textContent = "Play" |
    "Pause"`, and `applyLabelMode` did `namesBtn.textContent = ...`; with an inline `<svg>` in the
    button, that wipes the icon. Fix: each such button wraps its text in a dedicated label span
    (`#play-label`, `#names-label`), and the JS now sets `.textContent` on the SPAN only. For
    Play/Pause the icon also changes shape (triangle <-> two bars), so `setPlaying` swaps the
    single `<path d=...>` between `PLAY_ICON_PATH`/`PAUSE_ICON_PATH` (Heroicons solid play/pause
    path constants in main.ts) and updates the button's `aria-label`. A guard test forbids
    `playBtn.textContent =` / `namesBtn.textContent =` so this regression can't silently return.
  - **Tests.** 11 new markup/CSS guards in `src/toolbar.test.ts` (no jsdom, same text-read pattern
    as #46): each of the 8 inlined Heroicons matched by a fragment of its authentic path, the
    `currentColor`/no-`#0F172A` convention, solid-only-for-Play, and the label-span swap discipline
    (reads `src/main.ts` too now). Full suite 162 green, `npm run build` green.
  - **Verification caveat:** preview port 5173 is bound to a different worktree, so verified by a
    WebKit static render (qlmanage) of the built header + the 11 guards; live in-browser + 720px +
    the play/pause swap remain for the post-merge QA gate.

- **2026-05-30 - Accidental spelling is LOST at `halfTone -> midi` (review #40).** Documented
  during the #40 accidentals review (design.md has the full UX writeup + follow-ups). Root cause for
  any future "show flats / enharmonic spelling" work: `extractScore` (`src/score.ts:28`) and the sheet
  overlay (`src/sheet-overlay.ts:53`) both reduce each note to `note.halfTone + 12`, discarding OSMD's
  notation spelling (the MusicXML `<step>` + `<alter>`, e.g. Db vs C#). Every label downstream then
  recomputes the name from MIDI via a fixed ALWAYS-SHARP array (`LETTER_CLASSES` / `SOLFEGE_CLASSES` in
  `src/piano.ts:92-95`), so flats never appear (no `flat`/`.alter`/`♭` anywhere in `src/`). To honor a
  score's flats, carry the spelling (OSMD `note.Pitch` `Accidental`/`AccidentalEnum`, or step+alter)
  alongside `midi` on `VisNote` from those two extraction points and have the label use it when present,
  falling back to the pitch-class array only when absent (audio-transcribed scores have no spelling).
  The label fit (#39), hue (#12), and black-key lane geometry are all MIDI-driven and correct already;
  only the printed NAME needs the spelling. No code changed in #40 (docs-only spike).

- **2026-05-30 - Muting a hand now ghosts its falling notes (#54), not audio-only.** #37 shipped a
  mute that only skipped a hand's Tone.Part triggers, so muting had zero on-screen effect; with sound
  off it read as a dead button. Fix: the visualizer learns the mute state via `setMutedHands({left,
  right})` (a field, read each frame, pushed from main.ts on every toggle and reset on load). In
  `drawFallingNotes`, a muted bar draws at `globalAlpha 0.3` (composed with the off-window 0.35 via
  `Math.min`), its contact glow is suppressed (`inContact = isActive && !muted && ...`), and its label
  carries the same dimmed alpha. The mute predicate is a pure `isHandMuted(hand, mutedHands)` in
  `piano.ts` (unit-tested: matching hand only, `unknown`/`undefined` never mute) so the alpha and the
  contact gate share one source of truth. Reset `globalAlpha = 1` at the end of each bar iteration and
  after the label pass so a muted bar's dim never leaks. Verified live (post-merge QA gate): muting the
  right hand visibly ghosts the treble bars while bass bars stay full; console clean.

- **2026-05-30 - Falling-note name now ALWAYS fits the bar (#39): pure `fitBarLabel` helper + center-anchor.**
  Fixed the note name overflowing/detaching on short or narrow falling bars. Root cause was the #27
  label rule: a fixed `600 11px` glyph at a fixed `y = top + 14` with a coarse `w >= 16 && barHeight
  >= 22` gate AND an "always label the active note" override. On a brief note (a few px tall),
  `top + 14` placed the name below the bar's bottom edge (detached); the active override stamped a
  full 11px name onto a ~6px bar (taller+wider than the note, the "oversized pill"); and 11px could
  exceed a narrow black-key bar's width (sideways spill). Pieces:
  - **Pure helper `fitBarLabel(barWidth, barHeight, charCount): { show, fontSize }`** in `src/piano.ts`
    (next to the label helpers). Font derives from bar HEIGHT: `size = min(MAX_LABEL_PX 12,
    floor(height * LABEL_HEIGHT_RATIO 0.55))`, then capped by WIDTH: `min(size, floor((width - 2*gutter)
    / (charCount * LABEL_CHAR_WIDTH_RATIO)))` with `LABEL_CHAR_WIDTH_RATIO 0.62`, `LABEL_GUTTER 2`. If
    the result `< MIN_LABEL_PX (8)`, return `show:false` (omit). All constants exported for the tests.
    The char-width estimate (0.62 * size per glyph) is a deliberate upper bound for system-ui so the
    fit math needs NO `ctx.measureText` in the rAF loop (the #12 perf budget: no per-bar measureText).
  - **Visualizer (`src/visualizer.ts`) consumes the result only.** The label-collection block now calls
    `fitBarLabel(w, barHeight, text.length)` and pushes `{x, y, text, fontSize}` only when `show`. The
    "always label active note" override is REMOVED (it was the source of the forced oversized label).
    Anchor moved from `y = top + 14` (alphabetic baseline) to `y = top + barHeight/2` with
    `textBaseline = "middle"`, so the centered name sits INSIDE the bar at any height instead of
    floating below a short one. The text pass sets `ctx.font` per-label (`600 ${fontSize}px system-ui`)
    inside the loop since sizes now vary; everything else (shadow reset discipline, the
    rgba(255,255,255,0.82) fill + 2px dark text shadow) is unchanged from #27.
  - **Does not regress the neighbors.** Centered + width-constrained label can never exceed the bar
    width, honoring #38's no-wider-than-note rule. The #27 contact stroke and #36 hand stripe are
    untouched (label is collected after the fill/stripe/stroke pass, drawn last with glow off). Off-range
    #33 bars still `continue` before the label block, so they stay name-free.
  - **Tests: 10 new in `src/piano.test.ts`** (`fitBarLabel` describe): normal bar -> MAX size, huge bar
    capped at MAX, short ~18px bar scales below MAX but >= MIN, ~6px staccato omitted, narrow 13px
    black-key bar fits-or-omits within width, 6px sliver omitted, 4-char letters+octave name fits, empty
    name omitted, and a fuzz sweep over widths 6-60 / heights 4-80 / 1-4 chars asserting every shown
    label stays within [MIN,MAX] and never exceeds the bar width. Canvas paint stays untested (pure
    geometry is the testable core, same pattern as #38's `noteBarWidth`). Full suite 148 green,
    `npm run build` green.
  - **Gotcha:** `transcribe.test.ts` fails with "Failed to load url @spotify/basic-pitch" if
    `node_modules` is stale in a fresh worktree; `npm install` pulls the dep and the suite goes 148
    green. Not related to any source change.
  - **Verification caveat:** preview MCP server is bound to a DIFFERENT worktree (port 5173,
    gifted-fermi) and reuses it, so no live in-browser visual pass from this agent worktree. Verified by
    the 10 unit tests + the fuzz sweep (the label-fit decision is fully captured in the pure helper),
    `npm run build` green, and code reasoning that the centered+fitted glyph is bounded by the bar.

- **2026-05-30 - Note-entry artifact FIXED (#38): removed `drawLandingBloom`, the only contact
  element wider than the note.** The "rectangular layer wider than the note, sticking out on both
  sides at the keyboard entry" was the per-active-key landing bloom in `src/visualizer.ts`
  (`drawLandingBloom`), a rounded rect drawn at `key.x` with the FULL `key.width` just above the
  keybed (`top - 16`). Falling white-note bars are only `key.width * 0.82` wide and centered, so the
  bloom overhung ~9% of the key on each side: exactly the artifact. (Black-note bars fill their key
  width, so the overhang was white-note-specific.) Removed the method and its call entirely. The #27
  contact-glow stroke is now the sole per-note contact highlight, and it strokes the exact bar path
  (`w` = bar width), so it can never exceed the note's width. NOT removed: the resting glow strip in
  `drawKeyboard` is a full-keybed ambient gradient (`fillRect(0, top-30, width, 30)`), not a per-note
  box, so it does not read as "a box wider than one note" and is untouched. Hand stripe (#36, inset in
  the bar) and note-name labels are unaffected.
  - **Reusable geometry helper added:** `noteBarWidth(keyWidth, black)` + `WHITE_BAR_WIDTH_RATIO`
    (0.82) in `src/piano.ts`, so the bar-width math is named once instead of the inline
    `key.width * (black ? 1 : 0.82)`. The visualizer now calls it. This is the invariant the bloom
    broke (any keybed highlight must use the bar width, never the full key width). Regression coverage:
    3 tests in `src/piano.test.ts` (white = 82%, black = full, and a loop asserting the bar width never
    exceeds the key width so a centered highlight always has non-negative gutter on both sides). Canvas
    paint itself stays untested; the geometry is the testable core.
  - **Verification caveat:** the preview MCP server was bound to a DIFFERENT worktree (port 5173,
    `gifted-fermi-...`) and `preview_start` reused it instead of launching one for this branch, so no
    live in-browser visual pass was possible from the agent worktree. Verified instead by full suite
    (139 green) + `npm run build` green + code reasoning that the only full-key-width draw at the entry
    point was the removed bloom.

- **2026-05-30 - Toolbar redesign v2 SHIPPED (#46): three-tier palette + SVG step icons.**
  Follow-up to #34, which fixed grouping/ghost-vs-filled but left the palette monochrome (all
  three loaders AND Play were the same filled violet gradient) and shipped broken step glyphs
  (`◄|` / `|►`, an arrow jammed against a pipe). Research-led per the Designer spec in design.md.
  Markup/CSS only plus one new dep-free guard test; no JS/behavior change, so the #29 step logic
  and the sync invariant are untouched. Pieces:
  - **Three button tiers (`src/style.css`).** PRIMARY (sole filled-violet hero) = `#play-btn`
    only, applying "one accent per viewport". SECONDARY (new) = the three `.file-btn` loaders,
    demoted from filled violet to a raised NEUTRAL surface (`--secondary-*` tokens) that only
    tints violet on hover. GHOST = `#export-btn`, `.toggle`, `.step-btn` (unchanged in spirit).
    This is the whole fix: exactly one violet button on the bar now, so it stops reading as
    "purple everywhere" and gains a real primary/secondary/ghost hierarchy.
  - **New tokens (`:root`).** Calmer near-neutral `--bar-surface rgba(16,14,22,0.92)` and neutral
    `--bar-border` / `--group-divider` (was violet-tinted), plus the `--secondary-*` raised tier.
    The brand anchors (`--accent`, `--accent-gradient`, glow) and the slider violet are unchanged,
    so the visualizer + sliders + violet wordmark keep the brand identity. Button labels use
    `#f7f2ff` (near-white), not `#ffffff`, on hover/fill.
  - **Step buttons -> inline SVG skip-previous / skip-next (`index.html`).** Replaced the text
    glyphs with two inline `<svg class="step-icon" fill="currentColor">` icons: prev = vertical
    bar on the LEFT + left-pointing triangle (`|◄`), next = right-pointing triangle + bar on the
    RIGHT (`►|`), the universally-read "step one back/forward" shape. `currentColor` means they
    inherit the ghost label color and the hover brighten for free, and they are crisp + identical
    cross-platform (no emoji-variation risk that `⏮`/`⏭` carry). Kept every `id=`, `aria-label`,
    and `title`, so the change is purely visual and main.ts's `prevNoteBtn`/`nextNoteBtn` hooks
    and screen-reader labels are unaffected. Verified the rendered glyphs via qlmanage PNG: they
    read as the standard skip-track controls.
  - **Tight transport cluster (`index.html` + CSS).** Wrapped prev/Play/next in a new
    `.transport-cluster` (gap 0.4rem) so the two step satellites flank the Play hero, then a wider
    `.transport` gap before the seek scrub + time readout. Only new DOM is that one wrapper div;
    no id moved.
  - **Tests (`src/toolbar.test.ts`, NEW, 22 tests).** No jsdom in the project (kept dep-free), so
    the guard reads `index.html` + `src/style.css` as text and asserts: all 14 `id=` hooks main.ts
    queries still exist, the prev/next `aria-label`s + shortcut titles survive, the broken text
    glyphs are gone and exactly two `step-icon` SVGs exist, the `.file-btn` loaders use
    `--secondary-bg` (NOT the accent gradient) while `#play-btn` keeps the gradient, the divider
    uses `--group-divider`, and the #33 mobile contract (`@media (max-width:720px)` + `min-height:
    44px` + `.step-btn { min-width: 44px }`) is intact. This locks the redesign's invariants
    against future markup regressions without adding a browser dep. Full suite 136 green.
  - **Coordinates with #44/#33.** Left `#track-name { margin-left: auto }` as the right-trailing
    flexible slot so the future editable sheet name (#44) can slot in; did NOT build #44. The tier
    change is color-only on the loaders (still `button`/`.file-btn`), so all #33 responsive rules
    still match unchanged.
  - **Verification caveat (same preview-binding limit as #36/#37):** the `preview_start` tool is
    bound to a DIFFERENT worktree (gifted-fermi on port 5173) and reuses it instead of attaching
    to this agent worktree, so the live MCP preview did not reflect these changes. Verified
    instead by: `npm run build` green + confirming the built `dist` carries the SVG icons + tier
    CSS; a real WebKit render via `qlmanage` of the built CSS + header (full desktop toolbar
    screenshot showed the single violet Play hero, neutral loaders, ghost utilities, and correct
    skip glyphs); and the 22-test markup/CSS guard. The phone breakpoint was checked via the unit
    test rather than a live 375px viewport (qlmanage does not honor the media query reliably).

- **2026-05-30 - Per-hand mute SHIPPED (#37): skip the trigger, never rebuild the Part.**
  Two per-hand audio mute toggles (Right/Left), built on the #36 `VisNote.hand` tag. Pieces:
  - **Pure helper `hasBothHands(notes: VisNote[]): boolean`** in `src/playback.ts` (true only
    if at least one `"right"` AND at least one `"left"` note exists; early-exits the loop once
    both are seen). 6 unit tests in `src/playback.test.ts` (both -> true; right-only,
    left-only, all-unknown, empty, right+unknown -> false). This gates the toggles' visibility.
  - **Mute is a per-callback skip, not a Part rebuild.** A module-level
    `const handMuted = { left: false, right: false }` in `src/main.ts` is read FRESH at the top
    of the `Tone.Part` callback: `if (note.hand === "left" && handMuted.left) return;` and the
    same for right, before `triggerAttackRelease`. `"unknown"` always sounds. Toggling a hand
    flips the flag and takes effect from the NEXT onset with zero rescheduling, so it is live
    and cheap. The Part's note projection gained `hand: n.hand` (was `{ time, midi, duration }`).
  - **Why skip-in-callback over a per-hand Tone channel/volume node:** a skipped trigger has no
    downstream side effects, so the sampler/synth swap (`getInstrument`) and the export-video
    path (which records the master output) need NO change. Routing each hand through its own
    gain node would have meant two instruments or a mid-graph split and re-plumbing the export
    tee; the skip is one branch and keeps the single-instrument, single-destination graph.
  - **Visibility + reset in `loadNotes` (`src/main.ts`):** compute `hasBothHands(score.notes)`;
    `handMutes.hidden = !hasBothHands(...)`. On EVERY load reset `handMuted` to
    `{left:false,right:false}` and both buttons' `aria-pressed` to `"false"`, so a hand muted
    on a previous score never silently carries into the next one. Button clicks flip the flag
    and reflect it in `aria-pressed` (true = muted), mirroring the existing `#names-btn` wiring.
  - **Correctness:** muting does NOT stop notes from falling; the visualizer draws from
    `score.notes` by time, fully independent of audio (untouched). A note already sounding when
    its hand is muted keeps ringing until its release completes (mute applies from the next
    onset); accepted for v1, no active-voice tracking added.
  - **Markup/CSS** per the Designer spec in design.md: `#hand-mutes` container (`hidden` by
    default) in the settings `.group`, two `<button class="toggle hand-toggle" aria-pressed>`
    reusing the #34 ghost-pill, muted shown by dim + label strikethrough + swatch fade (more
    than color), swatches matching the #36 rails (right near-white, left near-dark).
  - **Verification caveat:** the preview tool is bound to a different worktree in this setup and
    jsdom is not a project dep, so live in-browser checking was not possible from the agent
    worktree. Covered instead by the 6 `hasBothHands` unit tests (full suite 114 green),
    `npm run build` + the functions typecheck green, a headless run of the mute-gate logic, and
    confirming the built `dist` contains the markup, CSS, and aria-pressed wiring. The skip path
    is plain control flow with no Tone/canvas state, so unit coverage is representative.

- **2026-05-30 - Left/right-hand distinction SHIPPED (#36).** Falling notes now carry which hand plays them and draw a hand cue. Pieces:
  - **Hand derivation.** Pure helper `handFromStaffIndex(index, staffCount): Hand` in `src/piano.ts` (`Hand = "left" | "right" | "unknown"`): `staffCount < 2` or `index < 0` -> `"unknown"`; else index 0 = `"right"` (treble), 1+ = `"left"` (bass). `extractScore` (`src/score.ts`) reads `note.ParentStaff.ParentInstrument.Staves.indexOf(staff)` and `.length` to tag each pushed note, all behind optional-chaining so a malformed score degrades to `"unknown"` instead of throwing. Gotcha: do NOT derive hand from `VoiceEntry.ParentVoice.VoiceId` (a single staff can hold multiple voices); staff index is the right axis. Use `instrument.Staves.indexOf(staff)` (relative), not `staff.idInMusicSheet` (a global counter across instruments, only equal to the staff index for a single-instrument piano).
  - **Type.** `VisNote.hand?: Hand` is optional, so `transcribe.ts` (audio path) and existing tests/callers compile untouched; a missing hand reads as `"unknown"`.
  - **Visual (Designer spec in design.md).** A neutral hand accent stripe on one edge of the bar, body keeps its full pitch-class hue. In `drawFallingNotes` (`src/visualizer.ts`), after the body `fill()` and before the contact stroke: stripe width `max(3, min(6, w * 0.16))`, inset 1px, `shadowBlur = 0`, plain `fillRect`. Left hand = dark rail `rgba(10, 7, 18, 0.85)` on the LEFT edge; right hand = light rail `rgba(255, 255, 255, 0.92)` on the RIGHT edge (dark-vs-light is a colorblind-safe luminance cue on top of the side cue). Guarded by `note.hand === "left" || "right"`, so `"unknown"` (single-staff + audio) draws nothing and renders exactly as before. The stripe block runs before the off-range `continue`, so #33 off-window bars keep a dimmed stripe at their 0.35 alpha.
  - **No score.test.ts** still (OSMD iterator is not jsdom-mockable); the regression test lives on the pure `handFromStaffIndex` (4 cases in `piano.test.ts`, suite 108). Canvas paint intentionally untested. Verified in preview with an injected grand-staff MusicXML.

- **2026-05-30 - Top toolbar redesign SHIPPED (#34).** Pure markup/CSS pass, no JS or test change (per the Designer spec in design.md). The bar was a flat row where every control shouted equally. Fixes:
  - **Design tokens (`:root`).** Added a brand ramp (`--accent-deep #7a2fd6`, `--accent-gradient`), toolbar surfaces (`--bar-surface`, `--bar-border`), ghost-control bg/border tiers, muted text tiers (`--text-muted`, `--text-faint`), and one shared `--focus-ring #d9a6ff`. Everything downstream points at these so a re-theme is a one-block edit.
  - **Grouped controls (`index.html`).** `.controls` children are wrapped in three `.group` divs (source loaders / output / settings). A hairline divider is drawn as `.group + .group::before` (a flex child of the *second* group) so it wraps with its group and never orphans at a line start. `#track-name` / `#sound-status` stay outside the groups and `#track-name { margin-left: auto }` pushes status to the right.
  - **Two-tier button hierarchy (`src/style.css`).** Replaced the single shared button rule with PRIMARY (`.file-btn, #play-btn`: filled `--accent-gradient`, Play is the hero with extra padding + resting glow) and GHOST (`#export-btn, .toggle, .step-btn`: transparent fill + subtle border, brightens on hover). One unified `:focus-visible` ring via `--focus-ring` across all controls; slider track gradients and focus rings also moved onto the tokens.
  - Verified in preview at 961px (3 groups, gradient Play, ghost Export, violet wordmark) and 375px (h1 hidden, 44px tap targets, bar wraps); no console errors.

- **2026-05-30 - Responsive / mobile SHIPPED (#33).** Made the whole app usable on phones, per the Designer spec in design.md. Pieces:
  - **Responsive keybed + key window (`src/visualizer.ts`).** `KEYBOARD_HEIGHT` is no longer a module constant; `resize()` computes an instance `keyboardHeight = clamp(96, width*0.18, 140)` and every former `KEYBOARD_HEIGHT` read uses the field. On narrow widths the visualizer shows a centered sub-window of the 88 keys (full at >=760px, C2..C7 / 36..96 at 480..759, C2..C6 / 36..84 below 480) so keys stay tappable-wide. Gotcha fixed: the old code indexed keys by array position `this.keys[midi - 21]`, which only works for the full 21-start range. Replaced with a `keyByMidi: Map<number, KeyGeometry>` rebuilt in `resize()`, so a sub-range Just Works. Notes outside the visible window clamp to the nearest edge column and draw at `globalAlpha 0.35` (dimmed "off-screen note" hint, no contact glow or label) rather than vanishing. Key-face labels are suppressed below a 110px keyboard floor (`KEY_LABEL_MIN_HEIGHT`) since glyphs crowd on a phone; falling-bar names still render.
  - **`buildKeyLayout(width, firstMidi?, lastMidi?)` (`src/piano.ts`)** gained optional range args defaulting to `FIRST_MIDI..LAST_MIDI`, so all existing callers and tests are unchanged; one new unit test covers a C2..C7 window tiling the full width.
  - **CSS (`src/style.css`)** added a 900px tablet tightening block and expanded the 720px phone block: hide `<h1>` / `.track-name` / `.sound-status`, wrap `.transport`, give every control `min-height: 44px` (`.step-btn` also `min-width: 44px`), grow both slider thumbs to 24px (recentred via `margin-top: -(thumb-track)/2`, seek `-9.5px` / tempo `-10px`, with `10px 0` input padding), and shrink `#sheet` to 34% (30% below 380px) with `overflow-x: auto`. Both sliders get `touch-action: none` so a touch drag moves the thumb instead of scrolling.
  - **`#rotate-hint`** is a CSS-only transient pill (`index.html` + `style.css`): shown only at `max-width: 540px and (orientation: portrait)`, `pointer-events: none`, fades out over 4s, and the orientation media query hides it in landscape. No JS needed (the canvas already relays out on the `resize` that an orientation change fires). Added `viewport-fit=cover` to the viewport meta so the pill respects the safe-area inset.
  - Verified in preview at 375px (narrowed legible keyboard, wrapped touch toolbar, chrome hidden, hint shown) and 961px (full 88 keys, toolbar unchanged); no console errors.

- **2026-05-30 - Contact glow on key hit SHIPPED (#27).** `src/visualizer.ts` only (no test change; pure canvas paint covered by existing color tests). When a sounding bar's leading edge reaches the keybed (`isActive && bottom >= keyboardTop - 10`), it strokes a 2px border in the note's own `colors.glow` (shadowBlur 22, globalAlpha 0.9) so the bar visibly "lights up" on the hit, distinct from the steady active fill. Cheap: the branch fires only for the small set of bars that are both sounding and touching, so the common falling bar pays nothing. Companion tweaks from the Designer spec (design.md): the falling-note name label moved from the bar BOTTOM to near the TOP (`y: top + 14`) so it never covers the contact point, with a raised fit gate (`barHeight >= 22`, was 18) and lighter glyphs (`600 11px`, `rgba(255,255,255,0.82)`); active body glow dialed 26->20 and `drawLandingBloom` softened (height 22->16, alpha 0.55->0.4) so the new contact stroke reads as the brightest cue at the keybed. Verified in preview: the lowest bar touching the keybed shows a bright hued border and the matching key illuminates in the same hue.

- **2026-05-30 - Audio-to-score hardened (#26): input size + duration caps, narrowed accept list.** `src/transcribe.ts` now rejects uploads over `MAX_AUDIO_BYTES` (30 MB) before reading them into memory, and over `MAX_AUDIO_SECONDS` (5 min) after decode but before allocating the resampled buffer / running TFJS inference. Both checks are pure functions (`validateAudioFileSize`, `validateAudioDuration`) returning a user-facing message or null, so they unit-test without a File or AudioContext; they `throw new Error(msg)` which surfaces through main.ts's existing transcription catch (`alert`). The `#audio-input` `accept` was narrowed from `audio/*,.mp3,.wav,.ogg,.flac` to `audio/mpeg,audio/wav,audio/x-wav,.mp3,.wav` to match the advertised MP3/WAV scope (ogg/flac `decodeAudioData` support is browser-dependent and already failed gracefully). The two remaining #26 notes (chunked `frames.push` only matters if the cap is lifted; tfjs pinned at 3.21.0 via basic-pitch) need no action now.

- **2026-05-30 - Code review of #29 (transport): APPROVED, no blockers.** Reviewed seek/tempo interaction, backward-jump cursor rebuild, keyboard focus guard, control lifecycle, and stepping off-by-one. All correct. Non-blocking notes for a future pass: (1) seeking WHILE playing sets `transport.seconds` but does not re-pause, so the clock keeps running and the rAF loop's `updateSeekUI` immediately overwrites the seeked slider value (a live scrub-while-playing nudges then resumes from the new spot, which is acceptable; if a "scrub pauses playback" feel is wanted, pause in the slider `input` handler like `stepNote` does). (2) `onsets` is a subset of `stepTimes` (rests are pushed to `stepTimes` in `extractScore` but excluded from notes), and `resyncCursor` walks `stepTimes`, so a note onset always lands the cursor exactly on its step; consistent by construction. (3) `formatClock` only shows m:ss, so a score > 59:59 rolls minutes past 60 with no h:mm:ss (fine for piano-length pieces). None block merge.

- **2026-05-30 - Playback transport SHIPPED (#29): seek/scrub bar + prev/next-note step + keyboard shortcuts.** Pure helpers in `src/playback.ts` (16 unit tests), DOM/Tone wiring in `main.ts`, layout per the Designer spec in design.md. Key choices and gotchas:
  - **Seek slider is a fixed `0..1000` per-mille range, never seconds.** `max` stays constant across loads; map with `seekToScoreTime(value, duration)` / `scoreTimeToSeek(time, duration)`. Avoids resetting `max` per score and keeps native step granularity smooth.
  - **Seeking inverts the tempo relation.** Score time `= transport.seconds * tempoRate`, so a seek sets `transport.seconds = scoreTime / tempoRate` (guarded `tempoRate > 0`). One `seekScoreTime()` is the single entry point for the slider, the step buttons, and the arrow keys; it sets the transport clock, resyncs the cursor, updates the seek UI, and renders once so a paused seek repaints immediately.
  - **Backward jumps need a cursor rebuild.** OSMD's cursor only moves forward (`.next()`), so `resyncCursor()` does `cursor.reset()` then advances from the start to the target step. The old forward-only `syncCursor()` still handles normal playback.
  - **Stepping uses note onsets, not cursor steps.** `uniqueOnsets(score.notes)` (sorted, de-duped) works for both sheet scores and audio-transcribed scores (which have an empty `stepTimes`). `nextOnset`/`prevOnset` use a 1e-3 epsilon so sitting exactly on an onset advances to the neighbor. Stepping pauses playback first (note-by-note walking is a paused action).
  - **Slider feedback loop guard.** A `userSeeking` flag (set on slider `input`, cleared on `change`) stops the rAF loop from writing the slider value back mid-drag. The rAF loop only drives the slider/readout while `playing`.
  - **Keyboard shortcuts are global** (`window` keydown): Space = play/pause, Left/Right = prev/next note. Handler bails when a form control (`INPUT`/`TEXTAREA`/`SELECT`/contentEditable) is focused, so arrows still adjust the focused seek/tempo slider natively; Space is `preventDefault`ed so a focused button is not also clicked.
  - **Verification caveat (same as #15): real-time playback advancement is only observable with a genuine user gesture.** In the headless preview, programmatic `.click()` and synthetic `KeyboardEvent`s do NOT grant user activation, so `AudioContext.resume()` leaves the context suspended and `transport.seconds` stays frozen (canvas does not animate, seek bar does not move). Driving the Play button via a CDP click (`preview_click`) DID resume the context and the seek bar + time readout + sheet cursor + falling notes all advanced in lockstep. Seek/step logic is fully verifiable headless because it sets `transport.seconds` directly without needing the clock to run.

- **2026-05-30 - Video export SHIPPED (#15) via client-side MediaRecorder (route 1). Decisions + a verification caveat.**
  An "Export video" button records the performance and downloads it; no service, no API, no OAuth (route 2,
  the YouTube Data API, was rejected for its quota + OAuth + token-backend needs, which break the
  free/uncapped/static-host posture). `src/recorder.ts` holds the pure, unit-tested helpers
  (`chooseVideoFormat` over a preference list, `buildExportFilename` slug + timestamp); the browser
  orchestration is `exportVideo()` in `main.ts`.
  - **Decisions:** real-time capture (MediaRecorder is realtime-only; offline faster-than-realtime is not
    possible with it). 30 fps. Container preference WebM `vp9,opus` -> `vp8,opus` -> `webm` -> `mp4`
    fallback (royalty-free, YouTube-friendly). **Records the `#stage` canvas only** (falling notes +
    keyboard); the sheet is a separate SVG and is NOT in the canvas, so the video is the Synthesia-style
    performance area only. No intro/title card (kept simple).
  - **Audio tee:** `Tone.getDestination().connect(streamDest)` where `streamDest =
    rawContext.createMediaStreamDestination()`; combine its audio track with `canvas.captureStream(30)`
    video tracks into one MediaStream for the recorder. `Tone.getContext().rawContext` is cast to
    `AudioContext` (the Tone type is `BaseAudioContext`, which lacks `createMediaStreamDestination`).
  - **Why it does not stop early:** `await Tone.start()` runs first (the Export button click is a real user
    gesture, so the context resumes), then the transport starts and a 100 ms poll waits until the rAF loop's
    end-of-score `rewind()` stops the transport. Recording then stops and the blob downloads.
  - **VERIFICATION CAVEAT (important for future canvas-recording work):** the headless Chromium behind the
    preview tool does NOT encode canvas frames for MediaRecorder, so a `captureStream` + `MediaRecorder`
    recording yields only a ~110-byte header (1 chunk, 0 frames) there, even though the video track exists.
    This is an environment limit, not a bug: format selection, track creation, the audio-tee `connect` (no
    throw), recorder lifecycle, blob+download, and filename were all verified, and the 8 unit tests pass, but
    the actual encoded video bytes can only be validated in a real (non-headless) browser. Do not trust an
    empty-blob result from the preview as a regression.

- **2026-05-30 - Audio-to-score SHIPPED (#19), falling-notes-only slice. Two gotchas worth remembering.**
  Implemented per the spike below. `src/transcribe.ts` owns the model glue: `transcribeAudioFile(file,
  onProgress)` decodes via `AudioContext.decodeAudioData`, resamples to mono 22050 Hz with an
  `OfflineAudioContext`, runs `BasicPitch.evaluateModel`, and maps results through the pure, unit-tested
  `noteEventsToVisNotes` (rounds MIDI, drops out-of-88-key / non-positive-duration notes, sorts by time).
  `loadScoreXml` was split into a shared `loadNotes(ScoreData, name, sheet)` core; the audio path calls it
  with `stepTimes: []` and `sheet=false`.
  - **Gotcha 1 (bundle size):** importing `@spotify/basic-pitch` statically pulls all of TensorFlow.js into
    the main chunk (~3.3 MB / 677 KB gzip on the initial load). Fixed by **lazy `await import("./transcribe")`**
    inside `loadAudioFile`, so tfjs is a separate ~1.8 MB chunk fetched only when a user actually transcribes.
    Keep any future heavy ML deps behind a dynamic import for the same reason.
  - **Gotcha 2 (OSMD cursor is undefined until a sheet loads):** `osmd.cursor` does not exist on a fresh page
    (no MusicXML loaded yet). The audio path must use `osmd.cursor?.hide()` and gate cursor work behind a
    `hasSheet` flag; `rewind()` only resets/shows the cursor when `hasSheet`. Verified end to end: a synthetic
    C-D-E-F-G WAV transcribes to exactly 5 ascending falling notes that play back, no console errors.
  - **Model hosting:** the ~1 MB weights are streamed from jsDelivr
    (`cdn.jsdelivr.net/npm/@spotify/basic-pitch@1.0.1/model/model.json`), same "CDN not repo binaries" pattern
    as the Salamander samples. TFJS resolves the weight shard relative to that URL.

- **2026-05-30 - Audio-to-score runs CLIENT-SIDE with Spotify basic-pitch (TF.js), not on a server (SPIKE #19).**
  Decision: transcribe uploaded audio (MP3/WAV) to note events fully in the browser with
  **`@spotify/basic-pitch`** (the `basic-pitch-ts` port), then build `VisNote[]` directly for a
  falling-notes-only first slice. No sheet view in slice 1. This mirrors the OMR spike's "heavy ML
  can't run in a Pages Function" finding, but here the model is small enough to run on-device, so
  we do NOT need the GitHub Actions detour: transcription happens entirely client-side, no R2, no
  dispatch, no Function.
  - **Model + license:** `@spotify/basic-pitch` is a TensorFlow.js port of Spotify's Basic Pitch,
    **Apache-2.0** (free/permissive, satisfies the hard constraint). The TF.js model is tiny:
    `group1-shard1of1.bin` ~742 KB + `model.json` ~175 KB, so well under 1 MB of weights. Runs in
    the browser via tfjs (WebGL/WASM/CPU backends); no native binaries, no server compute. Polyphonic
    by design (includes onset+offset detectors), so it also covers monophonic piano.
  - **API + output shape (confirmed from source):** `new BasicPitch(model)` then
    `await basicPitch.evaluateModel(audioBuffer, frameCb, percentCb)` accumulates frames/onsets/contours;
    then `noteFramesToTime(addPitchBendsToNoteEvents(contours, outputToNotesPoly(frames, onsets, onsetThresh,
    frameThresh)))` yields `NoteEventTime[] = { pitchMidi, startTimeSeconds, durationSeconds, amplitude }`.
    Input audio may be any sample rate; basic-pitch **resamples to 22050 Hz** internally. The library even
    has a `noteEventsToMidi`-style mapping that already emits `{ midi: pitchMidi, time: startTimeSeconds,
    duration: durationSeconds, velocity: amplitude }`, which is almost exactly our `VisNote`.
  - **Output -> pipeline (the key call): build `VisNote[]` DIRECTLY, bypass OSMD/MusicXML for slice 1.**
    `NoteEventTime` maps 1:1 onto `VisNote`: `{ midi: pitchMidi, time: startTimeSeconds, duration:
    durationSeconds }`. That feeds `visualizer.setNotes` + the `Tone.Part` build (the audio/falling-notes
    path in `loadScoreXml`) with zero notation work. **Cost: no synced sheet view** for audio uploads,
    because the sheet cursor needs OSMD-rendered MusicXML (`stepTimes` comes from the OSMD iterator in
    `src/score.ts`). To get the sheet back later (slice 2) we would quantize note events to a beat grid
    and emit MusicXML (tempo/key/time-sig estimation, note spelling, voice assignment), which is a large
    second effort and inherently lossy. Recommendation: ship falling-notes-only first, treat sheet view
    as a follow-up ticket. The sync invariant is NOT at risk in slice 1: with no cursor, falling notes
    are driven by the same `VisNote.time` values the Part is scheduled from, one timestamp source.
  - **Refactor needed:** `loadScoreXml` currently couples OSMD render + `extractScore` + Part build +
    `setNotes`. Split out a `loadNotes(notes: VisNote[], { name, duration })` that does the Part rebuild +
    `visualizer.setNotes` + transport reset, with NO cursor/sheet steps. The MusicXML path keeps calling
    the OSMD branch; the audio path calls `loadNotes` directly. `score.duration` for the frame-loop rewind
    is `max(time + duration)` over the notes (same formula as `extractScore`).
  - **Decode path:** use the Web Audio API `AudioContext.decodeAudioData` (handles MP3/WAV natively in
    browsers) to get an `AudioBuffer`, take channel 0 (mono) at 22050 Hz (resample via an
    `OfflineAudioContext` or let basic-pitch resample). All standard browser APIs, no extra deps beyond
    `@spotify/basic-pitch` + `@tensorflow/tfjs`.
  - **Riskiest unknowns:** (1) **transcription quality** is the single biggest risk: basic-pitch on a clean
    solo-piano recording is decent but produces spurious/missed notes, octave errors, and ragged on/off
    times; "demo-grade" is realistic, "accurate" is not, and quality degrades hard on dense/poly or noisy
    audio. (2) **tempo/timing**: events are in absolute seconds (good for our seconds-based Part), but there
    is no beat grid, so notes won't look quantized; fine for falling-notes, fatal for clean sheet output.
    (3) **bundle/runtime weight**: tfjs adds a few hundred KB of JS and a WebGL warmup; the model itself is
    sub-1 MB. (4) basic-pitch's npm package pins a tfjs major; verify it coexists with our Vite build.
  - **Verdict: FEASIBLE FIRST SLICE in one ticket** for a demo-grade monophonic/clean-piano MP3/WAV upload
    that plays as falling notes (no sheet), entirely within free tooling. Biggest risk = transcription
    accuracy, so scope the ticket as "demo-grade, clean solo piano" and set expectations accordingly. Sheet
    view from audio is a separate, larger NEEDS-MORE effort (quantize -> MusicXML).

- **2026-05-30 - Sheet note-name labels (issue #17): HTML overlay inside the scrolled `#sheet`, positions read from OSMD SVG bboxes.**
  Labels are an absolutely-positioned `<div id="sheet-labels">` (one `.sheet-label` span per
  notehead) appended INSIDE `#sheet` (now `position: relative` in `src/style.css`), with
  `pointer-events: none` and `z-index: 1`. Because the overlay lives in the same scrolled
  content box as the OSMD SVG, it translates natively on scroll: no scroll handler needed.
  Only re-render and resize move noteheads, so only those recompute positions.
  - **Reading notehead geometry from OSMD (reusable):** after `osmd.render()`, walk
    `osmd.GraphicSheet.MeasureList` (indexed `[staffLineIndex][measureIndex]`, guard undefined
    cells) -> `measure.staffEntries` -> `staffEntry.graphicalVoiceEntries` ->
    `voiceEntry.notes` (`GraphicalNote[]`). Skip rests via `note.sourceNote.isRest()`; MIDI is
    `sourceNote.halfTone + 12`. The rendered `<g>` comes from `getSVGGElement()`, which is a
    VexFlow-subclass method NOT on the public `GraphicalNote` type, so feature-detect it via a
    narrow structural cast (`note as unknown as { getSVGGElement?(): SVGGElement | null }`) and
    skip gracefully when null. Take its `getBoundingClientRect()` (viewport coords) and convert
    into the `#sheet` content box: `x = rect.left - containerRect.left + scrollLeft + rect.width/2`
    (notehead center-x), `y = rect.top - containerRect.top + scrollTop` (notehead top). This is
    the right coordinate space for the absolutely-positioned overlay even when scrolled.
  - **Pure layout split out for testing:** `layoutSheetLabels(notes: NotePosition[], mode): LabelItem[]`
    in `src/sheet-labels.ts` is DOM-free. It groups noteheads sharing an x into chords (epsilon
    0.5px), sorts each chord highest-pitch-first, and stacks labels upward: the lowest label sits
    6px above the top notehead, each higher one +11px. Off mode returns `[]`. Density rule: if two
    adjacent chords are closer in x than the wider of their two top-note labels (approx glyph width
    6px), collapse the lower-priority chord to its top note only (active/cursor chord wins, else the
    leftmost), so the melody/top line is always labeled. No octave on the sheet (uses `midiToLabel`,
    not `midiToBarLabel`). Tests in `src/sheet-labels.test.ts` (6): single note, 3-note chord
    stacked top-highest with 11px gap, off mode, letters vs solfege text, density drop keeping both
    top notes, active-chord priority. The OSMD walking + `getBoundingClientRect` glue lives in
    `src/sheet-overlay.ts` (`renderSheetLabels`) and is browser-only (not unit-tested).
  - **Wiring (`src/main.ts`):** `renderSheetLabels(osmd, sheetContainer, labelMode)` is called
    after `osmd.render()` in `loadScoreXml`, inside `applyLabelMode` (so the Names toggle and the
    startup call both rebuild it; it is a safe no-op before any score renders because
    `osmd.GraphicSheet` is falsy), and on a 150ms-debounced `window.resize` (OSMD `autoResize`
    re-renders the SVG, moving noteheads). Reuses the existing `LabelMode` and Names toggle; no
    second control. Color/font are pure CSS (`#7a2fd6`, `system-ui 600 9px`, triple light-halo
    `text-shadow`). Falling-bar/key labels (#11) and the cursor sync are untouched.

- **2026-05-30 - Tempo slider (issue #14): one rate scales audio bpm + visual score time, sync preserved.**
  A single `tempoRate` (1.0 = 100% = score speed) drives everything. Pure mapping lives in
  `src/tempo.ts` (`tempoPercentToRate`, `clampTempoPercent`, `rateToBpm`), unit-tested in
  `src/tempo.test.ts` (9 tests): 100% -> 1.0 -> `BASE_BPM`, 50 -> 0.5, 200 -> 2.0, range
  endpoints, clamp to [25,200] (and NaN/Infinity -> default 100).
  - **Mechanism (`src/main.ts`):** capture `BASE_BPM = transport.bpm.value` once at startup
    (Tone default 120). Audio speed is driven by `transport.bpm.value = BASE_BPM * tempoRate`;
    Tone live-scales the spacing of the already-scheduled seconds-based `Tone.Part` events, so
    NO Part rebuild on a tempo change. The frame loop computes
    `scoreTime = transport.seconds * tempoRate` and passes THAT (not raw seconds) to
    `visualizer.render`, `syncCursor`, and the `>= score.duration` rewind check. Why it stays
    in sync: Tone's transport is tick-based, so `transport.seconds = ticks*60/(PPQ*bpm)`;
    multiplying by `tempoRate = bpm/BASE_BPM` yields `ticks*60/(PPQ*BASE_BPM)`, independent of
    the current bpm. Score time is therefore continuous across a live tempo change (no jump),
    and audio + falling notes + cursor scale in lockstep.
  - **Build-at-baseline subtlety:** a `Tone.Part` built from numeric (seconds) times converts
    them to ticks using the bpm AT BUILD TIME. So in `loadScoreXml` we set `transport.bpm.value
    = BASE_BPM` BEFORE constructing the Part, then reapply `rateToBpm(tempoRate, BASE_BPM)`
    right after `part.start(0)`. This makes note tick positions rate-independent and keeps sync
    correct even when the tempo was changed before any score was loaded. `rewind()` stops the
    transport and resets position but leaves bpm alone, so the chosen tempo survives a rewind.
  - **UI:** native `<input type="range" min=25 max=200 step=5>` plus a `<button id="tempo-readout">`
    that snaps back to 100% on click/Enter, styled per design.md. `applyTempo(percent)` clamps,
    updates rate + live bpm + slider + readout; wired to slider `input` and readout `click`, and
    called once at startup. Works both before and during playback (live, no rebuild).

- **2026-05-30 - Sampled piano (issue #13): Tone.Sampler with Salamander Grand, lazy-loaded, synth fallback.**
  Swapped the sound source only; no timing/scheduling change, so the sync invariant holds.
  - **Sample set + license:** Salamander Grand Piano by Alexander Holm, **CC-BY 3.0** (free to use and
    redistribute with attribution). Attribution + license noted in `src/sampler.ts` header.
  - **Hosting:** stream mp3 buffers from the official, uncapped Tone.js sample CDN, base URL
    `https://tonejs.github.io/audio/salamander/` (`SALAMANDER_BASE_URL`). No mp3s in the repo, no R2 for
    audio. Satisfies free/uncapped + no-large-binaries constraints.
  - **Sample map is pure + unit-tested:** `buildSalamanderSampleMap()` in `src/sampler.ts` returns the
    Tone.Sampler `note->filename` map at ~one sample per minor third (A/C/D#/F# per octave). 30 entries:
    `A0` only in octave 0, A/C/D#/F# in octaves 1..7, plus `C8` (the partial top octave only ships C8).
    Sharps map to the CDN's "s" filename spelling (`"D#1" -> "Ds1.mp3"`, `"F#1" -> "Fs1.mp3"`); Tone keys
    keep the `#`. Tests in `src/sampler.test.ts` (8). Tone.Sampler itself is not jsdom-testable, so only
    the pure map is covered.
  - **Lazy-load + fallback design (`src/main.ts`):** `startSamplerLoad()` runs at startup (background); it
    only fetches buffers and does not need a running AudioContext, so it never blocks initial render or
    Play. `getInstrument()` returns the sampler when `sampler.loaded` is true, else `ensureSynth()`. The
    Tone.Part callback calls `getInstrument()` **at trigger time** (not captured at Part-build time), so
    playback upgrades to the sampler the moment it finishes loading, even mid-session. On `onerror` (or a
    constructor throw) the sampler is dropped and the synth is used permanently. Sampler volume -6 dB.
  - **Loading UX:** a `#sound-status` span in the header (`.sound-status`, hidden when empty via
    `:empty`) shows "Loading piano sound..." during load, clears on `onload`, and shows
    "Using basic sound (piano samples unavailable)." on failure. Non-blocking and non-fatal.

- **2026-05-30 - Visualizer colors (issue #12): pitch-class hue wheel, purple-anchored.**
  Color math lives in `src/piano.ts` next to the label helpers and is pure/unit-testable:
  `pitchClass(midi)` (normalizes negatives), `pitchHue(midi): number` returns
  `(276 + pc * 30) mod 360` (276deg = brand `#b14bff`, so C/Do anchors violet), and
  `noteColor(midi): NoteColors` returns the hsl strings (`whiteFill` 85/62, `blackFill`
  70/50, `glow` 90/68, `activeFill` 95/72, `activeWhiteKey` 85/66, `activeBlackKey` 80/60).
  Hue depends only on pitch class, so octaves share a hue and a key with multiple sounding
  notes is well-defined. Tests in `src/visualizer-color.test.ts`.
  - **Performance: a precomputed 12-entry `PITCH_CLASS_COLORS` table is built once at module
    load** (one `buildNoteColors` per pc); `noteColor` is a table lookup, so no hsl strings
    are built and no `measureText` runs inside the rAF loop. `noteColor(60) === noteColor(72)`
    (same cached object). Per-bar cost stays one `fillStyle` + one `shadowColor` + one
    `shadowBlur` + one `fill` (same as before #12). The background and resting landing-strip
    gradients are reused per frame/resize, never per note.
  - **Where colors land in `src/visualizer.ts`:** falling bars use white/black fill + glow
    shadowColor per note, active bars bump to `activeFill` + shadowBlur 26 (else 18); active
    white/black key faces use `activeWhiteKey`/`activeBlackKey`; resting strip dimmed to
    `rgba(177,75,255,0.18)`; a new `drawLandingBloom` draws a 22px-tall rounded bloom in each
    sounding note's glow hue (globalAlpha 0.55, shadowBlur 16) above the key, drawn before the
    keybed/keys, at most "notes sounding" draws per frame. Background: `bgGradient` (cached in
    `resize()`, `#0a0712` -> `#120b1f`) is `fillRect`-ed over the whole canvas each frame in
    place of `clearRect` (the fill both clears and paints). Removed the `ACCENT` constant.
    Label discipline from #11 is unchanged: `shadowBlur` reset to 0 before text, dark text
    shadow only, all-or-nothing key-label floor, active bar always labeled.

- **2026-05-30 - OMR code shape (issue #5): Pages Functions + R2 binding + browser poll, pure logic in `src/`.**
  Endpoints (Pages Functions, `functions/api/`): `POST /api/omr` (`functions/api/omr.ts`, `onRequestPost`)
  accepts multipart `file` (raw-body fallback), validates MIME in {png, jpeg, pdf} and size <= 12 MB,
  writes raw bytes to R2 `uploads/<jobId>` (jobId = `crypto.randomUUID()`), fires `repository_dispatch`
  to `simpasgh/piano-helper` (event_type `omr-job`, client_payload `{ jobId, ext }`, ext in
  png|jpg|jpeg|pdf), returns 202 `{ jobId }`. On dispatch failure it best-effort deletes the upload and
  returns 502; bad type/size returns 400 `{ error }`. `GET /api/omr/result?jobId=`
  (`functions/api/omr/result.ts`, `onRequestGet`) returns 200 + MusicXML
  (`application/vnd.recordare.musicxml+xml`) when `results/<jobId>.musicxml` exists, 422 `{ error }` from
  `results/<jobId>.error`, else 404 `{ status: "pending" }`. R2 binding name is `OMR_BUCKET` (set in
  `wrangler.jsonc` at repo root; wrangler-only file, vite ignores it). Token secret `GITHUB_DISPATCH_TOKEN`.
  - **Pure logic in `src/` so tests run without Cloudflare runtime:** `src/omr-server.ts` holds
    MIME->ext, `validateUpload`, `buildDispatchRequest`, and the R2 key helpers; the Functions import it
    and stay thin. `src/omr.ts` is the DOM-free browser client: `submitOmr(file, fetchFn=fetch)` and
    `pollOmrResult(jobId, { fetchFn, intervalMs, timeoutMs, sleep, now })` with injected sleep/now/fetch
    so `src/omr.test.ts` runs instantly with fakes. Tests live in `src/` (Vitest default glob only picked
    up the three `src/*.test.ts`).
  - **`functions/` typechecking is isolated from the app build.** Root `tsconfig.json` has
    `include: ["src"]`, so `tsc` (the `build` step) never compiles `functions/` and the Workers types
    never leak into the DOM-typed app build. A separate `functions/tsconfig.json` (types
    `@cloudflare/workers-types`, lib ES2022 only, no DOM) typechecks the Functions on demand via
    `npx tsc -p functions/tsconfig.json`. Each Function file also has a `/// <reference types="@cloudflare/workers-types" />`.
    Gotcha: this `@cloudflare/workers-types` version narrows `FormData.get()` to `string | null` (no File),
    so an `instanceof File` check fails to typecheck. Fix: cast the entry to `unknown` and feature-detect a
    `arrayBuffer` method (`isFilePart`) in `functions/api/omr.ts`. The Workers runtime does return a File for
    file fields, so this is type-only, not behavioral.
  - **`loadScoreXml` refactor in `src/main.ts`:** extracted `loadScoreXml(xml, name)` containing
    everything from `osmd.load` through the OSMD render, `extractScore`, Tone.Part rebuild,
    `visualizer.setNotes`, trackName, and playBtn enable. `loadScoreFile` now just reads `file.text()` then
    calls it; the OMR path calls the same function with the scan result. Scan UI: a second `.file-btn` file
    input (`#scan-input`), handler disables both inputs + play button while `submitOmr`/`pollOmrResult`
    runs, shows status in the track-name span, restores on success/error; the rAF loop is never blocked.
    `vite dev` does not run Pages Functions, so the live POST path needs `wrangler pages dev` to exercise;
    the contract is covered by unit tests + the functions typecheck.

- **2026-05-30 - OMR compute moved off GitHub Actions to an always-on R2-polling worker (issue #5).**
  This SUPERSEDES the earlier GitHub-Actions OMR runner (`.github/workflows/omr.yml`, now deleted) and
  the `repository_dispatch` trigger. Using GitHub Actions as the app's runtime compute backend violates
  GitHub's Actions usage policy (it is for CI/CD on the repo, not as a free job server) and risks account
  suspension, regardless of the public-repo "unlimited minutes" fact the earlier spike leaned on. New
  backend: a self-contained always-on Python worker (`omr-worker/worker.py`, boto3) that polls Cloudflare
  R2 for new uploads. It is host-agnostic (an Oracle Always Free ARM VM was the plan; it currently runs on
  the owner's Mac via launchd, see infrastructure.md); a systemd unit (`omr-worker/omr-worker.service`,
  `Restart=always`) is shipped for the Linux path. The R2 transport contract is UNCHANGED: input
  `uploads/<jobId>`, output `results/<jobId>.musicxml`, with a failure-sentinel MusicXML
  (`<miscellaneous-field name="omr-status">failed</miscellaneous-field>`) the client detects via
  `isFailureSentinel` / `FAILURE_SENTINEL_RE` in `src/omr.ts` (kept byte-compatible with the worker).
  The browser contract is also unchanged (POST returns 202 `{jobId}`, then poll `/api/omr/result`).
  **Trigger change:** there is no longer any push notification. The Pages Function `POST /api/omr`
  (`functions/api/omr.ts`) now ONLY validates + writes the upload to R2 and returns 202; all
  `repository_dispatch` / GitHub-PAT code was removed and the 503 gate is now `!env.OMR_BUCKET` only.
  `GET /api/omr/result` (`functions/api/omr/result.ts`) only reads `results/<jobId>.musicxml` (200) or
  reports pending (404); the old `.error`/422 path is gone because failure is carried in-XML by the
  sentinel. The worker discovers jobs by listing R2 `uploads/*` (env `OMR_POLL_SECONDS`), so no PAT, no
  webhook, no inbound port. Worker loop per job: validate jobId is a UUID (path-safety, before any S3
  key/filesystem use); skip if `results/<jobId>.musicxml` already exists (idempotent); download;
  rasterize PDFs first page with poppler `pdftoppm -r 300`; run oemer, fall back to homr; on both
  failing, write the sentinel; upload the result, THEN delete `uploads/<jobId>` (delete-after-write so a
  crash mid-job just retries). Per-job and per-cycle exceptions are caught so one bad upload never kills
  the loop. **Code organization (kept from main's structure):** the pure server helpers live in
  `src/omr-server.ts` (so the root `tsc` typechecks them and Vitest runs `src/omr-server.test.ts`); the
  Function code is typechecked in CI by `functions/tsconfig.json` (`npx tsc -p functions/tsconfig.json`),
  and the `OMR_BUCKET` R2 binding is declared in-code via `wrangler.jsonc` (`pages_build_output_dir:
  "dist"`), so no manual dashboard binding step is needed. `omr-worker/` is outside the JS test/build
  entirely (Python; verify with `python3 -m py_compile`). The `GITHUB_DISPATCH_TOKEN` Pages secret and
  `GITHUB_REPOSITORY` var are now unused and should be removed from the Pages project; the four R2 S3
  creds moved from Actions secrets to worker-host env vars. See `omr-worker/README.md` for the runbook.
  The earlier "OMR runs in GitHub Actions" and "OMR trigger via repository_dispatch" entries below are
  SUPERSEDED by this one.

- **2026-05-30 - Note-name labels (issue #11): piano.ts produces strings, visualizer is presentation-only.**
  Two helpers sit next to `midiToName` in `src/piano.ts`: `midiToLabel(midi, mode)` returns the
  pitch-class token only (no octave) for both key faces and solfege, and `midiToBarLabel(midi, mode)`
  appends the octave only in letters mode (so it equals `midiToName` there) and stays octave-free in
  solfege. `type LabelMode = "solfege" | "letters" | "off"`. Both return `""` for off mode. Solfege is
  fixed-Do, always-sharp, "Si" not "Ti". Toggle state lives in `main.ts` (localStorage key
  `pianoHelper.noteNames`, default "solfege"), flows one-way to the visualizer via
  `visualizer.setLabelMode(mode)`; the visualizer holds a `labelMode` field and never reads storage.
  Key-face labels render on the 52 white keys only (black faces too narrow). Legibility floor is
  all-or-nothing: if the widest label for the mode plus a 4px gutter exceeds the white-key width at
  11px, the whole row is skipped (uniform beats a ragged row), never shrink below 11px. Bar labels
  render when drawn width >= 16 and height >= 18, except the active key's bar is always labeled.
  `initLabelMode` and the toggle wrap `localStorage` in try/catch: storage access throws in Safari
  Private Browsing and sandboxed iframes, and it runs at module load before the rAF loop registers,
  so an unguarded throw would abort app startup, not just the labels feature.
  - **shadowBlur gotcha:** the falling-note glow uses `ctx.shadowBlur = 18`. Canvas `fillText`
    inherits the live shadow, so glyphs would smear if drawn under that. Fix: collect bar-label
    geometry during the fill pass, then after all fills set `shadowBlur = 0`, draw text with a small
    `shadowBlur = 2` (rgba(0,0,0,0.45) for legibility over the purple), and reset to 0 again.
    `drawKeyLabels` also sets `shadowBlur = 0` defensively before drawing. See `src/visualizer.ts`
    `drawFallingNotes` / `drawKeyLabels`.

- **2026-05-30 - OMR code-review fixes (issue #5).** Three review-driven changes on top of the initial app code. (1) Failure-sentinel detection: when both engines fail, the runner writes a valid-but-empty `score-partwise` carrying `<miscellaneous-field name="omr-status">failed</miscellaneous-field>` so the browser stops polling; without detection the client would have silently rendered a blank "0 notes" score as success. `src/omr.ts` now exports `isFailureSentinel(xml)` (regex `/name="omr-status"\s*>\s*failed/`, kept in sync with `.github/workflows/omr.yml`) and `pollOmrResult` throws a friendly "Could not recognize any notes" error when it sees the sentinel. (2) Poll timeout raised from ~5 min (120 x 2500 ms) to ~15 min (300 x 3000 ms): a cold oemer run (model download + inference + possible homr install) realistically exceeds 5 min, which would have shown "timed out" on a job that still succeeds. (3) `validateUpload` now normalizes the Content-Type via `normalizeMime` (strip `;` params, lowercase) before the allowlist check, so a legit upload tagged `image/png; charset=binary` is not wrongly 415'd. Also added `console.error` on the sheet-import failure path in `main.ts` for parity with the file-load path. Security review (token handling, R2 path traversal via jobId, workflow shell injection from client_payload, XXE) found nothing: jobId is UUID-validated server-side and re-validated in the workflow against `[A-Za-z0-9_-]` via a job-level env var, `filename`/`contentType` never reach a shell, and the PAT is never echoed.

- **2026-05-30 - OMR pipeline app code implemented (issue #5).** Two Pages Functions plus a client module, matching the frozen R2/dispatch contract. Endpoints: `POST /api/omr` (`functions/api/omr.ts`) reads raw file bytes with `?filename=`, validates MIME (pdf/png/jpeg) and size (<=10 MB) via shared helpers, `OMR_BUCKET.put('uploads/<jobId>', ...)`, fires `repository_dispatch` (event_type `omr-job`, client_payload `{ jobId, contentType, filename }`) to `api.github.com/repos/<repo>/dispatches`, returns 202 `{ jobId }`; 415/413 on bad input, 503 `{ error: "OMR is not configured" }` if `OMR_BUCKET` or `GITHUB_DISPATCH_TOKEN` missing (so prod never 500s pre-wiring), 502 if dispatch fails, 500 on unexpected. `GET /api/omr/result?jobId=` (`functions/api/omr/result.ts`) 400s on non-uuid, reads `results/<jobId>.musicxml`, 404 `{ status: "pending" }` while absent, else 200 with `Content-Type: application/vnd.recordare.musicxml+xml`. Pure helpers live in `functions/api/_omr.ts` (no Cloudflare types, unit-tested): `ALLOWED_MIME`, `MAX_UPLOAD_BYTES`, `validateUpload`, `uploadKey`, `resultKey`, `isUuid`. Env the Functions read: R2 binding `OMR_BUCKET`, secret `GITHUB_DISPATCH_TOKEN`, var `GITHUB_REPOSITORY` (fallback `simpasgh/piano-helper`). Client `src/omr.ts`: `validateSheetFile`, `requestOmr`, `pollOmrResult`, `convertSheetToMusicXml`; fetch/interval/maxAttempts/sleep are injectable for tests (defaults 2500 ms, ~120 attempts). `src/main.ts` refactor: extracted `loadMusicXml(xml, label)` from `loadScoreFile` (the .xml/.musicxml path now calls it), and `#sheet-input` drives upload -> poll -> `loadMusicXml`, updating `#omr-status`. Gotcha: `tsc` only includes `src/`, so `functions/` is not typechecked by `npm run typecheck`; keep it valid TS by hand. Vitest (no config) globs `**/*.test.ts`, so `functions/api/_omr.test.ts` runs alongside src tests.

- **2026-05-30 - OMR trigger: browser upload -> Cloudflare Pages Function proxy -> GitHub `repository_dispatch` -> runner, with R2 as the file transport both ways.** Only a tiny authenticated hop needs a GitHub token, so it lives server-side in a Pages Function (same Pages project, under `functions/api/`, no separate Worker), never in static assets. End-to-end shape: (1) browser POSTs the image/PDF to the Function (`/api/omr`), which holds a GitHub fine-grained PAT (this repo, Actions read/write) as an encrypted secret and has an R2 binding; (2) the Function validates type+size, makes a jobId, writes the upload to R2 (`uploads/<jobId>`), then fires `repository_dispatch` (event_type `omr-job`, client_payload `{ jobId }`), a tiny payload well under the ~10 KB client_payload limit; (3) the Actions workflow (unlimited minutes on a public repo) pulls the image from R2 via an R2 S3 API token (Actions secret), runs oemer (homr fallback), emits MusicXML; (4) the runner writes MusicXML to R2 (`results/<jobId>.musicxml`); (5) the browser polls the Function (`/api/omr/result?jobId=`), which reads R2 and returns 200 + MusicXML when ready or 404 while pending, so R2 stays server-side; (6) the MusicXML feeds the existing extractScore -> visualizer. Why this mechanism: Pages Functions run on the Workers free tier (100k requests/day shared with Workers, 10ms CPU/invocation), which a thin dispatch + R2-put proxy never strains because OMR runs on the runner, not the Function; R2's free tier (10 GB-month, 1M Class A + 10M Class B ops/month) carries both transfer directions and sidesteps both the ~10 KB payload ceiling and the auth-required, zipped Actions-artifact download path. Rejected alternatives: inline base64 image in the dispatch payload (the ~10 KB client_payload limit is far smaller than a real scan); return MusicXML as an Actions artifact (download needs auth even on public repos per actions/upload-artifact#144 and arrives as a zip, forcing extra proxy + unzip); return by committing MusicXML to the repo and reading raw.githubusercontent (works and needs no token, but pollutes git history, needs cleanup, and races on concurrent writes, so kept only as a fallback); embedding a GitHub token in the static frontend for client-side dispatch (leaks a privileged token in public assets, non-starter); an Issues/PR-based trigger carrying the image (still needs a token-holding backend for anonymous users and pollutes Issues); a standalone backend/queue service (a maintained or paid server, which defeats the free static + job-based-Actions design). Abuse/safety (note only, do not build yet): cap upload size and validate MIME at the Function, add a free Cloudflare WAF per-IP rate-limit rule, optionally gate upload with free unlimited Cloudflare Turnstile, and use an Actions concurrency group to coalesce queued runs; public-repo Actions minutes are unlimited so the risk is noise and attention, not cost.

- **2026-05-30 - OMR runs in GitHub Actions, not in-browser or in a serverless function (SPIKE #4).**
  Decision: an asynchronous, job-based pipeline. User uploads a PDF/PNG of sheet music; that
  triggers a GitHub Actions workflow that runs the open-source engine **oemer** (homr is the
  fallback engine) headless on the runner; the job outputs **MusicXML**, which is served back as
  a build/job artifact and fed unchanged into the existing `extractScore` -> visualizer pipeline.
  Real-time, in-request OMR is not feasible on any free tier, so we go offline/async on purpose.
  - **Why GitHub Actions:** the repo is public, so Actions minutes are **unlimited and free**
    (matches the hard constraint). Runners are full Linux VMs with enough CPU/RAM/disk to run
    oemer's PyTorch/onnx pipeline and its multi-hundred-MB models; both oemer and homr already
    ship a headless CLI/Docker path and emit MusicXML directly. Inference is minutes-scale, which
    is fine for an async job but fatal for a request handler.
  - **Rejected - client-side WASM OMR:** no reusable open-source browser OMR engine exists today.
    QuickStave proves it is possible but is proprietary and trained its own TS model; via CheerpJ,
    Audiveris took ~170s and oemer ~100-340s in-browser. Nothing free to adopt, and the runtime
    cost lands on the user's device.
  - **Rejected - Cloudflare Pages Functions / Workers (or similar free serverless):** free tier is
    10ms CPU per request, 3 MB compressed bundle, 128 MB memory. oemer/homr need heavy ML runtimes,
    hundreds of MB of models, and minutes of compute. Categorically impossible, and pushing usage
    up would breach the uncapped rule.
  - **Rejected - klang.io managed API:** free tier is a 20-second demo only, then a ticket-based
    paid subscription. Paid and capped, so it violates the free/uncapped project rule outright.
  - **Integration shape:** input PDF/PNG -> OMR job on a GitHub Actions runner (oemer; homr fallback)
    -> MusicXML artifact -> existing `src/score.ts` `extractScore` -> visualizer. No change to the
    sync invariant: OMR only produces the MusicXML that the current pipeline already consumes.
    Local dev machine can run the same oemer CLI for fast iteration. (Engine wiring + the
    upload/trigger UX are implementation work, not part of this spike.)

- **2026-05-30 - Input is MusicXML, not MIDI.** MIDI carries no real notation (no
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
