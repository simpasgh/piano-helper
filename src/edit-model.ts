// The editable NOTATION MODEL: the single source of truth for Smart Edit Mode (P1).
//
// Architecture (ratified in docs/context/tech-lead.md, 2026-06-04): an in-house notation
// model is the source of truth; Verovio is a render+sync engine driven FROM the model; the
// falling notes (VisNote[]) and the sheet cursor (stepTimes) are re-derived from the model
// after every edit, so the sync invariant (one timestamp source) holds by construction.
//
// P1 representation: a PITCH-TARGETED mutation over the retained source MusicXML DOM. The
// model parses the MusicXML once into a DOM, indexes every pitched <note> element in document
// order as a stable "handle", and computes each handle's onset seconds + MIDI + spelling by
// walking the part the same way score.ts/extractScore conceptually does (divisions, backup /
// forward, chords share an onset, ties merge into the start). A pitch edit mutates the
// handle's <pitch> element in place; serialize() re-emits the MusicXML for Verovio to engrave.
//
// Why DOM mutation over a from-scratch model for P1: pitch is a clean, LOCAL edit (set
// step / octave / alter on one <note>) with no reflow and no time change, so direct DOM
// surgery round-trips cleanly to Verovio and re-derives VisNote[] with zero risk to timing.
// The spike's warning against XML surgery was specifically about DURATION / rest / tie edits
// (P3); pitch is the safe axis to prove the whole edit -> render -> re-derive loop on. The
// model is EXTENSIBLE toward duration: P3 mutates <duration>/<type> + adds a fixed-bar
// validator over the SAME measure structure these handles already expose.
//
// Handle identity is STABLE for the edit session: pitch-only editing never adds, removes, or
// reorders <note> elements, so a handle's index into the pitched-note list is a permanent id
// the command stack keys on. The mapping handle <-> VisNote index is rebuilt by (midi, onset)
// after each edit (reusing the proven keying in verovio-view.ts), so selection follows a note
// across re-renders even though its MIDI changed.

import { FIRST_MIDI, LAST_MIDI, type NoteLetter, type NoteSpelling } from "./piano";

// Re-export the 88-key clamp bounds so callers that key on the model's range (e.g. the edit
// orchestrator's boundary announce) have one import site alongside pitchInRange / the stepping.
export { FIRST_MIDI, LAST_MIDI };

// A diatonic pitch as written on the staff: letter + octave (scientific) + accidental shift.
// This is what an edit sets and what serialize() writes back into <pitch>.
export interface ModelPitch {
  step: NoteLetter;
  octave: number;
  alter: number; // MusicXML <alter>: +1 sharp, -1 flat, +2/-2 doubles, 0 natural
}

// A handle on one pitched <note> in the model. `id` is its stable index in the document-order
// pitched-note list. `visMidi`/`onsetSec` are the keys used to map to a VisNote. A tie
// continuation (a <note> with <tie type="stop"> and no "start") is folded into its start note
// in the VisNote[] (score.ts merges ties), so it gets NO VisNote of its own; we still keep a
// handle for it so the DOM stays fully indexed, but `isTieContinuation` marks it un-mappable.
export interface NoteHandle {
  id: number;
  el: Element; // the <note> element this handle owns (mutated in place by setPitch)
  pitchEl: Element; // its <pitch> child (cached; pitch edits rewrite its children)
  onsetSec: number;
  midi: number;
  pitch: ModelPitch;
  isChordMember: boolean;
  isTieContinuation: boolean;
  // Time geometry of the note, so a duration edit can step the value ladder and re-derive the
  // falling note (which needs SECONDS) without a re-parse, and so the readout/announce can name
  // the current value. `durationDivs` is the <duration> in this measure's `divisions`; `divisions`
  // is that measure's <divisions> per quarter (load-bearing 4 for our OMR). `durationSec` is the
  // note's length in seconds (parallel to RestHandle.durationSec) at the model's tempo.
  durationDivs: number;
  divisions: number;
  durationSec: number;
}

// A handle on one <rest> in the model (ADD-a-note v1). A rest is SELECTABLE and CONVERTIBLE to a
// note, but it is NOT a NoteHandle, so nothing iterating pitched notes (staff nav, the handle <->
// VisNote map, the note count, delete / pitch / undo keying) ever sees it. Rests live in a
// separate `restHandles[]` registry, rebuilt in the same walk that builds the note handles.
// `id` is the rest's index in the document-order rest list (stable until a structural edit, like a
// note handle's id). `staff`/`voice`/`durationDivs` + `onsetSec` let the render side map a rest to
// the Verovio rest glyph by (onset, staff); `beat` is the 1-based beat for the selection announce.
export interface RestHandle {
  id: number;
  el: Element; // the <note> element carrying the <rest/> (replaced in place by addNote)
  onsetSec: number;
  durationSec: number;
  durationDivs: number; // <duration> in this measure's divisions (for the render-side match)
  type: string; // the <type> token (e.g. "quarter"); "" when the rest has none
  staff: number; // 1-based <staff>; 1 when absent
  voice: number; // 1-based <voice>; 1 when absent
  beat: number; // 1-based beat within the measure (onset / quarter-divisions + 1), for announce
}

// Semitone offset of each diatonic letter from C within an octave.
const LETTER_SEMITONE: Record<NoteLetter, number> = {
  C: 0,
  D: 2,
  E: 4,
  F: 5,
  G: 7,
  A: 9,
  B: 11,
};

const LETTERS: readonly NoteLetter[] = ["C", "D", "E", "F", "G", "A", "B"];

// MIDI number for a written pitch. MusicXML octave 4 = the octave starting at middle C
// (C4 = MIDI 60), so midi = (octave + 1) * 12 + letterSemitone + alter.
export function midiFromPitch(p: ModelPitch): number {
  return (p.octave + 1) * 12 + LETTER_SEMITONE[p.step] + p.alter;
}

// Whether a written pitch lands on the 88-key piano (MIDI 21..108). The stepping functions clamp
// to this range so an edit can never push a note off the keyboard: at the boundary the step is a
// no-op (the function returns the unchanged pitch), which the caller detects (same MIDI) and skips
// so no command is pushed and nothing is announced as a move.
export function pitchInRange(p: ModelPitch): boolean {
  const m = midiFromPitch(p);
  return m >= FIRST_MIDI && m <= LAST_MIDI;
}

// The order of sharps / flats as they appear in a key signature, by letter. Positive `fifths`
// adds sharps in this order; negative adds flats in the reverse order. Used to decide a
// letter's DIATONIC accidental in a given key (key-signature-aware diatonic stepping).
const SHARP_ORDER: readonly NoteLetter[] = ["F", "C", "G", "D", "A", "E", "B"];
const FLAT_ORDER: readonly NoteLetter[] = ["B", "E", "A", "D", "G", "C", "F"];

// The accidental a letter carries in the key signature with `fifths` sharps (negative = flats).
// E.g. fifths=+2 (D major) -> F and C are sharp, everything else natural; fifths=-3 (Eb major)
// -> B, E, A are flat. This is what "diatonic" means for stepping: the next letter takes the
// key's accidental, so stepping up from E in C major lands on F natural, and in D major on F#.
export function keyAlterForLetter(letter: NoteLetter, fifths: number): number {
  if (fifths > 0) {
    return SHARP_ORDER.slice(0, Math.min(fifths, 7)).includes(letter) ? 1 : 0;
  }
  if (fifths < 0) {
    return FLAT_ORDER.slice(0, Math.min(-fifths, 7)).includes(letter) ? -1 : 0;
  }
  return 0;
}

// Move a pitch one DIATONIC step (next/prev letter), key-signature aware. The new letter takes
// the key's accidental, so the result is a natural diatonic move (E -> F in C major, E -> F# in
// D major). Crossing the B/C boundary moves the octave. Pure.
export function diatonicStep(p: ModelPitch, dir: 1 | -1, fifths: number): ModelPitch {
  const idx = LETTERS.indexOf(p.step);
  let next = idx + dir;
  let octave = p.octave;
  if (next > 6) {
    next = 0;
    octave += 1; // ... B -> C of the next octave
  } else if (next < 0) {
    next = 6;
    octave -= 1; // C -> B of the octave below
  }
  const step = LETTERS[next];
  const candidate: ModelPitch = { step, octave, alter: keyAlterForLetter(step, fifths) };
  // Clamp to the 88-key range: at the boundary the step is a no-op (return the unchanged pitch).
  return pitchInRange(candidate) ? candidate : p;
}

// Move a pitch one CHROMATIC semitone (Ctrl on the staff; the canvas's native unit). Prefer
// keeping the LETTER and changing the accidental (the way you reach a sharp/flat), within the
// +-2 double-accidental range; if that would exceed it, fall to the neighbouring letter at the
// correct enharmonic so the pitch is still right. Pure; preserves a valid spelling for Verovio.
export function chromaticStep(p: ModelPitch, dir: 1 | -1): ModelPitch {
  const targetMidi = midiFromPitch(p) + dir;
  // Clamp to the 88-key range: a semitone past the lowest/highest key is a no-op.
  if (targetMidi < FIRST_MIDI || targetMidi > LAST_MIDI) return p;
  const nextAlter = p.alter + dir;
  if (nextAlter >= -2 && nextAlter <= 2) {
    // Same letter + adjusted accidental keeps the written letter (E -> E#, E -> Eb).
    return { step: p.step, octave: p.octave, alter: nextAlter };
  }
  // Past the double accidental: move to the adjacent letter and re-spell at the target MIDI.
  return pitchFromMidi(targetMidi, dir);
}

// Move a pitch by a whole OCTAVE (Shift), keeping the written letter + accidental. Pure. Clamps
// to the 88-key range: an octave past the lowest/highest key is a no-op (returns the unchanged
// pitch). An octave is 12 semitones, so unlike a step this can over/undershoot by a wide margin.
export function octaveStep(p: ModelPitch, dir: 1 | -1): ModelPitch {
  const candidate: ModelPitch = { step: p.step, octave: p.octave + dir, alter: p.alter };
  return pitchInRange(candidate) ? candidate : p;
}

