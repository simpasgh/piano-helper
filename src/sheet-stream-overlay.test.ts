// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import {
  groupSystemsByY,
  layoutSystemBoxes,
  renderStreamOverlay,
  clearStreamOverlay,
  STACKED_SYSTEM_HEIGHT,
  type SystemBox,
} from "./sheet-stream-overlay";
import { planSystemBoxes } from "./streaming-loader";
import type { OpenSheetMusicDisplay } from "opensheetmusicdisplay";

// A stub OSMD with no engraved notes (GraphicSheet empty), so readNoteBoxes finds nothing and every
// row stacks. jsdom's getBoundingClientRect returns zeros anyway, so the DOM tests exercise the
// box-state mapping + element structure, not pixel geometry (the pixel math is covered by the pure
// layoutSystemBoxes tests above).
const stubOsmd = { GraphicSheet: { MeasureList: [] } } as unknown as OpenSheetMusicDisplay;

function makeSheet(): HTMLElement {
  const el = document.createElement("div");
  document.body.appendChild(el);
  return el;
}

afterEach(() => {
  document.body.replaceChildren();
});

// A notehead box in the scrolled #sheet pixel basis (left/right/top/bottom).
const nb = (left: number, top: number, w = 10, h = 8) => ({
  left,
  right: left + w,
  top,
  bottom: top + h,
});

describe("groupSystemsByY", () => {
  it("clusters noteheads into one band per system by vertical gap", () => {
    // Two systems ~120px apart; within each, notes overlap in y (a grand staff). gap=40.
    const boxes = [
      nb(10, 100),
      nb(40, 105),
      nb(70, 98),
      nb(10, 300), // big jump -> new system
      nb(40, 305),
      nb(70, 302),
    ];
    const systems = groupSystemsByY(boxes, 40);
    expect(systems).toHaveLength(2);
    // First band spans the first three notes' extent.
    expect(systems[0].left).toBe(10);
    expect(systems[0].width).toBe(70); // 80 (right of last) - 10
    expect(systems[0].top).toBe(98);
    expect(systems[1].top).toBe(300);
  });

  it("keeps a grand staff (treble + bass close in y) as ONE system", () => {
    // Treble notes near y=100, bass notes near y=130: within the 40px gap, so one band.
    const boxes = [nb(10, 100), nb(40, 100), nb(10, 130), nb(40, 132)];
    const systems = groupSystemsByY(boxes, 40);
    expect(systems).toHaveLength(1);
    expect(systems[0].top).toBe(100);
    expect(systems[0].height).toBe(40); // 140 (bottom of y=132 note) - 100
  });

  it("is order-independent (boxes need not be pre-sorted)", () => {
    const a = groupSystemsByY([nb(10, 300), nb(10, 100)], 40);
    const b = groupSystemsByY([nb(10, 100), nb(10, 300)], 40);
    expect(a).toEqual(b);
    expect(a).toHaveLength(2);
  });

  it("pads each band vertically when padY is given", () => {
    const systems = groupSystemsByY([nb(10, 100, 10, 8)], 40, 8);
    // top shifts up by padY, height grows by 2 * padY.
    expect(systems[0].top).toBe(92); // 100 - 8
    expect(systems[0].height).toBe(8 + 16); // (108 - 100) + 2*8
  });

  it("returns no bands for an empty input", () => {
    expect(groupSystemsByY([], 40)).toEqual([]);
  });
});

