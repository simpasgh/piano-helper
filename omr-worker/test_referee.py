#!/usr/bin/env python3
"""Tests for the visual-diff PDF referee (omr-worker/referee.py).

Two tiers:
  - PURE tests (scope predicates + the guarded-import degrade path) run EVERYWHERE, including
    a verovio-less env (CI, the current prod worker venv). No render needed.
  - verovio-dependent tests SKIP cleanly when REFEREE_AVAILABLE is False, so they never fail
    where verovio/cairosvg/libcairo2 are absent. They GENERATE the "original" fixture at test
    time by rendering a known pitch with verovio itself (the stand-in original crop), so the
    suite is self-contained with NO committed binary fixture.

Run the verovio tier in a py>=3.11 venv with verovio + cairosvg + scipy installed (e.g. the
Slice 5 /tmp/verovio-spike venv).
"""

import importlib

import pytest

import referee


# --- PURE tier: runs everywhere (no verovio) ---------------------------------------------

class TestScopePredicates:
    """is_refereeable_dispute encodes the validated scope: octave + third+ pitch disputes on
    isolated noteheads are refereeable; steps/2nds, duration disputes, and dense regions are
    always declined. PURE logic, no verovio."""

    def test_accepts_octave_pitch_dispute(self):
        assert referee.is_refereeable_dispute(12, is_isolated=True, is_pitch_dispute=True)

    def test_accepts_third_pitch_dispute(self):
        # a minor third = 3 semitones (the MIN_REFEREEABLE_SEMITONES floor)
        assert referee.is_refereeable_dispute(3, is_isolated=True, is_pitch_dispute=True)

    def test_accepts_larger_than_third(self):
        assert referee.is_refereeable_dispute(7, is_isolated=True, is_pitch_dispute=True)

    def test_rejects_step_dispute(self):
        # a major 2nd = 2 semitones, below the floor -> decline
        assert not referee.is_refereeable_dispute(2, is_isolated=True, is_pitch_dispute=True)

    def test_rejects_minor_second(self):
        assert not referee.is_refereeable_dispute(1, is_isolated=True, is_pitch_dispute=True)

    def test_rejects_unison(self):
        assert not referee.is_refereeable_dispute(0, is_isolated=True, is_pitch_dispute=True)

    def test_rejects_duration_dispute(self):
        # an octave interval but NOT a pitch dispute (duration) -> out of scope
        assert not referee.is_refereeable_dispute(12, is_isolated=True, is_pitch_dispute=False)

    def test_rejects_dense_region(self):
        # an octave pitch dispute but NOT isolated (beamed/dense) -> decline
        assert not referee.is_refereeable_dispute(12, is_isolated=False, is_pitch_dispute=True)

    def test_rejects_none_interval(self):
        assert not referee.is_refereeable_dispute(None, is_isolated=True, is_pitch_dispute=True)

    def test_rejects_garbage_interval_without_raising(self):
        # a non-int interval must decline, never raise
        assert not referee.is_refereeable_dispute("oops", is_isolated=True, is_pitch_dispute=True)


class TestPitchIntervalSemitones:
    def test_octave(self):
        assert referee.pitch_interval_semitones(("C", 0, 4), ("C", 0, 5)) == 12

    def test_major_third(self):
        assert referee.pitch_interval_semitones(("C", 0, 5), ("E", 0, 5)) == 4

    def test_minor_third(self):
        assert referee.pitch_interval_semitones(("A", 0, 4), ("C", 0, 5)) == 3

    def test_step(self):
        assert referee.pitch_interval_semitones(("C", 0, 5), ("D", 0, 5)) == 2

    def test_respects_alter(self):
        # C#5 vs C5 is one semitone
        assert referee.pitch_interval_semitones(("C", 1, 5), ("C", 0, 5)) == 1

    def test_none_pitch_returns_none(self):
        assert referee.pitch_interval_semitones(None, ("C", 0, 5)) is None

    def test_malformed_pitch_returns_none(self):
        assert referee.pitch_interval_semitones(("Z", 0, 5), ("C", 0, 5)) is None


