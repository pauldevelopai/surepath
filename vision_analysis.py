"""
SurePath Vision Analysis Module
Uses Claude Vision for property analysis.
HuggingFace pre-classification for room/space detection and crack detection.
"""

import anthropic
import base64
import json
import sys
import os
import httpx
from pathlib import Path
from typing import Optional

VISION_SYSTEM_PROMPT = """You are a certified property inspector with 20 years of South African experience.
Analyse these property photos. Identify every visible risk, defect, or flag
that would concern a buyer, an insurer, or a trades professional.

Return structured JSON per photo:
{
  "photo_type": "exterior|interior|roof|bathroom|kitchen|db_board|ceiling|other",
  "findings": [{
    "category": "roof|walls|damp|electrical|plumbing|ceiling|structure|extension",
    "observation": "exact description of what you see",
    "confidence": "CONFIRMED_VISIBLE|PROBABLE|POSSIBLE|NOT_DETECTABLE",
    "severity": "CRITICAL|HIGH|MEDIUM|LOW|COSMETIC",
    "estimated_repair_cost_zar": { "min": 0, "max": 0 },
    "relevant_to": ["consumer","insurance","trades","solar"]
  }],
  "roof_material": "corrugated_cement|IBR|concrete_tile|clay_tile|other|unknown",
  "solar_installed": false,
  "roof_orientation_estimate": "north|south|east|west|unclear",
  "asbestos_indicators": false,
  "security_visible": false
}

Rules: Never confirm asbestos — flag indicators only. SA terminology. ZAR cost estimates.
Return ONLY valid JSON. No markdown fences, no commentary."""

# Use opus for full reports, sonnet for bulk/cost-sensitive operations
MODEL_FULL = "claude-opus-4-5-20250929"
MODEL_SCALE = "claude-sonnet-4-6"

# HuggingFace model endpoints (router API — replaces deprecated api-inference)
HF_ROUTER_BASE = "https://router.huggingface.co/hf-inference/models"
HF_SPACE_CLASSIFIER = f"{HF_ROUTER_BASE}/google/vit-base-patch16-224"
HF_CRACK_DETECTOR = f"{HF_ROUTER_BASE}/facebook/detr-resnet-50"

# Space types that indicate exterior walls (eligible for crack detection)
WALL_TYPES = {"wall", "facade", "house_facade", "exterior", "patio", "mobile_home", "church"}

# Map ImageNet labels to property-relevant space types
IMAGENET_TO_SPACE = {
    # Exterior
    "patio, terrace": "exterior",
    "mobile home, manufactured home": "exterior",
    "church, church building": "facade",
    "palace": "facade",
    "castle": "facade",
    "monastery": "facade",
    "mosque": "facade",
    "barn": "exterior",
    "boathouse": "exterior",
    "greenhouse, nursery, glasshouse": "exterior",
    "picket fence, paling": "exterior",
    "stone wall": "wall",
    "worm fence, snake fence": "exterior",
    # Interior - Kitchen
    "dining table, board": "kitchen",
    "plate rack": "kitchen",
    "refrigerator, icebox": "kitchen",
    "Dutch oven": "kitchen",
    "stove": "kitchen",
    "microwave, microwave oven": "kitchen",
    "toaster": "kitchen",
    # Interior - Bathroom
    "bathtub, bathing tub, bath, tub": "bathroom",
    "washbasin, handbasin, washbowl": "bathroom",
    "toilet seat": "bathroom",
    "shower curtain": "bathroom",
    "medicine chest, medicine cabinet": "bathroom",
    "tub, vat": "bathroom",
    # Interior - Living areas
    "entertainment center": "living_room",
    "home theater, home theatre": "living_room",
    "television, television system": "living_room",
    "rocking chair, rocker": "living_room",
    "studio couch, day bed": "living_room",
    # Interior - Bedroom
    "four-poster": "bedroom",
    "cradle": "bedroom",
    "quilt, comforter, comfort, puff": "bedroom",
    # Structure
    "window shade": "interior",
    "window screen": "interior",
    "sliding door": "interior",
    "steel arch bridge": "structure",
    "suspension bridge": "structure",
    # Garden/Pool
    "swimming trunks, bathing trunks": "pool",
    "fountain": "garden",
    "park bench": "garden",
    "lawn mower, mower": "garden",
}


