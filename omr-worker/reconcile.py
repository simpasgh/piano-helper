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
import os
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


# --- Sub-gates (Slice 4) -----------------------------------------------------------------
# The two RISKIEST conflict classes ship behind their OWN env flags so each can be disabled
# independently if QA shows a regression, WITHOUT touching the safe A/B/E path. Both default
# OFF and both ALSO require OMR_ENSEMBLE to be on (reconcile is only ever called when ensemble
# is enabled, but we re-check here so the helpers are honest on their own and a stray
# OMR_ENSEMBLE_TIMING=1 with OMR_ENSEMBLE unset is a no-op). Same truthy parsing as
# worker.ensemble_enabled ("1"/"true", case-insensitive, whitespace-tolerant).
OMR_ENSEMBLE_ENV = "OMR_ENSEMBLE"
OMR_ENSEMBLE_TIMING_ENV = "OMR_ENSEMBLE_TIMING"  # class D (timing mismatch)
OMR_ENSEMBLE_ADD_ENV = "OMR_ENSEMBLE_ADD"  # class C oemer-only ADD
OMR_ENSEMBLE_REFEREE_ENV = "OMR_ENSEMBLE_REFEREE"  # class B residual visual-diff referee


def _flag_on(name: str) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return False
    return raw.strip().lower() in ("1", "true")


def ensemble_enabled() -> bool:
    """True when OMR_ENSEMBLE is truthy. Mirrors worker.ensemble_enabled so reconcile can
    self-gate the Slice-4 sub-classes without importing worker (which pulls in boto3)."""
    return _flag_on(OMR_ENSEMBLE_ENV)


def timing_enabled() -> bool:
    """Class D (timing mismatch) sub-gate. OFF unless OMR_ENSEMBLE_TIMING is truthy AND the
    parent OMR_ENSEMBLE is also on. With just OMR_ENSEMBLE=1 (Slice-3 behavior) class D stays
    a no-op; it activates only when this specific sub-gate is also set."""
    return ensemble_enabled() and _flag_on(OMR_ENSEMBLE_TIMING_ENV)


def add_enabled() -> bool:
    """Class C oemer-only ADD sub-gate (the closest thing to fabrication, gated hardest). OFF
    unless OMR_ENSEMBLE_ADD is truthy AND the parent OMR_ENSEMBLE is also on. With just
    OMR_ENSEMBLE=1 oemer-only notes stay dropped (Slice-3 behavior)."""
    return ensemble_enabled() and _flag_on(OMR_ENSEMBLE_ADD_ENV)


def referee_enabled() -> bool:
    """Class B residual visual-diff referee sub-gate (Slice 6b). OFF unless
    OMR_ENSEMBLE_REFEREE is truthy AND the parent OMR_ENSEMBLE is also on. With just
    OMR_ENSEMBLE=1 the referee is never called; class-B disputes the heuristics cannot
    separate stay tiebroken to Clarity (Slice-3 behavior)."""
    return ensemble_enabled() and _flag_on(OMR_ENSEMBLE_REFEREE_ENV)


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
      3. Within each cell, GLOBAL OPTIMAL ASSIGNMENT keyed on BOTH onset and pitch (tolerance
         EPS_BEATS of a beat). A matched pair = both engines saw a note in the same slot (the
         pitches may DISAGREE: that lands in `matched`, to be voted on by a later slice).
         Unmatched events bucket into only_a / only_b. The earlier GREEDY nearest-onset matcher
         is kept as a never-raise fallback (_match_cell_greedy).

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
    """Match events within one (measure, staff) cell by GLOBAL OPTIMAL ASSIGNMENT keyed on
    BOTH onset and pitch.

    The original GREEDY nearest-onset matcher mispairs DENSE runs: when two Clarity notes and
    two oemer notes fall inside the eps window in a SWAPPED pitch order (e.g. Clarity [G5, B4]
    vs oemer [B4, G5] at near-coincident onsets), greedy locks each Clarity note to the
    onset-nearest oemer note and MANUFACTURES an A->B / B->A pitch-swap PAIR of phantom disputes
    when the correct pairing (G5<->G5, B4<->B4) makes both engines AGREE. Downstream the
    visual-diff referee then crops the WRONG (neighbor) oemer notehead and confidently confirms
    the swap (the Reverie regression; see docs/context/tech-lead.md 2026-06-02 Slice 6c entry).

    Fix: among all pairs whose onsets are within eps (the eligibility window, UNCHANGED), pick
    the assignment that MINIMIZES total cost, with cost = pitch_distance * (eps + 1) +
    onset_distance so pitch agreement DOMINATES onset proximity inside the window (a single
    semitone outweighs the whole eps onset window). This pairs like-pitch with like-pitch when
    the engines merely disagree on micro-timing, eliminating the phantom swap disputes, while
    still matching a genuine same-onset pitch dispute (its only eligible partner) as class B.
    Cardinality is maximized first (matching is always preferred to leaving a note unmatched
    within eps, exactly as greedy did), cost broken among the max-cardinality matchings.

    A matched pair may still DISAGREE on pitch (class B, voted later). Unmatched A -> only_a,
    unused B -> only_b (feeding the class C/D paths). NEVER raises: on ANY failure it falls back
    to the original greedy matching so align() degrades rather than throwing.
    """
    try:
        return _match_cell_optimal(list_a, list_b, eps)
    except Exception:
        return _match_cell_greedy(list_a, list_b, eps)


def _pair_cost(a: NoteEvent, b: NoteEvent, pitch_w: int) -> int:
    """Cost of pairing A with B: pitch distance (in semitones) dominates onset distance. A
    rest/garbage-vs-note pair is priced at 128 semitones (just above the 127-semitone piano
    span) so a note->note pairing is always preferred to note->rest when both are eligible; a
    rest-vs-rest pair costs only its onset distance. PURE."""
    onset_dist = abs(a.onset - b.onset)
    midi_a = _pitch_to_midi(a.pitch)
    midi_b = _pitch_to_midi(b.pitch)
    if midi_a is None and midi_b is None:
        pitch_dist = 0
    elif midi_a is None or midi_b is None:
        pitch_dist = 128
    else:
        pitch_dist = abs(midi_a - midi_b)
    return pitch_dist * pitch_w + onset_dist


def _match_cell_optimal(list_a, list_b, eps):
    """Minimal-cost maximum-cardinality assignment within one (measure, staff) cell. See
    _match_cell for the rationale. Returns (matched_pairs, only_a, only_b)."""
    n = len(list_a)
    m = len(list_b)
    if n == 0:
        return [], [], list(list_b)
    if m == 0:
        return [], list(list_a), []

    # pitch_w makes one semitone of pitch distance outweigh the entire eps onset window, so the
    # assignment first minimizes total pitch distance, then breaks ties by onset proximity.
    pitch_w = eps + 1
    max_real = 128 * pitch_w + eps  # max real pairing cost (rest-vs-note = 128 semitones).
    # Unmatch penalty: matching ANY eligible pair (cost <= max_real) must beat unmatching both
    # ends (2 * unmatch), so unmatch > max_real / 2; max_real + 1 guarantees it and preserves
    # greedy's "always match within eps" behavior (incl. an octave dispute, the slot's only
    # partner). Ineligible (onset beyond eps) pairs are priced so high the optimizer always
    # prefers unmatching both ends over using one.
    unmatch = max_real + 1
    big = unmatch * (n + m + 2)

    # Pad to a square: each real A also gets a dedicated "unmatched" dummy column (n+i), each
    # real B a dedicated dummy row (n+j); dummy-vs-dummy is free. A finite perfect matching
    # therefore always exists, and a min-cost one matches as many eligible real pairs as
    # possible (every real edge saves ~unmatch over leaving both ends unmatched).
    size = n + m
    cost = [[0] * size for _ in range(size)]
    for i in range(size):
        a_real = i < n
        for j in range(size):
            b_real = j < m
            if a_real and b_real:
                a = list_a[i]
                b = list_b[j]
                cost[i][j] = (
                    _pair_cost(a, b, pitch_w)
                    if abs(a.onset - b.onset) <= eps
                    else big
                )
            elif a_real and not b_real:
                cost[i][j] = unmatch if (j - m) == i else big
            elif (not a_real) and b_real:
                cost[i][j] = unmatch if (i - n) == j else big
            else:
                cost[i][j] = 0

    assign = _hungarian(cost)  # assign[i] = column matched to row i.

    matched_idx: List[Tuple[int, NoteEvent, NoteEvent]] = []
    only_a: List[NoteEvent] = []
    used_b = set()
    for i in range(n):
        j = assign[i]
        if j < m and cost[i][j] < big:
            matched_idx.append((i, list_a[i], list_b[j]))
            used_b.add(j)
        else:
            only_a.append(list_a[i])
    only_b = [list_b[j] for j in range(m) if j not in used_b]

    # Stable order: matched by A onset then A index (mirrors greedy's onset-ordered output).
    matched_idx.sort(key=lambda t: (t[1].onset, t[0]))
    matched = [(a, b) for _, a, b in matched_idx]
    return matched, only_a, only_b


