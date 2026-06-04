// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeAll } from "vitest";
import { CIRCLE_OF_FIFTHS, buildKeyOptionButton, keyRowLabel } from "./key-names";

// Regression for the LARGE-score edit-toolbar disappearance (root-caused in a browser on the
// user's 185-note reverie): #edit-toolbar used to be nested INSIDE #sheet. OSMD owns #sheet and an
// osmd.load/render (e.g. an autoResize-triggered re-render fired around entering edit mode on a
// tall score) clears/detaches #sheet's children. #verovio-host survives only because renderVerovio
// re-appends it every render; nothing re-attached the STATIC #edit-toolbar, so on a large score it
// was detached and `editToolbar.hidden = false` then acted on an orphaned node and the buttons
// never appeared. The small bundled demo never triggered that re-render, so its toolbar survived
// and every demo test passed.
//
// The fix moves #edit-toolbar OUT of #sheet into a #sheet-pane wrapper, so it is a sibling of
// #sheet that OSMD can never touch. These tests parse the REAL index.html into a DOM and assert
// that structural invariant directly (contains() over the real tree), so a regression that moves
// the toolbar back inside #sheet fails here.

// Read the real index.html from the project root. Under the jsdom environment import.meta.url is
// not a file: URL, so resolve from process.cwd() (the test runner's root), as the integration
// tests do for their fixtures.
const html = readFileSync(join(process.cwd(), "index.html"), "utf8");

let doc: Document;
let sheet: HTMLElement;
let sheetPane: HTMLElement;
let editToolbar: HTMLElement;
let verovioHost: HTMLElement | null;

beforeAll(() => {
  doc = new DOMParser().parseFromString(html, "text/html");
  sheet = doc.getElementById("sheet") as HTMLElement;
  sheetPane = doc.getElementById("sheet-pane") as HTMLElement;
  editToolbar = doc.getElementById("edit-toolbar") as HTMLElement;
  verovioHost = doc.getElementById("verovio-host"); // not in static HTML; created at runtime
});

describe("edit toolbar lives OUTSIDE the OSMD-owned #sheet", () => {
  it("has both #sheet and #edit-toolbar in the markup", () => {
    expect(sheet).not.toBeNull();
    expect(editToolbar).not.toBeNull();
  });

  it("does NOT nest #edit-toolbar inside #sheet (OSMD cannot detach it)", () => {
    // The whole point of the fix: OSMD clears #sheet's children, so the toolbar must not be one.
    expect(sheet.contains(editToolbar)).toBe(false);
  });

  it("keeps #edit-toolbar inside the #sheet-pane wrapper (still docked over the sheet)", () => {
    expect(sheetPane).not.toBeNull();
    expect(sheetPane.contains(editToolbar)).toBe(true);
    // And #sheet is also inside the wrapper, so the toolbar stays anchored to the same pane.
    expect(sheetPane.contains(sheet)).toBe(true);
  });

  it("docks the toolbar ABOVE the sheet (first child of the wrapper, before #sheet)", () => {
    // A docked-at-top look needs the toolbar to come before #sheet in document order within the
    // wrapper, so the staff scrolls beneath it.
    const children = Array.from(sheetPane.children);
    expect(children.indexOf(editToolbar)).toBeLessThan(children.indexOf(sheet));
  });

  it("starts hidden so edit-mode OFF is a true no-op", () => {
    expect(editToolbar.hasAttribute("hidden")).toBe(true);
  });

  it("there is no static #verovio-host in the markup (created at runtime, re-appended to #sheet)", () => {
    // Documents that the only element historically trapped inside #sheet was #edit-toolbar; the
    // verovio host is created in main.ts and re-attached to #sheet on every render, so it does not
    // need this fix.
    expect(verovioHost).toBeNull();
  });

  it("keeps the per-selection edit clusters and their button hooks inside the toolbar", () => {
    // The move must carry the whole toolbar subtree, not just the strip. main.ts queries these by
    // id, and they must remain descendants of the (now relocated) toolbar.
    for (const id of [
      "undo-btn",
      "redo-btn",
      "note-edit",
      "pitch-down-btn",
      "pitch-up-btn",
      "dur-shorter-btn",
      "dur-longer-btn",
      "dur-dot-btn",
      "delete-note-btn",
      "add-note",
      "add-note-btn",
      "edit-save-btn",
      "edit-discard-btn",
    ]) {
      const el = doc.getElementById(id);
      expect(el, `#${id} should exist`).not.toBeNull();
      expect(editToolbar.contains(el!), `#${id} should be inside #edit-toolbar`).toBe(true);
    }
  });
});

