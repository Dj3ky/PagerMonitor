/**
 * Client ingestion endpoint
 * Receives decoded POCSAG messages from remote RPi clients
 * Authenticated via X-Client-Key header (shared secret)
 */

'use strict';

const { version } = require('../../package.json');
const express = require('express');
const router  = express.Router();

const { insertMessage, getSetting } = require('../services/database');
const { broadcast }             = require('../services/websocket');
const { broadcastAll, notifyAll } = require('../services/fanout');
const { parseLocation, geocodeAddress } = require('../utils/parseLocation');
const { recordMessage, unregisterSource } = require('../services/deadair');
const { recordClientMessage, recordClientPing, recordClientOffline, getClientConfig, popPendingCommand } = require('../services/clientTracker');
const { getDedupConfig } = require('../services/config');
const { getVoiceChannelById } = require('../services/database');
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

    // Which remote client this message came from — resolved to its friendly display name/color (if set)
    let clientDisplayName = null, clientColor = null;
    try {
      const { getDb } = require('../services/database');
      const row = getDb().prepare('SELECT display_name, color FROM sdr_clients WHERE id = ?').get(clientId);
      clientDisplayName = row?.display_name || null;
      clientColor        = row?.color || null;
    } catch (_) {}

    const geocodeCountry = (getSetting('site_settings', {}).geocodeCountry || 'si');
    const location = parseLocation(message || '', geocodeCountry);
    const { lat, lng } = location;
    const ts  = timestamp || new Date().toISOString();
    // Raw, alias-agnostic — alias/group naming is resolved per-org at broadcast/read
    // time (an alias can differ per org, or be a global shared default; see services/fanout.js).
    const rawMsg = {
      timestamp: ts, capcode, protocol, baud, funcbits,
      message: message || '', raw: raw || '',
      lat, lng, alias: null,
      client_id:    clientId || null,
      client_name:  clientDisplayName,
      client_color: clientColor,
    };

    const id     = insertMessage(rawMsg);
    const perOrg = broadcastAll(rawMsg, id); // resolves alias/group + applies each org's feed filter

    recordMessage(clientId);
    recordClientMessage(clientId, req.ip, { message, freq, protocols });

    // Geocode address first if no explicit coords, so notifications include a map link.
    // Runs once for the shared raw message, not per-org — location isn't org-specific.
    ;(async () => {
      let coordsPatch = null;
      if (!lat) {
        const result = await geocodeAddress(location.candidates || [], geocodeCountry, message).catch(() => null);
        if (result) {
          try { require('../services/database').getDb().prepare('UPDATE messages SET lat=?, lng=? WHERE id=?').run(result.lat, result.lng, id); } catch (_) {}
          broadcast({ type: 'message_location', id, lat: result.lat, lng: result.lng });
          coordsPatch = { lat: result.lat, lng: result.lng };
        }
      }
      await notifyAll(perOrg, coordsPatch);
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
  if (clientId) {
    recordClientOffline(clientId);
    unregisterSource(clientId);   // stop dead-air alerts for this client
  }
  res.json({ ok: true });
});

// GET /client/config — client polls for remote config changes
// Returns { config, version } — client restarts pipeline if version differs from its current one
router.get('/config', requireClientKey, (req, res) => {
  const clientId = req.headers['x-client-id'] || '';
  if (!clientId) return res.status(400).json({ error: 'X-Client-Id header required' });

  let liveConfig = null;
  try { if (req.query.cfg) liveConfig = JSON.parse(req.query.cfg); } catch (_) {}

  recordClientPing(clientId, req.ip, {
    freq:       req.query.freq       || null,
    protocols:  req.query.protocols  || null,
    sdrRunning: req.query.sdrRunning === 'true' ? true : req.query.sdrRunning === 'false' ? false : null,
    gitHash:    req.query.gitHash    || null,
    liveConfig,
  });

  const cfg     = getClientConfig(clientId);
  const command = popPendingCommand(clientId); // one-shot — cleared after this read

  if (!cfg) return res.json({ config: null, version: null, command: command || null });

  // The client has no DB of its own — resolve airband voiceChannelIds into full channel
  // rows (freq/mode/squelch/description) here so it can build rtl_airband's config
  // directly, mirroring what sdr.js does locally via getVoiceChannelById. Two shapes:
  // a per-device `dongles` array (multi-dongle Pis), or the flat single-dongle config
  // pushed from Admin → SDR Clients (the common case — one dongle per Pi).
  if (Array.isArray(cfg.config?.dongles)) {
    cfg.config = {
      ...cfg.config,
      dongles: cfg.config.dongles.map(d => d.mode === 'airband'
        ? { ...d, voiceChannels: (Array.isArray(d.voiceChannelIds) ? d.voiceChannelIds : []).map(getVoiceChannelById).filter(Boolean) }
        : d),
    };
  } else if (cfg.config?.mode === 'airband') {
    cfg.config = {
      ...cfg.config,
      voiceChannels: (Array.isArray(cfg.config.voiceChannelIds) ? cfg.config.voiceChannelIds : []).map(getVoiceChannelById).filter(Boolean),
    };
  }

  res.json({ ...cfg, command: command || null });
});

module.exports = router;
