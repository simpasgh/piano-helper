"""Unit tests for seq2seq.py: the L4 Zeus assembly (delinearize + gated octave borrow) and the
validated agreement referee (OMR_SEQ2SEQ). Pure in-process tests; the zeus model itself never
runs here (worker.run_zeus is exercised in test_worker.py with stubbed subprocesses).

The octave-borrow and referee logic are faithful ports of the validated local study scripts
(l4v2_octave_borrow.py / l4v2_agree_referee.py, 2026-06-11), so these tests pin the GATES the
study selected: rewrites only in same-sign runs >= 4, only on pieces with pooled disagree rate
<= 0.08, only at a midi delta of exactly +-12, mixed chords never rewrite; the agreement signal
pools staves per measure, scores a missing measure 0, and works on pitch CLASSES; the pick rule
is strictly greater-than with the fused result as the floor on every failure.
"""
import sys
import types
import xml.etree.ElementTree as ET

import pytest

# Stub the S3 stack like test_worker.py so importing the worker stack never needs boto3.
for _name in ("boto3", "botocore", "botocore.client", "botocore.exceptions"):
    if _name not in sys.modules:
        sys.modules[_name] = types.ModuleType(_name)
if not hasattr(sys.modules["botocore.client"], "Config"):
    sys.modules["botocore.client"].Config = object
if not hasattr(sys.modules["botocore.exceptions"], "ClientError"):
    sys.modules["botocore.exceptions"].ClientError = type("ClientError", (Exception,), {})

import llm_omr  # noqa: E402
import seq2seq  # noqa: E402


# --- helpers -------------------------------------------------------------------------------

STEPS = "CDEFGAB"


def _ev(*pitches):
    """One chord event. Each pitch is (step, octave) or (step, octave, alter)."""
    out = []
    for p in pitches:
        step, octave = p[0], p[1]
        alter = p[2] if len(p) > 2 else 0
        out.append({"step": step, "alter": alter, "octave": octave})
    return {"duration": 4, "pitches": out}


def _doc(staff1_measures, staff2_measures=None):
    """Build a grand-staff MusicXML document. Each staff arg is a list of measures; each
    measure is a list of chords; each chord a list of (step, octave[, alter]) tuples."""
    staff2_measures = staff2_measures or []
    n = max(len(staff1_measures), len(staff2_measures))
    measures = []
    for i in range(n):
        s1 = staff1_measures[i] if i < len(staff1_measures) else []
        s2 = staff2_measures[i] if i < len(staff2_measures) else []
        measures.append({"staff1": [_ev(*ch) for ch in s1],
                         "staff2": [_ev(*ch) for ch in s2]})
    return llm_omr.score_json_to_musicxml(
        {"divisions": 4, "key_fifths": 0, "time": {"beats": 4, "beat_type": 4},
         "measures": measures})


def _chunk(chords, per_measure=4):
    """Split a flat chord list into measures of per_measure chords."""
    return [chords[i:i + per_measure] for i in range(0, len(chords), per_measure)]


def _stream50(shift_idxs=(), shift_to=5, base_octave=4):
    """A 50-chord single-note staff stream cycling through the 7 steps; chords whose index is
    in shift_idxs sit at octave shift_to instead of base_octave."""
    return [[(STEPS[i % 7], shift_to if i in shift_idxs else base_octave)] for i in range(50)]


def _octaves_of(xml_bytes):
    """All <octave> ints of staff-1 pitched notes, in document order."""
    root = ET.fromstring(xml_bytes)
    out = []
    for note in root.iter("note"):
        if note.findtext("staff") != "1":
            continue
        o = note.findtext("pitch/octave")
        if o is not None:
            out.append(int(o))
    return out


# --- STAGE 1: the gated octave borrow ------------------------------------------------------


