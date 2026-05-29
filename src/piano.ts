// Standard 88-key piano spans MIDI note 21 (A0) to 108 (C8).
export const FIRST_MIDI = 21;
export const LAST_MIDI = 108;

const BLACK_PITCH_CLASSES = new Set([1, 3, 6, 8, 10]);

export function isBlackKey(midi: number): boolean {
  return BLACK_PITCH_CLASSES.has(((midi % 12) + 12) % 12);
}

export interface KeyGeometry {
  midi: number;
  x: number;
  width: number;
  black: boolean;
}

// Builds left-edge x positions and widths for every key, scaled to `totalWidth`.
// White keys tile evenly; black keys are narrower and straddle the gap between whites.
export function buildKeyLayout(totalWidth: number): KeyGeometry[] {
  let whiteCount = 0;
  for (let m = FIRST_MIDI; m <= LAST_MIDI; m++) {
    if (!isBlackKey(m)) whiteCount++;
  }
  const whiteWidth = totalWidth / whiteCount;
  const blackWidth = whiteWidth * 0.62;

  const keys: KeyGeometry[] = [];
  let whiteIndex = 0;
  for (let m = FIRST_MIDI; m <= LAST_MIDI; m++) {
    if (isBlackKey(m)) {
      // Black key sits centered on the boundary between the previous and next white key.
      const x = whiteIndex * whiteWidth - blackWidth / 2;
      keys.push({ midi: m, x, width: blackWidth, black: true });
    } else {
      keys.push({ midi: m, x: whiteIndex * whiteWidth, width: whiteWidth, black: false });
      whiteIndex++;
    }
  }
  return keys;
}

export function midiToName(midi: number): string {
  const names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const octave = Math.floor(midi / 12) - 1;
  return `${names[((midi % 12) + 12) % 12]}${octave}`;
}
