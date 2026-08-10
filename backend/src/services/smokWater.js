'use strict';
// SMOK (Uprava RS za zascito in resevanje) river/water-level monitoring —
// station positions + status icon from a GeoJSON feed, per-station readings
// scraped from the same small HTML fragment SMOK's own map popup uses.
const proj4 = require('proj4');
const { getSetting } = require('./database');
const logger = require('../utils/logger');

const BASE = 'https://smok.sos112.si';
// Mirrors the exact filter the user asked for (skip stations with no reading).
const LIST_URL = `${BASE}/Voda/PostajaMap/POIs/?Alarm=True&Narasca=True&Pada=True&Ustaljen=True&Brez=False`;
const REFRESH_MS = 15 * 60 * 1000; // SMOK itself only updates ~every 30 min
const CONCURRENCY = 6;

// Station coordinates are in Slovenia's D96/TM grid (EPSG:3794), not lat/lon.
proj4.defs('EPSG:3794', '+proj=tmerc +lat_0=0 +lon_0=15 +k=0.9999 +x_0=500000 +y_0=-5000000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs');
const toWgs84 = proj4('EPSG:3794', 'EPSG:4326');

const STATUS_LABEL = { alarm: 'Alarm', rising: 'Rising', steady: 'Steady', falling: 'Falling', noData: 'No data', unknown: 'Unknown' };

function statusFromIcon(iconPath) {
  const file = (iconPath || '').split('/').pop().replace(/\.png$/i, '');
  if (/^a/i.test(file)) return 'alarm';
  if (file === 'b1') return 'rising';
  if (file === 'b2') return 'steady';
  if (file === 'b3') return 'falling';
  if (file === 'c') return 'noData';
  return 'unknown';
}

async function fetchJson(url, headers) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15000), headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchText(url, headers) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15000), headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// Slovenian number formatting uses ',' as the decimal separator and '.' for
// thousands, e.g. "17,026" -> 17.026, "1.234,5" -> 1234.5.
function parseSlNum(str) {
  if (str == null) return null;
  const cleaned = String(str).trim().replace(/\./g, '').replace(',', '.');
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

function extractField(html, label) {
  const re = new RegExp(`<b>${label}:</b>\\s*([\\-+\\d.,]+)[^(<]*(?:\\(\\s*&Delta;\\s*([\\-+\\d.,]+))?`, 'i');
  const m = html.match(re);
  if (!m) return { value: null, delta: null };
  return { value: parseSlNum(m[1]), delta: m[2] != null ? parseSlNum(m[2]) : null };
}

function parsePoiHtml(html) {
  const h1 = html.match(/<h1>([^<]*)<\/h1>/);
  const h2 = html.match(/<h2>([^<]*)<\/h2>/);
  const ad = html.match(/AD(\d+)\.png/);
  const as = html.match(/AS(\d+)\.png/);
  const age = html.match(/<b>Starost podatkov:<\/b>\s*([^(<]*)/i);

  const waterLevel = extractField(html, 'Vodostaj');
  const flow       = extractField(html, 'Pretok');
  const temp       = extractField(html, 'Temperatura');

  return {
    name:  h1 ? h1[1].trim() : null,
    river: h2 ? h2[1].trim() : null,
    waterLevelCm:      waterLevel.value,
    waterLevelDeltaCm: waterLevel.delta,
    flowM3s:           flow.value,
    flowDeltaM3s:      flow.delta,
    tempC:             temp.value,
    tempDeltaC:        temp.delta,
    dataAgeText:       age ? age[1].trim() : null,
    actualAlarmLevel:      ad ? parseInt(ad[1], 10) : null,
    statisticalAlarmLevel: as ? parseInt(as[1], 10) : null,
  };
}

async function fetchStationList() {
  const geo = await fetchJson(LIST_URL);
  return (geo.features || []).map(f => {
    const [x, y] = f.geometry.coordinates;
    const [lon, lat] = toWgs84.forward([x, y]);
    return {
      id:      f.properties.id,
      status:  statusFromIcon(f.properties.icon),
      statusLabel: STATUS_LABEL[statusFromIcon(f.properties.icon)],
      iconUrl: `${BASE}${f.properties.icon}`,
      lat, lon,
    };
  });
}

async function fetchStationDetail(id) {
  const html = await fetchText(`${BASE}/Voda/PostajaMap/POI/${id}`, {
    'X-Requested-With': 'XMLHttpRequest',
    'Referer': `${BASE}/Voda/PostajaMap/Map`,
  });
  return parsePoiHtml(html);
}

let cache = { stations: [], updatedAt: null };
let timer = null;

async function refresh() {
  if (getSetting('site_settings', {}).enableArsoWeather === false) return;
  const list = await fetchStationList();
  const stations = [];
  let idx = 0;
  async function worker() {
    while (idx < list.length) {
      const base = list[idx++];
      try {
        const detail = await fetchStationDetail(base.id);
        stations.push({ ...base, ...detail });
      } catch (e) {
        logger.warn(`SMOK station ${base.id}: ${e.message}`);
        stations.push(base); // still show the marker even if the detail fetch failed
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  cache = { stations, updatedAt: new Date().toISOString() };
}

function start() {
  if (timer) return;
  refresh().catch(e => logger.warn(`SMOK water initial refresh: ${e.message}`));
  timer = setInterval(() => refresh().catch(e => logger.warn(`SMOK water refresh: ${e.message}`)), REFRESH_MS);
}

function stop() { clearInterval(timer); timer = null; }

function getStations() { return cache; }

module.exports = { start, stop, getStations };
