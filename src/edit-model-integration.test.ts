// @vitest-environment jsdom
//
// In-engine integration check for Smart Edit Mode P1's load-bearing core: an edit on the
// notation model must round-trip cleanly through the REAL Verovio engine (serialize -> loadData
// -> render) and re-derive consistently. This complements the pure model tests (edit-model.test.ts)
// by proving the actual edit -> render loop the app runs, against the production grand-staff shape.
// jsdom gives DOMParser/XMLSerializer for the model; Verovio's WASM is embedded so it runs in node.

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadVerovioToolkit, renderMusicXml, buildRestIndexToId } from "./verovio-view";
import { parseScoreModel, buildHandleToVisIndex, midiFromPitch } from "./edit-model";
import type { VerovioToolkit } from "verovio/esm";
import type { VisNote } from "./visualizer";

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

const visNotes: VisNote[] = [
  { midi: 72, time: 0, duration: 0.5, hand: "right" },
  { midi: 74, time: 0.5, duration: 0.5, hand: "right" },
  { midi: 76, time: 1, duration: 0.5, hand: "right" },
  { midi: 77, time: 1.5, duration: 0.5, hand: "right" },
  { midi: 48, time: 0, duration: 2, hand: "left" },
  { midi: 52, time: 0, duration: 2, hand: "left" },
  { midi: 55, time: 0, duration: 2, hand: "left" },
];

describe("Smart Edit P1 model <-> Verovio round-trip", () => {
  let toolkit: VerovioToolkit;
  beforeAll(async () => {
    toolkit = await loadVerovioToolkit();
  }, 60000);

  it("a model pitch edit re-renders the staff at the NEW pitch (Verovio reads it back)", () => {
    const model = parseScoreModel(GRAND_STAFF_XML);
    // Raise the first RH note C5 -> E5 (diatonic, two steps) by setting the model pitch.
    model.setPitch(0, { step: "E", octave: 5, alter: 0 });
    const render = renderMusicXml(toolkit, model.serialize(), visNotes, 800);
    // Verovio still lays out 7 noteheads...
    expect(render.notes).toHaveLength(7);
    // ...and the pitch at onset 0 on the top staff is now E5 (MIDI 76), not C5 (72). The onset-0
    // pitches are the edited RH note + the 3 LH chord notes (48,52,55); 72 must be gone, 76 added
    // (76 also already existed as the 3rd RH note, so assert 72 is absent and the multiset shifted).
    const midis = render.notes.map((n) => n.midi).sort((a, b) => a - b);
    expect(midis).not.toContain(72); // the old C5 is gone
    expect(midis).toEqual([48, 52, 55, 74, 76, 76, 77]); // C5->E5: now two 76s (the edited + original E5)
  });

  it("serialize round-trips a sharp edit so Verovio engraves the accidental", () => {
    const model = parseScoreModel(GRAND_STAFF_XML);
    model.setPitch(0, { step: "F", octave: 5, alter: 1 }); // C5 -> F#5
    const xml = model.serialize();
    const render = renderMusicXml(toolkit, xml, visNotes, 800);
    // F#5 = MIDI 78; it must appear in the rendered pitches.
    expect(render.notes.map((n) => n.midi)).toContain(78);
  });

  it("re-maps handle -> VisNote by the new (midi, onset) after an edit (selection follows)", () => {
    const model = parseScoreModel(GRAND_STAFF_XML);
    model.setPitch(0, { step: "D", octave: 5, alter: 0 }); // C5 -> D5; onset unchanged
    // The app re-derives the falling notes from the model: slot 0 is now D5 (74) at time 0.
    const editedVis = visNotes.slice();
    editedVis[0] = { ...editedVis[0], midi: 74 };
    const map = buildHandleToVisIndex(model.handles, editedVis);
    // Handle 0 still maps to VisNote 0 (its onset never moved, only its pitch).
    expect(map.get(0)).toBe(0);
  });

  it("a model DELETE drops the note from the render (rest engraves) and round-trips on restore", () => {
    const model = parseScoreModel(GRAND_STAFF_XML);
    // Delete the 2nd RH quarter (D5, MIDI 74, handle 1). It becomes a rest of the same duration.
    const rec = model.deleteNote(1);
    expect(rec).not.toBeNull();
    // The falling notes the app re-derives drop that VisNote (index 1), so render with 6 notes.
    const editedVis = visNotes.filter((_, i) => i !== 1);
    const render = renderMusicXml(toolkit, model.serialize(), editedVis, 800);
    // Verovio now lays out 6 noteheads (the rest is not a note <g>), and D5 (74) is gone.
    expect(render.notes).toHaveLength(6);
    expect(render.notes.map((n) => n.midi)).not.toContain(74);
    // Restore brings D5 back: a fresh render lays out all 7 again with 74 present.
    model.restoreNote(rec!);
    const restored = renderMusicXml(toolkit, model.serialize(), visNotes, 800);
    expect(restored.notes).toHaveLength(7);
    expect(restored.notes.map((n) => n.midi)).toContain(74);
  });
});

