import "./style.css";
import * as Tone from "tone";
import { OpenSheetMusicDisplay } from "opensheetmusicdisplay";
import { Visualizer, type VisNote } from "./visualizer";
import { extractScore, type ScoreData } from "./score";
import { recomputeDuration } from "./note-edit";
import { midiToBarLabel } from "./piano";
import {
  parseScoreModel,
  buildHandleToVisIndex,
  deriveVisNotesFromModel,
  diatonicStep,
  chromaticStep,
  octaveStep,
  pitchFromMidi,
  midiFromPitch,
  spellingFromPitch,
  restDurationName,
  durationValueName,
  noteValueName,
  ladderIndexForDuration,
  DURATION_LADDER,
  FIRST_MIDI,
  type ScoreModel,
  type ModelPitch,
  type NoteHandle,
} from "./edit-model";
import {
  CommandStack,
  type SetPitchCommand,
  type DeleteNoteCommand,
  type AddNoteCommand,
  type ChangeDurationCommand,
} from "./edit-commands";
import { shouldStartPitchDrag } from "./edit-pointer";
import {
  staffNavOrder,
  stepStaffNav,
  keyboardDefaultPitch,
  mouseDefaultPitch,
  musicalNeighborAfterDelete,
  type StaffNavTarget,
} from "./edit-nav";

// Label a note for the edit readout + announcements. Falls back to letter-mode names when the
// label mode is "off" (which midiToBarLabel returns as an empty string), so the edit cluster and
// the aria-live region always read a concrete note even with names turned off.
function editNoteLabel(note: VisNote): string {
  const mode = labelMode === "off" ? "letters" : labelMode;
  return midiToBarLabel(note.midi, mode, note.spelling);
}

// Label a MIDI + spelling pair for announcements (the from/to pitch tokens). Same name source
// as editNoteLabel so the announcement matches what is on screen.
function pitchLabel(midi: number, spelling?: { letter: import("./piano").NoteLetter; alter: number }): string {
  const mode = labelMode === "off" ? "letters" : labelMode;
  return midiToBarLabel(midi, mode, spelling);
}
import {
  submitOmr,
  pollOmrResult,
  isCancelled,
  type SystemFrontier,
} from "./omr";
import {
  scanOverlayTitle,
  shouldApplyResult,
  type ScanOverlayKind,
} from "./scan-overlay";
import { shouldShowSystemLoader } from "./streaming-loader";
import {
  renderStreamOverlay,
  clearStreamOverlay,
} from "./sheet-stream-overlay";
import { chooseVideoFormat, buildExportFilename } from "./recorder";
import { chooseExportXml, musicXmlBlob, renderMusicXmlToPdfBlob } from "./export-score";
import {
  uniqueOnsets,
  nextOnset,
  prevOnset,
  scoreTimeToSeek,
  seekToScoreTime,
  formatClock,
  controlsEnabledForScore,
} from "./playback";
import { buildSalamanderSampleMap, SALAMANDER_BASE_URL } from "./sampler";
import { renderSheetLabels } from "./sheet-overlay";
import {
  tempoPercentToRate,
  rateToBpm,
  clampTempoPercent,
  TEMPO_DEFAULT_PERCENT,
} from "./tempo";
import { handGains, formatBalance, BALANCE_DEFAULT } from "./balance";
import type { LabelMode } from "./piano";
import {
  deriveDefaultSheetName,
  resolveEditedSheetName,
  DEFAULT_SHEET_NAME,
} from "./sheet-name";
import {
  loadVerovioToolkit,
  renderMusicXml,
  notesAtScoreTime,
  buildRestIndexToId,
  nearestPaddedBoxIndex,
  type PaddedBox,
  type VerovioRender,
} from "./verovio-view";
import type { VerovioToolkit } from "verovio/esm";

const canvas = document.getElementById("stage") as HTMLCanvasElement;
const fileInput = document.getElementById("file-input") as HTMLInputElement;
const scanInput = document.getElementById("scan-input") as HTMLInputElement;
const audioInput = document.getElementById("audio-input") as HTMLInputElement;
const playBtn = document.getElementById("play-btn") as HTMLButtonElement;
const prevNoteBtn = document.getElementById("prev-note-btn") as HTMLButtonElement;
const nextNoteBtn = document.getElementById("next-note-btn") as HTMLButtonElement;
const seekSlider = document.getElementById("seek-slider") as HTMLInputElement;
const timeReadout = document.getElementById("time-readout") as HTMLSpanElement;
const exportMenuBtn = document.getElementById("export-menu-btn") as HTMLButtonElement;
const exportMenu = document.getElementById("export-menu") as HTMLDivElement;
const exportMenuWrap = exportMenuBtn.closest(".export-menu-wrap") as HTMLDivElement;
const exportVideoBtn = document.getElementById("export-video-btn") as HTMLButtonElement;
const exportPdfBtn = document.getElementById("export-pdf-btn") as HTMLButtonElement;
const exportMusicxmlBtn = document.getElementById("export-musicxml-btn") as HTMLButtonElement;
const namesBtn = document.getElementById("names-btn") as HTMLButtonElement;
const namesLabel = document.getElementById("names-label") as HTMLSpanElement;
const playLabel = document.getElementById("play-label") as HTMLSpanElement;
const playIcon = playBtn.querySelector(".play-icon") as SVGSVGElement | null;
const handMutes = document.getElementById("hand-mutes") as HTMLDivElement;
const muteRightBtn = document.getElementById("mute-right-btn") as HTMLButtonElement;
const muteLeftBtn = document.getElementById("mute-left-btn") as HTMLButtonElement;
const balanceSlider = document.getElementById("balance-slider") as HTMLInputElement;
const balanceReadout = document.getElementById("balance-readout") as HTMLButtonElement;

// Reflect a hand's mute state on its toggle button: aria-pressed for assistive tech, plus a
// state-explicit tooltip ("audible. Click to mute." vs "muted. Click to unmute.") so the
// control never relies on the ambiguous "pressed" alone. The speaker-slash glyph and accent
// fill are driven purely by aria-pressed in CSS, so no glyph swap is needed here.
function reflectHandMute(btn: HTMLButtonElement, muted: boolean): void {
  btn.setAttribute("aria-pressed", String(muted));
  const name = btn.querySelector(".hand-toggle-label")?.textContent ?? "This hand";
  btn.title = muted
    ? `${name}: muted. Click to unmute.`
    : `${name}: audible. Click to mute.`;
}
const editBtn = document.getElementById("edit-btn") as HTMLButtonElement;
const verovioCredit = document.getElementById("verovio-credit") as HTMLAnchorElement;
const editToolbar = document.getElementById("edit-toolbar") as HTMLDivElement;
const undoBtn = document.getElementById("undo-btn") as HTMLButtonElement;
const redoBtn = document.getElementById("redo-btn") as HTMLButtonElement;
const noteEdit = document.getElementById("note-edit") as HTMLDivElement;
const noteEditReadout = document.getElementById("note-edit-readout") as HTMLSpanElement;
const pitchDownBtn = document.getElementById("pitch-down-btn") as HTMLButtonElement;
const pitchUpBtn = document.getElementById("pitch-up-btn") as HTMLButtonElement;
// Duration steppers (Smart Edit P3 v1): shorter/longer walk the note-value ladder. Placed between
// pitch and delete in the note cluster, disabled at the ladder ends (same idiom as undo/redo).
const durShorterBtn = document.getElementById("dur-shorter-btn") as HTMLButtonElement;
const durLongerBtn = document.getElementById("dur-longer-btn") as HTMLButtonElement;
// Dot TOGGLE (DOTTED v1): plain <-> dotted. aria-pressed + a lit look track whether the selected
// note is dotted; disabled only when a PLAIN note has no room for the x1.5 half before the barline.
const durDotBtn = document.getElementById("dur-dot-btn") as HTMLButtonElement;
const deleteNoteBtn = document.getElementById("delete-note-btn") as HTMLButtonElement;
// ADD-a-note v1 cluster: shown when a REST is selected (swaps with the note cluster). One primary
// "Add a note" button + a readout naming the rest.
const addNoteCluster = document.getElementById("add-note") as HTMLDivElement;
const addNoteReadout = document.getElementById("add-note-readout") as HTMLSpanElement;
const addNoteBtn = document.getElementById("add-note-btn") as HTMLButtonElement;
// COMMIT v1: explicit Save / Discard when leaving edit mode (trailing toolbar group).
const editSaveBtn = document.getElementById("edit-save-btn") as HTMLButtonElement;
const editDiscardBtn = document.getElementById("edit-discard-btn") as HTMLButtonElement;
const editLive = document.getElementById("edit-live") as HTMLSpanElement;
const tempoSlider = document.getElementById("tempo-slider") as HTMLInputElement;
const tempoReadout = document.getElementById("tempo-readout") as HTMLButtonElement;
const sheetContainer = document.getElementById("sheet") as HTMLDivElement;
const sheetNameBtn = document.getElementById("sheet-name") as HTMLButtonElement;
const sheetNameInput = document.getElementById("sheet-name-input") as HTMLInputElement;
const sheetNoteCount = document.getElementById("sheet-note-count") as HTMLSpanElement;
const trackStatus = document.getElementById("track-status") as HTMLSpanElement;
const soundStatus = document.getElementById("sound-status") as HTMLSpanElement;
const scanOverlay = document.getElementById("scan-overlay") as HTMLDivElement;
const scanOverlayTitleEl = document.getElementById(
  "scan-overlay-title",
) as HTMLHeadingElement;
const scanOverlayCancel = document.getElementById(
  "scan-overlay-cancel",
) as HTMLButtonElement;

const visualizer = new Visualizer(canvas);
const osmd = new OpenSheetMusicDisplay("sheet", {
  autoResize: true,
  backend: "svg",
  followCursor: true,
  // Piano Helper is single-instrument, so the per-part instrument label is noise.
  // The Clarity-OMR engine emits a UUID as the part name, which OSMD would render
  // as "Instr. P93a6af..." down the left margin; suppress part names entirely.
  drawPartNames: false,
});

let synth: Tone.PolySynth | null = null;
let sampler: Tone.Sampler | null = null;
let part: Tone.Part | null = null;
let score: ScoreData | null = null;
let stepIndex = 0;
let playing = false;
// Sorted, unique note onset times for the prev/next-note step controls (issue #29). Rebuilt
// per score; works for both sheet and audio scores.
let onsets: number[] = [];
// True while the user is dragging the seek slider, so the rAF loop does not fight the drag
// by writing the slider value back from the (also-changing) transport position.
let userSeeking = false;
// Whether the current score has a rendered sheet + cursor. MusicXML/OMR scores do;
// audio-transcribed scores (issue #19) are falling-notes only, so the cursor stays hidden.
let hasSheet = false;
// User-editable sheet name (issue #44). `sheetName` is the current friendly title (defaulted
// from the MusicXML title or file name, overridable by the user via inline edit). It persists
// for the session and survives status messages (scanning/transcribing/errors) that temporarily
// take over the toolbar slot. `noteCount` is shown next to the name. `nameEditing` guards the
// inline edit so background updates do not clobber an in-progress rename.
let sheetName = "";
let noteCount = 0;
let nameEditing = false;
// Per-hand audio mute (issue #37). Read fresh inside the Part callback so toggling a hand
// mutes/unmutes its audio with no Part rebuild. "unknown" notes always sound. The visualizer
// draws every note from score.notes regardless, so muting only affects audio, not the falling
// notes. A note already sounding when its hand is muted keeps ringing until its release
// completes (mute applies from the next onset); that is acceptable for v1.
const handMuted = { left: false, right: false };

// Per-hand volume balance (issue #70). Integer percent in [-100, 100]: 0 = even, positive
// favours the right hand (left quieter), negative the left. Read fresh inside the Part
// callback and applied as the per-note velocity, so dragging the slider takes effect from
// the next onset with no Part rebuild. Layered under the mute flags: a muted hand returns
// early before velocity is ever computed. "unknown" notes ignore balance (always full).
let handBalance = BALANCE_DEFAULT;

// Smart Edit Mode P1 (DUAL-SURFACE pitch editing on one source-of-truth model). The source
// MusicXML is retained per load so edit mode can hand it to Verovio and build the editable
// model; cleared for audio loads, which have no MusicXML to engrave.
let sourceMusicXml: string | null = null;
// True while edit mode is on (the Verovio staff replaces the OSMD sheet and BOTH surfaces are
// editable). Lazy state below is allocated on first entry only, so non-editing users never
// load the ~7MB Verovio toolkit.
let editMode = false;
let verovioToolkit: VerovioToolkit | null = null;
let verovioRender: VerovioRender | null = null;
let verovioHost: HTMLDivElement | null = null;
// Guard against overlapping enter-edit-mode loads (the lazy import is async).
let editModeLoading = false;

// The editable notation model (single source of truth) + its invertible command stack, built
// on entering edit mode from the retained MusicXML. Pitch edits on EITHER surface mutate the
// model through a command; the staff re-renders from the model and the falling notes + audio
// re-derive, so the two surfaces never diverge. Null when not in edit mode.
let scoreModel: ScoreModel | null = null;
let commandStack: CommandStack | null = null;
// The ONE shared selection (Designer P1-1): a model note keyed by its stable HANDLE id (which
// survives re-renders, unlike a VisNote index, which a delete would shift). Both surfaces show
// it at once. Null = nothing selected.
let selectedHandle: number | null = null;
// The shared selection can instead be a REST (ADD-a-note v1): a rest is selectable + convertible
// but is NOT a NoteHandle, so it gets its OWN selection slot. At most one of selectedHandle /
// selectedRest is non-null; selecting a note clears the rest and vice versa. Keyed by the model's
// rest-registry id (its document position among rests, stable until a structural edit). A rest has
// no VisNote (rests do not fall), so it shows ONLY on the staff.
let selectedRest: number | null = null;
// COMMIT v1: the falling notes captured on entering edit mode (the SESSION baseline: the loaded
// score, or the last Saved version if this is a re-entry), so DISCARD can restore the live player
// to that baseline. Holding the array by a shallow slice is safe: every edit builds FRESH VisNote
// arrays via finishEdit and never mutates these in place. Null when not in edit mode.
let editBaselineNotes: VisNote[] | null = null;
// The last MOUSE press on a rest (ADD-a-note v1): which rest + the click height + its glyph, so a
// following "Add a note" button press fills at the CLICKED staff line/space (ADD-2 mouse default).
// Cleared whenever the selection changes by any other path (keyboard selection, selecting a note),
// so a stale click height never leaks into a keyboard-driven add.
let lastRestPointer: { restId: number; clientY: number; glyph: SVGGElement } | null = null;
// Maps rebuilt after every edit: handle id <-> VisNote index. The handle is the durable spine;
// the VisNote index drives the canvas highlight and (via verovioRender.visIndexToId) the staff.
let handleToVisIndex = new Map<number, number>();
let visIndexToHandle = new Map<number, number>();
// Rest maps rebuilt on every staff render (ADD-a-note v1): model rest-index <-> Verovio rest glyph
// id, keyed by (onset, staff). restIndexToId drives the selected-rest halo + targeting a rest by
// keyboard; idToRestIndex resolves a rest-glyph CLICK back to the model rest.
let restIndexToId = new Map<number, string>();
let idToRestIndex = new Map<string, number>();
// Ids currently tinted as "playing" so the rAF loop only touches the DOM when the set changes.
let staffPlayingIds: string[] = [];

// Active pitch-drag state (Smart Edit P1). A drag previews ONLY on the active surface and
// commits ONE coalesced command on release; the mirror surface holds the pre-edit state
// de-emphasized. `surface` says which surface owns the gesture; `handleId` is the note being
// dragged; `beforePitch` is the pre-drag pitch (the command's `before`); `lastPreviewMidi`
// tracks the last previewed pitch so we only re-render on a real change.
interface DragState {
  surface: "staff" | "canvas";
  handleId: number;
  beforePitch: ModelPitch;
  startClientX: number;
  startClientY: number;
  startMidi: number;
  pxPerStep: number; // staff only: vertical px per diatonic step (from the notehead bbox)
  lastPreviewMidi: number;
  moved: boolean;
}
let drag: DragState | null = null;

// The VisNote index the current selection maps to, or null. Derived from the shared handle via
// the post-edit map; a tie continuation or a deleted note can leave a handle with no VisNote.
function selectedVisIndex(): number | null {
  if (selectedHandle === null) return null;
  return handleToVisIndex.get(selectedHandle) ?? null;
}

// Sync the readout text to the current balance. The slider position is set separately so
// programmatic resets (per load) and the reset button both reflect cleanly.
function reflectBalance(): void {
  balanceReadout.textContent = formatBalance(handBalance);
}

// Tempo (issue #14). The Part schedules notes at score seconds, which Tone converts to
// transport ticks using the bpm at build time. We capture the default bpm once as the
// score-speed baseline and never let it change while a Part is built, so note tick
// positions are always rate-independent. Audio speed is driven by setting the live
// transport bpm to BASE_BPM * tempoRate; the visual consumers (falling notes + cursor)
// read a derived "score time" = transport.seconds * tempoRate, which equals
// ticks * 60 / (PPQ * BASE_BPM) regardless of the current bpm. So audio, falling notes,
// and the cursor all scale in lockstep and a live tempo change never makes score time
// jump (transport.seconds is continuous; multiplying by the new rate is continuous too).
const BASE_BPM = Tone.getTransport().bpm.value;
let tempoRate = 1.0;

function ensureSynth(): Tone.PolySynth {
  if (!synth) {
    synth = new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: "triangle" },
      envelope: { attack: 0.005, decay: 0.2, sustain: 0.3, release: 0.8 },
    }).toDestination();
    synth.volume.value = -8;
  }
  return synth;
}

// The instrument used at trigger time. Returns the sampled piano once its buffers have
// loaded, otherwise the synth. Resolved per-note (not captured at Part-build time) so
// playback upgrades to the sampler the moment loading finishes, even mid-session.
function getInstrument(): Tone.PolySynth | Tone.Sampler {
  if (sampler && sampler.loaded) return sampler;
  return ensureSynth();
}

// Start fetching the Salamander samples in the background at startup. This only downloads
// buffers; it does not need a running AudioContext and must not block initial render. The
// synth covers playback until (and if) the sampler finishes loading. On failure we keep
// the synth permanently and surface a brief, non-fatal note.
function startSamplerLoad(): void {
  soundStatus.textContent = "Loading piano sound...";
  try {
    sampler = new Tone.Sampler({
      urls: buildSalamanderSampleMap(),
      baseUrl: SALAMANDER_BASE_URL,
      release: 1,
      onload: () => {
        soundStatus.textContent = "";
      },
      onerror: () => {
        sampler = null;
        soundStatus.textContent = "Using basic sound (piano samples unavailable).";
      },
    }).toDestination();
    sampler.volume.value = -6;
  } catch {
    sampler = null;
    soundStatus.textContent = "Using basic sound (piano samples unavailable).";
  }
}

