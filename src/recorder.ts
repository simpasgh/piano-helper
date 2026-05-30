// Video export (issue #15). Pure helpers for the client-side "record the performance and
// download it" path. The browser orchestration (captureStream + MediaRecorder) lives in
// main.ts; the codec choice and filename logic are isolated here so they can be unit-tested
// without a MediaRecorder or a DOM.

export interface VideoFormat {
  mimeType: string;
  extension: string;
}

// Preferred container/codec order. WebM (VP9/VP8 + Opus) is the broadly supported,
// royalty-free, YouTube-friendly default; MP4 is a last-resort fallback for browsers that
// only record MP4 (e.g. some Safari versions).
const VIDEO_FORMAT_CANDIDATES: VideoFormat[] = [
  { mimeType: "video/webm;codecs=vp9,opus", extension: "webm" },
  { mimeType: "video/webm;codecs=vp8,opus", extension: "webm" },
  { mimeType: "video/webm", extension: "webm" },
  { mimeType: "video/mp4", extension: "mp4" },
];

// First candidate the runtime can actually record, or null if none. The support predicate
// is injected (MediaRecorder.isTypeSupported in the app) so this stays unit-testable.
export function chooseVideoFormat(
  isSupported: (mimeType: string) => boolean,
): VideoFormat | null {
  for (const format of VIDEO_FORMAT_CANDIDATES) {
    if (isSupported(format.mimeType)) return format;
  }
  return null;
}

// Build a safe, descriptive download filename from the current track label. Strips the
// trailing "(N notes)" annotation and any file extension, slugifies the rest, and appends
// a timestamp so repeated exports do not collide. Falls back to "performance" when the
// label has no usable text.
export function buildExportFilename(
  trackName: string,
  extension: string,
  now: Date = new Date(),
): string {
  const slug =
    trackName
      .replace(/\s*\(\d+\s*notes?\)\s*$/i, "")
      .replace(/\.[^.]+$/, "")
      .replace(/[^a-z0-9]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase() || "performance";
  const stamp = now.toISOString().slice(0, 19).replace(/[:T]/g, "-");
  return `piano-helper-${slug}-${stamp}.${extension}`;
}
