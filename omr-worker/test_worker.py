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


def test_dpi_is_in_the_swept_sweet_spot():
    # The old workflow rasterized at 300 DPI; #109 raised it to 400 for denser pixels.
    # The #112 sweep (250/300/350/400/500 on icarus.pdf, judged by recall AND fidelity
    # vs the source PDF) then found 400 was PAST oemer's sweet spot and 350 recovers more
    # genuine LH chord tones with zero fabricated accidentals. Pin the value to the swept
    # range: above the old 300 baseline but not back up at the 400 that hurt chord
    # separation. A future edit must not silently drift outside this measured band.
    assert 300 < worker.PDF_RASTER_DPI <= 400
    assert worker.PDF_RASTER_DPI == 350


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


# --- Clarity-OMR engine wiring (#135) ----------------------------------------------------


def test_clarity_command_shape():
    cmd = worker.clarity_command(
        "/venv/bin/python", "/clarity/omr.py", "/in/score.pdf", "/out/clarity.musicxml",
        "/work",
    )
    assert cmd == [
        "/venv/bin/python",
        "/clarity/omr.py",
        "/in/score.pdf",
        "-o",
        "/out/clarity.musicxml",
        "--device",
        "cpu",
        "--fast",
        "--work-dir",
        "/work",
    ]


def test_run_clarity_returns_none_when_env_unset(tmp_path, monkeypatch):
    # With CLARITY_OMR_DIR / CLARITY_PYTHON unset, run_clarity must return None (no crash)
    # so process_job falls back to oemer.
    monkeypatch.delenv("CLARITY_OMR_DIR", raising=False)
    monkeypatch.delenv("CLARITY_PYTHON", raising=False)
    assert worker.run_clarity(str(tmp_path / "score.pdf"), str(tmp_path)) is None


def test_run_clarity_returns_none_when_paths_missing(tmp_path, monkeypatch):
    # Env set but pointing at non-existent script/python -> None, not an exception.
    monkeypatch.setenv("CLARITY_OMR_DIR", str(tmp_path / "nope"))
    monkeypatch.setenv("CLARITY_PYTHON", str(tmp_path / "nopython"))
    assert worker.run_clarity(str(tmp_path / "score.pdf"), str(tmp_path)) is None


# --- merge_to_grand_staff (#135) ---------------------------------------------------------

TWO_PART_XML = b"""<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list>
    <score-part id="P1"><part-name/></score-part>
    <score-part id="P2"><part-name/></score-part>
  </part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>2</divisions>
        <time><beats>2</beats><beat-type>2</beat-type></time>
        <clef><sign>G</sign><line>2</line></clef>
      </attributes>
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>4</duration><type>half</type></note>
    </measure>
  </part>
  <part id="P2">
    <measure number="1">
      <attributes>
        <divisions>2</divisions>
        <time><beats>2</beats><beat-type>2</beat-type></time>
        <clef><sign>F</sign><line>4</line></clef>
      </attributes>
      <note><pitch><step>C</step><octave>3</octave></pitch><duration>4</duration><type>half</type></note>
    </measure>
  </part>
</score-partwise>
"""

# Bass-first document order (the F-clef part is written FIRST): the merge must still put
# the treble (G) on staff 1 and bass (F) on staff 2 by clef sign, not document order.
TWO_PART_BASS_FIRST_XML = b"""<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list>
    <score-part id="P1"><part-name/></score-part>
    <score-part id="P2"><part-name/></score-part>
  </part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>2</divisions><clef><sign>F</sign><line>4</line></clef></attributes>
      <note><pitch><step>C</step><octave>3</octave></pitch><duration>4</duration><type>half</type></note>
    </measure>
  </part>
  <part id="P2">
    <measure number="1">
      <attributes><divisions>2</divisions><clef><sign>G</sign><line>2</line></clef></attributes>
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>4</duration><type>half</type></note>
    </measure>
  </part>
</score-partwise>
"""

