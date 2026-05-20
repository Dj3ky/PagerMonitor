'use strict';

/**
 * Per-user email notifications.
 * Called after each message — checks each user's preferences and sends email if they match.
 */

const { getAllUsersWithPrefs } = require('./database');
const { sendEmail, getEmailConfig } = require('./email');
const logger = require('../utils/logger');

function messageMatchesPrefs(msg, prefs) {
  if (!prefs.enabled) return false;
  if (prefs.mode === 'all') return true;

  if (prefs.mode === 'groups') {
    const gid = msg.group_id;
    return gid && prefs.group_ids.includes(Number(gid));
  }

  if (prefs.mode === 'aliases') {
    // aliases mode reuses capcodes array — stores selected capcodes from alias picker
    return (prefs.capcodes || []).includes(msg.capcode);
  }

  if (prefs.mode === 'capcodes') {
    return (prefs.capcodes || []).includes(msg.capcode);
  }

  if (prefs.mode === 'keywords') {
    const text = (msg.message || '').toLowerCase();
    return prefs.keywords.some(kw => kw && text.includes(kw.toLowerCase()));
  }

  return false;
}

function buildEmailBody(msg) {
  const alias     = msg.alias_name || msg.alias || null;
  const group     = msg.group_name || msg.parent_group_name || null;
  const hasCoords = msg.lat && msg.lng && !isNaN(msg.lat) && !isNaN(msg.lng);
  const mapsUrl   = hasCoords
    ? `https://www.google.com/maps?q=${msg.lat},${msg.lng}`
    : null;
  const d         = new Date(msg.timestamp);
  const ts        = `${String(d.getDate()).padStart(2,'0')}.${String(d.getMonth()+1).padStart(2,'0')}.${d.getFullYear()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;

  const textParts = [
    `📟 ${alias || msg.capcode}${group ? ` (${group})` : ''}`,
    `Capcode: ${msg.capcode}`,
    alias ? `Alias: ${alias}` : null,
    group ? `Group: ${group}` : null,
    `Time: ${ts}`,
    mapsUrl ? `Location: ${mapsUrl}` : null,
    '',
    msg.message || '(no text)',
  ].filter(l => l !== null);

  const html = `
    <div style="font-family:monospace;max-width:520px;padding:16px;background:#111;color:#eee;border-radius:8px">
      <div style="color:#00ff9d;font-weight:bold;font-size:1rem;margin-bottom:4px">
        📟 ${alias || msg.capcode}
      </div>
      ${alias ? `<div style="color:#888;font-size:0.8rem">${msg.capcode}</div>` : ''}
      ${group ? `<div style="color:#a855f7;font-size:0.78rem;margin-top:2px">📁 ${group}</div>` : ''}
      <div style="color:#888;font-size:0.75rem;margin:8px 0 4px">${ts}</div>
      <div style="background:#1a1a1a;padding:10px;border-radius:4px;border-left:3px solid #00ff9d;
                  word-break:break-word;margin-bottom:12px">
        ${msg.message || '<em>(no text)</em>'}
      </div>
      ${mapsUrl ? `
        <a href="${mapsUrl}"
           style="display:inline-block;padding:8px 16px;background:#1976d2;color:#fff;
                  text-decoration:none;border-radius:6px;font-size:0.85rem;font-weight:bold">
          📍 Open in Google Maps
        </a>
      ` : ''}
    </div>
  `;

  return { text: textParts.join('\n'), html };
}

async function sendUserEmailNotifications(msg) {
  const cfg = getEmailConfig();
  if (!cfg.enabled || !cfg.host) return;

  let users;
  try { users = getAllUsersWithPrefs(); } catch { return; }

  const eligible = users.filter(u => u.email && messageMatchesPrefs(msg, u.prefs));
  if (!eligible.length) return;

  const alias   = msg.alias_name || msg.alias || msg.capcode;
  const subject = `📟 PagerMonitor — ${alias}: ${(msg.message || '').substring(0, 60)}`;
  const { text, html } = buildEmailBody(msg);

  await Promise.allSettled(eligible.map(u =>
    sendEmail({ to: u.email, subject, text, html })
      .catch(e => logger.warn(`Email to ${u.email} failed: ${e.message}`))
  ));
}

module.exports = { sendUserEmailNotifications };
