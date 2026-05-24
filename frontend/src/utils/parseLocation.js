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
function validCoord(lat, lng) {
  return lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180 &&
         Math.abs(lat) > 0.001 && Math.abs(lng) > 0.001;
}

// ── Slovenian address helpers ─────────────────────────────────────────────────
const SUFFIX_RE = /^(cesta|ulica|trg|pot|nabrežje|avenija|aleja|breg|steza)$/i;
const HOUSE_RE  = /^\d{1,4}[a-zA-Z]?$/;
const PUNCT_RE  = /^[-–—,;:.()\[\]/\\]+$/;

const SI_CITIES = [
  // Major cities (original list)
  'Ljubljana', 'Maribor', 'Celje', 'Kranj', 'Koper', 'Novo Mesto', 'Nova Gorica',
  'Velenje', 'Krško', 'Slovenj Gradec', 'Murska Sobota', 'Ptuj', 'Domžale',
  'Škofja Loka', 'Trbovlje', 'Kamnik', 'Izola', 'Piran', 'Postojna',
  'Ajdovščina', 'Sežana', 'Logatec', 'Litija', 'Grosuplje', 'Vrhnika', 'Brežice',
  'Jesenice', 'Radovljica', 'Gornja Radgona', 'Ormož', 'Zagorje ob Savi',
  'Idrija', 'Tolmin', 'Tržič', 'Žalec', 'Laško', 'Šentjur', 'Rogaška Slatina',
  'Šempeter pri Gorici', 'Ruše', 'Ravne na Koroškem', 'Hrastnik',
  // Municipality centers not in original list
  'Škofljica', 'Medvode', 'Mengeš', 'Komenda', 'Vodice', 'Trzin', 'Ig',
  'Brezovica', 'Borovnica', 'Horjul', 'Dobrova', 'Log pri Brezovici',
  'Lukovica', 'Moravče', 'Šmartno pri Litiji', 'Ivančna Gorica',
  'Trebnje', 'Mirna', 'Šentrupert', 'Mokronog', 'Šmarješke Toplice',
  'Šentjernej', 'Kostanjevica na Krki', 'Straža', 'Dolenjske Toplice',
  'Črnomelj', 'Metlika', 'Semič', 'Kočevje', 'Ribnica', 'Sodražica',
  'Loški Potok', 'Osilnica', 'Ilirska Bistrica', 'Pivka', 'Cerknica',
  'Bloke', 'Loška Dolina', 'Logatec', 'Vrhnika',
  'Medvode', 'Šempeter-Vrtojba', 'Miren-Kostanjevica', 'Renče-Vogrsko',
  'Kanal', 'Kanal ob Soči', 'Bovec', 'Kobarid', 'Zreče', 'Vitanje',
  'Šoštanj', 'Mozirje', 'Nazarje', 'Gornji Grad', 'Rečica ob Savinji',
  'Ljubno', 'Luče', 'Solčava', 'Braslovče', 'Polzela', 'Štore',
  'Šentilj', 'Lenart', 'Kungota', 'Pesnica', 'Hoče-Slivnica',
  'Miklavž na Dravskem Polju', 'Duplek', 'Starše', 'Hajdina',
  'Markovci', 'Kidričevo', 'Majšperk', 'Videm', 'Podlehnik',
  'Žetale', 'Cirkulane', 'Zavrč', 'Središče ob Dravi',
  'Sveti Tomaž', 'Benedikt', 'Sveta Ana', 'Cerkvenjak',
  'Sveti Andraž v Slovenskih Goricah', 'Sveta Trojica v Slovenskih Goricah',
  'Destrnik', 'Trnovska vas', 'Dornava', 'Juršinci', 'Sveti Jurij ob Ščavnici',
  'Razkrižje', 'Veržej', 'Beltinci', 'Lendava', 'Dobrovnik', 'Moravske Toplice',
  'Kuzma', 'Rogašovci', 'Cankova', 'Grad', 'Hodoš', 'Šalovci',
  'Križevci', 'Ljutomer', 'Sveti Jurij v Slovenskih Goricah',
  'Apače', 'Radenci', 'Gornja Radgona', 'Šentilj', 'Sl. Konjice', 'Slovenska Konjice',
  'Mislinja', 'Podvelka', 'Radlje ob Dravi', 'Ribnica na Pohorju',
  'Vuzenica', 'Muta', 'Lovrenc na Pohorju', 'Rače-Fram', 'Selnica ob Dravi',
];