// ----- ADD-a-note v1: rest mapping + addNote round-trip through the REAL engine -----

// RH: C5, D5, a QUARTER REST on beat 3, F5. LH: whole C3. The rest is the convertible target.
const REST_XML = `<?xml version="1.0" encoding="UTF-8"?>
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
      <note><rest/><duration>2</duration><voice>1</voice><type>quarter</type><staff>1</staff></note>
      <note><pitch><step>F</step><octave>5</octave></pitch><duration>2</duration><voice>1</voice><type>quarter</type><staff>1</staff></note>
      <backup><duration>8</duration></backup>
      <note><pitch><step>C</step><octave>3</octave></pitch><duration>8</duration><voice>2</voice><type>whole</type><staff>2</staff></note>
    </measure>
  </part>
</score-partwise>`;

const restVis: VisNote[] = [
  { midi: 72, time: 0, duration: 0.5, hand: "right" },
  { midi: 74, time: 0.5, duration: 0.5, hand: "right" },
  { midi: 77, time: 1.5, duration: 0.5, hand: "right" },
  { midi: 48, time: 0, duration: 2, hand: "left" },
];

describe("Smart Edit ADD-a-note v1 model <-> Verovio round-trip", () => {
  let toolkit: VerovioToolkit;
  beforeAll(async () => {
    toolkit = await loadVerovioToolkit();
  }, 60000);

  it("maps the model rest handle to a Verovio rest glyph by (onset, staff)", () => {
    const model = parseScoreModel(REST_XML);
    expect(model.restHandles).toHaveLength(1);
    const render = renderMusicXml(toolkit, model.serialize(), restVis, 800);
    // Verovio lays out exactly one rest glyph, timed at the rest's onset (1.0s) on staff 1.
    expect(render.rests).toHaveLength(1);
    expect(render.rests[0].timeSec).toBeCloseTo(1.0, 3);
    expect(render.rests[0].staff).toBe(1);
    // The model rest maps to that glyph id (so a selection can find + halo it).
    const map = buildRestIndexToId(render.rests, model.restHandles);
    expect(map.size).toBe(1);
    expect(map.get(0)).toBe(render.rests[0].id);
  });

  it("addNote fills the rest with a note Verovio renders; removeNote restores the rest", () => {
    const model = parseScoreModel(REST_XML);
    const rec = model.addNote(0, { step: "E", octave: 5, alter: 0 }); // fill with E5 (MIDI 76)
    expect(rec).not.toBeNull();
    // The app re-derives the falling notes WITH the new E5 at time 1.0.
    const addedVis = [...restVis, { midi: 76, time: 1.0, duration: 0.5, hand: "right" as const }];
    const render = renderMusicXml(toolkit, model.serialize(), addedVis, 800);
    // Verovio now lays out 5 noteheads (E5 added) and NO rest (the gap is filled).
    expect(render.notes).toHaveLength(5);
    expect(render.notes.map((n) => n.midi)).toContain(midiFromPitch({ step: "E", octave: 5, alter: 0 }));
    expect(render.rests).toHaveLength(0);
    // Undo: the rest is back and the note is gone.
    model.removeNote(rec!);
    const restored = renderMusicXml(toolkit, model.serialize(), restVis, 800);
    expect(restored.notes).toHaveLength(4);
    expect(restored.rests).toHaveLength(1);
    expect(restored.notes.map((n) => n.midi)).not.toContain(76);
  });
});

// ----- ADD-a-note v1 REGRESSION: a rest in a MULTI-MEASURE score must still map (issue: the
// rest-glyph click was a no-op on the shipped demo). Two independent bugs broke this for any score
// with more than one measure, and every prior fixture was single-measure so neither was caught:
//   1. The model computed onsets MEASURE-RELATIVE (the cursor reset to 0 each measure), while the
//      VisNote[] and the Verovio timemap are ABSOLUTE from the score start. A rest in measure N>1
//      therefore had the wrong onsetSec and never keyed to its glyph.
//   2. restStavesFromSvg counted `<g class="staff">` groups DOCUMENT-WIDE, but Verovio emits one
//      staff group per measure, so the count was the system/measure index (e.g. "staff 4" for a
//      rest in the 4th measure of a single-staff score) instead of the musical staff number.
// These tests load the ACTUAL public/demo.musicxml (single staff, 4 measures, trailing rest) and a
// 2-staff multi-measure case, and assert the rest maps + round-trips through fill.

const DEMO_XML = readFileSync(join(process.cwd(), "public", "demo.musicxml"), "utf8");

// The C major scale the demo engraves: absolute seconds at 120bpm (quarter = 0.5s). 15 pitched
// notes; the trailing half rest is on beat 3 of measure 4 (over-full bar in the shipped file).
const DEMO_VIS: VisNote[] = [60, 62, 64, 65, 67, 69, 71, 72, 71, 69, 67, 65, 64, 62, 60].map(
  (midi, i) => ({ midi, time: i * 0.5, duration: i === 14 ? 1.0 : 0.5, hand: "right" as const }),
);

