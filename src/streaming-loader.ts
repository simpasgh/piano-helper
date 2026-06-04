// Pure layout/state math for the OMR streaming "recognition scan-line" loader (design.md
// STREAM-1..STREAM-5). The DOM glue (reading engraved system geometry, building the overlay
// elements) lives in sheet-stream-overlay.ts; this file is the testable kind -> state + box-plan
// decision so it cannot silently drift. No DOM, no em dashes (project rule).
//
// The loader shows one box per staff SYSTEM, top to bottom, driven by the stream's frontier:
//   k = systems finalized so far (done), total = the page's system count.
//   indices  0 .. k-1   -> "done"    (real notes already engraved)
//   index    k          -> "active"  (the system being decoded right now: the scan beam)
//   indices  k+1 .. n-1 -> "pending" (empty/skeleton staves, animated; NO fake notes)
// When k == total every system is done (no active, no pending row).

export type SystemBoxState = "done" | "active" | "pending";

// Where a box gets its geometry from:
//   "engraved" -> the box aligns to an engraved system's bounding box (the finished systems that are
//                 actually in the rendered SVG; there are `engravedCount` of them).
//   "stacked"  -> the box has no engraving yet, so it is stacked below the last engraved system at a
//                 fixed per-system height (the active row + all pending rows, per STREAM-5).
export type SystemBoxAnchor = "engraved" | "stacked";

export interface SystemBoxPlan {
  index: number; // 0-based system index, top to bottom
  state: SystemBoxState;
  anchor: SystemBoxAnchor;
  // For a "stacked" box: its position in the stacked run (0 = first stacked row), so the caller can
  // place it at lastEngravedBottom + stackOrder * perSystemHeight. -1 for an engraved box.
  stackOrder: number;
}

// The per-system state from the demo: done before the frontier, active AT it, pending after.
export function systemBoxState(
  index: number,
  done: number,
  total: number,
): SystemBoxState {
  if (index < done) return "done";
  // Once everything is finalized (done == total) there is no active/pending row; clamp so a
  // frontier of (total, total) yields all-done rather than an out-of-range active box.
  if (index === done && done < total) return "active";
  return "pending";
}

// Build the full ordered box plan for a frontier of (done, total) given how many systems are
// actually ENGRAVED in the current SVG (engravedCount). The finished systems are engraved
// (engravedCount should equal `done` in the streaming path, since a partial holds only the finished
// systems); any box at index >= engravedCount is stacked below the last engraved one. Clamps all
// inputs defensively so a bad frontier never produces a negative count or an out-of-range index.
export function planSystemBoxes(
  done: number,
  total: number,
  engravedCount: number,
): SystemBoxPlan[] {
  const n = Math.max(0, Math.floor(total));
  const k = Math.min(Math.max(0, Math.floor(done)), n);
  const engraved = Math.min(Math.max(0, Math.floor(engravedCount)), n);

  const plan: SystemBoxPlan[] = [];
  let stackOrder = 0;
  for (let index = 0; index < n; index++) {
    const state = systemBoxState(index, k, n);
    const anchor: SystemBoxAnchor = index < engraved ? "engraved" : "stacked";
    plan.push({
      index,
      state,
      anchor,
      stackOrder: anchor === "stacked" ? stackOrder++ : -1,
    });
  }
  return plan;
}

// True once the per-system loader should take over the sheet pane from the #86 full-stage overlay:
// the moment the stream has emitted a usable frontier with at least one system. Before that (the
// pre-stream wait, the non-streaming / audio paths) the #86 overlay stays.
export function shouldShowSystemLoader(
  frontier: { total: number; done: number } | null,
): boolean {
  return frontier !== null && frontier.total >= 1;
}