async function loadScoreFile(file: File): Promise<void> {
  const xml = await file.text();
  await loadScoreXml(xml, file.name);
}

// Build the Tone.Part that schedules a set of notes. The callback reads handMuted / handBalance /
// getInstrument FRESH each trigger, so a mute toggle, a balance drag, or the sampler finishing
// loading all take effect from the next onset with no Part rebuild. Shared by the full load
// (loadNotes), the in-place edit reload (reloadNotes), and the progressive upgrade (upgradeNotes) so
// the three never drift. The caller owns disposing the previous Part and setting the transport
// bpm/position around the swap; this just creates the new Part and starts it at 0.
function createPart(notes: VisNote[]): Tone.Part {
  const built = new Tone.Part((time, note) => {
    // Skip the trigger when this note's hand is muted (issue #37). A skipped trigger has no side
    // effects, so the export/instrument paths are unaffected.
    if (note.hand === "left" && handMuted.left) return;
    if (note.hand === "right" && handMuted.right) return;
    // Per-hand balance (issue #70): scale velocity by the hand's gain; "unknown" notes are full.
    const gains = handGains(handBalance);
    const velocity =
      note.hand === "left" ? gains.left : note.hand === "right" ? gains.right : 1;
    // Resolve the instrument per note so playback upgrades to the sampler as soon as it loads.
    getInstrument().triggerAttackRelease(
      Tone.Frequency(note.midi, "midi").toFrequency(),
      note.duration,
      time,
      velocity,
    );
  }, notes.map((n) => ({ time: n.time, midi: n.midi, duration: n.duration, hand: n.hand })));
  built.start(0);
  return built;
}

// Rebuild the audio + falling-notes pipeline from a ScoreData. Shared by the MusicXML
// path (which also renders a sheet + cursor) and the audio path (falling notes only).
// `name` is the default sheet title for this load (issue #44): the MusicXML title or file
// name, already derived by the caller; the user can rename it afterward. `sheet` records
// whether a sheet/cursor is active so rewind/sync can skip cursor work.
function loadNotes(data: ScoreData, name: string, sheet: boolean): void {
  score = data;
  hasSheet = sheet;

  const transport = Tone.getTransport();
  transport.stop();
  transport.position = 0;
  part?.dispose();

  // Build the Part at the baseline bpm so its notes' score seconds map to
  // rate-independent ticks; reapply the current tempo rate immediately after. This keeps
  // sync correct even when the tempo was changed before a score was loaded.
  transport.bpm.value = BASE_BPM;

  visualizer.setNotes(score.notes);

  part = createPart(score.notes);

  // Apply the current tempo now that the Part is built at BASE_BPM.
  transport.bpm.value = rateToBpm(tempoRate, BASE_BPM);

  // Per-hand mute toggles (issue #37): always shown. Every note is assigned a hand (grand
  // staff by clef, everything else by pitch at middle C), so the controls are meaningful for
  // any score. Reset on every load so a previously muted hand does not carry over.
  handMuted.left = false;
  handMuted.right = false;
  reflectHandMute(muteRightBtn, false);
  reflectHandMute(muteLeftBtn, false);
  visualizer.setMutedHands(handMuted);
  // Reset the hand balance to even on every load so a previous score's split does not carry
  // over (issue #70).
  handBalance = BALANCE_DEFAULT;
  balanceSlider.value = String(BALANCE_DEFAULT);
  reflectBalance();
  handMutes.hidden = false;

  // A fresh load drops any prior edit state: exit edit mode (the loaders below also clear the
  // retained model) and clear the shared selection so a previous score's edit view never
  // carries over.
  if (editMode) exitEditMode();
  selectedHandle = null;
  visualizer.setSelected(null);

  stepIndex = 0;
  onsets = uniqueOnsets(score.notes);
  // Issue #44: adopt the derived default name (the user can rename it) and show it with the
  // note count. A new load always resets to the source default; an in-progress edit is
  // cancelled so the new piece's name is not overwritten by a stale rename.
  cancelNameEdit();
  noteCount = score.notes.length;
  trackStatus.hidden = true;
  sheetNameBtn.hidden = false;
  sheetNoteCount.hidden = false;
  setSheetName(name);
  playBtn.disabled = false;
  exportMenuBtn.disabled = false;
  setTransportControlsEnabled(true);
  // Smart Edit Mode (P0) is available only for MusicXML/OMR scores (a rendered sheet + retained
  // source). A fresh load also resets the Edit button's pressed state via exitEditMode in the
  // loaders, so a previous score's edit view never carries over.
  setEditButtonEnabled();
  setExportMenuState();
  updateSeekUI(0);
  setPlaying(false);
}

// NARROW rebuild after an in-memory edit (issue #6). Unlike loadNotes this does NOT reset hand
// mutes/balance/tempo, does NOT re-render the sheet, and does NOT touch the sheet name. It only
// rebuilds what depends on score.notes: disposes + rebuilds the Tone.Part, recomputes the onset
// list and the total duration, refreshes the visualizer notes + the note-count readout. Pause
// and restore the transport position around the Part rebuild so the swap is inaudible (a Part
// rebuild while playing would reschedule mid-flight and click). In Smart Edit Mode P1 this is
// the audio/canvas half of the edit round-trip: pitch edits keep every note's TIME, so stepTimes
// are unchanged and the sync invariant holds (the falling notes and the cursor still read from
// one timeline). The staff is re-engraved separately from the model by the caller.
function reloadNotes(notes: VisNote[]): void {
  if (!score) return;
  const transport = Tone.getTransport();
  const wasPlaying = playing;
  // Capture the current playhead in transport seconds so we can restore it after the rebuild.
  const positionSeconds = transport.seconds;
  transport.pause();

  score = { ...score, notes, duration: recomputeDuration(notes) };

  part?.dispose();
  // Rebuild at the baseline bpm so the new notes' score seconds map to rate-independent ticks,
  // exactly as loadNotes does, then restore the live tempo. This keeps the sync invariant: the
  // falling notes and the cursor still read from one timeline (we never changed any note time).
  transport.bpm.value = BASE_BPM;
  visualizer.setNotes(score.notes);
  part = createPart(score.notes);
  transport.bpm.value = rateToBpm(tempoRate, BASE_BPM);

  // Restore the playhead. A delete can shorten the score below the old position; clamp it.
  transport.seconds = Math.min(positionSeconds, score.duration / (tempoRate || 1));
  onsets = uniqueOnsets(score.notes);
  noteCount = score.notes.length;
  renderSheetName(); // refresh the note-count readout next to the name
  if (wasPlaying) transport.start();
  updateSeekUI(Tone.getTransport().seconds * tempoRate);
}

// PROGRESSIVE in-place upgrade (progressive OMR). Swap the whole ScoreData (notes, step times,
// duration) for a refined or larger one the scan produced, WITHOUT resetting the player: keep the
// playing state, the playhead (clamped to the new duration), the hand mutes, balance, tempo, and the
// sheet name. The sheet SVG was already re-rendered by the caller (loadScoreXml), so this rebuilds
// only what depends on the notes: the Tone.Part, the visualizer, the onset list, the count, and the
// cursor position. This is how a partial scan refines into the complete one, or grows page by page,
// under the player's feet. The position is preserved as an ABSOLUTE score time (not a fraction) so
// earlier measures stay put while later pages append at the end.
function upgradeNotes(data: ScoreData): void {
  const transport = Tone.getTransport();
  const wasPlaying = playing;
  const positionSeconds = transport.seconds;
  transport.pause();

  score = data;
  hasSheet = true;
  part?.dispose();
  transport.bpm.value = BASE_BPM;
  visualizer.setNotes(score.notes);
  part = createPart(score.notes);
  transport.bpm.value = rateToBpm(tempoRate, BASE_BPM);

  const scoreTime = Math.min(positionSeconds * tempoRate, score.duration);
  transport.seconds = tempoRate > 0 ? scoreTime / tempoRate : 0;
  onsets = uniqueOnsets(score.notes);
  noteCount = score.notes.length;
  resyncCursor(scoreTime);
  if (wasPlaying) transport.start();
  updateSeekUI(scoreTime);
}

// ===== Smart Edit Mode P1: DUAL-SURFACE pitch editing on one source-of-truth model =====
//
// Edit mode shows the Verovio engraving in place of the OSMD sheet and makes BOTH the staff and
// the falling-notes canvas editable surfaces over ONE notation model (scoreModel). A pitch edit
// on either surface goes through a command, mutates the model, re-engraves the staff from the
// model, and re-derives the falling notes + audio (reloadNotes), so the two surfaces never
// diverge. The OSMD view is hidden (not destroyed) so exiting restores the normal player.

// Whether edit mode can be entered: only with a rendered sheet AND retained MusicXML to engrave.
// Audio-derived scores have neither, so the Edit button stays disabled for them.
function editModeAvailable(): boolean {
  return hasSheet && sourceMusicXml !== null;
}

function setEditButtonEnabled(): void {
  editBtn.disabled = !editModeAvailable();
}

// Enter edit mode: lazy-load the Verovio toolkit + WASM (~7MB) on first use, build the editable
// model from the retained MusicXML, render the staff, and arm both surfaces. Pauses playback
// (editing a moving target is never allowed). Idempotent and guarded against overlapping loads.
async function enterEditMode(): Promise<void> {
  if (editMode || editModeLoading || !editModeAvailable() || !sourceMusicXml) return;
  if (playing) {
    Tone.getTransport().pause();
    setPlaying(false);
  }
  editModeLoading = true;
  editBtn.disabled = true;
  editLive.textContent = "Loading the editor...";
  try {
    if (!verovioToolkit) verovioToolkit = await loadVerovioToolkit();
    // The score could have been swapped or audio-loaded while the toolkit streamed in; bail if
    // edit mode is no longer applicable so we never engrave a stale/cleared score.
    if (!editModeAvailable() || !sourceMusicXml) {
      editLive.textContent = "";
      return;
    }
    // Build the source-of-truth model + its command stack from the retained MusicXML. Pass the
    // tempo OSMD used to derive score.notes so the model's onset seconds match the VisNote
    // seconds exactly (the handle <-> VisNote mapping keys on midi + onset seconds).
    const bpm = (osmd.Sheet as { DefaultStartTempoInBpm?: number } | undefined)?.DefaultStartTempoInBpm;
    scoreModel = parseScoreModel(sourceMusicXml, bpm);
    commandStack = new CommandStack(scoreModel);
    selectedHandle = null;
    // COMMIT v1: snapshot the session-baseline falling notes (now, where score is non-null) so
    // DISCARD can restore the player to them. A shallow slice is pristine: edits never mutate these.
    editBaselineNotes = score ? score.notes.slice() : null;
    rederiveMaps();
    renderVerovio();
    editMode = true;
    editBtn.setAttribute("aria-pressed", "true");
    editBtn.title = "Edit mode on. Click to exit.";
    verovioCredit.hidden = false;
    editToolbar.hidden = false;
    sheetContainer.classList.add("editing");
    // Both surfaces become focusable application regions, each enumerating ITS keys.
    canvas.setAttribute("tabindex", "0");
    canvas.setAttribute("role", "application");
    canvas.setAttribute(
      "aria-label",
      "Falling notes editor. Up and down select a note; plus and minus change its pitch by a semitone; Shift with plus or minus moves an octave; comma and period change its length, tying across the next bar when needed; semicolon dots it; Delete removes it; Control Z undoes.",
    );
    reflectUndoRedoButtons();
    reflectSharedSelection();
    editLive.textContent =
      "Edit mode on. Click a note on the staff or the falling notes to select it, then edit its pitch.";
  } catch (err) {
    console.error("Failed to enter edit mode:", err);
    editLive.textContent = "Could not load the editor.";
    exitEditMode();
  } finally {
    editModeLoading = false;
    setEditButtonEnabled();
  }
}

// Leave edit mode: restore the OSMD view, hide the Verovio host + credit + toolbar, drop both
// surfaces' application roles, and discard the model + command stack. The Verovio toolkit
// instance is kept for a fast re-entry; only the on-screen render + edit state are torn down.
function exitEditMode(): void {
  editMode = false;
  editBtn.setAttribute("aria-pressed", "false");
  editBtn.title =
    "Edit mode off. Click to fix wrong notes on the staff or the falling notes.";
  verovioCredit.hidden = true;
  editToolbar.hidden = true;
  sheetContainer.classList.remove("editing");
  scoreModel = null;
  commandStack = null;
  selectedHandle = null;
  selectedRest = null;
  editBaselineNotes = null; // COMMIT v1: drop the pre-edit snapshot with the rest of the edit state
  handleToVisIndex = new Map();
  visIndexToHandle = new Map();
  restIndexToId = new Map();
  idToRestIndex = new Map();
  staffPlayingIds = [];
  drag = null;
  visualizer.setSelected(null);
  visualizer.setDragPreview(null);
  visualizer.setMirrorDeemphasis(null);
  canvas.removeAttribute("tabindex");
  canvas.removeAttribute("role");
  canvas.removeAttribute("aria-label");
  noteEdit.hidden = true;
  clearStaffMirror();
  if (verovioHost) {
    verovioHost.replaceChildren();
    // Drop the application role + tab stop so the empty host is not a phantom focus target in
    // the normal (non-editing) player.
    verovioHost.removeAttribute("tabindex");
    verovioHost.removeAttribute("role");
    verovioHost.removeAttribute("aria-label");
  }
}

// COMMIT v1: SAVE bakes the edited model back into the retained source MusicXML, then leaves edit
// mode. The live player already reflects every edit (each edit ran through reloadNotes), so there
// is nothing to re-derive; we only PERSIST the model so re-entering edit shows the saved edits and
// any source/MusicXML export is current. serialize() also enriches the score (it inserts inferred
// <type>s), but it is reached only when dirty, so we never gate on byte-equality. The read-only
// OSMD sheet is intentionally left as-is: it shows the pre-edit engraving exactly as any
// edit-then-exit already does today; refreshing it is a separate follow-up. Focus returns to the
// Edit button (the just-clicked Save is now hidden with the toolbar).
function saveEdits(): void {
  if (!scoreModel) return;
  sourceMusicXml = scoreModel.serialize();
  exitEditMode();
  editLive.textContent = "Edits saved.";
  editBtn.focus();
}

// COMMIT v1: DISCARD reverts the live player to the session baseline (the notes snapshotted on
// entering edit mode) and leaves edit mode, throwing away the in-session edits. Restoring the
// falling notes + audio via the narrow reloadNotes (which preserves mutes/balance/tempo/name and
// lands paused, since edit mode paused playback) is all that is needed: the read-only OSMD sheet is
// left as-is, consistent with SAVE and with today's edit-then-exit (the OSMD sheet reflects only
// the originally loaded score; refreshing it on save/discard is a deferred follow-up). A no-snapshot
// guard keeps it safe if somehow called outside an edit session.
function discardEdits(): void {
  if (editBaselineNotes) reloadNotes(editBaselineNotes);
  exitEditMode();
  editLive.textContent = "Edits discarded. Back to the original.";
  editBtn.focus();
}

// COMMIT v1: leaving edit mode via the Edit toggle. With unsaved edits, confirm before discarding
// (the toolbar's explicit Save/Discard are the primary commit path; this is the safety net on the
// toggle). A clean session exits silently. Programmatic exits (a new score load, an editor-load
// error) call exitEditMode DIRECTLY and never prompt, so loading a new piece never nags.
function requestExitEditMode(): void {
  if (isEditDirty()) {
    const discard = window.confirm("You have unsaved edits. Discard them and leave editing?");
    if (!discard) return; // stay in edit mode so the user can Save
    discardEdits();
    return;
  }
  exitEditMode();
}

// Rebuild the handle <-> VisNote index maps from the current model + falling notes. Called after
// every edit and on entering edit mode. The handle is the durable selection spine; these maps
// translate it to the VisNote index (canvas) and, via verovioRender.visIndexToId, the staff id.
function rederiveMaps(): void {
  if (!scoreModel || !score) {
    handleToVisIndex = new Map();
    visIndexToHandle = new Map();
    return;
  }
  handleToVisIndex = buildHandleToVisIndex(scoreModel.handles, score.notes);
  visIndexToHandle = new Map();
  for (const [handleId, visIndex] of handleToVisIndex) {
    if (!visIndexToHandle.has(visIndex)) visIndexToHandle.set(visIndex, handleId);
  }
}

// Render (or re-render) the model with Verovio into a host div inside #sheet, then re-apply the
// shared selection + playhead tint. The host is created once and reused; OSMD's SVG sits beside
// it (hidden by the `.editing` class). The SVG is engraved from the model's CURRENT serialized
// MusicXML, so it always reflects every committed (or mid-drag previewed) edit.
function renderVerovio(): void {
  if (!verovioToolkit || !scoreModel || !score) return;
  if (!verovioHost) {
    verovioHost = document.createElement("div");
    verovioHost.id = "verovio-host";
  }
  // A focusable application region so a keyboard user can Tab to the staff and drive its keys.
  // Set every render (idempotent) since exitEditMode strips these so the empty host is not a
  // phantom tab stop in the normal player.
  verovioHost.setAttribute("tabindex", "0");
  verovioHost.setAttribute("role", "application");
  verovioHost.setAttribute(
    "aria-label",
    "Staff editor. Left and right select a note or a rest; up and down change a note's pitch by a step; Control with up or down changes by a semitone; Shift with up or down by an octave; comma makes a note shorter and period makes it longer, crossing into the next bar with a tie when it must; semicolon dots the note; on a rest, press Enter to add a note of the same duration; Delete removes a note; Control Z undoes.",
  );
  // Always (re)attach the host to #sheet. OSMD owns #sheet and an osmd.load/render between edit
  // sessions can detach our node, so re-appending here keeps the render going into the live DOM
  // instead of an orphaned div. appendChild is a no-op move when it is already the last child.
  if (verovioHost.parentNode !== sheetContainer) {
    sheetContainer.appendChild(verovioHost);
  }
  const width = sheetContainer.clientWidth || 800;
  verovioRender = renderMusicXml(verovioToolkit, scoreModel.serialize(), score.notes, width);
  verovioHost.innerHTML = verovioRender.svg;
  rederiveRestMaps();
  applyStaffSelectionHighlight();
  staffPlayingIds = [];
  updateVerovioPlayhead(Tone.getTransport().seconds * tempoRate, true);
}

// Rebuild the rest maps (model rest-index <-> Verovio rest glyph id) from the current render +
// model rest handles, keyed on (onset, staff). Called from renderVerovio after the SVG + the
// render's rest list are available (a rest has no VisNote, so this is independent of the note maps
// rebuilt in rederiveMaps). Empty when not in edit mode or the score has no rests.
function rederiveRestMaps(): void {
  if (!scoreModel || !verovioRender) {
    restIndexToId = new Map();
    idToRestIndex = new Map();
    return;
  }
  restIndexToId = buildRestIndexToId(verovioRender.rests, scoreModel.restHandles);
  idToRestIndex = new Map();
  for (const [restIndex, id] of restIndexToId) idToRestIndex.set(id, restIndex);
}

