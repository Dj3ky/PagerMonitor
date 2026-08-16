'use strict';
// Slovenia's national public-safety intervention feed (fires, traffic accidents,
// technical assistance, NUS finds, etc). There's no official public API for this,
// so this polls the same RSS feed the public map's own "RSS kanal" subscribe
// button generates, which unlike the bulk JSON endpoints isn't IP-gated. Each item
// only carries a bare id + short text, so every newly-seen id gets a follow-up
// detail fetch (also ungated) for coordinates and type, and — since dispatch often
// adds the full narrative some time after an incident is first listed — a bounded
// re-check window until it shows up or we give up. Slovenia-only: gated by
// geocodeCountry === 'si' + enableInterventions, same as ARSO/NAP/OpenSky.
const { XMLParser } = require('fast-xml-parser');
const { getDb, getSetting } = require('./database');
const { reverseGeocode } = require('../utils/parseLocation');
const logger = require('../utils/logger');

const FEED_HOST          = 'spin3.sos112.si';
const RSS_URL            = `https://${FEED_HOST}/javno/ODApi/true`;
const DETAIL_URL         = id => `https://${FEED_HOST}/api/javno/lokacija/${id}`;
const REFRESH_MS         = 90 * 1000;
const DETAIL_BATCH       = 15; // per tick — stay polite to the source
const GEOCODE_BATCH      = 10;
const RECHECK_WINDOW_MS  = 2 * 24 * 60 * 60 * 1000; // give up on missing narrative after 2 days

const xmlParser = new XMLParser({ ignoreAttributes: false });

