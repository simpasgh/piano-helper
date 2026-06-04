import type { OpenSheetMusicDisplay } from "opensheetmusicdisplay";
import {
  planSystemBoxes,
  type SystemBoxPlan,
} from "./streaming-loader";

// DOM/OSMD glue for the OMR streaming "recognition scan-line" loader (design.md STREAM-1..STREAM-5).
// The pure state/box-plan math lives in streaming-loader.ts; the box-clustering math is the exported
// pure helper groupSystemsByY below. This file walks the rendered OSMD SVG, reads each system's
// bounding box (in the scrolled #sheet pixel basis, exactly like sheet-overlay.readNotePositions),
// and writes one absolutely-positioned box per system into a single overlay div inside #sheet, each
// marked data-state="done|active|pending". The motion is pure CSS lifted from
// docs/design/streaming-loader-demo.html; the only per-frame JS is flipping data-state as systems
// finalize. No em dashes (project rule).
//
// Why cluster noteheads instead of reading <g class="system">: the streaming render uses OSMD, whose
// SVG (VexFlow) emits NO per-system <g class="system"> group (that is a Verovio shape, used only in
// edit mode). So we recover each engraved system's vertical band by grouping the engraved noteheads
// by y, the same pixel basis the note-name overlay already uses, which is renderer-agnostic.

// A notehead's position in the scrolled #sheet content box (pixels). Mirrors sheet-overlay's read.
interface NoteBox {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

// An engraved system's bounding box in the scrolled #sheet content box (pixels).
export interface SystemBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

// The VexFlow note method is not on the public GraphicalNote type; feature-detect it.
interface SvgGettable {
  getSVGGElement?: () => SVGGElement | null;
}

// Read every engraved notehead's box in scrolled #sheet coordinates (identical math to
// sheet-overlay.readNotePositions: viewport rect -> subtract container origin + add scroll).
function readNoteBoxes(
  osmd: OpenSheetMusicDisplay,
  container: HTMLElement,
): NoteBox[] {
  const containerRect = container.getBoundingClientRect();
  const scrollLeft = container.scrollLeft;
  const scrollTop = container.scrollTop;
  const boxes: NoteBox[] = [];

  const graphic = osmd.GraphicSheet;
  if (!graphic) return boxes;

  for (const staffMeasures of graphic.MeasureList ?? []) {
    if (!staffMeasures) continue;
    for (const measure of staffMeasures) {
      if (!measure) continue;
      for (const staffEntry of measure.staffEntries ?? []) {
        for (const voiceEntry of staffEntry.graphicalVoiceEntries ?? []) {
          for (const note of voiceEntry.notes ?? []) {
            const source = note.sourceNote;
            if (!source || source.isRest()) continue;
            const el = (note as unknown as SvgGettable).getSVGGElement?.();
            if (!el) continue;
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 && rect.height === 0) continue;
            boxes.push({
              left: rect.left - containerRect.left + scrollLeft,
              right: rect.right - containerRect.left + scrollLeft,
              top: rect.top - containerRect.top + scrollTop,
              bottom: rect.bottom - containerRect.top + scrollTop,
            });
          }
        }
      }
    }
  }
  return boxes;
}

// Cluster notehead boxes into SYSTEM bands by vertical gaps. A new system starts when a notehead's
// top sits more than `gapThreshold` below the running band's bottom (a system break is a large
// vertical jump; notes within a grand staff overlap or nearly touch in y). PURE + DOM-free so it is
// unit-testable. Boxes need not be pre-sorted. `padY` grows each band a little vertically so the box
// reads like the whole staff-line row, not just the noteheads' extent.
export function groupSystemsByY(
  boxes: NoteBox[],
  gapThreshold: number,
  padY = 0,
): SystemBox[] {
  if (boxes.length === 0) return [];
  const sorted = [...boxes].sort((a, b) => a.top - b.top);
  const bands: NoteBox[] = [];
  let cur: NoteBox = { ...sorted[0] };
  for (let i = 1; i < sorted.length; i++) {
    const b = sorted[i];
    if (b.top > cur.bottom + gapThreshold) {
      bands.push(cur);
      cur = { ...b };
    } else {
      cur.left = Math.min(cur.left, b.left);
      cur.right = Math.max(cur.right, b.right);
      cur.top = Math.min(cur.top, b.top);
      cur.bottom = Math.max(cur.bottom, b.bottom);
    }
  }
  bands.push(cur);
  return bands.map((band) => ({
    left: band.left,
    top: band.top - padY,
    width: Math.max(0, band.right - band.left),
    height: Math.max(0, band.bottom - band.top + 2 * padY),
  }));
}

