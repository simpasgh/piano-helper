// Pure copy mapping for the scan / transcribe loading overlay (issue #86). The DOM
// show/hide + focus handling lives in main.ts; this is the testable kind -> heading
// decision so the wording cannot silently drift. No em dashes (project rule).

export type ScanOverlayKind = "scan" | "audio";

// Heading shown at the top of the overlay card for each job kind.
export function scanOverlayTitle(kind: ScanOverlayKind): string {
  return kind === "audio" ? "Transcribing your audio" : "Scanning your sheet";
}
