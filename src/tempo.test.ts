import { describe, it, expect } from "vitest";
import {
  clampTempoPercent,
  tempoPercentToRate,
  rateToBpm,
  TEMPO_MIN_PERCENT,
  TEMPO_MAX_PERCENT,
  TEMPO_DEFAULT_PERCENT,
} from "./tempo";

describe("tempoPercentToRate", () => {
  it("maps 100% to a rate of 1.0 (score speed)", () => {
    expect(tempoPercentToRate(100)).toBe(1.0);
  });

  it("maps 50% to 0.5 and 200% to 2.0", () => {
    expect(tempoPercentToRate(50)).toBe(0.5);
    expect(tempoPercentToRate(200)).toBe(2.0);
  });

  it("maps the range endpoints", () => {
    expect(tempoPercentToRate(TEMPO_MIN_PERCENT)).toBe(0.25);
    expect(tempoPercentToRate(TEMPO_MAX_PERCENT)).toBe(2.0);
  });

  it("clamps out-of-range percents before converting", () => {
    expect(tempoPercentToRate(10)).toBe(TEMPO_MIN_PERCENT / 100);
    expect(tempoPercentToRate(500)).toBe(TEMPO_MAX_PERCENT / 100);
    expect(tempoPercentToRate(-30)).toBe(TEMPO_MIN_PERCENT / 100);
  });
});

describe("clampTempoPercent", () => {
  it("leaves in-range values untouched", () => {
    expect(clampTempoPercent(100)).toBe(100);
    expect(clampTempoPercent(75)).toBe(75);
  });

  it("clamps below min and above max", () => {
    expect(clampTempoPercent(0)).toBe(TEMPO_MIN_PERCENT);
    expect(clampTempoPercent(1000)).toBe(TEMPO_MAX_PERCENT);
  });

  it("falls back to the default for non-finite input", () => {
    expect(clampTempoPercent(NaN)).toBe(TEMPO_DEFAULT_PERCENT);
    expect(clampTempoPercent(Infinity)).toBe(TEMPO_DEFAULT_PERCENT);
  });
});

describe("rateToBpm", () => {
  it("scales the base bpm by the rate", () => {
    expect(rateToBpm(1.0, 120)).toBe(120);
    expect(rateToBpm(0.5, 120)).toBe(60);
    expect(rateToBpm(2.0, 120)).toBe(240);
  });

  it("composes with tempoPercentToRate for the full slider->bpm path", () => {
    const baseBpm = 120;
    expect(rateToBpm(tempoPercentToRate(100), baseBpm)).toBe(120);
    expect(rateToBpm(tempoPercentToRate(50), baseBpm)).toBe(60);
    expect(rateToBpm(tempoPercentToRate(200), baseBpm)).toBe(240);
  });
});
