import type { OpenSheetMusicDisplay } from "opensheetmusicdisplay";
import { ClefEnum, ClefInstruction } from "opensheetmusicdisplay";
import type { VisNote } from "./visualizer";
import type { Hand } from "./piano";
import { handFromStaff, buildStaffClefMap } from "./piano";
import type { StaffClefKind } from "./piano";

export interface ScoreData {
  notes: VisNote[]; // drives audio scheduling and falling notes
  stepTimes: number[]; // absolute seconds of each cursor step, for highlight sync
  duration: number; // total seconds
}

// Reads the first clef declared on each staff so a note can be assigned a hand from its clef
// rather than its staff position. Treble => right, bass => left, "other" for clefs with no
// hand convention (C, percussion). The map is keyed by the staff's sheet-wide id
// (Staff.idInMusicSheet) so it matches the lookup at the call site: the per-measure
// staff-entry index can diverge from that id for exotic multi-instrument files, so we
// resolve each entry back to its ParentStaff rather than trusting array position (issue #73
// / PR #82 follow-up). buildStaffClefMap keeps the first clef seen per staff id.
function readStaffClefs(
  osmd: OpenSheetMusicDisplay,
): Map<number, StaffClefKind> {
  const declarations: { staffId: number; clef: StaffClefKind }[] = [];
  for (const measure of osmd.Sheet.SourceMeasures) {
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
          declarations.push({ staffId, clef });
          break;
        }
      }
    });
  }
  return buildStaffClefMap(declarations);
}

// Walks the score with a cloned iterator (so the visible cursor isn't disturbed),
// converting each note's whole-note timestamp/length into absolute seconds.
export function extractScore(osmd: OpenSheetMusicDisplay): ScoreData {
  const bpm = osmd.Sheet.DefaultStartTempoInBpm || 120;
  const wholeNoteSeconds = (60 / bpm) * 4; // a whole note spans 4 quarter-note beats
  const staffClefs = readStaffClefs(osmd);

  const it = osmd.cursor.iterator.clone();
  const notes: VisNote[] = [];
  const stepTimes: number[] = [];
  let duration = 0;

  while (!it.EndReached) {
    const time = it.currentTimeStamp.RealValue * wholeNoteSeconds;
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
        // Staff position is only a fallback for clefs with no hand convention. Guard
        // defensively so a malformed score (missing staff/instrument) degrades to "unknown".
        const staff = note.ParentStaff;
        const staves = staff?.ParentInstrument?.Staves;
        const hand: Hand = staff
          ? handFromStaff(
              staffClefs.get(staff.idInMusicSheet),
              staves ? staves.indexOf(staff) : -1,
              staves?.length ?? 1,
            )
          : "unknown";
        notes.push({ midi, time, duration: noteDuration, hand });
        duration = Math.max(duration, time + noteDuration);
      }
    }
    it.moveToNext();
  }

  return { notes, stepTimes, duration };
}
