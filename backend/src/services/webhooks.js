'use strict';
const { getWebhooks } = require('./database');
const logger = require('../utils/logger');
const crypto = require('crypto');

async function sendWebhooks(msg) {
  let hooks;
  try { hooks = getWebhooks().filter(h => h.enabled); } catch { return; }
  if (!hooks.length) return;

  await Promise.allSettled(hooks.map(async hook => {
    try {
      const body    = JSON.stringify(msg);
      const headers = { 'Content-Type': 'application/json', 'User-Agent': 'PagerMonitor/1.0' };
      if (hook.secret) {
        const sig = crypto.createHmac('sha256', hook.secret).update(body).digest('hex');
        headers['X-PagerMonitor-Signature'] = `sha256=${sig}`;
      }
      const r = await fetch(hook.url, { method: 'POST', headers, body, signal: AbortSignal.timeout(5000) });
      if (!r.ok) logger.warn(`Webhook "${hook.name}" returned ${r.status}`);
      else logger.debug(`Webhook "${hook.name}" OK`);
    } catch (e) {
      logger.warn(`Webhook "${hook.name}" failed: ${e.message}`);
    }
  }));
}

module.exports = { sendWebhooks };
