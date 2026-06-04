import { describe, it, expect } from "vitest";
import {
  timemapStepTimes,
  buildIdToVisNoteIndex,
  buildVisIndexToId,
  notesAtScoreTime,
  parseSvgNoteIds,
  type VerovioNote,
} from "./verovio-view";
import type { TimemapEntry } from "verovio/esm";
import type { VisNote } from "./visualizer";

// Helpers to keep the fixtures terse.
const vis = (over: Partial<VisNote> = {}): VisNote => ({
  midi: 60,
  time: 0,
  duration: 1,
  hand: "right",
  ...over,
});
const vn = (id: string, timeSec: number, midi: number): VerovioNote => ({ id, timeSec, midi });

describe("timemapStepTimes", () => {
  it("returns sorted unique onset times in SECONDS from the ms timemap", () => {
    // Mirrors the spike's clean-step shape (0, 250, 500, ... ms) plus a duplicate tstamp that
    // two notes share at one onset; the de-dup must collapse it to a single step time.
    const timemap: TimemapEntry[] = [
      { tstamp: 0, on: ["a"] },
      { tstamp: 500, on: ["b"] },
      { tstamp: 250, on: ["c"] },
      { tstamp: 500, on: ["d"] }, // same onset as the second entry (a chord member)
      { tstamp: 1000, on: ["e"] },
    ];
    expect(timemapStepTimes(timemap)).toEqual([0, 0.25, 0.5, 1]);
  });

  it("keeps an onset that carries no note ids (e.g. a measure marker)", () => {
    const timemap: TimemapEntry[] = [
      { tstamp: 0, on: ["a"] },
      { tstamp: 2000, measure: "m2" } as TimemapEntry, // measure-only stop, still a cursor step
    ];
    expect(timemapStepTimes(timemap)).toEqual([0, 2]);
  });

  it("ignores entries with a non-numeric tstamp and returns [] for an empty map", () => {
    expect(timemapStepTimes([])).toEqual([]);
    expect(
      timemapStepTimes([{ on: ["a"] } as unknown as TimemapEntry, { tstamp: 333, on: ["b"] }]),
    ).toEqual([0.333]);
  });
});

describe("buildIdToVisNoteIndex", () => {
  it("maps each Verovio note id to the VisNote sharing its pitch and onset", () => {
    // A four-note ascending line: each Verovio note (ms -> s) lines up with one VisNote.
    const visNotes: VisNote[] = [
      vis({ midi: 60, time: 0 }),
      vis({ midi: 62, time: 0.5 }),
      vis({ midi: 64, time: 1 }),
      vis({ midi: 65, time: 1.5 }),
    ];
    const verovio: VerovioNote[] = [
      vn("n1", 0, 60),
      vn("n2", 0.5, 62),
      vn("n3", 1, 64),
      vn("n4", 1.5, 65),
    ];
    const map = buildIdToVisNoteIndex(verovio, visNotes);
    expect(map.get("n1")).toBe(0);
    expect(map.get("n2")).toBe(1);
    expect(map.get("n3")).toBe(2);
    expect(map.get("n4")).toBe(3);
    expect(map.size).toBe(4);
  });

  it("disambiguates chord members by pitch at a shared onset", () => {
    // Three notes of a chord share time 0 but differ in pitch; each id maps to its own VisNote.
    const visNotes: VisNote[] = [
      vis({ midi: 48, time: 0 }),
      vis({ midi: 52, time: 0 }),
      vis({ midi: 55, time: 0 }),
    ];
    const verovio: VerovioNote[] = [vn("c1", 0, 55), vn("c2", 0, 48), vn("c3", 0, 52)];
    const map = buildIdToVisNoteIndex(verovio, visNotes);
    expect(map.get("c2")).toBe(0); // midi 48
    expect(map.get("c3")).toBe(1); // midi 52
    expect(map.get("c1")).toBe(2); // midi 55
  });

  it("does not map a tie continuation segment (folded into the start note in VisNote[])", () => {
    // score.ts merges a tie: the held C4 is ONE VisNote at t=0 spanning two beats. Verovio keeps
    // two segments (start at 0, continuation at 1). Only the start segment shares an onset with a
    // VisNote; the continuation finds no match and is absent from the map (caller falls back to
    // id-only selection).
    const visNotes: VisNote[] = [vis({ midi: 60, time: 0, duration: 2 })];
    const verovio: VerovioNote[] = [vn("tie-start", 0, 60), vn("tie-cont", 1, 60)];
    const map = buildIdToVisNoteIndex(verovio, visNotes);
    expect(map.get("tie-start")).toBe(0);
    expect(map.has("tie-cont")).toBe(false);
    expect(map.size).toBe(1);
  });

  it("tolerates sub-millisecond floating-point drift between the two onset sources", () => {
    // A triplet onset is 1/3 of a beat; ms->s reintroduces tiny rounding. The 1ms key tolerance
    // must still match the VisNote computed independently in score.ts.
    const visNotes: VisNote[] = [vis({ midi: 67, time: 0.3333333 })];
    const verovio: VerovioNote[] = [vn("trip", 0.3334, 67)]; // 333.4 ms rounds to 0.333
    const map = buildIdToVisNoteIndex(verovio, visNotes);
    expect(map.get("trip")).toBe(0);
  });

  it("returns an empty map when nothing lines up", () => {
    const visNotes: VisNote[] = [vis({ midi: 60, time: 0 })];
    const verovio: VerovioNote[] = [vn("x", 5, 99)];
    expect(buildIdToVisNoteIndex(verovio, visNotes).size).toBe(0);
  });
});

