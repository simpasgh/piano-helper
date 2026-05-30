import "./style.css";
import * as Tone from "tone";
import { OpenSheetMusicDisplay } from "opensheetmusicdisplay";
import { Visualizer } from "./visualizer";
import { extractScore, type ScoreData } from "./score";
import type { LabelMode } from "./piano";
import { pollOmrResult, requestOmr, validateSheetFile } from "./omr";

const canvas = document.getElementById("stage") as HTMLCanvasElement;
const fileInput = document.getElementById("file-input") as HTMLInputElement;
const sheetInput = document.getElementById("sheet-input") as HTMLInputElement;
const playBtn = document.getElementById("play-btn") as HTMLButtonElement;
const namesBtn = document.getElementById("names-btn") as HTMLButtonElement;
const trackName = document.getElementById("track-name") as HTMLSpanElement;
const omrStatus = document.getElementById("omr-status") as HTMLSpanElement;

const visualizer = new Visualizer(canvas);
const osmd = new OpenSheetMusicDisplay("sheet", {
  autoResize: true,
  backend: "svg",
  followCursor: true,
});

let synth: Tone.PolySynth | null = null;
let part: Tone.Part | null = null;
let score: ScoreData | null = null;
let stepIndex = 0;
let playing = false;

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

async function loadMusicXml(xml: string, label: string): Promise<void> {
  await osmd.load(xml);
  osmd.render();
  osmd.cursor.reset();
  osmd.cursor.show();

  score = extractScore(osmd);

  const transport = Tone.getTransport();
  transport.stop();
  transport.position = 0;
  part?.dispose();

  visualizer.setNotes(score.notes);

  const instrument = ensureSynth();
  part = new Tone.Part((time, note) => {
    instrument.triggerAttackRelease(
      Tone.Frequency(note.midi, "midi").toFrequency(),
      note.duration,
      time,
    );
  }, score.notes.map((n) => ({ time: n.time, midi: n.midi, duration: n.duration })));
  part.start(0);

  stepIndex = 0;
  trackName.textContent = `${label} (${score.notes.length} notes)`;
  playBtn.disabled = false;
  setPlaying(false);
}

async function loadScoreFile(file: File): Promise<void> {
  const xml = await file.text();
  await loadMusicXml(xml, file.name);
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
  osmd.cursor.reset();
  osmd.cursor.show();
  setPlaying(false);
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

function setOmrStatus(text: string, isError = false): void {
  omrStatus.textContent = text;
  omrStatus.classList.toggle("error", isError);
}

async function importSheet(file: File): Promise<void> {
  const invalid = validateSheetFile(file);
  if (invalid) {
    setOmrStatus(invalid, true);
    return;
  }
  try {
    setOmrStatus("Uploading sheet...");
    const { jobId } = await requestOmr(file);
    setOmrStatus("Converting (this can take a few minutes)...");
    const xml = await pollOmrResult(jobId);
    setOmrStatus("Rendering score...");
    await loadMusicXml(xml, file.name);
    setOmrStatus("");
  } catch (err) {
    console.error("Sheet import failed:", err);
    setOmrStatus(`Conversion failed: ${(err as Error).message}`, true);
  }
}

sheetInput.addEventListener("change", () => {
  const file = sheetInput.files?.[0];
  if (file) {
    importSheet(file).finally(() => {
      // Allow re-importing the same file by clearing the input value.
      sheetInput.value = "";
    });
  }
});

playBtn.addEventListener("click", () => togglePlay());

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
  const currentTime = Tone.getTransport().seconds;
  if (playing && score && currentTime >= score.duration) {
    rewind();
  } else if (playing) {
    syncCursor(currentTime);
  }
  visualizer.render(Tone.getTransport().seconds);
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
