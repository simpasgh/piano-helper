// Verovio render + sync surface for Smart Edit Mode P0 (read-only viewer + selection).
//
// Verovio is the engraving engine we introduce INSIDE edit mode (behind a flag); OSMD stays
// the read-only viewer when edit mode is off. P0 ships NO editing: this module only loads the
// retained MusicXML, renders an SVG into the sheet container, exposes click hit-testing on
// noteheads (every notehead is a `<g class="note" id="...">` with the stable MEI id), and a
// timemap-driven playback lookup. The notation model + actual edits are later increments.
//
// The toolkit + its ~7MB WASM are LAZY-loaded on first use via dynamic import (mirrors the
// Basic-Pitch lazy import in main.ts), so non-editing users never pay the payload.
//
// The PURE helpers (timemapStepTimes, buildIdToVisNoteIndex, notesAtScoreTime) carry the
// logic worth unit-testing and take plain data, so the tests need no browser/WASM.

import type { VerovioToolkit, TimemapEntry } from "verovio/esm";
import type { VisNote } from "./visualizer";

// A Verovio note distilled to the two fields the id<->VisNote mapping needs: its stable MEI
// id (also its SVG `<g>` id) and its onset time in score SECONDS (converted from the timemap's
// milliseconds). Built once per render and reused for every click.
export interface VerovioNote {
  id: string;
  timeSec: number;
  midi: number;
}

// A Verovio REST distilled to what the rest-handle mapping needs (ADD-a-note v1): its stable MEI
// id (also its `<g class="rest">` SVG id), its onset in score SECONDS (from the timemap's
// `restsOn`), and its 1-based staff ordinal (from the SVG `<g class="staff">` it nests under).
// (onset, staff) uniquely identifies a rest for the model->glyph map in the common case; a same
// (onset, staff) pair with two voices falls back to document order (first wins), like the note map.
export interface VerovioRest {
  id: string;
  timeSec: number;
  staff: number;
}

// Tolerance (seconds) for matching a Verovio onset to a VisNote onset. Both derive from the
// same MusicXML at the same tempo, so they agree to well under a millisecond; rounding to 3
// decimals (1ms) absorbs floating-point drift without merging genuinely distinct onsets
// (the smallest musical gap we render, a 64th at 200bpm, is ~19ms, far above 1ms).
const ONSET_EPSILON_DECIMALS = 3;

function onsetKey(midi: number, timeSec: number): string {
  return `${midi}@${timeSec.toFixed(ONSET_EPSILON_DECIMALS)}`;
}

// Sorted, unique onset times (SECONDS) from a Verovio timemap. This is the Verovio analogue of
// score.ts `stepTimes[]`: the timing skeleton the sheet cursor steps through. The timemap is in
// ms with one entry per onset; we take each entry's tstamp, convert to seconds, and de-dup
// (an entry with no `on` ids, e.g. a measure marker, still marks a valid cursor stop).
export function timemapStepTimes(timemap: readonly TimemapEntry[]): number[] {
  const seen = new Set<number>();
  const times: number[] = [];
  for (const entry of timemap) {
    if (typeof entry.tstamp !== "number") continue;
    const sec = entry.tstamp / 1000;
    const rounded = Number(sec.toFixed(ONSET_EPSILON_DECIMALS));
    if (seen.has(rounded)) continue;
    seen.add(rounded);
    times.push(rounded);
  }
  times.sort((a, b) => a - b);
  return times;
}

// Map each Verovio note id to the index of the matching VisNote, keyed on (midi, onset seconds).
// Used so a notehead click on the staff resolves to the same note the falling-notes view knows,
// keeping selection consistent across the two surfaces.
//
// "Where possible" (the P0 brief): a Verovio note matches when some VisNote shares its pitch and
// onset. Tied notes are the known gap. score.ts MERGES a tie's continuation segments into the
// start note (one sustained bar), so only the tie-START segment shares an onset with a VisNote;
// continuation ids find no match and are simply absent from the map (the caller falls back to
// id-only selection). Chords map cleanly: members share an onset but differ in pitch, so the
// pitch in the key disambiguates them. If two VisNotes truly collide on (midi, onset) the first
// wins; that is a unison the falling view already draws as one bar, so either index is correct.
export function buildIdToVisNoteIndex(
  verovioNotes: readonly VerovioNote[],
  visNotes: readonly VisNote[],
): Map<string, number> {
  const byOnset = new Map<string, number>();
  for (let i = 0; i < visNotes.length; i++) {
    const n = visNotes[i];
    const key = onsetKey(n.midi, Number(n.time.toFixed(ONSET_EPSILON_DECIMALS)));
    if (!byOnset.has(key)) byOnset.set(key, i);
  }
  const idToIndex = new Map<string, number>();
  for (const vn of verovioNotes) {
    const key = onsetKey(vn.midi, Number(vn.timeSec.toFixed(ONSET_EPSILON_DECIMALS)));
    const index = byOnset.get(key);
    if (index !== undefined) idToIndex.set(vn.id, index);
  }
  return idToIndex;
}

