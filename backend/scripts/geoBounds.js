'use strict';

/**
 * Shared by fetchStreets.js and fetchPlaces.js — one source of truth for country
 * bounding boxes and per-country tile grid size, so the two scripts can never drift
 * out of sync on what a given country covers or how it's split into areas.
 */

const BBOXES = {
  si: '45.42,13.38,46.88,16.61',
  hr: '42.39,13.49,46.55,19.45',
  de: '47.27,5.87,55.06,15.04',
  at: '46.37,9.53,49.02,17.16',
  it: '35.49,6.63,47.10,18.52',
  ch: '45.82,5.96,47.81,10.49',
  fr: '41.34,-5.14,51.09,9.56',
  gb: '49.87,-8.62,60.86,1.77',
  pl: '49.00,14.12,54.84,24.15',
  hu: '45.74,16.11,48.59,22.90',
  nz: '-47.35,166.43,-34.35,178.55',
  au: '-43.74,113.34,-10.41,153.64',
  ca: '41.68,-141.00,83.11,-52.64',
  us: '24.52,-124.77,49.38,-66.95',
};

// Countries whose OSM dataset is large enough that a single whole-country Overpass
// query gets rejected (oversized response / server-side timeout) even with a raised
// maxsize — these get split into an N x N grid of areas instead. Everything else
// keeps the original single-query behavior (grid size 1 = one "tile" covering the
// whole bbox). Only France is enabled so far — it's the one actually validated
// against production Overpass traffic; add other large countries here once verified.
const STREET_GRID_SIZE = { fr: 8 };
const PLACE_GRID_SIZE  = { fr: 5 };

// OSM admin_level for municipalities/regions varies by country (8 = most of Europe)
const MUNI_LEVELS = { nz: '6', au: '6', us: '6', ca: '8' };

function parseBbox(value) {
  const [south, west, north, east] = value.split(',').map(Number);
  return { south, west, north, east };
}

function formatBbox(bbox) {
  return [bbox.south, bbox.west, bbox.north, bbox.east]
    .map(value => value.toFixed(6))
    .join(',');
}

// Splits `bbox` into `rows` x `cols` equal-sized areas, south-west to north-east,
// row-major order. The last row/column snaps to the exact bbox edge (bbox.north /
// bbox.east) instead of accumulating floating-point drift from repeated addition.
function makeTiles(bbox, rows, cols) {
  const tiles = [];
  const latStep = (bbox.north - bbox.south) / rows;
  const lonStep = (bbox.east - bbox.west) / cols;

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      tiles.push({
        south: bbox.south + row * latStep,
        west: bbox.west + col * lonStep,
        north: row === rows - 1 ? bbox.north : bbox.south + (row + 1) * latStep,
        east: col === cols - 1 ? bbox.east : bbox.west + (col + 1) * lonStep,
      });
    }
  }

  return tiles;
}

module.exports = {
  BBOXES, STREET_GRID_SIZE, PLACE_GRID_SIZE, MUNI_LEVELS,
  parseBbox, formatBbox, makeTiles,
};
