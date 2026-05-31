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

describe("OMR worker Clarity-OMR tie engine (issue #135)", () => {
  it("wires Clarity as an env-gated CPU subprocess engine", () => {
    // The engine is located by two env vars; if either is unset run_clarity returns None
    // so the flow falls back to oemer (no crash).
    expect(worker).toContain('CLARITY_OMR_DIR_ENV = "CLARITY_OMR_DIR"');
    expect(worker).toContain('CLARITY_PYTHON_ENV = "CLARITY_PYTHON"');
    expect(worker).toContain("def clarity_command(");
    expect(worker).toContain("def run_clarity(");
  });

  it("builds the Clarity argv with --device cpu --fast and a work dir", () => {
    // Pure command builder (mirrors oemer_command) so the contract is unit-testable.
    expect(worker).toMatch(/"--device",\s*\n?\s*"cpu",/);
    expect(worker).toContain('"--fast",');
    expect(worker).toMatch(/"--work-dir",/);
    expect(worker).toMatch(/"-o",/);
  });

  it("returns None from run_clarity when the env is unset or paths are missing", () => {
    expect(worker).toMatch(/if not omr_dir or not python:\s*\n\s*return None/);
    expect(worker).toContain("os.path.isfile(omr_script)");
  });

  it("runs Clarity first for PDF uploads, then falls back to oemer then homr", () => {
    // Order: Clarity (PDF-only) -> oemer -> homr. Clarity is skipped for PNG/JPEG.
    expect(worker).toContain("is_pdf_input");
    expect(worker).toMatch(/if is_pdf_input:\s*\n\s*result_path = run_clarity\(input_path, workdir\)/);
    // oemer/homr stay the fallback, in that order. Scope the ordering to the process_job
    // flow (the function bodies define run_oemer/run_homr earlier in the file).
    const flow = worker.slice(worker.indexOf("def process_job("));
    const clarity = flow.indexOf("run_clarity(input_path");
    const oemer = flow.indexOf("run_oemer(image_path");
    const homr = flow.indexOf("run_homr(image_path");
    expect(clarity).toBeGreaterThan(-1);
    expect(clarity).toBeLessThan(oemer);
    expect(oemer).toBeLessThan(homr);
  });

  it("preserves the original PDF path for Clarity (sniff before rasterize)", () => {
    // rasterize_if_pdf renames input.bin, so the PDF type is sniffed BEFORE rasterizing
    // and Clarity is handed the original PDF (not the stitched raster).
    expect(worker).toMatch(/is_pdf_input = sniff_mime\(input_path\) == "application\/pdf"/);
  });

  it("applies both MusicXML post-transforms before put_object", () => {
    expect(worker).toContain("def merge_to_grand_staff(");
    expect(worker).toContain("def normalize_ties(");
    // Both run on the engine body, grand-staff merge first then tie normalization, and the
    // call site precedes the put_object that writes the result.
    const merge = worker.indexOf("body = merge_to_grand_staff(body)");
    const ties = worker.indexOf("body = normalize_ties(body)");
    const put = worker.indexOf("client.put_object(");
    expect(merge).toBeGreaterThan(-1);
    expect(merge).toBeLessThan(ties);
    expect(ties).toBeLessThan(put);
  });

  it("makes the post-transforms safe no-ops that never raise into process_job", () => {
    // The #113 robustness rule: any failure returns the ORIGINAL bytes, no sentinel.
    expect(worker).toContain("merge_to_grand_staff skipped");
    expect(worker).toContain("normalize_ties skipped");
    // grand-staff merge is a no-op unless there are exactly 2 parts (oemer has 1).
    expect(worker).toContain("if len(parts) != 2:");
    expect(worker).toContain("return xml_bytes");
  });
});
