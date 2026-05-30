// Per-hand volume balance (issue #70). Pure helpers, DOM- and Tone-free so they can be
// unit-tested. The slider sits next to the per-hand mute toggles (#37) and shifts relative
// loudness between the hands without silencing either: muting stays a separate, layered
// control. The balance value is an integer percent in [-100, 100]: 0 = even (both hands at
// full), positive favours the right hand (left hand quieter), negative favours the left.

export const BALANCE_RANGE = 100;
export const BALANCE_DEFAULT = 0;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export interface HandGains {
  left: number;
  right: number;
}

// Map a balance percent to a {left, right} gain pair in [0, 1], used as the per-note
// velocity in triggerAttackRelease. The favoured hand stays at 1.0; the other is attenuated
// linearly, reaching 0 at the extreme. At the extreme a hand's notes are effectively silent
// via low touch, which is distinct from (and layered under) the explicit mute toggle.
export function handGains(balancePercent: number): HandGains {
  const p = clamp(balancePercent, -BALANCE_RANGE, BALANCE_RANGE) / BALANCE_RANGE;
  if (p >= 0) return { left: 1 - p, right: 1 };
  return { left: 1, right: 1 + p };
}

// Compact toolbar readout of the current split, e.g. "L100 R100" when even or "L70 R100"
// when the left hand is at 70%. Percentages are rounded to whole numbers.
export function formatBalance(balancePercent: number): string {
  const { left, right } = handGains(balancePercent);
  return `L${Math.round(left * 100)} R${Math.round(right * 100)}`;
}
