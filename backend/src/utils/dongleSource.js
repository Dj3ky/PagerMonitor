'use strict';

function buildDongleSourceId(dongle) {
  const serial = String(dongle?.serial || '').trim();
  if (serial) return `dongle-${serial}`;

  const device = String(dongle?.device ?? '').trim();
  return `dongle-${device}`;
}

module.exports = { buildDongleSourceId };