const _cityPat = SI_CITIES
  .map(c => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'))
  .join('|');
// Use Unicode-aware boundaries so diacritic-initial names (Škofja Loka, etc.) match
const CITY_RE = new RegExp(`(?<!\\p{L})(${_cityPat})(?!\\p{L})`, 'iu');

function normSI(s) {
  return s.toLowerCase()
    .replace(/[šŠ]/g, 's').replace(/[čČ]/g, 'c').replace(/[žŽ]/g, 'z')
    .replace(/[ćĆ]/g, 'c').replace(/[đĐ]/g, 'd');
}

function detectCity(text) {
  const m = CITY_RE.exec(text);
  return m ? m[1] : null;
}

// ── Confidence scoring (no index on frontend — simpler formula) ───────────────
// Threshold 0.40 (lower than backend since no index data available)
const FE_CONF_MIN = 0.40;

function feScore({ hasKeyword, hasCityHint, hasHouseNum, hasHint, hasMultipleHints = false }) {
  let s = 0;
  s += hasKeyword  ? 0.35 : 0;
  s += hasCityHint ? 0.30 : (hasMultipleHints ? 0.20 : (hasHint ? 0.12 : 0));
  s += hasHouseNum ? 0.25 : 0;
  return s;
}

// Words that appear in Slovenian emergency messages but are not part of addresses
const SI_STOPWORDS_FE = new Set([
  'v', 'na', 'pri', 'ob', 'za', 'do', 'od', 'k', 'iz', 'po', 's', 'z',
  'je', 'so', 'in', 'ali', 'ter', 'da', 'ne', 'se', 'pa', 'ko', 'ker',
  'požar', 'gorenje', 'nesreča', 'prometna', 'intervencija',
  'gasilci', 'reševalci', 'policija', 'nujno', 'pomoč', 'klic', 'alarm',
  // medical / incident-type descriptors
  'stiska', 'dihalna', 'srčna', 'nezavest', 'poškodba', 'poškodbe',
  'utopitev', 'zastrupitev', 'opeklina', 'krvavitev', 'kolaps',
  'porodniška', 'porod', 'bolečina', 'bolečine', 'nezgoda',
  'km', 'm', 'ha',
  'oseba', 'osebe', 'oseb', 'osebno', 'vozilo', 'vozila', 'vozilu', 'vozilom',
  'motorist', 'kolesar', 'pešec',
  'padla', 'padel', 'gospa', 'gospod', 'odpiranje', 'vrat', 'steno',
  'trčilo', 'stena', 'steni', 'stanovanju', 'stanovanjska',
]);

// ── SI-specific candidate extraction (frontend, no prefix index) ──────────────
function siCandidatesFE(text, country) {
  // Strip punctuation attached to word ends (e.g. "stanovanju," → "stanovanju", "15," → "15")
  const clean    = text.replace(/([^\s])[,;:.!]+(?=\s|$)/g, '$1');
  const words    = clean.trim().split(/\s+/);
  const cityHint = detectCity(text);
  const seen     = new Set();
  const ranked   = [];

  function add(streetPhrase, houseNum, hasKeyword, hints = [], rawBonus = 0) {
    // Use most proximate hints (last elements) — closest to the address in the message
    const settlement = cityHint || (hints.length > 0 ? hints.slice(-2).join(' ') : null);
    const sc = feScore({
      hasKeyword,
      hasCityHint:     !!cityHint,
      hasHouseNum:     !!houseNum,
      hasHint:         hints.length > 0,
      hasMultipleHints: hints.length >= 2,
    });
    if (sc + rawBonus < FE_CONF_MIN) return;
    const parts = houseNum ? `${streetPhrase} ${houseNum}` : streetPhrase;
    const query = settlement
      ? `${parts}, ${settlement}, ${country}`
      : `${parts}, ${country}`;
    if (!seen.has(query)) { seen.add(query); ranked.push({ query, sc: sc + rawBonus }); }
  }

  // Pre-compute city hint words for suffix-first boundary detection.
  const cityHintNorm = cityHint ? normSI(cityHint).split(/\s+/) : [];

  // Returns true when the sequence ending at words[wordIdx] matches the full
  // city hint — prevents city tail words (e.g. "GORICA" from "IVANČNA GORICA")
  // from being used as a street-name prefix.
  function endsWithCityHint(wordIdx) {
    if (cityHintNorm.length === 0) return false;
    for (let k = 0; k < cityHintNorm.length; k++) {
      const wi = wordIdx - (cityHintNorm.length - 1 - k);
      if (wi < 0 || normSI(words[wi]) !== cityHintNorm[k]) return false;
    }
    return true;
  }

  // Strategy 1: keyword windows
  for (let i = 0; i < words.length; i++) {
    if (!SUFFIX_RE.test(words[i])) continue;

    // Find first non-punct word before this suffix (for boundary checks)
    let prevNPIdx = -1;
    for (let j = i - 1; j >= 0; j--) {
      if (!PUNCT_RE.test(words[j])) { prevNPIdx = j; break; }
    }

    // ── Suffix-FIRST pattern: "[CITY], ULICA DOLENJSKEGA ODREDA 14" ──────────
    // Detected when the nearest non-punct word before the suffix is the tail of
    // the city hint (comma stripped by `clean`), OR a standalone punctuation
    // word (dash) sits between the previous content word and the suffix.
    const suffixIsFirst =
      (prevNPIdx >= 0 && endsWithCityHint(prevNPIdx)) ||
      (prevNPIdx >= 0 && words.slice(prevNPIdx + 1, i).some(w => PUNCT_RE.test(w)));

    if (suffixIsFirst) {
      // Street name = suffix + following content words until house number or punct.
      // Do NOT break on prepositions — "Ulica ob potoku" has "ob" mid-name.
      const nameParts = [words[i]];
      let houseNum = null;
      for (let j = i + 1; j < words.length; j++) {
        if (HOUSE_RE.test(words[j])) { houseNum = words[j]; break; }
        if (PUNCT_RE.test(words[j])) break;
        nameParts.push(words[j]);
      }
      if (nameParts.length >= 2) {
        // cityHint already provides the settlement — no extra hints needed
        add(nameParts.join(' '), houseNum, true, []);
      }
      continue; // skip suffix-last logic for this suffix occurrence
    }

    // ── Suffix-LAST pattern: "DOLENJSKA CESTA 14" ────────────────────────────
    // Word immediately before the suffix; track its index for hint extraction
    let beforeWord = null, beforeIdx = -1;
    for (let j = i - 1; j >= 0; j--) {
      if (PUNCT_RE.test(words[j])) continue;
      if (SI_STOPWORDS_FE.has(words[j].toLowerCase())) break;
      beforeWord = words[j]; beforeIdx = j;
      break;
    }
    if (!beforeWord) continue;

    const streetPhrase = `${beforeWord} ${words[i]}`;
    let houseNum = null, houseIdx = i;
    for (let j = i + 1; j <= i + 2 && j < words.length; j++) {
      if (HOUSE_RE.test(words[j])) { houseNum = words[j]; houseIdx = j; break; }
    }

    // Collect settlement hints from surrounding context
    const hints = [];
    for (let j = beforeIdx - 1; j >= Math.max(0, beforeIdx - 3); j--) {
      const w = words[j];
      if (PUNCT_RE.test(w) || HOUSE_RE.test(w)) continue;
      if (SI_STOPWORDS_FE.has(w.toLowerCase())) break;
      if (/^[\p{L}]{2,}/u.test(w)) hints.unshift(w);
    }
    for (let j = houseIdx + 1; j <= houseIdx + 2 && j < words.length; j++) {
      const w = words[j];
      if (PUNCT_RE.test(w)) continue;
      if (!SI_STOPWORDS_FE.has(w.toLowerCase()) && /^[\p{L}]{2,}/u.test(w)) hints.push(w);
    }

    add(streetPhrase, houseNum, true, hints);
  }

  // Strategy 2: house-number window fallback
  if (ranked.length === 0) {
    let numIdx = -1;
    for (let i = words.length - 1; i >= 0; i--) {
      if (HOUSE_RE.test(words[i])) { numIdx = i; break; }
    }
    if (numIdx >= 1) {
      const cityFirstWords = cityHint ? normSI(cityHint).split(/\s+/) : [];

      for (let width = 1; width <= Math.min(4, numIdx); width++) {
        const startIdx = numIdx - width;
        const rawChunk = words.slice(startIdx, numIdx).filter(w => !PUNCT_RE.test(w));
        const chunk    = rawChunk.filter(w => !SI_STOPWORDS_FE.has(w.toLowerCase()));
        if (chunk.length === 0) continue;

        // Skip widths where chunk starts with the city name
        if (cityFirstWords.length > 0 && chunk.length > cityFirstWords.length) {
          const chunkNorm = chunk.map(w => normSI(w));
          if (cityFirstWords.every((w, i) => chunkNorm[i] === w)) continue;
        }

        const hints = [];
        for (let j = startIdx - 1; j >= Math.max(0, startIdx - 4); j--) {
          const w = words[j];
          if (PUNCT_RE.test(w) || HOUSE_RE.test(w)) continue;
          if (SI_STOPWORDS_FE.has(w.toLowerCase())) continue;
          if (/^[\p{L}]{2,}/u.test(w)) hints.unshift(w);
        }

        const hasSuffix = SUFFIX_RE.test(chunk[chunk.length - 1]);
        add(chunk.join(' '), words[numIdx], hasSuffix, hints);

        if (rawChunk.length > chunk.length) {
          add(rawChunk.join(' '), words[numIdx], hasSuffix, hints, rawChunk.length * 0.01);
        }
      }
    }
  }

  ranked.sort((a, b) => b.sc - a.sc);
  return ranked.slice(0, 10).map(r => r.query);
}

// ── Fallback candidates for non-SI country codes (original algorithm) ─────────
function legacyCandidatesFE(text, country) {
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
    if (n === 3) push(`${phrase(prev[n - 2])}, ${words[prev[n - 1]]}, ${country}`);
  }
  return results;
}

