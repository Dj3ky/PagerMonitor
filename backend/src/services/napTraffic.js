'use strict';
// NAP (National Access Point / b2b.nap.si) — Slovenian road traffic data: DARS/DRSI
// cameras, road works, events and VMS (variable message signs) today, with room to
// add traffic-info feeds later since they all share the same B2B account.
// Credentials come from the `nap_config` setting (Admin → Traffic Data), falling
// back to NAP_B2B_USER/NAP_B2B_PASS env vars.
const logger = require('../utils/logger');
const { XMLParser } = require('fast-xml-parser');
const { getSetting } = require('./database');

// Simple JSON feeds — response body is used as-is.
const FEEDS = {
  cameras:   { url: 'https://b2b.nap.si/data/b2b.cameras.geojson',         refreshMs: 10 * 60 * 1000 }, // locations/URLs change rarely — poll gently
  roadworks: { url: 'https://b2b.nap.si/data/b2b.roadworks.geojson.sl_SI', refreshMs: 5  * 60 * 1000 }, // entries carry same-day end times — needs to stay current
  events:    { url: 'https://b2b.nap.si/data/b2b.events.geojson.sl_SI',    refreshMs: 3  * 60 * 1000 }, // live incidents (accidents/congestion) — freshest of the three
};

// VMS (variable message signs) — DATEX II XML, split across a near-static location
// table and a frequently-changing status feed, joined by controller id below.
const VMS_TABLE_URL    = 'https://b2b.nap.si/data/b2b.dars.vms.datexii3.table';
const VMS_STATUS_URL   = 'https://b2b.nap.si/data/b2b.dars.vms.datexii3.status';
const VMS_TABLE_REFRESH_MS  = 10 * 60 * 1000;
const VMS_STATUS_REFRESH_MS = 3  * 60 * 1000;

const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', removeNSPrefix: true });

// DATEX2's "index card" pattern nests a wrapper and content under the same tag
// name (e.g. <vms index="0"><vms>...</vms></vms>), and fast-xml-parser only
// produces an array when a tag repeats — a single sign/message parses as a bare
// object instead. Every access below goes through this so both cases work.
const arr = v => (v == null ? [] : Array.isArray(v) ? v : [v]);

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

async function fetchAuthed(url) {
  const creds = getCredentials();
  if (!creds) return null; // not configured yet
  const res = await fetch(url, { headers: authHeader(creds), signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res;
}

const EMPTY_FC = { type: 'FeatureCollection', features: [] };
const cache  = Object.fromEntries([...Object.keys(FEEDS), 'vms'].map(k => [k, { data: EMPTY_FC, updatedAt: null }]));
const timers = Object.fromEntries([...Object.keys(FEEDS), 'vmsTable', 'vmsStatus'].map(k => [k, null]));

// Feed URLs above are hardcoded to Slovenia's DARS/DRSI network — pointless for
// any other deployment, regardless of the enable toggle.
function trafficEnabled() {
  const s = getSetting('site_settings', {});
  return s.enableTraffic === true && s.geocodeCountry === 'si';
}

async function refresh(key) {
  if (!trafficEnabled()) return;
  const res = await fetchAuthed(FEEDS[key].url);
  if (!res) return;
  cache[key] = { data: await res.json(), updatedAt: new Date().toISOString() };
}

// ── VMS: parse + join ────────────────────────────────────────────────────────
function parseVmsTable(xml) {
  const root = xmlParser.parse(xml)?.VmsTablePublication;
  const controllers = arr(root?.vmsControllerTable?.vmsController);
  const locations = new Map();
  for (const c of controllers) {
    const id = c?.['@_id'];
    const loc = arr(c?.vms)[0]?.vms?.vmsLocation;
    const coords = loc?.coordinatesForDisplay;
    const lat = parseFloat(coords?.latitude), lon = parseFloat(coords?.longitude);
    if (!id || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const along = loc?.pointAlongLinearElement;
    const distanceAlong = along?.distanceAlongLinearElement?.distanceAlong;
    locations.set(id, {
      lat, lon,
      roadId: along?.linearElement?.linearElementIdentifier ?? null,
      distanceAlong: distanceAlong != null ? Number(distanceAlong) : null,
    });
  }
  return locations;
}

function parseVmsStatus(xml) {
  const root = xmlParser.parse(xml)?.VmsPublication;
  const controllerStatuses = arr(root?.vmsControllerStatus);
  const statuses = new Map();
  for (const s of controllerStatuses) {
    const id = s?.vmsControllerReference?.['@_id'];
    if (!id) continue;
    const images = [];
    for (const vs of arr(s.vmsStatus)) {
      for (const m of arr(vs?.vmsStatus?.vmsMessage)) {
        for (const da of arr(m?.vmsMessage?.displayAreaSettings)) {
          const url = da?.displayAreaSettings?.pictogramDisplayUrl;
          if (url) images.push(url); // text-only displays (no pictogram) are skipped
        }
      }
    }
    statuses.set(id, { updatedAt: s.statusUpdateTime || null, images });
  }
  return statuses;
}

let vmsLocations = new Map();
let vmsStatuses  = new Map();

function rebuildVms() {
  const features = [];
  for (const [id, loc] of vmsLocations) {
    const status = vmsStatuses.get(id);
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [loc.lon, loc.lat] },
      properties: {
        id, roadId: loc.roadId, distanceAlong: loc.distanceAlong,
        images: status?.images || [], updated: status?.updatedAt || null,
      },
    });
  }
  cache.vms = { data: { type: 'FeatureCollection', features }, updatedAt: new Date().toISOString() };
}

async function refreshVmsTable() {
  if (!trafficEnabled()) return;
  const res = await fetchAuthed(VMS_TABLE_URL);
  if (!res) return;
  vmsLocations = parseVmsTable(await res.text());
  rebuildVms();
}

async function refreshVmsStatus() {
  if (!trafficEnabled()) return;
  const res = await fetchAuthed(VMS_STATUS_URL);
  if (!res) return;
  vmsStatuses = parseVmsStatus(await res.text());
  rebuildVms();
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

  refreshVmsTable().catch(e => logger.warn(`NAP vms table initial refresh: ${e.message}`));
  timers.vmsTable = setInterval(() => refreshVmsTable().catch(e => logger.warn(`NAP vms table refresh: ${e.message}`)), VMS_TABLE_REFRESH_MS);
  refreshVmsStatus().catch(e => logger.warn(`NAP vms status initial refresh: ${e.message}`));
  timers.vmsStatus = setInterval(() => refreshVmsStatus().catch(e => logger.warn(`NAP vms status refresh: ${e.message}`)), VMS_STATUS_REFRESH_MS);
}

function stop() {
  for (const key of Object.keys(timers)) { clearInterval(timers[key]); timers[key] = null; }
}

// Re-reads credentials and restarts the poll loops — call after saving new config.
function restart() { stop(); start(); }

function getStatus() {
  return {
    configured: !!getCredentials(),
    ...Object.fromEntries(Object.keys(cache).map(k => [k, { updatedAt: cache[k].updatedAt }])),
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
const getVmsResponse       = () => getResponse('vms');

module.exports = {
  start, stop, restart, getStatus,
  getCamerasResponse, getRoadworksResponse, getEventsResponse, getVmsResponse,
};
