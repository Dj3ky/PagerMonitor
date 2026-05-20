const express = require('express');
const router  = express.Router();
const { register, login, destroySession, requireAuth, requireAdmin,
        changePassword, adminSetPassword } = require('../services/auth');
const { getUsers, countUsers, deleteUser, updateUserRole, updateUserEmail, addAuditLog } = require('../services/database');
const logger = require('../utils/logger');

// POST /auth/login
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'username and password required' });
    const result = await login(username, password);
    res.json(result);
  } catch (e) {
    logger.warn(`Login failed: ${e.message}`);
    res.status(401).json({ error: e.message });
  }
});

// POST /auth/logout
router.post('/logout', requireAuth, (req, res) => {
  const token = (req.headers['authorization'] || '').replace('Bearer ', '');
  destroySession(token);
  res.json({ ok: true });
});

// GET /auth/me
router.get('/me', requireAuth, (req, res) => {
  const { getUsers } = require('../services/database');
  const u = getUsers().find(x => x.id === req.session.userId);
  res.json({ id: req.session.userId, username: req.session.username, role: req.session.role, email: u?.email || '' });
});

// POST /auth/change-password  (own password)
router.post('/change-password', requireAuth, async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body;
    await changePassword(req.session.userId, oldPassword, newPassword);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── Admin-only user management ─────────────────────────────────────────────
// POST /auth/register  (admin creates users)
router.post('/register', requireAdmin, async (req, res) => {
  try {
    const { username, password, role, email } = req.body;
    const validRoles = ['admin', 'editor', 'viewer'];
    const assignRole = validRoles.includes(role) ? role : 'viewer';
    const id = await register(username, password, assignRole);
    if (email) updateUserEmail(id, email);
    addAuditLog(req.session?.username||'admin', 'user.create', `username=${username} role=${assignRole}`);
    res.json({ ok: true, id });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// GET /auth/users
router.get('/users', requireAdmin, (_req, res) => {
  res.json(getUsers());
});

// PUT /auth/users/:id/role
router.put('/users/:id/role', requireAdmin, (req, res) => {
  try {
    updateUserRole(parseInt(req.params.id), req.body.role);
    addAuditLog(req.session.username, 'user.role_change', `id=${req.params.id} role=${req.body.role}`);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// POST /auth/users/:id/reset-password
router.post('/users/:id/reset-password', requireAdmin, async (req, res) => {
  try {
    await adminSetPassword(parseInt(req.params.id), req.body.password);
    addAuditLog(req.session.username, 'user.password_reset', `id=${req.params.id}`);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// DELETE /auth/users/:id
router.delete('/users/:id', requireAdmin, (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (id === req.session.userId) return res.status(400).json({ error: 'Cannot delete yourself' });
    const users = getUsers();
    const target = users.find(u => u.id === id);
    deleteUser(id);
    addAuditLog(req.session.username, 'user.delete', `id=${id} username=${target?.username || '?'}`);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// GET /auth/setup  — tells frontend if first-run (no users yet)
router.get('/setup', (_req, res) => {
  res.json({ needsSetup: countUsers() === 0 });
});

// PUT /auth/me/email — user updates their own email
router.put('/me/email', requireAuth, (req, res) => {
  try {
    const { updateUserEmail } = require('../services/database');
    updateUserEmail(req.session.userId, req.body.email);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// GET /auth/me/notif-prefs — user gets their own notification prefs
router.get('/me/notif-prefs', requireAuth, (req, res) => {
  try {
    const { getUserNotifPrefs } = require('../services/database');
    res.json(getUserNotifPrefs(req.session.userId));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /auth/me/notif-prefs — user sets their own notification prefs
router.put('/me/notif-prefs', requireAuth, (req, res) => {
  try {
    const { setUserNotifPrefs } = require('../services/database');
    setUserNotifPrefs(req.session.userId, req.body);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /auth/forgot-password — request reset email
router.post('/forgot-password', async (req, res) => {
  try {
    const { username } = req.body;
    if (!username) return res.status(400).json({ error: 'username required' });
    const { getUserByUsername } = require('../services/database');
    const { generateResetToken, sendPasswordReset, getEmailConfig } = require('../services/email');
    const cfg = getEmailConfig();
    if (!cfg.enabled) return res.status(503).json({ error: 'Email not configured on this server' });
    const user = getUserByUsername(username);
    // Always return ok to avoid user enumeration
    if (user?.email) {
      const token = generateResetToken(user.id);
      const baseUrl = req.headers.origin || `http://${req.headers.host}`;
      const resetUrl = `${baseUrl}/?reset=${token}`;
      await sendPasswordReset(user, resetUrl).catch(e => logger.warn(`Reset email failed: ${e.message}`));
    }
    res.json({ ok: true, message: 'If this account exists and has an email, a reset link has been sent.' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /auth/reset-password — consume token, set new password
router.post('/reset-password', async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) return res.status(400).json({ error: 'token and password required' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    const { consumeResetToken } = require('../services/email');
    const userId = consumeResetToken(token);
    if (!userId) return res.status(400).json({ error: 'Invalid or expired reset link' });
    await adminSetPassword(userId, password);
    addAuditLog('system', 'user.password_reset_via_email', `userId=${userId}`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