def _hungarian(cost):
    """Minimal-cost perfect assignment on a SQUARE integer cost matrix (Kuhn-Munkres with
    potentials, O(n^3)). Returns `assign` where assign[i] = column matched to row i. Pure
    stdlib. Called only on the square padded matrix _match_cell_optimal builds."""
    n = len(cost)
    if n == 0:
        return []
    # A sentinel strictly larger than any reachable reduced cost (sum of all |entries| + 1).
    inf = 1
    for row in cost:
        for c in row:
            inf += abs(c)

    u = [0] * (n + 1)
    v = [0] * (n + 1)
    p = [0] * (n + 1)  # p[j] = row assigned to column j (1-based); p[0] = scratch row.
    way = [0] * (n + 1)
    for i in range(1, n + 1):
        p[0] = i
        j0 = 0
        minv = [inf] * (n + 1)
        used = [False] * (n + 1)
        while True:
            used[j0] = True
            i0 = p[j0]
            delta = inf
            j1 = -1
            for j in range(1, n + 1):
                if not used[j]:
                    cur = cost[i0 - 1][j - 1] - u[i0] - v[j]
                    if cur < minv[j]:
                        minv[j] = cur
                        way[j] = j0
                    if minv[j] < delta:
                        delta = minv[j]
                        j1 = j
            for j in range(n + 1):
                if used[j]:
                    u[p[j]] += delta
                    v[j] -= delta
                else:
                    minv[j] -= delta
            j0 = j1
            if p[j0] == 0:
                break
        while j0:
            j1 = way[j0]
            p[j0] = p[j1]
            j0 = j1

    assign = [0] * n
    for j in range(1, n + 1):
        if p[j] != 0:
            assign[p[j] - 1] = j - 1
    return assign


