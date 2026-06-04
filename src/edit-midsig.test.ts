// @vitest-environment jsdom
//
// Unit tests for MID-PIECE key + time signature editing (Smart Edit Mode SIGNATURE EDITING v2). v1
// edited only the INITIAL piece-level <key>/<time>; v2 lets a key/meter change apply PARTWAY through a
// piece (a <key>/<time> in a later measure's <attributes>, in effect from there until the next change).
// These tests pin the model substrate the designer's MID-1..MID-5 spec rests on:
//  - the per-handle resolvers (measureNumberForHandle / timeForHandle / fifthsForHandle / the region
//    starts) report the signature IN EFFECT at the selected handle's measure;
//  - the MID-2 single rule for "set value V at measure M" (no-op / add / edit / remove);
//  - the SCOPED pitch-preservation (only [M, nextKeyChange) notes re-spell; earlier + later regions
//    byte-stable; every MIDI preserved) and the SCOPED mismatched-bar count;
//  - the duration editor's bar capacity already resolves the in-effect meter per measure (finding 2);
//  - byte-exact undo/redo of add/edit/remove; v1 initial-declaration edits unchanged; edit-OFF stable.
// The jsdom env gives DOMParser / XMLSerializer so the parse + serialize round-trip runs without a
// browser. The real-Verovio render of a mid-piece change is covered in edit-model-integration.test.ts.

import { describe, it, expect } from "vitest";
import { parseScoreModel, midiFromPitch, type ScoreModel } from "./edit-model";
import { keyPillLabel } from "./key-names";
import { timePillLabel } from "./time-names";

// ----- Multi-region fixture: a C-major 4/4 head, a mid-piece D-major 3/4 change at m.3, an F-major
// change at m.5 (which BOUNDS the D-major key region at [3,5)). divisions=4 throughout. Each bar fills
// its governing meter exactly (m.1/m.2 = 16 divs at 4/4; m.3/m.4/m.5 = 12 divs at 3/4), so no bar is
// mismatched at baseline. The m.3+ noteheads are BARE letters that D major sharps (F, C) so the
// bare-vs-explicit accidental pass is exercised; m.5 declares F major (one flat: B). -----
const MULTI_REGION = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>4</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type></note>
      <note><pitch><step>D</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type></note>
      <note><pitch><step>E</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type></note>
      <note><pitch><step>F</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type></note>
    </measure>
    <measure number="2">
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type></note>
      <note><pitch><step>A</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type></note>
      <note><pitch><step>B</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type></note>
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type></note>
    </measure>
    <measure number="3">
      <attributes><key><fifths>2</fifths></key><time><beats>3</beats><beat-type>4</beat-type></time></attributes>
      <note><pitch><step>D</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type></note>
      <note><pitch><step>F</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type></note>
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type></note>
    </measure>
    <measure number="4">
      <note><pitch><step>F</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type></note>
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type></note>
      <note><pitch><step>A</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type></note>
    </measure>
    <measure number="5">
      <attributes><key><fifths>-1</fifths></key></attributes>
      <note><pitch><step>B</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type></note>
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type></note>
      <note><pitch><step>D</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type></note>
    </measure>
  </part>
