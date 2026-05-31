// Editable sheet name (issue #44). Pure, DOM-free helpers so the naming logic is
// unit-testable without OSMD or the toolbar. The browser wiring (the inline click-to-edit
// field in the toolbar) lives in main.ts; deriving the default name and normalizing a
// user-entered name are isolated here.

// Longest name we keep. A friendly title, not a paragraph; also keeps the toolbar slot from
// being blown out by a pasted blob. Trimmed to this many characters after collapsing
// whitespace.
export const MAX_SHEET_NAME_LENGTH = 80;

// The label shown before any score is loaded and the fallback when a derived/edited name is
// empty. Mirrors the original #track-name placeholder text.
export const DEFAULT_SHEET_NAME = "Untitled sheet";

// OSMD reports this exact placeholder as the title when a MusicXML score has no embedded
// work-title/movement-title (issue #64). It is non-empty, so we must explicitly reject it,
// otherwise the file-name fallback never runs and the user sees "Untitled Score" instead of
// the file name. Compared lowercased and trimmed so case/whitespace variants are caught too.
export const OSMD_PLACEHOLDER_TITLE = "Untitled Score";

// Collapse internal whitespace runs to single spaces and trim the ends. A name pasted with
// newlines/tabs becomes one clean line.
function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

// Strip a trailing file extension (e.g. ".musicxml", ".mid", ".PDF"). Only removes a final
// dot followed by a short run of alphanumerics, so a name that merely contains a dot
// ("J.S. Bach", whose tail "Bach" is not preceded by a dot) is left alone.
function stripExtension(value: string): string {
  return value.replace(/\.[A-Za-z0-9]{1,8}$/, "");
}

// Normalize any candidate (a file name, a MusicXML title, or a user edit) into the name we
// actually store and display: whitespace collapsed, capped at MAX_SHEET_NAME_LENGTH. Returns
// "" when there is nothing usable, so callers can fall back to a default.
export function normalizeSheetName(raw: string | null | undefined): string {
  if (!raw) return "";
  return collapseWhitespace(raw).slice(0, MAX_SHEET_NAME_LENGTH).trim();
}

// True when a candidate title is OSMD's "Untitled Score" placeholder (case- and
// whitespace-insensitive). Such a title is not a real title, so it must not win.
function isPlaceholderTitle(value: string): boolean {
  return value.trim().toLowerCase() === OSMD_PLACEHOLDER_TITLE.toLowerCase();
}

// Pick the default name for a freshly loaded piece. Prefers the MusicXML title when the
// source provides a real one (not OSMD's "Untitled Score" placeholder), else the file name
// with its extension stripped, else DEFAULT_SHEET_NAME. Each candidate is normalized; a blank
// or placeholder candidate falls through to the next.
export function deriveDefaultSheetName(
  fileName: string | null | undefined,
  musicXmlTitle: string | null | undefined,
): string {
  const fromTitle = normalizeSheetName(musicXmlTitle);
  if (fromTitle && !isPlaceholderTitle(fromTitle)) return fromTitle;

  const fromFile = normalizeSheetName(stripExtension(fileName ?? ""));
  if (fromFile) return fromFile;

  return DEFAULT_SHEET_NAME;
}

// Resolve a user-submitted edit against the current name. An empty submission reverts to the
// current name (an edit cannot blank the title); otherwise the normalized edit wins. If the
// current name is somehow empty too, fall back to DEFAULT_SHEET_NAME.
export function resolveEditedSheetName(
  edited: string,
  currentName: string,
): string {
  const normalized = normalizeSheetName(edited);
  if (normalized) return normalized;
  return normalizeSheetName(currentName) || DEFAULT_SHEET_NAME;
}
