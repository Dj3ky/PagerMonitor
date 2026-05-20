'use strict';

const DECIMAL_RE = /(-?\d{1,3}\.\d{3,})\s*,\s*(-?\d{1,3}\.\d{3,})/;
const LAT_LON_RE = /LAT[=:]\s*(-?\d+\.?\d*)\s+LON[=:]\s*(-?\d+\.?\d*)/i;
const NSEW_RE    = /([NS])\s*(\d+\.\d+)\s+([EW])\s*(\d+\.\d+)/i;
const DMS_RE     = /(\d+)°(\d+)'(\d+(?:\.\d+)?)"([NS])\s+(\d+)°(\d+)'(\d+(?:\.\d+)?)"([EW])/i;

const SLO_WORD   = '[A-ZČŠŽĆĐ][A-ZČŠŽĆĐa-zčšžćđ]*';
const STREET_RE  = new RegExp(
  `(?:(${SLO_WORD}(?:\\s+(?:pri|v|na|pod|nad|ob|za|${SLO_WORD}))*)\\s*,\\s*)?` +
  `((?:${SLO_WORD}|[A-ZČŠŽ]{2,})(?:\\s+(?:${SLO_WORD}|[A-ZČŠŽ]{2,}|pri|v|na|pod|nad|ob|za))*)` +
  `\\s+(\\d+[a-zA-Z]?)\\b`
);

function dms(deg, min, sec, dir) {
  const d = +deg + +min / 60 + +sec / 3600;
  return (dir === 'S' || dir === 'W') ? -d : d;
}
function valid(lat, lng) {
  return lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

function parseLocation(text) {
  if (!text) return { lat: null, lng: null };

  let m = DECIMAL_RE.exec(text);
  if (m) { const lat = parseFloat(m[1]), lng = parseFloat(m[2]); if (valid(lat, lng)) return { lat, lng }; }

  m = LAT_LON_RE.exec(text);
  if (m) { const lat = parseFloat(m[1]), lng = parseFloat(m[2]); if (valid(lat, lng)) return { lat, lng }; }

  m = NSEW_RE.exec(text);
  if (m) {
    const lat = m[1].toUpperCase() === 'S' ? -parseFloat(m[2]) : parseFloat(m[2]);
    const lng = m[3].toUpperCase() === 'W' ? -parseFloat(m[4]) : parseFloat(m[4]);
    if (valid(lat, lng)) return { lat, lng };
  }

  m = DMS_RE.exec(text);
  if (m) {
    const lat = dms(m[1], m[2], m[3], m[4].toUpperCase());
    const lng = dms(m[5], m[6], m[7], m[8].toUpperCase());
    if (valid(lat, lng)) return { lat, lng };
  }

  // No coordinates found — backend only extracts coords, geocoding is frontend's job
  return { lat: null, lng: null };
}

module.exports = { parseLocation };