// Find a notehead <g> by id within the Verovio host.
function staffNoteEl(id: string): SVGGElement | null {
  if (!verovioHost) return null;
  return verovioHost.querySelector<SVGGElement>(`g.note[id="${CSS.escape(id)}"]`);
}

// Find a rest <g> by id within the Verovio host (ADD-a-note v1).
function staffRestEl(id: string): SVGGElement | null {
  if (!verovioHost) return null;
  return verovioHost.querySelector<SVGGElement>(`g.rest[id="${CSS.escape(id)}"]`);
}

// The Verovio rest glyph id for the current rest selection, or null. Mirrors selectedStaffId for
// rests: model rest-index -> glyph id via the render's rest map.
function selectedRestId(): string | null {
  if (selectedRest === null) return null;
  return restIndexToId.get(selectedRest) ?? null;
}

// The Verovio notehead id for the current shared selection, or null. handle -> VisNote index ->
// id, using the render's inverse map. Off-screen-on-the-mirror cases and tie continuations can
// leave a handle with no staff id (then the staff shows no halo and the canvas carries it).
function selectedStaffId(): string | null {
  const visIndex = selectedVisIndex();
  if (visIndex === null || !verovioRender) return null;
  return verovioRender.visIndexToId.get(visIndex) ?? null;
}

// Reflect the shared selection on the STAFF: stroke the selected notehead OR rest with the brass
// halo, clearing any previous one. A rest wears the SAME .ph-selected language as a note (sized to
// its glyph by the CSS), so "selected = brass halo" stays one learnable rule across notes + rests.
function applyStaffSelectionHighlight(): void {
  if (!verovioHost) return;
  for (const el of verovioHost.querySelectorAll(".ph-selected")) {
    el.classList.remove("ph-selected");
  }
  const noteId = selectedStaffId();
  if (noteId) staffNoteEl(noteId)?.classList.add("ph-selected");
  const restId = selectedRestId();
  if (restId) staffRestEl(restId)?.classList.add("ph-selected");
}

// A human label for the shared selection (the from-pitch token in announcements), via its
// VisNote when mapped, else the model handle's pitch (e.g. a tie continuation with no VisNote).
function selectedNoteLabel(): string {
  const visIndex = selectedVisIndex();
  if (visIndex !== null && score) return editNoteLabel(score.notes[visIndex]);
  if (selectedHandle !== null && scoreModel) {
    const h = scoreModel.handles[selectedHandle];
    if (h) return pitchLabel(h.midi, spellingFromPitch(h.pitch));
  }
  return "note";
}

// The continuation handle of a CROSS-BARLINE TIE whose START is `h`, or null if `h` is not a tie
// start. A tie start carries <tie type="start"/> (no stop); its continuation is the same-pitch
// handle flagged isTieContinuation whose onset begins exactly where the start ends. Used so a tied
// note's readout can name its SOUNDING (summed) value (TIE-E).
function tieContinuationOf(h: NoteHandle): NoteHandle | null {
  if (!scoreModel) return null;
  const ties = Array.from(h.el.getElementsByTagName("tie"));
  const hasStart = ties.some((t) => t.getAttribute("type") === "start");
  const hasStop = ties.some((t) => t.getAttribute("type") === "stop");
  if (!hasStart || hasStop) return null; // not a pure cross-barline tie start
  const end = h.onsetSec + h.durationSec;
  return (
    scoreModel.handles.find(
      (c) => c.isTieContinuation && c.midi === h.midi && Math.abs(c.onsetSec - end) < 1e-3,
    ) ?? null
  );
}

// The current value NAME of the shared-selected note (Smart Edit P3 readout/announce), e.g.
// "quarter" or (for an OMR-inferred dotted arrival) "dotted quarter". A CROSS-BARLINE TIE START
// reads its SOUNDING (summed) value + " tied across the bar" (TIE-E), e.g. "half tied across the
// bar" (a quarter-tied-to-quarter), since the staff shows two noteheads but it sounds as one held
// note. Empty when no note is selected or its handle is gone.
function selectedNoteValueName(): string {
  if (selectedHandle === null || !scoreModel) return "";
  const h = scoreModel.handles[selectedHandle];
  if (!h) return "";
  const cont = tieContinuationOf(h);
  if (cont) {
    // Sum the start + continuation divisions for the held sounding value (named, possibly dotted).
    const sumDivs = h.durationDivs + cont.durationDivs * (h.divisions / cont.divisions);
    return `${durationValueName(sumDivs, h.divisions)} tied across the bar`;
  }
  return durationValueName(h.durationDivs, h.divisions);
}

// The note cluster readout (Smart Edit P3): the pitch token (current Names mode) plus the current
// value, e.g. "D5, quarter". The value follows every duration edit so the user sees what it became.
function selectedNoteReadout(): string {
  const pitch = selectedNoteLabel();
  const value = selectedNoteValueName();
  return value ? `${pitch}, ${value}` : pitch;
}

// A human label for the selected REST (ADD-a-note v1): its duration name + beat, e.g. "a quarter
// rest, beat 3". Duration is the load-bearing token; the beat is included when it is a whole
// number (1..N), else omitted (an off-beat rest reads cleaner without a fractional beat).
function selectedRestLabel(): string {
  if (selectedRest === null || !scoreModel) return "a rest";
  const r = scoreModel.restHandles[selectedRest];
  if (!r) return "a rest";
  const name = restDurationName(r.type);
  const beatWhole = Number.isInteger(r.beat) ? r.beat : null;
  return beatWhole !== null ? `a ${name}, beat ${beatWhole}` : `a ${name}`;
}

// Reflect the ONE shared selection on BOTH surfaces + the edit cluster (Designer P1-1 + ADD-3). The
// cluster shows whenever edit mode is on AND something is selected, regardless of which surface the
// selection came from. Its CONTENTS swap on WHAT is selected: a NOTE shows the pitch-down/up +
// delete cluster; a REST shows the single "Add a note" button + a readout naming the rest. A rest
// has no VisNote, so the canvas selection clears when a rest is selected.
function reflectSharedSelection(announce?: string): void {
  const visIndex = selectedVisIndex();
  visualizer.setSelected(visIndex);
  applyStaffSelectionHighlight();
  const hasNote = selectedHandle !== null;
  const hasRest = selectedRest !== null;
  noteEdit.hidden = !(editMode && hasNote);
  addNoteCluster.hidden = !(editMode && hasRest);
  if (hasNote) noteEditReadout.textContent = selectedNoteReadout();
  if (hasRest) addNoteReadout.textContent = capitalize(selectedRestLabel());
  reflectDurationButtons();
  if (announce) editLive.textContent = announce;
}

// Dim/enable the duration steppers to match the selected note's ladder position (Smart Edit P3-6:
// disabled + aria-disabled at the ladder ends, the same idiom as undo/redo). Shorter is disabled at
// the shortest rung (16th), longer at the longest (whole). A dotted/odd ARRIVAL is off the ladder
// (index -1): both stay enabled because the first edit snaps it onto a rung. No selected note (or no
// model) leaves them disabled; the cluster is hidden then anyway. Also reflects the DOT toggle (v1):
// aria-pressed + a lit look when the note is dotted, ghost when plain; disabled only when a PLAIN
// note has no room for the x1.5 half before the barline (an already-dotted note is always enabled).
function reflectDurationButtons(): void {
  let canShorter = false;
  let canLonger = false;
  let dotted = false;
  let canDot = false;
  if (editMode && selectedHandle !== null && scoreModel) {
    const h = scoreModel.handles[selectedHandle];
    if (h) {
      const idx = ladderIndexForDuration(h.durationDivs, h.divisions);
      if (idx < 0) {
        // Off-ladder (dotted/odd arrival): the next press snaps onto a rung, so allow both.
        canShorter = true;
        canLonger = true;
      } else {
        canShorter = idx > 0;
        canLonger = idx < DURATION_LADDER.length - 1;
      }
      const ds = scoreModel.dotState(selectedHandle);
      dotted = ds.dotted;
      canDot = ds.canToggle;
    }
  }
  setButtonEnabled(durShorterBtn, canShorter);
  setButtonEnabled(durLongerBtn, canLonger);
  // The dot button is a TOGGLE: aria-pressed (the lit CSS keys off it) tracks dotted; it is disabled
  // only when a plain note cannot fit the added half (a dotted note's remove always has room).
  durDotBtn.setAttribute("aria-pressed", String(dotted));
  setButtonEnabled(durDotBtn, canDot);
}

