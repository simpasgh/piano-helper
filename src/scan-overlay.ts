// Pure copy mapping for the scan / transcribe loading overlay (issue #86). The DOM
// show/hide + focus handling lives in main.ts; this is the testable kind -> heading
// decision so the wording cannot silently drift. No em dashes (project rule).

export type ScanOverlayKind = "scan" | "audio";

// Heading shown at the top of the overlay card for each job kind.
export function scanOverlayTitle(kind: ScanOverlayKind): string {
  return kind === "audio" ? "Transcribing your audio" : "Scanning your sheet";
}

// Decide whether a finished job's result should still be applied (issue #86 cancel fix).
// The audio transcription cannot be aborted server-side, so a cancelled or superseded job
// keeps running in the background and resolves late. Its result must be applied ONLY when
// the job is still the active one (its captured generation matches the current generation)
// AND the user has not cancelled it. A cancel-then-restart bumps the generation, so job A's
// late result fails the generation check and is dropped while job B's overlay is up.
export function shouldApplyResult(
  generation: number,
  currentGeneration: number,
  cancelled: boolean,
): boolean {
  return generation === currentGeneration && !cancelled;
}
