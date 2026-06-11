'use strict';

const { getSetting, setSetting } = require('./database');
const logger = require('../utils/logger');
const { formatTs } = require('../utils/time');

const EMAIL_DEFAULTS = {
  enabled:  false,
  host:     '',
  port:     587,
  secure:   false,   // true = SSL/TLS on connect (port 465), false = STARTTLS (port 587)
  user:     '',
  password: '',
  from:     '',      // "PagerMonitor <alerts@example.com>"
};

function getEmailConfig() {
  return { ...EMAIL_DEFAULTS, ...getSetting('email_config', {}) };
}

function saveEmailConfig(cfg) {
  setSetting('email_config', { ...EMAIL_DEFAULTS, ...cfg });
}

// Lazy-create transporter so we don't load nodemailer until needed
let _transporter = null;
let _lastCfgHash = null;

function getTransporter() {
  const cfg = getEmailConfig();
  if (!cfg.enabled || !cfg.host || !cfg.user) return null;

  const hash = JSON.stringify(cfg);
  if (_transporter && hash === _lastCfgHash) return _transporter;

  try {
    const nodemailer = require('nodemailer');
    _transporter = nodemailer.createTransport({
      host:   cfg.host,
      port:   Number(cfg.port) || 587,
      secure: !!cfg.secure,
      auth:   { user: cfg.user, pass: cfg.password },
      tls:    { rejectUnauthorized: false }, // allow self-signed certs
    });
    _lastCfgHash = hash;
    return _transporter;
  } catch (e) {
    logger.warn(`Email: failed to create transporter: ${e.message}`);
    return null;
  }
}

async function sendEmail({ to, subject, text, html }) {
  const cfg         = getEmailConfig();
  const transporter = getTransporter();
  if (!transporter) throw new Error('Email not configured or disabled');

  const from = cfg.from || cfg.user;
  await transporter.sendMail({ from, to, subject, text, html });
  logger.info(`Email sent to ${to}: ${subject}`);
}

async function testEmail(to) {
  const ts  = formatTs(new Date().toISOString());
  const mapsUrl = 'https://www.google.com/maps?q=46.0569,14.5058';

  const html = `
    <div style="font-family:monospace;max-width:520px;padding:16px;background:#111;color:#eee;border-radius:8px">
      <div style="color:#00ff9d;font-weight:bold;font-size:1rem;margin-bottom:4px">📟 Test Alias</div>
      <div style="color:#888;font-size:0.8rem">0000001</div>
      <div style="color:#a855f7;font-size:0.78rem;margin-top:2px">📁 Test Group</div>
      <div style="color:#888;font-size:0.75rem;margin:8px 0 4px">${ts}</div>
      <div style="background:#1a1a1a;padding:10px;border-radius:4px;border-left:3px solid #00ff9d;word-break:break-word;margin-bottom:12px">
        This is a test notification from PagerMonitor ✓<br>
        Your email notifications are working correctly.
      </div>
      <a href="${mapsUrl}" style="display:inline-block;padding:8px 16px;background:#1976d2;color:#fff;text-decoration:none;border-radius:6px;font-size:0.85rem;font-weight:bold">
        📍 Open in Google Maps
      </a>
    </div>
  `;
  const text = [
    '📟 Test Alias (0000001)',
    '📁 Test Group',
    '',
    'This is a test notification from PagerMonitor ✓',
    'Your email notifications are working correctly.',
    '',
    `Location: ${mapsUrl}`,
  ].join('\n');

  await sendEmail({
    to,
    subject: 'PagerMonitor — test email (formatting preview)',
    text,
    html,
  });
}

// ── Password reset tokens (stored in DB settings as a map) ───────────────────
const RESET_TTL_MS = 60 * 60 * 1000; // 1 hour

function generateResetToken(userId) {
  const crypto = require('crypto');
  const token  = crypto.randomBytes(32).toString('hex');
  const tokens = getSetting('pw_reset_tokens', {});
  // Clean expired tokens
  const now = Date.now();
  for (const [t, v] of Object.entries(tokens)) {
    if (now > v.expires) delete tokens[t];
  }
  tokens[token] = { userId, expires: now + RESET_TTL_MS };
  setSetting('pw_reset_tokens', tokens);
  return token;
}

function validateResetToken(token) {
  const tokens = getSetting('pw_reset_tokens', {});
  const entry  = tokens[token];
  if (!entry) return null;
  if (Date.now() > entry.expires) {
    delete tokens[token];
    setSetting('pw_reset_tokens', tokens);
    return null;
  }
  return entry.userId;
}

function consumeResetToken(token) {
  const tokens = getSetting('pw_reset_tokens', {});
  const userId = tokens[token]?.userId || null;
  delete tokens[token];
  setSetting('pw_reset_tokens', tokens);
  return userId;
}

async function sendPasswordReset(user, resetUrl) {
  const cfg = getEmailConfig();
  if (!cfg.enabled) throw new Error('Email not configured');
  if (!user.email)  throw new Error('User has no email address');

  await sendEmail({
    to:      user.email,
    subject: 'PagerMonitor — password reset',
    text:    `Hi ${user.username},\n\nClick the link below to reset your password:\n${resetUrl}\n\nThis link expires in 1 hour.\n\nIf you did not request this, ignore this email.`,
    html:    `
      <p>Hi <strong>${user.username}</strong>,</p>
      <p>Click the button below to reset your password:</p>
      <p><a href="${resetUrl}" style="display:inline-block;padding:10px 20px;background:#00ff9d;color:#000;text-decoration:none;border-radius:6px;font-weight:bold;">Reset password</a></p>
      <p>Or copy this link: <code>${resetUrl}</code></p>
      <p>This link expires in <strong>1 hour</strong>.</p>
      <p style="color:#888;font-size:12px;">If you did not request this, ignore this email.</p>
    `,
  });
}

module.exports = {
  getEmailConfig, saveEmailConfig,
  sendEmail, testEmail,
  generateResetToken, validateResetToken, consumeResetToken,
  sendPasswordReset,
};
