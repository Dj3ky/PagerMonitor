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
// mode: 'all' | 'filtered'
// capcodes: array of capcode strings to include (when mode='filtered')
const NOTIF_FILTER_DEFAULTS = { mode: 'all', capcodes: [] };

function getNotifFilter() {
  const raw = getSetting('notif_filter', null);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...NOTIF_FILTER_DEFAULTS };
  return {
    mode:     ['all','filtered'].includes(raw.mode) ? raw.mode : 'all',
    capcodes: Array.isArray(raw.capcodes) ? raw.capcodes : [],
  };
}
function saveNotifFilter(cfg) {
  setSetting('notif_filter', {
    mode:     ['all','filtered'].includes(cfg.mode) ? cfg.mode : 'all',
    capcodes: Array.isArray(cfg.capcodes) ? cfg.capcodes.map(String) : [],
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
    windowSeconds: typeof raw.windowSeconds === 'number' && raw.windowSeconds > 0 ? raw.windowSeconds : DEDUP_DEFAULTS.windowSeconds,
  };
}
function saveDedupConfig(cfg) {
  setSetting('dedup_config', {
    enabled:       cfg.enabled === false ? false : true,
    windowSeconds: Math.max(5, Math.min(300, parseInt(cfg.windowSeconds,10)||30)),
  });
  logger.info('Dedup config saved');
}

module.exports = {
  getSdrConfig, saveSdrConfig, loadSdrConfigIntoEnv,
  getDongleConfigs, saveDongleConfigs,
  getNotifConfig, saveNotifConfig,
  getNotifFilter, saveNotifFilter,
  getDedupConfig, saveDedupConfig,
};
