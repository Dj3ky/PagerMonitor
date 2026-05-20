import { useState, useEffect } from 'react';
import { Bell, Save, RefreshCw } from 'lucide-react';

const BASE = import.meta.env.VITE_BACKEND_URL || '';
const tok  = () => localStorage.getItem('pm_token') || '';
const api  = (m, p, b) => fetch(`${BASE}${p}`, {
  method: m, headers: { 'Content-Type':'application/json', Authorization:`Bearer ${tok()}` },
  body: b ? JSON.stringify(b) : undefined,
}).then(r => r.json());

const MODES = [
  { id:'all',      label:'All messages' },
  { id:'groups',   label:'By group' },
  { id:'aliases',  label:'By alias' },
  { id:'capcodes', label:'By capcode' },
  { id:'keywords', label:'By keyword' },
];

function UserCard({ user, groups, aliases, onSave }) {
  const [prefs, setPrefs] = useState(user.prefs);
  const [email, setEmail] = useState(user.email || '');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg]     = useState(null);

  const flash = (type, text) => { setMsg({type,text}); setTimeout(() => setMsg(null), 3000); };

  const save = async () => {
    setSaving(true);
    try {
      // Save email
      await api('PUT', `/admin/users/${user.id}/email`, { email });
      // Save prefs
      await api('PUT', `/admin/user-notif-prefs/${user.id}`, prefs);
      flash('ok', 'Saved');
      onSave?.();
    } catch (e) { flash('err', e.message); }
    finally { setSaving(false); }
  };

  const setListField = (field, value) => {
    // comma-separated or newline-separated input → array
    const arr = value.split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
    setPrefs(p => ({ ...p, [field]: arr }));
  };

  return (
    <div className="pm-card" style={{ marginBottom:'0.75rem' }}>
      <div style={{ display:'flex', alignItems:'center', gap:'0.75rem', marginBottom:'0.75rem', flexWrap:'wrap' }}>
        <div style={{ fontWeight:700, fontSize:'0.9rem', color:'var(--text-1)', flex:1 }}>{user.username}</div>
        <span style={{ fontSize:'0.7rem', padding:'0.1rem 0.4rem', borderRadius:'0.3rem',
          background:'var(--bg-3)', color:'var(--text-3)' }}>{user.role}</span>
        <label style={{ display:'flex', alignItems:'center', gap:'0.4rem', fontSize:'0.82rem', cursor:'pointer' }}>
          <input type="checkbox" checked={prefs.enabled}
            onChange={e => setPrefs(p => ({ ...p, enabled: e.target.checked }))} />
          Email notifications
        </label>
      </div>

      {msg && <div style={{ padding:'0.3rem 0.5rem', borderRadius:'0.3rem', fontSize:'0.75rem',
        marginBottom:'0.5rem', fontFamily:'monospace',
        color: msg.type==='ok' ? 'var(--accent-green)' : 'var(--accent-red)',
        background:`color-mix(in srgb,${msg.type==='ok'?'var(--accent-green)':'var(--accent-red)'} 10%,transparent)`,
      }}>{msg.text}</div>}

      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'0.5rem',
        opacity: prefs.enabled ? 1 : 0.45, transition:'opacity 0.2s' }}>

        <div style={{ gridColumn:'1/-1' }}>
          <label className="pm-label">Email address</label>
          <input className="pm-input" type="email" value={email} placeholder="user@example.com"
            onChange={e => setEmail(e.target.value)} />
        </div>

        <div style={{ gridColumn:'1/-1' }}>
          <label className="pm-label">Notify for</label>
          <div style={{ display:'flex', gap:'0.35rem', flexWrap:'wrap' }}>
            {MODES.map(m => (
              <button key={m.id} onClick={() => setPrefs(p => ({ ...p, mode: m.id }))}
                style={{ padding:'0.2rem 0.6rem', borderRadius:'0.75rem', fontSize:'0.75rem',
                  cursor:'pointer', border:'1px solid',
                  background: prefs.mode === m.id ? 'color-mix(in srgb,var(--accent-green) 15%,transparent)' : 'var(--bg-3)',
                  color: prefs.mode === m.id ? 'var(--accent-green)' : 'var(--text-3)',
                  borderColor: prefs.mode === m.id ? 'color-mix(in srgb,var(--accent-green) 35%,transparent)' : 'var(--border)',
                }}>
                {m.label}
              </button>
            ))}
          </div>
        </div>

        {prefs.mode === 'groups' && (
          <div style={{ gridColumn:'1/-1' }}>
            <label className="pm-label">Groups (select)</label>
            <div style={{ display:'flex', flexWrap:'wrap', gap:'0.35rem' }}>
              {groups.map(g => (
                <label key={g.id} style={{ display:'flex', alignItems:'center', gap:'0.3rem',
                  fontSize:'0.78rem', cursor:'pointer', padding:'0.15rem 0.4rem',
                  borderRadius:'0.3rem', border:'1px solid var(--border)', background:'var(--bg-0)' }}>
                  <input type="checkbox"
                    checked={prefs.group_ids.includes(g.id)}
                    onChange={e => {
                      const ids = e.target.checked
                        ? [...prefs.group_ids, g.id]
                        : prefs.group_ids.filter(x => x !== g.id);
                      setPrefs(p => ({ ...p, group_ids: ids }));
                    }} />
                  <span style={{ color: g.color }}>{g.name}</span>
                </label>
              ))}
              {groups.length === 0 && <span style={{ fontSize:'0.75rem', color:'var(--text-3)' }}>No groups defined</span>}
            </div>
          </div>
        )}

        {prefs.mode === 'aliases' && (
          <div style={{ gridColumn:'1/-1' }}>
            <label className="pm-label">Aliases (select)</label>
            <div style={{ maxHeight:'160px', overflowY:'auto', border:'1px solid var(--border)',
              borderRadius:'0.4rem', padding:'0.35rem', display:'flex', flexWrap:'wrap', gap:'0.3rem' }}>
              {aliases.map(a => (
                <label key={a.capcode} style={{ display:'flex', alignItems:'center', gap:'0.3rem',
                  fontSize:'0.75rem', cursor:'pointer', padding:'0.15rem 0.4rem',
                  borderRadius:'0.3rem', border:'1px solid var(--border)', background:'var(--bg-0)',
                  whiteSpace:'nowrap' }}>
                  <input type="checkbox"
                    checked={(prefs.capcodes || []).includes(a.capcode)}
                    onChange={e => {
                      const caps = e.target.checked
                        ? [...(prefs.capcodes || []), a.capcode]
                        : (prefs.capcodes || []).filter(x => x !== a.capcode);
                      setPrefs(p => ({ ...p, capcodes: caps }));
                    }} />
                  <span style={{ color: a.color || 'var(--accent-green)' }}>{a.name}</span>
                  <span style={{ color:'var(--text-3)', fontFamily:'monospace', fontSize:'0.68rem' }}>
                    {a.capcode}
                  </span>
                </label>
              ))}
              {aliases.length === 0 && <span style={{ fontSize:'0.75rem', color:'var(--text-3)' }}>No aliases defined</span>}
            </div>
          </div>
        )}

        {prefs.mode === 'capcodes' && (
          <div style={{ gridColumn:'1/-1' }}>
            <label className="pm-label">Capcodes (one per line or comma-separated)</label>
            <textarea className="pm-input" rows={3}
              value={prefs.capcodes.join('\n')}
              onChange={e => setListField('capcodes', e.target.value)}
              placeholder="1234567&#10;2345678" style={{ resize:'vertical', fontFamily:'monospace', fontSize:'0.8rem' }} />
          </div>
        )}

        {prefs.mode === 'keywords' && (
          <div style={{ gridColumn:'1/-1' }}>
            <label className="pm-label">Keywords (one per line or comma-separated)</label>
            <textarea className="pm-input" rows={3}
              value={prefs.keywords.join('\n')}
              onChange={e => setListField('keywords', e.target.value)}
              placeholder="požar&#10;nujna&#10;urgent" style={{ resize:'vertical', fontFamily:'monospace', fontSize:'0.8rem' }} />
          </div>
        )}
      </div>

      <div style={{ marginTop:'0.75rem' }}>
        <button className="pm-btn pm-btn-primary" onClick={save} disabled={saving}>
          <Save size={13}/> {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}

