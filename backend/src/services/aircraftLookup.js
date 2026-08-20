'use strict';
// Registration → ICAO24 hex lookup, so a user only has to type a tail number ("S5-BZR")
// and we can resolve the hex code OpenSky's states/all endpoint actually matches on.
// adsbdb.com is free, keyless, and covers this well enough for our purposes.
const logger = require('../utils/logger');

const BASE_URL = 'https://api.adsbdb.com/v0/aircraft/';

async function lookupByRegistration(registration) {
  try {
    const res = await fetch(BASE_URL + encodeURIComponent(registration), { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const data = await res.json();
    const a = data?.response?.aircraft;
    if (!a?.mode_s) return null;
    return {
      icao24: String(a.mode_s).toLowerCase(),
      type: a.icao_type || a.type || null,
      manufacturer: a.manufacturer || null,
    };
  } catch (e) {
    logger.warn(`aircraftLookup: ${registration}: ${e.message}`);
    return null;
  }
}

module.exports = { lookupByRegistration };
