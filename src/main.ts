import "./style.css";
import * as Tone from "tone";
import { OpenSheetMusicDisplay } from "opensheetmusicdisplay";
import { Visualizer } from "./visualizer";
import { extractScore, type ScoreData } from "./score";

const canvas = document.getElementById("stage") as HTMLCanvasElement;
const fileInput = document.getElementById("file-input") as HTMLInputElement;
const playBtn = document.getElementById("play-btn") as HTMLButtonElement;
const trackName = document.getElementById("track-name") as HTMLSpanElement;

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

async function loadScoreFile(file: File): Promise<void> {
  const xml = await file.text();
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
  trackName.textContent = `${file.name} (${score.notes.length} notes)`;
  playBtn.disabled = false;
  setPlaying(false);
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

playBtn.addEventListener("click", () => togglePlay());

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
