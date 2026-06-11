import { describe, it, expect } from "vitest";
import { KNOWN_FLAGS } from "./flags-server";
import {
  FLAG_METADATA,
  withFlag,
  emptyState,
  transitiveRequires,
  dependentsOf,
  stateFromConfig,
  configFromState,
} from "./admin-flags";

describe("FLAG_METADATA", () => {
  it("has exactly one entry per known flag", () => {
    expect(FLAG_METADATA.map((m) => m.key).sort()).toEqual([...KNOWN_FLAGS].sort());
  });

  it("is ordered primitive -> advanced by unique ascending tiers", () => {
    const tiers = FLAG_METADATA.map((m) => m.tier);
    expect(tiers).toEqual([...tiers].sort((a, b) => a - b));
    expect(new Set(tiers).size).toBe(tiers.length);
  });

  it("only references known flags in requires", () => {
    for (const m of FLAG_METADATA) {
      for (const r of m.requires) expect(KNOWN_FLAGS).toContain(r);
    }
  });

  it("gives every flag accuracy / latency / algorithm copy", () => {
    for (const m of FLAG_METADATA) {
      expect(m.accuracy.length).toBeGreaterThan(0);
      expect(m.latency.length).toBeGreaterThan(0);
      expect(m.algorithm.length).toBeGreaterThan(0);
      expect(m.summary.length).toBeGreaterThan(0);
    }
  });

  it("uses no em or en dashes (project rule)", () => {
    for (const m of FLAG_METADATA) {
      const text = `${m.label}|${m.summary}|${m.accuracy}|${m.latency}|${m.algorithm}`;
      expect(text).not.toMatch(/[–—]/);
    }
  });
});

describe("withFlag dependency cascade", () => {
  it("enabling a flag enables its requirements", () => {
    const s = withFlag(emptyState(), "OMR_GEOM_FUSION", true);
    expect(s.OMR_GEOM_FUSION).toBe(true);
    expect(s.OMR_GEOM).toBe(true); // auto-enabled prerequisite
  });

  it("disabling a requirement disables its dependents", () => {
    let s = withFlag(emptyState(), "OMR_GEOM_FUSION", true); // GEOM + FUSION on
    s = withFlag(s, "OMR_GEOM", false);
    expect(s.OMR_GEOM).toBe(false);
    expect(s.OMR_GEOM_FUSION).toBe(false); // cascaded off
  });

  it("cascades transitively (per-page needs progressive)", () => {
    const on = withFlag(emptyState(), "OMR_PROGRESSIVE_PAGES", true);
    expect(on.OMR_PROGRESSIVE).toBe(true);
    const off = withFlag(on, "OMR_PROGRESSIVE", false);
    expect(off.OMR_PROGRESSIVE_PAGES).toBe(false);
  });

  it("block-streaming enables BOTH progressive and the fusion engine (+ geom)", () => {
    const on = withFlag(emptyState(), "OMR_PROGRESSIVE_BLOCKS", true);
    expect(on.OMR_PROGRESSIVE_BLOCKS).toBe(true);
    expect(on.OMR_PROGRESSIVE).toBe(true);
    expect(on.OMR_GEOM_FUSION).toBe(true);
    expect(on.OMR_GEOM).toBe(true); // transitive: fusion needs geom
    // Turning OFF either prerequisite cascades block-streaming off.
    expect(withFlag(on, "OMR_GEOM_FUSION", false).OMR_PROGRESSIVE_BLOCKS).toBe(false);
    expect(withFlag(on, "OMR_PROGRESSIVE", false).OMR_PROGRESSIVE_BLOCKS).toBe(false);
  });

  it("does not mutate the input state", () => {
    const base = emptyState();
    withFlag(base, "OMR_GEOM", true);
    expect(base.OMR_GEOM).toBe(false);
  });
});

describe("config <-> state", () => {
  it("round-trips through stateFromConfig / configFromState", () => {
    const state = stateFromConfig({ OMR_GEOM: "1", OMR_GEOM_FUSION: "1", OMR_PROGRESSIVE: "1" });
    expect(state.OMR_GEOM).toBe(true);
    expect(state.OMR_ENSEMBLE).toBe(false);
    const back = configFromState(state);
    expect(back.OMR_GEOM).toBe("1");
    expect(back.OMR_ENSEMBLE).toBe("0");
  });

  it("configFromState emits every known flag explicitly (full desired truth)", () => {
    expect(Object.keys(configFromState(emptyState())).sort()).toEqual([...KNOWN_FLAGS].sort());
  });
});

describe("transitiveRequires / dependentsOf", () => {
  it("transitiveRequires of per-page includes progressive", () => {
    expect(transitiveRequires("OMR_PROGRESSIVE_PAGES")).toContain("OMR_PROGRESSIVE");
  });

  it("dependentsOf geom includes primary, fusion, the photo shim, the seq2seq referee, UVDoc, and block-streaming (transitive via fusion)", () => {
    expect(dependentsOf("OMR_GEOM").sort()).toEqual([
      "OMR_GEOM_FUSION",
      "OMR_GEOM_PRIMARY",
      "OMR_PHOTO_CLARITY",
      "OMR_PROGRESSIVE_BLOCKS",
      "OMR_SEQ2SEQ",
      "OMR_UVDOC",
    ]);
  });

  it("the seq2seq referee requires geom + fusion (cascade on and off)", () => {
    const on = withFlag(emptyState(), "OMR_SEQ2SEQ", true);
    expect(on.OMR_SEQ2SEQ).toBe(true);
    expect(on.OMR_GEOM_FUSION).toBe(true);
    expect(on.OMR_GEOM).toBe(true);
    expect(withFlag(on, "OMR_GEOM_FUSION", false).OMR_SEQ2SEQ).toBe(false);
    expect(withFlag(on, "OMR_GEOM", false).OMR_SEQ2SEQ).toBe(false);
  });
});
