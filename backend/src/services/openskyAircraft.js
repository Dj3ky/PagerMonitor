'use strict';
// OpenSky Network — live tracking of Slovenia's AT-802 Fire Boss wildfire aircraft
// (S5-BZR/BZS/BZT/BZU). Credentials come from the `opensky_config` setting (Admin →
// Aircraft Tracking), falling back to OPENSKY_CLIENT_ID/OPENSKY_CLIENT_SECRET env
// vars. With credentials (OAuth2 client-credentials, Standard tier: 4000 credits/day)
// we poll every minute; without them we fall back to anonymous access (400
// credits/day) and poll every 5 minutes. Our bounding box is under 25 sq°, so each
// poll costs 1 credit either way.
const logger = require('../utils/logger');
const { getSetting } = require('./database');

const TOKEN_URL  = 'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';
const STATES_URL = 'https://opensky-network.org/api/states/all?lamin=45.3&lomin=13.2&lamax=47.0&lomax=16.7';

const AUTHENTICATED_REFRESH_MS = 60 * 1000;
const ANONYMOUS_REFRESH_MS     = 5 * 60 * 1000;

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
async function fetchStates(creds) {
  const headers = creds ? { Authorization: `Bearer ${await getToken(creds)}` } : {};
  let res = await fetch(STATES_URL, { headers, signal: AbortSignal.timeout(15000) });
  if (res.status === 401 && creds) {
    token = null;
    res = await fetch(STATES_URL, { headers: { Authorization: `Bearer ${await getToken(creds)}` }, signal: AbortSignal.timeout(15000) });
  }
  return res;
}

const KNOWN = [
  { reg: 'S5-BZR', callsign: 'S5BZR' },
  { reg: 'S5-BZS', callsign: 'S5BZS' },
  { reg: 'S5-BZT', callsign: 'S5BZT' },
  { reg: 'S5-BZU', callsign: 'S5BZU' },
];

function emptyAircraft(k) {
  return { ...k, icao24: null, lat: null, lon: null, altitude: null,
    velocity: null, heading: null, onGround: null, live: false, lastSeen: null };
}

let cache = { aircraft: KNOWN.map(emptyAircraft), updatedAt: null };
let timer = null;

async function refresh() {
  const res = await fetchStates(getCredentials());
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const raw = await res.json();
  const states = raw.states || [];

  const byCallsign = new Map();
  for (const s of states) {
    const cs = (s[1] || '').trim();
    if (cs) byCallsign.set(cs, s);
  }

  const now = new Date().toISOString();
  cache = {
    aircraft: KNOWN.map(k => {
      const s = byCallsign.get(k.callsign);
      if (!s) {
        const prev = cache.aircraft.find(a => a.callsign === k.callsign);
        return { ...(prev || emptyAircraft(k)), live: false };
      }
      return {
        ...k,
        icao24: s[0],
        lon: s[5],
        lat: s[6],
        altitude: s[7],
        onGround: s[8],
        velocity: s[9],
        heading: s[10],
        live: true,
        lastSeen: now,
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

function getAircraft() { return cache; }

module.exports = { start, stop, restart, getAircraft };
