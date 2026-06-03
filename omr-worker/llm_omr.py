#!/usr/bin/env python3
"""LLM-vision OMR transcriber (the "big value, small latency" engine).

The geometry-based engines (Clarity, oemer) and the visual-diff referee struggle most on
CHORDS and dense polyphony, and oemer is slow (~3-7 min on CPU). A multimodal LLM reads a
score image holistically: it is robust to chords, runs in seconds (one API round-trip), and
needs no per-note pixel geometry. This module asks a vision LLM to transcribe a rasterized
score into a STRICT JSON note model, then deterministically builds MusicXML from that model
(so the output is always well-formed regardless of how the model phrases things).

Design choices that matter:
  - PROVIDER-AGNOSTIC via tiny adapters (Anthropic / OpenAI-compatible / Gemini), all over
    stdlib urllib + json so the worker pulls NO new dependency. Pick via env; default Anthropic.
  - INERT WITHOUT A KEY: llm_available() is False unless the engine is flagged on AND an API
    key is present, so prod stays exactly as today (free engines) until a key is configured.
    This is the deliberate, opt-in relaxation of the "free tooling" rule (it costs ~pennies/scan).
  - NEVER RAISE: transcribe() returns None on ANY failure (no key, HTTP error, bad JSON,
    empty result) so the worker falls back to the existing engine pipeline. Same #113 contract.
  - The JSON -> MusicXML builder is PURE and unit-tested; it emits a 1-part / 2-staff grand
    staff (oemer's shape) so it flows through the existing merge_to_grand_staff + normalize_ties
    post-transforms unchanged.

Env:
  OMR_LLM                 master flag ("1"/"true" to enable this engine)
  OMR_LLM_PROVIDER        anthropic (default) | openai | gemini
  OMR_LLM_MODEL           model id (provider default if unset)
  OMR_LLM_API_KEY         API key (else the provider-standard var below)
  ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY   provider-standard key fallback
  OMR_LLM_BASE_URL        override the API base (for OpenAI-compatible gateways / proxies)
  OMR_LLM_MAX_EDGE        max image long-edge px before upload (default 2048; controls cost)
  OMR_LLM_TIMEOUT         per-request timeout seconds (default 120)
"""

from __future__ import annotations

import base64
import io
import json
import os
import urllib.request
import xml.etree.ElementTree as ET
from typing import Optional, Tuple

# --- Env / gating ------------------------------------------------------------------------

OMR_LLM_ENV = "OMR_LLM"
_DEFAULT_MODELS = {
    "anthropic": "claude-sonnet-4-6",
    "openai": "gpt-4o",
    "gemini": "gemini-2.0-flash",
}
_KEY_ENVS = {
    "anthropic": "ANTHROPIC_API_KEY",
    "openai": "OPENAI_API_KEY",
    "gemini": "GEMINI_API_KEY",
}


def _flag_on(name: str) -> bool:
    raw = os.environ.get(name)
    return raw is not None and raw.strip().lower() in ("1", "true")


def llm_enabled() -> bool:
    """True when the OMR_LLM master flag is truthy."""
    return _flag_on(OMR_LLM_ENV)


def _provider() -> str:
    return (os.environ.get("OMR_LLM_PROVIDER") or "anthropic").strip().lower()


def _api_key(provider: str) -> Optional[str]:
    key = os.environ.get("OMR_LLM_API_KEY")
    if key:
        return key.strip()
    key = os.environ.get(_KEY_ENVS.get(provider, ""))
    return key.strip() if key else None


def llm_available() -> bool:
    """True when the engine is enabled AND a usable provider+key is configured. The worker
    consults this to decide whether to try the LLM path; False keeps the existing pipeline."""
    if not llm_enabled():
        return False
    provider = _provider()
    if provider not in _DEFAULT_MODELS:
        return False
    return _api_key(provider) is not None


# --- Prompt ------------------------------------------------------------------------------

_SYSTEM = (
    "You are an expert optical music recognition engine for PIANO sheet music. You read a "
    "score image and output its notes as STRICT JSON only. Be meticulous about CHORDS (every "
    "simultaneously-sounding notehead in a stack must appear) and exact pitch (step, octave, "
    "and any accidental). Do not omit inner chord tones. Do not invent notes."
)