def test_borrow_rewrites_a_same_sign_run_of_four_at_the_disagree_boundary():
    # 50 matched chords, 4 consecutive +1 shifts (geom an octave above zeus at indices 10..13):
    # rate = 4/50 = 0.08 == MAX_DISAGREE (the boundary fires), run = 4 == MIN_RUN (fires).
    zeus = _doc(_chunk(_stream50()))
    geom = _doc(_chunk(_stream50(shift_idxs={10, 11, 12, 13})))
    corrected, n_rw, n_matched, rate = seq2seq.correct_octaves_gated(zeus, geom)
    assert n_matched == 50
    assert rate == pytest.approx(0.08)
    assert n_rw == 4
    octs = _octaves_of(corrected)
    assert [octs[i] for i in (10, 11, 12, 13)] == [5, 5, 5, 5]
    # Every other chord untouched.
    assert all(octs[i] == 4 for i in range(50) if i not in (10, 11, 12, 13))


def test_borrow_run_of_three_never_rewrites():
    zeus = _doc(_chunk(_stream50()))
    geom = _doc(_chunk(_stream50(shift_idxs={10, 11, 12})))
    corrected, n_rw, _n, rate = seq2seq.correct_octaves_gated(zeus, geom)
    assert rate <= seq2seq.MAX_DISAGREE  # the piece gate passes; the RUN gate is what blocks
    assert n_rw == 0
    assert _octaves_of(corrected) == [4] * 50


def test_borrow_disagree_rate_above_gate_blocks_even_a_long_run():
    # 4 shifts out of only 20 matched chords: rate 0.2 > 0.08 -> geom is not a trustworthy
    # octave anchor for this piece, nothing rewrites despite the 4-run.
    chords = [[(STEPS[i % 7], 4)] for i in range(20)]
    shifted = [[(STEPS[i % 7], 5 if i in (8, 9, 10, 11) else 4)] for i in range(20)]
    corrected, n_rw, n_matched, rate = seq2seq.correct_octaves_gated(
        _doc(_chunk(chords)), _doc(_chunk(shifted)))
    assert n_matched == 20
    assert rate == pytest.approx(0.2)
    assert n_rw == 0
    assert _octaves_of(corrected) == [4] * 20


def test_borrow_delta_must_be_exactly_one_octave():
    # geom two octaves above zeus (delta 24): no rewrite candidate exists, chords read neutral.
    zeus = _doc(_chunk(_stream50()))
    geom = _doc(_chunk(_stream50(shift_idxs={10, 11, 12, 13}, shift_to=6)))
    corrected, n_rw, _n, _rate = seq2seq.correct_octaves_gated(
        zeus, geom, max_disagree=None, min_run=1)  # even with both gates open
    assert n_rw == 0
    assert _octaves_of(corrected) == [4] * 50


def test_borrow_mixed_chord_never_rewrites_and_breaks_the_run():
    # Indices 10..14 disagree, but index 12 is a MIXED chord (one note agrees exactly, one is
    # shifted): mixed carries no rewrites and splits the run into 2+2 < MIN_RUN, so nothing
    # rewrites anywhere.
    z = _stream50()
    g = _stream50(shift_idxs={10, 11, 13, 14})
    z[12] = [("C", 4), ("E", 5)]
    g[12] = [("C", 4), ("E", 6)]  # C agrees, E shifted +1 -> mixed
    corrected, n_rw, _n, _r = seq2seq.correct_octaves_gated(
        _doc(_chunk(z)), _doc(_chunk(g)), max_disagree=None)  # only the RUN gate in play
    assert n_rw == 0
    assert _octaves_of(corrected)[:10] == [4] * 10


def test_borrow_rewrite_is_spelling_safe():
    # zeus B#3 vs geom C5: same pitch class (0), midi delta exactly +12. The rewrite shifts
    # zeus's OWN octave (3 -> 4), keeping the B# spelling, not geom's C digit.
    zeus = _doc([[[("B", 3, 1)]]])
    geom = _doc([[[("C", 5)]]])
    corrected, n_rw, n_matched, _rate = seq2seq.correct_octaves_gated(
        zeus, geom, max_disagree=None, min_run=1)
    assert (n_matched, n_rw) == (1, 1)
    root = ET.fromstring(corrected)
    note = next(n for n in root.iter("note") if n.find("pitch") is not None)
    assert note.findtext("pitch/step") == "B"
    assert note.findtext("pitch/alter") == "1"
    assert note.findtext("pitch/octave") == "4"


