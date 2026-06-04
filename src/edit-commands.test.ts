// Unit tests for the invertible command stack (Smart Edit Mode P1, undo/redo). These use a tiny
// in-memory model stub (just a pitch per handle) so the stack logic is isolated from the DOM:
// the real ScoreModel's setPitch is exercised in edit-model.test.ts.

import { describe, it, expect } from "vitest";
import {
  CommandStack,
  applyCommand,
  invertCommand,
  type SetPitchCommand,
  type DeleteNoteCommand,
} from "./edit-commands";
import type { DeleteRecord, ModelPitch, ScoreModel } from "./edit-model";

const p = (step: ModelPitch["step"], octave: number, alter = 0): ModelPitch => ({
  step,
  octave,
  alter,
});

// A minimal ScoreModel stand-in: records the last pitch set per handle, and a delete/restore log,
// so the tests can assert what apply/invert routed through the model. Only the methods the command
// stack calls are implemented. deleteNote returns a sentinel record so the stack stores + replays it.
function stubModel(): ScoreModel & {
  pitches: Map<number, ModelPitch>;
  deleted: number[];
  restored: DeleteRecord[];
} {
  const pitches = new Map<number, ModelPitch>();
  const deleted: number[] = [];
  const restored: DeleteRecord[] = [];
  return {
    pitches,
    deleted,
    restored,
    handles: [],
    fifthsForHandle: () => 0,
    setPitch: (id: number, pitch: ModelPitch) => {
      pitches.set(id, pitch);
    },
    deleteNote: (id: number): DeleteRecord => {
      deleted.push(id);
      // A stub record: the real DOM fields are not exercised here (edit-model.test.ts covers them).
      return {
        removedClone: { tag: `note-${id}` } as unknown as Element,
        parent: {} as Element,
        nextSibling: null,
        restPlaceholder: null,
        promoted: null,
      };
    },
    restoreNote: (record: DeleteRecord) => {
      restored.push(record);
    },
    serialize: () => "",
  };
}

const setPitch = (handleId: number, before: ModelPitch, after: ModelPitch): SetPitchCommand => ({
  kind: "setPitch",
  handleId,
  before,
  after,
});

const deleteNote = (handleId: number): DeleteNoteCommand => ({
  kind: "deleteNote",
  handleId,
  record: null,
  visNote: null,
  visIndex: null,
});

describe("applyCommand / invertCommand", () => {
  it("apply sets `after`; invert sets `before`", () => {
    const model = stubModel();
    const cmd = setPitch(3, p("C", 4), p("D", 4));
    applyCommand(model, cmd);
    expect(model.pitches.get(3)).toEqual(p("D", 4));
    invertCommand(model, cmd);
    expect(model.pitches.get(3)).toEqual(p("C", 4));
  });
});

