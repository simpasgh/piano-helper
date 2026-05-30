// Tempo control math for the playback-speed slider (issue #14).
//
// The slider value is a percent of the notated score tempo. We convert it to a unitless
// rate (1.0 = 100% = score speed) that drives both the audio transport bpm and the visual
// "score time" used by the falling notes and the OSMD cursor, so all three scale together.

// Matches the slider's min/max in index.html. Out-of-range input is clamped so the math
// can never produce a negative or runaway rate (e.g. a stale or hand-edited value).
export const TEMPO_MIN_PERCENT = 25;
export const TEMPO_MAX_PERCENT = 200;
export const TEMPO_DEFAULT_PERCENT = 100;

// Clamp a tempo percent into the supported range. Non-finite input falls back to 100%.
export function clampTempoPercent(percent: number): number {
  if (!Number.isFinite(percent)) return TEMPO_DEFAULT_PERCENT;
  return Math.min(TEMPO_MAX_PERCENT, Math.max(TEMPO_MIN_PERCENT, percent));
}

// Convert a tempo percent to a playback rate. 100 -> 1.0, 50 -> 0.5, 200 -> 2.0.
// The input is clamped first, so the result is always within [0.25, 2.0].
export function tempoPercentToRate(percent: number): number {
  return clampTempoPercent(percent) / 100;
}

// Convert a playback rate to the transport bpm given the base bpm captured at startup.
export function rateToBpm(rate: number, baseBpm: number): number {
  return baseBpm * rate;
}
