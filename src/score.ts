import type { OpenSheetMusicDisplay } from "opensheetmusicdisplay";
import type { MusicSheet, Pitch, SourceStaffEntry } from "opensheetmusicdisplay";
import { AccidentalEnum, ClefEnum, ClefInstruction, NoteEnum } from "opensheetmusicdisplay";
import type { VisNote } from "./visualizer";
import type { Hand, NoteLetter, NoteSpelling } from "./piano";
import {
  handFromStaff,
  handFromClefInEffect,
  handFromPitch,
  buildStaffClefMap,
  buildStaffClefTimeline,
} from "./piano";
import type { StaffClefKind, ClefDeclaration } from "./piano";

export interface ScoreData {
  notes: VisNote[]; // drives audio scheduling and falling notes
  stepTimes: number[]; // absolute seconds of each cursor step, for highlight sync
  duration: number; // total seconds
}

function clefKind(instruction: ClefInstruction): StaffClefKind {
  return instruction.ClefType === ClefEnum.G
    ? "treble"
    : instruction.ClefType === ClefEnum.F
      ? "bass"
      : "other";
}

// OSMD FundamentalNote (NoteEnum: C=0, D=2, E=4, F=5, G=7, A=9, B=11) -> diatonic letter.
const NOTE_ENUM_TO_LETTER: ReadonlyMap<NoteEnum, NoteLetter> = new Map([
  [NoteEnum.C, "C"],
  [NoteEnum.D, "D"],
  [NoteEnum.E, "E"],
  [NoteEnum.F, "F"],
  [NoteEnum.G, "G"],
  [NoteEnum.A, "A"],
  [NoteEnum.B, "B"],
]);

// OSMD AccidentalEnum -> the <alter> semitone shift the spelling carries. SHARP/FLAT and
// their doubles map to +-1/+-2; NONE and NATURAL carry no shift (a natural prints just the
// letter, since the staff position already says which letter). Microtonal/exotic accidentals
// have no piano key and no plain-letter name, so we return undefined to fall back to the
// always-sharp MIDI name rather than invent a spelling.
function accidentalAlter(accidental: AccidentalEnum): number | undefined {
  switch (accidental) {
    case AccidentalEnum.SHARP:
      return 1;
    case AccidentalEnum.DOUBLESHARP:
      return 2;
    case AccidentalEnum.FLAT:
      return -1;
    case AccidentalEnum.DOUBLEFLAT:
      return -2;
    case AccidentalEnum.NONE:
    case AccidentalEnum.NATURAL:
      return 0;
    default:
      return undefined;
  }
}

// Reads a note's printed spelling (issues #56/#58) from OSMD's Pitch so labels match the
// synced sheet instead of an always-sharp name recomputed from MIDI. Returns undefined when
// the note has no pitch or carries a microtonal/exotic accidental, so those notes fall back
// to the default. Prefers the TRANSPOSED pitch when the score is transposed, so the spelling
// agrees with the transposed staff (and with `note.halfTone`, which is also transposed).
export function readSpelling(pitch: Pitch | undefined): NoteSpelling | undefined {
  if (!pitch) return undefined;
  const letter = NOTE_ENUM_TO_LETTER.get(pitch.FundamentalNote);
  if (letter === undefined) return undefined;
  const alter = accidentalAlter(pitch.Accidental);
  if (alter === undefined) return undefined;
  return { letter, alter };
}

