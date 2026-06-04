# Design context

UX, visual design, interaction decisions. Append durable learnings at the top of the
relevant section, dated.

## Smart Edit Mode P3 DURATION COMPLETION: DOTTED durations + CROSS-BARLINE ties (interaction + visual spec)

- **2026-06-04 - Completes the duration editor specced below. The shipped v1 walks a PLAIN
  ladder (16th..whole) with the `#dur-shorter-btn`/`#dur-longer-btn` steppers + comma/period,
  fixed-bar: SHORTEN leaves a rest, LENGTHEN ripples + absorbs trailing rest + CLAMPS at the
  barline. v1 deliberately deferred two things this entry now specs: (A) DOTTED values and (B)
  cross-barline durations via TIES. Tech Lead builds DOTTED first, TIES second. The substrate is
  ready for both: the model already parses + serializes dots and `noteValueName(type, dots)`
  already speaks "dotted quarter"/"double dotted half" (`edit-model.ts`); `ChangeDurationRecord`
  snapshots the WHOLE bar's children for undo, so a dot or a tie edit inverts with the same
  machinery a plain step does; and `mergeTiedNotes` in `score.ts` ALREADY folds a tie chain into
  ONE sustained VisNote (one onset, summed duration) for the normal playback path, so a
  cross-barline tie plays as one held note for free if we emit the `<tie>`/`<tied>`. This entry is
  interaction + visual only; Tech Lead owns the model mutation, the ripple, and the tie-pairing.**

  ### DECISION DOT-1 (AFFORDANCE) - a dedicated DOT TOGGLE, not an interleaved dotted ladder.

  RECOMMENDATION: keep the shorter/longer steppers walking PLAIN rungs exactly as they do now, and
  add ONE toggle button that sets the selected note's value to dotted (x1.5) or back to plain, the
  MuseScore "." idiom. New button in the `#note-edit` cluster:
  - `#dur-dot-btn`, class `edit-tool-btn` (ghost style, same as the steppers), aria-label "Dotted
    note", title "Dot this note (semicolon). Adds half its value again: quarter to dotted quarter."
    Glyph: a filled notehead followed by a single augmentation dot (a small circle + a dot to its
    right), or simplest, a bold centered dot `.` echoing the MuseScore control. It is a TOGGLE
    (`aria-pressed`): pressed/lit when the selected note currently carries a dot, unpressed when
    plain. Placement in the cluster: pitch-down | pitch-up | shorter | longer | **DOT** | delete,
    i.e. the dot sits with the duration controls (after `#dur-longer-btn`) and before delete, so
    the cluster reads pitch | duration (shorter, longer, dot) | delete. The dot is a MODIFIER on
    the current value, so it belongs adjacent to the steppers it modifies.

    Why a toggle over interleaving dotted rungs into the shorter/longer ladder: (1) it keeps the
    stepper's one-sentence mental model intact ("each press halves or doubles") and the dot a
    SEPARATE, orthogonal axis ("this value, but dotted"), which is exactly how musicians think
    about a dot, instead of making "longer" ambiguous (does quarter step to dotted-quarter or to
    half?); (2) it is the directly-learnable MuseScore gesture (a single dot key/button that
    toggles), so it imports muscle memory for free; (3) it adds ONE button to a cluster that
    already carries six controls, where interleaving would DOUBLE the ladder length and make every
    stepper press land on a dotted value half the time, which most OMR corrections do not want; (4)
    toggle state (lit/unlit) is a clean readout of "am I dotted right now", which an interleaved
    ladder cannot show. The cluster is now seven controls on desktop; on phone it wraps within the
    docked toolbar, acceptable since these are 44px tap targets and the toolbar already scrolls
    (#33/#84). If width ever bites, the dot is the one most safely collapsed behind an overflow.

  ### DECISION DOT-2 (KEYBOARD) - SEMICOLON toggles the dot, on both surfaces.

  Comma/period (shorter/longer) are spent; arrows, Enter, Delete, +/-, Ctrl+Z are spent. CHOSEN:
  **semicolon `;` toggles the dot** whenever a NOTE is selected in edit mode, on BOTH the staff and
  the canvas (parity with comma/period). Rationale: (1) `;` sits immediately to the RIGHT of `,`
  and `.` on a QWERTY row, so the three duration keys cluster physically (`, . ;` = shorter,
  longer, dot), a learnable spatial group; (2) it is an unmodified single key, matching the
  lightweight feel of comma/period/Enter/Delete; (3) it does not collide with anything bound today
  and is free on the canvas. Rejected: the literal `.` key (already taken by "longer"); `d` for
  "dot" (single letters are reserved for the future note-input value-arming idiom, the same reason
  the number row is held back, and `n` is already an ADD alias, so burning `d` now risks a clash);
  Shift+period (reads as a modified "longer", confusing). On a REST selection `;` is a no-op
  (rests are not duration-editable in v1), `preventDefault` so it never types into the page.
  Document `;` in BOTH surface aria-labels (DOT-5).

  ### DECISION DOT-3 (MAX DOTS) - ONE dot only in v1 (single dot). Double-dot deferred.

  RECOMMENDATION: **single dot only.** The toggle is binary: plain <-> dotted (x1.5). Pressing the
  dot on an already-dotted note REMOVES the dot (back to plain), it does NOT add a second dot.
  Reasons: (1) single dots cover essentially all real piano OMR corrections (a dotted quarter, a
  dotted half); double-dotted values are rare and almost never what a scan-correction needs; (2) a
  binary toggle is the simplest possible affordance and announce ("dotted" / "not dotted"), where a
  three-state cycle (plain -> dotted -> double-dotted -> plain) muddies both the button's
  `aria-pressed` semantics and the spoken state; (3) the bar-math for x1.5 is already the
  interesting case (an odd, non-power-of-two span); x1.75 adds a second fractional case for little
  user value. The model ALREADY renders an arriving double-dotted note (`noteValueName` speaks
  "double dotted half", `noteTypeForDuration` infers two dots), so a scanned double-dot still
  DISPLAYS correctly; v1 simply never lets the user PRODUCE one, and the dot toggle on a
  double-dotted arrival snaps it to single-dotted-or-plain like any odd arrival snaps to the
  ladder (DOT-4). Double-dot is the obvious v2 of this control (cycle, or Shift+`;`) once single
  dots are proven.

  ### DECISION DOT-4 (BAR SEMANTICS) - dot ON reuses LENGTHEN (x1.5); dot OFF reuses SHORTEN. No new reflow.

  Confirmed: the dot is a duration change, so it routes through the SAME fixed-bar machinery the
  steppers use, no new reflow path.
  - **Adding a dot LENGTHENS the note to x1.5 of its current plain value** (quarter 4 divs ->
    dotted quarter 6 divs; the added half-value = 2 divs). It reuses the lengthen engine exactly:
    ripple the following same-voice events later, absorb trailing REST room, and (ties OFF) CLAMP
    at the barline. If the half-value does not fit before the barline and ties are off, the add is
    a no-op (the button does nothing, announce "No room to dot in this bar"); it must NEVER
    overflow the bar or silently cross a barline. (When ties land, DOT-B changes this: an
    overflowing dot AUTO-TIES the remainder into the next bar instead of clamping/no-op.) The note
    the dot is applied to must be on a PLAIN rung first: a non-plain arrival (already dotted, or an
    odd OMR span) SNAPS to its nearest plain rung as the dot is applied, announced, exactly the
    snap the steppers already do (`nearestLadderIndex`).
  - **Removing a dot SHORTENS the note back to its plain value** (dotted quarter 6 divs -> quarter
    4 divs) and reuses the shorten engine: the freed third becomes a REST appended after the note,
    following onsets unchanged. Always has room (it only frees time), so removing a dot never
    no-ops for lack of space.
  - **The lengthen-clamp's dotted output is unchanged and SEPARATE from this toggle.** Today a
    lengthen that clamps at the barline can already emit a dotted value to fill the bar exactly
    (the documented v1 exception); that stays. The new dot toggle is the user's EXPLICIT way to ask
    for a dotted value; the clamp's dotted fill is an implicit byproduct of filling the bar. Both
    set `<dot>` via the same `setNoteDuration(..., {keepDots})` path; they do not conflict.
  - **State after the edit:** the note is selected, its value now reads dotted (or plain), and the
    toggle's `aria-pressed` reflects the new state. The transient pulse (DECISION P3-4) fires on a
    dot edit too (the notehead gains/loses an augmentation dot in place, a shape change the flash
    draws the eye to), skipped under reduced motion.

  ### DECISION DOT-5 (READOUT + ANNOUNCE + DISABLED) - "dotted quarter" everywhere; toggle reflects state; disabled only when x1.5 cannot fit and ties are off.

  - **Readout:** `#note-edit-readout` already names the value via `durationValueName` (which calls
    `noteValueName(type, dots)`), so a dotted note ALREADY reads "D5, dotted quarter" with no new
    code, the moment the model carries the dot. Nothing to add; confirm it surfaces after a dot
    edit (it re-renders on every commit).
  - **Toggle visual state:** `#dur-dot-btn` carries `aria-pressed="true"` + a lit look (brass fill,
    reuse the `.edit-tool-btn-primary` fill tokens OR a lighter `[aria-pressed=true]` variant: a
    filled brass background `var(--accent)` at ~0.5 alpha with the brass-deep border) when the
    selected note is dotted, `aria-pressed="false"` + the ghost look when plain. This is set on
    every selection change + every duration edit, so the button always mirrors the current note.
  - **Announcements (`#edit-live`, polite, value-named, current Names mode):**
    - Add a dot: **"D5 quarter to dotted quarter"** (the from->to form, matching the steppers'
      "D5 quarter to half").
    - Remove a dot: **"D5 dotted quarter to quarter"**.
    - A non-plain arrival snapped as the dot is applied: fold into one, **"Dotted quarter to dotted
      half"** style is wrong here; instead announce the snap then the result, e.g. **"Double dotted
      half to dotted half"** (snap a double-dot arrival to a single dot), reusing the steppers'
      dotted-snap phrasing (`dottedSnap` already in the record).
    - No room to add the dot (ties off): **"No room to dot in this bar"** (mirrors "No room to
      lengthen in this bar").
    - Undo of a dot edit: **"Undid dot on the quarter"** / **"Undid removing the dot"**, or simpler
      and consistent with the steppers' undo, reuse the value form: **"Undid lengthen to dotted
      quarter"** / **"Undid shorten to quarter"**. Prefer the latter (one undo phrasing for all
      duration edits).
  - **Disabled state:** `#dur-dot-btn` is disabled (`disabled` + `aria-disabled="true"`, the dim
    ghost) ONLY when the selected note is currently PLAIN and there is NO room to add the x1.5
    half-value before the barline AND ties are off, i.e. the dot literally cannot be applied. (When
    ties are on per DOT-B, the dot is never disabled for room, since it can tie across.) On an
    already-dotted note the toggle is always ENABLED (removing a dot always has room). When the
    selected object is a rest the whole `#note-edit` cluster is hidden anyway, so the dot never
    shows for a rest. When no note is selected the cluster is hidden.

  ### DECISION TIE-A (TRIGGER) - LENGTHEN (and add-dot) that exceeds the bar AUTO-TIES across the barline. No separate tie control.

  RECOMMENDATION: **the existing lengthen/dot gesture auto-creates the tie**; there is no separate
  "add a tie" affordance in v1. When a lengthen step (or a dot's x1.5) wants more room than the bar
  has left AND there is room in the FOLLOWING bar, the note fills the current bar to the barline
  and a TIED CONTINUATION note of the remainder is created starting the next bar, joined by
  `<tie>`/`<tied>`. This is the simplest predictable model for a "simplified MuseScore": the user
  keeps pressing "longer" (or dots the note) and the value keeps growing past the barline the
  natural way, the editor handles the notation plumbing. It CHANGES the shipped v1 "clamp at the
  barline" rule precisely: clamp becomes **"tie across the barline when there is downstream room,
  else clamp at the very end of available room."** Concretely the lengthen/dot resolution is now:
  1. Grow within the current bar by absorbing trailing rest room (unchanged).
  2. If the target value still exceeds the current bar AND the next bar has room, fill the current
     bar to its barline and create a tied continuation of the remainder in the next bar (the new
     behavior).
  3. If there is no next bar (last bar of the part) or the next bar is already full in this voice,
     CLAMP exactly as today (fill to the barline, no-op if already full), announce the clamp.

  Why auto-tie over a separate explicit tie button: (1) it keeps ONE verb ("make this note
  longer") doing the whole job, so the user never learns a second gesture or reasons about when a
  tie is "needed"; the editor does what a musician means by "I want this note to last longer than
  the bar"; (2) it preserves the stepper's existing flow (the same comma/period/dot the user
  already knows) and only removes the wall they used to hit; (3) a separate tie tool would need its
  own selection model (tie WHICH two notes?), which is heavier than the correction this serves. The
  honest limitation (TIE-B) keeps it predictable.

  ### DECISION TIE-B (SCOPE) - v1 ties span at most ONE barline (note + one tied continuation). Multi-bar deferred.

  RECOMMENDATION, stated plainly: **v1 crosses at most ONE barline.** A lengthen/dot can produce a
  note that fills its bar + ONE tied continuation note starting the next bar. It does NOT span two
  or more barlines (no chain of three+ tied notes). If a single step's target would need to cross a
  SECOND barline (the remainder is itself longer than the next bar), the continuation is CLAMPED to
  fill the next bar to ITS barline and no third segment is created, announced as a clamp. The cap:
  **one note + one tied continuation, one barline crossing.** Reasons: (1) one crossing covers the
  overwhelmingly common case (a half note that starts on beat 3 of 4/4 and rings into the next bar);
  (2) it keeps the tie-pairing logic a single pair, not an arbitrary chain, so undo/redo and the
  VisNote merge stay a two-element relationship; (3) it bounds the reflow to exactly two adjacent
  bars, never a cascade down the piece. Multi-bar ties (a note held across several bars, the chain)
  are the explicit v2 follow-up; flag to PM for the help copy.

  ### DECISION TIE-C (PLAYBACK + FALLING-NOTES, CRITICAL for Tech Lead) - a tie group renders as TWO notes joined, but PLAYS and FALLS as ONE held note. Do not double-attack.

  This is the load-bearing correctness point. A cross-barline tie MUST:
  - **On the STAFF (Verovio):** render as TWO `<note>` elements joined by a tie curve, the first
    carrying `<tie type="start"/>` + `<notations><tied type="start"/></notations>`, the
    continuation carrying `<tie type="stop"/>` + `<tied type="stop"/>`, the continuation having the
    SAME pitch and NO new accidental. This is correct notation: the reader sees one sustained note
    notated across the barline.
  - **In PLAYBACK and the FALLING CANVAS:** the tie group is ONE held note, a SINGLE attack
    sustained across the barline, summed duration, NOT two separate hits. The implication the Tech
    Lead must honor: the VisNote derivation must MERGE the tie group into one held VisNote (one
    onset = the start note's onset, duration = start + continuation summed), while the MusicXML
    keeps the two `<note>`s joined by `<tie>`/`<tied>`. The GOOD NEWS: this merge ALREADY EXISTS,
    `mergeTiedNotes` in `score.ts` folds a tie chain into one sustained VisNote for the normal
    playback path (issue #123), and the edit model already flags `isTieContinuation` on a
    `<tie type="stop">`-only note so it claims no VisNote of its own. So emitting a well-formed tie
    in the MusicXML makes it play + fall as one held note FOR FREE through the existing re-derive;
    the Tech Lead's job is to EMIT the tie correctly (start/stop, tied notations, shared pitch), not
    to build new playback. State this explicitly so nobody re-implements a second attack: the
    continuation note must NOT generate its own onset/keypress; it is absorbed into the start note's
    held duration. Verify after build that a tied note triggers ONE attack (the easy regression is
    two hits at the barline).

  ### DECISION TIE-D (REVERSING) - shortening the note removes the continuation + the tie. One mental model.

  Confirmed mental model: **a tie is the tail of a too-long note, not a separate object the user
  manages.** So to remove a tie, the user SHORTENS the note (comma, or remove a dot): shortening a
  tied note first reclaims the continuation (delete the continuation `<note>` in the next bar +
  strip the `<tie>`/`<tied>` from the now-standalone note, leaving a rest of the freed time in the
  next bar so that bar stays full), then continues shortening within the original bar as normal.
  The user never deletes a tie directly; they make the note shorter and the tie evaporates when the
  value no longer needs to cross the barline. This matches the auto-tie trigger (TIE-A): a tie
  EXISTS only because the value exceeds the bar, so reducing the value below the bar's room removes
  it. Undo of a tie-creating lengthen restores BOTH bars exactly (the `ChangeDurationRecord` must
  now snapshot both the current and the next measure's children, since a tie edit mutates two bars,
  see the Tech Lead note below). After undo the note returns selected at its prior (untied) value.

  ### DECISION TIE-E (READOUT + ANNOUNCE + ACCESSIBILITY) - "tied across the bar"; aria/help additions, no em dashes.

  - **Readout:** a tied note's `#note-edit-readout` names its SOUNDING value (the summed value) plus
    that it is tied, e.g. **"D5, half tied across the bar"** (a half note's worth of sound, notated
    as quarter-tied-to-quarter across the barline). If the summed value is not a single clean note
    name (e.g. a quarter tied to an eighth = a dotted-quarter's worth), read the dotted name:
    "D5, dotted quarter tied across the bar". The "tied across the bar" suffix tells the user the
    note crosses the barline even though the staff shows two noteheads.
  - **Announcements (`#edit-live`, polite):**
    - A lengthen/dot that creates a tie: **"D5 lengthened across the bar to half"** (it grew past
      the barline; names the resulting sounding value). Distinct from the in-bar clamp's "D5
      lengthened to fill the bar" so the user hears that it crossed rather than stopped.
    - A lengthen/dot that wanted to cross but had no downstream room (clamped at the last barline):
      reuse **"D5 lengthened to fill the bar"** (it filled what it could; no tie made).
    - Shortening that removes a tie: **"D5 half to quarter, tie removed"** (the from->to value plus
      that the continuation went away), or simpler **"D5 shortened, tie removed"**.
    - Undo of a tie-creating edit: **"Undid lengthen to half"** (the steppers' undo form; the tie's
      removal is implied by returning to the shorter value).
  - **Surface aria/help additions (no em dashes):** extend the staff help/aria string (currently at
    `main.ts` ~line 676) so the lengthen clause states the cross-bar behavior. Replace the comma/
    period clause "comma makes a note shorter and period makes it longer" with: **"comma makes a
    note shorter and period makes it longer, crossing into the next bar with a tie when it must;
    semicolon dots the note"**. The canvas string (~line 588) likewise: replace "comma and period
    change its length" with **"comma and period change its length, tying across the next bar when
    needed; semicolon dots it"**. (Apply the `;` clause when DOTTED ships even before TIES, and add
    the tie clause when TIES ship; until ties ship the lengthen clause keeps the v1 "stops at the
    barline" reading.) Keep both strings free of em dashes.

  ### DECISION TIE-F (LIMITATION, stated plainly for PM + help copy)

  - **v1 ties span AT MOST ONE barline.** A note can be held across one barline (note + one tied
    continuation). A note that would need to span two or more bars is CLAMPED at the second barline
    in v1 (it fills the current bar + the whole next bar and stops). Holding a note across several
    bars (a multi-bar tie chain) is DEFERRED to a later version.
  - **The tie is created and removed by lengthening / shortening the note**, never by a direct tie
    tool. There is no way in v1 to tie two ARBITRARY existing notes together (that is a different,
    composition-style gesture); v1 ties are strictly "this note is longer than its bar". Deferred:
    a free tie tool, slurs (a tie joins same-pitch notes; a slur is a phrase mark over different
    pitches and is out of scope), and tying into a bar whose target slot is occupied by a note
    rather than rest room (v1 only ties into available room in the next bar; if the next bar's
    downbeat is already a note in this voice, the lengthen clamps instead of overwriting, never
    destroying data, consistent with the shipped no-overwrite rule).

  ### TECH LEAD NOTES (carried from the substrate read, 2026-06-04)

  - **Dots need no new model surface.** `noteValueName(type, dots)`, `noteTypeForDuration` (infers
    dots), `durationValueName`, and `setNoteDuration(..., {keepDots})` already exist; the dot toggle
    is a `changeDuration`-style edit that targets the x1.5 value and writes one `<dot>`. The readout
    speaks dots already.
  - **Ties widen the undo snapshot from one bar to two.** `ChangeDurationRecord` today snapshots a
    SINGLE `measureEl`'s children; a tie edit mutates the current bar AND the next bar (adds the
    continuation, leaves a rest on shorten). The record must snapshot BOTH measures' children (or
    generalize to "the affected measures") so `restoreDuration` inverts both. Everything else
    (clear + re-append cloned children, re-index) is unchanged.
  - **The playback merge is already built.** `mergeTiedNotes` (`score.ts`) + the model's
    `isTieContinuation` flag mean a correctly-emitted `<tie>`/`<tied>` plays + falls as one held
    note with no new code. Do NOT add a second attack path; emit the tie and let the re-derive fold
    it. Verify one attack at the barline as the key regression.
  - **Decisions to confirm with the main agent / product owner:** (1) DOT = a toggle button +
    semicolon, SINGLE dot only in v1 (double-dot deferred). (2) Lengthen/dot AUTO-TIES across one
    barline when it overflows and there is downstream room, else clamps; no separate tie tool; v1
    crosses at most one barline. (3) Shortening removes the tie (no direct tie deletion). (4) The
    continuation must merge into one held VisNote (one attack) via the existing `mergeTiedNotes`.
## Smart Edit Mode COMMIT v1: explicit Save / Discard when leaving edit mode (toolbar UX + a11y spec)

- **2026-06-04 - Today edits apply LIVE to the player but exiting edit mode drops the in-memory
  edit model without writing back to the retained source MusicXML, so re-entering edit silently
  rebuilds from the ORIGINAL and prior edits vanish. We are adding explicit Save (commit the edit
  model back to the retained source) and Discard (revert to that source) controls. I RATIFIED the
  proposed UX with two refinements: (a) a glyph and color choice that keeps Save from colliding
  with the existing filled-brass "Add a note" primary, and (b) Discard stays ENABLED only when
  dirty (NOT always-on), because the Edit toggle is already the always-available way out. This
  entry is the toolbar UX + a11y; the Tech Lead owns the dirty-flag plumbing, the write-back to
  the retained source, and the confirm-on-exit wiring. The substrate is the docked `#edit-toolbar`
  (index.html ~334), the `.edit-tool-btn` / `.edit-tool-btn-primary` idioms + the dimmed-disabled
  rule (src/style.css ~1429), and the shared polite announcer `#edit-live` (which sits OUTSIDE the
  toolbar, so it still announces AFTER the toolbar hides on exit, the load-bearing reason Save/
  Discard announcements survive the toggle-off).**

  ### Decision COMMIT-1 (PLACEMENT) - a TRAILING commit group, so the strip reads history | selection | commit.

  RATIFIED. Add Save + Discard as a new TRAILING `.edit-tool-group` placed AFTER the per-selection
  clusters, so the docked strip reads left to right: **history (undo/redo) | selection (pitch/dur/
  delete OR add) | commit (save/discard)**. This is the right reading order: undo/redo is the
  fine-grained "step back one edit" that lives at the leading fixed spot; the per-selection cluster
  is the middle working area that swaps on what is selected; Save/Discard is the coarse "I am done,
  keep or throw away EVERYTHING" that belongs at the trailing edge, the natural "exit" end of a
  left-to-right toolbar (the same place a dialog puts OK/Cancel). It also never moves: unlike the
  middle cluster (which shows/hides with selection), the commit group is ALWAYS present in edit
  mode, so its position is a stable muscle-memory target.

  - **Markup:** a sibling group after `#add-note`, e.g.
    `<div class="edit-tool-group edit-commit-group"> <save> <discard> </div>`. Save FIRST, Discard
    second (keep > throw away reads in that priority order, and Save is the affirmative default eye
    lands on). Both are ALWAYS in the DOM in edit mode (the group is not `hidden`); only their
    enabled state changes (COMMIT-2). Give the group its own class `edit-commit-group` so the
    trailing divider can target it WITHOUT depending on the selection clusters being present (see
    the divider gotcha below).
  - **DIVIDER (important gotcha):** the existing divider rule is
    `.edit-tool-group + .note-edit:not([hidden])`, which only fires when a `.note-edit` cluster
    directly follows the leading group. The trailing commit group needs its OWN divider rule, and
    it must NOT rely on adjacency to the selection clusters, because those clusters are `hidden`
    when nothing is selected (so a sibling-adjacency selector would collapse and the divider would
    vanish exactly when the strip is at its emptiest). Add a standalone rule keyed on the new class:
    ```css
    .edit-commit-group {
      border-left: 1px solid rgba(107, 79, 31, 0.3);
      padding-left: 0.5rem;
      margin-left: 0.25rem;
    }
    ```
    This matches the existing divider treatment (same brass-brown 0.3-alpha hairline, same 0.5rem
    pad + 0.25rem margin) and renders the leading divider of the commit group whether or not a
    selection cluster sits between it and history.

  ### Decision COMMIT-2 (IDS + ROLES + GLYPHS) - Save is a CHECKMARK (NOT filled brass), Discard is a back-arrow. Refined to dodge the Add-a-note primary collision.

  IDS (ratified the proposal): `#edit-save-btn`, `#edit-discard-btn`. Both keep the icon-only,
  18px stroke SVG, `aria-hidden`/`focusable="false"` glyph convention the rest of the strip uses
  (meaning lives in `title` + `aria-label`); do NOT add visible text labels, that would break the
  uniform 32px-square (44px on phone) grid and is unnecessary once the tooltips/labels carry the
  words. The one thing icon-only costs is glyph legibility, so the glyphs below are chosen to be
  unambiguous at 18px.

  - **COLOR refinement (the real decision):** the proposal made Save a filled `.edit-tool-btn-primary`.
    REJECTED as-is, because the rest cluster's "Add a note" is ALSO a filled-brass
    `.edit-tool-btn-primary`, so when a rest is selected the strip would show TWO filled-brass
    buttons (`[Add a note]` | `[Save]`) separated only by the thin divider, reading as two
    competing primaries with no clear hierarchy. There is only ever one "main action" the eye
    should land on, and in a correction tool that is the contextual selection action (add/delete/
    pitch), not the housekeeping commit. SO: **Save and Discard are BOTH ghost `.edit-tool-btn`**
    (the brass-brown-on-cream ghost), distinguished from each other and from the rest of the strip
    by GLYPH, not by fill. This keeps "filled brass = the single contextual primary" as a clean,
    learnable rule (it currently means "Add a note", and would mean any future single dominant
    action), and avoids the two-primaries clash. Save still reads as affirmative via its checkmark
    glyph + leftmost-of-the-pair position; it does not need a fill to be found. (If usage ever shows
    users miss Save, the lighter-weight fix is a subtle brass-brown text-underline-on-hover or a
    1px-heavier border on Save, NOT promoting it to the filled primary that collides with Add.)
  - **`#edit-save-btn`** - GLYPH: a **checkmark** (it reads as "commit / confirm / done" far more
    universally than a floppy disk, which is dated and at 18px is a fiddly little square; a check is
    instantly legible at this size and matches the affirmative meaning). Path (Heroicons-style check,
    on the same 24x24 viewBox, `fill="none" stroke="currentColor" stroke-width="1.8"
    stroke-linecap="round" stroke-linejoin="round"` to match the existing stroke glyphs):
    `<path d="M5 13l4 4L19 7" />`. title = `"Save your edits (keep the changes)"`; aria-label =
    `"Save edits"`.
  - **`#edit-discard-btn`** - GLYPH: a **curved revert / back-arrow** (an undo-style arrow), NOT a
    trash can and NOT a bare X. Why: a trash can already means the per-note Delete on the strip
    (`#delete-note-btn` is the canonical trash glyph), so reusing it for Discard would be a genuine
    icon collision a user could misread as "delete the selected note"; a bare X reads as "close /
    dismiss this toolbar" (a chrome action) rather than "revert my edits to the original". A curved
    revert arrow says "go back to how it was", which is exactly the semantics (Discard = revert to
    the retained source). It is visually distinct from the straight undo/redo history arrows
    (`#undo-btn`/`#redo-btn` use angular hook arrows) by being a rounded U-turn arrow, so it does not
    read as "undo one step". Path (a counter-clockwise revert arrow on the 24x24 viewBox, same stroke
    attrs): `<path d="M4 9a8 8 0 1 1-1.5 6" /><path d="M4 4v5h5" />` (an arc that loops back with a
    small arrowhead notch at the top-left). The Tech Lead may swap in any equivalent single-stroke
    "curved arrow returning to start" path; the load-bearing requirement is rounded-U-turn revert,
    visibly different from both the trash glyph and the straight history arrows. title =
    `"Discard your edits (go back to the original)"`; aria-label = `"Discard edits"`.

  ### Decision COMMIT-3 (DIRTY-ENABLE) - Save AND Discard are enabled ONLY when dirty; both dim-disabled when clean. (Chose this over always-on Discard, justified.)

  RATIFIED the proposal over the alternative. **"Dirty" = at least one edit command has been applied
  since entering edit mode (or since the last successful Save).** When dirty, BOTH Save and Discard
  are enabled. When clean, BOTH are dim-disabled using the EXACT existing idiom (`disabled` +
  `aria-disabled="true"`, which the `.edit-tool-btn:disabled, .edit-tool-btn[aria-disabled="true"]`
  rule renders at `opacity:.35; cursor:default`), the same way undo/redo dim when there is no
  history. A `reflectCommitButtons(isDirty)` helper mirrors the existing `reflectUndoRedoButtons`
  shape (set both attributes together); in fact dirty and "undo stack non-empty" move together for
  this v1 (an edit both makes the model dirty AND pushes an undo entry; a full Discard/Save resets
  both), so the same signal can drive all four buttons.

  - **Why NOT keep Discard always-enabled as an always-available "exit editing":** the Edit toggle
    `#edit-btn` in the header is ALREADY the always-available, always-present way to leave edit mode,
    and when there are no unsaved changes it exits silently (COMMIT-4). So an always-on Discard would
    be a SECOND exit affordance that is a no-op when clean, which is redundant and slightly
    misleading (a lit "Discard" button when there is nothing to discard invites the question "discard
    what?"). Tying Discard's enabled state to dirty keeps a tight, honest rule that matches undo/redo:
    **these buttons light up exactly when they have something to act on.** The "always offer a way
    out" need is genuinely met by the Edit toggle, which never disables. So when clean: leave via the
    Edit toggle (silent); when dirty: Save or Discard (or hit the Edit toggle and get the confirm,
    COMMIT-4). One way out always exists; the commit buttons stay meaningful.

  ### Decision COMMIT-4 (TOGGLE-OFF WHILE DIRTY) - native `confirm()` is ACCEPTED for v1; clean toggle-off is silent.

  RATIFIED. When the user clicks `#edit-btn` to LEAVE edit mode WITH unsaved changes, intercept and
  prompt with a native `confirm()` before exiting; when there are NO unsaved changes, toggle-off
  exits silently (no prompt). A native `confirm()` is acceptable for v1 and is the right call here:
  it is the one moment in the flow where DATA LOSS is on the line, and the native dialog is modal,
  unmissable, keyboard-accessible, screen-reader-announced, and free (zero new markup/CSS/tests, no
  focus-trap to get right), which is exactly what a "you are about to lose work" guard should be. A
  themed inline modal is a nice-to-have, NOT a v1 requirement, and it carries real cost (a focus-trap
  small modal + its own tests + reduced-motion handling); defer it. (If we DO theme it later, the
  minimal spec: a small centered card over a dimmed stage, reusing the `.scan-overlay` backdrop
  tokens, with the exact COMMIT-4 copy, a ghost "Keep editing" button and a filled-brass "Discard
  changes" button, focus moved to "Keep editing" on open and returned to `#edit-btn` on close, Esc =
  Keep editing. Not now.)

  - **Confirm copy (EXACT, em-dash-free):** message =
    **"You have unsaved edits. Discard them and leave editing?"**. The native OK button = discard the
    edits + exit edit mode; the native Cancel button = stay in edit mode (so the user can click Save).
    Phrasing note: it names WHAT is at stake ("unsaved edits") and what OK does ("discard them"), so a
    user who hits OK is not surprised; "leave editing" makes clear this is about exiting the mode. We
    cannot relabel the native OK/Cancel buttons, so the message itself must make OK = discard
    unambiguous, which this phrasing does.
  - **Note the asymmetry:** clicking Save then the Edit toggle never prompts (Save cleared the dirty
    flag, so the toggle-off is silent). The prompt ONLY guards the lose-your-work path.

  ### Decision COMMIT-5 (ANNOUNCEMENTS) - exact `#edit-live` polite strings, em-dash-free.

  All via the shared `#edit-live` polite region (it lives OUTSIDE the toolbar, so it still announces
  after the toolbar hides on exit, which is essential for the Save/Discard-then-exit paths). Exact
  strings:
  - **Save success:** **"Edits saved."** (short, affirmative, done. The retained source now holds
    the edits, so re-entering edit will rebuild from the saved version.)
  - **Discard success (via the Discard button, staying in edit mode):** **"Edits discarded. Back to
    the original."** (states the action AND the resulting state, so a non-sighted user knows the
    model reverted; mirrors the "Back to the original" framing of the Discard glyph's revert
    semantics.)
  - **Toggle-off after confirming Discard (OK on the native dialog, which both discards AND exits):**
    **"Edits discarded. Editing closed."** (distinct from the in-edit Discard because edit mode also
    ended; tells the user both halves of what happened. This fires AFTER the toolbar hides, which the
    outside-the-toolbar announcer makes reliable.)
  - **No announcement for:** a silent clean toggle-off (nothing changed, nothing to say), or hitting
    Cancel on the confirm (the user stays put; the absence of change is self-evident). Individual edit
    commands keep their existing P1/P2/P3/ADD announcements unchanged; COMMIT only adds the three save/
    discard strings above.

  ### Decision COMMIT-6 (A11Y + FOCUS) - confirm disabled attrs, define focus after Save/Discard, reduced-motion is a non-issue.

  - **Disabled attrs:** dim-disabled Save/Discard carry BOTH `disabled` AND `aria-disabled="true"`
    (the same pair `reflectUndoRedoButtons` sets), so a pointer user sees the 0.35-opacity dim and an
    AT user is told the control is unavailable. Set them together in `reflectCommitButtons`.
  - **Focus after SAVE (button path):** the user stays IN edit mode (Save commits but does not exit),
    Save and Discard become disabled (now clean), so KEEP focus on `#edit-save-btn` if it is still
    focusable; but because it just went disabled, a disabled element loses focus, so MOVE focus to the
    next sensible still-enabled control. RECOMMENDATION: move focus to `#edit-btn` (the Edit toggle in
    the header) after a button-Save, since the natural next intent after "save" is often "leave", and
    `#edit-btn` is always enabled. (Acceptable alternative: move to `#undo-btn` if it is still enabled,
    keeping focus inside the toolbar; but `#undo-btn` may also be disabled if Save cleared history in
    a future variant, whereas `#edit-btn` is unconditionally focusable, so `#edit-btn` is the safer
    target.) The "Edits saved." announcement covers the context change for AT.
  - **Focus after DISCARD (button path):** the user stays in edit mode but the model reverted and both
    commit buttons go disabled. Same rule: move focus to `#edit-btn` (always enabled). The "Edits
    discarded. Back to the original." announcement covers the context change.
  - **Focus after the TOGGLE-OFF confirm (either branch):** OK (discard + exit) returns focus to
    `#edit-btn` (it stays in the header after edit mode closes and is the element the user just
    activated, so focus naturally lives there); Cancel (stay) returns focus to `#edit-btn` as well
    (the user is still in edit mode, and `#edit-btn` was the activation point). Native `confirm()`
    already restores focus to the triggering element on its own in browsers, so in practice this is
    the default behavior and needs no extra code; just do not steal focus elsewhere after the dialog.
  - **Reduced motion:** COMMIT introduces NO animation (no flash, no transition beyond the existing
    button hover), so `prefers-reduced-motion` has no impact here. Confirmed, nothing to gate.

  ### COMMIT - tight implementation summary for the Tech Lead (all em-dash-free)
  - Trailing group `<div class="edit-tool-group edit-commit-group">` after `#add-note`, ALWAYS present
    in edit mode (not `hidden`), holding Save then Discard.
  - `#edit-save-btn` ghost `.edit-tool-btn`, checkmark glyph `<path d="M5 13l4 4L19 7" />`, title
    "Save your edits (keep the changes)", aria-label "Save edits".
  - `#edit-discard-btn` ghost `.edit-tool-btn`, curved revert arrow (rounded U-turn, distinct from
    trash + straight history arrows), title "Discard your edits (go back to the original)", aria-label
    "Discard edits".
  - Both are filled-brass-FREE (ghost), so they do not collide with the filled-brass "Add a note".
  - New CSS rule `.edit-commit-group { border-left:1px solid rgba(107,79,31,.3); padding-left:.5rem;
    margin-left:.25rem; }` for the trailing divider (do NOT rely on the existing
    `.edit-tool-group + .note-edit` adjacency rule, the selection clusters are hidden when empty).
  - `reflectCommitButtons(isDirty)` sets `disabled` + `aria-disabled` on both, mirroring
    `reflectUndoRedoButtons`; dirty = an edit applied since enter/last-Save; clean = disabled.
  - Toggle-off while dirty: native `confirm("You have unsaved edits. Discard them and leave editing?")`,
    OK = discard + exit, Cancel = stay. Clean toggle-off = silent exit.
  - Announcements via `#edit-live`: Save "Edits saved." / Discard button "Edits discarded. Back to the
    original." / confirm-OK exit "Edits discarded. Editing closed."
  - Focus to `#edit-btn` after a button Save or Discard (the just-clicked control goes disabled); the
    native confirm handles its own focus return.

  ### Decisions to confirm with the main agent / product owner
  1. **Save + Discard are BOTH ghost (not filled), distinguished by glyph.** Confirm dropping the
     proposed filled-brass Save; I changed it because a filled Save next to the filled "Add a note"
     would be two competing primaries. "Filled brass = the one contextual primary" stays a clean rule.
  2. **Discard is enabled ONLY when dirty (not always-on).** Confirm; the Edit toggle is already the
     always-available exit, so an always-lit Discard would be a redundant, slightly confusing second
     exit.
  3. **Native `confirm()` guards the dirty toggle-off for v1 (themed modal deferred).** Confirm we
     accept the OS dialog for the data-loss guard; it is modal, accessible, and free. Themed modal is
     a costed v2.
  4. **Glyphs: Save = checkmark, Discard = curved revert arrow** (not floppy/trash/X). Confirm; the
     trash + straight-arrow glyphs are already spent on Delete and undo/redo, so Discard must look
     different to avoid a misread.

## EXPORT menu: Video / PDF / MusicXML behind one disclosure pill (control pattern + DOM + a11y spec)

- **2026-06-04 - We are adding two export actions (Export PDF of the Verovio engraving, Export
  MusicXML download) alongside the existing single `#export-btn` ("Export video"). The existing
  button is a ghost pill (inline `.btn-icon` SVG + `<span class="btn-label">`) in
  `<div class="group group-output">`, `disabled` until a score loads. Video works for ANY loaded
  score; PDF + MusicXML need an engravable sheet (`sourceMusicXml` present), so for AUDIO-ONLY
  scores they must be DISABLED while Video stays enabled; the whole control is disabled with no
  score. This entry is the full implementable spec; the Tech Lead owns the actual PDF render +
  MusicXML serialization wiring.**

  ### Decision EXPORT-1 (CONTROL, RECOMMENDED) - ONE "Export" disclosure pill that opens a 3-item popup, NOT a 3-button group.

  RECOMMENDATION: replace the lone `#export-btn` with a single **Export disclosure button**
  (`#export-menu-btn`, the same ghost pill, now carrying a small caret) that opens a compact popup
  panel listing the three actions (Video, PDF, MusicXML). Reasons, in the Nocturne language and the
  narrow/phone constraint:
  - **Toolbar footprint stays at one pill.** `group-output` already sits in a row with the three
    source loaders, Names, Edit, the hand-mute group, and tempo; on phone the whole `.controls`
    bar already wraps (#84). Three full ghost pills (each icon + label) plus the `.group + .group`
    hairline would turn the output slot into a multi-line block and make it compete with the source
    loaders for the first wrap row. A disclosure keeps the exact footprint we have today (one pill).
  - **It groups three things under one honest verb.** "Export" is the user's intent; Video/PDF/
    MusicXML are formats of that one intent, so nesting them under one trigger reads more truthfully
    than three peer buttons that imply three unrelated tools.
  - **It gives PDF/MusicXML room for an honest disabled-with-reason treatment.** In a popup, a
    disabled item can carry a short "Needs a sheet, audio has none" subtext (see EXPORT-5); inline
    ghost pills have no room for that and would just dim mysteriously on audio-only scores.
  - **Picked DISCLOSURE + a group of buttons, NOT a true `role="menu"`.** These are three
    independent actions with MIXED enabled state (on audio-only, Video is live but PDF/MusicXML are
    not). A `role="menu"` implies a uniform command list with roving-tabindex arrow nav and a single
    tab stop; a disclosure that reveals a small `role="group"` of plain `<button>`s is the more
    honest pattern for "a few buttons that happen to be hidden until you ask", lets each item be a
    normal tab stop, and lets a disabled item stay focusable to announce WHY (a `role="menuitem"`
    that is disabled is awkward to make explain itself). So: `aria-expanded` disclosure trigger +
    a revealed `role="group"`, NOT `role="menu"`/`menuitem`.

  Rejected: the 3-button group (Video/PDF/MusicXML as three peer ghost pills). It is the simplest to
  build and needs no open/close, but it triples the output slot's width, wraps badly on phone, and
  has nowhere to explain the audio-only disable. Acceptable as a fallback ONLY if a popup proves too
  heavy to wire, but the disclosure is the recommended direction.

  ### Decision EXPORT-2 (DOM) - exact structure to add to index.html (replaces the current `#export-btn` block).

  The whole `<div class="group group-output"> ... </div>` becomes a relative-positioned anchor
  holding the trigger + the popup. Mirror the existing icon-SVG + `.btn-label` build of
  `#export-btn`/`#names-btn` (viewBox 0 0 24 24, stroke=currentColor, stroke-width 1.5,
  `aria-hidden`/`focusable="false"` on the SVG). IDs to wire: trigger `#export-menu-btn`, popup
  `#export-menu`, items `#export-video-btn`, `#export-pdf-btn`, `#export-musicxml-btn` (note: the
  VIDEO item is now `#export-video-btn`; the old `#export-btn` id is retired, so the Tech Lead must
  re-point the existing `exportVideo()` click handler to `#export-video-btn`).

  ```html
  <div class="group group-output">
    <div class="export-menu-wrap">
      <button
        id="export-menu-btn"
        class="toggle"
        type="button"
        aria-haspopup="true"
        aria-expanded="false"
        aria-controls="export-menu"
        title="Export this score as a video, a PDF, or a MusicXML file."
        disabled
      >
        <svg class="btn-icon" viewBox="0 0 24 24" width="18" height="18" fill="none"
          stroke="currentColor" stroke-width="1.5" stroke-linecap="round"
          stroke-linejoin="round" aria-hidden="true" focusable="false">
          <path d="M3 16.5V18.75C3 19.9926 4.00736 21 5.25 21H18.75C19.9926 21 21 19.9926 21 18.75V16.5M16.5 12L12 16.5M12 16.5L7.5 12M12 16.5V3" />
        </svg>
        <span class="btn-label">Export</span>
        <svg class="export-caret" viewBox="0 0 24 24" width="14" height="14" fill="none"
          stroke="currentColor" stroke-width="1.5" stroke-linecap="round"
          stroke-linejoin="round" aria-hidden="true" focusable="false">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      <div id="export-menu" class="export-menu" role="group"
        aria-label="Export this score" hidden>
        <button id="export-video-btn" class="export-item" type="button"
          title="Record the falling notes and audio to a video (WebM).">
          <svg class="export-item-icon" viewBox="0 0 24 24" width="18" height="18" fill="none"
            stroke="currentColor" stroke-width="1.5" stroke-linecap="round"
            stroke-linejoin="round" aria-hidden="true" focusable="false">
            <path d="M3.75 6.75A1.5 1.5 0 0 1 5.25 5.25h9A1.5 1.5 0 0 1 15.75 6.75v10.5A1.5 1.5 0 0 1 14.25 18.75h-9A1.5 1.5 0 0 1 3.75 17.25V6.75ZM15.75 9l4.5-2.25v10.5L15.75 15" />
          </svg>
          <span class="export-item-text">
            <span class="export-item-label">Video</span>
          </span>
        </button>
        <button id="export-pdf-btn" class="export-item" type="button"
          title="Download the sheet music as a PDF.">
          <svg class="export-item-icon" viewBox="0 0 24 24" width="18" height="18" fill="none"
            stroke="currentColor" stroke-width="1.5" stroke-linecap="round"
            stroke-linejoin="round" aria-hidden="true" focusable="false">
            <path d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625A1.125 1.125 0 0 0 4.5 3.375v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
          </svg>
          <span class="export-item-text">
            <span class="export-item-label">PDF</span>
            <span class="export-item-hint">Needs a sheet, audio has none</span>
          </span>
        </button>
        <button id="export-musicxml-btn" class="export-item" type="button"
          title="Download the score as a MusicXML file.">
          <svg class="export-item-icon" viewBox="0 0 24 24" width="18" height="18" fill="none"
            stroke="currentColor" stroke-width="1.5" stroke-linecap="round"
            stroke-linejoin="round" aria-hidden="true" focusable="false">
            <path d="M9 9V18M9 9L18 7.5V16.5M9 9L18 7.5M9 18A2.25 2.25 0 1 1 4.5 18 2.25 2.25 0 0 1 9 18ZM18 16.5A2.25 2.25 0 1 1 13.5 16.5 2.25 2.25 0 0 1 18 16.5ZM12.75 5.25l8.25-1.5v3l-8.25 1.5v-3Z" />
          </svg>
          <span class="export-item-text">
            <span class="export-item-label">MusicXML</span>
            <span class="export-item-hint">Needs a sheet, audio has none</span>
          </span>
        </button>
      </div>
    </div>
  </div>
  ```

  The `.export-item-hint` rows are PRESENT in the DOM always but VISIBLE only while that item is
  disabled (CSS: `.export-item:not(:disabled) .export-item-hint { display: none; }`). So a sheet
  score shows three clean one-word items; an audio-only score shows the two disabled items with
  their reason.

  ### Decision EXPORT-3 (KEYBOARD + ARIA) - disclosure semantics, plain tab stops inside, Esc + click-outside dismiss.

  - **Trigger** `#export-menu-btn`: `aria-haspopup="true"`, `aria-expanded` toggled true/false,
    `aria-controls="export-menu"`. It is the `.toggle` ghost pill, so it inherits the shared
    focus-visible ring (`--focus-ring`). Click or Enter/Space toggles the popup.
  - **Open behavior:** show `#export-menu` (drop the `hidden` attr), set `aria-expanded="true"`,
    and **move focus to the first ENABLED item** (Video on every score, since Video is always
    enabled when the trigger is). Do not focus a disabled item.
  - **Inside the popup = normal tab order, NOT a roving menu.** Tab / Shift+Tab move through
    `#export-video-btn -> #export-pdf-btn -> #export-musicxml-btn` as ordinary buttons; disabled
    items are skipped by Tab natively (they keep `aria-disabled` for SRs, see EXPORT-5). ALSO wire
    Up/Down arrows to move focus between the items as a convenience (wrap top<->bottom, skip
    disabled), since users expect arrows in a popped list, but this is additive, not a roving
    single-tab-stop. Home/End optional (first/last enabled item).
  - **Activate an item:** Enter/Space/click runs the action, then CLOSES the popup and returns
    focus to `#export-menu-btn` (so the next Tab continues from the trigger, never from a now-hidden
    item). The action itself (record video / generate PDF / download file) proceeds as today.
  - **Dismiss without choosing:** Esc closes the popup, sets `aria-expanded="false"`, and returns
    focus to `#export-menu-btn`. A pointer click OUTSIDE `.export-menu-wrap` also closes it (no
    focus move on outside-click, the user is going elsewhere). Closing on Tab OUT of the last item
    is optional polish; Esc + click-outside are the required two.
  - **`aria-label`/`title` strings (exact):**
    - Trigger: `title="Export this score as a video, a PDF, or a MusicXML file."` Label text
      "Export" + caret; no separate aria-label needed (the visible "Export" label names it).
    - Video item: `title="Record the falling notes and audio to a video (WebM)."`
    - PDF item: `title="Download the sheet music as a PDF."`
    - MusicXML item: `title="Download the score as a MusicXML file."`
    - Each item's accessible name is its visible label ("Video" / "PDF" / "MusicXML"); the hint
      span, when shown, is read after the label so a SR hears "PDF, Needs a sheet, audio has none".

  ### Decision EXPORT-4 (COPY) - tight, consistent, NO em dashes.

  | Control | Visible label | Title (tooltip) |
  | --- | --- | --- |
  | Trigger | `Export` | Export this score as a video, a PDF, or a MusicXML file. |
  | Video item | `Video` | Record the falling notes and audio to a video (WebM). |
  | PDF item | `PDF` | Download the sheet music as a PDF. |
  | MusicXML item | `MusicXML` | Download the score as a MusicXML file. |

  Disabled hint (PDF + MusicXML, shown only when disabled): `Needs a sheet, audio has none`.
  Rationale: the old single button said "Export video"; folding into a menu lets the items drop to
  one-word format names under the "Export" verb, which is tighter and scans instantly. "WebM" is
  named in the Video tooltip so the user knows the container, matching how the audio loader names
  "MP3/WAV".

  ### Decision EXPORT-5 (ENABLE/DISABLE) - the exact per-item truth table.

  Restated so the Tech Lead wires the precise logic. `hasScore` = any score loaded;
  `hasSheet` = an engravable sheet exists (`sourceMusicXml !== null`, the same predicate
  `editModeAvailable()` already uses for the Edit button).

  | State | Trigger `#export-menu-btn` | Video `#export-video-btn` | PDF `#export-pdf-btn` | MusicXML `#export-musicxml-btn` |
  | --- | --- | --- | --- | --- |
  | No score | disabled (popup unreachable) | n/a (popup never opens) | n/a | n/a |
  | Audio-only score (`hasScore && !hasSheet`) | enabled | ENABLED | DISABLED | DISABLED |
  | Sheet score (`hasScore && hasSheet`) | enabled | enabled | ENABLED | ENABLED |

  Wiring rules:
  - **Trigger:** `disabled = !hasScore`. It rides the SAME enable site the current `#export-btn`
    uses: `controlsEnabledForScore(!!score)` in `setBusyUI`, and the post-load enable, and the busy
    path forces it disabled (lines ~452, ~1898-1908, ~2270 today). It is `disabled` (not just
    `hidden`) when no score, matching how export is dimmed today.
  - **Per-item:** Video item `disabled = false` whenever the trigger is enabled (Video works for any
    loaded score, the existing guarantee). PDF + MusicXML items `disabled = !hasSheet`, AND carry
    `aria-disabled="true"` set in lockstep, the SAME `disabled` + `aria-disabled` idiom as undo/redo
    and the duration-ladder ends (main.ts ~834). A small `setExportMenuState()` that runs wherever
    `setEditButtonEnabled()` runs keeps PDF/MusicXML in sync with sheet availability.
  - **Disabled-item discoverability:** PDF/MusicXML stay in the DOM and remain focusable-by-arrow
    inside the popup even when disabled (so a keyboard user can land on them and hear the reason),
    but native Tab skips a `disabled` button. The chosen approach: keep `disabled` (so they cannot
    be activated and look dim) AND mirror `aria-disabled="true"`, plus show the inline
    `.export-item-hint`. The visible hint is the primary "why" for sighted users; the hint text
    being part of the item's content covers SR users who arrow onto it. This matches the project's
    existing "dim + aria-disabled" convention rather than inventing a tooltip-only explanation.

  ### Decision EXPORT-6 (ICONS) - Heroicons stroke glyphs (viewBox 0 0 24 24, stroke 1.5).

  - **Trigger:** keep the existing arrow-into-tray download glyph already on `#export-btn` (the
    `M3 16.5V18.75...` path), plus a small chevron-down caret (`M6 9l6 6 6-6`, 14px) after the label
    to signal "opens a menu". The tray-download glyph already reads as "export/save", so reusing it
    keeps recognition.
  - **Video item:** Heroicons `video-camera` (the camera body + lens triangle). Path:
    `M3.75 6.75A1.5 1.5 0 0 1 5.25 5.25h9A1.5 1.5 0 0 1 15.75 6.75v10.5A1.5 1.5 0 0 1 14.25 18.75h-9A1.5 1.5 0 0 1 3.75 17.25V6.75ZM15.75 9l4.5-2.25v10.5L15.75 15`.
  - **PDF item:** Heroicons `document` (a sheet of paper with a folded corner). Path:
    `M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625A1.125 1.125 0 0 0 4.5 3.375v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z`.
    A paper sheet reads as "a document to download" without faking a literal "PDF" badge (which a
    1.5-weight stroke icon renders illegibly small).
  - **MusicXML item:** a TWO-NOTE beamed/joined eighth pair (two noteheads on stems joined at the
    top, the classic "music" glyph; Heroicons has `musical-note` for a single note, this is the
    two-note variant so it does not collide with anything). Path:
    `M9 9V18M9 9L18 7.5V16.5M9 9L18 7.5M9 18A2.25 2.25 0 1 1 4.5 18 2.25 2.25 0 0 1 9 18ZM18 16.5A2.25 2.25 0 1 1 13.5 16.5 2.25 2.25 0 0 1 18 16.5ZM12.75 5.25l8.25-1.5v3l-8.25 1.5v-3Z`.
    The double note says "the music data itself", distinct from the PDF's paper (the rendered page)
    and the Video's camera. If the Tech Lead prefers an unambiguous "structured data" read, the
    fallback is Heroicons `code-bracket-square` (a `< >` in a rounded square), but the double-note is
    the on-theme first choice.

  ### Decision EXPORT-7 (MOTION + FOCUS) - reduced-motion + focus-ring.

  - **Popup open/close:** a quick fade + 4px rise (opacity 0->1, translateY 4px->0, ~120ms
    ease-out) is the only animation. Under `@media (prefers-reduced-motion: reduce)` the popup
    appears/disappears INSTANTLY (no fade, no rise), matching the project's existing reduced-motion
    blocks (style.css has three already; add the export popup to that treatment). No looped motion,
    so no flash concern.
  - **Panel surface:** the popup is a `--bar-surface` panel with a `--bar-border` 1px edge and an
    8px radius (same family as the toolbar), positioned absolutely under the trigger
    (`top: calc(100% + 6px); left: 0;`), `z-index` above the controls. Items are full-width ghost
    rows: transparent fill, `--text`; hover/focus tints brass exactly like the ghost pills
    (`--ghost-bg-hover` background). Keep contrast AA: `--text` on `--bar-surface` already passes;
    the disabled item drops to `opacity: 0.4` (the established disabled dim) but its hint text must
    stay legible, so apply the dim to the icon + label and give the hint its OWN `--text-muted`
    color so it does not stack into unreadability as the explanation.
  - **Focus ring:** every item and the trigger use the ONE shared `button:focus-visible` ring
    (`2px solid var(--focus-ring)`, 2px offset) already defined; no per-control ring. The trigger's
    `aria-expanded` does not change its ring; the open popup is the affordance.
  - **Phone:** the trigger stays one pill (>=44px tall via the existing touch rule). The popup is
    fixed-width ~220px but `max-width: calc(100vw - 24px)` so it never overflows a narrow viewport;
    each item row is >=44px tall on touch (reuse the existing `min-height: 44px` touch rule scope by
    adding `.export-item` to it). Because the popup is anchored to the trigger and the trigger can
    wrap to any row on phone, position it relative to `.export-menu-wrap` (`position: relative`) so
    it follows the trigger wherever it lands.

  ### Decisions to confirm with the main agent / product owner
  1. **Disclosure popup over a 3-button group.** Confirm we want the menu (keeps the toolbar at one
     pill, groups the formats, room to explain the audio-only disable) rather than three peer pills.
     I recommend the popup.
  2. **Disclosure + `role="group"` of buttons, NOT `role="menu"`.** Confirm the non-menu semantics
     (plain tab stops + additive arrow nav) given the mixed enabled state; I chose it so disabled
     items can stay focusable and explain themselves.
  3. **Disabled PDF/MusicXML show an inline "Needs a sheet, audio has none" hint** rather than
     vanishing. Confirm we surface the two formats always (greyed with a reason) so audio-only users
     learn the formats exist and why they are off, instead of seeing only Video and wondering.
  4. **Video item keeps the WebM container, named in its tooltip.** Confirm; it matches today's
     recorder output and the "MP3/WAV" naming on the audio loader.

## Smart Edit Mode P3 CHANGE-DURATION v1: shorten/lengthen a selected note along a note-value ladder (interaction + visual spec)

- **2026-06-04 - The last leg of the stated vision ("move notes, change their duration, add
  new ones"): move (P1 pitch) and add (ADD v1 rest-to-note) shipped; this is duration. Same
  substrate as P1/P2/ADD: ONE editable MusicXML model (`src/edit-model.ts`) projected onto the
  Verovio staff and the falling canvas, edits routed through the command/undo stack
  (`src/edit-commands.ts`) and the dual-surface re-render path in `main.ts` (serialize -> Verovio
  re-engrave -> re-derive VisNote[]/stepTimes -> `reloadNotes`). The model is ALREADY built for
  this: `NOTE_VALUE_QUARTERS` is the canonical ladder, `noteTypeForDuration` infers `<type>`+dots
  from `<duration>` divisions (the reason real OMR scores that omit `<type>` render at all), and
  the model header says it is "extensible toward duration: P3 mutates `<duration>`/`<type>` + adds
  a fixed-bar...". This entry is interaction + visual only; Tech Lead owns the model mutation +
  the ripple/reflow.**

  ### Decision P3-0 (SCOPE) - duration = walk a note up/down a fixed value ladder, ripple-and-reflow, RIGHT to the barline only.

  v1 is the smallest thing that delivers "change a note's duration": select a note, press a key or
  a button to make it the next-shorter or next-longer note value. NO duration palette, NO dotted
  values in v1, NO tuplets, NO note-input run mode (still deferred, see ADD-3). It applies ONLY to
  a selected NOTE (a rest's duration is not editable in v1; you fill it via ADD, then change the
  note's duration). This mirrors how P1 scoped pitch to a single nudge and ADD scoped to a single
  conversion: one selected object, one stepwise transform, one undo step, both surfaces re-derive.

  ### Decision P3-1 (CONTROL) - two stepper buttons (shorter / longer), NOT a value palette.

  RECOMMENDATION: add exactly TWO buttons to the `#note-edit` cluster (the note-selection cluster
  that already holds pitch-down / pitch-up / delete), placed AFTER pitch-up and BEFORE delete so
  the cluster reads pitch | duration | delete:
  - `#dur-shorter-btn`, aria-label "Shorter note", title "Make this note shorter (comma). Halves
    the value: half to quarter to eighth." Glyph: a short horizontal bar shrinking (or two notes
    with the right one smaller); keep it in the `.edit-tool-btn` ghost style.
  - `#dur-longer-btn`, aria-label "Longer note", title "Make this note longer (period). Doubles
    the value: eighth to quarter to half." Glyph: a bar growing. Same `.edit-tool-btn` style.

  Why steppers over explicit value buttons (a 16th/8th/quarter/half/whole palette): (1) two
  buttons fit the existing narrow docked toolbar that already carries undo/redo + pitch + delete,
  where a five-or-more-button palette would crowd or wrap on phone (#33/#84); (2) "make it a bit
  longer / shorter" is the OMR-correction verb (the scanner read a quarter as an eighth, the user
  wants one notch over), which a relative stepper expresses in one press, the same mental model as
  pitch-up/pitch-down already on the cluster; (3) it reuses the proven enabled/disabled idiom
  (gray out at the ends of the ladder) instead of needing a "which value am I on" highlighted-state
  palette. A value palette is the right richer follow-up when note-input mode lands (you pick a
  duration to ARM, which is a different gesture); flag to PM, do not build now. The cluster swap
  rule is UNCHANGED: `#note-edit` shows for a note selection, `#add-note` for a rest; duration only
  ever shows in the note cluster, so a rest never shows duration controls (correct, rests are not
  editable in v1).

  ### Decision P3-2 (KEYBOARD) - comma = shorter, period = longer. (Recommended, justified.)

  The arrow keys are fully spent: Left/Right = staff selection step, Up/Down = pitch (plain
  diatonic, Ctrl semitone, Shift octave), Enter = add-on-rest, Delete = delete, Ctrl+Z/Y = undo/
  redo, plus/minus = canvas pitch. Duration needs a fresh, unshifted, ergonomic pair that does not
  collide. CHOSEN: **comma `,` = shorter, period `.` = longer**, active on BOTH surfaces whenever a
  NOTE is selected in edit mode. Rationale: (1) `,` and `.` are physically the `<` / `>` keys, a
  near-universal "decrease / increase" pair, and on a piano-roll editor they read as "tighter /
  wider" which is exactly duration; (2) they are unmodified single keys (no Ctrl/Shift gymnastics),
  matching the lightweight feel of the existing single-key verbs (Enter, Delete); (3) they do not
  collide with anything bound today and are free on the canvas too (the canvas only spends arrows,
  plus/minus, Space). Rejected: bracket keys `[` `]` (harder to reach, less obviously ordered, and
  bracket-as-duration is a niche convention); Shift+Left/Right (reads as "extend selection", a
  multi-select gesture we may want later, so keep it free); the number row (that is the value-
  palette idiom for a future note-input mode, do not burn it on a stepper now). Document `,`/`.`
  in BOTH surface aria-labels (P3-6). On a rest selection `,`/`.` are no-ops (optionally a polite
  "Rests cannot change duration in this version" once, but silent is acceptable for v1).

  ### Decision P3-3 (LADDER) - plain values only: 16th, eighth, quarter, half, whole. No dots in v1.

  The stepper walks this exact ordered ladder (shortest to longest), one notch per press/click:
  **16th, eighth, quarter, half, whole**. These are the five values that cover essentially all
  real piano OMR corrections; `NOTE_VALUE_QUARTERS` already defines them (plus 32nd/64th/breve,
  which v1 simply does not step onto). Ends of the ladder CLAMP: at a 16th, "shorter" is a no-op
  (button disabled, key announces "Already the shortest value, sixteenth"); at a whole, "longer"
  is a no-op (button disabled, key announces "Already the longest value, whole"). DOTTED values
  are EXCLUDED from v1 and this is deliberate: dotted notes triple the ladder size (each value gets
  a dotted variant), make "next notch" ambiguous (does quarter step to dotted-quarter or to half?),
  and the bar-math for a 1.5x value is exactly where reflow gets hairy. Plain powers-of-two keep
  every step a clean double/halve, which keeps the ripple predictable and the mental model trivial
  ("each press doubles or halves"). A note that ARRIVES dotted (the model inferred dot(s) from an
  odd `<duration>`) snaps to the NEAREST plain ladder value on its first duration edit, announced
  ("Dotted quarter changed to quarter") so the user is not surprised; v1 never PRODUCES a dotted
  note. Dotted support is the natural v2 once reflow is proven. NOTE for Tech Lead: a duration edit
  sets BOTH `<duration>` (divisions) and `<type>`/dots together via the existing `noteTypeForDuration`
  inverse; `divisions` stays 4 (load-bearing across the codebase), so a 16th = 1 div, eighth = 2,
  quarter = 4, half = 8, whole = 16, and reflow math is in those integer divisions.

  ### Decision P3-4 (FEEDBACK) - both surfaces re-render the value; readout states the new value; a brief flash on the changed note.

  A duration change is a re-engrave (discrete, like a keyboard pitch step or an add), so there is
  no drag-preview phase in v1. On commit:
  - **Staff:** Verovio re-engraves the note at its new value (notehead fill open/closed, stem,
    flags/beams change) and the bar re-spaces. The `.ph-selected` brass halo stays on it. This is
    the primary "it landed" signal: a quarter visibly becoming a half is unambiguous notation.
  - **Falling canvas:** the bar's LENGTH changes (a longer value = a taller bar, since bar length
    is duration), and following bars in the voice shift to their new onsets (the ripple, P3-5). The
    bar keeps the focus-ring + glow selection. The length change is the canvas's native "it landed"
    signal.
  - **Readout (required):** the existing `#note-edit-readout` (which already names the selected
    note) ALSO states the current value, so a selected note reads e.g. "D5, quarter" and after a
    lengthen "D5, half". This is the transient value readout; no extra chrome. The readout uses the
    current Names mode for the pitch token (solfege/letters) as elsewhere.
  - **Transient flash:** on a duration commit, briefly pulse the changed note (staff notehead +
    canvas bar) with the brass `--accent-glow` for ~150ms, then settle to the steady selection
    halo. Pitch edits move the halo (visible by position); a duration edit can leave the notehead
    in the same x/y while only its shape changes, so a one-shot flash draws the eye to "this note
    just changed" the way a position move does for pitch. Respect reduced motion: NO flash under
    `prefers-reduced-motion` (the re-engrave + readout already confirm it), matching #86/#6.

  ### Decision P3-5 (BAR-FULLNESS) - RIPPLE-and-reflow within the bar, spill is CLAMPED at the barline (simplest predictable rule). Plainly stated limit.

  RECOMMENDATION: **ripple-and-reflow, scoped to the current bar, with a clamp at the barline.**
  This is NOT MuseScore's overwrite model (where lengthening a note silently eats the notes after
  it) and NOT a free global reflow (where one edit shoves the whole piece). The rule:
  - **Lengthen:** the note grows; the following notes/rests IN THE SAME VOICE AND BAR shift later
    by the added duration (ripple right). If the bar would OVERFLOW, the growth is CLAMPED so the
    note grows only as far as the barline allows: the note takes all remaining room up to the bar's
    end and no event is pushed across the barline. If there is no room at all (the note is already
    the last event filling the bar), "longer" is a no-op at the bar boundary (announce "No room to
    lengthen in this bar"). So a bar NEVER overflows and notes NEVER cross a barline in v1.
  - **Shorten:** the note shrinks; the freed time becomes a REST appended after it in the bar (the
    bar stays full, mirroring how DELETE leaves a rest). The following events do not move (their
    onsets are unchanged); only a rest appears in the gap. This reuses the proven "completing a bar
    with rests is a rendering-safe fill" finding (rhythm_repair: complete-with-rests is never-worse;
    stretching a note to fill REGRESSED real pieces, MEMORY.md). So shorten = "note + new rest",
    which is exactly the delete-leaves-a-rest idiom the user already knows.
  - **The limitation, stated plainly (for the PM + the help copy):** in v1 a duration change CANNOT
    spill across a barline. If you want a note longer than the room left in its bar, v1 stops you at
    the barline (it does not auto-create a tie into the next bar). Cross-barline durations + ties are
    the v2 follow-up. This is the honest, predictable boundary: every edit stays inside one bar, so
    the bar always sums correctly and the user never has to reason about a tie they did not ask for.
    The clamp-and-announce makes the limit legible at the moment it is hit rather than silently doing
    something surprising.

  Why this over MuseScore overwrite: overwrite (lengthening swallows the next note) DESTROYS data
  silently, which is the opposite of a correction tool's job and has no undo-friendly "what did I
  just lose" story. Ripple + clamp loses nothing: shorten adds a rest (recoverable by lengthening
  back), lengthen either ripples within the bar or stops at the wall. It keeps the bar invariant
  the rest of the editor already relies on (every prior op is fixed-bar) and it is one sentence to
  explain ("a note grows or shrinks inside its bar; it never crosses a barline").

  ### Decision P3-6 (ACCESSIBILITY) - aria-labels for the two buttons + the full revised staff help/aria string.

  - **Button aria-labels:** `#dur-shorter-btn` = "Shorter note"; `#dur-longer-btn` = "Longer note".
    Disabled at the ladder ends carry `disabled` + `aria-disabled="true"` (same idiom as undo/redo),
    so a pointer user sees them dim and a keyboard user gets the boundary announce instead.
  - **Announcements (the shared `#edit-live` polite region), value-named, current Names mode:**
    - On a duration step: **"D5 quarter to half"** (lengthen) / **"D5 half to quarter"** (shorten),
      the from->to form matching P1's "D4 up to E4". The pitch token is informational; the values
      are load-bearing.
    - Shorten that adds a rest: the same "D5 quarter to eighth" suffices (the new rest is implied by
      a shorter value); no extra sentence in v1.
    - Lengthen clamped at the barline: **"D5 lengthened to fill the bar"** when it grew partway, or
      **"No room to lengthen in this bar"** when it could not grow at all.
    - Ladder ends: **"Already the shortest value, sixteenth"** / **"Already the longest value, whole"**.
    - Snapping a dotted arrival to plain: **"Dotted quarter changed to quarter"** before the step's
      own from->to announce (or fold into one: "Dotted quarter to quarter").
    - Undo of a duration edit: **"Undid lengthen to half"** / **"Undid shorten to eighth"** (P1-6
      form); redo mirrors. After undo the note returns selected at its prior value.
  - **Full REVISED staff help/aria string (replaces the `main.ts` ~line 657 string verbatim, no
    em dashes):**

    "Staff editor. Left and right select a note or a rest; up and down change a note's pitch by a
    step; Control with up or down changes by a semitone; Shift with up or down by an octave; comma
    makes a note shorter and period makes it longer; on a rest, press Enter to add a note of the
    same duration; Delete removes a note; Control Z undoes."

  - **Canvas surface aria-label (append the duration clause to the canvas string too, since `,`/`.`
    work there as well):** add ", comma and period change its length" after the pitch clause, e.g.
    "...plus and minus change its pitch by a semitone; Shift with plus or minus moves an octave;
    comma and period change its length; Delete removes it; Control Z undoes."

  ### Decisions to confirm with the main agent / product owner
  1. **Ladder = plain 16th/eighth/quarter/half/whole, NO dots in v1.** Confirm dropping dotted
     values for the first cut; I chose it because clean halve/double keeps reflow predictable and
     the mental model one sentence. Dotted is the obvious v2.
  2. **Reflow = ripple inside the bar, CLAMP at the barline (no cross-bar ties).** Confirm we accept
     "a note cannot grow past its barline in v1" as the honest limit rather than auto-tying into the
     next bar. I recommend the clamp; ties are v2.
  3. **Keys = comma (shorter) / period (longer).** Confirm this pair over brackets; I picked `,`/`.`
     for the `<`/`>` decrease/increase reading and zero collisions.
  4. **Shorten leaves a REST in the freed time (following onsets unchanged); lengthen RIPPLES the
     following events later within the bar.** Confirm this asymmetry (shorten = local rest, lengthen
     = ripple) reads right; it falls out of "the bar always stays full and nothing crosses a barline".

## OMR block-by-block STREAMING loader: the "recognition scan-line" (loading-animation spec)

- **2026-06-04 - We are shipping OMR streaming (branch `feat/omr-block-streaming`): the score
  renders one SYSTEM (one staff-line row, top to bottom) at a time as the engine finalizes it.
  Finished systems show crisp REAL notes; the system being decoded right now gets a distinct
  ACTIVE treatment; systems still pending below the frontier show an animated loading state on
  EMPTY/skeleton staves. Hard product constraint from the owner: do NOT draw fake/placeholder
  rhythm on not-yet-recognized systems (that was explicitly rejected); the pending region is a
  loading animation on empty ruling, never invented notes. Prod CPU timeline: ~28s blank lead-in,
  then a new system finalizes roughly every ~9s, so the loader has to make a long, lumpy wait feel
  alive and like progress. Data contract the client has: k systems finalized out of total (the
  stream knows total + done), so the renderer draws k real systems + (total - k) pending slots and
  marks system k+1 active. A previewable demo of all three concepts lives at
  `docs/design/streaming-loader-demo.html` (self-contained, no build step, ~30s loop, concept +
  reduced-motion toggles). This entry is the design decision; the Tech Lead owns the wiring.**

  ### Decision STREAM-1 (RECOMMENDED) - the "recognition scan-line". The animation IS the recognition.

  **RECOMMENDED concept: a brass "scan-line" that sweeps top-to-bottom across the ACTIVE system,
  with notes materializing as each system locks in, and a quiet brass-brown skeleton shimmer on the
  pending systems below.** Why this over the alternatives: it is the only one that is ON-THEME for an
  OMR app. The engine literally reads the page line by line; a sweep that descends the active staff
  and leaves a faint "recognized so far" wash behind it mirrors the machine's actual act of optical
  recognition, so the animation tells the true story of the wait instead of a generic spinner. It
  also reads as PROGRESS (a frontier moving down the page) rather than mere "waiting", which is what a
  ~28s-then-9s-per-line wait needs. It fits the Nocturne language exactly: the sweep is brass
  (`--accent #d8a23a`) with a hot ivory core and an `--accent-glow` bloom, the same lamp-light accent
  used everywhere else; the skeleton wash is brass-brown (`#6b4f1f` family at low alpha), the page's
  own annotation ink, so nothing introduces a new hue. It is cheap (one sweeping pseudo-element per
  active system + a CSS-gradient sheen on pending blocks, transform/opacity only).

  ### Decision STREAM-2 - the THREE states and exactly how each looks.

  - **DONE (system index < k): crisp REAL notes, no animation.** The finalized engraving for that
    system, full-ink noteheads on full-strength staff lines, exactly as the score renders today. The
    only motion is the one-shot ENTRANCE the instant a system flips done: each notehead does a 360ms
    `note-pop` (opacity 0 -> 1, scale 0.6 -> 1, a 3px settle) so the row visibly "locks in" behind the
    sweep instead of snapping. After that it is static and crisp. Under reduced motion the notes
    appear instantly with no pop.
  - **ACTIVE (system index == k, the one decoding now): the scan beam.** A horizontal brass beam
    (~10px tall, transparent -> `--accent` -> ivory core -> `--accent` -> transparent, with an
    `--accent-glow` drop-shadow) rides from the top of the system to the bottom on a ~2.4s ease-in-out
    loop; ABOVE the beam a faint brass wash (`scaleY` growing from the top) reads as "recognized so far
    in this line". The staff ruling for the active row sits at ~0.5 opacity (present but not yet
    "inked"). No skeleton blocks on the active row (the beam carries it). This is the single row that
    says "work is happening right here, right now."
  - **PENDING (system index > k): skeleton shimmer on EMPTY staves, NO fake notes.** The staff ruling
    (5-line treble + 5-line bass, brace, edge barlines) is drawn at ~0.5 opacity so the page already
    looks like ruled music paper, and on each staff sit note-SHAPED skeleton blocks (rounded brass-brown
    bars, deliberately block-like so they read as placeholder, NOT as notes) with a brass sheen
    sweeping left-to-right on a ~1.8s loop, staggered per row so the page ripples rather than pulsing in
    lockstep. The skeleton occupies where notes WILL be without committing to any pitch or rhythm,
    honoring the "no invented notes" rule while still filling the empty region with life.

  ### Decision STREAM-3 - the two ALTERNATIVES (built in the demo, not recommended).

  - **B. Skeleton shimmer (modern content-loader).** Every not-done system (pending AND active) shows
    the note-shaped skeleton blocks with the brass sheen; the ACTIVE row shimmers brighter + faster and
    gets a pulsing brass left-edge marker to single it out. Clean, familiar, very cheap. Rejected as the
    primary because it is GENERIC: it could be any app loading any content and says nothing about
    optical recognition, so it wastes the one chance to make the wait feel like the product's core act.
    It is the right FALLBACK shape, though, and the recommended concept already reuses its skeleton
    treatment for the pending rows.
  - **C. Blink / pulse (calmest).** No sweep, no shimmer: empty staves gently breathe in opacity
    (~0.38 Hz, a 2.6s cycle) and the active row breathes a touch brighter with a brass tint. Lowest
    energy, lowest risk, least code. Rejected as primary because it reads as "waiting / idle" rather
    than "working", and gives the weakest sense of a frontier advancing, which is exactly the
    reassurance a minute-long lumpy wait needs. Its slow opacity breathe IS effectively the
    reduced-motion fallback for the scan-line concept (see STREAM-4).

  ### Decision STREAM-4 - reduced motion + flash safety (required).

  - **`@media (prefers-reduced-motion: reduce)`: collapse ALL concepts to one calm static state.** No
    sweep, no sheen, no breathe, no note-pop. Pending rows show a single STATIC brass-brown wash band on
    the empty staff (the skeleton block with its moving sheen disabled); the active row shows a STATIC
    brass left-edge marker + a slightly brighter static wash so "this row is being decoded now" stays
    legible without any motion; done rows show their real notes instantly. Progress is still fully
    conveyed (which rows are done vs pending vs active) purely by the static layout + the row count, so a
    reduced-motion user loses nothing but the animation. The demo's "Reduced motion" toggle previews
    this and auto-engages if the OS setting is on.
  - **Flash safety:** every looped animation is well under 3 Hz (scan beam ~0.42 Hz, skeleton sheen
    ~0.56 Hz, blink ~0.38 Hz) and none is a hard on/off flash; they are smooth opacity/translate ramps,
    so there is no seizure risk. Contrast: the brass accent on cream paper and the brass-brown wash on
    cream both stay within the page's existing legible palette; the sweep never obscures already-rendered
    real notes (it only rides the empty active row).

  ### Decision STREAM-5 - renderer ATTACHMENT POINT (for the Tech Lead).

  - **Where it lives:** the score renders into the cream sheet pane `#sheet` (the "real paper" pane,
    `background:#f6f1e6`, `position:relative`, `overflow-y:auto`). The loader is an OVERLAY layer that is
    a child of the scrolled sheet content (so it scrolls WITH the engraving, exactly like the
    `#sheet-labels` note-name overlay already does), holding one absolutely-positioned box PER SYSTEM,
    each aligned to that system's bounding box.
  - **What a "system" is in the DOM:** Verovio (PR #195, `src/verovio-view.ts`) lays the score out as
    `<g class="system"> ( <g class="measure"> <g class="staff"> ... )*`, so a musical system (one
    staff-line row, top to bottom) is exactly one `<g class="system">`. The streaming renderer can read
    the first k system groups as DONE (real notes already engraved) and overlay (total - k) PENDING
    boxes plus one ACTIVE box, sizing each box from the corresponding system group's
    `getBoundingClientRect()` (in scrolled `#sheet` coords, the same coordinate basis
    `readNotePositions`/`#sheet-labels` use). If a streamed render does not yet have the pending systems
    in the SVG at all (only k systems are engraved), the overlay lays out the (total - k) pending slots
    by stacking them below the last engraved system at a fixed per-system height (the renderer knows
    total + done, so it can reserve the vertical space). Either way the box positions come from layout
    geometry, never hard-coded.
  - **State per box** = `done | active | pending`, set from the stream's k-of-total. The CSS keys off a
    `data-state` attribute (the demo uses exactly this), so the only per-frame JS is flipping
    `data-state` when a system finalizes; the animation itself is pure CSS. Mark system k+1 (index == k)
    active.
  - **Tokens (all already in `:root`, no new brand colors):** `--accent` (sweep + active marker),
    `--accent-glow` (sweep bloom + active staff glow), `--focus-ring` not needed here; the skeleton wash
    is the page's brass-brown ink `#6b4f1f` at ~0.16 alpha and the sheen is `--accent` at ~0.42 alpha
    (proposed loader-local tokens `--skeleton-base` / `--skeleton-sheen` in the demo). Staff ruling for
    pending/active is the engraving ink at reduced opacity. The demo is the canonical reference for the
    exact gradients, durations, and easings; lift them from `docs/design/streaming-loader-demo.html`.
  - **Relationship to the #86 full-stage scan overlay:** the #86 blocking overlay covers the WHOLE stage
    for the opaque pre-stream wait (and for audio transcription, which has no per-system stream). Once
    block streaming begins emitting systems, the per-system loader REPLACES the blocking overlay for the
    sheet pane: the user watches the page fill in rather than staring at one centered spinner. The #86
    overlay stays for non-streaming paths and for the brief moment before the first system arrives.

  ### IMPLEMENTATION NOTES (Tech Lead, 2026-06-04) - two deviations from STREAM-5, both deliberate.

  - **The loader reads OSMD geometry, not Verovio `<g class="system">`.** STREAM-5 named Verovio's
    `<g class="system">` as the attachment point, but the STREAMING render path is OSMD (the cream sheet
    pane engraves partials via OSMD; Verovio is edit-mode-only, PR #195), and OSMD/VexFlow emit NO
    per-system `<g class="system">`. So the production loader (`src/sheet-stream-overlay.ts`) recovers
    each engraved system's box by CLUSTERING the engraved noteheads by their vertical position, in the
    exact scrolled-`#sheet` pixel basis the note-name overlay already uses (`readNotePositions`). This
    honors the spec's intent ("box positions come from layout geometry, never hard-coded", one box per
    system, scrolls with the engraving as a `#sheet` child like `#sheet-labels`) and is renderer-agnostic
    (works if the sheet later renders via Verovio). The fixed-per-system-height STACK for not-yet-engraved
    pending/active rows (the spec's own fallback) is used for ALL of them, since a streamed partial holds
    only the finished systems. Everything else is lifted verbatim from the demo: scan-beam, skeleton
    sheen (staggered), reduced-motion static fallback, the brass/brass-brown tokens.
  - **The one-shot `note-pop` entrance is dropped.** The overlay does not draw notes: a DONE system shows
    the REAL OSMD noteheads through a hidden overlay box, so there is nothing in the overlay to pop, and
    re-running OSMD's own note glyphs through a pop on each partial re-render would flash every note, not
    just the newest row. The core "recognition" motion (scan-line on the active row + skeleton shimmer on
    pending) is fully delivered; only this finishing flourish is absent. Revisit if the sheet ever moves
    to an incremental renderer that can animate a single just-landed system.

## Smart Edit Mode ADD-A-NOTE v1: fill a rest (turn a REST into a NOTE of the same duration) (interaction + visual spec)

- **2026-06-04 - The inverse of P2 delete. P2 (model-level DELETE) shipped: a selected note
  becomes a `<rest>` of the same duration in place, fixed-bar, undoable, chord-aware (tech-lead.md
  2026-06-04 "MODEL-LEVEL DELETE shipped"; `makeRestFrom` + `DeleteNoteCommand` + `reindexHandles`).
  ADD-a-note v1 is the literal mirror: turn a `<rest>` back into a `<note>` of the SAME duration,
  fixed-bar, no new timing math. This is exactly the OMR correction need (the scanner drops a note
  and leaves a rest in the gap; the user fills it) and it reuses the model machinery wholesale. The
  richer MuseScore "insert a note of any duration anywhere" is entangled with duration editing and is
  DEFERRED to land with P3 (duration). This entry is design only; the substrate is the edit-model DOM
  (`src/edit-model.ts`), the command stack (`src/edit-commands.ts`), and the dual-surface wiring in
  `src/main.ts`, all of which P1/P2 already built.**

  ### Decision ADD-0 (SCOPING, validated) - Add = rest-to-note fill, NO duration math, NO new mode.

  Validated the proposed scope and KEPT it. Add-a-note v1 = "select a rest on the staff, convert it to
  a note of the same duration, then adjust the pitch with the existing P1 pitch controls." Three reasons
  this is the right v1 and not a watered-down one: (1) it matches the real correction (a dropped note is
  a rest in the gap, so filling rests IS the feature, not a subset of it); (2) it is the exact inverse of
  the delete that just shipped, so it reuses `makeRestFrom`'s mirror, the command/undo stack, the
  re-index, and the dual-surface re-derive with almost no new surface; (3) it keeps the sync invariant
  trivially (the slot's duration and onset never change, so the falling lane and audio re-derive the same
  way a pitch edit does). Everything that needs real timing math (arbitrary-duration insertion, splitting
  a rest, note entry on an empty beat that has no rest) waits for P3 where duration editing exists.

  ### Decision ADD-1 - TARGETING a rest: the staff is the only place you can, and that asymmetry is honest.

  - **A rest is a STAFF-ONLY target.** The falling-notes canvas has no rest (rests do not fall), so there
    is nothing to click there. On the staff a rest is a Verovio `<g class="rest" id="...">` with a stable
    id, sibling to the `<g class="note">` noteheads the click path already resolves. So: **you add a note
    by selecting a rest on the staff and converting it; the new note then appears on BOTH surfaces** (it
    is a real note from that instant). This asymmetry is correct and should not be hidden: a rest is a
    silence, and a silence has no falling bar, so "you fill the gap on the page, and the note drops into
    the river" is the true mental model. Announce it so a canvas-focused or SR user is not surprised (see
    ADD-4: the add announcement names the note AND that it now plays).
  - **MOUSE - click the rest glyph.** Today the staff `pointerdown` resolves `target.closest("g.note")`;
    extend it to ALSO resolve `target.closest("g.rest")`. A rest is not a handle today (the model walk at
    `reindexHandles` SEES rests, computes their onset/duration, and deliberately pushes no handle for
    them, `edit-model.ts` ~line 320). To make a rest selectable WITHOUT polluting the pitched-note handle
    space that delete/pitch/undo key on, give the model a **separate rest registry**: a parallel
    `restHandles[]` built in the same walk (each entry: a synthetic rest id, the `<rest>`'s `<g>` id on
    the staff, its `onsetSec`, its `durationSec`/`<type>`, its `<staff>`/`<voice>`), so a rest id is
    addressable for selection + the add command but never appears in `staffNavHandles()` / `handleToVisIndex`
    / the pitched-note count. (Tech Lead owns the exact shape; the load-bearing constraint is "a rest is
    selectable and convertible, but it is NOT a NoteHandle, so nothing that iterates pitched notes changes
    behavior.") Click padding: noteheads already get a >=24px padded hot zone; give the rest glyph the
    SAME padded hit target (rest glyphs are small) so it is tappable on phone (#33/#84).
  - **KEYBOARD - rests join the staff Left/Right walk, opt-in via a "stops on rests" rule.** Left/Right
    on the staff steps `staffNavHandles()` (notes only, by onset). Extend the staff nav order to ALSO
    include rests, interleaved by onset, so Left/Right walks "note, note, REST, note" in document time and
    you can land on the gap with the keyboard alone (a no-pointer path is a hard a11y requirement, parity
    with delete). When the selection lands on a rest, the edit cluster shows the single **Add** action
    (ADD-3) instead of the pitch/delete cluster, and the announcement says it is a rest (ADD-4). Rests are
    still EXCLUDED from the canvas Up/Down selection nav (the canvas has no rest to select); canvas nav is
    unchanged. This keeps one consistent rule: the STAFF can reach every musical event including silences;
    the CANVAS reaches only the sounding notes it draws.

  ### Decision ADD-2 - SETTING the new note's pitch: default to the click height on the staff, else the previous note.

  When a rest becomes a note it needs a starting pitch the user then nudges with the P1 controls (arrows
  on the staff, drag, +/-). Minimize the steps to the intended pitch:

  - **MOUSE default = the staff line/space the user CLICKED (y -> nearest diatonic step, key-sig aware).**
    The click already carries a vertical position; map it to the nearest staff position the way a staff
    pitch drag snaps (the staff drag already does y -> diatonic step via the notehead bbox; reuse that
    math against the rest glyph's staff geometry). This is the fewest-steps path: a user fixing a dropped
    middle-C clicks at the middle-C line and gets a C with zero further adjustment. The pitch is diatonic
    + key-signature aware (clicking just above the top line in C major yields G/A, not a sharp), matching
    the staff's native unit. If the click maps cleanly, the new note lands there and is selected.
  - **KEYBOARD default = the PREVIOUS sounding note's pitch** (the nearest earlier note in the same
    voice/staff by onset; if none, the staff middle line, B4 treble / D3 bass). Rationale: a keyboard user
    arriving on a rest via Left/Right has no y to click, and "same pitch as the note before it" is the
    single best prior for a melodic gap (a dropped note is usually a step or two from its neighbor, far
    closer than a fixed default). The user then uses Up/Down (diatonic) to walk to the exact pitch, which
    is one or two presses from the neighbor in the common case. NOT the middle line as the primary default:
    the middle line is on average a wide interval from the gap's true pitch, so it costs more presses than
    "the note before it." Middle line is only the fallback when there is no previous note (a rest at the
    very start of a part).
  - **The new note is immediately the shared selection**, so the very next arrow / drag / +/- adjusts IT
    with the existing P1 pitch path. No separate confirm: convert-then-adjust is one continuous flow, the
    same as "delete, then undo if wrong." After conversion the pitch controls are live on it instantly.
  - **Default duration is NOT a choice in v1: it is the rest's own duration, always.** That is the whole
    point of fixed-bar fill (a quarter rest becomes a quarter note; the bar still balances). Duration
    pickers belong to P3.

  ### Decision ADD-3 - MODE MODEL: no note-input mode. Selecting a rest and converting it is enough. (Recommended, justified.)

  **RECOMMENDATION: NO separate note-input mode for v1.** Rest-to-note fill is a single conversion on an
  existing object (the rest), exactly like delete is a single conversion the other way; neither needs an
  armed insertion cursor. The MuseScore "N = note input" armed mode exists to enter RUNS of notes at a
  sticky advancing cursor with a chosen duration, which is a composition gesture; filling a dropped note
  is a one-shot correction on a target that is already on the page. Adding a mode would mean a second
  pointer state, a cursor object, an enter/exit affordance, and a mode indicator, all to wrap a single
  click that the existing selection machinery already supports. So:
  - **Selecting a rest reveals a single Add affordance**, and the edit cluster (shown whenever edit mode
    is on AND something is selected, ADD-1/P1) shows, for a rest selection, ONE primary button: **"Add a
    note"** (a plus-with-note glyph, e.g. Heroicons `plus` on the note motif, or a `plus-circle`), with
    the readout naming the rest ("Quarter rest, beat 3"). For a NOTE selection it shows the existing
    pitch-down / pitch-up / delete cluster, unchanged. One cluster, contents swap on what is selected.
  - **KEYBOARD = Enter (or the letter N as a familiar alias) converts the selected rest.** When a rest is
    selected, **Enter** turns it into a note at the keyboard default pitch (ADD-2) and selects it; **N**
    does the same for MuseScore muscle memory, but it is an ALIAS, not a mode toggle (one press = one
    conversion, never an armed state). After conversion you are on a normal note, so Up/Down immediately
    adjusts its pitch. This keeps the no-pointer path: Left/Right to the rest, Enter to fill, Up/Down to
    pitch it, done.
  - **Why this beats a mode even for runs:** a run of dropped notes is a run of rests (the scanner left a
    rest per gap), so the keyboard flow "Right to the next rest, Enter, Up/Down, Right to the next rest,
    Enter" already walks a run fast with no mode. If usage data ever shows users entering long original
    passages (composition, not correction), THAT is when a note-input mode earns its weight, and it lands
    with P3 duration (you cannot enter a run without choosing durations anyway). Flag to the PM, do not
    build it now.

  ### Decision ADD-4 - AFTER it is added it is a normal note; UNDO/REDO is one command; announcements.

  - **The added note is a first-class note** the instant it converts: pitch-editable (P1, both surfaces),
    deletable (P2, which turns it straight back into a rest), and present on BOTH the staff and the falling
    canvas. Nothing marks it as "added" (no permanent badge); like a corrected pitch, it is now just part
    of the model, which is the single source of truth (consistent with P1's "no permanent edited marker").
  - **ADD is ONE command, the inverse of delete.** Mirror `DeleteNoteCommand` with an `AddNoteCommand`:
    apply() converts the `<rest>` to a `<note>` at the chosen pitch/duration (a `makeNoteFrom(restEl, pitch)`
    that mirrors `makeRestFrom` and re-indexes), invert() turns that note back into the rest it came from
    (literally the delete path), redo() re-applies. The command carries the rest's slot + the added note's
    pitch + a `VisNoteSnapshot` so main.ts can splice the new falling note IN at its index on add and OUT
    on undo, exactly the reverse of how delete splices. Undo restores BOTH surfaces + audio together (same
    re-render / re-derive / reloadNotes path) and re-selects: after undoing an add, the **REST returns
    selected** (so you can try again), matching "after undoing a delete the note returns selected."
  - **Announcements (the shared `#edit-live` polite region):**
    - Selecting a rest: **"Selected a quarter rest, beat 3"** (name the rest's duration + its beat, the
      rest analogue of "Selected D4, right hand"). If beat is awkward to compute, "Selected a quarter rest"
      is acceptable; duration is the load-bearing token.
    - Adding: **"Added a note, D5"** (state that a note now exists AND its pitch, in the current Names mode
      so solfege/letters match the screen). Because the new note also starts sounding, this doubles as the
      "it now plays" signal the ADD-1 asymmetry needs; no extra sentence required.
    - Undo of an add: **"Removed the note"** (it became a rest again; symmetric with delete's "Restored
      D5"). Redo of an add: **"Added a note, D5"** again.
    - Each later pitch nudge on the new note announces with the normal P1 from->to form ("D5 up to E5").

  ### Decision ADD-5 - VISUAL + ARIA: a selectable rest wears the brass selection language; updated surface labels.

  - **A selectable rest looks like a rest until you touch it; on hover/focus it invites the click.** Give
    the rest `<g>`'s padded hot zone a subtle hover affordance (cursor: pointer + a faint brass
    `--accent-glow` wash behind the glyph on hover/keyboard-focus, ~20% alpha) so the user learns rests are
    actionable in edit mode without making every rest shout. This is lighter than a note's full selection
    halo because an unselected rest is not selected, only hoverable.
  - **A SELECTED rest wears the same brass selection language as a selected note**, sized to the rest
    glyph: the `.ph-selected` brass halo (2px `--focus-ring` stroke + soft `--accent-glow`) drawn around
    the rest's bounding box instead of a notehead. Same token, same look, applied to a rest. This is the
    one place the brass selection language extends to a non-note, and it should read identically so
    "selected = brass halo" stays a single learnable rule across notes and rests.
  - **DURING the add (the moment of conversion) there is no drag preview** (a click-to-fill is discrete,
    like a keyboard pitch step): the rest is replaced by a notehead at the chosen pitch in one re-engrave,
    the halo moves from the rest to the new notehead, and the falling bar appears in the lane in the same
    frame. If a future version lets the user drag vertically off the rest to choose the pitch before
    committing (a nice enhancement), it would reuse the staff drag-preview language (gliding notehead +
    target line/space wash); v1 does not need it because the click height already sets the pitch.
  - **Updated surface aria-labels (the staff gains the rest verbs; the canvas is unchanged on add):**
    - Staff `aria-label` adds the rest clause to the existing string: append "Select a rest and press
      Enter to fill it with a note of the same duration." So the full staff label becomes roughly: "Staff
      editor. Left and right select a note or a rest; up and down change a note's pitch by a step; Control
      with up or down changes by a semitone; Shift with up or down by an octave; on a rest, press Enter to
      add a note; Delete removes a note; Control Z undoes."
    - Canvas `aria-label` is UNCHANGED for adding (you cannot add from the canvas), but the project should
      ensure the ADD announcement is what tells a canvas-focused user that a note appeared (the live region
      is shared, so "Added a note, D5" reaches them regardless of focus).
    - Reduced motion: the rest hover wash and the selection halo are static (no pulse), matching #86/#6.

  ### Decisions to confirm with the main agent / product owner
  1. **Scope ratification: Add v1 = rest-to-note fill ONLY** (no arbitrary-duration insertion, no entering
     a note on a beat that has no rest, no note-input run mode). All of that waits for P3 duration. Confirm
     this is the intended v1 (the prompt says it is; flagging so the PM owns the "you cannot add a note
     where there is no rest yet" limit, which is the one user-visible gap and is honest given the scanner
     leaves a rest in real dropped-note cases).
  2. **Keyboard default pitch = the PREVIOUS note's pitch** (fallback middle line). Confirm "same as the
     note before it" over "always the middle line"; I chose it because a dropped note is usually near its
     neighbor, so it is the fewest-keystrokes prior. Mouse default is the click height regardless.
  3. **Enter (primary) + N (alias) to convert; NO note-input mode.** Confirm we do not want an armed
     MuseScore-style cursor for v1. I recommend no mode (a single conversion does not need one); N stays as
     a familiar one-shot alias, not a sticky state, so importing it now does not commit us to mode UX later.
  4. **Rests become reachable by the staff Left/Right walk** (interleaved by onset) in addition to clicking.
     Confirm we want keyboard users to step onto rests (I believe yes, it is the no-pointer add path); the
     cost is Left/Right now also stops on rests, which a pitch-correcting user will tab past. If that proves
     noisy, a follow-up could gate rest-stops behind a modifier, but v1 should include them for a11y.

## Smart Edit Mode P1: DUAL-SURFACE pitch editing + Correct-mode retirement + undo/redo (interaction + visual spec)

- **2026-06-04 - REVISES the framing below. P0 shipped a Verovio staff viewer behind an Edit toggle
  with click + Left/Right notehead selection, and the falling canvas in edit mode is currently a
  read-only mirror. The product owner gave two directives that this entry implements: (1) Edit mode
  REPLACES Correct mode (one editor, not two), and (2) DUAL-SURFACE editing: the user edits on the
  falling notes below AS WELL AS on the staff above, both derived from ONE source-of-truth notation
  model so a change on either surface instantly updates the other and the audio. The "Decision 0"
  below ("the staff is the editor; the falling view is a live mirror, READ-ONLY") is REVERSED for the
  parts noted here: the falling view becomes a co-equal editable surface. Everything in the older
  entry about the staff interaction, the cream/brass visual language, the fixed-bar duration model,
  and the assists still stands for the staff surface and for later increments; this entry adds the
  falling-surface half, the shared-selection bridge, and the P1 pitch-only scope. Tech Lead's P1 plan
  (tech-lead.md, 2026-06-04) is the substrate: an in-house notation model is the single source of
  truth; an edit -> serialize-to-MusicXML -> Verovio re-render -> re-derive VisNote[]/stepTimes ->
  rebuild Tone.Part loop (reuse `reloadNotes`); a COMMAND/undo stack from day one; Verovio re-render
  of the current page is single-digit ms so per-frame drag re-render is fine.**

  ### Decision P1-0 (FRAMING REVERSAL) - two editable surfaces, one model. The falling canvas is no longer read-only.

  In edit mode the user may edit on EITHER surface and both reflect every change live, because both
  are pure projections of one notation model (Tech Lead's model is the source of truth; the staff SVG
  and the `VisNote[]` the canvas draws are BOTH re-derived from it after every edit). This is the
  product-owner directive and it is the right call: a musician reasons about pitch differently on each
  surface (the staff says "this note is on the wrong line", the falling roll says "this bar is one
  key too low next to the one beside it"), and forcing them to one surface to make a correction they
  spotted on the other adds friction for no gain now that there is a single model to keep them honest.
  The "which view wins" ambiguity that the old read-only framing avoided does not return, because
  neither view holds state: the model wins, always, and both views redraw from it. When edit mode is
  OFF the app is exactly today's player on both surfaces (no selection, no hit-testing, no overhead).

  ### Decision P1-1 - SHARED selection is the spine of dual-surface. One selected model note, shown on both surfaces at once.

  There is ONE selection in edit mode: a single model note (P1 keeps single-select; multi-select is
  later). It is identified by the thing both surfaces can map to, the **VisNote index** (the canvas
  already selects by index; the staff already has `idToVisIndex` mapping a notehead id to that same
  index). Selecting on either surface sets that one selection and BOTH surfaces show it simultaneously:

  - **On the staff:** the existing `.ph-selected` brass halo on the notehead (`fill: --focus-ring`,
    `stroke: --accent`). Unchanged from P0.
  - **On the falling canvas:** the existing selection treatment in `drawFallingNotes` (solid 2px
    `--focus-ring` outline + soft `--accent-glow` halo on the bar), already wired to `setSelected(index)`.
  - **The selection is live on the NON-active surface too.** If you click a notehead on the staff and
    that note's bar is currently on-screen in the falling lane, the bar lights with the same halo at
    the same instant; if you select a bar on the canvas, its notehead on the staff gets the halo. The
    user always sees "the same note, highlighted in both places", which is what makes the single-model
    idea legible rather than abstract.
  - **Selection mapping caveats (inherit P0's contract):** the staff->canvas map is `idToVisIndex`
    keyed on (midi, onset). A tie CONTINUATION notehead has no VisNote (score.ts merges ties into one
    bar), so selecting a tie continuation on the staff selects the START bar on the canvas and the
    halo lands on the start notehead; announce the start note. The canvas->staff direction needs the
    inverse (VisNote index -> notehead id); build it as the reverse of `idToVisIndex` at render time
    (Tech Lead). When a canvas bar maps to no notehead (should not happen for a real note, but a
    defensive case), the staff simply shows no halo and the canvas halo alone carries selection.
  - **Off-screen on the mirror is fine.** If the selected note's bar has scrolled out of the falling
    lane, the canvas shows nothing (it only draws on-screen bars, by design) while the staff shows the
    halo. We do NOT auto-scroll the falling lane to chase a staff selection in P1 (the falling view is
    a time-scrubbed surface; yanking the playhead on every staff click would be disorienting). The
    reverse already holds: a canvas selection is by definition on-screen because you clicked a visible
    bar. The aria announcement names the note either way, so a keyboard/SR user is never lost.

  ### Decision P1-2 - the dual-surface PITCH edit: mouse + keyboard on each surface

  Scope is PITCH ONLY (move a note up/down). Time/onset never changes (preserves the sync invariant;
  the falling bar stays in its column, the staff note stays on its beat). Duration, add, delete, and
  cross-staff are later increments (P2+), except that delete is addressed in the retirement plan below.

  **STAFF surface (Verovio SVG), confirming + refining the older spec:**

  | Path | Gesture | Result |
  | --- | --- | --- |
  | Mouse | **Vertical drag** the selected notehead. As the pointer moves, the note SNAPS to the nearest staff position (line/space = a diatonic step), live-previewing at each snapped step. Horizontal movement is ignored (time is fixed). Release commits the pitch the note is showing. | Diatonic, key-signature aware (drag up from E in C major previews F, not E#). A drag is ONE undo step (coalesced), not one per crossed line. |
  | Keyboard | **Up/Down = diatonic step** (key-sig aware). **Ctrl/Cmd+Up/Down = chromatic semitone** (raw +-1, the way you reach an accidental). **Shift+Up/Down = octave** (chosen over PageUp/PageDown so the modifier story is uniform: plain = diatonic, Ctrl = chromatic, Shift = octave; see conflicts note). | Same model edit as the drag; each keypress is its own undo step. |

  **FALLING-NOTES surface (canvas piano-roll, NOT DOM noteheads), new in P1:**

  The canvas is a semitone grid (each key column is a semitone), so the natural falling-surface model
  is CHROMATIC, matching what the lane shows (it has no key signature, no staff lines; a bar is just
  "this key"). This is the right asymmetry: the staff edits diatonically (its native unit is the
  line/space), the roll edits chromatically (its native unit is the semitone/key). Folding in the old
  Correct +/- nudge:

  | Path | Gesture | Result |
  | --- | --- | --- |
  | Mouse | **Select a bar** (click, as P0/Correct already does via `hitTestBars`), then **vertical drag** the selected bar. The bar tracks the pointer and SNAPS to semitone rows (each row = one key); a faint target-key tint shows where it will land. Release commits. Horizontal drag is ignored (time fixed). A drag is ONE coalesced undo step. | Chromatic (+-1 semitone per row). Reuses the existing `nudgePitch` transform per snapped step under the hood, but committed as a single model edit on release. |
  | Keyboard | **Plus/Minus = chromatic semitone up/down** (the existing Correct `+`/`-`/`=`/`_` bindings, now living in edit mode). **Up/Down stay SELECTION movement** on the canvas (as Correct mode uses them today: move the selection to the nearest earlier/later onset), so they do not clash. **Shift+Plus/Minus = octave** (a fast way to fix the common octave-off OMR error from the roll). | Each keypress is its own undo step. |

  Why plus/minus for pitch on the canvas and arrows for pitch on the staff: the canvas already owns
  Up/Down for selection stepping (Left/Right/Space are transport), so its pitch keys must be the
  +/- pair, which is exactly the muscle memory Correct already taught. The staff is paused with no
  transport stepping, so its arrows are free to mean pitch. Two surfaces, two idioms, each matching
  what that surface already does. The plus/minus pitch keys also work on the staff as an alias (so a
  user who learned them on the canvas is not punished), but the canvas does NOT alias arrows-for-pitch
  (arrows are its selection nav). Document both in the aria-label per surface.

  ### Decision P1-3 - LIVE SYNC: exactly what the user sees on the non-active surface, during and after

  This is the heart of "single source of truth, two editable views". Define both phases precisely.

  - **DURING a drag (the active surface previews; the mirror does NOT thrash).** While dragging on
    one surface, only the ACTIVE surface shows the moving preview (the notehead gliding between lines,
    or the bar gliding between key rows, with the snap tint). The mirror surface and the audio are NOT
    updated per frame: a drag is a preview, and re-engraving the staff or rebuilding the Tone.Part 60
    times a second while the user is still choosing a pitch is both wasteful and visually noisy on the
    far surface. The mirror holds the PRE-DRAG state, lightly de-emphasized (see visual language) so it
    reads as "this is about to change", and updates in one step on release. Rationale: Tech Lead's
    re-render is single-digit ms so we COULD live-mirror, but the UX win of a calm mirror beats a
    twitching one, and it keeps the model write to one atomic commit per gesture (which is also one
    clean undo step). A keyboard pitch press is instantaneous (no drag), so it commits immediately and
    both surfaces + audio update at once with no preview phase.
  - **AFTER commit (release, or a keypress): both surfaces and audio update together, in one step.**
    The model takes the edit, serializes, Verovio re-renders the staff, the `VisNote[]` re-derives and
    the canvas redraws, and `reloadNotes` rebuilds the Tone.Part (it already pauses/restores the
    transport so the swap is inaudible). The selection STAYS on the same model note on both surfaces
    (the halo moves with it: the notehead is now on the new line, the bar is now in the new key row).
    The change is announced once (Decision P1-5). Net: edit on either surface, and within one frame the
    other surface shows the same note moved and the next Play will sound it at the new pitch.
  - **"Hear it" stays available.** The older spec's Space-to-audition-selection / Shift+Space-loop-bar
    assist applies to BOTH surfaces unchanged; after a pitch edit on the canvas you can tap it to hear
    the fix just as on the staff. (Audition is scoped playback, not transport, so it does not trip the
    "Play exits edit" rule.)

  ### Decision P1-4 - CORRECT-MODE RETIREMENT without a capability gap (clear recommendation)

  Correct mode does two things today: pitch-nudge (+/-) and delete. Edit mode P1 absorbs pitch-nudge
  on BOTH surfaces. Edit mode does NOT yet have delete (that is P2). So:

  - **RECOMMENDATION: remove the Correct toggle in P1 and carry its one missing capability (delete)
    forward as a minimal edit-mode action, then remove Correct's code in P2 when model-level delete
    lands.** Concretely, the no-regression path is:
    1. **P1 (this slice): remove the `Correct` button from the toolbar** (delete the `#correct-btn`
       markup + its toggle wiring). Edit mode is now the only editor. To avoid the delete capability
       gap for the one release before P2, **carry delete as a minimal edit-mode action**: the existing
       `deleteNote` transform already works on a VisNote index, and edit mode already has the selected
       index, so wire **Delete/Backspace (and a small trash button in the edit cluster) to delete the
       selected note in edit mode**. This is a tiny lift (the transform and the index both exist) and
       it means shipping P1 loses NOTHING Correct could do except add (below). It also front-runs P2's
       delete on the easy (VisNote-level) path; P2 then upgrades delete to the model-level fixed-bar
       "leaves a rest" behavior the older spec describes.
    2. **P2: replace the stopgap VisNote-delete with the model-level delete** (turns the note into a
       rest of the same duration, fixed-bar) and DELETE the `note-edit.ts` Correct transforms +
       `#note-edit` panel + all `correctMode` state from main.ts. Correct is fully gone.
  - **Why not "keep both until P2":** the product owner directive is one editor. Two visible toggles
    (Correct and Edit) that both pause playback and both select notes is exactly the confusion we are
    told to remove, and Correct's falling-canvas selection would now COMPETE with edit mode's falling
    selection on the same surface (two selection systems on one canvas). Removing the button in P1 and
    carrying delete forward as a small reuse is strictly less code and zero capability loss. The only
    thing P1 cannot do that Correct could is ADD a note; Correct's add was always marked minimal ("add
    as unknown hand") and is low-traffic, so deferring add to P2 (where it gets a real model
    representation) is acceptable and should be called out to the PM, not silently dropped.
  - **Exact button/label changes:**
    - **Remove** `#correct-btn` (the "Correct" toggle) entirely in P1.
    - **Keep** `#edit-btn` ("Edit", `pencil-square` icon, `aria-pressed`). Update its title to reflect
      that it is now THE editor: off = "Edit mode off. Click to fix wrong notes on the staff or the
      falling notes."; on = "Edit mode on. Click to exit." (state-explicit, matching the #37 wording
      rule). Drop "This view is read-only for now" from the on-enter announcement.
    - **Re-home the edit cluster** (the +/- and delete controls) so it serves edit mode. P0 put the
      staff edit affordances in the docked sheet toolbar; the falling surface needs its pitch controls
      reachable too. Single rule: the edit cluster (readout + pitch down + pitch up + delete) is
      shown whenever edit mode is on AND a note is selected, regardless of which surface the selection
      came from, and it acts on the one shared selection. It can live in the docked sheet edit-toolbar
      (the staff is always visible in edit mode) so there is ONE control cluster, not one per surface;
      the canvas does not grow its own floating panel in P1 (keyboard +/- and drag cover the canvas,
      and the shared cluster is on screen). This keeps the chrome to a single learnable place.

  ### Decision P1-5 - VISUAL LANGUAGE for a pitch edit (per surface), snap feedback, and the "edited" marker question

  - **Staff, during drag:** the dragged notehead glides vertically and snaps to each line/space; the
    target line/space gets a faint brass wash (`--accent` at low alpha) the instant the note would land
    there, so the snap is visible before release. The note keeps the `.ph-selected` halo throughout.
    Accidentals that the new pitch implies are NOT drawn during the preview (avoid flicker); they
    appear on the committed re-engrave. After commit: the note is simply engraved at the new pitch
    (correct by construction); the halo stays on it.
  - **Canvas, during drag:** the dragged bar glides vertically and snaps to key rows; the target KEY
    on the keybed AND the target row tint faintly in the bar's own pitch hue (so the user sees both
    "which key" and "which lane row"). The bar keeps the focus-ring + glow selection treatment. After
    commit: the bar is redrawn in its NEW pitch hue (the falling colors are pitch-class keyed, so the
    bar changes color to match its new pitch, which is itself strong confirmation the edit landed) at
    the new key column, still selected.
  - **The mirror during a drag:** de-emphasize the pre-edit note on the NON-active surface to ~55%
    opacity (a quiet "this is mid-edit" state) so the user understands the mirror is stale-by-one-
    gesture; restore to full on commit. This is cheap (one alpha on one element/bar) and only during
    an active drag. For a keyboard press there is no drag, so no mirror de-emphasis is needed.
  - **No permanent "edited" marker (CONFIRMED for dual-surface).** The older spec already argued the
    staff needs no per-note divergence marker because it is correct by construction once re-engraved.
    Under dual-surface this is even clearer: BOTH surfaces are now projections of the corrected model,
    so neither diverges from "the truth" anymore (the model IS the truth). RETIRE the falling canvas's
    dashed brass "edited" outline (the `note.edited` path in `drawFallingNotes` + the `edited` flag on
    VisNote + the "Edited. The sheet below still shows the original scan." status line): it described a
    divergence that no longer exists once the staff re-renders from the same model. The OPTIONAL
    "show original scan ghost" toggle from the older spec remains the right way to compare against the
    raw OMR (opt-in triage, not a permanent warning); it is not part of P1 but stays on the roadmap.
    Decision: P1 SHIPS WITHOUT any permanent edited marker on either surface; remove the dashed
    outline + status line as part of the Correct retirement.

  ### Decision P1-6 - UNDO / REDO UX (required)

  Undo/redo is mandatory in P1 (Tech Lead builds the command stack from day one). Design:

  - **Controls: two icon buttons in the docked sheet edit-toolbar**, a left-curving arrow (undo) and a
    right-curving arrow (redo), grouped together at the LEADING edge of the toolbar (before the pitch
    cluster) so they are in the conventional top-left "history" spot and do not move when the
    per-selection cluster shows/hides. Heroicons `arrow-uturn-left` / `arrow-uturn-right`, ghost-button
    styling, 44px tap targets on phone (#33/#84).
  - **Keyboard: Ctrl/Cmd+Z = undo, Ctrl/Cmd+Shift+Z = redo, and Ctrl/Cmd+Y = redo too** (Windows
    muscle memory). These are active whenever edit mode is on (not gated on a selection, since undo
    must work after a delete cleared the selection) and ignored while a form field is focused (the
    rename input stays safe). They `preventDefault` so the browser's own undo does not also fire.
  - **Scope: a drag is ONE undo step** (coalesced on release); each discrete keyboard pitch step is its
    own step; delete is one step. Undo restores BOTH surfaces and audio together (it is just another
    model mutation routed through the same re-render/re-derive/reloadNotes path) and RESTORES the
    selection to the affected note where it still exists (after undoing a delete, the note returns
    selected; after undoing a pitch move, the note is selected at its prior pitch).
  - **Disabled states:** undo disabled (`disabled` + `aria-disabled="true"`) when the undo stack is
    empty (fresh load, nothing done yet); redo disabled when the redo stack is empty (nothing undone,
    or a new edit cleared the redo branch). The buttons visibly dim when disabled (ghost-disabled
    styling) so the user can see whether there is history to move through.
  - **Aria announcements (polite, the shared edit-live region):** each undo announces what it reversed,
    "Undid raise to E4" / "Undid delete of C4"; each redo announces "Redid raise to E4". When a stack
    is empty and the key is pressed, announce "Nothing to undo" / "Nothing to redo" rather than going
    silent, so a keyboard/SR user knows the press registered. The button disabled state covers the
    pointer user; the announcement covers the keyboard user who pressed the shortcut anyway.

  ### Decision P1-7 - ACCESSIBILITY: both surfaces fully keyboard-drivable, every pitch change announced

  - **Both surfaces are focusable application regions in edit mode.** P0 already makes the staff pane a
    keyboard target and Correct already makes the canvas `role="application" tabindex="0"`. In edit
    mode, the CANVAS keeps that treatment (so its +/- pitch, Up/Down selection, octave, delete, and
    undo/redo all work from the keyboard with no pointer), and the staff pane keeps its P0 treatment
    (arrows = diatonic/chromatic/octave pitch, Left/Right = selection step). Tab moves focus between
    the two surfaces and the edit toolbar, so a keyboard user can choose which surface to edit on and
    drive it fully. Each surface's `aria-label` enumerates ITS keys (the canvas: "Up and down select a
    note; plus and minus change its pitch by a semitone; Shift with plus or minus moves an octave;
    Delete removes it; Ctrl Z undoes." / the staff: "Left and right select a note; up and down change
    its pitch by a step; Ctrl with up or down changes by a semitone; Shift with up or down by an
    octave; Delete removes it; Ctrl Z undoes.").
  - **ONE shared live region for edits, replacing the two P0 regions.** P0 has `#edit-live` (canvas)
    and `#staff-edit-live` (staff) as separate polite regions, which made sense when they were two
    independent selections. Dual-surface has ONE selection and ONE history, so collapse to ONE polite
    `aria-live` region for all edit/selection/undo announcements (keep a single id, e.g. reuse
    `#edit-live`; remove `#staff-edit-live`). This prevents the double-announce that two regions would
    produce when one model change updates both surfaces.
  - **Pitch-change announcements name the FROM and the TO pitch.** Required form: "D4 up to E4" (and
    "E4 down to D4", "C4 up an octave to C5"). This is more informative than P0/Correct's "Raised to
    D4" because it states the starting note too, which a non-sighted user needs to confirm the right
    note moved. Use the current Names mode (solfege/letters) for the pitch tokens so the announcement
    matches what is on screen. Selection announces "Selected D4, right hand" (name + hand, as Correct
    does). Snap during a drag is not announced per step (too chatty); only the committed result is.
  - **Undo/redo announcements** as in P1-6. Focus ring = shared `--focus-ring`. Reduced-motion: the
    selection halos and any snap tint are static (no animation/pulse), matching #86/#6.

  ### Tokens / classes (P1 deltas on top of the older spec's list)
  - Reuse `--accent`, `--accent-glow`, `--focus-ring`, `--on-accent`; canvas selection + staff
    `.ph-selected` are already wired.
  - **New:** a canvas drag-preview state (the gliding bar + target-key/row tint) and a staff
    drag-preview (gliding notehead + target line/space wash); the mirror de-emphasis is a transient
    ~55% alpha on the non-active surface's selected element during a drag only.
  - **New:** undo/redo buttons (`arrow-uturn-left`/`-right`, ghost styling, disabled states) in the
    docked edit-toolbar, leading edge.
  - **Removed:** `#correct-btn` + `.correct-toggle` wiring; the `note.edited` dashed outline +
    `VisNote.edited` flag + the "Edited..." status line; `#staff-edit-live` (collapse into `#edit-live`).
    `note-edit.ts` Correct transforms survive only as the P1 delete stopgap, removed at P2.
  - Edit state in main.ts: ONE shared `selectedIndex` (model note), `editMode`, drag state per surface,
    and the command/undo stack (Tech Lead owns the stack shape).

  ### Open decisions to flag to the main agent / product owner
  1. **ADD-a-note is deferred to P2.** P1 covers pitch on both surfaces and carries delete forward, but
     it does NOT add notes (Correct's minimal add retires with Correct). Confirm that losing "add a
     note" for the one release between P1 and P2 is acceptable; it is low-traffic and gets a proper
     model-level representation in P2. (Recommendation: acceptable.)
  2. **Drag previews the active surface only; the mirror updates on release, not per frame.** I chose a
     calm mirror over a live-twitching one even though the re-render is fast enough to live-mirror.
     Confirm that "the other surface updates when you let go, not while you are still dragging" matches
     the product-owner's mental model of "instantly updates the other"; instant-on-commit is what I
     read the directive to mean for a continuous gesture, and discrete keypress edits ARE instant on
     both surfaces. If the owner wants the mirror to track mid-drag, it is a small change (drop the
     debounce) but noisier; flagging the deliberate choice.
  3. **Surface asymmetry: staff edits DIATONICALLY, canvas edits CHROMATICALLY** (each matching its
     native unit, with modifiers for the other axis). Confirm this asymmetry is wanted rather than
     forcing both to the same model; I believe it is correct because the surfaces ARE different
     instruments, but it is a learnable difference worth ratifying.
  4. **Keybinding modifiers (carried from the older open item, narrowed to pitch):** plain arrows =
     diatonic (staff), plus/minus = chromatic (canvas + staff alias), Shift = octave, Ctrl/Cmd =
     chromatic on the staff arrows. Confirm Shift=octave (vs PageUp/PageDown) is the preferred octave
     modifier for a uniform plain/Ctrl/Shift story.

## Smart Edit Mode: edit the staff directly, sheet becomes source of truth (epic interaction spec)

- **2026-06-04 - Interaction + visual spec for "Smart Edit Mode": a simplified MuseScore-style
  editor layered ON the OSMD/VexFlow staff. The user edits notation directly on the engraved
  staff, the staff re-renders live, and the SHEET becomes the single source of truth that the
  falling-notes view and audio are re-derived from. This SUPERSEDES the #6 "Correct Mode" mental
  model (edit-on-falling-canvas, sheet stays a frozen reference) once it ships: the surface of
  truth flips from the falling canvas to the staff. Tech Lead owns rendering/round-trip
  feasibility in parallel; this entry is interaction + visual only and assumes we can (a) render
  an editable staff and (b) place click targets on noteheads. The notehead-geometry hook already
  exists: `readNotePositions` in `src/sheet-overlay.ts` walks every `GraphicalNote`,
  `getSVGGElement()` + `getBoundingClientRect()` -> `{ midi, x, y, spelling }` in scrolled `#sheet`
  coords, and has the OSMD `sourceNote` + `staffEntry` in hand. That is exactly the hook for hit
  targets, selection geometry, and measure membership.**

  ### Decision 0 (FRAMING) - the staff is the editor; the falling view is a live mirror, not a second editor

  In Edit mode you edit the STAFF only. The falling-notes canvas keeps rendering live (so you see
  pitch/rhythm changes fall as you make them), but it is READ-ONLY while editing: no selection
  cursor, no hit-testing, no edit panel on the canvas. One surface of truth removes the "which
  view wins" ambiguity that #6's divergence banner had to paper over. Rationale: musicians reason
  about correctness ON the staff (that is the document they are checking against), the OMR error
  we most need to fix is rhythm/duration which only reads clearly as notation, and a single edit
  surface halves the interaction + a11y surface area. The falling view earns its keep as instant
  feedback ("did that fix land?") without being a competing editor. When Edit mode is OFF the app
  is exactly today's player. The #6 falling-canvas editing surface is RETIRED when this ships (do
  not maintain two editors); its dashed-edited-marker and divergence banner are no longer needed
  because the sheet now reflects the edit (no divergence to mark).

  ### Decision 1 - mode model: one explicit Edit toggle; a Select default sub-mode and a Note-input sub-mode inside it; playback is mutually exclusive with editing

  - **Top-level: an explicit "Edit" toggle** replacing the #6 "Correct" button in `group-settings`
    (Heroicons `pencil-square`, `aria-pressed`, state-explicit title). OFF by default = today's
    pure player, zero edit overhead. Always-on rejected for the same reasons as #6 (do not steal
    clicks / run edit machinery for someone who just wants to watch).
  - **Two sub-modes inside Edit, MuseScore's core split, kept to two (not MuseScore's many):**
    - **Select (default on entering Edit).** Click/arrow to select existing notes/rests and modify
      them (pitch, duration, accidental, hand, delete). The pointer is the default arrow.
    - **Note-input (armed).** An insertion CURSOR appears and clicks/keys ADD notes at the cursor.
      Entered with **N** (MuseScore's muscle-memory key) or a "+ Add notes" button in the edit
      toolbar; **Esc or N again** returns to Select. The pointer is a crosshair while armed. This
      is the one MuseScore convention worth importing wholesale because millions already know "N =
      note input"; everything else we simplify.
    - **Why a real armed sub-mode and not #6's one-shot "click to place one note":** rhythm
      correction means entering RUNS of notes (a mis-scanned beamed group becomes four clean
      sixteenths). A sticky note-input cursor that advances after each entry makes a run fast; the
      one-shot add re-arms every note and is painful past the first. Keep the cursor sticky and
      advancing, MuseScore-style.
  - **Playback vs editing are mutually exclusive (inherit + tighten #6).** Entering Edit pauses
    playback. Pressing Play from within Edit is allowed but it EXITS to a still, watchable state:
    selection/cursor suspend, the edit toolbar hides, the staff is not hit-testable while the
    cursor sweeps. Pause returns you to where you were (same selection if it still exists). You
    never edit a moving target, and "hear it" (Decision 4) is a SCOPED loop, not general Play, so
    it does not trip this. The OSMD playback cursor (green box) sweeps during Play as today; the
    edit insertion cursor is a separate object only visible while editing + paused.

  ### Decision 2 - the per-operation interaction model (mouse path + keyboard path)

  Selection target = a notehead (or a rest glyph). Hit area is the notehead bbox PADDED to a
  >=24px CSS hit square (noteheads render ~10px; an invisible padded `<button>`-like hot zone per
  note in the overlay layer gives a real tap target without changing the engraving). One selection
  at a time in v1 (multi-select deferred).

  | Operation | Mouse path | Keyboard path |
  | --- | --- | --- |
  | **Select a note/rest** | Click the notehead/rest (its padded hot zone). | Enter Edit -> first note auto-selected; **Left/Right** = previous/next note IN STAFF ORDER (across the grand staff by musical time, see grand-staff note); **Home/End** = first/last note of the measure. |
  | **Move pitch** | **Vertical drag** the notehead: it snaps to staff steps (diatonic line/space) as you drag, live-previewing; release commits. Horizontal drag does nothing (time is fixed, Decision 3). | **Up/Down = diatonic step** (next staff position, key-signature aware so Up from E in C-major is F, not E#). **Ctrl/Cmd+Up/Down = chromatic semitone** (raw +-1, for when you truly want the accidental). **Up/Down+Octave via Ctrl+Shift or PageUp/PageDown = +-octave.** Diatonic-on-plain-arrows matches MuseScore and is what "move it up a line" means to a musician; chromatic is the modifier. |
  | **Set duration** | A small **duration toolbar** (the edit toolbar's primary row): whole/half/quarter/eighth/16th buttons + a dotted toggle. Click a value to set the selected note's (or the about-to-be-entered note's) duration. | **MuseScore's real number keys, restricted to the five durations in scope: 6=whole, 5=half, 4=quarter, 3=eighth, 2=sixteenth; . (period) toggles dot.** The number keys are the fast path for the frequent rhythm-fix case; the toolbar is the discoverable mirror. Both highlight the active duration. |
  | **Add a note** | In Note-input (armed): the insertion cursor sits at a time position; **click a staff line/space** to place a note of the current duration at that pitch, then the cursor ADVANCES by that duration. Click placement uses y -> nearest diatonic step, key-sig aware. | In Note-input: **A-G enter that letter** at the nearest octave to the previous note (MuseScore's letter entry), of the current duration; cursor advances. Duration chosen FIRST via number keys, then the letter, MuseScore-style ("4 C" = quarter C). **Up/Down after entry** nudges the just-entered note by octave/step. |
  | **Add a rest** | Note-input: a **rest button** in the duration toolbar, or set duration then click the rest button; places a rest of the current duration and advances. | **0 (zero) = enter a rest** of the current duration (MuseScore's key), cursor advances. |
  | **Delete** | Select -> trash button in the edit toolbar. | **Delete/Backspace.** Per Decision 3 this turns the note into a REST of the same duration (fixed-bar), it does not pull later notes left. |
  | **Toggle accidental** | Three small accidental buttons (flat / natural / sharp) in the edit toolbar, shown for the selected note; click sets that note's accidental. | One keyboard accidental affordance to avoid clashing with rest(0)/octave: **Ctrl/Cmd+Up/Down = chromatic re-spell** (raises/lowers by semitone, which is how you reach a sharp or flat), with the toolbar carrying explicit natural. Announce the resulting spelling. |
  | **Move note to other hand/staff** | Drag the notehead vertically across the staff gap onto the other staff (it re-homes to that staff, keeping pitch); OR a "send to other staff" button in the edit toolbar. | **Ctrl/Cmd+Shift+Up/Down = move to staff above/below** (MuseScore's cross-staff move), pitch preserved. Announce "Moved to left hand". |

  Notes on the table: where two desirable keybindings collide (accidentals vs rests vs octave),
  the rule is **number row = durations + rest(0), letter keys = pitch entry, plain arrows =
  diatonic pitch, modifiers (Ctrl/Cmd, Shift) = chromatic / octave / cross-staff.** That keeps the
  unmodified keys for the two highest-frequency actions (set duration, move pitch) and pushes the
  rarer ones onto modifiers, so the frequent rhythm-fix flow ("select the note, hit 3 to make it
  an eighth") is single-keystroke.

  ### Decision 3 - fixed-bar duration model + the "bar doesn't add up" indicator

  Duration edits are MuseScore-style FIXED-BAR: changing a note's duration does NOT ripple later
  notes. Lengthening overwrites the time it now covers (the next note(s) it swallows become
  shorter/removed per MuseScore's overwrite); shortening leaves a REST in the freed time; deleting
  leaves a rest. Nothing after the edit shifts in time, so the rest of the measure stays put and
  predictable. This is the right model for CORRECTION (you are fixing one wrong duration, not
  re-typesetting the bar) and it keeps onsets stable so the falling view + audio re-derive without
  a global reflow.

  - **"This measure does not add up" indicator.** When a measure's durations do not sum to the
    meter (under or over), flag THAT measure, do not block editing (half-corrected bars are a
    normal intermediate state). Treatment: a **2px brass left-edge bracket on the measure** plus a
    small **brass caution glyph in the measure's top-left margin** (a `!` in a ~14px rounded
    brass chip, `--accent` fill, `--on-accent` ink so it passes contrast). Hover/focus the chip ->
    tooltip + aria text: "This measure has 3.5 beats, the time signature is 4/4." Under-full and
    over-full read the same chip; the tooltip states which. Brass (not red) because this is a
    gentle "still in progress" nudge in a brass-on-dark palette, not an error; reserve any future
    red strictly for destructive/illegal. The chip lives in the overlay layer at the measure's
    bbox top-left, so it scrolls with the staff.
  - **Why fixed-bar over ripple/insert:** ripple (later notes shift) is a composition gesture and
    makes every duration edit reflow the whole piece, which is disorienting when you are spot-fixing
    a scan and watching the falling view. Fixed-bar = local, reversible, and matches the tool's
    job. Flag-don't-block keeps the user in flow.

  ### Decision 4 - visual language (all on the cream `#f6f1e6` paper, brass-brown ink world)

  The editor must stay legible on the existing cream sheet pane. The annotation ink is brass-brown
  `#6b4f1f`; selection/active uses the brass `--accent #d8a23a` / `--focus-ring #f0c66b` family,
  NOT the dark-stage tokens (those are for the falling canvas). Everything below lives in an
  overlay layer above the SVG (the proven `#sheet-labels` pattern: absolutely positioned in the
  scrolled box, scrolls natively, but this NEW layer DOES take pointer events for the hot zones).

  - **Selection:** a **brass rounded-rect halo** around the selected notehead (2px `--focus-ring`
    stroke + a soft `--accent-glow` outer glow), drawn in the overlay so it floats over the
    engraving without recoloring it. The selected note's stem/flag tint to `--accent` if cheap via
    OSMD, else the halo alone carries it. One selection at a time.
  - **Note-input insertion cursor:** a **vertical brass caret** (2px `--accent`, ~1 staff-height
    tall) at the insertion time-x, spanning the active staff, with a faint brass wash on the target
    line/space the next note would land on as the pointer/selected-pitch moves. It must read as
    distinct from the green OSMD PLAYBACK cursor: playback cursor is the existing translucent green
    box (sweeps during Play); the edit caret is a thin brass vertical line (static, only in Edit).
    Different color + different shape = no confusion.
  - **"Bar doesn't add up":** the brass left-bracket + `!` chip from Decision 3.
  - **Original-vs-edited:** because the sheet is now re-rendered from the edits, an edited note is
    just part of the engraving (no per-note divergence marker needed, unlike #6). Instead, offer a
    quiet, OPTIONAL **"show original scan" ghost**: a toggle that overlays the pre-edit notehead
    positions as faint brass-brown ghosts (~30% ink) so the user can compare against the raw scan.
    Off by default; it is a triage aid, not always-on clutter. (This replaces #6's mandatory dashed
    marker: divergence-from-scan is now opt-in comparison, not a permanent warning, since the staff
    is correct by construction.)
  - **Low-confidence (OMR uncertainty) highlight:** notes the scanner is unsure about get a
    **faint brass UNDERLINE/tint under the notehead** (a ~3px brass-brown soft bar, ~40% alpha) so
    the eye is drawn to triage them, distinct from selection (a full halo) and from the
    bar-doesn't-add-up (a measure-level bracket). Needs a per-note confidence from the OMR pipeline
    (Tech Lead: thread a `confidence` through to the geometry records the way `spelling` already
    rides along). If confidence is unavailable for a source, draw nothing (no false alarms).
  - **Rests:** rests are first-class selectable glyphs; selecting one shows the same brass halo
    sized to the rest glyph. A rest that resulted from a duration-shorten/delete is just a normal
    rest (no special mark) so the staff stays clean.

  ### Decision 5 - the "smart" assists, surfaced without clutter

  All three live in a single small **"Assist" cluster** in the edit toolbar (an outline
  `sparkles`/wand affordance), so they are discoverable but not spread across the chrome:

  - **Jump to least-confident note:** a button (and key **J**) that selects + scrolls to the
    lowest-confidence un-reviewed note, then the next on each press. This turns "fix the scan" into
    a guided pass instead of hunting. Announce "Jumped to a low-confidence note, measure 12." Once
    a note is edited or explicitly OK'd (an "ok" key, e.g. **K**), it drops out of the queue. If no
    confidence data, the button is hidden (not dead).
  - **Hear the selection / loop a bar:** a **play-glyph in the edit toolbar** (key **Space while a
    note is selected** = play just the selection; **Shift+Space** = loop the selected note's
    MEASURE). This reuses the existing audio pipeline scoped to a time window; it is NOT general
    transport so it does not trip the "Play exits edit" rule (Decision 1). A small looping
    indicator (brass pulse on the measure bracket) shows what is sounding; Esc stops. This is the
    single most useful assist for rhythm work: you fix a duration, tap Space, hear if it is right.
  - **Re-OMR a region (lasso a messy measure):** a **lasso tool** (key **L** or a marquee button)
    lets the user drag a rectangle over a botched measure; on release, show a compact
    **"Re-scan this measure?"** confirmation (brass outline over the selection) and a "Re-scan"
    button. The crop is sent back through the OMR path (Tech Lead) and the returned notes REPLACE
    that measure's notes (fixed-bar boundaries keep neighbors intact). Show the scan spinner scoped
    to the selection (reuse the #86 spinner, small). This is the heavy-hammer escape hatch when
    note-by-note fixing a mangled bar is slower than just re-reading it. Keep it behind an explicit
    drag+confirm so it never fires by accident.

  Cluster, do not scatter: the three assists share one toolbar group with the wand glyph so the
  edit toolbar stays = [duration row] [accidentals] [delete] [hand] [assists]. On phone the
  assists collapse into an overflow "More" menu (the toolbar is space-constrained, per #33).

  ### Decision 6 - the edit toolbar: a contextual bar docked to the sheet pane, not floating per-note

  Unlike #6's per-bar floating panel (which chased fast falling bars), the staff is static while
  editing, so dock a **single contextual edit toolbar to the top of the `#sheet` pane** (a thin
  brass-bordered strip on the cream paper, appearing only in Edit mode). It shows global controls
  (duration row, note-input toggle, assists) always, and the per-selection controls (accidentals,
  delete, hand-move) enable/disable based on whether a note is selected. Docked-not-floating
  because the staff does not move, the controls are always in the same place (learnable), and it
  never occludes the note you are editing. It collapses responsively like the main toolbar (#84/#85).

  ### Decision 7 - accessibility (parity with the existing aria-live + keyboard bar)

  - The `#sheet` pane becomes a **`role="application"` with `tabindex="0"`** ONLY in Edit mode,
    with an `aria-label` enumerating the edit keys (mirrors #6's stage treatment). The OSMD SVG is
    `aria-hidden` (it is decorative engraving); the SEMANTIC model is announced via aria-live.
  - **Every edit announces via the existing `#edit-live` polite region:** select ("Selected C4,
    quarter note, right hand, measure 3"), pitch ("Raised to D4"), duration ("Changed to eighth
    note"), accidental ("F sharp 4"), add ("Added quarter C5"), rest ("Quarter rest"), delete
    ("Deleted, now a quarter rest"), cross-staff ("Moved to left hand"), bar-warning ("Measure 3
    now has 4 and a half beats"), assist jumps, and loop start/stop. The note-input cursor
    announces its landing target as it moves ("Cursor on beat 3, B line").
  - **Fully keyboard-drivable note entry** is a hard requirement: the A-G + number-row + arrows
    model above means a screen-reader user can enter a run of notes with no pointer. The lasso
    re-OMR is the one pointer-first assist; give it a keyboard fallback = **"Re-scan current
    measure" (Shift+L)** that re-scans the measure containing the selection, so even the heavy
    assist has a no-pointer path.
  - Focus ring = shared `--focus-ring`. Reduced-motion: the selection halo and loop pulse are
    static (no animation), matching #86/#6.

  ### Open decisions for the main agent / user (call these out)

  1. **(BLOCKING, owned by Tech Lead) sheet round-trip feasibility.** This whole model assumes we
     can re-render the OSMD/VexFlow staff from an edited model live. #6 deferred exactly this
     ("OSMD round-trip", #6d). If full live re-render is not feasible v1, the FALLBACK is: keep
     editing on the staff (selection + the brass overlay), but defer the live re-engrave and
     instead re-derive only the falling view + audio immediately, re-rendering the staff on a
     debounce or an explicit "apply". Design works either way; the user should know which one Tech
     Lead can deliver because it changes how "live" the staff feels.
  2. **Keybinding conflicts to ratify.** I reserved number row = durations + 0=rest, letters =
     pitch entry, plain arrows = diatonic pitch, modifiers = chromatic/octave/cross-staff. This
     drops MuseScore's exact accidental keys in favor of Ctrl+arrow chromatic + toolbar buttons, to
     keep unmodified keys for the frequent actions. Confirm that simplification is acceptable
     (musicians coming straight from MuseScore lose the `-`/`up-arrow`-spells-up reflex but gain a
     less crowded keymap).
  3. **Confidence data availability.** Jump-to-least-confident and the low-confidence highlight
     need a per-note confidence from the OMR pipeline. If geom/Clarity do not expose it cleanly,
     these two assists ship dark (hidden) and the rest stands. Worth a Tech Lead/PM check on
     whether confidence is threadable like `spelling` is.
  4. **Does Edit mode REPLACE Correct mode immediately, or ship alongside it for a release?** I
     recommend replace-on-ship (one editor), but if the staff round-trip lands behind the falling
     edits, we might keep #6's falling editor for single-staff/audio scores that have no sheet to
     edit. Audio-derived scores have NO staff, so Smart Edit Mode is inherently sheet-only; those
     scores either keep the #6 falling editor or are simply not editable until they have a sheet.
     Flagging because it affects whether #6 code is deleted or retained for the no-sheet case.

  ### Tokens / classes introduced (for the Tech Lead)
  - Reuse `--accent`, `--accent-glow`, `--focus-ring`, `--on-accent`; annotation ink `#6b4f1f`.
  - New overlay layer `#sheet-edit-layer` (pointer-events: auto, above `#sheet-labels`) holding:
    `.note-hotzone` (>=24px padded hit target per note), `.note-selected-halo`, `.input-caret`,
    `.measure-warn` (bracket + `.measure-warn-chip`), `.note-lowconf`, `.scan-ghost`.
  - `.edit-toolbar` docked to `#sheet` top with `.edit-tool-group` clusters (duration / accidental
    / delete / hand / assist). New `Edit` toggle replaces `.correct-toggle`.
  - Per-note `confidence?: number` threaded onto the geometry record alongside `spelling` (Tech
    Lead). Edit state (mode, sub-mode, selectedId, input-cursor position) lives in main.ts.

## OMR correction UI v1 (issue #6 / #6a): select + nudge pitch + delete + add (interaction spec)

- **2026-05-31 - Build-ready interaction + visual spec for the first shippable correction
  slice. Edits run against the in-memory `score.notes` array; the falling view and audio
  re-sync for free via `visualizer.setNotes` + the existing Part rebuild (`loadNotes`). The
  OSMD sheet is NOT written back in v1.**

  ### Decision 1 (BLOCKING) - sheet divergence: keep the sheet authoritative, mark the EDIT on the falling view, banner the divergence. Chosen (c)+(a), rejected (b).

  When an edit makes the falling view disagree with the printed OSMD sheet, the sheet stays
  visible and UNCHANGED (it is still the user's ground truth, the thing they are checking
  against), and the DIVERGENCE is made legible on the falling side plus a one-line app-level
  notice. Specifically:
  - **Edited notes wear a persistent "edited" marker on the falling bar** (a thin dashed
    `--accent` brass outline around the whole bar, drawn after the body fill, independent of
    the #27 contact stroke and #131 active fill so it reads at any moment). This is the (c)
    leg: the bars the user changed are always identifiable, so "this no longer matches the
    sheet" is visible per-note, not just globally. Deleted notes leave no bar (nothing to
    mark); added notes get the same dashed marker since they too are absent from the sheet.
  - **A single quiet status line** appears once the score has any edit: "Edited. The sheet
    below still shows the original scan." in the existing `#track-status` slot styling
    (muted ivory). This is the (a) leg: it names the divergence honestly in one place
    without nagging. It clears on a fresh load.
  - **Rejected (b) hide/dim the sheet:** the synced sheet is the differentiator AND the
    reference the user is correcting against. Dimming it removes the very thing that lets
    them judge whether their fix is right. Divergence is the honest state of a half-corrected
    score, so SHOW it, do not hide it. Writing back to the sheet (closing the divergence) is
    real value but is the OSMD-round-trip research problem (#6d); deferring it is why the
    marker + banner exist as the honest interim.
  - **Why authoritative-sheet over authoritative-falling:** the user trusts what they
    uploaded. Until we can re-render the sheet from edits, the falling view is the "working
    copy" and the sheet is the "original" - exactly the mental model the banner states.

  ### Decision 2 - selection + edit affordances

  - **Select:** click/tap a falling bar. Hit-test against the same geometry
    `drawFallingNotes` already computes (x, top, w, barHeight per visible note); pick the
    topmost bar under the pointer. Requires a stable id on `VisNote` (Tech Lead adds `id`).
    Only visible (on-screen) bars are selectable in v1; to reach a note, seek/scrub it into
    the lane. Keyboard: Tab moves focus to the stage; Left/Right arrows are already taken by
    prev/next-note and Space by play, so selection uses **Up/Down to move the selection to the
    nearest earlier/later onset** while the stage is focused.
  - **Selected state:** solid 2px `--focus-ring` (#f0c66b) outline around the bar plus a soft
    brass halo (canvas `shadowColor --accent-glow, shadowBlur 12`), drawn over the dashed
    edited-marker if both apply. One selection at a time.
  - **Edit controls = a small floating "edit panel" anchored near the selected bar**, NOT
    inline icons on every bar (inline buttons on fast-falling bars are un-clickable and clutter
    the lane). The panel is a compact horizontal toolbar that appears on selection, pinned just
    above the keybed at the bar's x (clamped on-screen); it does not chase the falling bar.
    Contents, left to right:
    - **Pitch down** icon button (downward chevron), aria "Lower a semitone", shortcut **`-`**.
    - **Pitch up** icon button (upward chevron), aria "Raise a semitone", shortcut **`+`**.
    - Live **note readout** between them (e.g. "C4" / "Do4") so the user sees the pitch as they
      nudge, in the current Names mode.
    - **Delete** icon button (trash glyph), aria "Delete this note", shortcut
      **Delete/Backspace**.
    - Close affordance: Escape, or click empty stage, just deselects.
  - **Add a missed note (full-epic scope, kept minimal):** a single **"Add note"** affordance.
    Enter add-submode from a small "+ Add note" text button shown in the panel's empty state
    (when Correct mode is on and nothing is selected, see Decision 3). In add-submode the
    pointer is a crosshair; a click on the lane creates a note at that key (x -> nearest key ->
    midi) and that time (y -> currentTime offset via pps), default duration one beat (fallback
    0.5s), hand "unknown". The new note auto-selects so the user can immediately nudge its
    pitch. Escape cancels. Copy: "Add note" / while armed "Click the lane to place a note. Esc
    to cancel."
  - **All edit copy uses ASCII only, no em dashes.**

  ### Decision 3 - mode model: a distinct, explicit "Correct" mode toggle. Editable while paused; NOT while playing.

  - Correction is **OFF by default** and toggled by a new ghost toolbar button **"Correct"**
    (Heroicons `pencil-square`, outline; in `group-settings` next to Names). `aria-pressed`
    mirrors #37's pattern. When ON, the stage shows the selection cursor / hit-testing and the
    edit panel; when OFF, the stage is purely a player (today's behavior, zero overhead).
    Always-on was rejected: hit-testing every click would steal taps from a user who just
    wants to watch, and the marker/banner machinery should not run for non-editors.
  - **Coexistence with playback:** entering Correct mode **pauses** playback if playing; the
    transport stays usable (scrub/step to bring a note into the lane), but **editing is only
    allowed while paused.** Pressing Play while in Correct mode keeps the mode on but
    **suspends selection** (panel hides, bars not clickable) until paused again, so a moving
    target is never edited. You correct a still frame, you watch it move. Edits apply on
    pause-resume since they already rebuilt the Part.

  ### Decision 4 - accessibility + discoverability

  - **Discovery:** on the FIRST successful scan/transcribe load, show a one-time dismissible
    tip in `#track-status`: "Scanned notes can be wrong. Click Correct to fix pitches or
    remove stray notes." (Direct MusicXML loads, trusted, get no tip.) The "Correct" button is
    a permanent labeled toolbar control so it is always findable.
  - **A11y:** "Correct" is a real `<button aria-pressed>` with a state-explicit title
    ("Correction mode off. Click to fix scanned notes." / "...on. Click to exit."), matching
    the #37 hand-toggle wording rule. The stage becomes `tabindex="0"` only in Correct mode
    with `role="application"` and an `aria-label` describing the arrow/edit keys; edit-panel
    buttons are normal focusable buttons with aria-labels + the shortcuts above. Selecting a
    bar fires an `aria-live="polite"` announcement ("Selected C4, right hand."); nudge/delete/
    add each announce the result ("Raised to C#4", "Note deleted", "Added C4"). Focus ring is
    the shared `--focus-ring`. Reduced-motion: the selection halo is static (no pulse).

  ### Defer to later slices (explicit non-goals for v1)

  - **Sheet write-back / closing the divergence** (the OSMD round-trip): #6d. The dashed
    marker + banner are the interim.
  - **Duration editing** (#6b) and **drag-to-move time** of a note: out. Pitch nudge + delete
    + basic add only.
  - **Multi-select, undo/redo history, persistence across reload:** out (no persistence layer
    exists; an edit lives for the session, like the #44 rename).
  - **Editing off-screen notes directly / a flat note-list editor:** out; v1 reaches notes by
    scrubbing them into the lane. A list editor is a strong later surface.
  - **Add-note hand assignment UI:** v1 adds as "unknown" (no cap, full velocity). Choosing
    left/right for an added note is deferred.

  ### Tokens / classes introduced
  - `.correct-toggle` (reuses `.toggle` base); the dashed edited-marker is canvas-drawn in
    `--accent`, not a class; `.edit-panel` + `.edit-panel-btn` (reuse ghost-button tokens,
    44px tap targets on phone per #33/#84). New `VisNote.id` (Tech Lead). Edited-set +
    selected-id live in main.ts state alongside `score`.

## Falling-bar active highlight (issue #131)

- **2026-05-31 - The brighter "active" fill is per-bar, gated on that bar's own time
  window (`fallingBarActive`), NOT pitch-keyed. Two stacked same-pitch bars (e.g. two "La")
  must never both light: only the one whose window contains currentTime (it has reached the
  keybed) reads as the contact moment; the in-flight twin stays calm in its base hue. The
  keyboard KEY light stays pitch-keyed on purpose (a physical key is one object), and the
  label ink (`barGlyphIsDark` active flag) is correctly tied to per-bar active so the
  brighter active fill always gets matching-contrast glyphs. Distinct-pitch chords and
  single notes are unaffected (each has its own window). The window is half-open on the
  release edge (`[time, time+duration)`): a legato same-pitch repeat where note2.time ==
  note1.time + note1.duration hands the active fill straight to the arriving onset note
  instead of lighting both for the seam frame. `activeMidis` (keyboard key light) reuses
  the same `fallingBarActive` window, so bar and key never drift on the boundary rule.**

## Theme: "Nocturne" (issue #127)

- **2026-05-31 - Replaced the generic violet theme (it read as default "vibe-coded" AI
  styling) with "Nocturne": a grand piano on a darkened concert stage. The instrument IS
  the palette: ebony body, ivory keys, a single brass/gold accent for lamp-light on the lid
  and the brass pedals. Almost nobody ships a brass-on-dark UI, so it reads as craft, not
  default. The dark stage is honest for this app: the falling-notes view is a performance
  surface, so it should recede (house lights down) and let the colored notes glow.**

  ### Palette (the source of truth is `src/style.css` `:root`)
  - `--bg #0b0a0d` warm ebony, `--text #efe9dc` warm ivory.
  - `--accent #d8a23a` brass, `--accent-deep #a9761f`, `--accent-glow rgba(216,162,58,0.55)`.
  - `--focus-ring #f0c66b`. Muted ivory text at 0.62, faint at 0.40.
  - All surface tokens (bar/secondary/ghost) re-tinted ivory-on-charcoal; they only tint
    **brass** on hover/active, never violet.

  ### Decisions that are easy to get wrong
  - **Brass is a LIGHT accent.** White-on-brass fails contrast (~2.3:1). The one filled-brass
    surface (the Play hero) uses near-black ink `--on-accent #1a140d` (~7:1, AA). Do not put
    white text on a brass fill.
  - **Paper belongs to the sheet pane only.** The Todeo "real paper" analogue is the cream
    `#f6f1e6` sheet-music pane with brass-brown ink `#6b4f1f`, NOT the app background. The
    flagship falling-notes stage must stay dark ebony so the note hues pop.
  - **Wordmark = editorial serif** (`--font-display`, system serifs, no network font) for a
    concert-program feel; everything else stays system sans.
  - **Keybed is literal:** ivory white keys `#f1ead9`, ebony black keys `#0d0b08`, warm felt
    `#17140f` behind, brass rim-light gradient over the top edge.

  ### Pitch-class hue wheel re-anchored 276 -> 40 (`src/piano.ts pitchHue`)
  C/Do now lands on the brand brass (hue 40) instead of violet (276), removing the last
  prominent violet. The other 11 pitch classes still span the full wheel (a rainbow). The
  #67 glyph-contrast machinery self-corrects from the new hues; the two color tests
  (`piano.test.ts`, `visualizer-color.test.ts`) carry the shifted expected values. After
  re-anchor, the light-bar (dark-ink) pitch classes are C/E/F; dark-bar (light-ink) are
  G/A/B.

  ### Verified WCAG AA: ivory-on-ebony ~15.8:1, brass-as-text ~8.9:1, dark-ink-on-brass ~7:1.

## Scan / transcribe loading overlay (issue #86)

- **2026-05-31 - Build-ready spec: replace the easy-to-miss `#track-status` line ("Scanning
  sheet... (this can take a minute)") with a full-stage blocking overlay for the ~1-minute OMR
  scan AND audio transcription. The status line is too quiet for a minute-long wait tucked next
  to the tempo control; a centered overlay over the stage gives the wait the weight it deserves
  and stops the user from poking dead controls while the job runs.**

  ### Decision 1 - blocking overlay, NOT inline progress

  **Chosen: a blocking overlay that covers the stage (sheet + keyboard area), not the toolbar.**
  Justification for a ~1-minute indeterminate op: (a) nothing in the app is usable until the
  score arrives (the canvas is empty, transport is disabled by `setBusyUI`), so there is no
  reason to keep the stage interactive behind a thin inline bar; (b) a centered overlay is
  impossible to miss, which is the whole complaint; (c) it gives room for a clear "this takes
  about a minute" expectation so the user does not think the app froze. An inline bar repeats the
  current too-subtle pattern. The overlay sits OVER the stage only and leaves the toolbar visible
  (the toolbar is already greyed by `setBusyUI` disabling its controls), so the brand/context
  stays on screen and the overlay reads as "the work area is busy".

  ### Decision 2 - exact content (no em dashes, ASCII only)

  - **Heading:** scan -> "Scanning your sheet"; audio -> "Transcribing your audio".
  - **Body copy:** "This usually takes about a minute. Hang tight while we read the notes."
    (one line; the second clause is dropped on the narrow phone layout, see responsive).
  - **Indicator:** an indeterminate **ring spinner** (not a bar). A determinate bar would lie
    (we have no real progress from the server poll). A 44px ring, 3px stroke, violet
    (`--accent`) arc on a faint track, rotating. Reduced-motion swaps to a static pulsing dot
    (see a11y). Place the spinner ABOVE the heading.
  - **Cancel affordance:** YES, a ghost "Cancel" button. The OMR job runs server-side and we
    cannot abort the remote work, so Cancel is a CLIENT-SIDE ABANDON: it sets a flag the poll
    loop checks (`pollOmrResult` rejects with a sentinel "cancelled" the `scanSheet`/
    `transcribeAudio` finally-block treats as a non-error), closes the overlay, runs
    `setBusyUI(false)`, and restores the prior slot via `restoreSheetName()` (or the boot
    placeholder if no score was loaded). It does NOT alert. Copy under the button, faint:
    "The scan keeps running on our side, this just stops waiting." Tech Lead owns the poll-loop
    abort wiring; design only requires the button + that it dismisses the overlay and re-enables
    controls.

  ### Decision 3 - markup + CSS (matches the dark/violet theme, uses existing tokens)

  Add ONE overlay node inside `#app` (sibling of `#sheet`/`#stage`, after `#stage` so it stacks
  above), default `hidden`:

  ```html
  <div id="scan-overlay" class="scan-overlay" role="dialog" aria-modal="true"
       aria-labelledby="scan-overlay-title" aria-describedby="scan-overlay-body"
       aria-busy="true" hidden>
    <div class="scan-overlay-card">
      <div class="scan-spinner" aria-hidden="true"></div>
      <h2 id="scan-overlay-title" class="scan-overlay-title">Scanning your sheet</h2>
      <p id="scan-overlay-body" class="scan-overlay-body">
        This usually takes about a minute. Hang tight while we read the notes.
      </p>
      <button id="scan-overlay-cancel" class="scan-overlay-cancel" type="button">Cancel</button>
      <p class="scan-overlay-note">The scan keeps running on our side, this just stops waiting.</p>
    </div>
  </div>
  ```

  JS: a `showScanOverlay(kind: "scan" | "audio")` sets the title ("Scanning your sheet" /
  "Transcribing your audio") and clears `hidden`; `hideScanOverlay()` restores `hidden`.
  `scanSheet`/`transcribeAudio` call show on start and hide in `finally`. Keep `showStatus` too as
  a quiet fallback for the toolbar slot (harmless), but the overlay is the primary feedback.

  ```css
  /* Scan / transcribe loading overlay (issue #86). Covers the stage area, not the toolbar. */
  .scan-overlay {
    position: absolute;
    inset: 0;
    z-index: 5; /* above #sheet (z-index unset) and #stage; below nothing that matters */
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1.5rem;
    background: rgba(10, 7, 18, 0.72); /* --bg at 0.72 so the stage dims through it */
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
    animation: scan-overlay-in 0.18s ease both;
  }
  .scan-overlay[hidden] { display: none; }

  .scan-overlay-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    gap: 0.9rem;
    max-width: 22rem;
    padding: 2rem 2.25rem;
    border-radius: 16px;
    background: var(--bar-surface);
    border: 1px solid var(--bar-border);
    box-shadow:
      0 1px 0 rgba(255, 255, 255, 0.04) inset,
      0 18px 50px rgba(0, 0, 0, 0.55),
      0 0 40px rgba(177, 75, 255, 0.12); /* faint violet bloom ties it to the brand */
  }

  .scan-spinner {
    width: 44px;
    height: 44px;
    border-radius: 50%;
    border: 3px solid rgba(232, 224, 245, 0.14); /* faint track */
    border-top-color: var(--accent);            /* the rotating violet arc */
    animation: scan-spin 0.85s linear infinite;
  }

  .scan-overlay-title {
    font-size: 1.05rem;
    font-weight: 600;
    color: var(--text);
    letter-spacing: 0.01em;
  }
  .scan-overlay-body {
    font-size: 0.9rem;
    line-height: 1.4;
    color: var(--text-muted);
  }

  .scan-overlay-cancel {
    margin-top: 0.25rem;
    background: var(--ghost-bg);
    color: var(--text);
    border: 1px solid var(--ghost-border);
    border-radius: 8px;
    padding: 0.5rem 1.4rem;
    font-size: 0.85rem;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
  }
  .scan-overlay-cancel:hover {
    background: var(--ghost-bg-hover);
    border-color: var(--ghost-border-hover);
    color: #fff;
  }
  .scan-overlay-cancel:focus-visible {
    outline: 2px solid var(--focus-ring);
    outline-offset: 2px;
  }
  .scan-overlay-note {
    font-size: 0.72rem;
    color: var(--text-faint);
    max-width: 18rem;
  }

  @keyframes scan-spin { to { transform: rotate(360deg); } }
  @keyframes scan-overlay-in { from { opacity: 0; } to { opacity: 1; } }
  ```

  ### Decision 4 - accessibility

  - **Dialog semantics:** `role="dialog" aria-modal="true"`, labelled by the title, described by
    the body, `aria-busy="true"` so AT announces a busy modal on open.
  - **Move focus IN on open:** focus `#scan-overlay-cancel` (the only actionable control) when the
    overlay shows. **Restore focus on close** to the element that had it before (the Scan / From
    audio file-button label); Tech Lead saves `document.activeElement` before `showScanOverlay`
    and refocuses it in `hideScanOverlay`.
  - **Focus trap:** only one focusable element (Cancel), so trap is trivial: keep Tab/Shift+Tab on
    the Cancel button (handle keydown, `preventDefault` when it would leave). Escape triggers the
    same path as Cancel (abandon + close).
  - **Reduced motion:** wrap the spinner spin and the overlay fade in
    `@media (prefers-reduced-motion: reduce)` to disable them. The spinner instead pulses opacity
    gently (a 1.4s ease-in-out `scan-pulse` between 0.4 and 1 opacity) so there is still a
    "working" signal without rotation; the overlay appears with no fade.
    ```css
    @media (prefers-reduced-motion: reduce) {
      .scan-overlay { animation: none; }
      .scan-spinner {
        animation: scan-pulse 1.4s ease-in-out infinite;
        border-top-color: var(--accent);
      }
    }
    @keyframes scan-pulse { 0%, 100% { opacity: 0.4; } 50% { opacity: 1; } }
    ```

  ### Decision 5 - same overlay for audio transcription? YES

  Use the SAME overlay for "Transcribing audio...". It is the identical UX (a ~1-minute opaque
  job with no real progress) and the weak-feedback complaint applies equally. Only the title and
  the implicit kind differ; one component, a `kind` arg flips the heading. Do not build two.

  ### Decision 6 - responsive / mobile

  - The overlay is `position: absolute; inset: 0` over the stage, so it tracks the stage at every
    breakpoint with no extra rules; the toolbar (which wraps per #84/#85) stays above it
    untouched.
  - At `<=720px`: shrink the card padding to `1.5rem 1.25rem`, cap `max-width` to
    `calc(100vw - 2rem)`, and drop the second body sentence ("Hang tight while we read the
    notes.") to keep the card short on a phone in landscape where the stage is short. Implement by
    putting the second sentence in a `<span class="scan-overlay-body-extra">` and
    `display: none` it at `<=720px`, OR just shorten the body string on small screens in JS. CSS
    span-hide is simpler and stateless; prefer it.
  - Cancel keeps the #33/#84 44px tap target on phones (its `padding` already yields ~40px; add
    `min-height: 44px` inside the 720px block to be safe).

## Glow only the contact note, not every in-flight bar (issues #27, #38)

- **2026-05-30 - Build-ready spec: kill the bright glow halo on EVERY falling bar; reserve
  glow for the single note touching the keybed (the #27 contact moment).** Root cause is the
  body fill in `drawFallingNotes` (`src/visualizer.ts` ~216-217): it sets
  `ctx.shadowColor = colors.glow; ctx.shadowBlur = isActive ? 20 : 18;` BEFORE every bar's
  `fill()`, so every in-flight bar wears an 18px colored halo and the whole lane reads as
  "all highlighted". #27's actual intent was a clean colored bar while falling, glow only on
  contact. The body hue (#12) and the #36 hand cap STAY; only the glow changes.

  ### Decision 1 - non-active (still-falling) bars: shadowBlur = 0, fully flat

  **Set `ctx.shadowBlur = 0` (no halo) for the body fill of non-active bars. Exact: 0px, not
  a small residual.** A residual 4-6px halo would just be a dimmer version of the same "row of
  glowing chips" the user is complaining about, and it muddies the gap between adjacent bars
  and softens the hand-cap edge. The body is already a saturated hue on near-black: it does not
  need a halo to pop, it needs clean edges so the eye can count and track individual notes.
  Flat bars also make the ONE contact glow unmistakable by contrast.

  ### Decision 2 - active/contact bars: glow lives ONLY on the #27 contact stroke

  **The body fill of active bars also gets `shadowBlur = 0`. Do NOT keep any body-fill blur on
  active bars. The glow comes solely from the existing #27 contact stroke (2px, `colors.glow`,
  `shadowBlur 22`, alpha 0.9).** Reasons: (a) `isActive` bars are the ones at/below the keybed
  i.e. they are already the contact bars, so a body blur here would re-introduce a halo on
  exactly the bars that also get the stroke, double-glowing them; (b) the contact STROKE is the
  designed "lights up on the hit" cue and it is enough on its own (a hue-colored 22px-blurred
  outline reads clearly as a flash); (c) one glow source = one clear focal point. Net: the body
  fill is flat for ALL bars; the only glow in the falling field is the contact stroke on the
  bar(s) currently touching the keyboard. This is exactly #27's original wording.

  ### Decision 3 - muted bars

  **Muted bars (alpha 0.3, #54) keep glow OFF like everyone now (their body is flat). They are
  already excluded from the contact stroke by `!muted` in the `inContact` guard, so a muted
  hand's notes fall flat and dim with no glow at all.** Correct: a muted hand should look quiet,
  and the existing `!muted` gate already does the right thing once the body halo is gone. No
  change to the mute path; it just stops inheriting the body halo.

  ### Build note

  In the body-fill block, replace `ctx.shadowColor = colors.glow; ctx.shadowBlur = isActive ?
  20 : 18;` with `ctx.shadowBlur = 0;` (one line). Everything below is unchanged: the #36 cap
  already sets `shadowBlur = 0`, the #27 contact stroke sets its own `shadowColor` + `shadowBlur
  22`, and the post-loop reset to 0 stays. No per-bar `measureText`, strictly cheaper in the rAF
  loop (one fewer shadow setup per bar; the GPU skips the blur pass on every non-contact bar).
  Verify on a rendered frame that the contact note still flashes and mid-screen bars are flat.

## Falling-note name legibility: contrast-aware glyph + narrow-bar overflow (issue #67)

- **2026-05-30 - Build-ready spec for two reported legibility defects on falling-note names:
  (1) white text washes out on the bright yellow/green/cyan hues (Mi/Fa/Sol/La), (2) names
  vanish on narrow bars (a ~10px white key on the 88-key desktop view drops 2-char names via
  the #39 width rule). Both fixes are in `src/visualizer.ts` (the label-collect loop ~243-261
  and the single label-paint pass ~270-284) plus new exports in `src/piano.ts`. No new deps,
  no per-bar `measureText`. Keep the #39 "no detached oversized pill" intent intact.**

  ### Decision 1 - contrast-aware glyph color (replaces the fixed white)

  **Switch from the fixed `rgba(255,255,255,0.82)` glyph to a per-bar two-pole glyph: a DARK
  glyph on light-luminance bodies, a LIGHT glyph on dark-luminance bodies, chosen from the
  bar's OWN fill luminance.** White-on-everything fails because body luminance swings hard
  across the hue wheel: violet/blue bodies (Do 276, Si 246) are dark enough for white text,
  but the yellow-green/cyan bodies (Fa 66, Sol 126, La 186) at L 62-72% are far too light, so
  white text drops to ~1.4-2.0:1. A luminance-picked glyph keeps the name above ~4.5:1 on
  every hue. This is the same dual-luminance robustness move already adopted for the #36 hand
  cap; apply it to the glyph.

  - **Light glyph (on dark bodies):** `rgba(255, 255, 255, 0.95)` (near-opaque; the body it
    sits on is dark so it can be brighter than the old 0.82 without halation).
  - **Dark glyph (on light bodies):** `rgba(10, 7, 18, 0.92)` (the `--bg`-family near-black,
    matching the #36 dark cap, so the palette stays one ink).
  - **Picker (cheap, branch-only, no canvas read):** decide from the body fill's perceived
    luminance. The body fill is an HSL string per pitch class, so precompute its luminance
    ONCE per {pitch-class, state} in `piano.ts` and store an `isLight` boolean; the hot loop
    reads only that boolean. Threshold: glyph is DARK when `bodyLuminance >= 0.6` on a 0..1
    scale. At 0.6 the crossover lands cleanly: Mi/Fa/Sol/La/cyan get the dark glyph,
    Do/Re/Si/violet/blue keep the light glyph. Pick the luminance of the fill ACTUALLY drawn:
    `activeFill` for sounding bars, else `whiteFill` for white-key bars, else `blackFill` for
    black-key bars (black fills are dark, so they keep the light glyph). New `piano.ts` exports:
    - `GLYPH_LIGHT = "rgba(255,255,255,0.95)"`, `GLYPH_DARK = "rgba(10,7,18,0.92)"`.
    - `barGlyphIsDark(midi, { active, black }): boolean` returning the precomputed flag.
      Compute luminance with `lum = 0.299*r + 0.587*g + 0.114*b` on each fill's RGB (convert
      the hsl strings to RGB once at module load, alongside `PITCH_CLASS_COLORS`); store
      `isLight` per {pc, state}. The rAF loop pays nothing.
  - **Drop the soft dark drop-shadow; swap to a thin opposite-luminance HALO (outline).** The
    current `shadowColor rgba(0,0,0,0.45) blur 2` only helps the light glyph and muddies the
    dark glyph. Replace it with a 1-pole stroke in the OPPOSITE ink, drawn under the fill: per
    label `ctx.lineWidth = 2; ctx.lineJoin = "round";
    ctx.strokeStyle = (glyphDark ? GLYPH_LIGHT : GLYPH_DARK); ctx.strokeText(...)` then
    `ctx.fillStyle = (glyphDark ? GLYPH_DARK : GLYPH_LIGHT); ctx.fillText(...)`. The glyph
    carries BOTH poles, so it survives a hue boundary or a half-lit active bar. Keep
    `shadowBlur = 0` (no blur). The glyph already passes contrast on its body, so the halo is a
    thin insurance line; 2px (~1px per side) is enough and cheap (one strokeText + fillText per
    label, only for labels that already passed the fit test).
  - **Why not keep white + a heavier shadow:** a heavier shadow on a light body just smears
    grey, it cannot manufacture contrast against yellow-green. Body luminance is the problem, so
    the glyph ink has to respond to it. Picked-glyph + thin opposite halo is the minimal honest
    fix and reuses the established two-pole pattern.

  ### Decision 2 - narrow-bar policy: allow centered overflow down to a real floor (option a)

  **Chosen: (a) let a too-narrow bar's name OVERFLOW its width, centered, down to a font floor,
  rather than omit it. The name stays centered on the bar's x, so it bleeds symmetrically into
  the (usually empty) neighbor columns; it does NOT grow a pill or detach.** Rationale: on the
  88-key desktop view a white-key bar is ~10px but its lane neighbors are usually silent, so a
  centered 2-char name spilling a few px past the bar is readable and unambiguous (still
  centered on its own falling bar, directly above its key). Omitting (option c) leaves the wall
  of nameless chips the report describes. Lowering MIN_LABEL_PX globally (option b) would also
  shrink legitimately-fitting labels into mush and weaken the #39 floor everywhere; rejected.

  - **Keep #39's intent precisely:** #39 banned a name BIGGER than its bar in BOTH axes (the
    detached oversized pill). Overflow here is WIDTH-ONLY and the font is still bounded by the
    bar HEIGHT, so the name never grows taller than the bar and never becomes a pill. The height
    cap is the anti-pill guarantee that stays.
  - **Exact numbers (new overflow-aware fit; add a sibling fn or a flag so existing #39 callers
    are untouched):**
    - Height still binds the font: `size = min(MAX_LABEL_PX 12, floor(barHeight * 0.55))`,
      unchanged. The font NEVER exceeds the height-derived size, so no vertical overflow.
    - **New floor:** `MIN_OVERFLOW_PX = 7`. If the height-derived size is `>= 7`, SHOW the label
      even when it is wider than the bar, capping how far it may overflow so it cannot run wild:
      `MAX_OVERFLOW_PER_SIDE = barWidth * 0.9` (the name may render up to ~1.9x the bar width,
      centered). If the name at the height-size still exceeds
      `barWidth + 2 * MAX_OVERFLOW_PER_SIDE`, shrink the font to fit that width (same
      `charCount * size * 0.62 + 2*gutter` solve), and OMIT only if that shrink drops below
      `MIN_OVERFLOW_PX = 7`.
    - **Net:** legible names appear down to a 7px glyph with up to ~0.9x-per-side centered
      overflow. A ~10px white-key bar now shows "Do" at ~8-9px spilling a couple px each side
      instead of nothing. Bars genuinely too short (height-size < 7px, i.e. barHeight < ~13px)
      still omit, so a flurry of 4px slivers does not smear into overlapping text.
    - **MIN_LABEL_PX stays 8 for the non-overflow path** (the #39 in-bounds rule is unchanged);
      `MIN_OVERFLOW_PX = 7` is the slightly lower floor that applies ONLY when width overflow is
      permitted. Keep `MAX_LABEL_PX = 12`, `LABEL_HEIGHT_RATIO = 0.55`,
      `LABEL_CHAR_WIDTH_RATIO = 0.62`, `LABEL_GUTTER = 2` as-is.
  - **Collision note (acceptable for v1):** two adjacent narrow bars sounding at the same instant
    could have overlapping overflowed names. This is rare (adjacent semitones rarely both fall at
    the same instant in the same lane band) and the contrast halo keeps each readable on its own
    body. Do NOT add per-frame collision resolution now; revisit only if playtests show muddle.
  - **Octave digit on letters mode:** letter names are 2-3 chars ("C#4"), so they overflow sooner
    than solfege; the 0.9x-per-side cap is sized to still seat a 3-char name on a ~10px bar at
    ~7px. If 3-char letter names still read tight on the narrowest bars, the follow-up is to drop
    the octave digit on sub-12px bars (letters become pitch-class only when tiny), but do NOT do
    that in #67; ship the overflow first and measure.

  ### Build order

  1. `piano.ts`: add `GLYPH_LIGHT`, `GLYPH_DARK`, `MIN_OVERFLOW_PX = 7`, the
     `MAX_OVERFLOW_PER_SIDE` logic; precompute per-{pc,state} `isLight`; add
     `barGlyphIsDark(midi, {active, black})`; add the overflow-aware fit (new fn or a flag on
     `fitBarLabel` so existing #39 callers are untouched). Unit-test the luminance threshold
     (Fa/Sol/La/cyan -> dark glyph; Do/Si -> light glyph) and the 7px overflow floor.
  2. `visualizer.ts`: in the collect loop pass `{active: isActive && !muted, black}` so each
     label record carries `glyphDark`; in the paint pass, per label set stroke (opposite ink,
     lineWidth 2, lineJoin round) then fill (glyph ink), and drop the old
     `shadowColor`/`shadowBlur` drop-shadow. Keep `textAlign center` / `textBaseline middle` and
     the per-label `alpha`.

## Editable sheet name (issue #44)

- **2026-05-30 - SHIPPED: inline click-to-edit sheet title in the right-trailing toolbar slot.**
  Chose click-to-edit on the name itself over a separate "Rename" button (the issue left the
  call to the Designer). Rationale: lowest friction, no extra toolbar control (the #46 spec and
  the #48 Heroicons heads-up both want the bar minimal), and it slots into the existing
  `#track-name` flexible right slot the #46 redesign explicitly reserved for #44. The name reads
  as quiet muted text (not a loud button) with a dashed-underline + trailing pencil glyph
  (`\270E`) that appears on hover, so the affordance is discoverable without shouting.
  - **Interaction:** the name is a real `<button id="sheet-name">` (keyboard/AT operable,
    `aria-label="Sheet name, click to rename"`). Click/Enter opens an inline `<input
    id="sheet-name-input" maxlength="80">` seeded with the current name and text-selected.
    **Enter or blur commits** (clicking away keeps the typed name, the forgiving default),
    **Escape cancels**. An empty submission reverts to the current name (a rename can never blank
    the title). The note count moved out of the name into its own muted `#sheet-note-count`
    span so editing the title does not fight the "(N notes)" suffix.
  - **Default name:** MusicXML title (`osmd.Sheet.TitleString`) when present, else the file name
    with its extension stripped, else "Untitled sheet". Persisted for the session in a module
    variable; survives status messages (scan/transcribe/record/error) which now live in a
    separate `#track-status` span and restore the name afterward. The chosen name also drives
    the exported video filename (#15) and the document `<title>`, satisfying the issue's "reuse
    the title for export" note.
  - **Mobile:** the whole `#track-name` slot is still hidden at <=720px by the #33 rule, so the
    rename is desktop-only for v1. Accepted: the phone toolbar is space-constrained and renaming
    is not a core phone action. Revisit if mobile rename is requested.
  - **Cross-session persistence is OUT of scope** (the issue says "and across reloads if/when we
    have persistence"); there is no score-persistence layer yet, so the name lives for the
    session only. Wire it into that layer when it lands.

## Hand mute = speaker toggle + falling-note top-cap (user feedback)

- **2026-05-30 - Two build-ready fixes from real user feedback: (1) the per-hand mute pills
  are unintuitive ("checkbox buttons really not intuitive", unclear if lit = on or muted);
  (2) the falling-note hand stripe is invisible. Both specs are markup + CSS + one canvas
  block; the main agent builds them. No new deps; inline SVG only.**

  ### Problem 1 - make each hand control a speaker/mute switch, not an ambiguous pill

  **Root cause:** an `aria-pressed` pill has no fixed mapping between "lit" and a real-world
  meaning, so the user cannot know if lit = on or muted without trying. Fix: show the actual
  audio state with a speaker glyph that visibly GAINS a slash when muted. Speaker /
  speaker-with-slash is the most universally read mute metaphor and is colorblind-safe because
  the slash is a shape change, not a hue.

  **Keep:** `<button class="toggle hand-toggle" aria-pressed>`, the `#hand-mutes` container +
  show-when-both-hands logic, keyboard accessibility, the 44px phone tap target. **Change:**
  swap the dim/strikethrough-only treatment for a speaker icon that toggles glyph, and make
  the tooltip state-explicit.

  **New per-button markup (replace the `.hand-swatch` + `.hand-toggle-state` spans):**
  ```html
  <button id="mute-right-btn" class="toggle hand-toggle" type="button"
          aria-pressed="false" title="Right hand: audible. Click to mute.">
    <span class="hand-spk" aria-hidden="true">
      <svg class="hand-spk-svg" viewBox="0 0 16 16" width="15" height="15">
        <path d="M3 6 H5 L8.5 3 V13 L5 10 H3 Z"/>
        <path class="spk-waves" d="M10.5 5.5 a3.2 3.2 0 0 1 0 5 M12 4 a5 5 0 0 1 0 8"/>
        <path class="spk-slash" d="M10.5 5 L14 11"/>
      </svg>
    </span>
    <span class="hand-toggle-label">Right hand</span>
  </button>
  ```
  - SVG attrs: `fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round;
    stroke-linejoin: round`. One icon, two toggled paths (waves vs slash), no JS glyph swap
    beyond `aria-pressed`.
  - **CSS (replace the whole `aria-pressed="true"` block, style.css ~418-450):**
    ```css
    .hand-toggle { display: inline-flex; align-items: center; gap: 0.4rem; }
    .hand-spk { display: inline-flex; line-height: 0; color: var(--text); }
    .hand-spk-svg { fill: none; stroke: currentColor; stroke-width: 1.6;
      stroke-linecap: round; stroke-linejoin: round; }
    .hand-toggle .spk-slash { display: none; }   /* audible: no slash, waves shown */
    .hand-toggle[aria-pressed="true"] {
      background: rgba(177, 75, 255, 0.28);
      border-color: var(--accent); color: var(--text);
    }
    .hand-toggle[aria-pressed="true"] .hand-spk { color: var(--accent); }
    .hand-toggle[aria-pressed="true"] .spk-waves { display: none; }   /* muted */
    .hand-toggle[aria-pressed="true"] .spk-slash { display: inline; }
    .hand-toggle[aria-pressed="true"] .hand-toggle-label {
      text-decoration: line-through; opacity: 0.75;
    }
    ```
  - **States, exhaustively:**
    - **Audible (default, `aria-pressed="false"`):** ghost pill, `--text` speaker WITH waves,
      no slash, no fill. Reads "sound is coming out".
    - **Muted (`aria-pressed="true"`):** `--accent`-bordered violet-tinted fill (engaged, NOT
      dimmed, per the #37 follow-up where 0.55-dim read as a no-op), speaker turns `--accent`
      and shows the SLASH, label strikethrough. Three redundant cues: glyph slash (shape),
      accent color, strikethrough text.
    - **Hover:** ghost `:hover` (`--ghost-bg-hover`, `--ghost-border-hover`, label near-white);
      a muted button keeps its violet fill and just lifts the border.
    - **Focus-visible:** shared `--focus-ring` (#d9a6ff, 2px, offset 2px). Unchanged.
  - **Tooltip + a11y wording carry the literal state** (the user's complaint is ambiguity, so
    spell it out): audible `title="Right hand: audible. Click to mute."`; Tech Lead flips it to
    `"Right hand: muted. Click to unmute."` alongside `aria-pressed`. Never just "pressed".
  - **Why speaker-with-slash over an on/off switch:** "this controls AUDIO" reads faster from a
    speaker than an abstract switch, and the slash is the canonical OS mute mark everyone knows.
    It fits the existing pill footprint with zero layout change; a switch needs a new
    track/thumb component and still would not say "audio".

  ### Problem 2 - make the falling-note hand cue legible: a bold top cap

  **Root cause:** a 3-6px inset side rail is too thin to see at speed, and one-luminance rails
  fail against SOME hues (near-dark left rail vanishes on deep violet; near-white right rail
  blends into bright hues). **Fix: replace the thin two-sided rail with a single bold TOP CAP
  on every hand-bearing bar, full width, dual-luminance outlined so it survives any hue.** The
  top is the leading edge the eye already tracks, so the cue is read earliest, and full-width
  cannot be clipped at a lane edge. Hue still owns the body; the cap owns hand.

  - **Geometry (replace the #36 edge-stripe block, visualizer.ts ~205-215):** after the body
    `fill()`, with `ctx.shadowBlur = 0`:
    - `CAP_H = Math.max(5, Math.min(8, barHeight * 0.18))` (clamped 5-8px).
    - `ctx.fillStyle = capFill; ctx.fillRect(x + 1, top + 1, w - 2, CAP_H);`
    - `ctx.fillStyle = dividerColor; ctx.fillRect(x + 1, top + 1 + CAP_H, w - 2, 1);`
    - **Right hand:** capFill `rgba(255,255,255,0.95)`, divider `rgba(10,7,18,0.9)` (light cap).
    - **Left hand:** capFill `rgba(10,7,18,0.92)`, divider `rgba(255,255,255,0.9)` (dark cap).
    - Square cap corners are masked by sitting 1px inside the r=4 rounded body. Two flat fills
      per bar, glow off, no gradient/measureText: within the per-bar budget.
  - **The 1px opposite-luminance divider is the robustness trick:** each cap carries BOTH
    luminance poles, so a white cap still reads on pale-yellow (dark underline) and a dark cap
    still reads on deep violet (light underline). That kills the "inconsistent against
    different hues" complaint directly.
  - **Layering:** body fill -> top cap + divider (glow off) -> contact stroke (#27, re-walks
    the path, frames the cap) -> centered name label. Cap is at top, label near mid-bar, so no
    collision and no label reposition (supersedes the #36 edge-stripe label nudge note).
  - **Unknown fallback unchanged:** keep the
    `if (note.hand === "left" || note.hand === "right")` guard. Single-staff / audio / OMR
    (hand "unknown") draw NO cap, pixel-for-pixel as today.
  - **Off-range bars (#33):** keep the cap on them; it inherits the 0.35 alpha and stays
    readable as a dimmed band. No special-casing.
  - **Tradeoff chosen + why:** the cap "caps" a few pixels of the colored body, but legibility
    wins for a learning aid: it is ~6x the pixels of a 3px rail, sits where the eye tracks,
    cannot be clipped, and the dual-luminance outline makes it hue-proof. Rejected: a wider
    SIDE rail (still clippable, still one-luminance-fails-on-some-hue), a hand GLYPH per bar
    (illegible at speed / on narrow black-key bars), a body OUTLINE (collides with the #27
    contact stroke and #33 off-range dimming). Defer a legend; the dark/light cap is learnable
    in one or two notes.

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

## Note-name labeling: falling bars + keyboard keys (issues #42, #43)

- **2026-05-30 - One unified labeling model shipped for both the falling-note names and the
  keyboard key names.** Two related tickets, one branch (`fix/note-name-labeling`), because they
  share the same "what gets a name, when" question and would have conflicted if split.

  **#42 root cause (the per-hand inconsistency was a BUG, not a rule).** Left-hand notes appeared
  to label every note while right-hand notes only labeled the leading one. There was never a
  per-hand code path: the falling-bar label gate is purely `fitBarLabel(width, height, chars)` and
  the font size derives from bar HEIGHT (`duration * pps`). Right-hand (treble) melody notes are
  typically short/quick, so their small bars fell below the legibility floor and the name was
  omitted; left-hand (bass) notes are typically longer/sustained, so their taller bars always
  cleared it. The hand correlation was incidental (duration-correlated), not intentional. Fix:
  make the label decision IDENTITY-based and hand-agnostic, so both hands obey one rule and the
  fit check stays only as a legibility guard.

  **#42 repeated-run rule (decided as Designer):** label the FIRST note of every run of
  consecutive same-pitch notes, and re-label only when the pitch changes. A run is consecutive
  same-`midi` notes within the same HAND lane (left/right/unknown dedupe independently, so a
  shared pitch in both hands is labeled once per hand, never suppressed across hands). A "Do Do
  Do" run now reads as one clear name instead of a noisy stack. The decision is over playback
  time, not array order, so an out-of-order notes array still labels the time-first note of a run.

  **#43 approaching-key rule (decided as PM look-ahead window):** stop labeling every keyboard
  key. Only label a white key whose note is approaching within the look-ahead window OR currently
  sounding. The window is set EQUAL to the falling-note visible lane (`LOOK_AHEAD` = 4s, shared as
  `KEY_LABEL_LOOK_AHEAD`), so a key shows its name exactly while its falling bar is visible coming
  down the lane: the cleanest, least-surprising mental model and it keeps the two label systems in
  lockstep. A note counts from `time - lookAhead` (entered the top of the lane) through
  `time + duration` (finished sounding). When nothing is approaching, NO key labels (clean
  keyboard). A chord puts every chord pitch in the window, so chords stay fully labeled. Black-key
  (sharp) faces remain unlabeled (too narrow), unchanged from before.

  **How the two systems avoid double-labeling / losing the name.** The falling bar carries the
  name as it descends (deduped per run); the key carries the name only while that note is in the
  window. They share `LOOK_AHEAD`, so the key's name appears at the same moment the bar becomes
  visible and clears when the note finishes, never both fighting nor both blank. The #39 fit, #33
  off-window dimming, #54 muted-hand ghosting, #36 hand stripe, and #27 contact glow are all
  untouched: the dedupe only chooses WHICH bars try to label, and the key gate only chooses WHICH
  keys show a name; legibility, dimming, and color rules are unchanged.

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
