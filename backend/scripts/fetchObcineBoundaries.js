#!/usr/bin/env node
'use strict';

/**
 * Downloads all 212 Slovenian municipality (občina) boundary polygons from
 * GURS's official Register prostorskih enot (RPE) OGC API Features service,
 * and tags each one with its gasilska regija (fire-brigade region) from
 * backend/data/gasilska_regija.json.
 *
 * Source: https://ipi.eprostor.gov.si/wfs-si-gurs-rpe/ogc/features/collections/SI.GURS.RPE:OBCINE
 * Geometry ships already in WGS84 (lat/lng) — no reprojection needed, unlike
 * the SPIN WKT feed in vecjiObseg.js. One request returns all 212 features
 * (numberMatched/numberReturned both 212 as of writing), so no pagination.
 *
 * Output: backend/data/si_obcine.geojson — FeatureCollection, one
 * Polygon/MultiPolygon per municipality, properties: { naziv, regija }.
 *
 * Run once (or to refresh after an administrative boundary change):
 *   node backend/scripts/fetchObcineBoundaries.js
 */

const fs   = require('fs');
const path = require('path');

const URL        = 'https://ipi.eprostor.gov.si/wfs-si-gurs-rpe/ogc/features/collections/SI.GURS.RPE:OBCINE/items?f=json&limit=300';
const OUT         = path.join(__dirname, '../data/si_obcine.geojson');
const REGIJA_FILE = path.join(__dirname, '../data/gasilska_regija.json');

// GURS's NAZIV spells a few municipalities differently from the gasilska_regija.json
// source table: no spaces around hyphens ("Rače-Fram" vs "Rače - Fram"), and two
// outright abbreviations ("Kanal" for "Kanal ob Soči", "Slov. goricah" for
// "Slovenskih goricah"). Normalize both sides the same way before matching.
const NAME_ALIASES = {
  'Kanal': 'Kanal ob Soči',
  'Sveti Andraž v Slov. goricah': 'Sveti Andraž v Slovenskih goricah',
};

function normalizeName(name) {
  const aliased = NAME_ALIASES[name] || name;
  return aliased.replace(/\s*-\s*/g, '-');
}

async function main() {
  console.log('Fetching municipality boundaries from GURS RPE...\n');

  const regijaEntries = JSON.parse(fs.readFileSync(REGIJA_FILE, 'utf8'));
  const regijaByName  = new Map(regijaEntries.map(r => [normalizeName(r.municipality), r.region]));

  const res = await fetch(URL, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const page = await res.json();

  const fetched = page.features || [];
  console.log(`Fetched ${fetched.length} of ${page.numberMatched ?? '?'} matched features`);
  if (page.numberMatched && fetched.length < page.numberMatched) {
    console.warn(`Warning: only got ${fetched.length}/${page.numberMatched} — increase the limit param.`);
  }

  const features = fetched.map(f => {
    const naziv  = f.properties?.NAZIV;
    const regija = regijaByName.get(normalizeName(naziv)) ?? null;
    if (!regija) console.warn(`  ! no gasilska regija mapping for "${naziv}"`);
    return { type: 'Feature', geometry: f.geometry, properties: { naziv, regija } };
  });

  const seen    = new Set(features.map(f => normalizeName(f.properties.naziv)));
  const missing = regijaEntries.map(r => r.municipality).filter(m => !seen.has(normalizeName(m)));
  if (missing.length) console.warn(`\nNo boundary returned for: ${missing.join(', ')}`);

  const geojson = { type: 'FeatureCollection', features };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(geojson));
  console.log(`\nSaved ${features.length} boundaries to ${path.relative(process.cwd(), OUT)}`);
}

main().catch(err => { console.error('\nError:', err.message); process.exit(1); });
