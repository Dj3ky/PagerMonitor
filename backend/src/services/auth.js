const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db     = require('./database');
const logger = require('../utils/logger');
const { hashToken } = require('../utils/tokens');

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MIN_PASSWORD_LENGTH = 10; // applies whenever a password is set; existing ones stay valid
const PASSWORD_TOO_SHORT = `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
// Compared against when the username doesn't exist, so an unknown user takes as long to
// reject as a wrong password (otherwise response time reveals which usernames exist).
const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), 10);

// ── Sessions ──────────────────────────────────────────────────────────────────
// Stored in auth_sessions as SHA-256(token) → user id. There is deliberately no in-memory
// snapshot of role/org/platform-admin: validateSession reads the user's current row on
// every call, so demotions, org moves and deletions take effect on the very next request.
function createSession(user) {
  const token = crypto.randomBytes(32).toString('hex');
  db.saveDbSession(hashToken(token), user.id, Date.now() + SESSION_TTL_MS);
  return token;
}

function validateSession(token) {
  if (!token || typeof token !== 'string') return null;
  const tokenHash = hashToken(token);
  const row = db.getSessionUser(tokenHash);
  if (!row) return null;
  if (Date.now() > row.expires) { db.deleteDbSession(tokenHash); return null; }
  return {
    userId: row.id, username: row.username, role: row.role,
    orgId: row.org_id ?? null, isPlatformAdmin: !!row.is_platform_admin, expires: row.expires,
  };
}

function destroySession(token) {
  if (token) db.deleteDbSession(hashToken(token));
}

// Logs a user out everywhere — after a password change/reset, so a stolen token stops
// working. keepToken (the caller's own session) survives when a user changes their own
// password. Open WebSocket connections are re-validated by the heartbeat in websocket.js.
function revokeUserSessions(userId, keepToken = null) {
  const n = db.deleteUserSessions(userId, keepToken ? hashToken(keepToken) : null);
  if (n) logger.info(`Revoked ${n} session(s) of user id=${userId}`);
}

setInterval(() => {
  try { db.pruneExpiredSessions(); } catch (_) {}
}, 60 * 60 * 1000);

// Which org an anonymous (public-mode) viewer sees. Public mode is a single instance-wide
// toggle (site_settings.publicMode) with no org picker yet, so default to an explicitly
// configured 'public_org_id' setting, falling back to the lowest-id organization — good
// enough for the common single-org deployment; revisit if/when public mode needs to target
// a specific org on a multi-org instance.
function getPublicOrgId() {
  const configured = db.getSetting('public_org_id', null);
  if (configured) return configured;
  const orgs = db.getOrganizations();
  return orgs.length ? orgs[0].id : null;
}

// ── User ops ──────────────────────────────────────────────────────────────────
// Validates a new account and returns its password hash, without creating it — callers
// that need the insert inside a larger transaction (invite sign-up) do that themselves.
async function prepareNewUser(username, password, role) {
  if (typeof username !== 'string' || username.length < 2) throw new Error('Username must be at least 2 characters');
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) throw new Error(PASSWORD_TOO_SHORT);
  if (!['admin', 'editor', 'viewer'].includes(role)) throw new Error('Role must be admin, editor or viewer');
  if (db.getUserByUsername(username)) throw new Error('Username already taken');
  return bcrypt.hash(password, 10);
}

async function register(username, password, role = 'viewer', orgId = null, isPlatformAdmin = false) {
  const hash = await prepareNewUser(username, password, role);
  const id   = db.createUser(username, hash, role, orgId, isPlatformAdmin);
  logger.info(`User registered: ${username} (${role}${isPlatformAdmin ? ', platform-admin' : ''}, org=${orgId})`);
  return id;
}

async function login(username, password) {
  const user = db.getUserByUsername(username);
  const ok = await bcrypt.compare(password, user ? user.password : DUMMY_HASH);
  if (!user || !ok) throw new Error('Invalid username or password');
  db.touchUserLogin(user.id);
  const token = createSession(user);
  logger.info(`Login: ${username}`);
  const org = user.org_id ? db.getOrganization(user.org_id) : null;
  return {
    token, username: user.username, role: user.role,
    orgId: user.org_id, orgName: org?.name || null, isPlatformAdmin: !!user.is_platform_admin,
    uiLanguage: user.ui_language || null,
  };
}

// keepToken: the session making the change stays logged in; every other one is revoked.
async function changePassword(userId, oldPassword, newPassword, keepToken) {
  const user = db.getDb().prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) throw new Error('User not found');
  const ok = await bcrypt.compare(oldPassword, user.password);
  if (!ok)  throw new Error('Current password is incorrect');
  if (newPassword.length < MIN_PASSWORD_LENGTH) throw new Error(`New password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  db.updateUserPassword(userId, await bcrypt.hash(newPassword, 10));
  revokeUserSessions(userId, keepToken);
}

