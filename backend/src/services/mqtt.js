const logger = require('../utils/logger');

const MQTT_BROKER = process.env.MQTT_BROKER;
const MQTT_TOPIC  = process.env.MQTT_TOPIC || 'pagemon/messages';

let client = null;

// Lazy-load mqtt only if configured (optional dep)
async function getClient() {
  if (client) return client;
  if (!MQTT_BROKER) return null;
  try {
    const mqtt = require('mqtt');
    client = mqtt.connect(MQTT_BROKER);
    client.on('connect', () => logger.info(`MQTT connected to ${MQTT_BROKER}`));
    client.on('error', (e) => logger.warn(`MQTT error: ${e.message}`));
  } catch (e) {
    logger.warn('mqtt package not installed — MQTT bridge disabled');
  }
  return client;
}

async function sendMqtt(msg) {
  if (!MQTT_BROKER) return;
  const c = await getClient();
  if (!c || !c.connected) return;
  c.publish(MQTT_TOPIC, JSON.stringify(msg), { qos: 0, retain: false });
}

module.exports = { sendMqtt };