def _match_cell_greedy(list_a, list_b, eps):
    """Greedy nearest-onset matching within one (measure, staff) cell. KEPT as the never-raise
    fallback for _match_cell (and the historical reference behavior).

    For each A event (in onset order) pick the unused B event with the smallest onset
    distance within eps; among equally-close B candidates prefer one whose pitch matches
    exactly. A matched pair may still DISAGREE on pitch. Unmatched A -> only_a, unused B ->
    only_b. NOTE: this mispairs swapped dense runs (the reason _match_cell now defaults to the
    optimal assignment); see _match_cell's docstring.
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


# --- Reconciliation (Slice 3) ------------------------------------------------------------
# Wire reconcile() into worker.process_job BEHIND the OMR_ENSEMBLE flag, ONLY when both
# engines produced output. It takes the PRIMARY (Clarity) document as the SKELETON and, per
# matched (measure,staff) slot, emits the winner's REAL <note> element so Clarity's
# tie/spelling markup survives. ONLY the safe conflict classes are resolved here:
#   A (agree): keep Clarity.
#   B (pitch mismatch, same onset/staff): vote with FREE heuristics, tiebreak Clarity.
#   E (duration mismatch on a matched onset+pitch): metric-completeness vote, tiebreak Clarity.
#   C (note in one engine only) and D (timing mismatch): DO NOTHING this slice. See TODO(slice4).
#
# CRITICAL SAFETY: every heuristic tiebreaks to Clarity. The reconciled output must never be
# WORSE than Clarity-alone on Clarity-good inputs. When in doubt, keep Clarity.
#
# Robustness contract (the #113 rule): NEVER raise. On ANY failure (parse, align, vote) return
# primary_bytes unchanged. Empty/None secondary -> primary_bytes (single-engine pass-through).

MIDI_MIN = 21  # A0, lowest piano key
MIDI_MAX = 108  # C8, highest piano key

# Expected tessitura center per staff, as a MIDI note. Used only as a tiebreak prior when one
# class-B candidate is an implausible octave jump: RH/staff1 ~C5 (72), LH/staff2 ~C3 (48).
_STAFF_TESSITURA = {1: 72, 2: 48}

_STEP_SEMITONE = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}

# Major-key diatonic pitch classes by <fifths>. Index by fifths (-7..7) -> set of the 7
# diatonic pitch classes (0..11). A note whose pitch class is in the set is diatonic to the
# key; a lone non-diatonic alter is more likely an OMR misread than a real chromatic note.
_MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11]  # C major pitch classes


def _pitch_to_midi(pitch: Optional[Pitch]) -> Optional[int]:
    """MIDI number for a (step, alter, octave) pitch, or None for a rest/garbage."""
    if pitch is None:
        return None
    step, alter, octave = pitch
    base = _STEP_SEMITONE.get((step or "").upper())
    if base is None:
        return None
    return (octave + 1) * 12 + base + (alter or 0)


def _fifths_of(root: ET.Element) -> int:
    """The score's first <key><fifths>, or 0 (C major / no key) on missing/garbage. A single
    free prior: which pitch classes are diatonic. We do not model per-measure key changes
    (a later refinement); the first key is a good-enough prior for the diatonicity vote."""
    f = root.find(".//key/fifths")
    v = _int_text(f, 0)
    return v if v is not None else 0


def _diatonic_pitch_classes(fifths: int) -> Set[int]:
    """The 7 diatonic pitch classes (0..11) of the MAJOR key with this <fifths>. The major
    tonic pitch class is (fifths * 7) mod 12 (a fifth = 7 semitones up per sharp)."""
    tonic = (fifths * 7) % 12
    return {(tonic + d) % 12 for d in _MAJOR_SCALE}


def _is_diatonic(pitch: Optional[Pitch], diatonic_pcs: Set[int]) -> bool:
    midi = _pitch_to_midi(pitch)
    if midi is None:
        return False
    return (midi % 12) in diatonic_pcs


def _in_range(pitch: Optional[Pitch]) -> bool:
    midi = _pitch_to_midi(pitch)
    return midi is not None and MIDI_MIN <= midi <= MIDI_MAX


def _vote_pitch(
    clarity: NoteEvent,
    oemer: NoteEvent,
    diatonic_pcs: Set[int],
    prev_midi: Optional[int],
) -> NoteEvent:
    """Class B: same onset/staff, DIFFERENT pitch. Vote CONSERVATIVELY: oemer may override the
    Clarity primary ONLY on a STRONG positive signal. Everything else tiebreaks to Clarity, so
    on a clean diatonic piece (where every candidate is in range and diatonic) class B makes ~0
    changes, which is exactly never-worse-than-Clarity.

    Strong signals (the ONLY two that can override Clarity), in order:
      (1) range hard-reject: a candidate outside MIDI 21..108 cannot be a real piano pitch, so
          if exactly one is in range that one wins.
      (2) key-signature diatonicity: if oemer is diatonic AND Clarity is non-diatonic, oemer
          wins (a lone non-diatonic alter in Clarity is likely a misread accidental/ledger).
    Symmetrically, if Clarity is diatonic and oemer is not, Clarity wins.

    DELIBERATELY REMOVED (2026-06-02, QA finding on the Icarus score): the voice-leading prior
    ("smaller melodic interval wins") and the octave/tessitura prior. Both are SPECULATIVE and
    on clean input where Clarity is correct they OVERRODE correct Clarity readings with oemer's
    wrong pitch (3 regressions, 0 corrections on Icarus). The bar for any override is now: would
    this flip a CORRECT Clarity note on clean diatonic input? If yes, it is removed.

    The (4) tie tiebreak and (5) final fallback both resolve to Clarity (the primary).
    """
    c_mid = _pitch_to_midi(clarity.pitch)
    o_mid = _pitch_to_midi(oemer.pitch)

    # (1) range sanity as a hard reject: a pitch outside the piano cannot be right.
    c_ok = c_mid is not None and MIDI_MIN <= c_mid <= MIDI_MAX
    o_ok = o_mid is not None and MIDI_MIN <= o_mid <= MIDI_MAX
    if c_ok and not o_ok:
        return clarity
    if o_ok and not c_ok:
        return oemer
    if not c_ok and not o_ok:
        return clarity  # both garbage -> keep Clarity

    # (2) key-signature diatonicity: a lone non-diatonic candidate loses. This is the one
    # positive signal strong enough to override Clarity (oemer diatonic, Clarity not -> oemer).
    c_dia = (c_mid % 12) in diatonic_pcs
    o_dia = (o_mid % 12) in diatonic_pcs
    if c_dia and not o_dia:
        return clarity
    if o_dia and not c_dia:
        return oemer

    # No strong positive signal separated the pair (both in range, both diatonic-or-both-not):
    # tiebreak to Clarity (the primary). We do NOT use voice-leading or tessitura here; on clean
    # input they regress correct Clarity notes (see the docstring).
    return clarity


def _pitch_vote_is_residual(
    clarity: NoteEvent,
    oemer: NoteEvent,
    diatonic_pcs: Set[int],
    prev_midi: Optional[int],
) -> bool:
    """True when the FREE class-B heuristics in _vote_pitch could NOT confidently SEPARATE the
    two candidates and only fell through to the Clarity tiebreak: both in range AND both diatonic
    (or both non-diatonic). This is the LOW-CONFIDENCE residual the Slice-6 design routes to the
    visual-diff referee (both candidates are plausible, so the cheap priors cannot decide). PURE;
    mirrors the exact branch order of _vote_pitch so the two never disagree on what "residual"
    means.

    NOTE (2026-06-02): the octave-jump and voice-leading branches were REMOVED from _vote_pitch
    (they regressed correct Clarity notes on clean input), so they are removed here too. The
    `prev_midi` parameter is kept for signature compatibility with the caller but is unused.

    Returns False (NOT residual) whenever a heuristic WOULD have separated the pair, so a
    confidently-decided dispute never reaches the referee. Never raises.
    """
    try:
        c_mid = _pitch_to_midi(clarity.pitch)
        o_mid = _pitch_to_midi(oemer.pitch)

        # (1) range: if range separates (or both garbage) it is decided, not residual.
        c_ok = c_mid is not None and MIDI_MIN <= c_mid <= MIDI_MAX
        o_ok = o_mid is not None and MIDI_MIN <= o_mid <= MIDI_MAX
        if not (c_ok and o_ok):
            return False  # range decided it (or both garbage -> Clarity by other path).

        # (2) diatonicity: if exactly one is diatonic it is decided.
        c_dia = (c_mid % 12) in diatonic_pcs
        o_dia = (o_mid % 12) in diatonic_pcs
        if c_dia != o_dia:
            return False

        # Nothing separated them: the heuristics only had the Clarity tiebreak -> residual.
        return True
    except Exception:
        return False


def _vote_duration(
    clarity: NoteEvent,
    oemer: NoteEvent,
    measure_capacity_ticks: Optional[int],
    clarity_cell_sum: int,
) -> NoteEvent:
    """Class E: matched onset+pitch, DIFFERENT duration. Prefer the duration that keeps the
    bar metrically complete vs <time>; tiebreak the LONGER one IF it does not overflow the
    measure; Clarity tie-chains ALWAYS win. Every uncertain branch tiebreaks to Clarity.

    clarity_cell_sum is the summed duration of the OTHER non-chord Clarity notes in this cell
    (excluding this note), so completeness is judged with each candidate substituted in.
    """
    # Clarity tie-chains always win (a tie is a deliberate duration signal).
    if clarity.tie:
        return clarity

    c_dur = clarity.duration
    o_dur = oemer.duration
    if c_dur == o_dur:
        return clarity

    if measure_capacity_ticks is not None and measure_capacity_ticks > 0:
        c_total = clarity_cell_sum + c_dur
        o_total = clarity_cell_sum + o_dur
        c_complete = c_total == measure_capacity_ticks
        o_complete = o_total == measure_capacity_ticks
        # Prefer the candidate that makes the bar EXACTLY complete.
        if c_complete and not o_complete:
            return clarity
        if o_complete and not c_complete:
            return oemer
        # Neither (or both) hits exact completeness: prefer the LONGER duration only if it
        # does not OVERFLOW the measure (held notes are under-read more often than over-read).
        longer = clarity if c_dur >= o_dur else oemer
        longer_total = clarity_cell_sum + longer.duration
        if longer_total <= measure_capacity_ticks:
            return longer
        # The longer one overflows -> keep Clarity (do not introduce an overflow).
        return clarity

    # No usable <time>: tiebreak Clarity.
    return clarity


def _apply_pitch(clarity_elem: ET.Element, oemer_elem: ET.Element) -> bool:
    """Class-B winner = oemer: adopt ONLY oemer's <pitch> into the Clarity element, in place.

    We deliberately do NOT swap the whole oemer element. Doing so would drag in oemer's native
    <duration> (a different <divisions> base than the Clarity document we are serializing) and
    oemer's <chord/> membership (oemer may list the same chord's notes in a different order, so
    the matched member can be oemer's chord ROOT with no <chord/>). Either corrupts the Clarity
    skeleton's timing and can make the output WORSE than Clarity-alone. A pitch vote must change
    pitch ONLY, so we replace just the <pitch> child and leave duration/chord/type/ties/staff.

    Returns True if the pitch was replaced. Falls back to no-op (keep Clarity) if either element
    lacks a <pitch> (e.g. a rest), which the caller already guards against."""
    import copy

    new_pitch = oemer_elem.find("pitch")
    old_pitch = clarity_elem.find("pitch")
    if new_pitch is None or old_pitch is None:
        return False
    children = list(clarity_elem)
    idx = children.index(old_pitch)
    clarity_elem.remove(old_pitch)
    clarity_elem.insert(idx, copy.deepcopy(new_pitch))
    # A pitch correction can invalidate Clarity's printed accidental hint, but <accidental> is a
    # display-only courtesy element; leaving it would show the wrong glyph. Drop a stale one so
    # the renderer derives the accidental from the new <pitch>/<alter> instead.
    stale = clarity_elem.find("accidental")
    if stale is not None:
        clarity_elem.remove(stale)
    return True


def _apply_duration(clarity_ev: NoteEvent, oemer_ev: NoteEvent) -> bool:
    """Class-E winner = oemer: set the Clarity element's <duration> to oemer's WINNING duration,
    expressed in the CLARITY DOCUMENT's own tick base (not oemer's, not the common align base).

    clarity_ev.duration / oemer_ev.duration are align()'s COMMON-base values; the Clarity
    element's text is in the Clarity document's native base. We scale by the Clarity element's
    native-to-common ratio so the written tick count is correct for THIS document. <type> is the
    visual note shape; once the tick duration changes it would be stale, so we drop it and let
    the renderer derive the note shape from <duration> + <divisions>.

    Returns True if the duration was rewritten; no-op (keep Clarity) on any degenerate ratio."""
    elem = clarity_ev.elem
    if elem is None:
        return False
    dur_el = elem.find("duration")
    native_clarity = _int_text(dur_el)
    if dur_el is None or native_clarity is None or native_clarity <= 0:
        return False
    common_clarity = clarity_ev.duration
    if common_clarity <= 0:
        return False
    # native_winner = oemer_common * (native_clarity / common_clarity). Require an exact integer
    # so we never write a fractional/rounded tick count that would desync the bar.
    numerator = oemer_ev.duration * native_clarity
    if numerator % common_clarity != 0:
        return False
    native_winner = numerator // common_clarity
    if native_winner <= 0:
        return False
    dur_el.text = str(native_winner)
    stale_type = elem.find("type")
    if stale_type is not None:
        elem.remove(stale_type)
    return True


# --- Class B residual: visual-diff referee (Slice 6b, gated by referee_enabled) ----------
# When the FREE heuristics in _vote_pitch cannot confidently separate a class-B pitch dispute
# (the LOW-CONFIDENCE residual: both candidates diatonic + in range, so the cheap priors do
# not decide) AND the dispute is in the referee's PROVEN scope (isolated notehead, interval
# >= a third), consult the visual-diff referee on the ORIGINAL input PDF to break the tie.
# Heuristics FIRST; the referee is a residual tiebreaker only. Behind OMR_ENSEMBLE_REFEREE,
# default OFF (and requires OMR_ENSEMBLE). Never-worse-than-Clarity is preserved: the referee
# only ADJUDICATES between the two existing candidates (Clarity=A, oemer=B). It picks A, picks
# B, or DECLINES; on decline / unavailable / ANY failure we keep the heuristic result (Clarity).
# It NEVER introduces a third pitch, moves a note, or touches any other class.
#
# LOCALIZATION (Slice 6c, SOLVED via oemer's internal bboxes): the referee needs a pdf_crop +
# staff_geometry for the disputed note, i.e. a mapping from (measure, staff, onset) to a pixel
# region in the rasterized input. The Slice-6b blocker was that neither engine exposed per-note
# pixel geometry. Slice 6c removes it for the OEMER candidate (candidate B): oemer INTERNALLY
# detects each notehead's bbox + the staff-line geometry, and oemer_bbox.run_oemer_capture runs
# oemer as a LIBRARY (instead of the bare CLI) to emit, alongside the MusicXML, a BBOX INDEX:
# one row per pitched <note> in document order (parallel to to_events), keyed by
# (measure, staff, onset), carrying the notehead bbox + the 5 staff-line y's at that note's x,
# in oemer's WORKING-IMAGE pixel space. Validated on icarus.pdf: the library run's pitch
# sequence is byte-identical to the CLI, the index is 1:1 with the pitched notes, and every
# bbox overlays exactly on its glyph (see the tech-lead.md Slice 6c entry).
#
# `input_pdf` here is that bbox ARTIFACT (a dict {"working_gray": ndarray, "notes": [rows]}),
# threaded from worker.run_oemer when OMR_ENSEMBLE_REFEREE is on. We localize the OEMER note
# (oemer_ev) since the index is oemer-derived; the referee then renders BOTH candidates and
# scores which pitch's notehead POSITION matches the crop, so a Clarity-correct dispute still
# resolves to Clarity. If the artifact is absent, malformed, or the disputed note is not in the
# index (e.g. a chord member, or count drift), we DECLINE (return None) -> referee no-op ->
# Clarity stands. The validated decline-on-bad-crop guard in referee.py is the second backstop.


def _localize_dispute(input_pdf, clarity_ev, oemer_ev, primary_root, common_base):
    """Map the disputed OEMER NoteEvent to (pdf_crop, staff_geometry) using oemer's bbox index,
    or None if it cannot be localized confidently. `input_pdf` must be the bbox artifact dict
    from oemer_bbox.run_oemer_capture; a bare raster (no index) -> None (decline). NEVER raises.

    The crop is a generous neighborhood around the notehead from oemer's working-image gray
    (0=ink, 1=white, the polarity referee.render_candidate / _original_band expect); the
    staff_geometry's `lines` + `x_center` are translated into crop-local coordinates."""
    try:
        if not isinstance(input_pdf, dict):
            return None  # legacy bare-raster path has no per-note index -> decline.
        working_gray = input_pdf.get("working_gray")
        rows = input_pdf.get("notes")
        if working_gray is None or not rows:
            return None

        row = _bbox_row_for(rows, oemer_ev, common_base)
        if row is None:
            return None  # disputed note not uniquely localizable in the index -> decline.

        lines = [float(v) for v in row["lines"]]
        if len(lines) < 5:
            return None
        sp = (lines[4] - lines[0]) / 4.0
        if sp <= 0:
            return None

        bbox = row["bbox"]
        x_center = float(row["x_center"])

        # Crop a generous staff-relative band around the notehead: referee._original_band re-crops
        # to its exact band from `lines` + `x_center`, so we just need a window that comfortably
        # contains the staff + several ledger spaces and a notehead-width of horizontal context.
        h, w = working_gray.shape
        pad_x = int(round(sp * 3))
        y0 = int(round(lines[0] - 8 * sp))
        y1 = int(round(lines[4] + 8 * sp))
        x0 = int(round(x_center - pad_x))
        x1 = int(round(x_center + pad_x))
        y0, y1 = max(0, y0), min(h, y1)
        x0, x1 = max(0, x0), min(w, x1)
        if y1 - y0 < 5 or x1 - x0 < 5:
            return None

        crop = working_gray[y0:y1, x0:x1]
        staff_geometry = {
            "lines": [ly - y0 for ly in lines],
            "x_center": x_center - x0,
        }
        return crop, staff_geometry
    except Exception:
        return None