class TestDegradePathWithoutVerovio:
    """The guarded-import degrade path: with REFEREE_AVAILABLE forced False, every render/score
    function returns the safe default WITHOUT raising, so the prod worker (no verovio) is safe.
    This runs everywhere because it MONKEYPATCHES availability rather than needing verovio."""

    def test_referee_pick_returns_none_when_unavailable(self, monkeypatch):
        monkeypatch.setattr(referee, "REFEREE_AVAILABLE", False)
        assert referee.referee_pick(None, {}, None, None) is None

    def test_render_candidate_returns_none_when_unavailable(self, monkeypatch):
        monkeypatch.setattr(referee, "REFEREE_AVAILABLE", False)
        assert referee.render_candidate("C", 5, "G") is None

    def test_score_candidate_returns_none_when_unavailable(self, monkeypatch):
        monkeypatch.setattr(referee, "REFEREE_AVAILABLE", False)
        assert referee.score_candidate(None, {}, None) is None

    def test_module_imports_cleanly(self):
        # Re-importing the module must never raise even though the prod worker lacks verovio;
        # REFEREE_AVAILABLE is the boolean callers branch on.
        mod = importlib.import_module("referee")
        assert isinstance(mod.REFEREE_AVAILABLE, bool)


class TestNeverRaiseContract:
    """Public functions must return the safe default on garbage input, never throw. These run
    everywhere: when verovio is present the bad input still degrades; when absent the
    availability guard short-circuits first. Either way: no exception."""

    def test_referee_pick_on_garbage_does_not_raise(self):
        assert referee.referee_pick("not an array", {"bad": 1}, object(), object()) is None

    def test_score_candidate_on_garbage_does_not_raise(self):
        assert referee.score_candidate(123, None, "nope") is None

    def test_render_candidate_on_garbage_does_not_raise(self):
        # a nonsense step must not crash the renderer
        assert referee.render_candidate(object(), "x", "Q") is None


# --- verovio tier: SKIP cleanly when REFEREE_AVAILABLE is False ----------------------------

requires_verovio = pytest.mark.skipif(
    not referee.REFEREE_AVAILABLE,
    reason="verovio/cairosvg not installed (prod worker / CI) - referee tests skipped",
)

_STEPS = referee._STEPS


def _diatonic_shift(step, octave, degrees):
    """Shift a (step, octave) by a number of diatonic degrees."""
    idx = _STEPS.index(step) + 7 * octave + degrees
    return _STEPS[idx % 7], idx // 7


def _make_original(step, octave, clef="G"):
    """Render a known pitch with verovio and treat it as the stand-in ORIGINAL crop, deriving
    its staff geometry the way the caller eventually will. Returns (gray, staff_geometry)."""
    gray = referee.render_candidate(step, octave, clef)
    assert gray is not None, "verovio render failed"
    sp, lines = referee._staff_lines(gray)
    assert sp is not None and lines is not None and len(lines) >= 5
    nx = referee._find_notehead_x(gray, sp)
    assert nx is not None, "notehead localization failed on the original"
    return gray, {"lines": lines, "x_center": nx}


@requires_verovio
class TestRenderCompositing:
    def test_render_is_not_blank(self):
        gray = referee.render_candidate("C", 5, "G")
        assert gray is not None
        # Compositing on white must yield a real image: not all-white (would mean no ink)
        # and not all-black (the transparent-bg gotcha would turn the page all-ink).
        assert gray.min() < 0.2, "no ink found - compositing or render failed"
        assert gray.max() > 0.8, "no white background - transparent-bg gotcha not handled"
        ink_fraction = float((gray < 0.5).mean())
        assert 0.0 < ink_fraction < 0.5, f"ink fraction implausible: {ink_fraction}"

    def test_render_returns_numpy_2d(self):
        gray = referee.render_candidate("G", 4, "G")
        assert gray is not None
        assert gray.ndim == 2
        assert gray.dtype.kind == "f"