# The JSON contract the model must follow. Kept explicit so the deterministic builder can rely
# on it; the builder is also defensive about missing/garbage fields.
_INSTRUCTIONS = (
    "Transcribe this piano score image to JSON with EXACTLY this shape:\n"
    "{\n"
    '  "divisions": <int, ticks per quarter note, e.g. 4>,\n'
    '  "key_fifths": <int, -7..7, 0 if none>,\n'
    '  "time": {"beats": <int>, "beat_type": <int>},\n'
    '  "measures": [\n'
    "    {\n"
    '      "staff1": [ <event>, ... ],   // treble (right hand), in time order\n'
    '      "staff2": [ <event>, ... ]    // bass (left hand), in time order\n'
    "    }\n"
    "  ]\n"
    "}\n"
    "An <event> is either a rest: {\"rest\": true, \"duration\": <int ticks>}\n"
    "or a note/chord: {\"duration\": <int ticks>, \"pitches\": [ {\"step\":\"A\".."
    "\"G\", \"alter\": <-2..2, 0 if natural>, \"octave\": <int>}, ... ]}.\n"
    "A single note has one pitch; a CHORD lists all its pitches together in one event. "
    "Durations within each staff of a measure must sum to the measure capacity. Output ONLY "
    "the JSON object, no prose, no markdown fences."
)


# --- Public entry point ------------------------------------------------------------------

def transcribe(image_path: str) -> Optional[bytes]:
    """Transcribe a rasterized score image to MusicXML bytes via a vision LLM, or None on ANY
    failure (so the worker falls back to the existing engines). NEVER raises."""
    try:
        if not llm_available():
            return None
        provider = _provider()
        key = _api_key(provider)
        if not key:
            return None
        model = (os.environ.get("OMR_LLM_MODEL") or _DEFAULT_MODELS[provider]).strip()

        image_b64, media_type = _encode_image(image_path)
        if image_b64 is None:
            return None

        text = _call_provider(provider, model, key, image_b64, media_type)
        if not text:
            return None
        data = _extract_json(text)
        if not isinstance(data, dict):
            return None
        return score_json_to_musicxml(data)
    except Exception:
        return None


# --- Image encoding ----------------------------------------------------------------------

def _encode_image(image_path: str) -> Tuple[Optional[str], str]:
    """Load the image, downscale its long edge to OMR_LLM_MAX_EDGE (cost control), return
    (base64_png, media_type) or (None, "") on failure. NEVER raises."""
    try:
        from PIL import Image

        # Decompression-bomb guard: a non-PDF upload (10 MB cap) is passed straight here, so a
        # crafted highly-compressible image could balloon during decode. Bound the decoded pixel
        # area before opening; Pillow raises DecompressionBombError past it, which the surrounding
        # try/except turns into a clean None -> fallback. Mirrors worker.MAX_STITCH_PIXELS (kept a
        # local constant to avoid importing worker, which imports this module).
        Image.MAX_IMAGE_PIXELS = 1_000_000_000

        try:
            max_edge = int(os.environ.get("OMR_LLM_MAX_EDGE", "2048"))
        except (TypeError, ValueError):
            max_edge = 2048
        if max_edge < 256:
            max_edge = 256

        im = Image.open(image_path)
        im = im.convert("RGB")
        w, h = im.size
        longest = max(w, h)
        if longest > max_edge:
            scale = max_edge / float(longest)
            im = im.resize((max(1, int(w * scale)), max(1, int(h * scale))), Image.LANCZOS)
        buf = io.BytesIO()
        im.save(buf, format="PNG")
        return base64.b64encode(buf.getvalue()).decode("ascii"), "image/png"
    except Exception:
        return None, ""


# --- Provider adapters (stdlib urllib; no SDK dependency) --------------------------------

def _http_post_json(url: str, headers: dict, body: dict, timeout: float) -> Optional[dict]:
    """POST a JSON body and return the parsed JSON response, or None on any failure."""
    try:
        data = json.dumps(body).encode("utf-8")
        req = urllib.request.Request(url, data=data, headers=headers, method="POST")
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception:
        return None


def _timeout() -> float:
    try:
        t = float(os.environ.get("OMR_LLM_TIMEOUT", "120"))
        return t if t > 0 else 120.0
    except (TypeError, ValueError):
        return 120.0


def _call_provider(provider, model, key, image_b64, media_type) -> Optional[str]:
    """Dispatch to the right provider adapter; return the model's raw text output or None."""
    base = (os.environ.get("OMR_LLM_BASE_URL") or "").strip().rstrip("/")
    if provider == "anthropic":
        return _call_anthropic(base, model, key, image_b64, media_type)
    if provider == "openai":
        return _call_openai(base, model, key, image_b64, media_type)
    if provider == "gemini":
        return _call_gemini(base, model, key, image_b64, media_type)
    return None


