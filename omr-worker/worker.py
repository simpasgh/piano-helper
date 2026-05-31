#!/usr/bin/env python3
"""OMR worker for Piano Helper.

Always-on poller that turns uploaded sheet music into MusicXML. It runs on an
Oracle Cloud Always Free ARM VM (see README.md) and is the compute backend that
replaced the old GitHub Actions runner. The transport contract with the
Cloudflare Pages Functions is unchanged and lives entirely in R2:

  input   uploads/<jobId>              raw PDF/PNG/JPEG bytes (any content-type)
  output  results/<jobId>.musicxml     UTF-8 MusicXML

Loop, for each object under uploads/:
  1. validate the jobId (it is a UUID; reject anything else),
  2. skip if results/<jobId>.musicxml already exists (idempotent re-runs),
  3. download the upload, rasterize all PDF pages with pdftoppm if needed and
     stitch them into one tall PNG,
  4. run oemer (deskew disabled on the PDF path), fall back to homr, and on
     success upload the MusicXML,
  5. if BOTH engines fail, upload a failure-sentinel MusicXML the browser
     detects (functions ... src/omr.ts FAILURE_SENTINEL_RE),
  6. delete uploads/<jobId> so it is not reprocessed.

Per-job exceptions are caught so one bad upload never kills the loop.

Config comes from env vars (no secrets in the file, none on disk):
  R2_S3_ENDPOINT        https://<account>.r2.cloudflarestorage.com
  R2_ACCESS_KEY_ID      R2 S3 API token access key id
  R2_SECRET_ACCESS_KEY  R2 S3 API token secret
  R2_BUCKET             bucket name (piano-helper-omr)
  OMR_POLL_SECONDS      poll interval, optional (default 5)
"""

import os
import subprocess
import sys
import tempfile
import time
import uuid
import xml.etree.ElementTree as ET
from collections import Counter

import boto3
from botocore.client import Config
from botocore.exceptions import ClientError

UPLOAD_PREFIX = "uploads/"
RESULT_SUFFIX = ".musicxml"
RESULT_CONTENT_TYPE = "application/vnd.recordare.musicxml+xml"
DEFAULT_POLL_SECONDS = 5

# Rasterization DPI for the PDF path. oemer exposes no DPI/quality knob of its own
# (its CLI is just -o, --use-tf, --save-cache, -d/--without-deskew), so the raster we
# hand it is the ONLY preprocessing lever we own. 400 (up from the old 300) gives the
# ML engine denser staff-line and notehead pixels, which is the highest-leverage,
# lowest-risk free fidelity gain (#109). It is deliberately conservative versus 600 to
# stay within the Oracle Always Free ARM VM's memory/time budget: a single A4 page at
# 400 DPI is ~3300x4675 px (~46 MP), and we may stitch several pages into one tall
# image below, so the working bitmap stays bounded. Bump cautiously if the VM allows.
PDF_RASTER_DPI = 400

# Resource guards for the stitched raster. The upload Function caps inputs at 10 MB
# (src/omr-server.ts MAX_UPLOAD_BYTES), but a sparse VECTOR PDF compresses so well that
# 10 MB can still hold hundreds of pages. At 400 DPI each A4 page is ~15.5 MP, so an
# unbounded vertical stitch of a crafted many-page PDF would allocate a multi-GB RGB
# bitmap on a box that also runs the oemer PyTorch/onnx stack: a real OOM that would
# kill the always-on poller (the OS OOM-killer is not catchable by poll_once). Bound BOTH
# the page count and the total stitched pixel area; exceeding either raises RuntimeError,
# which poll_once turns into a clean failure sentinel instead of crashing the worker.
# 60 pages * 15.5 MP ~= 930 MP is also the ceiling we hand oemer (well past any real score).
MAX_STITCH_PAGES = 60
MAX_STITCH_PIXELS = 1_000_000_000  # ~1 GP; RGB canvas ~3 GB worst case, then freed.

# Byte-compatible with src/omr.ts FAILURE_SENTINEL_RE = /name="omr-status"\s*>\s*failed/.
# Written to the result key when both engines fail so the browser stops polling and
# shows a friendly error instead of rendering a near-empty score as success.
FAILURE_SENTINEL = """<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="4.0">
  <work><work-title>OMR failed</work-title></work>
  <identification>
    <miscellaneous>
      <miscellaneous-field name="omr-status">failed</miscellaneous-field>
    </miscellaneous>
  </identification>
  <part-list>
    <score-part id="P1"><part-name>Music</part-name></score-part>
  </part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>1</divisions>
        <key><fifths>0</fifths></key>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        <clef><sign>G</sign><line>2</line></clef>
      </attributes>
      <note><rest/><duration>4</duration><type>whole</type></note>
    </measure>
  </part>
</score-partwise>
""".encode("utf-8")


