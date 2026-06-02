#!/usr/bin/env python3
"""Capture oemer's per-notehead pixel geometry for the visual-diff referee (Slice 6c).

oemer internally detects each notehead's bounding box and the staff-line geometry, but its
CLI throws all of that away and emits only logical MusicXML. This module runs oemer's
pipeline AS A LIBRARY (a faithful in-process replay of `oemer.ete.extract`) so it can, in the
SAME pass that produces the MusicXML, also dump a per-note BBOX INDEX: for each pitched
`<note>` (in document order, parallel to `reconcile.to_events`), the notehead bbox + the 5
staff-line y-positions at that note's x, in oemer's WORKING-IMAGE pixel space.

WHY this is reliable (validated empirically on icarus.pdf, see the tech-lead.md Slice 6c
entry): the in-process run produces a pitch sequence BYTE-IDENTICAL to the CLI, the AddNote
action list is 1:1 and in-order with the pitched <note> elements, and each NoteHead.bbox
overlays exactly on its glyph (confirmed by a raster overlay). So the index can be zipped
positionally with to_events("oemer") and keyed by (measure, staff, onset).

COORDINATE SPACE: oemer resizes the input to ~3-4MP for its models and registers the
ORIGINAL image at that resized resolution (`ete`'s `cv2.resize(image, staff.shape)`). ALL
bboxes + staff lines are in THAT working space. We therefore ALSO return the working-image
grayscale so the referee crops from the exact same space the bboxes live in (no DPI/scale
reconciliation, which would be an error source). The full-res 350 DPI stitched raster the
worker passes for the OFF path is NOT used when a bbox artifact is present.

GUARDED IMPORT: oemer is heavy (torch-adjacent onnxruntime/opencv) and only the prod worker
venv has it. We import it lazily INSIDE the capture function (not at module load), so this
module imports fine anywhere and the pure reconcile/test path never pulls oemer in.

NEVER-RAISE: capture returns (musicxml_path, None) on ANY failure so the caller degrades to
the plain CLI result. A None artifact makes the referee a no-op (decline). The artifact is a
plain dict of Python primitives + one numpy array, so it crosses module boundaries cleanly.
"""

from __future__ import annotations

import os
from typing import List, Optional, Tuple


def capture_available() -> bool:
    """True if oemer can be imported in this venv (the prod worker). Cheap probe used by the
    worker to decide whether to take the library capture path. Never raises."""
    try:
        import oemer  # noqa: F401

        return True
    except Exception:
        return False


def run_oemer_capture(
    image_path: str,
    out_dir: str,
    without_deskew: bool,
) -> Tuple[Optional[str], Optional[dict]]:
    """Run oemer in-process and return (musicxml_path, bbox_artifact).

    bbox_artifact is a dict:
        {
          "working_gray": float32 HxW ndarray in [0,1], 0=ink (oemer's working image),
          "notes": [  # one row per PITCHED <note>, in document order
             {"measure": int, "staff": 1|2, "step": str, "octave": int, "alter": int,
              "is_chord": bool, "bbox": [x1,y1,x2,y2], "lines": [y0..y4], "x_center": float},
             ...
          ],
        }
    Returns (path, None) on ANY failure (the caller then uses the path alone, referee no-op).
    NEVER raises.
    """
    try:
        return _capture_impl(image_path, out_dir, without_deskew)
    except Exception:
        # Best effort: if the XML at least got written, hand the path back so the engine
        # result is not lost; otherwise (None, None) and the caller falls back to the CLI.
        try:
            from worker import find_musicxml  # local import; worker is the only caller

            return find_musicxml(out_dir), None
        except Exception:
            return None, None