// A default spelling for a MIDI pitch, used by the CHROMATIC (canvas) path and the chromatic
// staff fallback. White keys spell as the natural letter; black keys spell with a sharp when
// moving up and a flat when moving down (the conventional accidental for the direction), so a
// canvas semitone nudge engraves a sensible accidental on the staff. `dir` defaults to up.
export function pitchFromMidi(midi: number, dir: 1 | -1 = 1): ModelPitch {
  const octave = Math.floor(midi / 12) - 1;
  const pc = ((midi % 12) + 12) % 12;
  // White-key pitch classes map straight to a natural letter.
  const NATURAL: Record<number, NoteLetter> = {
    0: "C",
    2: "D",
    4: "E",
    5: "F",
    7: "G",
    9: "A",
    11: "B",
  };
  if (pc in NATURAL) return { step: NATURAL[pc], octave, alter: 0 };
  // Black keys: sharp of the letter below (up) or flat of the letter above (down).
  if (dir > 0) {
    const below = NATURAL[pc - 1];
    return { step: below, octave, alter: 1 };
  }
  const above = NATURAL[pc + 1];
  // A flat of C / F would cross an octave/letter awkwardly; pc+1 is always a natural here
  // (1->D,3->E,6->G,8->A,10->B), so this is safe.
  return { step: above, octave, alter: -1 };
}

const num = (el: Element | null, fallback: number): number => {
  const t = el?.textContent?.trim();
  if (t === undefined || t === "") return fallback;
  const n = Number(t);
  return Number.isFinite(n) ? n : fallback;
};

const child = (el: Element, tag: string): Element | null =>
  el.getElementsByTagName(tag).item(0);

// Read a <pitch> element into a ModelPitch. Defensive: a malformed pitch falls back to C4.
function readPitch(pitchEl: Element): ModelPitch {
  const stepText = (child(pitchEl, "step")?.textContent?.trim() ?? "C").toUpperCase();
  const step = (LETTERS.includes(stepText as NoteLetter) ? stepText : "C") as NoteLetter;
  const octave = num(child(pitchEl, "octave"), 4);
  const alter = num(child(pitchEl, "alter"), 0);
  return { step, octave, alter };
}

// The MusicXML <accidental> token for an alter value, or null when no accidental should print
// (alter 0 prints nothing unless a natural is needed; the caller decides whether to emit one).
function accidentalToken(alter: number): string | null {
  switch (alter) {
    case 2:
      return "double-sharp";
    case 1:
      return "sharp";
    case 0:
      return "natural";
    case -1:
      return "flat";
    case -2:
      return "flat-flat";
    default:
      return null;
  }
}

// What a DELETE captured, so it can be inverted (the note restored exactly where it was). Delete
// is FIXED-BAR: the deleted note's time slot is preserved so the measure still adds up and nothing
// after it reflows. A standalone note becomes a REST of the same duration in place; a chord member
// is removed (a rest cannot stack in a chord) while the chord's onset note keeps the slot full; a
// chord ONSET note with following members is removed after promoting the next member to the onset
// (stripping its <chord/>) so the duration-advance is preserved. Restoring re-inserts the original
// <note> element (a deep clone, with its pitch/ties/beams/accidental intact) at its prior position
// and reverses any promotion, then re-indexes. Holds live DOM references, so it is model-internal.
export interface DeleteRecord {
  // The original <note> element (cloned at delete time) and where it was, for re-insertion.
  removedClone: Element;
  parent: Element;
  nextSibling: Node | null;
  // If this delete CONVERTED the note to a rest in place, the rest element that replaced it (so
  // restore swaps the clone back in for the rest). Null when the delete REMOVED the element.
  restPlaceholder: Element | null;
  // If this delete promoted a following chord member to the onset (stripped its <chord/>), the
  // promoted element + the <chord/> child that was removed, so restore can re-insert it.
  promoted: { el: Element; chordChild: Element } | null;
}

// What an ADD captured, so it can be inverted (the note turned straight back into the rest it came
// from). ADD is the exact mirror of a STANDALONE-note delete: a `<rest>` becomes a `<note>` of the
// SAME `<duration>`/`<type>`/dots/`<voice>`/`<staff>` IN PLACE (fixed-bar, no timing math), at the
// given pitch. invert() swaps the original rest clone back in for the added note. Holds live DOM
// references, so it is model-internal.
export interface AddRecord {
  // The added <note> element now in the DOM (so invert can find + replace it), and the original
  // <rest>-bearing <note> (cloned at add time) to swap back on undo.
  addedNote: Element;
  restClone: Element;
}

// What a CHANGE-DURATION captured, so it can be inverted exactly. A duration edit can touch SEVERAL
// elements in one bar (the edited note's <duration>/<type>/<dot>, a freed-time REST inserted on
// shorten, and shrunk/removed trailing rests on lengthen + ripple), so rather than tracking each
// surgical change we snapshot the edited note's whole parent <measure> children (deep clones) BEFORE
// mutating. invert() clears the live measure's children and re-appends the snapshot, restoring the
// bar exactly (durations, onsets, rests, order), then re-indexes. The measure ELEMENT itself is
// never replaced (only its children), so this reference survives undo/redo. Model-internal (live
// DOM refs). `outcome`/`from`/`to`/`dottedSnap` describe the edit for the orchestrator's announce.
export interface ChangeDurationRecord {
  measureEl: Element; // the <measure> whose children were mutated (stable node, never replaced)
  childrenBefore: Node[]; // deep clones of measureEl's children at edit time, for invert
  outcome: "stepped" | "clamped" | "noRoom" | "atEnd";
  // The value NAMES for the announce (current Names mode is applied by the orchestrator's pitch
  // label, but the value words come from here). `fromName` is the pre-edit value (possibly dotted);
  // `toName` is the new value ("" when clamped to a fill duration that has no plain ladder name).
  fromName: string;
  toName: string;
  // A dotted/odd arrival was snapped to the nearest plain rung as part of this edit (folds into the
  // announce, e.g. "Dotted quarter to quarter"). False for a plain-to-plain step.
  dottedSnap: boolean;
  // The direction the user asked for, so the announce/undo can say "lengthen"/"shorten"/"dot". The
  // DOT toggle (v1) reuses the lengthen path to ADD a dot (x1.5) and the shorten path to REMOVE it
  // (back to the plain value), so its undo/redo flows through the same restoreDuration + command.
  direction: "shorter" | "longer" | "dot";
  // For a "dot" edit, whether it GREW (added a dot, a lengthen) or SHRANK (removed/normalized a dot, a
  // shorten), so the undo/redo announce reuses the stepper phrasing ("Undid lengthen to dotted
  // quarter" / "Undid shorten to quarter"). Undefined for a shorter/longer step (its own direction
  // already names the verb).
  dotVerb?: "lengthen" | "shorten";
}

// The editable score model. Holds the parsed DOM and the ordered pitched-note handles. Edits
// mutate the DOM through handles; serialize() re-emits MusicXML for Verovio.
//
// HANDLE-ID STABILITY: a handle's `id` is its index in the document-order pitched-note list. Pitch
// edits never change that list, so ids are stable across pitch edits. A DELETE removes a note, so
// the model RE-INDEXES (handles after the deleted one shift down by one); restoring re-inserts at
// the original DOM position, which restores the original ids. So a handle id is really "the note at
// this document position", and the delete command keys on that position for undo/redo.
export interface ScoreModel {
  handles: NoteHandle[];
  // The document-order rest registry (ADD-a-note v1). Parallel to `handles`, rebuilt by the same
  // walk; a rest is selectable + convertible but never a NoteHandle, so the pitched-note machinery
  // is unchanged. Empty for a score with no rests.
  restHandles: RestHandle[];
  setPitch(id: number, pitch: ModelPitch): void;
  // Delete the note as a FIXED-BAR rest (see DeleteRecord) and re-index. Returns the record needed
  // to invert, or null for an invalid id. The VisNote count drops by one (the rest / removal emits
  // no handle), so the caller must re-derive the falling notes + rebuild the maps.
  deleteNote(id: number): DeleteRecord | null;
  // Invert a delete: re-insert the original note at its prior position (reversing any promotion)
  // and re-index, so the restored note reclaims its original handle id.
  restoreNote(record: DeleteRecord): void;
  // ADD-a-note v1: turn the rest with `restId` into a `<note>` of the SAME duration at `pitch`
  // (fixed-bar, the inverse of a standalone-note delete) and re-index. Returns the record needed to
  // invert, or null for an invalid id. The VisNote count GROWS by one (a new pitched handle), so the
  // caller must splice the falling note in + rebuild the maps. The new note takes the key
  // signature's accidental for its letter unless `pitch.alter` departs from it (synced like setPitch).
  addNote(restId: number, pitch: ModelPitch): AddRecord | null;
  // Invert an add: swap the original rest back in for the added note and re-index, so the rest
  // reclaims its original rest-handle id (literally the standalone delete path).
  removeNote(record: AddRecord): void;
  // CHANGE-DURATION v1: step the note `id` one notch SHORTER or LONGER along the plain value ladder
  // (16th..whole), FIXED-BAR. Shorten shrinks the note and inserts a REST of the freed time right
  // after it (the bar stays full, following onsets unchanged). Lengthen grows the note, ripples the
  // following same-voice events later, and absorbs trailing REST space; if the next rung overflows
  // the room it CLAMPS to the barline (the note fills the bar). A dotted/odd ARRIVAL snaps to the
  // nearest plain rung first. Sets BOTH <duration> and <type>; a plain-rung step writes ZERO <dot>
  // and removes existing dots. Returns the record needed to invert (snapshots the bar), or null for
  // an invalid id, a rest end-clamp no-op, or a no-room no-op (the record's `outcome` distinguishes
  // them so the caller can announce). Note handle ids are STABLE (no pitched note is added/removed),
  // so the selection stays on the same handle; rest ids may shift, so the caller rebuilds the maps.
  //
  // The "dot" DIRECTION (DOTTED v1) is a binary toggle on the SAME machinery: on a PLAIN note it
  // ADDS a single dot (grow to x1.5 of the plain value, exactly one <dot>) via the lengthen ripple /
  // absorb path, but it never CLAMPS - if the added half does not fit before the barline it REFUSES
  // (a noRoom no-op, "No room to dot in this bar"); on an already-DOTTED note it REMOVES the dot
  // (shrink back to the plain value, the freed third becomes a rest after the note) via the shorten
  // path. An off-ladder arrival SNAPS to its nearest plain rung first, then the dot applies to that
  // rung. It NEVER produces a second dot. divisions stays load-bearing 4; the whole chord shares the
  // one dotted duration.
  changeDuration(
    id: number,
    direction: "shorter" | "longer" | "dot",
  ): ChangeDurationRecord | null;
  // Invert a change-duration: restore the snapshotted measure children and re-index.
  restoreDuration(record: ChangeDurationRecord): void;
  // DOTTED v1: the dot TOGGLE's UI state for note `id`, so the toolbar can show aria-pressed + a lit
  // look and disable the toggle when it cannot act. `dotted` is whether the note currently carries a
  // dot (inferred from its <duration>). `canToggle` is whether pressing dot would do something: an
  // already-dotted note is always toggleable (removing a dot frees time, always room); a PLAIN note is
  // toggleable only when the added x1.5 half fits before the barline (the same room test the dot ADD
  // uses). Returns a safe default ({ dotted:false, canToggle:false }) for an invalid id.
  dotState(id: number): { dotted: boolean; canToggle: boolean };
  fifthsForHandle(id: number): number;
  // The key signature (fifths) in effect at a REST handle, so the add can spell its accidental
  // diatonically (parallel to fifthsForHandle for note handles).
  fifthsForRest(restId: number): number;
  serialize(): string;
}

