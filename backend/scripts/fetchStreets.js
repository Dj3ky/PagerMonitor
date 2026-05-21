#!/usr/bin/env node
'use strict';

/**
 * Downloads all named street ways in Slovenia from the Overpass API and saves
 * a deduplicated, sorted JSON array to backend/data/si_streets.json.
 *
 * Run once (or periodically) to populate the street prefix index:
 *   node backend/scripts/fetchStreets.js
 *
 * Requires Node >=18 (uses built-in fetch). Takes ~30-60 s depending on network.
 */

const fs   = require('fs');
const path = require('path');

const OUT  = path.join(__dirname, '../data/si_streets.json');
const URL  = 'https://overpass-api.de/api/interpreter';
const QUERY = `[out:json][timeout:120];
area["ISO3166-1"="SI"]["admin_level"="2"]->.si;
(
  way(area.si)["highway"]["name"];
);
out tags;`;

async function main() {
  console.log('Fetching Slovenian street data from Overpass API...');

  const res = await fetch(URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    `data=${encodeURIComponent(QUERY)}`,
    signal:  AbortSignal.timeout(150_000),
  });

  if (!res.ok) {
    console.error(`HTTP ${res.status}: ${res.statusText}`);
    process.exit(1);
  }

  const json  = await res.json();
  const names = [...new Set(
    json.elements
      .map(e => e.tags?.name)
      .filter(n => typeof n === 'string' && n.trim().length > 2)
  )].sort((a, b) => a.localeCompare(b, 'sl'));

  fs.writeFileSync(OUT, JSON.stringify(names));
  console.log(`Saved ${names.length} unique street names to ${OUT}`);
}

main().catch(err => { console.error(err.message); process.exit(1); });
