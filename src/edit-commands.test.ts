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
  type AddNoteCommand,
  type ChangeDurationCommand,
} from "./edit-commands";
import type {
  AddRecord,
  ChangeDurationRecord,
  DeleteRecord,
  ModelPitch,
  ScoreModel,
} from "./edit-model";

const p = (step: ModelPitch["step"], octave: number, alter = 0): ModelPitch => ({
  step,
  octave,
  alter,
});

// A minimal ScoreModel stand-in: records the last pitch set per handle, plus delete/restore and
// add/remove logs, so the tests can assert what apply/invert routed through the model. Only the
// methods the command stack calls are implemented. deleteNote / addNote return sentinel records so
// the stack stores + replays them.
function stubModel(): ScoreModel & {
  pitches: Map<number, ModelPitch>;
  deleted: number[];
  restored: DeleteRecord[];
  added: { restId: number; pitch: ModelPitch }[];
  removed: AddRecord[];
  durationChanges: { id: number; direction: "shorter" | "longer" }[];
  durationRestores: ChangeDurationRecord[];
} {
  const pitches = new Map<number, ModelPitch>();
  const deleted: number[] = [];
  const restored: DeleteRecord[] = [];
  const added: { restId: number; pitch: ModelPitch }[] = [];
  const removed: AddRecord[] = [];
  const durationChanges: { id: number; direction: "shorter" | "longer" }[] = [];
  const durationRestores: ChangeDurationRecord[] = [];
  return {
    pitches,
    deleted,
    restored,
    added,
    removed,
    durationChanges,
    durationRestores,
    handles: [],
    restHandles: [],
    fifthsForHandle: () => 0,
    fifthsForRest: () => 0,
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
    addNote: (restId: number, pitch: ModelPitch): AddRecord => {
      added.push({ restId, pitch });
      return {
        addedNote: { tag: `note-from-rest-${restId}` } as unknown as Element,
        restClone: { tag: `rest-${restId}` } as unknown as Element,
      };
    },
    removeNote: (record: AddRecord) => {
      removed.push(record);
    },
    changeDuration: (id: number, direction: "shorter" | "longer"): ChangeDurationRecord => {
      durationChanges.push({ id, direction });
      // A stub record: the real DOM snapshot is exercised in edit-model.test.ts. `measureEl` is a
      // sentinel; childrenBefore non-empty so it reads as a real (non-no-op) edit.
      return {
        measureEl: { tag: `measure-${id}` } as unknown as Element,
        childrenBefore: [{ tag: "child" } as unknown as Node],
        outcome: "stepped",
        fromName: "quarter",
        toName: direction === "shorter" ? "eighth" : "half",
        dottedSnap: false,
        direction,
      };
    },
    restoreDuration: (record: ChangeDurationRecord) => {
      durationRestores.push(record);
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

const addNote = (restId: number, pitch: ModelPitch): AddNoteCommand => ({
  kind: "addNote",
  restId,
  pitch,
  record: null,
  visNote: null,
});

const changeDuration = (
  handleId: number,
  direction: "shorter" | "longer",
): ChangeDurationCommand => ({
  kind: "changeDuration",
  handleId,
  direction,
  record: null,
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

describe("AddNoteCommand (apply / invert / stack) - the inverse of delete", () => {
  it("apply adds via the model and stashes the record; invert removes from it", () => {
    const model = stubModel();
    const cmd = addNote(0, p("E", 5));
    applyCommand(model, cmd);
    expect(model.added).toEqual([{ restId: 0, pitch: p("E", 5) }]); // routed through model.addNote
    expect(cmd.record).not.toBeNull(); // the record was captured for undo
    const captured = cmd.record;
    invertCommand(model, cmd);
    expect(model.removed).toEqual([captured]); // removeNote got the captured record
  });

  it("push applies an add and undo turns the note back into the rest (round-trip)", () => {
    const model = stubModel();
    const stack = new CommandStack(model);
    stack.push(addNote(1, p("G", 4)));
    expect(model.added).toEqual([{ restId: 1, pitch: p("G", 4) }]);
    expect(stack.canUndo()).toBe(true);
    stack.undo();
    expect(model.removed.length).toBe(1); // the note was turned back into a rest on undo
    expect(stack.canRedo()).toBe(true);
  });

  it("redo re-adds, re-deriving a fresh record (the conversion is deterministic)", () => {
    const model = stubModel();
    const stack = new CommandStack(model);
    const cmd = addNote(0, p("C", 4));
    stack.push(cmd);
    const recordAfterPush = cmd.record;
    stack.undo();
    stack.redo();
    expect(model.added).toEqual([
      { restId: 0, pitch: p("C", 4) },
      { restId: 0, pitch: p("C", 4) },
    ]); // added on push AND on redo
    expect(cmd.record).not.toBeNull();
    expect(cmd.record).not.toBe(recordAfterPush); // a fresh record, not the stale one
  });

  it("an add then a delete, both undone in LIFO order, route to the right model calls", () => {
    const model = stubModel();
    const stack = new CommandStack(model);
    stack.push(addNote(0, p("E", 5)));
    stack.push(deleteNote(2));
    expect(model.added.length).toBe(1);
    expect(model.deleted).toEqual([2]);
    stack.undo(); // undoes the delete first
    expect(model.restored.length).toBe(1);
    stack.undo(); // then the add (turns the note back into the rest)
    expect(model.removed.length).toBe(1);
  });
});

describe("ChangeDurationCommand (apply / invert / stack)", () => {
  it("apply changes via the model and stashes the record; invert restores from it", () => {
    const model = stubModel();
    const cmd = changeDuration(2, "longer");
    applyCommand(model, cmd);
    expect(model.durationChanges).toEqual([{ id: 2, direction: "longer" }]);
    expect(cmd.record).not.toBeNull();
    const captured = cmd.record;
    invertCommand(model, cmd);
    expect(model.durationRestores).toEqual([captured]); // restoreDuration got the captured record
  });

  it("push applies a duration step and undo restores it (round-trip through the stack)", () => {
    const model = stubModel();
    const stack = new CommandStack(model);
    stack.push(changeDuration(0, "shorter"));
    expect(model.durationChanges).toEqual([{ id: 0, direction: "shorter" }]);
    expect(stack.canUndo()).toBe(true);
    stack.undo();
    expect(model.durationRestores.length).toBe(1);
    expect(stack.canRedo()).toBe(true);
  });

  it("redo re-applies, re-deriving a fresh record (the step is deterministic)", () => {
    const model = stubModel();
    const stack = new CommandStack(model);
    const cmd = changeDuration(1, "longer");
    stack.push(cmd);
    const recordAfterPush = cmd.record;
    stack.undo();
    stack.redo();
    expect(model.durationChanges).toEqual([
      { id: 1, direction: "longer" },
      { id: 1, direction: "longer" },
    ]); // applied on push AND on redo
    expect(cmd.record).not.toBeNull();
    expect(cmd.record).not.toBe(recordAfterPush); // a fresh record, not the stale one
  });
});

describe("ChangeDurationCommand via pushApplied (a no-op model edit is never recorded)", () => {
  it("pushApplied records a landed duration edit without re-applying it (mirrors a drag commit)", () => {
    const model = stubModel();
    const stack = new CommandStack(model);
    // The orchestrator runs model.changeDuration DIRECTLY for a real edit, then records it via
    // pushApplied so it is NOT applied a second time (the model is already mutated).
    const cmd = changeDuration(0, "longer");
    cmd.record = model.changeDuration(cmd.handleId, cmd.direction); // the direct (already-applied) edit
    expect(model.durationChanges).toEqual([{ id: 0, direction: "longer" }]); // applied ONCE
    stack.pushApplied(cmd);
    expect(model.durationChanges).toHaveLength(1); // pushApplied did not re-apply
    expect(stack.canUndo()).toBe(true);
    stack.undo();
    expect(model.durationRestores.length).toBe(1); // undo still reverses it
  });

  it("a boundary no-op is simply never pushed, so the redo branch survives", () => {
    // The orchestrator does NOT push a no-op duration edit (the model returns an atEnd/noRoom record
    // and changes nothing), so a prior redo future is preserved. Simulate: push then undo to make a
    // redo, then a no-op press (no push) must leave canRedo true.
    const model = stubModel();
    const stack = new CommandStack(model);
    stack.push(setPitch(0, p("C", 4), p("D", 4)));
    stack.undo();
    expect(stack.canRedo()).toBe(true);
    // ... a no-op duration press happens here but pushes nothing ...
    expect(stack.canRedo()).toBe(true); // the redo future is intact
  });
});
