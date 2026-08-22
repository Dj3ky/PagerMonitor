'use strict';

// backend/data/gasilske_regije.geojson is built offline by
// scripts/{fetchObcineBoundaries,dissolveGasilskeRegije}.js — not committed (same
// treatment as si_places.json/si_streets.json), so a fresh install has neither
// until those scripts run once, whether manually or via the admin "fetch geo data"
// button (see routes/admin.js). Read once and kept in memory; invalidate() drops
// the cache so the next request re-reads the freshly (re)built file instead of an
// empty/missing result cached from before the scripts ran.
const fs   = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '../../data/gasilske_regije.geojson');

let cached = null;

function get() {
  if (!cached) cached = fs.readFileSync(FILE, 'utf8');
  return cached;
}

function invalidate() {
  cached = null;
}

module.exports = { get, invalidate };