def _call_anthropic(base, model, key, image_b64, media_type) -> Optional[str]:
    url = (base or "https://api.anthropic.com") + "/v1/messages"
    headers = {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
    }
    body = {
        "model": model,
        "max_tokens": 8192,
        "system": _SYSTEM,
        "messages": [
            {
                "role": "user",
                "content": [
                    {
                        "type": "image",
                        "source": {"type": "base64", "media_type": media_type, "data": image_b64},
                    },
                    {"type": "text", "text": _INSTRUCTIONS},
                ],
            }
        ],
    }
    resp = _http_post_json(url, headers, body, _timeout())
    if not resp:
        return None
    try:
        parts = resp.get("content") or []
        return "".join(p.get("text", "") for p in parts if p.get("type") == "text") or None
    except Exception:
        return None


def _call_openai(base, model, key, image_b64, media_type) -> Optional[str]:
    url = (base or "https://api.openai.com") + "/v1/chat/completions"
    headers = {"Authorization": "Bearer " + key, "content-type": "application/json"}
    data_url = "data:%s;base64,%s" % (media_type, image_b64)
    body = {
        "model": model,
        "max_tokens": 8192,
        "messages": [
            {"role": "system", "content": _SYSTEM},
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": _INSTRUCTIONS},
                    {"type": "image_url", "image_url": {"url": data_url}},
                ],
            },
        ],
    }
    resp = _http_post_json(url, headers, body, _timeout())
    if not resp:
        return None
    try:
        return resp["choices"][0]["message"]["content"] or None
    except Exception:
        return None


def _call_gemini(base, model, key, image_b64, media_type) -> Optional[str]:
    root = base or "https://generativelanguage.googleapis.com"
    url = "%s/v1beta/models/%s:generateContent?key=%s" % (root, model, key)
    headers = {"content-type": "application/json"}
    body = {
        "system_instruction": {"parts": [{"text": _SYSTEM}]},
        "contents": [
            {
                "parts": [
                    {"inline_data": {"mime_type": media_type, "data": image_b64}},
                    {"text": _INSTRUCTIONS},
                ]
            }
        ],
    }
    resp = _http_post_json(url, headers, body, _timeout())
    if not resp:
        return None
    try:
        parts = resp["candidates"][0]["content"]["parts"]
        return "".join(p.get("text", "") for p in parts) or None
    except Exception:
        return None


def _extract_json(text: str):
    """Parse the model's text into a dict, tolerating ```json fences and leading/trailing prose
    by extracting the outermost {...}. Returns the parsed object or None. NEVER raises."""
    try:
        s = text.strip()
        if s.startswith("```"):
            # strip a ```json ... ``` fence
            s = s.split("```", 2)
            s = s[1] if len(s) >= 2 else text
            if s.lstrip().lower().startswith("json"):
                s = s.lstrip()[4:]
        s = s.strip().strip("`").strip()
        try:
            return json.loads(s)
        except Exception:
            pass
        start = s.find("{")
        end = s.rfind("}")
        if start != -1 and end != -1 and end > start:
            return json.loads(s[start : end + 1])
        return None
    except Exception:
        return None


# --- JSON -> MusicXML (PURE, deterministic, unit-tested) ---------------------------------

_VALID_STEPS = {"A", "B", "C", "D", "E", "F", "G"}


