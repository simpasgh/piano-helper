#!/usr/bin/env python3
"""Music-theory rhythm repair: complete each measure to the time signature, pitch-safely.

WHY. Every OMR engine (and the geom+Clarity fusion that is now prod-primary) emits residual RHYTHM
errors: a measure whose note durations do NOT sum to the bar capacity. A 4/4 bar that renders with
only ~3 beats (a dotted figure plus a chord, one beat missing) is the canonical symptom: the bar
renders squished and every following bar is misaligned. The time signature is a hard constraint the
engines do not exploit: in a 4/4 bar each voice MUST sum to four quarter-beats. This module flags
the bars that violate a CORROBORATED meter and completes them so they render at their true width.

WHAT IT DOES (per measure, per staff, single voice only). It makes the bar sum to capacity by
PITCH-SAFE means ONLY:
  - grow / shrink / remove a REST that is already in the bar, or
  - pad a short rest-free bar with a trailing REST (the missing time shown as silence).
It NEVER changes a pitched note's duration and NEVER adds or deletes a pitched note, so the
pitch/duration accuracy of the transcription cannot regress; only rests move. Completing the bar
fixes the rendering/timing symptom even though the gap is shown as a rest rather than recovered.

WHY NOT STRETCH A NOTE (a measured dead end, do not re-add naively). The obvious idea is: when a
bar is short by exactly one note's worth of a simple misread (eighth-vs-quarter, a missed dot),
stretch THAT note (x2 / +dot / ...) so the bar sums. We built that (unique-culprit only) and
MEASURED it on the 4 real pieces: it REGRESSED note_dur_f1 (tctab 0.875 -> 0.863). A per-edit
diagnostic against ground truth showed 7 of 9 such edits stretched a note that was ALREADY CORRECT
(truth matched the note's ORIGINAL duration); the bar was short because a note was DROPPED, not
misread. From the bar sum alone you cannot tell an under-read note from a correct note next to a
missing one, and in real engine output missing notes dominate. So per the never-worse contract we
do NOT touch pitched durations; silence is the only safe completion. (If a future engine exposes a
per-note duration CONFIDENCE, a targeted low-confidence-only edit could be revisited.)

NEVER-WORSE CONTRACT (the project's #113 robustness rule). NEVER raises (returns the input bytes
unchanged on ANY failure), and by construction cannot lower the pitch/duration metrics (it only
edits rests, which the scorer ignores). Additional guards keep the RENDERING never-worse too:
  - It only acts toward a CORROBORATED capacity: the declared <time> is trusted only when a strong
    majority of the piece's bars already sum to it. fusion hardcodes 4/4 even for a 2/4 piece, so
    without this guard every bar of a 2/4 score would look "half empty" and be wrongly padded; the
    corroboration check makes the module a no-op on such a piece instead.
  - It skips the FIRST and LAST measure of each part (a pickup / final bar is legitimately partial).
  - It skips any bar it cannot model simply (multiple voices, tuplets, odd backup/forward layout).
  - An overfull rest-free bar is left unchanged (shrinking a pitched note is the same unsafe guess).

PURE stdlib (xml.etree only). Runs as a worker post-transform alongside merge_to_grand_staff /
normalize_ties, and is importable with no heavy deps so the geom venv and the eval harness can call
it directly.
"""
from __future__ import annotations

import xml.etree.ElementTree as ET
from typing import Dict, List, Optional, Tuple

# Corroboration thresholds (see the module docstring). A declared capacity C is TRUSTED for repair
# only when, among the piece's simple bars declared at C, at least EXACT_MIN of them already sum
# EXACTLY to C and at most OVER_MAX of them OVERFLOW C, with at least MIN_BARS bars to judge from.
# This confirms the time signature is real before we repair its outliers, and makes the module a
# clean no-op on a piece whose declared meter does not match its content (e.g. fusion's hardcoded
# 4/4 on a 2/4 score). Tuned on the 4 real eval pieces; conservative by design.
DEFAULT_EXACT_MIN = 0.5
DEFAULT_OVER_MAX = 0.2
DEFAULT_MIN_BARS = 4


def _int_text(el: Optional[ET.Element], default: Optional[int] = None) -> Optional[int]:
    """Parse an element's text as an int, or return default on missing/garbage."""
    if el is None or el.text is None:
        return default
    try:
        return int(el.text.strip())
    except (ValueError, AttributeError):
        return default


