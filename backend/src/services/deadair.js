'use strict';
const { broadcast }  = require('./websocket');
const { getSetting } = require('./database');
const logger = require('../utils/logger');

let lastMessageTime = Date.now();
let checkTimer      = null;
let alerted         = false;

function recordMessage() {
  lastMessageTime = Date.now();
  if (alerted) {
    alerted = false;
    broadcast({ type: 'dead_air', state: 'recovered', lastMessage: new Date(lastMessageTime).toISOString() });
    logger.info('Dead air: recovered — message received');
  }
}

function startDeadAirCheck() {
  clearInterval(checkTimer);
  checkTimer = setInterval(() => {
    const cfg = getSetting('dead_air_config', { enabled: false, thresholdHours: 6 });
    if (!cfg.enabled) return;

    const threshold = (cfg.thresholdHours || 6) * 3600 * 1000;
    const silent    = Date.now() - lastMessageTime;

    if (silent >= threshold && !alerted) {
      alerted = true;
      const since = new Date(lastMessageTime).toISOString();
      const hours = Math.round(silent / 3600000);
      // Check if multi-dongle — alert covers all dongles (any message from any dongle resets the timer)
      const { getDongleConfigs } = require('./config');
      const dongles = getDongleConfigs();
      const dongleCount = Array.isArray(dongles) && dongles.length > 1 ? dongles.length : 1;
      const source = dongleCount > 1 ? `all ${dongleCount} dongles` : 'SDR';
      logger.warn(`Dead air: no messages from ${source} for ${hours}h (threshold: ${cfg.thresholdHours}h)`);
      broadcast({ type: 'dead_air', state: 'alert', lastMessage: since, silentMs: silent, dongleCount, source });
    }
  }, 60_000);
}

function stopDeadAirCheck() { clearInterval(checkTimer); }

module.exports = { recordMessage, startDeadAirCheck, stopDeadAirCheck };
