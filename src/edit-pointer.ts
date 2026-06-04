// Pure pointer-gating for Smart Edit Mode's pitch drag, split out so it is unit-testable without
// booting main.ts (which pulls in Tone/OSMD/canvas). A pointerdown should BEGIN a pitch drag only
// for the PRIMARY pointer's LEFT button on a mouse/pen; a right-click, a middle-click, a secondary
// touch point, or a touch (which must scroll the lane / tap-select, never hijack into a drag) all
// fail this gate. A plain primary left click still SELECTS (the caller selects before this gate);
// this only decides whether the press also arms a drag.
//
// Takes just the three PointerEvent fields it needs so the test passes plain objects.
export function shouldStartPitchDrag(e: {
  button: number;
  isPrimary: boolean;
  pointerType: string;
}): boolean {
  return e.button === 0 && e.isPrimary && e.pointerType !== "touch";
}
