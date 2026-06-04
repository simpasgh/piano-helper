// @vitest-environment jsdom
//
// Unit tests for the editable notation model (Smart Edit Mode P1, the load-bearing core). The
// jsdom env gives us DOMParser / XMLSerializer so the parse + serialize round-trip runs without
// a browser. These pin the pure pitch math (diatonic / chromatic / octave stepping, key-sig
// awareness), the parse (onsets, MIDI, chords, ties), the DOM mutation (pitch + accidental
// sync), and the handle <-> VisNote mapping that keeps the two surfaces consistent.

import { describe, it, expect } from "vitest";
import {
  parseScoreModel,
  midiFromPitch,
  keyAlterForLetter,
  diatonicStep,
  chromaticStep,
  octaveStep,
  pitchFromMidi,
  buildHandleToVisIndex,
  spellingFromPitch,
  type ModelPitch,
} from "./edit-model";

// A 1-part / 2-staff grand staff (the omr-worker shape): 4 RH quarters (C5 D5 E5 F5) over a
// 3-note LH whole chord (C3 E3 G3), default 120bpm so a quarter = 0.5s. Mirrors the committed
// verovio integration fixture so the onset/midi expectations line up with that proven data.
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

const p = (step: ModelPitch["step"], octave: number, alter = 0): ModelPitch => ({
  step,
  octave,
  alter,
});

describe("midiFromPitch", () => {
  it("maps written pitch to MIDI (C4 = 60, middle-C octave convention)", () => {
    expect(midiFromPitch(p("C", 4))).toBe(60);
    expect(midiFromPitch(p("A", 4))).toBe(69);
    expect(midiFromPitch(p("C", 5))).toBe(72);
    expect(midiFromPitch(p("F", 5, 1))).toBe(78); // F#5
    expect(midiFromPitch(p("D", 5, -1))).toBe(73); // Db5
  });
});

describe("keyAlterForLetter", () => {
  it("C major: every letter natural", () => {
    for (const l of ["C", "D", "E", "F", "G", "A", "B"] as const) {
      expect(keyAlterForLetter(l, 0)).toBe(0);
    }
  });
  it("D major (2 sharps): F and C are sharp", () => {
    expect(keyAlterForLetter("F", 2)).toBe(1);
    expect(keyAlterForLetter("C", 2)).toBe(1);
    expect(keyAlterForLetter("G", 2)).toBe(0);
  });
  it("Eb major (3 flats): B, E, A are flat", () => {
    expect(keyAlterForLetter("B", -3)).toBe(-1);
    expect(keyAlterForLetter("E", -3)).toBe(-1);
    expect(keyAlterForLetter("A", -3)).toBe(-1);
    expect(keyAlterForLetter("D", -3)).toBe(0);
  });
});

describe("diatonicStep", () => {
  it("steps to the next letter in C major (E up -> F natural, not E#)", () => {
    expect(diatonicStep(p("E", 4), 1, 0)).toEqual(p("F", 4));
    expect(diatonicStep(p("F", 4), -1, 0)).toEqual(p("E", 4));
  });
  it("is key-signature aware (E up in D major -> F#)", () => {
    expect(diatonicStep(p("E", 4), 1, 2)).toEqual(p("F", 4, 1));
  });
  it("crosses the octave at the B/C boundary", () => {
    expect(diatonicStep(p("B", 4), 1, 0)).toEqual(p("C", 5));
    expect(diatonicStep(p("C", 4), -1, 0)).toEqual(p("B", 3));
  });
  it("a diatonic step is one or two semitones (never zero)", () => {
    // E -> F is one semitone; C -> D is two. Both are a single staff position.
    expect(midiFromPitch(diatonicStep(p("E", 4), 1, 0)) - midiFromPitch(p("E", 4))).toBe(1);
    expect(midiFromPitch(diatonicStep(p("C", 4), 1, 0)) - midiFromPitch(p("C", 4))).toBe(2);
  });
});

