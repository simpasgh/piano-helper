// Pure aria-live announce-string builders for the Smart Edit editor (Designer P3-6 / MID-4). Kept out
// of main.ts (which is the DOM/model orchestrator and is not unit-tested) so the exact wording of each
// announce has a clean, isolated test surface, like key-names.ts / time-names.ts host the pill strings.
// These take ALREADY-RESOLVED display tokens (the pitch label in the current Names mode, the key name,
// the meter label) plus the structured edit fields; no DOM, no model, no globals. No em dashes.

// The committed-duration-edit announce (Designer P3-6 / TIE-E), value-named for the pitch token in the
// current Names mode. Step: "D5 quarter to half"; clamp: "D5 lengthened to fill the bar"; cross-barline
// tie create: "D5 lengthened across the bar to half" (distinct from the in-bar clamp so the user hears
// it CROSSED); tie remove: "D5 half to quarter, tie removed". An OFF-LADDER (dotted/odd) ARRIVAL that
// SNAPS to the nearest plain rung as part of the edit reads like a normal step WITH the pitch token
// ("D5 dotted quarter to half"); the pitch leads exactly as the plain-step branch, so a screen-reader
// user always hears which note moved. `pitch` is the resolved label; `fromValue` the pre-edit value name.
export function durationEditAnnounce(
  rec: {
    outcome: string;
    fromName: string;
    toName: string;
    dottedSnap: boolean;
  },
  fromValue: string,
  pitch: string,
  fillName: string,
): string {
  // A lengthen/dot that grew the note PAST the barline with a tie: name the resulting SOUNDING value.
  if (rec.outcome === "tied") return `${pitch} lengthened across the bar to ${rec.toName}`;
  // A shorten that REMOVED a cross-barline tie: from the sounding value down, plus that the tie went.
  if (rec.outcome === "untied") return `${pitch} ${rec.fromName} to ${rec.toName}, tie removed`;
  if (rec.outcome === "clamped") return `${pitch} lengthened to fill the bar`;
  // A dotted/odd arrival snapped to plain: name the PITCH then the from->to value, consistent with the
  // normal step below (the snap path used to drop the pitch token). `fillName` is the fallback value
  // word when the landed value has no plain ladder name (the same noteValueName("", 0) the caller uses).
  if (rec.dottedSnap) return `${pitch} ${fromValue} to ${rec.toName || fillName}`;
  return `${pitch} ${rec.fromName} to ${rec.toName}`;
}

// The forward (and redo) announce for a KEY edit (MID-4). A mid-piece REMOVE (the user re-picked the key
// the region inherits from before, dropping a redundant declaration) reads as a REMOVAL naming the
// measure and the reverted-to key; a mid-piece SET/ADD/EDIT names the measure ("from measure N"); a
// START edit (no selection / the initial region) keeps the v1 string. `name` is the resolved key name
// for the new value; `priorName` the resolved name of the key the region reverts to (== name on a
// remove, since a remove sets the value to the prior). `atMeasure` undefined / <= 1 means a start edit.
export function keySetAnnounce(opts: {
  name: string;
  atMeasure: number | undefined;
  removed: boolean;
  priorName: string;
}): string {
  const { name, atMeasure, removed, priorName } = opts;
  const mid = atMeasure !== undefined && atMeasure > 1;
  if (removed && mid) {
    return `Removed the key change at measure ${atMeasure}; back to ${priorName}.`;
  }
  if (mid) return `Key signature set to ${name} from measure ${atMeasure}.`;
  return `Key signature set to ${name}.`;
}

// The forward (and redo) announce for a TIME edit (SIG-5 / MID-4). A mid-piece REMOVE reads as a REMOVAL
// naming the measure and the reverted-to meter; otherwise the all-bars-fit string (or the guardrail
// string with the count of bars that no longer fill the new meter), naming the measure for a mid-piece
// change. The mismatched count is already scoped to the affected region by the model. `meter` is the
// resolved slash label for the new meter; `priorMeter` the label the region reverts to (== meter on a
// remove). `atMeasure` <= 1 / null means a start edit.
export function timeSetAnnounce(opts: {
  meter: string;
  atMeasure: number | null;
  mismatchedBars: number;
  removed: boolean;
  priorMeter: string;
}): string {
  const { meter, atMeasure, mismatchedBars, removed, priorMeter } = opts;
  const mid = atMeasure !== null && atMeasure > 1;
  if (removed && mid) {
    return `Removed the time change at measure ${atMeasure}; back to ${priorMeter}.`;
  }
  const from = mid ? ` from measure ${atMeasure}` : "";
  if (mismatchedBars <= 0) return `Time signature set to ${meter}${from}.`;
  const bars = mismatchedBars === 1 ? "1 bar no longer fills" : `${mismatchedBars} bars no longer fill`;
  return `Time signature set to ${meter}${from}. ${bars} the bar; adjust their note lengths.`;
}