// Capitalize the first letter of a label for the cluster readout (announcements use the lowercase
// "a quarter rest" form mid-sentence; the readout is a standalone caption).
function capitalize(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

// Select a model note by HANDLE (the shared spine) and announce it. Used by both surfaces.
// Selecting a note clears any rest selection (at most one of note / rest is selected).
function selectHandle(handleId: number, silent = false): void {
  selectedHandle = handleId;
  selectedRest = null;
  lastRestPointer = null;
  reflectSharedSelection(silent ? undefined : `Selected ${selectedNoteLabel()}`);
}

// Select a REST by its model rest-registry id (ADD-a-note v1) and announce it. Selecting a rest
// clears any note selection. The announce names the rest's duration + beat ("Selected a quarter
// rest, beat 3"); the cluster swaps to the single Add action (reflectSharedSelection). This is the
// KEYBOARD/programmatic path, so it clears any stashed mouse click height (the mouse pointerdown
// re-stashes it AFTER calling selectRest); a keyboard add then uses the previous-note default.
function selectRest(restId: number, silent = false): void {
  selectedRest = restId;
  selectedHandle = null;
  lastRestPointer = null;
  reflectSharedSelection(silent ? undefined : `Selected ${selectedRestLabel()}`);
}

// Select from a CANVAS bar (VisNote index) by mapping to its handle.
function selectByVisIndex(visIndex: number): void {
  const handle = visIndexToHandle.get(visIndex);
  if (handle === undefined) return;
  selectHandle(handle);
}

// The full staff Left/Right order (notes + rests interleaved by onset, ADD-1), built from the model
// via the pure staffNavOrder. Tie continuations are excluded (no VisNote to highlight); rests are
// included even if their glyph did not map (they are selectable + convertible regardless).
function staffNavTargets(): StaffNavTarget[] {
  if (!scoreModel) return [];
  const notes = scoreModel.handles
    .filter((h) => !h.isTieContinuation)
    .map((h) => ({ id: h.id, onsetSec: h.onsetSec, midi: h.midi }));
  const rests = scoreModel.restHandles.map((r) => ({ id: r.id, onsetSec: r.onsetSec }));
  return staffNavOrder(notes, rests);
}

// Step the staff selection to the prev/next stop in musical order (Left/Right), interleaving notes
// and rests. With no current selection, Right selects the first and Left the last. Selecting a note
// vs a rest routes through selectHandle / selectRest accordingly.
function moveStaffSelection(delta: 1 | -1): void {
  const order = staffNavTargets();
  const current: StaffNavTarget | null =
    selectedHandle !== null
      ? { kind: "note", id: selectedHandle }
      : selectedRest !== null
        ? { kind: "rest", id: selectedRest }
        : null;
  const target = stepStaffNav(order, current, delta);
  if (!target) return;
  if (target.kind === "note") selectHandle(target.id);
  else selectRest(target.id);
}

// Step the CANVAS selection by onset to the nearest earlier/later note (Up/Down on the canvas),
// matching what the falling view's selection nav did before. Operates over VisNote indices in
// onset order so it walks the score the way the lane shows it. Wraps at the ends.
function moveCanvasSelection(delta: 1 | -1): void {
  if (!score || score.notes.length === 0) return;
  // VisNote indices sorted by onset, then pitch, so stepping is musical.
  const order = score.notes
    .map((n, i) => ({ i, time: n.time, midi: n.midi }))
    .sort((a, b) => a.time - b.time || a.midi - b.midi)
    .map((o) => o.i);
  const currentVis = selectedVisIndex();
  const pos = currentVis === null ? -1 : order.indexOf(currentVis);
  let nextPos: number;
  if (pos === -1) {
    nextPos = delta > 0 ? 0 : order.length - 1;
  } else {
    nextPos = (pos + delta + order.length) % order.length;
  }
  selectByVisIndex(order[nextPos]);
}

// Tint the notehead(s) sounding at `scoreTime` so the Verovio staff shows the playhead, mirroring
// the OSMD cursor. Derived purely from the timemap (no per-frame WASM call). Only touches the DOM
// when the playing set changes, so the rAF loop stays cheap. `force` re-applies after a render.
function updateVerovioPlayhead(scoreTime: number, force = false): void {
  if (!editMode || !verovioRender || !verovioHost) return;
  const ids = notesAtScoreTime(verovioRender.timemap, scoreTime);
  if (
    !force &&
    ids.length === staffPlayingIds.length &&
    ids.every((id, i) => id === staffPlayingIds[i])
  ) {
    return; // unchanged; skip DOM work
  }
  for (const el of verovioHost.querySelectorAll(".ph-playing")) {
    el.classList.remove("ph-playing");
  }
  for (const id of ids) staffNoteEl(id)?.classList.add("ph-playing");
  staffPlayingIds = ids;
}

// ----- The dual-surface edit operations (pitch + undo/redo) -----

// Commit a discrete pitch edit (a keypress) on the shared selection: build the SetPitchCommand,
// push it (which applies it to the model), re-engrave the staff, re-derive the falling notes +
// audio, keep the selection on the same handle, and announce from/to. `next` is the target
// pitch the surface computed (diatonic / chromatic / octave). No-op without a selected handle.
function commitPitchEdit(next: ModelPitch): void {
  if (!scoreModel || !commandStack || selectedHandle === null || !score) return;
  const handle = scoreModel.handles[selectedHandle];
  if (!handle) return;
  const before = handle.pitch;
  // The stepping functions clamp to the 88-key range, so a step at the boundary returns the SAME
  // pitch. Treat that as a no-op: do not push a command, just announce the edge gently so a
  // keyboard/SR user knows the press registered (the boundary, not a dropped keystroke).
  const beforeMidi = midiFromPitch(before);
  if (midiFromPitch(next) === beforeMidi) {
    editLive.textContent =
      beforeMidi <= FIRST_MIDI ? "Already at the lowest key." : "Already at the highest key.";
    return;
  }
  const fromLabel = pitchLabel(beforeMidi, spellingFromPitch(before));
  const cmd: SetPitchCommand = {
    kind: "setPitch",
    handleId: selectedHandle,
    before,
    after: next,
  };
  commandStack.push(cmd); // applies it to the model
  const verb = verticalVerb(midiFromPitch(before), midiFromPitch(next));
  const toLabel = pitchLabel(midiFromPitch(next), spellingFromPitch(next));
  finishEdit(`${fromLabel} ${verb} ${toLabel}`);
}

// The directional phrase for an announcement, e.g. "up to", "down to", "up an octave to".
function verticalVerb(fromMidi: number, toMidi: number): string {
  const d = toMidi - fromMidi;
  if (d === 12) return "up an octave to";
  if (d === -12) return "down an octave to";
  return d >= 0 ? "up to" : "down to";
}

// Shared tail of an edit (or undo/redo): re-engrave the staff from the model, re-derive the
// falling notes from the model's new pitches, rebuild the maps, refresh selection, undo/redo
// buttons, and announce. The audio + canvas swap goes through reloadNotes (transport-safe).
//
// `explicitNotes` is supplied by a STRUCTURAL edit (delete / its undo) whose VisNote COUNT changed:
// the caller has already spliced the falling note out (or back in), so we use that array verbatim
// instead of the index-stable pitch projection (which assumes a same-length array). A pitch edit
// passes no array and gets the projection (midi/spelling from the model onto the existing notes).
function finishEdit(announce: string, explicitNotes?: VisNote[]): void {
  if (!score) return;
  let notes: VisNote[];
  if (explicitNotes) {
    notes = explicitNotes;
  } else {
    // Re-derive every mapped handle's pitch onto the falling notes from the model (covers undo of
    // a multi-note future too, though P1 edits are one note at a time).
    notes = score.notes.slice();
    if (scoreModel) {
      for (const h of scoreModel.handles) {
        const visIndex = handleToVisIndex.get(h.id);
        if (visIndex !== undefined) {
          notes[visIndex] = { ...notes[visIndex], midi: h.midi, spelling: spellingFromPitch(h.pitch) };
        }
      }
    }
  }
  reloadNotes(notes);
  rederiveMaps();
  renderVerovio();
  reflectUndoRedoButtons();
  reflectSharedSelection(announce);
}

// Undo / redo: route the model mutation through the same re-render / re-derive path so both
// surfaces + audio restore together, and re-select the affected note. Empty-stack presses
// announce so a keyboard/SR user knows the press registered (Designer P1-6).
function doUndo(): void {
  if (!commandStack) return;
  if (!commandStack.canUndo()) {
    editLive.textContent = "Nothing to undo";
    return;
  }
  // Snapshot per-note hand by element BEFORE the model mutates: commandStack.undo() applies the
  // reversal (which reindexes handles for a duration edit), so a later capture would be too late.
  // Only the duration path consumes it; capturing it for the others is a cheap discard.
  const elementToHand = captureElementToHand();
  const cmd = commandStack.undo();
  if (!cmd) return;
  if (cmd.kind === "deleteNote") {
    // Undo of a delete: the model restored the note (re-indexed, so it reclaims its original
    // document-position id) and the falling note must be spliced BACK in at its original slot. The
    // VisNote count grows by one, so pass the explicit array to finishEdit.
    undoDelete(cmd);
    return;
  }
  if (cmd.kind === "addNote") {
    // Undo of an add: the model turned the note back into the rest; splice the falling note OUT
    // and re-select the rest. The VisNote count falls by one.
    undoAdd(cmd);
    return;
  }
  if (cmd.kind === "changeDuration") {
    // Undo of a duration edit: the model restored the bar (restoreDuration). Re-derive the falling
    // notes from the restored model (onsets/durations are back), re-select the same handle (stable
    // across a duration edit), and announce the reversal. The changed note returns selected at its
    // prior value, which the readout reflects. A pulse marks the restored note.
    undoOrRedoDuration(cmd, "undo", elementToHand);
    return;
  }
  // Re-select the affected note (it now shows its prior pitch) and announce what reversed. Do
  // NOT rebuild the maps here: finishEdit projects the reverted model pitch onto the falling
  // notes using the existing (index-stable) map, THEN reloadNotes + rederiveMaps rebuild it
  // against the updated notes. Rebuilding first would fail to match the just-reverted note (the
  // model already holds the old pitch while score.notes still holds the new one).
  selectedHandle = cmd.handleId;
  const verb = verticalVerb(midiFromPitch(cmd.after), midiFromPitch(cmd.before));
  const toLabel = pitchLabel(midiFromPitch(cmd.before), spellingFromPitch(cmd.before));
  finishEdit(`Undid: ${pitchLabel(midiFromPitch(cmd.after), spellingFromPitch(cmd.after))} ${verb} ${toLabel}`);
}

function doRedo(): void {
  if (!commandStack) return;
  if (!commandStack.canRedo()) {
    editLive.textContent = "Nothing to redo";
    return;
  }
  // Snapshot per-note hand by element BEFORE the model mutates (see doUndo). Only the duration path
  // consumes it; capturing it for the others is a cheap discard.
  const elementToHand = captureElementToHand();
  const cmd = commandStack.redo();
  if (!cmd) return;
  if (cmd.kind === "deleteNote") {
    // Redo of a delete: the model re-deleted (re-derived its record); splice the falling note OUT
    // again and move the selection to a neighbor (or clear), as the original delete did.
    redoDelete(cmd);
    return;
  }
  if (cmd.kind === "addNote") {
    // Redo of an add: the model re-converted the rest; splice the falling note back IN and select
    // the new note, as the original add did.
    redoAdd(cmd);
    return;
  }
  if (cmd.kind === "changeDuration") {
    // Redo of a duration edit: applyCommand re-ran model.changeDuration against the restored bar
    // (deterministic), so the bar is edited again. Re-derive + re-select + announce like the undo.
    undoOrRedoDuration(cmd, "redo", elementToHand);
    return;
  }
  // Same map ordering as doUndo: project with the existing map, then rebuild in finishEdit.
  selectedHandle = cmd.handleId;
  const verb = verticalVerb(midiFromPitch(cmd.before), midiFromPitch(cmd.after));
  const toLabel = pitchLabel(midiFromPitch(cmd.after), spellingFromPitch(cmd.after));
  finishEdit(`Redid: ${pitchLabel(midiFromPitch(cmd.before), spellingFromPitch(cmd.before))} ${verb} ${toLabel}`);
}

// Splice the deleted falling note back in (undo of a delete) at its original slot and re-select
// the restored note. The model has ALREADY restored + re-indexed (the note reclaims handleId).
function undoDelete(cmd: DeleteNoteCommand): void {
  if (!score) return;
  const notes = score.notes.slice();
  if (cmd.visNote && cmd.visIndex !== null) {
    const restored: VisNote = {
      midi: cmd.visNote.midi,
      time: cmd.visNote.time,
      duration: cmd.visNote.duration,
      hand: cmd.visNote.hand,
      spelling: cmd.visNote.spelling,
    };
    const at = Math.min(cmd.visIndex, notes.length);
    notes.splice(at, 0, restored);
  }
  selectedHandle = cmd.handleId; // the restored note is back at its original document position
  const label = cmd.visNote
    ? pitchLabel(cmd.visNote.midi, cmd.visNote.spelling)
    : "note";
  finishEdit(`Restored ${label}`, notes);
}

// Splice the deleted falling note back OUT (redo of a delete) and move selection to a neighbor.
// Selection parity (P2 review): use the SAME musical-neighbor logic as deleteSelectedNote
// (neighborNoteElAfterDelete: next in onset/midi order, else previous) so delete and redo select
// IDENTICALLY. Evaluating it AFTER the re-delete (the model already re-indexed) means the neighbor
// is computed over the post-delete handles, then re-found by element; picking by document position
// (handles[handleId]) diverged from delete on a grand staff where document order != musical order.
function redoDelete(cmd: DeleteNoteCommand): void {
  if (!score || cmd.visIndex === null || !scoreModel) return;
  const notes = score.notes.slice();
  notes.splice(cmd.visIndex, 1);
  // Pick the next selection by MUSICAL order (matching deleteSelectedNote), evaluated after the
  // re-delete. The deleted handle id no longer exists, so we resolve the same "next note, else
  // previous" neighbor from the deleted note's (onset, midi) over the post-delete handles.
  selectedHandle = musicalNeighborAfterDeletedOnset(cmd);
  const label = cmd.visNote ? pitchLabel(cmd.visNote.midi, cmd.visNote.spelling) : "note";
  finishEdit(`Deleted ${label}`, notes);
}

// The handle to select after a delete/redo, chosen by MUSICAL order from the DELETED note's (onset,
// midi) via the pure musicalNeighborAfterDelete ("next note, else previous"). Evaluated over the
// post-delete handles so delete and its redo land on the SAME note even on a grand staff where
// document order != musical order (the P2 review fix).
function musicalNeighborAfterDeletedOnset(cmd: DeleteNoteCommand): number | null {
  if (!scoreModel || !cmd.visNote) return null;
  const remaining = scoreModel.handles
    .filter((h) => !h.isTieContinuation)
    .map((h) => ({ id: h.id, onsetSec: h.onsetSec, midi: h.midi }));
  return musicalNeighborAfterDelete(remaining, cmd.visNote.time, cmd.visNote.midi);
}

// Dim/enable the undo/redo buttons to match the stacks (Designer P1-6: visibly dimmed +
// aria-disabled when empty so the user can see whether there is history to move through).
// Set a toolbar button's enabled state, keeping `disabled` and its `aria-disabled` mirror in
// lockstep (the dimmed-disabled idiom every edit-toolbar reflector shares). Single-sourced so the
// a11y invariant cannot drift across the undo/redo, duration, and commit button pairs.
function setButtonEnabled(btn: HTMLButtonElement, enabled: boolean): void {
  btn.disabled = !enabled;
  btn.setAttribute("aria-disabled", String(!enabled));
}

function reflectUndoRedoButtons(): void {
  setButtonEnabled(undoBtn, commandStack?.canUndo() ?? false);
  setButtonEnabled(redoBtn, commandStack?.canRedo() ?? false);
  // The Save/Discard commit buttons share the SAME dirty signal (canUndo), so reflect them here:
  // every edit / undo / redo / enter that updates the history also updates commit availability,
  // with no missed call site (all those paths funnel through this function).
  reflectCommitButtons();
}

// COMMIT v1: "dirty" = at least one edit command applied since entering edit mode (or since the
// last Save). It is DERIVED from the command stack (canUndo), not a separate sticky flag, so
// undoing every edit back to the entry baseline correctly reads as clean (the model equals the
// baseline again). A fresh enter builds a new stack, and Save exits, so canUndo tracks exactly
// "the model differs from the source it was parsed from".
function isEditDirty(): boolean {
  return commandStack?.canUndo() ?? false;
}

// Enable/dim the Save + Discard buttons to match the dirty state (Designer COMMIT v1: the same
// dimmed + aria-disabled idiom as undo/redo, so the user can see whether there is anything to
// commit or revert). A clean session shows both dimmed and exits via the Edit toggle instead.
function reflectCommitButtons(): void {
  const dirty = isEditDirty();
  setButtonEnabled(editSaveBtn, dirty);
  setButtonEnabled(editDiscardBtn, dirty);
}

// Compute the target pitch for a keyboard pitch step on the STAFF (diatonic / chromatic / octave)
// or commit it. `mode` selects the axis; reads the selected handle's current pitch + key sig.
function staffPitchStep(mode: "diatonic" | "chromatic" | "octave", dir: 1 | -1): void {
  if (!scoreModel || selectedHandle === null) return;
  const h = scoreModel.handles[selectedHandle];
  if (!h) return;
  let next: ModelPitch;
  if (mode === "diatonic") next = diatonicStep(h.pitch, dir, scoreModel.fifthsForHandle(selectedHandle));
  else if (mode === "chromatic") next = chromaticStep(h.pitch, dir);
  else next = octaveStep(h.pitch, dir);
  commitPitchEdit(next);
}

// Compute + commit a CHROMATIC keyboard pitch step on the CANVAS (+/- = semitone, Shift = octave).
// The canvas is chromatic (its native unit is the key/semitone); re-spell from the new MIDI so
// the staff engraves a sensible accidental.
function canvasPitchStep(octaveMod: boolean, dir: 1 | -1): void {
  if (!scoreModel || selectedHandle === null) return;
  const h = scoreModel.handles[selectedHandle];
  if (!h) return;
  const next = octaveMod ? octaveStep(h.pitch, dir) : chromaticStep(h.pitch, dir);
  commitPitchEdit(next);
}

// Capture a pre-edit ELEMENT -> hand map so a re-derive after a duration edit can copy each note's
// hand back onto it. Keyed on the <note> DOM element (h.el), NOT the handle id and NOT the <staff>:
//
//   - id is UNSTABLE across a CROSS-BARLINE TIE (the continuation <note> insert reindexes every
//     handle past it), which is why the old id-keyed lookup broke and was (wrongly) replaced by a
//     per-STAFF lookup.
//   - <staff> is TOO COARSE: the issue-#87 collapsed-single-staff class (e.g. icarus.pdf, where the
//     OMR flattens a grand staff onto ONE <staff> that switches treble->bass mid-piece) has notes on
//     the SAME staff with DIFFERENT hands (score.ts tags hand PER MEASURE from the clef in effect),
//     so a per-staff rule collapses the whole bass section to the first note's hand after any edit.
//
// h.el is STABLE across BOTH the onset ripple AND the continuation insert (the DOM <note> nodes for
// surviving notes are mutated in place, never recreated), so an element-keyed map survives the id
// shift WITHOUT losing per-note hand. Must be captured BEFORE the model mutates, while
// handleToVisIndex + score.notes + the handle ids still line up.
function captureElementToHand(): Map<Element, VisNote["hand"]> {
  const map = new Map<Element, VisNote["hand"]>();
  if (!scoreModel || !score) return map;
  for (const h of scoreModel.handles) {
    const vi = handleToVisIndex.get(h.id);
    if (vi !== undefined) map.set(h.el, score.notes[vi]?.hand);
  }
  return map;
}

// Re-derive the FULL falling-notes array from the model after a duration edit. Thin DOM-guard over
// the pure deriveVisNotesFromModel (edit-model.ts), which owns the logic + its rationale: midi/time/
// duration come fresh from the handles, each note's HAND is restored by its <note> ELEMENT from the
// pre-edit `elementToHand` snapshot (see captureElementToHand), and a cross-barline tie continuation
// folds into its start's held VisNote. Element-keyed hand survives both the tie's id shift AND a
// collapsed single staff whose clef/hand changes mid-piece (issue #87).
function rederiveVisNotesFromModel(elementToHand: Map<Element, VisNote["hand"]>): VisNote[] {
  if (!scoreModel || !score) return score ? score.notes.slice() : [];
  return deriveVisNotesFromModel(scoreModel.handles, elementToHand);
}

// Step the shared-selected note one notch SHORTER or LONGER along the value ladder (Smart Edit P3
// v1), routed through the command stack so it is undoable and both surfaces re-derive. The model
// does the fixed-bar mutation (shrink + leave a rest, or grow + ripple + clamp) and returns a record
// describing the outcome for the announce; a ladder-end or no-room result is a no-op that only
// announces. No-op without a selected note. The selection stays on the same handle (ids are stable
// across a duration edit) and the changed note pulses on commit.
function changeDurationEdit(direction: "shorter" | "longer"): void {
  if (!scoreModel || !commandStack || selectedHandle === null || !score) return;
  const handleId = selectedHandle;
  const handle = scoreModel.handles[handleId];
  if (!handle) return;
  const fromValue = durationValueName(handle.durationDivs, handle.divisions);
  // Snapshot per-note hand by element BEFORE the model mutates (the edit reindexes handles, so this
  // must be captured while handleToVisIndex + score.notes + ids still line up). See rederive below.
  const elementToHand = captureElementToHand();

  // Run the model edit DIRECTLY (not through the stack) so a NO-OP outcome (ladder end / no room)
  // does not push a command and therefore cannot wipe the redo branch. Only a real edit is recorded,
  // via pushApplied (the model is already mutated), exactly like a drag commits.
  const rec = scoreModel.changeDuration(handleId, direction);
  if (!rec || rec.outcome === "atEnd" || rec.outcome === "noRoom") {
    // Boundary no-op: the model changed nothing. Announce so a keyboard/SR user knows it registered.
    if (!rec || rec.outcome === "atEnd") {
      editLive.textContent =
        direction === "shorter"
          ? "Already the shortest value, sixteenth"
          : "Already the longest value, whole";
    } else {
      editLive.textContent = "No room to lengthen in this bar";
    }
    return;
  }

  // The edit landed: record the applied command for undo/redo (clears the redo branch like any new
  // edit). Re-derive the falling notes from the model (onsets/durations changed), keep the selection
  // on the same handle, announce the value change (folding a dotted snap in), and pulse the note.
  const cmd: ChangeDurationCommand = { kind: "changeDuration", handleId, direction, record: rec };
  commandStack.pushApplied(cmd);
  const notes = rederiveVisNotesFromModel(elementToHand);
  // The selection stays on the edited note. A duration STEP/DOT keeps the handle id (no pitched note
  // is added before it). A CROSS-BARLINE TIE inserts a continuation AFTER the start, so the start's
  // id is also unchanged; re-find by element defensively so selection is robust to any id shift.
  selectedHandle = scoreModel.handles.find((h) => h.el === handle.el)?.id ?? handleId;
  const announce = durationAnnounce(rec, fromValue);
  finishEdit(announce, notes);
  pulseSelection();
}

// Toggle the dot on the shared-selected NOTE (DOTTED v1), routed through the SAME command stack +
// re-derive path as the steppers so it is undoable and both surfaces re-render. The model ADDS a dot
// (grow to x1.5, the lengthen path) on a plain note or REMOVES it (shrink back, the shorten path) on a
// dotted note; an add that does not fit before the barline is a REFUSED no-op announced "No room to
// dot in this bar". No-op without a selected note (the cluster is hidden for a rest / no selection).
// The selection stays on the same handle (ids are stable across a duration edit) and the note pulses.
function dotSelectedNote(): void {
  if (!scoreModel || !commandStack || selectedHandle === null || !score) return;
  const handleId = selectedHandle;
  const handle = scoreModel.handles[handleId];
  if (!handle) return;
  const fromValue = durationValueName(handle.durationDivs, handle.divisions);
  // Snapshot per-note hand by element BEFORE the model mutates (see captureElementToHand / rederive).
  const elementToHand = captureElementToHand();

  // Run the model edit DIRECTLY (not through the stack) so a NO-OP (no room) does not push a command
  // and wipe the redo branch; only a real edit is recorded, via pushApplied (the model is mutated).
  const rec = scoreModel.changeDuration(handleId, "dot");
  if (!rec || rec.outcome === "noRoom" || rec.outcome === "atEnd") {
    // No room to add the dotted half before the barline (ties are a later increment, so a crossing dot
    // is refused, not split). Announce so a keyboard/SR user knows the press registered.
    editLive.textContent = "No room to dot in this bar";
    return;
  }

  const cmd: ChangeDurationCommand = {
    kind: "changeDuration",
    handleId,
    direction: "dot",
    record: rec,
  };
  commandStack.pushApplied(cmd);
  const notes = rederiveVisNotesFromModel(elementToHand);
  // Keep the selection on the edited note (re-find by element so a tie's inserted continuation, which
  // re-indexes, cannot misplace it; the start's id is in fact stable).
  selectedHandle = scoreModel.handles.find((h) => h.el === handle.el)?.id ?? handleId;
  // Same announce builder as the steppers: an add reads "D5 quarter to dotted quarter", a remove
  // "D5 dotted quarter to quarter", a non-plain snap folds in ("Double dotted half to dotted half").
  const announce = durationAnnounce(rec, fromValue);
  finishEdit(announce, notes);
  pulseSelection();
}

// The polite-region announce for a committed duration edit (Designer P3-6 / TIE-E), value-named in
// the current Names mode for the pitch token. Step: "D5 quarter to half"; clamp: "D5 lengthened to
// fill the bar"; CROSS-BARLINE TIE create: "D5 lengthened across the bar to half" (distinct from the
// in-bar clamp so the user hears it CROSSED); tie remove: "D5 half to quarter, tie removed"; a dotted
// arrival folds into the from->to ("Dotted quarter to quarter"). `fromValue` is the pre-edit value.
function durationAnnounce(
  rec: { outcome: string; fromName: string; toName: string; dottedSnap: boolean },
  fromValue: string,
): string {
  const pitch = selectedNoteLabel();
  // A lengthen/dot that grew the note PAST the barline with a tie: name the resulting SOUNDING value.
  if (rec.outcome === "tied") return `${pitch} lengthened across the bar to ${rec.toName}`;
  // A shorten that REMOVED a cross-barline tie: from the sounding value down, plus that the tie went.
  if (rec.outcome === "untied") return `${pitch} ${rec.fromName} to ${rec.toName}, tie removed`;
  if (rec.outcome === "clamped") return `${pitch} lengthened to fill the bar`;
  // A dotted/odd arrival snapped to plain: phrase it from the arrival value ("Dotted quarter to
  // quarter"), capitalized as it leads the sentence.
  if (rec.dottedSnap) return `${capitalize(fromValue)} to ${rec.toName || noteValueName("", 0)}`;
  return `${pitch} ${rec.fromName} to ${rec.toName}`;
}

// Whether the user prefers reduced motion (Designer P3-4: NO flash under it). Read fresh per call so
// a runtime OS toggle is honored.
function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

let pulseTimer: number | null = null;
// Briefly pulse the changed note on a duration commit (Designer P3-4): the staff notehead gets a
// transient brass accent glow (the .ph-accent class) and the canvas bar a stronger glow, for ~150ms,
// then both settle to the steady .ph-selected halo. A duration edit can leave the notehead in the
// same x/y while only its shape changes, so the one-shot flash draws the eye the way a position move
// does for a pitch edit. Skipped entirely under prefers-reduced-motion (the re-engrave + readout
// already confirm the change). The canvas pulse is driven through the visualizer's accent flag.
function pulseSelection(): void {
  if (prefersReducedMotion()) return;
  const noteId = selectedStaffId();
  const staffEl = noteId ? staffNoteEl(noteId) : null;
  staffEl?.classList.add("ph-accent");
  visualizer.setAccentPulse(selectedVisIndex());
  if (pulseTimer !== null) window.clearTimeout(pulseTimer);
  pulseTimer = window.setTimeout(() => {
    pulseTimer = null;
    // Clear the staff accent on whichever notehead currently carries it (the selection/render may
    // have moved by now); clear the canvas accent flag so the bar settles to its steady halo.
    if (verovioHost) {
      for (const el of verovioHost.querySelectorAll(".ph-accent")) el.classList.remove("ph-accent");
    }
    visualizer.setAccentPulse(null);
  }, 150);
}

// The <note> element the selection should move to AFTER deleting `handleId`: the next note in
// musical order, else the previous, else null (the score is now empty of pitched notes). Returned
// as the DOM element because a delete RE-INDEXES the handles, so the id is not stable across it;
// we re-find the handle owning this element after the delete. Excludes tie continuations (they
// have no VisNote to select), matching the staff nav order.
function neighborNoteElAfterDelete(handleId: number): Element | null {
  if (!scoreModel) return null;
  const order = scoreModel.handles
    .filter((h) => !h.isTieContinuation)
    .slice()
    .sort((a, b) => a.onsetSec - b.onsetSec || a.midi - b.midi);
  const pos = order.findIndex((h) => h.id === handleId);
  if (pos === -1) return null;
  const neighbor = order[pos + 1] ?? order[pos - 1] ?? null;
  return neighbor ? neighbor.el : null;
}

// Delete the shared-selected note (Smart Edit Mode delete, model-level, fixed-bar, undoable). The
// note becomes a REST of the same duration (a chord member is removed) so the measure still adds
// up and nothing after it reflows; the rest is not a VisNote, so it drops from the falling notes
// and the audio (the VisNote count falls by one). Routed through the command stack so it is
// undoable (undo restores the note AND the prior selection). Moves the selection to a sensible
// neighbor (next note, else previous, else clears). No-op without a selected, mapped note.
function deleteSelectedNote(): void {
  if (!scoreModel || !commandStack || selectedHandle === null || !score) return;
  const handleId = selectedHandle;
  const handle = scoreModel.handles[handleId];
  if (!handle) return;
  // The falling note this handle currently owns (so we can splice it out and announce its name).
  // A tie continuation maps to no VisNote; deleting it would not change the falling notes, so we
  // require a mapped VisNote (the staff/canvas only let you select mapped notes in practice).
  const visIndex = handleToVisIndex.get(handleId);
  if (visIndex === undefined) return;
  const deletedLabel = editNoteLabel(score.notes[visIndex]);
  const deletedVisNote = score.notes[visIndex];

  // Pick the neighbor to select next BEFORE the delete re-indexes the handles, by its DOM element.
  const neighborEl = neighborNoteElAfterDelete(handleId);

  // Push the delete command: apply() calls model.deleteNote (mutates the DOM + re-indexes) and
  // stashes the DeleteRecord on the command for undo. Record the falling note + its index on the
  // command too, so undo can splice it back at the right slot.
  const cmd: DeleteNoteCommand = {
    kind: "deleteNote",
    handleId,
    record: null,
    visNote: {
      midi: deletedVisNote.midi,
      time: deletedVisNote.time,
      duration: deletedVisNote.duration,
      hand: deletedVisNote.hand,
      spelling: deletedVisNote.spelling,
    },
    visIndex,
  };
  commandStack.push(cmd);

  // Re-derive the falling notes WITHOUT the deleted one (the count drops by one).
  const notes = score.notes.slice();
  notes.splice(visIndex, 1);

  // Move the shared selection to the neighbor (now re-indexed) by re-finding its handle, else clear.
  selectedHandle =
    neighborEl !== null
      ? (scoreModel.handles.find((h) => h.el === neighborEl)?.id ?? null)
      : null;

  finishEdit(`Deleted ${deletedLabel}`, notes);
}

// ----- ADD a note: fill a selected rest (ADD-a-note v1, the inverse of delete) -----

// The default pitch for a KEYBOARD add on a rest (ADD-2): the PREVIOUS sounding note's pitch in the
// SAME voice/staff, else the staff middle line. Adapts the model handles into the pure
// keyboardDefaultPitch (which owns the choice + the fallback); the user then nudges with Up/Down.
function keyboardDefaultPitchForRest(restId: number): ModelPitch {
  if (!scoreModel) return { step: "B", octave: 4, alter: 0 };
  const rest = scoreModel.restHandles[restId];
  if (!rest) return { step: "B", octave: 4, alter: 0 };
  const candidates = scoreModel.handles
    .filter((h) => !h.isTieContinuation)
    .map((h) => ({
      onsetSec: h.onsetSec,
      staff: num2(h.el, "staff", 1),
      voice: num2(h.el, "voice", 1),
      pitch: h.pitch,
    }));
  return keyboardDefaultPitch(rest.onsetSec, rest.staff, rest.voice, candidates);
}

// Read a numeric child (e.g. <staff>/<voice>) of a <note> element, defaulting when absent. Small
// local helper so the keyboard default can read a handle's staff/voice without re-walking.
function num2(el: Element, tag: string, fallback: number): number {
  const t = el.getElementsByTagName(tag).item(0)?.textContent?.trim();
  const n = t ? Number(t) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

// The default pitch for a MOUSE add on a rest (ADD-2): the staff line/space the user CLICKED. The
// click's vertical offset from the rest glyph's CENTER (the staff middle line) is converted to
// diatonic steps here (against the live glyph bbox), then mouseDefaultPitch applies them key-sig
// aware. Mirrors the staff drag's per-step pixel sensitivity (~half a glyph height). Falls back to
// the keyboard default when the glyph cannot be measured.
function mouseDefaultPitchForRest(restId: number, restG: SVGGElement, clientY: number): ModelPitch {
  if (!scoreModel) return keyboardDefaultPitchForRest(restId);
  const rest = scoreModel.restHandles[restId];
  if (!rest) return keyboardDefaultPitchForRest(restId);
  const bbox = restG.getBoundingClientRect();
  if (!bbox.height) return keyboardDefaultPitchForRest(restId);
  // A rest glyph spans roughly one staff space; a diatonic step is ~half that. Mirror the staff
  // drag's floor so a small glyph still steps sanely.
  const pxPerStep = Math.max(4, bbox.height / 2);
  const center = bbox.top + bbox.height / 2;
  const steps = Math.round((center - clientY) / pxPerStep); // above center = +steps (higher pitch)
  return mouseDefaultPitch(rest.staff, scoreModel.fifthsForRest(restId), steps);
}

// The hand a fill on `staff` should take: copy an EXISTING note's hand on that staff (the
// authority, since score.ts already tagged it from staff/clef), else fall back to the staff
// convention (staff 2 = left, staff 1 = right) only for a genuine grand staff, else "unknown".
function handForRestStaff(staff: number): VisNote["hand"] {
  if (scoreModel && score) {
    for (const h of scoreModel.handles) {
      if (num2(h.el, "staff", 1) !== staff) continue;
      const vi = handleToVisIndex.get(h.id);
      if (vi !== undefined) return score.notes[vi]?.hand;
    }
    // No note on this staff yet: a grand staff (some handle on staff 2) maps by convention.
    const hasStaff2 = scoreModel.handles.some((h) => num2(h.el, "staff", 1) === 2);
    if (hasStaff2) return staff === 2 ? "left" : "right";
  }
  return "unknown";
}

// Add a note by filling the SELECTED rest (ADD-a-note v1): turn the rest into a `<note>` of the
// SAME duration at `pitch` (fixed-bar, the inverse of delete), undoable. The new note is a real
// note from that instant: it appears on BOTH surfaces (a new falling bar) and becomes the shared
// selection so the next arrow / drag / +/- nudges its pitch via the existing P1 path. No-op
// without a selected rest. Routed through the command stack so undo turns it straight back into
// the rest (which returns selected).
function addSelectedRest(pitch: ModelPitch): void {
  if (!scoreModel || !commandStack || selectedRest === null || !score) return;
  const restId = selectedRest;
  const rest = scoreModel.restHandles[restId];
  if (!rest) return;
  const midi = midiFromPitch(pitch);
  // The new falling note shares the rest's onset + duration (fixed-bar) at the chosen pitch, and
  // inherits the HAND of the existing notes on the rest's staff (so its velocity/mute matches its
  // neighbors). Borrowing a real neighbor's hand exactly matches score.ts (which derives hand from
  // staff/clef) including the single-staff "unknown" case, rather than re-deriving it here.
  const addedVis: VisNote = {
    midi,
    time: rest.onsetSec,
    duration: rest.durationSec,
    hand: handForRestStaff(rest.staff),
    spelling: spellingFromPitch(pitch),
  };
  const cmd: AddNoteCommand = {
    kind: "addNote",
    restId,
    pitch,
    record: null,
    visNote: { midi, time: rest.onsetSec, duration: rest.durationSec, hand: addedVis.hand, spelling: addedVis.spelling },
  };
  commandStack.push(cmd); // applies it: the rest is now a <note>, handles re-indexed

  // Splice the new falling note in (the VisNote count grows by one); order does not matter to the
  // canvas (it draws by time), but keep onset order for tidy downstream indexing.
  const notes = score.notes.slice();
  const insertAt = firstIndexAfterOnset(notes, rest.onsetSec);
  notes.splice(insertAt, 0, addedVis);

  // The NEW NOTE is the shared selection: find its handle by the (midi, onset) it now owns.
  selectedRest = null;
  selectedHandle =
    scoreModel.handles.find(
      (h) => h.midi === midi && Math.abs(h.onsetSec - rest.onsetSec) < 1e-3,
    )?.id ?? null;

  finishEdit(`Added a note, ${pitchLabel(midi, addedVis.spelling)}`, notes);
}

// The index at which a note with `onsetSec` should be inserted to keep `notes` in onset order
// (stable: lands after any note already at that onset). Linear is fine (P1 edits are one at a time).
function firstIndexAfterOnset(notes: readonly VisNote[], onsetSec: number): number {
  for (let i = 0; i < notes.length; i++) {
    if (notes[i].time > onsetSec + 1e-9) return i;
  }
  return notes.length;
}

// Convert the selected rest from the KEYBOARD (Enter / N): default pitch = the previous note's
// pitch (ADD-2). No-op without a selected rest.
function addSelectedRestFromKeyboard(): void {
  if (selectedRest === null) return;
  addSelectedRest(keyboardDefaultPitchForRest(selectedRest));
}

// Undo of an ADD: the model turned the note back into the rest (re-indexed, so the rest reclaims
// its id). Splice the falling note BACK OUT and re-select the REST (so the user can try again),
// matching "after undoing a delete the note returns selected" in reverse. The VisNote count falls
// by one, so pass the explicit array to finishEdit.
function undoAdd(cmd: AddNoteCommand): void {
  if (!score) return;
  const notes = score.notes.slice();
  if (cmd.visNote) {
    const i = notes.findIndex(
      (n) => n.midi === cmd.visNote!.midi && Math.abs(n.time - cmd.visNote!.time) < 1e-3,
    );
    if (i !== -1) notes.splice(i, 1);
  }
  // Re-select the rest the note came from: it is the rest now at the converted slot. Match by
  // (onset, staff) since the rest reclaims a registry id but that id is by document position.
  selectedHandle = null;
  selectedRest = restIndexAtOnsetStaff(cmd);
  finishEdit("Removed the note", notes);
}

// Redo of an ADD: the model re-converted the rest (re-derived its record); splice the falling note
// back IN and re-select the NEW NOTE, exactly as the original add did.
function redoAdd(cmd: AddNoteCommand): void {
  if (!score || !scoreModel || !cmd.visNote) return;
  const notes = score.notes.slice();
  const restored: VisNote = {
    midi: cmd.visNote.midi,
    time: cmd.visNote.time,
    duration: cmd.visNote.duration,
    hand: cmd.visNote.hand,
    spelling: cmd.visNote.spelling,
  };
  const insertAt = firstIndexAfterOnset(notes, restored.time);
  notes.splice(insertAt, 0, restored);
  selectedRest = null;
  selectedHandle =
    scoreModel.handles.find(
      (h) => h.midi === cmd.visNote!.midi && Math.abs(h.onsetSec - cmd.visNote!.time) < 1e-3,
    )?.id ?? null;
  finishEdit(`Added a note, ${pitchLabel(cmd.visNote.midi, cmd.visNote.spelling)}`, notes);
}

// The rest-registry id of the rest at an added note's (onset, staff), used to re-select the rest
// after undoing an add. The added note's command carries its onset (visNote.time) and we know its
// staff from the hand it was given; match the model rest sharing that (onset, staff).
function restIndexAtOnsetStaff(cmd: AddNoteCommand): number | null {
  if (!scoreModel || !cmd.visNote) return null;
  const staff = cmd.visNote.hand === "left" ? 2 : 1;
  const r = scoreModel.restHandles.find(
    (rh) => rh.staff === staff && Math.abs(rh.onsetSec - cmd.visNote!.time) < 1e-3,
  );
  return r ? r.id : null;
}

// Shared tail for undo AND redo of a duration edit. The model has ALREADY mutated (undo restored
// the bar via restoreDuration; redo re-applied via changeDuration), and a duration edit keeps the
// pitched-note handle ids stable, so we re-derive the falling notes from the model, re-select the
// same handle, announce the reversal/redo, and pulse the changed note. The announce uses the
// command's recorded value + direction (Designer P3-6: "Undid lengthen to half" / mirror for redo).
function undoOrRedoDuration(
  cmd: ChangeDurationCommand,
  mode: "undo" | "redo",
  elementToHand: Map<Element, VisNote["hand"]>,
): void {
  if (!scoreModel) return;
  const notes = rederiveVisNotesFromModel(elementToHand);
  // The edited note keeps its handle id across a duration edit (a cross-barline tie inserts the
  // continuation AFTER the start, so the start id is stable too), so re-select by the recorded id.
  selectedHandle = cmd.handleId;
  // A dot edit reuses the stepper phrasing via its recorded verb (add = lengthen, remove = shorten),
  // so undo reads "Undid lengthen to dotted quarter" / "Undid shorten to quarter".
  const verb =
    cmd.direction === "dot"
      ? (cmd.record?.dotVerb ?? "lengthen")
      : cmd.direction === "longer"
        ? "lengthen"
        : "shorten";
  // The value the edit landed on (record.toName); for a CLAMP fill there is no plain ladder name, so
  // fall back to the post-edit value name on redo / "fill the bar" phrasing.
  const landed = cmd.record?.toName || "fill the bar";
  const announce =
    mode === "undo" ? `Undid ${verb} to ${landed}` : `Redid ${verb} to ${landed}`;
  finishEdit(announce, notes);
  pulseSelection();
}

// Load MusicXML into OSMD and rebuild the pipeline. Shared by the direct MusicXML file
// path and the OMR scan result path.
async function loadScoreXml(
  xml: string,
  name: string,
  opts: { upgrade?: boolean } = {},
): Promise<void> {
  // Retain the source MusicXML so Smart Edit Mode can hand it to Verovio (P0). This was
  // previously discarded (a local that vanished after osmd.load). A fresh load also drops any
  // active edit-mode view + its Verovio render, which belonged to the previous score.
  sourceMusicXml = xml;
  if (editMode) exitEditMode();
  verovioRender = null;
  await osmd.load(xml);
  osmd.render();
  osmd.cursor.reset();
  osmd.cursor.show();
  // Rebuild the note-name overlay against the freshly rendered noteheads.
  renderSheetLabels(osmd, sheetContainer, labelMode);

  const data = extractScore(osmd);
  // Progressive upgrade (a partial refining into the complete result, or a per-page score growing):
  // keep the player where it is rather than resetting to the top with fresh mutes/name. Only when a
  // score is already loaded; the first partial falls through to the full load below.
  if (opts.upgrade && score) {
    upgradeNotes(data);
    return;
  }

  // A FRESH (non-upgrade) load replaces the score entirely, so drop any leftover streaming loader
  // from a previous job. The streaming partials after the first are upgrades (returned above), so
  // their per-partial loader render is not disturbed; only a genuinely new score clears here.
  clearStreamOverlay(sheetContainer);

  // Issue #44: default the sheet name to the MusicXML title when present, else the file name.
  // `osmd.Sheet.TitleString` is the parsed work title; guard defensively in case a score has
  // no title metadata.
  const xmlTitle = (osmd.Sheet as { TitleString?: string } | undefined)?.TitleString ?? null;
  loadNotes(data, deriveDefaultSheetName(name, xmlTitle), true);
}

// Transcribe an uploaded audio file (issue #19) into falling notes. There is no sheet
// view for audio yet, so we clear any previously rendered sheet and its overlay and run
// the player in cursor-less mode.
//
// `shouldApply` is checked immediately before the score is loaded (issue #86 cancel fix).
// The transcription cannot be aborted server-side, so a cancelled or superseded job keeps
// running and resolves late; without this guard the abandoned result would still call
// loadNotes and appear on screen (and a cancel-then-restart would load job A's score under
// job B's overlay). When the guard is false we skip loadNotes entirely, so the prior state
// (or the newer job) is left untouched.
async function loadAudioFile(file: File, shouldApply: () => boolean): Promise<void> {
  // Audio scores have no MusicXML to engrave, so drop any retained source + exit edit mode
  // (the Edit button stays disabled without a sheet). Guarded so a cancelled/superseded job
  // that never reaches loadNotes still leaves edit state coherent.
  sourceMusicXml = null;
  if (editMode) exitEditMode();
  verovioRender = null;
  // The cursor only exists once a sheet has been loaded; it is undefined on a fresh page.
  osmd.cursor?.hide();
  try {
    osmd.clear();
  } catch {
    // Nothing was rendered yet; clearing is a no-op.
  }
  renderSheetLabels(osmd, sheetContainer, labelMode); // empties the overlay too
  clearStreamOverlay(sheetContainer); // audio has no per-system stream; drop any leftover loader

  // Lazy-load the transcription module (TensorFlow.js + Basic Pitch is ~3 MB) so it is
  // fetched only when a user actually transcribes audio, not on every page load.
  const { transcribeAudioFile } = await import("./transcribe");
  const notes = await transcribeAudioFile(file, (fraction) => {
    if (!shouldApply()) return; // do not narrate progress for an abandoned job
    showStatus(`Transcribing audio... ${Math.round(fraction * 100)}%`);
  });
  // Drop the result if the job was cancelled or superseded while it was running, checked
  // right before the load so the abandoned score never reaches the screen.
  if (!shouldApply()) return;
  const duration = notes.reduce((max, n) => Math.max(max, n.time + n.duration), 0);
  // Audio has no MusicXML title, so the default name comes from the file name (issue #44).
  loadNotes({ notes, stepTimes: [], duration }, deriveDefaultSheetName(file.name, null), false);
}

// Heroicons (MIT) solid play / pause path data. We swap only the icon path and the label
// span so the inline <svg> and its currentColor wiring survive (replacing playBtn.textContent
// would wipe the icon).
const PLAY_ICON_PATH =
  "M4.5 5.65257C4.5 4.22644 6.029 3.32239 7.2786 4.00967L18.8192 10.357C20.1144 11.0694 20.1144 12.9304 18.8192 13.6428L7.2786 19.9901C6.029 20.6774 4.5 19.7733 4.5 18.3472V5.65257Z";
const PAUSE_ICON_PATH =
  "M6.75 5.25C6.75 4.83579 7.08579 4.5 7.5 4.5H9C9.41421 4.5 9.75 4.83579 9.75 5.25V18.75C9.75 19.1642 9.41421 19.5 9 19.5H7.5C7.30109 19.5 7.11032 19.421 6.96967 19.2803C6.82902 19.1397 6.75 18.9489 6.75 18.75L6.75 5.25ZM14.25 5.25C14.25 4.83579 14.5858 4.5 15 4.5H16.5C16.6989 4.5 16.8897 4.57902 17.0303 4.71967C17.171 4.86032 17.25 5.05109 17.25 5.25V18.75C17.25 19.1642 16.9142 19.5 16.5 19.5H15C14.5858 19.5 14.25 19.1642 14.25 18.75V5.25Z";

function setPlaying(value: boolean): void {
  playing = value;
  const label = value ? "Pause" : "Play";
  if (playLabel) playLabel.textContent = label;
  playBtn.setAttribute("aria-label", label);
  const iconPath = playIcon?.querySelector("path");
  if (iconPath) iconPath.setAttribute("d", value ? PAUSE_ICON_PATH : PLAY_ICON_PATH);
}

// Render the loaded-piece view of the toolbar slot: the editable name button + the note
// count, with the status text hidden. Called after a score loads and whenever the name
// changes. Does nothing visible while a status message is showing or the name field is open;
// those paths manage the slot themselves.
function renderSheetName(): void {
  sheetNameBtn.textContent = sheetName;
  sheetNameBtn.title = `Rename sheet (currently "${sheetName}")`;
  sheetNoteCount.textContent = noteCount === 1 ? "1 note" : `${noteCount} notes`;
}

// Switch the slot from a loaded piece to a transient status message (scanning, transcribing,
// recording, an error). Hides the editable name + count so a long job does not look like a
// sheet title; `restoreSheetName` brings the name back. A no-op when no score is loaded
// (the boot placeholder already lives in the status span).
function showStatus(message: string): void {
  cancelNameEdit();
  sheetNameBtn.hidden = true;
  sheetNoteCount.hidden = true;
  trackStatus.hidden = false;
  trackStatus.textContent = message;
}

// Return the slot to showing the editable sheet name + note count after a status message.
function restoreSheetName(): void {
  if (!score) return;
  trackStatus.hidden = true;
  sheetNameBtn.hidden = false;
  sheetNoteCount.hidden = false;
  renderSheetName();
}

// Adopt a new sheet name (from a load default or a user edit) and reflect it in the UI plus
// the document title so the rename is visible beyond the toolbar.
function setSheetName(name: string): void {
  sheetName = name || DEFAULT_SHEET_NAME;
  document.title = `${sheetName} - Piano Helper`;
  if (!trackStatus.hidden) return; // a status message owns the slot; restore later.
  renderSheetName();
}

// Open the inline rename field: swap the name button for a text input seeded with the
// current name, focused and selected so the user can type immediately.
function enterNameEdit(): void {
  if (!score || nameEditing) return;
  nameEditing = true;
  sheetNameInput.value = sheetName;
  sheetNameBtn.hidden = true;
  sheetNameInput.hidden = false;
  sheetNameInput.focus();
  sheetNameInput.select();
}

// Commit the inline edit: an empty submission reverts to the current name (a rename cannot
// blank the title); otherwise the normalized edit becomes the new name.
function commitNameEdit(): void {
  if (!nameEditing) return;
  const next = resolveEditedSheetName(sheetNameInput.value, sheetName);
  closeNameEdit();
  setSheetName(next);
  updateSheetTitle(next);
}

// Reflect a rename in the OSMD-rendered score title so the sheet header matches the toolbar
// name (issue #44 follow-up: the inline rename used to update only the toolbar label and the
// document title, leaving the original work title drawn atop the score). We write the new name
// into the OSMD model via `TitleString` (which rebuilds the title Label), so the change also
// survives autoResize re-renders, then re-render and restore the cursor to its current spot.
// No-op for audio-derived scores (no rendered sheet) and when the title is already correct
// (e.g. the load-time default that matches the work title), avoiding a needless re-render.
function updateSheetTitle(name: string): void {
  if (!hasSheet) return;
  const sheet = osmd.Sheet as { TitleString?: string } | undefined;
  if (!sheet || sheet.TitleString === name) return;
  const scoreTime = score ? Tone.getTransport().seconds * tempoRate : 0;
  sheet.TitleString = name;
  osmd.render();
  resyncCursor(scoreTime); // re-render resets the cursor; put it back where the playhead is
  renderSheetLabels(osmd, sheetContainer, labelMode); // re-render clears the overlay too
}

// Discard an in-progress edit without changing the name.
function cancelNameEdit(): void {
  if (!nameEditing) return;
  closeNameEdit();
  renderSheetName();
}

// Tear down the inline field and show the name button again. Shared by commit and cancel.
function closeNameEdit(): void {
  nameEditing = false;
  sheetNameInput.hidden = true;
  sheetNameBtn.hidden = false;
}

async function togglePlay(): Promise<void> {
  await Tone.start();
  const transport = Tone.getTransport();
  if (playing) {
    transport.pause();
    setPlaying(false);
  } else {
    // Pressing Play in edit mode suspends the selection so a moving target is never edited
    // (Designer decision): the selection clears (hiding the edit cluster) but edit mode stays
    // on; pausing again lets the player re-select. Any in-flight drag is abandoned. Covers a NOTE
    // or a REST selection (either hides its cluster).
    if (editMode && (selectedHandle !== null || selectedRest !== null)) {
      cancelDrag();
      selectedHandle = null;
      selectedRest = null;
      lastRestPointer = null;
      reflectSharedSelection();
    }
    transport.start();
    setPlaying(true);
  }
}

function rewind(): void {
  const transport = Tone.getTransport();
  transport.stop();
  transport.position = 0;
  stepIndex = 0;
  if (hasSheet) {
    osmd.cursor.reset();
    osmd.cursor.show();
  }
  updateSeekUI(0);
  setPlaying(false);
}

// Enable/disable the transport row controls (prev, next, seek) as a group, matching the
// Play button's lifecycle. They are only usable once a score is loaded.
function setTransportControlsEnabled(enabled: boolean): void {
  prevNoteBtn.disabled = !enabled;
  nextNoteBtn.disabled = !enabled;
  seekSlider.disabled = !enabled;
}

// Reflect a score time on the seek slider, the time readout, and the slider's accessible
// value text. Skips the slider write while the user is dragging it (avoids fighting the drag).
function updateSeekUI(scoreTime: number): void {
  if (!score) return;
  const clock = `${formatClock(scoreTime)} / ${formatClock(score.duration)}`;
  timeReadout.textContent = clock;
  seekSlider.setAttribute("aria-valuetext", clock);
  if (!userSeeking) {
    seekSlider.value = String(scoreTimeToSeek(scoreTime, score.duration));
  }
}

// Reposition the sheet cursor to the step at or before `scoreTime`. Rebuilds from the start
// each call so it handles backward jumps (the cursor only moves forward natively).
function resyncCursor(scoreTime: number): void {
  if (!hasSheet || !score) return;
  osmd.cursor.reset();
  stepIndex = 0;
  const { stepTimes } = score;
  while (stepIndex < stepTimes.length - 1 && scoreTime >= stepTimes[stepIndex + 1]) {
    osmd.cursor.next();
    stepIndex++;
  }
  osmd.cursor.show();
}

// Move the playhead to an absolute score time (seconds), keeping the transport, the sheet
// cursor, the falling notes, and the seek UI in sync. Works while paused or playing; the
// rAF loop renders the new position next frame, and we render once here so a paused seek
// updates immediately.
function seekScoreTime(scoreTime: number): void {
  if (!score) return;
  const clamped = Math.max(0, Math.min(scoreTime, score.duration));
  // scoreTime = transport.seconds * tempoRate, so invert to set the transport clock.
  Tone.getTransport().seconds = tempoRate > 0 ? clamped / tempoRate : 0;
  resyncCursor(clamped);
  updateSeekUI(clamped);
  visualizer.render(clamped);
}

// Step the playhead one note onset forward or backward (issue #29). Pauses first so the
// player can walk through the piece note by note. Backward at the start snaps to 0.
function stepNote(direction: 1 | -1): void {
  if (!score || busy) return;
  if (playing) {
    Tone.getTransport().pause();
    setPlaying(false);
  }
  const current = Tone.getTransport().seconds * tempoRate;
  const target =
    direction > 0 ? nextOnset(onsets, current) : prevOnset(onsets, current);
  if (target === null) {
    if (direction < 0) seekScoreTime(0);
    return;
  }
  seekScoreTime(target);
}

// Advance the sheet cursor so the highlighted note matches the playback time.
function syncCursor(currentTime: number): void {
  if (!score) return;
  const { stepTimes } = score;
  while (stepIndex < stepTimes.length - 1 && currentTime >= stepTimes[stepIndex + 1]) {
    osmd.cursor.next();
    stepIndex++;
  }
}

fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (file) {
    loadScoreFile(file).catch((err) => {
      console.error("Failed to load score:", err);
      alert(`Failed to load score: ${err.message}`);
    });
  }
});

