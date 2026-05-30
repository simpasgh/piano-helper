// Salamander Grand Piano samples, by Alexander Holm, licensed CC-BY 3.0.
// Free to use and redistribute with attribution. We stream the mp3 buffers from the
// official, uncapped Tone.js sample CDN rather than bundling them (keeps the repo free of
// large binaries and avoids any paid asset host).
export const SALAMANDER_BASE_URL = "https://tonejs.github.io/audio/salamander/";

// The CDN ships one sample roughly every minor third. We use that same spacing so
// Tone.Sampler pitch-shifts each note by at most ~1 semitone, which keeps the download
// modest while staying audibly realistic across the keyboard.
const SAMPLE_PITCH_CLASSES = [
  { name: "A", file: "A" },
  { name: "C", file: "C" },
  { name: "D#", file: "Ds" },
  { name: "F#", file: "Fs" },
];

// Octaves that exist in the Salamander CDN set. A0 is the lowest sample; the set runs up
// to C8. Within each octave the four pitch classes above exist, except the partial top
// octave which only ships C8.
const FIRST_OCTAVE = 0;
const LAST_OCTAVE = 7;

// Builds the Tone.Sampler note->filename map, e.g. { "A0": "A0.mp3", "D#1": "Ds1.mp3" }.
// Pure and deterministic so it can be unit-tested without an AudioContext. Sharps use the
// "s" spelling in filenames (D#1 -> Ds1.mp3) to match the CDN's file names.
export function buildSalamanderSampleMap(): Record<string, string> {
  const map: Record<string, string> = {};
  for (let octave = FIRST_OCTAVE; octave <= LAST_OCTAVE; octave++) {
    for (const pc of SAMPLE_PITCH_CLASSES) {
      // A0 is the lowest real sample; C0/D#0/F#0 do not exist on the CDN.
      if (octave === FIRST_OCTAVE && pc.name !== "A") continue;
      map[`${pc.name}${octave}`] = `${pc.file}${octave}.mp3`;
    }
  }
  // Top of the keyboard: only C8 ships.
  map["C8"] = "C8.mp3";
  return map;
}