// Reads every clef declaration in the score, tagged with its staff id and measure index, so
// hand-tagging can consult either the FIRST clef per staff (multi-staff grand staff) or the
// clef IN EFFECT at a note's measure (single collapsed staff, issue #87). Treble => right,
// bass => left, "other" for clefs with no hand convention (C, percussion). Declarations are
// keyed by the staff's sheet-wide id (Staff.idInMusicSheet) so they match the lookup at the
// call site: the per-measure staff-entry index can diverge from that id for exotic
// multi-instrument files, so we resolve each entry back to its ParentStaff rather than
// trusting array position (issue #73 / PR #82 follow-up).
//
// Two real-OSMD shapes (issue #90) that the naive "read FirstInstructionsStaffEntries and
// trust entry.ParentStaff" version dropped on the floor for a collapsed single-staff scan:
//  1. ParentStaff is undefined on the instruction entries of a SINGLE-STAFF instrument. The
//     staff still has an idInMusicSheet, so when the sheet is one instrument with one staff
//     we attribute the clef to that lone staff instead of discarding it.
//  2. A mid-piece clef change lives in LastInstructionsStaffEntries of the PRECEDING measure,
//     not FirstInstructionsStaffEntries of the new measure. We read both buckets; a `last`
//     clef applies from measureIndex + 1 (and `source` lets the timeline let a genuine `first`
//     clef at that measure win the tie).
export function readClefDeclarations(sheet: MusicSheet): ClefDeclaration[] {
  const declarations: ClefDeclaration[] = [];
  // The lone staff id to attribute clefs to when an entry has no ParentStaff. Only meaningful
  // when the whole sheet is a single single-staff instrument (a collapsed OMR grand staff);
  // for genuine multi-staff / multi-instrument scores we never guess and keep the entry guard.
  const loneStaffId =
    sheet.Instruments.length === 1 && sheet.Instruments[0].Staves.length === 1
      ? sheet.Instruments[0].Staves[0].idInMusicSheet
      : undefined;

  const collect = (
    entry: SourceStaffEntry | undefined,
    measureIndex: number,
    source: "first" | "last",
  ): void => {
    if (entry == null) return;
    const staffId = entry.ParentStaff?.idInMusicSheet ?? loneStaffId;
    if (staffId == null) return;
    for (const instruction of entry.Instructions) {
      if (instruction instanceof ClefInstruction) {
        // A `last`-bucket clef change takes effect from the NEXT measure.
        const measure = source === "last" ? measureIndex + 1 : measureIndex;
        declarations.push({ staffId, measureIndex: measure, clef: clefKind(instruction), source });
        break;
      }
    }
  };

  sheet.SourceMeasures.forEach((measure, measureIndex) => {
    measure.FirstInstructionsStaffEntries?.forEach((entry) => collect(entry, measureIndex, "first"));
    measure.LastInstructionsStaffEntries?.forEach((entry) => collect(entry, measureIndex, "last"));
  });
  return declarations;
}

// A note pulled off the cursor, plus the identity of the tie it belongs to (issue #123). A
// MusicXML tie is several <note> segments sharing one curve; OSMD gives each segment the same
// Tie object, with tie.StartNote marking the first. We carry a per-tie id and an isTieStart
// flag so mergeTiedNotes can fold a held note back into one sustained bar.
export interface RawNote extends VisNote {
  tieId?: number; // shared across every segment of one tie; undefined for an untied note
  isTieStart?: boolean; // true only for the segment that begins the tie chain
}

// Folds tie continuations into the note they're tied from, so a held pitch becomes ONE
// sustained falling bar instead of restruck notes (issue #123). A continuation segment never
// emits its own VisNote: its duration is added to the chain's start note. Defensive: a
// continuation with no recorded start (malformed/partial tie from a noisy OMR scan) is emitted
// standalone rather than dropped, so we never lose a note.
export function mergeTiedNotes(raw: readonly RawNote[]): { notes: VisNote[]; duration: number } {
  const notes: VisNote[] = [];
  const startIndexByTie = new Map<number, number>();
  let duration = 0;
  for (const r of raw) {
    if (r.tieId !== undefined && !r.isTieStart) {
      const startIndex = startIndexByTie.get(r.tieId);
      if (startIndex !== undefined) {
        notes[startIndex].duration += r.duration;
        duration = Math.max(duration, notes[startIndex].time + notes[startIndex].duration);
        continue;
      }
    }
    const note: VisNote = {
      midi: r.midi,
      time: r.time,
      duration: r.duration,
      hand: r.hand,
      spelling: r.spelling,
    };
    notes.push(note);
    duration = Math.max(duration, note.time + note.duration);
    if (r.tieId !== undefined && r.isTieStart) {
      startIndexByTie.set(r.tieId, notes.length - 1);
    }
  }
  return { notes, duration };
}

