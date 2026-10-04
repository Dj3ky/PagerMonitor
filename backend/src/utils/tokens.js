const crypto = require('crypto');

// Bearer-style secrets (reset tokens, session tokens) are only ever stored as their
// SHA-256 digest, so a leaked DB file or backup can't be replayed as a login. The tokens
// themselves are 256-bit random values, so a plain unsalted hash is sufficient here —
// unlike passwords, there's nothing to brute-force.
function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

// Constant-time comparison for shared secrets (e.g. the client key). Comparing digests
// keeps the timing independent of both the content and the length of the inputs.
function safeEqual(a, b) {
  return crypto.timingSafeEqual(
    crypto.createHash('sha256').update(String(a)).digest(),
    crypto.createHash('sha256').update(String(b)).digest(),
  );
}

module.exports = { hashToken, safeEqual };
