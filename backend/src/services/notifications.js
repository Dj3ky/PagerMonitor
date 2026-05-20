'use strict';

const logger = require('../utils/logger');
const { getNotifConfig, saveNotifConfig, getNotifFilter } = require('./config');

let config = null;
function ensureConfig() { if (!config) config = getNotifConfig(); return config; }

const NOTIF_DEFAULTS = {
  discord:   { enabled: false, url: '' },
  telegram:  { enabled: false, token: '', chatId: '' },
  gotify:    { enabled: false, url: '', token: '', priority: 5 },
  pushover:  { enabled: false, token: '', userKey: '', priority: 0, sound: 'default' },
};

function sanitiseConfig(raw) {
  if (!raw || typeof raw !== 'object') return JSON.parse(JSON.stringify(NOTIF_DEFAULTS));
  const out = {};
  for (const svc of ['discord', 'telegram', 'gotify', 'pushover']) {
    const src = (raw[svc] && typeof raw[svc] === 'object') ? raw[svc] : {};
    out[svc]  = { ...NOTIF_DEFAULTS[svc], ...src };
  }
  return out;
}

function getConfig() { return sanitiseConfig(ensureConfig()); }
function updateConfig(patch) {
  const current = sanitiseConfig(ensureConfig());
  const next = { ...current };
  for (const svc of ['discord', 'telegram', 'gotify', 'pushover']) {
    if (patch[svc] && typeof patch[svc] === 'object') next[svc] = { ...current[svc], ...patch[svc] };
  }
  config = next;
  saveNotifConfig(config);
}

function passesFilter(msg) {
  try {
    const filter = getNotifFilter();
    if (!filter || filter.mode === 'all') return true;
    if (filter.mode === 'filtered') {
      const capcodes = Array.isArray(filter.capcodes) ? filter.capcodes : [];
      return capcodes.includes(msg.capcode);
    }
    return true;
  } catch (_) { return true; }
}

// ── Shared message builder ────────────────────────────────────────────────────
function buildParts(msg) {
  const alias     = msg.alias_name || msg.alias || null;
  const group     = msg.group_name || msg.parent_group_name || null;
  const hasCoords = msg.lat && msg.lng && !isNaN(msg.lat) && !isNaN(msg.lng);
  const mapsUrl   = hasCoords
    ? `https://www.google.com/maps?q=${msg.lat},${msg.lng}`
    : null;
  const d  = new Date(msg.timestamp);
  const ts = `${String(d.getDate()).padStart(2,'0')}.${String(d.getMonth()+1).padStart(2,'0')}.${d.getFullYear()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;
  return { alias, group, hasCoords, mapsUrl, ts };
}

// ── Discord ───────────────────────────────────────────────────────────────────
async function sendDiscord(msg, cfg) {
  const { alias, group, mapsUrl, ts } = buildParts(msg);

  const fields = [];
  if (alias) fields.push({ name: '🏷 Alias', value: alias, inline: true });
  if (group) fields.push({ name: '📁 Group', value: group, inline: true });
  fields.push({ name: '🕐 Time', value: ts, inline: true });
  if (mapsUrl) fields.push({ name: '📍 Location', value: `[Open in Google Maps](${mapsUrl})`, inline: false });

  const embed = {
    title:       `📟 ${msg.capcode}${alias ? ` — ${alias}` : ''}`,
    description: msg.message || '*(no text)*',
    color:       0x00ff9d,
    fields,
    footer:      { text: 'PagerMonitor' },
    timestamp:   msg.timestamp,
  };

  const res = await fetch(cfg.url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ embeds: [embed], username: 'PagerMonitor' }),
  });
  if (!res.ok) { const b = await res.text().catch(() => ''); throw new Error(`Discord ${res.status}: ${b}`); }
}

// ── Telegram ──────────────────────────────────────────────────────────────────
async function sendTelegram(msg, cfg) {
  const { alias, group, mapsUrl, ts } = buildParts(msg);

  const lines = [];
  lines.push(`📟 *${escMd(msg.capcode)}*${alias ? ` — *${escMd(alias)}*` : ''}`);
  if (group) lines.push(`📁 ${escMd(group)}`);
  lines.push('');
  lines.push(escMd(msg.message || '_(no text)_'));
  lines.push('');
  lines.push(ts);
  if (mapsUrl) lines.push(`📍 [Open in Google Maps](${mapsUrl})`);

  const res = await fetch(`https://api.telegram.org/bot${cfg.token}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id:    cfg.chatId,
      text:       lines.join('\n'),
      parse_mode: 'MarkdownV2',
      disable_web_page_preview: true,
    }),
  });
  if (!res.ok) { const b = await res.json().catch(() => ({})); throw new Error(`Telegram ${res.status}: ${b.description || ''}`); }
}

