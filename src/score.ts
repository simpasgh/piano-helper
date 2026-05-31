import type { OpenSheetMusicDisplay } from "opensheetmusicdisplay";
import { ClefEnum, ClefInstruction } from "opensheetmusicdisplay";
import type { VisNote } from "./visualizer";
import type { Hand } from "./piano";
import {
  handFromStaff,
  handFromClefInEffect,
  buildStaffClefMap,
  buildStaffClefTimeline,
} from "./piano";
import type { StaffClefKind, ClefDeclaration } from "./piano";

export interface ScoreData {
  notes: VisNote[]; // drives audio scheduling and falling notes
  stepTimes: number[]; // absolute seconds of each cursor step, for highlight sync
  duration: number; // total seconds
}

// Reads every clef declaration in the score, tagged with its staff id and measure index, so
// hand-tagging can consult either the FIRST clef per staff (multi-staff grand staff) or the
// clef IN EFFECT at a note's measure (single collapsed staff, issue #87). Treble => right,
// bass => left, "other" for clefs with no hand convention (C, percussion). Declarations are
// keyed by the staff's sheet-wide id (Staff.idInMusicSheet) so they match the lookup at the
// call site: the per-measure staff-entry index can diverge from that id for exotic
// multi-instrument files, so we resolve each entry back to its ParentStaff rather than
// trusting array position (issue #73 / PR #82 follow-up).
function readClefDeclarations(osmd: OpenSheetMusicDisplay): ClefDeclaration[] {
  const declarations: ClefDeclaration[] = [];
  osmd.Sheet.SourceMeasures.forEach((measure, measureIndex) => {
    measure.FirstInstructionsStaffEntries?.forEach((entry) => {
      const staffId = entry?.ParentStaff?.idInMusicSheet;
      if (entry == null || staffId == null) return;
      for (const instruction of entry.Instructions) {
        if (instruction instanceof ClefInstruction) {
          const clef: StaffClefKind =
            instruction.ClefType === ClefEnum.G
              ? "treble"
              : instruction.ClefType === ClefEnum.F
                ? "bass"
                : "other";
          declarations.push({ staffId, measureIndex, clef });
          break;
        }
      }
    });
  });
  return declarations;
}

// Walks the score with a cloned iterator (so the visible cursor isn't disturbed),
// converting each note's whole-note timestamp/length into absolute seconds.
export function extractScore(osmd: OpenSheetMusicDisplay): ScoreData {
  const bpm = osmd.Sheet.DefaultStartTempoInBpm || 120;
  const wholeNoteSeconds = (60 / bpm) * 4; // a whole note spans 4 quarter-note beats
  const declarations = readClefDeclarations(osmd);
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
  const notes: VisNote[] = [];
  const stepTimes: number[] = [];
  let duration = 0;

  while (!it.EndReached) {
    const time = it.currentTimeStamp.RealValue * wholeNoteSeconds;
    const measureIndex = it.CurrentMeasureIndex; // preserved across the cloned iterator
    stepTimes.push(time);
    for (const entry of it.CurrentVoiceEntries) {
      for (const note of entry.Notes) {
        if (note.isRest()) continue;
        const midi = note.halfTone + 12; // OSMD halfTone 0 = C0; MIDI C0 = 12
        const noteDuration = note.Length.RealValue * wholeNoteSeconds;
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
        notes.push({ midi, time, duration: noteDuration, hand });
        duration = Math.max(duration, time + noteDuration);
      }
    }
    it.moveToNext();
  }

  return { notes, stepTimes, duration };
}
