'use strict';

const { getDb } = require('./database');
const crypto    = require('crypto');
const logger    = require('../utils/logger');

function ensureTables() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS sdr_clients (
      id              TEXT    PRIMARY KEY,
      first_seen      TEXT    NOT NULL DEFAULT (datetime('now')),
      last_seen       TEXT    NOT NULL DEFAULT (datetime('now')),
      message_count   INTEGER NOT NULL DEFAULT 0,
      messages_today  INTEGER NOT NULL DEFAULT 0,
      today_date      TEXT    NOT NULL DEFAULT (date('now')),
      ip              TEXT,
      freq            TEXT,
      protocols       TEXT,
      last_message    TEXT,
      last_message_ts TEXT
    );

    CREATE TABLE IF NOT EXISTS client_configs (
      client_id   TEXT    PRIMARY KEY,
      config_json TEXT    NOT NULL DEFAULT '{}',
      version     TEXT    NOT NULL DEFAULT '',
      updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Migrate: add new columns if missing
  const cols = db.prepare("PRAGMA table_info(sdr_clients)").all().map(c => c.name);
  for (const [col, def] of [
    ['messages_today',   'INTEGER NOT NULL DEFAULT 0'],
    ['today_date',       "TEXT NOT NULL DEFAULT (date('now'))"],
    ['freq',             'TEXT'],
    ['protocols',        'TEXT'],
    ['last_message',     'TEXT'],
    ['last_message_ts',  'TEXT'],
    ['sdr_running',      'INTEGER'],
    ['pending_command',  'TEXT'],
    ['live_config',      'TEXT'],
    ['git_hash',         'TEXT'],
    ['display_name',     'TEXT'],
  ]) {
    if (!cols.includes(col)) {
      db.exec(`ALTER TABLE sdr_clients ADD COLUMN ${col} ${def}`);
      logger.info(`Migration: added ${col} to sdr_clients`);
    }
  }
}

// ── Record incoming message ───────────────────────────────────────────────────
function recordClientMessage(clientId, ip, extra = {}) {
  if (!clientId) return;
  try {
    ensureTables();
    const db      = getDb();
    const today   = new Date().toISOString().slice(0, 10);
    const msgText = (extra.message || '').substring(0, 120);

    db.prepare(`
      INSERT INTO sdr_clients (id, last_seen, message_count, messages_today, today_date, ip, freq, protocols, last_message, last_message_ts)
      VALUES (?, datetime('now'), 1, 1, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        last_seen       = datetime('now'),
        message_count   = message_count + 1,
        messages_today  = CASE WHEN today_date = excluded.today_date THEN messages_today + 1 ELSE 1 END,
        today_date      = excluded.today_date,
        ip              = COALESCE(excluded.ip, ip),
        freq            = COALESCE(excluded.freq, freq),
        protocols       = COALESCE(excluded.protocols, protocols),
        last_message    = excluded.last_message,
        last_message_ts = datetime('now')
    `).run(clientId, today, ip || null, extra.freq || null, extra.protocols || null, msgText || null);
  } catch (e) {
    logger.warn(`clientTracker.recordClientMessage: ${e.message}`);
  }
}

// ── Record status ping (no message) ──────────────────────────────────────────
function recordClientPing(clientId, ip, extra = {}) {
  if (!clientId) return;
  try {
    ensureTables();
    const sdrRunning  = extra.sdrRunning != null ? (extra.sdrRunning ? 1 : 0) : null;
    const liveConfig  = extra.liveConfig ? JSON.stringify(extra.liveConfig) : null;
    getDb().prepare(`
      INSERT INTO sdr_clients (id, last_seen, ip, freq, protocols, sdr_running, live_config, git_hash)
      VALUES (?, datetime('now'), ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        last_seen   = datetime('now'),
        ip          = COALESCE(excluded.ip, ip),
        freq        = COALESCE(excluded.freq, freq),
        protocols   = COALESCE(excluded.protocols, protocols),
        sdr_running = COALESCE(excluded.sdr_running, sdr_running),
        live_config = COALESCE(excluded.live_config, live_config),
        git_hash    = COALESCE(excluded.git_hash, git_hash)
    `).run(clientId, ip || null, extra.freq || null, extra.protocols || null, sdrRunning, liveConfig, extra.gitHash || null);
  } catch (e) {
    logger.warn(`clientTracker.recordClientPing: ${e.message}`);
  }
}

