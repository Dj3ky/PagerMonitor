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
    ['messages_today',  'INTEGER NOT NULL DEFAULT 0'],
    ['today_date',      "TEXT NOT NULL DEFAULT (date('now'))"],
    ['freq',            'TEXT'],
    ['protocols',       'TEXT'],
    ['last_message',    'TEXT'],
    ['last_message_ts', 'TEXT'],
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
    getDb().prepare(`
      INSERT INTO sdr_clients (id, last_seen, ip, freq, protocols)
      VALUES (?, datetime('now'), ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        last_seen = datetime('now'),
        ip        = COALESCE(excluded.ip, ip),
        freq      = COALESCE(excluded.freq, freq),
        protocols = COALESCE(excluded.protocols, protocols)
    `).run(clientId, ip || null, extra.freq || null, extra.protocols || null);
  } catch (e) {
    logger.warn(`clientTracker.recordClientPing: ${e.message}`);
  }
}

// ── Get all clients ───────────────────────────────────────────────────────────
function getClients() {
  try {
    ensureTables();
    const rows = getDb().prepare('SELECT * FROM sdr_clients ORDER BY last_seen DESC').all();
    const now  = Date.now();
    return rows.map(r => {
      const lastMs = new Date(r.last_seen).getTime();
      return {
        id:             r.id,
        firstSeen:      r.first_seen,
        lastSeen:       r.last_seen,
        messageCount:   r.message_count,
        messagesToday:  r.messages_today || 0,
        ip:             r.ip || null,
        freq:           r.freq || null,
        protocols:      r.protocols || null,
        lastMessage:    r.last_message || null,
        lastMessageTs:  r.last_message_ts || null,
        online:         (now - lastMs) < 5 * 60 * 1000,
        silentSec:      Math.round((now - lastMs) / 1000),
      };
    });
  } catch (e) {
    logger.warn(`clientTracker.getClients: ${e.message}`);
    return [];
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
    const json    = JSON.stringify(config);
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

module.exports = {
  recordClientMessage, recordClientPing,
  getClients, resetClient,
  getClientConfig, getAllClientConfigs, saveClientConfig,
};
