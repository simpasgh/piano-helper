// Playback transport helpers (issue #29). Pure functions for the scrub/seek bar and the
// next/previous-note step controls, isolated from the DOM and Tone.js so they can be
// unit-tested. The browser wiring (transport.seconds, slider DOM, cursor) lives in main.ts.

import type { VisNote } from "./visualizer";

// The seek slider uses a fixed integer range (per-mille of the score) instead of seconds,
// so the native step granularity stays smooth and `max` never has to change per load.
export const SEEK_RANGE = 1000;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

// Sorted, de-duplicated list of note onset times (seconds). Drives next/previous stepping
// for both sheet scores and audio-transcribed scores (which have no cursor step list).
export function uniqueOnsets(notes: VisNote[]): number[] {
  const seen = new Set<number>();
  const onsets: number[] = [];
  for (const n of notes) {
    if (!seen.has(n.time)) {
      seen.add(n.time);
      onsets.push(n.time);
    }
  }
  onsets.sort((a, b) => a - b);
  return onsets;
}

// First onset strictly after `currentTime` (with a small epsilon so being exactly on an
// onset advances to the next one, not back to the current). Null when already at/after last.
export function nextOnset(onsets: number[], currentTime: number, eps = 1e-3): number | null {
  for (const t of onsets) {
    if (t > currentTime + eps) return t;
  }
  return null;
}

// Last onset strictly before `currentTime` (minus epsilon). Null when already at/before
// the first onset. `onsets` must be ascending (as returned by uniqueOnsets).
export function prevOnset(onsets: number[], currentTime: number, eps = 1e-3): number | null {
  let result: number | null = null;
  for (const t of onsets) {
    if (t < currentTime - eps) result = t;
    else break;
  }
  return result;
}

// Map a score time (seconds) to the integer seek-slider position [0, SEEK_RANGE].
export function scoreTimeToSeek(scoreTime: number, duration: number): number {
  if (duration <= 0) return 0;
  return Math.round(clamp(scoreTime / duration, 0, 1) * SEEK_RANGE);
}

// Map an integer seek-slider position back to a score time (seconds).
export function seekToScoreTime(value: number, duration: number): number {
  return clamp(value / SEEK_RANGE, 0, 1) * duration;
}

// Whether the play / export / transport controls should be enabled: only once a score is
// loaded. This is the single source of truth for the "not busy" enable decision (issue #86
// cancel fix), shared by setBusyUI's not-busy branch and the export finally, so a cancel or
// an abandoned job re-enables a still-loaded score's controls and correctly leaves them
// disabled when nothing is loaded.
export function controlsEnabledForScore(scoreLoaded: boolean): boolean {
  return scoreLoaded;
}

// Format a seconds value as m:ss (e.g. 84 -> "1:24"). Negative/NaN clamp to "0:00".
export function formatClock(seconds: number): string {
  const total = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}
