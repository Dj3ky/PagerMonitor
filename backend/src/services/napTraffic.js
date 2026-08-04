'use strict';
// NAP (National Access Point / b2b.nap.si) — Slovenian road traffic data: DARS/DRSI
// cameras today, with room to add road works / VMS / traffic-info feeds later since
// they all share the same B2B account. Credentials come from the `nap_config` setting
// (Admin → Traffic Data), falling back to NAP_B2B_USER/NAP_B2B_PASS env vars.
const logger = require('../utils/logger');
const { getSetting } = require('./database');

const CAMERAS_URL = 'https://b2b.nap.si/data/b2b.cameras.geojson';
const REFRESH_MS = 10 * 60 * 1000; // camera locations/URLs change rarely — poll gently

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

let cache = { cameras: { type: 'FeatureCollection', features: [] }, updatedAt: null };
let timer = null;

async function refreshCameras() {
  const creds = getCredentials();
  if (!creds) return; // not configured yet — leave cache empty
  const res = await fetch(CAMERAS_URL, { headers: authHeader(creds), signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const geojson = await res.json();
  cache = { cameras: geojson, updatedAt: new Date().toISOString() };
}

function start() {
  if (timer) return;
  const authenticated = !!getCredentials();
  logger.info(`NAP traffic data: ${authenticated ? 'starting' : 'no credentials configured, idle'}`);
  if (!authenticated) return;
  refreshCameras().catch(e => logger.warn(`NAP cameras initial refresh: ${e.message}`));
  timer = setInterval(() => refreshCameras().catch(e => logger.warn(`NAP cameras refresh: ${e.message}`)), REFRESH_MS);
}

function stop() { clearInterval(timer); timer = null; }

// Re-reads credentials and restarts the poll loop — call after saving new config.
function restart() { stop(); start(); }

function getCameras() { return cache.cameras; }
function getStatus() { return { configured: !!getCredentials(), updatedAt: cache.updatedAt }; }

module.exports = { start, stop, restart, getCameras, getStatus };
