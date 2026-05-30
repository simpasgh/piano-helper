import { describe, it, expect } from "vitest";
import { handGains, formatBalance, BALANCE_RANGE } from "./balance";

describe("handGains", () => {
  it("keeps both hands at full when centered", () => {
    expect(handGains(0)).toEqual({ left: 1, right: 1 });
  });

  it("attenuates the left hand when favouring the right", () => {
    expect(handGains(30)).toEqual({ left: 0.7, right: 1 });
  });

  it("attenuates the right hand when favouring the left", () => {
    expect(handGains(-30)).toEqual({ left: 1, right: 0.7 });
  });

  it("silences the off hand at each extreme", () => {
    expect(handGains(BALANCE_RANGE)).toEqual({ left: 0, right: 1 });
    expect(handGains(-BALANCE_RANGE)).toEqual({ left: 1, right: 0 });
  });

  it("clamps out-of-range input", () => {
    expect(handGains(200)).toEqual({ left: 0, right: 1 });
    expect(handGains(-200)).toEqual({ left: 1, right: 0 });
  });
});

describe("formatBalance", () => {
  it("reads even at center", () => {
    expect(formatBalance(0)).toBe("L100 R100");
  });

  it("reports the reduced hand's percentage", () => {
    expect(formatBalance(30)).toBe("L70 R100");
    expect(formatBalance(-30)).toBe("L100 R70");
  });
});
