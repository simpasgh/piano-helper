#!/usr/bin/env python3
"""OMR evaluation foundation: the MEASUREMENT substrate for the own-engine ambition.

You cannot build (or honestly claim) "more accurate" without a way to measure it. This module
is engine-agnostic: it grades any MusicXML transcription against a ground-truth MusicXML, and
it generates deterministic synthetic scores (for eval volume + future training data). It is the
first rung of building our own OMR engine, and it is what produces the Gemini baseline number.

Two pieces, both PURE stdlib (reuse reconcile.to_events for parsing + llm_omr's tested MusicXML
builder for generation), so they run anywhere with no new dependency and no API key:

  score_transcription(pred_xml, truth_xml) -> metrics
      Note-level precision / recall / F1 plus chord correctness, comparing the two scores as
      multisets of (measure, staff, midi) so the metric is robust to rhythm/onset differences
      (we grade WHAT notes were read, per measure+hand, not their exact tick placement).

  generate_random_score(seed, ...) -> MusicXML bytes
      A deterministic random piano grand-staff score (the MusicXML IS its own ground truth).
      Built via llm_omr.score_json_to_musicxml so the output is always well-formed.

NEVER raises into a caller: score_transcription degrades to zeros on unparseable input.
"""

from __future__ import annotations

import random
import xml.etree.ElementTree as ET
from collections import Counter
from typing import Dict, List, Optional, Tuple

import reconcile
import llm_omr


# --- Scoring -----------------------------------------------------------------------------

def _pitched_by_cell(xml_bytes) -> Dict:
    """Parse MusicXML -> {(measure, staff): Counter of midi}. Rests ignored. Robust: returns {}
    on parse failure (reconcile.to_events already never raises)."""
    out: Dict = {}
    for e in reconcile.to_events(xml_bytes, "x"):
        midi = reconcile._pitch_to_midi(e.pitch)
        if midi is None:
            continue
        out.setdefault((e.measure, e.staff), Counter())[midi] += 1
    return out


def _dur16(duration: int, base: int) -> int:
    """Quantize a note duration to an integer number of SIXTEENTH notes, so it is comparable
    across engines that use different `<divisions>`. `base` is the document's ticks-per-quarter
    (reconcile sets `event.base` to it after lowering onto the common tick base), so a quarter
    note -> 4, half -> 8, whole -> 16, eighth -> 2, sixteenth -> 1. base <= 0 -> 0 (degrade,
    never raise). This is the rhythm signal the pitch-only `_pitched_by_cell` deliberately drops."""
    if base <= 0:
        return 0
    return int(round(duration / base * 4.0))


def _pitched_dur_by_cell(xml_bytes) -> Dict:
    """Like `_pitched_by_cell` but the multiset key is `(midi, dur16)` so the metric scores PITCH
    AND DURATION together. Rests ignored; robust to parse failure ({}). Folding the duration into
    the key means a note counts only when BOTH its pitch and its (divisions-invariant) duration
    match -- the basis for the duration_acc / note_dur_f1 rhythm scores."""
    out: Dict = {}
    for e in reconcile.to_events(xml_bytes, "x"):
        midi = reconcile._pitch_to_midi(e.pitch)
        if midi is None:
            continue
        out.setdefault((e.measure, e.staff), Counter())[(midi, _dur16(e.duration, e.base))] += 1
    return out


def _chords_by_cell(xml_bytes) -> Dict:
    """Parse MusicXML -> {(measure, staff): Counter of frozenset(midi)} of the CHORDS (onset
    slots with >= 2 pitched notes) in each measure+hand.

    Keyed by (measure, staff) and NOT by raw onset on purpose: a raw onset is a per-document
    tick (lcm of that doc's <divisions>), so two engines that read the same chord but emit
    different <divisions> would never align. Comparing the multiset of chord pitch-sets per
    measure+hand is tick-base-invariant (and matches the note metric's "grade WHAT per
    measure+hand, not exact tick placement" philosophy). A chord in the wrong beat of the right
    measure still counts; a chord moved to another measure does not."""
    onset_slots: Dict = {}
    for e in reconcile.to_events(xml_bytes, "x"):
        midi = reconcile._pitch_to_midi(e.pitch)
        if midi is None:
            continue
        onset_slots.setdefault((e.measure, e.staff, e.onset), set()).add(midi)
    cells: Dict = {}
    for (measure, staff, _onset), midis in onset_slots.items():
        if len(midis) >= 2:
            cells.setdefault((measure, staff), Counter())[frozenset(midis)] += 1
    return cells


