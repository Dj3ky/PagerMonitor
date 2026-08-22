#!/usr/bin/env node
'use strict';

/**
 * Merges the 212 municipality polygons in backend/data/si_obcine.geojson into
 * one outline per gasilska regija (fire-brigade region), using each polygon's
 * "regija" property (set by fetchObcineBoundaries.js from gasilska_regija.json).
 *
 * Uses @turf/turf's dissolve(), which merges adjacent Polygon features sharing
 * the same property value — a one-time offline step, not needed at request
 * time, so it's a devDependency rather than a runtime one.
 *
 * Output: backend/data/gasilske_regije.geojson — FeatureCollection, one
 * Polygon/MultiPolygon per region, properties: { regija }.
 *
 * Run once (or after re-running fetchObcineBoundaries.js):
 *   node backend/scripts/dissolveGasilskeRegije.js
 */

const fs   = require('fs');
const path = require('path');
const { dissolve } = require('@turf/turf');

const IN  = path.join(__dirname, '../data/si_obcine.geojson');
const OUT = path.join(__dirname, '../data/gasilske_regije.geojson');

function main() {
  const obcine = JSON.parse(fs.readFileSync(IN, 'utf8'));

  const unmapped = obcine.features.filter(f => !f.properties.regija);
  if (unmapped.length) {
    throw new Error(`${unmapped.length} municipalities have no regija set: ` +
      unmapped.map(f => f.properties.naziv).join(', '));
  }

  const dissolved = dissolve(obcine, { propertyName: 'regija' });

  console.log(`Dissolved ${obcine.features.length} municipalities into ${dissolved.features.length} regions:`);
  for (const f of dissolved.features) console.log(`  ${f.properties.regija}`);

  fs.writeFileSync(OUT, JSON.stringify(dissolved));
  console.log(`\nSaved to ${path.relative(process.cwd(), OUT)}`);
}

main();
