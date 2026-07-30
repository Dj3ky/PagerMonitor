const express = require('express');
const router  = express.Router();
const { register, login, destroySession, requireAuth, requireAdmin, requirePlatformAdmin,
        changePassword, adminSetPassword } = require('../services/auth');
const {
  getUsers, getUserById, countUsers, deleteUser, updateUserRole, updateUserEmail, setUserOrg,
  setUserPlatformAdmin, getInviteByCode, consumeInvite, addAuditLog, getDb, getOrganization,
} = require('../services/database');
const logger = require('../utils/logger');

// A caller may manage a target user if they're platform admin (any user, any org) or
// the target belongs to their own org. Org-admins can never reach another org's users
// even by guessing an id.
function ownsUser(req, targetId) {
  if (req.session.isPlatformAdmin) return true;
  const target = getUserById(targetId);
  return !!target && target.org_id === req.session.orgId;
}

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

// POST /auth/join — consume an invite code, create the user in the invite's org/role, log in.
// Public (no auth) — mirrors /auth/login's response shape so the frontend reuses its existing
// post-login flow. A future self-service /auth/signup (creates a fresh org instead of joining
// an existing one) would share this same "create user + create session" tail.
router.post('/join', async (req, res) => {
  try {
    const { code, username, password, email } = req.body;
    if (!code) return res.status(400).json({ error: 'Invite code required' });
    const invite = getInviteByCode(code);
    if (!invite) return res.status(400).json({ error: 'Invalid invite code' });
    if (invite.revoked) return res.status(400).json({ error: 'This invite has been revoked' });
    if (invite.expires_at && new Date(invite.expires_at).getTime() < Date.now()) {
      return res.status(400).json({ error: 'This invite has expired' });
    }
    if (invite.max_uses > 0 && invite.use_count >= invite.max_uses) {
      return res.status(400).json({ error: 'This invite has reached its usage limit' });
    }

    const id = await register(username, password, invite.role, invite.org_id);
    if (email) updateUserEmail(id, email);
    consumeInvite(code, id); // atomic re-check + increment, guards the max_uses race
    addAuditLog(username, 'user.join_via_invite', `invite_id=${invite.id}`, invite.org_id);

    const result = await login(username, password);
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// POST /auth/logout
router.post('/logout', requireAuth, (req, res) => {
  const token = (req.headers['authorization'] || '').replace('Bearer ', '');
  destroySession(token);
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
  });
});

// POST /auth/change-password  (own password)
router.post('/change-password', requireAuth, async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body;
    await changePassword(req.session.userId, oldPassword, newPassword);
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
  res.json(getUsers(orgId));
});

// PUT /auth/users/:id/role
router.put('/users/:id/role', requireAdmin, (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!ownsUser(req, id)) return res.status(403).json({ error: 'Cannot manage a user outside your organization' });
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
    if (!ownsUser(req, id)) return res.status(403).json({ error: 'Cannot manage a user outside your organization' });
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
    if (!ownsUser(req, id)) return res.status(403).json({ error: 'Cannot manage a user outside your organization' });
    const target = getUserById(id);
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