// A human duration name for a rest's <type> token (e.g. "quarter rest"), for the selection
// announce ("Selected a quarter rest, beat 3"). Falls back to a generic "rest" when the type is
// missing or unrecognised; the duration is the load-bearing token, so a known type is preferred.
const REST_TYPE_NAMES: Record<string, string> = {
  whole: "whole",
  half: "half",
  quarter: "quarter",
  eighth: "eighth",
  "16th": "sixteenth",
  "32nd": "thirty-second",
  "64th": "sixty-fourth",
  breve: "double whole",
};
export function restDurationName(type: string): string {
  const name = REST_TYPE_NAMES[type];
  return name ? `${name} rest` : "rest";
}

// The standard MusicXML note-value tokens, each with its length in QUARTER-NOTE units. A whole is
// 4 quarters, an eighth half a quarter, etc. `breve` (double whole = 8q) is included because the
// model's REST_TYPE_NAMES recognises it; nothing shorter than a 64th is emitted by our OMR.
// Exported so the duration-edit ladder (changeDuration) is anchored to the SAME canonical table
// noteTypeForDuration scans, never a second hand-kept list.
export const NOTE_VALUE_QUARTERS: ReadonlyArray<{ type: string; quarters: number }> = [
  { type: "breve", quarters: 8 },
  { type: "whole", quarters: 4 },
  { type: "half", quarters: 2 },
  { type: "quarter", quarters: 1 },
  { type: "eighth", quarters: 0.5 },
  { type: "16th", quarters: 0.25 },
  { type: "32nd", quarters: 0.125 },
  { type: "64th", quarters: 0.0625 },
];

// The PLAIN value ladder the duration edit walks (Smart Edit P3 CHANGE-DURATION v1), shortest to
// longest: 16th, eighth, quarter, half, whole. NO dotted values, NO tuplets (Designer P3-3). Each
// notch is one ladder index; a step shorter is index-1, a step longer is index+1, both CLAMPED at
// the ends. `quarters` is the value's length in quarter-note units; multiply by `divisions` to get
// <duration> in a measure's divisions (e.g. divisions=4: 16th=1, eighth=2, quarter=4, half=8,
// whole=16, the load-bearing mapping the task pins). Drawn from NOTE_VALUE_QUARTERS so the tokens
// match noteTypeForDuration exactly.
const LADDER_TYPES: readonly string[] = ["16th", "eighth", "quarter", "half", "whole"];
export const DURATION_LADDER: ReadonlyArray<{ type: string; quarters: number }> = LADDER_TYPES.map(
  (type) => {
    const entry = NOTE_VALUE_QUARTERS.find((v) => v.type === type);
    // LADDER_TYPES is a subset of NOTE_VALUE_QUARTERS, so this is always found; assert for types.
    return { type, quarters: entry!.quarters };
  },
);

// Human duration names for a note's <type> token (e.g. "quarter"), parallel to REST_TYPE_NAMES but
// WITHOUT the trailing " rest". Used by the readout/announce so a value reads as a plain word.
const NOTE_TYPE_NAMES: Record<string, string> = {
  breve: "double whole",
  whole: "whole",
  half: "half",
  quarter: "quarter",
  eighth: "eighth",
  "16th": "sixteenth",
  "32nd": "thirty-second",
  "64th": "sixty-fourth",
};

// A spoken value name for a <type>+dots pair, e.g. "quarter", "dotted quarter", "double dotted
// half". v1 never PRODUCES dots, but a note can ARRIVE dotted (OMR inferred dots from an odd
// <duration>), so the readout names the arrival value before the snap. Unknown type -> "note".
export function noteValueName(type: string, dots: number): string {
  const base = NOTE_TYPE_NAMES[type];
  if (!base) return "note";
  if (dots === 1) return `dotted ${base}`;
  if (dots === 2) return `double dotted ${base}`;
  return base;
}

// The spoken value name for a <duration> in `divisions` (infers the type+dots first). The readout
// uses this to append the current value to the selected-note label ("D5, quarter").
export function durationValueName(durDivs: number, divisions: number): string {
  const { type, dots } = noteTypeForDuration(durDivs, divisions);
  return noteValueName(type, dots);
}

// The index of a duration on the PLAIN ladder, or -1 if it is not exactly a plain ladder value (a
// dotted/tuplet/odd duration that must SNAP before stepping). Matches by quarter-length within a
// small epsilon so float division (durDivs/divisions) lands cleanly.
export function ladderIndexForDuration(durDivs: number, divisions: number): number {
  const q = divisions > 0 ? durDivs / divisions : 0;
  const EPS = 1e-6;
  return DURATION_LADDER.findIndex((v) => Math.abs(v.quarters - q) < EPS);
}

// The NEAREST plain ladder index to a duration (used to SNAP a dotted/odd arrival onto the ladder).
// Ties (a dotted value sits exactly between two ladder rungs, e.g. a dotted quarter = 1.5q is
// equidistant from quarter and half) break toward the SHORTER rung, so a dotted quarter snaps to
// quarter (the spec's "Dotted quarter to quarter"), not half.
export function nearestLadderIndex(durDivs: number, divisions: number): number {
  const q = divisions > 0 ? durDivs / divisions : 0;
  let best = 0;
  let bestDelta = Infinity;
  for (let i = 0; i < DURATION_LADDER.length; i++) {
    const delta = Math.abs(DURATION_LADDER[i].quarters - q);
    // Strict < keeps the FIRST (shorter, since the ladder is shortest-first) on a tie.
    if (delta < bestDelta - 1e-9) {
      bestDelta = delta;
      best = i;
    }
  }
  return best;
}

// The inferred note-value (base <type> + dot count) for a duration expressed in divisions. Real OMR
// (and some publishers) emit a bare `<note>` with a `<duration>` but NO `<type>`; Verovio then draws
// EVERY such note at a uniform default value (wrong rhythm) and computes a wrong timemap, while OSMD
// infers the value from <duration> and renders correctly. So when a note/rest lacks a <type> we
// compute one here from `durDivs / divisions` (quarter-note units) and insert it (see addTypeIfMissing).
//
// Mapping: a quarter value q matches a base whose length is q exactly (0 dots), or base*1.5 (one dot),
// or base*1.75 (two dots) - the only durations a single notehead can spell. A dot adds half the base,
// a second dot a quarter, so a dotted half = 2 + 1 = 3q, a double-dotted half = 2 + 1 + 0.5 = 3.5q. We
// scan bases longest-first and take the first that yields a non-negative integral dot count (preferring
// FEWER dots and the LONGEST base, the conventional spelling). A duration that matches no standard base
// (a tuplet remainder, or a duration of 0) falls back to the base whose plain length is NEAREST q, with
// 0 dots, so the function NEVER throws and Verovio always receives a valid <type>.
export function noteTypeForDuration(
  durDivs: number,
  divisions: number,
): { type: string; dots: number } {
  const q = divisions > 0 ? durDivs / divisions : 0;
  const EPS = 1e-6;
  if (q > EPS) {
    // Try 0, 1, then 2 dots so the fewest dots win for a given base; bases are longest-first.
    for (let dots = 0; dots <= 2; dots++) {
      // A base with `dots` dots spans base * (2 - 2^-dots) quarters: 1x, 1.5x, 1.75x.
      const factor = 2 - Math.pow(2, -dots);
      for (const { type, quarters } of NOTE_VALUE_QUARTERS) {
        if (Math.abs(quarters * factor - q) < EPS) return { type, dots };
      }
    }
  }
  // No standard (possibly dotted) value matched: pick the base whose plain length is nearest q. This
  // keeps a tuplet/odd duration renderable (approximate value, no dots) instead of crashing or leaving
  // Verovio to guess. For q <= 0 this yields the shortest base, a harmless default.
  let nearest = NOTE_VALUE_QUARTERS[NOTE_VALUE_QUARTERS.length - 1];
  let bestDelta = Infinity;
  for (const cand of NOTE_VALUE_QUARTERS) {
    const delta = Math.abs(cand.quarters - q);
    if (delta < bestDelta) {
      bestDelta = delta;
      nearest = cand;
    }
  }
  return { type: nearest.type, dots: 0 };
}

