// Pure navigation + pitch-default logic for Smart Edit Mode (ADD-a-note v1 + the delete neighbor).
//
// These functions take plain data (no DOM, no module state) so they are unit-testable without
// booting main.ts, the same split as edit-pointer.ts / playback.ts. main.ts adapts its handles /
// rest handles into these shapes and applies the results to the live selection + model.

import { diatonicStep, type ModelPitch } from "./edit-model";

// One stop on the staff's Left/Right walk: a pitched NOTE or a REST, identified by its model id.
// Rests are interleaved with notes by onset so a keyboard user can land on a gap (ADD-1).
export type StaffNavTarget = { kind: "note"; id: number } | { kind: "rest"; id: number };

// A note as the nav order needs it: its handle id, onset, and midi (for the onset-tie sub-sort).
export interface NavNote {
  id: number;
  onsetSec: number;
  midi: number;
}
// A rest as the nav order needs it: its rest-registry id and onset.
export interface NavRest {
  id: number;
  onsetSec: number;
}

// The full staff Left/Right order: notes AND rests interleaved by onset (ADD-1). Ties on onset put
// a rest AFTER notes at that onset (a small, stable choice so a chord's notes come before a rest
// sharing the beat); notes at one onset sub-sort by midi. Pure; the caller passes already-filtered
// notes (tie continuations excluded) so this stays a sort.
export function staffNavOrder(notes: readonly NavNote[], rests: readonly NavRest[]): StaffNavTarget[] {
  const entries = [
    ...notes.map((n) => ({ kind: "note" as const, id: n.id, onset: n.onsetSec, rank: 0, sub: n.midi })),
    ...rests.map((r) => ({ kind: "rest" as const, id: r.id, onset: r.onsetSec, rank: 1, sub: 0 })),
  ];
  entries.sort((a, b) => a.onset - b.onset || a.rank - b.rank || a.sub - b.sub);
  return entries.map((e) => (e.kind === "note" ? { kind: "note", id: e.id } : { kind: "rest", id: e.id }));
}

// The next stop after `current` stepping by `delta` (+1 / -1), wrapping at the ends. With no current
// selection (current = null), +1 lands on the first and -1 on the last, so one arrow always lands.
// Returns null only for an empty order. Pure.
export function stepStaffNav(
  order: readonly StaffNavTarget[],
  current: StaffNavTarget | null,
  delta: 1 | -1,
): StaffNavTarget | null {
  if (order.length === 0) return null;
  const idx =
    current === null
      ? -1
      : order.findIndex((t) => t.kind === current.kind && t.id === current.id);
  let next: number;
  if (idx === -1) next = delta > 0 ? 0 : order.length - 1;
  else next = (idx + delta + order.length) % order.length;
  return order[next];
}

// A pitched note as the keyboard pitch default needs it: its onset, voice/staff, and written pitch.
export interface PrevNoteCandidate {
  onsetSec: number;
  staff: number;
  voice: number;
  pitch: ModelPitch;
}

// The KEYBOARD default pitch for a fill on a rest (ADD-2): the PREVIOUS sounding note's pitch in the
// SAME voice + staff (the nearest earlier onset), else the staff middle line (B4 treble / D3 bass by
// `restStaff`). "Same as the note before it" is the fewest-keystrokes prior for a melodic gap. Pure.
export function keyboardDefaultPitch(
  restOnsetSec: number,
  restStaff: number,
  restVoice: number,
  candidates: readonly PrevNoteCandidate[],
): ModelPitch {
  let best: PrevNoteCandidate | null = null;
  for (const c of candidates) {
    if (c.staff !== restStaff || c.voice !== restVoice) continue;
    if (c.onsetSec >= restOnsetSec) continue;
    if (best === null || c.onsetSec > best.onsetSec) best = c;
  }
  if (best) return best.pitch;
  return restStaff === 2 ? { step: "D", octave: 3, alter: 0 } : { step: "B", octave: 4, alter: 0 };
}

// The MOUSE default pitch for a fill on a rest (ADD-2): the staff line/space the user CLICKED. The
// click's vertical offset from the rest glyph's CENTER (taken as the staff middle line, B4 treble /
// D3 bass by `restStaff`), measured in `steps` diatonic steps (the caller computes steps from the
// click y + the glyph height; +steps = above center = higher pitch), is applied to the middle line
// key-signature aware. Pure (the y->steps geometry lives in main.ts against the live glyph bbox).
export function mouseDefaultPitch(restStaff: number, fifths: number, steps: number): ModelPitch {
  const middle: ModelPitch =
    restStaff === 2 ? { step: "D", octave: 3, alter: 0 } : { step: "B", octave: 4, alter: 0 };
  let pitch: ModelPitch = { ...middle };
  for (let s = 0; s < Math.abs(steps); s++) {
    pitch = diatonicStep(pitch, steps > 0 ? 1 : -1, fifths);
  }
  return pitch;
}

// A pitched note as the delete-neighbor logic needs it: its handle id, onset, and midi.
// (Same shape as NavNote, kept separate for intent.)
export interface NeighborNote {
  id: number;
  onsetSec: number;
  midi: number;
}

// The handle id to select after a note at (`onsetSec`, `midi`) is deleted, by MUSICAL order over the
// REMAINING notes: the nearest note strictly AFTER it in (onset, midi) order, else the nearest
// before (the deleted note was the musical last), else null (no notes left). This is the post-delete
// equivalent of "next note, else previous" so delete and its redo select IDENTICALLY even on a grand
// staff where document order != musical order (the P2 review fix). `remaining` excludes the deleted
// note (and tie continuations); it need not be sorted. Pure.
export function musicalNeighborAfterDelete(
  remaining: readonly NeighborNote[],
  onsetSec: number,
  midi: number,
): number | null {
  if (remaining.length === 0) return null;
  const sorted = remaining.slice().sort((a, b) => a.onsetSec - b.onsetSec || a.midi - b.midi);
  const after = sorted.find(
    (h) => h.onsetSec > onsetSec + 1e-9 || (Math.abs(h.onsetSec - onsetSec) < 1e-9 && h.midi > midi),
  );
  if (after) return after.id;
  return sorted[sorted.length - 1].id;
}
