// Invertible command stack over the editable notation model (Smart Edit Mode P1, undo/redo).
//
// The undo/redo is a COMMAND stack, NOT MusicXML-snapshot diffing (ratified in tech-lead.md):
// each command stores the minimal before/after it needs to re-apply and invert, the model is
// small, and the inverses are clean. A DRAG coalesces into ONE command (the model write happens
// once on release, carrying the pre-drag pitch as `before`), so undo reverses the whole gesture.
//
// Commands are PURE data + two model calls (apply / invert). They do NOT touch the DOM, audio,
// or selection directly: the caller (main.ts) routes apply/undo/redo through the same
// re-render / re-derive / reloadNotes path, so undo restores both surfaces + audio exactly like
// a fresh edit. This keeps the stack logic unit-testable against a tiny model stub.

import type {
  AddRecord,
  ChangeDurationRecord,
  DeleteRecord,
  ModelPitch,
  ScoreModel,
  SetKeyRecord,
} from "./edit-model";

// A pitch edit on one model note. `handleId` is the stable handle index; `before`/`after` are
// the written pitches. apply() sets `after`; invert() sets `before`. Used by BOTH surfaces (the
// staff builds `after` diatonically, the canvas chromatically); the command is the same.
export interface SetPitchCommand {
  kind: "setPitch";
  handleId: number;
  before: ModelPitch;
  after: ModelPitch;
}

// A minimal VisNote shape (no import from visualizer, to keep the command stack model-agnostic and
// DOM-free for its unit tests). The command stack NEVER reads this; only the orchestrator
// (main.ts) uses it to splice the deleted falling note out on delete and back in on undo.
export interface VisNoteSnapshot {
  midi: number;
  time: number;
  duration: number;
  hand?: "left" | "right" | "unknown"; // optional, matching VisNote.hand (absent = unknown)
  spelling?: { letter: import("./piano").NoteLetter; alter: number };
}

// A DELETE of one model note (fixed-bar: it becomes a rest / is removed from a chord; the measure
// still adds up, nothing after reflows). `handleId` is the document-position id of the note.
// apply() deletes it via the model and stashes the model's DeleteRecord in `record`; invert()
// restores it from that record. `visNote` + `visIndex` are the orchestrator's bookkeeping so the
// falling note can be removed and re-added at the right slot (the command stack ignores them).
export interface DeleteNoteCommand {
  kind: "deleteNote";
  handleId: number;
  record: DeleteRecord | null; // filled by apply(); used by invert(). Re-filled on redo.
  visNote: VisNoteSnapshot | null;
  visIndex: number | null;
}

// An ADD of one note (ADD-a-note v1): the inverse of a standalone-note delete. A `<rest>` becomes a
// `<note>` of the SAME duration at `pitch` (fixed-bar). `restId` is the document-position id of the
// rest in the model's rest registry. apply() converts it via the model and stashes the AddRecord in
// `record`; invert() turns the note back into the rest from that record. `visNote` is the
// orchestrator's bookkeeping so the new falling note can be spliced in on add and out on undo (the
// command stack ignores it). Mirrors DeleteNoteCommand exactly, with rest <-> note reversed.
export interface AddNoteCommand {
  kind: "addNote";
  restId: number;
  pitch: ModelPitch;
  record: AddRecord | null; // filled by apply(); used by invert(). Re-filled on redo.
  visNote: VisNoteSnapshot | null;
}

// A CHANGE-DURATION of one note (Smart Edit P3 v1): step it one notch shorter/longer along the
// plain value ladder, or TOGGLE its dot (DOTTED v1), FIXED-BAR. `handleId` is the stable handle id
// (a duration edit never adds or removes a pitched note, so the id is stable). apply() steps it via
// the model and stashes the ChangeDurationRecord (a bar snapshot) for undo; invert() restores the
// bar from that record. Like delete/add, the orchestrator (main.ts) re-derives the falling notes
// itself (a lengthen ripples following onsets and a shorten changes a duration + adds a rest), so the
// command stack ignores the vis bookkeeping. `direction` is recorded so a redo reproduces the same
// step deterministically; "dot" reuses the same model edit + undo path (it returns the same record).
export interface ChangeDurationCommand {
  kind: "changeDuration";
  handleId: number;
  direction: "shorter" | "longer" | "dot";
  record: ChangeDurationRecord | null; // filled by apply(); used by invert(). Re-filled on redo.
}

