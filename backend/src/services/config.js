const { getSetting, setSetting, normCapcode, groupMatchesSelection } = require('./database');
const logger = require('../utils/logger');

// Org-scoped settings (feed filter, notification filter/destinations) live under a
// composite key instead of a new column — keeps the flat settings(key,value) table
// as-is, and every instance-wide setting (SDR, email, dedup, etc.) keeps its bare key.
const orgKey = (orgId, base) => `org:${orgId}:${base}`;

const SDR_KEYS = [
  'RTL_FM_FREQ','RTL_FM_MODULATION','RTL_FM_SAMPLE_RATE','RTL_FM_GAIN',
  'RTL_FM_DEVICE_INDEX','RTL_FM_PPM','RTL_FM_SQUELCH','RTL_FM_RESAMPLE_RATE',
  'RTL_FM_LOWPASS','RTL_FM_TUNER_BANDWIDTH','RTL_FM_DIRECT_SAMPLING','RTL_FM_OFFSET_TUNING',
  'MULTIMON_PROTOCOLS','MULTIMON_VERBOSITY','MULTIMON_QUIET','MULTIMON_INPUT_FORMAT',
  'MULTIMON_POCSAG_SPECIAL','MULTIMON_POCSAG_CHARSET',
];

// ── SDR ───────────────────────────────────────────────────────────────────────
function getSdrConfig() {
  const stored = getSetting('sdr_config', null);
  if (stored && typeof stored === 'object' && !Array.isArray(stored)) return stored;
  const cfg = {};
  SDR_KEYS.forEach(k => { cfg[k] = process.env[k] || ''; });
  return cfg;
}

function saveSdrConfig(cfg) {
  for (const [k, v] of Object.entries(cfg)) {
    if (SDR_KEYS.includes(k)) process.env[k] = String(v);
  }
  setSetting('sdr_config', cfg);
  logger.info('SDR config saved');
}

// ── Dongle configs (multi-SDR) ────────────────────────────────────────────────
function getDongleConfigs() {
  return getSetting('dongle_configs', null);  // null = single dongle mode
}

function saveDongleConfigs(dongles) {
  // null or empty array = single dongle mode (use main sdr_config)
  setSetting('dongle_configs', (Array.isArray(dongles) && dongles.length > 0) ? dongles : null);
  logger.info(`Dongle configs saved: ${dongles?.length || 0} dongles`);
}

function loadSdrConfigIntoEnv() {
  const cfg = getSdrConfig();
  for (const [k, v] of Object.entries(cfg)) {
    if (v && SDR_KEYS.includes(k)) process.env[k] = String(v);
  }
  logger.info('SDR config loaded into env');

  // Cleanup corrupt dedup_config
  try {
    const raw = getSetting('dedup_config', null);
    if (raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) {
      logger.warn(`Resetting corrupt dedup_config`);
      setSetting('dedup_config', DEDUP_DEFAULTS);
    }
  } catch (_) {}
}

// ── Notifications ─────────────────────────────────────────────────────────────
const NOTIF_DEFAULTS = {
  discord:  { enabled: false, url: '' },
  telegram: { enabled: false, token: '', chatId: '' },
  gotify:   { enabled: false, url: '', token: '', priority: 5 },
};

function getNotifConfig(orgId) {
  const stored = getSetting(orgKey(orgId, 'notif_config'), null);
  if (!stored || typeof stored !== 'object') {
    return {
      discord:  { enabled: !!process.env.DISCORD_WEBHOOK_URL,  url: process.env.DISCORD_WEBHOOK_URL||'' },
      telegram: { enabled: !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID),
                  token: process.env.TELEGRAM_BOT_TOKEN||'', chatId: process.env.TELEGRAM_CHAT_ID||'' },
      gotify:   { enabled: !!(process.env.GOTIFY_URL && process.env.GOTIFY_TOKEN),
                  url: process.env.GOTIFY_URL||'', token: process.env.GOTIFY_TOKEN||'',
                  priority: parseInt(process.env.GOTIFY_PRIORITY||'5',10) },
    };
  }
  return stored;
}
function saveNotifConfig(orgId, cfg) { setSetting(orgKey(orgId, 'notif_config'), cfg); logger.info(`Notification config saved (org=${orgId})`); }

// ── Notification filter ───────────────────────────────────────────────────────
// Applies to: Discord, Telegram, Gotify, Pushover, MQTT only.
// mode: 'all' | 'groups' | 'aliases' | 'capcodes' | 'keywords'
const NOTIF_FILTER_MODES = ['all', 'groups', 'aliases', 'capcodes', 'keywords'];
const NOTIF_FILTER_DEFAULTS = { mode: 'all', group_ids: [], capcodes: [], keywords: [] };

