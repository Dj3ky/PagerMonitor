/**
 * Client ingestion endpoint
 * Receives decoded POCSAG messages from remote RPi clients
 * Authenticated via X-Client-Key header (shared secret)
 */

'use strict';

const { version } = require('../../package.json');
const express = require('express');
const router  = express.Router();

const { insertMessage, getKeywordAlerts, getSetting } = require('../services/database');
const { broadcast }             = require('../services/websocket');
const { resolveAlias }          = require('../utils/aliases');
const { parseLocation, geocodeAddress } = require('../utils/parseLocation');
const { sendNotifications }     = require('../services/notifications');
const { sendWebhooks }          = require('../services/webhooks');
const { sendUserEmailNotifications } = require('../services/emailNotifier');
const { sendPushPerUser }       = require('../services/webpush');
const { recordMessage }         = require('../services/deadair');
const { recordClientMessage, recordClientPing, recordClientOffline, getClientConfig } = require('../services/clientTracker');
const { getDedupConfig }        = require('../services/config');
const logger                    = require('../utils/logger');

// Dedup cache (same logic as sdr.js but for remote messages)
const dedupCache = new Map();
function isDuplicate(capcode, message) {
  const cfg = getDedupConfig();
  if (!cfg.enabled || !message) return false;
  const key  = `${capcode}|${message}`;
  const last = dedupCache.get(key);
  const now  = Date.now();
  if (last && (now - last) < cfg.windowSeconds * 1000) return true;
  dedupCache.set(key, now);
  if (dedupCache.size > 2000) {
    const cutoff = now - 300_000;
    for (const [k, v] of dedupCache) if (v < cutoff) dedupCache.delete(k);
  }
  return false;
}

// Auth middleware — verify X-Client-Key
function requireClientKey(req, res, next) {
  const clientKey = getSetting('client_key', null);
  if (!clientKey) {
    // No key configured — reject all client connections
    return res.status(403).json({ error: 'Client ingestion not enabled — set CLIENT_KEY in server settings' });
  }
  const provided = req.headers['x-client-key'] || '';
  if (provided !== clientKey) {
    logger.warn(`Client auth failed from ${req.ip} — bad key`);
    return res.status(401).json({ error: 'Invalid client key' });
  }
  next();
}

// POST /client/message — receive a decoded message from a remote client
router.post('/message', requireClientKey, (req, res) => {
  try {
    const { protocol, baud, capcode, funcbits, message, raw, timestamp, clientId, freq, protocols } = req.body;

    if (!capcode || !protocol) {
      return res.status(400).json({ error: 'capcode and protocol required' });
    }

    if (isDuplicate(capcode, message)) {
      logger.debug(`[client:${clientId}] dedup skip ${capcode}`);
      return res.json({ ok: true, deduped: true });
    }

    const aliasName = resolveAlias(capcode);

    // Look up full alias + group info to match history format
    let aliasColor = null, groupId = null, groupName = null, groupColor = null;
    let parentGroupName = null, parentGroupColor = null;
    try {
      const { getDb } = require('../services/database');
      const row = getDb().prepare(`
        SELECT a.color, g.id as gid, g.name as gname, g.color as gcolor,
               pg.name as pgname, pg.color as pgcolor
        FROM aliases a
        LEFT JOIN groups g  ON g.id = a.group_id
        LEFT JOIN groups pg ON pg.id = g.parent_id
        WHERE a.capcode = ?
      `).get(capcode);
      if (row) {
        aliasColor = row.color; groupId = row.gid; groupName = row.gname;
        groupColor = row.gcolor; parentGroupName = row.pgname; parentGroupColor = row.pgcolor;
      }
    } catch (_) {}

    const geocodeCountry = (getSetting('site_settings', {}).geocodeCountry || 'si');
    const location = parseLocation(message || '', geocodeCountry);
    const { lat, lng } = location;
    const ts  = timestamp || new Date().toISOString();
    const msg = {
      timestamp: ts, capcode, protocol, baud, funcbits,
      message: message || '', raw: raw || '',
      lat, lng,
      alias:              aliasName,
      alias_name:         aliasName,
      alias_color:        aliasColor,
      group_id:           groupId,
      group_name:         groupName,
      group_color:        groupColor,
      parent_group_name:  parentGroupName,
      parent_group_color: parentGroupColor,
    };
    const id      = insertMessage(msg);
    const payload = { type: 'message', id, ...msg };

    broadcast(payload);
    recordMessage();
    recordClientMessage(clientId, req.ip, { message, freq, protocols });

    // Keyword alerts
    try {
      const alerts  = getKeywordAlerts().filter(a => a.enabled);
      const matched = alerts.filter(a => {
        try {
          const re = a.is_regex
            ? new RegExp(a.pattern, 'i')
            : new RegExp(a.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
          return re.test(msg.message || '') || re.test(msg.capcode || '');
        } catch { return false; }
      });
      if (matched.length) broadcast({ ...payload, type: 'keyword_alert', matchedAlerts: matched });
    } catch (_) {}

    // Geocode address first if no explicit coords, so notifications include a map link
    ;(async () => {
      let notifyPayload = payload;
      if (!lat) {
        const result = await geocodeAddress(location.candidates || [], geocodeCountry, message).catch(() => null);
        if (result) {
          try { require('../services/database').getDb().prepare('UPDATE messages SET lat=?, lng=? WHERE id=?').run(result.lat, result.lng, id); } catch (_) {}
          broadcast({ type: 'message_location', id, lat: result.lat, lng: result.lng });
          notifyPayload = { ...payload, lat: result.lat, lng: result.lng };
        }
      }
      sendNotifications(notifyPayload).catch(e => logger.warn(`Notification: ${e.message}`));
      sendWebhooks(notifyPayload).catch(() => {});
      sendUserEmailNotifications(notifyPayload).catch(() => {});
      sendPushPerUser(notifyPayload).catch(() => {});
    })();

    logger.info(`[client:${clientId}] [${protocol}] ${capcode}: ${(message || '').substring(0, 60)}`);
    res.json({ ok: true, id });

  } catch (e) {
    logger.error(`Client message error: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// GET /client/status — client can check if server is reachable and key is valid
router.get('/status', requireClientKey, (req, res) => {
  const clientId = req.headers['x-client-id'] || 'unknown';
  recordClientPing(clientId, req.ip);
  res.json({ ok: true, server: 'PagerMonitor', version });
});

// POST /client/offline — client notifies server it is shutting down gracefully
router.post('/offline', requireClientKey, (req, res) => {
  const clientId = req.headers['x-client-id'] || '';
  if (clientId) recordClientOffline(clientId);
  res.json({ ok: true });
});

// GET /client/config — client polls for remote config changes
// Returns { config, version } — client restarts pipeline if version differs from its current one
router.get('/config', requireClientKey, (req, res) => {
  const clientId = req.headers['x-client-id'] || '';
  if (!clientId) return res.status(400).json({ error: 'X-Client-Id header required' });

  recordClientPing(clientId, req.ip, {
    freq:       req.query.freq       || null,
    protocols:  req.query.protocols  || null,
    sdrRunning: req.query.sdrRunning === 'true' ? true : req.query.sdrRunning === 'false' ? false : null,
  });

  const cfg = getClientConfig(clientId);
  if (!cfg) return res.json({ config: null, version: null }); // no config set yet

  res.json(cfg);
});

module.exports = router;