ONE_PART_XML = b"""<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name/></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>2</divisions><staves>2</staves>
        <clef number="1"><sign>G</sign><line>2</line></clef>
        <clef number="2"><sign>F</sign><line>4</line></clef>
      </attributes>
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>4</duration><type>half</type><staff>1</staff></note>
    </measure>
  </part>
</score-partwise>
"""


def test_merge_to_grand_staff_collapses_two_parts():
    import xml.etree.ElementTree as ET

    out = worker.merge_to_grand_staff(TWO_PART_XML)
    root = ET.fromstring(out)
    parts = root.findall("part")
    assert len(parts) == 1, "two parts collapse to one grand-staff part"

    score_parts = root.find("part-list").findall("score-part")
    assert len(score_parts) == 1, "part-list drops the second score-part"

    measure = parts[0].find("measure")
    assert measure.find("attributes/staves").text == "2"

    notes = measure.findall("note")
    assert len(notes) == 2
    # Treble note (C5) on staff 1, bass note (C3) on staff 2.
    treble = notes[0]
    bass = notes[1]
    assert treble.findtext("pitch/octave") == "5"
    assert treble.findtext("staff") == "1"
    assert bass.findtext("pitch/octave") == "3"
    assert bass.findtext("staff") == "2"
    # A <backup> separates the two staves so the bass rewinds to the measure start.
    backup = measure.find("backup")
    assert backup is not None
    assert backup.findtext("duration") == "4"


def test_merge_to_grand_staff_assigns_staff_by_clef_not_order():
    import xml.etree.ElementTree as ET

    out = worker.merge_to_grand_staff(TWO_PART_BASS_FIRST_XML)
    root = ET.fromstring(out)
    notes = root.find("part/measure").findall("note")
    # Even though the F-clef part came first in the document, the G-clef treble note is
    # emitted first on staff 1 and the bass note on staff 2.
    assert notes[0].findtext("pitch/octave") == "5"  # treble C5
    assert notes[0].findtext("staff") == "1"
    assert notes[1].findtext("pitch/octave") == "3"  # bass C3
    assert notes[1].findtext("staff") == "2"


def test_merge_to_grand_staff_noop_on_single_part():
    # oemer already emits one grand-staff part; the merge must leave it byte-identical.
    out = worker.merge_to_grand_staff(ONE_PART_XML)
    assert out == ONE_PART_XML


# A measure where OMR dropped a treble note, so the treble fill (one half note, duration 2)
# is SHORTER than the bass fill (one whole note, duration 4). The <backup> must rewind by
# the TREBLE advance (2), not the bass duration (4); a bass_dur backup would over-rewind
# past the measure start and play the bass early (falling-bar + cursor timing skew).
MISMATCHED_FILL_XML = b"""<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list>
    <score-part id="P1"><part-name/></score-part>
    <score-part id="P2"><part-name/></score-part>
  </part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>1</divisions><clef><sign>G</sign><line>2</line></clef></attributes>
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>2</duration><type>half</type></note>
    </measure>
  </part>
  <part id="P2">
    <measure number="1">
      <attributes><divisions>1</divisions><clef><sign>F</sign><line>4</line></clef></attributes>
      <note><pitch><step>C</step><octave>3</octave></pitch><duration>4</duration><type>whole</type></note>
    </measure>
  </part>
</score-partwise>
"""


def test_merge_to_grand_staff_backup_uses_treble_advance_not_bass():
    # Bug-2 regression: treble advance is 2, bass fill is 4. The <backup> must equal the
    # treble advance (2) so staff 2 rewinds exactly to the measure start, not 4 (which would
    # over-rewind past the start). MUST fail against the old bass_dur backup.
    import xml.etree.ElementTree as ET

    out = worker.merge_to_grand_staff(MISMATCHED_FILL_XML)
    measure = ET.fromstring(out).find("part/measure")
    backup = measure.find("backup")
    assert backup is not None
    assert backup.findtext("duration") == "2", "backup rewinds by the treble advance, not bass"