function getNotifFilter(orgId) {
  const raw = getSetting(orgKey(orgId, 'notif_filter'), null);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...NOTIF_FILTER_DEFAULTS };
  return {
    mode:      NOTIF_FILTER_MODES.includes(raw.mode) ? raw.mode : 'all',
    group_ids: Array.isArray(raw.group_ids) ? raw.group_ids.map(Number) : [],
    capcodes:  Array.isArray(raw.capcodes)  ? raw.capcodes.map(c => normCapcode(String(c)))  : [],
    keywords:  Array.isArray(raw.keywords)  ? raw.keywords  : [],
  };
}
function saveNotifFilter(orgId, cfg) {
  setSetting(orgKey(orgId, 'notif_filter'), {
    mode:      NOTIF_FILTER_MODES.includes(cfg.mode) ? cfg.mode : 'all',
    group_ids: Array.isArray(cfg.group_ids) ? cfg.group_ids.map(Number) : [],
    capcodes:  Array.isArray(cfg.capcodes)  ? cfg.capcodes.map(c => normCapcode(String(c)))  : [],
    keywords:  Array.isArray(cfg.keywords)  ? cfg.keywords.map(String)  : [],
  });
  logger.info(`Notification filter saved (org=${orgId})`);
}

// ── Dedup ─────────────────────────────────────────────────────────────────────
const DEDUP_DEFAULTS = { enabled: true, windowSeconds: 30 };

function getDedupConfig() {
  const raw = getSetting('dedup_config', null);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...DEDUP_DEFAULTS };
  return {
    enabled:       typeof raw.enabled === 'boolean' ? raw.enabled : DEDUP_DEFAULTS.enabled,
    windowSeconds: typeof raw.windowSeconds === 'number' && raw.windowSeconds >= 0 ? raw.windowSeconds : DEDUP_DEFAULTS.windowSeconds,
  };
}
function saveDedupConfig(cfg) {
  setSetting('dedup_config', {
    enabled:       cfg.enabled === false ? false : true,
    windowSeconds: Math.max(0, Math.min(300, parseInt(cfg.windowSeconds,10)||0)),
  });
  logger.info('Dedup config saved');
}

// ── Feed filter ───────────────────────────────────────────────────────────────
// Controls which messages are broadcast to the live feed and returned in history.
// mode: 'show_all' | 'ignore_capcodes' | 'only_capcodes' | 'only_groups' | 'only_aliases'
const FEED_FILTER_MODES    = ['show_all', 'ignore_capcodes', 'only_capcodes', 'only_groups', 'only_aliases'];
// message_type: 'all' | 'alpha' | 'numeric' — independent of mode, same as the text filters below.
// Only meaningful for POCSAG/FLEX, whose funcbits distinguish numeric-only pages from
// alphanumeric ones (multimon-ng's default "standard" decode: POCSAG func 0 = numeric,
// func != 0 = alpha; FLEX NUM = numeric). Anything else (unknown protocol) always passes.
const MESSAGE_TYPES        = ['all', 'alpha', 'numeric'];
const FEED_FILTER_DEFAULTS = { mode: 'show_all', capcodes: [], group_ids: [], text_strings: [], text_regex: [], message_type: 'all' };
const MAX_TEXT_FILTERS     = 100; // text_strings/text_regex run on every incoming message — bound the list size

function isNumericMessage(msg) {
  const protocol = String(msg.protocol || '').toUpperCase();
  const funcbits = Number(msg.funcbits);
  if (protocol.startsWith('POCSAG')) return funcbits === 0;
  if (protocol === 'FLEX')           return funcbits === 1; // FLEX_TYPE_FUNC.NUM (see services/sdr.js)
  return false;
}

// Rejects patterns shaped for catastrophic backtracking (e.g. `(a+)+`), since
// text_regex patterns run synchronously on every incoming message.
function isUnsafeRegexPattern(source) {
  if (source.length > 200) return true;
  return /\([^()]*[+*][^()]*\)\s*[+*]/.test(source) || /\([^()]*[+*][^()]*\)\s*\{\d+,/.test(source);
}

function getFeedFilter(orgId) {
  const raw = getSetting(orgKey(orgId, 'feed_filter'), null);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...FEED_FILTER_DEFAULTS };
  return {
    mode:         FEED_FILTER_MODES.includes(raw.mode) ? raw.mode : 'show_all',
    capcodes:     Array.isArray(raw.capcodes)     ? raw.capcodes.map(c => normCapcode(String(c))) : [],
    group_ids:    Array.isArray(raw.group_ids)    ? raw.group_ids.map(Number)     : [],
    text_strings: Array.isArray(raw.text_strings) ? raw.text_strings.map(String)  : [],
    text_regex:   Array.isArray(raw.text_regex)   ? raw.text_regex.map(String)    : [],
    message_type: MESSAGE_TYPES.includes(raw.message_type) ? raw.message_type : 'all',
  };
}

