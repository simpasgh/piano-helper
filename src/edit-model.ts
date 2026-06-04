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

import type { NoteLetter, NoteSpelling } from "./piano";

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
  return { step, octave, alter: keyAlterForLetter(step, fifths) };
}

// Move a pitch one CHROMATIC semitone (Ctrl on the staff; the canvas's native unit). Prefer
// keeping the LETTER and changing the accidental (the way you reach a sharp/flat), within the
// +-2 double-accidental range; if that would exceed it, fall to the neighbouring letter at the
// correct enharmonic so the pitch is still right. Pure; preserves a valid spelling for Verovio.
export function chromaticStep(p: ModelPitch, dir: 1 | -1): ModelPitch {
  const targetMidi = midiFromPitch(p) + dir;
  const nextAlter = p.alter + dir;
  if (nextAlter >= -2 && nextAlter <= 2) {
    // Same letter + adjusted accidental keeps the written letter (E -> E#, E -> Eb).
    return { step: p.step, octave: p.octave, alter: nextAlter };
  }
  // Past the double accidental: move to the adjacent letter and re-spell at the target MIDI.
  return pitchFromMidi(targetMidi, dir);
}

// Move a pitch by a whole OCTAVE (Shift), keeping the written letter + accidental. Pure.
export function octaveStep(p: ModelPitch, dir: 1 | -1): ModelPitch {
  return { step: p.step, octave: p.octave + dir, alter: p.alter };
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

// The editable score model. Holds the parsed DOM and the ordered pitched-note handles. Edits
// mutate the DOM through handles; serialize() re-emits MusicXML for Verovio.
export interface ScoreModel {
  handles: NoteHandle[];
  setPitch(id: number, pitch: ModelPitch): void;
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
  const handles: NoteHandle[] = [];

  const soundTempo = doc.querySelector("sound[tempo]")?.getAttribute("tempo");
  const bpm =
    bpmOverride && Number.isFinite(bpmOverride) && bpmOverride > 0
      ? bpmOverride
      : soundTempo && Number.isFinite(Number(soundTempo))
        ? Number(soundTempo)
        : 120;
  const secPerQuarter = 60 / bpm;

  // Per-handle key signature (fifths) so diatonic stepping is key-aware. Captured at parse time
  // from the attributes in effect at the handle's measure.
  const handleFifths: number[] = [];

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
    serialize(): string {
      return serializer.serializeToString(doc);
    },
  };
  return model;
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