</score-partwise>`;

// The MIDI of every pitched handle, in id order, to assert pitch-preservation across an edit.
function handleMidis(model: ScoreModel): number[] {
  return model.handles.map((h) => h.midi);
}

// The printed accidental token on the note at handle index `i`, or "" when bare.
function accAt(model: ScoreModel, i: number): string {
  return model.handles[i].el.getElementsByTagName("accidental").item(0)?.textContent ?? "";
}

// The own <fifths> of the measure numbered `n` (its direct <attributes><key>), or null. Reads a fresh
// serialize so it reflects the live DOM after an edit. "Own" = the measure declares it (a region start).
function ownFifthsOf(xml: string, n: number): number | null {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  for (const m of Array.from(doc.getElementsByTagName("measure"))) {
    if (m.getAttribute("number") !== String(n)) continue;
    // Only a DIRECT-child <attributes> counts (not a nested element).
    for (const c of Array.from(m.children)) {
      if (c.tagName.toLowerCase() !== "attributes") continue;
      const key = c.getElementsByTagName("key").item(0);
      const f = key?.getElementsByTagName("fifths").item(0);
      return f ? Number(f.textContent) : null;
    }
    return null;
  }
  return null;
}

// The own meter of the measure numbered `n` (its direct <attributes><time>), or null.
function ownMeterOf(xml: string, n: number): { beats: number; beatType: number } | null {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  for (const m of Array.from(doc.getElementsByTagName("measure"))) {
    if (m.getAttribute("number") !== String(n)) continue;
    for (const c of Array.from(m.children)) {
      if (c.tagName.toLowerCase() !== "attributes") continue;
      const time = c.getElementsByTagName("time").item(0);
      if (!time) return null;
      const beats = Number(time.getElementsByTagName("beats").item(0)?.textContent);
      const beatType = Number(time.getElementsByTagName("beat-type").item(0)?.textContent);
      return { beats, beatType };
    }
    return null;
  }
  return null;
}

// The serialized children (structure) of a measure by number, for a byte-stability assertion of regions
// OUTSIDE the affected one. Compares the measure's own <attributes> + each note's pitch/accidental.
function measureFields(xml: string, n: number): string {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  for (const m of Array.from(doc.getElementsByTagName("measure"))) {
    if (m.getAttribute("number") !== String(n)) continue;
    const notes = Array.from(m.getElementsByTagName("note")).map((note) => {
      const pitch = note.getElementsByTagName("pitch").item(0);
      const step = pitch?.getElementsByTagName("step").item(0)?.textContent ?? "";
      const alter = pitch?.getElementsByTagName("alter").item(0)?.textContent ?? "";
      const octave = pitch?.getElementsByTagName("octave").item(0)?.textContent ?? "";
      const acc = note.getElementsByTagName("accidental").item(0)?.textContent ?? "";
      return `${step}${alter}/${octave}:${acc}`;
    });
    return JSON.stringify(notes);
  }
  return "";
}

// ===== Finding 1: the per-handle resolvers report the IN-EFFECT signature at the handle's measure =====

describe("MID-PIECE resolvers: in-effect key/time + measure number at the selected handle", () => {
  it("measureNumberForHandle returns the SCORE measure number of each handle", () => {
    const model = parseScoreModel(MULTI_REGION);
    // 4 + 4 + 3 + 3 + 3 = 17 pitched handles.
    expect(model.handles.length).toBe(17);
    // m.1 handles 0..3, m.2 4..7, m.3 8..10, m.4 11..13, m.5 14..16.
    expect(model.measureNumberForHandle(0)).toBe(1);
    expect(model.measureNumberForHandle(4)).toBe(2);
    expect(model.measureNumberForHandle(8)).toBe(3);
    expect(model.measureNumberForHandle(11)).toBe(4);
    expect(model.measureNumberForHandle(16)).toBe(5);
  });

  it("fifthsForHandle resolves the KEY in effect at the handle's measure (the mid-piece change applies)", () => {
    const model = parseScoreModel(MULTI_REGION);
    expect(model.fifthsForHandle(0)).toBe(0); // m.1 C major
    expect(model.fifthsForHandle(4)).toBe(0); // m.2 inherits C major
    expect(model.fifthsForHandle(8)).toBe(2); // m.3 D major (the mid-piece change)
    expect(model.fifthsForHandle(11)).toBe(2); // m.4 inherits D major
    expect(model.fifthsForHandle(16)).toBe(-1); // m.5 F major
  });

  it("timeForHandle resolves the METER in effect at the handle's measure", () => {
    const model = parseScoreModel(MULTI_REGION);
    expect(model.timeForHandle(0)).toEqual({ beats: 4, beatType: 4 }); // m.1 4/4
    expect(model.timeForHandle(4)).toEqual({ beats: 4, beatType: 4 }); // m.2 inherits 4/4
    expect(model.timeForHandle(8)).toEqual({ beats: 3, beatType: 4 }); // m.3 3/4 (the change)
    expect(model.timeForHandle(11)).toEqual({ beats: 3, beatType: 4 }); // m.4 inherits 3/4
    expect(model.timeForHandle(16)).toEqual({ beats: 3, beatType: 4 }); // m.5 inherits 3/4 (no time change)
  });

  it("the region-start resolvers name where the in-effect signature STARTED (1 for the initial region)", () => {
    const model = parseScoreModel(MULTI_REGION);
    // KEY region starts: m.1/m.2 -> 1 (initial), m.3/m.4 -> 3 (the D-major change), m.5 -> 5 (F major).
    expect(model.keyRegionStartForHandle(0)).toBe(1);
    expect(model.keyRegionStartForHandle(7)).toBe(1);
    expect(model.keyRegionStartForHandle(8)).toBe(3);
    expect(model.keyRegionStartForHandle(13)).toBe(3);
    expect(model.keyRegionStartForHandle(14)).toBe(5);
    // TIME region starts: m.1/m.2 -> 1, m.3+ -> 3 (the 3/4 change; m.5 does not re-declare time).
    expect(model.timeRegionStartForHandle(0)).toBe(1);
    expect(model.timeRegionStartForHandle(8)).toBe(3);
    expect(model.timeRegionStartForHandle(16)).toBe(3);
  });

  it("a chord member uses its ONSET's measure (the handle's own measure)", () => {
    const chordXml = MULTI_REGION.replace(
      "<note><pitch><step>F</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type></note>\n      <note><pitch><step>C</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type></note>\n    </measure>\n    <measure number=\"4\">",
      "<note><pitch><step>F</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type></note>\n      <note><chord/><pitch><step>A</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type></note>\n      <note><pitch><step>C</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type></note>\n    </measure>\n    <measure number=\"4\">",
    );
    const model = parseScoreModel(chordXml);
    // The chord member (the A added in m.3) is in measure 3, in effect D major.
    const chordMember = model.handles.find((h) => h.isChordMember);
    expect(chordMember).toBeDefined();
    expect(model.measureNumberForHandle(chordMember!.id)).toBe(3);
    expect(model.fifthsForHandle(chordMember!.id)).toBe(2);
  });
});

// ===== MID-2: ADD a mid-piece change at a measure with no prior own declaration =====

describe("MID-2 ADD: a mid-piece key/time change at a measure that does not yet declare one", () => {
  it("ADDS a <key> at the target measure (m.2, in the initial C-major region) and respells its region", () => {
    const model = parseScoreModel(MULTI_REGION);
    expect(ownFifthsOf(model.serialize(), 2)).toBeNull(); // m.2 inherits, declares no key
    const before = handleMidis(model);
    const rec = model.setKeyFifths(-2, 2); // add B-flat major at m.2
    expect(rec).not.toBeNull();
    expect(rec?.targetMeasure).toBe(2);
    // m.2 now DECLARES B-flat major; the earlier declaration (m.1) is untouched.
    expect(ownFifthsOf(model.serialize(), 2)).toBe(-2);
    expect(ownFifthsOf(model.serialize(), 1)).toBe(0);
    // The next key change (m.3 D major) is untouched, bounding the new region at [2,3).
    expect(ownFifthsOf(model.serialize(), 3)).toBe(2);
    // PITCH-PRESERVING: every MIDI held.
    expect(handleMidis(model)).toEqual(before);
  });

  it("ADDS a <time> at a measure with no prior own declaration, creating <attributes> if needed", () => {
    const model = parseScoreModel(MULTI_REGION);
    expect(ownMeterOf(model.serialize(), 2)).toBeNull();
    const rec = model.setTimeSignature(6, 8, 2); // add 6/8 at m.2
    expect(rec).not.toBeNull();
    expect(rec?.targetMeasure).toBe(2);
    expect(ownMeterOf(model.serialize(), 2)).toEqual({ beats: 6, beatType: 8 });
    // The initial <time> (m.1) is unchanged; so is the m.3 change.
    expect(ownMeterOf(model.serialize(), 1)).toEqual({ beats: 4, beatType: 4 });
    expect(ownMeterOf(model.serialize(), 3)).toEqual({ beats: 3, beatType: 4 });
  });

  it("an ADD targeting a measure that has NO <attributes> creates one in valid position", () => {
    const model = parseScoreModel(MULTI_REGION);
    // m.4 has no <attributes> at all; adding a key there must create the element.
    const rec = model.setKeyFifths(3, 4); // A major at m.4 (differs from inherited D major +2)
    expect(rec).not.toBeNull();
    const doc = new DOMParser().parseFromString(model.serialize(), "application/xml");
    const m4 = Array.from(doc.getElementsByTagName("measure")).find(
      (m) => m.getAttribute("number") === "4",
    )!;
    const attrs = Array.from(m4.children).find((c) => c.tagName.toLowerCase() === "attributes");
    expect(attrs).toBeDefined();
    // The <attributes> is the FIRST child (before any note).
    expect(m4.children[0].tagName.toLowerCase()).toBe("attributes");
  });
});

// ===== MID-2: EDIT an existing mid-piece change =====

describe("MID-2 EDIT: rewrite an existing mid-piece change in place", () => {
  it("EDITS the m.3 key change (D major -> A major) without touching the other regions", () => {
    const model = parseScoreModel(MULTI_REGION);
    const before = handleMidis(model);
    const m1Before = measureFields(model.serialize(), 1);
    const m5Before = measureFields(model.serialize(), 5);
    const rec = model.setKeyFifths(3, 3); // D major (+2) -> A major (+3) at m.3
    expect(rec?.targetMeasure).toBe(3);
    expect(ownFifthsOf(model.serialize(), 3)).toBe(3); // rewritten in place
    // No NEW <key> was inserted elsewhere; m.1 + m.5 declarations untouched.
    expect(ownFifthsOf(model.serialize(), 1)).toBe(0);
    expect(ownFifthsOf(model.serialize(), 5)).toBe(-1);
    expect(handleMidis(model)).toEqual(before); // pitch-preserving
    // Regions outside [3,5) are byte-stable (m.1 + m.5 note spellings unchanged).
    expect(measureFields(model.serialize(), 1)).toBe(m1Before);
    expect(measureFields(model.serialize(), 5)).toBe(m5Before);
  });

  it("EDITS the m.3 time change (3/4 -> 2/4) in place", () => {
    const model = parseScoreModel(MULTI_REGION);
    const rec = model.setTimeSignature(2, 4, 3);
    expect(rec?.targetMeasure).toBe(3);
    expect(ownMeterOf(model.serialize(), 3)).toEqual({ beats: 2, beatType: 4 });
    expect(ownMeterOf(model.serialize(), 1)).toEqual({ beats: 4, beatType: 4 }); // initial untouched
  });
});

// ===== MID-2: REMOVE by choosing the prior value =====

describe("MID-2 REMOVE: choosing the prior region's value collapses a redundant mid-piece change", () => {
  it("REMOVES the m.3 key change when the chosen value equals the prior region (C major)", () => {
    const model = parseScoreModel(MULTI_REGION);
    const before = handleMidis(model);
    expect(ownFifthsOf(model.serialize(), 3)).toBe(2); // declares D major
    const rec = model.setKeyFifths(0, 3); // 0 == the prior region (C major) -> REMOVE
    expect(rec).not.toBeNull();
    expect(rec?.targetMeasure).toBe(3);
    // m.3's own <key> is gone; the region reverts to inheriting C major.
    expect(ownFifthsOf(model.serialize(), 3)).toBeNull();
    // But m.3 still declares its own <time> (independent axis: removing key keeps time).
    expect(ownMeterOf(model.serialize(), 3)).toEqual({ beats: 3, beatType: 4 });
    // The m.5 F-major change downstream is untouched.
    expect(ownFifthsOf(model.serialize(), 5)).toBe(-1);
    expect(handleMidis(model)).toEqual(before); // pitch-preserving
    // After removal, a handle in the old D-major region resolves to C major (the inherited key).
    const reparsed = parseScoreModel(model.serialize());
    expect(reparsed.fifthsForHandle(8)).toBe(0);
  });

  it("REMOVES the m.3 time change when the chosen value equals the prior region (4/4), keeping the key", () => {
    const model = parseScoreModel(MULTI_REGION);
    const rec = model.setTimeSignature(4, 4, 3); // 4/4 == the prior region -> REMOVE the time
    expect(rec).not.toBeNull();
    expect(ownMeterOf(model.serialize(), 3)).toBeNull(); // time removed
    expect(ownFifthsOf(model.serialize(), 3)).toBe(2); // key kept (independent axis)
  });

  it("dropping the LAST declaration in an <attributes> drops the empty <attributes>", () => {
    // A measure whose <attributes> carries ONLY a <key> + a <time>: removing both drops <attributes>.
    const model = parseScoreModel(MULTI_REGION);
    model.setKeyFifths(0, 3); // remove the key (m.3 attrs now holds only <time>)
    model.setTimeSignature(4, 4, 3); // remove the time -> <attributes> is now empty
    const doc = new DOMParser().parseFromString(model.serialize(), "application/xml");
    const m3 = Array.from(doc.getElementsByTagName("measure")).find(
      (m) => m.getAttribute("number") === "3",
    )!;
    const attrs = Array.from(m3.children).find((c) => c.tagName.toLowerCase() === "attributes");
    expect(attrs).toBeUndefined(); // the empty <attributes> was dropped
  });
});

// ===== MID-2 NO-OP: V equals the inherited value with no own declaration =====

describe("MID-2 NO-OP: choosing the in-effect value at a measure that declares nothing pushes nothing", () => {
  it("KEY no-op: choosing C major at m.2 (which inherits C major, declares no key) returns null", () => {
    const model = parseScoreModel(MULTI_REGION);
    const before = model.serialize();
    expect(model.setKeyFifths(0, 2)).toBeNull(); // m.2 already in effect C major, no own decl
    expect(model.serialize()).toBe(before); // document untouched
  });

  it("TIME no-op: choosing 3/4 at m.4 (which inherits 3/4, declares no time) returns null", () => {
    const model = parseScoreModel(MULTI_REGION);
    const before = model.serialize();
    expect(model.setTimeSignature(3, 4, 4)).toBeNull(); // m.4 already 3/4, no own decl
    expect(model.serialize()).toBe(before);
  });

  it("EDIT-to-same no-op: choosing D major at m.3 (which already declares D major) returns null", () => {
    const model = parseScoreModel(MULTI_REGION);
    const before = model.serialize();
    expect(model.setKeyFifths(2, 3)).toBeNull(); // m.3 already declares +2, not the prior -> no change
    expect(model.serialize()).toBe(before);
  });

  it("no-op when no part has the target measure number", () => {
    const model = parseScoreModel(MULTI_REGION);
    const before = model.serialize();
    expect(model.setKeyFifths(3, 99)).toBeNull(); // no measure 99
    expect(model.setTimeSignature(6, 8, 99)).toBeNull();
    expect(model.serialize()).toBe(before);
  });
});

// ===== MID-3: SCOPED pitch-preservation (only [M, nextKeyChange) re-spells; other regions byte-stable) =====

describe("MID-3 SCOPED pitch-preservation: a mid-piece key edit only re-spells its own region", () => {
  it("respelling at m.3 (D major -> E-flat major) touches ONLY [3,5); m.1/m.2/m.5 byte-stable", () => {
    const model = parseScoreModel(MULTI_REGION);
    const before = handleMidis(model);
    const m1Before = measureFields(model.serialize(), 1);
    const m2Before = measureFields(model.serialize(), 2);
    const m5Before = measureFields(model.serialize(), 5);
    // m.3 currently D major (+2): bare F sounds F#, bare C sounds C#. Re-target to E-flat major (-3),
    // which flats B/E/A but NOT F or C, so the F#/C# now need EXPLICIT sharps to hold their pitch.
    model.setKeyFifths(-3, 3);
    // Every MIDI preserved across the whole piece.
    expect(handleMidis(model)).toEqual(before);
    // Regions OUTSIDE [3,5) are byte-stable: m.1, m.2 (before), m.5 (after) note spellings unchanged.
    expect(measureFields(model.serialize(), 1)).toBe(m1Before);
    expect(measureFields(model.serialize(), 2)).toBe(m2Before);
    expect(measureFields(model.serialize(), 5)).toBe(m5Before);
    // INSIDE the region the F (handle 9) + C (handle 10) of m.3 now carry explicit sharps (E-flat major
    // would otherwise natural them, dropping the pitch a semitone).
    expect(accAt(model, 9)).toBe("sharp"); // F#4 pinned
    expect(accAt(model, 10)).toBe("sharp"); // C#5 pinned
  });

  it("the undo snapshot scopes to the affected region (only [3,5) measures snapshotted)", () => {
    const model = parseScoreModel(MULTI_REGION);
    const rec = model.setKeyFifths(-3, 3)!;
    // The region [3,5) is measures 3 + 4; the snapshot covers exactly those (not all 5 measures).
    const snapshottedNumbers = rec.measures
      .map((m) => m.el.getAttribute("number"))
      .sort();
    expect(snapshottedNumbers).toEqual(["3", "4"]);
  });

  it("a mid-piece key REMOVE re-resolves its region to the inherited key, other regions stable, MIDI held", () => {
    const model = parseScoreModel(MULTI_REGION);
    const before = handleMidis(model);
    const m1Before = measureFields(model.serialize(), 1);
    // First edit the region to E-flat major (which pins the bare F#/C# with explicit sharps), then
    // REMOVE the m.3 key (choose 0 == the prior region, C major). The region's GOVERNING key reverts to
    // C major, but every note holds its sounding pitch (the F that sounds F# keeps its explicit sharp,
    // since neither E-flat nor C major sharps F): MIDI is preserved across both steps.
    model.setKeyFifths(-3, 3);
    model.setKeyFifths(0, 3);
    expect(handleMidis(model)).toEqual(before); // MIDI preserved throughout
    expect(measureFields(model.serialize(), 1)).toBe(m1Before); // m.1 still byte-stable
    // The m.3 region now inherits C major (the removal collapsed the redundant change).
    const reparsed = parseScoreModel(model.serialize());
    expect(reparsed.fifthsForHandle(8)).toBe(0);
    expect(ownFifthsOf(model.serialize(), 3)).toBeNull();
  });
});

// ===== MID-3: SCOPED mismatched-bar count (only bars whose governing meter just changed) =====

// A fixture where the mid-piece time region's bars do NOT all fit the new meter, while OTHER regions do,
// to prove the count scopes. m.1/m.2 are 4/4 (16 divs, fit). m.3 declares 3/4 and has 12 divs (fits 3/4).
// m.4 inherits 3/4 with 12 divs (fits). Changing m.3 to 4/4 makes m.3 + m.4 (the [3,end) region) each
// 12 divs vs a 16-div 4/4 bar -> 2 mismatched; m.1/m.2 are NOT counted (their meter did not change).
const SCOPED_MISMATCH = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>4</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>16</duration><voice>1</voice><type>whole</type></note>
    </measure>
    <measure number="2">
      <note><pitch><step>D</step><octave>5</octave></pitch><duration>16</duration><voice>1</voice><type>whole</type></note>
    </measure>
    <measure number="3">
      <attributes><time><beats>3</beats><beat-type>4</beat-type></time></attributes>
      <note><pitch><step>E</step><octave>5</octave></pitch><duration>8</duration><voice>1</voice><type>half</type></note>
      <note><pitch><step>F</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type></note>
    </measure>
    <measure number="4">
      <note><pitch><step>G</step><octave>5</octave></pitch><duration>8</duration><voice>1</voice><type>half</type></note>
      <note><pitch><step>A</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type></note>
    </measure>
  </part>
</score-partwise>`;