// ── Main parser ───────────────────────────────────────────────────────────────
export function parseLocation(text, countryCode = 'si') {
  if (!text) return null;

  let m = DECIMAL_RE.exec(text);
  if (m) {
    const lat = parseFloat(m[1]), lng = parseFloat(m[2]);
    if (validCoord(lat, lng)) return { lat, lng, raw: m[0], type: 'coords' };
  }

  m = LAT_LON_RE.exec(text);
  if (m) {
    const lat = parseFloat(m[1]), lng = parseFloat(m[2]);
    if (validCoord(lat, lng)) return { lat, lng, raw: m[0], type: 'coords' };
  }

  m = NSEW_RE.exec(text);
  if (m) {
    const lat = m[1].toUpperCase() === 'S' ? -parseFloat(m[2]) : parseFloat(m[2]);
    const lng = m[3].toUpperCase() === 'W' ? -parseFloat(m[4]) : parseFloat(m[4]);
    if (validCoord(lat, lng)) return { lat, lng, raw: m[0], type: 'coords' };
  }

  m = DMS_RE.exec(text);
  if (m) {
    const lat = dms(m[1], m[2], m[3], m[4].toUpperCase());
    const lng = dms(m[5], m[6], m[7], m[8].toUpperCase());
    if (validCoord(lat, lng)) return { lat, lng, raw: m[0], type: 'coords' };
  }

  const country    = COUNTRY_NAMES[countryCode] || countryCode.toUpperCase();
  const candidates = countryCode === 'si'
    ? siCandidatesFE(text, country)
    : legacyCandidatesFE(text, country);

  if (candidates.length > 0) {
    return { lat: null, lng: null, type: 'address', raw: text, candidates, geoQuery: candidates[0] };
  }

  return null;
}

// ── Rate-limited Nominatim geocoder ──────────────────────────────────────────
// All requests share one serial queue — prevents 429s when many messages arrive.
const _geoCache = new Map();
let   _geoChain = Promise.resolve();

function _enqueue(work) {
  const slot = _geoChain.then(work);
  _geoChain = slot.then(() => new Promise(r => setTimeout(r, 1100)),
                         () => new Promise(r => setTimeout(r, 1100)));
  return slot;
}

export async function geocodeAddress(loc, countryCode = 'si') {
  const queries = typeof loc === 'object' && loc?.candidates
    ? loc.candidates
    : [typeof loc === 'string' ? loc : loc?.geoQuery || loc?.raw].filter(Boolean);

  // One pre-ranked candidate is enough — avoids extra Nominatim calls
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
        if (data?.length > 0) return {
          lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon),
          display: data[0].display_name, query,
        };
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