# ─── HuggingFace Pre-Classification ─────────────────────────────────────

def classify_image_space(image_base64: str, hf_token: str) -> dict:
    """Classify a property image into a property-relevant space type.

    Uses google/vit-base-patch16-224 via HF Router API, then maps
    ImageNet labels to property space types (kitchen, bathroom, exterior, etc.)

    Args:
        image_base64: Base64-encoded image data.
        hf_token: HuggingFace API token.

    Returns:
        {"label": "kitchen", "score": 0.92} for the top classification.
        Returns {"label": "unknown", "score": 0} on any error.
    """
    try:
        image_bytes = base64.b64decode(image_base64)
        response = httpx.post(
            HF_SPACE_CLASSIFIER,
            headers={
                "Authorization": f"Bearer {hf_token}",
                "Content-Type": "image/jpeg",
            },
            content=image_bytes,
            timeout=30.0,
        )
        if response.status_code != 200:
            return {"label": "unknown", "score": 0}

        results = response.json()
        if isinstance(results, list) and len(results) > 0:
            # Map the top ImageNet label to a property space type
            top = results[0]
            raw_label = top.get("label", "unknown")
            score = round(top.get("score", 0), 4)

            # Map to property space type
            mapped = IMAGENET_TO_SPACE.get(raw_label, "other")
            return {"label": mapped, "score": score, "raw_label": raw_label}

        return {"label": "unknown", "score": 0}
    except Exception:
        return {"label": "unknown", "score": 0}


def detect_wall_cracks(image_base64: str, hf_token: str) -> list | None:
    """Detect objects/features in wall/facade images using DETR.

    Uses facebook/detr-resnet-50 for object detection on exterior images.
    Useful for detecting structural elements, damage indicators, and features.

    Only call this when the image is classified as a wall/facade type
    with confidence > 0.55.

    Args:
        image_base64: Base64-encoded image data.
        hf_token: HuggingFace API token.

    Returns:
        List of detection results from the model, or None on error.
    """
    try:
        image_bytes = base64.b64decode(image_base64)
        response = httpx.post(
            HF_CRACK_DETECTOR,
            headers={
                "Authorization": f"Bearer {hf_token}",
                "Content-Type": "image/jpeg",
            },
            content=image_bytes,
            timeout=30.0,
        )
        if response.status_code != 200:
            return None

        results = response.json()
        if isinstance(results, list):
            return results
        return None
    except Exception:
        return None


def run_hf_prestage(image_base64: str, hf_token: str) -> dict:
    """Run the full HF pre-classification pipeline on a single image.

    Stage 1: Classify the image space type (kitchen, bathroom, facade, etc.)
    Stage 2: If the image is a wall/facade with confidence > 0.55, run crack detection.

    Args:
        image_base64: Base64-encoded image data.
        hf_token: HuggingFace API token.

    Returns:
        {
            "space_type": "wall",
            "space_confidence": 0.82,
            "crack_detections": null | [...]
        }
    """
    # Stage 1: Space classification
    space = classify_image_space(image_base64, hf_token)

    result = {
        "space_type": space["label"],
        "space_confidence": space["score"],
        "crack_detections": None,
    }

    # Stage 2: Crack detection (only for wall/facade images with good confidence)
    if space["label"] in WALL_TYPES and space["score"] > 0.55:
        cracks = detect_wall_cracks(image_base64, hf_token)
        result["crack_detections"] = cracks

    return result


# ─── CLI entry point for Node.js subprocess calls ───────────────────────

