const express = require('express');
const router  = express.Router();
const fs      = require('fs');
const os      = require('os');
const path    = require('path');
const { execSync, spawn } = require('child_process');
const { version } = require('../../package.json');

const { requireAdmin, requireEditor, requirePlatformAdmin } = require('../services/auth');
const { startSdrPipeline, stopSdrPipeline, restartSdrPipeline, getStatus, getLogs } = require('../services/sdr');
const { listAttachedDongles } = require('../services/rtlDevices');
const { getDb, getStats, getMessageStats,
        getGroups, createGroup, updateGroup, deleteGroup, deleteAllGroups, bulkUpsertGroups,
        getAliases, upsertAlias, deleteAlias, bulkUpsertAliases,
        getHighlightRules, upsertHighlightRule, deleteHighlightRule,
        getKeywordAlerts, upsertKeywordAlert, deleteKeywordAlert,
        getVoiceChannels, getAllVoiceChannels, upsertVoiceChannel, deleteVoiceChannel,
        getVoiceChannelHidden, setVoiceChannelHidden,
        getDiscordRelays, upsertDiscordRelay, deleteDiscordRelay,
        getWebhooks, upsertWebhook, deleteWebhook,
        addAuditLog, getAuditLog,
        deleteMessage, getUserLocations, getUserById,
        createOrganization, getOrganizations, renameOrganization, deleteOrganization,
        createInvite, listInvites, revokeInvite,
        getSetting: _gs, setSetting: _ss, normCapcode, getAliasNameForCapcode } = require('../services/database');
const { resolveAliasHome } = require('../utils/aliasPlace');
const { getConfig, updateConfig, testNotification } = require('../services/notifications');
const { getSdrConfig, saveSdrConfig, getDedupConfig, saveDedupConfig,
        getNotifFilter, saveNotifFilter, getDongleConfigs, saveDongleConfigs,
        getFeedFilter, saveFeedFilter,
        getMessageNormalizations, saveMessageNormalizations } = require('../services/config');
const { getClientCount } = require('../services/websocket');
const { unregisterSource } = require('../services/deadair');
const logger = require('../utils/logger');

// All admin routes require at least editor role by default
// Sensitive routes explicitly require requireAdmin/requirePlatformAdmin below
router.use(requireEditor);

// Org-tier admin (manages their own org's content/members) — role check only, the
// actual org boundary is enforced by every DB call below taking req.session.orgId.
const adminOnly = (req, res, next) =>
  req.session?.role === 'admin' ? next() : res.status(403).json({ error: 'Admin access required' });

// Platform tier (the app owner) — instance infrastructure + cross-org access.
// Re-validates the token itself (see services/auth.js), independent of the org role above.
const platformOnly = requirePlatformAdmin;

// A row a caller may write to global (org_id NULL) content: platform admin only,
// and only when explicitly requested (?global=1 or body.is_global) — everyone else
// always writes within their own org.
function effectiveOrgId(req) {
  const wantsGlobal = req.query.global === '1' || req.body?.is_global === true;
  return (req.session.isPlatformAdmin && wantsGlobal) ? null : req.session.orgId;
}

