#!/usr/bin/env python3
"""Ensemble OMR reconciliation core (Slice 2): a PURE, stdlib-only module that lowers
each engine's MusicXML into a comparable NoteEvent model and ALIGNS the two streams.

Design: see the "ENSEMBLE OMR DESIGN" entries in docs/context/tech-lead.md. The pipeline
will eventually be: run both engines -> reconcile(clarity_bytes, oemer_bytes) ->
merge_to_grand_staff -> normalize_ties -> put_object. THIS slice is ONLY the analyzable
core (`to_events` + `align`); it is NOT wired into worker.py, so it carries zero prod risk.

Two engines emit MusicXML in DIFFERENT shapes and DIFFERENT time bases:
  - oemer:   one <part> with two <staff>s; notes carry <staff>1/2.
  - Clarity: two <part>s (no <staff>), one per hand; the hand is decided by the part's
             first clef sign (G -> treble/staff 1, F -> bass/staff 2).
They also use different <divisions> (ticks per quarter note). To compare onsets/durations
as plain integers we scale BOTH engines onto a COMMON tick base = lcm(div_a, div_b).

Robustness contract (matches the worker post-transforms, the #113 rule): NEVER raise on
malformed input. On ANY parse failure `to_events` returns [] so a later caller can degrade
gracefully (fall back to a single engine's output).

stdlib only: xml.etree.ElementTree, math, dataclasses. NO new dependencies.
"""

from __future__ import annotations

import math
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from typing import List, Optional, Set, Tuple

# Onset-match tolerance, expressed as a FRACTION of a quarter note (a "beat"). Two notes in
# the same (measure, staff) cell whose normalized onsets differ by <= EPS_BEATS * base ticks
# are alignment candidates. ~1/8 beat absorbs small rounding/quantization differences between
# the engines without merging genuinely distinct onsets (a sixteenth note is 1/4 beat, well
# above this window). The absolute tick tolerance is derived per-pair from the common base
# (see `_eps_ticks`) so it scales with whatever divisions the two engines used.
EPS_BEATS = 0.125

# Pitch reference for tuple comparison: a NoteEvent's pitch is (step, alter, octave) with
# alter an int (0 for natural) so "C natural" and "C" with an absent <alter> compare equal.
Pitch = Tuple[str, int, int]


@dataclass
class NoteEvent:
    """One note (or rest) lowered onto the COMMON tick base, comparable across engines.

    measure   : measure number (int; defaults to running index if <measure number> absent).
    onset     : tick offset of this note WITHIN its measure, on the common tick base.
    staff     : 1 = RH/treble, 2 = LH/bass.
    pitch     : (step, alter, octave) or None for a rest.
    duration  : note duration on the common tick base.
    is_chord  : True if this note is a <chord/> member (shares the previous note's onset).
    tie       : set of {'start','stop'} parsed from <tie type=...>.
    src       : engine label ("clarity" | "oemer") for provenance + tiebreaks.
    base      : the document tick base (ticks per quarter note) onset/duration are expressed
                in. align() uses this to rescale BOTH engines onto a shared base; carrying it
                explicitly is exact, vs recovering it from a gcd of onsets (which a sub-beat
                note would corrupt). compare=False so it does not affect event equality.
    elem      : the ORIGINAL <note> element. The winner's REAL element is emitted later so
                Clarity's tie/spelling markup survives; never re-synthesize from the tuple.
    """

    measure: int
    onset: int
    staff: int
    pitch: Optional[Pitch]
    duration: int
    is_chord: bool
    tie: Set[str] = field(default_factory=set)
    src: str = ""
    base: int = field(default=1, compare=False)
    # ElementTree Element is not hashable/comparable in a useful way; keep it out of repr
    # and exclude from equality so two NoteEvents compare on their musical content only.
    elem: Optional[ET.Element] = field(default=None, repr=False, compare=False)


# --- MusicXML lowering helpers -----------------------------------------------------------


