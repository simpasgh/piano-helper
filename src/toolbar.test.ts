import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Toolbar redesign v2 (issue #46) is a markup/CSS change. There is no jsdom in this project
// (kept dep-free, see tech-lead.md), so these guards read the source files as text and assert
// the structural invariants that the redesign must preserve and the changes it must introduce.
// They protect the id= hooks main.ts queries, the ARIA labels, the responsive contract from
// #33, and the three-tier palette that fixes the all-violet bar.

const root = fileURLToPath(new URL("..", import.meta.url));
const html = readFileSync(`${root}index.html`, "utf8");
const css = readFileSync(`${root}src/style.css`, "utf8");
const main = readFileSync(`${root}src/main.ts`, "utf8");

describe("toolbar markup invariants (issue #46)", () => {
  // main.ts queries these by id; renaming any of them silently breaks the app.
  const requiredIds = [
    "file-input",
    "scan-input",
    "audio-input",
    "export-btn",
    "names-btn",
    "tempo-slider",
    "tempo-readout",
    "balance-slider",
    "balance-readout",
    "prev-note-btn",
    "play-btn",
    "next-note-btn",
    "seek-slider",
    "time-readout",
    "track-name",
    "sound-status",
  ];

  it.each(requiredIds)("keeps the #%s hook main.ts depends on", (id) => {
    expect(html).toContain(`id="${id}"`);
  });

  it("hides the hand-controls group via [hidden] instead of an unconditional display (issue #76)", () => {
    // main.ts toggles #hand-mutes (the mute toggles + the #70 balance slider) with the
    // `hidden` attribute when a score has no left/right split. A bare `.hand-mutes { display:
    // flex }` overrides the native `[hidden]` -> `display: none`, leaving the whole group on
    // screen for single-staff/audio scores. The `:not([hidden])` guard is what makes hiding
    // actually work; this asserts it stays.
    expect(css).toContain(".hand-mutes:not([hidden])");
    // And no bare `.hand-mutes {` rule (with a space) reintroduces the unconditional display.
    expect(css).not.toMatch(/\.hand-mutes\s*\{/);
  });

  it("keeps the prev/next step buttons labelled for assistive tech", () => {
    expect(html).toContain('aria-label="Previous note"');
    expect(html).toContain('aria-label="Next note"');
    // Keyboard-shortcut hints stay in the title attributes.
    expect(html).toContain("Previous note (Left arrow)");
    expect(html).toContain("Next note (Right arrow)");
  });

  it("renders step glyphs as inline SVG (crisp, cross-platform, currentColor)", () => {
    // The broken arrow-against-pipe text glyphs are gone.
    expect(html).not.toContain("&#9664;&#124;");
    expect(html).not.toContain("&#124;&#9654;");
    // Two step icons, both currentColor so they inherit the ghost label color.
    expect(html.match(/class="step-icon"/g)?.length).toBe(2);
    expect(html).toContain('fill="currentColor"');
  });

  it("groups prev/Play/next into one tight transport cluster", () => {
    expect(html).toContain('class="transport-cluster"');
  });

  it("keeps track-name as the right-trailing flexible slot (room for #44)", () => {
    // margin-left: auto on #track-name leaves a place for the future editable name field.
    expect(css).toMatch(/#track-name\s*\{[^}]*margin-left:\s*auto/);
  });

  it("provides the editable sheet-name hooks main.ts queries (issue #44)", () => {
    // The inline rename feature wires these by id; dropping any breaks the rename.
    for (const id of ["sheet-name", "sheet-name-input", "sheet-note-count", "track-status"]) {
      expect(html).toContain(`id="${id}"`);
    }
    // The name is a click-to-edit button (keyboard/AT operable), labelled for assistive tech.
    expect(html).toMatch(/id="sheet-name"[\s\S]*?aria-label="Sheet name, click to rename"/);
    // The edit field caps length so a pasted blob cannot blow out the toolbar.
    expect(html).toMatch(/id="sheet-name-input"[\s\S]*?maxlength="80"/);
  });
});

describe("toolbar palette tiers (issue #46)", () => {
  it("defines the new secondary (raised-neutral) loader tier tokens", () => {
    expect(css).toContain("--secondary-bg:");
    expect(css).toContain("--secondary-border:");
    expect(css).toContain("--secondary-bg-hover:");
  });

  it("makes Play the sole filled-violet primary, not the loaders", () => {
    // Loaders must NOT share the filled accent gradient any more.
    expect(css).not.toMatch(/\.file-btn,\s*#play-btn\s*\{[^}]*--accent-gradient/);
    // Loaders are the raised-neutral secondary surface.
    expect(css).toMatch(/\.file-btn\s*\{[^}]*var\(--secondary-bg\)/);
    // Play keeps the violet gradient hero fill.
    expect(css).toMatch(/#play-btn\s*\{[^}]*var\(--accent-gradient\)/);
  });

  it("uses a neutral group divider, not a violet one", () => {
    expect(css).toContain("--group-divider:");
    expect(css).toMatch(/\.group \+ \.group::before[\s\S]*?background:\s*var\(--group-divider\)/);
  });

  it("preserves the #33 mobile contract (44px touch targets at <=720px)", () => {
    expect(css).toContain("@media (max-width: 720px)");
    expect(css).toContain("min-height: 44px");
    expect(css).toMatch(/\.step-btn\s*\{\s*min-width:\s*44px/);
  });

  it("lets control groups wrap their buttons on phones so the toolbar never overflows (issue #84)", () => {
    // The source-loader cluster holds three labelled buttons; without intra-group wrapping it
    // forms a single row wider than a phone viewport and scrolls the page horizontally. The
    // phone breakpoint must let .group (and .controls) wrap so buttons stack instead.
    const phone = css.slice(css.indexOf("@media (max-width: 720px)"));
    expect(phone).toMatch(/\.controls,\s*\.group\s*\{\s*flex-wrap:\s*wrap/);
  });
});

describe("Heroicons toolbar/transport icons (issue #48)", () => {
  // The redesign #46 step glyphs were hand-rolled SVG; #48 adopts the official Heroicons
  // (MIT) set across the bar. These guards lock the icon set in by matching a fragment of
  // each authentic Heroicons path so a regression to ad-hoc glyphs (or a wrong icon) is
  // caught. They also assert the standardized currentColor + outline-vs-solid convention.

  // A distinctive substring of each Heroicons 24x24 path we inlined. Outline icons are
  // stroked, the Play/Pause hero is solid (filled).
  const heroiconSignatures: Record<string, string> = {
    // outline/document-arrow-up - Load MusicXML
    "document-arrow-up": "M19.5 14.25V11.625C19.5 9.76104 17.989 8.25 16.125 8.25",
    // outline/camera - Scan sheet
    camera: "M6.82689 6.1749C6.46581 6.75354 5.86127 7.13398 5.186 7.22994",
    // outline/musical-note - From audio
    "musical-note": "M9 9L19.5 6M19.5 12.5528V16.3028",
    // outline/arrow-down-tray - Export video
    "arrow-down-tray": "M3 16.5V18.75C3 19.9926 4.00736 21 5.25 21H18.75",
    // outline/eye - Names toggle
    eye: "M2.03555 12.3224C1.96647 12.1151 1.9664 11.8907 2.03536 11.6834",
    // outline/backward - Previous note (step satellite)
    backward: "M21 16.8115C21 17.6753 20.0668 18.2169 19.3169 17.7883",
    // outline/forward - Next note (step satellite)
    forward: "M3 8.68867C3 7.82487 3.93317 7.28334 4.68316 7.7119",
    // solid/play - Play hero (filled)
    "play-solid": "M4.5 5.65257C4.5 4.22644 6.029 3.32239 7.2786 4.00967",
  };

  it.each(Object.entries(heroiconSignatures))(
    "inlines the official Heroicons %s glyph",
    (_name, signature) => {
      expect(html).toContain(signature);
    },
  );

  it("standardizes outline icons on stroke=currentColor (palette-driven, no hardcoded hue)", () => {
    // Outline action/utility icons inherit the tier color via currentColor and stroke.
    expect(html).toContain('class="btn-icon"');
    expect(html).toContain('stroke="currentColor"');
    // Heroicons ship a hardcoded #0F172A on their paths; the inlined copies must not.
    expect(html).not.toContain("#0F172A");
    expect(html).not.toContain("#0f172a");
  });

  it("uses the solid (filled) variant only for the primary Play hero", () => {
    // The Play hero icon is filled; the swap path data lives in main.ts so the inline svg
    // (and its currentColor wiring) survives a Play/Pause toggle.
    expect(html).toMatch(/class="btn-icon play-icon"[\s\S]*?fill="currentColor"/);
    expect(main).toContain("PLAY_ICON_PATH");
    expect(main).toContain("PAUSE_ICON_PATH");
  });

  it("swaps only the label span + icon path on Play/Pause and Names, never the whole button", () => {
    // Replacing playBtn/namesBtn.textContent would wipe the inline svg; main.ts must target
    // the dedicated label spans instead.
    expect(html).toContain('id="play-label"');
    expect(html).toContain('id="names-label"');
    expect(main).not.toMatch(/playBtn\.textContent\s*=/);
    expect(main).not.toMatch(/namesBtn\.textContent\s*=/);
  });
});

// Scan / transcribe loading overlay (issue #86). Same text-guard pattern: lock the markup
// hooks main.ts queries, the dialog a11y attributes, the body-extra hook the phone CSS
// hides, and the overlay-over-stage stacking so a refactor cannot silently regress it.
describe("scan overlay markup + CSS (issue #86)", () => {
  it.each(["scan-overlay", "scan-overlay-title", "scan-overlay-cancel"])(
    "keeps the #%s hook main.ts depends on",
    (id) => {
      expect(html).toContain(`id="${id}"`);
    },
  );

  it("declares dialog semantics so AT announces a busy modal", () => {
    expect(html).toMatch(/id="scan-overlay"[\s\S]*?role="dialog"/);
    expect(html).toMatch(/id="scan-overlay"[\s\S]*?aria-modal="true"/);
    expect(html).toMatch(/id="scan-overlay"[\s\S]*?aria-labelledby="scan-overlay-title"/);
    expect(html).toMatch(/id="scan-overlay"[\s\S]*?aria-describedby="scan-overlay-body"/);
    expect(html).toMatch(/id="scan-overlay"[\s\S]*?aria-busy="true"/);
  });

  it("starts hidden and sits inside #app after the stage canvas", () => {
    const stageIdx = html.indexOf('id="stage"');
    const overlayIdx = html.indexOf('id="scan-overlay"');
    expect(stageIdx).toBeGreaterThan(-1);
    expect(overlayIdx).toBeGreaterThan(stageIdx);
    expect(html).toMatch(/id="scan-overlay"[\s\S]*?hidden/);
  });

  it("wraps the droppable second sentence so the phone layout can hide it", () => {
    expect(html).toContain('class="scan-overlay-body-extra"');
    expect(css).toMatch(/\.scan-overlay-body-extra\s*\{[\s\S]*?display:\s*none/);
  });

  it("covers the stage but not the toolbar (overlay below, topbar above)", () => {
    // The overlay is absolutely positioned at z-index 5; the topbar must stack above it.
    expect(css).toMatch(/\.scan-overlay\s*\{[\s\S]*?position:\s*absolute/);
    expect(css).toMatch(/\.scan-overlay\s*\{[\s\S]*?z-index:\s*5/);
    expect(css).toMatch(/\.topbar\s*\{[\s\S]*?z-index:\s*6/);
  });

  it("respects reduced motion (no spin, a gentle pulse instead)", () => {
    expect(css).toContain("prefers-reduced-motion: reduce");
    expect(css).toContain("scan-pulse");
  });

  it("wires Cancel and the cancelled-sentinel swallow, never alerting on a cancel", () => {
    expect(main).toContain("cancelScanOverlay");
    expect(main).toContain("isCancelledRequested");
    expect(main).toContain("isCancelled(err)");
  });

  it("gates the audio load behind shouldApplyResult so a cancelled job never loads (BLOCKING 1)", () => {
    // loadAudioFile takes a shouldApply guard and checks it before loadNotes; transcribeAudio
    // passes shouldApplyResult(generation, jobGeneration, cancelRequested). The generation
    // check (not just cancelRequested, which showScanOverlay resets per job) is what stops a
    // cancel-then-restart job A from loading under job B's overlay.
    expect(main).toContain("shouldApplyResult");
    expect(main).toMatch(/loadAudioFile\(\s*file\s*:\s*File\s*,\s*shouldApply/);
    expect(main).toMatch(/if\s*\(\s*!shouldApply\(\)\s*\)\s*return/);
    expect(main).toMatch(
      /shouldApplyResult\(\s*generation\s*,\s*jobGeneration\s*,\s*cancelRequested\s*\)/,
    );
  });

  it("re-enables play/export/transport in setBusyUI's not-busy branch (BLOCKING 2)", () => {
    // The not-busy branch must restore the controls based on whether a score is loaded, so a
    // cancel with a previously loaded score does not leave them stuck disabled. Guard that an
    // else branch exists and drives the enable off controlsEnabledForScore(!!score).
    const busyFn = main.slice(
      main.indexOf("function setBusyUI"),
      main.indexOf("function setBusyUI") + 900,
    );
    expect(busyFn).toContain("} else {");
    expect(busyFn).toContain("controlsEnabledForScore(!!score)");
    expect(busyFn).toMatch(/playBtn\.disabled\s*=\s*!enabled/);
    expect(busyFn).toMatch(/exportBtn\.disabled\s*=\s*!enabled/);
    expect(busyFn).toMatch(/setTransportControlsEnabled\(enabled\)/);
  });

  it("keeps the overlay copy free of em and en dashes", () => {
    const overlay = html.slice(
      html.indexOf('id="scan-overlay"'),
      html.indexOf('id="rotate-hint"'),
    );
    expect(overlay).not.toMatch(/[–—]/);
  });
});
