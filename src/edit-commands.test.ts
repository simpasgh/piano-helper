// Unit tests for the invertible command stack (Smart Edit Mode P1, undo/redo). These use a tiny
// in-memory model stub (just a pitch per handle) so the stack logic is isolated from the DOM:
// the real ScoreModel's setPitch is exercised in edit-model.test.ts.

import { describe, it, expect } from "vitest";
import { CommandStack, applyCommand, invertCommand, type SetPitchCommand } from "./edit-commands";
import type { ModelPitch, ScoreModel } from "./edit-model";

const p = (step: ModelPitch["step"], octave: number, alter = 0): ModelPitch => ({
  step,
  octave,
  alter,
});

// A minimal ScoreModel stand-in: records the last pitch set per handle so the tests can assert
// what apply/invert wrote. Only the methods the command stack calls are implemented.
function stubModel(): ScoreModel & { pitches: Map<number, ModelPitch> } {
  const pitches = new Map<number, ModelPitch>();
  return {
    pitches,
    handles: [],
    fifthsForHandle: () => 0,
    setPitch: (id: number, pitch: ModelPitch) => {
      pitches.set(id, pitch);
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