// Vertical gap (px, scrolled #sheet basis) above which two noteheads belong to different systems.
// A grand staff spans ~60-100px; a system break adds the inter-system margin on top. 40px sits well
// above intra-system overlap and below a real break, at the OSMD engraving size this app renders.
const SYSTEM_GAP_PX = 40;
// Grow each engraved band so the loader box covers the full staff row (ledger lines, the brace).
const SYSTEM_PAD_Y = 8;
// Fixed per-system height for the STACKED (not-yet-engraved) active + pending rows, mirroring the
// demo's 86px system + 26px gap. Used when a system has no engraving to measure (STREAM-5).
export const STACKED_SYSTEM_HEIGHT = 112;

// The geometry the overlay lays a single box out against.
interface BoxLayout {
  left: number;
  top: number;
  width: number;
  height: number;
}

// Resolve every box's pixel geometry from the plan + the engraved system boxes. Engraved boxes use
// their measured band; stacked boxes (active + pending) are placed below the last engraved system at
// a fixed height (STREAM-5). PURE given the engraved boxes + page width. Exported for unit testing.
export function layoutSystemBoxes(
  plan: SystemBoxPlan[],
  engraved: SystemBox[],
  fallbackWidth: number,
  fallbackLeft: number,
): BoxLayout[] {
  // The bottom of the last engraved system is where the stacked rows begin. With nothing engraved
  // yet (the lead-in: zero finished systems), start at the top of the pane.
  const lastEngraved = engraved[engraved.length - 1];
  const stackTop = lastEngraved ? lastEngraved.top + lastEngraved.height : 0;
  // Stacked rows reuse the engraved width/left when we have one (so they line up under the music),
  // else the caller's fallback (the pane content width).
  const stackWidth = lastEngraved ? lastEngraved.width : fallbackWidth;
  const stackLeft = lastEngraved ? lastEngraved.left : fallbackLeft;

  return plan.map((box) => {
    if (box.anchor === "engraved" && engraved[box.index]) {
      const e = engraved[box.index];
      return { left: e.left, top: e.top, width: e.width, height: e.height };
    }
    return {
      left: stackLeft,
      top: stackTop + box.stackOrder * STACKED_SYSTEM_HEIGHT,
      width: stackWidth,
      height: STACKED_SYSTEM_HEIGHT,
    };
  });
}

// Build the inner skeleton/scan DOM for one system box, mirroring the demo's structure so the CSS
// (lifted verbatim) applies: brace + edge barlines + two staves (treble/bass) + per-staff skeleton
// blocks + the scan band. The notes themselves are NOT drawn here (a done system shows the REAL
// engraved noteheads beneath the overlay; the overlay only ever ADDS the loading treatment for
// active/pending and a faint frame for done). pointer-events stay off so the overlay never blocks
// clicks on the engraving.
function buildBoxInner(box: HTMLDivElement): void {
  const brace = document.createElement("div");
  brace.className = "sys-brace";
  box.appendChild(brace);
  for (const side of ["l", "r"] as const) {
    const bl = document.createElement("div");
    bl.className = `sys-barline ${side}`;
    box.appendChild(bl);
  }
  for (const staffName of ["treble", "bass"] as const) {
    const staff = document.createElement("div");
    staff.className = `sys-staff ${staffName}`;
    box.appendChild(staff);
    // Skeleton blocks: note-SHAPED placeholders (rounded brass-brown bars), deliberately block-like
    // so they read as placeholder, never as notes. Spread across the staff like the demo.
    for (let s = 0; s < SKELETON_BLOCKS_PER_STAFF; s++) {
      const skel = document.createElement("div");
      skel.className = `sys-skel ${staffName}`;
      skel.style.left = `${54 + s * 6}%`;
      box.appendChild(skel);
    }
  }
  // The scan beam band (concept A): shown by CSS only on the active box.
  const band = document.createElement("div");
  band.className = "sys-scanband";
  box.appendChild(band);
}