describe("chromaticStep", () => {
  it("keeps the letter and adjusts the accidental (E up -> E#, E down -> Eb)", () => {
    expect(chromaticStep(p("E", 4), 1)).toEqual(p("E", 4, 1));
    expect(chromaticStep(p("E", 4), -1)).toEqual(p("E", 4, -1));
  });
  it("always moves exactly one semitone", () => {
    const start = p("G", 4);
    expect(midiFromPitch(chromaticStep(start, 1)) - midiFromPitch(start)).toBe(1);
    expect(midiFromPitch(chromaticStep(start, -1)) - midiFromPitch(start)).toBe(-1);
  });
  it("re-spells to a neighbouring letter past the double accidental", () => {
    const doubleSharp = p("F", 4, 2); // F##4 == G4
    const next = chromaticStep(doubleSharp, 1); // would be F###; must re-spell
    expect(midiFromPitch(next)).toBe(midiFromPitch(doubleSharp) + 1);
    expect(Math.abs(next.alter)).toBeLessThanOrEqual(2);
  });
});

describe("octaveStep", () => {
  it("moves a whole octave, keeping letter + accidental", () => {
    expect(octaveStep(p("D", 5, -1), 1)).toEqual(p("D", 6, -1));
    expect(octaveStep(p("D", 5, -1), -1)).toEqual(p("D", 4, -1));
    expect(midiFromPitch(octaveStep(p("C", 4), 1)) - midiFromPitch(p("C", 4))).toBe(12);
  });
});

describe("pitchFromMidi", () => {
  it("spells white keys as naturals", () => {
    expect(pitchFromMidi(60)).toEqual(p("C", 4));
    expect(pitchFromMidi(72)).toEqual(p("C", 5));
  });
  it("spells black keys as a sharp going up and a flat going down", () => {
    expect(pitchFromMidi(61, 1)).toEqual(p("C", 4, 1)); // C#4
    expect(pitchFromMidi(61, -1)).toEqual(p("D", 4, -1)); // Db4
  });
});

describe("parseScoreModel", () => {
  it("indexes every pitched note in document order with onset + MIDI", () => {
    const model = parseScoreModel(GRAND_STAFF_XML);
    expect(model.handles).toHaveLength(7);
    // 4 RH quarters at 0/0.5/1/1.5s, then the LH chord (3 notes) all at onset 0.
    expect(model.handles.map((h) => h.midi)).toEqual([72, 74, 76, 77, 48, 52, 55]);
    expect(model.handles.map((h) => Number(h.onsetSec.toFixed(3)))).toEqual([
      0, 0.5, 1, 1.5, 0, 0, 0,
    ]);
  });
  it("marks chord members (the 2nd and 3rd LH notes share the 1st's onset)", () => {
    const model = parseScoreModel(GRAND_STAFF_XML);
    expect(model.handles[4].isChordMember).toBe(false); // C3, onset note
    expect(model.handles[5].isChordMember).toBe(true); // E3
    expect(model.handles[6].isChordMember).toBe(true); // G3
  });
  it("captures the key signature per handle", () => {
    const model = parseScoreModel(GRAND_STAFF_XML);
    expect(model.fifthsForHandle(0)).toBe(0);
  });

  it("setPitch rewrites the <pitch> and round-trips through serialize", () => {
    const model = parseScoreModel(GRAND_STAFF_XML);
    // Raise the first RH note C5 -> D5 (diatonic).
    model.setPitch(0, p("D", 5));
    expect(model.handles[0].midi).toBe(74);
    const xml = model.serialize();
    const reparsed = parseScoreModel(xml);
    expect(reparsed.handles[0].pitch).toEqual(p("D", 5));
    expect(reparsed.handles[0].midi).toBe(74);
    // The other notes are untouched.
    expect(reparsed.handles.map((h) => h.midi)).toEqual([74, 74, 76, 77, 48, 52, 55]);
  });

  it("setPitch writes an explicit <accidental> when the pitch departs from the key, and an <alter>", () => {
    const model = parseScoreModel(GRAND_STAFF_XML);
    model.setPitch(0, p("F", 5, 1)); // C5 -> F#5 in C major: needs alter + sharp accidental
    const xml = model.serialize();
    expect(xml).toContain("<alter>1</alter>");
    expect(xml).toContain("<accidental>sharp</accidental>");
    const reparsed = parseScoreModel(xml);
    expect(reparsed.handles[0].pitch).toEqual(p("F", 5, 1));
  });

  it("setPitch omits <alter> and removes a stale <accidental> when back to a diatonic pitch", () => {
    const model = parseScoreModel(GRAND_STAFF_XML);
    model.setPitch(0, p("F", 5, 1)); // first make it sharp (adds alter + accidental)
    model.setPitch(0, p("G", 5)); // then a natural diatonic pitch
    const xml = model.serialize();
    const reparsed = parseScoreModel(xml);
    expect(reparsed.handles[0].pitch).toEqual(p("G", 5));
    // No stale accidental / alter left on that note: re-reading yields a clean natural.
    expect(reparsed.handles[0].pitch.alter).toBe(0);
  });

  it("setPitch on an out-of-range id is a no-op", () => {
    const model = parseScoreModel(GRAND_STAFF_XML);
    expect(() => model.setPitch(99, p("C", 4))).not.toThrow();
    expect(model.handles.map((h) => h.midi)).toEqual([72, 74, 76, 77, 48, 52, 55]);
  });
});

