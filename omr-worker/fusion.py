#!/usr/bin/env python3
"""Fuse the geom engine's PITCH with Clarity's RHYTHM into one MusicXML.

WHY. geom reads pitch + octave near-exactly and now segments real measures (barline detection),
but it fabricates durations (every note `duration: 1`). Clarity reads rhythm (and key/ties) but its
pitch/octave is weaker (real-score note_f1 0.41-0.89 vs geom 0.48-0.995). Their error profiles are
complementary, so combining geom's notes with Clarity's durations beats either engine alone. Measured
on the user's 4 MuseScore pieces, this fusion's full-transcription note_dur_f1 beats Clarity-alone on
every piece (liminality 0.856 -> 0.948, tctab 0.520 -> 0.875, icarus 0.857 -> 0.887, reverie 0.414 ->
0.460); geom alone scores 0 there because it has no rhythm.

HOW. geom-SKELETON: keep geom's note set (it has the higher pitch recall + the real measures) and
give each geom chord a duration borrowed from the temporally-corresponding Clarity chord. The match
is found by aligning each staff's geom chord stream to Clarity's with Needleman-Wunsch scored on
PITCH-CLASS overlap. Pitch-class (not full MIDI) is deliberate: geom's edge is the OCTAVE, which
pitch-class ignores, so a chord still aligns when geom corrected its octave relative to Clarity.
A geom chord with no Clarity match keeps a neutral quarter-note duration.

geom's pitches pass through unchanged, so the fused pitch is exactly geom's (never worse than geom
on pitch). Beyond per-note durations, fusion also adopts Clarity's declared TIME SIGNATURE (geom
fakes 4/4), so a non-4/4 piece declares its real meter: this renders it at true width and lets the
rhythm-repair post-transform corroborate the bar capacity instead of bailing on a wrong meter. The
time sig does not affect the rhythm/pitch metric (omr_eval keys on meter-agnostic per-(measure,staff)
(midi,dur16) multisets), so adopting the real meter cannot regress note_f1/note_dur_f1. Borrowing
Clarity's KEY SIGNATURE (to fix geom's faked key on non-C pieces) is still a deliberate later
enhancement, validated on a non-C piece first (all current eval pieces are C major, fifths=0).

PURE stdlib + the existing pure helpers (reconcile.to_events, omr_eval._dur16,
llm_omr.score_json_to_musicxml). NEVER raises: on ANY failure returns the geom MusicXML unchanged
(never worse than geom alone), or Clarity's if geom produced nothing.
"""
from __future__ import annotations

import xml.etree.ElementTree as ET
from typing import Dict, FrozenSet, List, Optional, Tuple

import reconcile
import omr_eval
import llm_omr


def _read_fifths(xml_bytes) -> int:
    """The score's key signature (first <fifths>), or 0. NEVER raises."""
    try:
        for f in ET.fromstring(xml_bytes).iter("fifths"):
            return int((f.text or "0").strip())
    except Exception:
        return 0
    return 0


def _read_time(xml_bytes) -> Optional[Tuple[int, int]]:
    """The score's declared meter (first <time>) as (beats, beat_type), or None on a missing /
    senza-misura / garbage <time>. Mirrors _read_fifths (first element wins). NEVER raises."""
    try:
        for t in ET.fromstring(xml_bytes).iter("time"):
            beats = int((t.findtext("beats") or "0").strip())
            beat_type = int((t.findtext("beat-type") or "0").strip())
            return (beats, beat_type) if beats > 0 and beat_type > 0 else None
    except Exception:
        return None
    return None


def _chords_by_cell(xml_bytes) -> Dict:
    """{(measure, staff): [(onset, [(step, alter, octave), ...], dur16), ...] sorted by onset}.

    One entry per ONSET SLOT (a chord) in each measure+hand, carrying its pitches and its
    divisions-invariant duration (omr_eval._dur16). Robust: reconcile.to_events never raises and
    returns [] on a parse failure, so a malformed engine output yields {}."""
    slots: Dict = {}
    for e in reconcile.to_events(xml_bytes, "x"):
        if e.pitch is None:
            continue
        cell = slots.setdefault((e.measure, e.staff), {})
        d = cell.setdefault(e.onset, {"pitches": [], "dur": e.duration, "base": e.base})
        d["pitches"].append(e.pitch)
        d["dur"] = max(d["dur"], e.duration)  # chord notes share a duration; guard with max
    out: Dict = {}
    for cell, ons in slots.items():
        out[cell] = [(o, ons[o]["pitches"], omr_eval._dur16(ons[o]["dur"], ons[o]["base"]))
                     for o in sorted(ons)]
    return out


def _pc(pitches) -> FrozenSet:
    """The pitch-class set of a chord (octave-invariant), for alignment scoring."""
    pcs = set()
    for p in pitches:
        m = reconcile._pitch_to_midi(p)
        if m is not None:
            pcs.add(m % 12)
    return frozenset(pcs)