// Admin reset or emailed reset link — the user is logged out on every device.
async function adminSetPassword(userId, newPassword) {
  if (typeof newPassword !== 'string' || newPassword.length < MIN_PASSWORD_LENGTH) throw new Error(PASSWORD_TOO_SHORT);
  db.updateUserPassword(userId, await bcrypt.hash(newPassword, 10));
  revokeUserSessions(userId);
}

// ── Middleware ────────────────────────────────────────────────────────────────
function extractToken(req) {
  const auth = req.headers['authorization'] || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7);
  return null;
}

function requireAuth(req, res, next) {
  // A valid login always wins — in public mode too, so a logged-in user keeps seeing their
  // own org and their own per-user data rather than the anonymous guest view.
  const s = validateSession(extractToken(req));
  if (s) { req.session = s; return next(); }
  // Allow unauthenticated GET requests when public mode is active
  if (req.publicAccess && req.method === 'GET') {
    req.session = { userId: null, username: 'guest', role: 'viewer', orgId: getPublicOrgId(), isPlatformAdmin: false };
    return next();
  }
  return res.status(401).json({ error: 'Not authenticated' });
}

// Like requireAuth, but never admits public-mode guests — for per-user data, internal
// notes and bulk exports, which stay behind a login even when the feed itself is public.
function requireUser(req, res, next) {
  const s = validateSession(extractToken(req));
  if (!s) return res.status(401).json({ error: 'Not authenticated' });
  req.session = s;
  next();
}

// Org admin — scoped to req.session.orgId by every downstream DB call, not by this
// middleware itself. A platform admin is also role='admin' in their own org, so this
// still passes for them; requirePlatformAdmin below is the separate, additional gate
// for instance-wide infrastructure and cross-org access.
function requireAdmin(req, res, next) {
  const s = validateSession(extractToken(req));
  if (!s)              return res.status(401).json({ error: 'Not authenticated' });
  if (s.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  req.session = s;
  next();
}

// Editor or above — can manage aliases, groups, rules, keyword alerts (within their own org)
function requireEditor(req, res, next) {
  const s = validateSession(extractToken(req));
  if (!s) return res.status(401).json({ error: 'Not authenticated' });
  if (s.role !== 'admin' && s.role !== 'editor') return res.status(403).json({ error: 'Editor access required' });
  req.session = s;
  next();
}

// Platform admin — the app owner's cross-org tier. Gates instance infrastructure
// (SDR, email config, DB tools, etc.) and cross-org management, independent of the
// per-org admin/editor/viewer role.
function requirePlatformAdmin(req, res, next) {
  const s = validateSession(extractToken(req));
  if (!s) return res.status(401).json({ error: 'Not authenticated' });
  if (!s.isPlatformAdmin) return res.status(403).json({ error: 'Platform admin access required' });
  req.session = s;
  next();
}

// Whether `session` may manage (role, email, password, notification prefs, delete) the
// user row `target`. Returns null if allowed, else { status, error }. Platform admins may
// manage anyone; org admins only users of their own org — and never a platform admin,
// even one in their own org: resetting that account's password or email would otherwise
// hand an org admin the instance-wide platform tier.
function manageUserError(session, target) {
  if (session.isPlatformAdmin) return target ? null : { status: 404, error: 'User not found' };
  if (!target || target.org_id !== session.orgId) return { status: 403, error: 'Cannot manage a user outside your organization' };
  if (target.is_platform_admin) return { status: 403, error: 'Only a platform admin can manage a platform admin account' };
  return null;
}

// ── First-run: create default admin + org if no users exist ──────────────────
async function ensureDefaultAdmin() {
  if (db.countUsers() === 0) {
    const orgId = db.createOrganization('My Organization', null);
    let pass = process.env.DEFAULT_ADMIN_PASS;
    if (pass && pass.length < MIN_PASSWORD_LENGTH) {
      logger.warn(`DEFAULT_ADMIN_PASS is shorter than ${MIN_PASSWORD_LENGTH} characters — ignoring it and generating a random password instead`);
      pass = null;
    }
    pass = pass || crypto.randomBytes(12).toString('hex');
    await register('admin', pass, 'admin', orgId, true);
    logger.warn(`⚠  Default admin created  username=admin  password=${pass}`);
    logger.warn('   Change this password in Admin → Users immediately!');
  }
}

module.exports = {
  register, prepareNewUser, login, changePassword, adminSetPassword,
  createSession, validateSession, destroySession, revokeUserSessions, getPublicOrgId,
  requireAuth, requireUser, requireAdmin, requireEditor, requirePlatformAdmin, ensureDefaultAdmin,
  manageUserError, extractToken, MIN_PASSWORD_LENGTH,
};