describe("parseScoreModel ties", () => {
  // A held C4 across two beats: a tie START segment then a STOP (continuation). score.ts merges
  // these into ONE VisNote, so the continuation handle must be flagged un-mappable.
  const TIE_XML = `<?xml version="1.0"?>
  <score-partwise version="3.1">
    <part-list><score-part id="P1"><part-name>P</part-name></score-part></part-list>
    <part id="P1"><measure number="1">
      <attributes><divisions>1</divisions><key><fifths>0</fifths></key>
        <time><beats>2</beats><beat-type>4</beat-type></time>
        <clef><sign>G</sign><line>2</line></clef></attributes>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><type>quarter</type><tie type="start"/></note>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><type>quarter</type><tie type="stop"/></note>
    </measure></part>
  </score-partwise>`;

  it("flags the continuation segment as a tie continuation (no VisNote of its own)", () => {
    const model = parseScoreModel(TIE_XML);
    expect(model.handles).toHaveLength(2);
    expect(model.handles[0].isTieContinuation).toBe(false); // the start segment
    expect(model.handles[1].isTieContinuation).toBe(true); // the held continuation
  });
});

describe("buildHandleToVisIndex", () => {
  it("maps non-continuation handles to the VisNote sharing (midi, onset)", () => {
    const model = parseScoreModel(GRAND_STAFF_XML);
    // The VisNote[] the app derives from this score (same as the verovio integration fixture).
    const visNotes = [
      { midi: 72, time: 0 },
      { midi: 74, time: 0.5 },
      { midi: 76, time: 1 },
      { midi: 77, time: 1.5 },
      { midi: 48, time: 0 },
      { midi: 52, time: 0 },
      { midi: 55, time: 0 },
    ];
    const map = buildHandleToVisIndex(model.handles, visNotes);
    expect(map.size).toBe(7);
    for (let i = 0; i < 7; i++) expect(map.get(i)).toBe(i);
  });

  it("skips a tie continuation (it has no VisNote)", () => {
    const model = parseScoreModel(
      `<?xml version="1.0"?>
      <score-partwise version="3.1">
        <part-list><score-part id="P1"><part-name>P</part-name></score-part></part-list>
        <part id="P1"><measure number="1">
          <attributes><divisions>1</divisions><key><fifths>0</fifths></key>
            <clef><sign>G</sign><line>2</line></clef></attributes>
          <note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><type>quarter</type><tie type="start"/></note>
          <note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><type>quarter</type><tie type="stop"/></note>
        </measure></part>
      </score-partwise>`,
    );
    // The merged VisNote is one held C4 at time 0 (duration 2 in score.ts; only midi+time key).
    const visNotes = [{ midi: 60, time: 0 }];
    const map = buildHandleToVisIndex(model.handles, visNotes);
    expect(map.get(0)).toBe(0); // start segment maps
    expect(map.has(1)).toBe(false); // continuation does not
  });

  it("re-maps after a pitch edit by the NEW (midi, onset) so selection follows the note", () => {
    const model = parseScoreModel(GRAND_STAFF_XML);
    model.setPitch(0, p("D", 5)); // C5 -> D5; onset unchanged
    // The re-derived VisNote[] now has D5 (74) at time 0 in slot 0.
    const visNotes = [
      { midi: 74, time: 0 },
      { midi: 74, time: 0.5 },
      { midi: 76, time: 1 },
      { midi: 77, time: 1.5 },
      { midi: 48, time: 0 },
      { midi: 52, time: 0 },
      { midi: 55, time: 0 },
    ];
    const map = buildHandleToVisIndex(model.handles, visNotes);
    expect(map.get(0)).toBe(0); // handle 0 still maps to VisNote 0 at its new pitch
  });
});

