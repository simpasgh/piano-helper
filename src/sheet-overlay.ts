import type { OpenSheetMusicDisplay } from "opensheetmusicdisplay";
import { layoutSheetLabels, type NotePosition } from "./sheet-labels";
import type { LabelMode } from "./piano";

// DOM/OSMD glue for the sheet note-name overlay (issue #17). The pure stacking
// and density math lives in sheet-labels.ts; this file only walks the rendered
// OSMD SVG, reads each notehead's bounding box, and writes positioned label
// elements into a single overlay div inside the scrolled #sheet container.
//
// How positions are read: after osmd.render() each VexFlow GraphicalNote exposes
// getSVGGElement() (the rendered <g> for the notehead). We take its
// getBoundingClientRect() (viewport coords) and convert into the #sheet content
// box: subtract the container's client rect origin and add scrollLeft/scrollTop.
// Because the overlay is absolutely positioned inside the same scrolled box, the
// layer scrolls natively with the SVG, so no scroll handler is needed; only a
// re-render or resize (which moves noteheads) requires recomputing positions.

// The VexFlow note method is not on the public GraphicalNote type, so we
// feature-detect it through a narrow structural cast.
interface SvgGettable {
  getSVGGElement?: () => SVGGElement | null;
}

function readNotePositions(
  osmd: OpenSheetMusicDisplay,
  container: HTMLElement,
): NotePosition[] {
  const containerRect = container.getBoundingClientRect();
  const scrollLeft = container.scrollLeft;
  const scrollTop = container.scrollTop;
  const positions: NotePosition[] = [];

  const graphic = osmd.GraphicSheet;
  if (!graphic) return positions;

  // MeasureList is indexed [staffLineIndex][measureIndex]; some cells can be
  // undefined for multi-staff layouts, so guard each level.
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
            if (!el) continue; // skip notes with no rendered element
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 && rect.height === 0) continue;
            const x = rect.left - containerRect.left + scrollLeft + rect.width / 2;
            const y = rect.top - containerRect.top + scrollTop;
            positions.push({ midi: source.halfTone + 12, x, y });
          }
        }
      }
    }
  }
  return positions;
}

// Rebuild the overlay div under #sheet from the current OSMD render. Off mode
// clears and hides the overlay. Safe to call repeatedly (idempotent).
export function renderSheetLabels(
  osmd: OpenSheetMusicDisplay,
  container: HTMLElement,
  mode: LabelMode,
): void {
  let overlay = container.querySelector<HTMLDivElement>("#sheet-labels");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "sheet-labels";
    container.appendChild(overlay);
  }

  if (mode === "off") {
    overlay.style.display = "none";
    overlay.replaceChildren();
    return;
  }
  overlay.style.display = "";

  const positions = readNotePositions(osmd, container);
  const items = layoutSheetLabels(positions, mode);

  const frag = document.createDocumentFragment();
  for (const item of items) {
    const span = document.createElement("span");
    span.className = "sheet-label";
    span.textContent = item.text;
    span.style.left = `${item.x}px`;
    span.style.top = `${item.y}px`;
    frag.appendChild(span);
  }
  overlay.replaceChildren(frag);
}
