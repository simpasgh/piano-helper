import type { OpenSheetMusicDisplay } from "opensheetmusicdisplay";
import { ClefEnum, ClefInstruction } from "opensheetmusicdisplay";
import type { VisNote } from "./visualizer";
import type { Hand } from "./piano";
import { handFromClef, handFromStaffIndex } from "./piano";

export interface ScoreData {
  notes: VisNote[]; // drives audio scheduling and falling notes
  stepTimes: number[]; // absolute seconds of each cursor step, for highlight sync
  duration: number; // total seconds
}

// Reads the first clef declared on each staff (keyed by the staff's sheet-wide index) so a
// note can be assigned a hand from its clef rather than its staff position. Treble => right,
// bass => left. We only need the opening clef of each staff: later clef changes don't move a
// note to the other hand. Returns "other" for clefs with no hand convention (C, percussion).
function readStaffClefs(
  osmd: OpenSheetMusicDisplay,
): Map<number, "treble" | "bass" | "other"> {
  const clefs = new Map<number, "treble" | "bass" | "other">();
  for (const measure of osmd.Sheet.SourceMeasures) {
    measure.FirstInstructionsStaffEntries?.forEach((entry, staffIndex) => {
      if (!entry || clefs.has(staffIndex)) return;
      for (const instruction of entry.Instructions) {
        if (instruction instanceof ClefInstruction) {
          const kind =
            instruction.ClefType === ClefEnum.G
              ? "treble"
              : instruction.ClefType === ClefEnum.F
                ? "bass"
                : "other";
          clefs.set(staffIndex, kind);
          break;
        }
      }
    });
  }
  return clefs;
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
        // Tag the hand for grand-staff piano (issue #36). The clef is the primary signal
        // (treble => right, bass => left) so the split is correct even when the file lists
        // its staves bass-first; staff position is only a fallback for clefs with no hand
        // convention. Single-staff parts can't be split, so they stay "unknown". Guard
        // defensively so a malformed score (missing staff/instrument) degrades to "unknown".
        const staff = note.ParentStaff;
        const staves = staff?.ParentInstrument?.Staves;
        let hand: Hand = "unknown";
        if (staff && staves && staves.length >= 2) {
          const clef = staffClefs.get(staff.idInMusicSheet);
          hand =
            (clef && handFromClef(clef)) ||
            handFromStaffIndex(staves.indexOf(staff), staves.length);
        }
        notes.push({ midi, time, duration: noteDuration, hand });
        duration = Math.max(duration, time + noteDuration);
      }
    }
    it.moveToNext();
  }

  return { notes, stepTimes, duration };
}
