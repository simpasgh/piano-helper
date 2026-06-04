// In-engine integration check for Smart Edit Mode P0: drive the REAL Verovio toolkit (the
// ~7MB WASM) through the same renderMusicXml path the app uses, against a production-shaped
// grand-staff OMR fixture. This is the committed proof that the Verovio substrate works
// (load -> render -> timemap -> id-based hit-testing -> id->VisNote mapping), complementing the
// pure-logic unit tests in verovio-view.test.ts. It runs under vitest's default node env (the
// WASM binary is embedded in the .mjs, so no separate fetch is needed). The browser is still
// where the visual render is verified; this pins the data contract.

import { describe, it, expect, beforeAll } from "vitest";
import { renderMusicXml, type VerovioRender } from "./verovio-view";
import { loadVerovioToolkit } from "./verovio-view";
import type { VisNote } from "./visualizer";

// A 1-part / 2-staff grand staff (the shape omr-worker emits): treble G/2 RH + bass F/4 LH, with
// a <backup> between staves and a 3-note LH chord. Mirrors the spike fixture's structure at a
// smaller size so the test stays fast. Tempo is the default 120 (matches score.ts), so the
// timemap ms and a VisNote's seconds agree.
const GRAND_STAFF_XML = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>2</divisions>
        <key><fifths>0</fifths></key>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        <staves>2</staves>
        <clef number="1"><sign>G</sign><line>2</line></clef>
        <clef number="2"><sign>F</sign><line>4</line></clef>
      </attributes>
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>2</duration><voice>1</voice><type>quarter</type><staff>1</staff></note>
      <note><pitch><step>D</step><octave>5</octave></pitch><duration>2</duration><voice>1</voice><type>quarter</type><staff>1</staff></note>
      <note><pitch><step>E</step><octave>5</octave></pitch><duration>2</duration><voice>1</voice><type>quarter</type><staff>1</staff></note>
      <note><pitch><step>F</step><octave>5</octave></pitch><duration>2</duration><voice>1</voice><type>quarter</type><staff>1</staff></note>
      <backup><duration>8</duration></backup>
      <note><pitch><step>C</step><octave>3</octave></pitch><duration>8</duration><voice>2</voice><type>whole</type><staff>2</staff></note>
      <note><chord/><pitch><step>E</step><octave>3</octave></pitch><duration>8</duration><voice>2</voice><type>whole</type><staff>2</staff></note>
      <note><chord/><pitch><step>G</step><octave>3</octave></pitch><duration>8</duration><voice>2</voice><type>whole</type><staff>2</staff></note>
    </measure>
  </part>
</score-partwise>`;

// The VisNote[] the app would build from this score (4 RH quarters at 0/0.5/1/1.5s + a 3-note LH
// whole chord at 0s). At 120bpm a quarter = 0.5s. We construct it directly so the mapping test
// does not depend on OSMD (which needs a real canvas to extract). MIDI: C5=72,D5=74,E5=76,F5=77,
// C3=48,E3=52,G3=55.
const visNotes: VisNote[] = [
  { midi: 72, time: 0, duration: 0.5, hand: "right" },
  { midi: 74, time: 0.5, duration: 0.5, hand: "right" },
  { midi: 76, time: 1, duration: 0.5, hand: "right" },
  { midi: 77, time: 1.5, duration: 0.5, hand: "right" },
  { midi: 48, time: 0, duration: 2, hand: "left" },
  { midi: 52, time: 0, duration: 2, hand: "left" },
  { midi: 55, time: 0, duration: 2, hand: "left" },
];

describe("Verovio in-engine integration (Smart Edit P0)", () => {
  let render: VerovioRender;

  beforeAll(async () => {
    const toolkit = await loadVerovioToolkit();
    render = renderMusicXml(toolkit, GRAND_STAFF_XML, visNotes, 800);
  }, 60000);

  it("loads and renders to an SVG with one <g class=\"note\"> per notehead", () => {
    // 4 RH + 3 LH = 7 noteheads.
    const noteGroups = (render.svg.match(/class="note"/g) ?? []).length;
    expect(noteGroups).toBe(7);
    expect(render.pageCount).toBeGreaterThanOrEqual(1);
  });

  it("extracts 7 notes each with a stable id, onset, and MIDI pitch", () => {
    expect(render.notes).toHaveLength(7);
    for (const n of render.notes) {
      expect(typeof n.id).toBe("string");
      expect(n.id.length).toBeGreaterThan(0);
      expect(n.timeSec).toBeGreaterThanOrEqual(0);
      expect(n.midi).toBeGreaterThanOrEqual(21);
      expect(n.midi).toBeLessThanOrEqual(108);
    }
    // The pitch set Verovio reports must equal the fixture's seven MIDI pitches.
    expect(render.notes.map((n) => n.midi).sort((a, b) => a - b)).toEqual([
      48, 52, 55, 72, 74, 76, 77,
    ]);
  });

  it("derives stepTimes covering the four RH onsets plus the end-of-measure stop", () => {
    // The LH whole-note shares onset 0 with the first RH note, so the unique NOTE onsets are the
    // four quarter-note starts (0, 0.5, 1, 1.5s). renderToTimemap is called with includeMeasures,
    // so the timemap also carries the measure-boundary marker at 2.0s (the end of the single 4/4
    // bar = the score duration); timemapStepTimes keeps it as a valid cursor stop. This is the
    // Verovio analogue of score.ts stepTimes[].
    expect(render.stepTimes).toEqual([0, 0.5, 1, 1.5, 2]);
  });

  it("every rendered note id resolves to a DOM <g> id present in the SVG", () => {
    // Closes the time->element->DOM loop the click hit-test relies on.
    for (const n of render.notes) {
      expect(render.svg).toContain(`id="${n.id}"`);
    }
  });

  it("maps every notehead id back to the matching VisNote (chord members disambiguated by pitch)", () => {
    // All 7 ids map (no ties in this fixture), and the mapped VisNote has the same MIDI pitch as
    // the Verovio note: proof the staff click and the falling-notes model stay consistent.
    expect(render.idToVisIndex.size).toBe(7);
    for (const n of render.notes) {
      const index = render.idToVisIndex.get(n.id);
      expect(index).toBeDefined();
      expect(visNotes[index!].midi).toBe(n.midi);
    }
  });

  it("round-trips the score through MEI without dropping notes (getMEI preserves content)", () => {
    // The spike's round-trip-fidelity property in miniature: re-loading the exported MEI yields
    // the same seven notes, so un-edited content survives the render engine.
    const mei = render.toolkit.getMEI();
    expect(mei).toContain("<note");
    render.toolkit.loadData(mei);
    render.toolkit.renderToMIDI();
    const reSvg = render.toolkit.renderToSVG(1);
    expect((reSvg.match(/class="note"/g) ?? []).length).toBe(7);
    // Restore the original render so other tests (order-independent) still see the XML load.
    render.toolkit.loadData(GRAND_STAFF_XML);
    render.toolkit.renderToMIDI();
  });
});
