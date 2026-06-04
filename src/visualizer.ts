import {
  approachingKeyMidis,
  barGlyphIsDark,
  buildKeyLayout,
  fitBarLabel,
  isBlackKey,
  isHandMuted,
  keyAtX,
  keyLabelFits,
  labelableFallingNotes,
  midiToLabel,
  midiToBarLabel,
  noteBarWidth,
  noteColor,
  FIRST_MIDI,
  GLYPH_DARK,
  GLYPH_LIGHT,
  KEY_LABEL_LOOK_AHEAD,
  LAST_MIDI,
  type KeyGeometry,
  type LabelMode,
  type Hand,
  type NoteSpelling,
} from "./piano";

export interface VisNote {
  midi: number;
  time: number; // start time in seconds
  duration: number; // seconds
  hand?: Hand; // which hand plays this note (issue #36); absent reads as "unknown"
  // The note's printed spelling from the sheet (issues #56/#58), e.g. step D + alter -1
  // for a "Db". Drives the label NAME only (color, octave, and geometry stay MIDI-driven).
  // Absent for audio-transcribed scores, which fall back to the always-sharp name.
  spelling?: NoteSpelling;
}

// A transient pitch-drag preview on the falling canvas (Smart Edit Mode P1): while the user
// drags a selected bar sideways to a new key, the bar is drawn at `previewMidi`'s column (NOT
// its model pitch) with the target key tinted, until release commits the edit. `index` is into
// the current notes. Null = no drag in progress.
export interface DragPreview {
  index: number;
  previewMidi: number;
}

// Geometry of one falling bar in canvas px, computed purely from the layout + a note's time
// window. Shared by the renderer and the click hit-test (issue #6) so a tap lands on exactly
// the rectangle the user sees. `clamped` flags an off-window bar pinned to an edge column on a
// narrow keyboard (issue #33); those are a dim "off-screen" hint and are NOT selectable.
export interface BarRect {
  x: number;
  top: number;
  width: number;
  height: number;
  clamped: boolean;
}

// Inputs the bar math needs, independent of any canvas. `keyByMidi`/edge fields come from the
// current key layout; `pps` (pixels per second) and `keyboardTop` from the current size.
export interface BarLayout {
  keyByMidi: ReadonlyMap<number, KeyGeometry>;
  firstVisibleMidi: number;
  lastVisibleMidi: number;
  keyboardTop: number;
  pps: number;
  lookAhead: number;
}

// Pure rectangle for note `n` at `currentTime`, or null when the bar is off-screen (not within
// the look-ahead window and not still sounding) or its key column is missing. Mirrors the exact
// math drawFallingNotes uses, so the renderer and the hit-test never drift apart.
export function barRect(
  n: { midi: number; time: number; duration: number },
  currentTime: number,
  layout: BarLayout,
): BarRect | null {
  const delta = n.time - currentTime;
  if (delta > layout.lookAhead || delta + n.duration < 0) return null; // off-screen
  const clamped = n.midi < layout.firstVisibleMidi || n.midi > layout.lastVisibleMidi;
  const lookupMidi = clamped
    ? n.midi < layout.firstVisibleMidi
      ? layout.firstVisibleMidi
      : layout.lastVisibleMidi
    : n.midi;
  const key = layout.keyByMidi.get(lookupMidi);
  if (!key) return null;
  const height = Math.max(6, n.duration * layout.pps);
  const bottom = layout.keyboardTop - delta * layout.pps;
  const top = bottom - height;
  const black = isBlackKey(n.midi);
  const width = noteBarWidth(key.width, black);
  const x = key.x + (key.width - width) / 2;
  return { x, top, width, height, clamped };
}