def _nw(gpc: List[FrozenSet], cpc: List[FrozenSet], gap: int = -1) -> List[Tuple[int, int]]:
    """Needleman-Wunsch global alignment of two chord sequences scored by pitch-class overlap.
    Returns the matched (geom_index, clarity_index) pairs (skipping zero-overlap matches). PURE."""
    n, m = len(gpc), len(cpc)
    if n == 0 or m == 0:
        return []
    dp = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(1, n + 1):
        dp[i][0] = i * gap
    for j in range(1, m + 1):
        dp[0][j] = j * gap
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            s = len(gpc[i - 1] & cpc[j - 1])
            dp[i][j] = max(dp[i - 1][j - 1] + (s if s > 0 else gap),
                           dp[i - 1][j] + gap, dp[i][j - 1] + gap)
    pairs: List[Tuple[int, int]] = []
    i, j = n, m
    while i > 0 and j > 0:
        s = len(gpc[i - 1] & cpc[j - 1])
        if dp[i][j] == dp[i - 1][j - 1] + (s if s > 0 else gap):
            if s > 0:
                pairs.append((i - 1, j - 1))
            i -= 1; j -= 1
        elif dp[i][j] == dp[i - 1][j] + gap:
            i -= 1
        else:
            j -= 1
    pairs.reverse()  # traceback collects from the end; return in ascending index order
    return pairs


def _borrow_durations(g_cells: Dict, c_cells: Dict) -> Dict:
    """{(measure, staff, chord_index): dur16} borrowing each geom chord a Clarity duration. Aligns
    each staff's full chord stream (concatenated across measures, so a measure-boundary drift between
    the two engines does not break the match) by pitch-class Needleman-Wunsch. PURE."""
    out: Dict = {}
    for staff in (1, 2):
        gpc: List[FrozenSet] = []
        gloc: List[Tuple[int, int]] = []
        for (mm, s) in sorted(k for k in g_cells if k[1] == staff):
            for idx, (_o, pitches, _gd) in enumerate(g_cells[(mm, s)]):
                gpc.append(_pc(pitches)); gloc.append((mm, idx))
        cpc: List[FrozenSet] = []
        cdur: List[int] = []
        for (cm, s) in sorted(k for k in c_cells if k[1] == staff):
            for (_o, pitches, cd) in c_cells[(cm, s)]:
                cpc.append(_pc(pitches)); cdur.append(cd)
        for gi, ci in _nw(gpc, cpc):
            out[(gloc[gi][0], staff, gloc[gi][1])] = cdur[ci]
    return out


def _build(g_cells: Dict, borrowed: Dict, fifths: int, beats: int = 4, beat_type: int = 4,
           fallback: int = 4) -> Optional[bytes]:
    """Rebuild geom's notes (pitch + measures) with the borrowed durations and Clarity's declared
    meter (beats/beat_type, so a non-4/4 piece renders at its true width). Unmatched geom chords
    keep a neutral quarter note (fallback=4 sixteenths). The key stays geom's (a non-C key borrow
    is a later enhancement, validated on a non-C piece first; all current eval pieces are C major).

    divisions stays 4 and is LOAD-BEARING: the borrowed durations are omr_eval._dur16 SIXTEENTHS,
    and divisions=4 makes a <duration> value of N equal N sixteenths == N ticks, so the borrowed
    dur16 numbers are directly usable as tick durations. Only the <time> is borrowed, never
    <divisions> (changing it would desync every borrowed duration). PURE; returns None if nothing
    usable."""
    measures: List[dict] = []
    for mm in sorted(set(k[0] for k in g_cells)):
        per_staff = {}
        for s in (1, 2):
            evs = []
            for idx, (_o, pitches, _gd) in enumerate(g_cells.get((mm, s), [])):
                dur = borrowed.get((mm, s, idx), fallback)
                dur = int(dur) if dur and dur > 0 else fallback
                evs.append({
                    "duration": dur,
                    "pitches": [{"step": st, "alter": al, "octave": oc} for (st, al, oc) in pitches],
                })
            per_staff[s] = evs
        measures.append({"staff1": per_staff.get(1, []), "staff2": per_staff.get(2, [])})
    if not measures:
        return None
    return llm_omr.score_json_to_musicxml(
        {"divisions": 4, "key_fifths": fifths,
         "time": {"beats": beats, "beat_type": beat_type}, "measures": measures})


def fuse(geom_xml, clarity_xml) -> Optional[bytes]:
    """Fuse geom pitch+measures with Clarity rhythm AND Clarity's declared <time> (so a non-4/4
    piece declares its real meter, which renders it at true width and lets the rhythm-repair
    post-transform corroborate the capacity; falls back to 4/4 when Clarity has no/garbage <time>).
    The key still comes from geom (a non-C key borrow is a deliberate later enhancement, validated
    on a non-C piece first). Returns fused MusicXML bytes. NEVER raises: on any failure returns
    geom_xml (never worse than geom alone); returns clarity_xml if geom produced nothing, and None
    only if both are empty."""
    try:
        if not geom_xml:
            return clarity_xml or None
        if not clarity_xml:
            return geom_xml
        g_cells = _chords_by_cell(geom_xml)
        if not g_cells:
            return clarity_xml
        c_cells = _chords_by_cell(clarity_xml)
        if not c_cells:
            return geom_xml
        borrowed = _borrow_durations(g_cells, c_cells)
        beats, beat_type = _read_time(clarity_xml) or (4, 4)
        fused = _build(g_cells, borrowed, _read_fifths(geom_xml), beats, beat_type)
        return fused or geom_xml
    except Exception:
        return geom_xml or None
