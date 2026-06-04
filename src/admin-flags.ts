// Static metadata for the admin feature-flag page (src/admin.ts): what each OMR flag does and its
// accuracy / latency / algorithm trade-off, ordered primitive -> advanced so the progression of
// engine sophistication is legible. Pure data + the dependency-cascade helper, so it is unit-testable
// without the DOM. The allowlist of flag KEYS lives in flags-server.ts (one source of truth); this
// module annotates each of those keys.

import { KNOWN_FLAGS, type FlagKey } from "./flags-server";

export type FlagSection = "engine" | "delivery";

// Desired on/off state of every flag, as the UI holds it (booleans) before serializing to the
// "0"/"1" config the worker reads.
export type FlagState = Record<FlagKey, boolean>;

export interface FlagMeta {
  key: FlagKey;
  label: string;
  // 1-based rank within the whole list, primitive (1) -> advanced (7); drives display order.
  tier: number;
  section: FlagSection;
  // Direct prerequisites: this flag is meaningless unless these are also on.
  requires: FlagKey[];
  // The recommended baseline pair (geom+Clarity fusion + fast-then-refine), highlighted in the UI.
  recommended?: boolean;
  summary: string;
  accuracy: string;
  latency: string;
  algorithm: string;
}

// Ordered primitive -> advanced. The "Recognition engine" section is the accuracy/algorithm axis; the
// "Delivery" section is the latency/UX axis. Descriptions are kept honest (e.g. geom-primary's
// fabricated rhythm, per-page's possibly-higher total time) so a reader can choose deliberately.
export const FLAG_METADATA: readonly FlagMeta[] = [
  {
    key: "OMR_ENSEMBLE",
    label: "Two-engine ensemble",
    tier: 1,
    section: "engine",
    requires: [],
    summary: "Run Clarity and oemer together and reconcile their disagreements.",
    accuracy: "Higher than either alone: two pretrained engines cross-check and a reconciler votes on conflicts.",
    latency: "Higher: runs both concurrently, so ~the slower engine (oemer can be ~180s on a full page).",
    algorithm: "Ensemble of two pretrained OMR models + a pitch/duration reconciler.",
  },
  {
    key: "OMR_ENSEMBLE_REFEREE",
    label: "Visual-diff referee",
    tier: 2,
    section: "engine",
    requires: ["OMR_ENSEMBLE"],
    summary: "Break leftover ensemble ties by comparing each disputed note to the pixels.",
    accuracy: "Marginal today: the localizer is deliberately conservative and declines most disputes (near no-op).",
    latency: "Negligible: only fires on the small set of residual disagreements.",
    algorithm: "Classical pixel/visual diff against a re-rendered candidate. Needs the ensemble.",
  },
  {
    key: "OMR_GEOM",
    label: "Trained geometric engine (fallback)",
    tier: 3,
    section: "engine",
    requires: [],
    summary: "Our own notehead detector + exact geometric pitch decode, as a never-worse fallback.",
    accuracy: "Exact pitch and octave when it fires; only used when the other engines produce nothing.",
    latency: "Fast (~5s): a small detector plus a deterministic decode, no heavy model.",
    algorithm: "Trained YOLO notehead detector feeding a deterministic staff-geometry pitch decode.",
  },
  {
    key: "OMR_GEOM_PRIMARY",
    label: "Geometric engine wins-first",
    tier: 4,
    section: "engine",
    requires: ["OMR_GEOM"],
    summary: "Let the geometric engine run first and win, ahead of the other engines.",
    accuracy: "Best pitch and octave, but it FABRICATES rhythm: every note becomes a quarter note.",
    latency: "Fast (~5s).",
    algorithm: "Trained detector + exact pitch decode, with no rhythm reading. Needs the geom engine.",
  },
  {
    key: "OMR_GEOM_FUSION",
    label: "Geom pitch + Clarity rhythm (fusion)",
    tier: 5,
    section: "engine",
    requires: ["OMR_GEOM"],
    recommended: true,
    summary: "Fuse the geometric engine's pitch with Clarity's rhythm. The current best.",
    accuracy: "Best overall: beats either engine alone on real pieces (geom's octaves + Clarity's durations).",
    latency: "~the slower of geom and Clarity (~100s) since both run, then fuse.",
    algorithm: "Geom pitch decode + Clarity durations, aligned per chord by pitch-class. Takes precedence over wins-first.",
  },
  {
    key: "OMR_PROGRESSIVE",
    label: "Progressive: fast-then-refine",
    tier: 6,
    section: "delivery",
    requires: [],
    recommended: true,
    summary: "Show all the notes in ~5s, then refine the rhythm in place when fusion finishes.",
    accuracy: "Identical final result: this only changes WHEN you see it, not what you get.",
    latency: "First notes in ~5s instead of waiting ~100s for the whole file.",
    algorithm: "Publish the geometric engine's pitch-only result as a partial, then the fused result as the complete.",
  },
  {
    key: "OMR_PROGRESSIVE_PAGES",
    label: "Progressive: per-page streaming",
    tier: 7,
    section: "delivery",
    requires: ["OMR_PROGRESSIVE"],
    summary: "Stream a multi-page PDF page by page (measure 1 shows while measure 20 is still computing).",
    accuracy: "Identical final result.",
    latency: "First PAGE sooner, but the TOTAL time can be higher (each page reloads the model; unmeasured).",
    algorithm: "Split the PDF, transcribe + fuse each page independently, append in document order. Needs progressive.",
  },
];

