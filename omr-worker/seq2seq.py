#!/usr/bin/env python3
"""L4 Zeus seq2seq third-engine assembly + referee (OMR_SEQ2SEQ, clean PDFs only).

WHY. The geom+Clarity fusion collapses on DENSE clean scores (the measured wall: only the
sparsest pieces read >= 0.85 note_f1). The zeus-olimpic CRNN (ufal/olimpic-icdar24, CC BY-SA
model, MIT code) reads exactly that wall (X4 bake-off: canon 0.391 -> 0.999 raw) but loses to
the fusion on some healthy pieces (icarus, reverie, tctab) and fails outright on scrambled
alignments (furelise, preludecmaj). The L4 selector-v2 study (2026-06-11, scripts
l4v2_octave_borrow.py / l4v2_agree_referee.py in C:/Users/pascu/omr-train, tables
l4v2_stage1.tsv / l4v2_stage2.tsv) found the validated two-stage rule this module ports:

  STAGE 1, GATED OCTAVE BORROW (zeus <- geom): zeus's LMX vocabulary has no ottava token, so
  in 8va/8vb regions it emits the WRITTEN pitch, an octave off the sounding truth. geom's
  octave decode is exact. NW-align zeus chords to geom's per staff (the same pitch-class
  alignment fusion._borrow_from_clarity uses) and rewrite a zeus note's octave to geom's when
  the pitch class matches and the midi delta is EXACTLY +-12, but ONLY inside maximal
  same-sign runs of >= MIN_RUN consecutive shifted chords AND only on pieces whose pooled
  disagree rate is <= MAX_DISAGREE (an unrestricted borrow regressed 18 pieces: a true
  missing 8va is a long same-sign run in an otherwise-agreeing piece; scattered mixed-sign
  disagreement means geom itself is the unreliable side). Measured (l4v2_stage1.tsv, the
  chosen 0.08/4 rule): rewrites fire on 4 of 30 pieces; reverie zeus 0.773 -> 0.837 is the
  target gain, nocturne -0.0024 / maple -0.0025 / furelise +0.0022 are noise-level, the
  other 26 pieces unchanged. Stage 2's zero-violations result was measured WITH these
  corrected files, so the tiny dips sit inside the validated guarantee.

  STAGE 2, THE REFEREE: az_pc = mean per-measure F1 of PITCH-CLASS multisets, zeus(corrected)
  vs CLARITY (staves pooled per measure, 1-based running measure indices, measures present in
  either side, a measure missing on one side scores 0); af_pc likewise for the live fusion
  output vs Clarity. RULE: pick zeus iff az_pc > af_pc STRICTLY (missing Clarity -> fusion).
  30-piece gate: accuracy 26/29 = 89.7%, ZERO never-worse violations, picked mean 0.7022 vs
  always-fusion 0.5067. Pitch-class (not midi) is LOAD-BEARING: it hides zeus's residual
  octave noise from the health signal, so "both healthy, fusion slightly better" pieces
  (reverie, tctab) route to fusion.

PURE stdlib + the existing pure helpers (fusion._chords_by_cell/_pc/_nw, reconcile). The
heavy zeus model runs elsewhere (worker.run_zeus, a subprocess in the zeus venv); this module
only delinearizes its LMX output (a GUARDED import of the stdlib-only app.linearization /
app.symbolic modules from ZEUS_OMR_DIR, inside the function so the worker imports cleanly
without the repo) and applies the study's pure transforms. assemble() and pick() NEVER raise:
any failure returns None / the fused input, so the fused result is the structural floor.
"""
from __future__ import annotations

import io
import os
import sys
import xml.etree.ElementTree as ET
from collections import Counter
from typing import Dict, List, Optional, Tuple

import fusion
import reconcile

# The validated stage-1 constants (gate sweep 2026-06-11, l4v2_stage1.tsv): rewrites fire only
# on pieces whose pooled zeus-vs-geom disagree rate is <= MAX_DISAGREE, and only inside maximal
# same-sign runs of >= MIN_RUN consecutive shifted chords.
MAX_DISAGREE = 0.08
MIN_RUN = 4