let busy = false;

// Toggle the inputs and play button while a long job (OMR scan or audio transcription)
// is in flight. The rAF render loop keeps running; only the controls are disabled.
function setBusyUI(active: boolean): void {
  busy = active;
  fileInput.disabled = active;
  scanInput.disabled = active;
  audioInput.disabled = active;
  if (active) {
    playBtn.disabled = true;
    exportMenuBtn.disabled = true;
    editBtn.disabled = true;
    closeExportMenu();
    setTransportControlsEnabled(false);
  } else {
    // Restore play/export/transport to match whether a score is loaded (issue #86 cancel
    // fix). On the cancel/abandon path loadNotes never runs, so without this a previously
    // loaded score would be left with its controls stuck disabled. Enable only when a score
    // exists, matching the post-load and post-export enable conditions.
    const enabled = controlsEnabledForScore(!!score);
    playBtn.disabled = !enabled;
    exportMenuBtn.disabled = !enabled;
    setEditButtonEnabled();
    setExportMenuState();
    setTransportControlsEnabled(enabled);
  }
}

// Scan-overlay state. `cancelRequested` is the client-side abandon flag the OMR poll
// loop checks (the job keeps running server-side, we just stop waiting).
let cancelRequested = false;
let lastFocusedBeforeOverlay: HTMLElement | null = null;
// Bumped each time a job starts so a cancelled-then-restarted audio job's late finally
// cannot tear down the newer job's overlay (the audio transcription cannot be aborted).
let jobGeneration = 0;

