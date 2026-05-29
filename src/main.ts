import "./style.css";
import * as Tone from "tone";
import { Midi } from "@tonejs/midi";
import { Visualizer, type VisNote } from "./visualizer";

const canvas = document.getElementById("stage") as HTMLCanvasElement;
const fileInput = document.getElementById("file-input") as HTMLInputElement;
const playBtn = document.getElementById("play-btn") as HTMLButtonElement;
const trackName = document.getElementById("track-name") as HTMLSpanElement;

const visualizer = new Visualizer(canvas);

let synth: Tone.PolySynth | null = null;
let part: Tone.Part | null = null;
let songEnd = 0;
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

async function loadMidiFile(file: File): Promise<void> {
  const buffer = await file.arrayBuffer();
  const midi = new Midi(buffer);

  const notes: VisNote[] = [];
  const transport = Tone.getTransport();
  transport.stop();
  transport.position = 0;
  part?.dispose();

  const scheduled: { time: number; midi: number; duration: number; velocity: number }[] = [];
  for (const track of midi.tracks) {
    for (const note of track.notes) {
      notes.push({ midi: note.midi, time: note.time, duration: note.duration });
      scheduled.push({
        time: note.time,
        midi: note.midi,
        duration: note.duration,
        velocity: note.velocity,
      });
    }
  }

  songEnd = midi.duration;
  visualizer.setNotes(notes);

  const instrument = ensureSynth();
  part = new Tone.Part((time, value) => {
    instrument.triggerAttackRelease(
      Tone.Frequency(value.midi, "midi").toFrequency(),
      value.duration,
      time,
      value.velocity,
    );
  }, scheduled);
  part.start(0);

  trackName.textContent = `${file.name} (${notes.length} notes)`;
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

fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (file) loadMidiFile(file).catch((err) => alert(`Failed to load MIDI: ${err.message}`));
});

playBtn.addEventListener("click", () => togglePlay());

function frame(): void {
  const current = Tone.getTransport().seconds;
  if (playing && songEnd > 0 && current >= songEnd) {
    const transport = Tone.getTransport();
    transport.stop();
    transport.position = 0;
    setPlaying(false);
  }
  visualizer.render(Tone.getTransport().seconds);
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
