// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { reattachHostIfDetached, observeHostReattach } from "./host-reattach";

// MutationObserver callbacks run as microtasks AFTER the mutation; a macrotask tick lets them flush.
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("reattachHostIfDetached", () => {
  it("re-appends a detached host while editing", () => {
    const sheet = document.createElement("div");
    const host = document.createElement("div");
    expect(reattachHostIfDetached(sheet, host, true)).toBe(true);
    expect(host.parentNode).toBe(sheet);
  });

  it("no-ops when edit mode is off (the player owns #sheet)", () => {
    const sheet = document.createElement("div");
    const host = document.createElement("div");
    expect(reattachHostIfDetached(sheet, host, false)).toBe(false);
    expect(host.parentNode).toBeNull();
  });

  it("no-ops when the host is already attached (so the observer cannot loop)", () => {
    const sheet = document.createElement("div");
    const host = document.createElement("div");
    sheet.appendChild(host);
    expect(reattachHostIfDetached(sheet, host, true)).toBe(false);
    expect(host.parentNode).toBe(sheet);
  });

  it("no-ops when there is no host", () => {
    const sheet = document.createElement("div");
    expect(reattachHostIfDetached(sheet, null, true)).toBe(false);
  });
});

describe("observeHostReattach", () => {
  it("re-attaches the host, content preserved, when OSMD clears #sheet during edit mode", async () => {
    const sheet = document.createElement("div");
    document.body.appendChild(sheet);
    const host = document.createElement("div");
    host.id = "verovio-host";
    host.innerHTML = "<svg><g class='note'></g></svg>"; // the engraved staff
    sheet.appendChild(host);

    const obs = observeHostReattach(sheet, () => host, () => true);
    // Simulate OSMD's autoResize render clearing its container.
    sheet.innerHTML = "";
    expect(host.parentNode).toBeNull(); // detached

    await tick();
    expect(host.parentNode).toBe(sheet); // re-attached by the observer
    expect(host.querySelector("svg g.note")).not.toBeNull(); // SVG survived the detach
    obs.disconnect();
  });

  it("does NOT re-attach when edit mode is off", async () => {
    const sheet = document.createElement("div");
    document.body.appendChild(sheet);
    const host = document.createElement("div");
    sheet.appendChild(host);

    const obs = observeHostReattach(sheet, () => host, () => false);
    sheet.innerHTML = "";
    await tick();
    expect(host.parentNode).toBeNull(); // left detached: the read-only player owns #sheet now
    obs.disconnect();
  });

  it("reads edit mode live, so the same observer serves a later edit session", async () => {
    const sheet = document.createElement("div");
    document.body.appendChild(sheet);
    const host = document.createElement("div");
    sheet.appendChild(host);
    let editing = false;
    const obs = observeHostReattach(sheet, () => host, () => editing);

    sheet.removeChild(host);
    await tick();
    expect(host.parentNode).toBeNull(); // not editing yet

    editing = true; // a later enter-edit
    sheet.appendChild(host);
    sheet.removeChild(host); // OSMD detaches again
    await tick();
    expect(host.parentNode).toBe(sheet); // now guarded
    obs.disconnect();
  });

  it("stops re-attaching after disconnect", async () => {
    const sheet = document.createElement("div");
    document.body.appendChild(sheet);
    const host = document.createElement("div");
    sheet.appendChild(host);

    const obs = observeHostReattach(sheet, () => host, () => true);
    obs.disconnect();
    sheet.innerHTML = "";
    await tick();
    expect(host.parentNode).toBeNull();
  });

  it("does not thrash: after a re-append the host stays attached", async () => {
    const sheet = document.createElement("div");
    document.body.appendChild(sheet);
    const host = document.createElement("div");
    sheet.appendChild(host);

    const obs = observeHostReattach(sheet, () => host, () => true);
    sheet.removeChild(host);
    await tick(); // re-appended (itself a mutation)
    await tick(); // the re-fire no-ops (parentNode === sheet)
    expect(host.parentNode).toBe(sheet);
    obs.disconnect();
  });
});
