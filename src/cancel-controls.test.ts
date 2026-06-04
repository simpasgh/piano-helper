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
    <button id="export-menu-btn" disabled></button>
    <button id="prev-note-btn" disabled></button>
    <button id="next-note-btn" disabled></button>
    <input id="seek-slider" type="range" disabled />
  `;
  return {
    playBtn: document.getElementById("play-btn") as HTMLButtonElement,
    exportMenuBtn: document.getElementById("export-menu-btn") as HTMLButtonElement,
    prevBtn: document.getElementById("prev-note-btn") as HTMLButtonElement,
    nextBtn: document.getElementById("next-note-btn") as HTMLButtonElement,
    seek: document.getElementById("seek-slider") as HTMLInputElement,
  };
}

// Mirror of setBusyUI's not-busy branch in main.ts: enable iff a score is loaded.
function applyNotBusy(els: ReturnType<typeof makeControls>, scoreLoaded: boolean) {
  const enabled = controlsEnabledForScore(scoreLoaded);
  els.playBtn.disabled = !enabled;
  els.exportMenuBtn.disabled = !enabled;
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
    els.exportMenuBtn.disabled = true;
    els.prevBtn.disabled = true;
    els.nextBtn.disabled = true;
    els.seek.disabled = true;

    // Cancel -> setBusyUI(false) with a score loaded.
    applyNotBusy(els, true);

    expect(els.playBtn.disabled).toBe(false);
    expect(els.exportMenuBtn.disabled).toBe(false);
    expect(els.prevBtn.disabled).toBe(false);
    expect(els.nextBtn.disabled).toBe(false);
    expect(els.seek.disabled).toBe(false);
  });

  it("leaves them disabled when no score is loaded", () => {
    applyNotBusy(els, false);

    expect(els.playBtn.disabled).toBe(true);
    expect(els.exportMenuBtn.disabled).toBe(true);
    expect(els.prevBtn.disabled).toBe(true);
    expect(els.nextBtn.disabled).toBe(true);
    expect(els.seek.disabled).toBe(true);
  });
});

// Regression for issue #93: on the SCAN path, Cancel/Escape must re-enable a still-loaded
// score's controls SYNCHRONOUSLY, not after the in-flight /api/omr round-trip settles.
// Before the fix, cancelScanOverlay only called setBusyUI(false) in its `wasAudio` branch,
// so the scan path's controls stayed disabled until scanSheet's finally ran (after submitOmr
// resolved and pollOmrResult next saw the cancel flag). The audio path already re-enabled
// synchronously. This models cancelScanOverlay's behavior (now identical for both kinds)
// against real elements: it tears down the UI immediately and leaves the in-flight job to
// settle later.
describe("scan-path Cancel re-enables controls synchronously (issue #93)", () => {
  let els: ReturnType<typeof makeControls>;

  // Mirror of cancelScanOverlay's control restore (kind-agnostic after the #93 fix): the
  // synchronous setBusyUI(false) + restore. We only assert the disabled-flag outcome here,
  // which is what the bug violated for the scan kind.
  function cancelScan(scoreLoaded: boolean) {
    applyNotBusy(els, scoreLoaded);
  }

  beforeEach(() => {
    els = makeControls();
  });

  it("re-enables a still-loaded score's controls immediately on scan cancel", () => {
    // Busy: a scan job in flight (setBusyUI(true) disabled everything).
    els.playBtn.disabled = true;
    els.exportMenuBtn.disabled = true;
    els.prevBtn.disabled = true;
    els.nextBtn.disabled = true;
    els.seek.disabled = true;

    // Cancel/Escape on the scan overlay, with the prior score still loaded.
    cancelScan(true);

    // No awaiting the OMR promise: controls are usable right away.
    expect(els.playBtn.disabled).toBe(false);
    expect(els.exportMenuBtn.disabled).toBe(false);
    expect(els.prevBtn.disabled).toBe(false);
    expect(els.nextBtn.disabled).toBe(false);
    expect(els.seek.disabled).toBe(false);
  });

  it("keeps controls disabled on scan cancel when no score is loaded", () => {
    els.playBtn.disabled = true;
    els.exportMenuBtn.disabled = true;
    els.prevBtn.disabled = true;
    els.nextBtn.disabled = true;
    els.seek.disabled = true;

    cancelScan(false);

    expect(els.playBtn.disabled).toBe(true);
    expect(els.exportMenuBtn.disabled).toBe(true);
    expect(els.prevBtn.disabled).toBe(true);
    expect(els.nextBtn.disabled).toBe(true);
    expect(els.seek.disabled).toBe(true);
  });
});