def _chord_hit_counts(truth_chords: Dict, pred_chords: Dict) -> Tuple[int, int]:
    """Given two {(measure, staff): Counter of frozenset(midi)} chord maps (as built by
    _chords_by_cell), return (n_truth_chords, n_hits): the total truth chords, and how many of
    them appear with the EXACT pitch set in the same (measure, staff) of pred. Multiset
    intersection, so a chord present k times in truth and j times in pred contributes min(k, j)
    hits. PURE. This is the SINGLE definition of the chord-recall numerator/denominator, shared
    by score_transcription and eval_detector's micro-average so the two cannot diverge."""
    n_truth_chords = sum(sum(c.values()) for c in truth_chords.values())
    n_hits = 0
    for cell, t_sets in truth_chords.items():
        n_hits += sum((t_sets & pred_chords.get(cell, Counter())).values())
    return n_truth_chords, n_hits


def score_transcription(pred_xml, truth_xml) -> Dict:
    """Grade a predicted MusicXML transcription against a ground-truth MusicXML.

    Returns a dict:
      note_precision/recall/f1 : note-level, comparing (measure, staff, midi) MULTISETS (so a
        right note in the right measure+hand counts even if the rhythm/onset differs). NOTE:
        midi is exact incl. octave (C4 != C5, an octave error is a full miss), and duration is
        NOT scored (a right pitch with the wrong duration still counts). This is a pitch-accuracy
        metric, not a full transcription score.
      n_truth / n_pred / n_matched : the underlying counts.
      chord_recall : fraction of TRUTH chords (>=2 notes at one onset) whose exact pitch set
        appears in the same (measure, staff) of the prediction. Tick-base-invariant (keyed by
        measure+hand, not raw onset), so a different <divisions> does not falsely zero it.
        1.0 if there are no truth chords.
      per_measure : per (measure, staff) {truth, pred, matched} note counts, for inspection.

    Engine-agnostic and never raises; unparseable input yields zeros.
    """
    try:
        truth = _pitched_by_cell(truth_xml)
        pred = _pitched_by_cell(pred_xml)

        cells = set(truth) | set(pred)
        n_truth = n_pred = n_matched = 0
        per_measure: List[Dict] = []
        for cell in sorted(cells):
            t = truth.get(cell, Counter())
            p = pred.get(cell, Counter())
            matched = sum((t & p).values())
            tn, pn = sum(t.values()), sum(p.values())
            n_truth += tn
            n_pred += pn
            n_matched += matched
            per_measure.append(
                {"measure": cell[0], "staff": cell[1], "truth": tn, "pred": pn, "matched": matched}
            )

        # 0 when the denominator is 0 (nothing predicted / nothing to match, incl. garbage
        # input that parses to no notes) - the documented "degrade to zeros" contract.
        precision = n_matched / n_pred if n_pred else 0.0
        recall = n_matched / n_truth if n_truth else 0.0
        f1 = (2 * precision * recall / (precision + recall)) if (precision + recall) else 0.0

        truth_chords = _chords_by_cell(truth_xml)
        pred_chords = _chords_by_cell(pred_xml)
        n_truth_chords, chord_hits = _chord_hit_counts(truth_chords, pred_chords)
        chord_recall = chord_hits / n_truth_chords if n_truth_chords else 1.0

        # RHYTHM: re-grade folding DURATION into the key (midi, dur16). A note matches only when
        # its pitch AND duration are both right, so this is the full-transcription score the
        # pitch-only note_* metrics deliberately omit. note_dur_f1 is the strict P/R/F1;
        # duration_acc is "of the notes read with the right pitch, the fraction also read with the
        # right duration" (parallels octave_acc), which isolates rhythm from pitch.
        truth_d = _pitched_dur_by_cell(truth_xml)
        pred_d = _pitched_dur_by_cell(pred_xml)
        n_dur_matched = 0
        for cell in set(truth_d) | set(pred_d):
            n_dur_matched += sum((truth_d.get(cell, Counter()) & pred_d.get(cell, Counter())).values())
        dur_precision = n_dur_matched / n_pred if n_pred else 0.0
        dur_recall = n_dur_matched / n_truth if n_truth else 0.0
        dur_f1 = (2 * dur_precision * dur_recall / (dur_precision + dur_recall)) if (dur_precision + dur_recall) else 0.0
        duration_acc = n_dur_matched / n_matched if n_matched else 0.0

        return {
            "note_precision": round(precision, 4),
            "note_recall": round(recall, 4),
            "note_f1": round(f1, 4),
            "note_dur_f1": round(dur_f1, 4),
            "duration_acc": round(duration_acc, 4),
            "n_dur_matched": n_dur_matched,
            "n_truth": n_truth,
            "n_pred": n_pred,
            "n_matched": n_matched,
            "chord_recall": round(chord_recall, 4),
            "n_truth_chords": n_truth_chords,
            "per_measure": per_measure,
        }
    except Exception:
        return {
            "note_precision": 0.0,
            "note_recall": 0.0,
            "note_f1": 0.0,
            "note_dur_f1": 0.0,
            "duration_acc": 0.0,
            "n_dur_matched": 0,
            "n_truth": 0,
            "n_pred": 0,
            "n_matched": 0,
            "chord_recall": 0.0,
            "n_truth_chords": 0,
            "per_measure": [],
        }


