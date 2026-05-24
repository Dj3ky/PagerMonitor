const express = require('express');
const router  = express.Router();
const os      = require('os');
const { execSync, spawn } = require('child_process');
const { version } = require('../../package.json');

const { requireAdmin, requireEditor } = require('../services/auth');
const { startSdrPipeline, stopSdrPipeline, restartSdrPipeline, getStatus, getLogs } = require('../services/sdr');
const { getDb, getStats, getMessageStats,
        getGroups, createGroup, updateGroup, deleteGroup,
        getAliases, upsertAlias, deleteAlias, bulkUpsertAliases,
        getHighlightRules, upsertHighlightRule, deleteHighlightRule,
        getKeywordAlerts, upsertKeywordAlert, deleteKeywordAlert,
        getWebhooks, upsertWebhook, deleteWebhook,
        addAuditLog, getAuditLog,
        deleteMessage,
        getSetting: _gs, setSetting: _ss } = require('../services/database');
const { getConfig, updateConfig, testNotification } = require('../services/notifications');
const { getSdrConfig, saveSdrConfig, getDedupConfig, saveDedupConfig,
        getNotifFilter, saveNotifFilter, getDongleConfigs, saveDongleConfigs } = require('../services/config');
const { getClientCount } = require('../services/websocket');
const logger = require('../utils/logger');

// All admin routes require at least editor role by default
// Sensitive routes explicitly require requireAdmin below
router.use(requireEditor);

// Inline helper — use as middleware on admin-only routes
const adminOnly = (req, res, next) =>
  req.session?.role === 'admin' ? next() : res.status(403).json({ error: 'Admin access required' });

