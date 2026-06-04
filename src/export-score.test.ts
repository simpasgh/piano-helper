// @vitest-environment jsdom
//
// Unit tests for the score-export helpers (Export PDF + Export MusicXML). The jsdom env gives us
// Blob, DOMParser/XMLSerializer, and SVG elements so the pure logic runs without a browser. The PDF
// DOM/render glue (renderMusicXmlToPdfBlob) needs real getBBox + jsPDF, so it is smoke-checked in a
// browser, not here; everything it is built from is covered below.

import { describe, it, expect } from "vitest";
import {
  chooseExportXml,
  musicXmlBlob,
  MUSICXML_MIME,
  fitContain,
  svgPixelSize,
  buildPdfToolkitOptions,
  PDF_SCALE,
} from "./export-score";
import { parseScoreModel } from "./edit-model";

// 4 RH quarters (C5 D5 E5 F5), single staff/voice, default tempo. Enough to prove the export content
// (the model's serialization) round-trips back into a parseable, pitch-identical score.
const SAMPLE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>2</divisions>
        <key><fifths>0</fifths></key>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        <clef><sign>G</sign><line>2</line></clef>
      </attributes>
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>2</duration><voice>1</voice><type>quarter</type></note>
      <note><pitch><step>D</step><octave>5</octave></pitch><duration>2</duration><voice>1</voice><type>quarter</type></note>
      <note><pitch><step>E</step><octave>5</octave></pitch><duration>2</duration><voice>1</voice><type>quarter</type></note>
      <note><pitch><step>F</step><octave>5</octave></pitch><duration>2</duration><voice>1</voice><type>quarter</type></note>
    </measure>
  </part>
</score-partwise>`;

describe("chooseExportXml", () => {
  it("prefers the edited model's serialization in edit mode", () => {
    expect(
      chooseExportXml({ editMode: true, editedXml: "<edited/>", sourceMusicXml: "<source/>" }),
    ).toBe("<edited/>");
  });

  it("falls back to the source when not in edit mode", () => {
    expect(
      chooseExportXml({ editMode: false, editedXml: "<edited/>", sourceMusicXml: "<source/>" }),
    ).toBe("<source/>");
  });

  it("falls back to the source when in edit mode but the model has no serialization", () => {
    expect(chooseExportXml({ editMode: true, editedXml: null, sourceMusicXml: "<source/>" })).toBe(
      "<source/>",
    );
  });

  it("returns null for an audio-only score (no source, no model)", () => {
    expect(chooseExportXml({ editMode: false, editedXml: null, sourceMusicXml: null })).toBeNull();
  });
});

describe("musicXmlBlob", () => {
  it("wraps the xml in a Blob with the MusicXML media type", async () => {
    const blob = musicXmlBlob(SAMPLE_XML);
    expect(blob.type).toBe(MUSICXML_MIME);
    expect(await blob.text()).toBe(SAMPLE_XML);
  });
});

describe("MusicXML export round-trips through the model", () => {
  // The exported MusicXML must be valid, parseable, and stable: parsing it, re-serializing, and
  // re-parsing yields the same pitched notes. This exercises the actual edit-mode export content
  // (scoreModel.serialize()) and guards against an export emitting MusicXML Verovio cannot read back.
  it("preserves the pitched notes across parse -> serialize -> parse", () => {
    const first = parseScoreModel(SAMPLE_XML);
    const firstMidi = first.handles.map((h) => h.midi);
    expect(firstMidi).toEqual([72, 74, 76, 77]); // C5 D5 E5 F5

    const reExported = first.serialize();
    const second = parseScoreModel(reExported);
    expect(second.handles.map((h) => h.midi)).toEqual(firstMidi);
  });
});

describe("fitContain", () => {
  it("scales a tall page to be height-bound, centered horizontally", () => {
    const r = fitContain(100, 200, 100, 100); // aspect 0.5 into a square
    expect(r.height).toBeCloseTo(100);
    expect(r.width).toBeCloseTo(50);
    expect(r.x).toBeCloseTo(25);
    expect(r.y).toBeCloseTo(0);
  });

  it("scales a wide page to be width-bound, centered vertically", () => {
    const r = fitContain(200, 100, 100, 100);
    expect(r.width).toBeCloseTo(100);
    expect(r.height).toBeCloseTo(50);
    expect(r.x).toBeCloseTo(0);
    expect(r.y).toBeCloseTo(25);
  });

  it("never overflows the page box (A4 from an A4-aspect svg)", () => {
    const r = fitContain(794, 1123, 595.28, 841.89);
    expect(r.width).toBeLessThanOrEqual(595.28 + 1e-6);
    expect(r.height).toBeLessThanOrEqual(841.89 + 1e-6);
  });

  it("falls back to the full box for a degenerate (zero) svg size", () => {
    expect(fitContain(0, 0, 595, 842)).toEqual({ x: 0, y: 0, width: 595, height: 842 });
  });
});

describe("svgPixelSize", () => {
  function svgWith(attrs: Record<string, string>): SVGSVGElement {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    for (const [k, v] of Object.entries(attrs)) svg.setAttribute(k, v);
    return svg as SVGSVGElement;
  }

  it("reads explicit px width/height (stripping a unit suffix)", () => {
    expect(svgPixelSize(svgWith({ width: "794px", height: "1123px" }))).toEqual({
      width: 794,
      height: 1123,
    });
  });

  it("falls back to the viewBox when width/height are absent", () => {
    expect(svgPixelSize(svgWith({ viewBox: "0 0 640 480" }))).toEqual({ width: 640, height: 480 });
  });

  it("falls back to the A4 box when neither is usable", () => {
    const r = svgPixelSize(svgWith({}));
    expect(r.width).toBeCloseTo(595.28);
    expect(r.height).toBeCloseTo(841.89);
  });
});

describe("buildPdfToolkitOptions", () => {
  const opts = buildPdfToolkitOptions();

  it("paginates into full pages (adjustPageHeight off, auto breaks, the screen scale)", () => {
    expect(opts.adjustPageHeight).toBe(false);
    expect(opts.breaks).toBe("auto");
    expect(opts.scale).toBe(PDF_SCALE);
  });

  it("sizes the page so the SVG px maps back to the A4-portrait target", () => {
    // Rendered px = units * scale / 100, so this recovers the ~794 x 1123 px A4 target.
    const wpx = (Number(opts.pageWidth) * PDF_SCALE) / 100;
    const hpx = (Number(opts.pageHeight) * PDF_SCALE) / 100;
    expect(wpx).toBeCloseTo(794, 0);
    expect(hpx).toBeCloseTo(1123, 0);
    expect(hpx).toBeGreaterThan(wpx); // portrait
  });
});