describe("MID-3 SCOPED mismatched-bar count: only the affected time region is counted", () => {
  it("changing m.3 from 3/4 to 4/4 reports the 2 region bars that no longer fit, NOT the fitting head", () => {
    const model = parseScoreModel(SCOPED_MISMATCH);
    const rec = model.setTimeSignature(4, 4, 3)!; // EDIT m.3's 3/4 -> 4/4
    // The region [3,end) is m.3 + m.4, both 12 divs vs a 16-div 4/4 bar -> 2 mismatched.
    expect(rec.mismatchedBars).toBe(2);
  });

  it("changing m.3 to a meter the region DOES fit reports 0 (the bars match)", () => {
    const model = parseScoreModel(SCOPED_MISMATCH);
    // m.3 + m.4 are 12 divs = a 3/4 bar already; relabel to 6/8 (also 12 divs at divisions 4) -> 0.
    const rec = model.setTimeSignature(6, 8, 3)!;
    expect(rec.mismatchedBars).toBe(0);
  });

  it("a mid-piece time edit does NOT count bars in the prior region (the head stays 4/4-correct)", () => {
    const model = parseScoreModel(SCOPED_MISMATCH);
    // Add a 2/4 change at m.4 (region is just m.4 = 12 divs vs an 8-div 2/4 bar -> 1 mismatched).
    const rec = model.setTimeSignature(2, 4, 4)!;
    expect(rec.mismatchedBars).toBe(1); // only m.4, not m.1/m.2/m.3
  });
});

