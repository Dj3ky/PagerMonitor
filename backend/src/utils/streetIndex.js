'use strict';

const fs   = require('fs');
const path = require('path');

// prefix (3-6 normalized chars) → original-name[]
const _index   = new Map();
let   _streets = [];
let   _ready   = false;

const SUFFIXES = new Set([
  'cesta', 'ulica', 'trg', 'pot', 'nabrežje', 'avenija', 'aleja',
  'breg', 'steza', 'vas', 'log', 'hrib',
]);

function _norm(s) {
  return s.toLowerCase()
    .replace(/š/g, 's').replace(/č/g, 'c').replace(/ž/g, 'z')
    .replace(/ć/g, 'c').replace(/đ/g, 'd');
}

// First non-suffix word (≥2 chars) in a normalized street name
function _keyOf(normName) {
  const words = normName.split(/\s+/);
  for (const w of words) if (!SUFFIXES.has(w) && w.length >= 2) return w;
  return words[0] || '';
}

function _build(names) {
  for (const name of names) {
    if (typeof name !== 'string' || !name.trim()) continue;
    const key = _keyOf(_norm(name));
    if (key.length < 3) continue;
    for (let len = 3; len <= Math.min(6, key.length); len++) {
      const p = key.slice(0, len);
      if (!_index.has(p)) _index.set(p, []);
      _index.get(p).push(name);
    }
  }
}

function _load() {
  if (_ready) return;
  _ready = true;
  try {
    const file = path.join(__dirname, '../../data/si_streets.json');
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    _streets   = Array.isArray(data) ? data : [];
    _build(_streets);
  } catch (_) { /* data file absent — graceful degradation */ }
}

function _lev(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const curr = [i];
    for (let j = 1; j <= n; j++) {
      curr[j] = a[i - 1] === b[j - 1] ? prev[j - 1]
        : 1 + Math.min(prev[j], curr[j - 1], prev[j - 1]);
    }
    prev = curr;
  }
  return prev[n];
}

function _sim(a, b) {
  if (a === b) return 1;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  if (maxLen > 30) return 0;
  return 1 - _lev(a, b) / maxLen;
}

/**
 * Find top matches for a street phrase in the index.
 * Compares the key word (first non-suffix word) of the query against indexed keys.
 * Returns [{name, sim}] sorted descending by similarity, max maxResults.
 */
function matchStreet(phrase, maxResults = 10) {
  _load();
  if (_streets.length === 0) return [];

  const qKey = _keyOf(_norm(phrase.trim()));
  if (qKey.length < 3) return [];

  const seen  = new Set();
  const batch = [];
  for (let len = Math.min(6, qKey.length); len >= 3; len--) {
    const bucket = _index.get(qKey.slice(0, len)) || [];
    for (const name of bucket) {
      if (!seen.has(name)) { seen.add(name); batch.push(name); }
    }
    if (batch.length >= 200) break;
  }

  if (batch.length === 0) return [];

  const scored = batch.map(name => ({ name, sim: _sim(_keyOf(_norm(name)), qKey) }));
  scored.sort((a, b) => b.sim - a.sim);
  return scored.slice(0, maxResults);
}

function hasData() { _load(); return _streets.length > 0; }

module.exports = { matchStreet, hasData };