def test_borrow_with_unusable_geom_is_a_no_op():
    # Garbage geom -> empty geom streams -> zero matches -> rate 1.0 -> no rewrites; the zeus
    # document passes through with its octaves intact.
    zeus = _doc(_chunk(_stream50()))
    corrected, n_rw, n_matched, rate = seq2seq.correct_octaves_gated(zeus, b"not xml")
    assert (n_rw, n_matched, rate) == (0, 0, 1.0)
    assert _octaves_of(corrected) == [4] * 50


# --- STAGE 2: the agreement signal ---------------------------------------------------------


def test_agreement_pools_both_staves_per_measure():
    # Side A has C in staff 1 / E in staff 2; side B swaps the staves. Pooled per measure the
    # multisets are identical, so the agreement is 1.0 (staves POOLED, not compared per staff).
    a = _doc([[[("C", 4)]]], [[[("E", 3)]]])
    b = _doc([[[("E", 3)]]], [[[("C", 4)]]])
    assert seq2seq.mean_measure_agreement(a, b, pc=False) == pytest.approx(1.0)


def test_agreement_missing_measure_scores_zero():
    # A has 2 measures, B only the first (identical): mean over measures present in EITHER side
    # = (1.0 + 0.0) / 2.
    a = _doc([[[("C", 4)]], [[("D", 4)]]])
    b = _doc([[[("C", 4)]]])
    assert seq2seq.mean_measure_agreement(a, b) == pytest.approx(0.5)


def test_agreement_pc_variant_folds_octaves():
    # Same pitch classes an octave apart: exact-midi agreement is 0, pitch-class agreement 1.
    a = _doc([[[("C", 4)], [("E", 4)]]])
    b = _doc([[[("C", 5)], [("E", 5)]]])
    assert seq2seq.mean_measure_agreement(a, b, pc=False) == pytest.approx(0.0)
    assert seq2seq.mean_measure_agreement(a, b, pc=True) == pytest.approx(1.0)


def test_agreement_none_when_a_side_has_no_pitched_content():
    a = _doc([[[("C", 4)]]])
    assert seq2seq.mean_measure_agreement(a, b"not xml") is None
    assert seq2seq.mean_measure_agreement(b"<score-partwise/>", a) is None


def test_measure_multisets_uses_running_index_when_numbers_absent():
    # zeus's delinearized output has no <measure number>: reconcile falls back to the running
    # 1-based index, so two-measure content lands at keys 1 and 2.
    doc = _doc([[[("C", 4)]], [[("D", 4)]]])
    root = ET.fromstring(doc)
    for m in root.iter("measure"):
        m.attrib.pop("number", None)
    stripped = ET.tostring(root)
    ms = seq2seq.measure_multisets(stripped)
    assert sorted(ms) == [1, 2]


# --- the pick rule -------------------------------------------------------------------------


def test_pick_zeus_on_strictly_higher_agreement():
    clarity = _doc([[[("C", 4)]], [[("D", 4)]]])
    zeus = _doc([[[("C", 4)]], [[("D", 4)]]])      # az = 1.0
    fused = _doc([[[("C", 4)]]])                   # af = 0.5 (missing measure 2)
    picked = seq2seq.pick(fused, zeus, clarity)
    assert picked is zeus


def test_pick_tie_keeps_fused():
    clarity = _doc([[[("C", 4)]]])
    zeus = _doc([[[("C", 4)]]])
    fused = _doc([[[("C", 4)]]])  # identical content, different object: az == af
    assert seq2seq.pick(fused, zeus, clarity) is fused


