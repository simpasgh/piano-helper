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

// Sensible render options for the read-only edit viewer: SVG view, page width tracking the
// container, and stable element ids in the SVG (the default) so click hit-testing works. We
// pass the container width so the engraving fills the sheet pane like OSMD does.
export function buildToolkitOptions(containerWidthPx: number): Record<string, unknown> {
  return {
    // Track the container so the staff is not clipped; Verovio uses 1/100 mm, but it also
    // accepts px-ish values well for screen layout. A floor avoids a degenerate 0-width layout
    // before the container has measured.
    pageWidth: Math.max(600, Math.round(containerWidthPx * 5)),
    pageHeight: 60000, // tall page so a multi-system score lays out vertically, scrolled in #sheet
    scale: 40,
    adjustPageHeight: true,
    breaks: "auto",
    footer: "none",
    header: "none",
  };
}

// Read every notehead Verovio laid out, as { id, onset seconds, midi }, by parsing the rendered
// SVG for `<g class="note" id="...">` and asking the toolkit for each one's onset + pitch. The
// SVG is the source of truth for which ids are clickable; the toolkit fills in timing/pitch.
// Pure-ish (only toolkit reads), kept here so it stays next to the render flow. `parseSvgNoteIds`
// is split out and exported for unit testing without the toolkit.
export function parseSvgNoteIds(svg: string): string[] {
  const ids: string[] = [];
  // Match <g ... class="note" ... id="..."> and <g ... id="..." ... class="note"> (attribute
  // order is not guaranteed). We scan every <g> that carries class "note" and pull its id.
  const gTag = /<g\b[^>]*>/g;
  let m: RegExpExecArray | null;
  while ((m = gTag.exec(svg)) !== null) {
    const tag = m[0];
    if (!/class\s*=\s*"(?:[^"]*\s)?note(?:\s[^"]*)?"/.test(tag)) continue;
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
  const timemap = toolkit.renderToTimemap({ includeMeasures: true, includeRests: false });

  const ids = parseSvgNoteIds(svg);
  const notes: VerovioNote[] = [];
  for (const id of ids) {
    const ms = toolkit.getTimeForElement(id);
    const midi = midiForElement(toolkit, id);
    if (ms < 0 || midi === null) continue; // unmapped element; skip rather than guess
    notes.push({ id, timeSec: ms / 1000, midi });
  }

  const stepTimes = timemapStepTimes(timemap);
  const idToVisIndex = buildIdToVisNoteIndex(notes, visNotes);
  const visIndexToId = buildVisIndexToId(idToVisIndex);
  return { toolkit, svg, pageCount, notes, timemap, stepTimes, idToVisIndex, visIndexToId };
}
