// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeAll } from "vitest";

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
      "delete-note-btn",
      "add-note",
      "add-note-btn",
    ]) {
      const el = doc.getElementById(id);
      expect(el, `#${id} should exist`).not.toBeNull();
      expect(editToolbar.contains(el!), `#${id} should be inside #edit-toolbar`).toBe(true);
    }
  });
});
