// Pure VisNote[] helper retained for the in-place reload after an edit.
//
// History: this module was the issue-#6 falling-canvas editor (pitch nudge + delete) that
// diverged the VisNote[] from the authoritative sheet. Smart Edit Mode P1 makes the in-house
// notation model the single source of truth and routes PITCH edits through it (edit-model.ts +
// edit-commands.ts), so `nudgePitch` and the `edited` divergence flag are gone. The P1 DELETE
// stopgap (a VisNote-only `deleteNote`) was also pulled: it desynced the two surfaces (the staff
// kept showing the deleted note) and was not undoable, so model-level delete is deferred to P2
// (syncs both surfaces, undoable, fixed-bar rest-filling). `recomputeDuration` stays: the
// reload after a pitch edit uses it to refresh the clock and seek range.
//
// SYNC INVARIANT: this transform NEVER touches a note's `time`, so the falling view and the
// sheet cursor still share one timestamp source.
import type { VisNote } from "./visualizer";

// Recompute the total score duration from the notes (the latest note end). Used after an edit
// to refresh the clock and the seek range. Empty score = 0.
export function recomputeDuration(notes: readonly VisNote[]): number {
  let max = 0;
  for (const n of notes) max = Math.max(max, n.time + n.duration);
  return max;
}
