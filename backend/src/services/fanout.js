'use strict';

/**
 * Per-organization fan-out for a single ingested message.
 *
 * The raw pager feed is shared infrastructure (see database.js — messages/sdr_clients
 * aren't org-scoped), but what each org actually *sees* is not: alias/group naming,
 * the feed filter, keyword alerts, and notification destinations are all per-org.
 * routes/client.js (remote decoders) and services/sdr.js (local decoder) used to each
 * resolve alias/group + apply a single global feed filter once at ingest time, which
 * can't work once two orgs can want different things for the same message — this is
 * the one place that per-org resolution now happens, called identically from both.
 */

const { getDb, getOrganizations, getKeywordAlerts } = require('./database');
const { broadcastToOrg } = require('./websocket');
const { passesFeedFilter } = require('./config');
const { sendNotifications } = require('./notifications');
const { sendWebhooks } = require('./webhooks');
const { sendUserEmailNotifications } = require('./emailNotifier');
const { sendPushPerUser } = require('./webpush');
const logger = require('../utils/logger');

// Resolves alias/group for one capcode against one org's aliases (its own override,
// falling back to the global/shared default) — same precedence as database.js's
// ALIAS_GROUP_JOIN_SQL, just for a single in-memory message instead of a stored-rows query.
function resolveAliasGroupForOrg(rawMsg, orgId) {
  const row = getDb().prepare(`
    SELECT COALESCE(a.name, ag.name) as alias_name, COALESCE(a.color, ag.color) as alias_color,
           COALESCE(a.row_color, ag.row_color) as alias_row_color, COALESCE(a.row_sound, ag.row_sound) as alias_row_sound,
           g.id as group_id, g.name as group_name, g.color as group_color, g.row_color as group_row_color, g.row_sound as group_row_sound,
           pg.name as parent_group_name, pg.color as parent_group_color, pg.row_color as parent_group_row_color, pg.row_sound as parent_group_row_sound
    FROM (SELECT ? as capcode) src
    LEFT JOIN aliases a  ON a.capcode = src.capcode AND a.org_id = ?
    LEFT JOIN aliases ag ON ag.capcode = src.capcode AND ag.org_id IS NULL
    LEFT JOIN groups  g  ON g.id = COALESCE(a.group_id, ag.group_id)
    LEFT JOIN groups  pg ON pg.id = g.parent_id
  `).get(rawMsg.capcode, orgId);

  return {
    ...rawMsg,
    alias: row?.alias_name || null,
    alias_name: row?.alias_name || null,
    alias_color: row?.alias_color || null,
    alias_row_color: row?.alias_row_color || null,
    alias_row_sound: row?.alias_row_sound || null,
    group_id: row?.group_id ?? null,
    group_name: row?.group_name || null,
    group_color: row?.group_color || null,
    group_row_color: row?.group_row_color || null,
    group_row_sound: row?.group_row_sound || null,
    parent_group_name: row?.parent_group_name || null,
    parent_group_color: row?.parent_group_color || null,
    parent_group_row_color: row?.parent_group_row_color || null,
    parent_group_row_sound: row?.parent_group_row_sound || null,
  };
}

function matchKeywordAlerts(msg, orgId) {
  try {
    const alerts = getKeywordAlerts(orgId).filter(a => a.enabled);
    return alerts.filter(a => {
      try {
        const re = a.is_regex
          ? new RegExp(a.pattern, 'i')
          : new RegExp(a.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        return re.test(msg.message || '') || re.test(msg.capcode || '');
      } catch { return false; }
    });
  } catch (_) { return []; }
}

// Resolves, filters, and broadcasts a freshly-ingested message to every org, immediately.
// Returns { [orgId]: payload | null } (null = that org's feed filter dropped it) so the
// caller can send notifications with the same per-org payload once final coordinates are
// known (see notifyAll below) without resolving/filtering a second time.
function broadcastAll(rawMsg, id) {
  const perOrg = {};
  for (const org of getOrganizations()) {
    const msg = resolveAliasGroupForOrg(rawMsg, org.id);
    if (!passesFeedFilter(msg, org.id)) { perOrg[org.id] = null; continue; }

    const payload = { type: 'message', id, ...msg };
    perOrg[org.id] = payload;
    broadcastToOrg(org.id, payload);

    const matched = matchKeywordAlerts(msg, org.id);
    if (matched.length) broadcastToOrg(org.id, { ...payload, type: 'keyword_alert', matchedAlerts: matched });
  }
  return perOrg;
}

// Sends notifications/webhooks/email/push for a message already broadcast via broadcastAll,
// once per org that didn't have it filtered out. `coordsPatch` (optional {lat,lng}) merges
// in coordinates resolved by an async geocode lookup that completed after the initial
// broadcast — matches the original single-fire (never double-notify) behavior.
async function notifyAll(perOrgPayloads, coordsPatch) {
  const tasks = [];
  for (const [orgIdStr, payload] of Object.entries(perOrgPayloads)) {
    if (!payload) continue;
    const orgId = Number(orgIdStr);
    const notifyPayload = coordsPatch ? { ...payload, ...coordsPatch } : payload;
    tasks.push(sendNotifications(notifyPayload, orgId).catch(e => logger.warn(`Notification (org ${orgId}): ${e.message}`)));
    tasks.push(sendWebhooks(notifyPayload, orgId).catch(() => {}));
    tasks.push(sendUserEmailNotifications(notifyPayload, orgId).catch(() => {}));
    tasks.push(sendPushPerUser(notifyPayload, orgId).catch(() => {}));
  }
  await Promise.allSettled(tasks);
}

module.exports = { broadcastAll, notifyAll, resolveAliasGroupForOrg };