// Insert an inferred `<type>` (and any `<dot>` elements) into a `<note>` that LACKS a `<type>`, so
// Verovio engraves the right rhythm and computes a correct timemap. A no-op when the note ALREADY has
// a `<type>` (so `<type>`-carrying scores - the demo, every prior fixture, publisher exports - are
// untouched, byte for byte). Children are placed in valid MusicXML content order: `<type>` follows
// `<duration>`/`<tie>`/`<voice>` and precedes `<dot>`*/`<accidental>`/`<notations>`/`<staff>`; each
// `<dot>` follows the `<type>`. Verovio is lenient about order, but we emit a valid document. Pure
// aside from mutating the passed element. Applies to pitched notes AND rests (both can omit a type).
function addTypeIfMissing(noteEl: Element, durDivs: number, divisions: number): void {
  if (child(noteEl, "type")) return; // already typed: leave the note exactly as it is
  const { type, dots } = noteTypeForDuration(durDivs, divisions);
  const doc = noteEl.ownerDocument;
  const typeEl = doc.createElement("type");
  typeEl.textContent = type;
  // <type> goes after <voice> (or <tie>/<duration>/<rest>/<pitch> if no <voice>): insert before the
  // first child that must follow <type> (<dot>, <accidental>, <notations>, <staff>, <beam>, <stem>,
  // <lyric>); else append. This keeps the DTD child order valid without depending on what is present.
  const AFTER_TYPE = new Set([
    "dot",
    "accidental",
    "notations",
    "staff",
    "beam",
    "stem",
    "lyric",
    "time-modification",
  ]);
  let anchor: Node | null = null;
  for (const c of Array.from(noteEl.children)) {
    if (AFTER_TYPE.has(c.tagName.toLowerCase())) {
      anchor = c;
      break;
    }
  }
  noteEl.insertBefore(typeEl, anchor);
  // <dot> elements immediately follow <type>.
  let after: Node | null = typeEl;
  for (let i = 0; i < dots; i++) {
    const dotEl = doc.createElement("dot");
    noteEl.insertBefore(dotEl, after.nextSibling);
    after = dotEl;
  }
}

