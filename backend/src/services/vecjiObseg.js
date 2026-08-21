'use strict';
// SPIN "Večji obseg" (major-scope) events — a separate SPIN data type from the point
// interventions in interventions.js: a municipality-wide notice (usually storm-driven)
// with free text, shown on the real SPIN map as a purple-outlined area over the
// affected občina. Both source files are static JSON, unauthenticated, keyed by the
// same obcinaMID:
//   - assets/data/vecjiObseg.json          — current active messages per municipality
//   - assets/data/obcinaWTK{obcinaMID}.json — that municipality's boundary, as WKT
// Boundaries barely ever change, so each one is fetched once and cached forever.
const proj4 = require('proj4');
const { getDb, getSetting } = require('./database');
const logger = require('../utils/logger');

const FEED_HOST      = 'spin3.sos112.si';
const LIST_URL        = `https://${FEED_HOST}/javno/assets/data/vecjiObseg.json`;
const BOUNDARY_URL    = mid => `https://${FEED_HOST}/javno/assets/data/obcinaWTK${mid}.json`;
const REFRESH_MS      = 3 * 60 * 1000;  // broader/slower-moving than point interventions
const ACTIVE_WINDOW_MS = 10 * 60 * 1000; // >3x REFRESH_MS so one missed poll doesn't flicker it off

// The WKT coordinates turned out to be the *old* D48/GK survey grid (Bessel ellipsoid,
// "MGI 1901 / Slovene National Grid", EPSG:3912) rather than the newer D96/TM
// (EPSG:3794, GRS80) used by SMOK's water-station feed — same false easting/northing
// and central meridian as D96/TM, which is why treating it as D96/TM still produced a
// plausible-looking but wrong shape. Confirmed by comparing against OpenStreetMap's own
// Ilirska Bistrica boundary: this shift lands within ~10-70m of OSM's line at 5 points
// spread around the whole ring; the D96/TM (null-shift) assumption was off by 200-600m.
proj4.defs('EPSG:3912', '+proj=tmerc +lat_0=0 +lon_0=15 +k=0.9999 +x_0=500000 +y_0=-5000000 +ellps=bessel +towgs84=682,-203,480,0,0,0,0 +units=m +no_defs +type=crs');
const toWgs84 = proj4('EPSG:3912', 'EPSG:4326');

