import { midiToLabel, type LabelMode, type NoteSpelling } from "./piano";

// Pure layout logic for the sheet note-name overlay (issue #17).
//
// The DOM/OSMD glue in main.ts walks the rendered SVG, reads each notehead's
// bounding box, and produces a flat list of NotePosition records (one per
// sounding notehead) in coordinates relative to the scrolled #sheet container.
// This module turns that geometry plus the current LabelMode into the laid-out
// label items (text + center-x + baseline-y), applying the chord stacking and
// the horizontal density-drop rule from the design spec. Keeping it DOM-free
// makes the stacking/density math unit-testable without a browser.

// One sounding notehead read from OSMD. x is the notehead center-x; y is the
// notehead top (bbox top). Both relative to the scrolled #sheet content box.
export interface NotePosition {
  midi: number;
  x: number;
  y: number;
  // Optional priority hints. active = note under the OSMD cursor (kept first
  // when space is scarce). Falsy/absent means a normal note.
  active?: boolean;
  // The note's printed spelling from the sheet (issues #56/#58), so the overlay name
  // matches the staff beneath it (a "Db" reads "Db"/"Reb", not "C#"/"Do#"). Absent falls
  // back to the always-sharp MIDI name.
  spelling?: NoteSpelling;
}

// A laid-out label ready to be positioned in the overlay.
export interface LabelItem {
  text: string;
  // center-x of the label (matches the chord/notehead center-x).
  x: number;
  // baseline-y of the label (top of stack sits highest).
  y: number;
  midi: number;
}

// Baseline of the lowest label in a stack sits this many px above the top
// notehead of the chord.
const TOP_OFFSET = 6;
// Vertical gap between stacked labels in a chord (1px more than the 9px cap
// height so glyphs never touch).
const STACK_GAP = 11;
// Two noteheads within this x distance belong to the same chord / staff entry.
const CHORD_X_EPSILON = 0.5;
// Approximate width budget per glyph at 9px/600. Used only by the horizontal
// density rule to decide when two adjacent chords' labels would overlap.
const APPROX_GLYPH_WIDTH = 6;

interface Chord {
  x: number;
  // top notehead y (smallest y, since y grows downward).
  topY: number;
  // notes sorted top-of-staff first (highest pitch first).
  notes: NotePosition[];
  active: boolean;
}

function approxLabelWidth(text: string): number {
  return Math.max(APPROX_GLYPH_WIDTH, text.length * APPROX_GLYPH_WIDTH);
}

// Group noteheads that share an x into chords, sorted by x ascending. Within a
// chord, notes are ordered highest-pitch-first so labels stack top-note-highest.
function groupChords(notes: NotePosition[]): Chord[] {
  const sorted = [...notes].sort((a, b) => a.x - b.x);
  const chords: Chord[] = [];
  for (const note of sorted) {
    const last = chords[chords.length - 1];
    if (last && Math.abs(note.x - last.x) <= CHORD_X_EPSILON) {
      last.notes.push(note);
      last.topY = Math.min(last.topY, note.y);
      last.active = last.active || !!note.active;
    } else {
      chords.push({ x: note.x, topY: note.y, notes: [note], active: !!note.active });
    }
  }
  for (const chord of chords) {
    // Highest pitch first (top of staff). Ties keep input order.
    chord.notes.sort((a, b) => b.midi - a.midi);
  }
  return chords;
}

// Lay out the sheet note-name labels for one render.
//
// Returns one LabelItem per kept notehead. Off mode returns []. Each chord's
// labels share the chord center-x and stack upward (top note highest) by
// STACK_GAP, with the lowest label TOP_OFFSET px above the top notehead.
//
// Density rule: if two adjacent chords are horizontally closer than the wider
// of their two top-note labels, the lower-priority chord drops all but its top
// note. Priority: active (cursor) chord > others; among equals the leftmost.
// The top note of every chord is always kept so the melody line stays labeled.
export function layoutSheetLabels(notes: NotePosition[], mode: LabelMode): LabelItem[] {
  if (mode === "off") return [];

  const chords = groupChords(notes);
  if (chords.length === 0) return [];

  // Decide, per chord, whether to keep only the top note (collapsed) because a
  // neighbor's label would overlap it. Walk adjacent pairs; collapse the
  // lower-priority chord of an overlapping pair.
  const collapsed = new Array<boolean>(chords.length).fill(false);
  for (let i = 0; i < chords.length - 1; i++) {
    const a = chords[i];
    const b = chords[i + 1];
    const aTopText = midiToLabel(a.notes[0].midi, mode, a.notes[0].spelling);
    const bTopText = midiToLabel(b.notes[0].midi, mode, b.notes[0].spelling);
    const needed = Math.max(approxLabelWidth(aTopText), approxLabelWidth(bTopText));
    const gap = b.x - a.x;
    if (gap < needed) {
      // Keep the higher-priority chord full; collapse the other. Active wins;
      // otherwise collapse the right (later) chord so the leftmost is favored.
      if (b.active && !a.active) {
        collapsed[i] = true;
      } else {
        collapsed[i + 1] = true;
      }
    }
  }

  const items: LabelItem[] = [];
  for (let i = 0; i < chords.length; i++) {
    const chord = chords[i];
    const keep = collapsed[i] ? chord.notes.slice(0, 1) : chord.notes;
    // keep[0] is the top note (drawn highest); the LAST kept note sits lowest,
    // TOP_OFFSET above the top notehead, and the stack grows upward.
    const lowestBaseline = chord.topY - TOP_OFFSET;
    for (let j = 0; j < keep.length; j++) {
      const note = keep[j];
      const text = midiToLabel(note.midi, mode, note.spelling);
      if (!text) continue;
      // j counts from the top of the stack; the lowest label (largest j) sits
      // at lowestBaseline, each higher one is STACK_GAP further up.
      const fromBottom = keep.length - 1 - j;
      const y = lowestBaseline - fromBottom * STACK_GAP;
      items.push({ text, x: chord.x, y, midi: note.midi });
    }
  }
  return items;
}