# --- Synthetic score generation (deterministic; the MusicXML is its own ground truth) -----

# Diatonic scale-degree -> semitone offset within an octave (major), for building in-key pitches.
_MAJOR = [0, 2, 4, 5, 7, 9, 11]
_PC_TO_STEP_ALTER = {
    0: ("C", 0), 1: ("C", 1), 2: ("D", 0), 3: ("E", -1), 4: ("E", 0), 5: ("F", 0),
    6: ("F", 1), 7: ("G", 0), 8: ("A", -1), 9: ("A", 0), 10: ("B", -1), 11: ("B", 0),
}


def _midi_to_pitch(midi: int) -> Dict:
    pc = midi % 12
    octave = midi // 12 - 1
    step, alter = _PC_TO_STEP_ALTER[pc]
    return {"step": step, "alter": alter, "octave": octave}


def mscx_to_truth_musicxml(mscx) -> Optional[bytes]:
    """Convert a MuseScore uncompressed score (.mscx XML, bytes or str) into ground-truth
    MusicXML the scorer can consume. This is the bridge from OUR ground-truth format (the
    composer's .mscz -> unzip -> .mscx) to score_transcription.

    We read Staff id=1 (treble) and id=2 (bass), and per <Measure> collect each <Chord> as one
    event carrying all its <Note><pitch> MIDI values (so real chords stay chords). Rests and
    durations are dropped (the note/chord metrics ignore rhythm), each event gets duration=1,
    and the result is built via the tested llm_omr builder so it is always well-formed. Returns
    None on any failure (e.g. not a .mscx). NEVER raises.

    NOTE: keyed to the MuseScore convention that the score's real staves are id "1"/"2" and
    hold <Measure>s; a part-definition <Staff> with no measures is skipped.
    """
    try:
        root = ET.fromstring(mscx if isinstance(mscx, (bytes, bytearray)) else str(mscx))
        by_staff: Dict = {}
        for staff in root.iter("Staff"):
            sid = staff.get("id")
            measures_el = staff.findall("Measure")
            if sid not in ("1", "2") or not measures_el:
                continue
            staff_measures = []
            for meas in measures_el:
                events = []
                for chord in meas.iter("Chord"):
                    midis = []
                    for p in chord.iter("pitch"):
                        try:
                            midis.append(int((p.text or "").strip()))
                        except (TypeError, ValueError):
                            continue
                    if midis:
                        events.append(
                            {"duration": 1, "pitches": [_midi_to_pitch(m) for m in midis]}
                        )
                staff_measures.append(events)
            by_staff[int(sid)] = staff_measures
        if not by_staff:
            return None

        n = max((len(v) for v in by_staff.values()), default=0)
        measures = []
        for i in range(n):
            s1 = by_staff.get(1, [])
            s2 = by_staff.get(2, [])
            measures.append(
                {
                    "staff1": s1[i] if i < len(s1) else [],
                    "staff2": s2[i] if i < len(s2) else [],
                }
            )
        return llm_omr.score_json_to_musicxml(
            {"divisions": 4, "measures": measures, "time": {"beats": 4, "beat_type": 4}}
        )
    except Exception:
        return None