// A SET-KEY of the piece-level key signature (Smart Edit SIG-4): rewrite the initial <key><fifths>
// to `after` (a fifths value, -7..+7), PITCH-PRESERVING (every note keeps its sounding pitch; only the
// printed signature + per-note accidentals change). `before`/`after` are the fifths values, so a redo
// re-applies and an undo restores; apply() runs model.setKeyFifths and stashes the SetKeyRecord (a
// whole-score snapshot) for the invert. A no-op set (same fifths, or no initial <key>) yields a null
// record and is never pushed by the caller, so the stack only holds real key changes.
export interface SetKeyCommand {
  kind: "setKey";
  before: number; // the fifths in effect before the edit (for the announce + a safety fallback)
  after: number; // the target fifths
  record: SetKeyRecord | null; // filled by apply(); used by invert(). Re-filled on redo.
}

export type EditCommand =
  | SetPitchCommand
  | DeleteNoteCommand
  | AddNoteCommand
  | ChangeDurationCommand
  | SetKeyCommand;

export function applyCommand(model: ScoreModel, cmd: EditCommand): void {
  switch (cmd.kind) {
    case "setPitch":
      model.setPitch(cmd.handleId, cmd.after);
      break;
    case "deleteNote":
      // Re-derive the record on every apply (initial push AND redo) so it always describes the
      // CURRENT DOM. Deletion is deterministic, so a redo reproduces the same removal.
      cmd.record = model.deleteNote(cmd.handleId);
      break;
    case "addNote":
      // Re-derive the record on every apply (initial push AND redo): the conversion is
      // deterministic, so a redo reproduces the same rest -> note at the same pitch.
      cmd.record = model.addNote(cmd.restId, cmd.pitch);
      break;
    case "changeDuration":
      // Re-derive the record on every apply (initial push AND redo): the step is deterministic
      // given the restored bar, so a redo reproduces the same shorten/lengthen.
      cmd.record = model.changeDuration(cmd.handleId, cmd.direction);
      break;
    case "setKey":
      // Re-derive the record on every apply (initial push AND redo): rewriting <fifths> to `after` is
      // deterministic, so a redo reproduces the same pitch-preserving accidental rewrite.
      cmd.record = model.setKeyFifths(cmd.after);
      break;
  }
}

export function invertCommand(model: ScoreModel, cmd: EditCommand): void {
  switch (cmd.kind) {
    case "setPitch":
      model.setPitch(cmd.handleId, cmd.before);
      break;
    case "deleteNote":
      if (cmd.record) model.restoreNote(cmd.record);
      break;
    case "addNote":
      if (cmd.record) model.removeNote(cmd.record);
      break;
    case "changeDuration":
      if (cmd.record) model.restoreDuration(cmd.record);
      break;
    case "setKey":
      if (cmd.record) model.restoreKey(cmd.record);
      break;
  }
}

// A LIFO command stack with redo. push() applies a command and clears the redo branch (a new
// edit after an undo abandons the redone future, the standard editor contract). undo()/redo()
// move a command across the boundary and return it (or null at the end) so the caller can
// re-render and announce. The model is mutated through apply/invert; the stack only orders them.
export class CommandStack {
  private undoStack: EditCommand[] = [];
  private redoStack: EditCommand[] = [];

  constructor(private model: ScoreModel) {}

  // Apply a brand-new command and record it. Clears the redo branch.
  push(cmd: EditCommand): void {
    applyCommand(this.model, cmd);
    this.undoStack.push(cmd);
    this.redoStack.length = 0;
  }

  // Record a command WITHOUT applying it (the caller already mutated the model live, e.g. a
  // drag that previewed each step). Still clears the redo branch. The command's before/after
  // must describe the net change so undo/redo work.
  pushApplied(cmd: EditCommand): void {
    this.undoStack.push(cmd);
    this.redoStack.length = 0;
  }

  // Invert the most recent command and move it to the redo stack. Returns it (for announce /
  // re-select), or null when there is nothing to undo.
  undo(): EditCommand | null {
    const cmd = this.undoStack.pop();
    if (!cmd) return null;
    invertCommand(this.model, cmd);
    this.redoStack.push(cmd);
    return cmd;
  }

  // Re-apply the most recently undone command. Returns it, or null when there is nothing to redo.
  redo(): EditCommand | null {
    const cmd = this.redoStack.pop();
    if (!cmd) return null;
    applyCommand(this.model, cmd);
    this.undoStack.push(cmd);
    return cmd;
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }
}
