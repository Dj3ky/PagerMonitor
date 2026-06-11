'use strict';

const { getSetting } = require('../services/database');

function formatTs(ts) {
  const tz = (getSetting('site_settings', {}).timezone) || 'Europe/Ljubljana';
  const d = new Date(ts);
  if (isNaN(d)) return ts || '';
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
  return `${p.day}.${p.month}.${p.year} ${p.hour}:${p.minute}:${p.second}`;
}

module.exports = { formatTs };