def generate_random_score(
    seed: int,
    n_measures: int = 8,
    key_fifths: int = 0,
    divisions: int = 4,
    chord_prob: float = 0.25,
) -> bytes:
    """Generate a deterministic random piano grand-staff score as MusicXML bytes. Same seed +
    args => byte-identical output. The notes are drawn from the key's major scale; the bass
    staff sometimes stacks a diatonic chord (so the eval set exercises chord correctness).

    Built through llm_omr.score_json_to_musicxml, so the document is always well-formed and is
    its OWN ground truth (feed the same bytes as both pred and truth -> perfect score)."""
    rng = random.Random(seed)
    tonic_pc = (key_fifths * 7) % 12
    scale = [(tonic_pc + d) % 12 for d in _MAJOR]

    def diatonic_midi(low_octave: int, span: int) -> int:
        degree = rng.randrange(len(scale))
        octave = low_octave + rng.randrange(span)
        pc = scale[degree]
        return (octave + 1) * 12 + pc

    measures = []
    quarter = divisions
    for _ in range(n_measures):
        # 4/4: four quarter-beats per staff; each beat is one quarter note (keep rhythm simple
        # so durations always sum to capacity -> valid bars).
        staff1 = []
        staff2 = []
        for _beat in range(4):
            # treble: a single melody note around C5..C6.
            staff1.append({"duration": quarter, "pitches": [_midi_to_pitch(diatonic_midi(4, 2))]})
            # bass: sometimes a chord (root + diatonic third + fifth), else a single note.
            root = diatonic_midi(2, 2)
            if rng.random() < chord_prob:
                pitches = [_midi_to_pitch(root)]
                for interval in (3, 7):  # a stacked-ish chord (approximate third + fifth)
                    pitches.append(_midi_to_pitch(root + interval))
                staff2.append({"duration": quarter, "pitches": pitches})
            else:
                staff2.append({"duration": quarter, "pitches": [_midi_to_pitch(root)]})
        measures.append({"staff1": staff1, "staff2": staff2})

    data = {
        "divisions": divisions,
        "key_fifths": key_fifths,
        "time": {"beats": 4, "beat_type": 4},
        "measures": measures,
    }
    out = llm_omr.score_json_to_musicxml(data)
    return out if out is not None else b""


# --- Rich synthetic score generation (the full-symbol detector's training data) -----------
#
# generate_random_score above is the SIMPLE generator: four quarter notes per bar, in-key, no
# accidentals/beams/clef-changes. It built the notehead-detector eval. generate_rich_score below
# emits the VARIED scores the next rung needs: a multi-class SYMBOL detector that reads durations,
# key, per-note accidentals, clefs, and rests FROM the engraved glyphs (the "measure, do not
# predict" thesis extended past noteheads). The MusicXML is still its OWN ground truth: every
# extra glyph (<type>/<beam>/<accidental>/<dot>/<direction>/clef change) is INVISIBLE to
# score_transcription (reconcile.to_events reads only pitch + duration + chord), so a rich score
# fed to itself still scores a perfect 1.0, while the rendered IMAGE shows the full symbol set.
#
# Why this is the right shape for training: the same MusicXML drives BOTH (a) the ground truth the
# scorer reads and (b) the Verovio render the detector sees, so the engraved eighth flag, sixteenth
# double-beam, sharp/flat/natural, augmentation dot, and rest glyph are each PERFECTLY consistent
# with the duration/pitch the score encodes. No hand labeling.

_LETTERS = "CDEFGAB"  # diatonic letter order (matches geom_omr._STEPS)

# Circle-of-fifths key-signature accidentals. Sharps add F C G D A E B; flats the reverse. This is
# a deliberate private copy of geom_omr.keyed_alter (+ its _SHARP_ORDER/_FLAT_ORDER): omr_eval is
# the eval SUBSTRATE and geom_omr is an ENGINE, so importing the engine into the substrate is the
# wrong layering direction (both already depend on the shared llm_omr builder). geom_omr's
# numpy/scipy imports ARE guarded, so the import would not fail; the copy is about layering, not
# availability. Keep in sync with geom_omr.keyed_alter (the canonical copy).
_SHARP_ORDER = ("F", "C", "G", "D", "A", "E", "B")
_FLAT_ORDER = ("B", "E", "A", "D", "G", "C", "F")
_ACCIDENTAL_GLYPH = {2: "double-sharp", 1: "sharp", 0: "natural", -1: "flat", -2: "flat-flat"}

