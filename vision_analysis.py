"""
SurePath Vision Analysis Module
Uses Claude Vision (claude-opus-4-5 / claude-sonnet-4-5) to inspect property photos.
"""

import anthropic
import base64
import json
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
MODEL_SCALE = "claude-sonnet-4-5-20250514"


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
    """Analyse a single property image with Claude Vision.

    Args:
        image_source: URL or local file path to the image.
        client: Anthropic client instance (created if not provided).
        model: Model to use. Defaults to sonnet for cost efficiency.

    Returns:
        Parsed JSON dict with photo_type, findings, roof_material, etc.
    """
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
    """Analyse multiple property images.

    For a single property report, pass all available photos. Each image is
    analysed individually to get per-photo structured findings.

    Args:
        image_sources: List of URLs or local file paths.
        client: Anthropic client instance.
        model: Model to use.
        batch: If True, send all images in one request for cross-referencing.

    Returns:
        List of analysis dicts, one per image (or one combined if batch=True).
    """
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
    """Send all images in a single request for cross-referenced analysis."""
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
    """Aggregate per-image analyses into a property-level summary.

    Returns a dict suitable for populating property_reports fields:
    - vision_findings: all findings across images
    - asbestos_risk: worst-case risk level from indicators
    - structural_flags: filtered structural findings
    - compliance_flags: electrical/plumbing compliance issues
    - repair_estimates: aggregated cost estimates
    - insurance_risk_score: 1-10 derived from findings
    - solar_suitability_score: 1-10 based on roof analysis
    - trades_flags: prioritised trades work list
    - roof_material, solar_installed, security_visible: from image analysis
    """
    all_findings = []
    roof_material = "unknown"
    solar_installed = False
    roof_orientation = "unclear"
    asbestos_indicators = False
    security_visible = False

    for analysis in analyses:
        if isinstance(analysis, list):
            # Handle batch response returning array
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

    # Derive scores
    severity_weights = {"CRITICAL": 10, "HIGH": 7, "MEDIUM": 4, "LOW": 2, "COSMETIC": 1}
    total_severity = sum(severity_weights.get(f.get("severity", "LOW"), 2) for f in all_findings)

    # Insurance risk: higher severity = higher risk
    insurance_findings = [f for f in all_findings if "insurance" in f.get("relevant_to", [])]
    insurance_severity = sum(severity_weights.get(f.get("severity", "LOW"), 2) for f in insurance_findings)
    insurance_risk_score = min(10, max(1, insurance_severity // 2 + (3 if asbestos_indicators else 0)))

    # Solar suitability: based on roof material, orientation, existing panels
    solar_score = 5  # baseline
    if roof_orientation in ("north",):
        solar_score += 3
    elif roof_orientation in ("east", "west"):
        solar_score += 1
    elif roof_orientation in ("south",):
        solar_score -= 2
    if roof_material in ("IBR", "concrete_tile", "clay_tile"):
        solar_score += 1
    if roof_material == "corrugated_cement":
        solar_score -= 1  # potential asbestos, harder install
    if solar_installed:
        solar_score += 1  # already proven viable
    # Penalise for roof damage findings
    roof_issues = [f for f in all_findings if f.get("category") == "roof" and f.get("severity") in ("CRITICAL", "HIGH")]
    solar_score -= len(roof_issues)
    solar_suitability_score = min(10, max(1, solar_score))

    # Crime risk score (from suburb_crime_score, not vision — placeholder)
    crime_risk_score = 5  # default, updated from crime_incidents data

    # Structural flags
    structural_flags = [f for f in all_findings if f.get("category") in ("structure", "walls", "ceiling")]

    # Compliance flags
    compliance_flags = [f for f in all_findings if f.get("category") in ("electrical", "plumbing")]

    # Repair estimates aggregated
    total_min = sum(f.get("estimated_repair_cost_zar", {}).get("min", 0) for f in all_findings)
    total_max = sum(f.get("estimated_repair_cost_zar", {}).get("max", 0) for f in all_findings)

    # Trades flags: group by category, sort by severity
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

    # Asbestos risk level
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
    """Extract findings from a single analysis into the combined list."""
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
    """Merge metadata from an analysis, preferring definitive values."""
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
