/**
 * Resolves a capcode to its alias name.
 * Reads from the database (set via Admin → Aliases panel).
 * The static aliases.json file is no longer used.
 */

function resolveAlias(capcode) {
  try {
    const { getDb } = require('../services/database');
    const norm = /^\d+$/.test(capcode) ? String(parseInt(capcode, 10)) : capcode;
    const row = getDb().prepare('SELECT name FROM aliases WHERE capcode = ?').get(norm);
    return row ? row.name : null;
  } catch (_) {
    return null;
  }
}

module.exports = { resolveAlias };
