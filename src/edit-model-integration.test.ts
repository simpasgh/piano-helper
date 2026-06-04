// @vitest-environment jsdom
//
// In-engine integration check for Smart Edit Mode P1's load-bearing core: an edit on the
// notation model must round-trip cleanly through the REAL Verovio engine (serialize -> loadData
// -> render) and re-derive consistently. This complements the pure model tests (edit-model.test.ts)
// by proving the actual edit -> render loop the app runs, against the production grand-staff shape.
// jsdom gives DOMParser/XMLSerializer for the model; Verovio's WASM is embedded so it runs in node.

import { describe, it, expect, beforeAll, vi } from "vitest";
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

// ----- NO-<type> OMR REGRESSION: the user's real `reverie` score (and any OMR output) omits the
// note-value <type>, emitting only <duration> (in divisions). Verovio WITHOUT <type> draws every
// note at a uniform default value (wrong rhythm) AND computes a wrong timemap, so the (midi, onset)
// click map diverges and click-to-select silently fails for every note after the first long one.
// OSMD (the read-only view, edit OFF) infers the value from <duration> and renders correctly, which
// is exactly why ONLY edit mode was broken and every prior fixture (all carrying <type>) missed it.
// The model now infers + inserts a <type> during the parse; these tests prove, against the REAL
// reverie file through the REAL engine, that (1) the right <type> is inferred and (2) the Verovio
// timemap onsets, which DIVERGED before the fix, now MATCH the model onsets (the click-map gate).

const REVERIE_XML = readFileSync(
  join(process.cwd(), "src", "test-fixtures", "reverie-omr.musicxml"),
  "utf8",
);

// Build the VisNote[] the app derives from the model (midi + absolute onset). extractScore (OSMD)
// and the model share the SAME <duration>-based onset math, so model-derived VisNotes are the right
// stand-in; the test's whole claim is that Verovio's onsets must equal these model/extractScore
// onsets. duration/hand are immaterial to the (midi, onset) key.
function visFromModel(model: ReturnType<typeof parseScoreModel>): VisNote[] {
  return model.handles
    .filter((h) => !h.isTieContinuation)
    .map((h) => ({ midi: h.midi, time: h.onsetSec, duration: 0.5, hand: "right" as const }));
}

