/**
 * Shared dedup logic for local SDR ingestion (sdr.js) and remote client
 * ingestion (routes/client.js).
 *
 * Pager retransmissions of the same page often decode with slightly
 * different text (truncated or corrupted by RF noise), so exact-string
 * matching alone misses them. This matches same-capcode messages within
 * the dedup window by text similarity, and — since a longer retransmission
 * can still be a worse decode than a shorter one — scores each candidate
 * so the row only ever gets replaced by a cleaner/more complete version,
 * never a noisier one.
 */
'use strict';

const { getDedupConfig } = require('./config');

// Below this similarity, two same-capcode messages within the window are
// treated as unrelated (e.g. two distinct dispatches to the same station),
// not retransmissions of one page. Kept fairly high — two genuinely different
// dispatches sharing boilerplate phrasing ("POŽAR V ..., ... CESTA ..., GORI
// ...") can otherwise land in the 0.55-0.65 range purely by template overlap.
const SIMILARITY_THRESHOLD = 0.65;
// Multimon-ng's own bracketed decode-failure placeholders (<DEL>, <EM>, ...)
// and raw control bytes — real dispatch text never legitimately contains
// these, so finding one is unambiguous proof this specific message is
// corrupted, independent of how it compares to anything else.
// String.prototype.match() resets lastIndex internally before searching, so
// this shared global-flagged regex stays safe to reuse across calls/strings —
// unlike RegExp.prototype.test(), which would carry lastIndex state between
// calls and could silently skip matches on a later string.
const JUNK_TOKEN_RE = /<[A-Z]{2,5}>/g;
function hasJunkMarkers(text) {
  if (text.match(JUNK_TOKEN_RE)) return true;
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}
// Once corruption is confirmed via hasJunkMarkers, matching switches to this
// much more permissive LCS-based ratio — unlike edit-distance similarity, it
// isn't penalized for multiple separate corrupted patches shifting the rest
// of the string out of character-for-character alignment, which is exactly
// what a batch with more than one bad codeword looks like.
const JUNK_LCS_THRESHOLD = 0.5;
// Retransmission corruption on POCSAG/FLEX almost always starts clean and
// degrades from some point onward — it doesn't scramble the beginning. So a
// long shared prefix is treated as a retransmission match even when the
// corrupted tail drags whole-string similarity below SIMILARITY_THRESHOLD.
const PREFIX_MIN_LEN   = 15;
const PREFIX_MIN_RATIO = 0.4;
// A receiver that loses signal partway through a retransmission can decode
// almost nothing before losing lock — real dispatch text in this system
// always runs well past this length, so anything at or under it is never a
// legitimate standalone page. Matched against an already-cached longer
// message for the same capcode, any such fragment (however it's damaged —
// cut off, misdecoded, both) is presumed to be a piece of it, gated by a
// small shared-prefix check so an unrelated-but-genuinely-short message
// (e.g. a short cancellation notice) isn't swallowed by coincidence.
const FRAGMENT_MAX_LEN      = 15;
const FRAGMENT_MIN_PREFIX   = 3;
// Safety-net sweep interval for capcodes that stop sending entirely — normal
// pruning already happens per-capcode against the configured dedup window.
const STALE_SWEEP_MS = 300_000;

// capcode -> [{ message, score, id, timestamp }]
const cache = new Map();

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

function similarity(a, b) {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const maxLen = Math.max(a.length, b.length);
  return maxLen === 0 ? 1 : 1 - levenshtein(a, b) / maxLen;
}