let tableReady = false;
function ensureTable() {
  if (tableReady) return;
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS interventions (
      id                  INTEGER PRIMARY KEY,
      event_type          TEXT,
      intervention_type   TEXT,
      municipality        TEXT,
      lat                 REAL,
      lng                 REAL,
      address             TEXT,
      address_confidence  TEXT,
      description         TEXT,
      occurred_at         TEXT,
      reported_at         TEXT,
      first_seen_at       TEXT NOT NULL DEFAULT (datetime('now')),
      last_checked_at     TEXT,
      description_pending INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_interventions_reported     ON interventions(reported_at DESC);
    CREATE INDEX IF NOT EXISTS idx_interventions_municipality ON interventions(municipality);
    CREATE INDEX IF NOT EXISTS idx_interventions_type         ON interventions(intervention_type);
  `);
  tableReady = true;
}

function enabled() {
  const s = getSetting('site_settings', {});
  return s.geocodeCountry === 'si' && s.enableInterventions === true;
}

function extractId(link) {
  const m = /\/zemljevid\/(\d+)/.exec(link || '');
  return m ? parseInt(m[1], 10) : null;
}

async function refresh() {
  if (!enabled()) return;
  ensureTable();
  const db = getDb();

  // 1. Discover ids from the RSS feed — the only working "list" endpoint. Each
  //    new id gets a placeholder row; existing ones are left untouched here.
  const res = await fetch(RSS_URL, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`feed HTTP ${res.status}`);
  const parsed = xmlParser.parse(await res.text());
  const items = [].concat(parsed?.rss?.channel?.item || []).filter(Boolean);

  const insertPlaceholder = db.prepare(`INSERT OR IGNORE INTO interventions (id, reported_at) VALUES (?, ?)`);
  const insertMany = db.transaction(rows => { for (const r of rows) insertPlaceholder.run(r.id, r.reportedAt); });
  insertMany(items.map(item => ({
    id: extractId(item.link),
    reportedAt: item.pubDate ? new Date(item.pubDate).toISOString() : null,
  })).filter(r => r.id));

  // 2. Fill in detail for rows still missing coordinates, or still waiting on a
  //    narrative within the recheck window.
  const needsDetail = db.prepare(`
    SELECT id FROM interventions
    WHERE lat IS NULL
       OR (description_pending = 1 AND first_seen_at > datetime('now', ?))
    ORDER BY id DESC LIMIT ?
  `).all(`-${RECHECK_WINDOW_MS / 1000} seconds`, DETAIL_BATCH);

  const updateDetail = db.prepare(`
    UPDATE interventions SET
      event_type = ?, intervention_type = ?, municipality = ?,
      lat = ?, lng = ?, occurred_at = ?,
      description = CASE WHEN ? != '' THEN ? ELSE description END,
      description_pending = CASE WHEN ? != '' THEN 0 ELSE description_pending END,
      last_checked_at = datetime('now')
    WHERE id = ?
  `);
  for (const { id } of needsDetail) {
    try {
      const r = await fetch(DETAIL_URL(id), { signal: AbortSignal.timeout(10000) });
      if (!r.ok) continue;
      const v = (await r.json())?.value;
      if (!v) continue;
      const narrative = v.besedilo || '';
      updateDetail.run(
        v.dogodekNaziv ?? null, v.intervencijaVrstaNaziv ?? null, v.obcinaNaziv ?? null,
        v.wgsLatApprox ?? null, v.wgsLonApprox ?? null, v.nastanekCas ?? null,
        narrative, narrative, narrative,
        id,
      );
    } catch (e) { logger.warn(`Intervention detail fetch ${id}: ${e.message}`); }
  }

  // 3. Reverse-geocode anything that now has coordinates but no address yet.
  const needsGeocode = db.prepare(`
    SELECT id, lat, lng FROM interventions
    WHERE lat IS NOT NULL AND address IS NULL ORDER BY id DESC LIMIT ?
  `).all(GEOCODE_BATCH);
  const updateAddress = db.prepare(`UPDATE interventions SET address=?, address_confidence=? WHERE id=?`);
  for (const row of needsGeocode) {
    try {
      const g = await reverseGeocode(row.lat, row.lng);
      if (g) updateAddress.run(g.address, g.confidence || null, row.id);
    } catch (e) { logger.warn(`Intervention reverse-geocode ${row.id}: ${e.message}`); }
  }

  // 4. Stop re-checking anything past the recheck window.
  db.prepare(`
    UPDATE interventions SET description_pending = 0
    WHERE description_pending = 1 AND first_seen_at <= datetime('now', ?)
  `).run(`-${RECHECK_WINDOW_MS / 1000} seconds`);
}

// ── Query helpers (used by the API routes) ──────────────────────────────────────
function query({ limit = 50, offset = 0, municipality, type, q, from, to } = {}) {
  ensureTable();
  const where  = [];
  const params = {};
  if (municipality) { where.push('municipality = @municipality'); params.municipality = municipality; }
  if (type)         { where.push('intervention_type = @type');    params.type = type; }
  if (from)         { where.push('reported_at >= @from');         params.from = from; }
  if (to)           { where.push('reported_at <= @to');           params.to = to; }
  if (q)            {
    where.push('(description LIKE @q OR municipality LIKE @q OR address LIKE @q OR event_type LIKE @q)');
    params.q = `%${q}%`;
  }
  params.limit  = Math.min(Math.max(parseInt(limit, 10)  || 50, 1), 200);
  params.offset = Math.max(parseInt(offset, 10) || 0, 0);
  const sql = `
    SELECT * FROM interventions
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY reported_at DESC LIMIT @limit OFFSET @offset
  `;
  return getDb().prepare(sql).all(params);
}

function getMunicipalities() {
  ensureTable();
  return getDb().prepare(`
    SELECT DISTINCT municipality FROM interventions
    WHERE municipality IS NOT NULL ORDER BY municipality
  `).all().map(r => r.municipality);
}

function getTypes() {
  ensureTable();
  return getDb().prepare(`
    SELECT DISTINCT intervention_type FROM interventions
    WHERE intervention_type IS NOT NULL ORDER BY intervention_type
  `).all().map(r => r.intervention_type);
}

let timer = null;
function start() {
  if (timer) return;
  ensureTable();
  refresh().catch(e => logger.warn(`Intervention feed initial refresh: ${e.message}`));
  timer = setInterval(() => refresh().catch(e => logger.warn(`Intervention feed refresh: ${e.message}`)), REFRESH_MS);
}
function stop() { clearInterval(timer); timer = null; }

module.exports = { start, stop, query, getMunicipalities, getTypes };
