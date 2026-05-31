"""Unit tests for the OMR worker preprocessing (#109).

Covers the rasterization changes we own: the DPI value, multi-page handling
(vertical stitch), and the oemer deskew gating. These are the levers that raise raw
OMR fidelity for clean vector PDFs.

Run locally with: python3 -m pytest omr-worker/test_worker.py

Note on CI: the repo's CI (.github/workflows/ci.yml) is a Node pipeline (typecheck +
vitest + build) and does not run pytest, so these Python tests are not a CI gate today.
A lightweight JS source-guard test (src/omr-worker.test.ts) locks the worker wiring
(DPI constant, all-pages rasterization, deskew flag) inside the existing vitest run so a
regression here is still caught in CI. See tech-lead.md.

boto3 is an install-time dependency of worker.py but is not needed for the pure
preprocessing functions, so it is stubbed before import to keep these tests runnable on
any machine (including CI, if it ever grows a pytest step).
"""

import sys
import types

# Stub the S3 stack so importing worker.py does not require boto3 to be installed.
for _name in ("boto3", "botocore", "botocore.client", "botocore.exceptions"):
    if _name not in sys.modules:
        sys.modules[_name] = types.ModuleType(_name)
if not hasattr(sys.modules["botocore.client"], "Config"):
    sys.modules["botocore.client"].Config = object
if not hasattr(sys.modules["botocore.exceptions"], "ClientError"):
    sys.modules["botocore.exceptions"].ClientError = type(
        "ClientError", (Exception,), {}
    )

import pytest  # noqa: E402

import worker  # noqa: E402

Image = pytest.importorskip("PIL.Image")


def test_dpi_is_raised_above_old_300():
    # The old workflow rasterized at 300 DPI. #109 raises it for denser pixels.
    assert worker.PDF_RASTER_DPI > 300
    # Stay within the Always Free VM budget: do not let a future edit push it absurdly high.
    assert worker.PDF_RASTER_DPI <= 600


def test_oemer_command_disables_deskew_on_pdf_path():
    cmd = worker.oemer_command("/tmp/page.png", "/tmp/out", without_deskew=True)
    assert cmd == ["oemer", "/tmp/page.png", "-o", "/tmp/out", "--without-deskew"]


def test_oemer_command_keeps_deskew_for_raster_images():
    # A scanned PNG/JPEG may be skewed, so deskew stays on (no flag).
    cmd = worker.oemer_command("/tmp/page.png", "/tmp/out", without_deskew=False)
    assert cmd == ["oemer", "/tmp/page.png", "-o", "/tmp/out"]
    assert "--without-deskew" not in cmd


def _make_png(path, size, color):
    Image.new("RGB", size, color).save(path)


def test_single_page_stitch_is_a_plain_copy(tmp_path):
    src = tmp_path / "page-1.png"
    _make_png(src, (120, 90), (10, 20, 30))
    dest = tmp_path / "stitched.png"

    out = worker.stitch_pages_vertical([str(src)], str(dest))

    assert out == str(dest)
    with Image.open(out) as im:
        assert im.size == (120, 90)
        assert im.mode == "RGB"


def test_multi_page_stitch_stacks_vertically(tmp_path):
    a = tmp_path / "page-1.png"
    b = tmp_path / "page-2.png"
    _make_png(a, (100, 60), (200, 0, 0))   # red, narrower
    _make_png(b, (140, 40), (0, 0, 200))   # blue, wider
    dest = tmp_path / "stitched.png"

    worker.stitch_pages_vertical([str(a), str(b)], str(dest))

    with Image.open(dest) as im:
        # Width is the widest page; height is the sum (no page dropped).
        assert im.size == (140, 100)
        # Page 1 sits at the top, page 2 directly below it.
        assert im.getpixel((0, 0)) == (200, 0, 0)
        assert im.getpixel((0, 80)) == (0, 0, 200)
        # The narrow first page leaves a white-background gutter, not garbage.
        assert im.getpixel((120, 10)) == (255, 255, 255)


def test_stitch_preserves_document_page_order(tmp_path):
    # pdftoppm names pages page-1/page-01/page-001; sorted() must keep them in order.
    first = tmp_path / "page-1.png"
    second = tmp_path / "page-2.png"
    third = tmp_path / "page-3.png"
    _make_png(first, (10, 10), (255, 0, 0))
    _make_png(second, (10, 10), (0, 255, 0))
    _make_png(third, (10, 10), (0, 0, 255))
    dest = tmp_path / "stitched.png"

    worker.stitch_pages_vertical([str(first), str(second), str(third)], str(dest))

    with Image.open(dest) as im:
        assert im.size == (10, 30)
        assert im.getpixel((5, 5)) == (255, 0, 0)     # page 1
        assert im.getpixel((5, 15)) == (0, 255, 0)    # page 2
        assert im.getpixel((5, 25)) == (0, 0, 255)    # page 3


