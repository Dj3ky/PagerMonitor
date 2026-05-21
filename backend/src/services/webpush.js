'use strict';

const logger = require('../utils/logger');
const { getSetting, setSetting, getDb } = require('./database');

let webpush = null;
try { webpush = require('web-push'); } catch (_) {
  logger.warn('web-push not installed — browser push notifications disabled');
}

// ── VAPID ─────────────────────────────────────────────────────────────────────

function _getOrCreateVapidKeys() {
  const stored = getSetting('vapid_keys', null);
  if (stored?.publicKey && stored?.privateKey) return stored;
  const keys = webpush.generateVAPIDKeys();
  setSetting('vapid_keys', keys);
  logger.info('VAPID keys generated and stored');
  return keys;
}

function initWebPush() {
  if (!webpush) return;
  const keys = _getOrCreateVapidKeys();
  webpush.setVapidDetails('mailto:push@pagermonitor.local', keys.publicKey, keys.privateKey);
  logger.info('Web Push (VAPID) initialised');
}

function getPublicKey() {
  if (!webpush) return null;
  return _getOrCreateVapidKeys().publicKey;
}

// ── Subscriptions ─────────────────────────────────────────────────────────────

function saveSubscription(userId, sub) {
  const { endpoint, keys: { p256dh, auth } } = sub;
  getDb().prepare(`
    INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id, p256dh=excluded.p256dh, auth=excluded.auth
  `).run(userId, endpoint, p256dh, auth);
}

function removeSubscription(endpoint) {
  getDb().prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
}

// ── Send ──────────────────────────────────────────────────────────────────────

async function sendPushToAll(payload) {
  if (!webpush) return;
  const subs = getDb().prepare('SELECT * FROM push_subscriptions').all();
  if (!subs.length) return;
  await Promise.allSettled(subs.map(sub => _send(sub, payload)));
}

async function _send(sub, payload) {
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload)
    );
  } catch (err) {
    if (err.statusCode === 410 || err.statusCode === 404) {
      // Expired subscription — clean up silently
      getDb().prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(sub.endpoint);
    } else {
      logger.warn(`Push send failed: ${err.message}`);
    }
  }
}

module.exports = { initWebPush, getPublicKey, saveSubscription, removeSubscription, sendPushToAll };