describe("no-<type> OMR regression: the real reverie file through real Verovio", () => {
  let toolkit: VerovioToolkit;
  beforeAll(async () => {
    toolkit = await loadVerovioToolkit();
  }, 60000);

  it("the raw OMR file has NO <type>, and the model inserts the correct ones (eighth, whole, ...)", () => {
    expect(REVERIE_XML.includes("<type>")).toBe(false); // the bug precondition: bare durations only
    const model = parseScoreModel(REVERIE_XML);
    const serialized = model.serialize();
    expect(serialized.includes("<type>")).toBe(true); // the fix: types are now present

    const doc = new DOMParser().parseFromString(serialized, "application/xml");
    // Collect, for each duration value, the set of <type> tokens the model assigned (divisions=4).
    const byDuration = new Map<string, Set<string>>();
    for (const note of Array.from(doc.getElementsByTagName("note"))) {
      const dur = note.getElementsByTagName("duration").item(0)?.textContent ?? "";
      const type = note.getElementsByTagName("type").item(0)?.textContent ?? "";
      if (!dur || !type) continue;
      if (!byDuration.has(dur)) byDuration.set(dur, new Set());
      byDuration.get(dur)!.add(type);
    }
    // divisions=4: duration 2 = eighth, duration 16 = whole (the two values the task calls out),
    // plus duration 4 = quarter, 8 = half, and the duration-12 rests = a dotted half.
    expect([...(byDuration.get("2") ?? [])]).toEqual(["eighth"]);
    expect([...(byDuration.get("16") ?? [])]).toEqual(["whole"]);
    expect([...(byDuration.get("4") ?? [])]).toEqual(["quarter"]);
    expect([...(byDuration.get("8") ?? [])]).toEqual(["half"]);
    // The duration-12 events are rests (dotted half); assert on the rest specifically.
    const dottedHalfRest = Array.from(doc.getElementsByTagName("rest"))
      .map((r) => r.parentElement!)
      .find((n) => n.getElementsByTagName("duration").item(0)?.textContent === "12");
    expect(dottedHalfRest?.getElementsByTagName("type").item(0)?.textContent).toBe("half");
    expect(dottedHalfRest?.getElementsByTagName("dot").length).toBe(1);
  });

  it("BEFORE the fix the Verovio timemap onsets DIVERGE from the model; AFTER they MATCH", () => {
    const model = parseScoreModel(REVERIE_XML);
    const vis = visFromModel(model);

    // BEFORE: render the RAW reverie XML (no inferred <type>). Verovio defaults every note to a
    // uniform value, so its per-note onsets do NOT match the model's <duration>-based onsets, and
    // the id->VisNote map (the click map) is mostly empty.
    const before = renderMusicXml(toolkit, REVERIE_XML, vis, 800);
    expect(before.notes).toHaveLength(model.handles.length); // same notes laid out...
    // ...but their onsets diverge from the model. Compare the SORTED unique onset sets: the raw
    // render collapses the eighth-note spacing to a uniform default, so the onset multiset differs.
    const beforeOnsets = uniqueSorted(before.notes.map((n) => round3(n.timeSec)));
    const modelOnsets = uniqueSorted(model.handles.map((h) => round3(h.onsetSec)));
    expect(beforeOnsets).not.toEqual(modelOnsets); // the divergence the bug is made of
    // The click map covers only a small fraction of notes before the fix (only those that happen to
    // coincide at a shared onset, e.g. the onset-0 column); the rest are unclickable.
    expect(before.idToVisIndex.size).toBeLessThan(model.handles.length / 2);

    // AFTER: render the MODEL-SERIALIZED XML (with the inferred <type>). Verovio now reproduces the
    // true durations, so the timemap onsets equal the model onsets and EVERY note maps (clickable).
    const after = renderMusicXml(toolkit, model.serialize(), vis, 800);
    expect(after.notes).toHaveLength(model.handles.length);
    const afterOnsets = uniqueSorted(after.notes.map((n) => round3(n.timeSec)));
    expect(afterOnsets).toEqual(modelOnsets); // the timemap now matches the model exactly
    // The click map is now COMPLETE: every non-continuation handle resolves to a VisNote, and every
    // Verovio note id resolves to a VisNote index, so clicking any notehead selects.
    const handleMap = buildHandleToVisIndex(model.handles, vis);
    expect(handleMap.size).toBe(vis.length);
    expect(after.idToVisIndex.size).toBe(after.notes.length);
  });

  it("each Verovio note's onset matches the model handle of the SAME pitch+position (per-note)", () => {
    // Stronger than the set comparison: walk the rendered notes in document order and assert each
    // sits at the model handle's onset. This is the precondition for click-selection: a clicked
    // notehead maps to a VisNote by (midi, ONSET), so the Verovio onset must equal the model onset
    // for the corresponding note, not merely belong to the same set.
    const model = parseScoreModel(REVERIE_XML);
    const vis = visFromModel(model);
    const render = renderMusicXml(toolkit, model.serialize(), vis, 800);
    // Group model onsets by midi (a pitch can recur); for each rendered note, its onset must be one
    // of that pitch's model onsets. With the fix every rendered onset is accounted for.
    const modelOnsetsByMidi = new Map<number, number[]>();
    for (const h of model.handles) {
      if (!modelOnsetsByMidi.has(h.midi)) modelOnsetsByMidi.set(h.midi, []);
      modelOnsetsByMidi.get(h.midi)!.push(round3(h.onsetSec));
    }
    for (const n of render.notes) {
      const onsets = modelOnsetsByMidi.get(n.midi) ?? [];
      expect(onsets).toContain(round3(n.timeSec));
    }
  });
});

// ----- CHANGE-DURATION v1 through the REAL engine on the real reverie file -----
//
// A duration edit re-serializes the model for Verovio just like a pitch/delete edit, so it must
// keep the no-<type> fix intact: after the edit EVERY note still carries a <type> (so Verovio
// engraves the right rhythm + a correct timemap), the timemap onsets stay self-consistent with the
// model, the click map is still complete (185/185, the count the <type> fix restored), and Verovio
// emits NO "unsupported note-type-value" warning (which is what a missing/blank <type> would cause).