// Parse MusicXML into the editable model. Walks each part tracking divisions and a time cursor
// (in divisions) so every pitched <note> gets an absolute onset; chords reuse the previous
// onset; <backup>/<forward> move the cursor; rests advance it but emit no handle. Pure aside
// from constructing a DOM. Never throws on a structurally odd score: unknown elements are ignored.
//
// `bpmOverride` is the tempo the falling notes (score.ts) used, passed in so the model's onset
// SECONDS exactly match the VisNote[] seconds and the (midi, onset) mapping lines up regardless
// of how the score declares its tempo. Without it, the tempo is read from the first <sound
// tempo> (default 120, matching score.ts's DefaultStartTempoInBpm || 120 fallback). Onsets only
// ever feed the mapping, so the absolute scale is not otherwise load-bearing.
export function parseScoreModel(xml: string, bpmOverride?: number): ScoreModel {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  // The handle list is the live array `model.handles` aliases; reindexHandles() mutates it IN
  // PLACE (clear + refill) so a structural edit (delete/restore) keeps that reference valid.
  const handles: NoteHandle[] = [];
  // The rest registry `model.restHandles` aliases; same in-place rebuild discipline as `handles`.
  const restHandles: RestHandle[] = [];

  const soundTempo = doc.querySelector("sound[tempo]")?.getAttribute("tempo");
  const bpm =
    bpmOverride && Number.isFinite(bpmOverride) && bpmOverride > 0
      ? bpmOverride
      : soundTempo && Number.isFinite(Number(soundTempo))
        ? Number(soundTempo)
        : 120;
  const secPerQuarter = 60 / bpm;

  // Per-handle key signature (fifths) so diatonic stepping is key-aware. Captured at walk time
  // from the attributes in effect at the handle's measure. Indexed in lockstep with `handles`.
  const handleFifths: number[] = [];
  // Per-REST key signature, indexed in lockstep with `restHandles`, so an ADD spells diatonically.
  const restFifths: number[] = [];

  // Walk the live DOM and (re)build the pitched-note handles + the rest handles + their key
  // signatures in document order. Called once at parse and again after every STRUCTURAL edit
  // (delete / restore / add / its undo), so a handle's id is always its current document position.
  // Onsets are computed exactly as before (divisions, <backup>/<forward>, chords share the prior
  // onset, rests advance the cursor and now ALSO emit a rest handle for selection + conversion).
  function reindexHandles(): void {
    handles.length = 0;
    handleFifths.length = 0;
    restHandles.length = 0;
    restFifths.length = 0;
    const parts = Array.from(doc.getElementsByTagName("part"));
    for (const part of parts) {
      let divisions = 1; // <divisions> per quarter note; updated by <attributes>
      let fifths = 0; // current key signature
      // ABSOLUTE onset clock: quarter-notes elapsed from the SCORE start up to the current measure's
      // start. Onsets must be absolute (from the score start), because both the VisNote[] (score.ts)
      // and the Verovio timemap time everything from the score start; a measure-relative onset only
      // agrees in a single-measure score and silently breaks the (midi, onset) and (onset, staff)
      // maps in measures 2+ (the rest-mapping bug). Accumulated in quarters (divisions-independent)
      // so a mid-piece <divisions> change stays correct.
      let measureStartQuarters = 0;
      const measures = Array.from(part.getElementsByTagName("measure"));
      for (const measure of measures) {
        let cursor = 0; // divisions from THIS measure's start
        let prevOnset = 0; // onset of the last non-chord note, for chord members
        // The furthest the cursor reaches in this measure (in this measure's divisions). With
        // <backup>/<forward> the cursor moves back and forth between voices, so the measure's
        // musical length is the MAX forward position, not the final cursor. This is how far to
        // advance the absolute clock for the next measure.
        let measureMaxCursor = 0;
        // Walk the measure's direct children in document order.
        for (const node of Array.from(measure.children)) {
          const tag = node.tagName.toLowerCase();
          if (tag === "attributes") {
            const div = child(node, "divisions");
            if (div) divisions = num(div, divisions);
            const fifthsEl = child(node, "fifths");
            if (fifthsEl) fifths = num(fifthsEl, fifths);
            continue;
          }
          if (tag === "backup") {
            cursor -= num(child(node, "duration"), 0);
            continue;
          }
          if (tag === "forward") {
            cursor += num(child(node, "duration"), 0);
            // A <forward> advances musical time, so it can extend the measure's furthest cursor
            // past any note (e.g. a voice that rests out the end of the bar as a forward instead
            // of an explicit <rest>). Capture it in the max so the next measure's absolute clock is
            // not under-counted (Verovio times the bar by its full length, including the forward).
            if (cursor > measureMaxCursor) measureMaxCursor = cursor;
            continue;
          }
          if (tag !== "note") continue;

          const isChord = child(node, "chord") !== null;
          const isRest = child(node, "rest") !== null;
          const durDivs = num(child(node, "duration"), 0);
          // Real OMR omits <type>; without it Verovio draws a uniform default value (wrong rhythm)
          // and a wrong timemap, breaking the (midi, onset) click map. Infer + insert a <type> here
          // from <duration>, in the SAME walk that already knows divisions. Idempotent (a no-op once
          // the note has a <type>), so a <type>-carrying score is untouched and re-indexing after a
          // structural edit does not double-insert. Chord members carry their own <type> too.
          if (durDivs > 0) addTypeIfMissing(node, durDivs, divisions);
          const onsetDivs = isChord ? prevOnset : cursor;
          // ABSOLUTE onset in seconds: the score-start clock at this measure's start, plus the
          // within-measure offset. `beat` stays measure-relative (1-based within the bar).
          const onsetSec = (measureStartQuarters + onsetDivs / divisions) * secPerQuarter;

          if (!isRest) {
            const pitchEl = child(node, "pitch");
            if (pitchEl) {
              const pitch = readPitch(pitchEl);
              // Tie continuation: a <tie type="stop"> with no "start" is folded into its start
              // note in the VisNote[] (score.ts), so it must not claim its own VisNote.
              const ties = Array.from(node.getElementsByTagName("tie"));
              const hasStop = ties.some((t) => t.getAttribute("type") === "stop");
              const hasStart = ties.some((t) => t.getAttribute("type") === "start");
              const isTieContinuation = hasStop && !hasStart;
              const id = handles.length;
              handles.push({
                id,
                el: node,
                pitchEl,
                onsetSec,
                midi: midiFromPitch(pitch),
                pitch,
                isChordMember: isChord,
                isTieContinuation,
                durationDivs: durDivs,
                divisions,
                durationSec: (durDivs / divisions) * secPerQuarter,
              });
              handleFifths.push(fifths);
            }
          } else {
            // A REST: push a rest handle so it is selectable + convertible (ADD-a-note v1). A rest
            // is never a chord member, so it always sits at the cursor. `beat` is 1-based within
            // the measure (onset in quarters + 1), rounded to the nearest sensible value for the
            // announce; staff/voice default to 1 when absent (single-staff scores).
            const restType = child(node, "type")?.textContent?.trim() ?? "";
            const staff = num(child(node, "staff"), 1);
            const voice = num(child(node, "voice"), 1);
            const beat = onsetDivs / divisions + 1;
            restHandles.push({
              id: restHandles.length,
              el: node,
              onsetSec,
              durationSec: (durDivs / divisions) * secPerQuarter,
              durationDivs: durDivs,
              type: restType,
              staff,
              voice,
              beat: Math.round(beat * 1000) / 1000,
            });
            restFifths.push(fifths);
          }

          // Advance the cursor for non-chord notes (and rests); chord members share the onset.
          if (!isChord) {
            prevOnset = onsetDivs;
            cursor = onsetDivs + durDivs;
            if (cursor > measureMaxCursor) measureMaxCursor = cursor;
          }
        }
        // Advance the absolute clock by THIS measure's musical length (its furthest cursor, in
        // quarters), so the next measure's onsets continue from the right score time.
        measureStartQuarters += measureMaxCursor / divisions;
      }
    }
  }

  reindexHandles();

  // DOTTED v1: the dot TOGGLE edit, a closure so it can reindex after mutating (like the inline
  // shorten/lengthen). Binary plain <-> dotted, fixed-bar, returning the SAME ChangeDurationRecord so
  // undo flows through restoreDuration. It never produces a second dot and never overflows a bar.
  //
  // The note's inferred (base, dots) drives the toggle:
  //  - dots == 0 (PLAIN, possibly off-ladder odd): ADD a dot. Snap an off-ladder value to its nearest
  //    plain rung first, then the target is that rung x1.5. Grow via the lengthen ripple/absorb path,
  //    but REFUSE (noRoom) if the added half does not fit before the barline (no clamp - ties later).
  //  - dots >= 1 (already DOTTED): step DOWN one dot level. A single dot -> the PLAIN base; a double
  //    dot -> the single-dotted base (the canonical value v1 keeps). Either way the value SHRINKS, so
  //    the freed time becomes a rest after the chord (always room).
  function toggleDotEdit(
    chordGroup: Element[],
    noteEl: Element,
    measureEl: Element,
    divisions: number,
    oldDivs: number,
    fromName: string,
  ): ChangeDurationRecord {
    const { type: baseType, dots } = noteTypeForDuration(oldDivs, divisions);
    const baseEntry = NOTE_VALUE_QUARTERS.find((v) => v.type === baseType);
    const baseDivs = baseEntry ? baseEntry.quarters * divisions : oldDivs;
    // Snapshot the bar BEFORE mutating, for an exact invert (mirrors the shorten/lengthen snapshot).
    const snapshot = (): Node[] => Array.from(measureEl.children).map((c) => c.cloneNode(true));

    if (dots === 0) {
      // ADD a dot. An off-ladder PLAIN arrival (a tuplet/odd duration noteTypeForDuration approximated
      // to 0 dots) is SNAPPED to its nearest plain rung first; the dot then applies to that rung.
      const onLadder = ladderIndexForDuration(oldDivs, divisions) >= 0;
      const snapIndex = nearestLadderIndex(oldDivs, divisions);
      const plainDivs = onLadder ? oldDivs : DURATION_LADDER[snapIndex].quarters * divisions;
      const plainType = onLadder ? baseType : DURATION_LADDER[snapIndex].type;
      const dottedSnap = !onLadder;
      // The dotted target is x1.5 of the plain rung; the added half is half the plain rung.
      const targetDivs = plainDivs + plainDivs / 2;
      const wanted = targetDivs - oldDivs; // divisions to grow by (from the ARRIVAL, snap-aware)
      // Room to grow: trailing same-voice REST divisions + any slack to the barline (the lengthen rule).
      const voice = num(child(noteEl, "voice"), 1);
      const following = followingVoiceEvents(measureEl, noteEl, voice);
      const room = growRoomDivs(measureEl, noteEl, divisions);
      // A dot NEVER clamps: if the full added half does not fit before the barline, REFUSE (noRoom).
      if (wanted > room + 1e-9) {
        return {
          measureEl,
          childrenBefore: [],
          outcome: "noRoom",
          fromName,
          toName: fromName,
          dottedSnap: false,
          direction: "dot",
        };
      }
      const childrenBefore = snapshot();
      // Consume `wanted` divisions of trailing rest, first rest onward: shrink a larger rest, remove a
      // fully consumed one (the lengthen absorb). Following NOTES ripple right via the cursor (untouched).
      let toConsume = wanted;
      for (const e of following) {
        if (toConsume <= 0) break;
        if (child(e, "rest") === null) continue;
        const restDur = num(child(e, "duration"), 0);
        if (restDur <= toConsume) {
          e.parentNode?.removeChild(e);
          toConsume -= restDur;
        } else {
          setNoteDuration(e, restDur - toConsume, divisions, { keepDots: false });
          toConsume = 0;
        }
      }
      // Write the dotted duration to EVERY chord member (one shared value); keepDots:true so the single
      // inferred <dot> is emitted (x1.5 infers exactly one dot for a plain base).
      for (const m of chordGroup) setNoteDuration(m, targetDivs, divisions, { keepDots: true });
      reindexHandles();
      return {
        measureEl,
        childrenBefore,
        outcome: "stepped",
        fromName,
        // "dotted {plain}" (e.g. "dotted quarter"); on a snap, named from the SNAPPED rung.
        toName: noteValueName(plainType, 1),
        dottedSnap,
        direction: "dot",
        dotVerb: "lengthen", // adding a dot grows the note
      };
    }

    // REMOVE / normalize a dot (dots >= 1): step down one dot level. A single dot -> plain base; a
    // double dot -> single-dotted base. The value shrinks, so the freed time becomes a rest after the
    // chord (the shorten idiom; always has room since we are getting SHORTER).
    const targetDots = dots - 1; // 1 -> 0 (plain), 2 -> 1 (dotted)
    // base * (2 - 2^-dots) quarters: a base with `targetDots` dots.
    const targetDivs = baseDivs * (2 - Math.pow(2, -targetDots));
    const freed = oldDivs - targetDivs;
    if (freed <= 1e-9) {
      // Defensive: a dotted value is always longer than its lower-dot form, so freed > 0 here.
      return {
        measureEl,
        childrenBefore: [],
        outcome: "atEnd",
        fromName,
        toName: fromName,
        dottedSnap: false,
        direction: "dot",
      };
    }
    const childrenBefore = snapshot();
    // Shrink EVERY chord member to the target value. keepDots:true so a double->single normalize keeps
    // the remaining single dot (targetDots==1); a single->plain remove infers 0 dots so none is written.
    for (const m of chordGroup) setNoteDuration(m, targetDivs, divisions, { keepDots: true });
    const lastInChord = chordGroup[chordGroup.length - 1];
    const freedRest = makeRestFrom(noteEl);
    setNoteDuration(freedRest, freed, divisions, { keepDots: false });
    lastInChord.parentNode?.insertBefore(freedRest, lastInChord.nextSibling);
    reindexHandles();
    return {
      measureEl,
      childrenBefore,
      outcome: "stepped",
      fromName,
      toName: noteValueName(baseType, targetDots),
      // A double-dotted arrival is a NON-PLAIN value; folding the snap phrasing in reads
      // "Double dotted half to dotted half". A plain single-dot remove uses the normal from->to.
      dottedSnap: dots >= 2,
      direction: "dot",
      dotVerb: "shorten", // removing/normalizing a dot shrinks the note
    };
  }

  const serializer = new XMLSerializer();

  const model: ScoreModel = {
    handles,
    restHandles,
    fifthsForHandle(id: number): number {
      return handleFifths[id] ?? 0;
    },
    fifthsForRest(restId: number): number {
      return restFifths[restId] ?? 0;
    },
    setPitch(id: number, next: ModelPitch): void {
      const handle = handles[id];
      if (!handle) return;
      // Rewrite the <pitch> children to the new step/alter/octave. Build in MusicXML order
      // (step, alter, octave); omit <alter> for a natural (alter 0), matching how publishers
      // and our OMR emit naturals.
      const doc2 = handle.pitchEl.ownerDocument;
      while (handle.pitchEl.firstChild) handle.pitchEl.removeChild(handle.pitchEl.firstChild);
      const stepEl = doc2.createElement("step");
      stepEl.textContent = next.step;
      handle.pitchEl.appendChild(stepEl);
      if (next.alter !== 0) {
        const alterEl = doc2.createElement("alter");
        alterEl.textContent = String(next.alter);
        handle.pitchEl.appendChild(alterEl);
      }
      const octEl = doc2.createElement("octave");
      octEl.textContent = String(next.octave);
      handle.pitchEl.appendChild(octEl);

      // Keep the printed <accidental> glyph in sync with the pitch relative to the key
      // signature: emit an explicit accidental when the note departs from the key's default
      // for its letter, and remove a now-stale <accidental> when it matches the key (so an
      // edit back to a diatonic pitch does not leave a redundant sharp/flat drawn). This keeps
      // the engraved staff correct after an edit; Verovio also infers from <alter>, but an
      // explicit, synced accidental avoids any stale-glyph ambiguity.
      const existing = child(handle.el, "accidental");
      const keyAlter = keyAlterForLetter(next.step, handleFifths[id] ?? 0);
      if (next.alter === keyAlter) {
        if (existing) existing.parentNode?.removeChild(existing);
      } else {
        const token = accidentalToken(next.alter);
        if (token) {
          if (existing) {
            existing.textContent = token;
          } else {
            const accEl = doc2.createElement("accidental");
            accEl.textContent = token;
            // <accidental> follows <type> in MusicXML; insert after <type> if present, else
            // after <pitch>. Placement is cosmetic for parsing, but keep it valid-ish.
            const typeEl = child(handle.el, "type");
            const anchor = typeEl ?? handle.pitchEl;
            anchor.parentNode?.insertBefore(accEl, anchor.nextSibling);
          }
        }
      }

      // Update the cached handle state so a subsequent read (and the mapping) sees the new pitch
      // without a re-parse.
      handle.pitch = next;
      handle.midi = midiFromPitch(next);
    },
    deleteNote(id: number): DeleteRecord | null {
      const handle = handles[id];
      if (!handle) return null;
      const noteEl = handle.el;
      const parent = noteEl.parentNode as Element | null;
      if (!parent) return null;
      const nextSibling = noteEl.nextSibling;
      // Clone the original note BEFORE mutating so restore re-inserts it exactly (pitch, ties,
      // beams, accidental, chord child, position all intact).
      const removedClone = noteEl.cloneNode(true) as Element;

      const isChordMember = child(noteEl, "chord") !== null;
      let restPlaceholder: Element | null = null;
      let promoted: { el: Element; chordChild: Element } | null = null;

      if (isChordMember) {
        // A chord MEMBER: a rest cannot stack in a chord, so REMOVE the element. The chord's onset
        // note keeps advancing the cursor, so the measure sum is unchanged (the member's own
        // duration is parallel, never added to the running total in the walk above).
        parent.removeChild(noteEl);
      } else {
        // A non-chord ONSET note. If the NEXT sibling is a chord member of THIS note, promote it to
        // the onset (strip its <chord/>) so the chord's duration-advance survives, then remove this
        // note. Otherwise this note stands alone at its onset: replace it IN PLACE with a rest of
        // the same duration so the time slot (and the measure sum) is preserved (fixed-bar).
        const nextNote = nextElementNamed(noteEl, "note");
        if (nextNote && child(nextNote, "chord") !== null) {
          const chordChild = child(nextNote, "chord")!;
          nextNote.removeChild(chordChild);
          promoted = { el: nextNote, chordChild };
          parent.removeChild(noteEl);
        } else {
          restPlaceholder = makeRestFrom(noteEl);
          parent.replaceChild(restPlaceholder, noteEl);
        }
      }

      reindexHandles();
      return { removedClone, parent, nextSibling, restPlaceholder, promoted };
    },
    restoreNote(record: DeleteRecord): void {
      // Reverse a promotion first (re-add the stripped <chord/> to the promoted member) so it goes
      // back to being a chord member once the original onset note returns ahead of it.
      if (record.promoted) {
        record.promoted.el.insertBefore(
          record.promoted.chordChild,
          record.promoted.el.firstChild,
        );
      }
      if (record.restPlaceholder && record.restPlaceholder.parentNode) {
        // The delete replaced the note with a rest in place: swap the original clone back in.
        record.restPlaceholder.parentNode.replaceChild(record.removedClone, record.restPlaceholder);
      } else {
        // The delete removed the element: re-insert the clone at its original position. The stored
        // nextSibling may itself have moved, but for a single delete/undo round-trip it is still a
        // child of `parent` (promotion only stripped a <chord/>, it did not move the node), so
        // insertBefore restores the original order; a detached ref falls back to append.
        const ref =
          record.nextSibling && record.nextSibling.parentNode === record.parent
            ? record.nextSibling
            : null;
        record.parent.insertBefore(record.removedClone, ref);
      }
      reindexHandles();
    },
    addNote(restId: number, pitch: ModelPitch): AddRecord | null {
      const rest = restHandles[restId];
      if (!rest) return null;
      const restEl = rest.el;
      const parent = restEl.parentNode as Element | null;
      if (!parent) return null;
      // Clone the rest BEFORE replacing it so an undo swaps it back in exactly (duration, type,
      // dots, voice, staff all intact). This is the literal inverse of a standalone-note delete.
      const restClone = restEl.cloneNode(true) as Element;
      const fifths = restFifths[restId] ?? 0;
      const addedNote = makeNoteFrom(restEl, pitch, fifths);
      parent.replaceChild(addedNote, restEl);
      reindexHandles();
      return { addedNote, restClone };
    },
    removeNote(record: AddRecord): void {
      // Swap the original rest back in for the added note (literally the standalone delete path).
      if (record.addedNote.parentNode) {
        record.addedNote.parentNode.replaceChild(record.restClone, record.addedNote);
      }
      reindexHandles();
    },
    changeDuration(
      id: number,
      direction: "shorter" | "longer" | "dot",
    ): ChangeDurationRecord | null {
      const handle = handles[id];
      if (!handle) return null;
      // A duration edit acts on the whole CHORD: members share one onset + one duration, so editing
      // a member's duration alone would desync the chord. `noteEl` is the chord's ONSET note (the one
      // that advances the cursor, which the fixed-bar math is scoped to); `chordGroup` is the onset +
      // all its members, every one of which gets the new duration/type together. For a non-chord note
      // the group is just the note itself.
      const chordGroup = chordGroupFor(handle.el);
      const noteEl = chordGroup[0];
      // The measure is the bar the fixed-bar math is scoped to. Walk up to the enclosing <measure>.
      const measureEl = ancestorNamed(noteEl, "measure");
      if (!measureEl) return null;
      const divisions = handle.divisions > 0 ? handle.divisions : 1;
      // Bar math keys on the ONSET note's duration (members are parallel), which equals the selected
      // member's anyway for a well-formed chord; read it from the onset note to be exact.
      const oldDivs = num(child(noteEl, "duration"), handle.durationDivs);
      // Current value name (for the announce), computed BEFORE any mutation (covers a dotted
      // arrival, e.g. "dotted quarter").
      const fromName = durationValueName(oldDivs, divisions);

      // DOTTED v1: a binary plain <-> dotted toggle on the SAME fixed-bar machinery. Handled before the
      // shorter/longer ladder stepping because its target value is x1.5 / x(2/3) of the PLAIN rung, not
      // an adjacent rung. Reuses the lengthen ripple/absorb (to ADD) and the shorten freed-rest (to
      // REMOVE), but ADD never CLAMPS: a dot that does not fit before the barline is REFUSED.
      if (direction === "dot") {
        return toggleDotEdit(
          chordGroup,
          noteEl,
          measureEl,
          divisions,
          oldDivs,
          fromName,
        );
      }

      // Is the note already on a plain ladder rung? If not (a dotted/odd arrival), SNAP to the
      // nearest rung first; that snap is folded into this edit (Designer P3-3).
      let curIndex = ladderIndexForDuration(oldDivs, divisions);
      const dottedSnap = curIndex < 0;
      if (dottedSnap) {
        const snapIndex = nearestLadderIndex(oldDivs, divisions);
        const snapped = DURATION_LADDER[snapIndex];
        // Pick the target rung from the snapped rung in the requested direction: if the snap already
        // moved in that direction (shorter: snapped < old; longer: snapped > old), the snap IS the
        // edit; otherwise take one more notch so the press still moves the value the asked way.
        const snappedDivs = snapped.quarters * divisions;
        if (direction === "shorter") {
          curIndex = snappedDivs < oldDivs ? snapIndex : Math.max(0, snapIndex - 1);
        } else {
          curIndex =
            snappedDivs > oldDivs ? snapIndex : Math.min(DURATION_LADDER.length - 1, snapIndex + 1);
        }
      } else {
        curIndex += direction === "shorter" ? -1 : 1;
      }

      // Ladder-end clamp: a step off either end is a disabled no-op (the caller announces "already
      // the shortest/longest"). No DOM change, so return a record marked `atEnd` with no snapshot.
      if (curIndex < 0 || curIndex > DURATION_LADDER.length - 1) {
        return {
          measureEl,
          childrenBefore: [],
          outcome: "atEnd",
          fromName,
          toName: fromName,
          dottedSnap: false,
          direction,
        };
      }

      const targetDivs = DURATION_LADDER[curIndex].quarters * divisions;

      // Snapshot the bar BEFORE mutating, for an exact invert (covers every surgical change below).
      const snapshot = (): Node[] => Array.from(measureEl.children).map((c) => c.cloneNode(true));

      if (direction === "longer" && targetDivs > oldDivs) {
        // LENGTHEN: grow the note, ripple the following same-voice events later, and absorb trailing
        // REST space. The bar must never overflow, so the growth is limited by the rest divisions
        // available after the note (+ any slack to the barline, normally 0 on a full bar).
        const voice = num(child(noteEl, "voice"), 1);
        const following = followingVoiceEvents(measureEl, noteEl, voice);
        const restRoom = following
          .filter((e) => child(e, "rest") !== null)
          .reduce((sum, e) => sum + num(child(e, "duration"), 0), 0);
        const slack = Math.max(0, measureCapacityDivs(measureEl, divisions) - voiceFilledDivs(measureEl, voice));
        const room = restRoom + slack;
        const wanted = targetDivs - oldDivs; // divisions the next rung would add
        const grow = Math.min(wanted, room);
        if (grow <= 0) {
          // No rest room to grow into: a no-op at the bar boundary (announce "No room ...").
          return {
            measureEl,
            childrenBefore: [],
            outcome: "noRoom",
            fromName,
            toName: fromName,
            dottedSnap: false,
            direction,
          };
        }
        const childrenBefore = snapshot();
        const newDivs = oldDivs + grow;
        // Consume `grow` divisions of trailing rest, from the FIRST following rest onward: shrink a
        // rest that is larger than what is left to consume, remove one fully consumed. Following
        // NOTES keep their durations (their onsets ripple right via the cursor as the note grows).
        let toConsume = grow;
        for (const e of following) {
          if (toConsume <= 0) break;
          if (child(e, "rest") === null) continue; // a note: untouched (it ripples by onset)
          const restDur = num(child(e, "duration"), 0);
          if (restDur <= toConsume) {
            e.parentNode?.removeChild(e);
            toConsume -= restDur;
          } else {
            setNoteDuration(e, restDur - toConsume, divisions, { keepDots: false });
            toConsume = 0;
          }
        }
        // A full-rung step (grow == wanted) lands on a plain ladder value (zero dots); a CLAMP
        // (grow < wanted) fills to the barline at a possibly-dotted value so the bar stays exactly
        // full and Verovio engraves a valid in-bar note (the documented v1 clamp exception). Apply to
        // EVERY chord member so the chord keeps one shared duration.
        const clamped = grow < wanted;
        for (const m of chordGroup) setNoteDuration(m, newDivs, divisions, { keepDots: clamped });
        reindexHandles();
        return {
          measureEl,
          childrenBefore,
          outcome: clamped ? "clamped" : "stepped",
          fromName,
          toName: clamped ? durationValueName(newDivs, divisions) : noteValueName(DURATION_LADDER[curIndex].type, 0),
          dottedSnap,
          direction,
        };
      }

      // SHORTEN (or a dotted-snap that lands shorter): shrink the note to the target value and insert
      // a REST of the freed divisions RIGHT AFTER it, so the bar stays full and the following onsets
      // are unchanged (the rhythm_repair "complete the bar with rests" idiom, MEMORY.md). When the
      // arrival was dotted the freed amount is oldDivs - targetDivs (which may exceed one rung's
      // worth); a single rest of exactly that span keeps the math correct.
      const freed = oldDivs - targetDivs;
      if (freed <= 0) {
        // The chosen rung is not actually shorter (defensive; should not happen for "shorter").
        return {
          measureEl,
          childrenBefore: [],
          outcome: "atEnd",
          fromName,
          toName: fromName,
          dottedSnap: false,
          direction,
        };
      }
      const childrenBefore = snapshot();
      // Shrink EVERY chord member to the target value (one shared duration), then insert the freed
      // rest AFTER the last member so it does not split the chord.
      for (const m of chordGroup) setNoteDuration(m, targetDivs, divisions, { keepDots: false });
      const lastInChord = chordGroup[chordGroup.length - 1];
      // Build the freed-time rest from the (now-shortened) onset note so it carries the same
      // voice/staff, give it the freed duration + matching type, and insert it after the chord.
      const freedRest = makeRestFrom(noteEl);
      setNoteDuration(freedRest, freed, divisions, { keepDots: false });
      lastInChord.parentNode?.insertBefore(freedRest, lastInChord.nextSibling);
      reindexHandles();
      return {
        measureEl,
        childrenBefore,
        outcome: "stepped",
        fromName,
        toName: noteValueName(DURATION_LADDER[curIndex].type, 0),
        dottedSnap,
        direction,
      };
    },
    restoreDuration(record: ChangeDurationRecord): void {
      // A no-op edit (ladder-end / no-room) snapshotted nothing: invert is also a no-op.
      if (record.childrenBefore.length === 0) return;
      // Restore the bar exactly: drop the live children, re-append the deep-cloned snapshot. The
      // measure element is the same node, so this reverses every surgical change (the note's
      // duration/type/dots, an inserted freed rest, shrunk/removed trailing rests) in one move.
      while (record.measureEl.firstChild) {
        record.measureEl.removeChild(record.measureEl.firstChild);
      }
      for (const c of record.childrenBefore) {
        record.measureEl.appendChild(c.cloneNode(true));
      }
      reindexHandles();
    },
    dotState(id: number): { dotted: boolean; canToggle: boolean } {
      const handle = handles[id];
      if (!handle) return { dotted: false, canToggle: false };
      const chordGroup = chordGroupFor(handle.el);
      const noteEl = chordGroup[0];
      const measureEl = ancestorNamed(noteEl, "measure");
      if (!measureEl) return { dotted: false, canToggle: false };
      const divisions = handle.divisions > 0 ? handle.divisions : 1;
      const oldDivs = num(child(noteEl, "duration"), handle.durationDivs);
      const { dots } = noteTypeForDuration(oldDivs, divisions);
      // An already-dotted note is always toggleable (removing a dot frees time; always room).
      if (dots >= 1) return { dotted: true, canToggle: true };
      // PLAIN: the dot ADD needs room for the added half. Compute the same x1.5 target the ADD uses
      // (snapping an off-ladder value to its nearest rung first), then compare the needed grow to room.
      const onLadder = ladderIndexForDuration(oldDivs, divisions) >= 0;
      const plainDivs = onLadder
        ? oldDivs
        : DURATION_LADDER[nearestLadderIndex(oldDivs, divisions)].quarters * divisions;
      const wanted = plainDivs + plainDivs / 2 - oldDivs;
      const room = growRoomDivs(measureEl, noteEl, divisions);
      return { dotted: false, canToggle: wanted <= room + 1e-9 };
    },
    serialize(): string {
      return serializer.serializeToString(doc);
    },
  };
  return model;
}