def _capture_impl(image_path, out_dir, without_deskew):
    # All oemer + heavy deps are imported HERE so the module stays importable without oemer.
    os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "3")
    import numpy as np
    import cv2
    from PIL import Image

    from oemer import MODULE_PATH, layers
    from oemer.inference import inference
    from oemer.dewarp import estimate_coords, dewarp
    from oemer.staffline_extraction import extract as staff_extract
    from oemer.notehead_extraction import extract as note_extract
    from oemer.note_group_extraction import extract as group_extract
    from oemer.symbol_extraction import extract as symbol_extract
    from oemer.rhythm_extraction import extract as rhythm_extract
    from oemer.build_system import MusicXMLBuilder, AddNote, AddMeasure, AddInit

    import xml.etree.ElementTree as ET
    import reconcile

    # Fresh layer state (oemer keeps layers in a module-global registry).
    for name in layers.list_layers():
        layers.delete_layer(name)

    # ---- Predict (faithful to oemer.ete.generate_pred) ----
    staff_symbols_map, _ = inference(
        os.path.join(MODULE_PATH, "checkpoints/unet_big"), image_path, use_tf=False
    )
    staff = np.where(staff_symbols_map == 1, 1, 0)
    symbols = np.where(staff_symbols_map == 2, 1, 0)
    sep, _ = inference(
        os.path.join(MODULE_PATH, "checkpoints/seg_net"),
        image_path,
        manual_th=None,
        use_tf=False,
    )
    stems_rests = np.where(sep == 1, 1, 0)
    notehead = np.where(sep == 2, 1, 0)
    clefs_keys = np.where(sep == 3, 1, 0)

    image = cv2.imread(image_path)
    image = cv2.resize(image, (staff.shape[1], staff.shape[0]))

    if not without_deskew:
        coords_x, coords_y = estimate_coords(staff)
        staff = dewarp(staff, coords_x, coords_y)
        symbols = dewarp(symbols, coords_x, coords_y)
        stems_rests = dewarp(stems_rests, coords_x, coords_y)
        clefs_keys = dewarp(clefs_keys, coords_x, coords_y)
        notehead = dewarp(notehead, coords_x, coords_y)
        for i in range(image.shape[2]):
            image[..., i] = dewarp(image[..., i], coords_x, coords_y)

    symbols = symbols + clefs_keys + stems_rests
    symbols[symbols > 1] = 1
    layers.register_layer("stems_rests_pred", stems_rests)
    layers.register_layer("clefs_keys_pred", clefs_keys)
    layers.register_layer("notehead_pred", notehead)
    layers.register_layer("symbols_pred", symbols)
    layers.register_layer("staff_pred", staff)
    layers.register_layer("original_image", image)

    staffs, zones = staff_extract()
    layers.register_layer("staffs", staffs)
    layers.register_layer("zones", zones)

    notes = note_extract()
    layers.register_layer("notes", np.array(notes))
    layers.register_layer("note_id", np.zeros(symbols.shape, dtype=np.int64) - 1)
    _register_note_id(layers, notes)

    groups, group_map = group_extract()
    layers.register_layer("note_groups", np.array(groups))
    layers.register_layer("group_map", group_map)

    barlines, clefs, sfns, rests = symbol_extract()
    layers.register_layer("barlines", np.array(barlines))
    layers.register_layer("clefs", np.array(clefs))
    layers.register_layer("sfns", np.array(sfns))
    layers.register_layer("rests", np.array(rests))

    rhythm_extract()

    basename = os.path.basename(image_path)
    for ext in (".jpg", ".jpeg", ".png"):
        basename = basename.replace(ext, "")
    builder = MusicXMLBuilder(title=basename.capitalize())
    builder.build()

    # Capture the NoteHead behind each AddNote, in action (= document) order.
    add_note_heads: List = []
    for action in builder.actions:
        if isinstance(action, (AddInit, AddMeasure)):
            continue
        if isinstance(action, AddNote):
            add_note_heads.append(action.note)

    xml_bytes = builder.to_musicxml()
    out_path = out_dir
    if not out_path.endswith(".musicxml"):
        out_path = os.path.join(out_dir, basename + ".musicxml")
    with open(out_path, "wb") as fh:
        fh.write(xml_bytes)

    # The working-image grayscale in [0,1], 0=ink (BGR->gray, then invert-free; cv2 reads BGR
    # but luminance is fine for the position-based NCC).
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY).astype(np.float32) / 255.0

    # Build the staff lookup: (track, group) -> list of (x_left, x_right, [5 line y's]).
    staff_zones = _staff_zones(staffs)

    # Pair each AddNote NoteHead with the matching pitched NoteEvent (document order) so the
    # index is keyed by the SAME (measure, staff, onset) reconcile.to_events produces.
    events = reconcile.to_events(xml_bytes, "oemer")
    pitched_events = [e for e in events if e.pitch is not None]

    rows = []
    if len(pitched_events) == len(add_note_heads):
        for ev, nh in zip(pitched_events, add_note_heads):
            row = _note_row(ev, nh, staff_zones)
            if row is not None:
                rows.append(row)
    # If counts disagree (oemer version drift, an unexpected action shape), we emit NO rows:
    # an empty index makes every localize miss -> the referee declines. Safe by construction.

    artifact = {"working_gray": gray, "notes": rows}
    return out_path, artifact


