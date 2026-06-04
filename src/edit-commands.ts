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

import type { ModelPitch, ScoreModel } from "./edit-model";

// A pitch edit on one model note. `handleId` is the stable handle index; `before`/`after` are
// the written pitches. apply() sets `after`; invert() sets `before`. Used by BOTH surfaces (the
// staff builds `after` diatonically, the canvas chromatically); the command is the same.
export interface SetPitchCommand {
  kind: "setPitch";
  handleId: number;
  before: ModelPitch;
  after: ModelPitch;
}

export type EditCommand = SetPitchCommand;

export function applyCommand(model: ScoreModel, cmd: EditCommand): void {
  switch (cmd.kind) {
    case "setPitch":
      model.setPitch(cmd.handleId, cmd.after);
      break;
  }
}

export function invertCommand(model: ScoreModel, cmd: EditCommand): void {
  switch (cmd.kind) {
    case "setPitch":
      model.setPitch(cmd.handleId, cmd.before);
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