describe("duration steppers (Smart Edit P3 v1) live in the note cluster, not in #sheet", () => {
  it("both stepper buttons exist INSIDE #note-edit (so the note cluster owns them)", () => {
    const noteEdit = doc.getElementById("note-edit") as HTMLElement;
    const shorter = doc.getElementById("dur-shorter-btn");
    const longer = doc.getElementById("dur-longer-btn");
    expect(shorter, "#dur-shorter-btn should exist").not.toBeNull();
    expect(longer, "#dur-longer-btn should exist").not.toBeNull();
    expect(noteEdit.contains(shorter!), "#dur-shorter-btn inside #note-edit").toBe(true);
    expect(noteEdit.contains(longer!), "#dur-longer-btn inside #note-edit").toBe(true);
  });

  it("are NOT inside #sheet (so an OSMD re-render can never detach them)", () => {
    // Same invariant as the whole toolbar: the steppers must be siblings of #sheet, never children
    // that OSMD's load/render would clear.
    expect(sheet.contains(doc.getElementById("dur-shorter-btn"))).toBe(false);
    expect(sheet.contains(doc.getElementById("dur-longer-btn"))).toBe(false);
  });

  it("start with the right aria-labels (the screen-reader names the steppers)", () => {
    expect(doc.getElementById("dur-shorter-btn")?.getAttribute("aria-label")).toBe("Shorter note");
    expect(doc.getElementById("dur-longer-btn")?.getAttribute("aria-label")).toBe("Longer note");
  });

  it("sit BETWEEN pitch-up and delete in the note cluster (pitch | duration | delete order)", () => {
    const noteEdit = doc.getElementById("note-edit") as HTMLElement;
    const ids = Array.from(noteEdit.querySelectorAll("button")).map((b) => b.id);
    expect(ids.indexOf("dur-shorter-btn")).toBeGreaterThan(ids.indexOf("pitch-up-btn"));
    expect(ids.indexOf("dur-longer-btn")).toBeGreaterThan(ids.indexOf("dur-shorter-btn"));
    expect(ids.indexOf("delete-note-btn")).toBeGreaterThan(ids.indexOf("dur-longer-btn"));
  });
});

describe("dot TOGGLE button (DOTTED v1) lives in the note cluster as a pressed-state toggle", () => {
  it("exists INSIDE #note-edit, not in #sheet (an OSMD re-render can never detach it)", () => {
    const noteEdit = doc.getElementById("note-edit") as HTMLElement;
    const dot = doc.getElementById("dur-dot-btn");
    expect(dot, "#dur-dot-btn should exist").not.toBeNull();
    expect(noteEdit.contains(dot!), "#dur-dot-btn inside #note-edit").toBe(true);
    expect(sheet.contains(dot)).toBe(false);
  });

  it("has the Dotted note aria-label (the screen-reader name)", () => {
    expect(doc.getElementById("dur-dot-btn")?.getAttribute("aria-label")).toBe("Dotted note");
  });

  it("starts as an UNPRESSED toggle (aria-pressed=false: a fresh selection is plain)", () => {
    expect(doc.getElementById("dur-dot-btn")?.getAttribute("aria-pressed")).toBe("false");
  });

  it("sits AFTER longer and BEFORE delete (pitch | shorter | longer | DOT | delete)", () => {
    const noteEdit = doc.getElementById("note-edit") as HTMLElement;
    const ids = Array.from(noteEdit.querySelectorAll("button")).map((b) => b.id);
    expect(ids.indexOf("dur-dot-btn")).toBeGreaterThan(ids.indexOf("dur-longer-btn"));
    expect(ids.indexOf("delete-note-btn")).toBeGreaterThan(ids.indexOf("dur-dot-btn"));
  });
});

