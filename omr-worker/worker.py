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

import concurrent.futures
import os
import subprocess
import sys
import tempfile
import time
import uuid
import xml.etree.ElementTree as ET

import boto3
from botocore.client import Config
from botocore.exceptions import ClientError

# reconcile.py is PURE stdlib (no boto3), so worker.py imports FROM it (never the reverse),
# keeping reconcile importable/testable without the S3 stack. _clef_sign is the shared
# treble/bass helper; reconcile() is the ensemble Slice-3 conflict resolver.
import reconcile
from reconcile import _clef_sign

UPLOAD_PREFIX = "uploads/"
RESULT_SUFFIX = ".musicxml"
RESULT_CONTENT_TYPE = "application/vnd.recordare.musicxml+xml"
DEFAULT_POLL_SECONDS = 5

# Rasterization DPI for the PDF path. oemer exposes no DPI/quality knob of its own
# (its CLI is just -o, --use-tf, --save-cache, -d/--without-deskew), so the raster we
# hand it is the ONLY preprocessing lever we own. The #112 DPI sweep on icarus.pdf
# (250/300/350/400/500, judged by recall AND fidelity against the source PDF, not raw
# note count) found 350 is the sweet spot: it recovers the most genuine left-hand chord
# tones (11 triads vs 4 at 400, ~3x the collapsed-LH-chord recovery #118 tracks) and the
# highest total recall (123 notes vs 400's 109), preserves all 27 measures, and crucially
# introduces ZERO accidentals on this accidental-free C-major score (DPI only changes
# raster density, it cannot invent pitches, so this lever is fabrication-safe by
# construction). 400 (the prior #109 value) turned out to be PAST oemer's sweet spot:
# over-upscaling the noteheads HURT chord-tone separation, collapsing real triads to lone
# bass notes. 500 starts dropping whole measures (25/27). Wall-clock is ~180s at every DPI
# in this range, so 350 costs nothing in speed. NOTE: right-hand arpeggio/dropped-note
# recall (#118 symptoms 1/2) is identical at every DPI (66 RH notes everywhere), so it is
# an engine limit this lever cannot move; that stays with #88 (stronger engine) / #6
# (human-in-the-loop correction UI).
PDF_RASTER_DPI = 350

# Resource guards for the stitched raster. The upload Function caps inputs at 10 MB
# (src/omr-server.ts MAX_UPLOAD_BYTES), but a sparse VECTOR PDF compresses so well that
# 10 MB can still hold hundreds of pages. At 350 DPI each A4 page is ~11.8 MP, so an
# unbounded vertical stitch of a crafted many-page PDF would allocate a multi-GB RGB
# bitmap on a box that also runs the oemer PyTorch/onnx stack: a real OOM that would
# kill the always-on poller (the OS OOM-killer is not catchable by poll_once). Bound BOTH
# the page count and the total stitched pixel area; exceeding either raises RuntimeError,
# which poll_once turns into a clean failure sentinel instead of crashing the worker.
# 60 pages * 11.8 MP ~= 708 MP is also the ceiling we hand oemer (well past any real score).
MAX_STITCH_PAGES = 60
MAX_STITCH_PIXELS = 1_000_000_000  # ~1 GP; RGB canvas ~3 GB worst case, then freed.

# Per-engine wall-clock cap. The ensemble (Slice 1) runs Clarity and oemer CONCURRENTLY,
# so a single wedged engine must not stall the always-on poller indefinitely. Each engine
# subprocess gets this timeout; exceeding it is treated as that engine FAILING (the runner
# returns None) so the flow degrades to the surviving engine exactly as if it had errored.
# Generous because oemer is ~180s on a full page at 350 DPI (#112) and a long multi-page
# score plus model load can run longer; the cap is a runaway guard, not a tuning knob.
# Overridable via OMR_ENGINE_TIMEOUT_SECONDS for hosts with different compute budgets.
DEFAULT_ENGINE_TIMEOUT_SECONDS = 1200


def engine_timeout_seconds():
    """Per-engine subprocess timeout in seconds, from OMR_ENGINE_TIMEOUT_SECONDS or the
    default. A non-positive or unparseable value falls back to the default."""
    raw = os.environ.get("OMR_ENGINE_TIMEOUT_SECONDS")
    if raw is None:
        return DEFAULT_ENGINE_TIMEOUT_SECONDS
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return DEFAULT_ENGINE_TIMEOUT_SECONDS
    return value if value > 0 else DEFAULT_ENGINE_TIMEOUT_SECONDS