function commonPrefixLen(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

function lcsLen(a, b) {
  const m = a.length, n = b.length;
  let prev = new Array(n + 1).fill(0);
  let curr = new Array(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      curr[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], curr[j - 1]);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

function lcsRatio(a, b) {
  const minLen = Math.min(a.length, b.length);
  return minLen === 0 ? 0 : lcsLen(a, b) / minLen;
}

// True if b looks like a retransmission of a — the whole strings are close,
// one/both carry known decode-failure markers and still share most of their
// content in order, they share a long prefix before one degrades into
// corruption, or the shorter one is a too-short-to-be-real fragment loosely
// aligned with it.
function looksLikeRetransmission(a, b) {
  if (similarity(a, b) >= SIMILARITY_THRESHOLD) return true;

  if (hasJunkMarkers(a) || hasJunkMarkers(b)) {
    if (lcsRatio(a, b) >= JUNK_LCS_THRESHOLD) return true;
  }

  const prefixLen = commonPrefixLen(a, b);
  const minLen = Math.min(a.length, b.length);
  if (minLen === 0) return false;
  if (prefixLen >= PREFIX_MIN_LEN && prefixLen / minLen >= PREFIX_MIN_RATIO) return true;

  const maxLen = Math.max(a.length, b.length);
  if (minLen <= FRAGMENT_MAX_LEN && minLen < maxLen) {
    return prefixLen >= Math.min(FRAGMENT_MIN_PREFIX, minLen);
  }
  return false;
}

// Rewards length, heavily penalizes control characters and multimon-ng's
// bracketed error placeholders (<DEL>, <NUL>, ...) so a longer-but-more-
// corrupted retransmission can never outscore a shorter, cleaner one. Junk
// tokens are stripped out of the length count entirely (not just flat-fee
// penalized) — a bracketed token is 4-5 characters long, so a per-token
// penalty in that same range nets out to ~0 and lets padding with garbage
// pay for itself; excluding their length from the count first closes that.
function scoreText(text) {
  if (!text) return 0;
  const junkTokens = text.match(JUNK_TOKEN_RE) || [];
  const stripped = text.replace(JUNK_TOKEN_RE, '');
  let controlChars = 0;
  for (const ch of stripped) {
    const code = ch.codePointAt(0);
    if (code < 0x20 || code === 0x7f) controlChars++;
  }
  return (stripped.length - controlChars) - controlChars * 3 - junkTokens.length * 8;
}

function sweepStale(now) {
  if (cache.size <= 2000) return;
  for (const [capcode, entries] of cache) {
    const kept = entries.filter(e => now - e.timestamp < STALE_SWEEP_MS);
    if (kept.length) cache.set(capcode, kept); else cache.delete(capcode);
  }
}

/**
 * Call before inserting a new message. Returns one of:
 *  - { duplicate: false }                — not a duplicate, insert as a new row
 *  - { duplicate: true, update: null }    — duplicate, new text isn't better, drop it
 *  - { duplicate: true, update: entry }   — duplicate AND better — caller should
 *    UPDATE entry.id's row with the new text, then call recordUpdate(entry, message)
 */
function evaluate(capcode, message) {
  const cfg = getDedupConfig();
  if (!cfg.enabled || !message) return { duplicate: false };
  const now = Date.now();
  const windowMs = cfg.windowSeconds * 1000;

  const entries = (cache.get(capcode) || []).filter(e => now - e.timestamp < windowMs);
  cache.set(capcode, entries);

  const match = entries.find(e => looksLikeRetransmission(e.message, message));
  if (!match) return { duplicate: false };

  return scoreText(message) > match.score
    ? { duplicate: true, update: match }
    : { duplicate: true, update: null };
}

// Record a freshly-inserted message so later retransmissions can match against it.
function recordInsert(capcode, message, id) {
  const entries = cache.get(capcode) || [];
  entries.push({ message, score: scoreText(message), id, timestamp: Date.now() });
  cache.set(capcode, entries);
  sweepStale(Date.now());
}

// Record that an existing row was just updated in place with better text.
function recordUpdate(entry, message) {
  entry.message   = message;
  entry.score     = scoreText(message);
  entry.timestamp = Date.now();
}

module.exports = { evaluate, recordInsert, recordUpdate, scoreText, similarity };
