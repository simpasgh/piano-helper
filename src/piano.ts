// Standard 88-key piano spans MIDI note 21 (A0) to 108 (C8).
export const FIRST_MIDI = 21;
export const LAST_MIDI = 108;

const BLACK_PITCH_CLASSES = new Set([1, 3, 6, 8, 10]);

export function isBlackKey(midi: number): boolean {
  return BLACK_PITCH_CLASSES.has(((midi % 12) + 12) % 12);
}

export interface KeyGeometry {
  midi: number;
  x: number;
  width: number;
  black: boolean;
}

// Builds left-edge x positions and widths for the keys in `[firstMidi, lastMidi]`,
// scaled to `totalWidth`. White keys tile evenly; black keys are narrower and straddle
// the gap between whites. The range defaults to the full 88-key piano; narrow screens
// pass a smaller window (issue #33) so keys stay legible.
export function buildKeyLayout(
  totalWidth: number,
  firstMidi: number = FIRST_MIDI,
  lastMidi: number = LAST_MIDI,
): KeyGeometry[] {
  let whiteCount = 0;
  for (let m = firstMidi; m <= lastMidi; m++) {
    if (!isBlackKey(m)) whiteCount++;
  }
  const whiteWidth = totalWidth / whiteCount;
  const blackWidth = whiteWidth * 0.62;

  const keys: KeyGeometry[] = [];
  let whiteIndex = 0;
  for (let m = firstMidi; m <= lastMidi; m++) {
    if (isBlackKey(m)) {
      // Black key sits centered on the boundary between the previous and next white key.
      const x = whiteIndex * whiteWidth - blackWidth / 2;
      keys.push({ midi: m, x, width: blackWidth, black: true });
    } else {
      keys.push({ midi: m, x: whiteIndex * whiteWidth, width: whiteWidth, black: false });
      whiteIndex++;
    }
  }
  return keys;
}

export function midiToName(midi: number): string {
  const names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const octave = Math.floor(midi / 12) - 1;
  return `${names[((midi % 12) + 12) % 12]}${octave}`;
}

export type LabelMode = "solfege" | "letters" | "off";

// Which hand plays a note (issue #36). "right" = treble staff, "left" = bass staff,
// "unknown" = single-staff or audio-derived scores with no hand information.
export type Hand = "left" | "right" | "unknown";

// Maps a note's staff index within its instrument to a hand. Grand-staff piano music
// has two staves: index 0 (treble) is the right hand, index 1 (bass) is the left hand.
// A single-staff part cannot be split into hands, so it degrades to "unknown".
export function handFromStaffIndex(index: number, staffCount: number): Hand {
  if (staffCount < 2 || index < 0) return "unknown";
  return index === 0 ? "right" : "left";
}

// Always-sharp spellings; "Si" (not "Ti") for the 7th degree per the solfege spec.
const LETTER_CLASSES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const SOLFEGE_CLASSES = [
  "Do", "Do#", "Re", "Re#", "Mi", "Fa", "Fa#", "Sol", "Sol#", "La", "La#", "Si",
];

// Pitch-class label only (no octave). Returns "" for off mode.
// Callers that want an octave (letter-mode falling bars) use midiToBarLabel.
export function midiToLabel(midi: number, mode: LabelMode): string {
  if (mode === "off") return "";
  const pc = ((midi % 12) + 12) % 12;
  return mode === "solfege" ? SOLFEGE_CLASSES[pc] : LETTER_CLASSES[pc];
}

// Label for a falling bar: solfege has no octave; letters append the octave
// (scientific pitch), e.g. "C4". Octave convention matches midiToName.
export function midiToBarLabel(midi: number, mode: LabelMode): string {
  if (mode === "off") return "";
  const base = midiToLabel(midi, mode);
  if (mode === "letters") {
    const octave = Math.floor(midi / 12) - 1;
    return `${base}${octave}`;
  }
  return base;
}

// --- Color (issue #12): pitch-class hue wheel, purple-anchored. ---

// Pitch class 0..11 (C..B), handling negative midi defensively.
export function pitchClass(midi: number): number {
  return ((midi % 12) + 12) % 12;
}

// Pure, unit-testable hue math: hue = (276 + pc * 30) mod 360 degrees.
// 276deg is the hue of the brand violet #b14bff, so C/Do anchors on purple.
// Depends only on pitch class, so octaves share a hue.
export function pitchHue(midi: number): number {
  return (276 + pitchClass(midi) * 30) % 360;
}

// Colors a note carries, derived from its pitch class. S/L are fixed per row
// (white vs black key); only hue varies by pitch class.
export interface NoteColors {
  hue: number;
  whiteFill: string; // white-key note bar fill
  blackFill: string; // black-key note bar fill
  glow: string; // per-note glow (shadowColor) and landing bloom
  activeFill: string; // active (sounding) bar fill
  activeWhiteKey: string; // active white key face fill
  activeBlackKey: string; // active black key face fill
}

function buildNoteColors(hue: number): NoteColors {
  return {
    hue,
    whiteFill: `hsl(${hue}, 85%, 62%)`,
    blackFill: `hsl(${hue}, 70%, 50%)`,
    glow: `hsl(${hue}, 90%, 68%)`,
    activeFill: `hsl(${hue}, 95%, 72%)`,
    activeWhiteKey: `hsl(${hue}, 85%, 66%)`,
    activeBlackKey: `hsl(${hue}, 80%, 60%)`,
  };
}

// Precomputed 12-entry pitch-class -> colors table, built once at module load.
// The rAF render loop indexes this instead of building hsl strings per note.
const PITCH_CLASS_COLORS: readonly NoteColors[] = Array.from({ length: 12 }, (_, pc) =>
  buildNoteColors((276 + pc * 30) % 360),
);

// Colors for a midi note, looked up from the precomputed table (no per-call
// string building). Hue is a function of pitch class only.
export function noteColor(midi: number): NoteColors {
  return PITCH_CLASS_COLORS[pitchClass(midi)];
}