// The INVERSE of buildIdToVisNoteIndex: VisNote index -> notehead id. Needed for the dual-
// surface bridge (P1): a selection made on the CANVAS (which is keyed by VisNote index) must
// highlight the same note's notehead on the staff. Built as the reverse of the id->index map so
// the two can never disagree. When several ids map to one VisNote index (a unison the falling
// view draws as one bar), the FIRST id wins, matching id->index's first-wins tie-break.
export function buildVisIndexToId(idToVisIndex: ReadonlyMap<string, number>): Map<number, string> {
  const indexToId = new Map<number, string>();
  for (const [id, index] of idToVisIndex) {
    if (!indexToId.has(index)) indexToId.set(index, id);
  }
  return indexToId;
}

// Map each rest id to its onset SECONDS from the timemap (ADD-a-note v1). The timemap lists rests
// under `restsOn` (verified against the installed toolkit) at the same tstamp the cursor stops at;
// we read each entry's tstamp (ms -> seconds) for every rest it turns on. A rest is timed by its
// onset, so this is the rest analogue of the note onset query. Pure (plain timemap data).
export function restOnsetsFromTimemap(timemap: readonly TimemapEntry[]): Map<string, number> {
  const onsets = new Map<string, number>();
  for (const entry of timemap) {
    if (typeof entry.tstamp !== "number") continue;
    const restsOn = (entry as { restsOn?: string[] }).restsOn;
    if (!restsOn) continue;
    const sec = Number((entry.tstamp / 1000).toFixed(ONSET_EPSILON_DECIMALS));
    for (const id of restsOn) if (!onsets.has(id)) onsets.set(id, sec);
  }
  return onsets;
}

// The 1-based MUSICAL staff number each rest `<g>` nests under. Verovio lays a score out as
// `<g class="system"> ( <g class="measure"> <g class="staff"> ... )*`, so a `<g class="staff">`
// group repeats once PER MEASURE (and once per staff). The staff's musical number is therefore its
// ordinal WITHIN ITS ENCLOSING MEASURE (staff 1 first), NOT its ordinal across the whole document:
// counting staff groups document-wide gives the system/measure index (e.g. a rest in the 4th
// measure of a single-staff score would read "staff 4"), which never matches the model's staff and
// silently breaks the rest map for any multi-measure score. We reset the staff count at each
// `<g class="measure">` boundary. The MEI <staff n> would be authoritative too, but its xml:ids do
// not always equal the SVG `<g>` ids, so we derive the number from the SVG structure here. Pure
// string scan (attribute order is not guaranteed, so we match class-bearing `<g>` open tags). A
// rest with no enclosing staff group (degenerate) maps to staff 1.
export function restStavesFromSvg(svg: string): Map<string, number> {
  // One pass over measure-open + staff-open tags, in document order, recording for each staff group
  // its offset and its 1-based ordinal within the measure that contains it.
  const boundaryOpen =
    /<g\b[^>]*class\s*=\s*"(?:[^"]*\s)?(measure|staff)(?:\s[^"]*)?"[^>]*>/g;
  const staffSpans: { offset: number; staffNo: number }[] = [];
  let staffInMeasure = 0;
  let bm: RegExpExecArray | null;
  while ((bm = boundaryOpen.exec(svg)) !== null) {
    if (bm[1] === "measure") {
      staffInMeasure = 0; // a new measure restarts the staff count
    } else {
      staffInMeasure += 1; // staff group: its within-measure ordinal is the musical staff number
      staffSpans.push({ offset: bm.index, staffNo: staffInMeasure });
    }
  }
  const restOpen = /<g\b[^>]*class\s*=\s*"(?:[^"]*\s)?rest(?:\s[^"]*)?"[^>]*>/g;
  const staves = new Map<string, number>();
  let rm: RegExpExecArray | null;
  while ((rm = restOpen.exec(svg)) !== null) {
    const idMatch = /\bid\s*=\s*"([^"]+)"/.exec(rm[0]);
    if (!idMatch) continue;
    // The enclosing staff is the last staff group that opened before this rest.
    let staffNo = 1;
    for (const span of staffSpans) {
      if (span.offset < rm.index) staffNo = span.staffNo;
      else break;
    }
    staves.set(idMatch[1], staffNo);
  }
  return staves;
}

