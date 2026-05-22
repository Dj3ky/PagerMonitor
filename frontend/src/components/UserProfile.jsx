import { useState, useEffect } from 'react';
import { User, Save, X, Bell, Lock, Mail, Smartphone } from 'lucide-react';
import { useAuth } from '../context/AuthContext.jsx';

const BASE = import.meta.env.VITE_BACKEND_URL || '';
const tok  = () => localStorage.getItem('pm_token') || '';
const api  = (m, p, b) => fetch(`${BASE}${p}`, {
  method: m, headers: { 'Content-Type':'application/json', Authorization:`Bearer ${tok()}` },
  body: b ? JSON.stringify(b) : undefined,
}).then(r => r.json());

const MODES = [
  { id:'all',      label:'All messages',    desc:'Get notified for every decoded message' },
  { id:'groups',   label:'By group',        desc:'Only messages from selected groups' },
  { id:'aliases',  label:'By alias',        desc:'Only messages from selected aliases' },
  { id:'capcodes', label:'By capcode',      desc:'Only specific capcodes' },
  { id:'keywords', label:'By keyword',      desc:'Only messages containing keywords' },
];

function Flash({ msg }) {
  if (!msg) return null;
  const ok = msg.type === 'ok';
  return <div style={{ padding:'0.35rem 0.6rem', borderRadius:'0.35rem', fontSize:'0.75rem',
    fontFamily:'monospace', marginTop:'0.4rem',
    color: ok ? 'var(--accent-green)' : 'var(--accent-red)',
    background:`color-mix(in srgb,${ok?'var(--accent-green)':'var(--accent-red)'} 10%,transparent)`,
  }}>{msg.text}</div>;
}

