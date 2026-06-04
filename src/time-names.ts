// Time-signature naming + presets for Smart Edit Mode SIGNATURE EDITING (SIG-3). Pure, DOM-free, so
// it is unit-testable and shared by the toolbar pill, the popover cells, and the announce strings.
//
// A time signature is a beats/beat-type pair (e.g. 4/4, 6/8). SIG-3 ships a PRESET LIST of 7 meters
// (no free numerator/denominator picker): these cover essentially every real piano score, and the
// edit is DECLARATION-ONLY (rewrite <beats>/<beat-type>, never re-bar). The pill + the announce show
// the meter as a slashed "beats/beat-type"; aria reads it as words ("4 4") so a screen reader does
// not speak "4/4" as a date or fraction. This is the single source the cells, the pill, and the
// announce read, so the meter strings never drift between surfaces.

export interface TimeMeter {
  beats: number; // the numerator, e.g. 4 in 4/4
  beatType: number; // the denominator, e.g. 4 in 4/4
}

// The 7 preset meters (SIG-3, the task's list): common, simple, and compound meters that cover real
// piano scores. A free N/D entry (5/4, 7/8, ...) is the v2 upgrade. The grid renders them in this
// order; the pill + announce read whichever one is current.
export const PRESET_METERS: readonly TimeMeter[] = [
  { beats: 4, beatType: 4 },
  { beats: 3, beatType: 4 },
  { beats: 2, beatType: 4 },
  { beats: 2, beatType: 2 },
  { beats: 6, beatType: 8 },
  { beats: 3, beatType: 8 },
  { beats: 12, beatType: 8 },
];

// The SLASHED label for the pill + the announce, e.g. "4/4". This is the conventional shorthand.
export function meterSlashLabel(beats: number, beatType: number): string {
  return `${beats}/${beatType}`;
}

// The SPOKEN label for aria (no slash, so a screen reader does not say a date/fraction), e.g. "4 4".
// The pill aria-label embeds this ("Time signature: 4 4. Change the time signature.") and each cell's
// aria-label is "{beats} {beat-type} time" (e.g. "3 4 time").
export function meterSpokenLabel(beats: number, beatType: number): string {
  return `${beats} ${beatType}`;
}

// The full spoken name for a popover cell (its aria-label), e.g. "3 4 time".
export function meterCellLabel(beats: number, beatType: number): string {
  return `${meterSpokenLabel(beats, beatType)} time`;
}

// Build ONE time-picker option cell (SIG-3): the meter drawn STACKED (numerator over denominator, the
// engraved look) + the current one carrying aria-selected. beats/beat-type live on data attributes so
// the click applies the right meter; the role/aria-selected match the listbox single-select pattern
// (consistent with the key picker). Pure given a Document, so the toolbar can populate the popover AND
// the DOM test can assert the cell structure (incl. aria-selected) without main.ts's load side effects.
export function buildTimeOptionButton(
  doc: Document,
  beats: number,
  beatType: number,
  selected: boolean,
): HTMLButtonElement {
  const btn = doc.createElement("button");
  btn.type = "button";
  btn.className = "edit-sig-cell";
  btn.dataset.beats = String(beats);
  btn.dataset.beatType = String(beatType);
  btn.setAttribute("role", "option");
  btn.setAttribute("aria-selected", String(selected));
  btn.setAttribute("aria-label", meterCellLabel(beats, beatType));
  // Stacked meter: the numerator above the denominator, the engraved look. A thin rule is not needed
  // (the two stacked numerals read as a meter); the cells sit in a grid. Both numerals are aria-hidden
  // since the cell's aria-label already speaks the meter as words.
  const stack = doc.createElement("span");
  stack.className = "edit-sig-meter";
  stack.setAttribute("aria-hidden", "true");
  const top = doc.createElement("span");
  top.className = "edit-sig-meter-num";
  top.textContent = String(beats);
  const bottom = doc.createElement("span");
  bottom.className = "edit-sig-meter-den";
  bottom.textContent = String(beatType);
  stack.append(top, bottom);
  btn.appendChild(stack);
  return btn;
}
