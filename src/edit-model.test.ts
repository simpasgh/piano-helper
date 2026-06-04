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
  pitchInRange,
  keyAlterForLetter,
  diatonicStep,
  chromaticStep,
  octaveStep,
  pitchFromMidi,
  buildHandleToVisIndex,
  spellingFromPitch,
  restDurationName,
  type ModelPitch,
} from "./edit-model";
import { FIRST_MIDI, LAST_MIDI } from "./piano";

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
