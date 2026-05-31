// @vitest-environment jsdom
//
// Regression test for issue #90: the per-hand controls stayed hidden for a collapsed
// single-staff scan that switches treble -> bass mid-piece, because readClefDeclarations
// dropped every clef when run against a REAL OSMD parse. The unit tests for the timeline
// helpers all fed hand-built ClefDeclaration[] arrays, so they bypassed the extraction and
// CI stayed green while production was broken. This test runs the extraction path against
// MusicXML actually parsed by OpenSheetMusicDisplay in jsdom, so it exercises the exact OSMD
// object graph the live app sees.
//
// Why readClefDeclarations and not the full extractScore: OSMD's render() drives VexFlow,
// which needs a real Canvas2D context (measureText / font) that jsdom does not provide
// (render throws "Cannot set properties of null (setting 'font')"). extractScore reads the
// cursor iterator, which only exists after render. The #90 bug, however, is entirely in
// readClefDeclarations' extraction from the parsed Sheet model, and osmd.load() populates
// that model without rendering, so this test pins the exact broken code path. Hand resolution
// downstream (buildStaffClefTimeline -> handFromClefInEffect -> hasBothHands) is covered by
// the pure-helper tests in piano.test.ts / playback.test.ts; here we compose them on the real
// declarations to assert the user-visible "both hands" outcome.
import { describe, it, expect, beforeAll } from "vitest";
import { OpenSheetMusicDisplay } from "opensheetmusicdisplay";

// jsdom has no Canvas2D implementation and logs a noisy "Not implemented: getContext"
// whenever OSMD touches a canvas during load(). We only parse the Sheet model (no render),
// so a null-returning stub is correct and keeps the test output clean.
beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = () => null as unknown as null;
});
import { readClefDeclarations, readSpelling } from "./score";
import {
  buildStaffClefMap,
  buildStaffClefTimeline,
  handFromClefInEffect,
  handFromStaff,
  midiToLabel,
  type NoteSpelling,
} from "./piano";

// A single-part, single-staff score: treble clef in measure 1, a clef change to bass at the
// head of measure 2. OSMD renders this as ONE staff (the collapsed-grand-staff shape an OMR
// scan produces) and carries the bass clef in the LastInstructionsStaffEntries of measure 1
// with ParentStaff === undefined on the instruction entries.
const SINGLE_STAFF_TREBLE_TO_BASS = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>1</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>1</duration><type>quarter</type></note>
      <note><pitch><step>D</step><octave>5</octave></pitch><duration>1</duration><type>quarter</type></note>
      <note><pitch><step>E</step><octave>5</octave></pitch><duration>1</duration><type>quarter</type></note>
      <note><pitch><step>F</step><octave>5</octave></pitch><duration>1</duration><type>quarter</type></note>
    </measure>
    <measure number="2">
      <attributes><clef><sign>F</sign><line>4</line></clef></attributes>
      <note><pitch><step>C</step><octave>3</octave></pitch><duration>1</duration><type>quarter</type></note>
      <note><pitch><step>D</step><octave>3</octave></pitch><duration>1</duration><type>quarter</type></note>
      <note><pitch><step>E</step><octave>3</octave></pitch><duration>1</duration><type>quarter</type></note>
      <note><pitch><step>G</step><octave>3</octave></pitch><duration>1</duration><type>quarter</type></note>
    </measure>
  </part>
</score-partwise>`;

// A genuine two-staff grand staff: one instrument, <staves>2</staves>, treble on staff 1 and
// bass on staff 2. Regression guard so the single-staff fix does not disturb the multi-staff
// path (issues #73/#82/#36).
const GRAND_STAFF = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>1</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time>
        <staves>2</staves>
        <clef number="1"><sign>G</sign><line>2</line></clef>
        <clef number="2"><sign>F</sign><line>4</line></clef>
      </attributes>
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>2</duration><type>half</type><staff>1</staff></note>
      <note><pitch><step>E</step><octave>5</octave></pitch><duration>2</duration><type>half</type><staff>1</staff></note>
      <backup><duration>4</duration></backup>
      <note><pitch><step>C</step><octave>3</octave></pitch><duration>2</duration><type>half</type><staff>2</staff></note>
      <note><pitch><step>E</step><octave>3</octave></pitch><duration>2</duration><type>half</type><staff>2</staff></note>
    </measure>
  </part>
</score-partwise>`;

// A short Db-major phrase whose printed spelling is flats (the <alter>-1 degrees). This pins
// that OSMD's Pitch.Accidental / FundamentalNote API reports flats for a real <alter>-1 parse,
// which is the exact data readSpelling threads into the labels (issues #56, #58). A natural C
// (no <alter>) and a real sharp (<alter>1) are included so naturals/sharps are covered too.
const DB_MAJOR_FLATS = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>1</divisions><key><fifths>-5</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>
      <note><pitch><step>D</step><alter>-1</alter><octave>4</octave></pitch><duration>1</duration><type>quarter</type></note>
      <note><pitch><step>E</step><alter>-1</alter><octave>4</octave></pitch><duration>1</duration><type>quarter</type></note>
      <note><pitch><step>G</step><alter>-1</alter><octave>4</octave></pitch><duration>1</duration><type>quarter</type></note>
      <note><pitch><step>A</step><alter>-1</alter><octave>4</octave></pitch><duration>1</duration><type>quarter</type></note>
    </measure>
    <measure number="2">
      <note><pitch><step>B</step><alter>-1</alter><octave>4</octave></pitch><duration>1</duration><type>quarter</type></note>
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>1</duration><type>quarter</type></note>
      <note><pitch><step>F</step><alter>1</alter><octave>4</octave></pitch><duration>1</duration><type>quarter</type></note>
      <note><pitch><step>D</step><alter>-1</alter><octave>4</octave></pitch><duration>1</duration><type>quarter</type></note>
    </measure>
  </part>