// ===== Finding 2: the duration editor's bar capacity already resolves the in-effect meter =====

describe("Finding 2: a duration edit in a mid-piece time region clamps at THAT region's capacity", () => {
  it("after a 3/4 change at m.3, a lengthen in m.3 clamps at the 3/4 barline (12 divs), not 4/4", () => {
    // m.3 (3/4 = 12 divs) holds a half (8) + a quarter (4) = full. Lengthen the quarter: no room in 3/4
    // (the bar is already full at 12). Under the OLD 4/4 (16) there would be 4 divs of slack, so this
    // proves the capacity uses the MID-PIECE 3/4 in effect at m.3 (finding 2), with no duration-editor
    // change. We do not even edit the signature here: the fixture already declares the mid-piece 3/4.
    const model = parseScoreModel(SCOPED_MISMATCH);
    // The m.3 quarter F5 is the last handle of measure 3.
    const quarter = model.handles.find(
      (h) => h.midi === midiFromPitch({ step: "F", octave: 5, alter: 0 }),
    )!;
    expect(model.measureNumberForHandle(quarter.id)).toBe(3);
    const rec = model.changeDuration(quarter.id, "longer");
    // The bar is full at 3/4 (12 divs), so a lengthen has no in-bar room: it either ties across the
    // barline or refuses; either way it does NOT silently grow in-bar to a 4/4 (16-div) capacity.
    expect(rec).not.toBeNull();
    expect(["noRoom", "tied"]).toContain(rec!.outcome);
  });

  it("a lengthen in the FITS-3/4 region after EDITING the meter to 4/4 now finds in-bar room", () => {
    // Same m.3 half+quarter (12 divs). After relabeling m.3 to 4/4 (capacity 16), the quarter has 4 divs
    // of slack to the barline, so a lengthen STEPS in-bar (the live capacity followed the edit).
    const model = parseScoreModel(SCOPED_MISMATCH);
    model.setTimeSignature(4, 4, 3); // m.3 now 4/4 (16-div capacity)
    const quarter = model.handles.find(
      (h) => h.midi === midiFromPitch({ step: "F", octave: 5, alter: 0 }) && model.measureNumberForHandle(h.id) === 3,
    )!;
    const rec = model.changeDuration(quarter.id, "longer");
    expect(rec?.outcome).toBe("stepped"); // grew in-bar (quarter -> half) within the new 4/4 capacity
  });
});