describe("Save / Discard commit controls (Smart Edit COMMIT v1) live in the edit toolbar", () => {
  it("has #edit-save-btn and #edit-discard-btn inside #edit-toolbar (not in OSMD's #sheet)", () => {
    const save = doc.getElementById("edit-save-btn");
    const discard = doc.getElementById("edit-discard-btn");
    expect(save, "#edit-save-btn should exist").not.toBeNull();
    expect(discard, "#edit-discard-btn should exist").not.toBeNull();
    expect(editToolbar.contains(save!)).toBe(true);
    expect(editToolbar.contains(discard!)).toBe(true);
    // Same OSMD-cannot-detach invariant as the rest of the toolbar (it is a #sheet sibling).
    expect(sheet.contains(save)).toBe(false);
    expect(sheet.contains(discard)).toBe(false);
  });

  it("groups them in a trailing .edit-commit-group AFTER #add-note (history | selection | commit)", () => {
    const group = editToolbar.querySelector(".edit-commit-group") as HTMLElement;
    expect(group, ".edit-commit-group should exist").not.toBeNull();
    expect(group.contains(doc.getElementById("edit-save-btn"))).toBe(true);
    expect(group.contains(doc.getElementById("edit-discard-btn"))).toBe(true);
    // The commit group comes LAST: after the add-note cluster in document order within the toolbar.
    const kids = Array.from(editToolbar.children);
    const addNote = doc.getElementById("add-note") as HTMLElement;
    expect(kids.indexOf(group)).toBeGreaterThan(kids.indexOf(addNote));
  });

  it("orders Save before Discard", () => {
    const group = editToolbar.querySelector(".edit-commit-group") as HTMLElement;
    const ids = Array.from(group.querySelectorAll("button")).map((b) => b.id);
    expect(ids.indexOf("edit-save-btn")).toBeLessThan(ids.indexOf("edit-discard-btn"));
  });

  it("start disabled + aria-disabled (a fresh edit session is clean, so nothing to commit)", () => {
    // Mirrors the undo/redo dimmed-disabled idiom; main.ts lights them up via reflectCommitButtons
    // once an edit is applied. The STATIC markup must start them off.
    for (const id of ["edit-save-btn", "edit-discard-btn"]) {
      const b = doc.getElementById(id) as HTMLButtonElement;
      expect(b.hasAttribute("disabled"), `#${id} starts disabled`).toBe(true);
      expect(b.getAttribute("aria-disabled"), `#${id} starts aria-disabled`).toBe("true");
    }
  });

  it("carry the expected em-dash-free aria-labels + titles (project style rule)", () => {
    const save = doc.getElementById("edit-save-btn") as HTMLButtonElement;
    const discard = doc.getElementById("edit-discard-btn") as HTMLButtonElement;
    expect(save.getAttribute("aria-label")).toBe("Save edits");
    expect(discard.getAttribute("aria-label")).toBe("Discard edits");
    for (const b of [save, discard]) {
      expect(b.getAttribute("title") ?? "").not.toContain("—");
      expect(b.getAttribute("aria-label") ?? "").not.toContain("—");
    }
  });
});