describe("buildVisIndexToId", () => {
  it("inverts the id->index map so a canvas selection can find its staff notehead", () => {
    const idToIndex = new Map<string, number>([
      ["n1", 0],
      ["n2", 1],
      ["n3", 2],
    ]);
    const inverse = buildVisIndexToId(idToIndex);
    expect(inverse.get(0)).toBe("n1");
    expect(inverse.get(1)).toBe("n2");
    expect(inverse.get(2)).toBe("n3");
    expect(inverse.size).toBe(3);
  });

  it("first id wins when two ids map to one VisNote index (a unison)", () => {
    // Insertion order is the tie-break, mirroring id->index's first-wins rule.
    const idToIndex = new Map<string, number>([
      ["first", 4],
      ["second", 4],
    ]);
    const inverse = buildVisIndexToId(idToIndex);
    expect(inverse.get(4)).toBe("first");
    expect(inverse.size).toBe(1);
  });

  it("is empty for an empty map", () => {
    expect(buildVisIndexToId(new Map()).size).toBe(0);
  });
});

describe("notesAtScoreTime", () => {
  // A two-note sequence: note A sounds [0, 1), note B sounds [1, 2). The timemap turns A off and
  // B on at t=1000ms.
  const timemap: TimemapEntry[] = [
    { tstamp: 0, on: ["a"], off: [] },
    { tstamp: 1000, on: ["b"], off: ["a"] },
    { tstamp: 2000, on: [], off: ["b"] },
  ];

  it("returns [] before the first onset", () => {
    expect(notesAtScoreTime(timemap, -0.5)).toEqual([]);
  });

  it("returns the note sounding at the current time", () => {
    expect(notesAtScoreTime(timemap, 0)).toEqual(["a"]);
    expect(notesAtScoreTime(timemap, 0.5)).toEqual(["a"]);
  });

  it("turns the previous note off and the next on at the boundary", () => {
    expect(notesAtScoreTime(timemap, 1)).toEqual(["b"]);
    expect(notesAtScoreTime(timemap, 1.5)).toEqual(["b"]);
  });

  it("returns [] after the last note is turned off", () => {
    expect(notesAtScoreTime(timemap, 2)).toEqual([]);
    expect(notesAtScoreTime(timemap, 10)).toEqual([]);
  });

  it("returns all members of a chord sounding together", () => {
    const chord: TimemapEntry[] = [{ tstamp: 0, on: ["x", "y", "z"], off: [] }];
    expect(notesAtScoreTime(chord, 0).sort()).toEqual(["x", "y", "z"]);
  });
});

describe("parseSvgNoteIds", () => {
  it("pulls the id from every <g class=\"note\"> regardless of attribute order", () => {
    const svg = `<svg>
      <g class="note" id="note-1"><ellipse/></g>
      <g id="note-2" class="note"><ellipse/></g>
      <g class="rest" id="rest-1"></g>
      <g class="note beamed" id="note-3"></g>
    </svg>`;
    expect(parseSvgNoteIds(svg)).toEqual(["note-1", "note-2", "note-3"]);
  });

  it("does not match a class that merely contains 'note' as a substring (e.g. 'notehead')", () => {
    const svg = `<g class="notehead" id="nh-1"></g><g class="note" id="n-1"></g>`;
    expect(parseSvgNoteIds(svg)).toEqual(["n-1"]);
  });

  it("returns [] when there are no note groups", () => {
    expect(parseSvgNoteIds(`<svg><g class="staff" id="s1"></g></svg>`)).toEqual([]);
  });
});
