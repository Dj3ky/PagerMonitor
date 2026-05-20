/**
 * Extract location from a pager message.
 * Handles Slovenian pager address formats.
 *
 * Coordinate formats:
 *   46.0569,14.5058
 *   LAT:46.0569 LON:14.5058
 *   N46.0569 E14.5058
 *   46°03'24"N 14°30'21"E
 *
 * Slovenian address formats:
 *   Dunajska cesta 5              → "Dunajska cesta 5"
 *   ŽUPANJE NJIVE 24A             → "ŽUPANJE NJIVE 24A"   (all-caps)
 *   DOL PRI LJUBLJANI, VIDEM 54   → "VIDEM 54, DOL PRI LJUBLJANI"  (settlement + street)
 *   Dol pri Ljubljani, Videm 54   → same, mixed case
 */

// ── Coordinate patterns ───────────────────────────────────────────────────────
const DECIMAL_RE    = /(-?\d{1,3}\.\d{3,})\s*,\s*(-?\d{1,3}\.\d{3,})/;
const LAT_LON_RE    = /LAT[=:]\s*(-?\d+\.?\d*)\s+LON[=:]\s*(-?\d+\.?\d*)/i;
const NSEW_RE       = /([NS])\s*(\d+\.\d+)\s+([EW])\s*(\d+\.\d+)/i;
const DMS_RE        = /(\d+)°(\d+)'(\d+(?:\.\d+)?)"([NS])\s+(\d+)°(\d+)'(\d+(?:\.\d+)?)"([EW])/i;

function dms(deg, min, sec, dir) {
  const d = +deg + +min / 60 + +sec / 3600;
  return (dir === 'S' || dir === 'W') ? -d : d;
}
function validCoord(lat, lng) {
  return lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

// ── Slovenian address patterns ────────────────────────────────────────────────
// Matches a word sequence ending with a house number:
//   - Mixed/title case: "Dunajska cesta 5" or "Županje Njive 24A"
//   - ALL CAPS: "ŽUPANJE NJIVE 24A"
// Word chars include Slovenian Š Č Ž etc.
const SLO_WORD     = '[A-ZČŠŽĆĐ][A-ZČŠŽĆĐa-zčšžćđ]*';
const STREET_RE    = new RegExp(
  // Settlement prefix: "DOL PRI LJUBLJANI, " or "Dol pri Ljubljani, "
  `(?:(${SLO_WORD}(?:\\s+(?:pri|v|na|pod|nad|ob|za|${SLO_WORD}))*)\\s*,\\s*)?` +
  // Street name: one or more words (mixed or all-caps)
  `((?:${SLO_WORD}|[A-ZČŠŽ]{2,})(?:\\s+(?:${SLO_WORD}|[A-ZČŠŽ]{2,}|pri|v|na|pod|nad|ob|za))*)` +
  // House number: digits + optional letter
  `\\s+(\\d+[a-zA-Z]?)\\b`
);

/**
 * Build the best possible geocoding query from parsed address parts.
 * For ambiguous street names (Videm, Bistrica, etc.) include settlement as context.
 */
function buildGeoQuery(settlement, street, number) {
  const addr = `${street} ${number}`.trim();
  if (settlement) {
    // Format: "VIDEM 54, DOL PRI LJUBLJANI, Slovenia"
    return `${addr}, ${settlement}`;
  }
  return addr;
}

// ── Main parser ───────────────────────────────────────────────────────────────
export function parseLocation(text) {
  if (!text) return null;

  // 1. Decimal coords
  let m = DECIMAL_RE.exec(text);
  if (m) {
    const lat = parseFloat(m[1]), lng = parseFloat(m[2]);
    if (validCoord(lat, lng)) return { lat, lng, raw: m[0], type: 'coords' };
  }

  // 2. LAT/LON keywords
  m = LAT_LON_RE.exec(text);
  if (m) {
    const lat = parseFloat(m[1]), lng = parseFloat(m[2]);
    if (validCoord(lat, lng)) return { lat, lng, raw: m[0], type: 'coords' };
  }

  // 3. N/S E/W decimal
  m = NSEW_RE.exec(text);
  if (m) {
    const lat = m[1].toUpperCase() === 'S' ? -parseFloat(m[2]) : parseFloat(m[2]);
    const lng = m[3].toUpperCase() === 'W' ? -parseFloat(m[4]) : parseFloat(m[4]);
    if (validCoord(lat, lng)) return { lat, lng, raw: m[0], type: 'coords' };
  }

  // 4. DMS
  m = DMS_RE.exec(text);
  if (m) {
    const lat = dms(m[1], m[2], m[3], m[4].toUpperCase());
    const lng = dms(m[5], m[6], m[7], m[8].toUpperCase());
    if (validCoord(lat, lng)) return { lat, lng, raw: m[0], type: 'coords' };
  }

  // 5. Slovenian address
  m = STREET_RE.exec(text);
  if (m) {
    const [, settlement, street, number] = m;
    const query = buildGeoQuery(settlement, street, number);
    return {
      lat: null, lng: null,
      raw:        m[0].trim(),   // original matched text
      geoQuery:   query,         // what to send to Nominatim
      type:       'address',
      settlement: settlement || null,
      street:     street,
      number:     number,
    };
  }

  return null;
}

// ── Geocoder ──────────────────────────────────────────────────────────────────
export async function geocodeAddress(rawOrQuery, countryCode = 'si') {
  // Accept either a plain string (old API) or a location object with geoQuery
  const query = typeof rawOrQuery === 'object'
    ? (rawOrQuery.geoQuery || rawOrQuery.raw)
    : rawOrQuery;

  if (!query) return null;

  try {
    const url = `https://nominatim.openstreetmap.org/search?` +
      `q=${encodeURIComponent(query)}&countrycode=${countryCode}&format=json&limit=1`;
    const r    = await fetch(url, {
      headers: { 'Accept-Language': 'sl,en', 'User-Agent': 'PagerMonitor/1.0' },
    });
    const data = await r.json();
    if (data?.length > 0) {
      return {
        lat:     parseFloat(data[0].lat),
        lng:     parseFloat(data[0].lon),
        display: data[0].display_name,
        query,
      };
    }
  } catch (_) {}
  return null;
}