// Show the blocking overlay over the stage for a ~1-minute opaque job. Saves the
// previously-focused element and moves focus to Cancel; the busy state already greyed
// the toolbar, so this is the primary feedback.
function showScanOverlay(kind: ScanOverlayKind): void {
  cancelRequested = false;
  scanOverlayTitleEl.textContent = scanOverlayTitle(kind);
  lastFocusedBeforeOverlay =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;
  scanOverlay.hidden = false;
  scanOverlayCancel.focus();
}

// Re-hide the overlay and restore focus to whatever had it before the overlay opened.
function hideScanOverlay(): void {
  if (scanOverlay.hidden) return;
  scanOverlay.hidden = true;
  const toRestore = lastFocusedBeforeOverlay;
  lastFocusedBeforeOverlay = null;
  if (toRestore && document.contains(toRestore)) {
    toRestore.focus();
  }
}

// Cancel = client-side abandon. Sets the poll-loop flag (the scan path rejects with the
// CANCELLED sentinel its catch swallows), closes the overlay, re-enables the controls, and
// restores the prior slot. Both kinds tear down the UI synchronously here: the scan path's
// in-flight /api/omr round-trip can take seconds to settle, and waiting for its finally to
// re-enable controls (issue #93) left a prior score's Play/Export/seek/step stuck disabled
// with no overlay. The in-flight job is ignored on completion (scan via the CANCELLED
// sentinel its catch swallows, audio via the generation guard in its finally).
function cancelScanOverlay(): void {
  if (scanOverlay.hidden) return;
  cancelRequested = true;
  hideScanOverlay();
  // Drop any per-system streaming loader so its skeleton rows do not linger over the restored slot
  // (a cancel after the first streaming partial leaves the loader up otherwise).
  clearStreamOverlay(sheetContainer);
  setBusyUI(false);
  restoreSheetName();
}

scanOverlayCancel.addEventListener("click", () => cancelScanOverlay());

// Minimal focus trap: Cancel is the only control, so Tab / Shift+Tab keep focus on it,
// and Escape behaves like Cancel (abandon + close). Scoped to the overlay node so it
// only fires while the overlay is open.
scanOverlay.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    e.preventDefault();
    cancelScanOverlay();
  } else if (e.key === "Tab") {
    e.preventDefault();
    scanOverlayCancel.focus();
  }
});

async function scanSheet(file: File): Promise<void> {
  const generation = ++jobGeneration;
  setBusyUI(true);
  showScanOverlay("scan");
  showStatus("Scanning sheet... (the accurate scan can take several minutes)");
  // True once the first progressive partial has been shown. After that the overlay is gone, the
  // controls are live, and the score is on screen; later partials and the final complete UPGRADE it
  // in place (preserving the playhead) rather than reloading from the top.
  let shownPartial = false;
  try {
    const jobId = await submitOmr(file);
    const xml = await pollOmrResult(jobId, {
      // Abort the wait on a user cancel OR when a newer job supersedes this one. A progressive job
      // keeps polling after the overlay is gone (the controls are re-enabled on the first partial),
      // so a stale loop must stop once the user starts another scan.
      isCancelledRequested: () => cancelRequested || generation !== jobGeneration,
      onPartial: async (partialXml, _version, frontier) => {
        if (!shouldApplyResult(generation, jobGeneration, cancelRequested)) return;
        // First partial: drop the blocking overlay and re-enable the controls so the user can see
        // and play the score-so-far while the rest is still being recognized.
        if (!shownPartial) {
          hideScanOverlay();
          setBusyUI(false);
        }
        await loadScoreXml(partialXml, file.name, { upgrade: shownPartial });
        shownPartial = true;
        // Block-by-block streaming partial: it carries the system FRONTIER and contains ONLY the
        // finished systems, so the per-system "recognition scan-line" loader REPLACES the #86
        // blocking overlay for the sheet pane (the user watches the page fill in). Drawn AFTER the
        // partial engraves so the finished systems exist to measure. A frontier-less partial
        // (fast-then-refine) keeps the old generic status and shows no per-system loader.
        if (shouldShowSystemLoader(frontier)) {
          const f = frontier as SystemFrontier;
          renderStreamOverlay(osmd, sheetContainer, f.done, f.total);
          // The active system is the one after the finished ones (1-based for the reader); once all
          // are finalized the next complete write lands momentarily.
          const active = Math.min(f.done + 1, f.total);
          showStatus(
            f.done >= f.total
              ? "Finishing the score..."
              : `Recognizing system ${active} of ${f.total}...`,
          );
        } else {
          clearStreamOverlay(sheetContainer);
          showStatus("Showing notes. Refining the rest...");
        }
      },
    });
    if (!shouldApplyResult(generation, jobGeneration, cancelRequested)) return;
    await loadScoreXml(xml, file.name, { upgrade: shownPartial });
    // The complete score is engraved; tear down the per-system loader so no skeleton rows linger.
    clearStreamOverlay(sheetContainer);
    if (shownPartial) restoreSheetName(); // the refine is done; drop the "Refining..." line.
  } catch (err) {
    // Superseded by a newer scan: drop this one silently so its late settle cannot stomp the new
    // job's overlay/controls (issue #93). The new job owns the UI.
    if (generation !== jobGeneration) return;
    // A recognition failure AFTER a partial already rendered: keep the fast result instead of wiping
    // the screen with an error (the fusion path cannot actually reach this, since a partial means
    // geom succeeded; this is a defensive degrade). A cancel still propagates so its caller restores
    // the slot quietly.
    if (shownPartial && !isCancelled(err)) {
      console.error("Scan refine failed; keeping the partial result:", err);
      // The refine is over (it failed), so no more systems are coming; drop the per-system loader so
      // the last partial's skeleton rows do not linger forever over the kept result.
      clearStreamOverlay(sheetContainer);
      showStatus("Showing notes (could not refine the rest).");
      return;
    }
    throw err;
  } finally {
    // Only tear down if this is still the active job. A cancel re-enables the controls and hides the
    // overlay synchronously and may have started a newer job; a late settle of this abandoned scan
    // must not stomp the newer job's overlay/controls (issue #93). setBusyUI(false) and
    // hideScanOverlay are idempotent (and already run on the first partial).
    if (generation === jobGeneration) {
      setBusyUI(false);
      hideScanOverlay();
    }
  }
}

scanInput.addEventListener("change", () => {
  if (busy) return;
  const file = scanInput.files?.[0];
  if (!file) return;
  scanSheet(file).catch((err) => {
    // A cancel is a deliberate abandon, not a failure: just restore the slot quietly.
    if (isCancelled(err)) {
      restoreSheetName();
      return;
    }
    console.error("Scan failed:", err);
    showStatus("Scan failed.");
    alert(`Scan failed: ${err.message}`);
  });
  // Allow re-selecting the same file to retry.
  scanInput.value = "";
});

async function transcribeAudio(file: File): Promise<void> {
  const generation = ++jobGeneration;
  setBusyUI(true);
  showScanOverlay("audio");
  showStatus("Transcribing audio... (this can take a minute)");
  try {
    // Gate the actual load: loadAudioFile only calls loadNotes when this job is still the
    // active one and was not cancelled. showScanOverlay resets cancelRequested when a NEW
    // job starts, so the generation check (not just cancelRequested) is what stops job A's
    // late result from loading under job B's overlay.
    await loadAudioFile(file, () =>
      shouldApplyResult(generation, jobGeneration, cancelRequested),
    );
  } finally {
    // Only tear down if this is still the active job: a cancel may have started a newer
    // one, and this stale transcription must not close the new overlay.
    if (generation === jobGeneration) {
      setBusyUI(false);
      hideScanOverlay();
    }
  }
}

audioInput.addEventListener("change", () => {
  if (busy) return;
  const file = audioInput.files?.[0];
  if (!file) return;
  transcribeAudio(file).catch((err) => {
    if (cancelRequested) {
      restoreSheetName();
      return;
    }
    console.error("Transcription failed:", err);
    showStatus("Transcription failed.");
    alert(`Could not transcribe audio: ${err.message}`);
  });
  // Allow re-selecting the same file to retry.
  audioInput.value = "";
});

playBtn.addEventListener("click", () => togglePlay());

prevNoteBtn.addEventListener("click", () => stepNote(-1));
nextNoteBtn.addEventListener("click", () => stepNote(1));

// Dragging the seek slider scrubs the playhead live. `input` fires continuously during the
// drag (mouse or keyboard); `change` marks the end so the rAF loop can resume driving the
// slider from the transport position.
seekSlider.addEventListener("input", () => {
  if (!score) return;
  userSeeking = true;
  seekScoreTime(seekToScoreTime(Number(seekSlider.value), score.duration));
});
seekSlider.addEventListener("change", () => {
  userSeeking = false;
});

