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
});