def _bbox_row_for(rows, oemer_ev, common_base):
    """Find the bbox-index row for the disputed oemer NoteEvent by (measure, staff, onset),
    rescaling the row's onset (recorded on the row's own base) to the align common base so the
    keys compare. Returns the row only if EXACTLY ONE pitched, non-chord row matches (an
    isolated slot); otherwise None (decline). NEVER raises."""
    try:
        matches = []
        for r in rows:
            if r.get("is_chord"):
                continue  # chords are out of the referee's isolated-notehead scope.
            if r.get("measure") != oemer_ev.measure or r.get("staff") != oemer_ev.staff:
                continue
            row_base = r.get("base") or 1
            row_onset = r.get("onset", 0)
            if row_base != common_base and row_base > 0:
                scaled = row_onset * common_base
                if scaled % row_base != 0:
                    continue
                row_onset = scaled // row_base
            if row_onset == oemer_ev.onset:
                matches.append(r)
        if len(matches) == 1:
            return matches[0]
        return None
    except Exception:
        return None


def _referee_onset_coincides(clarity_ev, oemer_ev) -> bool:
    """DECLINE-GUARD (belt-and-suspenders for the align() pairing fix): True only when the
    matched pair sits at effectively the SAME onset (within HALF the eps window). A genuine
    pitch dispute keeps the onset (only the pitch is misread); a non-trivial onset gap is the
    fingerprint of a dense-run MISPAIR (align matched within tolerance), where the referee
    would crop oemer's neighbor and confidently confirm a swapped pitch. With the optimal
    assignment this is rare, but declining when the onsets do not coincide keeps the referee
    never-worse: a wrong confident arbitration is worse than a decline. PURE; never raises.

    clarity_ev/oemer_ev are align()'s rescaled copies, so both onsets and .base are already on
    the shared common base and directly comparable."""
    try:
        base = clarity_ev.base or oemer_ev.base or 1
        eps = max(1, int(round(EPS_BEATS * base)))
        return abs(clarity_ev.onset - oemer_ev.onset) * 2 <= eps
    except Exception:
        return False


def _maybe_referee_pitch(
    input_pdf,
    clarity_ev,
    oemer_ev,
    primary_root,
    common_base,
    is_isolated,
) -> Optional[NoteEvent]:
    """Consult the visual-diff referee on a residual class-B pitch dispute. Returns the WINNING
    NoteEvent (clarity_ev or oemer_ev) only if the referee makes a confident pick; returns None
    to DECLINE (keep the heuristic result) on out-of-scope, unavailable, no-localization, or ANY
    failure. NEVER raises.

    Safety: the referee only chooses between the two EXISTING candidates. candidate A = Clarity,
    candidate B = oemer (the validated referee_pick contract: 'a'->A, 'b'->B, None->decline).
    """
    if input_pdf is None:
        return None
    try:
        # Lazy, guarded import: referee.py guards its own verovio/cairosvg deps and exposes
        # REFEREE_AVAILABLE. reconcile.py stays stdlib-only when the referee is never imported
        # (the pure path), so the pure tests need no verovio. A failed import -> decline.
        import referee  # noqa: E402
    except Exception:
        return None
    try:
        if not getattr(referee, "REFEREE_AVAILABLE", False):
            return None  # verovio/cairosvg absent on this worker -> referee is a no-op.

        # Scope gate (PURE, cheap, BEFORE any render/localization): isolated-notehead pitch
        # dispute of an octave or a third-or-larger interval. Out of scope -> never call referee.
        interval = referee.pitch_interval_semitones(clarity_ev.pitch, oemer_ev.pitch)
        if not referee.is_refereeable_dispute(
            interval, is_isolated=is_isolated, is_pitch_dispute=True
        ):
            return None

        # Decline-guard: if the matched pair's onsets do not coincide, the pairing is suspect
        # (a dense-run mispair the optimal assignment may not have fully resolved). Crop the
        # neighbor and we would confirm a swap; keep Clarity instead.
        if not _referee_onset_coincides(clarity_ev, oemer_ev):
            return None

        localized = _localize_dispute(
            input_pdf, clarity_ev, oemer_ev, primary_root, common_base
        )
        if localized is None:
            return None  # cannot localize the note in the original raster -> decline.
        pdf_crop, staff_geometry = localized

        clef = "F" if clarity_ev.staff == 2 else "G"

        def _render(ev):
            step, alter, octave = ev.pitch
            return referee.render_candidate(step, octave, clef=clef, alter=alter)

        candidate_a = _render(clarity_ev)  # A = Clarity
        candidate_b = _render(oemer_ev)  # B = oemer
        pick = referee.referee_pick(pdf_crop, staff_geometry, candidate_a, candidate_b)
        if pick == "a":
            return clarity_ev
        if pick == "b":
            return oemer_ev
        return None  # decline -> keep the heuristic result (Clarity).
    except Exception:
        return None


