const express = require('express');
const router  = express.Router();
const { register, prepareNewUser, login, destroySession, requireAuth, requireAdmin, requirePlatformAdmin,
        changePassword, adminSetPassword, manageUserError, extractToken, MIN_PASSWORD_LENGTH } = require('../services/auth');
const { loginLimiters, forgotPasswordLimiters, resetPasswordLimiter, joinLimiter } = require('../utils/rateLimits');
const {
  getUsers, getUserById, countUsers, deleteUser, updateUserRole, updateUserEmail, setUserOrg,
  setUserPlatformAdmin, getInviteByCode, inviteError, createUserFromInvite, addAuditLog, getDb, getOrganization,
  updateUserUiLanguage, getSetting,
} = require('../services/database');
const logger = require('../utils/logger');


// POST /auth/login
router.post('/login', loginLimiters, async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password || typeof username !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ error: 'username and password required' });
    }
    const result = await login(username, password);
    res.json(result);
  } catch (e) {
    logger.warn(`Login failed: ${e.message}`);
    res.status(401).json({ error: e.message });
  }
});

// POST /auth/join — consume an invite code, create the user in the invite's org/role, log in.
// Public (no auth) — mirrors /auth/login's response shape so the frontend reuses its existing
// post-login flow. A future self-service /auth/signup (creates a fresh org instead of joining
// an existing one) would share this same "create user + create session" tail.
router.post('/join', joinLimiter, async (req, res) => {
  try {
    const { code, username, password, email } = req.body;
    if (!code || typeof code !== 'string') return res.status(400).json({ error: 'Invite code required' });
    // Early check for a friendly error before spending time on the password hash; the
    // authoritative re-check happens inside createUserFromInvite's transaction.
    const pending = getInviteByCode(code);
    const invalid = inviteError(pending);
    if (invalid) return res.status(400).json({ error: invalid });

    const hash = await prepareNewUser(username, password, pending.role);
    const { userId, invite } = createUserFromInvite(code, username, hash, email);
    logger.info(`User registered via invite: ${username} (${invite.role}, org=${invite.org_id}, id=${userId})`);
    addAuditLog(username, 'user.join_via_invite', `invite_id=${invite.id}`, invite.org_id);

    const result = await login(username, password);
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// POST /auth/logout
router.post('/logout', requireAuth, (req, res) => {
  destroySession(extractToken(req));
  res.json({ ok: true });
});

// GET /auth/me
router.get('/me', requireAuth, (req, res) => {
  const u   = req.session.userId ? getUserById(req.session.userId) : null;
  const org = req.session.orgId ? getOrganization(req.session.orgId) : null;
  res.json({
    id: req.session.userId, username: req.session.username, role: req.session.role,
    orgId: req.session.orgId, orgName: org?.name || null, isPlatformAdmin: !!req.session.isPlatformAdmin,
    email: u?.email || '',
    uiLanguage: u?.ui_language || null,
  });
});

// POST /auth/change-password  (own password)
router.post('/change-password', requireAuth, async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body;
    if (typeof oldPassword !== 'string' || typeof newPassword !== 'string') {
      return res.status(400).json({ error: 'Current and new password required' });
    }
    // Every other session of this user is logged out; the one making the change stays.
    await changePassword(req.session.userId, oldPassword, newPassword, extractToken(req));
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── Admin-only user management (org-scoped, unless caller is platform admin) ──
// POST /auth/register  (admin creates users into their own org; platform admin may target any org)
router.post('/register', requireAdmin, async (req, res) => {
  try {
    const { username, password, role, email, org_id } = req.body;
    const validRoles = ['admin', 'editor', 'viewer'];
    const assignRole = validRoles.includes(role) ? role : 'viewer';
    const targetOrgId = (req.session.isPlatformAdmin && org_id != null) ? parseInt(org_id) : req.session.orgId;
    const id = await register(username, password, assignRole, targetOrgId);
    if (email) updateUserEmail(id, email);
    addAuditLog(req.session?.username||'admin', 'user.create', `username=${username} role=${assignRole}`, req.session.orgId);
    res.json({ ok: true, id });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// GET /auth/users — org-admin sees their own org; platform admin sees all (or ?org_id= to filter)
router.get('/users', requireAdmin, (req, res) => {
  const orgId = req.session.isPlatformAdmin
    ? (req.query.org_id ? parseInt(req.query.org_id) : null)
    : req.session.orgId;
  const online = require('../services/websocket').getConnectedUsernames();
  res.json(getUsers(orgId).map(u => ({ ...u, online: online.has(u.username) })));
});

// PUT /auth/users/:id/role
router.put('/users/:id/role', requireAdmin, (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const denied = manageUserError(req.session, getUserById(id));
    if (denied) return res.status(denied.status).json({ error: denied.error });
    if (!['admin', 'editor', 'viewer'].includes(req.body.role)) return res.status(400).json({ error: 'Role must be admin, editor or viewer' });
    updateUserRole(id, req.body.role);
    addAuditLog(req.session.username, 'user.role_change', `id=${id} role=${req.body.role}`, req.session.orgId);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// PUT /auth/users/:id/org — platform admin only: reassign a user to a different organization
router.put('/users/:id/org', requirePlatformAdmin, (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const orgId = parseInt(req.body.org_id);
    if (!orgId) return res.status(400).json({ error: 'org_id required' });
    setUserOrg(id, orgId);
    addAuditLog(req.session.username, 'user.org_reassign', `id=${id} org_id=${orgId}`);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// PUT /auth/users/:id/platform-admin — platform admin only: grant/revoke platform-admin access
router.put('/users/:id/platform-admin', requirePlatformAdmin, (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const grant  = !!req.body.isPlatformAdmin;
    const target = getUserById(id);
    if (!grant && target?.is_platform_admin) {
      // Don't allow the last platform admin to be revoked, leaving nobody able to
      // reach instance settings.
      const remaining = getDb().prepare('SELECT COUNT(*) as n FROM users WHERE is_platform_admin = 1 AND id != ?').get(id).n;
      if (remaining === 0) return res.status(400).json({ error: 'Cannot remove the last platform admin' });
    }
    setUserPlatformAdmin(id, grant);
    addAuditLog(req.session.username, 'user.platform_admin_set', `id=${id} value=${grant}`);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// POST /auth/users/:id/reset-password
router.post('/users/:id/reset-password', requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const denied = manageUserError(req.session, getUserById(id));
    if (denied) return res.status(denied.status).json({ error: denied.error });
    await adminSetPassword(id, req.body.password);
    addAuditLog(req.session.username, 'user.password_reset', `id=${id}`, req.session.orgId);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// DELETE /auth/users/:id
router.delete('/users/:id', requireAdmin, (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (id === req.session.userId) return res.status(400).json({ error: 'Cannot delete yourself' });
    const target = getUserById(id);
    const denied = manageUserError(req.session, target);
    if (denied) return res.status(denied.status).json({ error: denied.error });
    if (target.is_platform_admin) {
      const remaining = getDb().prepare('SELECT COUNT(*) as n FROM users WHERE is_platform_admin = 1 AND id != ?').get(id).n;
      if (remaining === 0) return res.status(400).json({ error: 'Cannot delete the last platform admin' });
    }
    deleteUser(id);
    addAuditLog(req.session.username, 'user.delete', `id=${id} username=${target?.username || '?'}`, req.session.orgId);
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
    updateUserEmail(req.session.userId, req.body.email);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// PUT /auth/me/language — user overrides their own UI language, independent of the
// site-wide locale setting (which still governs date/time formatting for everyone).
// null clears the override so the site default applies again.
const UI_LANGUAGES = ['en', 'sl'];
router.put('/me/language', requireAuth, (req, res) => {
  try {
    const lang = req.body.uiLanguage;
    if (lang != null && !UI_LANGUAGES.includes(lang)) {
      return res.status(400).json({ error: 'Invalid language' });
    }
    updateUserUiLanguage(req.session.userId, lang || null);
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
router.post('/forgot-password', forgotPasswordLimiters, async (req, res) => {
  try {
    const { username } = req.body;
    if (!username || typeof username !== 'string') return res.status(400).json({ error: 'username required' });
    const { getUserByUsername } = require('../services/database');
    const { generateResetToken, sendPasswordReset, getEmailConfig } = require('../services/email');
    const cfg = getEmailConfig();
    if (!cfg.enabled) return res.status(503).json({ error: 'Email not configured on this server' });
    // Reset links are built from the admin-configured public URL only — never from the
    // request's Origin/Host headers, which the requester controls (an attacker could
    // otherwise make a victim's genuine reset email point at a domain they own).
    const publicUrl = getSetting('site_settings', {}).publicUrl || '';
    if (!publicUrl) {
      logger.warn('Password reset requested, but no public URL is configured (Admin → Site settings)');
      return res.status(503).json({ error: 'Password reset is not available — the server has no public URL configured' });
    }
    const user = getUserByUsername(username);
    // Always return ok to avoid user enumeration
    if (user?.email) {
      const token = generateResetToken(user.id);
      const resetUrl = `${publicUrl}/?reset=${token}`;
      await sendPasswordReset(user, resetUrl).catch(e => logger.warn(`Reset email failed: ${e.message}`));
    }
    res.json({ ok: true, message: 'If this account exists and has an email, a reset link has been sent.' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /auth/reset-password — consume token, set new password
router.post('/reset-password', resetPasswordLimiter, async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password || typeof password !== 'string') return res.status(400).json({ error: 'token and password required' });
    // Checked before the token is consumed, so a too-short password doesn't burn the link
    if (password.length < MIN_PASSWORD_LENGTH) return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
    const { consumeResetToken } = require('../services/email');
    const userId = consumeResetToken(token);
    if (!userId) return res.status(400).json({ error: 'Invalid or expired reset link' });
    await adminSetPassword(userId, password);
    addAuditLog('system', 'user.password_reset_via_email', `userId=${userId}`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