def log(message):
    """Timestamped line on stdout so journald captures it under the unit."""
    print(time.strftime("%Y-%m-%dT%H:%M:%S"), message, flush=True)


def require_env(name):
    value = os.environ.get(name)
    if not value:
        log("FATAL missing required env var %s" % name)
        sys.exit(1)
    return value


def is_uuid(value):
    """The jobId is a UUID generated by the Pages Function. Validate before it ever
    reaches an S3 key or a filesystem path."""
    try:
        return str(uuid.UUID(value)) == value.lower()
    except (ValueError, AttributeError, TypeError):
        return False


def make_client():
    endpoint = require_env("R2_S3_ENDPOINT")
    access_key = require_env("R2_ACCESS_KEY_ID")
    secret_key = require_env("R2_SECRET_ACCESS_KEY")
    return boto3.client(
        "s3",
        endpoint_url=endpoint,
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        # R2 ignores region but boto3 requires one; "auto" matches the old workflow.
        region_name="auto",
        config=Config(signature_version="s3v4"),
    )


def list_upload_job_ids(client, bucket):
    """Yield valid jobIds for every object under uploads/. Paginated so a backlog
    larger than 1000 keys is handled."""
    paginator = client.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=bucket, Prefix=UPLOAD_PREFIX):
        for obj in page.get("Contents", []):
            key = obj["Key"]
            if not key.startswith(UPLOAD_PREFIX):
                continue
            job_id = key[len(UPLOAD_PREFIX):]
            if not job_id:
                continue
            if not is_uuid(job_id):
                log("skip non-uuid upload key %r" % key)
                continue
            yield job_id


def result_exists(client, bucket, job_id):
    try:
        client.head_object(Bucket=bucket, Key=result_key(job_id))
        return True
    except ClientError as err:
        code = err.response.get("Error", {}).get("Code")
        if code in ("404", "NoSuchKey", "NotFound"):
            return False
        raise


def upload_key(job_id):
    return UPLOAD_PREFIX + job_id


def result_key(job_id):
    return "results/" + job_id + RESULT_SUFFIX


def sniff_mime(input_path):
    """Return the libmagic mime-type string for the input, or "" on failure."""
    return subprocess.run(
        ["file", "--brief", "--mime-type", input_path],
        capture_output=True,
        text=True,
        check=False,
    ).stdout.strip()


def rasterize_if_pdf(input_path, workdir):
    """oemer needs a single raster image. Sniff the type and, for a PDF, render EVERY
    page to PNG with poppler's pdftoppm at PDF_RASTER_DPI, then stitch all pages
    vertically into one tall PNG so no music past page 1 is dropped (the old code
    rendered only the first page).

    Returns (image_path, is_pdf). is_pdf lets the caller disable oemer's deskew on the
    clean vector-PDF path (a vector raster is already orthogonal; deskew can warp it)."""
    kind = sniff_mime(input_path)
    log("detected mime %r" % kind)

    if kind == "application/pdf":
        out_prefix = os.path.join(workdir, "page")
        # No -f/-l: render ALL pages. -r sets the DPI (the only quality lever we own).
        subprocess.run(
            ["pdftoppm", "-png", "-r", str(PDF_RASTER_DPI), input_path, out_prefix],
            check=True,
        )
        # pdftoppm appends -1, -01, or -001 depending on page-count width; sorting the
        # zero-padded names keeps pages in document order (page-001 < page-002 < ...).
        pages = sorted(
            os.path.join(workdir, p)
            for p in os.listdir(workdir)
            if p.startswith("page-") and p.endswith(".png")
        )
        if not pages:
            raise RuntimeError("pdftoppm produced no page image")
        log("rasterized %d page(s) at %d DPI" % (len(pages), PDF_RASTER_DPI))
        stitched = os.path.join(workdir, "stitched.png")
        return stitch_pages_vertical(pages, stitched), True

    if kind == "image/png":
        return _rename_to(input_path, os.path.join(workdir, "page.png")), False

    if kind == "image/jpeg":
        return _rename_to(input_path, os.path.join(workdir, "page.jpg")), False

    # Best effort: hand the raw bytes to oemer as a PNG and let it try.
    log("unrecognized mime %r; treating as PNG" % kind)
    return _rename_to(input_path, os.path.join(workdir, "page.png")), False


