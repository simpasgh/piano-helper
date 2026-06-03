#!/usr/bin/env python3
"""Tests for the key-signature prior added to the geometric decode: keyed_alter (the circle-of-
fifths accidental table) and decode_pitch's fifths argument. This is what lets the exact decode
recover sharps/flats in real keys instead of reading everything as natural."""
import geom_omr


def test_keyed_alter_c_major_all_natural():
    for step in "CDEFGAB":
        assert geom_omr.keyed_alter(step, 0) == 0


def test_keyed_alter_sharps_add_in_order():
    # F C G D A E B
    assert geom_omr.keyed_alter("F", 1) == 1
    assert geom_omr.keyed_alter("C", 1) == 0      # only F# in 1-sharp
    assert geom_omr.keyed_alter("C", 2) == 1      # F#, C#
    assert geom_omr.keyed_alter("G", 2) == 0
    assert geom_omr.keyed_alter("G", 3) == 1      # F#, C#, G#
    # 7 sharps -> every letter sharp
    for step in "CDEFGAB":
        assert geom_omr.keyed_alter(step, 7) == 1


def test_keyed_alter_flats_add_in_order():
    # B E A D G C F
    assert geom_omr.keyed_alter("B", -1) == -1
    assert geom_omr.keyed_alter("E", -1) == 0     # only Bb in 1-flat
    assert geom_omr.keyed_alter("E", -2) == -1    # Bb, Eb
    assert geom_omr.keyed_alter("A", -2) == 0
    assert geom_omr.keyed_alter("A", -3) == -1    # Bb, Eb, Ab
    for step in "CDEFGAB":
        assert geom_omr.keyed_alter(step, -7) == -1


def test_keyed_alter_robust_to_garbage():
    assert geom_omr.keyed_alter("F", "not-an-int") == 0


def _treble_staff(interline=20.0, bottom_y=180.0):
    # 5 lines top-to-bottom; bottom line (largest y) is E4 in treble.
    return [bottom_y - 4 * interline, bottom_y - 3 * interline, bottom_y - 2 * interline,
            bottom_y - interline, bottom_y]


def test_decode_pitch_applies_key_to_f():
    lines = _treble_staff(interline=20.0, bottom_y=180.0)
    # one diatonic step above E4 (bottom line) is F4: y = bottom - half(=10).
    assert geom_omr.decode_pitch(170.0, lines, "G", fifths=0) == ("F", 0, 4)   # natural in C
    assert geom_omr.decode_pitch(170.0, lines, "G", fifths=1) == ("F", 1, 4)   # F# in G major
    assert geom_omr.decode_pitch(170.0, lines, "G", fifths=-1) == ("F", 0, 4)  # 1-flat: F still natural


def test_decode_pitch_default_fifths_is_natural():
    lines = _treble_staff()
    # backward compatible: no fifths arg behaves exactly like the original natural-only decode.
    step, alter, octave = geom_omr.decode_pitch(180.0, lines, "G")
    assert (step, alter, octave) == ("E", 0, 4)
