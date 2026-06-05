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
  type SetKeyCommand,
  type SetTimeCommand,
} from "./edit-commands";
import type {
  AddRecord,
  ChangeDurationRecord,
  DeleteRecord,
  ModelPitch,
  ScoreModel,
  SetKeyRecord,
  SetTimeRecord,
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
  durationChanges: { id: number; direction: "shorter" | "longer" | "dot" }[];
  durationRestores: ChangeDurationRecord[];
  keyChanges: number[];
  keyRestores: SetKeyRecord[];
  currentFifths: number;
  timeChanges: { beats: number; beatType: number }[];
  timeRestores: SetTimeRecord[];
  currentTime: { beats: number; beatType: number };
} {
  const pitches = new Map<number, ModelPitch>();
  const deleted: number[] = [];
  const restored: DeleteRecord[] = [];
  const added: { restId: number; pitch: ModelPitch }[] = [];
  const removed: AddRecord[] = [];
  const durationChanges: { id: number; direction: "shorter" | "longer" | "dot" }[] = [];
  const durationRestores: ChangeDurationRecord[] = [];
  const keyChanges: number[] = [];
  const keyRestores: SetKeyRecord[] = [];
  const timeChanges: { beats: number; beatType: number }[] = [];
  const timeRestores: SetTimeRecord[] = [];
  const self = {
    pitches,
    deleted,
    restored,
    added,
    removed,
    durationChanges,
    durationRestores,
    keyChanges,
    keyRestores,
    currentFifths: 0,
    timeChanges,
    timeRestores,
    currentTime: { beats: 4, beatType: 4 },
    handles: [],
    restHandles: [],
    fifthsForHandle: () => 0,
    fifthsForRest: () => 0,
    // MID-PIECE v2 resolvers: the command-stack tests drive START (initial-declaration) edits only, so
    // these constant stubs (measure 1, the stub's current meter, region start 1) are sufficient; the
    // real per-handle resolution is exercised in edit-model.test.ts.
    measureNumberForHandle: () => 1,
    measureNumberForRest: () => 1,
    timeForHandle: () => self.currentTime,
    timeForRest: () => self.currentTime,
    keyRegionStartForHandle: () => 1,
    keyRegionStartForRest: () => 1,
    timeRegionStartForHandle: () => 1,
    timeRegionStartForRest: () => 1,
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
    changeDuration: (
      id: number,
      direction: "shorter" | "longer" | "dot",
    ): ChangeDurationRecord => {
      durationChanges.push({ id, direction });
      // A stub record: the real DOM snapshot is exercised in edit-model.test.ts. `measureEl` is a
      // sentinel; childrenBefore non-empty so it reads as a real (non-no-op) edit.
      return {
        measureEl: { tag: `measure-${id}` } as unknown as Element,
        childrenBefore: [{ tag: "child" } as unknown as Node],
        outcome: "stepped",
        fromName: "quarter",
        toName: direction === "shorter" ? "eighth" : direction === "longer" ? "half" : "dotted quarter",
        dottedSnap: false,
        direction,
        ...(direction === "dot" ? { dotVerb: "lengthen" as const } : {}),
      };
    },
    restoreDuration: (record: ChangeDurationRecord) => {
      durationRestores.push(record);
    },
    dotState: () => ({ dotted: false, canToggle: true }),
    initialFifths: () => self.currentFifths,
    setKeyFifths: (newFifths: number, atMeasure?: number): SetKeyRecord | null => {
      // A no-op when the key is unchanged (mirrors the real model, so a SetKeyCommand with after ==
      // current pushes no real edit). Otherwise record the change + advance the stub's current key. The
      // command tests drive START edits (atMeasure undefined); the stub records it for the assertion.
      if (newFifths === self.currentFifths) return null;
      keyChanges.push(newFifths);
      const old = self.currentFifths;
      self.currentFifths = newFifths;
      return { oldFifths: old, newFifths, measures: [], changedCount: 0, targetMeasure: atMeasure ?? null, removed: false };
    },
    restoreKey: (record: SetKeyRecord) => {
      keyRestores.push(record);
      self.currentFifths = record.oldFifths; // invert: back to the prior key
    },
    initialTime: () => self.currentTime,
    barsNotMatchingMeter: () => 0,
    setTimeSignature: (beats: number, beatType: number, atMeasure?: number): SetTimeRecord | null => {
      // A no-op when the meter is unchanged (mirrors the real model, so a SetTimeCommand with after ==
      // current pushes no real edit). Otherwise record the change + advance the stub's current meter.
      if (beats === self.currentTime.beats && beatType === self.currentTime.beatType) return null;
      timeChanges.push({ beats, beatType });
      const old = self.currentTime;
      self.currentTime = { beats, beatType };
      return {
        oldBeats: old.beats,
        oldBeatType: old.beatType,
        newBeats: beats,
        newBeatType: beatType,
        mismatchedBars: 0,
        targetMeasure: atMeasure ?? null,
        measures: [],
        removed: false,
      };
    },
    restoreTime: (record: SetTimeRecord) => {
      timeRestores.push(record);
      self.currentTime = { beats: record.oldBeats, beatType: record.oldBeatType }; // invert: prior meter
    },
    serialize: () => "",
  };
  return self;
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
  direction: "shorter" | "longer" | "dot",
): ChangeDurationCommand => ({
  kind: "changeDuration",
  handleId,
  direction,
  record: null,
});

