'use strict';

const path = require('path');
const fs = require('fs');
const logger = require('../utils/logger');
const { getDb } = require('./database');
const { _matchesPushPrefs, _matchesAlertPrefs } = require('./webpush');

let admin = null;
try { admin = require('firebase-admin'); } catch (_) {
  logger.warn('firebase-admin not installed — native Android push notifications disabled');
}

let app = null;

// Native Android app background notifications (see frontend's usePushSubscription
// native branch). Separate delivery path from web-push, but shares the same
// user_notif_prefs.push_* filtering — a user's push preference applies regardless
// of whether delivery ends up going out as Web Push or FCM.
function initFcm() {
  if (!admin) return;
  const credPath = path.resolve(process.env.FCM_SERVICE_ACCOUNT_PATH || './fcm-service-account.json');
  if (!fs.existsSync(credPath)) {
    logger.warn(`FCM service account not found at ${credPath} — native Android push disabled`);
    return;
  }
  try {
    app = admin.initializeApp({ credential: admin.credential.cert(require(credPath)) }, 'pagermonitor-fcm');
    logger.info('FCM (native Android push) initialised');
  } catch (err) {
    logger.warn(`FCM init failed: ${err.message}`);
  }
}

function saveToken(userId, token, label) {
  getDb().prepare(`
    INSERT INTO fcm_tokens (user_id, token, label)
    VALUES (?, ?, ?)
    ON CONFLICT(token) DO UPDATE SET user_id = excluded.user_id, label = excluded.label
  `).run(userId, token, label || null);
}

function removeToken(token) {
  getDb().prepare('DELETE FROM fcm_tokens WHERE token = ?').run(token);
}

// Listed alongside web push subscriptions (see webpush.js's listSubscriptions) as one
// combined "your devices" view in the profile panel.
function listTokens(userId) {
  return getDb().prepare('SELECT id, label, created_at FROM fcm_tokens WHERE user_id = ? ORDER BY created_at DESC').all(userId);
}

// Scoped to userId so a user can only revoke their own device, even though the id alone
// (an autoincrement PK) doesn't imply ownership.
function removeTokenById(userId, id) {
  getDb().prepare('DELETE FROM fcm_tokens WHERE id = ? AND user_id = ?').run(id, userId);
}

// Called once per org per ingested message (see services/fanout.js) — mirrors sendPushPerUser.
async function sendFcmPerUser(msg, orgId) {
  if (!app) return;
  const rows = getDb().prepare(`
    SELECT ft.*, unp.push_enabled, unp.push_mode,
           unp.push_group_ids, unp.push_capcodes, unp.push_keywords
    FROM fcm_tokens ft
    JOIN users u ON u.id = ft.user_id AND u.org_id = ?
    LEFT JOIN user_notif_prefs unp ON unp.user_id = ft.user_id
  `).all(orgId);
  if (!rows.length) return;

  const alias = msg.alias_name || msg.alias || msg.capcode;
  const eligible = rows.filter(row => _matchesPushPrefs(msg, row));
  await Promise.allSettled(eligible.map(row => _send(row.token, {
    title: `📟 ${alias}`,
    body:  msg.message || '(tone / numeric only)',
    tag:   `pm-${msg.capcode}`,
    data:  { capcode: String(msg.capcode), timestamp: String(msg.timestamp) },
  })));
}

// Separate, opt-in tier — see user_notif_prefs.alert_* and _matchesAlertPrefs. Routed to
// a distinct Android notification channel (pm_alert) so it can carry its own sound and,
// once the user grants Do Not Disturb access to the app, break through silent/DND —
// something the regular pm_messages channel deliberately does not do.
async function sendAlertPerUser(msg, orgId) {
  if (!app) return;
  const rows = getDb().prepare(`
    SELECT ft.*, unp.alert_enabled, unp.alert_mode,
           unp.alert_group_ids, unp.alert_capcodes, unp.alert_keywords
    FROM fcm_tokens ft
    JOIN users u ON u.id = ft.user_id AND u.org_id = ?
    LEFT JOIN user_notif_prefs unp ON unp.user_id = ft.user_id
  `).all(orgId);
  if (!rows.length) return;

  const alias = msg.alias_name || msg.alias || msg.capcode;
  const eligible = rows.filter(row => _matchesAlertPrefs(msg, row));
  await Promise.allSettled(eligible.map(row => _send(row.token, {
    title: `🚨 ${alias}`,
    body:  msg.message || '(tone / numeric only)',
    tag:   `pm-alert-${msg.capcode}`,
    data:  { capcode: String(msg.capcode), timestamp: String(msg.timestamp) },
    channelId: 'pm_alert',
  })));
}

async function sendTest(userId) {
  if (!app) return 0;
  const rows = getDb().prepare('SELECT token FROM fcm_tokens WHERE user_id = ?').all(userId);
  let sent = 0;
  await Promise.allSettled(rows.map(async row => {
    try {
      await _send(row.token, {
        title: '📟 PagerMonitor',
        body:  '✅ Push notifications are working on this device!',
        tag:   'pm-test',
        data:  {},
      });
      sent++;
    } catch (_) {}
  }));
  return sent;
}

async function _send(token, { title, body, tag, data, channelId = 'pm_messages' }) {
  try {
    await admin.messaging(app).send({
      token,
      notification: { title, body },
      data,
      android: {
        priority: 'high',
        collapseKey: tag,
        notification: { channelId, tag },
      },
    });
  } catch (err) {
    if (err.code === 'messaging/registration-token-not-registered' || err.code === 'messaging/invalid-registration-token') {
      getDb().prepare('DELETE FROM fcm_tokens WHERE token = ?').run(token);
    } else {
      logger.warn(`FCM send failed: ${err.message}`);
    }
  }
}

module.exports = { initFcm, saveToken, removeToken, listTokens, removeTokenById, sendFcmPerUser, sendAlertPerUser, sendTest };
