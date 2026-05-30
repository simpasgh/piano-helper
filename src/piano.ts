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

// Fraction of a white key's width that a falling white-note bar occupies, so the bar
// sits inside its lane with a small gutter on each side. Black-note bars fill their
// (already narrow) key width. Any contact highlight at the keybed must stay within this
// width, never the full key width, or it reads as a box sticking out past the note
// (issue #38).
export const WHITE_BAR_WIDTH_RATIO = 0.82;

export function noteBarWidth(keyWidth: number, black: boolean): number {
  return keyWidth * (black ? 1 : WHITE_BAR_WIDTH_RATIO);
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

// Whether a note belongs to a hand the player has muted (issue #54). "unknown"-hand notes
// (single-staff or audio-derived scores) are never muted, so those scores are unaffected.
export function isHandMuted(
  hand: Hand | undefined,
  mutedHands: { left: boolean; right: boolean },
): boolean {
  return (
    (hand === "left" && mutedHands.left) || (hand === "right" && mutedHands.right)
  );
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

// --- Falling-note label fit (issue #39): the name must always fit the bar. ---

// Smallest legible glyph size on the dark stage; below this we omit the label.
export const MIN_LABEL_PX = 8;
// Ceiling so a tall bar's name never grows past the historical ~11-12px look.
export const MAX_LABEL_PX = 12;
// Font size is derived from the bar HEIGHT (the binding dimension for short notes).
export const LABEL_HEIGHT_RATIO = 0.55;
// Per-character width estimate as a fraction of font size (safe upper bound for
// system-ui letters/digits at these sizes), used to fit the name to the bar width
// without a canvas measureText in the hot loop.
export const LABEL_CHAR_WIDTH_RATIO = 0.62;
// Breathing room kept on each side of the name inside the bar.
export const LABEL_GUTTER = 2;

export interface BarLabelFit {
  show: boolean;
  fontSize: number; // px; only meaningful when show is true
}

// Decides whether a falling note's name fits its bar and at what font size, so the
// label never exceeds the note's bounds (issue #39). Pure and DOM-free: the visualizer
// passes the bar's drawn width/height and the name's character count, paints if `show`.
//
// Rule: scale the font to the bar height (clamped MIN..MAX), then shrink further if the
// name is too wide for the bar; if it still does not fit at MIN_LABEL_PX in either axis,
// omit the label (a bar that small reads better with no detached name than a forced one).
export function fitBarLabel(
  barWidth: number,
  barHeight: number,
  charCount: number,
): BarLabelFit {
  if (charCount <= 0) return { show: false, fontSize: 0 };

  // Start from the height-derived size, capped at MAX.
  let size = Math.min(MAX_LABEL_PX, Math.floor(barHeight * LABEL_HEIGHT_RATIO));

  // The name must fit the bar width: width(size) = charCount * size * ratio + 2*gutter.
  // Solve for the largest size that fits, then take the smaller of the two constraints.
  const usableWidth = barWidth - 2 * LABEL_GUTTER;
  if (usableWidth > 0) {
    const widthCap = Math.floor(usableWidth / (charCount * LABEL_CHAR_WIDTH_RATIO));
    size = Math.min(size, widthCap);
  } else {
    size = 0;
  }

  // Too small to be legible in either axis -> omit (the #39 fallback).
  if (size < MIN_LABEL_PX) return { show: false, fontSize: 0 };
  return { show: true, fontSize: size };
}

// --- Unified note-name labeling (issues #42, #43): one consistent model for both the
// falling-note names and the keyboard key names, shared across hands. ---

// A note as seen by the labeling helpers: just its identity and timing. Both the
// falling-bar labeling (#42) and the approaching-key labeling (#43) decide off this
// shape, so the two label sets are derived from one source and stay consistent.
export interface LabelNote {
  midi: number;
  time: number;
  duration: number;
  hand?: Hand;
}

// Tiny epsilon so notes that share an onset (a chord) or sit a hair apart still group
// as one run / one chord. Seconds.
const LABEL_TIME_EPSILON = 1e-3;

// Decides, per note, whether its falling bar should carry a name (issue #42). The rule
// is identity-based and HAND-AGNOSTIC, which fixes the bug where right-hand (short, quick
// melody) notes were silently dropped by the height-derived fit while left-hand (longer,
// sustained) notes were always labeled: that per-hand difference was an emergent artifact
// of bar height, not an intentional rule. Here both hands obey the same rule.
//
// Rule: label the FIRST note of every run of consecutive same-pitch notes, and re-label
// only when the pitch changes. A run is consecutive same-`midi` notes within the same
// hand lane, ordered by time; the second, third, ... repeat of a pitch is left unlabeled
// so a repeated "Do Do Do" reads as one clear name instead of a noisy stack. Notes of a
// different pitch (or the same pitch in the other hand's lane) each start their own run.
//
// Returns a boolean per input note, index-aligned to `notes` AS GIVEN (the caller keeps
// its own order; we do not reorder the caller's array). Pure and DOM-free for unit tests.
export function labelableFallingNotes(notes: readonly LabelNote[]): boolean[] {
  // Track the last labeled pitch per hand lane independently, so the left and right
  // melodic lines each dedupe within themselves and never suppress each other.
  const lastMidiByLane = new Map<string, number>();
  // Sort indices by time so "consecutive" means consecutive in playback, not array order;
  // map the decision back onto the original indices.
  const order = notes
    .map((n, i) => ({ n, i }))
    .sort((a, b) => a.n.time - b.n.time || a.i - b.i);

  const result = new Array<boolean>(notes.length).fill(false);
  for (const { n, i } of order) {
    const lane = n.hand ?? "unknown";
    const prev = lastMidiByLane.get(lane);
    // First note in the lane, or a pitch change from the previous note in this lane,
    // gets the label; an immediate repeat of the same pitch does not.
    const isRunStart = prev === undefined || prev !== n.midi;
    result[i] = isRunStart;
    lastMidiByLane.set(lane, n.midi);
  }
  return result;
}

// The look-ahead window (seconds) for which keyboard keys get a name (issue #43). Set
// equal to the falling-note visible window so a key shows its name exactly while its note
// is visible falling toward it: the keyboard label set is "keys whose note you can see
// coming", which is the cleanest, least-surprising rule and keeps the two label systems
// (falling bars and keys) in lockstep. Kept here so the visualizer's LOOK_AHEAD and this
// stay a single shared number.
export const KEY_LABEL_LOOK_AHEAD = 4;

// The set of midi notes whose key should be labeled right now (issue #43): only keys with
// a falling note approaching within the look-ahead window, plus any note currently
// sounding. Replaces "label every key" with "label the keys that matter right now". When
// nothing is approaching the set is empty (no key labels); a chord puts every chord pitch
// in the set, so chords stay fully labeled.
//
// A note counts as approaching/active when `currentTime` is within
// `[note.time - lookAhead, note.time + note.duration]`: it has entered the visible window
// above the keyboard (start) and has not yet finished sounding (end). Pure and DOM-free.
export function approachingKeyMidis(
  notes: readonly LabelNote[],
  currentTime: number,
  lookAhead: number = KEY_LABEL_LOOK_AHEAD,
): Set<number> {
  const midis = new Set<number>();
  for (const n of notes) {
    if (
      currentTime >= n.time - lookAhead - LABEL_TIME_EPSILON &&
      currentTime <= n.time + n.duration + LABEL_TIME_EPSILON
    ) {
      midis.add(n.midi);
    }
  }
  return midis;
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