# Master kill-switch for the ensemble work (Slice 1+). DEFAULT OFF so prod behavior is
# byte- AND latency-identical to today: the legacy Clarity-first SHORT-CIRCUIT runs (oemer
# only when Clarity fails, no upfront rasterization on the Clarity happy path, ~15s). When
# ON, process_job runs Clarity + oemer CONCURRENTLY via select_primary_result (~max of the
# two engines). The same flag will later gate reconciliation (Slice 3+), so QA can validate
# the parallel path on the live worker (OMR_ENSEMBLE=1) before it ever becomes the default.
OMR_ENSEMBLE_ENV = "OMR_ENSEMBLE"


def ensemble_enabled():
    """True when OMR_ENSEMBLE is a truthy string ("1"/"true", case-insensitive). Anything
    else (unset, "0", "false", garbage) is OFF. Shared by every ensemble slice so the flag
    is read in exactly one place."""
    raw = os.environ.get(OMR_ENSEMBLE_ENV)
    if raw is None:
        return False
    return raw.strip().lower() in ("1", "true")

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
    # one real 350 DPI A4 page (~11.8 MP), so legitimate pages are unaffected.
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


def run_oemer(image_path, workdir, without_deskew=False, timeout=None):
    """Run the primary raster engine. Returns the MusicXML path or None on failure.

    A timeout (seconds) caps the subprocess wall-clock; exceeding it is treated as a
    FAILURE (return None) so the ensemble degrades to the surviving engine."""
    out_dir = os.path.join(workdir, "oemer-out")
    os.makedirs(out_dir, exist_ok=True)
    try:
        subprocess.run(
            oemer_command(image_path, out_dir, without_deskew),
            check=True,
            cwd=workdir,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired as err:
        log("oemer timed out after %ss" % getattr(err, "timeout", timeout))
        return None
    except (subprocess.CalledProcessError, FileNotFoundError) as err:
        log("oemer failed: %s" % err)
        return None
    return find_musicxml(out_dir, workdir)


def run_homr(image_path, workdir, timeout=None):
    """Run the last-resort raster engine. Returns the MusicXML path or None on failure.
    A timeout (seconds) caps the subprocess; exceeding it counts as a failure (None)."""
    try:
        subprocess.run(["homr", image_path], check=True, cwd=workdir, timeout=timeout)
    except subprocess.TimeoutExpired as err:
        log("homr timed out after %ss" % getattr(err, "timeout", timeout))
        return None
    except (subprocess.CalledProcessError, FileNotFoundError) as err:
        log("homr failed: %s" % err)
        return None
    return find_musicxml(workdir)


# Clarity-OMR (github.com/clquwu/Clarity-OMR, GPL-3.0) is the only free engine that
# recovers TIES (held notes) on our own material (see the #135 / tie-spike entries in
# docs/context/tech-lead.md). Its torch / ultralytics-YOLO / transformers stack MUST NOT
# co-install with oemer's onnxruntime/opencv/numpy band, so it lives in its OWN venv and
# is invoked as a subprocess, exactly like oemer. Two env vars locate it; if either is
# unset or missing, run_clarity returns None and the flow falls back to oemer cleanly.
#   CLARITY_OMR_DIR   path to the cloned Clarity-OMR repo (must contain omr.py)
#   CLARITY_PYTHON    path to that repo's venv python interpreter
CLARITY_OMR_DIR_ENV = "CLARITY_OMR_DIR"
CLARITY_PYTHON_ENV = "CLARITY_PYTHON"
CLARITY_SCRIPT_NAME = "omr.py"


def clarity_command(python, omr_script, pdf_path, out_path, work_dir):
    """Build the Clarity-OMR argv. Pure so it is unit-testable without running the engine
    (mirrors oemer_command). --device cpu pins inference to the CPU-only VM and --fast uses
    beam-2 (the ~15s CPU mode); Clarity reads the PDF directly (pymupdf + YOLO auto-segment),
    so it takes the original uploaded PDF, NOT the stitched raster."""
    return [
        python,
        omr_script,
        pdf_path,
        "-o",
        out_path,
        "--device",
        "cpu",
        "--fast",
        "--work-dir",
        work_dir,
    ]


def run_clarity(pdf_path, workdir, timeout=None):
    """Run Clarity-OMR on the original PDF. Returns the output .musicxml path or None on
    ANY failure (env unset/missing, subprocess error, timeout, no output) so the caller
    falls back to oemer. Never raises into process_job. A timeout (seconds) caps the
    subprocess wall-clock; exceeding it counts as a failure (None)."""
    omr_dir = os.environ.get(CLARITY_OMR_DIR_ENV)
    python = os.environ.get(CLARITY_PYTHON_ENV)
    if not omr_dir or not python:
        return None
    omr_script = os.path.join(omr_dir, CLARITY_SCRIPT_NAME)
    if not os.path.isfile(omr_script) or not os.path.isfile(python):
        log("clarity env set but script/python missing (dir=%r python=%r)" % (omr_dir, python))
        return None

    out_path = os.path.join(workdir, "clarity.musicxml")
    clarity_work = os.path.join(workdir, "clarity-work")
    os.makedirs(clarity_work, exist_ok=True)
    try:
        subprocess.run(
            clarity_command(python, omr_script, pdf_path, out_path, clarity_work),
            check=True,
            cwd=workdir,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired as err:
        log("clarity timed out after %ss" % getattr(err, "timeout", timeout))
        return None
    except (subprocess.CalledProcessError, FileNotFoundError) as err:
        log("clarity failed: %s" % err)
        return None
    if os.path.isfile(out_path):
        return out_path
    # Clarity may have named it differently; fall back to a scan of the work dirs.
    return find_musicxml(workdir, clarity_work)


# --- Pure MusicXML post-transforms -------------------------------------------------------
# Both run on the engine output before put_object, UNCONDITIONALLY. Each is wrapped so ANY
# parse/transform failure returns the ORIGINAL bytes unchanged (the #113 robustness rule:
# never raise into process_job, never fabricate). They are safe no-ops on oemer output
# (already a single grand-staff part with zero ties).

_MUSICXML_NS = ""  # MusicXML partwise documents are not namespaced.


def _clef_sign_of_part(part):
    """First clef <sign> text in a <part>, or None. Decides treble (G) vs bass (F).
    Delegates to reconcile._clef_sign so the treble/bass logic lives in exactly one place
    (the DRY direction: reconcile is the stdlib-only owner, worker imports it)."""
    return _clef_sign(part)


def _measure_duration(measure):
    """Sum the <duration> of top-level notes in a measure that are NOT chord members
    (a <chord/> note sounds with the previous note, so it does not advance time). Used to
    size the <backup> that rewinds staff 2 to the measure start."""
    total = 0
    for note in measure.findall("note"):
        if note.find("chord") is not None:
            continue
        dur = note.find("duration")
        if dur is not None and dur.text:
            try:
                total += int(dur.text)
            except ValueError:
                pass
    return total


def _tag_notes_staff(measure, staff_number):
    """Append <staff>N</staff> to every <note> in the measure (oemer's grand-staff shape:
    staff 1 = treble/RH, staff 2 = bass/LH). score.ts reads this to split hands."""
    for note in measure.findall("note"):
        if note.find("staff") is None:
            staff = ET.SubElement(note, "staff")
            staff.text = str(staff_number)


def merge_to_grand_staff(xml_bytes):
    """If the score has exactly 2 <part>s, collapse them into ONE part with <staves>2</staves>:
    treble part -> staff 1, bass part -> staff 2, decided by each part's first clef sign
    (G=treble=1, F=bass=2; document order if ambiguous). Per measure: treble notes tagged
    staff 1, then a <backup> of the TREBLE advance (the distance the treble notes just
    moved the cursor), then the bass notes tagged staff 2.
    This matches oemer's grand-staff shape so score.ts hand detection and OSMD grand-staff
    rendering work. If parts != 2, return the input unchanged (no-op for oemer's 1 part)."""
    try:
        root = ET.fromstring(xml_bytes)
        parts = root.findall("part")
        if len(parts) != 2:
            return xml_bytes

        sign_a = _clef_sign_of_part(parts[0])
        sign_b = _clef_sign_of_part(parts[1])
        # Treble is the G-clef part, bass the F-clef part. If only one side is identified,
        # trust it and assign the other by elimination. If neither, keep document order.
        if sign_a == "G" or sign_b == "F":
            treble, bass = parts[0], parts[1]
        elif sign_a == "F" or sign_b == "G":
            treble, bass = parts[1], parts[0]
        else:
            treble, bass = parts[0], parts[1]

        treble_measures = treble.findall("measure")
        bass_measures = bass.findall("measure")

        # Build a merged part keyed by measure number, treble first then bass.
        merged = ET.Element("part", {"id": treble.get("id", "P1")})
        by_number = {}
        order = []
        for m in treble_measures:
            num = m.get("number")
            by_number[num] = {"treble": m, "bass": None}
            order.append(num)
        for m in bass_measures:
            num = m.get("number")
            if num in by_number:
                by_number[num]["bass"] = m
            else:
                by_number[num] = {"treble": None, "bass": m}
                order.append(num)

        for num in order:
            pair = by_number[num]
            tre = pair["treble"]
            bas = pair["bass"]

            out_measure = ET.Element("measure")
            if num is not None:
                out_measure.set("number", num)

            # Carry the treble measure's <attributes> first, and add <staves>2</staves> so
            # OSMD renders one grand-staff instrument. Then treble notes (staff 1).
            if tre is not None:
                for child in list(tre):
                    if child.tag == "attributes":
                        attrs = _copy_with_staves(child)
                        out_measure.append(attrs)
                    elif child.tag == "note":
                        note = _deepcopy(child)
                        if note.find("staff") is None:
                            ET.SubElement(note, "staff").text = "1"
                        out_measure.append(note)
                    else:
                        out_measure.append(_deepcopy(child))

            if bas is not None:
                # The <backup> must rewind the cursor by how far the TREBLE notes just
                # advanced (the sum of staff-1 non-chord durations), NOT the bass duration.
                # If OMR drops a treble note so the treble fill is shorter than the bass,
                # backing up by the bass duration over-rewinds past the measure start and
                # staff-2 notes sound at the wrong time (falling-bar + cursor timing skew).
                # A bass-only measure wrote nothing before it, so it needs no backup.
                treble_advance = _measure_duration(tre) if tre is not None else 0
                if tre is not None and treble_advance > 0:
                    backup = ET.SubElement(out_measure, "backup")
                    ET.SubElement(backup, "duration").text = str(treble_advance)
                for child in list(bas):
                    # The bass part's clef/key/time live in its own <attributes>; the merged
                    # measure already declared attributes from the treble side, so keep only
                    # the bass <clef> for staff 2 and drop the duplicate key/time.
                    if child.tag == "attributes":
                        clef = child.find("clef")
                        if clef is not None:
                            staff_attr = out_measure.find("attributes")
                            if staff_attr is not None:
                                clef_copy = _deepcopy(clef)
                                clef_copy.set("number", "2")
                                staff_attr.append(clef_copy)
                    elif child.tag == "note":
                        note = _deepcopy(child)
                        if note.find("staff") is None:
                            ET.SubElement(note, "staff").text = "2"
                        out_measure.append(note)
                    elif child.tag != "print":
                        out_measure.append(_deepcopy(child))

            merged.append(out_measure)

        # Rebuild <part-list> to a single grand-staff part, drop the second score-part.
        part_list = root.find("part-list")
        if part_list is not None:
            score_parts = part_list.findall("score-part")
            for sp in score_parts[1:]:
                part_list.remove(sp)
            if score_parts:
                score_parts[0].set("id", merged.get("id"))

        # Replace the two <part>s with the single merged part, in place.
        first_index = list(root).index(parts[0])
        root.remove(parts[0])
        root.remove(parts[1])
        root.insert(first_index, merged)

        return ET.tostring(root, encoding="utf-8", xml_declaration=True)
    except Exception as err:  # never raise into process_job
        log("merge_to_grand_staff skipped (%r)" % err)
        return xml_bytes


def _copy_with_staves(attributes_el):
    """Deep-copy an <attributes> element and ensure it declares <staves>2</staves> so OSMD
    renders one two-staff instrument. <staves> must follow <divisions>/<key>/<time> and
    precede <clef> per the MusicXML schema; we insert it before the first <clef>."""
    attrs = _deepcopy(attributes_el)
    if attrs.find("staves") is None:
        staves = ET.Element("staves")
        staves.text = "2"
        children = list(attrs)
        clef_index = next(
            (i for i, c in enumerate(children) if c.tag == "clef"), len(children)
        )
        attrs.insert(clef_index, staves)
    # The first clef is staff 1.
    first_clef = attrs.find("clef")
    if first_clef is not None and first_clef.get("number") is None:
        first_clef.set("number", "1")
    return attrs


def _deepcopy(el):
    """ElementTree has no public deepcopy; round-trip through copy.deepcopy."""
    import copy

    return copy.deepcopy(el)


def _pitch_key(note):
    """A (step, alter, octave) tuple identifying a note's pitch, or None for a rest."""
    pitch = note.find("pitch")
    if pitch is None:
        return None
    step = pitch.findtext("step")
    octave = pitch.findtext("octave")
    alter = pitch.findtext("alter") or "0"
    return (step, alter, octave)


def _note_staff(note):
    """The <staff> text of a note, or None (single-staff parts omit it)."""
    return note.findtext("staff")


def _remove_tie_markup(note, tie_type):
    """Remove <tie type=...> and the matching <notations>/<tied type=...> from a note."""
    for tie in note.findall("tie"):
        if tie.get("type") == tie_type:
            note.remove(tie)
    notations = note.find("notations")
    if notations is not None:
        for tied in notations.findall("tied"):
            if tied.get("type") == tie_type:
                notations.remove(tied)
        if len(list(notations)) == 0:
            note.remove(notations)


def _add_tie_stop(note):
    """Add <tie type="stop"/> and <notations><tied type="stop"/></notations> to a note,
    closing a dangling start. <tie> precedes <type> in note order; we append (OSMD and
    music21 read tie/tied regardless of sibling order, and score.ts reads OSMD's parse)."""
    if not any(t.get("type") == "stop" for t in note.findall("tie")):
        ET.SubElement(note, "tie", {"type": "stop"})
    notations = note.find("notations")
    if notations is None:
        notations = ET.SubElement(note, "notations")
    if not any(t.get("type") == "stop" for t in notations.findall("tied")):
        ET.SubElement(notations, "tied", {"type": "stop"})


def normalize_ties(xml_bytes):
    """Fix the model's tie output so OSMD/mergeTiedNotes can fold held notes (#135).

    MusicXML ties pair by PITCH, not document adjacency: a <tie type="start"> means this
    note is tied to the NEXT note of the SAME pitch in the same staff; a <tie type="stop">
    means this note ends a tie from the PREVIOUS same-pitch note. There is no explicit
    start->stop id link, so pairing is purely "same pitch, same staff, nearest follower."

    Two pitch-matched passes:
      (i)  Starts pass: for each note carrying <tie type="start"> with a real pitch (rests
           cannot tie, so strip their bogus marker), find the NEXT SAME-pitch note in the
           SAME staff. If that follower already carries a stop, leave it (validly paired).
           If it has no stop, ADD one (close the model's dangling start across the barline).
           If there is NO following same-pitch note, DROP the start (do not fabricate).
      (ii) Stops pass: for each note carrying <tie type="stop">, if there is no EARLIER
           same-staff same-pitch note carrying a start that pairs to it, DROP the stop.

    Pitch-matched pairing is what makes interleaved/chordal ties survive: a held LH chord
    (e.g. C4 and E4 both tied across a barline in staff 2) has interleaved start/stop
    markers, so the old "first different-pitch stop -> drop both ends" logic wrongly nuked
    a sibling's legitimate tie. Pairing by pitch processes each pitch independently, so both
    ties survive. The stops pass is what kills the model's cross-pitch false positives
    (Clarity's _insert_ties "A4 start ... C4 stop"): the A4 start has no A4 follower so it
    is dropped in pass (i), and the C4 stop has no preceding C4 start so it is dropped in
    pass (ii). Net: invalid cross-pitch ties vanish without the sibling-destroying bug.

    Trusting the model's raster-detected tie START is NOT fabrication; inventing a tie from
    "same pitch twice" (the #121 reject) would be. We only pair/drop what the model emitted.
    Returns the original bytes unchanged on ANY failure (oemer output has zero ties: no-op)."""
    try:
        root = ET.fromstring(xml_bytes)
        # Flatten every note across all parts/measures into one ordered stream so pitch
        # pairing can scan forward (for starts) and backward (for stops) in document order.
        stream = []  # list of note elements in document order
        for part in root.findall("part"):
            for measure in part.findall("measure"):
                for note in measure.findall("note"):
                    stream.append(note)

        # Pass (i): resolve every tie START by pitch-matched forward search.
        for idx, note in enumerate(stream):
            if "start" not in [t.get("type") for t in note.findall("tie")]:
                continue
            start_pitch = _pitch_key(note)
            start_staff = _note_staff(note)
            if start_pitch is None:
                # A rest cannot carry a tie; strip the bogus marker.
                _remove_tie_markup(note, "start")
                continue

            # Find the NEXT same-pitch note in the same staff. That is the tie's far end.
            target = None
            for later in stream[idx + 1:]:
                if _note_staff(later) != start_staff:
                    continue
                if _pitch_key(later) == start_pitch:
                    target = later
                    break
            if target is None:
                # No following same-pitch note: drop the dangling start (do not fabricate).
                _remove_tie_markup(note, "start")
            elif "stop" not in [t.get("type") for t in target.findall("tie")]:
                # Follower exists but is not yet a stop: close the model's dangling start.
                _add_tie_stop(target)
            # else: follower already carries a stop, leave the pair intact.

        # Pass (ii): drop any STOP that has no earlier same-pitch same-staff start to pair
        # with (kills the model's cross-pitch false positives the starts pass left behind).
        for idx, note in enumerate(stream):
            if "stop" not in [t.get("type") for t in note.findall("tie")]:
                continue
            stop_pitch = _pitch_key(note)
            stop_staff = _note_staff(note)
            if stop_pitch is None:
                _remove_tie_markup(note, "stop")
                continue
            has_start = False
            for earlier in reversed(stream[:idx]):
                if _note_staff(earlier) != stop_staff:
                    continue
                if _pitch_key(earlier) != stop_pitch:
                    continue
                if "start" in [t.get("type") for t in earlier.findall("tie")]:
                    has_start = True
                break  # nearest same-pitch same-staff predecessor decides the pairing
            if not has_start:
                _remove_tie_markup(note, "stop")

        return ET.tostring(root, encoding="utf-8", xml_declaration=True)
    except Exception as err:  # never raise into process_job
        log("normalize_ties skipped (%r)" % err)
        return xml_bytes


def select_primary_result(run_clarity_fn, run_oemer_fn, is_pdf_input, timeout=None):
    """Slice 1 of the ensemble (docs/context/tech-lead.md, 2026-06-02): run the two PRIMARY
    engines CONCURRENTLY and apply the EXISTING fallback selection unchanged.

    Behavior is byte-identical to the old sequential flow for every input; only the
    SCHEDULING changed (parallel instead of Clarity-then-oemer). The selection precedence
    is preserved exactly: Clarity wins if it produced output, else oemer, else None (the
    caller then tries homr, then the failure sentinel). homr stays the last-resort engine
    OUTSIDE this concurrent stage; it runs only when both primaries fail (unchanged).

    Concurrency model: each engine is a subprocess, so running them on a ThreadPoolExecutor
    gives true wall-clock overlap (the GIL is released during the subprocess wait and each
    engine child uses its own cores). Wall-clock is ~max(clarity, oemer), not the sum.

    Clarity is PDF-only (it reads the PDF directly), so for PNG/JPEG uploads it is NOT
    launched and the "ensemble" is just oemer, exactly as before. A None from either runner
    (engine error, missing env, or the per-engine timeout) counts as that engine failing, so
    we degrade to the survivor without changing which output is chosen.

    run_clarity_fn() and run_oemer_fn() are zero-arg callables (the caller binds paths) so
    this selector is pure scheduling logic and unit-testable with fast/slow/failing mocks.
    Returns (result_path_or_None, source_label)."""
    futures = {}
    # ThreadPoolExecutor over subprocess calls: threads block on the OS, the GIL is freed,
    # so the two engines truly overlap. max_workers=2 caps it at the two primaries.
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        if is_pdf_input:
            futures["clarity"] = pool.submit(run_clarity_fn)
        futures["oemer"] = pool.submit(run_oemer_fn)
        # Block until BOTH engines finish so the selection sees every result. A per-engine
        # subprocess timeout (inside the runners) bounds how long either can take, so this
        # join cannot hang longer than that cap; we do not need an executor-level timeout.
        results = {name: fut.result() for name, fut in futures.items()}

    # Selection precedence UNCHANGED: Clarity first, then oemer. homr is handled by the
    # caller as the last resort (it is not part of the concurrent primary stage).
    clarity_result = results.get("clarity")
    if clarity_result is not None:
        return clarity_result, "clarity"
    oemer_result = results.get("oemer")
    if oemer_result is not None:
        return oemer_result, "oemer"
    return None, None


def _select_legacy(job_id, input_path, workdir, is_pdf_input):
    """LEGACY engine selection (OMR_ENSEMBLE OFF = prod default). Byte- and latency-identical
    to the pre-ensemble flow: Clarity is PRIMARY and SHORT-CIRCUITS for a PDF (oemer is NOT
    run when Clarity succeeds, and NO rasterization happens on the Clarity happy path, so the
    ~15s Clarity inference is the whole cost). Only if Clarity fails (or for a PNG/JPEG, where
    Clarity is skipped) do we rasterize and fall back to oemer, then homr.
    Returns (result_path_or_None, source_label_or_None)."""
    result_path = None
    source = None
    # Clarity is PRIMARY but PDF-only: it expects a PDF (pymupdf + YOLO auto-segment),
    # so it is skipped for PNG/JPEG uploads. On any failure run_clarity returns None
    # and we fall back to the existing rasterize -> oemer -> homr path.
    if is_pdf_input:
        result_path = run_clarity(input_path, workdir)
        if result_path is not None:
            source = "clarity"
        else:
            log("clarity produced nothing for %s; falling back to oemer" % job_id)

    if result_path is None:
        image_path, is_pdf = rasterize_if_pdf(input_path, workdir)
        # Disable deskew only on the vector-PDF raster (already orthogonal).
        result_path = run_oemer(image_path, workdir, without_deskew=is_pdf)
        if result_path is not None:
            source = "oemer"
        else:
            log("oemer produced nothing for %s; trying homr" % job_id)
            result_path = run_homr(image_path, workdir)
            if result_path is not None:
                source = "homr"

    return result_path, source


def _select_ensemble(job_id, input_path, workdir, is_pdf_input):
    """ENSEMBLE engine selection (OMR_ENSEMBLE ON). Runs the two PRIMARY engines (Clarity +
    oemer) CONCURRENTLY via select_primary_result with a per-engine timeout. Selection
    precedence is UNCHANGED (Clarity > oemer > homr > sentinel); only the scheduling is
    parallel, so wall-clock is ~max(clarity, oemer) instead of the legacy ~15s short-circuit.
    This is the path QA validates with OMR_ENSEMBLE=1 before it ever becomes the default, and
    the slot where reconciliation (Slice 3+) will later hook in.
    Returns (result_path_or_None, source_label_or_None)."""
    timeout = engine_timeout_seconds()

    # Rasterize up front so oemer's image is ready to run CONCURRENTLY with Clarity.
    # Clarity is PDF-only and reads the original PDF directly, so it is NOT given the
    # raster; oemer gets the stitched image. is_pdf disables oemer deskew on the clean
    # vector-PDF raster (already orthogonal). If rasterization fails on a PDF (e.g.
    # pdftoppm error or a stitch-cap RuntimeError), do NOT crash the whole job: Clarity
    # reads the PDF directly and may still succeed, so disable only the raster engines
    # (oemer/homr) and let Clarity run. For a non-PDF input there is no Clarity path, so
    # a rasterization failure stays fatal (re-raised, caught by poll_once) as before.
    image_path = None
    is_pdf = False
    try:
        image_path, is_pdf = rasterize_if_pdf(input_path, workdir)
    except Exception as err:
        if not is_pdf_input:
            raise
        log("rasterization failed for %s (%r); raster engines disabled, trying Clarity"
            % (job_id, err))

    # Run the two PRIMARY engines concurrently, capturing BOTH results so reconciliation
    # (Slice 3) can vote on conflicts when both succeed. Clarity (PDF-only) wins the SELECTION
    # if present, else oemer; homr stays the last resort below. run_oemer is only launched when
    # a raster image exists (it always does unless a PDF raster failed above), so a missing
    # image degrades cleanly to Clarity-only.
    oemer_fn = (
        (lambda: run_oemer(image_path, workdir, without_deskew=is_pdf, timeout=timeout))
        if image_path is not None
        else (lambda: None)
    )
    clarity_path, oemer_path = run_primary_engines(
        lambda: run_clarity(input_path, workdir, timeout=timeout),
        oemer_fn,
        is_pdf_input,
    )
    # Selection precedence UNCHANGED: Clarity, else oemer.
    if clarity_path is not None:
        result_path, source = clarity_path, "clarity"
    elif oemer_path is not None:
        result_path, source = oemer_path, "oemer"
    else:
        result_path, source = None, None

    if result_path is None and image_path is not None:
        log("clarity+oemer produced nothing for %s; trying homr" % job_id)
        result_path = run_homr(image_path, workdir, timeout=timeout)
        if result_path is not None:
            source = "homr"

    # RECONCILE (Slice 3): when BOTH primary engines produced output, vote on the safe
    # conflict classes (pitch/duration) using Clarity as the skeleton, BEFORE the shared
    # merge_to_grand_staff -> normalize_ties post-transforms in process_job. Only the ENSEMBLE
    # path reaches here (process_job branches on the flag). When only one engine succeeded,
    # reconcile is a pass-through, so this is byte-identical to single-engine (no regression).
    if result_path is not None and clarity_path is not None and oemer_path is not None:
        # Pass the rasterized original (the stitched PNG oemer consumed) so the Slice-6b
        # visual-diff referee can be consulted on residual class-B disputes. reconcile uses it
        # ONLY when OMR_ENSEMBLE_REFEREE is on; with the sub-gate off (or image_path None) it is
        # ignored and reconcile behaves exactly as in Slice 4. image_path may be None on a PDF
        # whose rasterization failed (Clarity still ran); the referee then simply has no original.
        reconciled = _reconcile_paths(clarity_path, oemer_path, workdir, image_path)
        if reconciled is not None:
            result_path = reconciled
            source = "ensemble"

    return result_path, source


def _reconcile_paths(primary_path, secondary_path, workdir, raster_path=None):
    """Read both engines' MusicXML and reconcile them, writing the result to a new file in
    workdir and returning its path. reconcile() never raises (returns primary bytes on any
    failure), so the worst case is the Clarity bytes written back out, never worse than
    Clarity-alone. Returns None only if reading the primary fails, in which case the caller
    keeps the original result_path.

    raster_path (Slice 6b, OPTIONAL) is the rasterized original handed to reconcile as the
    referee's input. It is loaded into a grayscale array ONLY when the referee sub-gate is on
    (avoid a needless image decode on every job); with the gate off it stays None and reconcile
    never touches it (byte-identical to Slice 4)."""
    try:
        with open(primary_path, "rb") as fh:
            primary_bytes = fh.read()
    except OSError as err:
        log("reconcile skipped: cannot read primary %r (%r)" % (primary_path, err))
        return None
    try:
        with open(secondary_path, "rb") as fh:
            secondary_bytes = fh.read()
    except OSError:
        secondary_bytes = None  # secondary unreadable -> reconcile is a pass-through.

    input_pdf = _load_referee_raster(raster_path)
    reconciled_bytes = reconcile.reconcile(primary_bytes, secondary_bytes, input_pdf=input_pdf)
    out_path = os.path.join(workdir, "reconciled.musicxml")
    with open(out_path, "wb") as fh:
        fh.write(reconciled_bytes)
    return out_path


def _load_referee_raster(raster_path):
    """Load the rasterized original into a float32 grayscale ndarray ([0,1], 0=ink) for the
    visual-diff referee, ONLY when OMR_ENSEMBLE_REFEREE is on (else return None so reconcile's
    referee path stays a no-op and no image is decoded). Never raises: any failure (no path,
    Pillow/numpy missing, decode error) -> None, and reconcile simply has no referee input."""
    if raster_path is None or not reconcile.referee_enabled():
        return None
    try:
        import numpy as np
        from PIL import Image

        with Image.open(raster_path) as im:
            return np.asarray(im.convert("L"), dtype=np.float32) / 255.0
    except Exception as err:  # never raise into process_job
        log("referee raster load skipped (%r)" % err)
        return None


def run_primary_engines(run_clarity_fn, run_oemer_fn, is_pdf_input):
    """Run the two PRIMARY engines CONCURRENTLY and return (clarity_path, oemer_path), each
    None on that engine's failure. This is the Slice-1 concurrency of select_primary_result
    but it exposes BOTH results (not just the winner) so Slice 3 can reconcile them. Selection
    precedence is applied by the caller. Clarity is PDF-only: not launched for PNG/JPEG.

    Concurrency model is unchanged: each engine is a subprocess, so a ThreadPoolExecutor gives
    true wall-clock overlap (GIL released during the OS wait). max_workers=2 caps it."""
    futures = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        if is_pdf_input:
            futures["clarity"] = pool.submit(run_clarity_fn)
        futures["oemer"] = pool.submit(run_oemer_fn)
        results = {name: fut.result() for name, fut in futures.items()}
    return results.get("clarity"), results.get("oemer")


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

        # Sniff the type BEFORE rasterizing (rasterize_if_pdf renames the input), so the
        # original PDF path stays available for Clarity, which reads the PDF directly.
        is_pdf_input = sniff_mime(input_path) == "application/pdf"

        if ensemble_enabled():
            result_path, source = _select_ensemble(job_id, input_path, workdir, is_pdf_input)
        else:
            result_path, source = _select_legacy(job_id, input_path, workdir, is_pdf_input)

        if result_path is not None:
            with open(result_path, "rb") as fh:
                body = fh.read()
            log("%s recognized via %s output %s" % (job_id, source, result_path))
            # Post-transforms run UNCONDITIONALLY on every engine's output. Each returns
            # the input unchanged on failure or when it does not apply (oemer is already a
            # 1-part grand staff with zero ties, so both are safe no-ops there). Order:
            # collapse 2 parts to a grand staff first, then pair/drop ties.
            body = merge_to_grand_staff(body)
            body = normalize_ties(body)
        else:
            body = FAILURE_SENTINEL
            log("all engines failed for %s; writing failure sentinel" % job_id)

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