def reconcile(primary_bytes, secondary_bytes, input_pdf=None) -> bytes:
    """Reconcile two engines' MusicXML into one, using the PRIMARY (Clarity) document as the
    skeleton and resolving ONLY the safe conflict classes A/B/E with FREE heuristics. The
    winner's REAL <note> element is emitted per matched slot so Clarity's tie/spelling markup
    is preserved. Classes C (one-engine-only) and D (timing mismatch) are NOT touched here
    (Slice 4); Clarity's notes are kept as-is and oemer-only notes are ignored.

    `input_pdf` (Slice 6b, OPTIONAL, default None) is the rasterized original input passed to the
    visual-diff referee for residual class-B disputes. It is used ONLY when OMR_ENSEMBLE_REFEREE
    is on; when the arg is None or the sub-gate is off, behavior is byte-identical to before (the
    referee path is never entered). Current callers that pass nothing get exactly the old behavior.

    Robustness: NEVER raises. Returns primary_bytes unchanged on ANY failure or when there is
    no secondary (single-engine pass-through = no regression vs Slice 1).
    """
    if not secondary_bytes:
        # Single-engine pass-through: feed Clarity straight to the post-transforms.
        return primary_bytes

    try:
        # Parse the PRIMARY into the tree we will serialize. to_events(primary) returns events
        # whose .elem refs point into THIS root, so swapping an element in-place changes the
        # serialized output. We re-parse here (not reuse to_events' internal root) so we own
        # the exact root object whose children the primary events reference.
        primary_root = ET.fromstring(primary_bytes)
    except Exception:
        return primary_bytes

    try:
        primary_events = _events_from_root(primary_root, "clarity")
        secondary_events = to_events(secondary_bytes, "oemer")
        if not primary_events or not secondary_events:
            # Nothing comparable on one side -> keep Clarity untouched.
            return primary_bytes

        result = align(primary_events, secondary_events)
        matched = result["matched"]
        if not matched:
            return primary_bytes

        diatonic_pcs = _diatonic_pitch_classes(_fifths_of(primary_root))

        # Common base used by align() to scale onsets/durations: lcm of the two stream bases.
        # The matched events are align()'s rescaled COPIES, so their durations are already on
        # this common base; we derive the measure capacity in the same base for the class-E vote.
        base_primary = _stream_base(primary_events)
        base_secondary = _stream_base(secondary_events)
        common_base = _lcm(base_primary, base_secondary)
        capacity_ticks = _measure_capacity_ticks(primary_root, common_base)

        # Track previous same-staff Clarity MIDI per cell for the voice-leading prior, and the
        # per-cell summed Clarity duration (non-chord) for the metric-completeness vote.
        prev_midi_by_cell = {}
        cell_dur_sum = _cell_duration_sums(primary_events)
        # Per (measure, staff, onset) slot -> set of Clarity MIDI pitches present, for the class-B
        # duplicate guard: a pitch swap must never create a chord with two identical pitches.
        onset_slot_midis = _onset_slot_midis(primary_events)

        # The visual-diff referee fires ONLY on residual class-B disputes and ONLY when its
        # sub-gate is on; compute the gate ONCE so the matched loop just consults a bool. When
        # off (or no input_pdf), the referee branch is never entered = byte-identical to before.
        use_referee = input_pdf is not None and referee_enabled()
        # Isolation map: a (measure, staff, onset) slot is "isolated" only if exactly ONE pitched
        # Clarity note sits there (no chord stack, no coincident note). The referee's validated
        # scope is isolated noteheads only; a dense/chorded slot is never refereeable.
        isolated_slots = _isolated_slots(primary_events) if use_referee else None
        # Dense-run map: slots inside a beamed sub-quarter run. The referee's validated scope
        # EXCLUDES dense/beamed regions (Slice 5 GO/NO-GO): there the two engines often disagree
        # on note ORDER, and the position-based referee crops by oemer's order-drifted bbox and
        # confidently confirms a swapped pitch (the Reverie regression, tech-lead.md 2026-06-02).
        # Every eighth in a run passes the isolation test (one note per slot), so isolation alone
        # does NOT exclude dense runs; this map does. See _dense_run_slots.
        dense_run_slots = _dense_run_slots(primary_events) if use_referee else None

        # oemer pitched notes that aligned to a Clarity REST (a slot Clarity heard as silence):
        # these are class-C ADD candidates too (Clarity put a rest where oemer put a note), so we
        # route them to the gated ADD resolver alongside only_b. Collected during the matched loop.
        rest_slot_adds: List[NoteEvent] = []

        # Process matched pairs in (measure, staff, onset) order so voice-leading sees the
        # previous note. matched pairs are (clarity_event, oemer_event).
        ordered = sorted(
            matched,
            key=lambda pair: (pair[0].measure, pair[0].staff, pair[0].onset),
        )
        for clarity_ev, oemer_ev in ordered:
            cell = (clarity_ev.measure, clarity_ev.staff)
            prev_midi = prev_midi_by_cell.get(cell)
            # The Clarity element we may replace.
            target_elem = clarity_ev.elem

            if clarity_ev.pitch == oemer_ev.pitch:
                # Class A (agree on pitch) OR class E (same pitch, different duration).
                if (
                    clarity_ev.pitch is not None
                    and clarity_ev.duration != oemer_ev.duration
                ):
                    # Class E: duration vote (rests excluded; a rest pitch is None).
                    other_sum = cell_dur_sum.get(cell, 0)
                    if not clarity_ev.is_chord:
                        other_sum -= clarity_ev.duration
                    winner = _vote_duration(
                        clarity_ev, oemer_ev, capacity_ticks, other_sum
                    )
                    if winner is oemer_ev and target_elem is not None:
                        # Adopt ONLY oemer's duration, expressed in the Clarity document's own
                        # tick base. We must NOT copy oemer's whole element: it carries oemer's
                        # native <duration> (a different <divisions> base) and could flip the
                        # note's <chord/> membership, both of which would corrupt the Clarity
                        # skeleton's timing.
                        _apply_duration(clarity_ev, oemer_ev)
                # Class A: no change (keep Clarity's element).
            else:
                # Class B: pitch mismatch -> vote (rests never reach here as a "pitch" since a
                # rest has pitch None and would only "agree" with another rest above).
                if clarity_ev.pitch is not None and oemer_ev.pitch is not None:
                    winner = _vote_pitch(clarity_ev, oemer_ev, diatonic_pcs, prev_midi)
                    # RESIDUAL REFEREE (Slice 6b): the heuristics ran FIRST. Only when they could
                    # NOT confidently separate the pair (winner fell through to the Clarity
                    # tiebreak) do we consult the visual-diff referee, and only when its sub-gate
                    # is on and the dispute is in its proven scope (isolated notehead, interval
                    # >= a third). A referee pick of oemer overrides the Clarity tiebreak; a
                    # decline / unavailable / failure keeps the heuristic result (Clarity).
                    if (
                        use_referee
                        and winner is clarity_ev
                        and _pitch_vote_is_residual(
                            clarity_ev, oemer_ev, diatonic_pcs, prev_midi
                        )
                    ):
                        ref_slot = (
                            clarity_ev.measure,
                            clarity_ev.staff,
                            clarity_ev.onset,
                        )
                        is_isolated = bool(isolated_slots and ref_slot in isolated_slots)
                        is_dense = bool(dense_run_slots and ref_slot in dense_run_slots)
                        # Consult the referee ONLY on an isolated notehead that is NOT inside a
                        # dense/beamed run (its validated scope). A dense-run slot is declined
                        # outright (keep Clarity): the order-drift mispair there is exactly what
                        # the position-based referee cannot adjudicate.
                        if is_isolated and not is_dense:
                            ref_winner = _maybe_referee_pitch(
                                input_pdf,
                                clarity_ev,
                                oemer_ev,
                                primary_root,
                                common_base,
                                is_isolated,
                            )
                            if ref_winner is not None:
                                winner = ref_winner
                    if winner is oemer_ev and target_elem is not None:
                        # DUPLICATE GUARD: if adopting oemer's pitch would collide with ANOTHER
                        # note already at this same (measure, staff, onset) slot (a chord member
                        # or coincident note), DECLINE the swap and keep Clarity's original. We
                        # must never emit a chord with two identical pitches (e.g. {C2,G2} where
                        # the class-B path would push C2->G2, producing {G2,G2}).
                        slot = (
                            clarity_ev.measure,
                            clarity_ev.staff,
                            clarity_ev.onset,
                        )
                        new_midi = _pitch_to_midi(oemer_ev.pitch)
                        own_midi = _pitch_to_midi(clarity_ev.pitch)
                        others = onset_slot_midis.get(slot, set()) - {own_midi}
                        if new_midi is not None and new_midi in others:
                            pass  # decline: would duplicate a coincident pitch -> keep Clarity.
                        else:
                            # Adopt ONLY oemer's <pitch> into the Clarity element; keep Clarity's
                            # duration, <chord/> membership, <type>, ties and staff. A pitch vote
                            # must change pitch ONLY: swapping oemer's whole element would drag in
                            # oemer's native duration base and chord membership and break timing.
                            _apply_pitch(target_elem, oemer_ev.elem)
                elif clarity_ev.pitch is None and oemer_ev.pitch is not None:
                    # Clarity heard a REST where oemer heard a pitched note: a class-C ADD
                    # candidate (the gated ADD resolver decides whether to fill the rest's slot).
                    # We do NOT silence/add inline here; only the OMR_ENSEMBLE_ADD path may add.
                    rest_slot_adds.append(oemer_ev)
                # An oemer rest vs a Clarity note keeps Clarity (never silence a Clarity note).

            # Update the voice-leading anchor with the pitch we ENDED UP emitting. Re-read the
            # Clarity element so a class-B swap (which mutated its <pitch> in place) advances the
            # anchor to the pitch we actually emitted; on a Clarity win this reads back Clarity's
            # own pitch unchanged.
            emitted_pitch = (
                _pitch_of(target_elem) if target_elem is not None else clarity_ev.pitch
            )
            emitted_midi = _pitch_to_midi(emitted_pitch)
            if emitted_midi is not None:
                prev_midi_by_cell[cell] = emitted_midi

        # CLASS D (timing mismatch) + CLASS C (one-engine-only): the two RISKIEST classes, each
        # behind its OWN sub-gate (timing_enabled / add_enabled), both default OFF and both also
        # requiring OMR_ENSEMBLE. With just OMR_ENSEMBLE on they stay no-ops (Slice-3 behavior).
        # Class D is handled FIRST: a D pair is a same-pitch, same-cell note whose onsets differ
        # beyond eps, which align() bucketed into only_a (Clarity) + only_b (oemer). We must
        # consume those before the class-C ADD so a D-paired oemer note is NOT re-added as a
        # fabricated extra. _resolve_timing returns the oemer events it consumed (whether it
        # applied a shift or declined) so they are excluded from the class-C ADD set below.
        only_a = result["only_a"]
        only_b = result["only_b"]
        consumed_b = set()
        if timing_enabled():
            consumed_b = _resolve_timing(
                primary_root, only_a, only_b, capacity_ticks, common_base, base_primary
            )

        # CLASS C oemer-only ADD: bias HARD toward NOT adding. Add an only_b note to the Clarity
        # skeleton ONLY if ALL of: diatonic vs <fifths>, fills a genuine empty onset slot without
        # overflowing the bar, and in MIDI 21..108. Otherwise DROP (keep Clarity as-is). Clarity-
        # only notes (only_a) are KEPT by default (Clarity has better recall); we never drop them.
        if add_enabled():
            _resolve_oemer_only_adds(
                primary_root,
                only_b + rest_slot_adds,
                consumed_b,
                diatonic_pcs,
                capacity_ticks,
                common_base,
                base_primary,
            )

        return ET.tostring(primary_root, encoding="utf-8", xml_declaration=True)
    except Exception:
        # Robustness contract: any failure -> Clarity unchanged, never worse than Clarity-alone.
        return primary_bytes