const META_BY_KEY = new Map<FlagKey, FlagMeta>(FLAG_METADATA.map((m) => [m.key, m]));

// All flags this flag transitively requires (its prerequisites' prerequisites too).
export function transitiveRequires(flag: FlagKey): FlagKey[] {
  const seen = new Set<FlagKey>();
  const walk = (f: FlagKey): void => {
    for (const req of META_BY_KEY.get(f)?.requires ?? []) {
      if (!seen.has(req)) {
        seen.add(req);
        walk(req);
      }
    }
  };
  walk(flag);
  return [...seen];
}

// All flags that transitively require the given flag (its dependents).
export function dependentsOf(flag: FlagKey): FlagKey[] {
  return KNOWN_FLAGS.filter((f) => f !== flag && transitiveRequires(f).includes(flag));
}

// A fresh all-off state.
export function emptyState(): FlagState {
  return Object.fromEntries(KNOWN_FLAGS.map((k) => [k, false])) as FlagState;
}

// Toggle one flag and cascade dependencies so the result is always valid: turning a flag ON also
// turns on everything it requires; turning a flag OFF also turns off everything that requires it.
// Pure: returns a new state, does not mutate the input.
export function withFlag(state: FlagState, flag: FlagKey, value: boolean): FlagState {
  const next: FlagState = { ...state, [flag]: value };
  if (value) {
    for (const req of transitiveRequires(flag)) next[req] = true;
  } else {
    for (const dep of dependentsOf(flag)) next[dep] = false;
  }
  return next;
}

// Build a UI state from the "0"/"1" config the endpoint returns (absent flag = off).
export function stateFromConfig(config: Partial<Record<FlagKey, "0" | "1">>): FlagState {
  const state = emptyState();
  for (const k of KNOWN_FLAGS) state[k] = config[k] === "1";
  return state;
}

// Serialize a UI state to the full "0"/"1" config to POST (every known flag explicit, so the config
// is the complete desired truth rather than a partial overlay).
export function configFromState(state: FlagState): Record<FlagKey, "0" | "1"> {
  return Object.fromEntries(
    KNOWN_FLAGS.map((k) => [k, state[k] ? "1" : "0"]),
  ) as Record<FlagKey, "0" | "1">;
}