// A rest's identity key for matching a rendered rest glyph to a model rest handle: (onset seconds,
// staff). Both sides compute the SAME key, so the model -> glyph map can never disagree. The 1ms
// onset rounding matches the note keying.
export function restKey(timeSec: number, staff: number): string {
  return `${staff}@${timeSec.toFixed(ONSET_EPSILON_DECIMALS)}`;
}

// Map each model rest (by its index in restHandles) to the Verovio rest `<g>` id sharing its
// (onset, staff). Built once per render so a rest selection (model side) can find its glyph, and a
// glyph click (render side) can find its rest handle (via the inverse). First-wins on a key
// collision (two voices at one onset+staff), mirroring the note map's tie-break.
export function buildRestIndexToId(
  verovioRests: readonly VerovioRest[],
  modelRests: readonly { onsetSec: number; staff: number }[],
): Map<number, string> {
  const byKey = new Map<string, string>();
  for (const r of verovioRests) {
    const key = restKey(r.timeSec, r.staff);
    if (!byKey.has(key)) byKey.set(key, r.id);
  }
  const map = new Map<number, string>();
  for (let i = 0; i < modelRests.length; i++) {
    const id = byKey.get(restKey(modelRests[i].onsetSec, modelRests[i].staff));
    if (id !== undefined) map.set(i, id);
  }
  return map;
}

// The set of note ids sounding at `scoreTimeSec`, derived purely from the timemap so the rAF
// playback indicator needs no per-frame WASM call. A note is sounding from its onset until the
// next onset that ends it (the timemap `off` list). We resolve the latest onset at or before the
// current time and return its `on` ids minus anything already turned off; this is enough to tint
// the current notehead(s) without tracking note-by-note durations. Returns [] before the first
// onset or when the timemap is empty.
export function notesAtScoreTime(
  timemap: readonly TimemapEntry[],
  scoreTimeSec: number,
): string[] {
  const active = new Set<string>();
  for (const entry of timemap) {
    if (typeof entry.tstamp !== "number") continue;
    const sec = entry.tstamp / 1000;
    if (sec > scoreTimeSec + 1e-6) break; // timemap is time-ordered; nothing later applies yet
    for (const id of entry.off ?? []) active.delete(id);
    for (const id of entry.on ?? []) active.add(id);
  }
  return [...active];
}

