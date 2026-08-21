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
const DETAIL_BATCH       = 40; // per tick — this hits the source's own per-id endpoint,
                                 // not the same one that's IP-gated, so a higher cap is fine
const GEOCODE_BATCH      = 10;
const RECHECK_WINDOW_MS  = 6 * 24 * 60 * 60 * 1000; // give up on missing narrative after 6 days
const RETRACT_GRACE_MS   = 5 * 60 * 1000; // >3x REFRESH_MS — delete still-unconfirmed rows that
                                            // vanish from the feed (SPIN retracting a false report),
                                            // once a single missed/slow poll can't explain the gap

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
      last_seen_at        TEXT,
      description_pending INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_interventions_reported     ON interventions(reported_at DESC);
    CREATE INDEX IF NOT EXISTS idx_interventions_municipality ON interventions(municipality);
    CREATE INDEX IF NOT EXISTS idx_interventions_type         ON interventions(intervention_type);
  `);
  const cols = getDb().prepare(`PRAGMA table_info(interventions)`).all().map(c => c.name);
  if (!cols.includes('last_seen_at')) {
    getDb().exec(`ALTER TABLE interventions ADD COLUMN last_seen_at TEXT`);
    // Backfill existing rows as "seen right now" — otherwise they'd sit at NULL forever
    // (an already-retracted row would never appear in a future poll to set a real
    // value) and the retraction-delete check in refresh() can never match a NULL
    // last_seen_at, so it'd never get cleaned up. This gives every pre-existing row one
    // real timestamp to age from: the next poll either re-confirms it or, if it's gone,
    // it correctly ages past the grace window and gets deleted on schedule.
    getDb().exec(`UPDATE interventions SET last_seen_at = datetime('now') WHERE last_seen_at IS NULL`);
  }
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
  //    new id gets a placeholder row; existing ones just get last_seen_at bumped
  //    (reported_at is set once and never overwritten) so step 5 below can tell a
  //    retracted report (vanished from the feed) from one that's just still active.
  const res = await fetch(RSS_URL, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`feed HTTP ${res.status}`);
  const parsed = xmlParser.parse(await res.text());
  const items = [].concat(parsed?.rss?.channel?.item || []).filter(Boolean);

  const upsertSeen = db.prepare(`
    INSERT INTO interventions (id, reported_at, last_seen_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET last_seen_at = datetime('now')
  `);
  const upsertMany = db.transaction(rows => { for (const r of rows) upsertSeen.run(r.id, r.reportedAt); });
  upsertMany(items.map(item => ({
    id: extractId(item.link),
    reportedAt: item.pubDate ? new Date(item.pubDate).toISOString() : null,
  })).filter(r => r.id));

  // 2. Fill in detail for rows still missing coordinates, or still waiting on a
  //    narrative within the recheck window. Rows still missing coordinates
  //    entirely (freshly-discovered placeholders — blank/"Other" until this
  //    fills in) are ordered ahead of narrative-only rechecks, so a burst of
  //    new ids can't starve the batch and leave them empty for longer than
  //    necessary.
  const needsDetail = db.prepare(`
    SELECT id FROM interventions
    WHERE lat IS NULL
       OR (description_pending = 1 AND first_seen_at > datetime('now', ?))
    ORDER BY (lat IS NULL) DESC, id DESC LIMIT ?
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

  // 5. Delete still-unconfirmed rows that have dropped out of the feed — SPIN
  //    retracting what turned out to be a false report, not a real event just
  //    aging past the feed's own window (confirmed rows are never touched here).
  //    last_seen_at IS NULL (not yet seen by this migration's upsert) never matches,
  //    so this can't wipe out pre-existing rows before they get a chance to be re-seen.
  db.prepare(`
    DELETE FROM interventions
    WHERE description_pending = 1 AND last_seen_at < datetime('now', ?)
  `).run(`-${RETRACT_GRACE_MS / 1000} seconds`);
}

// ── Query helpers (used by the API routes) ──────────────────────────────────────
// Returns { rows, total } — total is the full match count regardless of limit/offset,
// so callers (the archive search UI) can show "N of M" and paginate instead of
// silently truncating at the page size with no indication there's more.
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
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = getDb().prepare(`SELECT COUNT(*) AS n FROM interventions ${whereSql}`).get(params).n;

  params.limit  = Math.min(Math.max(parseInt(limit, 10)  || 50, 1), 400);
  params.offset = Math.max(parseInt(offset, 10) || 0, 0);
  const rows = getDb().prepare(`
    SELECT * FROM interventions ${whereSql}
    ORDER BY reported_at DESC LIMIT @limit OFFSET @offset
  `).all(params);

  return { rows, total };
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

function getDailyStats(days = 30) {
  ensureTable();
  return getDb().prepare(`
    SELECT date(reported_at) AS day, COUNT(*) AS n FROM interventions
    WHERE reported_at >= datetime('now', @window) GROUP BY day ORDER BY day
  `).all({ window: `-${days} days` });
}

function getTypeStats(days = 30) {
  ensureTable();
  return getDb().prepare(`
    SELECT intervention_type, COUNT(*) AS n FROM interventions
    WHERE reported_at >= datetime('now', @window) GROUP BY intervention_type ORDER BY n DESC
  `).all({ window: `-${days} days` });
}

let timer = null;
function start() {
  if (timer) return;
  ensureTable();
  refresh().catch(e => logger.warn(`Intervention feed initial refresh: ${e.message}`));
  timer = setInterval(() => refresh().catch(e => logger.warn(`Intervention feed refresh: ${e.message}`)), REFRESH_MS);
}
function stop() { clearInterval(timer); timer = null; }

module.exports = { start, stop, query, getMunicipalities, getTypes, getDailyStats, getTypeStats };
