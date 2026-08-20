'use strict';
// OpenSky Network — live tracking of user-added aircraft registrations (Admin/Airplanes
// page → "tracked_aircraft" table). Credentials come from the `opensky_config` setting
// (Admin → Aircraft Tracking), falling back to OPENSKY_CLIENT_ID/OPENSKY_CLIENT_SECRET env
// vars. With credentials (OAuth2 client-credentials, Standard tier: 4000 credits/day) we
// poll every 90s; without them we fall back to anonymous access (400 credits/day) and poll
// every 15 minutes. We query by icao24 (worldwide, no bounding box) so tracked planes work
// anywhere — OpenSky's docs put an unbounded query at the top credit tier per call, so these
// intervals are conservative estimates; watch for 429s if that assumption is off.
const logger = require('../utils/logger');
const { getSetting, getAllTrackedAircraft, updateTrackedAircraftIcao24 } = require('./database');
const { lookupByRegistration } = require('./aircraftLookup');

const TOKEN_URL  = 'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';
const STATES_BASE_URL = 'https://opensky-network.org/api/states/all';

const AUTHENTICATED_REFRESH_MS = 90 * 1000;
const ANONYMOUS_REFRESH_MS     = 15 * 60 * 1000;

// Don't retry a registration lookup more than once per this window — a persistently
// unmatched registration (typo, obscure aircraft not in adsbdb) shouldn't hammer the API.
const LOOKUP_RETRY_MS = 10 * 60 * 1000;
const lastLookupAttempt = new Map(); // tracked_aircraft.id -> timestamp

function getCredentials() {
  const stored = getSetting('opensky_config', null);
  if (stored && stored.clientId && stored.clientSecret) {
    return { clientId: stored.clientId, clientSecret: stored.clientSecret };
  }
  if (process.env.OPENSKY_CLIENT_ID && process.env.OPENSKY_CLIENT_SECRET) {
    return { clientId: process.env.OPENSKY_CLIENT_ID, clientSecret: process.env.OPENSKY_CLIENT_SECRET };
  }
  return null;
}

let token = null; // { clientId, value, expiresAt }

async function getToken(creds) {
  if (token && token.clientId === creds.clientId && token.expiresAt > Date.now() + 5000) return token.value;
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`OpenSky token HTTP ${res.status}`);
  const data = await res.json();
  token = { clientId: creds.clientId, value: data.access_token, expiresAt: Date.now() + (data.expires_in || 1800) * 1000 };
  return token.value;
}

// Tokens expire after 30 min; on a stale-token 401 we clear the cache and retry once.
async function fetchStates(creds, url) {
  const headers = creds ? { Authorization: `Bearer ${await getToken(creds)}` } : {};
  let res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
  if (res.status === 401 && creds) {
    token = null;
    res = await fetch(url, { headers: { Authorization: `Bearer ${await getToken(creds)}` }, signal: AbortSignal.timeout(15000) });
  }
  return res;
}

// Flown path per aircraft, shown when its marker is clicked on the frontend.
const MAX_TRACK_POINTS  = 500;
const TRACK_GAP_RESET_MS = 30 * 60 * 1000; // gap this long = new sortie, don't draw a line across it

function emptyAircraft(row) {
  return {
    id: row.id, orgId: row.org_id, reg: row.registration, icao24: row.icao24 || null,
    lat: null, lon: null, altitude: null, velocity: null, heading: null,
    onGround: null, live: false, lastSeen: null, track: [],
  };
}

let cache = { aircraft: [], updatedAt: null };
let timer = null;