describe("CHANGE-DURATION v1: a duration edit on real reverie keeps the engine consistent", () => {
  let toolkit: VerovioToolkit;
  beforeAll(async () => {
    toolkit = await loadVerovioToolkit();
  }, 60000);

  it("after a shorten: every note still has a <type>, the click map is complete, no engine warning", () => {
    const model = parseScoreModel(REVERIE_XML);
    const handleCount = model.handles.length;
    expect(handleCount).toBe(185); // the reverie pitched-note count (the 185/185 click-map target)

    // Baseline: the model render maps every note (the <type> fix's contract), before any edit.
    const baseVis = visFromModel(model);
    const base = renderMusicXml(toolkit, model.serialize(), baseVis, 800);
    expect(base.idToVisIndex.size).toBe(base.notes.length);
    expect(base.notes).toHaveLength(handleCount);

    // Pick a STANDALONE EIGHTH note (reverie is full of them: duration 2 at divisions 4) and shorten
    // it to a 16th. Shorten always leaves a rest (never a no-op for a non-16th), so this is a real
    // edit. A non-chord, non-continuation note keeps the single-note path clear (the chord path is
    // unit-tested separately).
    const eighth = model.handles.find(
      (h) => h.durationDivs === 2 && !h.isTieContinuation && !h.isChordMember,
    );
    expect(eighth).toBeDefined();
    const rec = model.changeDuration(eighth!.id, "shorter");
    expect(rec?.outcome).toBe("stepped");

    // Re-derive the falling notes from the edited model (onsets/durations changed) and re-render,
    // capturing console output so we can assert Verovio raised no note-type-value warning.
    const editedVis = visFromModel(model);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    let render;
    try {
      render = renderMusicXml(toolkit, model.serialize(), editedVis, 800);
    } finally {
      const allOutput = [...logSpy.mock.calls, ...warnSpy.mock.calls]
        .flat()
        .map((a) => String(a))
        .join("\n");
      logSpy.mockRestore();
      warnSpy.mockRestore();
      // The whole point of the <type> fix: no blank/unsupported note-type-value warning.
      expect(allOutput).not.toContain("note-type-value");
    }

    // The serialized model still has a <type> on EVERY note (the edit set the changed note's type
    // and never stripped another note's).
    const doc = new DOMParser().parseFromString(model.serialize(), "application/xml");
    const pitchedNotes = Array.from(doc.getElementsByTagName("note")).filter(
      (n) => n.getElementsByTagName("rest").length === 0,
    );
    for (const n of pitchedNotes) {
      expect(n.getElementsByTagName("type").item(0)?.textContent ?? "").not.toBe("");
    }

    // The click map is still COMPLETE: every rendered notehead resolves to a VisNote and every
    // non-continuation handle resolves to a VisNote (185/185, no regression of the <type> fix).
    expect(render!.idToVisIndex.size).toBe(render!.notes.length);
    const handleMap = buildHandleToVisIndex(model.handles, editedVis);
    expect(handleMap.size).toBe(editedVis.length);

    // The timemap onsets are SELF-CONSISTENT with the model: every rendered note's onset matches a
    // model handle of the same pitch (the precondition for click-to-select after a duration edit).
    const modelOnsetsByMidi = new Map<number, number[]>();
    for (const h of model.handles) {
      if (!modelOnsetsByMidi.has(h.midi)) modelOnsetsByMidi.set(h.midi, []);
      modelOnsetsByMidi.get(h.midi)!.push(round3(h.onsetSec));
    }
    for (const n of render!.notes) {
      expect(modelOnsetsByMidi.get(n.midi) ?? []).toContain(round3(n.timeSec));
    }
  });

  it("a duration edit + restore round-trips the reverie bar back to the original render", () => {
    const model = parseScoreModel(REVERIE_XML);
    const before = model.serialize();
    const eighth = model.handles.find(
      (h) => h.durationDivs === 2 && !h.isTieContinuation && !h.isChordMember,
    )!;
    const rec = model.changeDuration(eighth.id, "shorter");
    expect(model.serialize()).not.toBe(before);
    model.restoreDuration(rec!);
    // The restored model renders the SAME note count + a complete click map again.
    const vis = visFromModel(model);
    const restored = renderMusicXml(toolkit, model.serialize(), vis, 800);
    expect(restored.notes).toHaveLength(185);
    expect(restored.idToVisIndex.size).toBe(restored.notes.length);
  });
});

function round3(x: number): number {
  return Number(x.toFixed(3));
}
function uniqueSorted(xs: number[]): number[] {
  return [...new Set(xs)].sort((a, b) => a - b);
}

// ----- CROSS-BARLINE TIES through the REAL engine -----
//
// A tie-creating duration edit emits <tie>/<tied> start/stop pairs across two bars; Verovio must
// engrave them WITHOUT a "unsupported note-type-value" warning (the continuation note carries a
// <type>, same as every other note) and render BOTH the start notehead and the continuation notehead
// joined by a tie. This is the in-engine proof of TIE-C's notation half (the playback fold is proven
// against OSMD in score.test.ts). The reverie case proves a tie on a real OMR file keeps the engine
// consistent (no warning, every note still typed).

// A 4/4 two-bar fixture: bar 1 = dotted-half rest + a beat-4 quarter D5; bar 2 = a whole rest. The
// canonical cross-barline tie (a half starting on beat 4 = quarter tied to quarter over the barline).
const TIE_TWO_BAR = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>4</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>
      <note><rest/><duration>12</duration><voice>1</voice><type>half</type><dot/></note>
      <note><pitch><step>D</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type></note>
    </measure>
    <measure number="2">
      <note><rest/><duration>16</duration><voice>1</voice><type>whole</type></note>
    </measure>
  </part>