def _clef_sign(el: ET.Element) -> Optional[str]:
    """First clef <sign> text under an element (a <part> or a <measure>), upper-cased, or
    None. Decides treble (G) vs bass (F). Mirrors worker._clef_sign_of_part; kept here so
    reconcile.py imports nothing from worker.py (which pulls in boto3). worker.py can import
    THIS in a later slice to stay DRY."""
    sign = el.find(".//clef/sign")
    if sign is not None and sign.text:
        return sign.text.strip().upper()
    return None


def _int_text(el: Optional[ET.Element], default: Optional[int] = None) -> Optional[int]:
    """Parse an element's text as an int, or return default on missing/garbage."""
    if el is None or el.text is None:
        return default
    try:
        return int(el.text.strip())
    except (ValueError, AttributeError):
        return default


def _pitch_of(note: ET.Element) -> Optional[Pitch]:
    """(step, alter, octave) for a note, or None for a rest. alter defaults to 0 so a
    natural with no <alter> compares equal to an explicit <alter>0</alter>."""
    pitch = note.find("pitch")
    if pitch is None:
        return None
    step = pitch.findtext("step")
    octave = _int_text(pitch.find("octave"))
    alter = _int_text(pitch.find("alter"), 0) or 0
    if step is None or octave is None:
        return None
    return (step.strip().upper(), alter, octave)


def _ties_of(note: ET.Element) -> Set[str]:
    """The set of <tie type=...> values on a note (subset of {'start','stop'})."""
    out: Set[str] = set()
    for tie in note.findall("tie"):
        t = tie.get("type")
        if t in ("start", "stop"):
            out.add(t)
    return out


def _measure_number(measure: ET.Element, fallback: int) -> int:
    """The measure's <measure number="N">, or a running fallback index if absent/garbage."""
    raw = measure.get("number")
    if raw is None:
        return fallback
    try:
        return int(raw.strip())
    except (ValueError, AttributeError):
        return fallback


def _divisions_in(measure: ET.Element) -> Optional[int]:
    """A <divisions> declared inside this measure's <attributes>, or None. divisions can
    change mid-part (per the spec it persists until re-declared), so we track it per measure."""
    div = measure.find("attributes/divisions")
    return _int_text(div)


def _all_divisions(root: ET.Element) -> List[int]:
    """Every positive <divisions> anywhere in the document, in document order. Used to seed
    the running divisions and to compute the common tick base across BOTH engines."""
    out: List[int] = []
    for div in root.iter("divisions"):
        v = _int_text(div)
        if v and v > 0:
            out.append(v)
    return out


def _staff_for_note(note: ET.Element, part_default_staff: int) -> int:
    """The note's staff: its explicit <staff> if present (oemer's shape), else the part's
    clef-derived default (Clarity's 2-part shape). Clamp to {1,2}; anything else -> the
    part default (we only model a two-staff grand staff)."""
    explicit = _int_text(note.find("staff"))
    if explicit in (1, 2):
        return explicit
    return part_default_staff


def _events_for_part(
    part: ET.Element,
    src: str,
    seed_divisions: int,
) -> List[Tuple[NoteEvent, int]]:
    """Lower one <part> into (NoteEvent, own_divisions) pairs. own_divisions is carried so
    the caller can scale onset/duration to the common base AFTER it knows both engines'
    divisions. Onsets/durations here are still in the PART's own tick base.

    Cursor math (generalizes worker._measure_duration to track POSITION, not just total):
      - a non-chord note advances the cursor by its <duration>;
      - a <chord/> member shares the PREVIOUS note's onset and does NOT advance the cursor;
      - <backup>/<forward> move the cursor back/forward by their <duration>.
    """
    out: List[Tuple[NoteEvent, int]] = []
    # The part's default staff comes from its first clef sign (Clarity has no <staff>).
    part_default_staff = 2 if _clef_sign(part) == "F" else 1

    divisions = seed_divisions if seed_divisions and seed_divisions > 0 else 1

    for running_index, measure in enumerate(part.findall("measure"), start=1):
        # divisions can be re-declared inside a measure; it persists once set.
        measure_div = _divisions_in(measure)
        if measure_div and measure_div > 0:
            divisions = measure_div

        number = _measure_number(measure, running_index)
        cursor = 0
        prev_onset = 0

        for child in list(measure):
            tag = child.tag
            if tag == "backup":
                cursor -= _int_text(child.find("duration"), 0) or 0
                if cursor < 0:
                    cursor = 0
                continue
            if tag == "forward":
                cursor += _int_text(child.find("duration"), 0) or 0
                continue
            if tag != "note":
                continue

            note = child
            is_chord = note.find("chord") is not None
            dur = _int_text(note.find("duration"), 0) or 0
            onset = prev_onset if is_chord else cursor

            event = NoteEvent(
                measure=number,
                onset=onset,
                staff=_staff_for_note(note, part_default_staff),
                pitch=_pitch_of(note),
                duration=dur,
                is_chord=is_chord,
                tie=_ties_of(note),
                src=src,
                elem=note,
            )
            out.append((event, divisions))

            if not is_chord:
                prev_onset = cursor
                cursor += dur
            # chord members keep prev_onset and do not move the cursor.

    return out