def test_stitch_rejects_empty_page_list(tmp_path):
    with pytest.raises(RuntimeError):
        worker.stitch_pages_vertical([], str(tmp_path / "stitched.png"))


def test_stitch_rejects_too_many_pages(tmp_path):
    # A crafted many-page 10 MB vector PDF must not be able to drive an unbounded stitch
    # (OOM risk on the Always Free VM). Reject before opening any page image.
    paths = [
        str(tmp_path / ("page-%03d.png" % i))
        for i in range(worker.MAX_STITCH_PAGES + 1)
    ]
    # The files need not exist: the page-count guard fires before any Image.open.
    with pytest.raises(RuntimeError):
        worker.stitch_pages_vertical(paths, str(tmp_path / "stitched.png"))


def test_stitch_rejects_oversized_total_area(tmp_path, monkeypatch):
    # Lower the pixel cap so a couple of small pages exceed it, proving the area guard
    # rejects (raising) instead of allocating a giant canvas. Two pages stay under the
    # page-count cap, so this isolates the AREA guard.
    # Cap = 2000: a single 40x40 page (1600 px) still opens (Pillow bomb guard is 2x cap),
    # but the two-page total (3200 px) trips the pre-allocation area guard.
    monkeypatch.setattr(worker, "MAX_STITCH_PIXELS", 2000)
    a = tmp_path / "page-1.png"
    b = tmp_path / "page-2.png"
    _make_png(a, (40, 40), (0, 0, 0))   # 1600 px each, 3200 total > 2000
    _make_png(b, (40, 40), (0, 0, 0))
    with pytest.raises(RuntimeError):
        worker.stitch_pages_vertical([str(a), str(b)], str(tmp_path / "stitched.png"))


# ---------------------------------------------------------------------------
# Left-hand chord completion post-pass (#113)
# ---------------------------------------------------------------------------

import xml.etree.ElementTree as ET  # noqa: E402


def test_pitch_semitone_roundtrip():
    # Middle C is 60 (MIDI convention).
    assert worker.pitch_to_semitone("C", 0, 4) == 60
    assert worker.pitch_to_semitone("A", 0, 4) == 69
    assert worker.pitch_to_semitone("C", 1, 4) == 61  # C#4
    assert worker.pitch_to_semitone("D", -1, 4) == 61  # Db4 sounds the same
    # Roundtrip back to a canonical sharp spelling.
    assert worker.semitone_to_pitch(60) == ("C", 0, 4)
    assert worker.semitone_to_pitch(61) == ("C", 1, 4)
    assert worker.semitone_to_pitch(67) == ("G", 0, 4)
    assert worker.semitone_to_pitch(69) == ("A", 0, 4)
    # Db4 (61) round-trips to the sharp spelling C#4 but the same semitone.
    step, alter, octave = worker.semitone_to_pitch(
        worker.pitch_to_semitone("D", -1, 4)
    )
    assert worker.pitch_to_semitone(step, alter, octave) == 61


def test_dominant_pattern_prefers_triad_over_dyad():
    from collections import Counter

    # A size-2 shape is more common, but a triad exists, so the triad wins.
    counts = Counter({(0, 7): 5, (0, 4, 7): 2, (0, 3, 7): 1})
    assert worker._dominant_pattern(counts) == (0, 4, 7)


def test_dominant_pattern_falls_back_to_dyad_when_no_triad():
    from collections import Counter

    counts = Counter({(0, 7): 3, (0, 5): 1})
    assert worker._dominant_pattern(counts) == (0, 7)


def test_interval_pattern_is_offsets_above_lowest():
    # Build a C-major triad chord-group: C4, E4, G4.
    measure = ET.fromstring(
        "<measure>"
        "<note><pitch><step>C</step><octave>4</octave></pitch>"
        "<duration>4</duration><staff>2</staff></note>"
        "<note><chord/><pitch><step>E</step><octave>4</octave></pitch>"
        "<duration>4</duration><staff>2</staff></note>"
        "<note><chord/><pitch><step>G</step><octave>4</octave></pitch>"
        "<duration>4</duration><staff>2</staff></note>"
        "</measure>"
    )
    groups = worker._chord_groups(measure)
    assert len(groups) == 1
    assert worker._interval_pattern(groups[0]) == (0, 4, 7)