// First (topmost-drawn) note whose on-screen bar contains (px, py) at `currentTime`, or null.
// "Topmost on overlap" = the LAST index drawn wins, since later bars paint over earlier ones;
// we scan from the end so a stacked chord selects the bar the user actually sees on top.
// Clamped off-window bars are skipped: they are a dim hint, not a precise target.
export function hitTestBars(
  notes: readonly { midi: number; time: number; duration: number }[],
  px: number,
  py: number,
  currentTime: number,
  layout: BarLayout,
): number | null {
  for (let i = notes.length - 1; i >= 0; i--) {
    const r = barRect(notes[i], currentTime, layout);
    if (!r || r.clamped) continue;
    if (px >= r.x && px <= r.x + r.width && py >= r.top && py <= r.top + r.height) {
      return i;
    }
  }
  return null;
}

// Whether a single falling bar should carry the brighter "active" fill (issue #131).
// Keyed on THIS note's own time window, not the pitch, so two same-pitch notes in
// sequence never light up together: only the instance currently sounding (its bar has
// reached the keybed, since delta <= 0 inside the window) is active. The window is
// half-open on the release edge ([time, time+duration)) so a legato same-pitch repeat
// (note2.time === note1.time + note1.duration) hands the active fill straight to the
// onset note instead of both lighting for the seam frame. Pure + canvas-free so it is
// unit-testable; the keyboard-key highlight reuses this same window via activeMidis.
export function fallingBarActive(
  note: { time: number; duration: number },
  currentTime: number,
): boolean {
  return currentTime >= note.time && currentTime < note.time + note.duration;
}

const MAX_KEYBOARD_HEIGHT = 140;
const MIN_KEYBOARD_HEIGHT = 96;
// Seconds of notes visible above the keyboard. Shared with the keyboard-label window
// (issue #43) so a key shows its name exactly while its falling bar is visible.
const LOOK_AHEAD = KEY_LABEL_LOOK_AHEAD;

// Below this keyboard height the per-key face labels crowd, so they are suppressed
// (the falling-bar names still show). Matches the issue #11 legibility-floor rule.
const KEY_LABEL_MIN_HEIGHT = 110;

export class Visualizer {
  private ctx: CanvasRenderingContext2D;
  private keys: KeyGeometry[] = [];
  private keyByMidi = new Map<number, KeyGeometry>();
  private firstVisibleMidi = FIRST_MIDI;
  private lastVisibleMidi = LAST_MIDI;
  private keyboardHeight = MAX_KEYBOARD_HEIGHT;
  private notes: VisNote[] = [];
  // Per-note flag: whether this note's falling bar should carry a name (issue #42).
  // Precomputed in setNotes (index-aligned to `notes`) so the rAF loop only does a lookup,
  // and so the run-dedupe / per-hand-consistency decision is made once, not every frame.
  private labelableNote: boolean[] = [];
  private mutedHands = { left: false, right: false };
  // Index of the note selected in edit mode (Smart Edit P1), or null when nothing is selected.
  // A selected bar gets a solid focus-ring outline + brass halo so the edit target is obvious.
  private selectedIndex: number | null = null;
  // Transient pitch-drag preview (Smart Edit P1): the selected bar is drawn at a preview key
  // while the user drags it, until release commits the model edit. Null = no drag.
  private dragPreview: DragPreview | null = null;
  // When the canvas is the de-emphasized MIRROR during a drag on the OTHER surface (the staff),
  // its selected bar dims to ~55% so it reads as "about to change" (Designer P1-5). Null = full.
  private mirrorDeemphasisIndex: number | null = null;
  // Transient accent-pulse bar (Smart Edit P3): the bar whose duration just changed flashes a
  // stronger brass glow for ~150ms before settling to the steady selection halo. Null = no pulse.
  private accentPulseIndex: number | null = null;
  private width = 0;
  private height = 0;
  private dpr = 1;
  private labelMode: LabelMode = "solfege";
  // Cached vertical background gradient; depends only on height, rebuilt in resize().
  private bgGradient: CanvasGradient | null = null;

  constructor(private canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas context unavailable");
    this.ctx = ctx;
    this.resize();
    window.addEventListener("resize", () => this.resize());
  }

