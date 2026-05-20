/**
 * Extract location from a Slovenian pager message.
 *
 */

// ── Coordinate patterns ───────────────────────────────────────────────────────
const DECIMAL_RE = /(-?\d{1,3}\.\d{3,})\s*,\s*(-?\d{1,3}\.\d{3,})/;
const LAT_LON_RE = /LAT[=:]\s*(-?\d+\.?\d*)\s+LON[=:]\s*(-?\d+\.?\d*)/i;
const NSEW_RE    = /([NS])\s*(\d+\.\d+)\s+([EW])\s*(\d+\.\d+)/i;
const DMS_RE     = /(\d+)°(\d+)'(\d+(?:\.\d+)?)"([NS])\s+(\d+)°(\d+)'(\d+(?:\.\d+)?)"([EW])/i;

function dms(deg, min, sec, dir) {
  const d = +deg + +min / 60 + +sec / 3600;
  return (dir === 'S' || dir === 'W') ? -d : d;
}
function validCoord(lat, lng) {
  return lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180 &&
         Math.abs(lat) > 0.001 && Math.abs(lng) > 0.001;
}

// ── Suffix candidates for Nominatim ──────────────────────────────────────────
/**
 * Generate word-boundary suffixes of decreasing length.
 */
function suffixCandidates(text) {
  const words = text.trim().split(/\s+/);
  const candidates = [];
  const hasNumber = s => /\d/.test(s);

  for (let i = 0; i < words.length - 1; i++) {
    const suffix = words.slice(i).join(' ');
    if (hasNumber(suffix)) {
      candidates.push(`${suffix}, Slovenia`);
    }
  }
  return candidates;
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

  // 5. Address — only if message contains a house number
  if (/\d/.test(text)) {
    const candidates = suffixCandidates(text);
    if (candidates.length > 0) {
      return {
        lat: null, lng: null,
        type:       'address',
        raw:        text,
        candidates,
        geoQuery:   candidates[0],
      };
    }
  }

  return null;
}

// ── Geocoder (Nominatim) ──────────────────────────────────────────────────────
export async function geocodeAddress(loc, countryCode = 'si') {
  const queries = typeof loc === 'object' && loc?.candidates
    ? loc.candidates
    : [typeof loc === 'string' ? loc : loc?.geoQuery || loc?.raw].filter(Boolean);

  for (const query of queries) {
    if (!query?.trim()) continue;
    try {
      const url = `https://nominatim.openstreetmap.org/search?` +
        `q=${encodeURIComponent(query)}&countrycode=${countryCode}&format=json&limit=1`;
      const r    = await fetch(url, {
        headers: { 'Accept-Language': 'sl,en', 'User-Agent': 'PagerMonitor/2.1' },
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
    // Polite delay between Nominatim requests
    await new Promise(r => setTimeout(r, 300));
  }
  return null;
}