def _register_note_id(layers, notes):
    import numpy as np

    symbols = layers.get_layer("symbols_pred")
    layer = layers.get_layer("note_id")
    for idx, note in enumerate(notes):
        x1, y1, x2, y2 = note.bbox
        yi, xi = np.where(symbols[y1:y2, x1:x2] > 0)
        yi += y1
        xi += x1
        layer[yi, xi] = idx
        notes[idx].id = idx


def _staff_zones(staffs):
    """Group the staffs grid into {(track, group): [(x_left, x_right, [y0..y4]), ...]}.
    Each (track, group) is one visual staff split into horizontal x-zones, each carrying its
    locally-fit 5 staff lines (so a skewed scan still gets the right lines per x)."""
    import numpy as np

    zones = {}
    arr = np.array(staffs)
    for idx in np.ndindex(arr.shape):
        st = arr[idx]
        if st is None:
            continue
        try:
            lines = sorted(float(ln.y_center) for ln in st.lines)
            if len(lines) < 5:
                continue
            key = (int(st.track), int(st.group))
            zones.setdefault(key, []).append(
                (float(st.x_left), float(st.x_right), lines[:5])
            )
        except Exception:
            continue
    return zones


def _note_row(ev, nh, staff_zones):
    """One bbox-index row for a pitched NoteEvent + its NoteHead, or None if it cannot be
    localized confidently (no bbox, no matching staff zone)."""
    try:
        bbox = [int(v) for v in nh.bbox]
        if bbox[2] <= bbox[0] or bbox[3] <= bbox[1]:
            return None
        x_center = (bbox[0] + bbox[2]) / 2.0
        # oemer track is 0-based (0=treble, 1=bass); the XML <staff> (ev.staff) is 1-based.
        track = nh.track if nh.track is not None else (ev.staff - 1)
        group = nh.group
        lines = _lines_for(staff_zones, int(track), group, x_center)
        if lines is None:
            return None
        step, alter, octave = ev.pitch
        return {
            "measure": ev.measure,
            "staff": ev.staff,
            "onset": ev.onset,
            "base": ev.base,
            "step": step,
            "octave": octave,
            "alter": alter,
            "is_chord": ev.is_chord,
            "bbox": bbox,
            "lines": lines,
            "x_center": x_center,
        }
    except Exception:
        return None


def _lines_for(staff_zones, track, group, x_center):
    """The 5 staff-line y's for the (track, group) staff at x_center: pick the x-zone that
    contains x_center, else the nearest zone. Returns [y0..y4] or None."""
    candidates = staff_zones.get((track, group))
    if not candidates and group is not None:
        # group may be unset on a stray note; fall back to any zone for that track.
        candidates = []
        for (t, _g), zs in staff_zones.items():
            if t == track:
                candidates.extend(zs)
    if not candidates:
        return None
    inside = [z for z in candidates if z[0] <= x_center <= z[1]]
    if inside:
        return list(inside[0][2])
    # Nearest zone by x-distance to its center.
    nearest = min(candidates, key=lambda z: abs((z[0] + z[1]) / 2.0 - x_center))
    return list(nearest[2])