// ===== Undo / redo: byte-exact restore of add / edit / remove =====

describe("MID undo/redo: add / edit / remove invert byte-for-byte", () => {
  it("undo of a mid-piece key ADD restores the pre-add bytes (the new <key> is gone)", () => {
    const model = parseScoreModel(MULTI_REGION);
    const before = model.serialize();
    const rec = model.setKeyFifths(-2, 2)!; // ADD B-flat major at m.2
    expect(model.serialize()).not.toBe(before);
    model.restoreKey(rec);
    expect(model.serialize()).toBe(before); // byte-exact
  });

  it("undo of a mid-piece key EDIT restores the prior mid-piece value", () => {
    const model = parseScoreModel(MULTI_REGION);
    const before = model.serialize();
    const rec = model.setKeyFifths(3, 3)!; // EDIT m.3 D major -> A major
    model.restoreKey(rec);
    expect(model.serialize()).toBe(before);
    expect(ownFifthsOf(model.serialize(), 3)).toBe(2); // back to D major
  });

  it("undo of a mid-piece key REMOVE re-inserts the removed change", () => {
    const model = parseScoreModel(MULTI_REGION);
    const before = model.serialize();
    const rec = model.setKeyFifths(0, 3)!; // REMOVE the m.3 D-major change
    expect(ownFifthsOf(model.serialize(), 3)).toBeNull();
    model.restoreKey(rec);
    expect(model.serialize()).toBe(before); // the <key> is restored byte-exact
    expect(ownFifthsOf(model.serialize(), 3)).toBe(2);
  });

  it("undo of a mid-piece time ADD / EDIT / REMOVE each restore byte-exact", () => {
    // ADD
    let model = parseScoreModel(MULTI_REGION);
    let before = model.serialize();
    let rec = model.setTimeSignature(6, 8, 2)!;
    model.restoreTime(rec);
    expect(model.serialize()).toBe(before);
    // EDIT
    model = parseScoreModel(MULTI_REGION);
    before = model.serialize();
    rec = model.setTimeSignature(2, 4, 3)!;
    model.restoreTime(rec);
    expect(model.serialize()).toBe(before);
    // REMOVE
    model = parseScoreModel(MULTI_REGION);
    before = model.serialize();
    rec = model.setTimeSignature(4, 4, 3)!;
    expect(ownMeterOf(model.serialize(), 3)).toBeNull();
    model.restoreTime(rec);
    expect(model.serialize()).toBe(before);
    expect(ownMeterOf(model.serialize(), 3)).toEqual({ beats: 3, beatType: 4 });
  });

  it("redo (re-running the targeted edit) reproduces the same change deterministically", () => {
    const model = parseScoreModel(MULTI_REGION);
    const rec = model.setKeyFifths(3, 3)!; // EDIT m.3 -> A major
    const after = model.serialize();
    model.restoreKey(rec);
    // Re-apply (what applyCommand does on redo): same target + value -> same bytes.
    model.setKeyFifths(3, 3);
    expect(model.serialize()).toBe(after);
  });
});