// The CHORD GROUP a <note> belongs to (Smart Edit P3 duration edit): the onset note + all its
// <chord/> members, in document order, so a duration edit can set ONE shared duration across the
// whole chord (editing a single member's <duration> would desync it). If `el` is a chord MEMBER
// (carries <chord/>), walk BACK to the onset note (the first preceding sibling <note> in the same
// voice WITHOUT a <chord/>); then collect that onset + the consecutive following <chord/> members.
// A standalone note returns just itself. Same-voice is matched so a backup-separated voice is not
// pulled in.
function chordGroupFor(el: Element): Element[] {
  const voice = num(child(el, "voice"), 1);
  // Find the onset note: el itself if it has no <chord/>, else the nearest preceding non-chord note.
  let onset = el;
  if (child(el, "chord") !== null) {
    let n: Node | null = el.previousSibling;
    while (n) {
      if (n.nodeType === 1) {
        const e = n as Element;
        if (e.tagName.toLowerCase() === "note" && num(child(e, "voice"), 1) === voice) {
          onset = e;
          if (child(e, "chord") === null) break; // reached the onset note
        } else if (e.tagName.toLowerCase() === "backup" || e.tagName.toLowerCase() === "forward") {
          break; // do not cross a voice boundary
        }
      }
      n = n.previousSibling;
    }
  }
  // Collect the onset + consecutive following <chord/> members of the same voice.
  const group: Element[] = [onset];
  let n: Node | null = onset.nextSibling;
  while (n) {
    if (n.nodeType === 1) {
      const e = n as Element;
      if (e.tagName.toLowerCase() !== "note") break;
      if (child(e, "chord") === null) break; // the next onset note: the chord ended
      if (num(child(e, "voice"), 1) !== voice) break;
      group.push(e);
    }
    n = n.nextSibling;
  }
  return group;
}