# --- normalize_ties (#135) ---------------------------------------------------------------

CROSS_PITCH_TIE_XML = b"""<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name/></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <note><pitch><step>A</step><octave>4</octave></pitch><duration>4</duration>
        <tie type="start"/><type>half</type>
        <notations><tied type="start"/></notations></note>
    </measure>
    <measure number="2">
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration>
        <tie type="stop"/><type>half</type>
        <notations><tied type="stop"/></notations></note>
    </measure>
  </part>
</score-partwise>
"""

DANGLING_START_XML = b"""<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name/></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <note><pitch><step>C</step><octave>2</octave></pitch><duration>4</duration>
        <tie type="start"/><type>whole</type>
        <notations><tied type="start"/></notations></note>
    </measure>
    <measure number="2">
      <note><pitch><step>C</step><octave>2</octave></pitch><duration>4</duration><type>whole</type></note>
    </measure>
  </part>
</score-partwise>
"""

TERMINAL_DANGLING_START_XML = b"""<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name/></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <note><pitch><step>G</step><octave>2</octave></pitch><duration>4</duration>
        <tie type="start"/><type>whole</type>
        <notations><tied type="start"/></notations></note>
    </measure>
  </part>
</score-partwise>
"""

TIE_FREE_XML = b"""<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name/></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><type>whole</type></note>
    </measure>
  </part>
</score-partwise>
"""


def _ties_in(xml_bytes):
    import xml.etree.ElementTree as ET

    root = ET.fromstring(xml_bytes)
    return [t.get("type") for t in root.iter("tie")]


def _tied_in(xml_bytes):
    import xml.etree.ElementTree as ET

    root = ET.fromstring(xml_bytes)
    return [t.get("type") for t in root.iter("tied")]


def test_normalize_ties_drops_cross_pitch_tie():
    # A start on A4 and a stop on C4 is not a real tie (different pitches). Both ends drop;
    # the notes survive as separate re-attacks.
    out = worker.normalize_ties(CROSS_PITCH_TIE_XML)
    assert _ties_in(out) == [], "cross-pitch tie markup removed"
    assert _tied_in(out) == []
    # Both notes still present.
    import xml.etree.ElementTree as ET

    assert len(ET.fromstring(out).findall(".//note")) == 2


def test_normalize_ties_closes_dangling_start_to_next_same_pitch():
    # The model emitted a tie=start on C2 with no stop; the next measure has a same-pitch
    # C2. normalize_ties must add a matching stop so OSMD/mergeTiedNotes can fold them.
    out = worker.normalize_ties(DANGLING_START_XML)
    import xml.etree.ElementTree as ET

    root = ET.fromstring(out)
    notes = root.findall(".//note")
    assert [t.get("type") for t in notes[0].findall("tie")] == ["start"]
    assert [t.get("type") for t in notes[1].findall("tie")] == ["stop"]
    assert [t.get("type") for t in notes[1].find("notations").findall("tied")] == ["stop"]


def test_normalize_ties_drops_terminal_dangling_start():
    # A tie=start with NO following same-pitch note cannot be paired; drop it rather than
    # fabricate a stop. The note remains, untied.
    out = worker.normalize_ties(TERMINAL_DANGLING_START_XML)
    assert _ties_in(out) == []
    assert _tied_in(out) == []
    import xml.etree.ElementTree as ET

    assert len(ET.fromstring(out).findall(".//note")) == 1


def test_normalize_ties_noop_on_tie_free_input():
    # oemer output has zero ties; normalize_ties must not invent any.
    out = worker.normalize_ties(TIE_FREE_XML)
    assert _ties_in(out) == []
    assert _tied_in(out) == []