let tableReady = false;
function ensureTable() {
  if (tableReady) return;
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS obcina_boundaries (
      obcina_mid   INTEGER PRIMARY KEY,
      obcina_naziv TEXT,
      geometry     TEXT NOT NULL,
      fetched_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS vecji_obseg_messages (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      obcina_mid    INTEGER NOT NULL,
      obcina_naziv  TEXT,
      message_at    TEXT,
      besedilo      TEXT,
      first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at  TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(obcina_mid, message_at)
    );
    CREATE INDEX IF NOT EXISTS idx_vecji_obseg_mid ON vecji_obseg_messages(obcina_mid);
  `);
  tableReady = true;
}

function enabled() {
  const s = getSetting('site_settings', {});
  return s.geocodeCountry === 'si' && s.enableInterventions === true;
}

// ── WKT parsing ──────────────────────────────────────────────────────────────────
// Splits "A(...), B(...)" into ["A(...)", "B(...)"] respecting nested parens.
function splitTopLevel(str) {
  const parts = [];
  let depth = 0, start = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) { parts.push(str.slice(start, i)); start = i + 1; }
  }
  parts.push(str.slice(start));
  return parts.map(s => s.trim());
}

function stripOuterParens(str) {
  const s = str.trim();
  return s.slice(1, -1);
}

function parseRing(ringStr) {
  return ringStr.split(',').map(pt => pt.trim().split(/\s+/).map(Number));
}

function parsePolygonBody(body) {
  return splitTopLevel(stripOuterParens(body)).map(ring => parseRing(stripOuterParens(ring)));
}

// Normalizes POLYGON/MULTIPOLYGON WKT to a uniform shape: polygons -> rings -> [x,y]
// points, so callers never need to branch on which WKT type they got.
function parseWkt(wkt) {
  const trimmed = (wkt || '').trim();
  const body = trimmed.slice(trimmed.indexOf('('));
  if (trimmed.startsWith('MULTIPOLYGON')) {
    return splitTopLevel(stripOuterParens(body)).map(parsePolygonBody);
  }
  return [parsePolygonBody(body)];
}

// polygons -> rings -> [x,y] (D96/TM) becomes polygons -> rings -> [lat,lng] (WGS84)
function reprojectPolygons(polygons) {
  return polygons.map(rings => rings.map(ring => ring.map(([x, y]) => {
    const [lon, lat] = toWgs84.forward([x, y]);
    return [lat, lon];
  })));
}

// ── Refresh ──────────────────────────────────────────────────────────────────────
async function fetchJsonValue(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json())?.value;
}

async function refresh() {
  if (!enabled()) return;
  ensureTable();
  const db = getDb();

  const items = (await fetchJsonValue(LIST_URL)) || [];

  const upsertMessage = db.prepare(`
    INSERT INTO vecji_obseg_messages (obcina_mid, obcina_naziv, message_at, besedilo, last_seen_at)
    VALUES (@mid, @naziv, @messageAt, @besedilo, datetime('now'))
    ON CONFLICT(obcina_mid, message_at) DO UPDATE SET
      obcina_naziv = excluded.obcina_naziv, besedilo = excluded.besedilo, last_seen_at = datetime('now')
  `);
  const upsertMany = db.transaction(rows => { for (const r of rows) upsertMessage.run(r); });
  upsertMany(items.flatMap(item => (item.besediloList || []).map(b => ({
    mid: item.obcinaMID, naziv: item.obcinaNaziv, messageAt: b.datum, besedilo: b.besedilo,
  }))));

  // Fetch + cache boundaries for any municipality we haven't seen before.
  const known = new Set(db.prepare(`SELECT obcina_mid FROM obcina_boundaries`).all().map(r => r.obcina_mid));
  const insertBoundary = db.prepare(`
    INSERT OR IGNORE INTO obcina_boundaries (obcina_mid, obcina_naziv, geometry) VALUES (?, ?, ?)
  `);
  const newMids = [...new Set(items.map(i => i.obcinaMID))].filter(mid => !known.has(mid));
  for (const mid of newMids) {
    const item = items.find(i => i.obcinaMID === mid);
    try {
      const wkt = await fetchJsonValue(BOUNDARY_URL(mid));
      const geometry = reprojectPolygons(parseWkt(wkt));
      insertBoundary.run(mid, item?.obcinaNaziv ?? null, JSON.stringify(geometry));
    } catch (e) { logger.warn(`Večji obseg boundary fetch ${mid}: ${e.message}`); }
  }
}

// ── Query ────────────────────────────────────────────────────────────────────────
function getActive() {
  ensureTable();
  const messages = getDb().prepare(`
    SELECT obcina_mid, obcina_naziv, message_at, besedilo FROM vecji_obseg_messages
    WHERE last_seen_at >= datetime('now', ?)
    ORDER BY obcina_mid, message_at DESC
  `).all(`-${ACTIVE_WINDOW_MS / 1000} seconds`);
  if (!messages.length) return [];

  const mids = [...new Set(messages.map(m => m.obcina_mid))];
  const boundaries = new Map(getDb().prepare(`
    SELECT obcina_mid, geometry FROM obcina_boundaries WHERE obcina_mid IN (${mids.map(() => '?').join(',')})
  `).all(...mids).map(r => [r.obcina_mid, JSON.parse(r.geometry)]));

  const byMunicipality = new Map();
  for (const m of messages) {
    if (!byMunicipality.has(m.obcina_mid)) {
      byMunicipality.set(m.obcina_mid, {
        obcinaMid: m.obcina_mid, obcinaNaziv: m.obcina_naziv,
        messages: [], boundary: boundaries.get(m.obcina_mid) || null,
      });
    }
    byMunicipality.get(m.obcina_mid).messages.push({ messageAt: m.message_at, besedilo: m.besedilo });
  }
  return [...byMunicipality.values()];
}

// All messages ever seen (not just currently-active ones) — searchable history for
// the Arhiv "Večji obseg" view. Rows are never deleted from vecji_obseg_messages, so
// this is the full record.
function getHistory({ limit = 50, offset = 0, municipality, q, from, to } = {}) {
  ensureTable();
  const where  = [];
  const params = {};
  if (municipality) { where.push('obcina_naziv = @municipality'); params.municipality = municipality; }
  if (from)         { where.push('message_at >= @from');          params.from = from; }
  if (to)           { where.push('message_at <= @to');            params.to = to; }
  if (q)            { where.push('(besedilo LIKE @q OR obcina_naziv LIKE @q)'); params.q = `%${q}%`; }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = getDb().prepare(`SELECT COUNT(*) AS n FROM vecji_obseg_messages ${whereSql}`).get(params).n;

  params.limit  = Math.min(Math.max(parseInt(limit, 10)  || 50, 1), 200);
  params.offset = Math.max(parseInt(offset, 10) || 0, 0);
  const rows = getDb().prepare(`
    SELECT obcina_mid, obcina_naziv, message_at, besedilo FROM vecji_obseg_messages
    ${whereSql} ORDER BY message_at DESC LIMIT @limit OFFSET @offset
  `).all(params);

  return { rows, total };
}

let timer = null;
function start() {
  if (timer) return;
  ensureTable();
  refresh().catch(e => logger.warn(`Večji obseg initial refresh: ${e.message}`));
  timer = setInterval(() => refresh().catch(e => logger.warn(`Večji obseg refresh: ${e.message}`)), REFRESH_MS);
}
function stop() { clearInterval(timer); timer = null; }

module.exports = { start, stop, getActive, getHistory };
