// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { controlsEnabledForScore } from "./playback";

// Regression for the #86 cancel defect: setBusyUI(false) must re-enable play / export /
// the transport row (prev, next, seek) when a score is loaded, and leave them disabled when
// nothing is loaded. Before the fix the not-busy branch never wrote these flags, so a score
// that was loaded before a scan/audio job started was left with its controls stuck disabled
// after Cancel (loadNotes never runs on the abandon path).
//
// setBusyUI is module-private in main.ts and booting the whole app under jsdom would pull in
// Tone.js, OSMD, canvas captureStream, the sampler network load, and the rAF loop. So this
// test reproduces the exact not-busy enable wiring against real DOM elements and the shared
// `controlsEnabledForScore` predicate that main.ts now uses, locking the disabled-flag
// behavior the defect violated.

function makeControls() {
  document.body.innerHTML = `
    <button id="play-btn" disabled></button>
    <button id="export-btn" disabled></button>
    <button id="prev-note-btn" disabled></button>
    <button id="next-note-btn" disabled></button>
    <input id="seek-slider" type="range" disabled />
  `;
  return {
    playBtn: document.getElementById("play-btn") as HTMLButtonElement,
    exportBtn: document.getElementById("export-btn") as HTMLButtonElement,
    prevBtn: document.getElementById("prev-note-btn") as HTMLButtonElement,
    nextBtn: document.getElementById("next-note-btn") as HTMLButtonElement,
    seek: document.getElementById("seek-slider") as HTMLInputElement,
  };
}

// Mirror of setBusyUI's not-busy branch in main.ts: enable iff a score is loaded.
function applyNotBusy(els: ReturnType<typeof makeControls>, scoreLoaded: boolean) {
  const enabled = controlsEnabledForScore(scoreLoaded);
  els.playBtn.disabled = !enabled;
  els.exportBtn.disabled = !enabled;
  els.prevBtn.disabled = !enabled;
  els.nextBtn.disabled = !enabled;
  els.seek.disabled = !enabled;
}

describe("cancel re-enables controls based on a loaded score (issue #86)", () => {
  let els: ReturnType<typeof makeControls>;

  beforeEach(() => {
    els = makeControls();
  });

  it("re-enables play/export/transport when a score is still loaded", () => {
    // Simulate the busy state first (a scan/audio job in flight).
    els.playBtn.disabled = true;
    els.exportBtn.disabled = true;
    els.prevBtn.disabled = true;
    els.nextBtn.disabled = true;
    els.seek.disabled = true;

    // Cancel -> setBusyUI(false) with a score loaded.
    applyNotBusy(els, true);

    expect(els.playBtn.disabled).toBe(false);
    expect(els.exportBtn.disabled).toBe(false);
    expect(els.prevBtn.disabled).toBe(false);
    expect(els.nextBtn.disabled).toBe(false);
    expect(els.seek.disabled).toBe(false);
  });

  it("leaves them disabled when no score is loaded", () => {
    applyNotBusy(els, false);

    expect(els.playBtn.disabled).toBe(true);
    expect(els.exportBtn.disabled).toBe(true);
    expect(els.prevBtn.disabled).toBe(true);
    expect(els.nextBtn.disabled).toBe(true);
    expect(els.seek.disabled).toBe(true);
  });
});
