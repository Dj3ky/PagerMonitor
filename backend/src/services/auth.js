const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db     = require('./database');
const logger = require('../utils/logger');

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const sessions = new Map(); // token → { userId, username, role, orgId, isPlatformAdmin, expires }

// ── Sessions ──────────────────────────────────────────────────────────────────
function initSessions() {
  try {
    const rows = db.loadActiveSessions();
    for (const r of rows) sessions.set(r.token, {
      userId: r.user_id, username: r.username, role: r.role,
      orgId: r.org_id ?? null, isPlatformAdmin: !!r.is_platform_admin, expires: r.expires,
    });
    logger.info(`Loaded ${rows.length} active session(s) from DB`);
  } catch (e) {
    logger.warn(`Could not load sessions from DB: ${e.message}`);
  }
}

function createSession(user) {
  const token   = crypto.randomBytes(32).toString('hex');
  const expires = Date.now() + SESSION_TTL_MS;
  const orgId = user.org_id ?? null;
  const isPlatformAdmin = !!user.is_platform_admin;
  sessions.set(token, { userId: user.id, username: user.username, role: user.role, orgId, isPlatformAdmin, expires });
  try { db.saveDbSession(token, user.id, user.username, user.role, expires, orgId, isPlatformAdmin); } catch (_) {}
  return token;
}

function validateSession(token) {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() > s.expires) { sessions.delete(token); try { db.deleteDbSession(token); } catch (_) {} return null; }
  return s;
}

function destroySession(token) {
  sessions.delete(token);
  try { db.deleteDbSession(token); } catch (_) {}
}

setInterval(() => {
  const now = Date.now();
  for (const [tok, s] of sessions) if (now > s.expires) sessions.delete(tok);
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
async function register(username, password, role = 'viewer', orgId = null, isPlatformAdmin = false) {
  if (!username || username.length < 2) throw new Error('Username must be at least 2 characters');
  if (!password || password.length < 6) throw new Error('Password must be at least 6 characters');
  if (!['admin', 'editor', 'viewer'].includes(role)) throw new Error('Role must be admin, editor or viewer');
  if (db.getUserByUsername(username)) throw new Error('Username already taken');
  const hash = await bcrypt.hash(password, 10);
  const id   = db.createUser(username, hash, role, orgId, isPlatformAdmin);
  logger.info(`User registered: ${username} (${role}${isPlatformAdmin ? ', platform-admin' : ''}, org=${orgId})`);
  return id;
}

async function login(username, password) {
  const user = db.getUserByUsername(username);
  if (!user) throw new Error('Invalid username or password');
  const ok = await bcrypt.compare(password, user.password);
  if (!ok)  throw new Error('Invalid username or password');
  db.touchUserLogin(user.id);
  const token = createSession(user);
  logger.info(`Login: ${username}`);
  const org = user.org_id ? db.getOrganization(user.org_id) : null;
  return {
    token, username: user.username, role: user.role,
    orgId: user.org_id, orgName: org?.name || null, isPlatformAdmin: !!user.is_platform_admin,
  };
}

async function changePassword(userId, oldPassword, newPassword) {
  const user = db.getDb().prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) throw new Error('User not found');
  const ok = await bcrypt.compare(oldPassword, user.password);
  if (!ok)  throw new Error('Current password is incorrect');
  if (newPassword.length < 6) throw new Error('New password must be at least 6 characters');
  db.updateUserPassword(userId, await bcrypt.hash(newPassword, 10));
}

async function adminSetPassword(userId, newPassword) {
  if (newPassword.length < 6) throw new Error('Password must be at least 6 characters');
  db.updateUserPassword(userId, await bcrypt.hash(newPassword, 10));
}

// ── Middleware ────────────────────────────────────────────────────────────────
function extractToken(req) {
  const auth = req.headers['authorization'] || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7);
  return null;
}

function requireAuth(req, res, next) {
  // Allow unauthenticated GET requests when public mode is active
  if (req.publicAccess && req.method === 'GET') {
    req.session = { userId: null, username: 'guest', role: 'viewer', orgId: getPublicOrgId(), isPlatformAdmin: false };
    return next();
  }
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

// ── First-run: create default admin + org if no users exist ──────────────────
async function ensureDefaultAdmin() {
  if (db.countUsers() === 0) {
    const orgId = db.createOrganization('My Organization', null);
    const pass = process.env.DEFAULT_ADMIN_PASS || crypto.randomBytes(12).toString('hex');
    await register('admin', pass, 'admin', orgId, true);
    logger.warn(`⚠  Default admin created  username=admin  password=${pass}`);
    logger.warn('   Change this password in Admin → Users immediately!');
  }
}

module.exports = {
  register, login, changePassword, adminSetPassword,
  createSession, validateSession, destroySession, initSessions, getPublicOrgId,
  requireAuth, requireAdmin, requireEditor, requirePlatformAdmin, ensureDefaultAdmin,
};