function saveFeedFilter(orgId, cfg) {
  const textStrings = Array.isArray(cfg.text_strings)
    ? cfg.text_strings.map(v => String(v).trim()).filter(Boolean).slice(0, MAX_TEXT_FILTERS)
    : [];
  const textRegex = Array.isArray(cfg.text_regex)
    ? cfg.text_regex.map(v => String(v).trim()).filter(Boolean).slice(0, MAX_TEXT_FILTERS)
    : [];
  const unsafePattern = textRegex.find(isUnsafeRegexPattern);
  if (unsafePattern) {
    throw new Error(`Regex pattern rejected (too long or prone to catastrophic backtracking): ${unsafePattern}`);
  }

  setSetting(orgKey(orgId, 'feed_filter'), {
    mode:         FEED_FILTER_MODES.includes(cfg.mode) ? cfg.mode : 'show_all',
    capcodes:     Array.isArray(cfg.capcodes)     ? cfg.capcodes.map(c => normCapcode(String(c))) : [],
    group_ids:    Array.isArray(cfg.group_ids)    ? cfg.group_ids.map(Number)  : [],
    text_strings: textStrings,
    text_regex:   textRegex,
    message_type: MESSAGE_TYPES.includes(cfg.message_type) ? cfg.message_type : 'all',
  });
  logger.info(`Feed filter saved (org=${orgId})`);
}

// Returns true if the message should be shown in the feed for the given org.
// msg must have: capcode, alias_name/alias, group_id (resolved for that same org — see
// database.js's ALIAS_GROUP_JOIN_SQL/getHistory for the org-aware alias/group resolution
// this depends on).
function passesFeedFilter(msg, orgId) {
  try {
    const filter = getFeedFilter(orgId);
    if (!filter) return true;

    // Decoders don't agree on zero-padding capcodes — filter.capcodes is normalized on
    // save/load, so the message side must be normalized here too or padded live capcodes
    // (e.g. "001234567") silently fail to match an entry saved as "1234567".
    const msgCapcode = normCapcode(String(msg.capcode));

    if (filter.mode === 'ignore_capcodes') {
      if (filter.capcodes.includes(msgCapcode)) return false;
    }
    else if (filter.mode === 'only_capcodes') {
      if (!filter.capcodes.includes(msgCapcode)) return false;
    }
    else if (filter.mode === 'only_groups') {
      if (!groupMatchesSelection(msg.group_id, filter.group_ids)) return false;
    }
    else if (filter.mode === 'only_aliases') {
      const hasAlias = !!(msg.alias_name || msg.alias);
      if (!hasAlias) return false;
      // If specific capcodes listed — require capcode to be in that list too
      if (filter.capcodes.length > 0 && !filter.capcodes.includes(msgCapcode)) return false;
    }

    if (filter.message_type !== 'all') {
      const numeric = isNumericMessage(msg);
      if (filter.message_type === 'alpha'   && numeric)  return false;
      if (filter.message_type === 'numeric' && !numeric) return false;
    }

    const text = String(msg.message || '');
    if (!text) return true;

    const lowerText = text.toLowerCase();
    const matchedString = filter.text_strings.find(s => {
      const needle = String(s ?? '').trim().toLowerCase();
      return needle ? lowerText.includes(needle) : false;
    });
    if (matchedString) {
      logger.info(`[feed-filter] dropped capcode=${msg.capcode} — matched text filter "${matchedString}"`);
      return false;
    }

    for (const pattern of filter.text_regex) {
      const source = String(pattern ?? '').trim();
      if (!source) continue;
      try {
        if (new RegExp(source, 'i').test(text)) {
          logger.info(`[feed-filter] dropped capcode=${msg.capcode} — matched regex filter /${source}/i`);
          return false;
        }
      } catch (_) {}
    }

    return true;
  } catch (_) { return true; }
}

// ── Message normalizations ────────────────────────────────────────────────────
function getMessageNormalizations() {
  const raw = getSetting('msg_normalizations', null);
  if (!Array.isArray(raw)) return [];
  return raw.filter(r => r && typeof r.pattern === 'string' && typeof r.replace === 'string');
}

function saveMessageNormalizations(rules) {
  const clean = (Array.isArray(rules) ? rules : [])
    .filter(r => r && typeof r.pattern === 'string')
    .map(r => ({ pattern: String(r.pattern), replace: String(r.replace ?? '') }));
  setSetting('msg_normalizations', clean);
  logger.info(`Message normalizations saved: ${clean.length} rules`);
}

module.exports = {
  getSdrConfig, saveSdrConfig, loadSdrConfigIntoEnv,
  getDongleConfigs, saveDongleConfigs,
  getNotifConfig, saveNotifConfig,
  getNotifFilter, saveNotifFilter,
  getDedupConfig, saveDedupConfig,
  getFeedFilter, saveFeedFilter, passesFeedFilter,
  getMessageNormalizations, saveMessageNormalizations,
};
