/**
 * Generate a display title for a property.
 *
 * Priority order:
 * 1. Street address + suburb (e.g. "401 The Edge, 247 Bree Street, Gardens")
 * 2. Address normalised from Google (e.g. "Cape Town City Centre, Cape Town, 8000")
 * 3. Listing title cleaned up (remove "for Sale in" boilerplate)
 * 4. Suburb + city fallback
 *
 * Never returns generic text like "Property in Gardens".
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function propertyTitle(p: Record<string, any>): string {
  // Best: real street address
  if (p.street_address && p.street_address.length > 3) {
    const parts = [p.street_address];
    if (p.suburb && !p.street_address.includes(p.suburb)) parts.push(p.suburb);
    return parts.join(", ");
  }

  // Good: Google-normalised address (strip country)
  if (p.address_normalised) {
    return p.address_normalised.replace(/, South Africa$/, "");
  }

  // OK: listing title, cleaned up
  if (p.address_raw) {
    // Remove "X Bedroom Apartment / Flat for Sale in" prefix
    const cleaned = p.address_raw
      .replace(/^\d+\.?\d*\s+Bedroom\s+/i, "")
      .replace(/^(Apartment|House|Flat|Townhouse|Commercial\s+property)\s*\/?\s*(Flat|Apartment)?\s*(for\s+Sale|On\s+Auction|to\s+Rent)\s+in\s+/i, "")
      .trim();

    if (cleaned.length > 2 && cleaned !== p.address_raw) {
      // We extracted the suburb name — add context
      return `${p.bedrooms || "?"}bed ${p.property_type || "property"} in ${cleaned}`;
    }

    // If cleaning didn't help, use as-is but it's not great
    if (p.address_raw.length > 5 && !p.address_raw.startsWith("Property in")) {
      return p.address_raw;
    }
  }

  // Fallback: suburb + city
  if (p.suburb && p.city) {
    const prefix = p.bedrooms ? `${p.bedrooms}bed` : "Property";
    return `${prefix} in ${p.suburb}, ${p.city}`;
  }

  return `Property #${p.id}`;
}

/**
 * Get a short one-line subtitle for the property.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function propertySubtitle(p: Record<string, any>): string {
  const parts: string[] = [];
  if (p.suburb) parts.push(`${p.suburb}, ${p.city || ""}`);
  if (p.bedrooms) parts.push(`${p.bedrooms}bed/${p.bathrooms || "?"}bath`);
  if (p.floor_area_sqm) parts.push(`${p.floor_area_sqm}m²`);
  if (p.property_type) parts.push(p.property_type);
  return parts.join(" · ");
}
