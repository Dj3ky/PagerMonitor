'use strict';

// Resolves a pager alias name (e.g. "<org type> <place name>") to the reporting
// unit's home settlement — used as a soft geographic anchor when disambiguating
// addresses in that unit's dispatch messages (see parseLocation.js and
// placeIndex.js). Most Slovenian fire/rescue alias names are "<org type>
// <place>", so stripping the org-type prefix leaves the place name.

const { lookupWord, lookupWordLoose } = require('./placeIndex');

// Leading tokens that identify an org type rather than a place. Best-effort list —
// a deployment-specific abbreviation that isn't listed here just fails to resolve
// (resolveAliasHome returns null), which is a safe no-op for the caller.
const ORG_PREFIXES = new Set([
  'PGD', 'PGE', 'GRC', 'GRS', 'GARS', 'GZ', 'GPO', 'PPO',
  'JZGRD', 'JZGRS', 'JZ', 'CZ', 'ZD', 'NMP', 'GB',
]);

function stripOrgPrefix(name) {
  const words = name.trim().split(/\s+/);
  let i = 0;
  // Keep at least one trailing word so an alias that's entirely prefix tokens
  // (e.g. unresolvable custom abbreviations) doesn't strip down to nothing.
  while (i < words.length - 1 && ORG_PREFIXES.has(words[i].toUpperCase())) i++;
  return words.slice(i).join(' ');
}

const _cache = new Map(); // "aliasName|countryCode" -> resolved home place | null

// Returns {name, municipality, lat, lng} for the alias's home place, or null when
// nothing in the place index matches (unknown prefix, no place-index data, etc).
function resolveAliasHome(aliasName, countryCode = 'si') {
  if (!aliasName) return null;
  const key = `${aliasName}|${countryCode}`;
  if (_cache.has(key)) return _cache.get(key);

  let result = null;
  const words = stripOrgPrefix(aliasName).split(/\s+/).filter(Boolean);

  // Place names are contiguous — try the longest word-sequence first (handles
  // multi-word settlements), shrinking down to single words.
  outer:
  for (let len = words.length; len >= 1; len--) {
    for (let start = 0; start + len <= words.length; start++) {
      const candidate = words.slice(start, start + len).join(' ');
      const found = _resolveCandidate(candidate, countryCode);
      if (found) { result = found; break outer; }
    }
  }

  _cache.set(key, result);
  return result;
}

// Resolves one candidate place-name string to a single best entry, or null.
// Priority:
//   1. An unambiguous exact match, or one whose name IS its own municipality
//      seat — highest confidence.
//   2. A "twin village" compound family: 2+ directional/size-qualified compounds
//      (e.g. "Dolenje Kamence" + "Gorenje Kamence") sharing a municipality — a
//      bare alias name like "Kamence" almost certainly means that shared area,
//      and this pattern is common enough in Slovenian place names to trust.
//   3. Whatever ambiguous exact match(es) exist, first one — old behavior,
//      weakest signal, kept as a last resort.
//   4. A single (non-twin) compound match — better than nothing.
function _resolveCandidate(candidate, countryCode) {
  const exact = lookupWord(candidate, countryCode);
  const seat  = exact.find(m => m.name.toLowerCase() === m.municipality.toLowerCase());
  if (seat) return seat;
  if (exact.length === 1) return exact[0];

  const compound = lookupWordLoose(candidate, countryCode);
  const muniCounts = new Map();
  for (const m of compound) muniCounts.set(m.municipality, (muniCounts.get(m.municipality) || 0) + 1);
  const twinMuni = [...muniCounts.entries()].find(([, n]) => n >= 2)?.[0];
  if (twinMuni) return compound.find(m => m.municipality === twinMuni);

  if (exact.length) return exact[0];
  if (compound.length) return compound[0];
  return null;
}

// Drops cached resolutions — needed after an admin geo-data refresh, since a
// resolveAliasHome() call made before the place-index data existed would
// otherwise cache `null` forever for that alias.
function invalidate() {
  _cache.clear();
}

module.exports = { resolveAliasHome, stripOrgPrefix, invalidate };
