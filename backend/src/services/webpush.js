'use strict';

const logger = require('../utils/logger');
const { getSetting, setSetting, getDb, normCapcode } = require('./database');

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

// Called once per org per ingested message (see services/fanout.js) — only that org's
// members' subscriptions are eligible.
async function sendPushPerUser(msg, orgId) {
  if (!webpush) return;
  const subs = getDb().prepare(`
    SELECT ps.*, unp.push_enabled, unp.push_mode,
           unp.push_group_ids, unp.push_capcodes, unp.push_keywords
    FROM push_subscriptions ps
    JOIN users u ON u.id = ps.user_id AND u.org_id = ?
    LEFT JOIN user_notif_prefs unp ON unp.user_id = ps.user_id
  `).all(orgId);
  if (!subs.length) return;

  const alias = msg.alias_name || msg.alias || msg.capcode;
  const payload = {
    title: `📟 ${alias}`,
    body:  msg.message || '(tone / numeric only)',
    tag:   `pm-${msg.capcode}`,
    data:  { capcode: msg.capcode, timestamp: msg.timestamp },
  };

  const eligible = subs.filter(sub => _matchesPushPrefs(msg, sub));
  await Promise.allSettled(eligible.map(sub => _send(sub, payload)));
}

function _matchesPushPrefs(msg, sub) {
  // No prefs row means the user never configured prefs — default to send all
  if (sub.push_enabled === null || sub.push_enabled === undefined) return true;
  if (!sub.push_enabled) return false;
  const mode = sub.push_mode || 'all';
  if (mode === 'all') return true;
  if (mode === 'groups') {
    const ids = JSON.parse(sub.push_group_ids || '[]').map(Number);
    return msg.group_id != null && ids.includes(Number(msg.group_id));
  }
  if (mode === 'aliases' || mode === 'capcodes') {
    const caps = JSON.parse(sub.push_capcodes || '[]').map(normCapcode);
    return caps.includes(normCapcode(String(msg.capcode)));
  }
  if (mode === 'keywords') {
    const kws  = JSON.parse(sub.push_keywords || '[]');
    const text = (msg.message || '').toLowerCase();
    return kws.some(kw => kw && text.includes(kw.toLowerCase()));
  }
  return true;
}

async function _send(sub, payload) {
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload),
      { TTL: 86400, urgency: 'high' }  // high urgency = FCM wakes Android from Doze immediately
    );
  } catch (err) {
    if (err.statusCode === 410 || err.statusCode === 404) {
      getDb().prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(sub.endpoint);
    } else {
      logger.warn(`Push send failed: ${err.message}`);
    }
  }
}

module.exports = { initWebPush, getPublicKey, saveSubscription, removeSubscription, sendPushPerUser };