def _grand_staff_fixture():
    """A 1-part, 2-staff grand staff: staff-1 (RH) notes, two staff-2 measures
    with a detected C-major triad, and several staff-2 measures with a lone note
    at the same (whole-note) duration that should be completed. Measure 6's LH
    slot is a rest, so it must gain nothing."""
    def lh_chord(root_step, root_oct):
        # root + major triad (root, +4, +7) at duration 16 / whole.
        return (
            "<note><pitch><step>%s</step><octave>%d</octave></pitch>"
            "<duration>16</duration><voice>2</voice><type>whole</type>"
            "<staff>2</staff></note>"
            "<note><chord/><pitch><step>E</step><octave>%d</octave></pitch>"
            "<duration>16</duration><voice>2</voice><type>whole</type>"
            "<staff>2</staff></note>"
            "<note><chord/><pitch><step>G</step><octave>%d</octave></pitch>"
            "<duration>16</duration><voice>2</voice><type>whole</type>"
            "<staff>2</staff></note>"
        ) % (root_step, root_oct, root_oct, root_oct)

    def lh_single(step, octave):
        return (
            "<note><pitch><step>%s</step><octave>%d</octave></pitch>"
            "<duration>16</duration><voice>2</voice><type>whole</type>"
            "<staff>2</staff></note>"
        ) % (step, octave)

    def rh_note(step, octave):
        return (
            "<note><pitch><step>%s</step><octave>%d</octave></pitch>"
            "<duration>16</duration><voice>1</voice><type>whole</type>"
            "<staff>1</staff></note>"
        ) % (step, octave)

    def measure(number, rh, lh):
        attrs = ""
        if number == 1:
            attrs = (
                "<attributes><divisions>4</divisions>"
                "<key><fifths>0</fifths></key>"
                "<time><beats>4</beats><beat-type>4</beat-type></time>"
                "<clef number=\"1\"><sign>G</sign><line>2</line></clef>"
                "<clef number=\"2\"><sign>F</sign><line>4</line></clef>"
                "<staves>2</staves></attributes>"
            )
        return (
            "<measure number=\"%d\">%s%s<backup><duration>16</duration></backup>%s</measure>"
            % (number, attrs, rh, lh)
        )

    measures = [
        # Two measures with a real detected C-major triad.
        measure(1, rh_note("C", 5), lh_chord("C", 3)),
        measure(2, rh_note("D", 5), lh_chord("C", 3)),
        # Lone LH notes at the same duration: should be completed to a triad.
        measure(3, rh_note("E", 5), lh_single("C", 3)),
        measure(4, rh_note("F", 5), lh_single("G", 2)),
        measure(5, rh_note("G", 5), lh_single("F", 2)),
        # Measure 6 has NO LH note (a rest): must gain nothing.
        measure(
            6,
            rh_note("A", 5),
            "<note><rest/><duration>16</duration><voice>2</voice>"
            "<type>whole</type><staff>2</staff></note>",
        ),
    ]
    return (
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>"
        "<score-partwise version=\"4.0\">"
        "<part-list><score-part id=\"P1\"><part-name>Piano</part-name>"
        "</score-part></part-list>"
        "<part id=\"P1\">" + "".join(measures) + "</part>"
        "</score-partwise>"
    ).encode("utf-8")


def _lh_chord_groups(part):
    """Helper: collect (measure_number, interval_pattern, lowest_semitone) for
    every staff-2 chord-group of size >= 1 across a part element."""
    out = []
    for measure in part.findall("measure"):
        for group in worker._chord_groups(measure):
            if not all(worker._is_lh_note(n) for _i, n in group):
                continue
            semis = [worker._read_note_pitch(n) for _i, n in group]
            out.append((measure.get("number"), worker._interval_pattern(group), min(semis)))
    return out


def test_post_pass_completes_lone_lh_notes_to_dominant_triad():
    out = worker.complete_lh_chords(_grand_staff_fixture())
    root = ET.fromstring(out)
    part = root.find("part")
    groups = _lh_chord_groups(part)

    by_measure = {num: (pattern, low) for num, pattern, low in groups}
    # Detected triads in measures 1 and 2 stay triads.
    assert by_measure["1"][0] == (0, 4, 7)
    assert by_measure["2"][0] == (0, 4, 7)
    # Lone notes in 3, 4, 5 became the dominant (0,4,7) shape ...
    for num, expected_low in (
        ("3", worker.pitch_to_semitone("C", 0, 3)),
        ("4", worker.pitch_to_semitone("G", 0, 2)),
        ("5", worker.pitch_to_semitone("F", 0, 2)),
    ):
        pattern, low = by_measure[num]
        assert pattern == (0, 4, 7), num
        # ... with the ORIGINAL note preserved as the lowest (root).
        assert low == expected_low, num


