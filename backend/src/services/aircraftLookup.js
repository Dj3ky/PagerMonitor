'use strict';
// Registration → ICAO24 hex lookup, so a user only has to type a tail number ("S5-BZR")
// and we can resolve the hex code OpenSky's states/all endpoint actually matches on.
// Two free, keyless sources chained since neither has full coverage on its own — small
// state/military/firefighting fleets in particular are often missing from one but not the
// other (e.g. adsbdb has no record of Slovenia's Fire Boss fleet at all; hexdb.io has half
// of it). adsbdb tried first since it also returns manufacturer/type in one call.
const logger = require('../utils/logger');

const ADSBDB_URL = 'https://api.adsbdb.com/v0/aircraft/';
const HEXDB_REG_HEX_URL  = 'https://hexdb.io/reg-hex?reg=';
const HEXDB_AIRCRAFT_URL = 'https://hexdb.io/api/v1/aircraft/';

async function lookupViaAdsbdb(registration) {
  const res = await fetch(ADSBDB_URL + encodeURIComponent(registration), { signal: AbortSignal.timeout(10000) });
  if (!res.ok) return null;
  const data = await res.json();
  const a = data?.response?.aircraft;
  if (!a?.mode_s) return null;
  return {
    icao24: String(a.mode_s).toLowerCase(),
    type: a.icao_type || a.type || null,
    manufacturer: a.manufacturer || null,
  };
}

// hexdb.io's forward lookup (reg → hex) only returns a plain-text hex, so a second call
// against its reverse endpoint fills in type/manufacturer for that hex when available.
async function lookupViaHexdb(registration) {
  const res = await fetch(HEXDB_REG_HEX_URL + encodeURIComponent(registration), { signal: AbortSignal.timeout(10000) });
  if (!res.ok) return null;
  const hex = (await res.text()).trim();
  if (!hex || hex.toLowerCase() === 'n/a' || !/^[0-9a-fA-F]{6}$/.test(hex)) return null;

  let type = null, manufacturer = null;
  try {
    const infoRes = await fetch(HEXDB_AIRCRAFT_URL + encodeURIComponent(hex), { signal: AbortSignal.timeout(10000) });
    if (infoRes.ok) {
      const info = await infoRes.json();
      type = info?.ICAOTypeCode || info?.Type || null;
      manufacturer = info?.Manufacturer || null;
    }
  } catch (_) { /* hex is still usable even if this enrichment call fails */ }

  return { icao24: hex.toLowerCase(), type, manufacturer };
}

async function lookupByRegistration(registration) {
  try {
    const viaAdsbdb = await lookupViaAdsbdb(registration);
    if (viaAdsbdb) return viaAdsbdb;
  } catch (e) {
    logger.warn(`aircraftLookup (adsbdb): ${registration}: ${e.message}`);
  }
  try {
    const viaHexdb = await lookupViaHexdb(registration);
    if (viaHexdb) return viaHexdb;
  } catch (e) {
    logger.warn(`aircraftLookup (hexdb): ${registration}: ${e.message}`);
  }
  return null;
}

module.exports = { lookupByRegistration };
