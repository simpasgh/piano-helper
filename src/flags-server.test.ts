import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { KNOWN_FLAGS, sanitizeFlagConfig, isAuthorized, isFlagOn } from "./flags-server";

describe("sanitizeFlagConfig", () => {
  it("keeps known flags as 0/1", () => {
    expect(sanitizeFlagConfig({ OMR_PROGRESSIVE: "1", OMR_GEOM: "0" })).toEqual({
      OMR_PROGRESSIVE: "1",
      OMR_GEOM: "0",
    });
  });

  it("coerces booleans and numbers to 0/1", () => {
    expect(
      sanitizeFlagConfig({ OMR_GEOM: true, OMR_GEOM_FUSION: 1, OMR_ENSEMBLE: false }),
    ).toEqual({ OMR_GEOM: "1", OMR_GEOM_FUSION: "1", OMR_ENSEMBLE: "0" });
  });

  it("drops unknown keys (including the paid OMR_LLM) and unrecognized values", () => {
    expect(
      sanitizeFlagConfig({
        OMR_LLM: "1",
        BOGUS: "1",
        OMR_GEOM: "maybe",
        OMR_PROGRESSIVE: "1",
      }),
    ).toEqual({ OMR_PROGRESSIVE: "1" });
  });

  it("returns null for non-objects so the endpoint can 400", () => {
    expect(sanitizeFlagConfig(null)).toBeNull();
    expect(sanitizeFlagConfig("x")).toBeNull();
    expect(sanitizeFlagConfig([1, 2])).toBeNull();
  });
});

describe("isAuthorized", () => {
  it("accepts the exact Bearer token", () => {
    expect(isAuthorized("Bearer s3cret", "s3cret")).toBe(true);
  });

  it("rejects a wrong, missing, or malformed header", () => {
    expect(isAuthorized("Bearer nope", "s3cret")).toBe(false);
    expect(isAuthorized("s3cret", "s3cret")).toBe(false); // no Bearer prefix
    expect(isAuthorized(null, "s3cret")).toBe(false);
    expect(isAuthorized("Bearer s3cre", "s3cret")).toBe(false); // length mismatch
  });

  it("fails closed when no token is configured", () => {
    expect(isAuthorized("Bearer anything", "")).toBe(false);
    expect(isAuthorized("Bearer anything", undefined)).toBe(false);
  });
});

describe("isFlagOn", () => {
  it("treats only the string 1 as on", () => {
    expect(isFlagOn("1")).toBe(true);
    expect(isFlagOn("0")).toBe(false);
    expect(isFlagOn(undefined)).toBe(false);
  });
});

describe("worker/client flag-list parity", () => {
  it("KNOWN_FLAGS matches omr-worker/flag_config.py (so the allowlists never drift)", () => {
    const root = fileURLToPath(new URL("..", import.meta.url));
    const py = readFileSync(`${root}omr-worker/flag_config.py`, "utf8");
    const block = py.match(/KNOWN_FLAGS\s*=\s*\(([\s\S]*?)\)/);
    expect(block, "flag_config.py must define a KNOWN_FLAGS tuple").not.toBeNull();
    const pyFlags = [...block![1].matchAll(/"([A-Z0-9_]+)"/g)].map((m) => m[1]);
    expect(pyFlags).toEqual([...KNOWN_FLAGS]);
  });
});
