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
const reconcile = readFileSync(`${root}omr-worker/reconcile.py`, "utf8");

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
    // process_job branches on the flag: ensemble path when the flag is ON, otherwise the
    // legacy single-engine path.
    expect(worker).toMatch(
      /if ensemble_enabled\(\):\s*\n\s*result_path, source = _select_ensemble\(/,
    );
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
    // else homr, else sentinel). Slice 3 needs BOTH engine outputs to reconcile, so the
    // concurrent launcher is now run_primary_engines (returns both paths); select_primary_result
    // is retained as the Slice-1 selector and still unit-tested.
    expect(worker).toContain("is_pdf_input");
    expect(worker).toContain("def run_primary_engines(");
    expect(worker).toContain("def select_primary_result(");
    // The two primaries are launched on a thread pool (true wall-clock overlap on subprocs).
    expect(worker).toContain("import concurrent.futures");
    expect(worker).toMatch(/concurrent\.futures\.ThreadPoolExecutor/);
    // Clarity is launched ONLY for PDF input (it is PDF-only); oemer always.
    expect(worker).toMatch(/if is_pdf_input:\s*\n\s*futures\["clarity"\] = pool\.submit/);
    // Selection precedence in the ensemble flow: Clarity checked before oemer.
    const flow = worker.slice(
      worker.indexOf("def _select_ensemble("),
      worker.indexOf("def _reconcile_paths("),
    );
    const clarityPick = flow.indexOf('result_path, source = clarity_path, "clarity"');
    const oemerPick = flow.indexOf('result_path, source = oemer_path, "oemer"');
    expect(clarityPick).toBeGreaterThan(-1);
    expect(clarityPick).toBeLessThan(oemerPick);
    // homr stays the LAST resort, run in the ensemble path only after the concurrent
    // primaries both fail (result_path is None).
    const launch = flow.indexOf("run_primary_engines(");
    const homr = flow.indexOf("run_homr(image_path");
    expect(launch).toBeGreaterThan(-1);
    expect(launch).toBeLessThan(homr);
  });

  it("reconciles both engine outputs BEFORE merge/normalize when ensemble is on", () => {
    // Slice 3: when BOTH primaries produce output, _select_ensemble reconciles (clarity, oemer)
    // using Clarity as the skeleton, BEFORE the shared post-transforms. New order with the flag
    // on + both engines: reconcile -> merge_to_grand_staff -> normalize_ties -> put_object.
    expect(worker).toContain("import reconcile");
    expect(worker).toContain("def _reconcile_paths(");
    // Slice 6b threaded an optional input_pdf (the referee's rasterized original) through the
    // reconcile call; the kwarg defaults so single-engine and gate-off behavior is unchanged.
    expect(worker).toMatch(
      /reconcile\.reconcile\(primary_bytes,\s*secondary_bytes,\s*input_pdf=input_pdf\)/,
    );
    // Reconcile fires only when BOTH engine paths are present (single-engine = pass-through).
    expect(worker).toMatch(
      /clarity_path is not None and oemer_path is not None/,
    );
    // The reconcile call (inside _select_ensemble) precedes the post-transforms (in process_job).
    const reconcileCall = worker.indexOf("reconciled = _reconcile_paths(");
    const merge = worker.indexOf("body = merge_to_grand_staff(body)");
    const ties = worker.indexOf("body = normalize_ties(body)");
    expect(reconcileCall).toBeGreaterThan(-1);
    expect(reconcileCall).toBeLessThan(merge);
    expect(merge).toBeLessThan(ties);
  });

  it("threads the rasterized original to reconcile only behind the referee sub-gate (Slice 6b)", () => {
    // The visual-diff referee needs the original raster. _select_ensemble passes image_path into
    // _reconcile_paths, which loads it into an array ONLY when OMR_ENSEMBLE_REFEREE is on (gate
    // off -> input_pdf None -> byte-identical to Slice 4). The referee sub-gate lives in
    // reconcile.py, default OFF, and additionally requires the parent OMR_ENSEMBLE.
    expect(worker).toMatch(/_reconcile_paths\(\s*clarity_path,\s*oemer_path,\s*workdir,\s*image_path,\s*bbox_sink\.get\("artifact"\)\s*\)/);
    expect(worker).toContain("def _load_referee_raster(");
    expect(worker).toMatch(/reconcile\.referee_enabled\(\)/);
    expect(reconcile).toContain("OMR_ENSEMBLE_REFEREE_ENV");
    expect(reconcile).toContain("def referee_enabled(");
    // The referee is a residual tiebreaker: it only fires when the heuristic vote is residual.
    expect(reconcile).toContain("def _pitch_vote_is_residual(");
    expect(reconcile).toContain("def _maybe_referee_pitch(");
    // Localization is the documented blocker: the localizer returns None today (no-op referee).
    expect(reconcile).toContain("def _localize_dispute(");
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

  it("applies the three MusicXML post-transforms before put_object", () => {
    expect(worker).toContain("def merge_to_grand_staff(");
    expect(worker).toContain("def normalize_ties(");
    // The rhythm repair (omr-worker/rhythm_repair.py) is the FINAL post-transform: it reads the
    // already-merged grand staff + resolved ties and makes each measure's durations sum to the
    // time signature. It must run AFTER merge+normalize and before the put_object that writes.
    expect(worker).toContain("import rhythm_repair");
    const merge = worker.indexOf("body = merge_to_grand_staff(body)");
    const ties = worker.indexOf("body = normalize_ties(body)");
    const repair = worker.indexOf("body = rhythm_repair.repair_measure_durations(body)");
    const put = worker.indexOf("client.put_object(");
    expect(merge).toBeGreaterThan(-1);
    expect(merge).toBeLessThan(ties);
    expect(ties).toBeLessThan(repair);
    expect(repair).toBeLessThan(put);
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