// Fills in missing icao24 and/or missing description for rows that lack either (throttled
// per-row). A row that already has BOTH is left untouched — in particular this never
// overwrites a manually-entered icao24 or a hand-typed description, only fills gaps.
async function resolveMissingIcao24(rows) {
  const now = Date.now();
  const candidates = rows.filter(r => (!r.icao24 || !r.aircraft_type) && (now - (lastLookupAttempt.get(r.id) || 0)) > LOOKUP_RETRY_MS);
  for (const row of candidates) {
    lastLookupAttempt.set(row.id, now);
    const info = await lookupByRegistration(row.registration);
    if (info?.icao24) {
      const icao24 = row.icao24 || info.icao24;
      const aircraft_type = row.aircraft_type || info.type;
      const manufacturer = row.manufacturer || info.manufacturer;
      updateTrackedAircraftIcao24(row.id, { icao24, aircraft_type, manufacturer });
      row.icao24 = icao24;
      row.aircraft_type = aircraft_type;
      row.manufacturer = manufacturer;
    }
  }
}

async function refresh() {
  const s = getSetting('site_settings', {});
  if (s.enableAircraft !== true || s.geocodeCountry !== 'si') return;

  const rows = getAllTrackedAircraft().filter(r => r.enabled);
  await resolveMissingIcao24(rows);

  const now = new Date().toISOString();
  const prevById = new Map(cache.aircraft.map(a => [a.id, a]));
  const trackable = rows.filter(r => r.icao24);

  if (trackable.length === 0) {
    cache = { aircraft: rows.map(r => prevById.get(r.id) || emptyAircraft(r)), updatedAt: now };
    return;
  }

  const url = STATES_BASE_URL + '?' + trackable.map(r => `icao24=${encodeURIComponent(r.icao24)}`).join('&');
  const res = await fetchStates(getCredentials(), url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const raw = await res.json();
  const states = raw.states || [];
  const byIcao24 = new Map(states.map(st => [st[0], st]));

  cache = {
    aircraft: rows.map(row => {
      const prev = prevById.get(row.id) || emptyAircraft(row);
      if (!row.icao24) return { ...prev, reg: row.registration, live: false };
      const st = byIcao24.get(row.icao24);
      if (!st) return { ...prev, reg: row.registration, icao24: row.icao24, live: false };

      const lat = st[6], lon = st[5];
      let track = prev.track || [];
      const lastPoint = track[track.length - 1];
      if (lastPoint && Date.now() - new Date(lastPoint.time).getTime() > TRACK_GAP_RESET_MS) track = [];
      if (!lastPoint || lastPoint.lat !== lat || lastPoint.lon !== lon) {
        track = [...track, { lat, lon, time: now }].slice(-MAX_TRACK_POINTS);
      }

      return {
        id: row.id, orgId: row.org_id, reg: row.registration, icao24: row.icao24,
        lat, lon, altitude: st[7], onGround: st[8], velocity: st[9], heading: st[10],
        live: true, lastSeen: now, track,
      };
    }),
    updatedAt: now,
  };
}

function start() {
  if (timer) return;
  const authenticated = !!getCredentials();
  const intervalMs = authenticated ? AUTHENTICATED_REFRESH_MS : ANONYMOUS_REFRESH_MS;
  logger.info(`OpenSky aircraft tracking: ${authenticated ? 'authenticated' : 'anonymous'} access, polling every ${intervalMs / 1000}s`);
  refresh().catch(e => logger.warn(`OpenSky aircraft initial refresh: ${e.message}`));
  timer = setInterval(() => refresh().catch(e => logger.warn(`OpenSky aircraft refresh: ${e.message}`)), intervalMs);
}

function stop() { clearInterval(timer); timer = null; token = null; }

// Re-reads credentials and restarts the poll interval — call after saving new config.
function restart() { stop(); start(); }

// Fire-and-forget immediate refresh — call after a tracked_aircraft row changes so the
// UI doesn't have to wait out a full poll cycle to see the effect.
function refreshSoon() { refresh().catch(e => logger.warn(`OpenSky aircraft refresh: ${e.message}`)); }

function getAircraft(orgId) {
  return {
    aircraft: cache.aircraft.filter(a => a.orgId == null || a.orgId === orgId),
    updatedAt: cache.updatedAt,
  };
}

module.exports = { start, stop, restart, refreshSoon, getAircraft };