  setNotes(notes: VisNote[]): void {
    this.notes = notes;
    // Decide once which bars carry a name: label the first of every repeated same-pitch
    // run, per hand lane, so both hands obey one rule (issue #42). The fit check (#39)
    // still applies per frame as a legibility guard.
    this.labelableNote = labelableFallingNotes(notes);
  }

  // Which hands are muted (issue #54). A muted hand's falling notes are ghosted so the
  // mute reads on screen, not just in the audio. "unknown"-hand notes are never affected.
  setMutedHands(muted: { left: boolean; right: boolean }): void {
    this.mutedHands = muted;
  }

  setLabelMode(mode: LabelMode): void {
    this.labelMode = mode;
  }

  // Mark the selected note for edit mode (Smart Edit P1); null clears the selection. The
  // index is into the current `notes`; the caller is responsible for passing a valid index.
  setSelected(index: number | null): void {
    this.selectedIndex = index;
  }

  // Transient accent pulse on a bar (Smart Edit P3): on a duration commit the changed bar flashes a
  // stronger brass glow for ~150ms before settling to the steady selection halo, so the eye catches
  // a length change that does not move the bar's x/y. The caller sets the index then clears it (to
  // null) after the timeout; while set, the bar is drawn with an extra accent ring + heavier glow.
  setAccentPulse(index: number | null): void {
    this.accentPulseIndex = index;
  }

  // Set (or clear) the transient pitch-drag preview (Smart Edit P1). While set, the previewed
  // bar is drawn at `previewMidi`'s key column with that key tinted, until the caller commits
  // the model edit and clears the preview.
  setDragPreview(preview: DragPreview | null): void {
    this.dragPreview = preview;
  }

  // De-emphasize the selected bar to the mirror state (~55% alpha) while a drag is happening on
  // the OTHER surface (the staff). null restores full opacity. Pass the selected index so only
  // that bar dims.
  setMirrorDeemphasis(index: number | null): void {
    this.mirrorDeemphasisIndex = index;
  }

  // The MIDI of the key column under a canvas x coordinate, or null outside the keybed. Used by
  // the canvas pitch drag to snap the dragged bar to the key under the pointer.
  midiAtX(px: number): number | null {
    return keyAtX(this.keys, px);
  }

  // Build the current bar layout (key columns + scale) so the pure hit-test sees exactly the
  // geometry the render loop draws. pps must match render()'s `(height - keyboardHeight)/LOOK_AHEAD`.
  private barLayout(): BarLayout {
    return {
      keyByMidi: this.keyByMidi,
      firstVisibleMidi: this.firstVisibleMidi,
      lastVisibleMidi: this.lastVisibleMidi,
      keyboardTop: this.keyboardTop(),
      pps: (this.height - this.keyboardHeight) / LOOK_AHEAD,
      lookAhead: LOOK_AHEAD,
    };
  }

  // Hit-test a click/tap in canvas px against the falling bars at `currentTime`, returning the
  // topmost note's index or null (issue #6). Topmost-on-overlap wins; clamped off-window bars
  // are not selectable.
  hitTest(px: number, py: number, currentTime: number): number | null {
    return hitTestBars(this.notes, px, py, currentTime, this.barLayout());
  }

