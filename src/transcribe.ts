// Audio-to-score (issue #19). Transcribe an uploaded audio file into pitched notes that
// feed the existing falling-notes player. Runs entirely client-side with Spotify's
// Basic Pitch model (Apache-2.0), so there is no server, no paid API, and nothing to host.
// We stream the ~1 MB model from the free jsDelivr CDN (same approach as the Salamander
// samples) rather than committing the weights to the repo.
import {
  BasicPitch,
  addPitchBendsToNoteEvents,
  noteFramesToTime,
  outputToNotesPoly,
  type NoteEventTime,
} from "@spotify/basic-pitch";
import { FIRST_MIDI, LAST_MIDI } from "./piano";
import type { VisNote } from "./visualizer";

// jsDelivr serves package files; TFJS resolves the weight shard relative to this URL.
const MODEL_URL =
  "https://cdn.jsdelivr.net/npm/@spotify/basic-pitch@1.0.1/model/model.json";

// Basic Pitch analyzes audio at 22050 Hz mono; we resample before inference.
const TARGET_SAMPLE_RATE = 22050;

// Note-detection thresholds. Tuned conservatively for demo-grade clarity on clean,
// mostly-monophonic piano: a higher onset threshold suppresses spurious notes, and a
// minimum length trims sub-beat blips. (frames are ~11.6 ms; 11 frames is ~128 ms.)
const ONSET_THRESHOLD = 0.5;
const FRAME_THRESHOLD = 0.3;
const MIN_NOTE_LENGTH_FRAMES = 11;

// Pure glue between Basic Pitch's note events and the player's VisNote shape. Rounds to
// the nearest MIDI integer, drops anything outside the 88-key range or with non-positive
// duration, clamps negative start times to 0, and sorts by start time. Isolated from the
// model and Web Audio so it can be unit-tested without an AudioContext.
export function noteEventsToVisNotes(events: NoteEventTime[]): VisNote[] {
  const notes: VisNote[] = [];
  for (const e of events) {
    const midi = Math.round(e.pitchMidi);
    if (midi < FIRST_MIDI || midi > LAST_MIDI) continue;
    if (!(e.durationSeconds > 0)) continue;
    notes.push({
      midi,
      time: Math.max(0, e.startTimeSeconds),
      duration: e.durationSeconds,
    });
  }
  notes.sort((a, b) => a.time - b.time);
  return notes;
}

// Decode an audio file and resample it to mono 22050 Hz. Stereo input is downmixed to
// mono automatically when a multi-channel buffer is routed to a single-channel
// destination (Web Audio downmix spec).
async function decodeToMono22050(file: File): Promise<AudioBuffer> {
  const arrayBuffer = await file.arrayBuffer();
  const AudioCtx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext })
      .webkitAudioContext;
  const decodeCtx = new AudioCtx();
  try {
    const decoded = await decodeCtx.decodeAudioData(arrayBuffer);
    const frameCount = Math.max(1, Math.ceil(decoded.duration * TARGET_SAMPLE_RATE));
    const offline = new OfflineAudioContext(1, frameCount, TARGET_SAMPLE_RATE);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start();
    return await offline.startRendering();
  } finally {
    decodeCtx.close();
  }
}

// Reused across uploads so the model weights are fetched and compiled only once.
let basicPitch: BasicPitch | null = null;

// Transcribe an uploaded audio file into VisNotes. onProgress reports 0..1 during model
// inference (the slow part) so the UI can show meaningful progress.
export async function transcribeAudioFile(
  file: File,
  onProgress?: (fraction: number) => void,
): Promise<VisNote[]> {
  const audioBuffer = await decodeToMono22050(file);

  if (!basicPitch) basicPitch = new BasicPitch(MODEL_URL);

  const frames: number[][] = [];
  const onsets: number[][] = [];
  const contours: number[][] = [];

  await basicPitch.evaluateModel(
    audioBuffer,
    (f, o, c) => {
      frames.push(...f);
      onsets.push(...o);
      contours.push(...c);
    },
    (p) => onProgress?.(p),
  );

  const events = noteFramesToTime(
    addPitchBendsToNoteEvents(
      contours,
      outputToNotesPoly(
        frames,
        onsets,
        ONSET_THRESHOLD,
        FRAME_THRESHOLD,
        MIN_NOTE_LENGTH_FRAMES,
      ),
    ),
  );

  return noteEventsToVisNotes(events);
}
