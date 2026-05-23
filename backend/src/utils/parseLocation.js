'use strict';

const COUNTRY_NAMES = {
  si:'Slovenia', de:'Germany', at:'Austria', it:'Italy', fr:'France',
  gb:'United Kingdom', nl:'Netherlands', be:'Belgium', ch:'Switzerland',
  pl:'Poland', cz:'Czech Republic', sk:'Slovakia', hu:'Hungary',
  hr:'Croatia', rs:'Serbia', ba:'Bosnia and Herzegovina',
  us:'United States', ca:'Canada', au:'Australia', nz:'New Zealand',
};

// ── Coordinate patterns ───────────────────────────────────────────────────────
const DECIMAL_RE = /(-?\d{1,3}\.\d{3,})\s*,\s*(-?\d{1,3}\.\d{3,})/;
const LAT_LON_RE = /LAT[=:]\s*(-?\d+\.?\d*)\s+LON[=:]\s*(-?\d+\.?\d*)/i;
const NSEW_RE    = /([NS])\s*(\d+\.\d+)\s+([EW])\s*(\d+\.\d+)/i;
const DMS_RE     = /(\d+)°(\d+)'(\d+(?:\.\d+)?)"([NS])\s+(\d+)°(\d+)'(\d+(?:\.\d+)?)"([EW])/i;