# Per-clef comfortable WRITTEN octave range (lo, hi inclusive) for picking notes that sit on/near
# the staff. Ledger-heavy mode widens these so the detector sees many ledger-line notes.
_CLEF_OCTAVES = {"G": (4, 5), "F": (2, 3), "C": (3, 4)}
# The staff line a clef sits on (the <clef><line>): treble G=2, bass F=4, alto C=3.
_CHANGE_CLEF_LINE = {"G": 2, "F": 4, "C": 3}


def _keyed_alter(step: str, fifths: int) -> int:
    """The accidental the key signature `fifths` applies to a diatonic step (+1/-1/0). PURE.
    A private copy of geom_omr.keyed_alter (kept here to avoid importing the engine into the eval
    substrate; see the constant block above)."""
    try:
        f = int(fifths)
        if f > 0 and step in _SHARP_ORDER[:f]:
            return 1
        if f < 0 and step in _FLAT_ORDER[: -f]:
            return -1
        return 0
    except Exception:
        return 0


def _accidental_glyph(step: str, alter: int, fifths: int) -> Optional[str]:
    """The accidental GLYPH to engrave for a note of (step, alter) in key `fifths`, or None when
    the key signature already implies that alter (so no glyph is drawn). e.g. F-natural in D major
    needs a 'natural'; F# in C major needs a 'sharp'; F# in D major needs nothing."""
    if alter == _keyed_alter(step, fifths):
        return None
    return _ACCIDENTAL_GLYPH.get(alter)


def _diatonic_step_up(step: str, octave: int, steps: int) -> Tuple[str, int]:
    """Move `steps` diatonic letters up from (step, octave), carrying the octave at the C boundary.
    steps=2 is a third, 4 a fifth. PURE."""
    idx = _LETTERS.index(step) + int(steps)
    return _LETTERS[idx % 7], octave + idx // 7


def _ticks_to_type(ticks: int, divisions: int) -> Optional[Tuple[str, int]]:
    """Map a duration in ticks to its engraved (note-type, dots), where `divisions` is ticks per
    quarter. Returns None for a value that is not a plain/dotted/double-dotted power-of-two note.
    This is what makes the rendered glyph (open vs filled head, flag count) match the duration."""
    if ticks <= 0 or divisions <= 0:
        return None
    q = ticks / float(divisions)  # value in quarter notes
    bases = [(8.0, "breve"), (4.0, "whole"), (2.0, "half"), (1.0, "quarter"),
             (0.5, "eighth"), (0.25, "16th"), (0.125, "32nd"), (0.0625, "64th")]
    for base, name in bases:
        if abs(q - base) < 1e-9:
            return name, 0
        if abs(q - base * 1.5) < 1e-9:
            return name, 1   # dotted
        if abs(q - base * 1.75) < 1e-9:
            return name, 2   # double-dotted
    return None


def _beam_levels(type_name: Optional[str]) -> int:
    """How many beams/flags a note type carries: eighth 1, 16th 2, 32nd 3, ... ; quarter+ = 0
    (unbeamable). Dots do not add beams, so this keys off the base type only."""
    return {"eighth": 1, "16th": 2, "32nd": 3, "64th": 4}.get(type_name or "", 0)


def _assign_beams(items: List[Tuple[int, int]], beat_ticks: int) -> List[List[dict]]:
    """Compute the <beam> markings for a bar. `items` is one (start_tick, beam_level) per slot in
    order (beam_level 0 = a rest or a quarter-or-longer note, which breaks a beam). Returns a
    per-slot list of {'number', 'value'} beam dicts. PURE.

    Beams group consecutive beamable notes WITHIN one beat (the simple-meter convention): a group
    of >= 2 gets a primary beam (number 1) begin/continue/end; deeper levels (number 2 for
    sixteenths, 3 for 32nds) beam their own consecutive sub-runs, and a lone deeper note gets a
    hook (backward toward an earlier neighbor, else forward). A single beamable note keeps a flag
    (no beam). Beat-internal grouping + this hook rule reproduce standard engraving so Verovio
    draws the eighth/sixteenth beams the detector trains on."""
    n = len(items)
    out: List[List[dict]] = [[] for _ in range(n)]
    if beat_ticks <= 0:
        return out
    i = 0
    while i < n:
        start_i, lvl_i = items[i]
        if lvl_i < 1:
            i += 1
            continue
        beat = start_i // beat_ticks
        j = i
        while j < n and items[j][1] >= 1 and items[j][0] // beat_ticks == beat:
            j += 1
        if j - i >= 2:  # a real beam group
            for k in range(i, j):  # primary beam (level 1)
                value = "begin" if k == i else ("end" if k == j - 1 else "continue")
                out[k].append({"number": 1, "value": value})
            max_level = max(items[k][1] for k in range(i, j))
            for level in range(2, max_level + 1):  # secondary beams
                k = i
                while k < j:
                    if items[k][1] < level:
                        k += 1
                        continue
                    r = k
                    while r < j and items[r][1] >= level:
                        r += 1
                    if r - k >= 2:
                        for t in range(k, r):
                            value = "begin" if t == k else ("end" if t == r - 1 else "continue")
                            out[t].append({"number": level, "value": value})
                    else:  # lone deeper note -> a hook (e.g. dotted-eighth + sixteenth)
                        out[k].append({"number": level,
                                       "value": "backward hook" if k > i else "forward hook"})
                    k = r
        i = j
    return out