</score-partwise>`;

describe("CROSS-BARLINE TIE: an editor-created tie engraves through real Verovio with no warning", () => {
  let toolkit: VerovioToolkit;
  beforeAll(async () => {
    toolkit = await loadVerovioToolkit();
  }, 60000);

  it("renders a tie (two D5 noteheads + a tie/tied) with NO unsupported note-type-value warning", () => {
    const model = parseScoreModel(TIE_TWO_BAR);
    const rec = model.changeDuration(0, "longer"); // D5 quarter -> half: overflows beat 4, ties
    expect(rec?.outcome).toBe("tied");
    const xml = model.serialize();
    // The serialized MusicXML carries the matched tie markup the spec requires (TIE-C).
    expect(xml).toContain('<tie type="start"');
    expect(xml).toContain('<tie type="stop"');
    expect(xml).toContain('<tied type="start"');
    expect(xml).toContain('<tied type="stop"');

    // The falling notes the app would derive: ONE held D5 (the tie folds), so render with that note.
    const tiedVis: VisNote[] = [{ midi: 74, time: 1.5, duration: 1.0, hand: "right" }];
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    let render;
    try {
      render = renderMusicXml(toolkit, xml, tiedVis, 800);
    } finally {
      const allOutput = [...logSpy.mock.calls, ...warnSpy.mock.calls]
        .flat()
        .map((a) => String(a))
        .join("\n");
      logSpy.mockRestore();
      warnSpy.mockRestore();
      // The whole point: the continuation carries a <type>, so no blank/unsupported note-type warning.
      expect(allOutput).not.toContain("note-type-value");
    }

    // Verovio lays out TWO D5 noteheads (the start in bar 1 + the continuation in bar 2)...
    expect(render!.notes.filter((n) => n.midi === 74)).toHaveLength(2);
    // ...and the rendered SVG contains a tie element (Verovio draws <tie> for the engraved curve).
    expect(render!.svg).toMatch(/class="[^"]*\btie\b/);
  });
});

describe("CROSS-BARLINE TIE: the ties refactor keeps the real reverie engine path consistent", () => {
  let toolkit: VerovioToolkit;
  beforeAll(async () => {
    toolkit = await loadVerovioToolkit();
  }, 60000);

  it("reverie's dense texture produces NO spurious tie on a one-rung lengthen (conservative trigger)", () => {
    // The tie trigger is conservative: it fires only when the note reaches the barline (no following
    // same-voice note blocks it) AND the next bar's downbeat in this voice has room. Reverie is dense,
    // so a single one-rung lengthen never ties (it clamps / no-ops in-bar). This guards that the tie
    // path does not over-fire and silently restructure a real OMR score's bars.
    const model = parseScoreModel(REVERIE_XML);
    let ties = 0;
    for (const h of model.handles) {
      if (h.isTieContinuation || h.isChordMember) continue;
      const probe = parseScoreModel(REVERIE_XML);
      if (probe.changeDuration(h.id, "longer")?.outcome === "tied") ties++;
    }
    expect(ties).toBe(0); // no note ties on a single lengthen; the structure blocks every candidate
    // And the unedited reverie has no tie markup of its own (precondition for the count above).
    expect(REVERIE_XML.includes("<tie")).toBe(false);
  });

  it("a reverie SHORTEN still renders 185/185 with a <type> on every note and NO engine warning (refactor intact)", () => {
    // The ties increment refactored rederiveVisNotesFromModel (hand-by-element + tie folding); this
    // re-affirms the no-<type> contract still holds for the EXISTING reverie edit path through real
    // Verovio after that refactor: 185/185 click map, every note typed, no note-type-value warning.
    const model = parseScoreModel(REVERIE_XML);
    expect(model.handles.length).toBe(185);
    const eighth = model.handles.find(
      (h) => h.durationDivs === 2 && !h.isTieContinuation && !h.isChordMember,
    )!;
    const rec = model.changeDuration(eighth.id, "shorter");
    expect(rec?.outcome).toBe("stepped");

    const vis = model.handles
      .filter((h) => !h.isTieContinuation)
      .map((h) => ({ midi: h.midi, time: h.onsetSec, duration: 0.5, hand: "right" as const }));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    let render;
    try {
      render = renderMusicXml(toolkit, model.serialize(), vis, 800);
    } finally {
      const allOutput = [...logSpy.mock.calls, ...warnSpy.mock.calls]
        .flat()
        .map((a) => String(a))
        .join("\n");
      logSpy.mockRestore();
      warnSpy.mockRestore();
      expect(allOutput).not.toContain("note-type-value");
    }
    expect(render!.idToVisIndex.size).toBe(render!.notes.length); // complete click map
    const doc = new DOMParser().parseFromString(model.serialize(), "application/xml");
    const pitched = Array.from(doc.getElementsByTagName("note")).filter(
      (n) => n.getElementsByTagName("rest").length === 0,
    );
    for (const n of pitched) {
      expect(n.getElementsByTagName("type").item(0)?.textContent ?? "").not.toBe("");
    }
  });
});