def to_events(xml_bytes, src: str = "") -> List[NoteEvent]:
    """Lower one engine's MusicXML into a list of NoteEvent on a per-DOCUMENT common tick
    base = lcm of every <divisions> in this document, so onsets/durations within ONE engine
    are already comparable integers. (align() further rescales BOTH engines onto a shared
    base when they differ.)

    Robustness: returns [] on ANY parse failure (malformed XML, etc) so a later caller can
    degrade gracefully. NEVER raises.

    src labels provenance ("clarity"/"oemer"); it is copied onto every NoteEvent.
    """
    try:
        root = ET.fromstring(xml_bytes)
    except Exception:
        return []

    try:
        doc_divs = _all_divisions(root) or [1]
        # A single document can carry multiple divisions (per-part or per-measure changes).
        # Lower everything onto this document's own lcm first; align() then bridges the two
        # documents. seed_divisions is the FIRST positive divisions; per-measure changes
        # override it as the cursor walks (see _events_for_part).
        seed = doc_divs[0]

        raw: List[Tuple[NoteEvent, int]] = []
        for part in root.findall("part"):
            raw.extend(_events_for_part(part, src, seed))

        if not raw:
            return []

        # Scale every event onto THIS document's common base so onsets are comparable even
        # if divisions changed mid-document.
        per_event_divs = [d for _, d in raw if d and d > 0] or [1]
        doc_base = _lcm_all(set(per_event_divs))

        events: List[NoteEvent] = []
        for event, own_div in raw:
            own = own_div if own_div and own_div > 0 else 1
            scale = doc_base // own
            event.onset *= scale
            event.duration *= scale
            event.base = doc_base
            events.append(event)
        return events
    except Exception:
        # Robustness contract: a structurally surprising document degrades to "no events"
        # rather than raising into a future caller.
        return []


def _lcm(a: int, b: int) -> int:
    if a <= 0:
        return b
    if b <= 0:
        return a
    return a * b // math.gcd(a, b)


def _lcm_all(values) -> int:
    base = 1
    for v in values:
        if v and v > 0:
            base = _lcm(base, v)
    return base or 1


# --- Alignment ---------------------------------------------------------------------------


