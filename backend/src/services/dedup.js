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
// not retransmissions of one page.
const SIMILARITY_THRESHOLD = 0.55;
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

// Rewards length, heavily penalizes control characters and multimon-ng's
// bracketed error placeholders (<DEL>, <NUL>, ...) so a longer-but-more-
// corrupted retransmission can never outscore a shorter, cleaner one.
function scoreText(text) {
  if (!text) return 0;
  const junkTokens = (text.match(/<[A-Z]{2,5}>/g) || []).length;
  let controlChars = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code < 0x20 || code === 0x7f) controlChars++;
  }
  return (text.length - controlChars) - controlChars * 3 - junkTokens * 5;
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

  const match = entries.find(e => similarity(e.message, message) >= SIMILARITY_THRESHOLD);
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