// The nearest ancestor element of `el` whose tag is `tag` (case-insensitive), or null. Used to find
// the <measure> a note belongs to so the duration edit can scope its fixed-bar math to that bar.
function ancestorNamed(el: Element, tag: string): Element | null {
  let n: Element | null = el.parentElement;
  while (n) {
    if (n.tagName.toLowerCase() === tag) return n;
    n = n.parentElement;
  }
  return null;
}

// The events (notes + rests) that FOLLOW `noteEl` in the SAME voice within its measure, in document
// order, stopping at the next <backup>/<forward> (a voice boundary). These are the events a lengthen
// ripples + absorbs rest space from. Same-voice is matched by the <voice> child (default 1).
function followingVoiceEvents(measureEl: Element, noteEl: Element, voice: number): Element[] {
  const out: Element[] = [];
  let seen = false;
  for (const node of Array.from(measureEl.children)) {
    const tag = node.tagName.toLowerCase();
    if (node === noteEl) {
      seen = true;
      continue;
    }
    if (!seen) continue;
    // A backup/forward ends this contiguous voice run; stop collecting (the ripple is scoped to the
    // edited note's own voice run, not whatever a later <backup> jumps to).
    if (tag === "backup" || tag === "forward") break;
    if (tag !== "note") continue;
    if (num(child(node, "voice"), 1) !== voice) continue;
    out.push(node);
  }
  return out;
}

// The divisions a note could GROW by within its bar: the trailing same-voice REST space plus any
// slack to the barline. This is the room a lengthen (and the dot ADD) may consume without overflowing
// the bar. Shared by the dot ADD edit and the dot button's enabled-state probe so both agree exactly.
function growRoomDivs(measureEl: Element, noteEl: Element, divisions: number): number {
  const voice = num(child(noteEl, "voice"), 1);
  const following = followingVoiceEvents(measureEl, noteEl, voice);
  const restRoom = following
    .filter((e) => child(e, "rest") !== null)
    .reduce((sum, e) => sum + num(child(e, "duration"), 0), 0);
  const slack = Math.max(
    0,
    measureCapacityDivs(measureEl, divisions) - voiceFilledDivs(measureEl, voice),
  );
  return restRoom + slack;
}

// The bar's capacity in divisions from its <time> signature (beats * divisions * 4 / beat-type), or
// a fallback when no time signature is in scope. divisions is per quarter note, so a beat worth of
// divisions is divisions * (4 / beat-type); times `beats` gives the full bar. The <time> may sit in
// THIS measure's <attributes> or be inherited; we read the most recent one at/ before this measure.
function measureCapacityDivs(measureEl: Element, divisions: number): number {
  const time = timeSignatureFor(measureEl);
  if (!time) {
    // No time signature found: fall back to the bar's own filled length so a lengthen finds no slack
    // (room then comes only from explicit trailing rests, which is the safe, never-overflow default).
    return voiceFilledDivsMax(measureEl);
  }
  return time.beats * divisions * (4 / time.beatType);
}

// The <time> beats/beat-type in scope for `measureEl`: the LAST <time> in this measure or any
// earlier measure of the same part (MusicXML time signatures persist until changed). Null if none.
function timeSignatureFor(measureEl: Element): { beats: number; beatType: number } | null {
  const part = ancestorNamed(measureEl, "part");
  if (!part) return readTime(measureEl);
  let found: { beats: number; beatType: number } | null = null;
  for (const m of Array.from(part.getElementsByTagName("measure"))) {
    const t = readTime(m);
    if (t) found = t;
    if (m === measureEl) break; // do not look past the edited measure
  }
  return found;
}

