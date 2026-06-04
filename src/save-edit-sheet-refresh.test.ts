// @vitest-environment jsdom
//
// Smart Edit Mode SAVE refreshes the read-only OSMD cream sheet from the saved XML and recomputes
// the cursor's timing skeleton (score.stepTimes) from it. The wiring lives in main.ts's saveEdits
// (browser-verified end to end), but the two INVARIANTS it stands on are pinned here against the
// REAL engines:
//
//   1. The saved (serialized) model XML, re-parsed by OSMD, carries the edit -> the cream sheet
//      (which is the OSMD render of exactly that XML) now shows the edited note, not the loaded one.
//      This is the bug the fix closes: before it, SAVE persisted the model but left the OSMD sheet
//      showing the originally loaded engraving.
//   2. A pitch edit leaves the onset skeleton (the cursor's per-time-slice steps) UNCHANGED, while a
//      STRUCTURAL edit (a duration change that frees a rest) ADDS a step. The OSMD cursor walks one
//      step per time-slice container, advanced from score.stepTimes; a stale stepTimes of the wrong
//      length would over- or under-run the re-rendered cursor. That is exactly why saveEdits
//      recomputes score.stepTimes after re-rendering rather than keeping the original array.
//
// OSMD's render() (and thus its cursor and the full extractScore) needs a real Canvas2D that jsdom
// lacks (see score.test.ts), so both invariants read the parsed OSMD Sheet model directly, which is
// load-only and jsdom-safe: invariant 1 reads each note's pitch, and invariant 2 counts the
// VerticalSourceStaffEntryContainers (the time slices the cursor steps through, one stepTime each).

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OpenSheetMusicDisplay } from "opensheetmusicdisplay";
import { parseScoreModel } from "./edit-model";

// The bundled demo the browser check drives (public/demo.musicxml): a 4-measure C major scale,
// divisions=1. Read from disk so the test tracks the real fixture.
const DEMO = readFileSync(join(process.cwd(), "public", "demo.musicxml"), "utf8");

// A single 4/4 bar of two half notes, divisions=4 so a duration STEP lands on integer MusicXML
// durations: shortening the first half to a quarter frees a quarter REST, adding a fresh time slice.
const TWO_HALVES = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>4</divisions>
        <key><fifths>0</fifths></key>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        <clef><sign>G</sign><line>2</line></clef>
      </attributes>
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>8</duration><type>half</type></note>
      <note><pitch><step>D</step><octave>5</octave></pitch><duration>8</duration><type>half</type></note>
    </measure>
  </part>
</score-partwise>`;

// Feed OSMD exactly what saveEdits feeds it: a complete document. saveEdits prepends the XML
// declaration to scoreModel.serialize() (XMLSerializer drops it, and OSMD's load() mistakes a
// declaration-less string for a URL), which is the precise bug this test guards. We also strip the
// bundled demo's <!DOCTYPE> (which points at an external DTD): a real browser ignores it, but jsdom
// tries to FETCH it and fails the load, so stripping it keeps the parsed Sheet faithful to the app.
async function parseOsmd(xml: string): Promise<OpenSheetMusicDisplay> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const osmd = new OpenSheetMusicDisplay(container, { autoResize: false, backend: "svg" });
  let doc = xml.replace(/<!DOCTYPE[^>]*>/i, "");
  if (!doc.trimStart().startsWith("<?xml")) doc = '<?xml version="1.0" encoding="UTF-8"?>\n' + doc;
  await osmd.load(doc); // parse only; render() needs a Canvas2D jsdom lacks (see score.test.ts)
  return osmd;
}

// Every sounding note's MIDI in document order, read from the parsed Sheet the way extractScore
// does (OSMD halfTone 0 = C0; MIDI C0 = 12). This is exactly the note set the cream sheet engraves.
function osmdMidis(osmd: OpenSheetMusicDisplay): number[] {
  const midis: number[] = [];
  for (const measure of osmd.Sheet.SourceMeasures) {
    for (const container of measure.VerticalSourceStaffEntryContainers) {
      for (const staffEntry of container.StaffEntries) {
        if (!staffEntry) continue;
        for (const voiceEntry of staffEntry.VoiceEntries) {
          for (const note of voiceEntry.Notes) {
            if (note.isRest()) continue;
            midis.push(note.halfTone + 12);
          }
        }
      }
    }
  }
  return midis;
}

// The number of time-slice containers the OSMD cursor steps through == the length of the stepTimes
// skeleton extractScore builds (it pushes one stepTime per cursor step). A rest IS a cursor stop in
// OSMD, so freeing a rest grows this count.
function osmdStepCount(osmd: OpenSheetMusicDisplay): number {
  let steps = 0;
  for (const measure of osmd.Sheet.SourceMeasures) {
    steps += measure.VerticalSourceStaffEntryContainers.length;
  }
  return steps;
}

describe("Smart Edit SAVE refreshes the cream sheet from the saved XML", () => {
  it("re-parses a saved PITCH edit as the new note (the cream sheet shows the edit, not the loaded note)", async () => {
    const before = osmdMidis(await parseOsmd(DEMO));
    expect(before[0]).toBe(60); // the demo opens on C4 (MIDI 60)

    const model = parseScoreModel(DEMO);
    model.setPitch(0, { step: "C", octave: 5, alter: 0 }); // first note C4 -> C5, an octave jump
    const savedXml = model.serialize();

    const after = osmdMidis(await parseOsmd(savedXml));
    expect(after[0]).toBe(72); // the re-rendered sheet now opens on C5 (MIDI 72)
    expect(after.slice(1)).toEqual(before.slice(1)); // and only the edited note moved
  });

  it("leaves the cursor skeleton (step count) UNCHANGED for a pitch edit, so the recompute is a harmless refresh", async () => {
    const before = osmdStepCount(await parseOsmd(DEMO));

    const model = parseScoreModel(DEMO);
    model.setPitch(0, { step: "C", octave: 5, alter: 0 });
    const savedXml = model.serialize();

    expect(osmdStepCount(await parseOsmd(savedXml))).toBe(before);
  });

  it("GROWS the cursor skeleton for a structural edit, so a stale stepTimes would under-run the re-rendered cursor", async () => {
    const before = osmdStepCount(await parseOsmd(TWO_HALVES));

    const model = parseScoreModel(TWO_HALVES);
    // Shorten the first half note to a quarter: the freed quarter becomes a REST after it, a new
    // time slice the cursor now stops on. The edit must land (a no-op would return null).
    const record = model.changeDuration(0, "shorter");
    expect(record).not.toBeNull();
    const savedXml = model.serialize();

    const after = osmdStepCount(await parseOsmd(savedXml));
    // One added cursor stop: the original (stale) stepTimes would now be one entry short, stranding
    // the cursor a step behind near the edit. saveEdits recomputes it from this re-rendered sheet.
    expect(after).toBeGreaterThan(before);
  });
});