  resize(): void {
    this.dpr = window.devicePixelRatio || 1;
    this.width = this.canvas.clientWidth;
    this.height = this.canvas.clientHeight;
    this.canvas.width = this.width * this.dpr;
    this.canvas.height = this.height * this.dpr;
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    // Responsive keyboard (issue #33): shrink the keybed on narrow screens and show a
    // smaller, centered key window so individual keys stay legible on a phone. Ranges
    // start and end on C; off-window notes clamp to the nearest edge in drawFallingNotes.
    this.keyboardHeight = Math.round(
      Math.min(MAX_KEYBOARD_HEIGHT, Math.max(MIN_KEYBOARD_HEIGHT, this.width * 0.18)),
    );
    if (this.width >= 760) {
      this.firstVisibleMidi = FIRST_MIDI; // full 88 keys (A0..C8)
      this.lastVisibleMidi = LAST_MIDI;
    } else if (this.width >= 480) {
      this.firstVisibleMidi = 36; // C2..C7
      this.lastVisibleMidi = 96;
    } else {
      this.firstVisibleMidi = 36; // C2..C6
      this.lastVisibleMidi = 84;
    }
    this.keys = buildKeyLayout(this.width, this.firstVisibleMidi, this.lastVisibleMidi);
    this.keyByMidi = new Map(this.keys.map((k) => [k.midi, k]));

    // Background gradient depends only on height; cache it so the rAF loop never
    // calls createLinearGradient. Replaces the clearRect-to-transparent fill.
    const bg = this.ctx.createLinearGradient(0, 0, 0, this.height);
    bg.addColorStop(0, "#0b0a0d"); // warm ebony stage (Nocturne, issue #127)
    bg.addColorStop(1, "#16130e");
    this.bgGradient = bg;
  }

  private keyboardTop(): number {
    return this.height - this.keyboardHeight;
  }

  private activeMidis(currentTime: number): Set<number> {
    const active = new Set<number>();
    for (const n of this.notes) {
      if (fallingBarActive(n, currentTime)) active.add(n.midi);
    }
    return active;
  }

  render(currentTime: number): void {
    const { ctx, width, height } = this;
    // Fill the cached background gradient over the whole canvas; this both clears
    // the previous frame and paints the stage in one pass (no separate clearRect).
    ctx.fillStyle = this.bgGradient ?? "#0b0a0d";
    ctx.fillRect(0, 0, width, height);

    const keyboardTop = this.keyboardTop();
    const pps = (height - this.keyboardHeight) / LOOK_AHEAD; // pixels per second
    const active = this.activeMidis(currentTime);
    // Keys to label this frame (issue #43): only those whose note is approaching within
    // the look-ahead window or currently sounding, so the keyboard shows just the names
    // that matter right now instead of every key.
    const approaching = approachingKeyMidis(this.notes, currentTime, LOOK_AHEAD);

    this.drawFallingNotes(currentTime, keyboardTop, pps);
    this.drawKeyboard(keyboardTop, active, approaching);
    this.drawDragTargetKey(keyboardTop);
  }

  // Tint the target KEY in the dragged bar's pitch hue while a canvas pitch drag is in progress
  // (Smart Edit P1), so the user sees which key the bar will land on, not just the lane column.
  // Drawn over the keybed after the keyboard so it reads as a highlight on the target key.
  private drawDragTargetKey(keyboardTop: number): void {
    if (!this.dragPreview) return;
    const key = this.keyByMidi.get(this.dragPreview.previewMidi);
    if (!key) return;
    const { ctx } = this;
    const colors = noteColor(this.dragPreview.previewMidi);
    const kbH = this.keyboardHeight;
    const h = key.black ? kbH * 0.62 : kbH;
    ctx.save();
    ctx.globalAlpha = 0.55;
    ctx.fillStyle = key.black ? colors.activeBlackKey : colors.activeWhiteKey;
    ctx.fillRect(key.x, keyboardTop, key.width, h);
    ctx.restore();
  }

