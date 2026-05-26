const { getSetting, setSetting } = require('./database');
const logger = require('../utils/logger');

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

function getNotifConfig() {
  const stored = getSetting('notif_config', null);
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
function saveNotifConfig(cfg) { setSetting('notif_config', cfg); logger.info('Notification config saved'); }

// ── Notification filter ───────────────────────────────────────────────────────
// Applies to: Discord, Telegram, Gotify, Pushover, MQTT only.
// mode: 'all' | 'groups' | 'aliases' | 'capcodes' | 'keywords'
const NOTIF_FILTER_MODES = ['all', 'groups', 'aliases', 'capcodes', 'keywords'];
const NOTIF_FILTER_DEFAULTS = { mode: 'all', group_ids: [], capcodes: [], keywords: [] };

function getNotifFilter() {
  const raw = getSetting('notif_filter', null);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...NOTIF_FILTER_DEFAULTS };
  return {
    mode:      NOTIF_FILTER_MODES.includes(raw.mode) ? raw.mode : 'all',
    group_ids: Array.isArray(raw.group_ids) ? raw.group_ids.map(Number) : [],
    capcodes:  Array.isArray(raw.capcodes)  ? raw.capcodes  : [],
    keywords:  Array.isArray(raw.keywords)  ? raw.keywords  : [],
  };
}
function saveNotifFilter(cfg) {
  setSetting('notif_filter', {
    mode:      NOTIF_FILTER_MODES.includes(cfg.mode) ? cfg.mode : 'all',
    group_ids: Array.isArray(cfg.group_ids) ? cfg.group_ids.map(Number) : [],
    capcodes:  Array.isArray(cfg.capcodes)  ? cfg.capcodes.map(String)  : [],
    keywords:  Array.isArray(cfg.keywords)  ? cfg.keywords.map(String)  : [],
  });
  logger.info('Notification filter saved');
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
const FEED_FILTER_DEFAULTS = { mode: 'show_all', capcodes: [], group_ids: [] };

function getFeedFilter() {
  const raw = getSetting('feed_filter', null);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...FEED_FILTER_DEFAULTS };
  return {
    mode:      FEED_FILTER_MODES.includes(raw.mode) ? raw.mode : 'show_all',
    capcodes:  Array.isArray(raw.capcodes)  ? raw.capcodes.map(String)  : [],
    group_ids: Array.isArray(raw.group_ids) ? raw.group_ids.map(Number) : [],
  };
}

function saveFeedFilter(cfg) {
  setSetting('feed_filter', {
    mode:      FEED_FILTER_MODES.includes(cfg.mode) ? cfg.mode : 'show_all',
    capcodes:  Array.isArray(cfg.capcodes)  ? cfg.capcodes.map(String)   : [],
    group_ids: Array.isArray(cfg.group_ids) ? cfg.group_ids.map(Number)  : [],
  });
  logger.info('Feed filter saved');
}

// Returns true if the message should be shown in the feed.
// msg must have: capcode, alias_name/alias, group_id
function passesFeedFilter(msg) {
  try {
    const filter = getFeedFilter();
    if (!filter || filter.mode === 'show_all') return true;

    if (filter.mode === 'ignore_capcodes') {
      return !filter.capcodes.includes(String(msg.capcode));
    }
    if (filter.mode === 'only_capcodes') {
      return filter.capcodes.includes(String(msg.capcode));
    }
    if (filter.mode === 'only_groups') {
      return msg.group_id != null && filter.group_ids.includes(Number(msg.group_id));
    }
    if (filter.mode === 'only_aliases') {
      const hasAlias = !!(msg.alias_name || msg.alias);
      if (!hasAlias) return false;
      // If specific capcodes listed — require capcode to be in that list too
      if (filter.capcodes.length > 0) return filter.capcodes.includes(String(msg.capcode));
      return true;
    }
    return true;
  } catch (_) { return true; }
}

module.exports = {
  getSdrConfig, saveSdrConfig, loadSdrConfigIntoEnv,
  getDongleConfigs, saveDongleConfigs,
  getNotifConfig, saveNotifConfig,
  getNotifFilter, saveNotifFilter,
  getDedupConfig, saveDedupConfig,
  getFeedFilter, saveFeedFilter, passesFeedFilter,
};