describe("ADD-a-note v1 regression: rest mapping in a multi-measure score", () => {
  let toolkit: VerovioToolkit;
  beforeAll(async () => {
    toolkit = await loadVerovioToolkit();
  }, 60000);

  it("maps the trailing rest of the REAL demo (measure 4, single staff) to its glyph", () => {
    const model = parseScoreModel(DEMO_XML);
    // The demo has exactly one rest, on staff 1. Its onset is ABSOLUTE (measures 1-3 = 12 quarters
    // = 6.0s, plus its within-measure offset), NOT the measure-relative 2.0s the old walk produced.
    expect(model.restHandles).toHaveLength(1);
    expect(model.restHandles[0].staff).toBe(1);
    expect(model.restHandles[0].onsetSec).toBeGreaterThan(6); // absolute, well past a single bar

    const render = renderMusicXml(toolkit, model.serialize(), DEMO_VIS, 800);
    expect(render.rests).toHaveLength(1);
    // The Verovio rest is on the MUSICAL staff 1 (within-measure ordinal), not "staff 4" (the old
    // document-wide staff-group count), and its onset equals the model's.
    expect(render.rests[0].staff).toBe(1);
    expect(render.rests[0].timeSec).toBeCloseTo(model.restHandles[0].onsetSec, 3);

    // The map is non-empty and the model rest resolves to that glyph id (the click can now select).
    const map = buildRestIndexToId(render.rests, model.restHandles);
    expect(map.size).toBe(1);
    expect(map.get(0)).toBe(render.rests[0].id);
  });

  it("round-trips the demo rest through fill: addNote engraves a note, removeNote restores the rest", () => {
    const model = parseScoreModel(DEMO_XML);
    const restOnset = model.restHandles[0].onsetSec;
    const rec = model.addNote(0, { step: "G", octave: 4, alter: 0 }); // fill with G4 (MIDI 67)
    expect(rec).not.toBeNull();
    expect(model.restHandles).toHaveLength(0);
    // The added note sits at the rest's absolute onset.
    const added = model.handles.find((h) => Math.abs(h.onsetSec - restOnset) < 1e-3 && h.midi === 67);
    expect(added).toBeDefined();

    // The app re-derives the falling notes WITH the new G4 at the rest's onset.
    const filledVis = [...DEMO_VIS, { midi: 67, time: restOnset, duration: 1.0, hand: "right" as const }];
    const filled = renderMusicXml(toolkit, model.serialize(), filledVis, 800);
    expect(filled.rests).toHaveLength(0); // the gap is filled
    expect(filled.notes.map((n) => n.midi)).toContain(67);

    // Undo: the rest comes back and maps again (proves restore + re-map round-trips cleanly).
    model.removeNote(rec!);
    expect(model.restHandles).toHaveLength(1);
    const restored = renderMusicXml(toolkit, model.serialize(), DEMO_VIS, 800);
    expect(restored.rests).toHaveLength(1);
    const remap = buildRestIndexToId(restored.rests, model.restHandles);
    expect(remap.get(0)).toBe(restored.rests[0].id);
  });

  it("disambiguates a rest by staff in a 2-staff, multi-measure score (staff != document order)", () => {
    // Measure 2 has a half rest on STAFF 2. The correct staff is 2; a document-wide staff-group
    // count would say 4 (m1.s1, m1.s2, m2.s1, m2.s2). The onset is absolute (measure 2 starts at
    // 2.0s, the rest at +1.0s = 3.0s), not the measure-relative 1.0s.
    const GRAND_MULTI = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>1</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><staves>2</staves>
        <clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef></attributes>
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><type>whole</type><staff>1</staff></note>
      <backup><duration>4</duration></backup>
      <note><pitch><step>C</step><octave>3</octave></pitch><duration>4</duration><voice>2</voice><type>whole</type><staff>2</staff></note>
    </measure>
    <measure number="2">
      <note><pitch><step>D</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><type>whole</type><staff>1</staff></note>
      <backup><duration>4</duration></backup>
      <note><pitch><step>C</step><octave>3</octave></pitch><duration>2</duration><voice>2</voice><type>half</type><staff>2</staff></note>
      <note><rest/><duration>2</duration><voice>2</voice><type>half</type><staff>2</staff></note>
    </measure>
  </part>
</score-partwise>`;
    const model = parseScoreModel(GRAND_MULTI);
    expect(model.restHandles).toHaveLength(1);
    expect(model.restHandles[0].staff).toBe(2);
    expect(model.restHandles[0].onsetSec).toBeCloseTo(3.0, 3); // absolute, not 1.0

    const render = renderMusicXml(toolkit, model.serialize(), [], 800);
    expect(render.rests).toHaveLength(1);
    expect(render.rests[0].staff).toBe(2); // musical staff, not the document-order count (4)
    expect(render.rests[0].timeSec).toBeCloseTo(3.0, 3);

    const map = buildRestIndexToId(render.rests, model.restHandles);
    expect(map.get(0)).toBe(render.rests[0].id);
  });
});
