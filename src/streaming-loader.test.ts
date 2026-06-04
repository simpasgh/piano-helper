import { describe, it, expect } from "vitest";
import {
  systemBoxState,
  planSystemBoxes,
  shouldShowSystemLoader,
} from "./streaming-loader";

describe("systemBoxState", () => {
  it("marks systems before the frontier done, AT it active, after it pending", () => {
    // 6 systems, 2 finalized: 0,1 done; 2 active; 3,4,5 pending (mirrors the demo's logic).
    const states = Array.from({ length: 6 }, (_, i) => systemBoxState(i, 2, 6));
    expect(states).toEqual([
      "done",
      "done",
      "active",
      "pending",
      "pending",
      "pending",
    ]);
  });

  it("has no active row once every system is finalized (done == total)", () => {
    const states = Array.from({ length: 3 }, (_, i) => systemBoxState(i, 3, 3));
    expect(states).toEqual(["done", "done", "done"]);
  });

  it("makes system 0 active during the lead-in (nothing finalized yet)", () => {
    const states = Array.from({ length: 3 }, (_, i) => systemBoxState(i, 0, 3));
    expect(states).toEqual(["active", "pending", "pending"]);
  });
});

describe("planSystemBoxes", () => {
  it("anchors the finished (engraved) systems and stacks active + pending", () => {
    // 4 systems, 2 done, 2 engraved (the finished ones are in the SVG).
    const plan = planSystemBoxes(2, 4, 2);
    expect(plan.map((b) => b.state)).toEqual([
      "done",
      "done",
      "active",
      "pending",
    ]);
    expect(plan.map((b) => b.anchor)).toEqual([
      "engraved",
      "engraved",
      "stacked",
      "stacked",
    ]);
    // The two stacked rows get sequential stack orders; engraved rows get -1.
    expect(plan.map((b) => b.stackOrder)).toEqual([-1, -1, 0, 1]);
  });

  it("stacks every row during the lead-in (nothing engraved yet)", () => {
    const plan = planSystemBoxes(0, 3, 0);
    expect(plan.map((b) => b.anchor)).toEqual(["stacked", "stacked", "stacked"]);
    expect(plan.map((b) => b.state)).toEqual(["active", "pending", "pending"]);
    expect(plan.map((b) => b.stackOrder)).toEqual([0, 1, 2]);
  });

  it("anchors all rows when every system is engraved (complete)", () => {
    const plan = planSystemBoxes(3, 3, 3);
    expect(plan.map((b) => b.anchor)).toEqual([
      "engraved",
      "engraved",
      "engraved",
    ]);
    expect(plan.map((b) => b.state)).toEqual(["done", "done", "done"]);
  });

  it("clamps a frontier that claims more done/engraved than total", () => {
    // done 9, engraved 9 of a 3-system page: clamp to 3 done, 3 engraved (all done, all engraved).
    const plan = planSystemBoxes(9, 3, 9);
    expect(plan).toHaveLength(3);
    expect(plan.every((b) => b.state === "done")).toBe(true);
    expect(plan.every((b) => b.anchor === "engraved")).toBe(true);
  });

  it("never claims more engraved rows than done (a stray cluster cannot steal the active row)", () => {
    // 4 systems, only 1 done, but 3 engraved boxes were measured: cap engraved at done so the
    // caller passes engraved.slice(0, engravedCount). Here engravedCount=3 is given by the caller,
    // but the active row (index 1) must still be stacked, not engraved.
    const plan = planSystemBoxes(1, 4, 1);
    expect(plan[0].anchor).toBe("engraved"); // the one finished system
    expect(plan[1]).toMatchObject({ state: "active", anchor: "stacked" });
  });

  it("returns an empty plan for a zero-system page", () => {
    expect(planSystemBoxes(0, 0, 0)).toEqual([]);
  });
});

describe("shouldShowSystemLoader", () => {
  it("is true once a usable frontier with at least one system arrives", () => {
    expect(shouldShowSystemLoader({ total: 6, done: 0 })).toBe(true);
    expect(shouldShowSystemLoader({ total: 1, done: 1 })).toBe(true);
  });

  it("is false with no frontier (pre-stream / non-streaming paths)", () => {
    expect(shouldShowSystemLoader(null)).toBe(false);
  });

  it("is false for a degenerate zero-system frontier", () => {
    expect(shouldShowSystemLoader({ total: 0, done: 0 })).toBe(false);
  });
});