// A padded hit target: an element's screen bounding box plus the index that identifies it to the
// caller. The geometry below is pure (no DOM), so the nearest-glyph hit test is unit-testable; the
// DOM helpers in main.ts read each glyph's getBoundingClientRect() into this shape and map the
// winning index back to a `<g>`.
export interface PaddedBox {
  index: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

// The index of the box whose bounds, inflated by `padding` px on every side, CONTAIN the point and
// whose center is nearest the point; or null if the padded point hits no box. This gives a small
// glyph (a notehead or a rest) a finger-sized hot zone without enlarging the drawn glyph: a tap
// that lands within `padding` of a notehead still selects it. Nearest-center breaks ties between
// overlapping padded zones so the closest glyph wins. Pure: the caller supplies screen-space boxes.
export function nearestPaddedBoxIndex(
  boxes: readonly PaddedBox[],
  clientX: number,
  clientY: number,
  padding: number,
): number | null {
  let bestIndex: number | null = null;
  let bestDist = Infinity;
  for (const b of boxes) {
    if (
      clientX < b.left - padding ||
      clientX > b.right + padding ||
      clientY < b.top - padding ||
      clientY > b.bottom + padding
    ) {
      continue;
    }
    const cx = (b.left + b.right) / 2;
    const cy = (b.top + b.bottom) / 2;
    const dist = Math.hypot(clientX - cx, clientY - cy);
    if (dist < bestDist) {
      bestDist = dist;
      bestIndex = b.index;
    }
  }
  return bestIndex;
}

// Lazily-loaded module handles, cached after the first load so re-entering edit mode is cheap.
let createVerovioModule:
  | ((moduleArg?: Record<string, unknown>) => Promise<unknown>)
  | null = null;
let ToolkitCtor: (new (module: unknown) => VerovioToolkit) | null = null;

// A live, rendered Verovio score: the toolkit, the per-note onset+pitch list (for hit-testing),
// the timemap (for the cursor), the stepTimes derived from it, and the id->VisNote map.
export interface VerovioRender {
  toolkit: VerovioToolkit;
  svg: string;
  pageCount: number;
  notes: VerovioNote[];
  timemap: TimemapEntry[];
  stepTimes: number[];
  idToVisIndex: Map<string, number>;
  // The inverse of idToVisIndex (VisNote index -> notehead id), for the dual-surface bridge:
  // a canvas selection (by VisNote index) highlights the matching staff notehead.
  visIndexToId: Map<number, string>;
  // Rendered rests (id, onset seconds, staff) for the ADD-a-note rest mapping. The model side maps
  // its rest handles to these glyph ids by (onset, staff) via buildRestIndexToId.
  rests: VerovioRest[];
}

// Lazy-load the Verovio toolkit + WASM (~7MB) and construct a toolkit instance. The dynamic
// imports mean nothing is fetched until a user first enters edit mode. Cached across calls.
export async function loadVerovioToolkit(): Promise<VerovioToolkit> {
  if (!createVerovioModule) {
    const wasm = await import("verovio/wasm");
    createVerovioModule = wasm.default;
  }
  if (!ToolkitCtor) {
    const esm = await import("verovio/esm");
    ToolkitCtor = esm.VerovioToolkit;
  }
  const module = await createVerovioModule();
  return new ToolkitCtor(module);
}

// Engraving scale (Verovio's `scale`, a percent of the staff's natural size). At this scale the
// staff-line spacing renders at ~9px on screen and a notehead at ~10px, comparable to OSMD's
// default read-only view (the readability target). Higher = larger glyphs but fewer measures per
// system. Exported so a test can pin the pageWidth-from-scale invariant.
export const VEROVIO_SCALE = 50;

// Sensible render options for the edit viewer: SVG view, an engraving that FILLS the container
// width (so it reads like OSMD), and stable element ids in the SVG (the default) so click
// hit-testing works.
//
// The width fix (issue: "staff too small"): Verovio's `pageWidth` is in 1/100 mm and the rendered
// SVG's px width is `pageWidth * scale / 100`. The CSS sizes the SVG with `max-width: 100%`, so if
// the intrinsic px width EXCEEDS the host the browser shrinks the whole engraving (glyphs and all)
// to fit, which is what made the staff a tiny strip (the old `pageWidth = containerWidth * 5` at
// scale 40 produced a ~2x-too-wide SVG that then got halved by the CSS). We instead derive
// `pageWidth` so the intrinsic px width EQUALS the container: pageWidth = containerWidthPx * 100 /
// scale. Then `max-width: 100%` is a no-op (no hidden downscale) and `scale` alone sets glyph size,
// while `breaks: "auto"` wraps long scores into multiple systems that scroll inside #sheet.
export function buildToolkitOptions(containerWidthPx: number): Record<string, unknown> {
  // A floor avoids a degenerate 0-width layout before the container has measured (e.g. a hidden
  // pane). 320px is the narrowest sensible phone content width.
  const widthPx = Math.max(320, Math.round(containerWidthPx));
  return {
    // px width of the SVG == widthPx, so the CSS never downscales the engraving.
    pageWidth: Math.round((widthPx * 100) / VEROVIO_SCALE),
    pageHeight: 60000, // tall page so a multi-system score lays out vertically, scrolled in #sheet
    scale: VEROVIO_SCALE,
    adjustPageHeight: true,
    breaks: "auto",
    footer: "none",
    header: "none",
    // Trim the default page margins so the music uses the full width (OSMD-like edge-to-edge).
    pageMarginLeft: 50,
    pageMarginRight: 50,
    pageMarginTop: 50,
    pageMarginBottom: 50,
  };
}

// Read every notehead Verovio laid out, as { id, onset seconds, midi }, by parsing the rendered
// SVG for `<g class="note" id="...">` and asking the toolkit for each one's onset + pitch. The
// SVG is the source of truth for which ids are clickable; the toolkit fills in timing/pitch.
// Pure-ish (only toolkit reads), kept here so it stays next to the render flow. `parseSvgNoteIds`
// is split out and exported for unit testing without the toolkit.
export function parseSvgNoteIds(svg: string): string[] {
  return parseSvgGIdsWithClass(svg, "note");
}

// The same scan for rest glyphs (ADD-a-note v1): every rest is a `<g class="rest" id="...">`.
export function parseSvgRestIds(svg: string): string[] {
  return parseSvgGIdsWithClass(svg, "rest");
}

// Pull the id of every `<g>` carrying `className` (attribute order is not guaranteed, so we scan
// open tags and test the class). Shared by the note + rest id scans.
function parseSvgGIdsWithClass(svg: string, className: string): string[] {
  const ids: string[] = [];
  const gTag = /<g\b[^>]*>/g;
  const classRe = new RegExp(`class\\s*=\\s*"(?:[^"]*\\s)?${className}(?:\\s[^"]*)?"`);
  let m: RegExpExecArray | null;
  while ((m = gTag.exec(svg)) !== null) {
    const tag = m[0];
    if (!classRe.test(tag)) continue;
    const idMatch = /\bid\s*=\s*"([^"]+)"/.exec(tag);
    if (idMatch) ids.push(idMatch[1]);
  }
  return ids;
}