export default function UserProfile({ onClose }) {
  const { user } = useAuth();
  const [email, setEmail]   = useState('');
  const [prefs, setPrefs]   = useState({
    enabled:false, mode:'all', group_ids:[], capcodes:[], keywords:[],
    push_enabled:false, push_mode:'all', push_group_ids:[], push_capcodes:[], push_keywords:[],
  });
  const [groups, setGroups]   = useState([]);
  const [aliases, setAliases] = useState([]);
  const [pw, setPw]         = useState({ current:'', next:'', confirm:'' });
  const [saving, setSaving] = useState(false);
  const [pwSaving, setPwSaving] = useState(false);
  const [emailMsg, setEmailMsg] = useState(null);
  const [pwMsg, setPwMsg]       = useState(null);
  const [prefMsg, setPrefMsg]   = useState(null);

  const flashEmail = (t,m) => { setEmailMsg({type:t,text:m}); setTimeout(()=>setEmailMsg(null),3000); };
  const flashPw    = (t,m) => { setPwMsg({type:t,text:m});    setTimeout(()=>setPwMsg(null),3000); };
  const flashPref  = (t,m) => { setPrefMsg({type:t,text:m});  setTimeout(()=>setPrefMsg(null),3000); };

  useEffect(() => {
    // Load current email and prefs
    api('GET', '/auth/me').then(d => setEmail(d.email || '')).catch(() => {});
    api('GET', '/auth/me/notif-prefs').then(setPrefs).catch(() => {});
    api('GET', '/admin/groups').then(d => setGroups(Array.isArray(d) ? d.filter(g => !g.parent_id) : [])).catch(() => {});
    api('GET', '/admin/aliases').then(d => setAliases(Array.isArray(d) ? d : [])).catch(() => {});
  }, []);

  const saveEmail = async () => {
    setSaving(true);
    try { await api('PUT', '/auth/me/email', { email }); flashEmail('ok', 'Email saved'); }
    catch (e) { flashEmail('err', e.message); }
    finally { setSaving(false); }
  };

  const savePrefs = async () => {
    setSaving(true);
    try { await api('PUT', '/auth/me/notif-prefs', prefs); flashPref('ok', 'Preferences saved'); }
    catch (e) { flashPref('err', e.message); }
    finally { setSaving(false); }
  };

  const changePassword = async () => {
    if (!pw.current) return flashPw('err', 'Enter current password');
    if (pw.next.length < 6) return flashPw('err', 'New password must be at least 6 characters');
    if (pw.next !== pw.confirm) return flashPw('err', 'Passwords do not match');
    setPwSaving(true);
    try {
      const r = await api('POST', '/auth/change-password', { current: pw.current, next: pw.next });
      if (r.ok) { flashPw('ok', 'Password changed'); setPw({ current:'', next:'', confirm:'' }); }
      else flashPw('err', r.error || 'Failed');
    } catch (e) { flashPw('err', e.message); }
    finally { setPwSaving(false); }
  };

  const setListField = (field, value) => {
    const arr = value.split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
    setPrefs(p => ({ ...p, [field]: arr }));
  };

  return (
    <div style={{ position:'fixed', inset:0, zIndex:3000, display:'flex', alignItems:'flex-start', justifyContent:'flex-end' }}
      onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ width:'min(420px,100vw)', height:'100vh', background:'var(--bg-1)',
        borderLeft:'1px solid var(--border)', overflowY:'auto', boxShadow:'-4px 0 24px rgba(0,0,0,0.4)' }}>

        {/* Header */}
        <div style={{ display:'flex', alignItems:'center', gap:'0.75rem', padding:'1rem',
          borderBottom:'1px solid var(--border)', position:'sticky', top:0, background:'var(--bg-1)', zIndex:1 }}>
          <User size={18} style={{ color:'var(--accent-green)' }}/>
          <div style={{ flex:1 }}>
            <div style={{ fontWeight:700, color:'var(--text-1)' }}>{user?.username}</div>
            <div style={{ fontSize:'0.7rem', color:'var(--text-3)' }}>{user?.role}</div>
          </div>
          <button onClick={onClose} style={{ background:'none', border:'none', cursor:'pointer',
            color:'var(--text-3)', padding:'0.25rem' }}><X size={18}/></button>
        </div>

        <div style={{ padding:'1rem', display:'flex', flexDirection:'column', gap:'1rem' }}>

          {/* Email */}
          <div className="pm-card">
            <div className="pm-section-title"><Mail size={13}/> Email address</div>
            <p style={{ fontSize:'0.75rem', color:'var(--text-3)', marginBottom:'0.6rem', lineHeight:1.5 }}>
              Used for message notifications and password reset.
            </p>
            <input className="pm-input" type="email" value={email}
              onChange={e => setEmail(e.target.value)} placeholder="you@example.com"
              onKeyDown={e => e.key === 'Enter' && saveEmail()} />
            <Flash msg={emailMsg} />
            <button className="pm-btn pm-btn-primary" onClick={saveEmail} disabled={saving}
              style={{ marginTop:'0.5rem' }}>
              <Save size={13}/> Save email
            </button>
          </div>

          {/* Notification prefs */}
          <div className="pm-card">
            <div className="pm-section-title"><Bell size={13}/> Email notification preferences</div>
            <p style={{ fontSize:'0.75rem', color:'var(--text-3)', marginBottom:'0.75rem', lineHeight:1.5 }}>
              Requires email address above and SMTP configured by admin.
            </p>

            <label style={{ display:'flex', alignItems:'center', gap:'0.5rem',
              fontSize:'0.85rem', cursor:'pointer', marginBottom:'0.75rem' }}>
              <input type="checkbox" checked={prefs.enabled}
                onChange={e => setPrefs(p => ({ ...p, enabled: e.target.checked }))} />
              Enable email notifications
            </label>

            <div style={{ opacity: prefs.enabled ? 1 : 0.45, transition:'opacity 0.2s' }}>
              <label className="pm-label">Notify for</label>
              <div style={{ display:'flex', flexWrap:'wrap', gap:'0.35rem', marginBottom:'0.75rem' }}>
                {MODES.map(m => (
                  <button key={m.id} onClick={() => setPrefs(p => ({ ...p, mode: m.id }))}
                    title={m.desc}
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

              {prefs.mode === 'aliases' && (
                <div style={{ marginBottom:'0.75rem' }}>
                  <label className="pm-label">Select aliases</label>
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
                        <span style={{ color:'var(--text-3)', fontFamily:'monospace', fontSize:'0.68rem' }}>{a.capcode}</span>
                      </label>
                    ))}
                    {!aliases.length && <span style={{ fontSize:'0.75rem', color:'var(--text-3)' }}>No aliases defined</span>}
                  </div>
                </div>
              )}

              {prefs.mode === 'groups' && (
                <div style={{ marginBottom:'0.75rem' }}>
                  <label className="pm-label">Select groups</label>
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
                    {!groups.length && <span style={{ fontSize:'0.75rem', color:'var(--text-3)' }}>No groups defined</span>}
                  </div>
                </div>
              )}

              {prefs.mode === 'capcodes' && (
                <div style={{ marginBottom:'0.75rem' }}>
                  <label className="pm-label">Capcodes (one per line)</label>
                  <textarea className="pm-input" rows={3}
                    value={prefs.capcodes.join('\n')}
                    onChange={e => setListField('capcodes', e.target.value)}
                    placeholder="1234567&#10;2345678"
                    style={{ resize:'vertical', fontFamily:'monospace', fontSize:'0.8rem' }} />
                </div>
              )}

              {prefs.mode === 'keywords' && (
                <div style={{ marginBottom:'0.75rem' }}>
                  <label className="pm-label">Keywords (one per line)</label>
                  <textarea className="pm-input" rows={3}
                    value={prefs.keywords.join('\n')}
                    onChange={e => setListField('keywords', e.target.value)}
                    placeholder="požar&#10;nujna&#10;urgent"
                    style={{ resize:'vertical', fontFamily:'monospace', fontSize:'0.8rem' }} />
                </div>
              )}
            </div>

            <Flash msg={prefMsg} />
            <button className="pm-btn pm-btn-primary" onClick={savePrefs} disabled={saving}
              style={{ marginTop:'0.25rem' }}>
              <Save size={13}/> Save preferences
            </button>
          </div>

          {/* Push notification prefs */}
          <div className="pm-card">
            <div className="pm-section-title"><Smartphone size={13}/> Push notification preferences</div>
            <p style={{ fontSize:'0.75rem', color:'var(--text-3)', marginBottom:'0.75rem', lineHeight:1.5 }}>
              Controls which messages send a push notification to your browser or installed PWA.
              Requires the bell icon to be enabled.
            </p>

            <label style={{ display:'flex', alignItems:'center', gap:'0.5rem',
              fontSize:'0.85rem', cursor:'pointer', marginBottom:'0.75rem' }}>
              <input type="checkbox" checked={prefs.push_enabled}
                onChange={e => setPrefs(p => ({ ...p, push_enabled: e.target.checked }))} />
              Enable push notifications
            </label>

            <div style={{ opacity: prefs.push_enabled ? 1 : 0.45, transition:'opacity 0.2s' }}>
              <label className="pm-label">Notify for</label>
              <div style={{ display:'flex', flexWrap:'wrap', gap:'0.35rem', marginBottom:'0.75rem' }}>
                {MODES.map(m => (
                  <button key={m.id} onClick={() => setPrefs(p => ({ ...p, push_mode: m.id }))}
                    title={m.desc}
                    style={{ padding:'0.2rem 0.6rem', borderRadius:'0.75rem', fontSize:'0.75rem',
                      cursor:'pointer', border:'1px solid',
                      background: prefs.push_mode === m.id ? 'color-mix(in srgb,var(--accent-green) 15%,transparent)' : 'var(--bg-3)',
                      color: prefs.push_mode === m.id ? 'var(--accent-green)' : 'var(--text-3)',
                      borderColor: prefs.push_mode === m.id ? 'color-mix(in srgb,var(--accent-green) 35%,transparent)' : 'var(--border)',
                    }}>
                    {m.label}
                  </button>
                ))}
              </div>

              {prefs.push_mode === 'aliases' && (
                <div style={{ marginBottom:'0.75rem' }}>
                  <label className="pm-label">Select aliases</label>
                  <div style={{ maxHeight:'160px', overflowY:'auto', border:'1px solid var(--border)',
                    borderRadius:'0.4rem', padding:'0.35rem', display:'flex', flexWrap:'wrap', gap:'0.3rem' }}>
                    {aliases.map(a => (
                      <label key={a.capcode} style={{ display:'flex', alignItems:'center', gap:'0.3rem',
                        fontSize:'0.75rem', cursor:'pointer', padding:'0.15rem 0.4rem',
                        borderRadius:'0.3rem', border:'1px solid var(--border)', background:'var(--bg-0)',
                        whiteSpace:'nowrap' }}>
                        <input type="checkbox"
                          checked={(prefs.push_capcodes || []).includes(a.capcode)}
                          onChange={e => {
                            const caps = e.target.checked
                              ? [...(prefs.push_capcodes || []), a.capcode]
                              : (prefs.push_capcodes || []).filter(x => x !== a.capcode);
                            setPrefs(p => ({ ...p, push_capcodes: caps }));
                          }} />
                        <span style={{ color: a.color || 'var(--accent-green)' }}>{a.name}</span>
                        <span style={{ color:'var(--text-3)', fontFamily:'monospace', fontSize:'0.68rem' }}>{a.capcode}</span>
                      </label>
                    ))}
                    {!aliases.length && <span style={{ fontSize:'0.75rem', color:'var(--text-3)' }}>No aliases defined</span>}
                  </div>
                </div>
              )}

              {prefs.push_mode === 'groups' && (
                <div style={{ marginBottom:'0.75rem' }}>
                  <label className="pm-label">Select groups</label>
                  <div style={{ display:'flex', flexWrap:'wrap', gap:'0.35rem' }}>
                    {groups.map(g => (
                      <label key={g.id} style={{ display:'flex', alignItems:'center', gap:'0.3rem',
                        fontSize:'0.78rem', cursor:'pointer', padding:'0.15rem 0.4rem',
                        borderRadius:'0.3rem', border:'1px solid var(--border)', background:'var(--bg-0)' }}>
                        <input type="checkbox"
                          checked={(prefs.push_group_ids || []).includes(g.id)}
                          onChange={e => {
                            const ids = e.target.checked
                              ? [...(prefs.push_group_ids || []), g.id]
                              : (prefs.push_group_ids || []).filter(x => x !== g.id);
                            setPrefs(p => ({ ...p, push_group_ids: ids }));
                          }} />
                        <span style={{ color: g.color }}>{g.name}</span>
                      </label>
                    ))}
                    {!groups.length && <span style={{ fontSize:'0.75rem', color:'var(--text-3)' }}>No groups defined</span>}
                  </div>
                </div>
              )}

              {prefs.push_mode === 'capcodes' && (
                <div style={{ marginBottom:'0.75rem' }}>
                  <label className="pm-label">Capcodes (one per line)</label>
                  <textarea className="pm-input" rows={3}
                    value={(prefs.push_capcodes || []).join('\n')}
                    onChange={e => setListField('push_capcodes', e.target.value)}
                    placeholder="1234567&#10;2345678"
                    style={{ resize:'vertical', fontFamily:'monospace', fontSize:'0.8rem' }} />
                </div>
              )}

              {prefs.push_mode === 'keywords' && (
                <div style={{ marginBottom:'0.75rem' }}>
                  <label className="pm-label">Keywords (one per line)</label>
                  <textarea className="pm-input" rows={3}
                    value={(prefs.push_keywords || []).join('\n')}
                    onChange={e => setListField('push_keywords', e.target.value)}
                    placeholder="požar&#10;nujna&#10;urgent"
                    style={{ resize:'vertical', fontFamily:'monospace', fontSize:'0.8rem' }} />
                </div>
              )}
            </div>

            <button className="pm-btn pm-btn-primary" onClick={savePrefs} disabled={saving}
              style={{ marginTop:'0.25rem' }}>
              <Save size={13}/> Save preferences
            </button>
          </div>

          {/* Change password */}
          <div className="pm-card">
            <div className="pm-section-title"><Lock size={13}/> Change password</div>
            <div style={{ display:'flex', flexDirection:'column', gap:'0.5rem' }}>
              {[
                { label:'Current password', key:'current' },
                { label:'New password',     key:'next'    },
                { label:'Confirm new',      key:'confirm' },
              ].map(f => (
                <div key={f.key}>
                  <label className="pm-label">{f.label}</label>
                  <input className="pm-input" type="password" value={pw[f.key]}
                    onChange={e => setPw(p => ({ ...p, [f.key]: e.target.value }))} />
                </div>
              ))}
            </div>
            <Flash msg={pwMsg} />
            <button className="pm-btn pm-btn-primary" onClick={changePassword} disabled={pwSaving}
              style={{ marginTop:'0.5rem' }}>
              <Lock size={13}/> {pwSaving ? 'Saving…' : 'Change password'}
            </button>
          </div>

        </div>
      </div>
    </div>
  );
}
