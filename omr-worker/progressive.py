#!/usr/bin/env python3
"""Pure helpers for PROGRESSIVE OMR: publish a score in pieces so the browser renders the first
notes while the rest is still being recognized.

WHY. End-to-end OMR is slow (~100s, dominated by Clarity's rhythm), and today the browser waits for
the WHOLE file before anything shows. Progressive publishing writes the result key MULTIPLE times in
one process_job: in-progress writes are marked omr-status="partial" (+ an omr-version so the client
re-renders only on change), and the final write is left unmarked (= complete). The client renders
each partial and keeps polling, stopping only on the complete write or the failure sentinel. This
mirrors the existing failure-sentinel pattern (worker.FAILURE_SENTINEL / src/omr.ts) exactly: the
status rides INSIDE the MusicXML as a <miscellaneous-field>, so the result endpoint is unchanged
(200 for partial and complete alike, 404 while absent).

Two shapes of progressive output, both built from these pure pieces:
  - FAST-THEN-REFINE (worker OMR_PROGRESSIVE): publish geom's pitch-only result (~5s, placeholder
    rhythm) as a partial, then the fused geom+Clarity result (~100s) as the complete. Same measures,
    rhythm refines in place.
  - PER-PAGE (worker OMR_PROGRESSIVE_PAGES): transcribe each PDF page independently and APPEND its
    measures (append_measures) in document order, publishing after each page. The score GROWS page
    by page, so measure 1 shows while measure 20 is still being recognized.

PURE stdlib (xml.etree). NEVER raises: stamp_partial returns the input unchanged on any failure (so a
mis-stamp can never corrupt a real result), and append_measures returns the data it already has (the
accumulated doc, or the new page) so a concat failure never loses a page.
"""
from __future__ import annotations

import re
import xml.etree.ElementTree as ET
from typing import Optional

# The omr-status values the client (src/omr.ts) matches. "partial" tells it to render AND keep
# polling; the complete write carries no status (an unmarked real score == complete), exactly like
# a successful non-progressive job today. "failed" is the separate failure sentinel in worker.py.
STATUS_PARTIAL = "partial"

# Field names carried in <identification><miscellaneous>. omr-status gates render-and-keep-polling;
# omr-version is a monotonic publish counter so the client re-renders only when it changes (a repeat
# poll of the same partial is a no-op). Kept byte-compatible with the regexes in src/omr.ts.
_STATUS_FIELD = "omr-status"
_VERSION_FIELD = "omr-version"

# Byte-pattern the client (src/omr.ts PARTIAL_SENTINEL_RE) uses to detect a partial IN THE BODY.
# is_partial_marked confirms a body actually carries it before that body is written to the result key.
_PARTIAL_MARKER_RE = re.compile(rb'name="omr-status"\s*>\s*partial')


def is_partial_marked(xml_bytes) -> bool:
    """True when xml_bytes carries the omr-status=partial marker the browser reads (src/omr.ts). The
    worker uses this to REFUSE writing an unmarked body to the result key mid-job: the result endpoint
    drops object metadata, so an unmarked body would be read as a COMPLETE result and stop the client
    polling early on a half-finished score. NEVER raises."""
    try:
        return bool(_PARTIAL_MARKER_RE.search(xml_bytes))
    except Exception:
        return False


def stamp_partial(xml_bytes, version: int) -> bytes:
    """Mark a MusicXML document as an in-progress PARTIAL result by injecting
    <identification><miscellaneous> fields omr-status="partial" and omr-version=<version>.

    The fusion/geom builders emit no <identification>, so we create one in schema order (it must
    precede <part-list>). If one already exists we update its fields in place. NEVER raises: returns
    the input bytes unchanged on any parse/serialize failure, so a stamp error degrades to an
    unmarked (== complete) result rather than corrupting the score."""
    try:
        root = ET.fromstring(xml_bytes)
        ident = root.find("identification")
        if ident is None:
            ident = ET.Element("identification")
            # <identification> precedes <part-list> in the score-partwise schema; insert it there.
            part_list = root.find("part-list")
            insert_at = list(root).index(part_list) if part_list is not None else 0
            root.insert(insert_at, ident)
        misc = ident.find("miscellaneous")
        if misc is None:
            misc = ET.SubElement(ident, "miscellaneous")
        _set_misc_field(misc, _STATUS_FIELD, STATUS_PARTIAL)
        _set_misc_field(misc, _VERSION_FIELD, str(int(version)))
        return ET.tostring(root, encoding="utf-8", xml_declaration=True)
    except Exception:
        return xml_bytes


def _set_misc_field(misc, name: str, value: str) -> None:
    """Set <miscellaneous-field name=NAME>VALUE</...> under a <miscellaneous>, replacing any
    existing field of that name so re-stamping is idempotent."""
    for field in misc.findall("miscellaneous-field"):
        if field.get("name") == name:
            field.text = value
            return
    field = ET.SubElement(misc, "miscellaneous-field", {"name": name})
    field.text = value


def append_measures(accumulated: Optional[bytes], page: bytes) -> bytes:
    """Append a page's measures to the accumulated score in document order, renumbering them to
    continue the sequence, and return the merged MusicXML. The growing document is always a single
    <part> so OSMD renders one continuous grand staff; each page's measures re-declare their own
    <attributes> (valid mid-part) so a page is self-contained.

    The first call passes accumulated=None and just returns the page unchanged (it is already the
    whole score so far). PURE. NEVER raises: on any failure returns the accumulated bytes if present
    (never drop already-published measures), else the page bytes, so a concat error degrades to
    "this page did not get appended" rather than losing the run."""
    if not accumulated:
        return page
    if not page:
        return accumulated
    try:
        acc_root = ET.fromstring(accumulated)
        page_root = ET.fromstring(page)
        acc_part = acc_root.find("part")
        page_part = page_root.find("part")
        if acc_part is None:
            return page
        if page_part is None:
            return accumulated
        next_number = len(acc_part.findall("measure"))
        import copy

        for measure in page_part.findall("measure"):
            next_number += 1
            clone = copy.deepcopy(measure)
            clone.set("number", str(next_number))
            acc_part.append(clone)
        return ET.tostring(acc_root, encoding="utf-8", xml_declaration=True)
    except Exception:
        return accumulated
