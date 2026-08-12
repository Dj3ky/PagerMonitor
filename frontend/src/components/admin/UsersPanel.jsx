import { useState } from 'react';
import { Users, UserPlus, Trash2, Key, ShieldCheck, LogOut, Pencil, Save, X, Mail, Link2, Copy, Ban } from 'lucide-react';
import { authUsers, authRegister, authSetRole, authResetPw, authDeleteUser, authChangePw, adminSetUserEmail,
         adminFetchInvites, adminCreateInvite, adminRevokeInvite, adminRenameOwnOrg } from '../../utils/api.js';
import { useAdminFetch } from '../../hooks/useAdminFetch.js';
import { useAuth } from '../../context/AuthContext.jsx';

function Flash({ msg }) {
  if (!msg) return null;
  const ok = msg.type === 'ok';
  return (
    <div style={{ padding:'0.45rem 0.75rem', borderRadius:'0.4rem', fontSize:'0.78rem', fontFamily:'monospace', marginBottom:'0.75rem',
      color: ok ? 'var(--accent-green)' : 'var(--accent-red)',
      background: `color-mix(in srgb, ${ok ? 'var(--accent-green)' : 'var(--accent-red)'} 10%, transparent)`,
      border: `1px solid color-mix(in srgb, ${ok ? 'var(--accent-green)' : 'var(--accent-red)'} 30%, transparent)`,
    }}>{msg.text}</div>
  );
}

function UserRow({ u, me, onRole, onDelete, onEdit }) {
  return (
    <div style={{ display:'flex', alignItems:'center', gap:'0.5rem', padding:'0.6rem 0',
      borderBottom:'1px solid var(--border-soft)', flexWrap:'wrap' }}>
      <ShieldCheck size={14} style={{ color: u.role === 'admin' ? 'var(--accent-amber)' : 'var(--text-3)', flexShrink:0 }} />
      <div style={{ flex:1, minWidth:0 }}>
        <div style={{ fontFamily:'monospace', fontSize:'0.85rem', color:'var(--text-1)', display:'flex', alignItems:'center', gap:'0.4rem' }}>
          {u.username}
          {u.username === me?.username && <span style={{ fontSize:'0.65rem', color:'var(--accent-green)' }}>(you)</span>}
        </div>
        {u.email && (
          <div style={{ fontSize:'0.7rem', color:'var(--text-3)', fontFamily:'monospace', display:'flex', alignItems:'center', gap:'0.25rem' }}>
            <Mail size={10}/> {u.email}
          </div>
        )}
      </div>
      <select value={u.role || 'viewer'} onChange={e => onRole(u.id, e.target.value)}
        disabled={u.username === me?.username}
        style={{ background:'var(--bg-3)', border:'1px solid var(--border)', color:'var(--text-2)',
          borderRadius:'0.35rem', padding:'0.2rem 0.4rem', fontSize:'0.75rem', cursor:'pointer', flexShrink:0 }}>
        <option value="admin">admin</option>
        <option value="editor">editor</option>
        <option value="viewer">viewer</option>
      </select>
      <button onClick={() => onEdit(u)} title="Edit email / reset password"
        style={{ background:'none', border:'none', cursor:'pointer', color:'var(--text-3)', padding:'0.2rem' }}>
        <Pencil size={13}/>
      </button>
      <button onClick={() => onDelete(u.id, u.username)} disabled={u.username === me?.username}
        style={{ background:'none', border:'none', cursor:'pointer', padding:'0.2rem',
          color: u.username === me?.username ? 'var(--text-3)' : 'var(--accent-red)' }}>
        <Trash2 size={13}/>
      </button>
    </div>
  );
}

