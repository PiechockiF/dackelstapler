"""Optional Claude vision pass on the first delivery photo: label + bbox + rough dimensions.

Only runs when ANTHROPIC_API_KEY is set; returns None on any problem so the OpenCV path takes over.
"""

from __future__ import annotations

import base64
import io
import json
import logging
import os
import re

from PIL import Image, ImageOps

log = logging.getLogger(__name__)

MODEL = os.environ.get("SITETWIN_VISION_MODEL", "claude-opus-5-5")

PROMPT = """This phone photo shows a delivered item (pallet, crate, drum, machine part, …) standing on a floor.
A printed black-and-white ArUco marker sheet (black square 150 mm) lies on the floor next to it — it is NOT the item.

Return only a JSON object, no prose:
{"label": "<short noun phrase, e.g. 'Pallet with steel drum'>",
 "bbox": [x0, y0, x1, y1],          // tight box around the whole item incl. its pallet, as fractions 0..1 of image width/height
 "rough_dims_m": {"w": <float>, "d": <float>, "h": <float>},  // your best guess, metres, w >= d
 "confidence": "low"|"medium"|"high"}"""


def available() -> bool:
    return bool(os.environ.get("ANTHROPIC_API_KEY"))


def _jpeg_base64(data: bytes, max_side: int = 1568) -> str:
    image = ImageOps.exif_transpose(Image.open(io.BytesIO(data))).convert("RGB")
    image.thumbnail((max_side, max_side))
    buffer = io.BytesIO()
    image.save(buffer, format="JPEG", quality=88)
    return base64.standard_b64encode(buffer.getvalue()).decode()


def analyze_photo(data: bytes) -> dict | None:
    if not available():
        return None
    try:
        import anthropic

        client = anthropic.Anthropic(timeout=60.0, max_retries=1)
        response = client.messages.create(
            model=MODEL,
            max_tokens=2000,
            output_config={"effort": "low"},
            messages=[{
                "role": "user",
                "content": [
                    {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": _jpeg_base64(data)}},
                    {"type": "text", "text": PROMPT},
                ],
            }],
        )
        if response.stop_reason == "refusal":
            return None
        text = "".join(block.text for block in response.content if block.type == "text")
        match = re.search(r"\{.*\}", text, re.S)
        if not match:
            return None
        parsed = json.loads(match.group(0))
        bbox = [float(v) for v in parsed.get("bbox", [])][:4]
        if len(bbox) != 4 or not all(0 <= v <= 1 for v in bbox) or bbox[2] <= bbox[0] or bbox[3] <= bbox[1]:
            bbox = None
        rough = parsed.get("rough_dims_m") or {}
        rough = {k: float(rough[k]) for k in ("w", "d", "h") if k in rough} if rough else None
        return {"label": str(parsed.get("label") or "").strip()[:80] or None, "bbox": bbox,
                "rough_dims_m": rough if rough and len(rough) == 3 else None,
                "confidence": parsed.get("confidence")}
    except Exception as error:  # noqa: BLE001 — vision is a bonus, never a blocker
        log.warning("Claude vision failed: %s", error)
        return None