const SKELETON_BLOCKS_PER_STAFF = 7;

// Rebuild the streaming-loader overlay under #sheet for a frontier of (done, total). Reads the
// engraved system boxes, plans done/active/pending, lays each out, and writes the boxes with their
// data-state. Idempotent: re-call on each partial to advance the frontier (boxes that already exist
// are reused so the CSS animation state is not reset; only data-state flips). Pass total=0 / done=0
// (or call clearStreamOverlay) to tear it down.
export function renderStreamOverlay(
  osmd: OpenSheetMusicDisplay,
  container: HTMLElement,
  done: number,
  total: number,
): void {
  let overlay = container.querySelector<HTMLDivElement>("#sheet-stream");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "sheet-stream";
    overlay.setAttribute("aria-hidden", "true"); // decorative; progress is announced via status
    container.appendChild(overlay);
  }

  if (total < 1) {
    clearStreamOverlay(container);
    return;
  }
  overlay.style.display = "";

  const engraved = groupSystemsByY(
    readNoteBoxes(osmd, container),
    SYSTEM_GAP_PX,
    SYSTEM_PAD_Y,
  );
  // The engraved systems ARE the finished ones, but never claim more engraved rows than the frontier
  // says are done (a stray cluster must not steal the active row), nor more than the page has.
  const engravedCount = Math.min(engraved.length, done, total);
  const plan = planSystemBoxes(done, total, engravedCount);
  const layouts = layoutSystemBoxes(
    plan,
    engraved.slice(0, engravedCount),
    Math.max(0, container.clientWidth - 2 * SYSTEM_PAD_Y),
    SYSTEM_PAD_Y,
  );

  // Reuse existing box elements in order so an in-progress CSS animation is not restarted; create or
  // drop the tail as the count changes (it does not here, but be robust to it).
  const existing = Array.from(
    overlay.querySelectorAll<HTMLDivElement>(".sys-box"),
  );
  while (existing.length < plan.length) {
    const box = document.createElement("div");
    box.className = "sys-box";
    buildBoxInner(box);
    overlay.appendChild(box);
    existing.push(box);
  }
  while (existing.length > plan.length) {
    existing.pop()?.remove();
  }

  for (let i = 0; i < plan.length; i++) {
    const box = existing[i];
    const layout = layouts[i];
    box.style.left = `${layout.left}px`;
    box.style.top = `${layout.top}px`;
    box.style.width = `${layout.width}px`;
    box.style.height = `${layout.height}px`;
    // Stagger the skeleton sheen per row so the page ripples rather than pulsing in lockstep (the
    // demo keys this off :nth-child; an inline custom property is robust to box reuse).
    box.style.setProperty("--sys-row", String(i));
    if (box.getAttribute("data-state") !== plan[i].state) {
      box.setAttribute("data-state", plan[i].state);
    }
  }
}

// Hide + empty the streaming overlay (the score is complete, or a non-streaming path took over).
export function clearStreamOverlay(container: HTMLElement): void {
  const overlay = container.querySelector<HTMLDivElement>("#sheet-stream");
  if (!overlay) return;
  overlay.style.display = "none";
  overlay.replaceChildren();
}