def stitch_pages_vertical(page_paths, dest_path):
    """Stack page PNGs top-to-bottom into one tall PNG and write it to dest_path.

    oemer reads ONE image, so a multi-page PDF must collapse to a single raster.
    Vertical stitching (rather than picking one "best" page) preserves ALL music: a
    grand staff reads the same whether the systems sit on one page or several, and the
    engine processes staves top-to-bottom regardless. A single page short-circuits to a
    plain copy (no compositing cost). Canvas width is the widest page so nothing is
    cropped; narrower pages are left-aligned on a white background (matches sheet-music
    paper and the engine's binarization assumptions). Returns dest_path.

    Pillow is already an oemer runtime dependency (see requirements.txt), so this adds
    no new dependency. Imported lazily so the rest of the module (and its unit tests)
    stays importable on a host without Pillow installed.

    Resource-safety: a crafted many-page 10 MB vector PDF could otherwise stitch into a
    multi-GB bitmap and OOM-kill the worker, so reject more than MAX_STITCH_PAGES pages
    and any total area over MAX_STITCH_PIXELS before allocating the canvas. Pillow's
    decompression-bomb guard is also armed (MAX_IMAGE_PIXELS) so a single crafted page
    cannot bomb-decode on Image.open."""
    if not page_paths:
        raise RuntimeError("no pages to stitch")
    if len(page_paths) > MAX_STITCH_PAGES:
        raise RuntimeError(
            "too many pages to stitch: %d > %d" % (len(page_paths), MAX_STITCH_PAGES)
        )

    from PIL import Image

    # Arm Pillow's decompression-bomb guard so an Image.open of a crafted page raises
    # rather than silently decoding a giant bitmap. MAX_STITCH_PIXELS comfortably exceeds
    # one real 400 DPI A4 page (~15.5 MP), so legitimate pages are unaffected.
    Image.MAX_IMAGE_PIXELS = MAX_STITCH_PIXELS

    if len(page_paths) == 1:
        # Single page: just normalize to RGB at dest_path, no compositing.
        with Image.open(page_paths[0]) as only:
            only.convert("RGB").save(dest_path)
        return dest_path

    images = []
    try:
        for path in page_paths:
            images.append(Image.open(path).convert("RGB"))
        total_width = max(img.width for img in images)
        total_height = sum(img.height for img in images)
        # Reject before allocating: the canvas alone would be total_width*total_height*3
        # bytes of RAM, so cap the area to keep the worker inside the VM's budget.
        if total_width * total_height > MAX_STITCH_PIXELS:
            raise RuntimeError(
                "stitched image too large: %d px > %d"
                % (total_width * total_height, MAX_STITCH_PIXELS)
            )
        canvas = Image.new("RGB", (total_width, total_height), (255, 255, 255))
        y = 0
        for img in images:
            canvas.paste(img, (0, y))
            y += img.height
        canvas.save(dest_path)
    finally:
        for img in images:
            img.close()
    return dest_path


def _rename_to(src, dest):
    """Give the input a sensible extension so oemer reads it as the right format.
    Returns the path oemer should use."""
    if src == dest:
        return src
    os.replace(src, dest)
    return dest


def find_musicxml(*dirs):
    """Return the first .musicxml/.xml file found across the given dirs, or None.
    oemer and homr differ on output path/name across versions."""
    for d in dirs:
        if not d or not os.path.isdir(d):
            continue
        for name in sorted(os.listdir(d)):
            if name.endswith(".musicxml") or name.endswith(".xml"):
                return os.path.join(d, name)
    return None


def oemer_command(image_path, out_dir, without_deskew):
    """Build the oemer argv. Pure so the deskew gating is unit-testable without running
    the engine. --without-deskew is added ONLY when without_deskew is true (the clean
    vector-PDF path): a vector raster is already orthogonal, so oemer's deskew step can
    only warp it. A scanned/photo PNG/JPEG keeps deskew on (it may be skewed)."""
    cmd = ["oemer", image_path, "-o", out_dir]
    if without_deskew:
        cmd.append("--without-deskew")
    return cmd


