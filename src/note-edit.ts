// Pure, immutable transforms over a VisNote[] for the OMR correction UI (issue #6, first
// slice: pitch nudge + delete). Every function returns a NEW array; it never mutates the
// input or any note object, so the caller can swap the result in atomically and a stale
// reference still reads the old score. The sheet stays AUTHORITATIVE and unchanged: these
// edits diverge the falling-notes model from the scanned sheet, and an `edited` flag marks
// the bars that changed so the divergence is legible on screen (Designer decision #1).
//
// SYNC INVARIANT: these transforms NEVER touch a note's `time` (only `midi` or removal), so
// the falling view and the sheet cursor still share one timestamp source. Durations are only
// summed for the readout via recomputeDuration; a delete shortens the total, a nudge does not.
import { FIRST_MIDI, LAST_MIDI } from "./piano";
import type { VisNote } from "./visualizer";

// Clamp a candidate MIDI to the 88-key piano range (A0=21 .. C8=108). A nudge that would
// push past either end is pinned to the edge rather than producing an unplayable pitch.
function clampMidi(midi: number): number {
  return Math.max(FIRST_MIDI, Math.min(LAST_MIDI, midi));
}

// Shift note `i`'s pitch by `delta` semitones (typically +-1), clamped to 21..108. Marks the
// note `edited` so the bar gets the divergence outline. CLEARS `spelling`: the printed spelling
// came from the sheet's notehead (e.g. a "Db" reads "Reb"); once the user moves the pitch by
// hand that spelling no longer describes the note, so we drop it and let the honest always-sharp
// MIDI name show instead of a stale enharmonic from the original scan. Returns a NEW array with a
// NEW note object at `i`; all other notes are referenced unchanged. Out-of-range `i` is a no-op
// returning a shallow copy (so the caller can treat the result uniformly).
export function nudgePitch(notes: readonly VisNote[], i: number, delta: number): VisNote[] {
  const next = notes.slice();
  if (i < 0 || i >= next.length) return next;
  const note = next[i];
  const midi = clampMidi(note.midi + delta);
  next[i] = { ...note, midi, edited: true, spelling: undefined };
  return next;
}

// Remove note `i` (a spurious note the scan invented). Returns a NEW array without it; the
// surviving notes are referenced unchanged. Out-of-range `i` returns a shallow copy unchanged.
export function deleteNote(notes: readonly VisNote[], i: number): VisNote[] {
  if (i < 0 || i >= notes.length) return notes.slice();
  const next = notes.slice();
  next.splice(i, 1);
  return next;
}

// Recompute the total score duration from the notes (the latest note end). Used after an edit
// to refresh the clock and the seek range without re-rendering the sheet. Empty score = 0.
export function recomputeDuration(notes: readonly VisNote[]): number {
  let max = 0;
  for (const n of notes) max = Math.max(max, n.time + n.duration);
  return max;
}

// Whether any note carries an edit, so the UI can show the one-time "Edited" status line and
// the sheet-divergence note (Designer decision #1).
export function hasEdits(notes: readonly VisNote[]): boolean {
  return notes.some((n) => n.edited === true);
}
