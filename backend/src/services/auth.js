const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db     = require('./database');
const logger = require('../utils/logger');

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const sessions = new Map(); // token → { userId, username, role, expires }

// ── Sessions ──────────────────────────────────────────────────────────────────
function createSession(user) {
  const token   = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { userId: user.id, username: user.username, role: user.role, expires: Date.now() + SESSION_TTL_MS });
  return token;
}

function validateSession(token) {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() > s.expires) { sessions.delete(token); return null; }
  return s;
}

function destroySession(token) { sessions.delete(token); }

setInterval(() => {
  const now = Date.now();
  for (const [tok, s] of sessions) if (now > s.expires) sessions.delete(tok);
}, 60 * 60 * 1000);

// ── User ops ──────────────────────────────────────────────────────────────────
async function register(username, password, role = 'viewer') {
  if (!username || username.length < 2) throw new Error('Username must be at least 2 characters');
  if (!password || password.length < 6) throw new Error('Password must be at least 6 characters');
  if (!['admin', 'editor', 'viewer'].includes(role)) throw new Error('Role must be admin, editor or viewer');
  if (db.getUserByUsername(username)) throw new Error('Username already taken');
  const hash = await bcrypt.hash(password, 10);
  const id   = db.createUser(username, hash, role);
  logger.info(`User registered: ${username} (${role})`);
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
  return { token, username: user.username, role: user.role };
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
    req.session = { userId: null, username: 'guest', role: 'viewer' };
    return next();
  }
  const s = validateSession(extractToken(req));
  if (!s) return res.status(401).json({ error: 'Not authenticated' });
  req.session = s;
  next();
}

function requireAdmin(req, res, next) {
  const s = validateSession(extractToken(req));
  if (!s)              return res.status(401).json({ error: 'Not authenticated' });
  if (s.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  req.session = s;
  next();
}

// Editor or above — can manage aliases, groups, rules, keyword alerts
function requireEditor(req, res, next) {
  const s = validateSession(extractToken(req));
  if (!s) return res.status(401).json({ error: 'Not authenticated' });
  if (s.role !== 'admin' && s.role !== 'editor') return res.status(403).json({ error: 'Editor access required' });
  req.session = s;
  next();
}

// ── First-run: create default admin if no users exist ────────────────────────
async function ensureDefaultAdmin() {
  if (db.countUsers() === 0) {
    const pass = process.env.DEFAULT_ADMIN_PASS || 'admin123';
    await register('admin', pass, 'admin');
    logger.warn(`⚠  Default admin created  username=admin  password=${pass}`);
    logger.warn('   Change this password in Admin → Users immediately!');
  }
}

module.exports = {
  register, login, changePassword, adminSetPassword,
  createSession, validateSession, destroySession,
  requireAuth, requireAdmin, requireEditor, ensureDefaultAdmin,
};