def _events_from_root(root: ET.Element, src: str) -> List[NoteEvent]:
    """Like to_events but from an ALREADY-PARSED root, so the returned events' .elem refs
    point into THAT root (the one reconcile will serialize). Mirrors to_events' scaling."""
    doc_divs = _all_divisions(root) or [1]
    seed = doc_divs[0]
    raw: List[Tuple[NoteEvent, int]] = []
    for part in root.findall("part"):
        raw.extend(_events_for_part(part, src, seed))
    if not raw:
        return []
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


def _measure_capacity_ticks(root: ET.Element, common_base: int) -> Optional[int]:
    """The measure capacity in COMMON-base ticks from the first <time>, or None. A bar of
    `beats`/`beat-type` holds beats * (4 / beat-type) quarter notes; in common-base ticks
    that is beats * 4 * common_base / beat_type (common_base = ticks per quarter note)."""
    time = root.find(".//time")
    if time is None:
        return None
    beats = _int_text(time.find("beats"))
    beat_type = _int_text(time.find("beat-type"))
    if not beats or not beat_type or beat_type <= 0:
        return None
    num = beats * 4 * common_base
    if num % beat_type != 0:
        return None  # non-integer tick capacity: skip the completeness vote rather than guess.
    return num // beat_type


def _isolated_slots(events: List[NoteEvent]) -> Set[Tuple[int, int, int]]:
    """Return the set of (measure, staff, onset) slots that hold EXACTLY ONE pitched note in
    the primary (Clarity) document. The visual-diff referee's validated scope is isolated
    noteheads only: a chord stack or two coincident notes share an onset and would confuse the
    notehead localization, so any slot with >1 pitched note is NOT isolated. Rests do not count
    (a rest is not a notehead). PURE; never raises in practice (plain dict counting)."""
    counts = {}
    for e in events:
        if e.pitch is None:
            continue  # rests are not noteheads.
        key = (e.measure, e.staff, e.onset)
        counts[key] = counts.get(key, 0) + 1
    return {key for key, n in counts.items() if n == 1}


def _dense_run_slots(events: List[NoteEvent]) -> Set[Tuple[int, int, int]]:
    """Return the (measure, staff, onset) slots that sit inside a DENSE/BEAMED sub-quarter run:
    a pitched note whose nearest same-cell pitched neighbor is LESS THAN one quarter note away.

    The visual-diff referee's validated scope EXCLUDES dense/beamed regions (Slice 5 GO/NO-GO,
    tech-lead.md). In a dense run the two engines frequently disagree on note ORDER (one engine's
    onset assignment drifts by a note relative to the other), so a Clarity note gets matched to an
    oemer note the engines placed a beat-fraction apart. The referee crops by oemer's
    (order-drifted) bbox, sees a REAL but WRONG-SLOT notehead, and confidently confirms a swapped
    pitch. That is the Reverie regression (adjacent A->B / B->A swap pairs in eighth runs). The
    isolation test (one pitched note per onset slot) does NOT catch this: every eighth in a run is
    alone in its own onset slot. This map does, by neighbor spacing.

    One quarter = the event's tick base (ticks-per-quarter). These events are the primary (Clarity)
    document's, so e.base is the primary doc base, consistent with _isolated_slots which the caller
    pairs this with. An eighth-note run (gap = base/2 < base) is dense; a quarter-note line
    (gap = base, NOT < base) is not, so an isolated quarter dispute (e.g. the Icarus E6->C6
    correction) still reaches the referee. PURE; never raises in practice.
    """
    by_cell = {}
    for e in events:
        if e.pitch is None:
            continue  # rests are not noteheads.
        by_cell.setdefault((e.measure, e.staff), []).append(e)
    dense: Set[Tuple[int, int, int]] = set()
    for evs in by_cell.values():
        onsets = sorted({e.onset for e in evs})
        for e in evs:
            quarter = e.base if e.base and e.base > 0 else 1
            nearest = None
            for o in onsets:
                if o == e.onset:
                    continue
                d = abs(o - e.onset)
                if nearest is None or d < nearest:
                    nearest = d
            if nearest is not None and nearest < quarter:
                dense.add((e.measure, e.staff, e.onset))
    return dense