export default function UserNotifPrefs() {
  const [users, setUsers]     = useState([]);
  const [groups, setGroups]   = useState([]);
  const [aliases, setAliases] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = () => {
    setLoading(true);
    Promise.all([
      api('GET', '/admin/user-notif-prefs'),
      api('GET', '/admin/groups'),
      api('GET', '/admin/aliases'),
    ]).then(([u, g, a]) => {
      setUsers(Array.isArray(u) ? u : []);
      setGroups(Array.isArray(g) ? g.filter(x => !x.parent_id) : []);
      setAliases(Array.isArray(a) ? a : []);
    }).finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  return (
    <div style={{ maxWidth:'640px' }}>
      <h2 style={{ fontSize:'1rem', fontWeight:700, color:'var(--text-1)', marginBottom:'0.5rem',
        display:'flex', alignItems:'center', gap:'0.5rem', justifyContent:'space-between' }}>
        <span style={{ display:'flex', alignItems:'center', gap:'0.5rem' }}>
          <Bell size={16} style={{ color:'var(--accent-amber)' }}/> User Email Preferences
        </span>
        <button className="pm-btn" onClick={load}><RefreshCw size={12}/></button>
      </h2>
      <p style={{ fontSize:'0.82rem', color:'var(--text-3)', marginBottom:'1rem', lineHeight:1.6 }}>
        Set an email address and notification filter for each user.
        Users can also update their own preferences from the profile icon in the header.
      </p>

      {loading && <div style={{ color:'var(--text-3)', fontFamily:'monospace' }}>Loading…</div>}
      {!loading && users.map(u => (
        <UserCard key={u.id} user={u} groups={groups} aliases={aliases} onSave={load} />
      ))}
    </div>
  );
}
