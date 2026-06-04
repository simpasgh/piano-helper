// @vitest-environment jsdom
//
// Unit tests for the editable notation model (Smart Edit Mode P1, the load-bearing core). The
// jsdom env gives us DOMParser / XMLSerializer so the parse + serialize round-trip runs without
// a browser. These pin the pure pitch math (diatonic / chromatic / octave stepping, key-sig
// awareness), the parse (onsets, MIDI, chords, ties), the DOM mutation (pitch + accidental
// sync), and the handle <-> VisNote mapping that keeps the two surfaces consistent.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseScoreModel,
  midiFromPitch,
  pitchInRange,
  keyAlterForLetter,
  diatonicStep,
  chromaticStep,
  octaveStep,
  pitchFromMidi,
  buildHandleToVisIndex,
  deriveVisNotesFromModel,
  spellingFromPitch,
  restDurationName,
  noteTypeForDuration,
  noteValueName,
  durationValueName,
  ladderIndexForDuration,
  nearestLadderIndex,
  DURATION_LADDER,
  NOTE_VALUE_QUARTERS,
  type ModelPitch,
  type NoteHandle,
} from "./edit-model";
import {
  FIRST_MIDI,
  LAST_MIDI,
  handFromClefInEffect,
  type Hand,
  type StaffClefKind,
} from "./piano";

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

  it("computes ABSOLUTE onsets across measures (not measure-relative)", () => {
    // Regression for the rest-mapping bug: onsets must be from the SCORE start so they match the
    // VisNote[] / Verovio timemap. A measure-relative walk (cursor reset per bar) put every
    // measure's first note back at 0 and broke the maps for measures 2+. Two 4/4 bars at 120bpm:
    // bar 1 onsets 0/0.5/1/1.5, bar 2 continues at 2.0/2.5/3.0/3.5 (NOT 0/0.5/1/1.5 again).
    const TWO_BARS = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>1</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><type>quarter</type></note>
      <note><pitch><step>D</step><octave>4</octave></pitch><duration>1</duration><type>quarter</type></note>
      <note><pitch><step>E</step><octave>4</octave></pitch><duration>1</duration><type>quarter</type></note>
      <note><pitch><step>F</step><octave>4</octave></pitch><duration>1</duration><type>quarter</type></note>
    </measure>
    <measure number="2">
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>1</duration><type>quarter</type></note>
      <note><pitch><step>A</step><octave>4</octave></pitch><duration>1</duration><type>quarter</type></note>
      <note><pitch><step>B</step><octave>4</octave></pitch><duration>1</duration><type>quarter</type></note>
      <note><rest/><duration>1</duration><type>quarter</type></note>
    </measure>
  </part>
</score-partwise>`;
    const model = parseScoreModel(TWO_BARS);
    expect(model.handles.map((h) => Number(h.onsetSec.toFixed(3)))).toEqual([
      0, 0.5, 1, 1.5, 2, 2.5, 3,
    ]);
    // The rest is on beat 4 of bar 2 => absolute onset 3.5s (NOT the measure-relative 1.5s).
    expect(model.restHandles).toHaveLength(1);
    expect(model.restHandles[0].onsetSec).toBeCloseTo(3.5, 6);
    expect(model.restHandles[0].beat).toBe(4); // beat stays 1-based WITHIN the bar
  });

  it("advances the measure clock by a trailing <forward>, not just the last note", () => {
    // A measure whose LAST event is a <forward> filling the rest of the bar (a voice that rests out
    // the bar end as a forward instead of an explicit <rest>). The next measure must start at the
    // FULL bar length (the furthest cursor incl. the forward), not at the last note's end. Without
    // counting the forward, m2 would land at 0.5s and silently break the maps for every later bar
    // (the same class as the measure-relative bug). 4/4 at 120bpm => m2 at 2.0s.
    const TRAILING_FORWARD = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>1</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><type>quarter</type></note>
      <forward><duration>3</duration></forward>
    </measure>
    <measure number="2">
      <note><pitch><step>D</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice><type>whole</type></note>
    </measure>
  </part>
</score-partwise>`;
    const model = parseScoreModel(TRAILING_FORWARD);
    const m2 = model.handles.find((h) => h.midi === 62);
    expect(m2?.onsetSec).toBeCloseTo(2.0, 6);
  });

  it("advances the measure clock by the furthest voice when a later voice ends short", () => {
    // A grand-staff bar where voice 1 fills the whole bar but voice 2 (the LAST events in document
    // order) plays only a half note and stops. The next measure must start at the MAX forward cursor
    // (4 quarters), not the last event's end (2 quarters). 4/4 at 120bpm => m2 at 2.0s.
    const SHORT_TRAILING_VOICE = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>1</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><staves>2</staves>
        <clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef></attributes>
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><type>whole</type><staff>1</staff></note>
      <backup><duration>4</duration></backup>
      <note><pitch><step>C</step><octave>3</octave></pitch><duration>2</duration><voice>2</voice><type>half</type><staff>2</staff></note>
    </measure>
    <measure number="2">
      <note><pitch><step>D</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><type>whole</type><staff>1</staff></note>
    </measure>
  </part>
</score-partwise>`;
    const model = parseScoreModel(SHORT_TRAILING_VOICE);
    const m2 = model.handles.find((h) => h.midi === 74);
    expect(m2?.onsetSec).toBeCloseTo(2.0, 6);
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

describe("ScoreModel.serialize SAVE round-trip (Smart Edit COMMIT v1)", () => {
  // SAVE writes scoreModel.serialize() back into the retained source MusicXML; the NEXT
  // enterEditMode re-parses that source. These pin the contract that the round-trip carries the
  // edit AND is STABLE under repeated save/re-enter (so re-entering then re-saving does not drift).
  it("a serialized edit re-parses WITH the edit (re-entering edit shows the saved change)", () => {
    const model = parseScoreModel(GRAND_STAFF_XML);
    model.setPitch(0, p("D", 5)); // raise the first RH note C5 -> D5
    const saved = model.serialize(); // what SAVE persists into sourceMusicXml
    // Re-entering edit mode re-parses the saved source: the edit is present, not the original.
    const reentered = parseScoreModel(saved);
    expect(reentered.handles[0].pitch).toEqual(p("D", 5));
    expect(reentered.handles[0].midi).toBe(74);
    expect(reentered.handles.map((h) => h.midi)).toEqual([74, 74, 76, 77, 48, 52, 55]);
  });

  it("serialize is idempotent across a re-parse (re-enter then re-save does not drift)", () => {
    const model = parseScoreModel(GRAND_STAFF_XML);
    model.setPitch(0, p("D", 5)); // an edit, mirroring a real Save (serialize only runs when dirty)
    const saved = model.serialize();
    const resaved = parseScoreModel(saved).serialize(); // a second Save with no further edits
    expect(resaved).toBe(saved); // byte-stable: <type> inference + serialize do not keep mutating
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

// ===== 88-key clamp (Smart Edit P1 review note): a step must never push a note off MIDI 21..108 =====
describe("pitchInRange", () => {
  it("is true inside the 88-key range, false outside", () => {
    expect(pitchInRange(p("A", 0))).toBe(true); // MIDI 21, lowest key
    expect(pitchInRange(p("C", 8))).toBe(true); // MIDI 108, highest key
    expect(pitchInRange(p("A", 0, -1))).toBe(false); // MIDI 20, below the keyboard
    expect(pitchInRange(p("C", 8, 1))).toBe(false); // MIDI 109, above the keyboard
  });
});

describe("stepping clamps to the 88-key range (boundary step is a no-op)", () => {
  it("diatonicStep does not go below A0 or above C8", () => {
    // Lowest key is A0 (MIDI 21). A diatonic step DOWN would be G0 (MIDI 19): clamped to a no-op.
    const a0 = p("A", 0);
    expect(midiFromPitch(a0)).toBe(FIRST_MIDI);
    expect(diatonicStep(a0, -1, 0)).toEqual(a0); // unchanged
    // Highest key is C8 (MIDI 108). A diatonic step UP would be D8 (MIDI 110): clamped.
    const c8 = p("C", 8);
    expect(midiFromPitch(c8)).toBe(LAST_MIDI);
    expect(diatonicStep(c8, 1, 0)).toEqual(c8); // unchanged
    // A step AWAY from the boundary still moves (not frozen).
    expect(midiFromPitch(diatonicStep(a0, 1, 0))).toBe(23); // A0 -> B0
    expect(midiFromPitch(diatonicStep(c8, -1, 0))).toBe(107); // C8 -> B7
  });

  it("chromaticStep does not cross either boundary", () => {
    const a0 = p("A", 0);
    expect(chromaticStep(a0, -1)).toEqual(a0); // A0 down would be 20: no-op
    expect(midiFromPitch(chromaticStep(a0, 1))).toBe(22); // A0 up -> A#0, fine
    const c8 = p("C", 8);
    expect(chromaticStep(c8, 1)).toEqual(c8); // C8 up would be 109: no-op
    expect(midiFromPitch(chromaticStep(c8, -1))).toBe(107); // C8 down -> B7, fine
  });

  it("octaveStep does not push a note off the keyboard", () => {
    // C1 (MIDI 24) down an octave is C0 (MIDI 12), below the keyboard: clamped to a no-op.
    const c1 = p("C", 1);
    expect(octaveStep(c1, -1)).toEqual(c1);
    // C7 (MIDI 96) up an octave is C8 (MIDI 108), still on the keyboard: allowed.
    expect(midiFromPitch(octaveStep(p("C", 7), 1))).toBe(108);
    // C8 up an octave would be C9 (120): clamped.
    const c8 = p("C", 8);
    expect(octaveStep(c8, 1)).toEqual(c8);
  });
});

// ===== Model-level DELETE (fixed-bar, undoable, both surfaces re-derive) =====
//
// The time EXTENT of the first measure in divisions: walk its children tracking a cursor exactly
// like the model does (non-chord notes + rests advance it, <backup>/<forward> move it, chord
// members are parallel), and return the furthest the cursor reaches. This is the fixed-bar invariant
// a delete must preserve: replacing a note with a rest of the same duration, removing a chord
// member, or promoting a chord member all leave this extent unchanged. Handles the grand staff's
// two voices joined by <backup> (so the RH run and the LH whole note overlap, extent 8, not 16).
function measureFilledDivs(xml: string): number {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const measure = doc.getElementsByTagName("measure").item(0);
  if (!measure) return 0;
  let cursor = 0;
  let extent = 0;
  for (const node of Array.from(measure.children)) {
    const tag = node.tagName.toLowerCase();
    const durOf = (el: Element) =>
      Number(el.getElementsByTagName("duration").item(0)?.textContent ?? "0");
    if (tag === "backup") {
      cursor -= durOf(node);
    } else if (tag === "forward") {
      cursor += durOf(node);
    } else if (tag === "note") {
      if (node.getElementsByTagName("chord").item(0)) continue; // chord member: parallel, no advance
      cursor += durOf(node);
    }
    extent = Math.max(extent, cursor);
  }
  return extent;
}

describe("ScoreModel.deleteNote / restoreNote", () => {
  it("replaces a standalone note with a REST of the same duration (the bar still adds up)", () => {
    const model = parseScoreModel(GRAND_STAFF_XML);
    const before = measureFilledDivs(model.serialize()); // 4 RH quarters (2 each) = 8 divs
    expect(before).toBe(8);
    // Delete the 2nd RH quarter (handle 1 = D5). It is alone at its onset, so it becomes a rest.
    model.deleteNote(1);
    const xml = model.serialize();
    expect(measureFilledDivs(xml)).toBe(before); // fixed-bar: total unchanged
    // The note count dropped by one (6 pitched handles now); D5 at onset 0.5 is gone.
    expect(model.handles).toHaveLength(6);
    expect(model.handles.map((h) => h.midi)).toEqual([72, 76, 77, 48, 52, 55]);
    // A <rest/> now sits where D5 was, with the same duration (2 divs).
    const reparsed = new DOMParser().parseFromString(xml, "application/xml");
    const rests = Array.from(reparsed.getElementsByTagName("rest"));
    expect(rests.length).toBe(1);
    const restNote = rests[0].parentElement!;
    expect(restNote.getElementsByTagName("duration").item(0)?.textContent).toBe("2");
  });

  it("delete + restore round-trips exactly (undo brings the note back at its position + pitch)", () => {
    const model = parseScoreModel(GRAND_STAFF_XML);
    const originalMidis = model.handles.map((h) => h.midi);
    const originalXmlNotes = model.handles.length;
    const rec = model.deleteNote(2); // delete E5 (3rd RH note)
    expect(rec).not.toBeNull();
    expect(model.handles).toHaveLength(originalXmlNotes - 1);
    model.restoreNote(rec!);
    // Handles are back to the original count, order, and pitches (the note reclaimed its slot).
    expect(model.handles).toHaveLength(originalXmlNotes);
    expect(model.handles.map((h) => h.midi)).toEqual(originalMidis);
    // Handle ids are re-assigned by document order, so the restored note is handle 2 again.
    expect(model.handles[2].midi).toBe(76); // E5 back in position 2
  });

  it("removes a CHORD MEMBER without disturbing the bar or the other chord notes", () => {
    const model = parseScoreModel(GRAND_STAFF_XML);
    const before = measureFilledDivs(model.serialize());
    // Handle 5 = E3, the 2nd note of the LH whole-note chord (a <chord/> member).
    expect(model.handles[5].isChordMember).toBe(true);
    const rec = model.deleteNote(5);
    const xml = model.serialize();
    expect(measureFilledDivs(xml)).toBe(before); // chord member is parallel: bar unchanged
    // The chord is now C3 + G3; E3 is gone, no rest was added (a rest cannot stack in a chord).
    expect(model.handles.map((h) => h.midi)).toEqual([72, 74, 76, 77, 48, 55]);
    expect(Array.from(new DOMParser().parseFromString(xml, "application/xml").getElementsByTagName("rest")).length).toBe(0);
    // Restore puts E3 back as a chord member between C3 and G3.
    model.restoreNote(rec!);
    expect(model.handles.map((h) => h.midi)).toEqual([72, 74, 76, 77, 48, 52, 55]);
    expect(model.handles[5].isChordMember).toBe(true);
  });

  it("deleting a chord ONSET note promotes the next member and keeps the bar (then restores)", () => {
    const model = parseScoreModel(GRAND_STAFF_XML);
    const before = measureFilledDivs(model.serialize());
    // Handle 4 = C3, the ONSET note of the LH chord (no <chord/>); handles 5,6 are its members.
    expect(model.handles[4].isChordMember).toBe(false);
    const rec = model.deleteNote(4);
    const xml = model.serialize();
    expect(measureFilledDivs(xml)).toBe(before); // promoted member carries the duration: bar unchanged
    // C3 is gone; E3 + G3 remain and still sound (E3 is now the chord onset).
    expect(model.handles.map((h) => h.midi)).toEqual([72, 74, 76, 77, 52, 55]);
    // Restore: C3 is back as the onset, E3 demoted to a member again.
    model.restoreNote(rec!);
    expect(model.handles.map((h) => h.midi)).toEqual([72, 74, 76, 77, 48, 52, 55]);
    expect(model.handles[4].isChordMember).toBe(false); // C3 onset again
    expect(model.handles[5].isChordMember).toBe(true); // E3 a member again
  });

  it("the handle->VisNote map rebuilds after a delete (the remaining notes still map)", () => {
    const model = parseScoreModel(GRAND_STAFF_XML);
    model.deleteNote(1); // drop D5 (onset 0.5)
    // The re-derived VisNote[] no longer has D5; the surviving notes keep their (midi, onset).
    const visNotes = [
      { midi: 72, time: 0 },
      { midi: 76, time: 1 },
      { midi: 77, time: 1.5 },
      { midi: 48, time: 0 },
      { midi: 52, time: 0 },
      { midi: 55, time: 0 },
    ];
    const map = buildHandleToVisIndex(model.handles, visNotes);
    expect(map.size).toBe(6);
    // Handle 0 (C5) -> VisNote 0; handle 1 is now E5 (was index-2 pre-delete) -> VisNote 1.
    expect(map.get(0)).toBe(0);
    expect(map.get(1)).toBe(1); // the reindexed handle for E5
    expect(model.handles[1].midi).toBe(76);
  });

  it("deleteNote on an out-of-range id is a no-op returning null", () => {
    const model = parseScoreModel(GRAND_STAFF_XML);
    expect(model.deleteNote(99)).toBeNull();
    expect(model.handles).toHaveLength(7);
  });
});

// ----- ADD-a-note v1: rest registry + makeNoteFrom + addNote/removeNote -----

// A 1-part / 2-staff measure with a clear gap: RH C5, D5, a QUARTER REST on beat 3, F5; LH a whole
// C3. divisions=2 so a quarter = 2 divs = 0.5s at 120bpm; the rest's onset is beat 3 (= 1.0s).
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

// Same shape but in D major (2 sharps), so a fill on the F line is diatonically F# and a fill on
// the C line is C#: lets us prove the accidental is synced to the key signature like setPitch.
const REST_XML_DMAJOR = REST_XML.replace("<fifths>0</fifths>", "<fifths>2</fifths>");

describe("parseScoreModel rest registry (ADD-a-note v1)", () => {
  it("indexes rests in a SEPARATE registry without polluting the pitched-note handles", () => {
    const model = parseScoreModel(REST_XML);
    // Four pitched notes (C5, D5, F5, C3); the rest is NOT a NoteHandle.
    expect(model.handles.map((h) => h.midi)).toEqual([72, 74, 77, 48]);
    // Exactly one rest handle, with the rest's onset/duration/type/staff/beat captured.
    expect(model.restHandles).toHaveLength(1);
    const r = model.restHandles[0];
    expect(r.onsetSec).toBeCloseTo(1.0, 6); // beat 3 at 120bpm
    expect(r.durationSec).toBeCloseTo(0.5, 6); // a quarter
    expect(r.type).toBe("quarter");
    expect(r.staff).toBe(1);
    expect(r.voice).toBe(1);
    expect(r.beat).toBe(3);
  });

  it("a score with no rests has an empty rest registry", () => {
    const model = parseScoreModel(GRAND_STAFF_XML);
    expect(model.restHandles).toHaveLength(0);
  });
});

describe("ScoreModel.addNote / removeNote (makeNoteFrom, fixed-bar, round-trip)", () => {
  it("turns a rest into a NOTE of the same duration at the given pitch (fixed-bar)", () => {
    const model = parseScoreModel(REST_XML);
    const before = measureFilledDivs(model.serialize()); // RH 4 quarters = 8 divs
    expect(before).toBe(8);
    const rec = model.addNote(0, { step: "E", octave: 5, alter: 0 }); // fill the rest with E5
    expect(rec).not.toBeNull();
    // The bar still adds up (the new note has the rest's duration), and the rest is gone.
    expect(measureFilledDivs(model.serialize())).toBe(before);
    expect(model.restHandles).toHaveLength(0);
    // A 5th pitched note now exists: E5 (MIDI 76) at the rest's onset (1.0s).
    expect(model.handles.map((h) => h.midi)).toEqual([72, 74, 76, 77, 48]);
    const added = model.handles.find((h) => h.midi === 76)!;
    expect(added.onsetSec).toBeCloseTo(1.0, 6);
    // The added <note> carries the same <duration>/<type>/<staff> as the rest, and no <rest/>.
    const doc = new DOMParser().parseFromString(model.serialize(), "application/xml");
    const noteEls = Array.from(doc.getElementsByTagName("note"));
    const e5 = noteEls.find(
      (n) => n.getElementsByTagName("step").item(0)?.textContent === "E" &&
             n.getElementsByTagName("octave").item(0)?.textContent === "5",
    )!;
    expect(e5.getElementsByTagName("rest").length).toBe(0);
    expect(e5.getElementsByTagName("duration").item(0)?.textContent).toBe("2");
    expect(e5.getElementsByTagName("type").item(0)?.textContent).toBe("quarter");
    expect(e5.getElementsByTagName("staff").item(0)?.textContent).toBe("1");
  });

  it("add + remove round-trips exactly (rest -> note -> undo -> rest)", () => {
    const model = parseScoreModel(REST_XML);
    const originalMidis = model.handles.map((h) => h.midi);
    const rec = model.addNote(0, { step: "G", octave: 5, alter: 0 });
    expect(rec).not.toBeNull();
    expect(model.handles).toHaveLength(originalMidis.length + 1);
    expect(model.restHandles).toHaveLength(0);
    model.removeNote(rec!);
    // The note is gone, the rest is back at its slot, the pitched handles match the original.
    expect(model.handles.map((h) => h.midi)).toEqual(originalMidis);
    expect(model.restHandles).toHaveLength(1);
    expect(model.restHandles[0].onsetSec).toBeCloseTo(1.0, 6);
    expect(model.restHandles[0].type).toBe("quarter");
  });

  it("syncs the accidental to the key signature (diatonic fill prints none; departing prints one)", () => {
    // In D major, a fill on the F line is F# (diatonic) and prints NO explicit accidental.
    const dmodel = parseScoreModel(REST_XML_DMAJOR);
    dmodel.addNote(0, { step: "F", octave: 5, alter: 1 }); // F#5, the key's default for F
    const ddoc = new DOMParser().parseFromString(dmodel.serialize(), "application/xml");
    const fSharp = Array.from(ddoc.getElementsByTagName("note")).find(
      (n) => n.getElementsByTagName("step").item(0)?.textContent === "F" &&
             n.getElementsByTagName("octave").item(0)?.textContent === "5",
    )!;
    expect(fSharp.getElementsByTagName("alter").item(0)?.textContent).toBe("1"); // pitch is F#
    expect(fSharp.getElementsByTagName("accidental").length).toBe(0); // but no printed accidental

    // A fill that DEPARTS from the key (F natural in D major) prints an explicit natural.
    const dmodel2 = parseScoreModel(REST_XML_DMAJOR);
    dmodel2.addNote(0, { step: "F", octave: 5, alter: 0 }); // F natural, NOT the key's default
    const ddoc2 = new DOMParser().parseFromString(dmodel2.serialize(), "application/xml");
    const fNat = Array.from(ddoc2.getElementsByTagName("note")).find(
      (n) => n.getElementsByTagName("step").item(0)?.textContent === "F" &&
             n.getElementsByTagName("octave").item(0)?.textContent === "5",
    )!;
    expect(fNat.getElementsByTagName("accidental").item(0)?.textContent).toBe("natural");
  });

  it("a fill with a sharp in C major prints the explicit sharp accidental", () => {
    const model = parseScoreModel(REST_XML); // C major
    model.addNote(0, { step: "F", octave: 5, alter: 1 }); // F#5 departs from C major's F natural
    const doc = new DOMParser().parseFromString(model.serialize(), "application/xml");
    const fSharp = Array.from(doc.getElementsByTagName("note")).find(
      (n) => n.getElementsByTagName("step").item(0)?.textContent === "F" &&
             n.getElementsByTagName("alter").item(0)?.textContent === "1",
    )!;
    expect(fSharp.getElementsByTagName("accidental").item(0)?.textContent).toBe("sharp");
  });

  it("addNote on an out-of-range rest id is a no-op returning null", () => {
    const model = parseScoreModel(REST_XML);
    expect(model.addNote(99, { step: "C", octave: 4, alter: 0 })).toBeNull();
    expect(model.handles).toHaveLength(4);
    expect(model.restHandles).toHaveLength(1);
  });

  it("the added note maps to its VisNote by (midi, onset), so selection can follow it", () => {
    const model = parseScoreModel(REST_XML);
    model.addNote(0, { step: "E", octave: 5, alter: 0 }); // E5 at onset 1.0
    // The app re-derives the falling notes WITH the new E5 at time 1.0.
    const visNotes = [
      { midi: 72, time: 0 },
      { midi: 74, time: 0.5 },
      { midi: 76, time: 1.0 }, // the added note
      { midi: 77, time: 1.5 },
      { midi: 48, time: 0 },
    ];
    const map = buildHandleToVisIndex(model.handles, visNotes);
    const addedHandle = model.handles.find((h) => h.midi === 76)!;
    expect(map.get(addedHandle.id)).toBe(2); // the new note maps to its VisNote
  });
});

describe("restDurationName", () => {
  it("names known rest types", () => {
    expect(restDurationName("quarter")).toBe("quarter rest");
    expect(restDurationName("half")).toBe("half rest");
    expect(restDurationName("eighth")).toBe("eighth rest");
    expect(restDurationName("16th")).toBe("sixteenth rest");
    expect(restDurationName("whole")).toBe("whole rest");
  });
  it("falls back to a generic 'rest' for an unknown/missing type", () => {
    expect(restDurationName("")).toBe("rest");
    expect(restDurationName("weird")).toBe("rest");
  });
});

// ===== <type> inference from <duration> (the no-<type> OMR bug) =====
//
// Real OMR (e.g. the user's `reverie`) emits notes with a <duration> but NO <type>. Verovio then
// draws every such note at a uniform default value (wrong rhythm) AND computes a wrong timemap, so
// the (midi, onset) click map diverges and click-to-select fails; OSMD (the read-only view) infers
// from <duration> and renders correctly, which is why only EDIT mode was broken. The model now
// infers + inserts a <type> (and any <dot>) during the parse so Verovio receives a valid value.

const NOTE_VALUE_TOKENS = ["breve", "whole", "half", "quarter", "eighth", "16th", "32nd", "64th"];

describe("noteTypeForDuration (duration -> note value, key-sig-independent)", () => {
  it("maps the standard plain values at divisions=4 (the reverie divisions)", () => {
    // q = durDivs / divisions. The reverie durations: 2->eighth, 4->quarter, 8->half, 16->whole.
    expect(noteTypeForDuration(2, 4)).toEqual({ type: "eighth", dots: 0 });
    expect(noteTypeForDuration(4, 4)).toEqual({ type: "quarter", dots: 0 });
    expect(noteTypeForDuration(8, 4)).toEqual({ type: "half", dots: 0 });
    expect(noteTypeForDuration(16, 4)).toEqual({ type: "whole", dots: 0 });
  });

  it("maps every standard value at divisions=1 (1 div = a quarter)", () => {
    expect(noteTypeForDuration(8, 1)).toEqual({ type: "breve", dots: 0 }); // double whole = 8q
    expect(noteTypeForDuration(4, 1)).toEqual({ type: "whole", dots: 0 });
    expect(noteTypeForDuration(2, 1)).toEqual({ type: "half", dots: 0 });
    expect(noteTypeForDuration(1, 1)).toEqual({ type: "quarter", dots: 0 });
    expect(noteTypeForDuration(0.5, 1)).toEqual({ type: "eighth", dots: 0 });
    expect(noteTypeForDuration(0.25, 1)).toEqual({ type: "16th", dots: 0 });
    expect(noteTypeForDuration(0.125, 1)).toEqual({ type: "32nd", dots: 0 });
    expect(noteTypeForDuration(0.0625, 1)).toEqual({ type: "64th", dots: 0 });
  });

  it("maps dotted values (1.5x base = one dot, 1.75x base = two dots)", () => {
    // divisions=4: a dotted half is 3 quarters = 12 divs; the reverie's duration-12 rests are these.
    expect(noteTypeForDuration(12, 4)).toEqual({ type: "half", dots: 1 }); // 3q
    expect(noteTypeForDuration(6, 4)).toEqual({ type: "quarter", dots: 1 }); // 1.5q dotted quarter
    expect(noteTypeForDuration(3, 4)).toEqual({ type: "eighth", dots: 1 }); // 0.75q dotted eighth
    // double dotted: a double-dotted half = 2 + 1 + 0.5 = 3.5q = 14 divs at divisions=4.
    expect(noteTypeForDuration(14, 4)).toEqual({ type: "half", dots: 2 });
    // dotted whole = 6q = 6 divs at divisions=1.
    expect(noteTypeForDuration(6, 1)).toEqual({ type: "whole", dots: 1 });
  });

  it("prefers the longest base + fewest dots for an ambiguous length", () => {
    // 3 quarters could be a dotted half (half + 1 dot) - the conventional spelling - never a
    // "quarter + ..."; the longest base that yields an integral dot count wins.
    expect(noteTypeForDuration(3, 1)).toEqual({ type: "half", dots: 1 });
    // A plain 2 quarters is a half (0 dots), not a dotted-something.
    expect(noteTypeForDuration(2, 1)).toEqual({ type: "half", dots: 0 });
  });

  it("falls back to the NEAREST base (no dots) for a non-standard duration, never crashing", () => {
    // A triplet eighth at divisions=12 is 4 divs = 1/3 quarter (~0.333q), between an eighth (0.5q,
    // delta 0.167) and a 16th (0.25q, delta 0.083): the 16th is NEAREST. No exception, valid, 0 dots.
    expect(noteTypeForDuration(4, 12)).toEqual({ type: "16th", dots: 0 });
    // A triplet quarter (8 divs at divisions=12 = 2/3 quarter, ~0.667q) is nearest an eighth (0.5q,
    // delta 0.167) over a quarter (1q, delta 0.333).
    expect(noteTypeForDuration(8, 12)).toEqual({ type: "eighth", dots: 0 });
    // A zero / negative / divisions-0 duration does not throw and yields a valid token.
    expect(() => noteTypeForDuration(0, 4)).not.toThrow();
    expect(() => noteTypeForDuration(2, 0)).not.toThrow();
    expect(NOTE_VALUE_TOKENS).toContain(noteTypeForDuration(0, 4).type);
    expect(NOTE_VALUE_TOKENS).toContain(noteTypeForDuration(2, 0).type);
  });
});

// The synthetic no-<type> grand-staff fixture: a HALF + QUARTERS + WHOLE + a DOTTED-HALF note + a
// QUARTER REST, two measures, none carrying a <type> (only <duration>). This is the committed
// regression for the real-world reverie case at unit scale; the real reverie file is exercised
// through Verovio in edit-model-integration.test.ts.
const NO_TYPE_XML = readFileSync(
  join(process.cwd(), "src", "test-fixtures", "no-type-grand-staff.musicxml"),
  "utf8",
);

describe("parseScoreModel infers <type> for no-<type> notes/rests (OMR shape)", () => {
  it("inserts the correct <type> (and <dot>) into each note + rest, computed from <duration>", () => {
    const model = parseScoreModel(NO_TYPE_XML);
    const xml = model.serialize();
    const doc = new DOMParser().parseFromString(xml, "application/xml");

    const typeOf = (step: string, octave: string) => {
      const note = Array.from(doc.getElementsByTagName("note")).find(
        (n) =>
          n.getElementsByTagName("step").item(0)?.textContent === step &&
          n.getElementsByTagName("octave").item(0)?.textContent === octave,
      );
      return {
        type: note?.getElementsByTagName("type").item(0)?.textContent ?? null,
        dots: note?.getElementsByTagName("dot").length ?? 0,
      };
    };

    // divisions=2: C5 half (dur 4), D5/E5 quarters (dur 2), C3/E3 wholes (dur 8), G5 dotted-half
    // (dur 6 = 3 quarters = half + one dot).
    expect(typeOf("C", "5")).toEqual({ type: "half", dots: 0 });
    expect(typeOf("D", "5")).toEqual({ type: "quarter", dots: 0 });
    expect(typeOf("E", "5")).toEqual({ type: "quarter", dots: 0 });
    expect(typeOf("C", "3")).toEqual({ type: "whole", dots: 0 });
    expect(typeOf("E", "3")).toEqual({ type: "whole", dots: 0 });
    expect(typeOf("G", "5")).toEqual({ type: "half", dots: 1 }); // dotted half

    // The quarter REST (dur 2) is typed too, so its announce names it and a fill copies the type.
    const restNote = Array.from(doc.getElementsByTagName("rest")).map((r) => r.parentElement!)[0];
    expect(restNote.getElementsByTagName("type").item(0)?.textContent).toBe("quarter");
    expect(model.restHandles[0].type).toBe("quarter");
  });

  it("emits a valid MusicXML child order: <type> after <duration>/<staff-less prefix>, <dot> after <type>", () => {
    const model = parseScoreModel(NO_TYPE_XML);
    const doc = new DOMParser().parseFromString(model.serialize(), "application/xml");
    const g5 = Array.from(doc.getElementsByTagName("note")).find(
      (n) => n.getElementsByTagName("step").item(0)?.textContent === "G",
    )!;
    const order = Array.from(g5.children).map((c) => c.tagName.toLowerCase());
    // The fixture note is <pitch><duration><staff>; the inserted <type> must sit BEFORE <staff> and
    // each <dot> immediately AFTER <type> (valid DTD order: ... duration, type, dot*, ... staff).
    const di = order.indexOf("duration");
    const ti = order.indexOf("type");
    const doti = order.indexOf("dot");
    const si = order.indexOf("staff");
    expect(di).toBeGreaterThanOrEqual(0);
    expect(ti).toBeGreaterThan(di); // type after duration
    expect(doti).toBe(ti + 1); // the dot immediately follows the type
    expect(si).toBeGreaterThan(doti); // staff after the dot (it sits late in the content model)
  });

  it("the inferred onsets reflect the TRUE durations (so the falling notes + click map line up)", () => {
    // The model onsets come from <duration>, so they were already right; this pins the values the
    // Verovio timemap must now also produce (proven in the integration test). 4/4 at 120bpm.
    const model = parseScoreModel(NO_TYPE_XML);
    // C5 half @0, D5 quarter @1.0, E5 quarter @1.5 (m1 RH); C3 whole @0, E3 whole @2.0 (LH);
    // G5 dotted-half @2.0 (m2 RH); quarter rest @3.5 (m2 RH, after the 3-quarter dotted half).
    const at = (midi: number) => model.handles.filter((h) => h.midi === midi).map((h) => h.onsetSec);
    expect(at(72)).toEqual([0]); // C5
    expect(at(74)).toEqual([1.0]); // D5
    expect(at(76)).toEqual([1.5]); // E5
    expect(at(79)).toEqual([2.0]); // G5 dotted half, measure 2
    expect(model.restHandles[0].onsetSec).toBeCloseTo(3.5, 6); // quarter rest after the dotted half
  });

  it("does NOT modify a note that already HAS a <type> (typed scores are untouched)", () => {
    // GRAND_STAFF_XML carries an explicit <type> on every note. Inference must be a strict no-op:
    // no extra <type>/<dot> added, and the existing tokens preserved verbatim.
    const before = new DOMParser().parseFromString(GRAND_STAFF_XML, "application/xml");
    const beforeTypes = Array.from(before.getElementsByTagName("type")).map((t) => t.textContent);
    const beforeDots = before.getElementsByTagName("dot").length;
    const model = parseScoreModel(GRAND_STAFF_XML);
    const after = new DOMParser().parseFromString(model.serialize(), "application/xml");
    const afterTypes = Array.from(after.getElementsByTagName("type")).map((t) => t.textContent);
    expect(afterTypes).toEqual(beforeTypes); // same count, same tokens, same order
    expect(after.getElementsByTagName("dot").length).toBe(beforeDots);
  });

  it("is idempotent across a structural edit (re-indexing does not double-insert a <type>)", () => {
    // reindexHandles() runs again after a delete; addTypeIfMissing must be a no-op the 2nd time
    // (the note now has a <type>), so a delete + restore leaves exactly ONE <type> per note.
    const model = parseScoreModel(NO_TYPE_XML);
    const typesAfterParse = new DOMParser()
      .parseFromString(model.serialize(), "application/xml")
      .getElementsByTagName("type").length;
    const rec = model.deleteNote(0); // triggers a reindex
    model.restoreNote(rec!); // and another
    const typesAfterEdit = new DOMParser()
      .parseFromString(model.serialize(), "application/xml")
      .getElementsByTagName("type").length;
    // The delete turns C5 (a standalone note) into a rest, then restore brings it back, so the
    // pitched-note + rest TOTAL is unchanged: the <type> count is identical, never doubled.
    expect(typesAfterEdit).toBe(typesAfterParse);
  });
});

// ===== CHANGE-DURATION v1 (Smart Edit P3): step a note along the plain value ladder, fixed-bar =====
//
// The ladder is 16th..whole; in divisions=4 (load-bearing): 16th=1, eighth=2, quarter=4, half=8,
// whole=16. Shorten leaves a REST of the freed time (bar stays full, following onsets unchanged);
// lengthen ripples following events later and absorbs trailing REST space, CLAMPING at the barline.
// A plain-rung step sets BOTH <duration> and <type> and writes ZERO dots (removing any). A dotted
// arrival snaps to the nearest plain rung first. These pin all of that purely (no Verovio).

describe("DURATION_LADDER + ladder helpers", () => {
  it("the ladder is the plain values 16th..whole in order, drawn from NOTE_VALUE_QUARTERS", () => {
    expect(DURATION_LADDER.map((v) => v.type)).toEqual([
      "16th",
      "eighth",
      "quarter",
      "half",
      "whole",
    ]);
    // Each ladder rung's quarter-length matches the canonical NOTE_VALUE_QUARTERS table.
    for (const rung of DURATION_LADDER) {
      const canon = NOTE_VALUE_QUARTERS.find((v) => v.type === rung.type)!;
      expect(rung.quarters).toBe(canon.quarters);
    }
  });

  it("maps divisions to the load-bearing duration values (divisions=4)", () => {
    // 16th=1, eighth=2, quarter=4, half=8, whole=16 in divisions=4.
    const byType = Object.fromEntries(DURATION_LADDER.map((v) => [v.type, v.quarters * 4]));
    expect(byType).toEqual({ "16th": 1, eighth: 2, quarter: 4, half: 8, whole: 16 });
  });

  it("ladderIndexForDuration finds plain rungs and rejects dotted/odd durations", () => {
    expect(ladderIndexForDuration(4, 4)).toBe(2); // quarter
    expect(ladderIndexForDuration(8, 4)).toBe(3); // half
    expect(ladderIndexForDuration(1, 4)).toBe(0); // 16th
    expect(ladderIndexForDuration(16, 4)).toBe(4); // whole
    expect(ladderIndexForDuration(6, 4)).toBe(-1); // dotted quarter: off the plain ladder
    expect(ladderIndexForDuration(12, 4)).toBe(-1); // dotted half: off the plain ladder
  });

  it("nearestLadderIndex snaps a dotted value to the nearest rung, ties going SHORTER", () => {
    // A dotted quarter (1.5q) is equidistant from quarter (idx 2) and half (idx 3); tie -> shorter.
    expect(nearestLadderIndex(6, 4)).toBe(2); // -> quarter
    // A dotted half (3q) is equidistant from half (idx 3) and whole (idx 4); tie -> shorter (half).
    expect(nearestLadderIndex(12, 4)).toBe(3); // -> half
    // A dotted eighth (0.75q) is between 16th(0.25, idx0) and eighth(0.5, idx1) and quarter(1, idx2):
    // nearest is quarter? |0.75-0.5|=0.25 vs |0.75-1|=0.25 tie eighth vs quarter -> shorter (eighth).
    expect(nearestLadderIndex(3, 4)).toBe(1); // -> eighth
  });
});

describe("noteValueName / durationValueName", () => {
  it("names plain and dotted values", () => {
    expect(noteValueName("quarter", 0)).toBe("quarter");
    expect(noteValueName("16th", 0)).toBe("sixteenth");
    expect(noteValueName("quarter", 1)).toBe("dotted quarter");
    expect(noteValueName("half", 2)).toBe("double dotted half");
    expect(noteValueName("weird", 0)).toBe("note"); // unknown -> generic
  });
  it("durationValueName infers from divisions", () => {
    expect(durationValueName(4, 4)).toBe("quarter");
    expect(durationValueName(6, 4)).toBe("dotted quarter"); // dotted arrival reads as dotted
    expect(durationValueName(16, 4)).toBe("whole");
  });
});

// A SINGLE-VOICE 4/4 bar at divisions=4: four quarters C5 D5 E5 F5 (each dur 4), total 16. The
// clean ground for ladder steps + dot handling on the FIRST note (which has a following note to
// ripple). 120bpm => quarter = 0.5s.
const FOUR_QUARTERS = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>P</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>4</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type></note>
      <note><pitch><step>D</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type></note>
      <note><pitch><step>E</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type></note>
      <note><pitch><step>F</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type></note>
    </measure>
  </part>
</score-partwise>`;

// Helpers to read a serialized note's duration/type/dots by its pitch step (each pitch is unique in
// the fixtures below), and to list a measure's events in order (tag + duration) for ripple checks.
function noteInfo(xml: string, step: string, octave = "5"): { dur: number; type: string; dots: number } {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const note = Array.from(doc.getElementsByTagName("note")).find(
    (n) =>
      n.getElementsByTagName("step").item(0)?.textContent === step &&
      n.getElementsByTagName("octave").item(0)?.textContent === octave,
  );
  return {
    dur: Number(note?.getElementsByTagName("duration").item(0)?.textContent ?? "NaN"),
    type: note?.getElementsByTagName("type").item(0)?.textContent ?? "",
    dots: note?.getElementsByTagName("dot").length ?? 0,
  };
}

// The first measure's events as {rest, dur} in document order (single voice), for ripple/rest checks.
function measureEvents(xml: string): { rest: boolean; dur: number }[] {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const measure = doc.getElementsByTagName("measure").item(0)!;
  return Array.from(measure.getElementsByTagName("note")).map((n) => ({
    rest: n.getElementsByTagName("rest").length > 0,
    dur: Number(n.getElementsByTagName("duration").item(0)?.textContent ?? "0"),
  }));
}

describe("ScoreModel.changeDuration ladder step (both <duration> and <type>, dots removed)", () => {
  it("LONGER steps one rung up across the ladder, setting duration + type, zero dots", () => {
    // Start E5 = quarter (the 3rd note); lengthen consumes from the trailing F5? No: a step that
    // RIPPLES needs trailing rest room. To pin a clean rung-by-rung mapping without bar interaction,
    // use a one-note 4/4 bar per rung so there is room to the barline.
    const oneNote = (dur: number, type: string) => `<?xml version="1.0"?>
<score-partwise version="3.1"><part-list><score-part id="P1"><part-name>P</part-name></score-part></part-list>
<part id="P1"><measure number="1">
  <attributes><divisions>4</divisions><time><beats>8</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>
  <note><pitch><step>C</step><octave>5</octave></pitch><duration>${dur}</duration><voice>1</voice><type>${type}</type></note>
  <note><rest/><duration>${32 - dur}</duration><voice>1</voice><type>whole</type></note>
</measure></part></score-partwise>`;
    // 8/4 bar (capacity 32) so there is always trailing rest room to step up into.
    const cases: Array<[number, string, number, string]> = [
      [1, "16th", 2, "eighth"],
      [2, "eighth", 4, "quarter"],
      [4, "quarter", 8, "half"],
      [8, "half", 16, "whole"],
    ];
    for (const [dur, type, nextDur, nextType] of cases) {
      const model = parseScoreModel(oneNote(dur, type));
      const rec = model.changeDuration(0, "longer");
      expect(rec?.outcome).toBe("stepped");
      const info = noteInfo(model.serialize(), "C");
      expect(info.dur).toBe(nextDur);
      expect(info.type).toBe(nextType);
      expect(info.dots).toBe(0);
    }
  });

  it("SHORTER steps one rung down across the ladder, setting duration + type, zero dots", () => {
    const oneNote = (dur: number, type: string) => `<?xml version="1.0"?>
<score-partwise version="3.1"><part-list><score-part id="P1"><part-name>P</part-name></score-part></part-list>
<part id="P1"><measure number="1">
  <attributes><divisions>4</divisions><time><beats>8</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>
  <note><pitch><step>C</step><octave>5</octave></pitch><duration>${dur}</duration><voice>1</voice><type>${type}</type></note>
  <note><rest/><duration>${32 - dur}</duration><voice>1</voice><type>whole</type></note>
</measure></part></score-partwise>`;
    const cases: Array<[number, string, number, string]> = [
      [16, "whole", 8, "half"],
      [8, "half", 4, "quarter"],
      [4, "quarter", 2, "eighth"],
      [2, "eighth", 1, "16th"],
    ];
    for (const [dur, type, prevDur, prevType] of cases) {
      const model = parseScoreModel(oneNote(dur, type));
      const rec = model.changeDuration(0, "shorter");
      expect(rec?.outcome).toBe("stepped");
      const info = noteInfo(model.serialize(), "C");
      expect(info.dur).toBe(prevDur);
      expect(info.type).toBe(prevType);
      expect(info.dots).toBe(0);
    }
  });

  it("announces the spelled value name on a step (toName matches the readout, incl. the sixteenth rung)", () => {
    // The screen-reader announce (rec.toName) must use the SAME spelled form as the visible readout
    // (durationValueName), so a step landing on a 16th says "sixteenth", not the raw "16th" token.
    // The other rungs already coincide (their <type> token is the spelled word); the 16th was the gap.
    const oneNote = (dur: number, type: string) => `<?xml version="1.0"?>
<score-partwise version="3.1"><part-list><score-part id="P1"><part-name>P</part-name></score-part></part-list>
<part id="P1"><measure number="1">
  <attributes><divisions>4</divisions><time><beats>8</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>
  <note><pitch><step>C</step><octave>5</octave></pitch><duration>${dur}</duration><voice>1</voice><type>${type}</type></note>
  <note><rest/><duration>${32 - dur}</duration><voice>1</voice><type>whole</type></note>
</measure></part></score-partwise>`;
    const down = parseScoreModel(oneNote(2, "eighth")).changeDuration(0, "shorter");
    expect(down?.toName).toBe("sixteenth");
    const up = parseScoreModel(oneNote(1, "16th")).changeDuration(0, "longer");
    expect(up?.toName).toBe("eighth");
  });

  it("REMOVES existing <dot> children on a plain-rung step", () => {
    // A note that arrives dotted (dotted quarter = 6) gets its dot stripped when stepped; the result
    // is a clean plain rung with zero dots (the dotted-arrival snap also runs, see the snap tests).
    const DOTTED = `<?xml version="1.0"?>
<score-partwise version="3.1"><part-list><score-part id="P1"><part-name>P</part-name></score-part></part-list>
<part id="P1"><measure number="1">
  <attributes><divisions>4</divisions><time><beats>8</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>
  <note><pitch><step>C</step><octave>5</octave></pitch><duration>6</duration><voice>1</voice><type>quarter</type><dot/></note>
  <note><rest/><duration>26</duration><voice>1</voice><type>whole</type></note>
</measure></part></score-partwise>`;
    const model = parseScoreModel(DOTTED);
    expect(noteInfo(DOTTED, "C").dots).toBe(1); // precondition: arrives dotted
    model.changeDuration(0, "longer"); // snaps to quarter then up to half
    expect(noteInfo(model.serialize(), "C").dots).toBe(0); // the dot is gone
  });
});

describe("ScoreModel.changeDuration ladder-end clamp (no-op + signaling)", () => {
  it("SHORTER at a 16th is a no-op marked atEnd (no DOM change)", () => {
    const SIXTEENTH = `<?xml version="1.0"?>
<score-partwise version="3.1"><part-list><score-part id="P1"><part-name>P</part-name></score-part></part-list>
<part id="P1"><measure number="1">
  <attributes><divisions>4</divisions><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>
  <note><pitch><step>C</step><octave>5</octave></pitch><duration>1</duration><voice>1</voice><type>16th</type></note>
  <note><rest/><duration>15</duration><voice>1</voice><type>whole</type></note>
</measure></part></score-partwise>`;
    const model = parseScoreModel(SIXTEENTH);
    const before = model.serialize();
    const rec = model.changeDuration(0, "shorter");
    expect(rec?.outcome).toBe("atEnd");
    expect(rec?.childrenBefore.length).toBe(0); // nothing snapshotted (true no-op)
    expect(model.serialize()).toBe(before); // DOM unchanged
  });

  it("LONGER at a whole is a no-op marked atEnd (no DOM change)", () => {
    const WHOLE = `<?xml version="1.0"?>
<score-partwise version="3.1"><part-list><score-part id="P1"><part-name>P</part-name></score-part></part-list>
<part id="P1"><measure number="1">
  <attributes><divisions>4</divisions><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>
  <note><pitch><step>C</step><octave>5</octave></pitch><duration>16</duration><voice>1</voice><type>whole</type></note>
</measure></part></score-partwise>`;
    const model = parseScoreModel(WHOLE);
    const before = model.serialize();
    const rec = model.changeDuration(0, "longer");
    expect(rec?.outcome).toBe("atEnd");
    expect(model.serialize()).toBe(before);
  });

  it("changeDuration on an out-of-range id is null", () => {
    const model = parseScoreModel(FOUR_QUARTERS);
    expect(model.changeDuration(99, "longer")).toBeNull();
  });
});

describe("ScoreModel.changeDuration SHORTEN inserts a rest, bar stays full, onsets unchanged", () => {
  it("shrinks the note and inserts a REST of the freed time right after it", () => {
    // Shorten the 2nd quarter D5 (dur 4) -> eighth (dur 2): a freed eighth-rest (dur 2) appears right
    // after it; E5 and F5 keep their onsets; the bar still sums to 16.
    const model = parseScoreModel(FOUR_QUARTERS);
    const eOnsetBefore = model.handles.find((h) => h.midi === 76)!.onsetSec; // E5
    const fOnsetBefore = model.handles.find((h) => h.midi === 77)!.onsetSec; // F5
    const rec = model.changeDuration(1, "shorter");
    expect(rec?.outcome).toBe("stepped");
    const xml = model.serialize();
    // D5 is now an eighth; a rest of dur 2 sits immediately after it.
    expect(noteInfo(xml, "D")).toEqual({ dur: 2, type: "eighth", dots: 0 });
    const events = measureEvents(xml);
    // C(4) D(2) REST(2) E(4) F(4): the freed rest is between D and E.
    expect(events).toEqual([
      { rest: false, dur: 4 },
      { rest: false, dur: 2 },
      { rest: true, dur: 2 },
      { rest: false, dur: 4 },
      { rest: false, dur: 4 },
    ]);
    expect(measureFilledDivs(xml)).toBe(16); // bar still full
    // E5 and F5 onsets are UNCHANGED (the freed time became a rest; nothing shifted).
    expect(model.handles.find((h) => h.midi === 76)!.onsetSec).toBeCloseTo(eOnsetBefore, 6);
    expect(model.handles.find((h) => h.midi === 77)!.onsetSec).toBeCloseTo(fOnsetBefore, 6);
  });
});

describe("ScoreModel.changeDuration LENGTHEN ripples following events, clamps at the barline", () => {
  // C5 quarter (4), D5 quarter (4), E5 quarter (4), then a quarter REST (4): total 16. Lengthening
  // C5 to a half (8) must ripple D5 and E5 right and CONSUME the trailing rest, keeping the bar full.
  const RIPPLE = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>P</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>4</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type></note>
      <note><pitch><step>D</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type></note>
      <note><pitch><step>E</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type></note>
      <note><rest/><duration>4</duration><voice>1</voice><type>quarter</type></note>
    </measure>
  </part>
</score-partwise>`;

  it("ripples following NOTES later and absorbs the trailing rest (bar stays full)", () => {
    const model = parseScoreModel(RIPPLE);
    const dBefore = model.handles.find((h) => h.midi === 74)!.onsetSec; // D5
    const eBefore = model.handles.find((h) => h.midi === 76)!.onsetSec; // E5
    const rec = model.changeDuration(0, "longer"); // C5 quarter -> half
    expect(rec?.outcome).toBe("stepped");
    const xml = model.serialize();
    expect(noteInfo(xml, "C")).toEqual({ dur: 8, type: "half", dots: 0 });
    // The quarter rest (4) was fully consumed by the half-note's extra quarter; the bar is now
    // C(8) D(4) E(4) with NO rest, still summing to 16.
    expect(measureEvents(xml)).toEqual([
      { rest: false, dur: 8 },
      { rest: false, dur: 4 },
      { rest: false, dur: 4 },
    ]);
    expect(measureFilledDivs(xml)).toBe(16);
    // D5 and E5 rippled later by one quarter (4 divs = 0.5s at 120bpm).
    expect(model.handles.find((h) => h.midi === 74)!.onsetSec).toBeCloseTo(dBefore + 0.5, 6);
    expect(model.handles.find((h) => h.midi === 76)!.onsetSec).toBeCloseTo(eBefore + 0.5, 6);
  });

  it("CLAMPS growth to the barline when the next rung overflows the room (note fills the bar)", () => {
    // A half note (8) then a quarter rest (4) then a quarter note (4): total 16. Lengthening the half
    // to a whole (16) would add 8, but only 4 divs of rest are available -> CLAMP: grow by 4 to a
    // dotted-half (12), consuming the rest, keeping the quarter note. The bar stays exactly full.
    const CLAMP = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>P</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>4</divisions><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>8</duration><voice>1</voice><type>half</type></note>
      <note><rest/><duration>4</duration><voice>1</voice><type>quarter</type></note>
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type></note>
    </measure>
  </part>
</score-partwise>`;
    const model = parseScoreModel(CLAMP);
    const rec = model.changeDuration(0, "longer");
    expect(rec?.outcome).toBe("clamped");
    const xml = model.serialize();
    // The note filled to the barline: dur 12 (a dotted half), consuming the rest; G4 remains.
    const c = noteInfo(xml, "C");
    expect(c.dur).toBe(12);
    expect(measureEvents(xml)).toEqual([
      { rest: false, dur: 12 },
      { rest: false, dur: 4 },
    ]);
    expect(measureFilledDivs(xml)).toBe(16); // bar exactly full, no overflow, no barline crossing
  });

  it("is a NO-OP (noRoom) when the note already fills to the barline (no following rest)", () => {
    // A half note then a half note, no rest: total 16. The first half has no rest room after it, so
    // lengthening it is a no-op at the bar boundary (noRoom), not an overflow.
    const FULL = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>P</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>4</divisions><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>8</duration><voice>1</voice><type>half</type></note>
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>8</duration><voice>1</voice><type>half</type></note>
    </measure>
  </part>
</score-partwise>`;
    const model = parseScoreModel(FULL);
    const before = model.serialize();
    const rec = model.changeDuration(0, "longer");
    expect(rec?.outcome).toBe("noRoom");
    expect(rec?.childrenBefore.length).toBe(0);
    expect(model.serialize()).toBe(before); // DOM unchanged
  });
});

describe("ScoreModel.changeDuration dotted-arrival snap to the nearest plain rung", () => {
  it("SHORTER on a dotted quarter snaps to quarter (folds the snap into the step)", () => {
    // A dotted quarter (dur 6) then a dotted-quarter rest... use a bar with room. The shorter press
    // snaps the dotted quarter (1.5q) to its nearest plain rung (quarter, tie -> shorter), so it
    // lands on a plain quarter with zero dots.
    const DOTTED_Q = `<?xml version="1.0"?>
<score-partwise version="3.1"><part-list><score-part id="P1"><part-name>P</part-name></score-part></part-list>
<part id="P1"><measure number="1">
  <attributes><divisions>4</divisions><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>
  <note><pitch><step>C</step><octave>5</octave></pitch><duration>6</duration><voice>1</voice><type>quarter</type><dot/></note>
  <note><rest/><duration>10</duration><voice>1</voice><type>half</type></note>
</measure></part></score-partwise>`;
    const model = parseScoreModel(DOTTED_Q);
    const rec = model.changeDuration(0, "shorter");
    expect(rec?.dottedSnap).toBe(true);
    expect(rec?.fromName).toBe("dotted quarter");
    expect(rec?.toName).toBe("quarter");
    const info = noteInfo(model.serialize(), "C");
    expect(info).toEqual({ dur: 4, type: "quarter", dots: 0 }); // snapped to a plain quarter
    expect(measureFilledDivs(model.serialize())).toBe(16); // bar still full (freed time -> rest)
  });

  it("LONGER on a dotted quarter snaps to quarter then steps up to half", () => {
    // The longer press snaps the dotted quarter (snapped value = quarter, which is SHORTER than the
    // arrival), so it takes one more rung up to half (so the press still lengthens).
    const DOTTED_Q = `<?xml version="1.0"?>
<score-partwise version="3.1"><part-list><score-part id="P1"><part-name>P</part-name></score-part></part-list>
<part id="P1"><measure number="1">
  <attributes><divisions>4</divisions><time><beats>8</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>
  <note><pitch><step>C</step><octave>5</octave></pitch><duration>6</duration><voice>1</voice><type>quarter</type><dot/></note>
  <note><rest/><duration>26</duration><voice>1</voice><type>whole</type></note>
</measure></part></score-partwise>`;
    const model = parseScoreModel(DOTTED_Q);
    const rec = model.changeDuration(0, "longer");
    expect(rec?.dottedSnap).toBe(true);
    expect(rec?.toName).toBe("half");
    expect(noteInfo(model.serialize(), "C")).toEqual({ dur: 8, type: "half", dots: 0 });
  });
});

describe("ScoreModel.changeDuration undo via restoreDuration restores the bar exactly", () => {
  it("a SHORTEN + restore round-trips to the exact prior bar (durations, types, onsets)", () => {
    const model = parseScoreModel(FOUR_QUARTERS);
    const before = model.serialize();
    const beforeOnsets = model.handles.map((h) => Number(h.onsetSec.toFixed(6)));
    const rec = model.changeDuration(1, "shorter");
    expect(rec).not.toBeNull();
    expect(model.serialize()).not.toBe(before); // it changed
    model.restoreDuration(rec!);
    // The bar children are restored; the model re-parses to the identical handles + onsets.
    expect(model.handles.map((h) => h.midi)).toEqual([72, 74, 76, 77]);
    expect(model.handles.map((h) => Number(h.onsetSec.toFixed(6)))).toEqual(beforeOnsets);
    expect(noteInfo(model.serialize(), "D")).toEqual({ dur: 4, type: "quarter", dots: 0 });
    expect(model.restHandles).toHaveLength(0); // the freed rest is gone again
  });

  it("a LENGTHEN-with-ripple + restore brings back the consumed rest and the original onsets", () => {
    const RIPPLE = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>P</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>4</divisions><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type></note>
      <note><pitch><step>D</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type></note>
      <note><pitch><step>E</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type></note>
      <note><rest/><duration>4</duration><voice>1</voice><type>quarter</type></note>
    </measure>
  </part>
</score-partwise>`;
    const model = parseScoreModel(RIPPLE);
    const beforeOnsets = model.handles.map((h) => Number(h.onsetSec.toFixed(6)));
    const rec = model.changeDuration(0, "longer");
    expect(model.restHandles).toHaveLength(0); // the rest was consumed
    model.restoreDuration(rec!);
    expect(model.handles.map((h) => Number(h.onsetSec.toFixed(6)))).toEqual(beforeOnsets);
    expect(model.restHandles).toHaveLength(1); // the consumed quarter rest is back
    expect(noteInfo(model.serialize(), "C")).toEqual({ dur: 4, type: "quarter", dots: 0 });
  });

  it("restoreDuration on a no-op record (ladder end) is a safe no-op", () => {
    const WHOLE = `<?xml version="1.0"?>
<score-partwise version="3.1"><part-list><score-part id="P1"><part-name>P</part-name></score-part></part-list>
<part id="P1"><measure number="1">
  <attributes><divisions>4</divisions><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>
  <note><pitch><step>C</step><octave>5</octave></pitch><duration>16</duration><voice>1</voice><type>whole</type></note>
</measure></part></score-partwise>`;
    const model = parseScoreModel(WHOLE);
    const before = model.serialize();
    const rec = model.changeDuration(0, "longer"); // atEnd no-op
    expect(() => model.restoreDuration(rec!)).not.toThrow();
    expect(model.serialize()).toBe(before);
  });
});