# --- LMX -> MusicXML (delinearize ONCE) ----------------------------------------------------


def delinearize(lmx_lines, zeus_dir) -> Optional[bytes]:
    """Join the per-system LMX lines with spaces and delinearize ONCE via zeus's own
    app.linearization.Delinearizer + app.symbolic.part_to_score (the X4 spike protocol:
    concatenating per-system LMX and delinearizing once is what reproduced published quality).

    The app.* modules are stdlib-only, so they run in the WORKER's interpreter; they are
    imported INSIDE this function from a sys.path scoped to zeus_dir (ZEUS_OMR_DIR), never at
    module top, so importing seq2seq never needs the zeus repo. Returns the MusicXML bytes, or
    None on ANY failure (missing dir, import failure, malformed LMX). NEVER raises."""
    try:
        if not lmx_lines or not zeus_dir or not os.path.isdir(zeus_dir):
            return None
        joined = " ".join(ln for ln in lmx_lines if ln and ln.strip())
        if not joined.strip():
            return None
        zd = os.path.abspath(zeus_dir)
        inserted = False
        if zd not in sys.path:
            sys.path.insert(0, zd)
            inserted = True
        try:
            from app.linearization.Delinearizer import Delinearizer
            from app.symbolic.part_to_score import part_to_score
        finally:
            # Scope the path insertion to the import; the modules stay cached in sys.modules.
            if inserted:
                try:
                    sys.path.remove(zd)
                except ValueError:
                    pass
        err = io.StringIO()
        d = Delinearizer(errout=err)
        d.process_text(joined)
        score = part_to_score(d.part_element)
        return ET.tostring(score.getroot(), encoding="utf-8", xml_declaration=True)
    except Exception:
        return None


# --- STAGE 1: the gated octave borrow (ported from l4v2_octave_borrow.py) ------------------


def _zeus_chord_streams(root) -> Dict[int, List]:
    """Per-staff ordered chord streams from the parsed zeus DOM: {staff: [chord, ...]} where
    chord = [(pitch_tuple, note_elem), ...]. Mirrors fusion._chords_by_cell's construction
    (group pitched notes by (measure, staff), then onset slot, sorted by measure then onset)
    but keeps the LIVE <note> Elements so <octave> can be rewritten in place. Onsets within
    one measure share a tick base (reconcile reads divisions per measure), so the per-measure
    onset sort needs no cross-measure rescaling."""
    seed = (reconcile._all_divisions(root) or [1])[0]
    slots: Dict = {}
    for part in root.findall("part"):
        for ev, _div in reconcile._events_for_part(part, "zeus", seed):
            if ev.pitch is None or ev.elem is None:
                continue
            cell = slots.setdefault((ev.measure, ev.staff), {})
            cell.setdefault(ev.onset, []).append((ev.pitch, ev.elem))
    streams: Dict[int, List] = {1: [], 2: []}
    for (mm, s) in sorted(slots):
        if s not in streams:
            continue
        for o in sorted(slots[(mm, s)]):
            streams[s].append(slots[(mm, s)][o])
    return streams


def _geom_chord_streams(geom_xml) -> Dict[int, List]:
    """Per-staff ordered chord streams of geom pitch lists, exactly as
    fusion._borrow_from_clarity walks them (sorted (measure, staff) keys, chords in onset
    order): {staff: [[pitch_tuple, ...], ...]}."""
    g_cells = fusion._chords_by_cell(geom_xml)
    streams: Dict[int, List] = {1: [], 2: []}
    for staff in (1, 2):
        for (mm, s) in sorted(k for k in g_cells if k[1] == staff):
            for (_o, pitches, _gd, _gt) in g_cells[(mm, s)]:
                streams[staff].append(pitches)
    return streams


