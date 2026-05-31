import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The OMR worker is Python (omr-worker/worker.py) and the project CI runs only the Node
// pipeline (vitest), so there is no pytest gate today. omr-worker/test_worker.py covers
// the preprocessing logic for a local run; these source guards read worker.py as text and
// lock the #109 wiring inside the existing vitest run so a regression to the rasterization
// preprocessing is still caught in CI. They are intentionally structural (not behavioral).

const root = fileURLToPath(new URL("..", import.meta.url));
const worker = readFileSync(`${root}omr-worker/worker.py`, "utf8");

describe("OMR worker rasterization preprocessing (issue #109)", () => {
  it("keeps the rasterization DPI in the #112-swept sweet spot", () => {
    const match = worker.match(/PDF_RASTER_DPI\s*=\s*(\d+)/);
    expect(match, "PDF_RASTER_DPI constant must exist").not.toBeNull();
    const dpi = Number(match![1]);
    // #109 raised this from 300 to 400; the #112 DPI sweep on icarus.pdf then found 400
    // was past oemer's sweet spot (it collapsed real LH triads) and 350 recovers more
    // genuine chord tones with zero fabricated accidentals. Lock the swept value: above
    // the old 300 baseline, at the measured 350, never drifting back up to the worse 400.
    expect(dpi).toBeGreaterThan(300);
    expect(dpi).toBe(350);
  });

  it("passes the DPI constant to pdftoppm (not a hardcoded 300)", () => {
    expect(worker).toMatch(/pdftoppm[\s\S]*str\(PDF_RASTER_DPI\)/);
    // The old single-page flags must be gone so all pages rasterize.
    expect(worker).not.toMatch(/"-f",\s*"1",\s*"-l",\s*"1"/);
  });

  it("stitches all PDF pages into one image instead of dropping pages 2+", () => {
    expect(worker).toContain("def stitch_pages_vertical(");
    expect(worker).toContain("stitch_pages_vertical(pages");
  });

  it("bounds the stitched raster so a crafted many-page PDF cannot OOM the worker", () => {
    // A 10 MB vector PDF can hold hundreds of sparse pages; an unbounded vertical
    // stitch would allocate a multi-GB bitmap and OOM-kill the always-on poller.
    expect(worker).toMatch(/MAX_STITCH_PAGES\s*=\s*\d+/);
    expect(worker).toMatch(/MAX_STITCH_PIXELS\s*=/);
    // Page-count and total-area caps must both be enforced before allocating the canvas.
    expect(worker).toContain("len(page_paths) > MAX_STITCH_PAGES");
    expect(worker).toMatch(/total_width \* total_height > MAX_STITCH_PIXELS/);
    // Pillow's decompression-bomb guard must be armed so a single crafted page cannot
    // bomb-decode on Image.open.
    expect(worker).toContain("Image.MAX_IMAGE_PIXELS = MAX_STITCH_PIXELS");
  });

  it("disables oemer deskew only on the PDF path", () => {
    expect(worker).toContain("--without-deskew");
    // rasterize returns (image_path, is_pdf); the deskew flag is driven by is_pdf.
    expect(worker).toMatch(/run_oemer\(image_path,\s*workdir,\s*without_deskew=is_pdf\)/);
  });

  it("keeps the R2 result key/content-type transport contract unchanged", () => {
    expect(worker).toContain('RESULT_SUFFIX = ".musicxml"');
    expect(worker).toContain(
      'RESULT_CONTENT_TYPE = "application/vnd.recordare.musicxml+xml"',
    );
  });

  it("uses no em or en dashes in the worker source", () => {
    expect(worker).not.toMatch(/[–—]/);
  });
});