def _cli_prestage():
    """Called from Node.js via: python3 vision_analysis.py prestage <base64_file>

    Reads base64 image data from a temp file, runs HF pre-stage,
    prints JSON result to stdout.
    """
    if len(sys.argv) < 3:
        print(json.dumps({"error": "Usage: vision_analysis.py prestage <base64_file>"}))
        sys.exit(1)

    hf_token = os.environ.get("HF_API_TOKEN", "")
    if not hf_token:
        print(json.dumps({"space_type": "unknown", "space_confidence": 0, "crack_detections": None}))
        sys.exit(0)

    base64_file = sys.argv[2]
    try:
        image_b64 = Path(base64_file).read_text().strip()
    except Exception as e:
        print(json.dumps({"error": f"Failed to read base64 file: {e}"}))
        sys.exit(1)

    result = run_hf_prestage(image_b64, hf_token)
    print(json.dumps(result))


# ─── Existing Claude Vision functions ────────────────────────────────────

def _encode_image_file(path: str) -> tuple[str, str]:
    """Read a local image file and return (base64_data, media_type)."""
    p = Path(path)
    suffix = p.suffix.lower()
    media_types = {
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".gif": "image/gif",
        ".webp": "image/webp",
    }
    media_type = media_types.get(suffix, "image/jpeg")
    data = base64.standard_b64encode(p.read_bytes()).decode("utf-8")
    return data, media_type


def _build_image_block(image_source: str) -> dict:
    """Build a Claude API image content block from a URL or local path."""
    if image_source.startswith(("http://", "https://")):
        return {
            "type": "image",
            "source": {"type": "url", "url": image_source},
        }
    else:
        data, media_type = _encode_image_file(image_source)
        return {
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": media_type,
                "data": data,
            },
        }


def analyse_single_image(
    image_source: str,
    client: Optional[anthropic.Anthropic] = None,
    model: str = MODEL_SCALE,
) -> dict:
    if client is None:
        client = anthropic.Anthropic()

    image_block = _build_image_block(image_source)

    message = client.messages.create(
        model=model,
        max_tokens=4096,
        system=VISION_SYSTEM_PROMPT,
        messages=[
            {
                "role": "user",
                "content": [
                    image_block,
                    {"type": "text", "text": "Analyse this property photo."},
                ],
            }
        ],
    )

    raw_text = message.content[0].text
    return json.loads(raw_text)


def analyse_property_images(
    image_sources: list[str],
    client: Optional[anthropic.Anthropic] = None,
    model: str = MODEL_SCALE,
    batch: bool = False,
) -> list[dict]:
    if client is None:
        client = anthropic.Anthropic()

    if batch and len(image_sources) > 1:
        return [_analyse_batch(image_sources, client, model)]

    results = []
    for source in image_sources:
        result = analyse_single_image(source, client=client, model=model)
        results.append(result)
    return results


def _analyse_batch(
    image_sources: list[str],
    client: anthropic.Anthropic,
    model: str,
) -> dict:
    content_blocks = []
    for i, source in enumerate(image_sources, 1):
        content_blocks.append(
            {"type": "text", "text": f"Photo {i}:"}
        )
        content_blocks.append(_build_image_block(source))

    content_blocks.append(
        {
            "type": "text",
            "text": (
                "Analyse all photos above as a single property. "
                "Return a JSON array with one object per photo."
            ),
        }
    )

    message = client.messages.create(
        model=model,
        max_tokens=8192,
        system=VISION_SYSTEM_PROMPT,
        messages=[{"role": "user", "content": content_blocks}],
    )

    raw_text = message.content[0].text
    return json.loads(raw_text)