def _onset_slot_midis(events: List[NoteEvent]):
    """Per (measure, staff, onset) slot, the set of MIDI pitches present in the primary (Clarity)
    document. Used by the class-B duplicate guard: before adopting oemer's pitch onto a Clarity
    note, we check the new pitch would not collide with ANOTHER note already at the same slot
    (a chord member or coincident note), which would emit an invalid chord with two identical
    pitches (e.g. {C2,G2} -> {G2,G2}). PURE; never raises in practice."""
    slots = {}
    for e in events:
        midi = _pitch_to_midi(e.pitch)
        if midi is None:
            continue  # rests / garbage have no pitch to collide with.
        key = (e.measure, e.staff, e.onset)
        slots.setdefault(key, set()).add(midi)
    return slots


def _cell_duration_sums(events: List[NoteEvent]):
    """Per (measure, staff) cell, the summed duration of NON-chord notes (the cursor advance).
    Used by the class-E metric-completeness vote to judge bar fill with a candidate swapped in."""
    sums = {}
    for e in events:
        if e.is_chord:
            continue
        cell = (e.measure, e.staff)
        sums[cell] = sums.get(cell, 0) + e.duration
    return sums


# --- Class D: timing mismatch (Slice 4, gated by timing_enabled) -------------------------
# A class-D pair is a SAME-pitch, SAME-cell note the two engines placed at DIFFERENT onsets
# (beyond eps), so align() did not match them: Clarity's copy is in only_a, oemer's in only_b.
# We pick the onset that makes the measure metrically complete vs <time>, tiebreak Clarity,
# and apply ONLY when the correction is surgical (no later note shifts) - otherwise DECLINE.
#
# The single safe, surgical shape we apply: the Clarity note is the LAST event in its cell and
# is preceded by a REST. Moving its onset = resizing that one leading rest; nothing follows it,
# so NO later onset shifts. We apply this only when the current bar is INCOMPLETE and oemer's
# onset makes it EXACTLY complete (note ends at capacity). Any other shape -> decline (keep
# Clarity). A declined correction is always acceptable; a corrupted measure is not.


def _resolve_timing(primary_root, only_a, only_b, capacity_ticks, common_base, base_primary):
    """Resolve class-D timing pairs in place on the Clarity skeleton. Returns the set of id()s
    of the only_b (oemer) events CONSUMED as D pairs (whether applied or declined) so the
    class-C ADD does not re-add them as fabricated extras. NEVER raises into the caller (the
    outer reconcile try/except is the backstop, but we also guard each pair)."""
    consumed_b = set()
    if capacity_ticks is None or capacity_ticks <= 0:
        return consumed_b

    # Map each <note> element to its containing <measure> (ElementTree has no getparent), so
    # _apply_timing can resize the note's sibling rest in the correct measure.
    note_to_measure = {}
    for part in primary_root.findall("part"):
        for measure in part.findall("measure"):
            for note in measure.findall("note"):
                note_to_measure[id(note)] = measure

    # Index oemer-only notes by (measure, staff) for quick same-cell, same-pitch lookup.
    b_by_cell = {}
    for b in only_b:
        b_by_cell.setdefault((b.measure, b.staff), []).append(b)

    for a in only_a:
        if a.pitch is None:
            continue
        cell = (a.measure, a.staff)
        candidates = b_by_cell.get(cell, [])
        partner = None
        for b in candidates:
            if id(b) in consumed_b:
                continue
            if b.pitch == a.pitch and b.onset != a.onset:
                partner = b
                break
        if partner is None:
            continue

        # This is a class-D pair: consume the oemer note regardless of whether we apply, so the
        # class-C ADD never treats a D-paired note as a new fabrication.
        consumed_b.add(id(partner))

        measure = note_to_measure.get(id(a.elem)) if a.elem is not None else None
        try:
            _apply_timing(a, partner, measure, capacity_ticks, common_base, base_primary)
        except Exception:
            # Any trouble applying -> decline (keep Clarity). Never raise.
            pass

    return consumed_b


def _apply_timing(clarity_ev, oemer_ev, measure, capacity_ticks, common_base, base_primary):
    """Apply ONE class-D correction surgically, or DECLINE. Returns True if applied.

    Safe shape only: clarity_ev is the LAST <note> in its cell and is immediately preceded by a
    <rest>. Moving the note to oemer's onset = resizing that leading rest, which shifts nothing
    after it. We apply ONLY when (a) the metric-completeness vote picks oemer's onset (oemer's
    placement makes the bar exactly complete and Clarity's does not), and (b) the resized rest
    stays positive and the note then ends exactly at capacity. Otherwise decline."""
    note_elem = clarity_ev.elem
    if note_elem is None or measure is None:
        return False

    # The safe shape requires the Clarity note to be the LAST note element in the cell and to be
    # immediately preceded (in document order) by a <rest>. The cell is then [rest, note]: moving
    # the note = resizing that one leading rest, which shifts NOTHING after it.
    raw = list(measure)
    note_children = [c for c in raw if c.tag == "note"]
    if not note_children or note_children[-1] is not note_elem:
        return False
    try:
        idx = raw.index(note_elem)
    except ValueError:
        return False
    if idx == 0:
        return False
    prev = raw[idx - 1]
    if prev.tag != "note" or prev.find("rest") is None:
        return False

    # Convert the common-base onsets/durations to the Clarity document's NATIVE tick base.
    if common_base <= 0 or base_primary <= 0:
        return False
    if (oemer_ev.onset * base_primary) % common_base != 0:
        return False
    target_onset_native = (oemer_ev.onset * base_primary) // common_base
    note_dur_native = _int_text(note_elem.find("duration"))
    if note_dur_native is None or note_dur_native <= 0:
        return False
    if (capacity_ticks * base_primary) % common_base != 0:
        return False
    capacity_native = (capacity_ticks * base_primary) // common_base

    # Metric-completeness vote: oemer's onset must make the bar EXACTLY complete (note ends at
    # capacity) AND Clarity's current onset must NOT (otherwise ambiguous -> keep Clarity).
    cur_rest = _int_text(prev.find("duration"))
    if cur_rest is None or cur_rest < 0:
        return False
    # In the [rest, note] shape the note's current onset == the leading rest; current bar end =
    # cur_rest + note_dur_native.
    cur_end = cur_rest + note_dur_native
    new_end = target_onset_native + note_dur_native
    if new_end != capacity_native:
        return False  # oemer's onset does not complete the bar -> decline.
    if cur_end == capacity_native:
        return False  # bar already complete at Clarity's onset -> ambiguous, keep Clarity.

    new_rest = target_onset_native  # the resized leading rest = the note's new onset
    if new_rest <= 0:
        return False  # would delete/invert the rest -> decline rather than restructure.

    prev.find("duration").text = str(new_rest)
    # The rest's <type> (if any) is now stale; drop it so the renderer derives the shape.
    stale = prev.find("type")
    if stale is not None:
        prev.remove(stale)
    return True


# --- Class C: oemer-only ADD (Slice 4, gated by add_enabled) -----------------------------
# The closest thing to fabrication, gated HARDEST. Add an only_b (oemer-only) note ONLY if ALL
# of: diatonic vs <fifths>, fills a genuine empty onset slot without overflowing the bar, and
# in MIDI 21..108. Otherwise DROP. Bias hard toward NOT adding. Clarity-only notes are kept.