def _clef_sign(part: ET.Element) -> Optional[str]:
    """First clef <sign> in a part, upper-cased (G/F), or None. Decides a part's default staff
    when its notes carry no explicit <staff> (Clarity's 2-part shape)."""
    sign = part.find(".//clef/sign")
    if sign is not None and sign.text:
        return sign.text.strip().upper()
    return None


def _capacity(beats: Optional[int], beat_type: Optional[int], divisions: int) -> Optional[int]:
    """Bar capacity in native divisions ticks: beats * (4/beat_type) quarters * divisions
    ticks-per-quarter = beats * 4 * divisions / beat_type. None if any input is missing/garbage
    or the result is not an exact integer (we never guess a fractional capacity)."""
    if not beats or not beat_type or beat_type <= 0 or divisions <= 0:
        return None
    num = beats * 4 * divisions
    if num % beat_type != 0:
        return None
    return num // beat_type


class _Slot:
    """One onset slot (a single note or a whole chord) within a (measure, staff) voice.

    elems    : the <note> element(s); a chord has >1, all sharing one duration.
    dur      : the slot's duration in the document's native divisions ticks.
    is_rest  : True if the slot is a rest (no pitch); only rests are ever resized.
    """

    __slots__ = ("elems", "dur", "is_rest")

    def __init__(self, elem: ET.Element, dur: int, is_rest: bool):
        self.elems = [elem]
        self.dur = dur
        self.is_rest = is_rest


class _Bar:
    """A (part, measure, staff) cell's single-voice content, plus the context to edit it safely."""

    __slots__ = ("slots", "fill", "capacity", "staff", "voices", "complex", "measure_el",
                 "backup_el", "part_idx", "measure_idx")

    def __init__(self, staff: int, capacity: Optional[int], measure_el: ET.Element,
                 part_idx: int, measure_idx: int):
        self.slots: List[_Slot] = []
        self.fill = 0
        self.capacity = capacity
        self.staff = staff
        self.voices: set = set()
        self.complex = False
        self.measure_el = measure_el
        self.backup_el: Optional[ET.Element] = None
        self.part_idx = part_idx
        self.measure_idx = measure_idx


def _parse_measure(measure_el: ET.Element, part_default_staff: int, capacity: Optional[int],
                   part_idx: int, measure_idx: int) -> Tuple[Dict[int, _Bar], bool]:
    """Lower one <measure> into {staff: _Bar}. Returns (bars, simple_layout).

    simple_layout is False when the measure's structure is not the plain grand-staff shape we can
    edit safely (more than one <backup>, any <forward>, or a <backup> with no following staff-2
    notes). A staff with more than one distinct <voice> is flagged complex on its own bar so the
    repairer skips just that staff.
    """
    bars: Dict[int, _Bar] = {}
    last_slot: Dict[int, Optional[_Slot]] = {}
    backup_count = 0
    forward_count = 0
    backup_el: Optional[ET.Element] = None
    saw_note_after_backup = False

    def bar_for(staff: int) -> _Bar:
        b = bars.get(staff)
        if b is None:
            b = _Bar(staff, capacity, measure_el, part_idx, measure_idx)
            bars[staff] = b
        return b

    for child in list(measure_el):
        tag = child.tag
        if tag == "backup":
            backup_count += 1
            backup_el = child
            continue
        if tag == "forward":
            forward_count += 1
            continue
        if tag != "note":
            continue
        if child.find("grace") is not None:
            # Grace notes consume no metrical time; ignore them entirely.
            continue
        if backup_count >= 1:
            saw_note_after_backup = True

        explicit = _int_text(child.find("staff"))
        staff = explicit if explicit in (1, 2) else part_default_staff
        bar = bar_for(staff)

        voice = child.findtext("voice")
        bar.voices.add(voice)
        if child.find("time-modification") is not None:
            bar.complex = True  # tuplet: our simple-ratio model does not apply.

        dur = _int_text(child.find("duration"), 0) or 0
        is_chord = child.find("chord") is not None
        is_rest = child.find("rest") is not None

        if is_chord and last_slot.get(staff) is not None:
            slot = last_slot[staff]
            slot.elems.append(child)
            # A chord member shares the slot duration and does not advance fill.
            continue

        slot = _Slot(child, dur, is_rest)
        bar.slots.append(slot)
        bar.fill += dur
        last_slot[staff] = slot

    # A staff with >1 real voice cannot be summed as a single line: flag it.
    for bar in bars.values():
        if len({v for v in bar.voices if v is not None}) > 1:
            bar.complex = True
        bar.backup_el = backup_el

    simple_layout = (
        backup_count <= 1
        and forward_count == 0
        and not (backup_count == 1 and not saw_note_after_backup)
    )
    return bars, simple_layout