def aggregate_findings(analyses: list[dict]) -> dict:
    all_findings = []
    roof_material = "unknown"
    solar_installed = False
    roof_orientation = "unclear"
    asbestos_indicators = False
    security_visible = False

    for analysis in analyses:
        if isinstance(analysis, list):
            for item in analysis:
                _extract(item, all_findings)
                roof_material, solar_installed, roof_orientation, asbestos_indicators, security_visible = _merge_meta(
                    item, roof_material, solar_installed, roof_orientation, asbestos_indicators, security_visible
                )
        else:
            _extract(analysis, all_findings)
            roof_material, solar_installed, roof_orientation, asbestos_indicators, security_visible = _merge_meta(
                analysis, roof_material, solar_installed, roof_orientation, asbestos_indicators, security_visible
            )

    severity_weights = {"CRITICAL": 10, "HIGH": 7, "MEDIUM": 4, "LOW": 2, "COSMETIC": 1}
    insurance_findings = [f for f in all_findings if "insurance" in f.get("relevant_to", [])]
    insurance_severity = sum(severity_weights.get(f.get("severity", "LOW"), 2) for f in insurance_findings)
    insurance_risk_score = min(10, max(1, insurance_severity // 2 + (3 if asbestos_indicators else 0)))

    solar_score = 5
    if roof_orientation in ("north",):
        solar_score += 3
    elif roof_orientation in ("east", "west"):
        solar_score += 1
    elif roof_orientation in ("south",):
        solar_score -= 2
    if roof_material in ("IBR", "concrete_tile", "clay_tile"):
        solar_score += 1
    if roof_material == "corrugated_cement":
        solar_score -= 1
    if solar_installed:
        solar_score += 1
    roof_issues = [f for f in all_findings if f.get("category") == "roof" and f.get("severity") in ("CRITICAL", "HIGH")]
    solar_score -= len(roof_issues)
    solar_suitability_score = min(10, max(1, solar_score))

    crime_risk_score = 5

    structural_flags = [f for f in all_findings if f.get("category") in ("structure", "walls", "ceiling")]
    compliance_flags = [f for f in all_findings if f.get("category") in ("electrical", "plumbing")]

    total_min = sum(f.get("estimated_repair_cost_zar", {}).get("min", 0) for f in all_findings)
    total_max = sum(f.get("estimated_repair_cost_zar", {}).get("max", 0) for f in all_findings)

    trades_by_category = {}
    for f in all_findings:
        if "trades" in f.get("relevant_to", []):
            cat = f.get("category", "other")
            if cat not in trades_by_category:
                trades_by_category[cat] = []
            trades_by_category[cat].append(f)
    trades_flags = [
        {"trade_type": cat, "items": items}
        for cat, items in sorted(
            trades_by_category.items(),
            key=lambda x: max(severity_weights.get(i.get("severity", "LOW"), 2) for i in x[1]),
            reverse=True,
        )
    ]

    asbestos_risk = "NEGLIGIBLE"
    if asbestos_indicators:
        asbestos_risk = "HIGH"
        if roof_material == "corrugated_cement":
            asbestos_risk = "CRITICAL"

    return {
        "vision_findings": all_findings,
        "asbestos_risk": asbestos_risk,
        "structural_flags": structural_flags,
        "compliance_flags": compliance_flags,
        "repair_estimates": {"total_min_zar": total_min, "total_max_zar": total_max},
        "insurance_risk_score": insurance_risk_score,
        "insurance_flags": [f for f in all_findings if "insurance" in f.get("relevant_to", [])],
        "solar_suitability_score": solar_suitability_score,
        "crime_risk_score": crime_risk_score,
        "trades_flags": trades_flags,
        "maintenance_cost_estimate": total_max,
        "roof_material": roof_material,
        "solar_installed": solar_installed,
        "security_visible": security_visible,
    }


def _extract(analysis: dict, findings_list: list):
    for finding in analysis.get("findings", []):
        finding["photo_type"] = analysis.get("photo_type", "unknown")
        findings_list.append(finding)


def _merge_meta(
    analysis: dict,
    roof_material: str,
    solar_installed: bool,
    roof_orientation: str,
    asbestos_indicators: bool,
    security_visible: bool,
) -> tuple:
    rm = analysis.get("roof_material", "unknown")
    if rm != "unknown":
        roof_material = rm
    if analysis.get("solar_installed"):
        solar_installed = True
    ro = analysis.get("roof_orientation_estimate", "unclear")
    if ro != "unclear":
        roof_orientation = ro
    if analysis.get("asbestos_indicators"):
        asbestos_indicators = True
    if analysis.get("security_visible"):
        security_visible = True
    return roof_material, solar_installed, roof_orientation, asbestos_indicators, security_visible


# ─── Main ────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    if len(sys.argv) >= 2 and sys.argv[1] == "prestage":
        _cli_prestage()
    else:
        print("Usage: python3 vision_analysis.py prestage <base64_file>")
        sys.exit(1)