// ── SDR (instance infrastructure — the physical/decoder feed shared by every org) ──
router.post('/sdr/start',   platformOnly, (req, res) => { startSdrPipeline();   addAuditLog(req.session?.username||'admin', 'sdr.start',   null); res.json({ ok: true }); });
router.post('/sdr/stop',    platformOnly, (req, res) => { stopSdrPipeline();    addAuditLog(req.session?.username||'admin', 'sdr.stop',    null); res.json({ ok: true }); });
router.post('/sdr/restart', platformOnly, (req, res) => { restartSdrPipeline(); addAuditLog(req.session?.username||'admin', 'sdr.restart', null); res.json({ ok: true }); });
router.get('/sdr/status',   platformOnly, (_req, res) => res.json(getStatus()));
router.get('/sdr/logs',     platformOnly, (_req, res) => res.json(getLogs()));
router.get('/sdr/config',   platformOnly, (_req, res) => res.json(getSdrConfig()));
router.post('/sdr/config',  platformOnly, (req, res)  => {
  try {
    saveSdrConfig(req.body); restartSdrPipeline();
    addAuditLog(req.session?.username||'admin', 'sdr.config', `freq=${req.body.RTL_FM_FREQ||'?'}`);
    res.json({ ok: true });
  }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Turns findVoiceChannelConflicts' structured output into one readable sentence for the
// error toast — resolving channel ids/client ids to their display names so it actually
// says something actionable instead of "channel 3 conflicts with client a1b2c3".
function describeChannelConflicts(conflicts) {
  const { getVoiceChannelById } = require('../services/database');
  const { getClients } = require('../services/clientTracker');
  const clients = getClients();
  const clientLabel = id => clients.find(c => c.id === id)?.displayName || id;
  return conflicts.map(c => {
    const name = getVoiceChannelById(c.channelId)?.description || `channel ${c.channelId}`;
    if (c.duplicatedHere) return `"${name}" is assigned to more than one dongle in this save`;
    const where = c.owners.map(o => o.type === 'local' ? 'a local dongle' : `remote client "${clientLabel(o.clientId)}"`).join(', ');
    return `"${name}" is already assigned to ${where}`;
  }).join('; ');
}

// Multi-dongle configs
router.get('/sdr/dongles',  platformOnly, (_req, res) => { try{ res.json(getDongleConfigs() || []); } catch(e){ res.status(500).json({error:e.message}); }});
router.get('/sdr/detected-dongles', platformOnly, async (_req, res) => {
  try { res.json(await listAttachedDongles()); } catch(e){ res.status(500).json({error:e.message}); }
});
router.put('/sdr/dongles',  platformOnly, (req, res)  => {
  try {
    const dongles = Array.isArray(req.body) ? req.body : [];
    const conflicts = require('../services/audioRelay').findVoiceChannelConflicts(dongles, { type: 'local' });
    if (conflicts.length > 0) {
      return res.status(409).json({ error: describeChannelConflicts(conflicts), conflicts });
    }
    saveDongleConfigs(dongles.length > 0 ? dongles : null);
    // Don't restart here — caller will restart after setting all configs
    addAuditLog(req.session?.username||'admin', 'sdr.dongles', `count=${dongles.length}`);
    require('../services/websocket').broadcast({ type: 'voice_channels_changed' });
    res.json({ ok: true });
  } catch(e){ res.status(500).json({error:e.message}); }
});

// ── System ────────────────────────────────────────────────────────────────────
router.get('/system', platformOnly, (_req, res) => {
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

// ── DB tools (operate on the shared raw message stream — platform-level) ──────
// Clear all location data (lat/lng) from messages without deleting the messages
router.delete('/map/locations', platformOnly, (req, res) => {
  try {
    const result = getDb().prepare('UPDATE messages SET lat=NULL, lng=NULL WHERE lat IS NOT NULL OR lng IS NOT NULL').run();
    require('../services/websocket').broadcast({ type: 'map_locations_cleared' });
    addAuditLog(req.session?.username||'admin', 'map.clear_locations', `cleared=${result.changes}`);
    res.json({ ok: true, cleared: result.changes });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/db/purge/all', platformOnly, (req, res) => {
  try {
    const db = getDb();
    db.exec('DELETE FROM messages_fts');
    db.exec('DELETE FROM messages');
    try { db.exec('VACUUM'); } catch (_) {}
    addAuditLog(req.session?.username||'admin', 'db.purge_all', 'all messages deleted');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/db/purge', platformOnly, (req, res) => {
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

router.delete('/messages/:id', platformOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
  try {
    deleteMessage(id);
    addAuditLog(req.session?.username||'admin', 'message.delete', `id=${id}`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/messages/:id/regeocode', platformOnly, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
  try {
    const row = getDb().prepare('SELECT message, capcode FROM messages WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ ok: false, reason: 'Message not found' });

    const cc = (_gs('site_settings', {}).geocodeCountry || '');
    const { parseLocation, geocodeAddress } = require('../utils/parseLocation');
    // Same soft geographic anchor as the live ingest pipeline (see services/sdr.js)
    // — without this, ambiguous settlement names default to whichever same-named
    // place happens to be first in the data file, not necessarily the right one.
    const aliasName = row.capcode ? getAliasNameForCapcode(row.capcode) : null;
    const homeHint  = aliasName ? resolveAliasHome(aliasName, cc) : null;
    const loc = parseLocation(row.message, cc, homeHint);
    if (loc.lat != null && loc.lng != null) {
      getDb().prepare('UPDATE messages SET lat=?, lng=? WHERE id=?').run(loc.lat, loc.lng, id);
      require('../services/websocket').broadcast({ type: 'message_location', id, lat: loc.lat, lng: loc.lng });
      addAuditLog(req.session?.username||'admin', 'message.regeocode', `id=${id} type=coords`);
      return res.json({ ok: true, lat: loc.lat, lng: loc.lng, query: loc.raw });
    }
    const result = await geocodeAddress(loc.candidates || [], cc, row.message, homeHint);
    if (!result) return res.json({ ok: false, reason: 'No results found', query: loc.candidates?.[0] });
    getDb().prepare('UPDATE messages SET lat=?, lng=? WHERE id=?').run(result.lat, result.lng, id);
    require('../services/websocket').broadcast({ type: 'message_location', id, lat: result.lat, lng: result.lng });
    addAuditLog(req.session?.username||'admin', 'message.regeocode', `id=${id} q="${result.query}"`);
    res.json({ ok: true, lat: result.lat, lng: result.lng, query: result.query });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/db/export', platformOnly, (_req, res) => {
  try {
    const rows    = getDb().prepare('SELECT * FROM messages ORDER BY id ASC').all();
    const headers = ['id','timestamp','capcode','alias','protocol','baud','funcbits','message','raw'];
    const csv = [headers.join(','), ...rows.map(r => headers.map(h => `"${String(r[h]??'').replace(/"/g,'""')}"`).join(','))].join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="pagermonitor-${Date.now()}.csv"`);
    res.send('﻿' + csv);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/db/stats', platformOnly, (_req, res) => {
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

// ── Notifications (per-org destinations/filter) ────────────────────────────────
router.get('/notifications/config', adminOnly, (req, res) => res.json(getConfig(req.session.orgId)));
router.put('/notifications/config', adminOnly, (req, res) => {
  try { updateConfig(req.session.orgId, req.body); addAuditLog(req.session?.username||'admin', 'notif.config', null, req.session.orgId); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/notifications/test/:service', adminOnly, async (req, res) => {
  try { await testNotification(req.session.orgId, req.params.service); addAuditLog(req.session?.username||'admin', 'notif.test', req.params.service, req.session.orgId); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// GET/PUT /admin/notifications/filter
router.get('/notifications/filter', adminOnly, (req, res) => res.json(getNotifFilter(req.session.orgId)));
router.put('/notifications/filter', adminOnly, (req, res) => {
  try { saveNotifFilter(req.session.orgId, req.body); addAuditLog(req.session?.username||'admin', 'notif.filter', null, req.session.orgId); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Feed filter (per-org — controls what that org's live feed/history shows) ──
router.get('/feed-filter', adminOnly, (req, res) => res.json(getFeedFilter(req.session.orgId)));
router.put('/feed-filter', adminOnly, (req, res) => {
  try {
    saveFeedFilter(req.session.orgId, req.body);
    addAuditLog(req.session?.username||'admin', 'feed_filter.save', `mode=${req.body.mode}`, req.session.orgId);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Dedup (operates on the raw shared stream before any org-specific logic) ───
router.get('/dedup', platformOnly, (_req, res) => res.json(getDedupConfig()));
router.put('/dedup', platformOnly, (req, res) => {
  try { saveDedupConfig(req.body); addAuditLog(req.session?.username||'admin', 'dedup.config', `enabled=${req.body.enabled}`); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Message normalizations (decode-quality cleanup — platform-level) ──────────
router.get('/message-normalizations', platformOnly, (_req, res) => res.json(getMessageNormalizations()));
router.put('/message-normalizations', platformOnly, (req, res) => {
  try {
    saveMessageNormalizations(req.body);
    addAuditLog(req.session?.username||'admin', 'msg_norm.save', `count=${Array.isArray(req.body)?req.body.length:0}`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Groups (org-scoped; NULL org_id = global/shared default, platform-admin only) ──
router.get('/groups', (req, res) => { try { res.json(getGroups(req.session.orgId)); } catch (e) { res.status(500).json({ error: e.message }); } });
router.post('/groups', (req, res) => {
  try {
    const { name, color, parent_id, row_color, row_sound } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    const id = createGroup(effectiveOrgId(req), name, color, parent_id, row_color || null, row_sound || null);
    addAuditLog(req.session?.username||'admin', 'group.create', `name=${name}`, req.session.orgId);
    res.json({ ok: true, id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.put('/groups/:id', (req, res) => {
  try {
    const { name, color, parent_id, row_color, row_sound, is_global } = req.body;
    // Scope reassignment only happens when the caller explicitly sent is_global (platform
    // admin's edit form only includes it when the checkbox was actually toggled from the
    // group's original state) — never inferred from a routine edit of name/color/etc.
    const newScopeOrgId = (req.session.isPlatformAdmin && typeof is_global === 'boolean')
      ? (is_global ? null : req.session.orgId)
      : undefined;
    const changes = updateGroup(parseInt(req.params.id), req.session.orgId, req.session.isPlatformAdmin, name, color, parent_id, row_color || null, row_sound || null, newScopeOrgId);
    if (!changes) return res.status(404).json({ error: 'Group not found, or not yours to edit' });
    addAuditLog(req.session?.username||'admin', 'group.update', `id=${req.params.id} name=${name}`, req.session.orgId);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.delete('/groups/:id', (req, res) => {
  try {
    const changes = deleteGroup(parseInt(req.params.id), req.session.orgId, req.session.isPlatformAdmin);
    if (!changes) return res.status(404).json({ error: 'Group not found, or not yours to delete' });
    addAuditLog(req.session?.username||'admin', 'group.delete', `id=${req.params.id}`, req.session.orgId);
    res.json({ ok: true });
  }
  catch (e) { res.status(500).json({ error: e.message }); }
});
// Deletes the caller's own org's groups by default; a platform admin passing ?global=1
// deletes the global/shared-default groups instead — same reasoning as aliases above.
router.delete('/groups', adminOnly, (req, res) => {
  try {
    const wantsGlobal = req.query.global === '1';
    if (wantsGlobal && !req.session.isPlatformAdmin) return res.status(403).json({ error: 'Only the platform admin can delete the global group library' });
    const deleted = deleteAllGroups(wantsGlobal ? null : req.session.orgId);
    addAuditLog(req.session?.username||'admin', wantsGlobal ? 'group.delete_all_global' : 'group.delete_all', `count=${deleted}`, req.session.orgId);
    res.json({ ok: true, deleted });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Group CSV export
router.get('/groups/export', (req, res) => {
  try {
    const groups = getGroups(req.session.orgId);
    const nameById = {};
    groups.forEach(g => { nameById[g.id] = g.name; });
    // id lets a paired aliases CSV's group_id column keep working across a delete-all +
    // reimport cycle: existing groups are still matched by name on import, but a genuinely
    // new group keeps this id if nothing already occupies it (see bulkUpsertGroups).
    const csv = ['id;name;color;parent_name;row_color;row_sound',
      ...groups.map(g => `"${g.id}";"${(g.name||'').replace(/"/g,'""')}";"${g.color||''}";"${(g.parent_id ? nameById[g.parent_id]||'' : '').replace(/"/g,'""')}";"${g.row_color||''}";"${g.row_sound||''}"`),
    ].join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="groups.csv"');
    res.send('﻿' + csv);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Group CSV import
router.post('/groups/import', express.text({ type: 'text/csv', limit: '1mb' }), (req, res) => {
  try {
    const lines = req.body.replace(/^﻿/, '').replace(/\r/g, '').split('\n').filter(Boolean);
    const header = lines[0].toLowerCase();
    if (!header.includes('name')) return res.status(400).json({ error: 'CSV must have name column' });
    const cols = header.split(';').map(c => c.replace(/"/g,'').trim());
    const rows = []; let skipped = 0;
    for (const line of lines.slice(1)) {
      const vals = parseCsvLine(line);
      const row  = {};
      cols.forEach((c, i) => row[c] = (vals[i]||'').trim());
      if (row.name) rows.push({ id: row.id ? parseInt(row.id, 10) : null, name: row.name, color: row.color||'#4ade80', parent_name: row.parent_name||null, row_color: row.row_color||null, row_sound: row.row_sound||null });
      else skipped++;
    }
    bulkUpsertGroups(effectiveOrgId(req), rows);
    res.json({ ok: true, imported: rows.length, skipped });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Aliases (admin — with group_id support; org-scoped like groups) ───────────
router.get('/aliases', (req, res) => { try { res.json(getAliases(req.session.orgId)); } catch (e) { res.status(500).json({ error: e.message }); } });
router.put('/aliases/:capcode', (req, res) => {
  try {
    const { name, color, notes, group_id, row_color, row_sound } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    upsertAlias(effectiveOrgId(req), req.session.isPlatformAdmin, req.params.capcode, name, color, notes, group_id, row_color || null, row_sound || null);
    addAuditLog(req.session?.username||'admin', 'alias.save', `capcode=${normCapcode(req.params.capcode)} name=${name}`, req.session.orgId);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Deletes the caller's own org's aliases by default — never the global library or another
// org's. A platform admin passing ?global=1 instead deletes the global/shared-default
// library itself (affects every org on the instance), which is why that branch re-checks
// isPlatformAdmin explicitly rather than trusting adminOnly's org-scoped role check.
router.delete('/aliases', adminOnly, (req, res) => {
  try {
    const wantsGlobal = req.query.global === '1';
    if (wantsGlobal && !req.session.isPlatformAdmin) return res.status(403).json({ error: 'Only the platform admin can delete the global alias library' });
    const info = wantsGlobal
      ? getDb().prepare('DELETE FROM aliases WHERE org_id IS NULL').run()
      : getDb().prepare('DELETE FROM aliases WHERE org_id=?').run(req.session.orgId);
    addAuditLog(req.session?.username||'admin', wantsGlobal ? 'alias.delete_all_global' : 'alias.delete_all', `count=${info.changes}`, req.session.orgId);
    res.json({ ok: true, deleted: info.changes });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.delete('/aliases/:capcode', (req, res) => {
  try {
    const changes = deleteAlias(effectiveOrgId(req), req.session.isPlatformAdmin, req.params.capcode);
    if (!changes) return res.status(404).json({ error: 'Alias not found, or not yours to delete' });
    addAuditLog(req.session?.username||'admin', 'alias.delete', `capcode=${normCapcode(req.params.capcode)}`, req.session.orgId);
    res.json({ ok: true });
  }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Alias CSV export
router.get('/aliases/export', (req, res) => {
  try {
    const aliases = getAliases(req.session.orgId);
    // group_name, not the raw id — an id only means anything on the instance it was
    // exported from, and re-importing it elsewhere (or after groups were recreated, which
    // reassigns ids) trips the aliases.group_id foreign key. Name is portable and matches
    // how the groups CSV already references parent_name instead of parent_id.
    const csv = ['capcode;name;color;notes;group_name;row_color;row_sound',
      ...aliases.map(a => `"${a.capcode}";"${(a.name||'').replace(/"/g,'""')}";"${a.color||''}";"${(a.notes||'').replace(/"/g,'""')}";"${(a.group_name||'').replace(/"/g,'""')}";"${a.row_color||''}";"${a.row_sound||''}"`),
    ].join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="aliases.csv"');
    res.send('﻿' + csv);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Alias CSV import
router.post('/aliases/import', express.text({ type: 'text/csv', limit: '1mb' }), (req, res) => {
  try {
    const lines = req.body.replace(/^﻿/, '').replace(/\r/g, '').split('\n').filter(Boolean);
    const header = lines[0].toLowerCase();
    if (!header.includes('capcode')) return res.status(400).json({ error: 'CSV must have capcode column' });
    const cols = header.split(';').map(c => c.replace(/"/g,'').trim());
    const effOrgId = effectiveOrgId(req);

    // Resolve group_name (current export format) or a legacy raw group_id column to a group
    // actually visible in this scope; anything that doesn't resolve becomes ungrouped instead
    // of failing the whole import with a foreign-key error. Global groups are looked up first
    // so an org's own same-named group wins on collision, matching getAliases' precedence.
    const visibleGroups = getDb().prepare('SELECT id, name FROM groups WHERE org_id = ? OR org_id IS NULL ORDER BY (org_id IS NULL) DESC').all(effOrgId);
    const nameToId = {}; const validIds = new Set();
    for (const g of visibleGroups) { nameToId[g.name] = g.id; validIds.add(g.id); }

    const rows = []; let skipped = 0;
    for (const line of lines.slice(1)) {
      const vals = parseCsvLine(line);
      const row  = {};
      cols.forEach((c, i) => row[c] = (vals[i]||'').trim());
      if (!row.capcode) { skipped++; continue; }
      let group_id = null;
      if (row.group_name) group_id = nameToId[row.group_name] || null;
      else if (row.group_id) { const gid = parseInt(row.group_id, 10); if (validIds.has(gid)) group_id = gid; }
      rows.push({ capcode: row.capcode, name: row.name||row.capcode, color: row.color||'#4ade80', notes: row.notes||'', group_id, row_color: row.row_color||null, row_sound: row.row_sound||null });
    }
    bulkUpsertAliases(effOrgId, rows);
    res.json({ ok: true, imported: rows.length, skipped });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Highlight rules (org-scoped) ───────────────────────────────────────────────
router.get('/rules', (req, res) => { try { res.json(getHighlightRules(req.session.orgId)); } catch (e) { res.status(500).json({ error: e.message }); } });
router.put('/rules', (req, res) => {
  try {
    const { id } = upsertHighlightRule(req.session.orgId, req.body);
    addAuditLog(req.session?.username||'admin', 'rule.save', `name=${req.body.name}`, req.session.orgId);
    res.json({ ok: true, id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.delete('/rules/:id', (req, res) => {
  try {
    const changes = deleteHighlightRule(parseInt(req.params.id), req.session.orgId);
    if (!changes) return res.status(404).json({ error: 'Rule not found, or not yours to delete' });
    addAuditLog(req.session?.username||'admin', 'rule.delete', `id=${req.params.id}`, req.session.orgId);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Semicolon-delimited (not comma) — Excel in European locales (e.g. Slovenian) uses ','
// as the decimal separator, so it defaults to splitting CSV columns on ';' instead.
function parseCsvLine(line) {
  const result = []; let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { inQ = !inQ; } else if (c === ';' && !inQ) { result.push(cur); cur = ''; } else cur += c;
  }
  result.push(cur);
  return result;
}

// ── User live locations (org-scoped — a member's live position is personal data) ──
router.get('/user-locations', adminOnly, (req, res) => {
  try { res.json(getUserLocations(525600, req.session.isPlatformAdmin ? null : req.session.orgId)); } // all stored (up to 1 year)
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Site settings (instance-wide) ──────────────────────────────────────────────
// geocodeCountry/locale/timezone default to blank (unconfigured) rather than
// Slovenia — this repo is public and self-hosted by deployments worldwide, and a
// silent Slovenia default meant every fresh install silently activated
// Slovenia-only integrations (ARSO, NAP traffic, OpenSky aircraft bounding box).
// Same reasoning applies to the optional-feature toggles themselves — all default
// off now, opt-in rather than opt-out, on top of the geocodeCountry gate.
const SITE_SETTINGS_DEFAULTS = { siteName:'PagerMonitor', siteDescription:'Real-time pager decoder', newBadgeSeconds:10, mapDotColor:'#00ff9d', showMapButton:true, mapMaxAgeDays:30, publicMode:false, geocodeCountry:'', locale:'', timezone:'', windyApiKey:'', enableTraffic:false, enableAircraft:false, enableArsoWeather:false, enableInterventions:false };

router.get('/site-settings', platformOnly, (_req, res) => {
  try { res.json(_gs('site_settings', SITE_SETTINGS_DEFAULTS)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.put('/site-settings', platformOnly, (req, res) => {
  try {
    const cur = _gs('site_settings', SITE_SETTINGS_DEFAULTS);
    const b = req.body;
    const validTz = tz => { try { Intl.DateTimeFormat(undefined, { timeZone: tz }); return true; } catch (_) { return false; } };
    // Merge onto the existing stored blob — only fields present in the request body
    // are validated/overwritten, so a page that only edits e.g. the feature toggles
    // doesn't clobber unrelated settings saved from another admin tab.
    const next = {
      siteName: b.siteName !== undefined ? (b.siteName || 'PagerMonitor') : cur.siteName,
      siteDescription: b.siteDescription !== undefined ? (b.siteDescription || '') : cur.siteDescription,
      newBadgeSeconds: b.newBadgeSeconds !== undefined ? Math.max(0, Math.min(300, parseInt(b.newBadgeSeconds,10)||0)) : cur.newBadgeSeconds,
      mapDotColor: b.mapDotColor !== undefined ? (b.mapDotColor || '#00ff9d') : cur.mapDotColor,
      showMapButton: b.showMapButton !== undefined ? (b.showMapButton !== false) : cur.showMapButton,
      mapMaxAgeDays: b.mapMaxAgeDays !== undefined ? Math.max(1/24, Math.min(365, parseFloat(b.mapMaxAgeDays)||30)) : cur.mapMaxAgeDays,
      publicMode: b.publicMode !== undefined ? !!b.publicMode : cur.publicMode,
      // Empty string is a valid explicit "clear it back to unconfigured" — only
      // reject genuinely invalid non-empty input by falling back to the current value.
      geocodeCountry: b.geocodeCountry !== undefined ? (b.geocodeCountry === '' || /^[a-z]{2}$/.test(b.geocodeCountry) ? b.geocodeCountry : cur.geocodeCountry) : cur.geocodeCountry,
      locale: b.locale !== undefined ? (b.locale === '' || /^[a-z]{2}-[A-Z]{2}$/.test(b.locale) ? b.locale : cur.locale) : cur.locale,
      hour12: b.hour12 !== undefined ? !!b.hour12 : cur.hour12,
      timezone: b.timezone !== undefined ? (b.timezone === '' || (typeof b.timezone === 'string' && validTz(b.timezone)) ? b.timezone : cur.timezone) : cur.timezone,
      windyApiKey: b.windyApiKey !== undefined ? (typeof b.windyApiKey === 'string' ? b.windyApiKey.trim() : '') : cur.windyApiKey,
      // Opt-in (=== true), not opt-out — these default off until an admin turns
      // them on explicitly, on top of the geocodeCountry gate.
      enableTraffic: b.enableTraffic !== undefined ? (b.enableTraffic === true) : (cur.enableTraffic === true),
      enableAircraft: b.enableAircraft !== undefined ? (b.enableAircraft === true) : (cur.enableAircraft === true),
      enableArsoWeather: b.enableArsoWeather !== undefined ? (b.enableArsoWeather === true) : (cur.enableArsoWeather === true),
      enableInterventions: b.enableInterventions !== undefined ? (b.enableInterventions === true) : (cur.enableInterventions === true),
    };
    _ss('site_settings', next);
    addAuditLog(req.session?.username||'admin', 'site.settings', `publicMode=${!!next.publicMode}`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Geo data download (SSE, instance-wide) ────────────────────────────────────
// Streams stdout/stderr from fetchStreets.js + fetchPlaces.js back to the browser.
// Uses fetch()-streaming on the frontend (not EventSource) so Bearer auth works.
router.get('/geo-data/fetch', platformOnly, (req, res) => {
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
      // The street/place indexes are lazy-loaded singletons that cache a failed
      // (empty) load forever — without this, a freshly-written data file isn't
      // picked up until the backend process restarts.
      try {
        require('../utils/streetIndex').invalidate();
        require('../utils/placeIndex').invalidate(cc);
        require('../utils/aliasPlace').invalidate();
      } catch (_) {}
      send({ type: 'done' });
      clearInterval(hb);
      res.end();
    });
  });

  addAuditLog(req.session?.username || 'admin', 'geo.fetch', `cc=${cc}`);
});

// ── Client key (instance-wide — shared secret for every remote SDR client) ────
router.get('/client-key', platformOnly, (_req, res) => { try { res.json({ key: _gs('client_key','') }); } catch(e){ res.status(500).json({error:e.message}); }});
router.put('/client-key', platformOnly, (req, res) => {
  try {
    const { key } = req.body;
    if (!key || key.trim().length < 16) return res.status(400).json({ error: 'Key must be at least 16 characters' });
    _ss('client_key', key.trim()); res.json({ ok: true });
  } catch(e){ res.status(500).json({error:e.message}); }
});

// ── Keyword alerts (org-scoped) ────────────────────────────────────────────────
router.get('/keyword-alerts',        (req,res) => { try{ res.json(getKeywordAlerts(req.session.orgId)); } catch(e){ res.status(500).json({error:e.message}); }});
router.put('/keyword-alerts',        (req,res) => { try{ const { id } = upsertKeywordAlert(req.session.orgId, req.body); res.json({ok:true,id}); } catch(e){ res.status(500).json({error:e.message}); }});
router.delete('/keyword-alerts/:id', (req,res) => {
  try {
    const changes = deleteKeywordAlert(parseInt(req.params.id), req.session.orgId);
    if (!changes) return res.status(404).json({ error: 'Alert not found, or not yours to delete' });
    res.json({ok:true});
  } catch(e){ res.status(500).json({error:e.message}); }
});

// ── Voice channels — the catalog is instance-wide (tied to shared physical dongles, not
// per-org content), so managing it is platform-admin only. Each org can still opt individual
// channels out for its own users — see the /voice-channel-visibility routes further down,
// which are the ones regular org admins use. ──────────────────────────────────────────────
router.get('/voice-channels',        platformOnly, (_req,res) => { try{ res.json(getAllVoiceChannels()); } catch(e){ res.status(500).json({error:e.message}); }});
router.put('/voice-channels',        platformOnly, (req,res) => {
  try{
    const { id } = upsertVoiceChannel(req.body);
    require('../services/websocket').broadcast({ type: 'voice_channels_changed' });
    res.json({ok:true,id});
  } catch(e){ res.status(500).json({error:e.message}); }
});
router.delete('/voice-channels/:id', platformOnly, (req,res) => {
  try {
    const changes = deleteVoiceChannel(parseInt(req.params.id));
    if (!changes) return res.status(404).json({ error: 'Channel not found' });
    require('../services/websocket').broadcast({ type: 'voice_channels_changed' });
    res.json({ok:true});
  } catch(e){ res.status(500).json({error:e.message}); }
});

// Live per-channel status — listener counts, which dongle/client owns the channel, and
// when it was last confirmed transmitting. Polled by the platform-admin catalog page, so
// shows every channel regardless of which orgs have opted out of it.
router.get('/voice-channels/listeners', platformOnly, (_req, res) => {
  try {
    const audioRelay   = require('../services/audioRelay');
    const { getClients } = require('../services/clientTracker');
    const listenerCounts = audioRelay.getListenerCounts();
    const heardAt         = audioRelay.getHeardTimestamps();
    const clientLabel = (id) => getClients().find(c => c.id === id)?.displayName || id;

    const out = {};
    for (const c of getAllVoiceChannels()) {
      const owner = audioRelay.resolveChannelOwner(c.id);
      out[c.id] = {
        count: listenerCounts[c.id]?.count || 0,
        usernames: listenerCounts[c.id]?.usernames || [],
        owner: owner && {
          type: owner.type,
          label: owner.type === 'remote'
            ? clientLabel(owner.clientId) + (owner.dongleLabel ? ` - ${owner.dongleLabel}` : '')
            : (owner.dongleLabel || 'This server'),
        },
        lastHeardAt: heardAt[c.id] || null,
      };
    }
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Per-org visibility toggle — lets an org admin hide specific channels from the shared
// catalog above for their own org's users, without touching the catalog itself.
router.get('/voice-channel-visibility', adminOnly, (req, res) => {
  try { res.json({ channels: getAllVoiceChannels(), hidden: getVoiceChannelHidden(req.session.orgId) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.put('/voice-channel-visibility/:id', adminOnly, (req, res) => {
  try {
    setVoiceChannelHidden(req.session.orgId, parseInt(req.params.id), !!req.body.hidden);
    require('../services/websocket').broadcastToOrg(req.session.orgId, { type: 'voice_channels_changed' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Discord relays (org-scoped) — streams a voice channel live into a Discord voice
// channel via a bot connection. reconcile() (lazy-required to dodge circular init) tells
// discordRelay.js to pick up the change — connect/disconnect/rejoin as needed.
router.get('/discord-relays', (req, res) => {
  try { res.json(getDiscordRelays(req.session.orgId)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.put('/discord-relays', (req, res) => {
  try {
    const { channel_ids, bot_token, guild_id, discord_channel_id } = req.body;
    if (!Array.isArray(channel_ids) || channel_ids.length === 0 || !bot_token || !guild_id || !discord_channel_id) {
      return res.status(400).json({ error: 'channel_ids (at least one), bot_token, guild_id, and discord_channel_id are required' });
    }
    const { id } = upsertDiscordRelay(req.session.orgId, req.body);
    require('../services/discordRelay').reconcile().catch(() => {});
    res.json({ ok: true, id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.delete('/discord-relays/:id', (req, res) => {
  try {
    const changes = deleteDiscordRelay(parseInt(req.params.id), req.session.orgId);
    if (!changes) return res.status(404).json({ error: 'Relay not found, or not yours to delete' });
    require('../services/discordRelay').reconcile().catch(() => {});
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Dead air config (instance-wide) ────────────────────────────────────────────
router.get('/dead-air', platformOnly, (_req,res) => { try{ res.json(_gs('dead_air_config',{enabled:false,thresholdHours:6})); } catch(e){ res.status(500).json({error:e.message}); }});
router.put('/dead-air', platformOnly, (req,res) => {
  try {
    const { enabled, thresholdHours } = req.body;
    _ss('dead_air_config', { enabled: !!enabled, thresholdHours: Math.max(1, Math.min(168, parseInt(thresholdHours,10)||6) )});
    res.json({ ok: true });
  } catch(e){ res.status(500).json({error:e.message}); }
});

// ── OpenSky aircraft tracking credentials (instance-wide) ──────────────────────
const openskyAircraft = require('../services/openskyAircraft');
router.get('/opensky/config', platformOnly, (_req, res) => { try{ res.json(_gs('opensky_config', { clientId:'', clientSecret:'' })); } catch(e){ res.status(500).json({error:e.message}); }});
router.put('/opensky/config', platformOnly, (req, res) => {
  try {
    const clientId     = String(req.body?.clientId || '').trim();
    const clientSecret = String(req.body?.clientSecret || '').trim();
    _ss('opensky_config', { clientId, clientSecret });
    openskyAircraft.restart();
    addAuditLog(req.session?.username||'admin', 'opensky.config', null);
    res.json({ ok: true });
  } catch(e){ res.status(500).json({error:e.message}); }
});

// ── NAP (b2b.nap.si) traffic data credentials (instance-wide) ──────────────────
const napTraffic = require('../services/napTraffic');
router.get('/nap/config', platformOnly, (_req, res) => {
  try {
    const cfg = _gs('nap_config', { username:'', password:'' });
    res.json({ ...cfg, status: napTraffic.getStatus() });
  } catch(e){ res.status(500).json({error:e.message}); }
});
router.put('/nap/config', platformOnly, (req, res) => {
  try {
    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '').trim();
    _ss('nap_config', { username, password });
    napTraffic.restart();
    addAuditLog(req.session?.username||'admin', 'nap.config', null);
    res.json({ ok: true });
  } catch(e){ res.status(500).json({error:e.message}); }
});

// ── Webhooks (org-scoped) ───────────────────────────────────────────────────────
router.get('/webhooks', adminOnly, (_req,res) => { try{ res.json(getWebhooks(_req.session.orgId)); } catch(e){ res.status(500).json({error:e.message}); }});
router.put('/webhooks', adminOnly, (req,res) => { try{ const { id } = upsertWebhook(req.session.orgId, req.body); res.json({ok:true,id}); } catch(e){ res.status(500).json({error:e.message}); }});
router.delete('/webhooks/:id', adminOnly, (req,res) => {
  try {
    const changes = deleteWebhook(parseInt(req.params.id), req.session.orgId);
    if (!changes) return res.status(404).json({ error: 'Webhook not found, or not yours to delete' });
    res.json({ok:true});
  } catch(e){ res.status(500).json({error:e.message}); }
});
router.post('/webhooks/:id/test', adminOnly, async (req,res) => {
  try {
    const hooks = getWebhooks(req.session.orgId).filter(h => h.id === parseInt(req.params.id,10));
    if (!hooks.length) return res.status(404).json({error:'Not found'});
    const { sendWebhooks } = require('../services/webhooks');
    await sendWebhooks({ type:'test', message:'PagerMonitor webhook test', timestamp: new Date().toISOString() }, req.session.orgId);
    res.json({ ok: true });
  } catch(e){ res.status(500).json({error:e.message}); }
});

// ── Audit log (platform-wide; optional ?org_id= to focus on one org) ──────────
router.get('/audit-log', platformOnly, (req,res) => {
  try {
    const limit  = parseInt(req.query.limit || '200', 10);
    const filter = req.query.filter || ''; // e.g. "alias,group,rule"
    const orgId  = req.query.org_id ? parseInt(req.query.org_id) : null;
    let rows = getAuditLog(limit, orgId);
    if (filter) {
      const prefixes = filter.split(',').map(s => s.trim()).filter(Boolean);
      rows = rows.filter(r => prefixes.some(p => r.action.startsWith(p)));
    }
    res.json(rows);
  } catch(e){ res.status(500).json({error:e.message}); }
});

// ── Message stats (platform-wide dashboard over the shared raw stream) ────────
router.get('/stats', platformOnly, (req,res) => {
  try{ res.json(getMessageStats(req.session.orgId)); } catch(e){ res.status(500).json({error:e.message}); }
});

// ── Organizations & invites ────────────────────────────────────────────────────
// Platform admin: create/list organizations, reassign users (see routes/auth.js
// for PUT /auth/users/:id/org).
router.get('/organizations', platformOnly, (_req, res) => {
  try { res.json(getOrganizations()); } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/organizations', platformOnly, (req, res) => {
  try {
    const name = (req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name required' });
    const id = createOrganization(name, req.session.userId);
    addAuditLog(req.session.username, 'org.create', `name=${name}`);
    res.json({ ok: true, id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.put('/organizations/:id', platformOnly, (req, res) => {
  try {
    const name = (req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name required' });
    const changes = renameOrganization(parseInt(req.params.id), name);
    if (!changes) return res.status(404).json({ error: 'Organization not found' });
    addAuditLog(req.session.username, 'org.rename', `id=${req.params.id} name=${name}`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// PUT /admin/organization — org admin renames their own org (unlike the platform-only
// /organizations/:id above, which can target any org). No :id — always req.session.orgId,
// so an org admin can never rename anyone else's workspace.
router.put('/organization', adminOnly, (req, res) => {
  try {
    const name = (req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name required' });
    renameOrganization(req.session.orgId, name);
    addAuditLog(req.session.username, 'org.rename', `id=${req.session.orgId} name=${name}`, req.session.orgId);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/organizations/:id', platformOnly, (req, res) => {
  try {
    const changes = deleteOrganization(parseInt(req.params.id));
    if (!changes) return res.status(404).json({ error: 'Organization not found' });
    addAuditLog(req.session.username, 'org.delete', `id=${req.params.id}`);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Invites — org-admin scoped (their own org only). An admin may invite at any of the
// three org roles, including a co-admin — it's their org to manage.
router.get('/invites', adminOnly, (req, res) => {
  try { res.json(listInvites(req.session.orgId)); } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/invites', adminOnly, (req, res) => {
  try {
    const { role, expiresInDays, maxUses } = req.body || {};
    const validRoles = ['admin', 'editor', 'viewer'];
    const expiresAt = expiresInDays ? new Date(Date.now() + parseInt(expiresInDays,10) * 86400000).toISOString() : null;
    const code = createInvite({
      orgId: req.session.orgId,
      role: validRoles.includes(role) ? role : 'viewer',
      createdBy: req.session.userId,
      expiresAt,
      maxUses: parseInt(maxUses, 10) || 0,
    });
    addAuditLog(req.session.username, 'invite.create', `role=${role}`, req.session.orgId);
    res.json({ ok: true, code });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.delete('/invites/:id', adminOnly, (req, res) => {
  try {
    const changes = revokeInvite(parseInt(req.params.id), req.session.orgId);
    if (!changes) return res.status(404).json({ error: 'Invite not found, or not yours to revoke' });
    addAuditLog(req.session.username, 'invite.revoke', `id=${req.params.id}`, req.session.orgId);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── SDR Clients dashboard (instance infrastructure) ────────────────────────────
const { getClients, resetClient, getAllClientConfigs, saveClientConfig, setPendingCommand, setDisplayName, setClientColor } = require('../services/clientTracker');

router.get('/sdr-clients', platformOnly, (_req, res) => {
  try {
    const { isAudioConnected } = require('../services/audioRelay');
    res.json(getClients().map(c => ({ ...c, audioConnected: isAudioConnected(c.id) })));
  }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/sdr-clients/:id/name', platformOnly, (req, res) => {
  try {
    const id   = decodeURIComponent(req.params.id);
    const name = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 60) : '';
    setDisplayName(id, name);
    addAuditLog(req.session?.username || 'admin', 'client.rename', `id=${id} name=${name || '(cleared)'}`);
    res.json({ ok: true });
  }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/sdr-clients/:id/color', platformOnly, (req, res) => {
  try {
    const id    = decodeURIComponent(req.params.id);
    const color = typeof req.body?.color === 'string' ? req.body.color.trim().slice(0, 20) : '';
    setClientColor(id, color);
    addAuditLog(req.session?.username || 'admin', 'client.color', `id=${id} color=${color || '(cleared)'}`);
    res.json({ ok: true });
  }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/sdr-clients/:id', platformOnly, (req, res) => {
  try {
    const id = decodeURIComponent(req.params.id);
    resetClient(id);
    unregisterSource(id);   // clear dead-air tracking for removed client
    require('../services/websocket').broadcast({ type: 'voice_channels_changed' });
    res.json({ ok: true });
  }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Per-client remote config
router.get('/sdr-clients/configs', platformOnly, (_req, res) => {
  try { res.json(getAllClientConfigs()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/sdr-clients/:id/config', platformOnly, (req, res) => {
  try {
    const clientId = decodeURIComponent(req.params.id);
    const dongles = Array.isArray(req.body?.dongles) ? req.body.dongles : [req.body];
    const conflicts = require('../services/audioRelay').findVoiceChannelConflicts(dongles, { type: 'remote', clientId });
    if (conflicts.length > 0) {
      return res.status(409).json({ error: describeChannelConflicts(conflicts), conflicts });
    }
    const version = saveClientConfig(clientId, req.body);
    require('../services/websocket').broadcast({ type: 'voice_channels_changed' });
    res.json({ ok: true, version });
  }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /admin/clients/logs — buffered history, merged across all clients unless ?clientId=
router.get('/clients/logs', platformOnly, (req, res) => {
  try {
    const { getClientLogs, getAllClientLogs } = require('../services/audioRelay');
    const clientId = req.query.clientId;
    res.json(clientId ? getClientLogs(clientId) : getAllClientLogs());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /admin/sdr-clients/:id/command — queue a remote command (e.g. 'update')
router.post('/sdr-clients/:id/command', platformOnly, (req, res) => {
  try {
    const { command } = req.body;
    if (!command) return res.status(400).json({ error: 'command required' });
    const id = decodeURIComponent(req.params.id);
    setPendingCommand(id, command);
    addAuditLog(req.session?.username || 'admin', 'client.command', `id=${id} cmd=${command}`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Email config (instance-wide) ───────────────────────────────────────────────
const { getEmailConfig, saveEmailConfig, testEmail } = require('../services/email');

router.get('/email/config', platformOnly, (_req, res) => {
  try {
    res.json(getEmailConfig());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/email/config', platformOnly, (req, res) => {
  try {
    const existing = getEmailConfig();
    const cfg = { ...existing, ...req.body };
    saveEmailConfig(cfg);
    addAuditLog(req.session?.username||'admin', 'email.config', `host=${cfg.host}`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/email/test', platformOnly, async (req, res) => {
  try {
    const { to } = req.body;
    if (!to) return res.status(400).json({ error: 'to email required' });
    await testEmail(to);
    addAuditLog(req.session?.username||'admin', 'email.test', `to=${to}`);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── Per-user notification prefs (org-scoped) ──────────────────────────────────
const { getAllUsersWithPrefs, getUserNotifPrefs, setUserNotifPrefs, updateUserEmail } = require('../services/database');

router.get('/user-notif-prefs', adminOnly, (req, res) => {
  try { res.json(getAllUsersWithPrefs(req.session.orgId)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/user-notif-prefs/:userId', adminOnly, (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    if (!req.session.isPlatformAdmin) {
      const target = getUserById(userId);
      if (!target || target.org_id !== req.session.orgId) return res.status(403).json({ error: 'Cannot manage a user outside your organization' });
    }
    setUserNotifPrefs(userId, req.body);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/users/:id/email', adminOnly, (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!req.session.isPlatformAdmin) {
      const target = getUserById(id);
      if (!target || target.org_id !== req.session.orgId) return res.status(403).json({ error: 'Cannot manage a user outside your organization' });
    }
    updateUserEmail(id, req.body.email);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Archive (instance-wide) ─────────────────────────────────────────────────────
const { archiveOldMessages, getArchiveStats } = require('../services/archive');

router.get('/archive/stats', platformOnly, (_req, res) => {
  try { res.json(getArchiveStats()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/archive/config', platformOnly, (_req, res) => {
  try { res.json(_gs('archive_config', { enabled: false, afterDays: 30 })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/archive/config', platformOnly, (req, res) => {
  try {
    const { enabled, afterDays } = req.body;
    _ss('archive_config', {
      enabled:    !!enabled,
      afterDays:  Math.max(1, Math.min(3650, parseInt(afterDays, 10) || 30)),
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/archive/run', platformOnly, (req, res) => {
  try {
    const cfg   = _gs('archive_config', { enabled: false, afterDays: 30 });
    const days  = parseInt(req.body.days, 10) || cfg.afterDays || 30;
    const count = archiveOldMessages(days);
    res.json({ ok: true, archived: count, days });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── AI Geocode (instance-wide) ──────────────────────────────────────────────────
const aiGeocode = require('../utils/aiGeocode');

router.get('/ai-geocode/config', platformOnly, (_req, res) => {
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
      geocoder:        cfg.geocoder,
      hereKeySaved:    !!cfg.hereKey,
      hereKeySource:   process.env.HERE_API_KEY   ? 'env' : (cfg.hereKey   ? 'db' : 'none'),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/ai-geocode/config', platformOnly, (req, res) => {
  try {
    aiGeocode.saveConfig(req.body);
    addAuditLog(req.session?.username || 'admin', 'ai_geocode.config', `provider=${req.body.provider}`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/ai-geocode/status', platformOnly, async (_req, res) => {
  try { res.json(await aiGeocode.checkStatus()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/ai-geocode/test', platformOnly, async (req, res) => {
  try {
    const text = (req.body.text || '').trim();
    if (!text) return res.status(400).json({ error: 'text is required' });
    const extracted = await aiGeocode.extractAddress(text);
    res.json({ ok: !!extracted?.street, extracted: extracted || null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── System Update (instance-wide) ──────────────────────────────────────────────
const ROOT_DIR      = path.join(__dirname, '../../..');
const UPDATE_SCRIPT = path.join(ROOT_DIR, 'update-web.sh');

function detectUpdateEnvironment() {
  const dockerEnv = process.env.PM_UPDATE_MODE || '';
  if (dockerEnv === 'docker') {
    return {
      mode: 'docker',
      supported: false,
      reason: 'The web updater is only supported for host/systemd installs. In Docker, use the documented host-side update workflow from the Makefile instead.',
      commands: ['make update'],
    };
  }

  try {
    if (fs.existsSync('/.dockerenv')) {
      return {
        mode: 'docker',
        supported: false,
        reason: 'The web updater is only supported for host/systemd installs. In Docker, use the documented host-side update workflow from the Makefile instead.',
        commands: ['make update'],
      };
    }
  } catch (_) {}

  try {
    const cgroup = fs.readFileSync('/proc/1/cgroup', 'utf8');
    if (/(^|\/)(docker|containerd|kubepods)(\/|$)/m.test(cgroup)) {
      return {
        mode: 'docker',
        supported: false,
        reason: 'The web updater is only supported for host/systemd installs. In Docker, use the documented host-side update workflow from the Makefile instead.',
        commands: ['make update'],
      };
    }
  } catch (_) {}

  return {
    mode: 'host',
    supported: true,
    reason: null,
    commands: [],
  };
}

// GET /admin/update/status — local git info (frontend fetches GitHub API itself)
router.get('/update/status', platformOnly, (_req, res) => {
  const updateEnv = detectUpdateEnvironment();
  let localHash = null, localDate = null, localCommits = null;
  try {
    localHash    = execSync('git rev-parse --short HEAD',      { cwd: ROOT_DIR, timeout: 5000, stdio: 'pipe' }).toString().trim();
    localDate    = execSync('git log -1 --format=%ci',         { cwd: ROOT_DIR, timeout: 5000, stdio: 'pipe' }).toString().trim();
    localCommits = execSync('git rev-parse HEAD',              { cwd: ROOT_DIR, timeout: 5000, stdio: 'pipe' }).toString().trim();
  } catch (_) {}
  res.json({ version, localHash, localDate, localCommits, updateEnv });
});

// Strip ANSI colour escape codes (e.g. \x1b[33m) from Vite/npm output
function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

// POST /admin/update — streams update-web.sh output via SSE, then restarts service
router.post('/update', platformOnly, (req, res) => {
  const updateEnv = detectUpdateEnvironment();
  if (!updateEnv.supported) {
    return res.status(409).json({
      error: updateEnv.reason,
      updateEnv,
    });
  }

  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();

  const send = obj => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`); };
  const hb   = setInterval(() => { if (!res.writableEnded) res.write(': ping\n\n'); }, 20_000);
  req.on('close', () => clearInterval(hb));

  const child = spawn('bash', [UPDATE_SCRIPT], {
    cwd: ROOT_DIR,
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', TERM: 'dumb' },
  });

  child.stdout.on('data', d =>
    d.toString().split('\n').forEach(l => { const c = stripAnsi(l); if (c.trim()) send({ type: 'log', text: c }); })
  );
  child.stderr.on('data', d =>
    d.toString().split('\n').forEach(l => { const c = stripAnsi(l); if (c.trim()) send({ type: 'log', text: c, err: true }); })
  );
  child.on('error', err => {
    send({ type: 'error', text: err.message });
    clearInterval(hb);
    res.end();
  });
  child.on('close', code => {
    clearInterval(hb);
    if (code !== 0) {
      send({ type: 'error', text: `Update script exited with code ${code}` });
      res.end();
      return;
    }
    send({ type: 'restarting' });
    res.end();
    addAuditLog(req.session?.username || 'admin', 'system.update', 'web update completed');
    // Restart the service — spawned detached so it survives this process dying
    setTimeout(() => {
      const r = spawn('sudo', ['systemctl', 'restart', 'pagermonitor'],
        { detached: true, stdio: 'ignore' });
      r.unref();
    }, 800);
  });
});

module.exports = router;