def test_pick_pitch_class_hides_octave_noise():
    # fused differs from Clarity ONLY by octave: pitch-class agreement is still 1.0, so a zeus
    # that exactly matches Clarity cannot beat it (tie -> fused). This is the load-bearing
    # property that routes "both healthy" pieces (reverie, tctab) to the fusion.
    clarity = _doc([[[("C", 4)], [("E", 4)]]])
    fused = _doc([[[("C", 5)], [("E", 5)]]])
    zeus = _doc([[[("C", 4)], [("E", 4)]]])
    assert seq2seq.pick(fused, zeus, clarity) is fused


def test_pick_missing_inputs_keep_fused():
    fused = _doc([[[("C", 4)]]])
    zeus = _doc([[[("C", 4)]], [[("D", 4)]]])
    assert seq2seq.pick(fused, zeus, None) is fused      # no Clarity -> no signal -> fused
    assert seq2seq.pick(fused, None, b"<x/>") is fused   # no zeus -> fused
    assert seq2seq.pick(None, zeus, b"<x/>") is None     # nothing to defend; never raises


def test_pick_no_signal_keeps_fused():
    fused = _doc([[[("C", 4)]]])
    zeus = _doc([[[("C", 4)]]])
    assert seq2seq.pick(fused, zeus, b"<score-partwise/>") is fused  # empty clarity -> None signal


def test_pick_exception_keeps_fused(monkeypatch):
    fused = _doc([[[("C", 4)]]])
    zeus = _doc([[[("D", 4)]]])

    def boom(*a, **k):
        raise RuntimeError("boom")

    monkeypatch.setattr(seq2seq, "mean_measure_agreement", boom)
    assert seq2seq.pick(fused, zeus, _doc([[[("D", 4)]]])) is fused


# --- delinearize (guarded import from a fake zeus repo) -------------------------------------

_FAKE_DELINEARIZER = '''\
import xml.etree.ElementTree as ET


class Delinearizer:
    def __init__(self, errout=None):
        self.part_element = None
        self._errout = errout

    def process_text(self, text):
        el = ET.Element("part")
        el.set("lmx", text)
        self.part_element = el
'''

_FAKE_PART_TO_SCORE = '''\
import xml.etree.ElementTree as ET


class _Tree:
    def __init__(self, root):
        self._root = root

    def getroot(self):
        return self._root


def part_to_score(part_element):
    root = ET.Element("score-partwise")
    root.append(part_element)
    return _Tree(root)
'''


@pytest.fixture()
def fake_zeus_repo(tmp_path, monkeypatch):
    """A minimal on-disk app.linearization / app.symbolic package tree mirroring the real
    olimpic-icdar24 layout, so delinearize's guarded import is exercised end to end without the
    repo. Cleans the imported modules out of sys.modules afterwards."""
    app = tmp_path / "app"
    (app / "linearization").mkdir(parents=True)
    (app / "symbolic").mkdir(parents=True)
    (app / "__init__.py").write_text("")
    (app / "linearization" / "__init__.py").write_text("")
    (app / "symbolic" / "__init__.py").write_text("")
    (app / "linearization" / "Delinearizer.py").write_text(_FAKE_DELINEARIZER)
    (app / "symbolic" / "part_to_score.py").write_text(_FAKE_PART_TO_SCORE)
    yield tmp_path
    for name in list(sys.modules):
        if name == "app" or name.startswith("app."):
            del sys.modules[name]


def test_delinearize_joins_lines_with_single_spaces(fake_zeus_repo):
    out = seq2seq.delinearize(["measure note C4", "", "measure note D4"], str(fake_zeus_repo))
    assert out is not None
    root = ET.fromstring(out)
    part = root.find("part")
    # The X4 spike protocol: per-system LMX lines joined with spaces, delinearized ONCE.
    assert part.get("lmx") == "measure note C4 measure note D4"


def test_delinearize_leaves_sys_path_clean(fake_zeus_repo):
    before = list(sys.path)
    assert seq2seq.delinearize(["measure"], str(fake_zeus_repo)) is not None
    assert sys.path == before