  private drawFallingNotes(
    currentTime: number,
    keyboardTop: number,
    pps: number,
  ): void {
    const { ctx } = this;
    // Geometry of bars worth labeling, collected during the fill pass and drawn
    // after, so the contact stroke's glow never bleeds into the glyphs. Each label
    // carries its own fitted font size so short/narrow bars get a smaller name that
    // stays within the bar's bounds (issue #39).
    const labels: {
      x: number;
      y: number;
      text: string;
      fontSize: number;
      alpha: number;
      glyphDark: boolean; // dark ink on a light bar, else light ink (issue #67)
    }[] = [];

    for (let i = 0; i < this.notes.length; i++) {
      const note = this.notes[i];
      const delta = note.time - currentTime;
      if (delta > LOOK_AHEAD || delta + note.duration < 0) continue; // off-screen

      // Pitch-drag preview (Smart Edit P1): while this bar is being dragged to a new key, draw
      // it at the PREVIEW pitch's column + hue (time is unchanged), so the user sees where it
      // will land before release. Only the horizontal position / color use the preview midi;
      // the vertical (time) window stays the note's own.
      const renderMidi =
        this.dragPreview?.index === i ? this.dragPreview.previewMidi : note.midi;

      // On narrow screens the visible keyboard is a sub-window of the 88 keys (issue #33).
      // Notes outside the window clamp to the nearest edge column and draw dimmed so the
      // player still sees them coming without them vanishing.
      const offRange =
        renderMidi < this.firstVisibleMidi || renderMidi > this.lastVisibleMidi;
      const lookupMidi = offRange
        ? renderMidi < this.firstVisibleMidi
          ? this.firstVisibleMidi
          : this.lastVisibleMidi
        : renderMidi;
      const key = this.keyByMidi.get(lookupMidi);
      if (!key) continue;

      const barHeight = Math.max(6, note.duration * pps);
      const bottom = keyboardTop - delta * pps;
      const top = bottom - barHeight;

      const black = isBlackKey(renderMidi);
      const w = noteBarWidth(key.width, black);
      const x = key.x + (key.width - w) / 2;

      // Per-pitch-class colors come from a precomputed table (no per-bar string
      // building). Active bars get a brighter fill and a wider glow.
      const colors = noteColor(renderMidi);
      // Active fill is per-note, gated on this bar's own time window (issue #131), not the
      // per-pitch `active` set, so a same-pitch bar still in flight stays inactive until it
      // arrives. `active` (pitch-keyed) is still passed through for the keyboard-key lights.
      const isActive = fallingBarActive(note, currentTime);
      // Ghost a bar whose hand is currently muted (issue #54) so the mute is visible on
      // screen, not audio-only. Composes with the off-window dim; "unknown" never mutes.
      const muted = isHandMuted(note.hand, this.mutedHands);
      let alpha = 1;
      if (offRange) alpha = 0.35;
      if (muted) alpha = Math.min(alpha, 0.3);
      // Mirror de-emphasis (Smart Edit P1): when a drag is happening on the staff, the canvas is
      // the stale mirror, so its selected bar dims to ~55% until the edit commits.
      if (this.mirrorDeemphasisIndex === i) alpha = Math.min(alpha, 0.55);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = isActive
        ? colors.activeFill
        : black
          ? colors.blackFill
          : colors.whiteFill;
      // No body glow: a falling bar is a clean colored bar (issue #27 intent). The only
      // glow is the #27 contact stroke below, fired solely for the bar touching the keybed,
      // so in-flight notes stay calm and the highlight reads as the single contact moment.
      ctx.shadowBlur = 0;
      this.roundRect(x, top, w, barHeight, 4);
      ctx.fill();

      // Hand cue (issue #36, redesigned): a bold full-width cap on the bar's LEADING (top)
      // edge so the eye reads which hand plays it without overriding the pitch hue (hue still
      // owns the body). Light cap = right hand, dark cap = left hand. A 1px opposite-luminance
      // divider runs under the cap so each cap carries BOTH luminance poles and can never wash
      // out against the hue beneath it (a white cap still reads on pale amber, a dark cap on
      // deep blue). Drawn after the body fill with the glow off, before the contact stroke;
      // inherits the bar's globalAlpha so off-range bars (0.35) keep a dimmed cap. "unknown"
      // draws nothing, so single-staff and audio-derived scores render exactly as before.
      if (note.hand === "left" || note.hand === "right") {
        const capH = Math.max(5, Math.min(8, barHeight * 0.18));
        const capFill =
          note.hand === "right" ? "rgba(255, 255, 255, 0.95)" : "rgba(11, 10, 13, 0.92)";
        const dividerColor =
          note.hand === "right" ? "rgba(11, 10, 13, 0.9)" : "rgba(255, 255, 255, 0.9)";
        ctx.shadowBlur = 0;
        ctx.fillStyle = capFill;
        ctx.fillRect(x + 1, top + 1, w - 2, capH);
        ctx.fillStyle = dividerColor;
        ctx.fillRect(x + 1, top + 1 + capH, w - 2, 1);
      }

      // Selection outline + halo (Smart Edit P1): the note picked in edit mode gets a solid 2px
      // focus-ring border and a soft brass halo so the edit target reads clearly. Drawn on the
      // real (non-clamped) bar only; the selection survives play being paused.
      if (this.selectedIndex === i) {
        // A duration-commit pulse (Smart Edit P3) draws a heavier brass ring + glow for its ~150ms
        // window, on top of (and brighter than) the steady selection halo, so a length change that
        // does not move the bar still catches the eye. Falls back to the steady halo otherwise.
        const pulsing = this.accentPulseIndex === i;
        ctx.save();
        ctx.lineWidth = pulsing ? 3 : 2;
        ctx.strokeStyle = pulsing ? "#d8a23a" : "#f0c66b"; // --accent : --focus-ring
        ctx.shadowColor = "rgba(216, 162, 58, 0.55)"; // --accent-glow
        ctx.shadowBlur = pulsing ? 28 : 16;
        ctx.globalAlpha = 1;
        this.roundRect(x, top, w, barHeight, 4);
        ctx.stroke();
        ctx.restore();
      }

      // Clamped off-window bars get neither the contact glow nor a label: they are a
      // dimmed "a note is happening off-screen" hint, not a precise target.
      if (offRange) {
        ctx.globalAlpha = 1;
        continue;
      }

      // Contact glow (issue #27): the instant a sounding bar's leading edge reaches the
      // keybed, stroke a soft border in the note's own hue so it visibly "lights up" on
      // the hit, distinct from the steady active fill. Fires only for the small set of
      // bars that are both sounding and touching, so the common falling bar pays nothing.
      const inContact = isActive && !muted && bottom >= keyboardTop - 10;
      if (inContact) {
        ctx.lineWidth = 2;
        ctx.strokeStyle = colors.glow;
        ctx.shadowColor = colors.glow;
        ctx.shadowBlur = 22;
        ctx.globalAlpha = 0.9;
        this.roundRect(x, top, w, barHeight, 4);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }

      // Label only the first bar of a repeated same-pitch run, per hand (issue #42), so
      // both hands obey one rule and a "Do Do Do" run reads as one clear name. The fit
      // check below is still the per-frame legibility guard (issue #39).
      if (this.labelMode !== "off" && this.labelableNote[i] !== false) {
        // The font is still bound by bar HEIGHT (issue #39) so a short bar never grows a
        // detached pill. But on the dense desktop keybed a white key is ~10px wide, too
        // narrow to hold a 2-char name inside the bar, which dropped the name entirely; we
        // now let the name overflow horizontally, centered on the bar, down to a 7px floor
        // (issue #67). The name is still centered vertically so it stays within the bar's
        // height. Ink is chosen from the bar's luminance so it reads on every hue.
        const text = midiToBarLabel(note.midi, this.labelMode, note.spelling);
        const fit = fitBarLabel(w, barHeight, text.length, true);
        if (fit.show) {
          labels.push({
            x: x + w / 2,
            y: top + barHeight / 2,
            text,
            fontSize: fit.fontSize,
            alpha,
            glyphDark: barGlyphIsDark(note.midi, { active: isActive && !muted, black }),
          });
        }
      }

      // Reset alpha so a muted bar's dim does not leak into the next bar or the labels.
      ctx.globalAlpha = 1;
    }

    // Reset glow before text, draw text, then reset again so nothing else inherits it.
    // Each label sets its own fitted font size; baseline is middle so the centered name
    // sits within the bar's vertical bounds even when the bar is only a few px tall.
    ctx.shadowBlur = 0;
    if (labels.length > 0) {
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.lineJoin = "round";
      ctx.lineWidth = 2;
      // Each name is drawn as a two-pole glyph (issue #67): an ink chosen from the bar's
      // luminance, haloed by the opposite ink. The halo lets the name survive hue
      // boundaries and overflow onto the dark stage between narrow bars. Replaces the old
      // fixed white fill + soft drop-shadow that washed out on the light (yellow/green) hues.
      for (const l of labels) {
        ctx.globalAlpha = l.alpha;
        ctx.font = `600 ${l.fontSize}px system-ui`;
        ctx.strokeStyle = l.glyphDark ? GLYPH_LIGHT : GLYPH_DARK;
        ctx.strokeText(l.text, l.x, l.y);
        ctx.fillStyle = l.glyphDark ? GLYPH_DARK : GLYPH_LIGHT;
        ctx.fillText(l.text, l.x, l.y);
      }
      ctx.globalAlpha = 1;
    }
  }

