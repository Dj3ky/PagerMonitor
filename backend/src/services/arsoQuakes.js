'use strict';
// ARSO seismology — recent earthquakes in and around Slovenia.
const { getSetting } = require('./database');
const logger = require('../utils/logger');

const URL = 'https://potresi.arso.gov.si/sc/potresi/public';
const REFRESH_MS = 10 * 60 * 1000;

function magColor(m) {
  if (m == null) return '#8b949e';
  if (m < 2) return '#3fb950';
  if (m < 4) return '#d29922';
  if (m < 5) return '#f0883e';
  return '#f85149';
}

let cache = { quakes: [], updatedAt: null };
let timer = null;

async function refresh() {
  if (getSetting('site_settings', {}).enableArsoWeather === false) return;
  const res = await fetch(URL, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const raw = await res.json();
  const quakes = raw
    .map(q => ({
      id:          q.OBJECTID,
      time:        q.TIME,
      lat:         q.LAT,
      lon:         q.LON,
      depthKm:     q.DEPTH,
      magnitude:   q.MAG1,
      color:       magColor(q.MAG1),
      stations:    q.NSTA,
      location:    q.GEOLOC,
      intensity:   q.INTENZITETA,
      felt:        q.FELT === 1,
      reportCount: q.ZAZNALI,
    }))
    .sort((a, b) => new Date(b.time) - new Date(a.time));
  cache = { quakes, updatedAt: new Date().toISOString() };
}

function start() {
  if (timer) return;
  refresh().catch(e => logger.warn(`ARSO quakes initial refresh: ${e.message}`));
  timer = setInterval(() => refresh().catch(e => logger.warn(`ARSO quakes refresh: ${e.message}`)), REFRESH_MS);
}

function stop() { clearInterval(timer); timer = null; }

function getQuakes() { return cache; }

module.exports = { start, stop, getQuakes };