// Walks the score with a cloned iterator (so the visible cursor isn't disturbed),
// converting each note's whole-note timestamp/length into absolute seconds.
export function extractScore(osmd: OpenSheetMusicDisplay): ScoreData {
  const bpm = osmd.Sheet.DefaultStartTempoInBpm || 120;
  const wholeNoteSeconds = (60 / bpm) * 4; // a whole note spans 4 quarter-note beats
  const declarations = readClefDeclarations(osmd.Sheet);
  // Two lookups, chosen per note by the staff count of its instrument:
  //  - First clef per staff (multi-staff grand staff): a transient mid-staff clef change on
  //    the RH staff must not move those notes to the LH (issues #73/#82/#36).
  //  - Clef in effect per measure (single collapsed staff, issue #87): an OMR scan can flatten
  //    a grand staff onto one staff that switches treble -> bass mid-piece, where the clef at
  //    the note's measure IS the correct hand.
  const staffClefs = buildStaffClefMap(declarations);
  const clefTimeline = buildStaffClefTimeline(
    declarations,
    osmd.Sheet.SourceMeasures.length,
  );

  const it = osmd.cursor.iterator.clone();
  const raw: RawNote[] = [];
  const stepTimes: number[] = [];
  // Assigns each OSMD Tie object a small stable id, so mergeTiedNotes can group a held note's
  // segments without depending on OSMD object identity downstream (issue #123).
  const tieIds = new Map<object, number>();

  while (!it.EndReached) {
    const time = it.currentTimeStamp.RealValue * wholeNoteSeconds;
    const measureIndex = it.CurrentMeasureIndex; // preserved across the cloned iterator
    stepTimes.push(time);
    for (const entry of it.CurrentVoiceEntries) {
      for (const note of entry.Notes) {
        if (note.isRest()) continue;
        const midi = note.halfTone + 12; // OSMD halfTone 0 = C0; MIDI C0 = 12
        const noteDuration = note.Length.RealValue * wholeNoteSeconds;
        // Printed spelling for the label (issues #56/#58): a Db reads "Db"/"Reb" instead of
        // the always-sharp "C#"/"Do#". halfTone is the transposed pitch, so read the spelling
        // from the transposed pitch too when present so the two agree.
        const spelling = readSpelling(note.TransposedPitch ?? note.Pitch);
        // Tag the hand for piano (issue #36). The clef is the primary signal (treble =>
        // right, bass => left) so the split is correct even when the file lists its staves
        // bass-first, AND whether the piano is one instrument with two staves or two
        // separate single-staff parts (music21 fragments do the latter; issue #70 follow-up).
        // Guard defensively so a malformed score (missing staff/instrument) degrades to
        // "unknown".
        const staff = note.ParentStaff;
        const staves = staff?.ParentInstrument?.Staves;
        let hand: Hand = "unknown";
        if (staff) {
          const staffCount = staves?.length ?? 1;
          if (staffCount > 1) {
            // True grand staff: first clef per staff, position fallback for C/percussion.
            hand = handFromStaff(
              staffClefs.get(staff.idInMusicSheet),
              staves ? staves.indexOf(staff) : -1,
              staffCount,
            );
          } else {
            // Single staff: use the clef in effect at this measure so a collapsed grand
            // staff splits into hands (issue #87). A stable-clef single-staff part keeps
            // its single hand, since clef-in-effect == its first clef.
            const timeline = clefTimeline.get(staff.idInMusicSheet);
            hand = handFromClefInEffect(timeline?.[measureIndex]);
          }
        }
        // The per-hand controls must always be available, so every note has to land on a
        // real hand. When clef/staff data can't decide (a lone staff with a no-hand clef,
        // or a malformed score), split by pitch at middle C, the same heuristic the
        // audio-derived path uses, instead of leaving the note "unknown".
        if (hand === "unknown") hand = handFromPitch(midi);
        // Tag the tie this note belongs to (issue #123) so a held note merges into one bar.
        let tieId: number | undefined;
        let isTieStart = false;
        const tie = note.NoteTie;
        if (tie) {
          let id = tieIds.get(tie);
          if (id === undefined) {
            id = tieIds.size;
            tieIds.set(tie, id);
          }
          tieId = id;
          isTieStart = tie.StartNote === note;
        }
        raw.push({ midi, time, duration: noteDuration, hand, spelling, tieId, isTieStart });
      }
    }
    it.moveToNext();
  }

  const { notes, duration } = mergeTiedNotes(raw);
  return { notes, stepTimes, duration };
}