def test_delinearize_declines_without_a_repo(tmp_path):
    assert seq2seq.delinearize(["measure"], None) is None
    assert seq2seq.delinearize(["measure"], str(tmp_path / "missing")) is None
    # A dir without the app package: the guarded import fails -> None, never a raise.
    assert seq2seq.delinearize(["measure"], str(tmp_path)) is None
    assert seq2seq.delinearize([], str(tmp_path)) is None
    assert seq2seq.delinearize(["   "], str(tmp_path)) is None


# --- assemble ------------------------------------------------------------------------------


def test_assemble_delinearizes_then_borrows(fake_zeus_repo, monkeypatch):
    seen = {}

    def fake_borrow(zeus_xml, geom_xml, max_disagree=seq2seq.MAX_DISAGREE,
                    min_run=seq2seq.MIN_RUN):
        seen["zeus"], seen["geom"] = zeus_xml, geom_xml
        seen["gates"] = (max_disagree, min_run)
        return b"<corrected/>", 0, 0, 1.0

    monkeypatch.setattr(seq2seq, "correct_octaves_gated", fake_borrow)
    out = seq2seq.assemble(["measure"], b"<geom/>", str(fake_zeus_repo))
    assert out == b"<corrected/>"
    assert seen["geom"] == b"<geom/>"
    assert b'lmx="measure"' in seen["zeus"]
    # The validated stage-1 constants ride the defaults.
    assert seen["gates"] == (0.08, 4)


def test_assemble_none_when_delinearize_fails(tmp_path):
    assert seq2seq.assemble(["measure"], b"<geom/>", str(tmp_path)) is None


def test_assemble_never_raises(fake_zeus_repo, monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("boom")

    monkeypatch.setattr(seq2seq, "correct_octaves_gated", boom)
    assert seq2seq.assemble(["measure"], b"<geom/>", str(fake_zeus_repo)) is None


def test_delinearize_stamps_sequential_measure_numbers(tmp_path):
    # Zeus's delinearized MusicXML carries NO number attribute on <measure> (the eval pipeline
    # tolerates it via running indices, but the schema requires it and the browser sheet renderer
    # keys on it): delinearize must stamp sequential 1-based numbers per part.
    app = tmp_path / "app"
    (app / "linearization").mkdir(parents=True)
    (app / "symbolic").mkdir(parents=True)
    (app / "__init__.py").write_text("")
    (app / "linearization" / "__init__.py").write_text("")
    (app / "symbolic" / "__init__.py").write_text("")
    (app / "linearization" / "Delinearizer.py").write_text(
        "import xml.etree.ElementTree as ET\n\n\n"
        "class Delinearizer:\n"
        "    def __init__(self, errout=None):\n"
        "        self.part_element = None\n\n"
        "    def process_text(self, text):\n"
        "        el = ET.Element('part')\n"
        "        for _ in range(3):\n"
        "            ET.SubElement(el, 'measure')  # NO number attr, the real zeus shape\n"
        "        self.part_element = el\n"
    )
    (app / "symbolic" / "part_to_score.py").write_text(
        "import xml.etree.ElementTree as ET\n\n\n"
        "class _Tree:\n"
        "    def __init__(self, root):\n"
        "        self._root = root\n\n"
        "    def getroot(self):\n"
        "        return self._root\n\n\n"
        "def part_to_score(part_element):\n"
        "    root = ET.Element('score-partwise')\n"
        "    root.append(part_element)\n"
        "    return _Tree(root)\n"
    )
    try:
        out = seq2seq.delinearize(["measure"], str(tmp_path))
        assert out is not None
        measures = ET.fromstring(out).find("part").findall("measure")
        assert [m.get("number") for m in measures] == ["1", "2", "3"]
    finally:
        for name in list(sys.modules):
            if name == "app" or name.startswith("app."):
                sys.modules.pop(name, None)