def run_oemer(image_path, workdir, without_deskew=False):
    """Run the primary engine. Returns the MusicXML path or None on failure."""
    out_dir = os.path.join(workdir, "oemer-out")
    os.makedirs(out_dir, exist_ok=True)
    try:
        subprocess.run(
            oemer_command(image_path, out_dir, without_deskew),
            check=True,
            cwd=workdir,
        )
    except (subprocess.CalledProcessError, FileNotFoundError) as err:
        log("oemer failed: %s" % err)
        return None
    return find_musicxml(out_dir, workdir)


def run_homr(image_path, workdir):
    """Run the fallback engine. Returns the MusicXML path or None on failure."""
    try:
        subprocess.run(["homr", image_path], check=True, cwd=workdir)
    except (subprocess.CalledProcessError, FileNotFoundError) as err:
        log("homr failed: %s" % err)
        return None
    return find_musicxml(workdir)


# ---------------------------------------------------------------------------
# Left-hand chord completion post-pass (#113)
#
# oemer reliably reads the right hand but collapses many left-hand block chords
# to a single note (on the user's icarus.pdf only 12 of 27 LH measures kept a
# chord, 4 of them triads, where the source has a triad almost every bar). This
# pure, additive post-pass runs on the engine's MusicXML BEFORE it is written to
# R2: it learns the dominant LH chord SHAPE oemer DID detect elsewhere in the
# piece and completes lone LH notes (at a matching duration) to that shape, with
# the existing note kept as the LOWEST note. It never touches the right hand,
# never alters an existing pitch or duration, and never changes part/staff/
# measure structure. Any parse or shape failure returns the input bytes
# unchanged (no regression, never a sentinel).
# ---------------------------------------------------------------------------

LH_STAFF = "2"  # the bass staff of a grand staff carries <staff>2</staff>

# Canonical sharp spelling for each pitch class (0 = C). The pass spells added
# chord notes with sharps; the sounding pitch (MIDI) is what matters for playback
# and for the falling-notes/sheet sync, and OSMD renders these cleanly.
_PC_TO_STEP_ALTER = {
    0: ("C", 0),
    1: ("C", 1),
    2: ("D", 0),
    3: ("D", 1),
    4: ("E", 0),
    5: ("F", 0),
    6: ("F", 1),
    7: ("G", 0),
    8: ("G", 1),
    9: ("A", 0),
    10: ("A", 1),
    11: ("B", 0),
}
_STEP_TO_PC = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}


def pitch_to_semitone(step, alter, octave):
    """Convert a MusicXML pitch (step letter, alter in semitones, octave) to an
    absolute semitone where C4 (middle C) = 60, matching MIDI. Pure and the
    unit-testable core of the transposition."""
    return (octave + 1) * 12 + _STEP_TO_PC[step] + alter


def semitone_to_pitch(semitone):
    """Inverse of pitch_to_semitone, returning (step, alter, octave) in canonical
    sharp spelling. Octave comes from the absolute value so an added note always
    sounds in the right register."""
    octave = semitone // 12 - 1
    pc = semitone % 12
    step, alter = _PC_TO_STEP_ALTER[pc]
    return step, alter, octave


def _read_note_pitch(note):
    """Return the absolute semitone of a <note>'s <pitch>, or None if it has no
    pitch (a rest, or a malformed/unpitched note)."""
    pitch = note.find("pitch")
    if pitch is None:
        return None
    step_el = pitch.find("step")
    octave_el = pitch.find("octave")
    if step_el is None or octave_el is None:
        return None
    step = (step_el.text or "").strip()
    if step not in _STEP_TO_PC:
        return None
    alter_el = pitch.find("alter")
    try:
        alter = int((alter_el.text or "0").strip()) if alter_el is not None else 0
        octave = int((octave_el.text or "").strip())
    except (ValueError, TypeError):
        return None
    return pitch_to_semitone(step, alter, octave)


def _is_lh_note(note):
    """A pitched <note> on staff 2 (the left hand). Rests and staff-1 notes are
    excluded."""
    if note.tag != "note":
        return False
    if note.find("rest") is not None:
        return False
    staff_el = note.find("staff")
    staff = (staff_el.text or "").strip() if staff_el is not None else None
    return staff == LH_STAFF