// ── Get all clients ───────────────────────────────────────────────────────────
function getClients() {
  try {
    ensureTables();
    const rows = getDb().prepare('SELECT * FROM sdr_clients').all();
    const now  = Date.now();
    const clients = rows.map(r => {
      // SQLite datetime('now') is UTC without 'Z' — append Z so JS parses as UTC
      const tsStr  = r.last_seen?.includes('T') ? r.last_seen : (r.last_seen || '').replace(' ', 'T') + 'Z';
      const lastMs = new Date(tsStr).getTime();
      return {
        id:              r.id,
        displayName:     r.display_name || null,
        firstSeen:       r.first_seen,
        lastSeen:        r.last_seen,
        messageCount:    r.message_count,
        messagesToday:   r.messages_today || 0,
        ip:              r.ip || null,
        freq:            r.freq || null,
        protocols:       r.protocols || null,
        lastMessage:     r.last_message || null,
        lastMessageTs:   r.last_message_ts || null,
        online:          (now - lastMs) < 90 * 1000,
        silentSec:       Math.round((now - lastMs) / 1000),
        sdrRunning:      r.sdr_running == null ? null : r.sdr_running === 1,
        pendingCommand:  r.pending_command || null,
        liveConfig:      r.live_config ? JSON.parse(r.live_config) : null,
        gitHash:         r.git_hash || null,
      };
    });
    // Online clients first (stable), offline last. Within each group, sort by
    // name rather than last_seen so the list doesn't reshuffle on every ping.
    clients.sort((a, b) => {
      if (a.online !== b.online) return a.online ? -1 : 1;
      return (a.displayName || a.id).localeCompare(b.displayName || b.id);
    });
    return clients;
  } catch (e) {
    logger.warn(`clientTracker.getClients: ${e.message}`);
    return [];
  }
}

function recordClientOffline(clientId) {
  if (!clientId) return;
  try {
    ensureTables();
    getDb().prepare(`UPDATE sdr_clients SET last_seen = '1970-01-01 00:00:00' WHERE id = ?`).run(clientId);
  } catch (e) {
    logger.warn(`clientTracker.recordClientOffline: ${e.message}`);
  }
}

function setDisplayName(id, name) {
  try {
    ensureTables();
    getDb().prepare('UPDATE sdr_clients SET display_name = ? WHERE id = ?').run(name || null, id);
  } catch (e) {
    logger.warn(`clientTracker.setDisplayName: ${e.message}`);
  }
}

function resetClient(id) {
  try {
    ensureTables();
    getDb().prepare('DELETE FROM sdr_clients WHERE id=?').run(id);
    getDb().prepare('DELETE FROM client_configs WHERE client_id=?').run(id);
  } catch (e) {
    logger.warn(`clientTracker.resetClient: ${e.message}`);
  }
}

// ── Per-client config ─────────────────────────────────────────────────────────
function getClientConfig(clientId) {
  try {
    ensureTables();
    const row = getDb().prepare('SELECT * FROM client_configs WHERE client_id=?').get(clientId);
    if (!row) return null;
    return { config: JSON.parse(row.config_json || '{}'), version: row.version };
  } catch (e) {
    logger.warn(`clientTracker.getClientConfig: ${e.message}`);
    return null;
  }
}

function getAllClientConfigs() {
  try {
    ensureTables();
    return getDb().prepare('SELECT * FROM client_configs ORDER BY client_id').all().map(r => ({
      clientId:  r.client_id,
      config:    JSON.parse(r.config_json || '{}'),
      version:   r.version,
      updatedAt: r.updated_at,
    }));
  } catch (e) { return []; }
}

function saveClientConfig(clientId, config) {
  try {
    ensureTables();
    // Strip empty/null values — empty means "use Pi's .env default"
    const filtered = Object.fromEntries(
      Object.entries(config).filter(([, v]) => v !== '' && v != null)
    );
    const json    = JSON.stringify(filtered);
    const version = crypto.createHash('sha256').update(json).digest('hex').slice(0, 8);
    getDb().prepare(`
      INSERT INTO client_configs (client_id, config_json, version, updated_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(client_id) DO UPDATE SET
        config_json = excluded.config_json,
        version     = excluded.version,
        updated_at  = datetime('now')
    `).run(clientId, json, version);
    return version;
  } catch (e) {
    logger.warn(`clientTracker.saveClientConfig: ${e.message}`);
    return null;
  }
}

// ── Pending commands (remote update, etc.) ────────────────────────────────────
function setPendingCommand(clientId, command) {
  if (!clientId) return;
  try {
    ensureTables();
    getDb().prepare('UPDATE sdr_clients SET pending_command = ? WHERE id = ?').run(command, clientId);
  } catch (e) {
    logger.warn(`clientTracker.setPendingCommand: ${e.message}`);
  }
}

/** Atomically read + clear the pending command — returns null if none. */
function popPendingCommand(clientId) {
  if (!clientId) return null;
  try {
    ensureTables();
    const db  = getDb();
    const row = db.prepare('SELECT pending_command FROM sdr_clients WHERE id = ?').get(clientId);
    if (!row || !row.pending_command) return null;
    db.prepare('UPDATE sdr_clients SET pending_command = NULL WHERE id = ?').run(clientId);
    return row.pending_command;
  } catch (e) {
    logger.warn(`clientTracker.popPendingCommand: ${e.message}`);
    return null;
  }
}

module.exports = {
  recordClientMessage, recordClientPing, recordClientOffline,
  getClients, resetClient, setDisplayName,
  getClientConfig, getAllClientConfigs, saveClientConfig,
  setPendingCommand, popPendingCommand,
};