function dms(deg, min, sec, dir) {
  const d = +deg + +min / 60 + +sec / 3600;
  return (dir === 'S' || dir === 'W') ? -d : d;
}
function valid(lat, lng) {
  return lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

// ── Slovenian address helpers ─────────────────────────────────────────────────
const SUFFIX_RE = /^(cesta|ulica|trg|pot|nabrežje|avenija|aleja|breg|steza)$/i;
const HOUSE_RE  = /^\d{1,4}[a-zA-Z]?$/;
const PUNCT_RE  = /^[-–—,;:.()\[\]/\\]+$/;

const SI_CITIES = [
  'Ljubljana', 'Maribor', 'Celje', 'Kranj', 'Koper', 'Novo Mesto', 'Nova Gorica',
  'Velenje', 'Krško', 'Slovenj Gradec', 'Murska Sobota', 'Ptuj', 'Domžale',
  'Škofja Loka', 'Trbovlje', 'Kamnik', 'Izola', 'Piran', 'Postojna',
  'Ajdovščina', 'Sežana', 'Logatec', 'Litija', 'Grosuplje', 'Vrhnika', 'Brežice',
  'Jesenice', 'Radovljica', 'Gornja Radgona', 'Ormož', 'Zagorje ob Savi',
  'Idrija', 'Tolmin', 'Tržič', 'Žalec', 'Laško', 'Šentjur', 'Rogaška Slatina',
  'Šempeter pri Gorici', 'Ruše', 'Ravne na Koroškem', 'Hrastnik',
];

const _cityPattern = SI_CITIES
  .map(c => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'))
  .join('|');
// Use Unicode-aware boundaries so diacritic-initial names (Škofja Loka, etc.) match
const CITY_RE = new RegExp(`(?<!\\p{L})(${_cityPattern})(?!\\p{L})`, 'iu');

function detectCity(text) {
  const m = CITY_RE.exec(text);
  return m ? m[1] : null;
}

// Lazy-load street index (only for SI, file read once at first use)
let _si = null;
function si() {
  if (!_si) _si = require('./streetIndex');
  return _si;
}

// Lazy-load place disambiguation index
let _pi = null;
function pi() {
  if (!_pi) _pi = require('./placeIndex');
  return _pi;
}

// ── Confidence scoring ────────────────────────────────────────────────────────
// Returns 0..1. Candidates below CONF_MIN are discarded.
const CONF_MIN = 0.55;

function confScore({ hasKeyword, streetSim, hasCityHint, hasHouseNum, indexLoaded, placeConfidence = 0, hasMultipleContext = false }) {
  let s = 0;
  s += hasKeyword  ? 0.25 : 0;
  // Floor of 0.10 prevents the index penalising settlement names (streetSim≈0)
  // that legitimately don't appear in the street list.
  s += indexLoaded ? Math.max(0.10, streetSim * 0.35) : 0.15;
  if (placeConfidence > 0) {
    s += 0.10 + placeConfidence * 0.15;
  } else if (hasCityHint) {
    s += 0.20;
  } else if (hasMultipleContext) {
    // 2+ proximate context words (e.g. DOBROVA-POLHOV GRADEC) ≈ city hint strength
    s += 0.20;
  }
  s += hasHouseNum ? 0.25 : 0;
  return s;
}

// Slovenian prepositions that precede address phrases but are not part of them
const SI_STOPWORDS = new Set(['v', 'na', 'pri', 'ob', 'za', 'do', 'od', 'k', 'iz', 'po', 's', 'z']);

// Extended set used only for hint collection — filters common Slovenian words that
// are NOT place names so they don't pollute the settlement disambiguation hints.
const SI_HINT_STOPWORDS = new Set([
  ...SI_STOPWORDS,
  // conjunctions / particles
  'je', 'so', 'in', 'ali', 'ter', 'da', 'ne', 'se', 'pa', 'ko', 'ker',
  // emergency / dispatch words
  'požar', 'gorenje', 'nesreča', 'prometna', 'intervencija',
  'gasilci', 'reševalci', 'policija', 'nujno', 'pomoč', 'klic', 'alarm',
  // vehicles / persons
  'oseba', 'osebe', 'oseb', 'osebno', 'vozilo', 'vozila', 'vozilu', 'vozilom',
  'motorist', 'kolesar', 'pešec',
  // actions / objects frequently appearing near addresses
  'padla', 'padel', 'gospa', 'gospod', 'odpiranje', 'vrat', 'steno',
  'trčilo', 'stena', 'steni', 'stanovanju', 'stanovanjska',
]);

// ── SI-specific candidate extraction ─────────────────────────────────────────
function siCandidates(text, country, countryCode) {
  // Strip punctuation attached to word ends (e.g. "stanovanju," → "stanovanju", "15," → "15")
  const clean  = text.replace(/([^\s])[,;:.!]+(?=\s|$)/g, '$1');
  const words  = clean.trim().split(/\s+/);
  const idx    = si();
  const hasIdx = idx.hasData();
  const cityHint = detectCity(text);
  const seen   = new Set();
  const ranked = [];

  function addCandidate(streetPhrase, houseNum, hasKeyword, hints = []) {
    const matches   = idx.matchStreet(streetPhrase, 10);
    const streetSim = matches.length ? matches[0].sim : 0;

    // ── Place disambiguation ──────────────────────────────────────────────────
    const placeMatch = hints.length
      ? pi().disambiguate(hints, text, countryCode)
      : null;

    const sc = confScore({
      hasKeyword,
      streetSim,
      hasCityHint: !!cityHint || !!placeMatch,
      hasHouseNum: !!houseNum,
      indexLoaded: hasIdx,
      placeConfidence: placeMatch?.confidence || 0,
      hasMultipleContext: hints.length >= 2,
    });
    if (sc < CONF_MIN) return;

    // Use corrected index name for diacritics/typo fixing; keep original if no strong match.
    // 0.90 threshold for both cases — diacritics fixes normalize to sim=1.0 anyway,
    // and lower values swap different streets (e.g. "Ob potoku" → "K potoku").
    const streetUsed = (streetSim >= 0.90 && matches[0]?.name)
      ? matches[0].name
      : streetPhrase;

    const parts = houseNum ? `${streetUsed} ${houseNum}` : streetUsed;

    // Build Nominatim query: "Street Number, Settlement, Municipality, Country"
    let query;
    if (placeMatch) {
      const addMuni = placeMatch.confidence >= 0.70 &&
                      placeMatch.municipality !== placeMatch.name;
      query = addMuni
        ? `${parts}, ${placeMatch.name}, ${placeMatch.municipality}, ${country}`
        : `${parts}, ${placeMatch.name}, ${country}`;
    } else if (cityHint) {
      query = `${parts}, ${cityHint}, ${country}`;
    } else if (hints.length > 0) {
      // No place index match — pass the most proximate context words directly to
      // Nominatim (e.g. "GABRJE 30, DOBROVA-POLHOV GRADEC, Slovenia")
      query = `${parts}, ${hints.slice(-2).join(' ')}, ${country}`;
    } else {
      query = `${parts}, ${country}`;
    }

    if (!seen.has(query)) { seen.add(query); ranked.push({ query, sc }); }
  }

  // Strategy 1: keyword windows (cesta/ulica/trg/...)
  for (let i = 0; i < words.length; i++) {
    if (!SUFFIX_RE.test(words[i])) continue;

    // Find the word immediately before the suffix (street adjective); track its index
    let beforeWord = null, beforeIdx = -1;
    for (let j = i - 1; j >= 0; j--) {
      if (PUNCT_RE.test(words[j])) continue;
      if (SI_STOPWORDS.has(words[j].toLowerCase())) break;
      beforeWord = words[j]; beforeIdx = j;
      break;
    }
    if (!beforeWord) continue;

    const streetPhrase = `${beforeWord} ${words[i]}`;

    // House number: first suitable word after suffix (within 2 positions)
    let houseNum = null, houseIdx = i;
    for (let j = i + 1; j <= i + 2 && j < words.length; j++) {
      if (HOUSE_RE.test(words[j])) { houseNum = words[j]; houseIdx = j; break; }
    }

    // Settlement hints: words before the street name (up to 3, no hint-stopwords/punct)
    const hints = [];
    for (let j = beforeIdx - 1; j >= Math.max(0, beforeIdx - 3); j--) {
      const w = words[j];
      if (PUNCT_RE.test(w) || HOUSE_RE.test(w)) continue;
      if (SI_STOPWORDS.has(w.toLowerCase())) break;
      if (SI_HINT_STOPWORDS.has(w.toLowerCase())) continue;
      if (/^[\p{L}]{2,}/u.test(w)) hints.unshift(w);
    }
    // Words after house number also carry settlement context (up to 2)
    for (let j = houseIdx + 1; j <= houseIdx + 2 && j < words.length; j++) {
      const w = words[j];
      if (PUNCT_RE.test(w)) continue;
      if (!SI_HINT_STOPWORDS.has(w.toLowerCase()) && /^[\p{L}]{2,}/u.test(w)) hints.push(w);
    }

    addCandidate(streetPhrase, houseNum, true, hints);
  }

  // Strategy 2: house-number window (for messages without suffix keyword)
  if (ranked.length === 0) {
    let numIdx = -1;
    for (let i = words.length - 1; i >= 0; i--) {
      if (HOUSE_RE.test(words[i])) { numIdx = i; break; }
    }

    if (numIdx >= 1) {
      for (let width = 1; width <= Math.min(4, numIdx); width++) {
        const startIdx = numIdx - width;
        const rawChunk = words.slice(startIdx, numIdx).filter(w => !PUNCT_RE.test(w));
        const chunk    = rawChunk.filter(w => !SI_STOPWORDS.has(w.toLowerCase()));
        if (chunk.length === 0) continue;

        // Collect settlement hints from words before this chunk.
        // Use continue (not break) on stopwords so a settlement like ŠKOFLJICA
        // isn't missed just because a preposition (OB) sits between it and the street.
        const hints = [];
        for (let j = startIdx - 1; j >= Math.max(0, startIdx - 4); j--) {
          const w = words[j];
          if (PUNCT_RE.test(w) || HOUSE_RE.test(w)) continue;
          if (SI_HINT_STOPWORDS.has(w.toLowerCase())) continue;
          if (/^[\p{L}]{2,}/u.test(w)) hints.unshift(w);
        }

        const hasSuffix = SUFFIX_RE.test(chunk[chunk.length - 1]);
        addCandidate(chunk.join(' '), words[numIdx], hasSuffix, hints);

        // Also try the raw chunk (prepositions kept) for streets like
        // "Ob potoku", "Pod lipami", "K potoku" where the preposition is
        // part of the official street name.
        if (rawChunk.length > chunk.length) {
          addCandidate(rawChunk.join(' '), words[numIdx], hasSuffix, hints);
        }
      }
    }
  }

  ranked.sort((a, b) => b.sc - a.sc);
  return ranked.slice(0, 10).map(r => r.query);
}

// ── Fallback candidates for non-SI country codes (original algorithm) ─────────
function legacyCandidates(text, country) {
  const words = text.trim().split(/\s+/);

  let numIdx = -1;
  for (let i = words.length - 1; i >= 0; i--) {
    if (/^\d+[a-zA-Z]?$/.test(words[i])) { numIdx = i; break; }
  }
  if (numIdx < 1) return [];

  const prev = [];
  for (let i = numIdx - 1; i >= 0 && prev.length < 6; i--) {
    if (!PUNCT_RE.test(words[i])) prev.push(i);
  }
  if (prev.length === 0) return [];

  const phrase = (start) =>
    words.slice(start, numIdx + 1).filter(w => !PUNCT_RE.test(w)).join(' ');

  const results = [];
  const seen    = new Set();
  const push    = q => { if (q && !seen.has(q)) { seen.add(q); results.push(q); } };

  for (let n = 1; n <= prev.length; n++) {
    push(`${phrase(prev[n - 1])}, ${country}`);
    if (n === 3) {
      push(`${phrase(prev[n - 2])}, ${words[prev[n - 1]]}, ${country}`);
    }
  }
  return results;
}

// ── Main parser ───────────────────────────────────────────────────────────────
function parseLocation(text, countryCode = 'si') {
  if (!text) return { lat: null, lng: null };

  let m = DECIMAL_RE.exec(text);
  if (m) { const lat = parseFloat(m[1]), lng = parseFloat(m[2]); if (valid(lat, lng)) return { lat, lng }; }

  m = LAT_LON_RE.exec(text);
  if (m) { const lat = parseFloat(m[1]), lng = parseFloat(m[2]); if (valid(lat, lng)) return { lat, lng }; }

  m = NSEW_RE.exec(text);
  if (m) {
    const lat = m[1].toUpperCase() === 'S' ? -parseFloat(m[2]) : parseFloat(m[2]);
    const lng = m[3].toUpperCase() === 'W' ? -parseFloat(m[4]) : parseFloat(m[4]);
    if (valid(lat, lng)) return { lat, lng };
  }

  m = DMS_RE.exec(text);
  if (m) {
    const lat = dms(m[1], m[2], m[3], m[4].toUpperCase());
    const lng = dms(m[5], m[6], m[7], m[8].toUpperCase());
    if (valid(lat, lng)) return { lat, lng };
  }

  const country    = COUNTRY_NAMES[countryCode] || countryCode.toUpperCase();
  const candidates = countryCode === 'si'
    ? siCandidates(text, country, countryCode)
    : legacyCandidates(text, country);

  if (candidates.length > 0) return { lat: null, lng: null, candidates };
  return { lat: null, lng: null };
}

// ── Rate-limited Nominatim geocoder ──────────────────────────────────────────
// Nominatim policy: max 1 request/second. All requests share a single serial
// queue so concurrent message bursts don't trigger 429s.
const _geoCache = new Map();        // "query|cc" → result  (capped at 500 entries)
let   _geoChain = Promise.resolve(); // serialises every HTTP request globally

function _enqueue(work) {
  const slot = _geoChain.then(work);
  _geoChain = slot.then(() => new Promise(r => setTimeout(r, 1100)),
                         () => new Promise(r => setTimeout(r, 1100)));
  return slot;
}

async function geocodeAddress(candidates, countryCode = 'si') {
  const queries = Array.isArray(candidates) ? candidates : [candidates].filter(Boolean);
  // Candidates are pre-ranked by confidence; one well-formed query is enough
  const toTry = queries.slice(0, 1).filter(q => q?.trim());

  for (const query of toTry) {
    const key = `${query}|${countryCode}`;
    if (_geoCache.has(key)) return _geoCache.get(key);

    const result = await _enqueue(async () => {
      if (_geoCache.has(key)) return _geoCache.get(key);
      const ctrl  = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      try {
        const url = `https://nominatim.openstreetmap.org/search?` +
          `q=${encodeURIComponent(query)}&countrycode=${countryCode}&format=json&limit=1`;
        const r = await fetch(url, {
          headers: { 'Accept-Language': 'sl,en', 'User-Agent': 'PagerMonitor/2.2' },
          signal: ctrl.signal,
        });
        if (!r.ok) return null;
        const data = await r.json();
        if (data?.length > 0) return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon), query };
        return null;
      } catch { return null; }
      finally { clearTimeout(timer); }
    });

    if (result) {
      _geoCache.set(key, result);
      if (_geoCache.size > 500) _geoCache.delete(_geoCache.keys().next().value);
      return result;
    }
  }
  return null;
}

module.exports = { parseLocation, geocodeAddress };