@requires_verovio
class TestRefereePickCorrect:
    """referee_pick returns the candidate whose notehead matches the original for octave and
    third disputes: correct beats wrong by >= MARGIN_THRESHOLD."""

    @pytest.mark.parametrize("step,octave", [("C", 5), ("G", 5), ("B", 4), ("A", 4)])
    def test_picks_correct_over_octave_wrong(self, step, octave):
        orig, geom = _make_original(step, octave)
        correct = referee.render_candidate(step, octave)
        wrong = referee.render_candidate(*_diatonic_shift(step, octave, 7))  # an octave up
        assert referee.referee_pick(orig, geom, correct, wrong) == "a"
        # ...and order-independent: correct as candidate_b -> 'b'
        assert referee.referee_pick(orig, geom, wrong, correct) == "b"

    @pytest.mark.parametrize("step,octave", [("C", 5), ("G", 5), ("B", 4), ("A", 4)])
    def test_picks_correct_over_third_wrong(self, step, octave):
        orig, geom = _make_original(step, octave)
        correct = referee.render_candidate(step, octave)
        wrong = referee.render_candidate(*_diatonic_shift(step, octave, 2))  # a third up
        assert referee.referee_pick(orig, geom, correct, wrong) == "a"

    def test_correct_margin_clears_threshold(self):
        orig, geom = _make_original("C", 5)
        correct = referee.render_candidate("C", 5)
        wrong = referee.render_candidate(*_diatonic_shift("C", 5, 7))
        s_correct = referee.score_candidate(orig, geom, correct)
        s_wrong = referee.score_candidate(orig, geom, wrong)
        assert s_correct is not None and s_wrong is not None
        assert (s_correct - s_wrong) >= referee.MARGIN_THRESHOLD


@requires_verovio
class TestRefereePickDeclines:
    """The core safety: a low-margin / ambiguous comparison must DECLINE (return None), never
    guess."""

    def test_declines_when_candidates_symmetric_octave(self):
        # original C5; candidate_a = octave up, candidate_b = octave down. Both wrong by the
        # same distance, so their scores are within MARGIN_THRESHOLD -> decline.
        orig, geom = _make_original("C", 5)
        a = referee.render_candidate(*_diatonic_shift("C", 5, 7))
        b = referee.render_candidate(*_diatonic_shift("C", 5, -7))
        s_a = referee.score_candidate(orig, geom, a)
        s_b = referee.score_candidate(orig, geom, b)
        assert s_a is not None and s_b is not None
        assert abs(s_a - s_b) < referee.MARGIN_THRESHOLD  # the precondition the test relies on
        assert referee.referee_pick(orig, geom, a, b) is None

    def test_declines_when_candidates_symmetric_third(self):
        orig, geom = _make_original("C", 5)
        a = referee.render_candidate(*_diatonic_shift("C", 5, 2))
        b = referee.render_candidate(*_diatonic_shift("C", 5, -2))
        assert referee.referee_pick(orig, geom, a, b) is None

    def test_declines_when_a_candidate_fails_to_render(self):
        orig, geom = _make_original("C", 5)
        correct = referee.render_candidate("C", 5)
        # candidate_b is None (its render failed) -> cannot score -> decline.
        assert referee.referee_pick(orig, geom, correct, None) is None

    def test_declines_on_degenerate_geometry(self):
        orig, _ = _make_original("C", 5)
        correct = referee.render_candidate("C", 5)
        wrong = referee.render_candidate(*_diatonic_shift("C", 5, 7))
        # fewer than 5 staff lines in geometry -> _original_band returns None -> decline.
        bad_geom = {"lines": [10.0, 20.0], "x_center": 100.0}
        assert referee.referee_pick(orig, bad_geom, correct, wrong) is None