def _int(value, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _append_pitch(note_el: ET.Element, pitch: dict) -> bool:
    """Append a <pitch> child to a <note> from a {step, alter, octave} dict. Returns False if
    the pitch is unusable (so the caller can skip it)."""
    step = str(pitch.get("step", "")).strip().upper()
    if step not in _VALID_STEPS:
        return False
    octave = pitch.get("octave")
    if octave is None:
        return False
    p = ET.SubElement(note_el, "pitch")
    ET.SubElement(p, "step").text = step
    alter = _int(pitch.get("alter", 0), 0)
    if alter:
        ET.SubElement(p, "alter").text = str(alter)
    ET.SubElement(p, "octave").text = str(_int(octave, 4))
    return True


def _build_event(measure_el: ET.Element, event: dict, staff: int) -> int:
    """Append the <note> element(s) for one event (rest, note, or chord) to a measure. Returns
    the duration consumed by the event (for the backup between staves)."""
    duration = _int(event.get("duration", 0), 0)
    if duration <= 0:
        duration = 1
    if event.get("rest"):
        note = ET.SubElement(measure_el, "note")
        ET.SubElement(note, "rest")
        ET.SubElement(note, "duration").text = str(duration)
        ET.SubElement(note, "staff").text = str(staff)
        return duration

    pitches = event.get("pitches")
    if not isinstance(pitches, list) or not pitches:
        # Treat a pitchless event as a rest so the bar stays metrically intact.
        note = ET.SubElement(measure_el, "note")
        ET.SubElement(note, "rest")
        ET.SubElement(note, "duration").text = str(duration)
        ET.SubElement(note, "staff").text = str(staff)
        return duration

    first = True
    wrote_any = False
    for pitch in pitches:
        if not isinstance(pitch, dict):
            continue
        note = ET.SubElement(measure_el, "note")
        if not first:
            # A chord member shares the previous note's onset.
            chord = ET.Element("chord")
            note.insert(0, chord)
        if not _append_pitch(note, pitch):
            measure_el.remove(note)
            continue
        ET.SubElement(note, "duration").text = str(duration)
        ET.SubElement(note, "staff").text = str(staff)
        first = False
        wrote_any = True
    if not wrote_any:
        note = ET.SubElement(measure_el, "note")
        ET.SubElement(note, "rest")
        ET.SubElement(note, "duration").text = str(duration)
        ET.SubElement(note, "staff").text = str(staff)
    return duration


def _staff_total(events) -> int:
    total = 0
    for e in events if isinstance(events, list) else []:
        if isinstance(e, dict):
            d = _int(e.get("duration", 0), 0)
            total += d if d > 0 else 1
    return total


def score_json_to_musicxml(data: dict) -> Optional[bytes]:
    """Build a 1-part / 2-staff grand-staff MusicXML document from the LLM's JSON note model.
    PURE and deterministic: defensive about missing/garbage fields, returns None only if there
    is no usable measure content. NEVER raises.

    Shape: one <part> with <staves>2</staves>, treble clef on staff 1 (G) and bass on staff 2
    (F). Per measure we emit staff-1 events, a <backup> of the staff-1 total, then staff-2
    events, which is the standard way to write two staves in one part. This flows through the
    worker's merge_to_grand_staff (a no-op on an already-merged grand staff) + normalize_ties.
    """
    try:
        if not isinstance(data, dict):
            return None
        measures = data.get("measures")
        if not isinstance(measures, list) or not measures:
            return None

        divisions = _int(data.get("divisions", 4), 4)
        if divisions <= 0:
            divisions = 4
        fifths = _int(data.get("key_fifths", 0), 0)
        time = data.get("time") if isinstance(data.get("time"), dict) else {}
        beats = _int(time.get("beats", 4), 4)
        beat_type = _int(time.get("beat_type", 4), 4)

        root = ET.Element("score-partwise", {"version": "4.0"})
        part_list = ET.SubElement(root, "part-list")
        score_part = ET.SubElement(part_list, "score-part", {"id": "P1"})
        ET.SubElement(score_part, "part-name").text = "Piano"
        part = ET.SubElement(root, "part", {"id": "P1"})

        any_content = False
        for i, measure in enumerate(measures, start=1):
            if not isinstance(measure, dict):
                continue
            m_el = ET.SubElement(part, "measure", {"number": str(i)})
            if i == 1:
                attrs = ET.SubElement(m_el, "attributes")
                ET.SubElement(attrs, "divisions").text = str(divisions)
                key = ET.SubElement(attrs, "key")
                ET.SubElement(key, "fifths").text = str(fifths)
                t = ET.SubElement(attrs, "time")
                ET.SubElement(t, "beats").text = str(beats)
                ET.SubElement(t, "beat-type").text = str(beat_type)
                ET.SubElement(attrs, "staves").text = "2"
                clef1 = ET.SubElement(attrs, "clef", {"number": "1"})
                ET.SubElement(clef1, "sign").text = "G"
                ET.SubElement(clef1, "line").text = "2"
                clef2 = ET.SubElement(attrs, "clef", {"number": "2"})
                ET.SubElement(clef2, "sign").text = "F"
                ET.SubElement(clef2, "line").text = "4"

            staff1 = measure.get("staff1")
            staff2 = measure.get("staff2")
            staff1 = staff1 if isinstance(staff1, list) else []
            staff2 = staff2 if isinstance(staff2, list) else []

            for event in staff1:
                if isinstance(event, dict):
                    _build_event(m_el, event, staff=1)
                    any_content = True

            if staff2:
                backup_total = _staff_total(staff1)
                if backup_total > 0:
                    backup = ET.SubElement(m_el, "backup")
                    ET.SubElement(backup, "duration").text = str(backup_total)
                for event in staff2:
                    if isinstance(event, dict):
                        _build_event(m_el, event, staff=2)
                        any_content = True

        if not any_content:
            return None
        return ET.tostring(root, encoding="utf-8", xml_declaration=True)
    except Exception:
        return None
