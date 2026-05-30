import {
  buildKeyLayout,
  isBlackKey,
  midiToLabel,
  midiToBarLabel,
  noteColor,
  type KeyGeometry,
  type LabelMode,
} from "./piano";

export interface VisNote {
  midi: number;
  time: number; // start time in seconds
  duration: number; // seconds
}

const KEYBOARD_HEIGHT = 140;
const LOOK_AHEAD = 4; // seconds of notes visible above the keyboard

export class Visualizer {
  private ctx: CanvasRenderingContext2D;
  private keys: KeyGeometry[] = [];
  private notes: VisNote[] = [];
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
    this.keys = buildKeyLayout(this.width);

    // Background gradient depends only on height; cache it so the rAF loop never
    // calls createLinearGradient. Replaces the clearRect-to-transparent fill.
    const bg = this.ctx.createLinearGradient(0, 0, 0, this.height);
    bg.addColorStop(0, "#0a0712");
    bg.addColorStop(1, "#120b1f");
    this.bgGradient = bg;
  }

  private keyboardTop(): number {
    return this.height - KEYBOARD_HEIGHT;
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
    const pps = (height - KEYBOARD_HEIGHT) / LOOK_AHEAD; // pixels per second
    const active = this.activeMidis(currentTime);

    this.drawFallingNotes(currentTime, keyboardTop, pps, active);
    this.drawKeyboard(keyboardTop, active);
  }

  private drawFallingNotes(
    currentTime: number,
    keyboardTop: number,
    pps: number,
    active: Set<number>,
  ): void {
    const { ctx } = this;
    // Geometry of bars worth labeling, collected during the fill pass and drawn
    // after, so the bar glow (shadowBlur 18) never bleeds into the glyphs.
    const labels: { x: number; y: number; text: string }[] = [];

    for (const note of this.notes) {
      const delta = note.time - currentTime;
      if (delta > LOOK_AHEAD || delta + note.duration < 0) continue; // off-screen

      const key = this.keys[note.midi - 21];
      if (!key) continue;

      const barHeight = Math.max(6, note.duration * pps);
      const bottom = keyboardTop - delta * pps;
      const top = bottom - barHeight;

      const black = isBlackKey(note.midi);
      const w = key.width * (black ? 1 : 0.82);
      const x = key.x + (key.width - w) / 2;

      // Per-pitch-class colors come from a precomputed table (no per-bar string
      // building). Active bars get a brighter fill and a wider glow.
      const colors = noteColor(note.midi);
      const isActive = active.has(note.midi);
      ctx.fillStyle = isActive
        ? colors.activeFill
        : black
          ? colors.blackFill
          : colors.whiteFill;
      ctx.shadowColor = colors.glow;
      ctx.shadowBlur = isActive ? 20 : 18;
      this.roundRect(x, top, w, barHeight, 4);
      ctx.fill();

      // Contact glow (issue #27): the instant a sounding bar's leading edge reaches the
      // keybed, stroke a soft border in the note's own hue so it visibly "lights up" on
      // the hit, distinct from the steady active fill. Fires only for the small set of
      // bars that are both sounding and touching, so the common falling bar pays nothing.
      const inContact = isActive && bottom >= keyboardTop - 10;
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

      if (this.labelMode !== "off") {
        // Name rides near the TOP of the bar so it never covers the contact point at the
        // bottom of the lane. Active key's bar is always labeled even if narrow; the
        // player needs it now.
        const fits = w >= 16 && barHeight >= 22;
        if (fits || active.has(note.midi)) {
          labels.push({
            x: x + w / 2,
            y: top + 14,
            text: midiToBarLabel(note.midi, this.labelMode),
          });
        }
      }
    }

    // Reset glow before text, draw text, then reset again so nothing else inherits it.
    ctx.shadowBlur = 0;
    if (labels.length > 0) {
      ctx.font = "600 11px system-ui";
      ctx.textAlign = "center";
      ctx.textBaseline = "alphabetic";
      ctx.fillStyle = "rgba(255,255,255,0.82)";
      ctx.shadowColor = "rgba(0,0,0,0.45)";
      ctx.shadowBlur = 2;
      for (const l of labels) {
        ctx.fillText(l.text, l.x, l.y);
      }
      ctx.shadowBlur = 0;
    }
  }

  private drawKeyboard(top: number, active: Set<number>): void {
    const { ctx, width } = this;

    // Dim resting glow strip along the top edge of the keyboard (one gradient
    // per frame, never per key). Dimmer than before so it does not fight hues.
    const grad = ctx.createLinearGradient(0, top - 30, 0, top);
    grad.addColorStop(0, "rgba(177,75,255,0)");
    grad.addColorStop(1, "rgba(177,75,255,0.18)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, top - 30, width, 30);

    // Per-active-key landing bloom: a short vertical glow in the note's own hue,
    // just above the keyboard where bars land. At most "notes sounding" draws.
    this.drawLandingBloom(top, active);

    ctx.fillStyle = "#15101f";
    ctx.fillRect(0, top, width, KEYBOARD_HEIGHT);

    // white keys first, then black keys on top
    for (const key of this.keys) {
      if (key.black) continue;
      ctx.fillStyle = active.has(key.midi)
        ? noteColor(key.midi).activeWhiteKey
        : "#f2ecf8";
      ctx.strokeStyle = "#2a2238";
      ctx.lineWidth = 1;
      ctx.fillRect(key.x, top, key.width, KEYBOARD_HEIGHT);
      ctx.strokeRect(key.x, top, key.width, KEYBOARD_HEIGHT);
    }
    for (const key of this.keys) {
      if (!key.black) continue;
      ctx.fillStyle = active.has(key.midi)
        ? noteColor(key.midi).activeBlackKey
        : "#100b1a";
      ctx.fillRect(key.x, top, key.width, KEYBOARD_HEIGHT * 0.62);
    }

    this.drawKeyLabels(top, active);
  }

  // Vertical bloom above each sounding key, in that note's glow hue, sitting just
  // above the keyboard top where bars land. Drawn before the keybed/keys so the
  // glow reads behind the keys. Resets shadow state when done.
  private drawLandingBloom(top: number, active: Set<number>): void {
    if (active.size === 0) return;
    const { ctx } = this;
    const BLOOM_HEIGHT = 16;
    ctx.globalAlpha = 0.4;
    for (const midi of active) {
      const key = this.keys[midi - 21];
      if (!key) continue;
      const colors = noteColor(midi);
      ctx.fillStyle = colors.glow;
      ctx.shadowColor = colors.glow;
      ctx.shadowBlur = 16;
      this.roundRect(key.x, top - BLOOM_HEIGHT, key.width, BLOOM_HEIGHT, 4);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;
  }

  // White-key pitch-class labels (no octave). Never shrinks below 11px, and
  // skips all-or-nothing: if the widest label for this mode plus a small gutter
  // won't fit a white key, draw no key-face labels this pass (uniform > ragged).
  private drawKeyLabels(top: number, active: Set<number>): void {
    if (this.labelMode === "off") return;
    const { ctx } = this;
    const whiteWidth = this.keys.find((k) => !k.black)?.width ?? 0;
    if (whiteWidth <= 0) return;

    ctx.font = "600 11px system-ui";
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.shadowBlur = 0;

    const GUTTER = 4; // px of breathing room each side so glyphs do not touch key edges
    let widest = 0;
    for (const key of this.keys) {
      if (key.black) continue;
      widest = Math.max(widest, ctx.measureText(midiToLabel(key.midi, this.labelMode)).width);
    }
    if (widest + GUTTER > whiteWidth) return; // too narrow at 11px, skip the whole row

    const baseline = top + KEYBOARD_HEIGHT - 10;
    for (const key of this.keys) {
      if (key.black) continue;
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