def _chord_groups(measure):
    """Group a measure's child <note> elements into chord-groups in document order.

    A chord-group is a lead <note> followed by zero or more sibling <note>s that
    carry a <chord/> element. Returns a list of lists of (index_in_children, note).
    Non-note children (attributes, backup, forward, ...) break grouping naturally
    since we only collect <note>s but track their child index for insertion."""
    groups = []
    current = None
    for idx, child in enumerate(list(measure)):
        if child.tag != "note":
            current = None
            continue
        if child.find("chord") is not None and current is not None:
            current.append((idx, child))
        else:
            current = [(idx, child)]
            groups.append(current)
    return groups


def _interval_pattern(group):
    """Semitone offsets of a chord-group above its lowest note, sorted ascending
    and de-duplicated, e.g. a root-position major triad -> (0, 4, 7). Returns None
    if any note in the group is unpitched."""
    semis = []
    for _idx, note in group:
        s = _read_note_pitch(note)
        if s is None:
            return None
        semis.append(s)
    if not semis:
        return None
    low = min(semis)
    return tuple(sorted({s - low for s in semis}))


def _note_duration_text(note):
    d = note.find("duration")
    return (d.text or "").strip() if d is not None else None


def complete_lh_chords(xml_bytes):
    """Additive LH chord-completion post-pass over engine MusicXML.

    Returns possibly-modified bytes. ALWAYS returns the original bytes unchanged
    on any parse/shape failure (wrapped in try/except), so it can never regress a
    score or emit a sentinel. See the module-level comment for the contract."""
    try:
        return _complete_lh_chords(xml_bytes)
    except Exception as err:  # never raise into process_job
        log("LH chord-completion skipped (%r); passing engine output through" % err)
        return xml_bytes


def _complete_lh_chords(xml_bytes):
    root = ET.fromstring(xml_bytes)

    # Must be a single-part score (one <part>). A multi-part score is not the
    # grand-staff shape this pass reasons about, so leave it untouched.
    parts = root.findall("part")
    if len(parts) != 1:
        return xml_bytes
    part = parts[0]

    measures = part.findall("measure")
    # The score must actually use staff 2 (a grand staff). If no note carries
    # <staff>2</staff>, it is a single-staff part: do nothing.
    has_lh = any(_is_lh_note(n) for m in measures for n in m.findall("note"))
    if not has_lh:
        return xml_bytes

    # 1) Learn the dominant detected LH chord shape and the durations chords use.
    pattern_counts = Counter()
    chord_durations = set()
    for measure in measures:
        for group in _chord_groups(measure):
            if len(group) < 2:
                continue
            if not all(_is_lh_note(note) for _idx, note in group):
                continue
            pattern = _interval_pattern(group)
            if pattern is None or len(pattern) < 2:
                continue
            pattern_counts[pattern] += 1
            lead_note = group[0][1]
            lead_dur = _note_duration_text(lead_note)
            if lead_dur is not None:
                chord_durations.add(lead_dur)

    if not pattern_counts:
        return xml_bytes  # zero detected LH chords: nothing to learn from

    dominant = _dominant_pattern(pattern_counts)
    if dominant is None:
        return xml_bytes

    # The added notes are the offsets ABOVE the existing lowest note (offset 0 is
    # the existing note itself, so skip it).
    add_offsets = [off for off in dominant if off != 0]
    if not add_offsets:
        return xml_bytes

    changed = False

    # 2) Complete lone LH notes at a chord-matching duration to the dominant shape.
    for measure in measures:
        # Recompute groups per measure; insertions below shift indices, so collect
        # the lead notes first, then mutate.
        groups = _chord_groups(measure)
        lone_leads = []
        for group in groups:
            if len(group) != 1:
                continue
            _idx, lead = group[0]
            if not _is_lh_note(lead):
                continue
            if _read_note_pitch(lead) is None:
                continue
            if _note_duration_text(lead) not in chord_durations:
                continue
            lone_leads.append(lead)

        for lead in lone_leads:
            if _complete_one(measure, lead, add_offsets):
                changed = True

    if not changed:
        return xml_bytes

    return ET.tostring(root, encoding="utf-8", xml_declaration=True)


def _dominant_pattern(pattern_counts):
    """Pick the most common detected chord shape with size >= 3 (a triad). Fall
    back to the most common size-2 shape if no triad was seen. Ties broken by
    higher count then larger size then the pattern itself (deterministic)."""
    def key(item):
        pattern, count = item
        return (count, len(pattern), pattern)

    triads = [(p, c) for p, c in pattern_counts.items() if len(p) >= 3]
    if triads:
        return max(triads, key=key)[0]
    dyads = [(p, c) for p, c in pattern_counts.items() if len(p) == 2]
    if dyads:
        return max(dyads, key=key)[0]
    return None