// ── SDR ───────────────────────────────────────────────────────────────────────
router.post('/sdr/start',   adminOnly, (req, res) => { startSdrPipeline();   addAuditLog(req.session?.username||'admin', 'sdr.start',   null); res.json({ ok: true }); });
router.post('/sdr/stop',    adminOnly, (req, res) => { stopSdrPipeline();    addAuditLog(req.session?.username||'admin', 'sdr.stop',    null); res.json({ ok: true }); });
router.post('/sdr/restart', adminOnly, (req, res) => { restartSdrPipeline(); addAuditLog(req.session?.username||'admin', 'sdr.restart', null); res.json({ ok: true }); });
router.get('/sdr/status',   adminOnly, (_req, res) => res.json(getStatus()));
router.get('/sdr/logs',     adminOnly, (_req, res) => res.json(getLogs()));
router.get('/sdr/config',   adminOnly, (_req, res) => res.json(getSdrConfig()));
router.post('/sdr/config',  adminOnly, (req, res)  => {
  try {
    saveSdrConfig(req.body); restartSdrPipeline();
    addAuditLog(req.session?.username||'admin', 'sdr.config', `freq=${req.body.RTL_FM_FREQ||'?'}`);
    res.json({ ok: true });
  }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Multi-dongle configs
router.get('/sdr/dongles',  adminOnly, (_req, res) => { try{ res.json(getDongleConfigs() || []); } catch(e){ res.status(500).json({error:e.message}); }});
router.put('/sdr/dongles',  adminOnly, (req, res)  => {
  try {
    const dongles = Array.isArray(req.body) ? req.body : [];
    saveDongleConfigs(dongles.length > 0 ? dongles : null);
    // Don't restart here — caller will restart after setting all configs
    addAuditLog(req.session?.username||'admin', 'sdr.dongles', `count=${dongles.length}`);
    res.json({ ok: true });
  } catch(e){ res.status(500).json({error:e.message}); }
});

// ── System ────────────────────────────────────────────────────────────────────
router.get('/system', adminOnly, (_req, res) => {
  let disk = null;
  try {
    const df = execSync("df -k / --output=size,used,avail 2>/dev/null | tail -1", { timeout: 3000 }).toString().trim();
    const [size, used, avail] = df.split(/\s+/).map(Number);
    disk = { total: size * 1024, used: used * 1024, avail: avail * 1024 };
  } catch (_) {}

  res.json({
    uptime: process.uptime(), memory: process.memoryUsage(),
    loadAvg: os.loadavg(), freeMem: os.freemem(), totalMem: os.totalmem(),
    platform: os.platform(), arch: os.arch(), cpus: os.cpus().length,
    hostname: os.hostname(), nodeVer: process.version,
    wsClients: getClientCount(), stats: getStats(),
    mode: process.env.MODE || 'single', version,
    disk,
  });
});

// ── DB tools ──────────────────────────────────────────────────────────────────
router.delete('/db/purge/all', adminOnly, (req, res) => {
  try {
    const db = getDb();
    db.exec('DELETE FROM messages_fts');
    db.exec('DELETE FROM messages');
    try { db.exec('VACUUM'); } catch (_) {}
    addAuditLog(req.session?.username||'admin', 'db.purge_all', 'all messages deleted');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/db/purge', adminOnly, (req, res) => {
  const days = parseInt(req.query.days || '30', 10);
  if (isNaN(days) || days < 1) return res.status(400).json({ error: 'days must be >=1' });
  try {
    const db = getDb();
    // Get IDs to delete first (for FTS cleanup)
    const toDelete = db.prepare(
      `SELECT id FROM messages WHERE timestamp < strftime('%Y-%m-%dT%H:%M:%SZ', datetime('now', '-' || ? || ' days'))`
    ).all(days).map(r => r.id);

    if (toDelete.length === 0) {
      return res.json({ ok: true, deleted: 0, days, note: 'No messages older than ' + days + ' days found' });
    }

    // Delete from FTS first, then messages
    const deleteFts = db.prepare('DELETE FROM messages_fts WHERE rowid = ?');
    const deleteMsg = db.prepare('DELETE FROM messages WHERE id = ?');
    const tx = db.transaction((ids) => {
      for (const id of ids) {
        deleteFts.run(id);
        deleteMsg.run(id);
      }
    });
    tx(toDelete);

    // Reclaim disk space
    try { db.exec('VACUUM'); } catch (_) {}

    res.json({ ok: true, deleted: toDelete.length, days });
    addAuditLog(req.session?.username||'admin', 'db.purge', `deleted=${toDelete.length} days=${days}`);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/messages/:id', adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
  try {
    deleteMessage(id);
    addAuditLog(req.session?.username||'admin', 'message.delete', `id=${id}`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/messages/:id/regeocode', adminOnly, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
  try {
    const row = getDb().prepare('SELECT message FROM messages WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ ok: false, reason: 'Message not found' });

    const cc = (_gs('site_settings', {}).geocodeCountry || 'si');
    const { parseLocation, geocodeAddress } = require('../utils/parseLocation');
    const loc = parseLocation(row.message, cc);
    if (!loc) return res.json({ ok: false, reason: 'No location candidates found' });
    if (loc.type === 'coords') {
      getDb().prepare('UPDATE messages SET lat=?, lng=? WHERE id=?').run(loc.lat, loc.lng, id);
      require('../services/websocket').broadcast({ type: 'message_location', id, lat: loc.lat, lng: loc.lng });
      addAuditLog(req.session?.username||'admin', 'message.regeocode', `id=${id} type=coords`);
      return res.json({ ok: true, lat: loc.lat, lng: loc.lng, query: loc.raw });
    }
    const result = await geocodeAddress(loc.candidates || [], cc, row.message);
    if (!result) return res.json({ ok: false, reason: 'Nominatim returned no results', query: loc.candidates[0] });
    getDb().prepare('UPDATE messages SET lat=?, lng=? WHERE id=?').run(result.lat, result.lng, id);
    require('../services/websocket').broadcast({ type: 'message_location', id, lat: result.lat, lng: result.lng });
    addAuditLog(req.session?.username||'admin', 'message.regeocode', `id=${id} q="${result.query}"`);
    res.json({ ok: true, lat: result.lat, lng: result.lng, query: result.query });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/db/export', adminOnly, (_req, res) => {
  try {
    const rows    = getDb().prepare('SELECT * FROM messages ORDER BY id ASC').all();
    const headers = ['id','timestamp','capcode','alias','protocol','baud','funcbits','message','raw'];
    const csv = [headers.join(','), ...rows.map(r => headers.map(h => `"${String(r[h]??'').replace(/"/g,'""')}"`).join(','))].join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="pagermonitor-${Date.now()}.csv"`);
    res.send('\uFEFF' + csv);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/db/stats', adminOnly, (_req, res) => {
  try {
    const db = getDb();
    const total    = db.prepare('SELECT COUNT(*) as n FROM messages').get();
    const today    = db.prepare("SELECT COUNT(*) as n FROM messages WHERE date(timestamp,'localtime')=date('now','localtime')").get();
    const lastHour = db.prepare("SELECT COUNT(*) as n FROM messages WHERE timestamp >= strftime('%Y-%m-%dT%H:%M:%SZ', datetime('now','-1 hour'))").get();
    const protocols = db.prepare('SELECT protocol, COUNT(*) as n FROM messages GROUP BY protocol ORDER BY n DESC').all();
    const topCodes  = db.prepare('SELECT capcode, COUNT(*) as n FROM messages GROUP BY capcode ORDER BY n DESC LIMIT 10').all();
    const dbSize    = db.prepare("SELECT page_count*page_size as size FROM pragma_page_count(), pragma_page_size()").get();
    res.json({ total: total.n, today: today.n, lastHour: lastHour.n, protocols, topCodes, dbSize: dbSize.size });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Notifications ─────────────────────────────────────────────────────────────
router.get('/notifications/config', adminOnly, (_req, res) => res.json(getConfig()));
router.put('/notifications/config', adminOnly, (req, res) => {
  try { updateConfig(req.body); addAuditLog(req.session?.username||'admin', 'notif.config', null); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/notifications/test/:service', adminOnly, async (req, res) => {
  try { await testNotification(req.params.service); addAuditLog(req.session?.username||'admin', 'notif.test', req.params.service); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// GET/PUT /admin/notifications/filter
router.get('/notifications/filter', adminOnly, (_req, res) => res.json(getNotifFilter()));
router.put('/notifications/filter', adminOnly, (req, res) => {
  try { saveNotifFilter(req.body); addAuditLog(req.session?.username||'admin', 'notif.filter', null); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Dedup ─────────────────────────────────────────────────────────────────────
router.get('/dedup', adminOnly, (_req, res) => res.json(getDedupConfig()));
router.put('/dedup', adminOnly, (req, res) => {
  try { saveDedupConfig(req.body); addAuditLog(req.session?.username||'admin', 'dedup.config', `enabled=${req.body.enabled}`); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Groups ────────────────────────────────────────────────────────────────────
router.get('/groups', (_req, res) => { try { res.json(getGroups()); } catch (e) { res.status(500).json({ error: e.message }); } });
router.post('/groups', (req, res) => {
  try {
    const { name, color, parent_id, row_color, row_sound } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    const id = createGroup(name, color, parent_id, row_color || null, row_sound || null);
    addAuditLog(req.session?.username||'admin', 'group.create', `name=${name}`);
    res.json({ ok: true, id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.put('/groups/:id', (req, res) => {
  try {
    const { name, color, parent_id, row_color, row_sound } = req.body;
    updateGroup(parseInt(req.params.id), name, color, parent_id, row_color || null, row_sound || null);
    addAuditLog(req.session?.username||'admin', 'group.update', `id=${req.params.id} name=${name}`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.delete('/groups/:id', (req, res) => {
  try {
    deleteGroup(parseInt(req.params.id));
    addAuditLog(req.session?.username||'admin', 'group.delete', `id=${req.params.id}`);
    res.json({ ok: true });
  }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Aliases (admin — with group_id support) ───────────────────────────────────
router.get('/aliases', (_req, res) => { try { res.json(getAliases()); } catch (e) { res.status(500).json({ error: e.message }); } });
router.put('/aliases/:capcode', (req, res) => {
  try {
    const { name, color, notes, group_id, row_color, row_sound } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    upsertAlias(req.params.capcode, name, color, notes, group_id, row_color || null, row_sound || null);
    addAuditLog(req.session?.username||'admin', 'alias.save', `capcode=${req.params.capcode} name=${name}`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.delete('/aliases/:capcode', (req, res) => {
  try {
    deleteAlias(req.params.capcode);
    addAuditLog(req.session?.username||'admin', 'alias.delete', `capcode=${req.params.capcode}`);
    res.json({ ok: true });
  }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Alias CSV export
router.get('/aliases/export', (_req, res) => {
  try {
    const aliases = getAliases();
    const csv = ['capcode,name,color,notes,group_id',
      ...aliases.map(a => `"${a.capcode}","${(a.name||'').replace(/"/g,'""')}","${a.color||''}","${(a.notes||'').replace(/"/g,'""')}","${a.group_id||''}"`),
    ].join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="aliases.csv"');
    res.send('\uFEFF' + csv);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Alias CSV import
router.post('/aliases/import', express.text({ type: 'text/csv', limit: '1mb' }), (req, res) => {
  try {
    const lines = req.body.replace(/\r/g, '').split('\n').filter(Boolean);
    const header = lines[0].toLowerCase();
    if (!header.includes('capcode')) return res.status(400).json({ error: 'CSV must have capcode column' });
    const cols = header.split(',').map(c => c.replace(/"/g,'').trim());
    const rows = [];
    for (const line of lines.slice(1)) {
      const vals = parseCsvLine(line);
      const row  = {};
      cols.forEach((c, i) => row[c] = (vals[i]||'').trim());
      if (row.capcode) rows.push({ capcode: row.capcode, name: row.name||row.capcode, color: row.color||'#4ade80', notes: row.notes||'' });
    }
    bulkUpsertAliases(rows);
    res.json({ ok: true, imported: rows.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Highlight rules ───────────────────────────────────────────────────────────
router.get('/rules',        (_req, res) => { try { res.json(getHighlightRules()); } catch (e) { res.status(500).json({ error: e.message }); } });
router.put('/rules',        (req, res)  => { try { const id = upsertHighlightRule(req.body); addAuditLog(req.session?.username||'admin', 'rule.save', `name=${req.body.name}`); res.json({ ok: true, id }); } catch (e) { res.status(500).json({ error: e.message }); } });
router.delete('/rules/:id', (req, res)  => { try { deleteHighlightRule(parseInt(req.params.id)); addAuditLog(req.session?.username||'admin', 'rule.delete', `id=${req.params.id}`); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); } });

function parseCsvLine(line) {
  const result = []; let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { inQ = !inQ; } else if (c === ',' && !inQ) { result.push(cur); cur = ''; } else cur += c;
  }
  result.push(cur);
  return result;
}

// ── Site settings ─────────────────────────────────────────────────────────────
router.get('/site-settings', adminOnly, (_req, res) => {
  try { res.json(_gs('site_settings', { siteName:'PagerMonitor', siteDescription:'Real-time pager decoder', newBadgeSeconds:10, mapDotColor:'#00ff9d', showMapButton:true, mapMaxAgeDays:30, publicMode:false, geocodeCountry:'si' })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.put('/site-settings', adminOnly, (req, res) => {
  try {
    const { siteName, siteDescription, newBadgeSeconds, mapDotColor, showMapButton, mapMaxAgeDays, publicMode, geocodeCountry } = req.body;
    _ss('site_settings', {
      siteName: siteName || 'PagerMonitor', siteDescription: siteDescription || '',
      newBadgeSeconds: Math.max(3, Math.min(300, parseInt(newBadgeSeconds,10)||10)),
      mapDotColor: mapDotColor || '#00ff9d', showMapButton: showMapButton !== false,
      mapMaxAgeDays: Math.max(1, Math.min(365, parseInt(mapMaxAgeDays,10)||30)),
      publicMode: !!publicMode,
      geocodeCountry: /^[a-z]{2}$/.test(geocodeCountry) ? geocodeCountry : 'si',
    });
    addAuditLog(req.session?.username||'admin', 'site.settings', `publicMode=${!!publicMode}`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Geo data download (SSE) ───────────────────────────────────────────────────
// Streams stdout/stderr from fetchStreets.js + fetchPlaces.js back to the browser.
// Uses fetch()-streaming on the frontend (not EventSource) so Bearer auth works.
router.get('/geo-data/fetch', adminOnly, (req, res) => {
  const cc = /^[a-z]{2}$/.test(req.query.cc || '') ? req.query.cc : 'si';

  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();

  const send = obj => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`); };

  // Keepalive so the connection survives the ~60 s download window
  const hb = setInterval(() => { if (!res.writableEnded) res.write(': ping\n\n'); }, 20_000);
  req.on('close', () => clearInterval(hb));

  const scriptsDir = require('path').join(__dirname, '../../scripts');

  function runScript(file, onDone) {
    send({ type: 'log', text: `\n▶ ${file}\n` });
    const child = spawn('node', [require('path').join(scriptsDir, file), cc], {
      cwd: require('path').join(__dirname, '../../'),
    });
    child.stdout.on('data', d => send({ type: 'log', text: d.toString() }));
    child.stderr.on('data', d => send({ type: 'log', text: d.toString() }));
    child.on('close', code => {
      if (code !== 0) {
        send({ type: 'error', text: `${file} exited with code ${code}` });
        clearInterval(hb);
        res.end();
      } else {
        onDone();
      }
    });
    child.on('error', err => {
      send({ type: 'error', text: err.message });
      clearInterval(hb);
      res.end();
    });
  }

  runScript('fetchStreets.js', () => {
    runScript('fetchPlaces.js', () => {
      send({ type: 'done' });
      clearInterval(hb);
      res.end();
    });
  });

  addAuditLog(req.session?.username || 'admin', 'geo.fetch', `cc=${cc}`);
});

// ── Client key ────────────────────────────────────────────────────────────────
router.get('/client-key', adminOnly, (_req, res) => { try { res.json({ key: _gs('client_key','') }); } catch(e){ res.status(500).json({error:e.message}); }});
router.put('/client-key', adminOnly, (req, res) => {
  try {
    const { key } = req.body;
    if (!key || key.trim().length < 16) return res.status(400).json({ error: 'Key must be at least 16 characters' });
    _ss('client_key', key.trim()); res.json({ ok: true });
  } catch(e){ res.status(500).json({error:e.message}); }
});

// ── Keyword alerts ────────────────────────────────────────────────────────────
router.get('/keyword-alerts',        (_req,res) => { try{ res.json(getKeywordAlerts()); } catch(e){ res.status(500).json({error:e.message}); }});
router.put('/keyword-alerts',        (req,res)  => { try{ res.json({ok:true,id:upsertKeywordAlert(req.body)}); } catch(e){ res.status(500).json({error:e.message}); }});
router.delete('/keyword-alerts/:id', (req,res)  => { try{ deleteKeywordAlert(parseInt(req.params.id)); res.json({ok:true}); } catch(e){ res.status(500).json({error:e.message}); }});

// ── Dead air config ───────────────────────────────────────────────────────────
router.get('/dead-air', adminOnly, (_req,res) => { try{ res.json(_gs('dead_air_config',{enabled:false,thresholdHours:6})); } catch(e){ res.status(500).json({error:e.message}); }});
router.put('/dead-air', adminOnly, (req,res) => {
  try {
    const { enabled, thresholdHours } = req.body;
    _ss('dead_air_config', { enabled: !!enabled, thresholdHours: Math.max(1, Math.min(168, parseInt(thresholdHours,10)||6) )});
    res.json({ ok: true });
  } catch(e){ res.status(500).json({error:e.message}); }
});

// ── Webhooks ──────────────────────────────────────────────────────────────────
router.get('/webhooks', adminOnly,        (_req,res) => { try{ res.json(getWebhooks()); } catch(e){ res.status(500).json({error:e.message}); }});
router.put('/webhooks', adminOnly,        (req,res)  => { try{ res.json({ok:true,id:upsertWebhook(req.body)}); } catch(e){ res.status(500).json({error:e.message}); }});
router.delete('/webhooks/:id', adminOnly, (req,res)  => { try{ deleteWebhook(parseInt(req.params.id)); res.json({ok:true}); } catch(e){ res.status(500).json({error:e.message}); }});
router.post('/webhooks/:id/test', adminOnly, async (req,res) => {
  try {
    const hooks = getWebhooks().filter(h => h.id === parseInt(req.params.id,10));
    if (!hooks.length) return res.status(404).json({error:'Not found'});
    const { sendWebhooks } = require('../services/webhooks');
    await sendWebhooks({ type:'test', message:'PagerMonitor webhook test', timestamp: new Date().toISOString() });
    res.json({ ok: true });
  } catch(e){ res.status(500).json({error:e.message}); }
});

// ── Audit log ─────────────────────────────────────────────────────────────────
router.get('/audit-log', adminOnly, (req,res) => {
  try {
    const limit  = parseInt(req.query.limit || '200', 10);
    const filter = req.query.filter || ''; // e.g. "alias,group,rule"
    let rows = getAuditLog(limit);
    if (filter) {
      const prefixes = filter.split(',').map(s => s.trim()).filter(Boolean);
      rows = rows.filter(r => prefixes.some(p => r.action.startsWith(p)));
    }
    res.json(rows);
  } catch(e){ res.status(500).json({error:e.message}); }
});

// ── Message stats ─────────────────────────────────────────────────────────────
router.get('/stats', adminOnly, (_req,res) => {
  try{ res.json(getMessageStats()); } catch(e){ res.status(500).json({error:e.message}); }
});

// ── SDR Clients dashboard ─────────────────────────────────────────────────────
const { getClients, resetClient, getAllClientConfigs, saveClientConfig } = require('../services/clientTracker');

router.get('/sdr-clients', adminOnly, (_req, res) => {
  try { res.json(getClients()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/sdr-clients/:id', adminOnly, (req, res) => {
  try { resetClient(decodeURIComponent(req.params.id)); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Per-client remote config
router.get('/sdr-clients/configs', adminOnly, (_req, res) => {
  try { res.json(getAllClientConfigs()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/sdr-clients/:id/config', adminOnly, (req, res) => {
  try {
    const version = saveClientConfig(decodeURIComponent(req.params.id), req.body);
    res.json({ ok: true, version });
  }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Email config ──────────────────────────────────────────────────────────────
const { getEmailConfig, saveEmailConfig, testEmail } = require('../services/email');

router.get('/email/config', requireAdmin, (_req, res) => {
  try {
    const cfg = getEmailConfig();
    // Never send password over wire - mask it
    res.json({ ...cfg, password: cfg.password ? '••••••••' : '' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/email/config', requireAdmin, (req, res) => {
  try {
    const existing = getEmailConfig();
    const cfg = { ...existing, ...req.body };
    // If password is the masked placeholder, keep existing
    if (cfg.password === '••••••••') cfg.password = existing.password;
    saveEmailConfig(cfg);
    addAuditLog(req.session?.username||'admin', 'email.config', `host=${cfg.host}`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/email/test', requireAdmin, async (req, res) => {
  try {
    const { to } = req.body;
    if (!to) return res.status(400).json({ error: 'to email required' });
    await testEmail(to);
    addAuditLog(req.session?.username||'admin', 'email.test', `to=${to}`);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── Per-user notification prefs ───────────────────────────────────────────────
const { getAllUsersWithPrefs, getUserNotifPrefs, setUserNotifPrefs, updateUserEmail } = require('../services/database');

router.get('/user-notif-prefs', adminOnly, (_req, res) => {
  try { res.json(getAllUsersWithPrefs()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/user-notif-prefs/:userId', adminOnly, (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    setUserNotifPrefs(userId, req.body);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/users/:id/email', adminOnly, (req, res) => {
  try {
    updateUserEmail(parseInt(req.params.id), req.body.email);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Archive ───────────────────────────────────────────────────────────────────
const { archiveOldMessages, getArchiveStats } = require('../services/archive');

router.get('/archive/stats', adminOnly, (_req, res) => {
  try { res.json(getArchiveStats()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/archive/config', adminOnly, (_req, res) => {
  try { res.json(_gs('archive_config', { enabled: false, afterDays: 30 })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/archive/config', adminOnly, (req, res) => {
  try {
    const { enabled, afterDays } = req.body;
    _ss('archive_config', {
      enabled:    !!enabled,
      afterDays:  Math.max(1, Math.min(3650, parseInt(afterDays, 10) || 30)),
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/archive/run', adminOnly, (req, res) => {
  try {
    const cfg   = _gs('archive_config', { enabled: false, afterDays: 30 });
    const days  = parseInt(req.body.days, 10) || cfg.afterDays || 30;
    const count = archiveOldMessages(days);
    res.json({ ok: true, archived: count, days });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── AI Geocode ────────────────────────────────────────────────────────────────
const aiGeocode = require('../utils/aiGeocode');

router.get('/ai-geocode/config', adminOnly, (_req, res) => {
  try {
    const cfg = aiGeocode.getConfig();
    // Never send key values to the frontend — send only whether they are set and from where
    res.json({
      provider:        cfg.provider,
      groqKeySaved:    !!cfg.groqKey,
      groqKeySource:   process.env.GROQ_API_KEY   ? 'env' : (cfg.groqKey   ? 'db' : 'none'),
      groqModel:       cfg.groqModel,
      openaiKeySaved:  !!cfg.openaiKey,
      openaiKeySource: process.env.OPENAI_API_KEY ? 'env' : (cfg.openaiKey ? 'db' : 'none'),
      openaiModel:     cfg.openaiModel,
      ollamaUrl:       cfg.ollamaUrl,
      ollamaModel:     cfg.ollamaModel,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/ai-geocode/config', adminOnly, (req, res) => {
  try {
    aiGeocode.saveConfig(req.body);
    addAuditLog(req.session?.username || 'admin', 'ai_geocode.config', `provider=${req.body.provider}`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/ai-geocode/status', adminOnly, async (_req, res) => {
  try { res.json(await aiGeocode.checkStatus()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/ai-geocode/test', adminOnly, async (req, res) => {
  try {
    const text = (req.body.text || '').trim();
    if (!text) return res.status(400).json({ error: 'text is required' });
    const extracted = await aiGeocode.extractAddress(text);
    res.json({ ok: !!extracted?.street, extracted: extracted || null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;