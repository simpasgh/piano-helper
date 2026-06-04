// Score export helpers: download the current score as MusicXML, or render its Verovio engraving
// to a (possibly multi-page) PDF. Both are fully client-side, no service, mirroring the video
// export (recorder.ts). The video path lives in main.ts; these two formats are isolated here.
//
// The PURE helpers (chooseExportXml, the MIME + Blob, buildPdfToolkitOptions, fitContain,
// svgPixelSize) carry the unit-testable logic; the PDF render glue is browser-only (it needs the
// DOM to measure SVG glyph boxes) and is smoke-checked in a real browser. jsPDF + svg2pdf.js are
// lazy-imported inside the render so they stay out of the main bundle.

// Official media type for uncompressed MusicXML (the .musicxml extension), used for the download Blob.
export const MUSICXML_MIME = "application/vnd.recordare.musicxml+xml";

// Pick which MusicXML to export. Prefer the LIVE edited model's serialization when edit mode is on,
// so a user's in-progress edits are what downloads; otherwise the retained source MusicXML. Returns
// null when neither exists (an audio-only score has no engravable source), which the caller uses to
// keep the PDF + MusicXML items disabled.
export function chooseExportXml(opts: {
  editMode: boolean;
  editedXml: string | null; // scoreModel?.serialize() when in edit mode, else null
  sourceMusicXml: string | null;
}): string | null {
  if (opts.editMode && opts.editedXml) return opts.editedXml;
  return opts.sourceMusicXml;
}

// A Blob for the .musicxml download (UTF-8 text, official MusicXML media type).
export function musicXmlBlob(xml: string): Blob {
  return new Blob([xml], { type: MUSICXML_MIME });
}

// jsPDF A4-portrait page size in points (1/72 inch): 210mm x 297mm. svg2pdf draws each page into this.
export const PDF_PAGE_PT = { width: 595.28, height: 841.89 } as const;

// Verovio engraving scale for the PDF (percent of natural staff size). Matches the on-screen edit
// engraving (VEROVIO_SCALE = 50) so the printed page reads like what the user sees in edit mode.
export const PDF_SCALE = 50;

// Verovio render options that PAGINATE the score into A4-portrait pages, so a long score yields a
// multi-page PDF. pageWidth/pageHeight are Verovio units (rendered px = units * scale / 100); we size
// them so each page's SVG carries the A4-portrait aspect, and turn OFF adjustPageHeight so the layout
// breaks into full pages instead of one tall scroll page (the edit view uses one tall page on purpose;
// a printed score wants real page breaks). `header: "auto"` keeps the work title when the score has it.
export function buildPdfToolkitOptions(): Record<string, unknown> {
  // A4 portrait at ~96dpi in px, mapped to Verovio units via units = px * 100 / scale.
  const pageWpx = 794;
  const pageHpx = 1123;
  return {
    pageWidth: Math.round((pageWpx * 100) / PDF_SCALE),
    pageHeight: Math.round((pageHpx * 100) / PDF_SCALE),
    scale: PDF_SCALE,
    adjustPageHeight: false, // full A4 pages so a long score paginates into multiple PDF pages
    breaks: "auto",
    footer: "none",
    header: "auto",
    pageMarginLeft: 100,
    pageMarginRight: 100,
    pageMarginTop: 100,
    pageMarginBottom: 100,
  };
}

// Uniform CONTAIN-fit a (svgW x svgH) page into a (pageW x pageH) box, centered, so the engraving
// never distorts (uniform scale) and never overflows the PDF page. Returns the draw rect for svg2pdf.
export function fitContain(
  svgW: number,
  svgH: number,
  pageW: number,
  pageH: number,
): { x: number; y: number; width: number; height: number } {
  if (svgW <= 0 || svgH <= 0) return { x: 0, y: 0, width: pageW, height: pageH };
  const scale = Math.min(pageW / svgW, pageH / svgH);
  const width = svgW * scale;
  const height = svgH * scale;
  return { x: (pageW - width) / 2, y: (pageH - height) / 2, width, height };
}

// The px width/height a Verovio page SVG declares (stripping any unit suffix); falls back to the
// viewBox's w/h, then to the A4 box. Pure DOM-light parsing, so the fit math is testable.
export function svgPixelSize(svg: SVGSVGElement): { width: number; height: number } {
  const w = parseFloat(svg.getAttribute("width") || "");
  const h = parseFloat(svg.getAttribute("height") || "");
  if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) return { width: w, height: h };
  const vb = (svg.getAttribute("viewBox") || "").split(/[\s,]+/).map(Number);
  if (vb.length === 4 && vb[2] > 0 && vb[3] > 0) return { width: vb[2], height: vb[3] };
  return { width: PDF_PAGE_PT.width, height: PDF_PAGE_PT.height };
}

// The minimal Verovio toolkit surface the PDF render needs (so a fake can stand in for a test). The
// app passes the real VerovioToolkit, whose loadData/renderToSVG/getPageCount match these signatures.
export interface PdfToolkit {
  setOptions(options: Record<string, unknown>): void;
  loadData(xml: string): boolean | void;
  getPageCount(): number;
  renderToSVG(page: number): string;
}

// Render the score's Verovio engraving to a multi-page PDF Blob. Loads `xml` into `toolkit` with the
// paginating options, then for each page parses the page SVG into a hidden off-screen host (svg2pdf
// needs an ATTACHED element so getBBox can measure text/glyph boxes) and draws it, contain-fit, into a
// jsPDF page. Browser-only; jsPDF + svg2pdf.js are lazy-imported so the main bundle stays lean. `doc`
// is injected to keep the function from hard-binding the global document.
export async function renderMusicXmlToPdfBlob(
  toolkit: PdfToolkit,
  xml: string,
  doc: Document = document,
): Promise<Blob> {
  const [jspdf, svg2pdfMod] = await Promise.all([import("jspdf"), import("svg2pdf.js")]);
  const JsPdfCtor = jspdf.jsPDF;
  // svg2pdf.js exposes a named `svg2pdf`; tolerate a default-wrapped interop build too.
  const svg2pdf = svg2pdfMod.svg2pdf ?? (svg2pdfMod as unknown as { default: typeof svg2pdfMod.svg2pdf }).default;

  toolkit.setOptions(buildPdfToolkitOptions());
  toolkit.loadData(xml);
  const pageCount = Math.max(1, toolkit.getPageCount());

  const pdf = new JsPdfCtor({ orientation: "portrait", unit: "pt", format: "a4" });
  const pageW = pdf.internal.pageSize.getWidth();
  const pageH = pdf.internal.pageSize.getHeight();

  // An off-screen, zero-impact host the SVG attaches to so svg2pdf can measure it. Kept out of layout
  // (fixed, far off-screen) and torn down in finally so a render error never leaks a node.
  const host = doc.createElement("div");
  host.setAttribute("aria-hidden", "true");
  host.style.cssText =
    "position:fixed;left:-10000px;top:0;width:0;height:0;overflow:hidden;opacity:0;pointer-events:none;";
  doc.body.appendChild(host);
  try {
    for (let page = 1; page <= pageCount; page++) {
      if (page > 1) pdf.addPage();
      host.innerHTML = toolkit.renderToSVG(page);
      const svg = host.querySelector("svg");
      if (!svg) continue;
      const { width, height } = svgPixelSize(svg as SVGSVGElement);
      const rect = fitContain(width, height, pageW, pageH);
      await svg2pdf(svg, pdf, rect);
    }
  } finally {
    host.remove();
  }
  return pdf.output("blob");
}
