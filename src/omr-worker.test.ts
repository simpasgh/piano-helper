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
    // rasterize returns (image_path, is_pdf); the deskew flag is driven by is_pdf. The
    // oemer launch now carries a per-engine timeout too (Slice 1), so allow extra args
    // after without_deskew=is_pdf rather than pinning the exact end of the call.
    expect(worker).toMatch(/run_oemer\(image_path,\s*workdir,\s*without_deskew=is_pdf/);
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

  it("gates the concurrent ensemble path behind OMR_ENSEMBLE, default OFF = legacy short-circuit", () => {
    // Slice 1 ships ZERO-risk: the concurrent path is behind OMR_ENSEMBLE (default OFF) so
    // prod keeps the legacy Clarity-first short-circuit (oemer NOT run when Clarity wins on a
    // PDF, ~15s) until QA validates the parallel path with OMR_ENSEMBLE=1. The same flag will
    // later gate reconciliation. This guard pins the env-flag helper + the process_job branch.
    expect(worker).toContain('OMR_ENSEMBLE_ENV = "OMR_ENSEMBLE"');
    expect(worker).toContain("def ensemble_enabled(");
    // Truthy parsing: only "1"/"true" enable it (anything else, incl. unset, stays OFF).
    expect(worker).toMatch(/in \("1", "true"\)/);
    // process_job branches on the flag: ensemble path when ON, legacy path when OFF.
    expect(worker).toMatch(/if ensemble_enabled\(\):\s*\n\s*result_path, source = _select_ensemble\(/);
    expect(worker).toMatch(/else:\s*\n\s*result_path, source = _select_legacy\(/);
  });

  it("legacy path (flag OFF) short-circuits at Clarity for a PDF, no oemer/raster on success", () => {
    // The prod default. _select_legacy must try Clarity FIRST for a PDF and only rasterize +
    // run oemer when Clarity returns None, so a successful Clarity scan never pays the oemer
    // (~180s) or rasterization cost. Pin that the rasterize+oemer fallback is INSIDE the
    // `if result_path is None:` guard (i.e. skipped on the Clarity happy path).
    const legacy = worker.slice(
      worker.indexOf("def _select_legacy("),
      worker.indexOf("def _select_ensemble("),
    );
    const clarity = legacy.indexOf("run_clarity(input_path");
    const guard = legacy.indexOf("if result_path is None:");
    const raster = legacy.indexOf("rasterize_if_pdf(input_path");
    const oemer = legacy.indexOf("run_oemer(image_path");
    expect(clarity).toBeGreaterThan(-1);
    // Clarity runs before the None-guard; rasterize + oemer run only after (inside) it.
    expect(clarity).toBeLessThan(guard);
    expect(guard).toBeLessThan(raster);
    expect(raster).toBeLessThan(oemer);
  });

  it("ensemble path (flag ON) runs the two primaries concurrently, keeping Clarity>oemer>homr", () => {
    // When the flag is ON, _select_ensemble runs Clarity and oemer CONCURRENTLY via a
    // ThreadPoolExecutor, but the SELECTION precedence is unchanged (Clarity wins, else oemer,
    // else homr, else sentinel). This guard pins the precedence without pinning a sequential
    // call order, so the concurrent scheduling is allowed while a precedence regression fails.
    expect(worker).toContain("is_pdf_input");
    expect(worker).toContain("def select_primary_result(");
    // The two primaries are launched on a thread pool (true wall-clock overlap on subprocs).
    expect(worker).toContain("import concurrent.futures");
    expect(worker).toMatch(/concurrent\.futures\.ThreadPoolExecutor/);
    // Clarity is launched ONLY for PDF input (it is PDF-only); oemer always.
    expect(worker).toMatch(/if is_pdf_input:\s*\n\s*futures\["clarity"\] = pool\.submit/);
    // Selection precedence inside the selector: Clarity checked before oemer.
    const selector = worker.slice(
      worker.indexOf("def select_primary_result("),
      worker.indexOf("def _select_legacy("),
    );
    const clarityPick = selector.indexOf('return clarity_result, "clarity"');
    const oemerPick = selector.indexOf('return oemer_result, "oemer"');
    expect(clarityPick).toBeGreaterThan(-1);
    expect(clarityPick).toBeLessThan(oemerPick);
    // homr stays the LAST resort, run in the ensemble path only after the concurrent
    // primaries both fail (result_path is None).
    const flow = worker.slice(
      worker.indexOf("def _select_ensemble("),
      worker.indexOf("def process_job("),
    );
    const selectCall = flow.indexOf("select_primary_result(");
    const homr = flow.indexOf("run_homr(image_path");
    expect(selectCall).toBeGreaterThan(-1);
    expect(selectCall).toBeLessThan(homr);
  });

  it("applies a per-engine subprocess timeout so one wedged engine cannot stall the worker", () => {
    // Each engine subprocess gets a wall-clock cap; exceeding it counts as that engine
    // failing (the runner returns None) and we degrade to the survivor.
    expect(worker).toContain("def engine_timeout_seconds(");
    expect(worker).toMatch(/DEFAULT_ENGINE_TIMEOUT_SECONDS\s*=\s*\d+/);
    // The runners thread the timeout into subprocess.run and treat TimeoutExpired as None.
    expect(worker).toMatch(/subprocess\.run\([\s\S]*?timeout=timeout/);
    expect(worker).toContain("subprocess.TimeoutExpired");
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