// Global keyboard shortcuts: Space toggles play/pause, Left/Right step by note. Arrow keys
// are ignored when a form control (the seek or tempo slider) is focused so they keep their
// native behavior; Space is handled globally (prevented so a focused button is not also
// clicked).
window.addEventListener("keydown", (e) => {
  if (!score || busy) return;
  const target = e.target as HTMLElement | null;
  const tag = target?.tagName;
  const isFormField =
    tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || !!target?.isContentEditable;

  if (e.code === "Space") {
    if (isFormField) return;
    e.preventDefault();
    togglePlay();
  } else if (e.code === "ArrowRight") {
    if (isFormField || editMode) return; // edit mode: the edit listener owns the arrows
    e.preventDefault();
    stepNote(1);
  } else if (e.code === "ArrowLeft") {
    if (isFormField || editMode) return;
    e.preventDefault();
    stepNote(-1);
  }
});

// Trigger a browser download of a recorded blob.
function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke after a tick so the download has started.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Export the performance (issue #15): play it once from the top while recording the
// falling-notes canvas plus the live audio into a single WebM/MP4 file the user can
// download and upload to YouTube. Fully client-side via captureStream + MediaRecorder;
// no service, no API. The sheet view is a separate SVG and is not part of the recording,
// so the video shows the Synthesia-style performance area only.
async function exportVideo(): Promise<void> {
  if (!score || busy) return;

  const format = chooseVideoFormat((t) => MediaRecorder.isTypeSupported(t));
  if (!format) {
    alert("Video recording is not supported in this browser.");
    return;
  }

  // Reuse the user's sheet name for the exported file (issue #44).
  const exportLabel = sheetName || "performance";
  setBusyUI(true);

  let streamDest: MediaStreamAudioDestinationNode | null = null;
  let canvasStream: MediaStream | null = null;
  try {
    // Awaiting Tone.start() (driven by this button's user gesture) resumes the audio
    // context, so the transport actually advances once we start it below.
    await Tone.start();

    // Tee the master output into a MediaStream so the recording captures exactly what
    // is played (synth or sampler, at the current tempo).
    const rawContext = Tone.getContext().rawContext as unknown as AudioContext;
    streamDest = rawContext.createMediaStreamDestination();
    Tone.getDestination().connect(streamDest);

    canvasStream = canvas.captureStream(30);
    const mixed = new MediaStream([
      ...canvasStream.getVideoTracks(),
      ...streamDest.stream.getAudioTracks(),
    ]);

    const recorder = new MediaRecorder(mixed, { mimeType: format.mimeType });
    const chunks: BlobPart[] = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    const recorderStopped = new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
    });

    // Start the performance from the top and record it in real time. The timeslice flushes
    // a chunk each second so a long performance does not buffer entirely in memory. Clear any
    // active edit selection first (note OR rest) so its ring is never baked into the recorded video.
    if (selectedHandle !== null || selectedRest !== null) {
      cancelDrag();
      selectedHandle = null;
      selectedRest = null;
      lastRestPointer = null;
      reflectSharedSelection();
    }
    rewind();
    recorder.start(1000);
    const transport = Tone.getTransport();
    transport.start();
    setPlaying(true);
    showStatus("Recording video...");

    // Wait until playback reaches the end. The rAF loop calls rewind() at the end of the
    // score, which stops the transport; we detect that here and finalize the recording.
    await new Promise<void>((resolve) => {
      const id = setInterval(() => {
        const scoreTime = transport.seconds * tempoRate;
        const reachedEnd = score !== null && score.duration > 0 && scoreTime >= score.duration;
        if (!playing || transport.state !== "started" || reachedEnd) {
          clearInterval(id);
          resolve();
        }
      }, 100);
    });

    transport.stop();
    setPlaying(false);
    recorder.stop();
    await recorderStopped;

    const blob = new Blob(chunks, { type: format.mimeType });
    downloadBlob(blob, buildExportFilename(exportLabel, format.extension));
  } catch (err) {
    console.error("Video export failed:", err);
    alert(`Video export failed: ${(err as Error).message}`);
  } finally {
    if (streamDest) Tone.getDestination().disconnect(streamDest);
    canvasStream?.getTracks().forEach((t) => t.stop());
    restoreSheetName();
    // setBusyUI(false) restores play/export/transport based on whether a score is loaded
    // (issue #86 cancel fix), so no separate re-enable is needed here.
    setBusyUI(false);
  }
}

// ===== Export menu (Video / PDF / MusicXML) =====
//
// The single "Export" disclosure pill opens a small popup of three formats. Video records the
// performance (exportVideo, above); PDF renders the Verovio engraving to a multi-page PDF; MusicXML
// downloads the score's MusicXML. PDF + MusicXML need an engravable sheet, so they disable for
// audio-only scores (design.md EXPORT-5). The popup is a disclosure + a GROUP of plain buttons (not
// a role="menu"), so each item is a normal tab stop and a disabled item can still show why it is off.

const exportItems = (): HTMLButtonElement[] => [exportVideoBtn, exportPdfBtn, exportMusicxmlBtn];

// Set both `disabled` and `aria-disabled` in lockstep, the project's disabled idiom (undo/redo, the
// duration-ladder ends).
function setItemDisabled(btn: HTMLButtonElement, disabled: boolean): void {
  btn.disabled = disabled;
  btn.setAttribute("aria-disabled", String(disabled));
}

// Sync the per-format items with what the current score supports. Video works for any loaded score;
// PDF + MusicXML need a sheet (editModeAvailable() = a rendered sheet + retained MusicXML). Runs
// wherever setEditButtonEnabled() does, so the items track sheet availability.
function setExportMenuState(): void {
  const canExport = !busy && !!score;
  const canSheet = canExport && editModeAvailable();
  setItemDisabled(exportVideoBtn, !canExport);
  setItemDisabled(exportPdfBtn, !canSheet);
  setItemDisabled(exportMusicxmlBtn, !canSheet);
}

function openExportMenu(): void {
  if (exportMenuBtn.disabled || !exportMenu.hidden) return;
  exportMenu.hidden = false;
  exportMenuBtn.setAttribute("aria-expanded", "true");
  // Focus the first ENABLED item (Video is enabled whenever the trigger is).
  exportItems()
    .find((b) => !b.disabled)
    ?.focus();
  // Dismiss on a pointer press outside the wrap (capture so it runs before the items' own handlers).
  document.addEventListener("pointerdown", onExportOutsidePointer, true);
}

function closeExportMenu(opts: { restoreFocus?: boolean } = {}): void {
  if (exportMenu.hidden) return;
  exportMenu.hidden = true;
  exportMenuBtn.setAttribute("aria-expanded", "false");
  document.removeEventListener("pointerdown", onExportOutsidePointer, true);
  if (opts.restoreFocus) exportMenuBtn.focus();
}

function onExportOutsidePointer(e: PointerEvent): void {
  if (!exportMenuWrap.contains(e.target as Node)) closeExportMenu();
}

// Move focus among the ENABLED items (wrapping), for Up/Down arrow nav inside the open popup.
function moveExportFocus(dir: 1 | -1): void {
  const items = exportItems().filter((b) => !b.disabled);
  if (items.length === 0) return;
  const idx = items.indexOf(document.activeElement as HTMLButtonElement);
  items[(idx + dir + items.length) % items.length].focus();
}

exportMenuBtn.addEventListener("click", () => {
  if (exportMenu.hidden) openExportMenu();
  else closeExportMenu({ restoreFocus: true });
});

exportMenuBtn.addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown" && exportMenu.hidden && !exportMenuBtn.disabled) {
    e.preventDefault();
    openExportMenu();
  }
});

exportMenu.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    e.preventDefault();
    closeExportMenu({ restoreFocus: true });
  } else if (e.key === "ArrowDown") {
    e.preventDefault();
    moveExportFocus(1);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    moveExportFocus(-1);
  }
});

// Each item: close the popup and return focus to the trigger, then run the format's export. The
// action's own guards (disabled item, missing source) still apply.
exportVideoBtn.addEventListener("click", () => {
  closeExportMenu({ restoreFocus: true });
  exportVideo();
});
exportPdfBtn.addEventListener("click", () => {
  closeExportMenu({ restoreFocus: true });
  exportPdf();
});
exportMusicxmlBtn.addEventListener("click", () => {
  closeExportMenu({ restoreFocus: true });
  exportMusicXml();
});

// The MusicXML to export: the LIVE edited model in edit mode, else the retained source (null for an
// audio-only score, where the items are disabled anyway).
function currentExportXml(): string | null {
  return chooseExportXml({
    editMode,
    editedXml: editMode && scoreModel ? scoreModel.serialize() : null,
    sourceMusicXml,
  });
}

// Export MusicXML: a Blob + object-URL download (downloadBlob), named from the sheet like the video.
function exportMusicXml(): void {
  if (!score) return;
  const xml = currentExportXml();
  if (!xml) return; // audio-only; the item is disabled, this is a belt-and-braces guard
  downloadBlob(musicXmlBlob(xml), buildExportFilename(sheetName || "score", "musicxml"));
}

// A dedicated Verovio toolkit for PDF export, ALWAYS its own instance (never the shared edit-mode
// `verovioToolkit`). PDF render is async: it sets the paginating options, loadData, then walks the
// pages across awaits. If it shared the edit toolkit, a user entering edit mode mid-build would
// re-run setOptions/loadData on that same instance and silently corrupt the in-flight PDF (and the
// edit view). loadVerovioToolkit builds a fresh toolkit sharing only the immutable WASM module, so a
// second instance is cheap (the WASM is not recompiled) and fully isolated from the edit engraving.
let exportToolkit: VerovioToolkit | null = null;
async function getExportToolkit(): Promise<VerovioToolkit> {
  if (!exportToolkit) exportToolkit = await loadVerovioToolkit();
  return exportToolkit;
}

// Export PDF: render the score's Verovio engraving to a (multi-page) PDF via svg2pdf + jsPDF (both
// lazy-loaded). Named from the sheet; a brief status covers the first-use toolkit load. The
// re-entrancy guard stops a second click from interleaving two renders on the one export toolkit.
let pdfBuilding = false;
async function exportPdf(): Promise<void> {
  if (!score || pdfBuilding) return;
  const xml = currentExportXml();
  if (!xml) return;
  pdfBuilding = true;
  showStatus("Building PDF...");
  try {
    const toolkit = await getExportToolkit();
    const blob = await renderMusicXmlToPdfBlob(toolkit, xml);
    downloadBlob(blob, buildExportFilename(sheetName || "score", "pdf"));
  } catch (err) {
    console.error("PDF export failed:", err);
    alert(`PDF export failed: ${(err as Error).message}`);
  } finally {
    pdfBuilding = false;
    restoreSheetName();
  }
}

// Apply a tempo percent: clamp it, update the rate, the live transport bpm, the slider,
// and the readout. Works before playback (bpm is set for the next start) and live during
// playback (Tone scales the already-scheduled seconds-based events with no Part rebuild).
function applyTempo(percent: number): void {
  const clamped = clampTempoPercent(percent);
  tempoRate = tempoPercentToRate(clamped);
  Tone.getTransport().bpm.value = rateToBpm(tempoRate, BASE_BPM);
  tempoSlider.value = String(clamped);
  tempoReadout.textContent = `${clamped}%`;
}

tempoSlider.addEventListener("input", () => {
  applyTempo(Number(tempoSlider.value));
});

// Click (or keyboard-activate) the readout to snap back to score speed.
tempoReadout.addEventListener("click", () => {
  applyTempo(TEMPO_DEFAULT_PERCENT);
});

applyTempo(Number(tempoSlider.value));

const NAME_LABELS: Record<LabelMode, string> = {
  solfege: "Names: Solfege",
  letters: "Names: Letters",
  off: "Names: Off",
};
const NAME_CYCLE: Record<LabelMode, LabelMode> = {
  solfege: "letters",
  letters: "off",
  off: "solfege",
};

function applyLabelMode(mode: LabelMode): void {
  visualizer.setLabelMode(mode);
  // Swap only the label span so the inline eye icon survives.
  if (namesLabel) namesLabel.textContent = NAME_LABELS[mode];
  // Rebuild the sheet overlay to match (no-op until a score is rendered).
  renderSheetLabels(osmd, sheetContainer, mode);
}

// localStorage can throw (Safari Private Browsing, sandboxed iframes, blocked
// site data); never let a persistence failure abort app startup.
function initLabelMode(): LabelMode {
  try {
    const stored = localStorage.getItem("pianoHelper.noteNames");
    return stored === "letters" || stored === "off" ? stored : "solfege";
  } catch {
    return "solfege";
  }
}

let labelMode = initLabelMode();
applyLabelMode(labelMode);

// Begin loading the sampled piano in the background. Does not block render or play.
startSamplerLoad();

// Per-hand mute toggles (issue #37): flip the hand's mute flag and reflect it in
// aria-pressed (true = muted). The flag is read fresh by the Part callback, so no rebuild.
muteRightBtn.addEventListener("click", () => {
  handMuted.right = !handMuted.right;
  reflectHandMute(muteRightBtn, handMuted.right);
  visualizer.setMutedHands(handMuted);
});
muteLeftBtn.addEventListener("click", () => {
  handMuted.left = !handMuted.left;
  reflectHandMute(muteLeftBtn, handMuted.left);
  visualizer.setMutedHands(handMuted);
});

// Hand balance slider (issue #70): update the live balance and readout on input. The Part
// callback reads handBalance fresh, so the new split applies from the next onset with no
// rebuild. The readout button resets to even.
balanceSlider.addEventListener("input", () => {
  handBalance = Number(balanceSlider.value);
  reflectBalance();
});
balanceReadout.addEventListener("click", () => {
  handBalance = BALANCE_DEFAULT;
  balanceSlider.value = String(BALANCE_DEFAULT);
  reflectBalance();
});

// Inline sheet rename (issue #44): the name button opens the edit field; Enter commits,
// Escape cancels, and blur commits (so clicking away keeps the typed name). Editing is only
// reachable once a score is loaded (the button is hidden before that).
sheetNameBtn.addEventListener("click", () => enterNameEdit());
sheetNameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    commitNameEdit();
  } else if (e.key === "Escape") {
    e.preventDefault();
    cancelNameEdit();
  }
});
sheetNameInput.addEventListener("blur", () => commitNameEdit());

namesBtn.addEventListener("click", () => {
  labelMode = NAME_CYCLE[labelMode];
  try {
    localStorage.setItem("pianoHelper.noteNames", labelMode);
  } catch {
    // Persistence is best-effort; the toggle still works for this session.
  }
  applyLabelMode(labelMode);
});

// Smart Edit Mode toggle (P1): flip the dual-surface editor. Entering lazy-loads Verovio, builds
// the source-of-truth model, and engraves it; leaving restores the OSMD view. Disabled for audio
// scores (no MusicXML to engrave).
editBtn.addEventListener("click", () => {
  // COMMIT v1: toggling edit OFF prompts when there are unsaved edits (requestExitEditMode); a
  // clean session exits silently. The explicit Save/Discard buttons are the primary commit path.
  if (editMode) requestExitEditMode();
  else enterEditMode();
});

// Undo / redo buttons (Smart Edit P1).
undoBtn.addEventListener("click", () => doUndo());
redoBtn.addEventListener("click", () => doRedo());

// COMMIT v1: Save commits the edited model back to the source; Discard reverts the player to the
// pre-edit score. Both leave edit mode and are enabled only when there are unsaved edits.
editSaveBtn.addEventListener("click", () => saveEdits());
editDiscardBtn.addEventListener("click", () => discardEdits());

// ----- STAFF surface: click to select + vertical drag to change pitch (diatonic) -----
//
// Click a notehead to select it; press-and-drag a notehead vertically to change its pitch,
// snapping in diatonic steps as the pointer moves, committing one coalesced edit on release.
// Delegated on the persistent #sheet container so it survives re-renders.
sheetContainer.addEventListener("pointerdown", (e) => {
  if (!editMode || playing) return;
  if (!e.isPrimary) return; // ignore secondary touch points entirely
  const target = e.target as Element | null;
  // A notehead is small, so accept a DIRECT hit on g.note OR the nearest notehead within a >=24px
  // padded hot zone (parity with the rest tap target, #33/#84). The direct hit is the fast path;
  // the padded fallback makes tapping reliable when a notehead is only a few px wide.
  const directNote = target?.closest("g.note") as SVGGElement | null;
  const noteG = directNote?.id ? directNote : nearestNoteGWithinPadding(e.clientX, e.clientY);
  if (noteG && noteG.id) {
    // Resolve the notehead to its model handle FIRST; only select + start a drag if it maps to a
    // real editable note (a tie continuation maps to no handle, so we do nothing rather than drag
    // a stale prior selection).
    const visIndex = verovioRender?.idToVisIndex.get(noteG.id);
    const handle = visIndex === undefined ? undefined : visIndexToHandle.get(visIndex);
    if (handle === undefined) return;
    selectHandle(handle);
    // A plain primary left click selects (above) and arms a drag; right-click / touch only select.
    if (shouldStartPitchDrag(e)) beginStaffDrag(noteG, handle, e);
    return;
  }
  // No notehead (direct or padded): try a REST (ADD-a-note v1). A rest glyph is small, so accept a
  // DIRECT hit OR the nearest rest within the same >=24px padded hot zone the notehead uses (#33/
  // #84). Noteheads are resolved first, so a tap near both a note and a rest selects the note.
  // Selecting a rest needs only a primary press (no drag); the same primary-button gate as notes
  // applies via e.isPrimary above (a rest has no drag, so shouldStartPitchDrag is not consulted).
  const directRest = target?.closest("g.rest") as SVGGElement | null;
  const restG = directRest?.id ? directRest : nearestRestGWithinPadding(e.clientX, e.clientY);
  if (restG && restG.id) {
    const restId = idToRestIndex.get(restG.id);
    if (restId === undefined) return; // a rest with no model mapping (defensive); no-op
    selectRest(restId);
    // Stash the click height + glyph AFTER selectRest (which clears it) so a following "Add a note"
    // button press fills at the CLICKED staff line/space (ADD-2 mouse default).
    lastRestPointer = { restId, clientY: e.clientY, glyph: restG };
    return;
  }
  if (target?.closest("#verovio-host")) {
    // A click on the staff but not on a notehead or rest clears the selection.
    selectedHandle = null;
    selectedRest = null;
    reflectSharedSelection("Selection cleared.");
  }
});

// Padding (px each side) that inflates a glyph's box into a finger-sized hot zone: a notehead or a
// rest glyph is only ~10px, so a >=24px-wider zone makes a near-miss tap still select it. 12px each
// side => a 24px-wider zone than the glyph itself.
const GLYPH_HIT_PADDING = 12;

