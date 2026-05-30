import {
  approachingKeyMidis,
  barGlyphIsDark,
  buildKeyLayout,
  fitBarLabel,
  isBlackKey,
  isHandMuted,
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
} from "./piano";

export interface VisNote {
  midi: number;
  time: number; // start time in seconds
  duration: number; // seconds
  hand?: Hand; // which hand plays this note (issue #36); absent reads as "unknown"
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
    bg.addColorStop(0, "#0a0712");
    bg.addColorStop(1, "#120b1f");
    this.bgGradient = bg;
  }

  private keyboardTop(): number {
    return this.height - this.keyboardHeight;
  }

  private activeMidis(currentTime: number): Set<number> {
    const active = new Set<number>();
    for (const n of this.notes) {
      if (currentTime >= n.time && currentTime <= n.time + n.duration) {
        active.add(n.midi);
      }
    }
    return active;
  }

  render(currentTime: number): void {
    const { ctx, width, height } = this;
    // Fill the cached background gradient over the whole canvas; this both clears
    // the previous frame and paints the stage in one pass (no separate clearRect).
    ctx.fillStyle = this.bgGradient ?? "#0a0712";
    ctx.fillRect(0, 0, width, height);

    const keyboardTop = this.keyboardTop();
    const pps = (height - this.keyboardHeight) / LOOK_AHEAD; // pixels per second
    const active = this.activeMidis(currentTime);
    // Keys to label this frame (issue #43): only those whose note is approaching within
    // the look-ahead window or currently sounding, so the keyboard shows just the names
    // that matter right now instead of every key.
    const approaching = approachingKeyMidis(this.notes, currentTime, LOOK_AHEAD);

    this.drawFallingNotes(currentTime, keyboardTop, pps, active);
    this.drawKeyboard(keyboardTop, active, approaching);
  }

  private drawFallingNotes(
    currentTime: number,
    keyboardTop: number,
    pps: number,
    active: Set<number>,
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

      // On narrow screens the visible keyboard is a sub-window of the 88 keys (issue #33).
      // Notes outside the window clamp to the nearest edge column and draw dimmed so the
      // player still sees them coming without them vanishing.
      const offRange =
        note.midi < this.firstVisibleMidi || note.midi > this.lastVisibleMidi;
      const lookupMidi = offRange
        ? note.midi < this.firstVisibleMidi
          ? this.firstVisibleMidi
          : this.lastVisibleMidi
        : note.midi;
      const key = this.keyByMidi.get(lookupMidi);
      if (!key) continue;

      const barHeight = Math.max(6, note.duration * pps);
      const bottom = keyboardTop - delta * pps;
      const top = bottom - barHeight;

      const black = isBlackKey(note.midi);
      const w = noteBarWidth(key.width, black);
      const x = key.x + (key.width - w) / 2;

      // Per-pitch-class colors come from a precomputed table (no per-bar string
      // building). Active bars get a brighter fill and a wider glow.
      const colors = noteColor(note.midi);
      const isActive = active.has(note.midi);
      // Ghost a bar whose hand is currently muted (issue #54) so the mute is visible on
      // screen, not audio-only. Composes with the off-window dim; "unknown" never mutes.
      const muted = isHandMuted(note.hand, this.mutedHands);
      let alpha = 1;
      if (offRange) alpha = 0.35;
      if (muted) alpha = Math.min(alpha, 0.3);
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
      // out against the hue beneath it (a white cap still reads on pale yellow, a dark cap on
      // deep violet). Drawn after the body fill with the glow off, before the contact stroke;
      // inherits the bar's globalAlpha so off-range bars (0.35) keep a dimmed cap. "unknown"
      // draws nothing, so single-staff and audio-derived scores render exactly as before.
      if (note.hand === "left" || note.hand === "right") {
        const capH = Math.max(5, Math.min(8, barHeight * 0.18));
        const capFill =
          note.hand === "right" ? "rgba(255, 255, 255, 0.95)" : "rgba(10, 7, 18, 0.92)";
        const dividerColor =
          note.hand === "right" ? "rgba(10, 7, 18, 0.9)" : "rgba(255, 255, 255, 0.9)";
        ctx.shadowBlur = 0;
        ctx.fillStyle = capFill;
        ctx.fillRect(x + 1, top + 1, w - 2, capH);
        ctx.fillStyle = dividerColor;
        ctx.fillRect(x + 1, top + 1 + capH, w - 2, 1);
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
        const text = midiToBarLabel(note.midi, this.labelMode);
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
    grad.addColorStop(0, "rgba(177,75,255,0)");
    grad.addColorStop(1, "rgba(177,75,255,0.18)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, top - 30, width, 30);

    const kbH = this.keyboardHeight;
    ctx.fillStyle = "#15101f";
    ctx.fillRect(0, top, width, kbH);

    // white keys first, then black keys on top
    for (const key of this.keys) {
      if (key.black) continue;
      ctx.fillStyle = active.has(key.midi)
        ? noteColor(key.midi).activeWhiteKey
        : "#f2ecf8";
      ctx.strokeStyle = "#2a2238";
      ctx.lineWidth = 1;
      ctx.fillRect(key.x, top, key.width, kbH);
      ctx.strokeRect(key.x, top, key.width, kbH);
    }
    for (const key of this.keys) {
      if (!key.black) continue;
      ctx.fillStyle = active.has(key.midi)
        ? noteColor(key.midi).activeBlackKey
        : "#100b1a";
      ctx.fillRect(key.x, top, key.width, kbH * 0.62);
    }

    this.drawKeyLabels(top, active, approaching);
  }

  // White-key pitch-class labels (no octave). Only labels keys with an approaching or
  // sounding note (issue #43), so the keyboard shows the names that matter right now, not
  // every key. Never shrinks below 11px, and the width check is all-or-nothing: if the
  // widest possible label plus a small gutter would not fit a white key, draw no key-face
  // labels this pass (uniform > ragged).
  private drawKeyLabels(
    top: number,
    active: Set<number>,
    approaching: Set<number>,
  ): void {
    if (this.labelMode === "off") return;
    // Below the legibility floor the keybed is too short to seat readable glyphs, so
    // skip key-face labels entirely on small screens (the falling-bar names remain).
    if (this.keyboardHeight < KEY_LABEL_MIN_HEIGHT) return;
    // Nothing approaching -> no key labels at all (issue #43).
    if (approaching.size === 0) return;
    const { ctx } = this;
    const whiteWidth = this.keys.find((k) => !k.black)?.width ?? 0;
    if (whiteWidth <= 0) return;

    ctx.font = "600 11px system-ui";
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.shadowBlur = 0;

    const GUTTER = 4; // px of breathing room each side so glyphs do not touch key edges
    // Measure the widest label across the whole mode (not just approaching keys) so the
    // fit decision is stable frame-to-frame as the approaching set changes; a key that
    // would not fit at 11px never gets a name regardless of which subset is showing.
    let widest = 0;
    for (const key of this.keys) {
      if (key.black) continue;
      widest = Math.max(widest, ctx.measureText(midiToLabel(key.midi, this.labelMode)).width);
    }
    if (widest + GUTTER > whiteWidth) return; // too narrow at 11px, skip the whole row

    const baseline = top + this.keyboardHeight - 10;
    for (const key of this.keys) {
      if (key.black) continue;
      // Only label a key whose own note is approaching or sounding right now. The
      // approaching set keys off each note's true midi, so a note clamped to an off-window
      // edge column (issue #33) does not falsely label the edge key; that key labels only
      // when it has its own approaching note.
      if (!approaching.has(key.midi)) continue;
      ctx.fillStyle = active.has(key.midi) ? "#1a0f2b" : "#5b4a72";
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
