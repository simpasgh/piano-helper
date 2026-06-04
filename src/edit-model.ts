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
  setPitch(id: number, pitch: ModelPitch): void;
  // Delete the note as a FIXED-BAR rest (see DeleteRecord) and re-index. Returns the record needed
  // to invert, or null for an invalid id. The VisNote count drops by one (the rest / removal emits
  // no handle), so the caller must re-derive the falling notes + rebuild the maps.
  deleteNote(id: number): DeleteRecord | null;
  // Invert a delete: re-insert the original note at its prior position (reversing any promotion)
  // and re-index, so the restored note reclaims its original handle id.
  restoreNote(record: DeleteRecord): void;
  fifthsForHandle(id: number): number;
  serialize(): string;
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

  // Walk the live DOM and (re)build the pitched-note handles + their key signatures in document
  // order. Called once at parse and again after every STRUCTURAL edit (delete / restore), so a
  // handle's id is always its current document position. Onsets are computed exactly as before
  // (divisions, <backup>/<forward>, chords share the prior onset, rests advance but emit no handle).
  function reindexHandles(): void {
    handles.length = 0;
    handleFifths.length = 0;
    const parts = Array.from(doc.getElementsByTagName("part"));
    for (const part of parts) {
      let divisions = 1; // <divisions> per quarter note; updated by <attributes>
      let fifths = 0; // current key signature
      const measures = Array.from(part.getElementsByTagName("measure"));
      for (const measure of measures) {
        let cursor = 0; // divisions from the measure start
        let prevOnset = 0; // onset of the last non-chord note, for chord members
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
            continue;
          }
          if (tag !== "note") continue;

          const isChord = child(node, "chord") !== null;
          const isRest = child(node, "rest") !== null;
          const durDivs = num(child(node, "duration"), 0);
          const onsetDivs = isChord ? prevOnset : cursor;

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
                onsetSec: (onsetDivs / divisions) * secPerQuarter,
                midi: midiFromPitch(pitch),
                pitch,
                isChordMember: isChord,
                isTieContinuation,
              });
              handleFifths.push(fifths);
            }
          }

          // Advance the cursor for non-chord notes (and rests); chord members share the onset.
          if (!isChord) {
            prevOnset = onsetDivs;
            cursor = onsetDivs + durDivs;
          }
        }
      }
    }
  }

  reindexHandles();

  const serializer = new XMLSerializer();

  const model: ScoreModel = {
    handles,
    fifthsForHandle(id: number): number {
      return handleFifths[id] ?? 0;
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
    serialize(): string {
      return serializer.serializeToString(doc);
    },
  };
  return model;
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