export default function UsersPanel() {
  const { user: me, logout, refreshUser } = useAuth();
  const { data: users, loading, reload } = useAdminFetch(() => authUsers(me?.orgId), [me?.orgId]);
  const { data: invites, loading: invitesLoading, reload: reloadInvites } = useAdminFetch(adminFetchInvites, []);
  const [msg, setMsg]         = useState(null);
  const [newUser, setNewUser] = useState({ username:'', password:'', email:'', role:'viewer' });
  const [pwForm, setPwForm]   = useState({ oldPassword:'', newPassword:'' });
  const [editTarget, setEditTarget] = useState(null); // user being edited
  const [editEmail, setEditEmail]   = useState('');
  const [editPw, setEditPw]         = useState('');
  const [inviteForm, setInviteForm] = useState({ role:'viewer', expiresInDays:'7', maxUses:'1' });
  const [lastInviteUrl, setLastInviteUrl] = useState(null);
  const [renamingOrg, setRenamingOrg] = useState(false);
  const [orgNameDraft, setOrgNameDraft] = useState('');

  const flash = (type, text) => { setMsg({ type, text }); setTimeout(() => setMsg(null), 4000); };
  const safeUsers   = Array.isArray(users) ? users : [];

  const startRenameOrg = () => { setOrgNameDraft(me?.orgName || ''); setRenamingOrg(true); };
  const handleRenameOrg = async () => {
    if (!orgNameDraft.trim()) return;
    try {
      await adminRenameOwnOrg(orgNameDraft.trim());
      flash('ok', 'Organization renamed');
      setRenamingOrg(false);
      refreshUser();
    } catch (e) { flash('err', e.message); }
  };
  const safeInvites = Array.isArray(invites) ? invites : [];

  const handleCreateInvite = async () => {
    try {
      const { code } = await adminCreateInvite(
        inviteForm.role,
        inviteForm.expiresInDays ? parseInt(inviteForm.expiresInDays) : null,
        inviteForm.maxUses ? parseInt(inviteForm.maxUses) : 0,
      );
      const url = `${window.location.origin}/?invite=${code}`;
      setLastInviteUrl(url);
      flash('ok', 'Invite created — copy the link below');
      reloadInvites();
    } catch (e) { flash('err', e.message); }
  };

  const handleRevokeInvite = async (id) => {
    try { await adminRevokeInvite(id); flash('ok', 'Invite revoked'); reloadInvites(); }
    catch (e) { flash('err', e.message); }
  };

  const copyInviteUrl = (code) => {
    const url = `${window.location.origin}/?invite=${code}`;
    navigator.clipboard?.writeText(url).then(() => flash('ok', 'Join link copied')).catch(() => setLastInviteUrl(url));
  };

  const handleAdd = async () => {
    if (!newUser.username || newUser.password.length < 6) { flash('err', 'Username required, password min 6 chars'); return; }
    try {
      await authRegister(newUser.username, newUser.password, newUser.role, newUser.email || undefined);
      flash('ok', `User "${newUser.username}" created`);
      setNewUser({ username:'', password:'', email:'', role:'viewer' });
      reload();
    } catch (e) { flash('err', e.message); }
  };

  const handleRole = async (id, role) => {
    try { await authSetRole(id, role); flash('ok', 'Role updated'); reload(); }
    catch (e) { flash('err', e.message); }
  };

  const handleDelete = async (id, username) => {
    if (!confirm(`Delete user "${username}"?`)) return;
    try { await authDeleteUser(id); flash('ok', `Deleted ${username}`); reload(); }
    catch (e) { flash('err', e.message); }
  };

  const openEdit = (u) => { setEditTarget(u); setEditEmail(u.email || ''); setEditPw(''); };

  const handleEdit = async () => {
    if (!editTarget) return;
    try {
      // Save email
      await adminSetUserEmail(editTarget.id, editEmail);
      // Reset password if provided
      if (editPw) {
        if (editPw.length < 6) { flash('err', 'Password min 6 characters'); return; }
        await authResetPw(editTarget.id, editPw);
      }
      flash('ok', `${editTarget.username} updated`);
      setEditTarget(null);
      reload();
    } catch (e) { flash('err', e.message); }
  };

  const handleChangePw = async () => {
    if (!pwForm.oldPassword || pwForm.newPassword.length < 6) { flash('err', 'New password min 6 chars'); return; }
    try { await authChangePw(pwForm.oldPassword, pwForm.newPassword); flash('ok', 'Password changed'); setPwForm({ oldPassword:'', newPassword:'' }); }
    catch (e) { flash('err', e.message); }
  };

  return (
    <div style={{ maxWidth:'640px' }}>
      <h2 style={{ fontSize:'1rem', fontWeight:700, color:'var(--text-1)', marginBottom:'1rem',
        display:'flex', alignItems:'center', gap:'0.5rem', flexWrap:'wrap' }}>
        <Users size={16} style={{ color:'var(--accent-blue)' }} /> Users & Access
        {renamingOrg ? (
          <span style={{ display:'flex', alignItems:'center', gap:'0.3rem' }}>
            <input className="pm-input" style={{ fontSize:'0.78rem', fontWeight:400, padding:'0.15rem 0.4rem' }}
              value={orgNameDraft} onChange={e => setOrgNameDraft(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleRenameOrg()} autoFocus />
            <button onClick={handleRenameOrg} style={{ background:'none', border:'none', cursor:'pointer', color:'var(--accent-green)' }}><Save size={14}/></button>
            <button onClick={() => setRenamingOrg(false)} style={{ background:'none', border:'none', cursor:'pointer', color:'var(--text-3)' }}><X size={14}/></button>
          </span>
        ) : (
          me?.orgName && (
            <span style={{ fontSize:'0.72rem', fontWeight:400, color:'var(--text-3)', display:'flex', alignItems:'center', gap:'0.25rem' }}>
              — {me.orgName}
              {me?.role === 'admin' && (
                <button onClick={startRenameOrg} title="Rename organization"
                  style={{ background:'none', border:'none', cursor:'pointer', color:'var(--text-3)', padding:'0.1rem' }}>
                  <Pencil size={11}/>
                </button>
              )}
            </span>
          )
        )}
      </h2>

      <Flash msg={msg} />

      {/* User list */}
      <div className="pm-card" style={{ marginBottom:'1rem' }}>
        <div className="pm-section-title">Registered users</div>
        {loading
          ? <div style={{ color:'var(--text-3)', fontSize:'0.82rem' }}>Loading…</div>
          : safeUsers.length === 0
            ? <div style={{ color:'var(--text-3)', fontSize:'0.82rem' }}>No users.</div>
            : safeUsers.map(u => (
              <UserRow key={u.id} u={u} me={me}
                onRole={handleRole} onDelete={handleDelete} onEdit={openEdit} />
            ))
        }
      </div>

      {/* Invites — let someone join your organization directly, sharing your groups/aliases/filter */}
      <div className="pm-card" style={{ marginBottom:'1rem' }}>
        <div className="pm-section-title"><Link2 size={13}/> Invite links</div>
        <p style={{ fontSize:'0.78rem', color:'var(--text-3)', margin:'0 0 0.6rem' }}>
          Anyone who joins via an invite link lands in your organization immediately, seeing the
          same groups, aliases, and feed filter you already have — not a copy, the same live setup.
        </p>
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:'0.5rem', marginBottom:'0.6rem', alignItems:'end' }}>
          <div style={{ display:'flex', flexDirection:'column' }}>
            <label className="pm-label" style={{ minHeight:'2rem' }}>Role granted</label>
            <select value={inviteForm.role} onChange={e => setInviteForm(f => ({ ...f, role: e.target.value }))}
              style={{ background:'var(--bg-3)', border:'1px solid var(--border)', color:'var(--text-2)',
                borderRadius:'0.5rem', padding:'0.4rem 0.5rem', fontSize:'0.8rem', width:'100%' }}>
              <option value="viewer">viewer</option>
              <option value="editor">editor</option>
              <option value="admin">admin</option>
            </select>
          </div>
          <div style={{ display:'flex', flexDirection:'column' }}>
            <label className="pm-label" style={{ minHeight:'2rem' }}>Expires in (days, blank = never)</label>
            <input className="pm-input" type="number" min="0" value={inviteForm.expiresInDays}
              onChange={e => setInviteForm(f => ({ ...f, expiresInDays: e.target.value }))} />
          </div>
          <div style={{ display:'flex', flexDirection:'column' }}>
            <label className="pm-label" style={{ minHeight:'2rem' }}>Max uses (0 = unlimited)</label>
            <input className="pm-input" type="number" min="0" value={inviteForm.maxUses}
              onChange={e => setInviteForm(f => ({ ...f, maxUses: e.target.value }))} />
          </div>
        </div>
        <button className="pm-btn pm-btn-primary" onClick={handleCreateInvite}>
          <Link2 size={13}/> Generate invite link
        </button>

        {lastInviteUrl && (
          <div style={{ display:'flex', alignItems:'center', gap:'0.5rem', marginTop:'0.6rem',
            padding:'0.4rem 0.6rem', background:'var(--bg-2)', border:'1px solid var(--border)', borderRadius:'0.4rem' }}>
            <input readOnly value={lastInviteUrl} className="pm-input" style={{ flex:1, fontSize:'0.72rem' }}
              onFocus={e => e.target.select()} />
            <button className="pm-btn" onClick={() => navigator.clipboard?.writeText(lastInviteUrl)}>
              <Copy size={12}/> Copy
            </button>
          </div>
        )}

        {!invitesLoading && safeInvites.length > 0 && (
          <div style={{ marginTop:'0.75rem' }}>
            {safeInvites.map(inv => (
              <div key={inv.id} style={{ display:'flex', alignItems:'center', gap:'0.5rem', padding:'0.4rem 0',
                borderBottom:'1px solid var(--border-soft)', fontSize:'0.78rem', flexWrap:'wrap' }}>
                <span style={{ fontFamily:'monospace', color:'var(--text-2)' }}>{inv.role}</span>
                <span style={{ color:'var(--text-3)' }}>
                  {inv.use_count}/{inv.max_uses || '∞'} used
                  {inv.expires_at ? ` · expires ${new Date(inv.expires_at).toLocaleDateString()}` : ''}
                  {inv.revoked ? ' · revoked' : ''}
                </span>
                <span style={{ flex:1 }} />
                {!inv.revoked && (
                  <>
                    <button className="pm-btn" onClick={() => copyInviteUrl(inv.code)}><Copy size={12}/> Copy link</button>
                    <button className="pm-btn pm-btn-danger" onClick={() => handleRevokeInvite(inv.id)}><Ban size={12}/> Revoke</button>
                  </>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Edit user panel */}
      {editTarget && (
        <div className="pm-card" style={{ marginBottom:'1rem',
          borderColor:'color-mix(in srgb, var(--accent-blue) 30%, var(--border))' }}>
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:'0.75rem' }}>
            <div className="pm-section-title" style={{ margin:0 }}>
              <Pencil size={13}/> Edit — {editTarget.username}
            </div>
            <button onClick={() => setEditTarget(null)}
              style={{ background:'none', border:'none', cursor:'pointer', color:'var(--text-3)' }}>
              <X size={16}/>
            </button>
          </div>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'0.5rem', marginBottom:'0.75rem' }}>
            <div style={{ gridColumn:'1/-1' }}>
              <label className="pm-label"><Mail size={11}/> Email address</label>
              <input className="pm-input" type="email" value={editEmail}
                onChange={e => setEditEmail(e.target.value)} placeholder="user@example.com" />
            </div>
            <div style={{ gridColumn:'1/-1' }}>
              <label className="pm-label"><Key size={11}/> New password (leave empty to keep current)</label>
              <input className="pm-input" type="password" value={editPw}
                onChange={e => setEditPw(e.target.value)} placeholder="Leave empty to keep current" />
              {editPw.length > 0 && editPw.length < 6 && (
                <div style={{ fontSize:'0.68rem', color:'var(--accent-red)', marginTop:'0.2rem', fontFamily:'monospace' }}>
                  {editPw.length}/6 — too short
                </div>
              )}
            </div>
          </div>
          <div style={{ display:'flex', gap:'0.5rem' }}>
            <button className="pm-btn pm-btn-primary" onClick={handleEdit}>
              <Save size={13}/> Save changes
            </button>
            <button className="pm-btn" onClick={() => setEditTarget(null)}>Cancel</button>
          </div>
        </div>
      )}

      {/* Add user */}
      <div className="pm-card" style={{ marginBottom:'1rem' }}>
        <div className="pm-section-title"><UserPlus size={13}/> Add user</div>
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'0.5rem', marginBottom:'0.5rem' }}>
          <div>
            <label className="pm-label">Username</label>
            <input className="pm-input" placeholder="username" value={newUser.username}
              onChange={e => setNewUser(u => ({ ...u, username: e.target.value }))} />
          </div>
          <div>
            <label className="pm-label">Role</label>
            <select value={newUser.role} onChange={e => setNewUser(u => ({ ...u, role: e.target.value }))}
              style={{ background:'var(--bg-3)', border:'1px solid var(--border)', color:'var(--text-2)',
                borderRadius:'0.5rem', padding:'0.4rem 0.5rem', fontSize:'0.8rem', width:'100%' }}>
              <option value="viewer">viewer</option>
              <option value="editor">editor</option>
              <option value="admin">admin</option>
            </select>
          </div>
          <div>
            <label className="pm-label">Password (min 6)</label>
            <input className="pm-input" type="password" placeholder="Password" value={newUser.password}
              onChange={e => setNewUser(u => ({ ...u, password: e.target.value }))} />
            {newUser.password.length > 0 && newUser.password.length < 6 && (
              <div style={{ fontSize:'0.68rem', color:'var(--accent-red)', marginTop:'0.2rem', fontFamily:'monospace' }}>
                {newUser.password.length}/6 — too short
              </div>
            )}
          </div>
          <div>
            <label className="pm-label">Email (optional)</label>
            <input className="pm-input" type="email" placeholder="user@example.com" value={newUser.email}
              onChange={e => setNewUser(u => ({ ...u, email: e.target.value }))} />
          </div>
        </div>
        <button className="pm-btn pm-btn-primary" onClick={handleAdd}
          disabled={!newUser.username || newUser.password.length < 6}>
          <UserPlus size={13}/> Create user
        </button>
      </div>

      {/* Change my password */}
      <div className="pm-card" style={{ marginBottom:'1rem' }}>
        <div className="pm-section-title"><Key size={13}/> Change my password</div>
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'0.5rem', marginBottom:'0.5rem' }}>
          <input className="pm-input" type="password" placeholder="Current password"
            value={pwForm.oldPassword} onChange={e => setPwForm(f => ({ ...f, oldPassword: e.target.value }))} />
          <div>
            <input className="pm-input" type="password" placeholder="New password (min 6)"
              value={pwForm.newPassword} onChange={e => setPwForm(f => ({ ...f, newPassword: e.target.value }))} />
            {pwForm.newPassword.length > 0 && pwForm.newPassword.length < 6 && (
              <div style={{ fontSize:'0.68rem', color:'var(--accent-red)', marginTop:'0.2rem', fontFamily:'monospace' }}>
                {pwForm.newPassword.length}/6 — too short
              </div>
            )}
          </div>
        </div>
        <button className="pm-btn pm-btn-primary" onClick={handleChangePw} disabled={!pwForm.oldPassword}>
          <Key size={13}/> Change password
        </button>
      </div>

      <button className="pm-btn pm-btn-danger" onClick={logout}>
        <LogOut size={13}/> Sign out
      </button>
    </div>
  );
}