function escMd(text) {
  // Escape MarkdownV2 special chars
  return String(text || '').replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}

// ── Gotify ────────────────────────────────────────────────────────────────────
async function sendGotify(msg, cfg) {
  const { alias, group, mapsUrl, ts } = buildParts(msg);

  const lines = [];
  if (alias) lines.push(`Alias: ${alias}`);
  if (group) lines.push(`Group: ${group}`);
  lines.push(`Time: ${ts}`);
  if (mapsUrl) lines.push(`Location: ${mapsUrl}`);

  const base = cfg.url.replace(/\/+$/, '');
  const res  = await fetch(`${base}/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Gotify-Key': cfg.token },
    body: JSON.stringify({
      title:    `📟 ${msg.capcode}${alias ? ` — ${alias}` : ''}`,
      message:  (msg.message || '(no text)') + '\n\n' + lines.join('\n'),
      priority: Number(cfg.priority) || 5,
      extras: { 'client::display': { contentType: 'text/plain' } },
    }),
  });
  if (!res.ok) { const b = await res.text().catch(() => ''); throw new Error(`Gotify ${res.status}: ${b}`); }
}

// ── Pushover ──────────────────────────────────────────────────────────────────
async function sendPushover(msg, cfg) {
  const { alias, group, mapsUrl, ts } = buildParts(msg);

  const titleParts = [`📟 ${msg.capcode}`];
  if (alias) titleParts.push(alias);
  if (group) titleParts.push(`(${group})`);

  const bodyParts = [msg.message || '(no text)', ''];
  if (alias) bodyParts.push(`Alias: ${alias}`);
  if (group) bodyParts.push(`Group: ${group}`);
  bodyParts.push(`Time: ${ts}`);

  const params = new URLSearchParams({
    token:    cfg.token,
    user:     cfg.userKey,
    title:    titleParts.join(' — '),
    message:  bodyParts.filter(Boolean).join('\n'),
    priority: String(Number(cfg.priority) || 0),
    sound:    cfg.sound || 'default',
  });

  // Add Google Maps URL if coordinates available
  if (mapsUrl) {
    params.set('url',       mapsUrl);
    params.set('url_title', 'Open in Google Maps');
  }

  const res = await fetch('https://api.pushover.net/1/messages.json', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:   params.toString(),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok || d.status !== 1) throw new Error(`Pushover error: ${d.errors?.join(', ') || res.status}`);
}

// ── Send all ──────────────────────────────────────────────────────────────────
async function sendNotifications(msg) {
  if (!passesFilter(msg)) return;
  const c = sanitiseConfig(ensureConfig());
  const tasks = [];
  if (c.discord?.enabled  && c.discord?.url)                            tasks.push(sendDiscord(msg,   c.discord));
  if (c.telegram?.enabled && c.telegram?.token && c.telegram?.chatId)   tasks.push(sendTelegram(msg,  c.telegram));
  if (c.gotify?.enabled   && c.gotify?.url     && c.gotify?.token)      tasks.push(sendGotify(msg,    c.gotify));
  if (c.pushover?.enabled && c.pushover?.token && c.pushover?.userKey)  tasks.push(sendPushover(msg,  c.pushover));
  if (tasks.length) await Promise.allSettled(tasks);
}

async function testNotification(service) {
  const c = sanitiseConfig(ensureConfig());
  const dummy = {
    capcode: '0000001', alias: 'Fire Station Alpha', alias_name: 'Fire Station Alpha',
    group_name: 'Fire Department',
    protocol: 'POCSAG1200', baud: 1200,
    message: 'Test notification from PagerMonitor ✓',
    timestamp: new Date().toISOString(),
    lat: 46.0569, lng: 14.5058,  // Ljubljana coords for testing the maps link
  };
  switch (service) {
    case 'discord':  return sendDiscord(dummy,   c.discord);
    case 'telegram': return sendTelegram(dummy,  c.telegram);
    case 'gotify':   return sendGotify(dummy,    c.gotify);
    case 'pushover': return sendPushover(dummy,  c.pushover);
    default: throw new Error(`Unknown service: ${service}`);
  }
}

module.exports = { sendNotifications, getConfig, updateConfig, testNotification };
