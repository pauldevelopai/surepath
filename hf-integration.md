# HuggingFace Pre-Classification Integration

## Overview

The vision pipeline now has a two-stage HuggingFace pre-classification layer that runs **before** Claude Vision analysis. This gives Claude specialist context from purpose-built models, improving defect detection accuracy — especially for wall cracks and room-type-specific issues.

## The Two Models

### Stage 1: Room/Space Classification
- **Model**: `andupets/real-estate-image-classification-30classes`
- **What it does**: Classifies a property image into one of 30 real estate space types (kitchen, bathroom, bedroom, facade, wall, garden, pool, etc.)
- **Why**: Tells Claude what kind of space it's looking at, so it can focus on relevant defects (e.g., plumbing in bathrooms, electrical in kitchens, cracks on facades)

### Stage 2: Wall Crack Detection
- **Model**: `OpenSistemas/YOLOv8-crack-seg`
- **What it does**: Detects and segments cracks in wall/facade images using YOLOv8
- **When**: Only runs if Stage 1 classified the image as `wall`, `facade`, `house_facade`, or `exterior` with confidence > 0.55
- **Why**: Specialist crack detection catches hairline cracks that general-purpose vision might miss

## Getting a Free HF Token

1. Go to [huggingface.co](https://huggingface.co) and create a free account
2. Go to Settings → Access Tokens → New Token
3. Name it "surepath" and select "Read" access
4. Copy the token (starts with `hf_`)
5. Add to your `.env` file: `HF_API_TOKEN=hf_your_token_here`

The free tier includes 30,000 inference requests/month — more than enough for property analysis.

## How It Works

```
Image → [HF Stage 1: Space Classification] → [HF Stage 2: Crack Detection (if wall)]
                                                          ↓
                                              Context injected into Claude prompt:
                                              [HF Pre-analysis: space_type=wall, confidence=0.82, crack_detections=3]
                                                          ↓
                                              [Claude Vision: Full property analysis with HF context]
                                                          ↓
                                              Results stored in property_images.vision_analysis
                                              with hf_prestage data merged in
```

## Testing

```bash
# Test HF pre-classification directly (Python)
echo "BASE64_IMAGE_DATA" > /tmp/test.b64
HF_API_TOKEN=hf_your_token python3 vision_analysis.py prestage /tmp/test.b64

# Test the full pipeline (Node.js)
# Set HF_API_TOKEN in your .env file, then:
node test-vision.js

# Test without HF (falls back gracefully)
# Simply don't set HF_API_TOKEN — the pipeline runs without it
```

## Graceful Fallback

The HF layer **never blocks** the pipeline:
- If `HF_API_TOKEN` is not set → falls back to standard `analysePropertyImages()`
- If HF API returns an error → returns `{space_type: "unknown", space_confidence: 0}` and continues
- If the HF model is loading (cold start) → returns unknown and continues
- If Python is not installed → falls back silently

## Data Storage

HF results are stored in the existing `vision_analysis` JSONB column under the key `hf_prestage`:

```json
{
  "photo_type": "exterior",
  "findings": [...],
  "hf_prestage": {
    "space_type": "house_facade",
    "space_confidence": 0.91,
    "crack_detections": [{"label": "crack", "score": 0.87, "box": {...}}]
  }
}
```

## API Usage

```javascript
const { analyseWithHFPrestage } = require('./vision');

// Uses HF pre-classification + Claude Vision
const result = await analyseWithHFPrestage(propertyId, imageUrls);

// Falls back to standard pipeline if HF_API_TOKEN not set
const { analysePropertyImages } = require('./vision');
const result = await analysePropertyImages(imageUrls, propertyId);
```