describe("ScoreModel.changeDuration applies to the whole CHORD (one shared duration)", () => {
  // A 4/4 bar (divisions=4) with a half-note chord C5+E5+G5 (each dur 8) then a half rest (dur 8).
  // Editing ANY chord member must change ALL members' durations together, never split the chord.
  const CHORD = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>P</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>4</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>8</duration><voice>1</voice><type>half</type></note>
      <note><chord/><pitch><step>E</step><octave>5</octave></pitch><duration>8</duration><voice>1</voice><type>half</type></note>
      <note><chord/><pitch><step>G</step><octave>5</octave></pitch><duration>8</duration><voice>1</voice><type>half</type></note>
      <note><rest/><duration>8</duration><voice>1</voice><type>half</type></note>
    </measure>
  </part>
</score-partwise>`;

  it("SHORTEN a chord member shrinks ALL members and inserts one rest after the chord", () => {
    const model = parseScoreModel(CHORD);
    // Select the chord MEMBER E5 (handle 1) and shorten it: the whole chord becomes a quarter.
    const rec = model.changeDuration(1, "shorter");
    expect(rec?.outcome).toBe("stepped");
    const xml = model.serialize();
    expect(noteInfo(xml, "C")).toEqual({ dur: 4, type: "quarter", dots: 0 });
    expect(noteInfo(xml, "E")).toEqual({ dur: 4, type: "quarter", dots: 0 });
    expect(noteInfo(xml, "G")).toEqual({ dur: 4, type: "quarter", dots: 0 });
    // The freed rest sits AFTER the whole chord (one new rest of 4), and the bar is still full.
    const events = measureEvents(xml);
    // C(4) E(4,chord) G(4,chord) FREED-REST(4) HALF-REST(8): the freed rest comes after the chord.
    expect(events.map((e) => e.dur)).toEqual([4, 4, 4, 4, 8]);
    expect(events[3].rest).toBe(true);
    expect(measureFilledDivs(xml)).toBe(16); // chord members are parallel: bar sum unchanged
  });

  it("LENGTHEN a chord ONSET grows ALL members and consumes the trailing rest", () => {
    const model = parseScoreModel(CHORD);
    // Select the chord ONSET C5 (handle 0) and lengthen: the half chord becomes a whole, consuming
    // the trailing half rest, so the whole bar is one whole-note chord.
    const rec = model.changeDuration(0, "longer");
    expect(rec?.outcome).toBe("stepped");
    const xml = model.serialize();
    expect(noteInfo(xml, "C")).toEqual({ dur: 16, type: "whole", dots: 0 });
    expect(noteInfo(xml, "E")).toEqual({ dur: 16, type: "whole", dots: 0 });
    expect(noteInfo(xml, "G")).toEqual({ dur: 16, type: "whole", dots: 0 });
    // The half rest was consumed; the bar is just the whole-note chord (3 notes, no rest), sum 16.
    const events = measureEvents(xml);
    expect(events.map((e) => e.rest)).toEqual([false, false, false]);
    expect(measureFilledDivs(xml)).toBe(16);
  });
});

describe("ScoreModel.changeDuration keeps the <type>-inference idempotent + handle ids stable", () => {
  it("re-running reindex after a duration edit does not double-insert <type> (idempotent)", () => {
    const model = parseScoreModel(FOUR_QUARTERS);
    const typesBefore = new DOMParser()
      .parseFromString(model.serialize(), "application/xml")
      .getElementsByTagName("type").length;
    const rec = model.changeDuration(1, "shorter"); // adds a rest (which carries a <type>)
    model.restoreDuration(rec!); // re-indexes back
    const typesAfter = new DOMParser()
      .parseFromString(model.serialize(), "application/xml")
      .getElementsByTagName("type").length;
    expect(typesAfter).toBe(typesBefore); // exactly one <type> per note, never doubled
  });

  it("a duration edit leaves the pitched-note handle ids stable (no note added/removed)", () => {
    const model = parseScoreModel(FOUR_QUARTERS);
    const midisBefore = model.handles.map((h) => h.midi);
    model.changeDuration(0, "shorter"); // shorten C5 (adds a rest, not a note)
    expect(model.handles.map((h) => h.midi)).toEqual(midisBefore); // same notes, same order, same ids
    expect(model.handles[0].midi).toBe(72); // C5 still handle 0
  });
});

describe("CHANGE-DURATION edit-OFF no-op: parsing without an edit never mutates the document", () => {
  it("serialize() of a parsed-but-UNEDITED typed score is byte-identical to the source", () => {
    // The duration feature added cached time fields (durationDivs/divisions/durationSec) to each
    // handle, read during the parse walk. They must be READ-ONLY: with NO changeDuration call, the
    // serialized output of a fully-typed score must equal the input exactly (edit-off is untouched).
    // GRAND_STAFF_XML carries a <type> on every note, so addTypeIfMissing is a no-op too.
    const model = parseScoreModel(GRAND_STAFF_XML);
    // No edit performed. serialize() should round-trip the typed document unchanged.
    const out = model.serialize();
    // Compare structurally: same notes, same durations, same types, no extra/removed elements.
    const reparse = (x: string) => {
      const doc = new DOMParser().parseFromString(x, "application/xml");
      return Array.from(doc.getElementsByTagName("note")).map((n) => ({
        step: n.getElementsByTagName("step").item(0)?.textContent ?? "",
        dur: n.getElementsByTagName("duration").item(0)?.textContent ?? "",
        type: n.getElementsByTagName("type").item(0)?.textContent ?? "",
        dots: n.getElementsByTagName("dot").length,
      }));
    };
    expect(reparse(out)).toEqual(reparse(GRAND_STAFF_XML));
    // And the total element count is unchanged (no field leaked into the DOM as a stray child).
    const count = (x: string) =>
      new DOMParser().parseFromString(x, "application/xml").getElementsByTagName("*").length;
    expect(count(out)).toBe(count(GRAND_STAFF_XML));
  });
});

describe("ScoreModel.changeDuration respects a non-4/4 time signature for the bar capacity", () => {
  it("clamps at the barline of a 2/4 bar (capacity 8 at divisions=4)", () => {
    // 2/4 bar (capacity 8): a quarter note (4) + a quarter rest (4). Lengthen the quarter to a half
    // (8) would add 4; exactly 4 of rest is available, so it grows fully to a half, consuming the
    // rest and filling the 2/4 bar (a stepped, not clamped, outcome since the rung fit exactly).
    const TWO_FOUR = `<?xml version="1.0"?>
<score-partwise version="3.1"><part-list><score-part id="P1"><part-name>P</part-name></score-part></part-list>
<part id="P1"><measure number="1">
  <attributes><divisions>4</divisions><time><beats>2</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>
  <note><pitch><step>C</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type></note>
  <note><rest/><duration>4</duration><voice>1</voice><type>quarter</type></note>
</measure></part></score-partwise>`;
    const model = parseScoreModel(TWO_FOUR);
    const rec = model.changeDuration(0, "longer");
    expect(rec?.outcome).toBe("stepped");
    expect(noteInfo(model.serialize(), "C")).toEqual({ dur: 8, type: "half", dots: 0 });
    expect(measureFilledDivs(model.serialize())).toBe(8); // the 2/4 bar is now full with one half note
    // A further lengthen is now a no-op: a half fills the 2/4 bar, no rest room left.
    const rec2 = model.changeDuration(0, "longer");
    expect(rec2?.outcome).toBe("noRoom");
  });
});

// ---------------------------------------------------------------------------------------------------
// DOTTED v1: the dot TOGGLE (changeDuration(id, "dot")). Add = grow to x1.5 via the lengthen path
// (ripple / absorb / REFUSE when the half does not fit, never clamp); remove = shrink to the plain
// value via the shorten path (freed third -> rest). Single dot only; off-ladder arrival snaps first.
// ---------------------------------------------------------------------------------------------------

// One note of `dur`/`type` then a trailing rest filling an 8/4 bar (capacity 32 at divisions=4), so a
// dot ADD on each plain rung has room to grow into. The dot's added half is half the plain rung.
const dotBar = (dur: number, type: string) => `<?xml version="1.0"?>
<score-partwise version="3.1"><part-list><score-part id="P1"><part-name>P</part-name></score-part></part-list>
<part id="P1"><measure number="1">
  <attributes><divisions>4</divisions><time><beats>8</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>
  <note><pitch><step>C</step><octave>5</octave></pitch><duration>${dur}</duration><voice>1</voice><type>${type}</type></note>
  <note><rest/><duration>${32 - dur}</duration><voice>1</voice><type>whole</type></note>
</measure></part></score-partwise>`;

describe("ScoreModel.changeDuration dot ADD on each plain rung (x1.5, one <dot>, lengthen path)", () => {
  it("adds a single dot on 16th..half, setting <duration>=x1.5 + <type> + exactly one <dot>", () => {
    // 16th(1)->1.5 ... half(8)->12. divisions=4. Each lands on the SAME base type with one dot.
    const cases: Array<[number, string, number]> = [
      [1, "16th", 1.5],
      [2, "eighth", 3],
      [4, "quarter", 6],
      [8, "half", 12],
    ];
    for (const [dur, type, dottedDur] of cases) {
      const model = parseScoreModel(dotBar(dur, type));
      const rec = model.changeDuration(0, "dot");
      expect(rec?.outcome).toBe("stepped");
      expect(rec?.dotVerb).toBe("lengthen"); // adding a dot is a lengthen
      const info = noteInfo(model.serialize(), "C");
      expect(info.dur).toBe(dottedDur);
      expect(info.type).toBe(type); // same base type, now dotted
      expect(info.dots).toBe(1); // EXACTLY one dot, never two
      expect(rec?.toName).toBe(noteValueName(type, 1)); // e.g. "dotted quarter"
    }
  });

  it("the dot ADD consumes trailing rest and keeps the bar full (no overflow)", () => {
    // quarter(4) + rest(28) in an 8/4 bar. Dot -> dotted quarter (6); the 2 added divs come from the
    // rest, which shrinks to 26. The bar still sums to 32, no barline crossing.
    const model = parseScoreModel(dotBar(4, "quarter"));
    model.changeDuration(0, "dot");
    const xml = model.serialize();
    expect(noteInfo(xml, "C")).toEqual({ dur: 6, type: "quarter", dots: 1 });
    const events = measureEvents(xml);
    expect(events).toEqual([
      { rest: false, dur: 6 },
      { rest: true, dur: 26 },
    ]);
    expect(measureFilledDivs(xml)).toBe(32);
  });
});

describe("ScoreModel.changeDuration dot ADD ripples + absorbs like a lengthen", () => {
  // C5 quarter (4), D5 quarter (4), then a quarter rest (4): total 12 in a 3/4 bar. Dotting C5 to a
  // dotted quarter (6) adds 2; the rest absorbs it (4 -> 2) and D5 ripples right by 2 divs.
  const RIPPLE = `<?xml version="1.0"?>
<score-partwise version="3.1"><part-list><score-part id="P1"><part-name>P</part-name></score-part></part-list>
<part id="P1"><measure number="1">
  <attributes><divisions>4</divisions><time><beats>3</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>
  <note><pitch><step>C</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type></note>
  <note><pitch><step>D</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type></note>
  <note><rest/><duration>4</duration><voice>1</voice><type>quarter</type></note>
</measure></part></score-partwise>`;

  it("ripples the following note right and shrinks the trailing rest by the added half", () => {
    const model = parseScoreModel(RIPPLE);
    const dBefore = model.handles.find((h) => h.midi === 74)!.onsetSec; // D5
    const rec = model.changeDuration(0, "dot");
    expect(rec?.outcome).toBe("stepped");
    const xml = model.serialize();
    expect(noteInfo(xml, "C")).toEqual({ dur: 6, type: "quarter", dots: 1 });
    // C(6) D(4) REST(2): the rest shrank from 4 to 2; the bar still sums to 12.
    expect(measureEvents(xml)).toEqual([
      { rest: false, dur: 6 },
      { rest: false, dur: 4 },
      { rest: true, dur: 2 },
    ]);
    expect(measureFilledDivs(xml)).toBe(12);
    // D5 rippled later by 2 divs = 0.25s at 120bpm.
    expect(model.handles.find((h) => h.midi === 74)!.onsetSec).toBeCloseTo(dBefore + 0.25, 6);
  });
});

describe("ScoreModel.changeDuration dot ADD is REFUSED (noRoom) when the half does not fit", () => {
  it("a quarter that fills to the barline cannot be dotted (no following rest, no slack)", () => {
    // 4/4 bar: a quarter (4) then a dotted-half (12) fill it exactly (16). The quarter has no rest
    // room after it and no slack, so dotting it would cross the barline -> REFUSED, DOM unchanged.
    const FULL = `<?xml version="1.0"?>
<score-partwise version="3.1"><part-list><score-part id="P1"><part-name>P</part-name></score-part></part-list>
<part id="P1"><measure number="1">
  <attributes><divisions>4</divisions><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>
  <note><pitch><step>C</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type></note>
  <note><pitch><step>G</step><octave>4</octave></pitch><duration>12</duration><voice>1</voice><type>half</type><dot/></note>
</measure></part></score-partwise>`;
    const model = parseScoreModel(FULL);
    const before = model.serialize();
    const rec = model.changeDuration(0, "dot");
    expect(rec?.outcome).toBe("noRoom");
    expect(rec?.childrenBefore.length).toBe(0); // nothing snapshotted (true no-op)
    expect(model.serialize()).toBe(before); // DOM unchanged, no overflow, no barline crossing
  });

  it("partial room is NOT a clamp: a half with only a quarter rest after it is refused", () => {
    // 4/4 bar: a half (8) + a quarter rest (4) + a quarter note (4) = 16. Dotting the half needs +4
    // (to 12), and exactly 4 of rest is available... so it FITS. Tighten: only 2 of rest available.
    // half(8) + eighth-rest(2) + ... must still sum to 16; use half(8)+rest(2)+dotted-half? Keep it
    // simple: half(8) needs +4 but only a 2-div rest follows -> REFUSED (would need to clamp, which
    // the dot never does).
    const TIGHT = `<?xml version="1.0"?>
<score-partwise version="3.1"><part-list><score-part id="P1"><part-name>P</part-name></score-part></part-list>
<part id="P1"><measure number="1">
  <attributes><divisions>4</divisions><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>
  <note><pitch><step>C</step><octave>5</octave></pitch><duration>8</duration><voice>1</voice><type>half</type></note>
  <note><rest/><duration>2</duration><voice>1</voice><type>eighth</type></note>
  <note><pitch><step>G</step><octave>4</octave></pitch><duration>6</duration><voice>1</voice><type>quarter</type><dot/></note>
</measure></part></score-partwise>`;
    const model = parseScoreModel(TIGHT);
    const before = model.serialize();
    const rec = model.changeDuration(0, "dot");
    expect(rec?.outcome).toBe("noRoom"); // +4 needed, only 2 of rest -> refused, NOT clamped to +2
    expect(model.serialize()).toBe(before);
  });
});

describe("ScoreModel.changeDuration dot on a WHOLE note is refused (no room)", () => {
  it("a whole note filling a 4/4 bar cannot be dotted", () => {
    const WHOLE = `<?xml version="1.0"?>
<score-partwise version="3.1"><part-list><score-part id="P1"><part-name>P</part-name></score-part></part-list>
<part id="P1"><measure number="1">
  <attributes><divisions>4</divisions><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>
  <note><pitch><step>C</step><octave>5</octave></pitch><duration>16</duration><voice>1</voice><type>whole</type></note>
</measure></part></score-partwise>`;
    const model = parseScoreModel(WHOLE);
    const before = model.serialize();
    const rec = model.changeDuration(0, "dot");
    expect(rec?.outcome).toBe("noRoom"); // a dotted whole (24) would overflow the 4/4 bar
    expect(model.serialize()).toBe(before);
    // ... but in an 8/4 bar (capacity 32) a whole HAS room, so the dot is allowed there.
    const big = parseScoreModel(dotBar(16, "whole"));
    expect(big.changeDuration(0, "dot")?.outcome).toBe("stepped");
    expect(noteInfo(big.serialize(), "C")).toEqual({ dur: 24, type: "whole", dots: 1 });
  });
});

describe("ScoreModel.changeDuration dot REMOVE returns to the plain value + inserts the freed rest", () => {
  it("removing a dot from a dotted quarter yields a plain quarter and a freed eighth rest", () => {
    // A dotted quarter (6) then a rest (10) in a 4/4 bar. Pressing dot REMOVES it: quarter (4) + a new
    // rest of the freed 2 right after, then the original rest. The bar still sums to 16.
    const DOTTED = `<?xml version="1.0"?>
<score-partwise version="3.1"><part-list><score-part id="P1"><part-name>P</part-name></score-part></part-list>
<part id="P1"><measure number="1">
  <attributes><divisions>4</divisions><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>
  <note><pitch><step>C</step><octave>5</octave></pitch><duration>6</duration><voice>1</voice><type>quarter</type><dot/></note>
  <note><rest/><duration>10</duration><voice>1</voice><type>half</type></note>
</measure></part></score-partwise>`;
    const model = parseScoreModel(DOTTED);
    const rec = model.changeDuration(0, "dot");
    expect(rec?.outcome).toBe("stepped");
    expect(rec?.dotVerb).toBe("shorten"); // removing a dot is a shorten
    expect(rec?.dottedSnap).toBe(false); // a plain single-dot remove uses the normal from->to
    expect(rec?.fromName).toBe("dotted quarter");
    expect(rec?.toName).toBe("quarter");
    const xml = model.serialize();
    expect(noteInfo(xml, "C")).toEqual({ dur: 4, type: "quarter", dots: 0 }); // plain quarter, no dot
    // C(4) FREED-REST(2) REST(10): the freed eighth sits right after the note.
    expect(measureEvents(xml)).toEqual([
      { rest: false, dur: 4 },
      { rest: true, dur: 2 },
      { rest: true, dur: 10 },
    ]);
    expect(measureFilledDivs(xml)).toBe(16);
  });
});

describe("ScoreModel.changeDuration dot toggle is binary (plain <-> dotted, never two dots)", () => {
  it("dot then dot returns to the original plain value (toggle off)", () => {
    const model = parseScoreModel(dotBar(4, "quarter"));
    model.changeDuration(0, "dot"); // -> dotted quarter (6)
    expect(noteInfo(model.serialize(), "C")).toEqual({ dur: 6, type: "quarter", dots: 1 });
    model.changeDuration(0, "dot"); // -> back to a plain quarter (4)
    expect(noteInfo(model.serialize(), "C")).toEqual({ dur: 4, type: "quarter", dots: 0 });
  });

  it("a double-dotted ARRIVAL normalizes DOWN to a single dot (never up to a third)", () => {
    // A double-dotted half (3.5q = 14 divs) then a rest (2) in a 4/4 bar. Pressing dot removes ONE dot
    // level: dotted half (12), freeing 2 -> rest. dottedSnap folds the announce "double dotted half to
    // dotted half". It NEVER becomes triple-dotted.
    const DOUBLE = `<?xml version="1.0"?>
<score-partwise version="3.1"><part-list><score-part id="P1"><part-name>P</part-name></score-part></part-list>
<part id="P1"><measure number="1">
  <attributes><divisions>4</divisions><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>
  <note><pitch><step>C</step><octave>5</octave></pitch><duration>14</duration><voice>1</voice><type>half</type><dot/><dot/></note>
  <note><rest/><duration>2</duration><voice>1</voice><type>eighth</type></note>
</measure></part></score-partwise>`;
    const model = parseScoreModel(DOUBLE);
    expect(noteInfo(DOUBLE, "C").dots).toBe(2); // precondition: arrives double-dotted
    const rec = model.changeDuration(0, "dot");
    expect(rec?.outcome).toBe("stepped");
    expect(rec?.dottedSnap).toBe(true); // non-plain arrival -> snap phrasing
    expect(rec?.toName).toBe("dotted half");
    expect(noteInfo(model.serialize(), "C")).toEqual({ dur: 12, type: "half", dots: 1 });
  });
});

describe("ScoreModel.changeDuration dot on an OFF-LADDER plain arrival snaps to the nearest rung", () => {
  it("a tuplet-ish odd duration (5 divs) snaps to its nearest plain rung, then dots it", () => {
    // 5 divs at divisions=4 = 1.25q: not a plain rung, and noteTypeForDuration approximates it to a
    // plain quarter (0 dots, nearest base). Pressing dot snaps to the nearest plain rung (quarter, 4)
    // then dots -> dotted quarter (6). dottedSnap is true (an off-ladder arrival was snapped).
    const ODD = `<?xml version="1.0"?>
<score-partwise version="3.1"><part-list><score-part id="P1"><part-name>P</part-name></score-part></part-list>
<part id="P1"><measure number="1">
  <attributes><divisions>4</divisions><time><beats>8</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>
  <note><pitch><step>C</step><octave>5</octave></pitch><duration>5</duration><voice>1</voice><type>quarter</type></note>
  <note><rest/><duration>27</duration><voice>1</voice><type>whole</type></note>
</measure></part></score-partwise>`;
    const model = parseScoreModel(ODD);
    expect(ladderIndexForDuration(5, 4)).toBe(-1); // precondition: off the plain ladder
    const rec = model.changeDuration(0, "dot");
    expect(rec?.outcome).toBe("stepped");
    expect(rec?.dottedSnap).toBe(true);
    expect(rec?.toName).toBe("dotted quarter");
    expect(noteInfo(model.serialize(), "C")).toEqual({ dur: 6, type: "quarter", dots: 1 });
  });
});

describe("ScoreModel.changeDuration dot applies to the WHOLE chord (one shared dotted duration)", () => {
  // A half-note chord C5+E5+G5 (each dur 8) then a half rest (8) in a 4/4 bar. Dotting ANY member
  // must dot ALL of them to a dotted half (12), consuming 4 of the rest, never splitting the chord.
  const CHORD = `<?xml version="1.0"?>
<score-partwise version="3.1"><part-list><score-part id="P1"><part-name>P</part-name></score-part></part-list>
<part id="P1"><measure number="1">
  <attributes><divisions>4</divisions><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>
  <note><pitch><step>C</step><octave>5</octave></pitch><duration>8</duration><voice>1</voice><type>half</type></note>
  <note><chord/><pitch><step>E</step><octave>5</octave></pitch><duration>8</duration><voice>1</voice><type>half</type></note>
  <note><chord/><pitch><step>G</step><octave>5</octave></pitch><duration>8</duration><voice>1</voice><type>half</type></note>
  <note><rest/><duration>8</duration><voice>1</voice><type>half</type></note>
</measure></part></score-partwise>`;

  it("dotting a chord MEMBER dots every member to one shared dotted-half and absorbs the rest", () => {
    const model = parseScoreModel(CHORD);
    const rec = model.changeDuration(1, "dot"); // select the member E5
    expect(rec?.outcome).toBe("stepped");
    const xml = model.serialize();
    for (const step of ["C", "E", "G"]) {
      expect(noteInfo(xml, step)).toEqual({ dur: 12, type: "half", dots: 1 });
    }
    // The chord (3 dotted halves) + the shrunken rest (4): the half rest absorbed 4 of its 8.
    const events = measureEvents(xml);
    expect(events.map((e) => e.dur)).toEqual([12, 12, 12, 4]);
    expect(events[3].rest).toBe(true);
    expect(measureFilledDivs(xml)).toBe(16); // chord members are parallel: bar sum unchanged
  });
});

describe("ScoreModel.changeDuration dot undo via restoreDuration restores the bar exactly", () => {
  // restoreDuration rebuilds the measure from a deep clone of its ELEMENT children, which drops
  // inter-element whitespace text nodes; the bar is STRUCTURALLY identical but not byte-identical, so
  // (like the stepper undo tests) we compare the note structure + onsets, not the raw serialization.
  const noteShapes = (xml: string) => {
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    return Array.from(doc.getElementsByTagName("note")).map((n) => ({
      step: n.getElementsByTagName("step").item(0)?.textContent ?? "",
      rest: n.getElementsByTagName("rest").length > 0,
      dur: n.getElementsByTagName("duration").item(0)?.textContent ?? "",
      type: n.getElementsByTagName("type").item(0)?.textContent ?? "",
      dots: n.getElementsByTagName("dot").length,
    }));
  };

  it("add-dot + restore round-trips to the exact prior duration/type/dots/onsets", () => {
    const model = parseScoreModel(dotBar(4, "quarter"));
    const before = noteShapes(model.serialize());
    const beforeOnsets = model.handles.map((h) => Number(h.onsetSec.toFixed(6)));
    const rec = model.changeDuration(0, "dot");
    expect(noteShapes(model.serialize())).not.toEqual(before);
    model.restoreDuration(rec!);
    expect(noteShapes(model.serialize())).toEqual(before); // structure restored exactly
    expect(model.handles.map((h) => Number(h.onsetSec.toFixed(6)))).toEqual(beforeOnsets);
    expect(noteInfo(model.serialize(), "C")).toEqual({ dur: 4, type: "quarter", dots: 0 });
  });

  it("remove-dot + restore brings back the dot and removes the freed rest", () => {
    const DOTTED = `<?xml version="1.0"?>
<score-partwise version="3.1"><part-list><score-part id="P1"><part-name>P</part-name></score-part></part-list>
<part id="P1"><measure number="1">
  <attributes><divisions>4</divisions><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>
  <note><pitch><step>C</step><octave>5</octave></pitch><duration>6</duration><voice>1</voice><type>quarter</type><dot/></note>
  <note><rest/><duration>10</duration><voice>1</voice><type>half</type></note>
</measure></part></score-partwise>`;
    const model = parseScoreModel(DOTTED);
    const before = noteShapes(model.serialize());
    const rec = model.changeDuration(0, "dot"); // remove the dot, insert a freed rest
    expect(model.restHandles).toHaveLength(2); // freed rest + the original rest
    model.restoreDuration(rec!);
    expect(noteShapes(model.serialize())).toEqual(before); // exact restore: dot back, freed rest gone
    expect(noteInfo(model.serialize(), "C")).toEqual({ dur: 6, type: "quarter", dots: 1 });
    expect(model.restHandles).toHaveLength(1); // back to just the original rest
  });
});

describe("ScoreModel.changeDuration dot keeps handle ids stable + reindex idempotent", () => {
  it("a dot edit adds/removes no pitched note, so handle ids are unchanged", () => {
    const model = parseScoreModel(dotBar(4, "quarter"));
    const midisBefore = model.handles.map((h) => h.midi);
    model.changeDuration(0, "dot");
    expect(model.handles.map((h) => h.midi)).toEqual(midisBefore);
    expect(model.handles[0].midi).toBe(72); // C5 still handle 0
  });

  it("dot add then restore does not double-insert <type> (reindex idempotent)", () => {
    const model = parseScoreModel(dotBar(4, "quarter"));
    const typeCount = (x: string) =>
      new DOMParser().parseFromString(x, "application/xml").getElementsByTagName("type").length;
    const before = typeCount(model.serialize());
    const rec = model.changeDuration(0, "dot");
    model.restoreDuration(rec!);
    expect(typeCount(model.serialize())).toBe(before); // exactly one <type> per note, never doubled
  });
});

describe("ScoreModel.dotState (the dot button's aria-pressed + enabled probe)", () => {
  it("reports PLAIN + toggleable when a plain note has room for the added half", () => {
    const model = parseScoreModel(dotBar(4, "quarter")); // quarter with a big trailing rest
    expect(model.dotState(0)).toEqual({ dotted: false, canToggle: true });
  });

  it("reports DOTTED + always toggleable for an already-dotted note", () => {
    const DOTTED = `<?xml version="1.0"?>
<score-partwise version="3.1"><part-list><score-part id="P1"><part-name>P</part-name></score-part></part-list>
<part id="P1"><measure number="1">
  <attributes><divisions>4</divisions><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>
  <note><pitch><step>C</step><octave>5</octave></pitch><duration>12</duration><voice>1</voice><type>half</type><dot/></note>
  <note><rest/><duration>4</duration><voice>1</voice><type>quarter</type></note>
</measure></part></score-partwise>`;
    // Even though the dotted half fills most of the bar, removing its dot frees time, so it is always
    // toggleable regardless of room.
    expect(parseScoreModel(DOTTED).dotState(0)).toEqual({ dotted: true, canToggle: true });
  });

  it("reports PLAIN + NOT toggleable when a plain note has no room for the half", () => {
    const FULL = `<?xml version="1.0"?>
<score-partwise version="3.1"><part-list><score-part id="P1"><part-name>P</part-name></score-part></part-list>
<part id="P1"><measure number="1">
  <attributes><divisions>4</divisions><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>
  <note><pitch><step>C</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type></note>
  <note><pitch><step>G</step><octave>4</octave></pitch><duration>12</duration><voice>1</voice><type>half</type><dot/></note>
</measure></part></score-partwise>`;
    expect(parseScoreModel(FULL).dotState(0)).toEqual({ dotted: false, canToggle: false });
  });

  it("returns a safe default for an out-of-range id", () => {
    expect(parseScoreModel(FOUR_QUARTERS).dotState(99)).toEqual({ dotted: false, canToggle: false });
  });
});

describe("DOTTED edit-OFF no-op: parsing without a dot edit never mutates the document", () => {
  it("serialize() of a parsed-but-UNEDITED dotted score is byte-identical (dots preserved)", () => {
    // A score that ARRIVES dotted must round-trip unchanged with NO dot edit: the dot machinery only
    // mutates on an explicit changeDuration(id, "dot") call. Confirms edit-off is untouched and the
    // model DISPLAYS (preserves) an arriving dotted note without producing or stripping dots.
    const DOTTED = `<?xml version="1.0"?>
<score-partwise version="3.1"><part-list><score-part id="P1"><part-name>P</part-name></score-part></part-list>
<part id="P1"><measure number="1">
  <attributes><divisions>4</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>
  <note><pitch><step>C</step><octave>5</octave></pitch><duration>6</duration><voice>1</voice><type>quarter</type><dot/></note>
  <note><pitch><step>D</step><octave>5</octave></pitch><duration>10</duration><voice>1</voice><type>half</type><dot/></note>
</measure></part></score-partwise>`;
    const model = parseScoreModel(DOTTED);
    const reparse = (x: string) => {
      const doc = new DOMParser().parseFromString(x, "application/xml");
      return Array.from(doc.getElementsByTagName("note")).map((n) => ({
        step: n.getElementsByTagName("step").item(0)?.textContent ?? "",
        dur: n.getElementsByTagName("duration").item(0)?.textContent ?? "",
        type: n.getElementsByTagName("type").item(0)?.textContent ?? "",
        dots: n.getElementsByTagName("dot").length,
      }));
    };
    expect(reparse(model.serialize())).toEqual(reparse(DOTTED));
  });
});

// ---------------------------------------------------------------------------------------------------
// CROSS-BARLINE TIES (TIE-A..F): a lengthen/dot that overflows the bar fills it to the barline and
// TIES the remainder into the next bar (one barline only); shortening a tied note removes the tie.
// The model emits <tie>/<tied> start/stop pairs; the continuation is flagged isTieContinuation so it
// claims no VisNote (mergeTiedNotes folds the group into ONE held note). The record snapshots BOTH
// bars for an exact two-bar undo. divisions stays load-bearing 4.
// ---------------------------------------------------------------------------------------------------

// The events {rest, dur} of the Nth measure (0-based) in document order (single voice), for two-bar
// fixtures where measureEvents (first-measure-only) is insufficient.
function eventsOfMeasure(xml: string, measureIndex: number): { rest: boolean; dur: number }[] {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const measure = Array.from(doc.getElementsByTagName("measure"))[measureIndex];
  if (!measure) return [];
  return Array.from(measure.getElementsByTagName("note")).map((n) => ({
    rest: n.getElementsByTagName("rest").length > 0,
    dur: Number(n.getElementsByTagName("duration").item(0)?.textContent ?? "0"),
  }));
}

// The filled divisions of the Nth measure (0-based), mirroring measureFilledDivs but bar-indexable.
function measureFilledDivsAt(xml: string, measureIndex: number): number {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const measure = Array.from(doc.getElementsByTagName("measure"))[measureIndex];
  if (!measure) return 0;
  let cursor = 0;
  let extent = 0;
  for (const node of Array.from(measure.children)) {
    const tag = node.tagName.toLowerCase();
    const dur = Number(node.getElementsByTagName("duration").item(0)?.textContent ?? "0");
    if (tag === "backup") cursor -= dur;
    else if (tag === "forward") cursor += dur;
    else if (tag === "note") {
      if (node.getElementsByTagName("chord").item(0)) continue;
      cursor += dur;
    }
    extent = Math.max(extent, cursor);
  }
  return extent;
}

// All notes of a given pitch in the serialized score (a tie produces TWO same-pitch notes), as
// {dur, measure} pairs, so a test can assert the start (bar 1) + the continuation (bar 2) durations.
function notesOfPitch(xml: string, step: string, octave = "5"): { dur: number; measure: number }[] {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const out: { dur: number; measure: number }[] = [];
  const measures = Array.from(doc.getElementsByTagName("measure"));
  measures.forEach((m, mi) => {
    for (const n of Array.from(m.getElementsByTagName("note"))) {
      if (n.getElementsByTagName("rest").length > 0) continue;
      if (
        n.getElementsByTagName("step").item(0)?.textContent === step &&
        n.getElementsByTagName("octave").item(0)?.textContent === octave
      ) {
        out.push({ dur: Number(n.getElementsByTagName("duration").item(0)?.textContent ?? "0"), measure: mi });
      }
    }
  });
  return out;
}

// A 4/4 two-bar fixture: bar 1 = a dotted-half rest (beats 1-3) + a QUARTER D5 on beat 4; bar 2 = a
// whole rest. D5 (handle 0) is the only pitched note. Lengthening it (quarter -> half) overflows the
// bar with downbeat room in bar 2, the canonical cross-barline tie (a half starting on beat 4).
const BEAT4_QUARTER = `<?xml version="1.0"?>
<score-partwise version="3.1"><part-list><score-part id="P1"><part-name>P</part-name></score-part></part-list>
<part id="P1">
<measure number="1">
  <attributes><divisions>4</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>
  <note><rest/><duration>12</duration><voice>1</voice><type>half</type><dot/></note>
  <note><pitch><step>D</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type></note>
</measure>
<measure number="2">
  <note><rest/><duration>16</duration><voice>1</voice><type>whole</type></note>
</measure>
</part></score-partwise>`;

describe("CROSS-BARLINE TIE: a lengthen that overflows ties into the next bar (TIE-A/B/C)", () => {
  it("emits a correct tie (two notes, start/stop <tie>+<tied>, same pitch, both bars full)", () => {
    const model = parseScoreModel(BEAT4_QUARTER);
    const rec = model.changeDuration(0, "longer"); // D5 quarter -> half, overflows beat 4
    expect(rec?.outcome).toBe("tied");
    const xml = model.serialize();

    // TWO D5 notes now: a quarter in bar 1 (the start) + a quarter in bar 2 (the continuation).
    const d5 = notesOfPitch(xml, "D");
    expect(d5).toEqual([
      { dur: 4, measure: 0 },
      { dur: 4, measure: 1 },
    ]);
    // Bar 1's D5 carries the START tie + tied; the continuation note carries the STOP (matched pair).
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    const d5Notes = Array.from(doc.getElementsByTagName("note")).filter(
      (n) => n.getElementsByTagName("step").item(0)?.textContent === "D" && n.getElementsByTagName("rest").length === 0,
    );
    const tieTypes = (n: Element) =>
      Array.from(n.getElementsByTagName("tie")).map((t) => t.getAttribute("type")).sort();
    const tiedTypes = (n: Element) =>
      Array.from(n.getElementsByTagName("tied")).map((t) => t.getAttribute("type")).sort();
    expect(tieTypes(d5Notes[0])).toEqual(["start"]);
    expect(tiedTypes(d5Notes[0])).toEqual(["start"]);
    expect(tieTypes(d5Notes[1])).toEqual(["stop"]);
    expect(tiedTypes(d5Notes[1])).toEqual(["stop"]);
    // The continuation has the SAME pitch and NO new accidental.
    expect(d5Notes[1].getElementsByTagName("accidental").length).toBe(0);
    expect(d5Notes[1].getElementsByTagName("octave").item(0)?.textContent).toBe("5");

    // BOTH bars stay exactly full (the tie is the only thing crossing the barline; no overflow).
    expect(measureFilledDivsAt(xml, 0)).toBe(16);
    expect(measureFilledDivsAt(xml, 1)).toBe(16);
    // Bar 2: the continuation quarter (beat 1) + the remaining dotted-half rest (beats 2-4).
    expect(eventsOfMeasure(xml, 1)).toEqual([
      { rest: false, dur: 4 },
      { rest: true, dur: 12 },
    ]);
    // The announce names the SOUNDING (summed) value across the barline: a half.
    expect(rec?.toName).toBe("half");
    expect(rec?.fromName).toBe("quarter");
  });

  it("flags the continuation as a tie continuation so it claims NO VisNote (one held note)", () => {
    const model = parseScoreModel(BEAT4_QUARTER);
    model.changeDuration(0, "longer");
    // Two D5 handles now exist: the start (mappable) + the continuation (isTieContinuation).
    const d5Handles = model.handles.filter((h) => h.midi === 74);
    expect(d5Handles).toHaveLength(2);
    const starts = d5Handles.filter((h) => !h.isTieContinuation);
    const conts = d5Handles.filter((h) => h.isTieContinuation);
    expect(starts).toHaveLength(1);
    expect(conts).toHaveLength(1);
    // buildHandleToVisIndex maps ONLY the start (the continuation is skipped), so one VisNote, single
    // onset at the start note's onset = beat 4 of bar 1 = 3 quarters = 1.5s at 120bpm.
    const vis = model.handles
      .filter((h) => !h.isTieContinuation)
      .map((h) => ({ midi: h.midi, time: h.onsetSec }));
    const map = buildHandleToVisIndex(model.handles, vis);
    // The start handle maps; the continuation handle does not.
    expect(map.has(starts[0].id)).toBe(true);
    expect(map.has(conts[0].id)).toBe(false);
    expect(starts[0].onsetSec).toBeCloseTo(1.5, 6); // single attack at the barline-adjacent beat 4
  });
});

describe("CROSS-BARLINE TIE: add-dot that overflows auto-ties the same way (DOT-B)", () => {
  it("a dot on a beat-4 quarter fills the bar + ties the remainder, summing to a dotted quarter", () => {
    const model = parseScoreModel(BEAT4_QUARTER);
    const rec = model.changeDuration(0, "dot"); // quarter -> dotted quarter (6), overflows beat 4 by 2
    expect(rec?.outcome).toBe("tied");
    expect(rec?.dotVerb).toBe("lengthen");
    const xml = model.serialize();
    // Bar 1 keeps the quarter D5 (it already filled to the barline); bar 2 gets an EIGHTH continuation
    // (the 2 overflow divisions), summing to a dotted quarter (6) of sound.
    const d5 = notesOfPitch(xml, "D");
    expect(d5).toEqual([
      { dur: 4, measure: 0 },
      { dur: 2, measure: 1 },
    ]);
    expect(rec?.toName).toBe("dotted quarter");
    // Both bars full; the continuation eighth (beat 1) + the rest of bar 2.
    expect(measureFilledDivsAt(xml, 0)).toBe(16);
    expect(measureFilledDivsAt(xml, 1)).toBe(16);
    expect(eventsOfMeasure(xml, 1)).toEqual([
      { rest: false, dur: 2 },
      { rest: true, dur: 14 },
    ]);
  });
});

describe("CROSS-BARLINE TIE: CLAMP when no tie is possible (TIE-A step 3, no overwrite)", () => {
  it("CLAMPS at the final barline when there is NO next bar (single-bar score)", () => {
    const LAST_BAR = `<?xml version="1.0"?>
<score-partwise version="3.1"><part-list><score-part id="P1"><part-name>P</part-name></score-part></part-list>
<part id="P1"><measure number="1">
  <attributes><divisions>4</divisions><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>
  <note><rest/><duration>8</duration><voice>1</voice><type>half</type></note>
  <note><pitch><step>C</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type></note>
  <note><rest/><duration>4</duration><voice>1</voice><type>quarter</type></note>
</measure></part></score-partwise>`;
    const model = parseScoreModel(LAST_BAR);
    // C5 quarter on beat 3 (handle 0, the only pitched note), a quarter rest after it (beat 4).
    // Lengthen quarter -> half grows IN-BAR (consumes the rest), filling to the barline; no overflow.
    const rec = model.changeDuration(0, "longer");
    expect(rec?.outcome).toBe("stepped"); // it fit exactly in-bar
    // Now C5 is a half filling beats 3-4. Lengthen AGAIN (half -> whole): overflow, but NO next bar.
    const rec2 = model.changeDuration(0, "longer");
    expect(rec2?.outcome).toBe("noRoom"); // clamped at the final barline (no room, no tie)
    // No tie markup was emitted (the score has no continuation).
    expect(model.serialize().includes("<tie")).toBe(false);
  });

  it("CLAMPS (no tie) when the next bar's downbeat in this voice is a NOTE (occupied)", () => {
    const OCCUPIED = `<?xml version="1.0"?>
<score-partwise version="3.1"><part-list><score-part id="P1"><part-name>P</part-name></score-part></part-list>
<part id="P1">
<measure number="1">
  <attributes><divisions>4</divisions><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>
  <note><rest/><duration>12</duration><voice>1</voice><type>half</type><dot/></note>
  <note><pitch><step>D</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type></note>
</measure>
<measure number="2">
  <note><pitch><step>E</step><octave>5</octave></pitch><duration>16</duration><voice>1</voice><type>whole</type></note>
</measure>
</part></score-partwise>`;
    const model = parseScoreModel(OCCUPIED);
    const before = model.serialize();
    // D5 on beat 4 wants to grow to a half, but bar 2's downbeat is an E5 NOTE: no room to tie into.
    const rec = model.changeDuration(0, "longer");
    expect(rec?.outcome).toBe("noRoom"); // clamped (already fills its bar), no overwrite of E5
    expect(model.serialize()).toBe(before); // DOM unchanged: no tie, no overwrite
  });
});

describe("CROSS-BARLINE TIE: ONE-barline cap (TIE-B) clamps the continuation to fill the next bar", () => {
  it("a remainder longer than the next bar's downbeat room clamps the continuation, no third segment", () => {
    // Bar 1: half rest (beats 1-2) + half C5 (beats 3-4, tie start). Lengthen half -> whole (wanted 8).
    // Bar 2's downbeat room is only a QUARTER rest (then a dotted-half note), so the continuation is
    // CLAMPED to a quarter (4), not the full remaining half (8). One barline, one continuation.
    const CAP = `<?xml version="1.0"?>
<score-partwise version="3.1"><part-list><score-part id="P1"><part-name>P</part-name></score-part></part-list>
<part id="P1">
<measure number="1">
  <attributes><divisions>4</divisions><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>
  <note><rest/><duration>8</duration><voice>1</voice><type>half</type></note>
  <note><pitch><step>C</step><octave>5</octave></pitch><duration>8</duration><voice>1</voice><type>half</type></note>
</measure>
<measure number="2">
  <note><rest/><duration>4</duration><voice>1</voice><type>quarter</type></note>
  <note><pitch><step>G</step><octave>4</octave></pitch><duration>12</duration><voice>1</voice><type>half</type><dot/></note>
</measure>
</part></score-partwise>`;
    const model = parseScoreModel(CAP);
    const rec = model.changeDuration(0, "longer"); // C5 (handle 0) half -> whole, overflows by a half
    expect(rec?.outcome).toBe("tied");
    const xml = model.serialize();
    // Bar 1: the half C5 stays a half (start). Bar 2: a QUARTER C5 continuation (clamped, not a half).
    const c5 = notesOfPitch(xml, "C");
    expect(c5).toEqual([
      { dur: 8, measure: 0 },
      { dur: 4, measure: 1 },
    ]);
    // The G4 dotted-half is untouched (not overwritten); both bars full; exactly ONE continuation.
    expect(notesOfPitch(xml, "G", "4")).toEqual([{ dur: 12, measure: 1 }]);
    expect(measureFilledDivsAt(xml, 0)).toBe(16);
    expect(measureFilledDivsAt(xml, 1)).toBe(16);
    // The summed sounding value is a dotted half (half + quarter = 12), NOT the whole the rung wanted.
    expect(rec?.toName).toBe("dotted half");
  });
});

describe("CROSS-BARLINE TIE: a following NOTE in-bar blocks a tie (existing clamp behavior intact)", () => {
  it("clamps in-bar (no tie) when a following same-voice NOTE sits before the barline", () => {
    // Bar 1: half C5 (beats 1-2) + quarter rest (beat 3) + quarter G4 (beat 4). Lengthen the half ->
    // whole: it cannot reach the barline (the G4 note blocks beat 4), so it CLAMPS in-bar to a dotted
    // half (the shipped behavior), never a tie - a tie would be non-contiguous across the G4.
    const BLOCKED = `<?xml version="1.0"?>
<score-partwise version="3.1"><part-list><score-part id="P1"><part-name>P</part-name></score-part></part-list>
<part id="P1">
<measure number="1">
  <attributes><divisions>4</divisions><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>
  <note><pitch><step>C</step><octave>5</octave></pitch><duration>8</duration><voice>1</voice><type>half</type></note>
  <note><rest/><duration>4</duration><voice>1</voice><type>quarter</type></note>
  <note><pitch><step>G</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type></note>
</measure>
<measure number="2">
  <note><rest/><duration>16</duration><voice>1</voice><type>whole</type></note>
</measure>
</part></score-partwise>`;
    const model = parseScoreModel(BLOCKED);
    const rec = model.changeDuration(0, "longer");
    expect(rec?.outcome).toBe("clamped"); // in-bar clamp, not a tie
    expect(model.serialize().includes("<tie")).toBe(false); // no tie emitted
    expect(noteInfo(model.serialize(), "C")).toMatchObject({ dur: 12 }); // dotted half, fills to the G4
  });
});

describe("CROSS-BARLINE TIE: shortening a tied note REMOVES the tie (TIE-D)", () => {
  it("shorten deletes the continuation + strips the tie, leaving a rest, following onsets coherent", () => {
    const model = parseScoreModel(BEAT4_QUARTER);
    model.changeDuration(0, "longer"); // create the tie (D5 quarter-tied-to-quarter = a half)
    expect(model.serialize().includes("<tie")).toBe(true);
    // The selectable handle is the START (the continuation has no VisNote). Shorten it: remove the tie.
    const start = model.handles.find((h) => h.midi === 74 && !h.isTieContinuation)!;
    const rec = model.changeDuration(start.id, "shorter");
    expect(rec?.outcome).toBe("untied");
    expect(rec?.fromName).toBe("half"); // the sounding value before removal
    expect(rec?.toName).toBe("quarter"); // the in-bar value after removal
    const xml = model.serialize();
    // No tie markup remains; ONE D5 (the standalone quarter in bar 1); bar 2 is a whole rest again.
    expect(xml.includes("<tie")).toBe(false);
    expect(xml.includes("<tied")).toBe(false);
    expect(notesOfPitch(xml, "D")).toEqual([{ dur: 4, measure: 0 }]);
    // Bar 2 is ALL rests now (the continuation's quarter slot became a rest, beside the existing rest)
    // and stays exactly full; the continuation no longer sounds.
    const bar2 = eventsOfMeasure(xml, 1);
    expect(bar2.every((e) => e.rest)).toBe(true);
    expect(bar2.reduce((s, e) => s + e.dur, 0)).toBe(16);
    expect(measureFilledDivsAt(xml, 0)).toBe(16);
    expect(measureFilledDivsAt(xml, 1)).toBe(16);
    // The model has no continuation handle anymore; D5 maps to one VisNote.
    expect(model.handles.filter((h) => h.midi === 74)).toHaveLength(1);
    expect(model.handles.find((h) => h.midi === 74)!.isTieContinuation).toBe(false);
  });
});

describe("CROSS-BARLINE TIE: undo/redo restores BOTH bars exactly (the widened snapshot, TIE-D)", () => {
  it("undo of a tie-creating lengthen restores both bars to the exact untied state", () => {
    const model = parseScoreModel(BEAT4_QUARTER);
    const beforeBar0 = eventsOfMeasure(model.serialize(), 0);
    const beforeBar1 = eventsOfMeasure(model.serialize(), 1);
    const beforeOnsets = model.handles.map((h) => Number(h.onsetSec.toFixed(6)));
    const rec = model.changeDuration(0, "longer");
    expect(rec?.outcome).toBe("tied");
    expect(model.serialize().includes("<tie")).toBe(true);
    expect(rec?.extraMeasures).toHaveLength(1); // the next bar was snapshotted too

    model.restoreDuration(rec!);
    const xml = model.serialize();
    // BOTH bars are back to the pre-edit state, no tie, the original single D5 handle + onsets.
    expect(xml.includes("<tie")).toBe(false);
    expect(eventsOfMeasure(xml, 0)).toEqual(beforeBar0);
    expect(eventsOfMeasure(xml, 1)).toEqual(beforeBar1);
    expect(model.handles.filter((h) => h.midi === 74)).toHaveLength(1);
    expect(model.handles.map((h) => Number(h.onsetSec.toFixed(6)))).toEqual(beforeOnsets);
  });

  it("redo (re-apply) reproduces the same tie deterministically", () => {
    const model = parseScoreModel(BEAT4_QUARTER);
    const rec1 = model.changeDuration(0, "longer");
    const tiedXml = model.serialize();
    model.restoreDuration(rec1!);
    // Re-applying changeDuration on the restored bar reproduces the identical tie (deterministic).
    const rec2 = model.changeDuration(0, "longer");
    expect(rec2?.outcome).toBe("tied");
    expect(notesOfPitch(model.serialize(), "D")).toEqual(notesOfPitch(tiedXml, "D"));
    expect(model.serialize().includes('<tie type="start"')).toBe(true);
  });
});

describe("CROSS-BARLINE TIE: a CHORD crosses the barline as a tied chord (each member tied)", () => {
  // Bar 1: dotted-half rest (beats 1-3) + a quarter chord C5+E5+G5 on beat 4. Bar 2: whole rest.
  // Lengthening the chord (quarter -> half) ties EACH member to its own continuation in bar 2.
  const CHORD_TIE = `<?xml version="1.0"?>
<score-partwise version="3.1"><part-list><score-part id="P1"><part-name>P</part-name></score-part></part-list>
<part id="P1">
<measure number="1">
  <attributes><divisions>4</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>
  <note><rest/><duration>12</duration><voice>1</voice><type>half</type><dot/></note>
  <note><pitch><step>C</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type></note>
  <note><chord/><pitch><step>E</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type></note>
  <note><chord/><pitch><step>G</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type></note>
</measure>
<measure number="2">
  <note><rest/><duration>16</duration><voice>1</voice><type>whole</type></note>
</measure>
</part></score-partwise>`;

  it("ties every chord member to its own same-pitch continuation (a tied chord, not a clamp)", () => {
    const model = parseScoreModel(CHORD_TIE);
    const rec = model.changeDuration(0, "longer"); // lengthen the chord onset C5
    expect(rec?.outcome).toBe("tied");
    const xml = model.serialize();
    // Each member has a quarter start in bar 1 + a quarter continuation in bar 2.
    for (const step of ["C", "E", "G"]) {
      expect(notesOfPitch(xml, step)).toEqual([
        { dur: 4, measure: 0 },
        { dur: 4, measure: 1 },
      ]);
      // The bar-1 note carries START, the bar-2 continuation carries STOP (matched pair per member).
      const doc = new DOMParser().parseFromString(xml, "application/xml");
      const notes = Array.from(doc.getElementsByTagName("note")).filter(
        (n) => n.getElementsByTagName("step").item(0)?.textContent === step && n.getElementsByTagName("rest").length === 0,
      );
      expect(Array.from(notes[0].getElementsByTagName("tie")).map((t) => t.getAttribute("type"))).toEqual(["start"]);
      expect(Array.from(notes[1].getElementsByTagName("tie")).map((t) => t.getAttribute("type"))).toEqual(["stop"]);
    }
    // The continuation chord stacks: the 2nd + 3rd continuation notes carry <chord/> (one onset).
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    const bar2 = Array.from(doc.getElementsByTagName("measure"))[1];
    const bar2Notes = Array.from(bar2.getElementsByTagName("note")).filter(
      (n) => n.getElementsByTagName("rest").length === 0,
    );
    expect(bar2Notes).toHaveLength(3); // C5, E5, G5 continuations
    expect(bar2Notes[0].getElementsByTagName("chord").length).toBe(0); // onset
    expect(bar2Notes[1].getElementsByTagName("chord").length).toBe(1); // member
    expect(bar2Notes[2].getElementsByTagName("chord").length).toBe(1); // member
    expect(measureFilledDivsAt(xml, 0)).toBe(16);
    expect(measureFilledDivsAt(xml, 1)).toBe(16);
  });

  it("shortening the tied chord removes every member's tie and restores the bars", () => {
    const model = parseScoreModel(CHORD_TIE);
    model.changeDuration(0, "longer"); // tie the chord
    const start = model.handles.find((h) => h.midi === 72 && !h.isTieContinuation)!; // C5 onset start
    const rec = model.changeDuration(start.id, "shorter");
    expect(rec?.outcome).toBe("untied");
    const xml = model.serialize();
    expect(xml.includes("<tie")).toBe(false);
    // One note per chord member again (the quarter chord), bar 2 all rests summing to a full bar.
    for (const step of ["C", "E", "G"]) {
      expect(notesOfPitch(xml, step)).toEqual([{ dur: 4, measure: 0 }]);
    }
    const bar2 = eventsOfMeasure(xml, 1);
    expect(bar2.every((e) => e.rest)).toBe(true);
    expect(bar2.reduce((s, e) => s + e.dur, 0)).toBe(16);
  });
});

describe("CROSS-BARLINE TIE: edit-OFF byte-identical (no tie machinery runs without an edit)", () => {
  it("serialize() of a parsed-but-UNEDITED two-bar score is structurally identical (no stray tie)", () => {
    const model = parseScoreModel(BEAT4_QUARTER);
    const reparse = (x: string) => {
      const doc = new DOMParser().parseFromString(x, "application/xml");
      return Array.from(doc.getElementsByTagName("note")).map((n) => ({
        step: n.getElementsByTagName("step").item(0)?.textContent ?? "",
        rest: n.getElementsByTagName("rest").length > 0,
        dur: n.getElementsByTagName("duration").item(0)?.textContent ?? "",
        type: n.getElementsByTagName("type").item(0)?.textContent ?? "",
        ties: n.getElementsByTagName("tie").length,
      }));
    };
    expect(reparse(model.serialize())).toEqual(reparse(BEAT4_QUARTER));
    expect(model.serialize().includes("<tie")).toBe(false); // no tie added without an edit
  });
});

describe("CROSS-BARLINE TIE: dotState reflects tie-ability (DOT-5 with ties on)", () => {
  it("a plain note with NO in-bar room is still toggleable when it can tie across the barline", () => {
    const model = parseScoreModel(BEAT4_QUARTER); // D5 quarter on beat 4, bar 2 a whole rest
    // No in-bar room (the quarter fills to the barline), but a tie into bar 2 is possible -> toggleable.
    expect(model.dotState(0)).toEqual({ dotted: false, canToggle: true });
  });

  it("a plain note with no room AND no tie target (last bar full) is NOT toggleable", () => {
    const LAST = `<?xml version="1.0"?>
<score-partwise version="3.1"><part-list><score-part id="P1"><part-name>P</part-name></score-part></part-list>
<part id="P1"><measure number="1">
  <attributes><divisions>4</divisions><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>
  <note><rest/><duration>12</duration><voice>1</voice><type>half</type><dot/></note>
  <note><pitch><step>D</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type></note>
</measure></part></score-partwise>`;
    expect(parseScoreModel(LAST).dotState(0)).toEqual({ dotted: false, canToggle: false });
  });
});

// Regression for the cross-barline-ties hand fix: deriveVisNotesFromModel must preserve each
// falling note's HAND across a duration edit by keying on the <note> ELEMENT, NOT on the <staff>.
// The ties change had (wrongly) keyed hand per <staff>: that is correct for a true grand staff but
// REGRESSED the issue-#87 COLLAPSED single-staff class, where the OMR flattens both hands onto ONE
// <staff> that switches treble->bass mid-piece and score.ts tags hand PER MEASURE from the clef in
// effect. With the per-staff rule, ANY duration edit collapsed the whole bass section from "left"
// to the first note's "right" (recoloring those bars + breaking the left-hand mute). These pin the
// per-element fix and guard the grand-staff + tie-continuation shapes against re-introducing it.
describe("deriveVisNotesFromModel preserves per-note hand across a duration edit (ties fix)", () => {
  // A COLLAPSED single staff (issue #87 / icarus.pdf shape): one part, NO <staves>, notes carry NO
  // <staff>, treble clef for measures 1-2 then a clef CHANGE to bass (F clef) for measures 3-4. So
  // score.ts tags the early notes "right" and the later notes "left" on the SAME (defaulted) staff.
  // divisions=4 (load-bearing), 4/4. Each bass measure leaves a trailing rest so a lengthen has room.
  const COLLAPSED_TREBLE_TO_BASS = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>4</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type></note>
      <note><pitch><step>D</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type></note>
      <note><pitch><step>E</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type></note>
      <note><pitch><step>F</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type></note>
    </measure>
    <measure number="2">
      <note><pitch><step>G</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type></note>
      <note><pitch><step>A</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type></note>
      <note><rest/><duration>8</duration><voice>1</voice><type>half</type></note>
    </measure>
    <measure number="3">
      <attributes><clef><sign>F</sign><line>4</line></clef></attributes>
      <note><pitch><step>C</step><octave>3</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type></note>
      <note><rest/><duration>4</duration><voice>1</voice><type>quarter</type></note>
      <note><rest/><duration>8</duration><voice>1</voice><type>half</type></note>
    </measure>
    <measure number="4">
      <note><pitch><step>E</step><octave>3</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type></note>
      <note><pitch><step>G</step><octave>3</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type></note>
      <note><rest/><duration>8</duration><voice>1</voice><type>half</type></note>
    </measure>
  </part>
</score-partwise>`;

  // The pre-edit hand for each pitched <note> ELEMENT, the way score.ts derives it for a SINGLE
  // staff: carry the clef in effect forward across measures (treble => right, bass => left) and tag
  // each note by the clef of its measure. This is the snapshot main.ts captures (captureElementToHand)
  // from the pre-edit score.notes, keyed by the handle's element, and hands to the rederive.
  function preEditElementToHand(model: { handles: readonly NoteHandle[] }): Map<Element, Hand | undefined> {
    const xmlDoc = model.handles[0].el.ownerDocument!;
    const measures = Array.from(xmlDoc.getElementsByTagName("measure"));
    // measure element -> clef in effect (carried forward), reduced to a clef KIND.
    const clefByMeasure = new Map<Element, StaffClefKind | undefined>();
    let current: StaffClefKind | undefined;
    for (const m of measures) {
      const sign = m.getElementsByTagName("clef").item(0)?.getElementsByTagName("sign").item(0)
        ?.textContent?.trim();
      if (sign === "G") current = "treble";
      else if (sign === "F") current = "bass";
      clefByMeasure.set(m, current);
    }
    const map = new Map<Element, Hand | undefined>();
    for (const h of model.handles) {
      let m: Element | null = h.el.parentElement;
      while (m && m.tagName !== "measure") m = m.parentElement;
      map.set(h.el, m ? handFromClefInEffect(clefByMeasure.get(m)) : undefined);
    }
    return map;
  }

  it("the collapsed fixture really puts both hands on ONE defaulted staff (the per-staff trap)", () => {
    const model = parseScoreModel(COLLAPSED_TREBLE_TO_BASS);
    // Every note defaults to <staff>1 (none declare a <staff>), yet they split into two hands by
    // clef. A per-STAFF hand rule therefore HAS to collapse them; only a per-ELEMENT rule survives.
    for (const h of model.handles) {
      expect(h.el.getElementsByTagName("staff").item(0)).toBeNull();
    }
    const hands = preEditElementToHand(model);
    const byPitch = (midi: number) =>
      hands.get(model.handles.find((h) => h.midi === midi)!.el);
    expect(byPitch(72)).toBe("right"); // C5 (treble, measure 1)
    expect(byPitch(48)).toBe("left"); // C3 (bass, measure 3)
  });

  it("a LENGTHEN of a bass note keeps the bass notes left and the treble notes right", () => {
    const model = parseScoreModel(COLLAPSED_TREBLE_TO_BASS);
    const elementToHand = preEditElementToHand(model); // captured BEFORE the edit, as main.ts does

    // Lengthen the bass C3 in measure 3 (quarter -> half, absorbing the following quarter rest).
    const c3 = model.handles.find((h) => h.midi === 48)!;
    const rec = model.changeDuration(c3.id, "longer");
    expect(rec?.outcome).toBe("stepped"); // grew in-bar; no tie, no clamp

    const notes = deriveVisNotesFromModel(model.handles, elementToHand);
    const handOf = (midi: number) => notes.find((n) => n.midi === midi)?.hand;
    // The edited bass note AND its bass neighbours stay LEFT (the regression collapsed them to right).
    expect(handOf(48)).toBe("left"); // C3, the lengthened note
    expect(handOf(52)).toBe("left"); // E3
    expect(handOf(55)).toBe("left"); // G3
    // The treble notes are untouched and stay RIGHT.
    expect(handOf(72)).toBe("right"); // C5
    expect(handOf(74)).toBe("right"); // D5
    expect(handOf(81)).toBe("right"); // A5
    // The lengthened note really grew (quarter 0.5s -> half 1.0s at 120bpm/divisions 4).
    expect(notes.find((n) => n.midi === 48)?.duration).toBeCloseTo(1.0, 5);
  });

  it("a DOT of a bass note also keeps hands correct (the shared rederive path)", () => {
    const model = parseScoreModel(COLLAPSED_TREBLE_TO_BASS);
    const elementToHand = preEditElementToHand(model);

    const c3 = model.handles.find((h) => h.midi === 48)!;
    const rec = model.changeDuration(c3.id, "dot"); // quarter -> dotted quarter (room: the rest)
    expect(rec?.outcome).toBe("stepped");

    const notes = deriveVisNotesFromModel(model.handles, elementToHand);
    const handOf = (midi: number) => notes.find((n) => n.midi === midi)?.hand;
    expect(handOf(48)).toBe("left");
    expect(handOf(52)).toBe("left");
    expect(handOf(72)).toBe("right");
  });

  it("a true GRAND staff keeps staff 2 LEFT and staff 1 RIGHT across a duration edit (no regression)", () => {
    // Reverie-shaped: 4 RH quarters on <staff>1 over a LH whole chord on <staff>2. Hand is tagged by
    // staff/clef on the real path; capture it by staff here (staff 1 -> right, staff 2 -> left).
    const model = parseScoreModel(GRAND_STAFF_XML);
    const elementToHand = new Map<Element, Hand | undefined>();
    for (const h of model.handles) {
      const staff = h.el.getElementsByTagName("staff").item(0)?.textContent?.trim();
      elementToHand.set(h.el, staff === "2" ? "left" : "right");
    }
    // Lengthen the FIRST RH quarter (C5). The LH chord must not move hands.
    const c5 = model.handles.find((h) => h.midi === 72)!;
    model.changeDuration(c5.id, "longer");

    const notes = deriveVisNotesFromModel(model.handles, elementToHand);
    const handOf = (midi: number) => notes.find((n) => n.midi === midi)?.hand;
    expect(handOf(72)).toBe("right"); // RH C5
    expect(handOf(76)).toBe("right"); // RH E5
    expect(handOf(48)).toBe("left"); // LH C3
    expect(handOf(52)).toBe("left"); // LH E3
    expect(handOf(55)).toBe("left"); // LH G3
  });

  it("a tie CONTINUATION created by the edit inherits its tie-start's hand (folded into one bar)", () => {
    // A LH (bass) D5-on-beat-4 in bar 1, bar 2 a whole rest: lengthening the quarter overflows the
    // barline and TIES into bar 2. The continuation is a NEW <note> with no pre-edit hand entry; the
    // fold sums it into the start's held VisNote, which carries the start's (left) hand.
    const TIE_BASS = `<?xml version="1.0"?>
<score-partwise version="3.1"><part-list><score-part id="P1"><part-name>P</part-name></score-part></part-list>
<part id="P1">
  <measure number="1">
    <attributes><divisions>4</divisions><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>F</sign><line>4</line></clef></attributes>
    <note><rest/><duration>12</duration><voice>1</voice><type>half</type><dot/></note>
    <note><pitch><step>D</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type></note>
  </measure>
  <measure number="2">
    <note><rest/><duration>16</duration><voice>1</voice><type>whole</type></note>
  </measure>
</part></score-partwise>`;
    const model = parseScoreModel(TIE_BASS);
    // Pre-edit: the lone D5 is bass => left. (No continuation exists yet.)
    const d5 = model.handles.find((h) => h.midi === 74 && !h.isTieContinuation)!;
    const elementToHand = new Map<Element, Hand | undefined>([[d5.el, "left"]]);

    const rec = model.changeDuration(d5.id, "longer");
    expect(rec?.outcome).toBe("tied"); // crossed the barline with a tie
    // The model now has a continuation handle with NO entry in elementToHand.
    expect(model.handles.some((h) => h.isTieContinuation && h.midi === 74)).toBe(true);

    const notes = deriveVisNotesFromModel(model.handles, elementToHand);
    const d5Notes = notes.filter((n) => n.midi === 74);
    expect(d5Notes).toHaveLength(1); // folded into ONE held bar (one attack), not two
    expect(d5Notes[0].hand).toBe("left"); // inherits the start's hand, not a staff fallback
    expect(d5Notes[0].duration).toBeCloseTo(1.0, 5); // quarter (0.5s) + tied quarter (0.5s) = half
  });
});
