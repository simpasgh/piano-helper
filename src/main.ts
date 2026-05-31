import "./style.css";
import * as Tone from "tone";
import { OpenSheetMusicDisplay } from "opensheetmusicdisplay";
import { Visualizer } from "./visualizer";
import { extractScore, type ScoreData } from "./score";
import { submitOmr, pollOmrResult, isCancelled } from "./omr";
import {
  scanOverlayTitle,
  shouldApplyResult,
  type ScanOverlayKind,
} from "./scan-overlay";
import { chooseVideoFormat, buildExportFilename } from "./recorder";
import {
  hasBothHands,
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

const canvas = document.getElementById("stage") as HTMLCanvasElement;
const fileInput = document.getElementById("file-input") as HTMLInputElement;
const scanInput = document.getElementById("scan-input") as HTMLInputElement;
const audioInput = document.getElementById("audio-input") as HTMLInputElement;
const playBtn = document.getElementById("play-btn") as HTMLButtonElement;
const prevNoteBtn = document.getElementById("prev-note-btn") as HTMLButtonElement;
const nextNoteBtn = document.getElementById("next-note-btn") as HTMLButtonElement;
const seekSlider = document.getElementById("seek-slider") as HTMLInputElement;
const timeReadout = document.getElementById("time-readout") as HTMLSpanElement;
const exportBtn = document.getElementById("export-btn") as HTMLButtonElement;
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

  part = new Tone.Part((time, note) => {
    // Skip the trigger when this note's hand is muted (issue #37). The flag is read fresh
    // each callback, so a mute toggle takes effect from the next onset with no Part rebuild.
    // A skipped trigger has no side effects, so the export/instrument paths are unaffected.
    if (note.hand === "left" && handMuted.left) return;
    if (note.hand === "right" && handMuted.right) return;
    // Per-hand balance (issue #70): scale this note's velocity by its hand's gain. Read
    // fresh each callback so slider drags apply from the next onset. "unknown" notes are
    // unaffected (full velocity).
    const gains = handGains(handBalance);
    const velocity =
      note.hand === "left" ? gains.left : note.hand === "right" ? gains.right : 1;
    // Resolve the instrument per note so playback upgrades to the sampler as soon as it
    // loads. Timing/scheduling is unchanged: only the sound source differs.
    getInstrument().triggerAttackRelease(
      Tone.Frequency(note.midi, "midi").toFrequency(),
      note.duration,
      time,
      velocity,
    );
  }, score.notes.map((n) => ({ time: n.time, midi: n.midi, duration: n.duration, hand: n.hand })));
  part.start(0);

  // Apply the current tempo now that the Part is built at BASE_BPM.
  transport.bpm.value = rateToBpm(tempoRate, BASE_BPM);

  // Per-hand mute toggles (issue #37): shown only when the score has both a right- and a
  // left-hand note set. Grand-staff sheets split by clef; audio-derived scores split by pitch
  // (issue #70 follow-up), so a two-handed clip now shows the controls and a single-register
  // one stays hidden. Reset on every load so a previously muted hand does not carry over.
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
  handMutes.hidden = !hasBothHands(score.notes);

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
  exportBtn.disabled = false;
  setTransportControlsEnabled(true);
  updateSeekUI(0);
  setPlaying(false);
}

// Load MusicXML into OSMD and rebuild the pipeline. Shared by the direct MusicXML file
// path and the OMR scan result path.
async function loadScoreXml(xml: string, name: string): Promise<void> {
  await osmd.load(xml);
  osmd.render();
  osmd.cursor.reset();
  osmd.cursor.show();
  // Rebuild the note-name overlay against the freshly rendered noteheads.
  renderSheetLabels(osmd, sheetContainer, labelMode);

  // Issue #44: default the sheet name to the MusicXML title when present, else the file name.
  // `osmd.Sheet.TitleString` is the parsed work title; guard defensively in case a score has
  // no title metadata.
  const xmlTitle = (osmd.Sheet as { TitleString?: string } | undefined)?.TitleString ?? null;
  loadNotes(extractScore(osmd), deriveDefaultSheetName(name, xmlTitle), true);
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
  // The cursor only exists once a sheet has been loaded; it is undefined on a fresh page.
  osmd.cursor?.hide();
  try {
    osmd.clear();
  } catch {
    // Nothing was rendered yet; clearing is a no-op.
  }
  renderSheetLabels(osmd, sheetContainer, labelMode); // empties the overlay too

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
    exportBtn.disabled = true;
    setTransportControlsEnabled(false);
  } else {
    // Restore play/export/transport to match whether a score is loaded (issue #86 cancel
    // fix). On the cancel/abandon path loadNotes never runs, so without this a previously
    // loaded score would be left with its controls stuck disabled. Enable only when a score
    // exists, matching the post-load and post-export enable conditions.
    const enabled = controlsEnabledForScore(!!score);
    playBtn.disabled = !enabled;
    exportBtn.disabled = !enabled;
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
  showStatus("Scanning sheet... (this can take a minute)");
  try {
    const jobId = await submitOmr(file);
    const xml = await pollOmrResult(jobId, {
      isCancelledRequested: () => cancelRequested,
    });
    await loadScoreXml(xml, file.name);
  } finally {
    // Only tear down if this is still the active job. A cancel re-enables the controls and
    // hides the overlay synchronously and may have started a newer job; a late settle of this
    // abandoned scan must not stomp the newer job's overlay/controls (issue #93). When this is
    // still the active job the repeat is harmless: setBusyUI(false), hideScanOverlay, and
    // restoreSheetName are all idempotent.
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
    if (isFormField) return;
    e.preventDefault();
    stepNote(1);
  } else if (e.code === "ArrowLeft") {
    if (isFormField) return;
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
    // a chunk each second so a long performance does not buffer entirely in memory.
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

exportBtn.addEventListener("click", () => {
  exportVideo();
});

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
  }, 150);
});

requestAnimationFrame(frame);
