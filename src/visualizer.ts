import {
  buildKeyLayout,
  isBlackKey,
  midiToLabel,
  midiToBarLabel,
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
const ACCENT = "#b14bff";

export class Visualizer {
  private ctx: CanvasRenderingContext2D;
  private keys: KeyGeometry[] = [];
  private notes: VisNote[] = [];
  private width = 0;
  private height = 0;
  private dpr = 1;
  private labelMode: LabelMode = "solfege";

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
    ctx.clearRect(0, 0, width, height);

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
    const labels: { x: number; bottom: number; text: string }[] = [];

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

      ctx.fillStyle = black ? "#8a2fe0" : ACCENT;
      ctx.shadowColor = ACCENT;
      ctx.shadowBlur = 18;
      this.roundRect(x, top, w, barHeight, 4);
      ctx.fill();

      if (this.labelMode !== "off") {
        // Active key's bar is always labeled even if narrow; the player needs it now.
        const fits = w >= 16 && barHeight >= 18;
        if (fits || active.has(note.midi)) {
          labels.push({
            x: x + w / 2,
            bottom: bottom - 6,
            text: midiToBarLabel(note.midi, this.labelMode),
          });
        }
      }
    }

    // Reset glow before text, draw text, then reset again so nothing else inherits it.
    ctx.shadowBlur = 0;
    if (labels.length > 0) {
      ctx.font = "700 12px system-ui";
      ctx.textAlign = "center";
      ctx.textBaseline = "alphabetic";
      ctx.fillStyle = "#ffffff";
      ctx.shadowColor = "rgba(0,0,0,0.45)";
      ctx.shadowBlur = 2;
      for (const l of labels) {
        ctx.fillText(l.text, l.x, l.bottom);
      }
      ctx.shadowBlur = 0;
    }
  }

  private drawKeyboard(top: number, active: Set<number>): void {
    const { ctx, width } = this;

    // glow strip along the top edge of the keyboard
    const grad = ctx.createLinearGradient(0, top - 30, 0, top);
    grad.addColorStop(0, "rgba(177,75,255,0)");
    grad.addColorStop(1, "rgba(177,75,255,0.35)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, top - 30, width, 30);

    ctx.fillStyle = "#15101f";
    ctx.fillRect(0, top, width, KEYBOARD_HEIGHT);

    // white keys first, then black keys on top
    for (const key of this.keys) {
      if (key.black) continue;
      ctx.fillStyle = active.has(key.midi) ? ACCENT : "#f2ecf8";
      ctx.strokeStyle = "#2a2238";
      ctx.lineWidth = 1;
      ctx.fillRect(key.x, top, key.width, KEYBOARD_HEIGHT);
      ctx.strokeRect(key.x, top, key.width, KEYBOARD_HEIGHT);
    }
    for (const key of this.keys) {
      if (!key.black) continue;
      ctx.fillStyle = active.has(key.midi) ? "#d89bff" : "#100b1a";
      ctx.fillRect(key.x, top, key.width, KEYBOARD_HEIGHT * 0.62);
    }

    this.drawKeyLabels(top, active);
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