def _resolve_oemer_only_adds(
    primary_root,
    only_b,
    consumed_b,
    diatonic_pcs,
    capacity_ticks,
    common_base,
    base_primary,
):
    """Insert strongly-corroborated oemer-only notes into the Clarity skeleton, in place.
    Skips any note already consumed as a class-D pair. NEVER raises (each add is guarded)."""
    if capacity_ticks is None or capacity_ticks <= 0:
        return

    # Per (measure, staff) Clarity occupancy + fill, rebuilt from the ACTUAL primary tree (not
    # just only_a) so we never add into a slot a MATCHED Clarity note already holds. occupied =
    # onsets a PITCHED Clarity note sits on (a rest leaves the slot musically EMPTY = fillable).
    # pitched_fill = summed non-chord PITCHED duration (the bar's real note content); a gap is the
    # difference up to capacity, whether it shows as a rest or as trailing slack.
    prim_events = _events_from_root(primary_root, "clarity")
    base = _stream_base(prim_events)
    scale = (common_base // base) if base else 1
    occupied = {}
    pitched_fill = {}
    for e in prim_events:
        cell = (e.measure, e.staff)
        if e.pitch is None:
            continue  # rests do not occupy a slot for the ADD; they ARE the fillable gap.
        occupied.setdefault(cell, set()).add(e.onset * scale)
        if not e.is_chord:
            pitched_fill[cell] = pitched_fill.get(cell, 0) + e.duration * scale

    for b in only_b:
        if id(b) in consumed_b:
            continue
        try:
            _maybe_add_oemer_note(
                primary_root,
                b,
                occupied,
                pitched_fill,
                diatonic_pcs,
                capacity_ticks,
                common_base,
                base_primary,
            )
        except Exception:
            # Any trouble -> drop (keep Clarity). Never raise.
            pass


def _maybe_add_oemer_note(
    primary_root,
    b,
    occupied,
    pitched_fill,
    diatonic_pcs,
    capacity_ticks,
    common_base,
    base_primary,
):
    """Decide + apply a single oemer-only ADD. ALL gates must pass; bias hard toward dropping.

    SAFE INSERTION: we add a note ONLY where its onset slot is currently silence (a Clarity
    <rest>, or trailing slack at end-of-content). We CONSUME that silence so following content
    never shifts: the inserted note takes a rest's place (shrinking/removing the rest) or fills
    trailing space. If the target onset is not a clean silence boundary, we DROP."""
    if b.pitch is None:
        return  # never add a rest
    midi = _pitch_to_midi(b.pitch)
    if midi is None or not (MIDI_MIN <= midi <= MIDI_MAX):
        return  # gate: in MIDI range
    if (midi % 12) not in diatonic_pcs:
        return  # gate: diatonic to the key

    cell = (b.measure, b.staff)
    # gate: fills a genuine gap -> the onset slot must hold no PITCHED Clarity note.
    if b.onset in occupied.get(cell, set()):
        return
    # gate: adding it must NOT overflow the bar's PITCHED content.
    if pitched_fill.get(cell, 0) + b.duration > capacity_ticks:
        return

    part, measure, part_base = _find_part_measure_for_cell(primary_root, b.measure, b.staff)
    if measure is None or part_base is None or part_base <= 0 or common_base <= 0:
        return

    # Convert the common-base onset/duration to the Clarity document's NATIVE base.
    if (b.onset * part_base) % common_base != 0 or (b.duration * part_base) % common_base != 0:
        return  # not exactly representable in the Clarity base -> drop rather than round.
    onset_native = (b.onset * part_base) // common_base
    dur_native = (b.duration * part_base) // common_base
    if dur_native <= 0:
        return

    if not _insert_into_silence(measure, onset_native, dur_native, b):
        return  # not a clean silence slot -> drop (bias against adding).

    # Update occupancy + fill so a second add in the same cell sees this one.
    occupied.setdefault(cell, set()).add(b.onset)
    pitched_fill[cell] = pitched_fill.get(cell, 0) + b.duration


def _insert_into_silence(measure, onset_native, dur_native, b) -> bool:
    """Place a new note of dur_native at onset_native WITHOUT shifting following content, by
    consuming silence (a <rest> or trailing slack). Returns True if placed, False to DROP.

    Cases handled (all preserve every following onset):
      - the onset lands exactly on an existing <rest> whose duration >= dur_native: shrink the
        rest by dur_native (remove it if it becomes 0) and insert the note in its place;
      - the onset lands at end-of-content (append) with no following element: just append.
    Any other shape (onset mid-note, no rest, rest too short) -> DROP."""
    raw = list(measure)
    first_note_idx = None
    for i, child in enumerate(raw):
        if child.tag in ("note", "backup", "forward"):
            first_note_idx = i
            break
    if first_note_idx is None:
        # No content yet: only onset 0 is a clean boundary (append after attributes).
        if onset_native != 0:
            return False
        measure.append(_build_clarity_note(b, dur_native))
        return True

    cursor = 0
    for i in range(first_note_idx, len(raw)):
        child = raw[i]
        if cursor == onset_native:
            if child.tag == "note" and child.find("rest") is not None:
                rest_dur = _int_text(child.find("duration"))
                if rest_dur is None or rest_dur < dur_native:
                    return False  # rest too short -> dropping (don't overflow following content).
                new_note = _build_clarity_note(b, dur_native)
                measure.insert(i, new_note)
                if rest_dur == dur_native:
                    measure.remove(child)  # note exactly replaces the rest.
                else:
                    child.find("duration").text = str(rest_dur - dur_native)
                    stale = child.find("type")
                    if stale is not None:
                        child.remove(stale)
                return True
            return False  # onset sits on a pitched note / non-rest boundary -> drop.
        if child.tag == "backup":
            cursor -= _int_text(child.find("duration"), 0) or 0
            if cursor < 0:
                cursor = 0
            continue
        if child.tag == "forward":
            cursor += _int_text(child.find("duration"), 0) or 0
            continue
        if child.tag != "note":
            continue
        if child.find("chord") is None:
            cursor += _int_text(child.find("duration"), 0) or 0

    # End-of-content: append into trailing slack (capacity already checked by the caller).
    if cursor == onset_native:
        measure.append(_build_clarity_note(b, dur_native))
        return True
    return False


def _build_clarity_note(b, dur_native):
    """Build a NEW <note> for the Clarity document from oemer's event: oemer's pitch plus the
    duration scaled into the Clarity base. We SYNTHESIZE a minimal element rather than deep-copying
    oemer's whole <note> (which carries oemer's native duration base, <staff>, and shape markup);
    only the <pitch> is copied. Clarity's 2-part shape decides the hand by part clef, so we emit
    NO <staff>."""
    import copy

    note = ET.Element("note")
    src_pitch = b.elem.find("pitch") if b.elem is not None else None
    if src_pitch is not None:
        note.append(copy.deepcopy(src_pitch))
    else:
        step, alter, octave = b.pitch
        pitch = ET.SubElement(note, "pitch")
        ET.SubElement(pitch, "step").text = step
        if alter:
            ET.SubElement(pitch, "alter").text = str(alter)
        ET.SubElement(pitch, "octave").text = str(octave)
    ET.SubElement(note, "duration").text = str(dur_native)
    return note


def _find_part_measure_for_cell(root, measure_number, staff):
    """Return (part, measure_elem, part_native_base) for the (measure_number, staff) cell, or
    (None, None, None). For Clarity's 2-part shape the staff maps to the part whose first clef
    sign is G (staff 1) or F (staff 2). part_native_base is the part's lcm-of-divisions base."""
    chosen = None
    for part in root.findall("part"):
        sign = _clef_sign(part)
        part_staff = 2 if sign == "F" else 1
        if part_staff == staff:
            chosen = part
            break
    if chosen is None:
        # Single-part (oemer-style) doc: notes carry <staff>; just use the only part.
        parts = root.findall("part")
        chosen = parts[0] if parts else None
    if chosen is None:
        return None, None, None

    # part native base = lcm of divisions declared in this part (mirrors to_events scaling).
    divs = [v for v in (_int_text(d) for d in chosen.iter("divisions")) if v and v > 0]
    part_base = _lcm_all(set(divs)) if divs else 1

    for running_index, measure in enumerate(chosen.findall("measure"), start=1):
        if _measure_number(measure, running_index) == measure_number:
            return chosen, measure, part_base
    return chosen, None, part_base