function readTime(measureEl: Element): { beats: number; beatType: number } | null {
  const time = measureEl.getElementsByTagName("time").item(0);
  if (!time) return null;
  const beats = num(time.getElementsByTagName("beats").item(0), 0);
  const beatType = num(time.getElementsByTagName("beat-type").item(0), 0);
  if (beats > 0 && beatType > 0) return { beats, beatType };
  return null;
}

// The filled divisions of ONE voice's contiguous run in a measure: sum the durations of its notes
// (non-chord) and rests up to the next <backup>/<forward>. Used to compute the slack to the barline
// for that voice (capacity - filled). Chord members are parallel (no advance), matching the walk.
function voiceFilledDivs(measureEl: Element, voice: number): number {
  let sum = 0;
  for (const node of Array.from(measureEl.children)) {
    const tag = node.tagName.toLowerCase();
    if (tag === "backup" || tag === "forward") {
      // Only count the FIRST contiguous run for this voice (the run the edit lives in). A later
      // backup starts a different voice/run; stop once we have started counting and hit a boundary.
      if (sum > 0) break;
      continue;
    }
    if (tag !== "note") continue;
    if (num(child(node, "voice"), 1) !== voice) continue;
    if (child(node, "chord") !== null) continue; // chord member: parallel, no advance
    sum += num(child(node, "duration"), 0);
  }
  return sum;
}

// The maximum forward extent of a measure across all voices (the cursor walk's furthest reach), used
// as a no-time-signature capacity fallback. Mirrors the parse walk: backup/forward move the cursor,
// non-chord notes/rests advance it, chord members are parallel.
function voiceFilledDivsMax(measureEl: Element): number {
  let cursor = 0;
  let extent = 0;
  for (const node of Array.from(measureEl.children)) {
    const tag = node.tagName.toLowerCase();
    const dur = num(child(node as Element, "duration"), 0);
    if (tag === "backup") cursor -= dur;
    else if (tag === "forward") cursor += dur;
    else if (tag === "note") {
      if (child(node as Element, "chord") !== null) continue;
      cursor += dur;
    }
    if (cursor > extent) extent = cursor;
  }
  return extent;
}

// Set a <note>/<rest> element's <duration> and matching <type>, fixed to `divisions`. Rewrites the
// <duration> text and the <type> token (inferred via noteTypeForDuration). v1's plain-rung steps
// pass keepDots:false: ALL existing <dot> children are removed and none are written, so the note
// lands on a clean plain value. The lengthen CLAMP passes keepDots:true so a fill-to-the-barline
// duration keeps the dots its value needs (the documented v1 exception) and Verovio stays valid.
function setNoteDuration(
  el: Element,
  durDivs: number,
  divisions: number,
  opts: { keepDots: boolean },
): void {
  const doc = el.ownerDocument;
  // <duration>
  let durEl = child(el, "duration");
  if (!durEl) {
    durEl = doc.createElement("duration");
    // <duration> follows <pitch>/<rest>/<chord>/<grace>; insert before <voice>/<type>/... if present.
    const anchor = child(el, "voice") ?? child(el, "type") ?? null;
    el.insertBefore(durEl, anchor);
  }
  durEl.textContent = String(durDivs);

  const { type, dots } = noteTypeForDuration(durDivs, divisions);
  // <type>
  let typeEl = child(el, "type");
  if (!typeEl) {
    typeEl = doc.createElement("type");
    // <type> goes after <duration>/<voice>; insert before the first child that must follow it.
    const AFTER_TYPE = new Set([
      "dot",
      "accidental",
      "notations",
      "staff",
      "beam",
      "stem",
      "lyric",
      "time-modification",
    ]);
    let anchor: Node | null = null;
    for (const c of Array.from(el.children)) {
      if (AFTER_TYPE.has(c.tagName.toLowerCase())) {
        anchor = c;
        break;
      }
    }
    el.insertBefore(typeEl, anchor);
  }
  typeEl.textContent = type;

  // Remove every existing <dot>, then (only when keeping dots, the clamp exception) re-emit them
  // immediately after <type> in valid DTD order.
  for (const dot of Array.from(el.getElementsByTagName("dot"))) {
    dot.parentNode?.removeChild(dot);
  }
  if (opts.keepDots) {
    let after: Node = typeEl;
    for (let i = 0; i < dots; i++) {
      const dotEl = doc.createElement("dot");
      el.insertBefore(dotEl, after.nextSibling);
      after = dotEl;
    }
  }
}

// The next ELEMENT sibling of `el` whose tag is `tag` immediately following it (skipping text
// nodes), or null. Used to find a chord member that directly follows a deleted onset note.
function nextElementNamed(el: Element, tag: string): Element | null {
  let n: Node | null = el.nextSibling;
  while (n) {
    if (n.nodeType === 1) {
      const e = n as Element;
      return e.tagName.toLowerCase() === tag ? e : null;
    }
    n = n.nextSibling;
  }
  return null;
}

// Build a <rest> <note> from a pitched <note>, preserving the time-structural children so the rest
// occupies the SAME slot (fixed-bar) and stays in the right voice/staff, and dropping the
// pitch-bound children (<pitch>, <accidental>, <tie>, <beam>, <notations>, <stem>, ...). Children
// are emitted in MusicXML DTD order: <rest>, <duration>, <voice>, <type>, <dot>*, then <staff>
// (which sits late in the note's content model). This is the "leaves a rest of the same duration"
// deletion for a standalone note.
function makeRestFrom(noteEl: Element): Element {
  const doc = noteEl.ownerDocument;
  const rest = doc.createElement("note");
  rest.appendChild(doc.createElement("rest"));
  for (const tag of ["duration", "voice", "type"]) {
    const src = child(noteEl, tag);
    if (src) rest.appendChild(src.cloneNode(true));
  }
  for (const dot of Array.from(noteEl.getElementsByTagName("dot"))) {
    rest.appendChild(dot.cloneNode(true));
  }
  // <staff> keeps the rest on the correct staff of a grand staff (else it defaults to staff 1).
  const staff = child(noteEl, "staff");
  if (staff) rest.appendChild(staff.cloneNode(true));
  return rest;
}

// Build a pitched <note> from a <rest>-bearing <note> at `pitch`, preserving the time-structural
// children so the new note occupies the SAME slot (fixed-bar) and stays in the right voice/staff,
// and dropping the <rest>. This is the exact inverse of makeRestFrom (rest -> note). The
// <accidental> glyph is synced to the key signature like setPitch: an explicit accidental prints
// only when the pitch departs from the key's default for its letter. Children are emitted in
// MusicXML note order: <pitch>, <duration>, <voice>, <type>, <dot>*, <accidental>, then <staff>.
function makeNoteFrom(restEl: Element, pitch: ModelPitch, fifths: number): Element {
  const doc = restEl.ownerDocument;
  const note = doc.createElement("note");

  const pitchEl = doc.createElement("pitch");
  const stepEl = doc.createElement("step");
  stepEl.textContent = pitch.step;
  pitchEl.appendChild(stepEl);
  if (pitch.alter !== 0) {
    const alterEl = doc.createElement("alter");
    alterEl.textContent = String(pitch.alter);
    pitchEl.appendChild(alterEl);
  }
  const octEl = doc.createElement("octave");
  octEl.textContent = String(pitch.octave);
  pitchEl.appendChild(octEl);
  note.appendChild(pitchEl);

  for (const tag of ["duration", "voice", "type"]) {
    const src = child(restEl, tag);
    if (src) note.appendChild(src.cloneNode(true));
  }
  for (const dot of Array.from(restEl.getElementsByTagName("dot"))) {
    note.appendChild(dot.cloneNode(true));
  }
  // Print an accidental only when the pitch leaves the key's default for its letter (same rule as
  // setPitch); a diatonic pitch prints none, so a fill in C major lands clean.
  const keyAlter = keyAlterForLetter(pitch.step, fifths);
  if (pitch.alter !== keyAlter) {
    const token = accidentalToken(pitch.alter);
    if (token) {
      const accEl = doc.createElement("accidental");
      accEl.textContent = token;
      note.appendChild(accEl);
    }
  }
  const staff = child(restEl, "staff");
  if (staff) note.appendChild(staff.cloneNode(true));
  return note;
}

// Map each pitched, NON-continuation handle to the index of the VisNote sharing its (midi,
// onset seconds). This is the same keying verovio-view.ts uses for the staff; reusing the rule
// keeps handle <-> VisNote and Verovio-id <-> VisNote consistent (all three pinned by midi +
// onset). Tie continuations are skipped (they have no VisNote, by score.ts's tie merge). A
// 1ms rounding tolerance absorbs float drift between the two onset computations.
const ONSET_DECIMALS = 3;
function onsetKey(midi: number, onsetSec: number): string {
  return `${midi}@${onsetSec.toFixed(ONSET_DECIMALS)}`;
}

export function buildHandleToVisIndex(
  handles: readonly NoteHandle[],
  visNotes: readonly { midi: number; time: number }[],
): Map<number, number> {
  const byOnset = new Map<string, number>();
  for (let i = 0; i < visNotes.length; i++) {
    const key = onsetKey(visNotes[i].midi, Number(visNotes[i].time.toFixed(ONSET_DECIMALS)));
    if (!byOnset.has(key)) byOnset.set(key, i);
  }
  const map = new Map<number, number>();
  for (const h of handles) {
    if (h.isTieContinuation) continue;
    const idx = byOnset.get(onsetKey(h.midi, Number(h.onsetSec.toFixed(ONSET_DECIMALS))));
    if (idx !== undefined) map.set(h.id, idx);
  }
  return map;
}

// Build a default spelling object for a VisNote from a model pitch, so the falling-notes label
// follows the edit (e.g. a diatonic move to F# shows "F#"/"Fa#"). Mirrors NoteSpelling.
export function spellingFromPitch(p: ModelPitch): NoteSpelling {
  return { letter: p.step, alter: p.alter };
}
