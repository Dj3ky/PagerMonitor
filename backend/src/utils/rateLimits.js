// Brute-force protection for the public /auth endpoints. In-memory counters (reset on
// restart), keyed by client IP — which relies on Express's 'trust proxy' setting (see
// index.js) to see the real client behind a reverse proxy — and, for login and
// forgot-password, additionally by username, so spreading attempts over many IPs doesn't
// help either. Trade-off of the per-username key: someone hammering a username can lock
// its owner out of logging in for up to the window, never longer.
const { rateLimit } = require('express-rate-limit');

const MIN = 60 * 1000;

function limiter({ windowMs, limit, byUsername = false, failedOnly = false, what }) {
  const minutes = Math.round(windowMs / MIN);
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    // Only failed responses (>= 400) count, so normal logins never use up the budget.
    skipSuccessfulRequests: failedOnly,
    ...(byUsername && {
      keyGenerator: req => `user:${String(req.body?.username ?? '').trim().toLowerCase()}`,
    }),
    message: { error: `Too many ${what} — please try again in ${minutes} minutes` },
  });
}

// 10 failed logins per 15 min, per IP and per username
const loginLimiters = [
  limiter({ windowMs: 15 * MIN, limit: 10, failedOnly: true, what: 'failed login attempts' }),
  limiter({ windowMs: 15 * MIN, limit: 10, failedOnly: true, byUsername: true, what: 'failed login attempts for this user' }),
];

// Each request may send an email: 5 per 15 min per IP, 3 per hour per username
const forgotPasswordLimiters = [
  limiter({ windowMs: 15 * MIN, limit: 5, what: 'password reset requests' }),
  limiter({ windowMs: 60 * MIN, limit: 3, byUsername: true, what: 'password reset requests for this user' }),
];

// Reset tokens are 256-bit, so this only caps noise: 10 per 15 min per IP
const resetPasswordLimiter = limiter({ windowMs: 15 * MIN, limit: 10, what: 'password reset attempts' });

// Every successful join creates an account: 10 per hour per IP
const joinLimiter = limiter({ windowMs: 60 * MIN, limit: 10, what: 'sign-up attempts' });

module.exports = { loginLimiters, forgotPasswordLimiters, resetPasswordLimiter, joinLimiter };