describe("layoutSystemBoxes", () => {
  const engraved: SystemBox[] = [
    { left: 20, top: 100, width: 600, height: 80 },
    { left: 20, top: 220, width: 600, height: 80 },
  ];

  it("places engraved rows at their measured boxes and stacks the rest below the last", () => {
    // 4 systems, 2 done + engraved, so rows 2 (active) and 3 (pending) stack below row 1.
    const plan = planSystemBoxes(2, 4, 2);
    const layouts = layoutSystemBoxes(plan, engraved, 640, 8);

    // Engraved rows take their measured geometry verbatim.
    expect(layouts[0]).toEqual({ left: 20, top: 100, width: 600, height: 80 });
    expect(layouts[1]).toEqual({ left: 20, top: 220, width: 600, height: 80 });

    // Stacked rows begin at the bottom of the last engraved system (220 + 80 = 300), each one
    // STACKED_SYSTEM_HEIGHT tall, reusing the engraved left/width so they line up under the music.
    expect(layouts[2]).toEqual({
      left: 20,
      top: 300,
      width: 600,
      height: STACKED_SYSTEM_HEIGHT,
    });
    expect(layouts[3]).toEqual({
      left: 20,
      top: 300 + STACKED_SYSTEM_HEIGHT,
      width: 600,
      height: STACKED_SYSTEM_HEIGHT,
    });
  });

  it("stacks from the top with no engraving (the lead-in), using the fallback width/left", () => {
    const plan = planSystemBoxes(0, 3, 0);
    const layouts = layoutSystemBoxes(plan, [], 640, 8);
    expect(layouts[0]).toEqual({
      left: 8,
      top: 0,
      width: 640,
      height: STACKED_SYSTEM_HEIGHT,
    });
    expect(layouts[1].top).toBe(STACKED_SYSTEM_HEIGHT);
    expect(layouts[2].top).toBe(2 * STACKED_SYSTEM_HEIGHT);
    // All three reuse the fallback geometry.
    expect(layouts.every((l) => l.left === 8 && l.width === 640)).toBe(true);
  });

  it("lays every row at its engraved box when the score is complete", () => {
    const plan = planSystemBoxes(2, 2, 2);
    const layouts = layoutSystemBoxes(plan, engraved, 640, 8);
    expect(layouts).toEqual(engraved.map((e) => ({ ...e })));
  });
});

describe("renderStreamOverlay (DOM)", () => {
  it("draws one box per system with the right data-state from (done, total)", () => {
    const sheet = makeSheet();
    renderStreamOverlay(stubOsmd, sheet, 2, 5); // 5 systems, 2 finalized

    const overlay = sheet.querySelector("#sheet-stream")!;
    const boxes = Array.from(overlay.querySelectorAll(".sys-box"));
    expect(boxes).toHaveLength(5);
    expect(boxes.map((b) => b.getAttribute("data-state"))).toEqual([
      "done",
      "done",
      "active",
      "pending",
      "pending",
    ]);
    // Each box carries the demo's inner structure (staves + skeletons + scan band) so the lifted CSS
    // applies; the overlay is decorative (aria-hidden) and never blocks clicks.
    expect(overlay.getAttribute("aria-hidden")).toBe("true");
    expect(boxes[3].querySelectorAll(".sys-staff")).toHaveLength(2);
    expect(boxes[3].querySelector(".sys-scanband")).not.toBeNull();
    expect(boxes[3].querySelectorAll(".sys-skel").length).toBeGreaterThan(0);
  });

  it("advances data-state in place across partials without recreating boxes (animation continuity)", () => {
    const sheet = makeSheet();
    renderStreamOverlay(stubOsmd, sheet, 1, 4); // system 1 done, 2 active, 3+4 pending
    const overlay = sheet.querySelector("#sheet-stream")!;
    const firstBoxes = Array.from(overlay.querySelectorAll(".sys-box"));

    renderStreamOverlay(stubOsmd, sheet, 2, 4); // system 2 now done, 3 active
    const secondBoxes = Array.from(overlay.querySelectorAll(".sys-box"));

    // SAME element instances are reused (so an in-flight CSS animation is not restarted).
    expect(secondBoxes).toHaveLength(4);
    secondBoxes.forEach((b, i) => expect(b).toBe(firstBoxes[i]));
    expect(secondBoxes.map((b) => b.getAttribute("data-state"))).toEqual([
      "done",
      "done",
      "active",
      "pending",
    ]);
  });

  it("clears the overlay when the frontier has zero systems", () => {
    const sheet = makeSheet();
    renderStreamOverlay(stubOsmd, sheet, 0, 3);
    expect(sheet.querySelectorAll(".sys-box").length).toBe(3);
    renderStreamOverlay(stubOsmd, sheet, 0, 0); // total < 1 tears it down
    expect(sheet.querySelectorAll(".sys-box").length).toBe(0);
  });

  it("clearStreamOverlay hides and empties the overlay", () => {
    const sheet = makeSheet();
    renderStreamOverlay(stubOsmd, sheet, 1, 3);
    clearStreamOverlay(sheet);
    const overlay = sheet.querySelector<HTMLElement>("#sheet-stream")!;
    expect(overlay.querySelectorAll(".sys-box").length).toBe(0);
    expect(overlay.style.display).toBe("none");
  });
});
