// Key-signature naming for Smart Edit Mode SIGNATURE EDITING (SIG-4). Pure, DOM-free, so it is
// unit-testable and shared by the toolbar pill, the popover rows, and the announce strings.
//
// A key signature is a <fifths> value (-7..+7) on the circle of fifths: negative = flats, positive =
// sharps, 0 = no accidentals. <fifths> alone does NOT distinguish major from its relative minor (both
// share the same signature), and the OMR only knows the accidental count, so the picker shows BOTH
// names per row and we never write <mode> (MVP edits only <fifths>). The pill + the announce use the
// MAJOR name (the conventional shorthand for "the key with N sharps/flats").

// The 15 keys from 7 flats to 7 sharps, in circle-of-fifths order (flats..natural..sharps). Each entry
// is the <fifths> value with its major + relative-minor names. This is the single source the popover
// list, the pill label, and the announce all read, so the names never drift between surfaces.
export interface KeyName {
  fifths: number;
  major: string; // e.g. "D major"
  minor: string; // the relative minor sharing this signature, e.g. "B minor"
}

export const CIRCLE_OF_FIFTHS: readonly KeyName[] = [
  { fifths: -7, major: "C flat major", minor: "A flat minor" },
  { fifths: -6, major: "G flat major", minor: "E flat minor" },
  { fifths: -5, major: "D flat major", minor: "B flat minor" },
  { fifths: -4, major: "A flat major", minor: "F minor" },
  { fifths: -3, major: "E flat major", minor: "C minor" },
  { fifths: -2, major: "B flat major", minor: "G minor" },
  { fifths: -1, major: "F major", minor: "D minor" },
  { fifths: 0, major: "C major", minor: "A minor" },
  { fifths: 1, major: "G major", minor: "E minor" },
  { fifths: 2, major: "D major", minor: "B minor" },
  { fifths: 3, major: "A major", minor: "F sharp minor" },
  { fifths: 4, major: "E major", minor: "C sharp minor" },
  { fifths: 5, major: "B major", minor: "G sharp minor" },
  { fifths: 6, major: "F sharp major", minor: "D sharp minor" },
  { fifths: 7, major: "C sharp major", minor: "A sharp minor" },
];

// Look up a key by <fifths>, clamped to -7..+7 so an out-of-range value still names something sane.
export function keyForFifths(fifths: number): KeyName {
  const clamped = Math.max(-7, Math.min(7, Math.trunc(fifths)));
  // CIRCLE_OF_FIFTHS index 0 is fifths -7, so the index is fifths + 7.
  return CIRCLE_OF_FIFTHS[clamped + 7];
}

// The MAJOR key name for a signature (the pill label + the announce shorthand), e.g. "C major".
export function keyMajorName(fifths: number): string {
  return keyForFifths(fifths).major;
}

// The accidental-count phrase for a signature: "no sharps or flats" (0), "1 sharp"/"2 sharps" (+),
// "1 flat"/"3 flats" (-). Leads the spoken row label so the count is heard first (SIG-4 rows read
// "2 sharps, D major or B minor").
export function accidentalCountPhrase(fifths: number): string {
  const n = Math.abs(Math.trunc(fifths));
  if (n === 0) return "no sharps or flats";
  const noun = fifths > 0 ? "sharp" : "flat";
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

// The full spoken name for a key row (the option's aria-label + the readable text), e.g.
// "2 sharps, D major or B minor" / "no sharps or flats, C major or A minor". Major then relative minor,
// since a signature does not pick between them and showing both lets the user recognise their key.
export function keyRowLabel(fifths: number): string {
  const k = keyForFifths(fifths);
  return `${accidentalCountPhrase(fifths)}, ${k.major} or ${k.minor}`;
}

// Build ONE key-picker option button (SIG-2): a brass check column (shown only on the current key) +
// the spoken row label, with the fifths on data-fifths and aria-checked tracking the current key. The
// builder is pure given a Document, so the toolbar can populate the popover AND the DOM test can assert
// the option structure (incl. aria-checked) without pulling in main.ts's module-load side effects.
export function buildKeyOptionButton(doc: Document, fifths: number, checked: boolean): HTMLButtonElement {
  const btn = doc.createElement("button");
  btn.type = "button";
  btn.className = "edit-sig-item";
  btn.dataset.fifths = String(fifths);
  btn.setAttribute("role", "menuitemradio");
  btn.setAttribute("aria-checked", String(checked));
  btn.setAttribute("aria-label", keyRowLabel(fifths));
  const svgNs = "http://www.w3.org/2000/svg";
  const check = doc.createElementNS(svgNs, "svg");
  check.setAttribute("class", "edit-sig-check");
  check.setAttribute("viewBox", "0 0 24 24");
  check.setAttribute("width", "16");
  check.setAttribute("height", "16");
  check.setAttribute("fill", "none");
  check.setAttribute("stroke", "currentColor");
  check.setAttribute("stroke-width", "2.4");
  check.setAttribute("stroke-linecap", "round");
  check.setAttribute("stroke-linejoin", "round");
  check.setAttribute("aria-hidden", "true");
  const tick = doc.createElementNS(svgNs, "path");
  tick.setAttribute("d", "M5 13l4 4L19 7");
  check.appendChild(tick);
  const text = doc.createElement("span");
  text.className = "edit-sig-item-text";
  text.textContent = keyRowLabel(fifths);
  btn.append(check, text);
  return btn;
}