describe("CommandStack", () => {
  it("starts empty (nothing to undo or redo)", () => {
    const stack = new CommandStack(stubModel());
    expect(stack.canUndo()).toBe(false);
    expect(stack.canRedo()).toBe(false);
    expect(stack.undo()).toBeNull();
    expect(stack.redo()).toBeNull();
  });

  it("push applies the command and enables undo", () => {
    const model = stubModel();
    const stack = new CommandStack(model);
    stack.push(setPitch(0, p("C", 4), p("D", 4)));
    expect(model.pitches.get(0)).toEqual(p("D", 4));
    expect(stack.canUndo()).toBe(true);
    expect(stack.canRedo()).toBe(false);
  });

  it("undo reverses the last command and enables redo", () => {
    const model = stubModel();
    const stack = new CommandStack(model);
    const cmd = setPitch(0, p("C", 4), p("D", 4));
    stack.push(cmd);
    const undone = stack.undo();
    expect(undone).toBe(cmd);
    expect(model.pitches.get(0)).toEqual(p("C", 4));
    expect(stack.canUndo()).toBe(false);
    expect(stack.canRedo()).toBe(true);
  });

  it("redo re-applies the undone command", () => {
    const model = stubModel();
    const stack = new CommandStack(model);
    stack.push(setPitch(0, p("C", 4), p("E", 4)));
    stack.undo();
    const redone = stack.redo();
    expect(redone).not.toBeNull();
    expect(model.pitches.get(0)).toEqual(p("E", 4));
    expect(stack.canUndo()).toBe(true);
    expect(stack.canRedo()).toBe(false);
  });

  it("a new push after an undo clears the redo branch", () => {
    const model = stubModel();
    const stack = new CommandStack(model);
    stack.push(setPitch(0, p("C", 4), p("D", 4)));
    stack.undo();
    expect(stack.canRedo()).toBe(true);
    stack.push(setPitch(0, p("C", 4), p("E", 4)));
    expect(stack.canRedo()).toBe(false); // the redo future was abandoned
    expect(model.pitches.get(0)).toEqual(p("E", 4));
  });

  it("undoes and redoes a multi-step sequence in LIFO order", () => {
    const model = stubModel();
    const stack = new CommandStack(model);
    stack.push(setPitch(0, p("C", 4), p("D", 4)));
    stack.push(setPitch(0, p("D", 4), p("E", 4)));
    stack.push(setPitch(0, p("E", 4), p("F", 4)));
    expect(model.pitches.get(0)).toEqual(p("F", 4));
    stack.undo();
    expect(model.pitches.get(0)).toEqual(p("E", 4));
    stack.undo();
    expect(model.pitches.get(0)).toEqual(p("D", 4));
    stack.redo();
    expect(model.pitches.get(0)).toEqual(p("E", 4));
  });

  it("pushApplied records a live-applied command (drag) without re-applying it", () => {
    const model = stubModel();
    const stack = new CommandStack(model);
    // Simulate a drag: the model was mutated step-by-step during the gesture; the net command is
    // recorded on release WITHOUT applying again (it is already at `after`).
    model.setPitch(0, p("G", 4)); // the live preview left it here
    stack.pushApplied(setPitch(0, p("C", 4), p("G", 4)));
    expect(model.pitches.get(0)).toEqual(p("G", 4)); // not double-applied
    expect(stack.canUndo()).toBe(true);
    stack.undo();
    expect(model.pitches.get(0)).toEqual(p("C", 4)); // undo still reverses the whole gesture
  });
});

describe("DeleteNoteCommand (apply / invert / stack)", () => {
  it("apply deletes via the model and stashes the record; invert restores from it", () => {
    const model = stubModel();
    const cmd = deleteNote(2);
    applyCommand(model, cmd);
    expect(model.deleted).toEqual([2]); // routed through model.deleteNote
    expect(cmd.record).not.toBeNull(); // the record was captured for undo
    const captured = cmd.record;
    invertCommand(model, cmd);
    expect(model.restored).toEqual([captured]); // restoreNote got the captured record
  });

  it("push applies a delete and undo restores it (round-trip through the stack)", () => {
    const model = stubModel();
    const stack = new CommandStack(model);
    stack.push(deleteNote(1));
    expect(model.deleted).toEqual([1]);
    expect(stack.canUndo()).toBe(true);
    stack.undo();
    expect(model.restored.length).toBe(1); // the note was restored on undo
    expect(stack.canRedo()).toBe(true);
  });

  it("redo re-deletes, re-deriving a fresh record (deletion is deterministic)", () => {
    const model = stubModel();
    const stack = new CommandStack(model);
    const cmd = deleteNote(0);
    stack.push(cmd);
    const recordAfterPush = cmd.record;
    stack.undo();
    stack.redo();
    expect(model.deleted).toEqual([0, 0]); // deleted on push AND on redo
    // apply() always re-runs model.deleteNote, so redo captures a FRESH record object.
    expect(cmd.record).not.toBeNull();
    expect(cmd.record).not.toBe(recordAfterPush); // a new record, not the stale one
  });

  it("a delete then a pitch edit, both undone in LIFO order, route to the right model calls", () => {
    const model = stubModel();
    const stack = new CommandStack(model);
    stack.push(setPitch(5, p("C", 4), p("D", 4)));
    stack.push(deleteNote(3));
    expect(model.pitches.get(5)).toEqual(p("D", 4));
    expect(model.deleted).toEqual([3]);
    stack.undo(); // undoes the delete first
    expect(model.restored.length).toBe(1);
    stack.undo(); // then the pitch edit
    expect(model.pitches.get(5)).toEqual(p("C", 4));
  });
});
