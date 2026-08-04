'use strict';
// NAP (National Access Point / b2b.nap.si) — Slovenian road traffic data: DARS/DRSI
// cameras and road works today, with room to add VMS / traffic-info feeds later since
// they all share the same B2B account. Credentials come from the `nap_config` setting
// (Admin → Traffic Data), falling back to NAP_B2B_USER/NAP_B2B_PASS env vars.
const logger = require('../utils/logger');
const { getSetting } = require('./database');

const CAMERAS_URL   = 'https://b2b.nap.si/data/b2b.cameras.geojson';
const ROADWORKS_URL = 'https://b2b.nap.si/data/b2b.roadworks.geojson.sl_SI';

const CAMERAS_REFRESH_MS   = 10 * 60 * 1000; // camera locations/URLs change rarely — poll gently
const ROADWORKS_REFRESH_MS = 5  * 60 * 1000; // entries carry same-day end times — needs to stay current

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
let cache = {
  cameras:   { data: EMPTY_FC, updatedAt: null },
  roadworks: { data: EMPTY_FC, updatedAt: null },
};
let camerasTimer = null;
let roadworksTimer = null;

async function fetchGeojson(url) {
  const creds = getCredentials();
  if (!creds) return null; // not configured yet
  const res = await fetch(url, { headers: authHeader(creds), signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function refreshCameras() {
  const geojson = await fetchGeojson(CAMERAS_URL);
  if (!geojson) return;
  cache.cameras = { data: geojson, updatedAt: new Date().toISOString() };
}

async function refreshRoadworks() {
  const geojson = await fetchGeojson(ROADWORKS_URL);
  if (!geojson) return;
  cache.roadworks = { data: geojson, updatedAt: new Date().toISOString() };
}

function start() {
  if (camerasTimer || roadworksTimer) return;
  const authenticated = !!getCredentials();
  logger.info(`NAP traffic data: ${authenticated ? 'starting' : 'no credentials configured, idle'}`);
  if (!authenticated) return;

  refreshCameras().catch(e => logger.warn(`NAP cameras initial refresh: ${e.message}`));
  camerasTimer = setInterval(() => refreshCameras().catch(e => logger.warn(`NAP cameras refresh: ${e.message}`)), CAMERAS_REFRESH_MS);

  refreshRoadworks().catch(e => logger.warn(`NAP roadworks initial refresh: ${e.message}`));
  roadworksTimer = setInterval(() => refreshRoadworks().catch(e => logger.warn(`NAP roadworks refresh: ${e.message}`)), ROADWORKS_REFRESH_MS);
}

function stop() {
  clearInterval(camerasTimer); camerasTimer = null;
  clearInterval(roadworksTimer); roadworksTimer = null;
}

// Re-reads credentials and restarts the poll loops — call after saving new config.
function restart() { stop(); start(); }

function getStatus() {
  return {
    configured: !!getCredentials(),
    cameras:    { updatedAt: cache.cameras.updatedAt },
    roadworks:  { updatedAt: cache.roadworks.updatedAt },
  };
}

// GeoJSON plus updatedAt/configured tacked on — extra top-level fields are
// harmless to any GeoJSON consumer and let the frontend show staleness/setup state.
function getCamerasResponse() {
  return { ...cache.cameras.data, updatedAt: cache.cameras.updatedAt, configured: !!getCredentials() };
}
function getRoadworksResponse() {
  return { ...cache.roadworks.data, updatedAt: cache.roadworks.updatedAt, configured: !!getCredentials() };
}

module.exports = { start, stop, restart, getStatus, getCamerasResponse, getRoadworksResponse };