def _complete_one(measure, lead, add_offsets):
    """Insert <chord/> sibling notes immediately after the lead note to realize the
    shape, with the lead as the lowest note. Returns True if it added notes.

    Hard guards: the lead must be a pitched LH note that exists in this measure;
    we only ADD siblings and copy duration/voice/type/staff from the lead. The
    lead's own pitch/duration are never touched."""
    base = _read_note_pitch(lead)
    if base is None:
        return False
    children = list(measure)
    try:
        lead_pos = children.index(lead)
    except ValueError:
        return False

    duration_el = lead.find("duration")
    voice_el = lead.find("voice")
    type_el = lead.find("type")
    staff_el = lead.find("staff")

    insert_at = lead_pos + 1
    added = False
    for offset in add_offsets:
        step, alter, octave = semitone_to_pitch(base + offset)
        note = ET.Element("note")
        ET.SubElement(note, "chord")
        pitch = ET.SubElement(note, "pitch")
        ET.SubElement(pitch, "step").text = step
        if alter:
            ET.SubElement(pitch, "alter").text = str(alter)
        ET.SubElement(pitch, "octave").text = str(octave)
        if duration_el is not None:
            ET.SubElement(note, "duration").text = duration_el.text
        if voice_el is not None:
            ET.SubElement(note, "voice").text = voice_el.text
        if type_el is not None:
            ET.SubElement(note, "type").text = type_el.text
        if staff_el is not None:
            ET.SubElement(note, "staff").text = staff_el.text
        measure.insert(insert_at, note)
        insert_at += 1
        added = True
    return added


def process_job(client, bucket, job_id):
    """Convert one upload. Always leaves exactly one object at the result key
    (real score or sentinel) and deletes the upload so it is not reprocessed."""
    if result_exists(client, bucket, job_id):
        log("result already present for %s; deleting stale upload" % job_id)
        client.delete_object(Bucket=bucket, Key=upload_key(job_id))
        return

    with tempfile.TemporaryDirectory(prefix="omr-") as workdir:
        input_path = os.path.join(workdir, "input.bin")
        client.download_file(bucket, upload_key(job_id), input_path)

        image_path, is_pdf = rasterize_if_pdf(input_path, workdir)
        # Disable deskew only on the vector-PDF raster (already orthogonal).
        result_path = run_oemer(image_path, workdir, without_deskew=is_pdf)
        if result_path is None:
            log("oemer produced nothing for %s; trying homr" % job_id)
            result_path = run_homr(image_path, workdir)

        if result_path is not None:
            with open(result_path, "rb") as fh:
                body = fh.read()
            log("%s recognized via engine output %s" % (job_id, result_path))
            # Additive LH chord-completion runs ONLY on a real engine result, never
            # on the failure-sentinel path. It self-guards and returns the input
            # bytes unchanged on any failure, so the R2 transport contract holds.
            body = complete_lh_chords(body)
        else:
            body = FAILURE_SENTINEL
            log("both engines failed for %s; writing failure sentinel" % job_id)

        client.put_object(
            Bucket=bucket,
            Key=result_key(job_id),
            Body=body,
            ContentType=RESULT_CONTENT_TYPE,
        )

    # Only delete the upload after the result is durably written.
    client.delete_object(Bucket=bucket, Key=upload_key(job_id))
    log("done %s; upload deleted" % job_id)


def poll_once(client, bucket):
    for job_id in list_upload_job_ids(client, bucket):
        try:
            process_job(client, bucket, job_id)
        except Exception as err:  # one bad upload must never kill the loop
            log("ERROR processing %s: %r" % (job_id, err))


def main():
    bucket = require_env("R2_BUCKET")
    try:
        interval = float(os.environ.get("OMR_POLL_SECONDS", DEFAULT_POLL_SECONDS))
    except ValueError:
        interval = DEFAULT_POLL_SECONDS
    if interval <= 0:
        interval = DEFAULT_POLL_SECONDS

    client = make_client()
    log("OMR worker started; bucket=%s interval=%ss" % (bucket, interval))

    while True:
        try:
            poll_once(client, bucket)
        except Exception as err:  # list/credentials hiccup: log and keep going
            log("ERROR poll cycle: %r" % err)
        time.sleep(interval)


if __name__ == "__main__":
    main()
