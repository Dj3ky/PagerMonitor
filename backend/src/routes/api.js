const express      = require('express');
const router       = express.Router();
const os           = require('os');
const path         = require('path');
const { execSync } = require('child_process');

const ROOT_DIR = path.join(__dirname, '../../..');

const { getDb, getHistory, searchMessages, getStats, getAliases, upsertAlias, deleteAlias,
        getGroups, getHighlightRules, getLastSeenId, setLastSeenId } = require('../services/database');
const { getStatus }      = require('../services/sdr');
const { getClientCount } = require('../services/websocket');
const { requireAuth, requireEditor } = require('../services/auth');
const { getPublicKey, saveSubscription, removeSubscription } = require('../services/webpush');
const { getFeedFilter, passesFeedFilter } = require('../services/config');

router.get('/history', requireAuth, (req, res) => {
  const limit  = Math.min(parseInt(req.query.limit || '200', 10), 1000);
  const before = parseInt(req.query.before || '0', 10); // load messages older than this id
  try {
    const db   = require('../services/database').getDb();
    // Fetch a larger batch then filter so we return close to `limit` rows even with aggressive filters.
    // Max over-fetch is capped at 2× limit to avoid scanning the whole table on empty filters.
    const fetchLimit = limit * 2;
    const rows = before > 0
      ? db.prepare(`
          SELECT m.*, a.name as alias_name, a.color as alias_color, a.row_color as alias_row_color, a.row_sound as alias_row_sound,
                 g.id as group_id, g.name as group_name, g.color as group_color, g.row_color as group_row_color, g.row_sound as group_row_sound,
                 pg.name as parent_group_name, pg.color as parent_group_color, pg.row_color as parent_group_row_color, pg.row_sound as parent_group_row_sound,
                 (SELECT COUNT(*) FROM message_notes n WHERE n.message_id = m.id AND n.is_private = 0) as note_count
          FROM messages m
          LEFT JOIN aliases a  ON a.capcode = m.capcode
          LEFT JOIN groups  g  ON g.id = a.group_id
          LEFT JOIN groups  pg ON pg.id = g.parent_id
          WHERE m.id < ?
          ORDER BY m.id DESC LIMIT ?
        `).all(before, fetchLimit)
      : db.prepare(`
          SELECT m.*, a.name as alias_name, a.color as alias_color, a.row_color as alias_row_color, a.row_sound as alias_row_sound,
                 g.id as group_id, g.name as group_name, g.color as group_color, g.row_color as group_row_color, g.row_sound as group_row_sound,
                 pg.name as parent_group_name, pg.color as parent_group_color, pg.row_color as parent_group_row_color, pg.row_sound as parent_group_row_sound,
                 (SELECT COUNT(*) FROM message_notes n WHERE n.message_id = m.id AND n.is_private = 0) as note_count
          FROM messages m
          LEFT JOIN aliases a  ON a.capcode = m.capcode
          LEFT JOIN groups  g  ON g.id = a.group_id
          LEFT JOIN groups  pg ON pg.id = g.parent_id
          ORDER BY m.id DESC LIMIT ?
        `).all(fetchLimit);
    res.json(rows.filter(r => passesFeedFilter(r)).slice(0, limit));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/search', requireAuth, (req, res) => {
  const q = (req.query.q||'').trim();
  if (!q) return res.status(400).json({ error: 'q required' });
  try { res.json(searchMessages(q, Math.min(parseInt(req.query.limit||'100',10), 500))); }
  catch (e) { res.status(500).json({ error: 'Search failed' }); }
});

router.get('/status', requireAuth, (_req, res) => {
  const sdrDisabled = process.env.DISABLE_SDR === 'true';
  let sdrClients = null;
  if (sdrDisabled) {
    try {
      sdrClients = require('../services/clientTracker').getClients().map(c => ({
        id: c.id, online: c.online, freq: c.freq, protocols: c.protocols, silentSec: c.silentSec,
        sdrRunning: c.sdrRunning, gitHash: c.gitHash || null,
      }));
    } catch (_) { sdrClients = []; }
  }

  // Server's own git hash — used by status bar to show update availability
  let gitHash = null;
  try { gitHash = execSync('git rev-parse HEAD', { cwd: ROOT_DIR, timeout: 3000 }).toString().trim(); } catch (_) {}

  res.json({ ok: true, version: require('../../package.json').version, mode: process.env.MODE||'single',
    sdrDisabled, sdrClients, gitHash,
    uptime: process.uptime(), wsClients: getClientCount(),
    memory: process.memoryUsage(), loadAvg: os.loadavg(),
    freeMem: os.freemem(), totalMem: os.totalmem(), sdr: getStatus(), stats: getStats() });
});

router.get('/aliases', requireAuth, (_req, res) => res.json(getAliases()));
router.put('/aliases/:capcode', requireEditor, (req, res) => {
  const { name, color, notes, group_id } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  upsertAlias(req.params.capcode, name, color, notes, group_id);
  res.json({ ok: true });
});
router.delete('/aliases/:capcode', requireEditor, (req, res) => { deleteAlias(req.params.capcode); res.json({ ok: true }); });

router.get('/groups', requireAuth, (_req, res) => { try { res.json(getGroups()); } catch (e) { res.status(500).json({ error: e.message }); } });
router.get('/rules',  requireAuth, (_req, res) => { try { res.json(getHighlightRules()); } catch (e) { res.status(500).json({ error: e.message }); } });

// Feed filter — exposed so clients know when a filter is active (mode only, no sensitive data)
router.get('/feed-filter', requireAuth, (_req, res) => {
  try { res.json(getFeedFilter()); } catch (e) { res.status(500).json({ error: e.message }); }
});

// Messages with coordinates for the map view
router.get('/map', requireAuth, (req, res) => {
  try {
    const limit      = Math.min(parseInt(req.query.limit || '500', 10), 2000);
    const maxAgeDays = parseInt(req.query.maxAgeDays || '30', 10);
    const rows = getDb().prepare(`
      SELECT m.id, m.timestamp, m.capcode, m.message, m.protocol, m.lat, m.lng,
             a.name as alias_name, a.color as alias_color,
             g.name as group_name, g.color as group_color
      FROM messages m
      LEFT JOIN aliases a ON a.capcode = m.capcode
      LEFT JOIN groups  g ON g.id = a.group_id
      WHERE m.lat IS NOT NULL AND m.lng IS NOT NULL
        AND m.timestamp >= strftime('%Y-%m-%dT%H:%M:%SZ', datetime('now', '-' || ? || ' days'))
      ORDER BY m.id DESC LIMIT ?
    `).all(maxAgeDays, limit);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Save geocoded coordinates back to DB
router.post('/messages/:id/location', requireAuth, (req, res) => {
  try {
    const id  = parseInt(req.params.id, 10);
    const lat = parseFloat(req.body.lat);
    const lng = parseFloat(req.body.lng);
    if (!id || isNaN(lat) || isNaN(lng)) return res.status(400).json({ error: 'id, lat, lng required' });
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return res.status(400).json({ error: 'invalid coordinates' });
    getDb().prepare('UPDATE messages SET lat=?, lng=? WHERE id=?').run(lat, lng, id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Per-user last-seen tracking (requires auth token)
router.get('/last-seen', requireAuth, (req, res) => {
  try { res.json({ lastSeenId: getLastSeenId(req.session.userId) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/last-seen', requireAuth, (req, res) => {
  try {
    const id = parseInt(req.body.lastSeenId, 10);
    if (!id || isNaN(id)) return res.status(400).json({ error: 'lastSeenId required' });
    // Only advance — never let a stale/out-of-order request regress the pointer
    const current = getLastSeenId(req.session.userId);
    if (id > current) setLastSeenId(req.session.userId, id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Archive ───────────────────────────────────────────────────────────────────

// Build a capcode→group_id map from current aliases (used when feed filter is 'only_groups')
function buildGroupMap() {
  try {
    return Object.fromEntries(
      getDb().prepare(`
        SELECT a.capcode, g.id as group_id, pg.id as parent_group_id
        FROM aliases a
        LEFT JOIN groups g  ON g.id = a.group_id
        LEFT JOIN groups pg ON pg.id = g.parent_id
        WHERE a.group_id IS NOT NULL
      `).all().map(r => [r.capcode, r.group_id])
    );
  } catch (_) { return {}; }
}

// Enrich archive rows with group_id for filter compatibility, then apply feed filter
function filterArchiveRows(rows) {
  const filter = getFeedFilter();
  if (!filter || filter.mode === 'show_all') return rows;
  // For 'only_groups' mode archive rows need a live group lookup (not stored in archive)
  const groupMap = filter.mode === 'only_groups' ? buildGroupMap() : null;
  return rows.filter(r => {
    const enriched = groupMap ? { ...r, group_id: groupMap[r.capcode] ?? null } : r;
    return passesFeedFilter(enriched);
  });
}

router.get('/archive', requireAuth, (req, res) => {
  try {
    const { searchArchive, getArchiveHistory } = require('../services/archive');
    const q     = (req.query.q || '').trim();
    const limit = Math.min(parseInt(req.query.limit || '200', 10), 1000);
    const rows  = q ? searchArchive(q, limit * 2) : getArchiveHistory(limit * 2);
    res.json(filterArchiveRows(rows).slice(0, limit));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/archive/stats', requireAuth, (_req, res) => {
  try {
    const { getArchiveStats } = require('../services/archive');
    res.json(getArchiveStats());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Message notes ─────────────────────────────────────────────────────────────
const { getMessageNotes, addMessageNote, deleteMessageNote } = require('../services/database');

router.get('/messages/:id/notes', requireAuth, (req, res) => {
  try {
    const notes = getMessageNotes(parseInt(req.params.id), req.session.userId);
    res.json(notes);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/messages/:id/notes', requireAuth, (req, res) => {
  try {
    const { note, isPrivate } = req.body;
    if (!note?.trim()) return res.status(400).json({ error: 'note required' });
    const id = addMessageNote(
      parseInt(req.params.id),
      req.session.userId,
      req.session.username,
      note,
      !!isPrivate,
    );
    res.json({ ok: true, id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/notes/:id', requireAuth, (req, res) => {
  try {
    deleteMessageNote(parseInt(req.params.id), req.session.userId, req.session.role);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Archive CSV export
router.get('/archive/export', requireAuth, (req, res) => {
  try {
    const { getArchiveHistory, searchArchive } = require('../services/archive');
    const q    = (req.query.q || '').trim();
    const rows = filterArchiveRows(q ? searchArchive(q, 10000) : getArchiveHistory(10000));

    const escape = v => v == null ? '' : `"${String(v).replace(/"/g, '""')}"`;
    const header = ['id','timestamp','capcode','alias','protocol','baud','funcbits','message','lat','lng'];
    const lines  = [
      header.join(','),
      ...rows.map(r => header.map(k => escape(r[k])).join(',')),
    ];

    const ts = new Date().toISOString().slice(0,10);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="pagermonitor-archive-${ts}.csv"`);
    res.send(lines.join('\r\n'));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Web Push ──────────────────────────────────────────────────────────────────

router.get('/push/vapid-public-key', (_req, res) => {
  const key = getPublicKey();
  if (!key) return res.status(503).json({ error: 'Push notifications not available' });
  res.json({ publicKey: key });
});

router.post('/push/subscribe', requireAuth, (req, res) => {
  try {
    const { endpoint, keys } = req.body;
    if (!endpoint || !keys?.p256dh || !keys?.auth)
      return res.status(400).json({ error: 'Invalid subscription' });
    saveSubscription(req.session.userId, { endpoint, keys });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/push/subscribe', requireAuth, (req, res) => {
  try {
    const { endpoint } = req.body;
    if (!endpoint) return res.status(400).json({ error: 'endpoint required' });
    removeSubscription(endpoint);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