def _collect_bars(root: ET.Element, skip_first_last: bool) -> List[_Bar]:
    """Walk every part/measure and return the repairable _Bar cells (simple layout, non-complex,
    known capacity). Running <divisions>/<time> persist across measures until re-declared. When
    skip_first_last is set, the first and last measure of each part are excluded (anacrusis / final
    bar are legitimately partial)."""
    out: List[_Bar] = []
    for part_idx, part in enumerate(root.findall("part")):
        part_default_staff = 2 if _clef_sign(part) == "F" else 1
        measures = part.findall("measure")
        divisions = 0
        beats: Optional[int] = None
        beat_type: Optional[int] = None
        last_idx = len(measures) - 1
        for measure_idx, measure in enumerate(measures):
            attrs = measure.find("attributes")
            if attrs is not None:
                d = _int_text(attrs.find("divisions"))
                if d and d > 0:
                    divisions = d
                t = attrs.find("time")
                if t is not None:
                    b = _int_text(t.find("beats"))
                    bt = _int_text(t.find("beat-type"))
                    if b:
                        beats = b
                    if bt:
                        beat_type = bt
            capacity = _capacity(beats, beat_type, divisions) if divisions > 0 else None
            bars, simple_layout = _parse_measure(
                measure, part_default_staff, capacity, part_idx, measure_idx
            )
            if skip_first_last and (measure_idx == 0 or measure_idx == last_idx):
                continue
            if not simple_layout:
                continue
            for bar in bars.values():
                if bar.complex or bar.capacity is None or not bar.slots:
                    continue
                out.append(bar)
    return out


def _trusted_capacities(bars: List[_Bar], exact_min: float, over_max: float,
                        min_bars: int) -> set:
    """The set of capacity values worth repairing toward. A capacity C is trusted only when, among
    the bars declared at C, at least exact_min already sum EXACTLY to C and at most over_max
    overflow it, with at least min_bars samples. This confirms the declared meter matches the
    content before we touch any outlier (see the module docstring)."""
    by_cap: Dict[int, List[_Bar]] = {}
    for bar in bars:
        by_cap.setdefault(bar.capacity, []).append(bar)
    trusted = set()
    for cap, group in by_cap.items():
        n = len(group)
        if n < min_bars:
            continue
        exact = sum(1 for b in group if b.fill == cap)
        over = sum(1 for b in group if b.fill > cap)
        if exact / n >= exact_min and over / n <= over_max:
            trusted.add(cap)
    return trusted


def _set_slot_duration(slot: _Slot, new_dur: int) -> None:
    """Rewrite every member element's <duration> to new_dur and drop the now-stale <type>/<dot>
    shape markup so the renderer re-derives the note/rest shape from duration + divisions (mirrors
    reconcile._apply_duration). Only ever called on a REST slot."""
    for note in slot.elems:
        dur_el = note.find("duration")
        if dur_el is not None:
            dur_el.text = str(new_dur)
        for tag in ("type", "dot"):
            for stale in note.findall(tag):
                note.remove(stale)
    slot.dur = new_dur


def _pick_rest_slot(bar: _Bar, deficit: int) -> Optional[_Slot]:
    """The rest slot to resize to absorb the deficit, or None if a rest cannot do it. A short bar
    (deficit > 0) grows its last rest. An overfull bar (deficit < 0) needs a rest big enough to
    shrink to >= 0, so it picks the LARGEST rest and only if that rest can absorb the overflow."""
    rests = [s for s in bar.slots if s.is_rest]
    if not rests:
        return None
    if deficit >= 0:
        return rests[-1]
    biggest = max(rests, key=lambda s: s.dur)
    return biggest if biggest.dur + deficit >= 0 else None


def _remove_slot(bar: _Bar, slot: _Slot) -> None:
    """Remove a slot's element(s) from the measure (used when a rest shrinks to zero duration)."""
    for el in slot.elems:
        try:
            bar.measure_el.remove(el)
        except ValueError:
            pass


def _build_rest(duration: int, staff: int) -> ET.Element:
    """A minimal <note><rest/><duration/><staff/> element (no <type>: the renderer derives it)."""
    note = ET.Element("note")
    ET.SubElement(note, "rest")
    ET.SubElement(note, "duration").text = str(duration)
    ET.SubElement(note, "staff").text = str(staff)
    return note