  private drawKeyboard(
    top: number,
    active: Set<number>,
    approaching: Set<number>,
  ): void {
    const { ctx, width } = this;

    // Dim resting glow strip along the top edge of the keyboard (one gradient
    // per frame, never per key). Dimmer than before so it does not fight hues.
    const grad = ctx.createLinearGradient(0, top - 30, 0, top);
    grad.addColorStop(0, "rgba(216,162,58,0)"); // brass rim-light over the keybed (Nocturne)
    grad.addColorStop(1, "rgba(216,162,58,0.16)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, top - 30, width, 30);

    const kbH = this.keyboardHeight;
    ctx.fillStyle = "#17140f"; // warm ebony felt behind the keys
    ctx.fillRect(0, top, width, kbH);

    // white keys first, then black keys on top
    for (const key of this.keys) {
      if (key.black) continue;
      ctx.fillStyle = active.has(key.midi)
        ? noteColor(key.midi).activeWhiteKey
        : "#f1ead9"; // ivory key
      ctx.strokeStyle = "#2a251c";
      ctx.lineWidth = 1;
      ctx.fillRect(key.x, top, key.width, kbH);
      ctx.strokeRect(key.x, top, key.width, kbH);
    }
    for (const key of this.keys) {
      if (!key.black) continue;
      ctx.fillStyle = active.has(key.midi)
        ? noteColor(key.midi).activeBlackKey
        : "#0d0b08"; // ebony key
      ctx.fillRect(key.x, top, key.width, kbH * 0.62);
    }

    this.drawKeyLabels(top, active, approaching);
  }

  // Key-face pitch-class labels (no octave). Shares the labelMode + legibility-floor
  // guards, then draws two independent passes: the white-key row (approaching/sounding
  // keys, issue #43) and the black-key cue (sounding keys only, issue #57). Each pass is
  // all-or-nothing on its own key width so neither row goes ragged.
  private drawKeyLabels(
    top: number,
    active: Set<number>,
    approaching: Set<number>,
  ): void {
    if (this.labelMode === "off") return;
    // Below the legibility floor the keybed is too short to seat readable glyphs, so
    // skip key-face labels entirely on small screens (the falling-bar names remain).
    if (this.keyboardHeight < KEY_LABEL_MIN_HEIGHT) return;

    const { ctx } = this;
    ctx.textAlign = "center";
    ctx.shadowBlur = 0;

    this.drawWhiteKeyLabels(top, active, approaching);
    this.drawBlackKeyLabels(top, active);
  }

  // White-key path. Unchanged behavior: nothing approaching -> no labels (issue #43), all
  // labels share one 11px font, and the row is all-or-nothing against the white-key width.
  private drawWhiteKeyLabels(
    top: number,
    active: Set<number>,
    approaching: Set<number>,
  ): void {
    // Nothing approaching -> no white key labels at all (issue #43).
    if (approaching.size === 0) return;
    const { ctx } = this;
    const whiteWidth = this.keys.find((k) => !k.black)?.width ?? 0;
    if (whiteWidth <= 0) return;

    ctx.font = "600 11px system-ui";
    ctx.textBaseline = "bottom";

    const GUTTER = 4; // px of breathing room each side so glyphs do not touch key edges
    // Measure the widest label across the whole mode (not just approaching keys) so the
    // fit decision is stable frame-to-frame as the approaching set changes; a key that
    // would not fit at 11px never gets a name regardless of which subset is showing.
    let widest = 0;
    for (const key of this.keys) {
      if (key.black) continue;
      widest = Math.max(widest, ctx.measureText(midiToLabel(key.midi, this.labelMode)).width);
    }
    if (!keyLabelFits(widest, whiteWidth, GUTTER)) return; // too narrow at 11px, skip row

    const baseline = top + this.keyboardHeight - 10;
    for (const key of this.keys) {
      if (key.black) continue;
      // Only label a key whose own note is approaching or sounding right now. The
      // approaching set keys off each note's true midi, so a note clamped to an off-window
      // edge column (issue #33) does not falsely label the edge key; that key labels only
      // when it has its own approaching note.
      if (!approaching.has(key.midi)) continue;
      ctx.fillStyle = active.has(key.midi) ? "#1a140d" : "#6b5c44";
      ctx.fillText(midiToLabel(key.midi, this.labelMode), key.x + key.width / 2, baseline);
    }
  }

  // Black-key path (issue #57): purely additive name cue. A black key is only labeled
  // while it is sounding/pressed (in `active`), so the resting keyboard stays clean and a
  // beginner who sees a falling "C#"/"Do#" gets a name on the physical black key the moment
  // it lights up. Black faces are narrow, so this uses a smaller 9px font and the same
  // all-or-nothing width fit as the white row: if the widest black-key label would not fit
  // the black-key width at 9px, no black-key labels are drawn this pass (uniform > ragged).
  private drawBlackKeyLabels(top: number, active: Set<number>): void {
    const { ctx } = this;
    const blackWidth = this.keys.find((k) => k.black)?.width ?? 0;
    if (blackWidth <= 0) return;
    if (active.size === 0) return;

    ctx.font = "600 9px system-ui";
    ctx.textBaseline = "bottom";

    const GUTTER = 2; // tighter than the white row; the black face has little room
    // Widest black-key label across the whole mode keeps the fit decision stable as the
    // active set changes (solfege "Do#"/"Reb" is wider than the 2-char letter spelling).
    let widest = 0;
    for (const key of this.keys) {
      if (!key.black) continue;
      widest = Math.max(widest, ctx.measureText(midiToLabel(key.midi, this.labelMode)).width);
    }
    if (!keyLabelFits(widest, blackWidth, GUTTER)) return; // too narrow at 9px, skip

    // Seat the name near the bottom of the black-key face (height is kbH * 0.62).
    const baseline = top + this.keyboardHeight * 0.62 - 4;
    for (const key of this.keys) {
      if (!key.black) continue;
      if (!active.has(key.midi)) continue;
      // Light text reads against the lit black-key hue (activeBlackKey fill).
      ctx.fillStyle = "#f1ead9";
      ctx.fillText(midiToLabel(key.midi, this.labelMode), key.x + key.width / 2, baseline);
    }
  }

  private roundRect(x: number, y: number, w: number, h: number, r: number): void {
    const { ctx } = this;
    const radius = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + w, y, x + w, y + h, radius);
    ctx.arcTo(x + w, y + h, x, y + h, radius);
    ctx.arcTo(x, y + h, x, y, radius);
    ctx.arcTo(x, y, x + w, y, radius);
    ctx.closePath();
  }
}