def test_post_pass_leaves_rh_staff1_notes_untouched():
    src = _grand_staff_fixture()
    out = worker.complete_lh_chords(src)
    before = ET.fromstring(src).find("part")
    after = ET.fromstring(out).find("part")

    def rh_pitches(part):
        result = []
        for measure in part.findall("measure"):
            for note in measure.findall("note"):
                staff = note.find("staff")
                if staff is not None and staff.text == "1":
                    p = note.find("pitch")
                    result.append((p.find("step").text, p.find("octave").text))
        return result

    assert rh_pitches(before) == rh_pitches(after)
    # Count is identical too.
    assert len(rh_pitches(after)) == 6


def test_post_pass_does_not_add_to_measure_with_no_lh_note():
    out = worker.complete_lh_chords(_grand_staff_fixture())
    part = ET.fromstring(out).find("part")
    measure6 = [m for m in part.findall("measure") if m.get("number") == "6"][0]
    lh_notes = [n for n in measure6.findall("note") if worker._is_lh_note(n)]
    # The rest is not a pitched LH note, so nothing was added.
    assert lh_notes == []
    # And the rest itself is still present and unchanged.
    rests = [n for n in measure6.findall("note") if n.find("rest") is not None]
    assert len(rests) == 1


def test_post_pass_raises_lh_chord_and_triad_counts():
    src = _grand_staff_fixture()
    out = worker.complete_lh_chords(src)

    def counts(xml_bytes):
        part = ET.fromstring(xml_bytes).find("part")
        chords = 0
        triads = 0
        for _num, pattern, _low in _lh_chord_groups(part):
            if pattern is None:
                continue
            if len(pattern) >= 2:
                chords += 1
            if len(pattern) >= 3:
                triads += 1
        return chords, triads

    before_chords, before_triads = counts(src)
    after_chords, after_triads = counts(out)
    assert after_chords > before_chords
    assert after_triads > before_triads


def test_post_pass_passes_single_staff_score_through_unchanged():
    # No <staff>2</staff> anywhere: a single-staff part is returned byte-for-byte.
    src = (
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>"
        "<score-partwise version=\"4.0\">"
        "<part-list><score-part id=\"P1\"><part-name>Music</part-name>"
        "</score-part></part-list>"
        "<part id=\"P1\"><measure number=\"1\">"
        "<note><pitch><step>C</step><octave>4</octave></pitch>"
        "<duration>4</duration><staff>1</staff></note>"
        "</measure></part></score-partwise>"
    ).encode("utf-8")
    assert worker.complete_lh_chords(src) == src


def test_post_pass_passes_multi_part_score_through_unchanged():
    # Two parts is not the grand-staff shape this pass reasons about.
    src = (
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>"
        "<score-partwise version=\"4.0\">"
        "<part-list>"
        "<score-part id=\"P1\"><part-name>RH</part-name></score-part>"
        "<score-part id=\"P2\"><part-name>LH</part-name></score-part>"
        "</part-list>"
        "<part id=\"P1\"><measure number=\"1\">"
        "<note><pitch><step>C</step><octave>5</octave></pitch>"
        "<duration>4</duration><staff>2</staff></note>"
        "</measure></part>"
        "<part id=\"P2\"><measure number=\"1\">"
        "<note><pitch><step>C</step><octave>3</octave></pitch>"
        "<duration>4</duration><staff>2</staff></note>"
        "</measure></part>"
        "</score-partwise>"
    ).encode("utf-8")
    assert worker.complete_lh_chords(src) == src


def test_post_pass_returns_malformed_xml_unchanged():
    bad = b"<score-partwise><part><measure></measure>"  # unclosed tags
    assert worker.complete_lh_chords(bad) == bad


def test_post_pass_no_detected_chords_returns_input_unchanged():
    # A grand staff with LH notes but NO detected chord: nothing to learn, so the
    # input passes through unchanged (no guessing a shape from nothing).
    src = (
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>"
        "<score-partwise version=\"4.0\">"
        "<part-list><score-part id=\"P1\"><part-name>Piano</part-name>"
        "</score-part></part-list>"
        "<part id=\"P1\"><measure number=\"1\">"
        "<note><pitch><step>G</step><octave>5</octave></pitch>"
        "<duration>4</duration><staff>1</staff></note>"
        "<note><pitch><step>C</step><octave>3</octave></pitch>"
        "<duration>4</duration><staff>2</staff></note>"
        "</measure></part></score-partwise>"
    ).encode("utf-8")
    assert worker.complete_lh_chords(src) == src