def _plan_chord(zchord, gchord) -> Tuple[str, int, List]:
    """Rewrite plan for one matched chord pair: (label, shift, rewrites) where label is
    'agree' / 'shift' / 'mixed' / 'neutral', shift is +1/-1 for 'shift', and rewrites is
    [(octave_elem, new_octave_int), ...]. CONSUMPTION pairing inside the chord: exact-midi
    pairs first (an agreeing note never moves and its geom twin can't be reused), then each
    remaining zeus note takes its unconsumed same-pitch-class geom candidate IFF exactly one
    such candidate sits exactly +-12 semitones away. The rewrite shifts the zeus note's OWN
    octave by the midi delta (spelling-safe: a zeus B#3 vs geom C5 rewrites to B#4, the same
    sounding pitch, not geom's octave digit). 'mixed' (exact-agree and shifted notes in ONE
    chord, or both signs) carries NO rewrites: a real ottava span shifts the whole chord, a
    partial shift is alignment noise."""
    gmidis = [m for m in (reconcile._pitch_to_midi(p) for p in gchord) if m is not None]
    used = [False] * len(gmidis)
    n_agree = 0
    pend = []
    for zpitch, elem in zchord:
        zm = reconcile._pitch_to_midi(zpitch)
        if zm is None:
            continue
        hit = next((k for k, g in enumerate(gmidis) if not used[k] and g == zm), None)
        if hit is not None:
            used[hit] = True
            n_agree += 1
        else:
            pend.append((zpitch, elem, zm))
    shifts = []
    rewrites = []
    for zpitch, elem, zm in pend:
        cands = [k for k, g in enumerate(gmidis)
                 if not used[k] and g % 12 == zm % 12 and abs(g - zm) == 12]
        ss = {(gmidis[k] - zm) // 12 for k in cands}
        if len(ss) != 1:
            continue  # no candidate, or ambiguous +1 vs -1
        used[cands[0]] = True
        s = next(iter(ss))
        shifts.append(s)
        oct_el = elem.find("pitch/octave")
        if oct_el is not None and oct_el.text is not None:
            rewrites.append((oct_el, zpitch[2] + s))
    if not shifts:
        return ("agree" if n_agree else "neutral"), 0, []
    if len(set(shifts)) > 1 or n_agree:
        return "mixed", 0, []
    return "shift", shifts[0], rewrites


def correct_octaves_gated(zeus_xml, geom_xml, max_disagree=MAX_DISAGREE, min_run=MIN_RUN):
    """GATED octave borrow (the validated stage-1 rule): rewrites fire only when
      (a) PIECE TRUST GATE: the pooled disagree rate (shift+mixed chords / matched chords)
          is <= max_disagree -- geom must be a trustworthy octave anchor for this piece
          (a real missing-ottava span is a small fraction of a piece; scattered mass
          disagreement = geom octave noise, the k545/serenade/toccata shape), AND
      (b) RUN GATE: the chord sits in a maximal SAME-SIGN run of >= min_run consecutive
          'shift' chords (neutral chords transparent; agree/mixed/opposite sign breaks) --
          a real ottava bracket spans contiguous chords (reverie +1 x5), isolated singletons
          are noise (the canon shape).
    Pure: zeus_xml -> (corrected bytes, n_rewrites, n_matched, disagree_rate). Only <octave>
    text changes. max_disagree=None disables (a); min_run=1 disables (b). May raise on a
    malformed zeus document; assemble() is the never-raise boundary."""
    root = ET.fromstring(zeus_xml)
    zs = _zeus_chord_streams(root)
    gs = _geom_chord_streams(geom_xml)
    staff_seqs: Dict[int, List] = {}
    n_matched = 0
    n_disagree = 0
    for staff in (1, 2):
        zchords, gchords = zs[staff], gs[staff]
        zpc = [fusion._pc([p for p, _e in ch]) for ch in zchords]
        gpc = [fusion._pc(ch) for ch in gchords]
        seq = []
        for zi, gi in fusion._nw(zpc, gpc):
            lab, s, rw = _plan_chord(zchords[zi], gchords[gi])
            seq.append((lab, s, rw))
            n_matched += 1
            if lab in ("shift", "mixed"):
                n_disagree += 1
        staff_seqs[staff] = seq
    rate = (n_disagree / n_matched) if n_matched else 1.0
    n_rw = 0
    if max_disagree is None or rate <= max_disagree:
        for staff in (1, 2):
            run: List = []  # buffered 'shift' chords of the current same-sign run
            run_sign = 0

            def flush():
                nonlocal n_rw, run, run_sign
                if len(run) >= min_run:
                    for _lab, _s, rw in run:
                        for oct_el, new_oct in rw:
                            oct_el.text = str(new_oct)
                            n_rw += 1
                run, run_sign = [], 0

            for lab, s, rw in staff_seqs[staff]:
                if lab == "shift":
                    if run_sign != s:
                        flush()
                        run_sign = s
                    run.append((lab, s, rw))
                elif lab == "neutral":
                    continue
                else:
                    flush()
            flush()
    return (ET.tostring(root, encoding="utf-8", xml_declaration=True),
            n_rw, n_matched, rate)


# --- STAGE 2: the agreement signal + the pick rule (ported from l4v2_agree_referee.py) -----


def measure_multisets(xml_bytes, pc=False) -> Dict[int, Counter]:
    """{measure_number: Counter(midi or pitch-class)} pooled over BOTH staves, via
    fusion._chords_by_cell (pitched notes only). Measure numbers are reconcile's: the
    document's own <measure number> when parseable, else the running 1-based index (zeus's
    delinearized output carries no number attribute, so it gets the running index)."""
    cells = fusion._chords_by_cell(xml_bytes)
    out: Dict[int, Counter] = {}
    for (mm, _s), chords in cells.items():
        c = out.setdefault(mm, Counter())
        for (_o, pitches, _d, _t) in chords:
            for p in pitches:
                m = reconcile._pitch_to_midi(p)
                if m is not None:
                    c[m % 12 if pc else m] += 1
    return out


def mean_measure_agreement(a_xml, b_xml, pc=False) -> Optional[float]:
    """Mean over measure indices present in EITHER side of the per-measure multiset F1
    (a measure missing on one side contributes an F1 of 0, which is what penalizes a
    scrambled grid). None when either side has no pitched content at all (no signal)."""
    a = measure_multisets(a_xml, pc)
    b = measure_multisets(b_xml, pc)
    if not a or not b:
        return None
    ks = sorted(set(a) | set(b))
    f1s = []
    for k in ks:
        ca, cb = a.get(k, Counter()), b.get(k, Counter())
        tot = sum(ca.values()) + sum(cb.values())
        if tot == 0:
            continue
        inter = sum((ca & cb).values())
        f1s.append(2 * inter / tot)
    return sum(f1s) / len(f1s) if f1s else 0.0


def assemble(lmx_lines, geom_xml, zeus_dir) -> Optional[bytes]:
    """zeus's per-system LMX lines -> the CORRECTED zeus MusicXML: delinearize ONCE, then the
    gated octave borrow from geom (the validated stage-1 constants). Returns None on ANY
    failure so the caller keeps the fused result (the structural floor). The returned bytes
    are UN-repaired: the worker's existing complete-write post chain (merge -> normalize_ties
    -> rhythm_repair -> drop_ties_across_rests) runs on whichever body wins the pick, exactly
    as the study applied rhythm_repair to its zeus arm. NEVER raises."""
    try:
        zeus_xml = delinearize(lmx_lines, zeus_dir)
        if not zeus_xml:
            return None
        corrected, _n_rw, _n_match, _rate = correct_octaves_gated(zeus_xml, geom_xml)
        return corrected
    except Exception:
        return None


def pick(fused, zeus_final, clarity) -> Optional[bytes]:
    """The validated referee: return zeus_final iff its per-measure PITCH-CLASS agreement with
    Clarity STRICTLY exceeds the fusion's (az_pc > af_pc); everything else -- a tie, missing
    Clarity, missing zeus, no signal on either side, ANY exception -- returns the fused input
    unchanged. The returned object is one of the two inputs by IDENTITY (callers may log which
    side won via `is`). NEVER raises."""
    try:
        if not fused or not zeus_final or not clarity:
            return fused
        az = mean_measure_agreement(zeus_final, clarity, pc=True)
        af = mean_measure_agreement(fused, clarity, pc=True)
        if az is None or af is None:
            return fused
        return zeus_final if az > af else fused
    except Exception:
        return fused