describe("Key-signature pill (Smart Edit SIGNATURE EDITING, SIG-2) lives in the edit toolbar", () => {
  it("has #key-sig-btn inside #edit-toolbar (not in OSMD's #sheet)", () => {
    const pill = doc.getElementById("key-sig-btn");
    expect(pill, "#key-sig-btn should exist").not.toBeNull();
    expect(editToolbar.contains(pill!)).toBe(true);
    // Same OSMD-cannot-detach invariant as the rest of the toolbar (it is a #sheet sibling).
    expect(sheet.contains(pill)).toBe(false);
  });

  it("sits in a signatures group BETWEEN #add-note and the commit group (history | selection | signatures | commit)", () => {
    const pill = doc.getElementById("key-sig-btn") as HTMLElement;
    const sigGroup = pill.closest(".edit-sig-group") as HTMLElement;
    expect(sigGroup, ".edit-sig-group should wrap the pill").not.toBeNull();
    const kids = Array.from(editToolbar.children);
    const addNote = doc.getElementById("add-note") as HTMLElement;
    const commit = editToolbar.querySelector(".edit-commit-group") as HTMLElement;
    expect(kids.indexOf(sigGroup)).toBeGreaterThan(kids.indexOf(addNote));
    expect(kids.indexOf(sigGroup)).toBeLessThan(kids.indexOf(commit));
  });

  it("is a labeled PILL that opens a dialog popover (aria-haspopup, aria-expanded, aria-controls)", () => {
    const pill = doc.getElementById("key-sig-btn") as HTMLButtonElement;
    expect(pill.getAttribute("aria-haspopup")).toBe("dialog");
    expect(pill.getAttribute("aria-expanded")).toBe("false"); // starts closed
    expect(pill.getAttribute("aria-controls")).toBe("key-sig-menu");
    // The pill carries the brass text variant class + the current key as readable text.
    expect(pill.classList.contains("edit-sig-btn")).toBe(true);
    expect(doc.getElementById("key-sig-label")?.textContent).toBe("C major"); // seeded label
  });

  it("seeds the aria-label as the current key with no em dash (SIG-5 spoken name)", () => {
    const pill = doc.getElementById("key-sig-btn") as HTMLButtonElement;
    expect(pill.getAttribute("aria-label")).toBe("Key signature: C major. Change the key.");
    expect(pill.getAttribute("aria-label") ?? "").not.toContain("—");
    expect(pill.getAttribute("title") ?? "").not.toContain("—");
  });

  it("has an empty popover container (role=dialog, hidden) anchored in the signatures wrap", () => {
    const menu = doc.getElementById("key-sig-menu") as HTMLElement;
    expect(menu, "#key-sig-menu should exist").not.toBeNull();
    expect(menu.getAttribute("role")).toBe("dialog");
    expect(menu.hasAttribute("hidden")).toBe(true);
    expect(menu.children.length).toBe(0); // rows are built at runtime in main.ts
    expect(sheet.contains(menu)).toBe(false);
  });
});

describe("Key-signature popover OPTIONS (built via the shared builder, SIG-4)", () => {
  // The rows are built at runtime in main.ts from buildKeyOptionButton; test that builder directly so
  // the option structure (incl. aria-checked on the current key) is pinned without main.ts side effects.
  it("builds 15 keys from 7 flats to 7 sharps in circle-of-fifths order", () => {
    expect(CIRCLE_OF_FIFTHS).toHaveLength(15);
    expect(CIRCLE_OF_FIFTHS[0].fifths).toBe(-7);
    expect(CIRCLE_OF_FIFTHS[14].fifths).toBe(7);
    // Strictly increasing fifths (the circle-of-fifths layout flats..natural..sharps).
    for (let i = 1; i < CIRCLE_OF_FIFTHS.length; i++) {
      expect(CIRCLE_OF_FIFTHS[i].fifths).toBe(CIRCLE_OF_FIFTHS[i - 1].fifths + 1);
    }
  });

  it("each option carries aria-checked (true only for the current key) + the spoken row label", () => {
    const d = new DOMParser().parseFromString("<!doctype html><html><body></body></html>", "text/html");
    // The current key is C major (fifths 0); build the row for it CHECKED and a neighbour UNCHECKED.
    const current = buildKeyOptionButton(d, 0, true);
    const other = buildKeyOptionButton(d, 2, false);
    expect(current.getAttribute("aria-checked")).toBe("true");
    expect(other.getAttribute("aria-checked")).toBe("false");
    // The spoken label leads with the accidental count + both names (SIG-4).
    expect(current.getAttribute("aria-label")).toBe("no sharps or flats, C major or A minor");
    expect(other.getAttribute("aria-label")).toBe("2 sharps, D major or B minor");
    // data-fifths stores the value the click applies; the row is a radio option.
    expect(current.dataset.fifths).toBe("0");
    expect(other.getAttribute("role")).toBe("menuitemradio");
  });

  it("every key row's spoken label is em-dash-free (project style rule)", () => {
    for (const k of CIRCLE_OF_FIFTHS) {
      const label = keyRowLabel(k.fifths);
      expect(label).not.toContain("—");
      expect(label).not.toContain("–");
    }
  });
});