</score-partwise>`;

// Flatten every sounding note's Pitch out of a parsed Sheet, in document order.
function pitchesOf(osmd: OpenSheetMusicDisplay) {
  const pitches = [];
  for (const measure of osmd.Sheet.SourceMeasures) {
    for (const container of measure.VerticalSourceStaffEntryContainers) {
      for (const staffEntry of container.StaffEntries) {
        if (!staffEntry) continue;
        for (const voiceEntry of staffEntry.VoiceEntries) {
          for (const note of voiceEntry.Notes) {
            if (note.isRest()) continue;
            pitches.push(note.TransposedPitch ?? note.Pitch);
          }
        }
      }
    }
  }
  return pitches;
}

async function parse(xml: string): Promise<OpenSheetMusicDisplay> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const osmd = new OpenSheetMusicDisplay(container, { autoResize: false, backend: "svg" });
  await osmd.load(xml); // parse only; render() needs a real Canvas2D that jsdom lacks
  return osmd;
}

describe("readClefDeclarations against a real OSMD parse (issue #90)", () => {
  it("collects both the treble and the carried-forward bass clef of a collapsed single staff", async () => {
    const osmd = await parse(SINGLE_STAFF_TREBLE_TO_BASS);
    const decls = readClefDeclarations(osmd.Sheet);

    // The previously-dropped declarations: a treble at measure 0 and a bass attributed to
    // measure 1 (it lived in measure 0's LastInstructionsStaffEntries).
    const staffId = osmd.Sheet.Instruments[0].Staves[0].idInMusicSheet;
    expect(decls).toContainEqual({ staffId, measureIndex: 0, clef: "treble", source: "first" });
    expect(decls).toContainEqual({ staffId, measureIndex: 1, clef: "bass", source: "last" });
  });

  it("resolves a collapsed single staff into both hands (the user-visible #90 outcome)", async () => {
    const osmd = await parse(SINGLE_STAFF_TREBLE_TO_BASS);
    const decls = readClefDeclarations(osmd.Sheet);
    const measureCount = osmd.Sheet.SourceMeasures.length;
    const staffId = osmd.Sheet.Instruments[0].Staves[0].idInMusicSheet;
    const timeline = buildStaffClefTimeline(decls, measureCount).get(staffId);

    expect(handFromClefInEffect(timeline?.[0])).toBe("right"); // treble measure
    expect(handFromClefInEffect(timeline?.[1])).toBe("left"); // bass measure
  });

  it("keeps a genuine two-staff grand staff split by first-clef-per-staff (regression guard)", async () => {
    const osmd = await parse(GRAND_STAFF);
    const decls = readClefDeclarations(osmd.Sheet);
    const staves = osmd.Sheet.Instruments[0].Staves;
    expect(staves.length).toBe(2);

    const clefMap = buildStaffClefMap(decls);
    const trebleStaff = staves[0];
    const bassStaff = staves[1];
    expect(
      handFromStaff(clefMap.get(trebleStaff.idInMusicSheet), 0, 2),
    ).toBe("right");
    expect(handFromStaff(clefMap.get(bassStaff.idInMusicSheet), 1, 2)).toBe("left");
  });
});

describe("readSpelling against a real OSMD parse (issues #56, #58)", () => {
  it("reads the printed flat spelling, not the always-sharp enharmonic", async () => {
    const osmd = await parse(DB_MAJOR_FLATS);
    const spellings = pitchesOf(osmd).map(readSpelling);

    // Document order: Db Eb Gb Ab | Bb C(natural) F# Db
    const expected: NoteSpelling[] = [
      { letter: "D", alter: -1 },
      { letter: "E", alter: -1 },
      { letter: "G", alter: -1 },
      { letter: "A", alter: -1 },
      { letter: "B", alter: -1 },
      { letter: "C", alter: 0 },
      { letter: "F", alter: 1 },
      { letter: "D", alter: -1 },
    ];
    expect(spellings).toEqual(expected);
  });

  it("threads those spellings into flat labels in both modes (the user-visible outcome)", async () => {
    const osmd = await parse(DB_MAJOR_FLATS);
    const spellings = pitchesOf(osmd).map(readSpelling);
    // The four flat scale degrees, MIDI-pitch-class agnostic: the label honors the sheet.
    const flats = spellings.slice(0, 5); // Db Eb Gb Ab Bb
    const midis = [61, 63, 66, 68, 70]; // their sounding MIDI (sharp-side pitch classes)
    const letters = ["Db", "Eb", "Gb", "Ab", "Bb"];
    const solfege = ["Reb", "Mib", "Solb", "Lab", "Sib"];
    flats.forEach((spelling, i) => {
      expect(midiToLabel(midis[i], "letters", spelling)).toBe(letters[i]);
      expect(midiToLabel(midis[i], "solfege", spelling)).toBe(solfege[i]);
    });
  });
});
