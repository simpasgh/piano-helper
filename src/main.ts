import "./style.css";
import * as Tone from "tone";
import { OpenSheetMusicDisplay } from "opensheetmusicdisplay";
import { Visualizer } from "./visualizer";
import { extractScore, type ScoreData } from "./score";
import { submitOmr, pollOmrResult } from "./omr";
import { chooseVideoFormat, buildExportFilename } from "./recorder";
import {
  uniqueOnsets,
  nextOnset,
  prevOnset,
  scoreTimeToSeek,
  seekToScoreTime,
  formatClock,
} from "./playback";
import { buildSalamanderSampleMap, SALAMANDER_BASE_URL } from "./sampler";
import { renderSheetLabels } from "./sheet-overlay";
import {
  tempoPercentToRate,
  rateToBpm,
  clampTempoPercent,
  TEMPO_DEFAULT_PERCENT,
} from "./tempo";
import type { LabelMode } from "./piano";

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
const tempoSlider = document.getElementById("tempo-slider") as HTMLInputElement;
const tempoReadout = document.getElementById("tempo-readout") as HTMLButtonElement;
const sheetContainer = document.getElementById("sheet") as HTMLDivElement;
const trackName = document.getElementById("track-name") as HTMLSpanElement;
const soundStatus = document.getElementById("sound-status") as HTMLSpanElement;

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
// `sheet` records whether a sheet/cursor is active so rewind/sync can skip cursor work.
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
    // Resolve the instrument per note so playback upgrades to the sampler as soon as it
    // loads. Timing/scheduling is unchanged: only the sound source differs.
    getInstrument().triggerAttackRelease(
      Tone.Frequency(note.midi, "midi").toFrequency(),
      note.duration,
      time,
    );
  }, score.notes.map((n) => ({ time: n.time, midi: n.midi, duration: n.duration })));
  part.start(0);

  // Apply the current tempo now that the Part is built at BASE_BPM.
  transport.bpm.value = rateToBpm(tempoRate, BASE_BPM);

  stepIndex = 0;
  onsets = uniqueOnsets(score.notes);
  trackName.textContent = `${name} (${score.notes.length} notes)`;
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

  loadNotes(extractScore(osmd), name, true);
}

// Transcribe an uploaded audio file (issue #19) into falling notes. There is no sheet
// view for audio yet, so we clear any previously rendered sheet and its overlay and run
// the player in cursor-less mode.
async function loadAudioFile(file: File): Promise<void> {
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
    trackName.textContent = `Transcribing audio... ${Math.round(fraction * 100)}%`;
  });
  const duration = notes.reduce((max, n) => Math.max(max, n.time + n.duration), 0);
  loadNotes({ notes, stepTimes: [], duration }, file.name, false);
}

function setPlaying(value: boolean): void {
  playing = value;
  playBtn.textContent = value ? "Pause" : "Play";
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
  }
}

async function scanSheet(file: File): Promise<void> {
  setBusyUI(true);
  trackName.textContent = "Scanning sheet... (this can take a minute)";
  try {
    const jobId = await submitOmr(file);
    const xml = await pollOmrResult(jobId);
    await loadScoreXml(xml, file.name);
  } finally {
    setBusyUI(false);
  }
}

scanInput.addEventListener("change", () => {
  if (busy) return;
  const file = scanInput.files?.[0];
  if (!file) return;
  scanSheet(file).catch((err) => {
    console.error("Scan failed:", err);
    trackName.textContent = "Scan failed.";
    alert(`Scan failed: ${err.message}`);
  });
  // Allow re-selecting the same file to retry.
  scanInput.value = "";
});

async function transcribeAudio(file: File): Promise<void> {
  setBusyUI(true);
  trackName.textContent = "Transcribing audio... (this can take a minute)";
  try {
    await loadAudioFile(file);
  } finally {
    setBusyUI(false);
  }
}

audioInput.addEventListener("change", () => {
  if (busy) return;
  const file = audioInput.files?.[0];
  if (!file) return;
  transcribeAudio(file).catch((err) => {
    console.error("Transcription failed:", err);
    trackName.textContent = "Transcription failed.";
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

  const labelBeforeExport = trackName.textContent ?? "performance";
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
    trackName.textContent = "Recording video...";

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
    downloadBlob(blob, buildExportFilename(labelBeforeExport, format.extension));
  } catch (err) {
    console.error("Video export failed:", err);
    alert(`Video export failed: ${(err as Error).message}`);
  } finally {
    if (streamDest) Tone.getDestination().disconnect(streamDest);
    canvasStream?.getTracks().forEach((t) => t.stop());
    trackName.textContent = labelBeforeExport;
    setBusyUI(false);
    playBtn.disabled = !score;
    exportBtn.disabled = !score;
    setTransportControlsEnabled(!!score);
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
  namesBtn.textContent = NAME_LABELS[mode];
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