def _bar_rhythm(rng: random.Random, capacity: int, beat_ticks: int, divisions: int,
                density: float, rest_prob: float) -> List[dict]:
    """Fill ONE bar with a varied, metrically-exact rhythm. Returns a list of slots
    {ticks, rest}. `density` in [0,1] biases toward shorter (subdivided) values; `rest_prob` is
    the per-slot chance a slot is a rest. Built from beat-aligned cells so beaming stays within a
    beat and the bar always sums EXACTLY to capacity (a valid bar Verovio engraves cleanly)."""
    bt = beat_ticks
    if capacity <= 0 or bt <= 0:
        return []
    if capacity % bt != 0:
        # Unusual meter: degrade to a single full-capacity note so the bar still sums exactly.
        return [{"ticks": capacity, "rest": False}]
    # Keep only cells whose every value maps to an engraved note TYPE at this divisions, so a
    # generated note's glyph is always consistent with its duration (the core thesis) even for an
    # exotic divisions. At the default divisions=4 every cell below qualifies, so this is a no-op
    # (and the RNG draw sequence is unchanged, keeping generate_rich_score byte-deterministic).
    ok = lambda cell: all(t > 0 and _ticks_to_type(t, divisions) for t in cell)
    half = bt // 2 if bt % 2 == 0 else 0
    quart = bt // 4 if bt % 4 == 0 else 0
    one_beat = [[bt]]
    if half:
        one_beat.append([half, half])                       # two eighths
    if quart:
        one_beat += [[quart] * 4,                            # four sixteenths
                     [half, quart, quart],                   # eighth + two sixteenths
                     [quart, quart, half],                   # two sixteenths + eighth
                     [bt * 3 // 4, quart]]                    # dotted-eighth + sixteenth
    two_beat = [[2 * bt]]                                    # half note
    if half:
        two_beat.append([bt + half, half])                  # dotted-quarter + eighth
    if quart:
        two_beat.append([bt + half, quart, quart])          # dotted-quarter + two sixteenths
    three_beat = [[3 * bt]]                                  # dotted half
    four_beat = [[4 * bt]]                                   # whole
    one_beat = [c for c in one_beat if ok(c)] or [[bt]]     # always keep at least the plain beat
    two_beat = [c for c in two_beat if ok(c)]
    three_beat = [c for c in three_beat if ok(c)]
    four_beat = [c for c in four_beat if ok(c)]

    beats_total = capacity // bt
    slots: List[dict] = []
    remaining = beats_total
    while remaining > 0:
        # Longer multi-beat values get LESS likely as density rises (denser = more notes). The
        # pool-non-empty guards keep span <= remaining and never pick an unrepresentable cell.
        long_bias = max(0.0, 0.55 - 0.5 * density)
        span, pool = 1, one_beat
        if remaining >= 2 and two_beat and rng.random() < long_bias:
            span, pool = 2, two_beat
        elif remaining >= 3 and three_beat and rng.random() < long_bias * 0.4:
            span, pool = 3, three_beat
        elif remaining == beats_total == 4 and four_beat and rng.random() < long_bias * 0.3:
            span, pool = 4, four_beat
        cell = rng.choice(pool)
        for t in cell:
            slots.append({"ticks": t, "rest": rng.random() < rest_prob})
        remaining -= span
    return slots


def _random_pitch(rng: random.Random, clef: str, fifths: int, accidental_prob: float,
                  octaves: Tuple[int, int]) -> dict:
    """One in-key (or chromatically altered) pitch dict for the given clef range. A diatonic note
    takes the key's alter and needs NO glyph; with probability accidental_prob it is shifted a
    semitone, which sets an explicit <accidental> glyph (sharp/flat/natural/...)."""
    step = rng.choice(_LETTERS)
    octave = rng.randint(octaves[0], octaves[1])
    alter = _keyed_alter(step, fifths)
    pitch = {"step": step, "octave": octave, "alter": alter}
    if rng.random() < accidental_prob:
        new_alter = max(-2, min(2, alter + rng.choice((-1, 1))))
        glyph = _accidental_glyph(step, new_alter, fifths)
        if glyph is not None:
            pitch["alter"] = new_alter
            pitch["accidental"] = glyph
    return pitch


def _note_event(rng: random.Random, slot: dict, type_dots, clef: str, fifths: int,
                chord_prob: float, accidental_prob: float, octaves: Tuple[int, int],
                beams: List[dict]) -> dict:
    """Turn one rhythm slot into a note/rest/chord event with the engraved type/dots/accidental/
    beams attached. Chords stack diatonic thirds/fifths on the root. `type_dots` is the slot's
    precomputed (type, dots) from _staff_measure (or None), so the tick->type map runs once."""
    type_name, dots = type_dots if type_dots else (None, 0)
    if slot["rest"]:
        ev = {"rest": True, "duration": slot["ticks"]}
        if type_name:
            ev["type"] = type_name
            ev["dots"] = dots
        return ev
    root = _random_pitch(rng, clef, fifths, accidental_prob, octaves)
    pitches = [root]
    if rng.random() < chord_prob:
        size = rng.choice((2, 3))  # a third, or a third + fifth (triad)
        for s in (2, 4)[: size - 1]:
            st, oc = _diatonic_step_up(root["step"], root["octave"], s)
            pitches.append({"step": st, "octave": oc, "alter": _keyed_alter(st, fifths)})
    ev: dict = {"duration": slot["ticks"], "pitches": pitches}
    if type_name:
        ev["type"] = type_name
        ev["dots"] = dots
    if beams:
        ev["beams"] = beams
    return ev


def _staff_measure(rng: random.Random, capacity: int, beat_ticks: int, divisions: int,
                   clef: str, fifths: int, chord_prob: float, accidental_prob: float,
                   rest_prob: float, density: float, octaves: Tuple[int, int],
                   tie_prob: float = 0.0) -> List[dict]:
    """Build ONE staff's worth of one measure: a varied rhythm, each slot decoded into a
    note/rest/chord with beams computed over the bar. Sums EXACTLY to capacity."""
    slots = _bar_rhythm(rng, capacity, beat_ticks, divisions, density, rest_prob)
    # tick->type once per slot, reused for both the beam level and the engraved <type>/<dot>.
    tds = [_ticks_to_type(s["ticks"], divisions) for s in slots]
    # beam level per slot (0 for rests / unbeamable), with running start ticks, then assign beams.
    starts, levels, pos = [], [], 0
    for s, td in zip(slots, tds):
        level = 0 if s["rest"] else _beam_levels(td[0] if td else None)
        starts.append(pos)
        levels.append(level)
        pos += s["ticks"]
    beam_lists = _assign_beams(list(zip(starts, levels)), beat_ticks)
    events = [_note_event(rng, s, tds[i], clef, fifths, chord_prob, accidental_prob,
                          octaves, beam_lists[i]) for i, s in enumerate(slots)]
    # Optional ties: tie a single note to the next single note as one HELD pitch (the second
    # repeats the first's pitch). Gated on tie_prob>0 so the default RNG stream is unchanged.
    if tie_prob > 0 and len(events) >= 2:
        i = 0
        while i < len(events) - 1:
            a, b = events[i], events[i + 1]
            if (not a.get("rest") and not b.get("rest")
                    and isinstance(a.get("pitches"), list) and len(a["pitches"]) == 1
                    and isinstance(b.get("pitches"), list) and len(b["pitches"]) == 1
                    and "tie" not in a and "tie" not in b and rng.random() < tie_prob):
                src = a["pitches"][0]
                # the tied-to note repeats the pitch with NO accidental glyph (the tie carries it)
                b["pitches"] = [{"step": src["step"], "octave": src["octave"],
                                 "alter": src.get("alter", 0)}]
                a["tie"], b["tie"] = "start", "stop"
                i += 2  # do not chain a third note into the same tie
            else:
                i += 1
    return events


def generate_rich_score(
    seed: int,
    n_measures: int = 8,
    key_fifths: Optional[int] = None,
    divisions: int = 4,
    beats: int = 4,
    beat_type: int = 4,
    chord_prob: float = 0.25,
    accidental_prob: float = 0.12,
    rest_prob: float = 0.12,
    density: float = 0.5,
    tie_prob: float = 0.0,
    clef_changes: bool = False,
    ottava: bool = False,
    ledger_heavy: bool = False,
) -> bytes:
    """Deterministic RICH random grand-staff score as MusicXML bytes (its own ground truth).

    Beyond generate_random_score this varies: note DURATIONS (whole..sixteenth, dotted) with
    correct engraved type/flag/beam, RESTS, dense CHORDS, ALL keys (key_fifths None -> random
    -7..7) with per-note ACCIDENTALS, optional TIES, mid-piece CLEF CHANGES (to bass or alto),
    OTTAVA brackets, and LEDGER-heavy ranges. Same seed + args => byte-identical output.

    Defaults to a simple meter (4/4) with divisions=4 so eighth/sixteenth/dotted values and their
    beams are all exactly representable; exotic meters degrade gracefully (a full-bar note).

    tie_prob (default 0) ties held notes; clef_changes / ottava / ledger_heavy add the HARDER cases
    (a clef the geometric decode does not yet read, an octave bracket, many ledger lines) and are
    off by default so the plain rich set stays a clean rhythm/key/accidental benchmark. NEVER raises
    (degrades to b'')."""
    try:
        rng = random.Random(seed)
        if key_fifths is None:
            key_fifths = rng.randint(-7, 7)
        if divisions <= 0:
            divisions = 4
        beat_ticks = divisions * 4 // beat_type if beat_type else divisions
        if beat_ticks <= 0:
            beat_ticks = divisions
        capacity = beats * beat_ticks

        # Optional single mid-piece clef change on the treble staff (measure ci): switch to bass OR
        # alto for one bar (so its notes sit in that clef's range) then switch back. A clef change
        # is invisible to the scorer but engraves a clef glyph and re-positions notes (a step-3
        # rung); randomizing F vs C gives the detector both fClef and cClef change examples.
        clef_change_measure = rng.randint(2, n_measures - 1) if (clef_changes and n_measures >= 4) else None
        change_sign = rng.choice(("F", "C")) if clef_change_measure is not None else "G"
        change_line = _CHANGE_CLEF_LINE.get(change_sign, 4)
        # Optional ottava run on the treble staff of one measure (a rendered 8va bracket).
        ottava_measure = rng.randint(1, n_measures) if (ottava and n_measures >= 1) else None

        def octaves_for(clef: str) -> Tuple[int, int]:
            lo, hi = _CLEF_OCTAVES.get(clef, (4, 5))
            return (lo - 1, hi + 1) if ledger_heavy else (lo, hi)

        measures = []
        for m in range(1, n_measures + 1):
            treble_clef = change_sign if m == clef_change_measure else "G"
            measure: dict = {}
            if m == clef_change_measure:
                measure["clefs"] = [{"number": 1, "sign": change_sign, "line": change_line}]
            elif clef_change_measure is not None and m == clef_change_measure + 1:
                measure["clefs"] = [{"number": 1, "sign": "G", "line": 2}]  # switch back

            staff1 = _staff_measure(rng, capacity, beat_ticks, divisions, treble_clef, key_fifths,
                                    chord_prob * 0.6, accidental_prob, rest_prob, density,
                                    octaves_for(treble_clef), tie_prob)
            staff2 = _staff_measure(rng, capacity, beat_ticks, divisions, "F", key_fifths,
                                    chord_prob, accidental_prob, rest_prob, density,
                                    octaves_for("F"), tie_prob)

            if m == ottava_measure and staff1:
                # Wrap the treble run in an octave-shift bracket (visual only; written pitch is the
                # ground truth, matching how reconcile.to_events + the geometric decode read it).
                staff1 = (
                    [{"direction": {"octave_shift": {"type": "down", "size": 8, "number": 1}}}]
                    + staff1
                    + [{"direction": {"octave_shift": {"type": "stop", "number": 1}}}]
                )

            measure["staff1"] = staff1
            measure["staff2"] = staff2
            measures.append(measure)

        data = {
            "divisions": divisions,
            "key_fifths": key_fifths,
            "time": {"beats": beats, "beat_type": beat_type},
            "measures": measures,
        }
        out = llm_omr.score_json_to_musicxml(data)
        return out if out is not None else b""
    except Exception:
        return b""