const setKey = (before: number, after: number): SetKeyCommand => ({
  kind: "setKey",
  before,
  after,
  record: null,
});

const setTime = (
  before: { beats: number; beatType: number },
  after: { beats: number; beatType: number },
): SetTimeCommand => ({
  kind: "setTime",
  before,
  after,
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

describe("ChangeDurationCommand with the DOT direction (toggle, same apply/invert path)", () => {
  it("apply routes a dot toggle through model.changeDuration; invert restores the record", () => {
    const model = stubModel();
    const cmd = changeDuration(3, "dot");
    applyCommand(model, cmd);
    expect(model.durationChanges).toEqual([{ id: 3, direction: "dot" }]);
    expect(cmd.record).not.toBeNull();
    expect(cmd.record?.direction).toBe("dot");
    const captured = cmd.record;
    invertCommand(model, cmd);
    expect(model.durationRestores).toEqual([captured]); // dot undo flows through restoreDuration
  });

  it("undo/redo a dot toggle round-trips through the stack (re-applying the dot on redo)", () => {
    const model = stubModel();
    const stack = new CommandStack(model);
    stack.push(changeDuration(0, "dot"));
    expect(stack.canUndo()).toBe(true);
    stack.undo();
    expect(model.durationRestores.length).toBe(1);
    stack.redo();
    expect(model.durationChanges).toEqual([
      { id: 0, direction: "dot" },
      { id: 0, direction: "dot" }, // applied on push AND on redo
    ]);
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

describe("SetKeyCommand (apply / invert / stack) - the key-signature edit", () => {
  it("apply rewrites the key via the model and stashes the record; invert restores the prior key", () => {
    const model = stubModel(); // starts at fifths 0 (C major)
    const cmd = setKey(0, 2); // C major -> D major
    applyCommand(model, cmd);
    expect(model.keyChanges).toEqual([2]); // routed through model.setKeyFifths
    expect(model.currentFifths).toBe(2);
    expect(cmd.record).not.toBeNull();
    expect(cmd.record?.oldFifths).toBe(0);
    expect(cmd.record?.newFifths).toBe(2);
    const captured = cmd.record;
    invertCommand(model, cmd);
    expect(model.keyRestores).toEqual([captured]); // restoreKey got the captured record
    expect(model.currentFifths).toBe(0); // back to C major
  });

  it("push applies a key change and undo restores it (round-trip through the stack)", () => {
    const model = stubModel();
    const stack = new CommandStack(model);
    stack.push(setKey(0, -3)); // C major -> E flat major
    expect(model.currentFifths).toBe(-3);
    expect(stack.canUndo()).toBe(true);
    stack.undo();
    expect(model.keyRestores.length).toBe(1);
    expect(model.currentFifths).toBe(0);
    expect(stack.canRedo()).toBe(true);
  });

  it("redo re-applies, re-deriving a fresh record (the rewrite is deterministic)", () => {
    const model = stubModel();
    const stack = new CommandStack(model);
    const cmd = setKey(0, 4); // C major -> E major
    stack.push(cmd);
    const recordAfterPush = cmd.record;
    stack.undo();
    expect(model.currentFifths).toBe(0);
    stack.redo();
    expect(model.currentFifths).toBe(4);
    expect(model.keyChanges).toEqual([4, 4]); // applied on push AND on redo
    expect(cmd.record).not.toBeNull();
    expect(cmd.record).not.toBe(recordAfterPush); // a fresh record, not the stale one
  });

  it("pushApplied records a directly-run key edit without re-applying it (mirrors the orchestrator)", () => {
    // main.ts runs model.setKeyFifths DIRECTLY (so a no-op does not push), then records via
    // pushApplied. The model is already mutated; pushApplied must not run it again.
    const model = stubModel();
    const stack = new CommandStack(model);
    const cmd = setKey(0, 2);
    cmd.record = model.setKeyFifths(cmd.after); // the direct (already-applied) edit
    expect(model.keyChanges).toEqual([2]); // applied ONCE
    expect(model.currentFifths).toBe(2);
    stack.pushApplied(cmd);
    expect(model.keyChanges).toHaveLength(1); // pushApplied did not re-apply
    stack.undo();
    expect(model.currentFifths).toBe(0); // undo still reverses it
  });

  it("a key edit then a pitch edit, both undone in LIFO order, route to the right model calls", () => {
    const model = stubModel();
    const stack = new CommandStack(model);
    stack.push(setKey(0, 1)); // C major -> G major
    stack.push(setPitch(5, p("C", 4), p("D", 4)));
    expect(model.currentFifths).toBe(1);
    expect(model.pitches.get(5)).toEqual(p("D", 4));
    stack.undo(); // undoes the pitch edit first
    expect(model.pitches.get(5)).toEqual(p("C", 4));
    stack.undo(); // then the key edit
    expect(model.currentFifths).toBe(0);
  });
});

describe("SetTimeCommand (apply / invert / stack) - the time-signature edit", () => {
  it("apply rewrites the meter via the model and stashes the record; invert restores the prior meter", () => {
    const model = stubModel(); // starts at 4/4
    const cmd = setTime({ beats: 4, beatType: 4 }, { beats: 3, beatType: 4 }); // 4/4 -> 3/4
    applyCommand(model, cmd);
    expect(model.timeChanges).toEqual([{ beats: 3, beatType: 4 }]); // routed through model.setTimeSignature
    expect(model.currentTime).toEqual({ beats: 3, beatType: 4 });
    expect(cmd.record).not.toBeNull();
    expect(cmd.record?.oldBeats).toBe(4);
    expect(cmd.record?.oldBeatType).toBe(4);
    expect(cmd.record?.newBeats).toBe(3);
    expect(cmd.record?.newBeatType).toBe(4);
    const captured = cmd.record;
    invertCommand(model, cmd);
    expect(model.timeRestores).toEqual([captured]); // restoreTime got the captured record
    expect(model.currentTime).toEqual({ beats: 4, beatType: 4 }); // back to 4/4
  });

  it("push applies a time change and undo restores it (round-trip through the stack)", () => {
    const model = stubModel();
    const stack = new CommandStack(model);
    stack.push(setTime({ beats: 4, beatType: 4 }, { beats: 6, beatType: 8 })); // 4/4 -> 6/8
    expect(model.currentTime).toEqual({ beats: 6, beatType: 8 });
    expect(stack.canUndo()).toBe(true);
    stack.undo();
    expect(model.timeRestores.length).toBe(1);
    expect(model.currentTime).toEqual({ beats: 4, beatType: 4 });
    expect(stack.canRedo()).toBe(true);
  });

  it("redo re-applies, re-deriving a fresh record (the rewrite is deterministic)", () => {
    const model = stubModel();
    const stack = new CommandStack(model);
    const cmd = setTime({ beats: 4, beatType: 4 }, { beats: 2, beatType: 2 }); // 4/4 -> 2/2
    stack.push(cmd);
    const recordAfterPush = cmd.record;
    stack.undo();
    expect(model.currentTime).toEqual({ beats: 4, beatType: 4 });
    stack.redo();
    expect(model.currentTime).toEqual({ beats: 2, beatType: 2 });
    expect(model.timeChanges).toEqual([
      { beats: 2, beatType: 2 },
      { beats: 2, beatType: 2 },
    ]); // applied on push AND on redo
    expect(cmd.record).not.toBeNull();
    expect(cmd.record).not.toBe(recordAfterPush); // a fresh record, not the stale one
  });

  it("pushApplied records a directly-run time edit without re-applying it (mirrors the orchestrator)", () => {
    // main.ts runs model.setTimeSignature DIRECTLY (so a no-op does not push), then records via
    // pushApplied. The model is already mutated; pushApplied must not run it again.
    const model = stubModel();
    const stack = new CommandStack(model);
    const cmd = setTime({ beats: 4, beatType: 4 }, { beats: 3, beatType: 4 });
    cmd.record = model.setTimeSignature(cmd.after.beats, cmd.after.beatType); // the direct (already-applied) edit
    expect(model.timeChanges).toEqual([{ beats: 3, beatType: 4 }]); // applied ONCE
    expect(model.currentTime).toEqual({ beats: 3, beatType: 4 });
    stack.pushApplied(cmd);
    expect(model.timeChanges).toHaveLength(1); // pushApplied did not re-apply
    stack.undo();
    expect(model.currentTime).toEqual({ beats: 4, beatType: 4 }); // undo still reverses it
  });

  it("a time edit then a key edit, both undone in LIFO order, route to the right model calls", () => {
    const model = stubModel();
    const stack = new CommandStack(model);
    stack.push(setTime({ beats: 4, beatType: 4 }, { beats: 3, beatType: 4 })); // 4/4 -> 3/4
    stack.push(setKey(0, 2)); // C major -> D major
    expect(model.currentTime).toEqual({ beats: 3, beatType: 4 });
    expect(model.currentFifths).toBe(2);
    stack.undo(); // undoes the key edit first
    expect(model.currentFifths).toBe(0);
    stack.undo(); // then the time edit
    expect(model.currentTime).toEqual({ beats: 4, beatType: 4 });
  });
});
