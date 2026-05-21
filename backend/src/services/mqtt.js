'use strict';

const logger = require('../utils/logger');

const clients = new Map();

function getClient(broker) {
  if (clients.has(broker)) return clients.get(broker);
  let mqtt;
  try { mqtt = require('mqtt'); }
  catch { logger.warn('mqtt package not installed — MQTT bridge disabled'); return null; }
  const c = mqtt.connect(broker);
  c.on('connect', () => logger.info(`MQTT connected to ${broker}`));
  c.on('error',   (e) => logger.warn(`MQTT error: ${e.message}`));
  clients.set(broker, c);
  return c;
}

async function sendMqtt(msg, cfg) {
  if (!cfg?.broker) return;
  const c = getClient(cfg.broker);
  if (!c) return;
  if (!c.connected) {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('MQTT connection timeout')), 5000);
      c.once('connect', () => { clearTimeout(t); resolve(); });
      c.once('error',   (e) => { clearTimeout(t); reject(new Error(e?.errors?.[0]?.message || e?.message || String(e) || 'MQTT connection failed')); });
    });
  }
  const topic = cfg.topic || 'pagermonitor/messages';
  await new Promise((resolve, reject) =>
    c.publish(topic, JSON.stringify(msg), { qos: 0, retain: false }, err => err ? reject(new Error(err?.message || String(err))) : resolve())
  );
}

module.exports = { sendMqtt };