// Verovio 6.2.0 returns a note's MIDI values at the top level: { pitch, duration, time }, where
// `pitch` is the MIDI number (verified against the installed package). Returns null if absent so
// the caller skips an unmapped element rather than guessing a pitch.
function midiForElement(toolkit: VerovioToolkit, id: string): number | null {
  try {
    const pitch = toolkit.getMIDIValuesForElement(id)?.pitch;
    return typeof pitch === "number" ? pitch : null;
  } catch {
    return null;
  }
}

// Load MusicXML into a toolkit instance and produce a full render bundle: the SVG, the per-note
// onset+pitch list, the timemap + derived stepTimes, and the id->VisNote map. The toolkit is
// reused across loads (loadData replaces the document), so callers may pass an existing one.
export function renderMusicXml(
  toolkit: VerovioToolkit,
  musicXml: string,
  visNotes: readonly VisNote[],
  containerWidthPx: number,
): VerovioRender {
  toolkit.setOptions(buildToolkitOptions(containerWidthPx));
  toolkit.loadData(musicXml);
  const pageCount = toolkit.getPageCount();
  const svg = toolkit.renderToSVG(1);
  // renderToMIDI must run before the timemap/time queries are valid.
  toolkit.renderToMIDI();
  // The cursor/stepTimes timemap EXCLUDES rests (a rest is not a cursor stop), preserving the
  // playhead behavior. A SEPARATE rest-inclusive timemap feeds only the rest-onset map (ADD-a-note),
  // so including rests can never alter the cursor stops the sync invariant depends on.
  const timemap = toolkit.renderToTimemap({ includeMeasures: true, includeRests: false });
  const restTimemap = toolkit.renderToTimemap({ includeMeasures: true, includeRests: true });

  const ids = parseSvgNoteIds(svg);
  const notes: VerovioNote[] = [];
  for (const id of ids) {
    const ms = toolkit.getTimeForElement(id);
    const midi = midiForElement(toolkit, id);
    if (ms < 0 || midi === null) continue; // unmapped element; skip rather than guess
    notes.push({ id, timeSec: ms / 1000, midi });
  }

  // Rests: onset (seconds) from the rest-inclusive timemap's `restsOn`, staff from the SVG nesting.
  const restOnsets = restOnsetsFromTimemap(restTimemap);
  const restStaves = restStavesFromSvg(svg);
  const rests: VerovioRest[] = [];
  for (const id of parseSvgRestIds(svg)) {
    const timeSec = restOnsets.get(id);
    if (timeSec === undefined) continue; // a rest the timemap did not time; skip rather than guess
    rests.push({ id, timeSec, staff: restStaves.get(id) ?? 1 });
  }

  const stepTimes = timemapStepTimes(timemap);
  const idToVisIndex = buildIdToVisNoteIndex(notes, visNotes);
  const visIndexToId = buildVisIndexToId(idToVisIndex);
  return { toolkit, svg, pageCount, notes, timemap, stepTimes, idToVisIndex, visIndexToId, rests };
}
