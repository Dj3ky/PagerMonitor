import { useState } from 'react';
import { Server, Plus, Users2, ArrowRightLeft } from 'lucide-react';
import { adminFetchOrgs, adminCreateOrg, authUsers, authSetUserOrg } from '../../utils/api.js';
import { useAdminFetch } from '../../hooks/useAdminFetch.js';
import { useAuth } from '../../context/AuthContext.jsx';

function Flash({ msg }) {
  if (!msg) return null;
  const ok = msg.type === 'ok';
  return (
    <div style={{ padding:'0.4rem 0.75rem', borderRadius:'0.4rem', fontSize:'0.78rem', fontFamily:'monospace', marginBottom:'0.75rem',
      color: ok ? 'var(--accent-green)' : 'var(--accent-red)',
      background: `color-mix(in srgb, ${ok ? 'var(--accent-green)' : 'var(--accent-red)'} 10%, transparent)`,
      border: `1px solid color-mix(in srgb, ${ok ? 'var(--accent-green)' : 'var(--accent-red)'} 30%, transparent)`,
    }}>{msg.text}</div>
  );
}

// Platform-admin only — every org on the instance, plus a cross-org user list with the
// ability to move someone from one org into another (e.g. splitting a user out of the
// auto-created "Default Organization" into their own isolated workspace).
export default function Organizations() {
  const { user: me } = useAuth();
  const { data: orgsRaw, loading: orgsLoading, reload: reloadOrgs } = useAdminFetch(adminFetchOrgs, []);
  const { data: usersRaw, loading: usersLoading, reload: reloadUsers } = useAdminFetch(() => authUsers(), []);
  const orgs  = Array.isArray(orgsRaw) ? orgsRaw : [];
  const users = Array.isArray(usersRaw) ? usersRaw : [];

  const [newOrgName, setNewOrgName] = useState('');
  const [msg, setMsg] = useState(null);
  const flash = (type, text) => { setMsg({ type, text }); setTimeout(() => setMsg(null), 3500); };

  const handleCreateOrg = async () => {
    if (!newOrgName.trim()) return;
    try {
      await adminCreateOrg(newOrgName.trim());
      flash('ok', `Organization "${newOrgName.trim()}" created`);
      setNewOrgName('');
      reloadOrgs();
    } catch (e) { flash('err', e.message); }
  };

  const handleMove = async (userId, orgId) => {
    try {
      await authSetUserOrg(userId, parseInt(orgId));
      flash('ok', 'User moved');
      reloadUsers();
      reloadOrgs(); // user counts change
    } catch (e) { flash('err', e.message); }
  };

  return (
    <div style={{ maxWidth:'720px' }}>
      <h2 style={{ fontSize:'1rem', fontWeight:700, color:'var(--text-1)', marginBottom:'1rem', display:'flex', alignItems:'center', gap:'0.5rem' }}>
        <Server size={16} style={{ color:'var(--accent-green)' }} /> Organizations
      </h2>
      <p style={{ fontSize:'0.82rem', color:'var(--text-3)', marginBottom:'1rem' }}>
        Each organization is an isolated workspace — its own groups, aliases, and feed filter.
        Everyone still shares the same underlying pager feed; this only controls who sees what.
      </p>

      <Flash msg={msg} />

      <div className="pm-card" style={{ marginBottom:'1rem' }}>
        <div className="pm-section-title">Create organization</div>
        <div style={{ display:'flex', gap:'0.5rem' }}>
          <input className="pm-input" style={{ flex:1 }} placeholder="e.g. Acme Fire Department"
            value={newOrgName} onChange={e => setNewOrgName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleCreateOrg()} />
          <button className="pm-btn pm-btn-primary" onClick={handleCreateOrg} disabled={!newOrgName.trim()}>
            <Plus size={13}/> Create
          </button>
        </div>
      </div>

      <div className="pm-card" style={{ marginBottom:'1rem' }}>
        <div className="pm-section-title">All organizations</div>
        {orgsLoading
          ? <div style={{ color:'var(--text-3)', fontSize:'0.82rem' }}>Loading…</div>
          : orgs.length === 0
            ? <div style={{ color:'var(--text-3)', fontSize:'0.82rem' }}>No organizations yet.</div>
            : orgs.map(o => (
              <div key={o.id} style={{ display:'flex', alignItems:'center', gap:'0.6rem', padding:'0.45rem 0',
                borderBottom:'1px solid var(--border-soft)' }}>
                <span style={{ fontFamily:'monospace', fontSize:'0.85rem', color:'var(--text-1)', flex:1 }}>{o.name}</span>
                <span style={{ fontSize:'0.7rem', color:'var(--text-3)', display:'flex', alignItems:'center', gap:'0.25rem' }}>
                  <Users2 size={11}/> {o.user_count} user{o.user_count !== 1 ? 's' : ''}
                </span>
              </div>
            ))
        }
      </div>

      <div className="pm-card">
        <div className="pm-section-title"><ArrowRightLeft size={13}/> Users — reassign organization</div>
        {usersLoading
          ? <div style={{ color:'var(--text-3)', fontSize:'0.82rem' }}>Loading…</div>
          : users.map(u => (
            <div key={u.id} style={{ display:'flex', alignItems:'center', gap:'0.5rem', padding:'0.45rem 0',
              borderBottom:'1px solid var(--border-soft)', flexWrap:'wrap' }}>
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ fontFamily:'monospace', fontSize:'0.85rem', color:'var(--text-1)' }}>
                  {u.username}{u.username === me?.username && <span style={{ fontSize:'0.65rem', color:'var(--accent-green)', marginLeft:'0.4rem' }}>(you)</span>}
                </div>
                <div style={{ fontSize:'0.7rem', color:'var(--text-3)' }}>{u.role}{u.is_platform_admin ? ' · platform admin' : ''}</div>
              </div>
              <select value={u.org_id || ''} onChange={e => handleMove(u.id, e.target.value)}
                style={{ background:'var(--bg-3)', border:'1px solid var(--border)', color:'var(--text-2)',
                  borderRadius:'0.35rem', padding:'0.25rem 0.4rem', fontSize:'0.75rem', cursor:'pointer' }}>
                {orgs.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
              </select>
            </div>
          ))
        }
      </div>
    </div>
  );
}
