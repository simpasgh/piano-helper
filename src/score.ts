import type { OpenSheetMusicDisplay } from "opensheetmusicdisplay";
import type { VisNote } from "./visualizer";

export interface ScoreData {
  notes: VisNote[]; // drives audio scheduling and falling notes
  stepTimes: number[]; // absolute seconds of each cursor step, for highlight sync
  duration: number; // total seconds
}

// Walks the score with a cloned iterator (so the visible cursor isn't disturbed),
// converting each note's whole-note timestamp/length into absolute seconds.
export function extractScore(osmd: OpenSheetMusicDisplay): ScoreData {
  const bpm = osmd.Sheet.DefaultStartTempoInBpm || 120;
  const wholeNoteSeconds = (60 / bpm) * 4; // a whole note spans 4 quarter-note beats

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
        notes.push({ midi, time, duration: noteDuration });
        duration = Math.max(duration, time + noteDuration);
      }
    }
    it.moveToNext();
  }

  return { notes, stepTimes, duration };
}