def _append_staff_rest(bar: _Bar, duration: int) -> None:
    """Append a trailing rest of the given duration to this bar's staff, at the end of that staff's
    stream. Staff 1 ends at the cross-staff <backup>, so its rest is inserted BEFORE the backup;
    staff 2 (and any backup-less measure) ends at the measure end, so its rest is appended there.
    The backup is adjusted by the caller via _fix_backup."""
    rest = _build_rest(duration, bar.staff)
    if bar.staff == 1 and bar.backup_el is not None:
        try:
            idx = list(bar.measure_el).index(bar.backup_el)
            bar.measure_el.insert(idx, rest)
            return
        except ValueError:
            pass
    bar.measure_el.append(rest)


def _fix_backup(bar: _Bar, delta: int) -> None:
    """A change of +delta ticks to staff 1's fill must add +delta to the cross-staff <backup> so
    staff 2 still rewinds to the measure start. Staff 2 has no following backup, so nothing to do."""
    if bar.staff != 1 or bar.backup_el is None or delta == 0:
        return
    dur_el = bar.backup_el.find("duration")
    cur = _int_text(dur_el)
    if dur_el is not None and cur is not None and cur + delta > 0:
        dur_el.text = str(cur + delta)


def _repair_bar(bar: _Bar) -> bool:
    """Complete one flagged bar PITCH-SAFELY. Returns True if the bar was changed.

    Each step closes the deficit exactly, so the staff-1 fill change is always == deficit, which is
    what _fix_backup adds to the cross-staff backup:
      - a bar with a rest big enough: grow / shrink (or remove) that rest to absorb the deficit;
      - a SHORT rest-free bar: pad with a trailing rest (the missing time shown as silence).
    Everything else (an overfull rest-free bar, or a rest too small to absorb an overflow) is left
    UNCHANGED: the only alternative is editing a pitched note's duration, which the measured
    diagnostic showed regresses real transcriptions (see the module docstring)."""
    deficit = bar.capacity - bar.fill
    if deficit == 0:
        return False

    rest_slot = _pick_rest_slot(bar, deficit)
    if rest_slot is not None:
        # Pitch-safe: grow / shrink the rest to absorb the deficit. A rest shrunk exactly to zero
        # is removed; _pick_rest_slot already refused any rest that would go negative.
        new_rest = rest_slot.dur + deficit
        if new_rest > 0:
            _set_slot_duration(rest_slot, new_rest)
        else:
            _remove_slot(bar, rest_slot)
        _fix_backup(bar, deficit)
        return True

    if deficit > 0 and not any(s.is_rest for s in bar.slots):
        # Short and rest-free: pad with a trailing rest. This never touches a pitched note, so it
        # cannot regress pitch/duration accuracy; it only makes the bar metrically whole so it
        # renders at its true width with correct timing.
        _append_staff_rest(bar, deficit)
        _fix_backup(bar, deficit)
        return True

    return False


def repair_measure_durations(
    xml_bytes,
    exact_min: float = DEFAULT_EXACT_MIN,
    over_max: float = DEFAULT_OVER_MAX,
    min_bars: int = DEFAULT_MIN_BARS,
    skip_first_last: bool = True,
) -> bytes:
    """Repair measures whose per-staff durations do not sum to the (corroborated) time signature.

    Returns the repaired MusicXML bytes, or the ORIGINAL bytes unchanged when nothing was repaired
    or on ANY failure (never-raise). See the module docstring for the full safety contract.
    """
    try:
        if not xml_bytes:
            return xml_bytes
        root = ET.fromstring(xml_bytes)
    except Exception:
        return xml_bytes

    try:
        bars = _collect_bars(root, skip_first_last)
        if not bars:
            return xml_bytes
        trusted = _trusted_capacities(bars, exact_min, over_max, min_bars)
        if not trusted:
            return xml_bytes

        changed = False
        for bar in bars:
            if bar.capacity not in trusted:
                continue
            if bar.fill == bar.capacity:
                continue
            try:
                if _repair_bar(bar):
                    changed = True
            except Exception:
                # One bad bar must never abort the others or the document.
                continue

        if not changed:
            return xml_bytes
        return ET.tostring(root, encoding="utf-8", xml_declaration=True)
    except Exception:
        return xml_bytes