describe("spellingFromPitch", () => {
  it("carries the letter + alter so the falling label follows the edit", () => {
    expect(spellingFromPitch(p("F", 5, 1))).toEqual({ letter: "F", alter: 1 });
  });
});

// The re-derivation contract the dual-surface bridge depends on: across a sequence of pitch
// edits and an undo, projecting the model's pitch onto a VisNote[] by the stable handle index and
// then re-mapping by (midi, onset) keeps a handle pointing at the same VisNote slot (so the
// shared selection follows the note). This mirrors what main.ts's finishEdit/rederiveMaps do.
describe("re-derivation across edits + undo (selection-follows invariant)", () => {
  // Project the model's current pitches onto a VisNote[] by the (index-stable) handle map, the
  // way main.ts re-derives the falling notes after an edit (pitch/time unchanged in structure).
  function project(
    model: ReturnType<typeof parseScoreModel>,
    base: { midi: number; time: number }[],
    handleMap: Map<number, number>,
  ): { midi: number; time: number }[] {
    const next = base.map((n) => ({ ...n }));
    for (const h of model.handles) {
      const vi = handleMap.get(h.id);
      if (vi !== undefined) next[vi] = { ...next[vi], midi: h.midi };
    }
    return next;
  }

  it("keeps handle 0 -> VisNote 0 through an edit and its undo", () => {
    const model = parseScoreModel(GRAND_STAFF_XML);
    let vis = [
      { midi: 72, time: 0 },
      { midi: 74, time: 0.5 },
      { midi: 76, time: 1 },
      { midi: 77, time: 1.5 },
      { midi: 48, time: 0 },
      { midi: 52, time: 0 },
      { midi: 55, time: 0 },
    ];
    let map = buildHandleToVisIndex(model.handles, vis);
    expect(map.get(0)).toBe(0);

    // EDIT: C5 -> E5. Project with the PRE-edit map (index stable), then re-map.
    model.setPitch(0, p("E", 5));
    vis = project(model, vis, map);
    expect(vis[0].midi).toBe(76);
    map = buildHandleToVisIndex(model.handles, vis);
    expect(map.get(0)).toBe(0); // handle 0 still owns VisNote 0 at its new pitch

    // UNDO: model reverts to C5. Project with the still-valid map BEFORE re-mapping (the bug the
    // ordering guards against: re-mapping first would fail to match the reverted note).
    model.setPitch(0, p("C", 5));
    vis = project(model, vis, map);
    expect(vis[0].midi).toBe(72); // the undo landed on the falling notes
    map = buildHandleToVisIndex(model.handles, vis);
    expect(map.get(0)).toBe(0);
  });
});