# A held LH CHORD: C4 and E4 in the SAME staff each tied across a barline, with BOTH a
# start (measure 1) and an explicit stop (measure 2). The stops are interleaved (the m2
# stops appear in E4-then-C4 order, the opposite of the m1 C4-then-E4 starts), so the old
# "first different-pitch stop -> drop both ends" loop would corrupt them. Pitch-matched
# pairing must leave BOTH ties intact.
INTERLEAVED_CHORD_TIE_XML = b"""<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name/></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration>
        <tie type="start"/><type>half</type><staff>2</staff>
        <notations><tied type="start"/></notations></note>
      <note><chord/><pitch><step>E</step><octave>4</octave></pitch><duration>4</duration>
        <tie type="start"/><type>half</type><staff>2</staff>
        <notations><tied type="start"/></notations></note>
    </measure>
    <measure number="2">
      <note><pitch><step>E</step><octave>4</octave></pitch><duration>4</duration>
        <tie type="stop"/><type>half</type><staff>2</staff>
        <notations><tied type="stop"/></notations></note>
      <note><chord/><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration>
        <tie type="stop"/><type>half</type><staff>2</staff>
        <notations><tied type="stop"/></notations></note>
    </measure>
  </part>
</score-partwise>
"""


def test_normalize_ties_keeps_interleaved_chord_ties():
    # Bug-1 regression: a tied chord whose start/stop markers interleave by pitch. Both the
    # C4 and the E4 tie must survive (both starts keep their start, both stops keep their
    # stop, nothing dropped). This MUST fail against the old "drop both on pitch mismatch"
    # code, which nuked a sibling's legitimate tie when it hit the wrong-pitch stop first.
    import xml.etree.ElementTree as ET

    out = worker.normalize_ties(INTERLEAVED_CHORD_TIE_XML)
    assert sorted(_ties_in(out)) == ["start", "start", "stop", "stop"]
    assert sorted(_tied_in(out)) == ["start", "start", "stop", "stop"]

    root = ET.fromstring(out)
    notes = root.findall(".//note")
    assert len(notes) == 4, "no notes dropped"

    def tie_for(step, octave, want):
        for n in notes:
            if n.findtext("pitch/step") == step and n.findtext("pitch/octave") == octave:
                if want in [t.get("type") for t in n.findall("tie")]:
                    return True
        return False

    assert tie_for("C", "4", "start"), "C4 keeps its start"
    assert tie_for("E", "4", "start"), "E4 keeps its start"
    assert tie_for("C", "4", "stop"), "C4 keeps its stop"
    assert tie_for("E", "4", "stop"), "E4 keeps its stop"


# A model cross-pitch false positive: a start on pitch X (A4) with NO same-pitch follower,
# and a dangling stop on a different pitch Y (C4) with no preceding same-pitch start. The
# starts pass drops the A4 start (no A4 follower) and the stops pass drops the C4 stop (no
# preceding C4 start). Both markers must vanish, both notes survive.
CROSS_PITCH_FALSE_POSITIVE_XML = b"""<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name/></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <note><pitch><step>A</step><octave>4</octave></pitch><duration>4</duration>
        <tie type="start"/><type>half</type>
        <notations><tied type="start"/></notations></note>
    </measure>
    <measure number="2">
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration>
        <tie type="stop"/><type>half</type>
        <notations><tied type="stop"/></notations></note>
    </measure>
  </part>
</score-partwise>
"""


def test_normalize_ties_drops_cross_pitch_false_positive():
    # The A4 start has no A4 follower (dropped in the starts pass) and the C4 stop has no
    # preceding C4 start (dropped in the stops pass). Both invalid markers vanish.
    import xml.etree.ElementTree as ET

    out = worker.normalize_ties(CROSS_PITCH_FALSE_POSITIVE_XML)
    assert _ties_in(out) == [], "cross-pitch start and stop both removed"
    assert _tied_in(out) == []
    assert len(ET.fromstring(out).findall(".//note")) == 2, "both notes survive"
