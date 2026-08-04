'use strict';
// NAP (National Access Point / b2b.nap.si) — Slovenian road traffic data: DARS/DRSI
// cameras, road works and events today, with room to add VMS / traffic-info feeds
// later since they all share the same B2B account. Credentials come from the
// `nap_config` setting (Admin → Traffic Data), falling back to
// NAP_B2B_USER/NAP_B2B_PASS env vars.
const logger = require('../utils/logger');
const { getSetting } = require('./database');

const FEEDS = {
  cameras:   { url: 'https://b2b.nap.si/data/b2b.cameras.geojson',           refreshMs: 10 * 60 * 1000 }, // locations/URLs change rarely — poll gently
  roadworks: { url: 'https://b2b.nap.si/data/b2b.roadworks.geojson.sl_SI',   refreshMs: 5  * 60 * 1000 }, // entries carry same-day end times — needs to stay current
  events:    { url: 'https://b2b.nap.si/data/b2b.events.geojson.sl_SI',      refreshMs: 3  * 60 * 1000 }, // live incidents (accidents/congestion) — freshest of the three
};

function getCredentials() {
  const stored = getSetting('nap_config', null);
  if (stored && stored.username && stored.password) {
    return { username: stored.username, password: stored.password };
  }
  if (process.env.NAP_B2B_USER && process.env.NAP_B2B_PASS) {
    return { username: process.env.NAP_B2B_USER, password: process.env.NAP_B2B_PASS };
  }
  return null;
}

function authHeader(creds) {
  return { Authorization: `Basic ${Buffer.from(`${creds.username}:${creds.password}`).toString('base64')}` };
}

const EMPTY_FC = { type: 'FeatureCollection', features: [] };
const cache  = Object.fromEntries(Object.keys(FEEDS).map(k => [k, { data: EMPTY_FC, updatedAt: null }]));
const timers = Object.fromEntries(Object.keys(FEEDS).map(k => [k, null]));

async function refresh(key) {
  const creds = getCredentials();
  if (!creds) return; // not configured yet
  const res = await fetch(FEEDS[key].url, { headers: authHeader(creds), signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const geojson = await res.json();
  cache[key] = { data: geojson, updatedAt: new Date().toISOString() };
}

function start() {
  if (Object.values(timers).some(Boolean)) return;
  const authenticated = !!getCredentials();
  logger.info(`NAP traffic data: ${authenticated ? 'starting' : 'no credentials configured, idle'}`);
  if (!authenticated) return;

  for (const key of Object.keys(FEEDS)) {
    refresh(key).catch(e => logger.warn(`NAP ${key} initial refresh: ${e.message}`));
    timers[key] = setInterval(() => refresh(key).catch(e => logger.warn(`NAP ${key} refresh: ${e.message}`)), FEEDS[key].refreshMs);
  }
}

function stop() {
  for (const key of Object.keys(timers)) { clearInterval(timers[key]); timers[key] = null; }
}

// Re-reads credentials and restarts the poll loops — call after saving new config.
function restart() { stop(); start(); }

function getStatus() {
  return {
    configured: !!getCredentials(),
    ...Object.fromEntries(Object.keys(FEEDS).map(k => [k, { updatedAt: cache[k].updatedAt }])),
  };
}

// GeoJSON plus updatedAt/configured tacked on — extra top-level fields are
// harmless to any GeoJSON consumer and let the frontend show staleness/setup state.
function getResponse(key) {
  return { ...cache[key].data, updatedAt: cache[key].updatedAt, configured: !!getCredentials() };
}
const getCamerasResponse   = () => getResponse('cameras');
const getRoadworksResponse = () => getResponse('roadworks');
const getEventsResponse    = () => getResponse('events');

module.exports = { start, stop, restart, getStatus, getCamerasResponse, getRoadworksResponse, getEventsResponse };