// The mapped `<g>` (matching `selector`, with a model mapping per `isMapped`) whose padded box is
// nearest the client point, or null. Reads each candidate's screen box and defers the geometry to
// the pure nearestPaddedBoxIndex; only consulted when a direct hit on the glyph missed. Shared by
// the notehead and rest hit tests so the two padded-target idioms stay identical.
function nearestMappedGWithinPadding(
  selector: string,
  isMapped: (id: string) => boolean,
  clientX: number,
  clientY: number,
): SVGGElement | null {
  if (!verovioHost) return null;
  const els: SVGGElement[] = [];
  const boxes: PaddedBox[] = [];
  for (const el of verovioHost.querySelectorAll<SVGGElement>(selector)) {
    if (!el.id || !isMapped(el.id)) continue;
    const b = el.getBoundingClientRect();
    boxes.push({ index: els.length, left: b.left, right: b.right, top: b.top, bottom: b.bottom });
    els.push(el);
  }
  const idx = nearestPaddedBoxIndex(boxes, clientX, clientY, GLYPH_HIT_PADDING);
  return idx === null ? null : els[idx];
}

// The nearest selectable notehead within the padded hot zone (a notehead maps to a handle via its
// idToVisIndex -> visIndexToHandle; a tie continuation does not and is skipped so it never wins).
function nearestNoteGWithinPadding(clientX: number, clientY: number): SVGGElement | null {
  return nearestMappedGWithinPadding(
    "g.note",
    (id) => {
      const visIndex = verovioRender?.idToVisIndex.get(id);
      return visIndex !== undefined && visIndexToHandle.has(visIndex);
    },
    clientX,
    clientY,
  );
}

// The nearest selectable rest within the padded hot zone (a rest maps to a model rest via
// idToRestIndex). Only consulted when a direct hit on g.rest missed.
function nearestRestGWithinPadding(clientX: number, clientY: number): SVGGElement | null {
  return nearestMappedGWithinPadding(
    "g.rest",
    (id) => idToRestIndex.get(id) !== undefined,
    clientX,
    clientY,
  );
}

// ----- CANVAS surface: click to select + HORIZONTAL drag to change pitch (chromatic) -----
//
// On the falling-notes canvas pitch is the HORIZONTAL axis (key columns) and time is vertical, so
// dragging a bar SIDEWAYS to another key column is the chromatic pitch edit; vertical movement
// (time) is ignored. (The Designer spec describes a horizontal piano-roll where pitch is vertical;
// this app's falling view is vertical, so the pitch axis is horizontal here.) Convert the click to
// canvas-local px and hit-test against the current playhead so the rectangle matches what is seen.
canvas.addEventListener("pointerdown", (e) => {
  if (!score || !editMode || playing) return;
  if (!e.isPrimary) return; // ignore secondary touch points entirely
  const rect = canvas.getBoundingClientRect();
  const px = e.clientX - rect.left;
  const py = e.clientY - rect.top;
  const scoreTime = Tone.getTransport().seconds * tempoRate;
  const hit = visualizer.hitTest(px, py, scoreTime);
  if (hit === null) {
    selectedHandle = null;
    selectedRest = null;
    lastRestPointer = null;
    reflectSharedSelection("Selection cleared.");
    return;
  }
  const handle = visIndexToHandle.get(hit);
  if (handle === undefined) return; // a bar with no model handle (defensive); just no-op the drag
  selectHandle(handle);
  // A plain primary left click selects (above) and arms a drag; right-click / touch only select.
  if (shouldStartPitchDrag(e)) beginCanvasDrag(handle, e);
});

// Edit cluster buttons (Smart Edit P1): act on the ONE shared selection. Pitch up/down on the
// cluster are DIATONIC (the staff's native unit, the discoverable mirror of the staff arrows).
pitchUpBtn.addEventListener("click", () => staffPitchStep("diatonic", 1));
pitchDownBtn.addEventListener("click", () => staffPitchStep("diatonic", -1));
// Duration steppers (Smart Edit P3 v1): walk the value ladder one notch. Disabled at the ladder
// ends (reflectDurationButtons), so a click only ever fires for a legal step.
durShorterBtn.addEventListener("click", () => changeDurationEdit("shorter"));
durLongerBtn.addEventListener("click", () => changeDurationEdit("longer"));
// Dot TOGGLE (DOTTED v1): add a dot on a plain note, remove it on a dotted one. Disabled
// (reflectDurationButtons) only when a plain note has no room for the added half, so a click only
// ever fires for a legal toggle.
durDotBtn.addEventListener("click", () => dotSelectedNote());
// Trash button: delete the shared-selected note (model-level, fixed-bar, undoable).
deleteNoteBtn.addEventListener("click", () => deleteSelectedNote());
// "Add a note" button (ADD-a-note v1): fill the selected rest. A button press following a MOUSE
// selection of THIS rest uses the clicked staff height (ADD-2 mouse default); otherwise (a
// keyboard selection, or the click context is stale) it uses the previous-note default.
addNoteBtn.addEventListener("click", () => addNoteFromButton());

// Fill the selected rest from the Add button: prefer the stashed mouse click height when it
// matches the current rest selection, else the keyboard (previous-note) default.
function addNoteFromButton(): void {
  if (selectedRest === null) return;
  if (lastRestPointer && lastRestPointer.restId === selectedRest) {
    addSelectedRest(
      mouseDefaultPitchForRest(selectedRest, lastRestPointer.glyph, lastRestPointer.clientY),
    );
  } else {
    addSelectedRestFromKeyboard();
  }
}

// Whether an element is a form field, so editing shortcuts never steal typing (the rename input).
function isFormFieldTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  const tag = el?.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || !!el?.isContentEditable;
}

// Unified edit-mode keyboard handler (Smart Edit P1). Routes by which SURFACE has focus so the
// two idioms coexist: on the STAFF, Up/Down = diatonic pitch (Ctrl = chromatic, Shift = octave),
// Left/Right = selection step; on the CANVAS, +/- = chromatic pitch (Shift = octave), Up/Down =
// selection step. The +/- pitch pair also works as a staff alias. Undo/redo are global to edit
// mode (active even with no selection). Ignored while a form field is focused.
window.addEventListener("keydown", (e) => {
  if (!score || busy || !editMode) return;
  if (isFormFieldTarget(e.target)) return;
  const ctrl = e.ctrlKey || e.metaKey;

  // Undo / redo first (not gated on a selection). Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z, Ctrl/Cmd+Y.
  if (ctrl && (e.key === "z" || e.key === "Z")) {
    e.preventDefault();
    if (e.shiftKey) doRedo();
    else doUndo();
    return;
  }
  if (ctrl && (e.key === "y" || e.key === "Y")) {
    e.preventDefault();
    doRedo();
    return;
  }

  // Is the canvas the focused (active) surface? If so, its idiom applies; otherwise the staff's.
  const onCanvas = document.activeElement === canvas;

  if (e.key === "ArrowUp") {
    e.preventDefault();
    if (onCanvas) moveCanvasSelection(1);
    else staffPitchStep(ctrl ? "chromatic" : e.shiftKey ? "octave" : "diatonic", 1);
    return;
  }
  if (e.key === "ArrowDown") {
    e.preventDefault();
    if (onCanvas) moveCanvasSelection(-1);
    else staffPitchStep(ctrl ? "chromatic" : e.shiftKey ? "octave" : "diatonic", -1);
    return;
  }
  if (e.key === "ArrowRight") {
    e.preventDefault();
    moveStaffSelection(1); // staff selection step (the canvas owns Up/Down for selection)
    return;
  }
  if (e.key === "ArrowLeft") {
    e.preventDefault();
    moveStaffSelection(-1);
    return;
  }

  // Enter (or N as a one-shot alias, NOT a mode toggle) fills the SELECTED REST with a note at the
  // keyboard default pitch (the previous note's pitch), then selects the new note so Up/Down
  // immediately adjusts it (ADD-3). Handled before the selectedHandle guard since a rest selection
  // has selectedHandle === null. A no-op when nothing (or a note) is selected.
  if (e.key === "Enter" || e.key === "n" || e.key === "N") {
    if (selectedRest !== null) {
      e.preventDefault();
      addSelectedRestFromKeyboard();
    }
    return;
  }

  // Comma / period change the selected NOTE's duration on BOTH surfaces (Smart Edit P3 v1): comma =
  // shorter, period = longer. preventDefault so the keys never type into the page; a no-op on a rest
  // selection (selectedHandle is null then) and announced once via changeDurationEdit. Handled
  // before the selectedHandle guard so the preventDefault still fires on a rest (a clean no-op).
  if (e.key === "," || e.key === ".") {
    e.preventDefault();
    if (selectedHandle !== null) changeDurationEdit(e.key === "," ? "shorter" : "longer");
    return;
  }

  // Semicolon toggles the DOT on the selected NOTE on BOTH surfaces (DOTTED v1): add on a plain note,
  // remove on a dotted one. preventDefault so it never types into the page; a no-op on a rest
  // selection (selectedHandle is null then). Handled before the selectedHandle guard so preventDefault
  // still fires on a rest (a clean no-op), exactly like comma/period.
  if (e.key === ";") {
    e.preventDefault();
    if (selectedHandle !== null) dotSelectedNote();
    return;
  }

  if (selectedHandle === null) return; // the remaining keys need a selected note

  // Delete / Backspace: remove the selected note (model-level, fixed-bar, undoable). Works from
  // either surface since it acts on the one shared selection.
  if (e.key === "Delete" || e.key === "Backspace") {
    e.preventDefault();
    deleteSelectedNote();
    return;
  }

  if (e.key === "+" || e.key === "=") {
    e.preventDefault();
    // +/- are the CANVAS's chromatic pitch pair, and a staff alias. Shift = octave.
    canvasPitchStep(e.shiftKey, 1);
  } else if (e.key === "-" || e.key === "_") {
    e.preventDefault();
    canvasPitchStep(e.shiftKey, -1);
  }
});

// ----- Drag mechanics (shared by both surfaces) -----

// Start a STAFF pitch drag on `noteG`. Records the pre-drag pitch + a per-step pixel sensitivity
// from the notehead's height (a notehead is ~one interline; a diatonic step is half an interline),
// dims the canvas mirror, and captures the pointer so a drag that leaves the SVG still tracks.
function beginStaffDrag(noteG: SVGGElement, handleId: number, e: PointerEvent): void {
  if (!scoreModel) return;
  const h = scoreModel.handles[handleId];
  if (!h) return;
  const bbox = noteG.getBoundingClientRect();
  const pxPerStep = Math.max(4, (bbox.height || 16) / 2);
  drag = {
    surface: "staff",
    handleId,
    beforePitch: h.pitch,
    startClientX: e.clientX,
    startClientY: e.clientY,
    startMidi: h.midi,
    pxPerStep,
    lastPreviewMidi: h.midi,
    moved: false,
  };
  // The canvas is the stale mirror during a staff drag: dim its selected bar.
  visualizer.setMirrorDeemphasis(selectedVisIndex());
  try {
    (e.target as Element).setPointerCapture?.(e.pointerId);
  } catch {
    // Pointer capture is best-effort; the window-level move/up listeners still track the drag.
  }
}

// Start a CANVAS pitch drag. Records the pre-drag pitch and dims the staff mirror notehead.
function beginCanvasDrag(handleId: number, e: PointerEvent): void {
  if (!scoreModel) return;
  const h = scoreModel.handles[handleId];
  if (!h) return;
  drag = {
    surface: "canvas",
    handleId,
    beforePitch: h.pitch,
    startClientX: e.clientX,
    startClientY: e.clientY,
    startMidi: h.midi,
    pxPerStep: 0,
    lastPreviewMidi: h.midi,
    moved: false,
  };
  // The staff is the stale mirror during a canvas drag: dim its selected notehead.
  staffNoteEl(selectedStaffId() ?? "")?.classList.add("ph-mirror");
  try {
    canvas.setPointerCapture?.(e.pointerId);
  } catch {
    // best-effort
  }
}

// Pointer move during a drag: compute the previewed pitch from the pointer delta and, if it
// changed, preview ONLY the active surface (the staff re-engraves at the snapped diatonic step;
// the canvas draws the bar at the key under the pointer). The mirror + audio are NOT updated
// mid-drag (Designer P1-3). The model IS mutated for the staff preview (so it re-engraves); the
// net edit is recorded as one command on release.
window.addEventListener("pointermove", (e) => {
  if (!drag || !scoreModel) return;
  if (drag.surface === "staff") {
    const steps = Math.round((drag.startClientY - e.clientY) / drag.pxPerStep); // up = +steps
    let preview = drag.beforePitch;
    const fifths = scoreModel.fifthsForHandle(drag.handleId);
    for (let s = 0; s < Math.abs(steps); s++) {
      preview = diatonicStep(preview, steps > 0 ? 1 : -1, fifths);
    }
    const previewMidi = midiFromPitch(preview);
    if (previewMidi !== drag.lastPreviewMidi) {
      drag.lastPreviewMidi = previewMidi;
      drag.moved = true;
      // Re-engrave the staff at the previewed pitch (single-digit ms). Mutate the model directly
      // (NOT through the command stack); the one command is recorded on release.
      scoreModel.setPitch(drag.handleId, preview);
      renderVerovioPreview(drag.handleId);
    }
  } else {
    // Canvas: pitch is the horizontal axis. Snap to the key column under the pointer.
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const targetMidi = visualizer.midiAtX(px);
    if (targetMidi !== null && targetMidi !== drag.lastPreviewMidi) {
      drag.lastPreviewMidi = targetMidi;
      drag.moved = true;
      const visIndex = handleToVisIndex.get(drag.handleId);
      if (visIndex !== undefined) {
        visualizer.setDragPreview({ index: visIndex, previewMidi: targetMidi });
      }
    }
  }
});

// Pointer up: commit the drag as ONE coalesced command (before -> final pitch) and do the full
// re-render / re-derive, or just clean up if the pointer never moved (a plain click-select).
window.addEventListener("pointerup", () => {
  if (!drag) return;
  const d = drag;
  drag = null;
  visualizer.setMirrorDeemphasis(null);
  visualizer.setDragPreview(null);
  clearStaffMirror();
  if (!d.moved || !scoreModel || !commandStack) {
    // No movement: the model was never changed; leave the selection as the click set it.
    return;
  }
  // Determine the final pitch. Staff: the model already holds the previewed pitch. Canvas: derive
  // the final pitch from the snapped key column (re-spell from MIDI), since the canvas only
  // previewed (the model was not mutated mid-canvas-drag).
  let finalPitch: ModelPitch;
  if (d.surface === "staff") {
    finalPitch = scoreModel.handles[d.handleId]?.pitch ?? d.beforePitch;
    // Roll the model back to the pre-drag pitch so the command's apply is the single source of
    // the change (keeps the model state and the command in lockstep; pushApplied would also work
    // but this keeps one apply path).
    scoreModel.setPitch(d.handleId, d.beforePitch);
  } else {
    finalPitch = pitchFromMidi(d.lastPreviewMidi, d.lastPreviewMidi >= d.startMidi ? 1 : -1);
  }
  if (midiFromPitch(finalPitch) === midiFromPitch(d.beforePitch)) {
    // Net zero change (dragged back to start): nothing to commit, but re-engrave to clear any
    // mid-drag preview state on the staff.
    if (d.surface === "staff") renderVerovio();
    return;
  }
  selectedHandle = d.handleId;
  const fromLabel = pitchLabel(midiFromPitch(d.beforePitch), spellingFromPitch(d.beforePitch));
  commandStack.push({ kind: "setPitch", handleId: d.handleId, before: d.beforePitch, after: finalPitch });
  const verb = verticalVerb(midiFromPitch(d.beforePitch), midiFromPitch(finalPitch));
  const toLabel = pitchLabel(midiFromPitch(finalPitch), spellingFromPitch(finalPitch));
  finishEdit(`${fromLabel} ${verb} ${toLabel}`);
});

// Abandon an in-flight drag without committing (used when Play/Export interrupts editing): roll
// the model back to the pre-drag pitch and clear all preview state.
function cancelDrag(): void {
  if (!drag) return;
  const d = drag;
  drag = null;
  if (d.surface === "staff" && scoreModel) {
    scoreModel.setPitch(d.handleId, d.beforePitch);
    if (editMode) renderVerovio();
  }
  visualizer.setMirrorDeemphasis(null);
  visualizer.setDragPreview(null);
  clearStaffMirror();
}

// Re-engrave the staff during a drag preview and re-apply the brass halo to the DRAGGED note by
// finding it at its (onset, previewed-midi). The id may change across re-renders, so we re-find
// it from the new render's notes rather than trusting the old id.
function renderVerovioPreview(handleId: number): void {
  if (!verovioToolkit || !scoreModel || !score) return;
  const width = sheetContainer.clientWidth || 800;
  verovioRender = renderMusicXml(verovioToolkit, scoreModel.serialize(), score.notes, width);
  if (verovioHost) verovioHost.innerHTML = verovioRender.svg;
  // Highlight the dragged notehead: find the rendered note matching the handle's onset + midi.
  const h = scoreModel.handles[handleId];
  if (h && verovioHost) {
    const match = verovioRender.notes.find(
      (n) => n.midi === h.midi && Math.abs(n.timeSec - h.onsetSec) < 0.002,
    );
    if (match) staffNoteEl(match.id)?.classList.add("ph-selected");
  }
}

// Remove the staff mirror-dim class from any notehead carrying it.
function clearStaffMirror(): void {
  if (!verovioHost) return;
  for (const el of verovioHost.querySelectorAll(".ph-mirror")) el.classList.remove("ph-mirror");
}

function frame(): void {
  // Derive a bpm-independent score time from the transport so the falling notes and the
  // cursor stay in sync with the audio at any tempo (see tempo notes above). The audio
  // itself is sped up via the transport bpm, not this value.
  const scoreTime = Tone.getTransport().seconds * tempoRate;
  if (playing && score && scoreTime >= score.duration) {
    rewind();
  } else if (playing) {
    syncCursor(scoreTime);
    updateSeekUI(scoreTime);
  }
  visualizer.render(scoreTime);
  // Smart Edit Mode: mirror the playhead onto the Verovio staff via the timemap. Cheap (only
  // touches the DOM when the sounding set changes) and skipped entirely when edit mode is off.
  if (editMode) updateVerovioPlayhead(scoreTime);
  requestAnimationFrame(frame);
}

// Recompute overlay label positions after a resize settles. OSMD autoResize
// re-renders the SVG (moving noteheads), so the overlay must be rebuilt off the
// new geometry. Debounced so a drag-resize does not rebuild every pixel.
let resizeTimer: ReturnType<typeof setTimeout> | undefined;
window.addEventListener("resize", () => {
  if (resizeTimer !== undefined) clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    renderSheetLabels(osmd, sheetContainer, labelMode);
    // Re-engrave the Verovio staff at the new width so it is not clipped (it preserves the
    // current selection by id). Cheap re-render; only runs while edit mode is active.
    if (editMode) renderVerovio();
  }, 150);
});

requestAnimationFrame(frame);
