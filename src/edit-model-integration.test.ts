// @vitest-environment jsdom
//
// In-engine integration check for Smart Edit Mode P1's load-bearing core: an edit on the
// notation model must round-trip cleanly through the REAL Verovio engine (serialize -> loadData
// -> render) and re-derive consistently. This complements the pure model tests (edit-model.test.ts)
// by proving the actual edit -> render loop the app runs, against the production grand-staff shape.
// jsdom gives DOMParser/XMLSerializer for the model; Verovio's WASM is embedded so it runs in node.

import { describe, it, expect, beforeAll } from "vitest";
import { loadVerovioToolkit, renderMusicXml } from "./verovio-view";
import { parseScoreModel, buildHandleToVisIndex } from "./edit-model";
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
});