// ===== v1 PRESERVED: initial-declaration edits unchanged when no target is given =====

describe("v1 PRESERVED: setKeyFifths/setTimeSignature with NO target edit the initial declaration", () => {
  it("setKeyFifths(f) (no atMeasure) rewrites the INITIAL <key> with the v1 whole-score snapshot", () => {
    const model = parseScoreModel(MULTI_REGION);
    const rec = model.setKeyFifths(-2); // no target: initial C major -> B-flat major (the v1 START edit)
    expect(rec?.targetMeasure).toBeNull(); // a START edit
    expect(ownFifthsOf(model.serialize(), 1)).toBe(-2); // initial rewritten
    // The whole-score snapshot (v1) covers ALL 5 measures (the START edit's domain is the whole piece;
    // the mid-piece <key>s at m.3/m.5 are not rewritten, only the initial declaration is).
    expect(rec!.measures.length).toBe(5);
    expect(ownFifthsOf(model.serialize(), 3)).toBe(2); // the mid-piece declarations are not touched
    expect(ownFifthsOf(model.serialize(), 5)).toBe(-1);
  });

  it("targeting measure 1 (a selection in the initial region) edits the initial decl, scoped to that region", () => {
    // When a note in measure 1 is selected, the UI passes atMeasure=1: the mid-piece path EDITS the
    // initial <key> in place and scopes the region to [1, nextKeyChange) = m.1+m.2 here (bounded by the
    // m.3 change), so only the initial region re-spells; m.3/m.5 declarations + spellings are untouched.
    const model = parseScoreModel(MULTI_REGION);
    const before = handleMidis(model);
    const m3Before = measureFields(model.serialize(), 3);
    const rec = model.setKeyFifths(-2, 1); // edit the initial C major -> B-flat major AT m.1
    expect(rec?.targetMeasure).toBe(1);
    expect(ownFifthsOf(model.serialize(), 1)).toBe(-2); // initial rewritten in place
    expect(ownFifthsOf(model.serialize(), 3)).toBe(2); // the mid-piece change untouched
    expect(measureFields(model.serialize(), 3)).toBe(m3Before); // m.3 region byte-stable
    expect(handleMidis(model)).toEqual(before); // pitch-preserving
    // The scoped snapshot is the initial region only (m.1 + m.2), NOT all 5 measures.
    expect(rec!.measures.map((m) => m.el.getAttribute("number")).sort()).toEqual(["1", "2"]);
  });

  it("a no-target key edit on a SINGLE-region score holds EVERY note to pitch (the v1 guarantee)", () => {
    // v1's whole-piece pitch-preservation is exact on a single initial region (the real OMR shape).
    const single = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>4</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type></note>
      <note><pitch><step>F</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type></note>
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type></note>
      <note><pitch><step>B</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type></note>
    </measure>
    <measure number="2">
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>16</duration><voice>1</voice><type>whole</type></note>
    </measure>
  </part>
</score-partwise>`;
    const model = parseScoreModel(single);
    const before = handleMidis(model);
    model.setKeyFifths(-3); // C major -> E-flat major
    expect(handleMidis(model)).toEqual(before); // every MIDI held across the whole (single-region) piece
  });

  it("setTimeSignature(b,bt) (no atMeasure) rewrites the INITIAL <time> in place with the tiny record", () => {
    const model = parseScoreModel(MULTI_REGION);
    const rec = model.setTimeSignature(2, 2); // no target: initial 4/4 -> 2/2
    expect(rec?.targetMeasure).toBeNull();
    expect(rec!.measures.length).toBe(0); // the v1 in-place record (no measure snapshot)
    expect(ownMeterOf(model.serialize(), 1)).toEqual({ beats: 2, beatType: 2 });
    // The mid-piece m.3 change is untouched.
    expect(ownMeterOf(model.serialize(), 3)).toEqual({ beats: 3, beatType: 4 });
  });
});

// ===== MID-1 PILL RE-SEAT: the pill reads the in-effect value + (m. N) from the selection =====
//
// reseatSignaturePills (main.ts) composes the model resolvers with the pure pill helpers: with a handle
// selected, reflectKeySig(fifthsForHandle(id), keyRegionStartForHandle(id)); with nothing selected, the
// initial declaration. These tests pin that COMPOSITION end to end (the wiring is the glue), so the pill
// shows the in-effect value with a `(m. N)` qualifier in a mid-piece region and the clean value otherwise.
describe("MID-1 pill re-seat: in-effect value + (m. N) qualifier from the selected handle", () => {
  it("a selection in the INITIAL region shows the clean initial value (no qualifier)", () => {
    const model = parseScoreModel(MULTI_REGION);
    // Handle 4 is in m.2, the initial C-major 4/4 region (region start 1).
    const keyLabel = keyPillLabel(model.fifthsForHandle(4), model.keyRegionStartForHandle(4));
    const t = model.timeForHandle(4);
    const timeLabel = timePillLabel(t.beats, t.beatType, model.timeRegionStartForHandle(4));
    expect(keyLabel).toBe("C major"); // no (m. N): the initial region stays clean
    expect(timeLabel).toBe("4/4");
  });

  it("a selection in a MID-PIECE region shows the in-effect value WITH the (m. N) qualifier", () => {
    const model = parseScoreModel(MULTI_REGION);
    // Handle 11 is in m.4, governed by the D-major 3/4 change that STARTED at m.3.
    const keyLabel = keyPillLabel(model.fifthsForHandle(11), model.keyRegionStartForHandle(11));
    const t = model.timeForHandle(11);
    const timeLabel = timePillLabel(t.beats, t.beatType, model.timeRegionStartForHandle(11));
    expect(keyLabel).toBe("D major (m. 3)"); // the region started at m.3, even though the selection is m.4
    expect(timeLabel).toBe("3/4 (m. 3)");
  });

  it("NO selection shows the INITIAL declaration (the v1 fallback)", () => {
    const model = parseScoreModel(MULTI_REGION);
    // The reseat falls back to initialFifths()/initialTime() with nothing selected.
    expect(keyPillLabel(model.initialFifths())).toBe("C major");
    const t0 = model.initialTime();
    expect(timePillLabel(t0.beats, t0.beatType)).toBe("4/4");
  });
});

// ===== edit-OFF: parsing the multi-region fixture without an edit never mutates it =====

describe("MID edit-OFF: parsing a multi-region score (no signature edit) is byte-stable", () => {
  it("serialize() of the parsed-but-unedited multi-region score keeps every signature + accidental", () => {
    const model = parseScoreModel(MULTI_REGION);
    const out = model.serialize();
    // Structural compare (the serializer may normalize whitespace/quoting): the per-measure own key/time
    // + every note's pitch/accidental must be identical to the source.
    for (const n of [1, 2, 3, 4, 5]) {
      expect(ownFifthsOf(out, n)).toBe(ownFifthsOf(MULTI_REGION, n));
      expect(ownMeterOf(out, n)).toEqual(ownMeterOf(MULTI_REGION, n));
      expect(measureFields(out, n)).toBe(measureFields(MULTI_REGION, n));
    }
  });
});