def align(events_a: List[NoteEvent], events_b: List[NoteEvent]):
    """Align two engines' NoteEvent streams. Returns:
        {"matched": [(a, b), ...], "only_a": [...], "only_b": [...]}

    Strategy:
      1. Bring both streams onto a SHARED tick base. to_events scaled each document onto its
         OWN lcm base (recorded on NoteEvent.base), which can still differ between engines
         (e.g. 16 vs 4). Rescale both onto lcm(base_a, base_b) so onsets are directly
         comparable integers.
      2. Group both streams by (measure, staff) cell.
      3. Within each cell, GREEDY nearest-onset matching (tolerance EPS_BEATS of a beat),
         preferring an exact-pitch match when onsets tie. A matched pair = both engines saw a
         note in the same slot (the pitches may DISAGREE: that lands in `matched`, to be voted
         on by a later slice). Unmatched events bucket into only_a / only_b.

    This does NOT resolve conflicts; it only buckets them (Slice 2 scope).
    """
    base_a = _stream_base(events_a)
    base_b = _stream_base(events_b)
    common = _lcm(base_a, base_b)

    a_scaled = _rescale_stream(events_a, common // base_a)
    b_scaled = _rescale_stream(events_b, common // base_b)

    # eps in the common base: a fraction of a beat (a quarter note = `common` ticks since the
    # base IS ticks-per-quarter after rescale).
    eps = max(1, int(round(EPS_BEATS * common)))

    matched: List[Tuple[NoteEvent, NoteEvent]] = []
    only_a: List[NoteEvent] = []
    only_b: List[NoteEvent] = []

    cells_a = _group_by_cell(a_scaled)
    cells_b = _group_by_cell(b_scaled)

    for cell in sorted(set(cells_a) | set(cells_b)):
        list_a = cells_a.get(cell, [])
        list_b = cells_b.get(cell, [])
        cell_matched, cell_only_a, cell_only_b = _match_cell(list_a, list_b, eps)
        matched.extend(cell_matched)
        only_a.extend(cell_only_a)
        only_b.extend(cell_only_b)

    return {"matched": matched, "only_a": only_a, "only_b": only_b}


def _stream_base(events: List[NoteEvent]) -> int:
    """The stream's tick base (ticks per quarter note). to_events records the document's
    lcm-of-divisions base on every NoteEvent.base, so we read it directly rather than
    recovering it from a gcd of onsets (a sub-beat note, e.g. a grace/jitter at an odd tick,
    would corrupt the gcd). All events in one to_events call share a base; take the lcm of
    whatever is present to be safe with hand-built mixed inputs. Empty -> 1."""
    return _lcm_all({e.base for e in events if e.base and e.base > 0}) if events else 1


def _rescale_stream(events: List[NoteEvent], scale: int) -> List[NoteEvent]:
    """Return copies of events with onset/duration multiplied by scale (1 = identity).
    Copies so callers' inputs are not mutated; keeps the same elem reference."""
    if scale == 1:
        return list(events)
    out: List[NoteEvent] = []
    for e in events:
        out.append(
            NoteEvent(
                measure=e.measure,
                onset=e.onset * scale,
                staff=e.staff,
                pitch=e.pitch,
                duration=e.duration * scale,
                is_chord=e.is_chord,
                tie=set(e.tie),
                src=e.src,
                base=e.base * scale,
                elem=e.elem,
            )
        )
    return out


def _group_by_cell(events: List[NoteEvent]):
    """Bucket events by (measure, staff). Preserves input order within a cell."""
    cells = {}
    for e in events:
        cells.setdefault((e.measure, e.staff), []).append(e)
    return cells


def _match_cell(list_a, list_b, eps):
    """Greedy nearest-onset matching within one (measure, staff) cell.

    For each A event (in onset order) pick the unused B event with the smallest onset
    distance within eps; among equally-close B candidates prefer one whose pitch matches
    exactly (so a coincident same-pitch note beats a same-onset different-pitch note). A
    matched pair may still DISAGREE on pitch (both engines placed a note in the slot but read
    a different pitch): that is intentionally bucketed in `matched` for a later voting slice.
    Unmatched A -> only_a, unused B -> only_b.
    """
    matched: List[Tuple[NoteEvent, NoteEvent]] = []
    only_a: List[NoteEvent] = []
    used_b = set()

    a_sorted = sorted(range(len(list_a)), key=lambda i: list_a[i].onset)

    for ai in a_sorted:
        a = list_a[ai]
        best_bi = None
        best_key = None  # (onset_distance, pitch_mismatch) lower is better
        for bi, b in enumerate(list_b):
            if bi in used_b:
                continue
            dist = abs(b.onset - a.onset)
            if dist > eps:
                continue
            pitch_mismatch = 0 if (b.pitch == a.pitch) else 1
            key = (dist, pitch_mismatch)
            if best_key is None or key < best_key:
                best_key = key
                best_bi = bi
        if best_bi is None:
            only_a.append(a)
        else:
            used_b.add(best_bi)
            matched.append((a, list_b[best_bi]))

    only_b = [b for bi, b in enumerate(list_b) if bi not in used_b]
    return matched, only_a, only_b
