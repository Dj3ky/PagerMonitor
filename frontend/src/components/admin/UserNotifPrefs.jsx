import { useState, useEffect } from 'react';
import { Bell, Save, RefreshCw, Mail, Smartphone, Siren } from 'lucide-react';
import { useAuth } from '../../context/AuthContext.jsx';

const BASE = import.meta.env.VITE_BACKEND_URL || '';
const tok  = () => localStorage.getItem('pm_token') || '';
const api  = (m, p, b) => fetch(`${BASE}${p}`, {
  method: m, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok()}` },
  body: b ? JSON.stringify(b) : undefined,
}).then(r => r.json());

const MODES = [
  { id: 'all',      label: 'All messages' },
  { id: 'groups',   label: 'By group' },
  { id: 'aliases',  label: 'By alias' },
  { id: 'capcodes', label: 'By capcode' },
  { id: 'keywords', label: 'By keyword' },
];

const DEFAULT_PREFS = {
  enabled: false, mode: 'all', group_ids: [], capcodes: [], keywords: [],
  alias_color_from_group: false,
  push_enabled: false, push_mode: 'all', push_group_ids: [], push_capcodes: [], push_keywords: [],
  alert_enabled: false, alert_mode: 'all', alert_group_ids: [], alert_capcodes: [], alert_keywords: [],
};

function FilterSection({ label, icon: Icon, accentVar, enabled, onToggle, prefs, onChange, groups, aliases, prefixKey }) {
  const mode      = prefs[`${prefixKey}mode`]      || 'all';
  const groupIds  = prefs[`${prefixKey}group_ids`] || [];
  const capcodes  = prefs[`${prefixKey}capcodes`]  || [];
  const keywords  = prefs[`${prefixKey}keywords`]  || [];

  const set = (patch) => onChange({ ...prefs, ...patch });
  const setList = (field, value) => {
    const arr = value.split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
    set({ [`${prefixKey}${field}`]: arr });
  };

  return (
    <div style={{ marginBottom: '1rem' }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', marginBottom: '0.5rem' }}>
        <input type="checkbox" checked={enabled} onChange={e => onToggle(e.target.checked)} />
        <Icon size={13} style={{ color: `var(${accentVar})` }} />
        <span style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-1)' }}>{label}</span>
      </label>

      <div style={{ paddingLeft: '1.4rem', opacity: enabled ? 1 : 0.4, transition: 'opacity 0.2s', pointerEvents: enabled ? 'auto' : 'none' }}>
        <div style={{ marginBottom: '0.5rem' }}>
          <div className="pm-label" style={{ marginBottom: '0.3rem' }}>Notify for</div>
          <div style={{ display: 'flex', gap: '0.3rem', flexWrap: 'wrap' }}>
            {MODES.map(m => (
              <button key={m.id} onClick={() => set({ [`${prefixKey}mode`]: m.id })}
                style={{
                  padding: '0.15rem 0.5rem', borderRadius: '0.75rem', fontSize: '0.72rem',
                  cursor: 'pointer', border: '1px solid',
                  background: mode === m.id ? `color-mix(in srgb,var(${accentVar}) 15%,transparent)` : 'var(--bg-3)',
                  color: mode === m.id ? `var(${accentVar})` : 'var(--text-3)',
                  borderColor: mode === m.id ? `color-mix(in srgb,var(${accentVar}) 35%,transparent)` : 'var(--border)',
                }}>
                {m.label}
              </button>
            ))}
          </div>
        </div>

        {mode === 'groups' && (
          <div>
            <div className="pm-label" style={{ marginBottom: '0.3rem' }}>Groups</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.3rem' }}>
              {groups.map(g => (
                <label key={g.id} style={{
                  display: 'flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.75rem',
                  cursor: 'pointer', padding: '0.15rem 0.4rem',
                  borderRadius: '0.3rem', border: '1px solid var(--border)', background: 'var(--bg-0)',
                }}>
                  <input type="checkbox"
                    checked={groupIds.includes(g.id)}
                    onChange={e => {
                      const ids = e.target.checked ? [...groupIds, g.id] : groupIds.filter(x => x !== g.id);
                      set({ [`${prefixKey}group_ids`]: ids });
                    }} />
                  <span style={{ color: g.color }}>{g.name}</span>
                </label>
              ))}
              {groups.length === 0 && <span style={{ fontSize: '0.75rem', color: 'var(--text-3)' }}>No groups defined</span>}
            </div>
          </div>
        )}

        {mode === 'aliases' && (
          <div>
            <div className="pm-label" style={{ marginBottom: '0.3rem' }}>Aliases</div>
            <div style={{ maxHeight: '140px', overflowY: 'auto', border: '1px solid var(--border)', borderRadius: '0.4rem', padding: '0.3rem', display: 'flex', flexWrap: 'wrap', gap: '0.25rem' }}>
              {aliases.map(a => (
                <label key={a.capcode} style={{
                  display: 'flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.72rem',
                  cursor: 'pointer', padding: '0.1rem 0.35rem',
                  borderRadius: '0.3rem', border: '1px solid var(--border)', background: 'var(--bg-0)', whiteSpace: 'nowrap',
                }}>
                  <input type="checkbox"
                    checked={capcodes.includes(a.capcode)}
                    onChange={e => {
                      const caps = e.target.checked ? [...capcodes, a.capcode] : capcodes.filter(x => x !== a.capcode);
                      set({ [`${prefixKey}capcodes`]: caps });
                    }} />
                  <span style={{ color: a.color || 'var(--accent-green)' }}>{a.name}</span>
                  <span style={{ color: 'var(--text-3)', fontFamily: 'monospace', fontSize: '0.65rem' }}>{a.capcode}</span>
                </label>
              ))}
              {aliases.length === 0 && <span style={{ fontSize: '0.75rem', color: 'var(--text-3)' }}>No aliases defined</span>}
            </div>
          </div>
        )}

        {mode === 'capcodes' && (
          <div>
            <div className="pm-label" style={{ marginBottom: '0.3rem' }}>Capcodes (one per line or comma-separated)</div>
            <textarea className="pm-input" rows={2}
              value={capcodes.join('\n')}
              onChange={e => setList('capcodes', e.target.value)}
              placeholder="1234567&#10;2345678"
              style={{ resize: 'vertical', fontFamily: 'monospace', fontSize: '0.78rem' }} />
          </div>
        )}

        {mode === 'keywords' && (
          <div>
            <div className="pm-label" style={{ marginBottom: '0.3rem' }}>Keywords (one per line or comma-separated)</div>
            <textarea className="pm-input" rows={2}
              value={keywords.join('\n')}
              onChange={e => setList('keywords', e.target.value)}
              placeholder="požar&#10;nujna&#10;urgent"
              style={{ resize: 'vertical', fontFamily: 'monospace', fontSize: '0.78rem' }} />
          </div>
        )}
      </div>
    </div>
  );
}

function UserCard({ user, groups, aliases, onSave }) {
  const { user: currentUser } = useAuth();
  const [prefs, setPrefs] = useState({ ...DEFAULT_PREFS, ...user.prefs });
  const [email, setEmail] = useState(user.email || '');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg]     = useState(null);

  const flash = (type, text) => { setMsg({ type, text }); setTimeout(() => setMsg(null), 3000); };

  const save = async () => {
    setSaving(true);
    try {
      await api('PUT', `/admin/users/${user.id}/email`, { email });
      await api('PUT', `/admin/user-notif-prefs/${user.id}`, prefs);
      if (currentUser?.id === user.id) {
        window.dispatchEvent(new CustomEvent('pm:notif-prefs-updated', { detail: { alias_color_from_group: !!prefs.alias_color_from_group } }));
      }
      flash('ok', 'Saved');
      onSave?.();
    } catch (e) { flash('err', e.message); }
    finally { setSaving(false); }
  };

  return (
    <div className="pm-card" style={{ marginBottom: '0.75rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.75rem', flexWrap: 'wrap' }}>
        <div style={{ fontWeight: 700, fontSize: '0.9rem', color: 'var(--text-1)', flex: 1 }}>{user.username}</div>
        <span style={{ fontSize: '0.7rem', padding: '0.1rem 0.4rem', borderRadius: '0.3rem', background: 'var(--bg-3)', color: 'var(--text-3)' }}>
          {user.role}
        </span>
      </div>

      {msg && (
        <div style={{
          padding: '0.3rem 0.5rem', borderRadius: '0.3rem', fontSize: '0.75rem', marginBottom: '0.5rem', fontFamily: 'monospace',
          color: msg.type === 'ok' ? 'var(--accent-green)' : 'var(--accent-red)',
          background: `color-mix(in srgb,${msg.type === 'ok' ? 'var(--accent-green)' : 'var(--accent-red)'} 10%,transparent)`,
        }}>{msg.text}</div>
      )}

      <div style={{ marginBottom: '0.75rem' }}>
        <label className="pm-label">Email address</label>
        <input className="pm-input" type="email" value={email} placeholder="user@example.com"
          onChange={e => setEmail(e.target.value)} />
      </div>

      <div style={{ borderTop: '1px solid var(--border)', paddingTop: '0.75rem' }}>
        <div style={{ marginBottom: '1rem' }}>
          <div className="pm-section-title" style={{ marginBottom: '0.45rem' }}>Notifications</div>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-3)', lineHeight: 1.5 }}>
            Configure which messages trigger email and push notifications for this user.
          </div>
        </div>
        <FilterSection
          label="Email notifications"
          icon={Mail}
          accentVar="--accent-amber"
          enabled={prefs.enabled}
          onToggle={v => setPrefs(p => ({ ...p, enabled: v }))}
          prefs={prefs}
          onChange={setPrefs}
          groups={groups}
          aliases={aliases}
          prefixKey=""
        />
        <FilterSection
          label="Push notifications"
          icon={Smartphone}
          accentVar="--accent-green"
          enabled={prefs.push_enabled}
          onToggle={v => setPrefs(p => ({ ...p, push_enabled: v }))}
          prefs={prefs}
          onChange={setPrefs}
          groups={groups}
          aliases={aliases}
          prefixKey="push_"
        />
        <FilterSection
          label="Alert notifications (bypass silent — Android app only)"
          icon={Siren}
          accentVar="--accent-red"
          enabled={prefs.alert_enabled}
          onToggle={v => setPrefs(p => ({ ...p, alert_enabled: v }))}
          prefs={prefs}
          onChange={setPrefs}
          groups={groups}
          aliases={aliases}
          prefixKey="alert_"
        />

        <div style={{ marginTop: '1rem', paddingTop: '0.9rem', borderTop: '1px solid var(--border-soft)' }}>
          <div className="pm-section-title" style={{ marginBottom: '0.45rem' }}>Alias creation</div>
          <label style={{ display: 'flex', alignItems: 'flex-start', gap: '0.45rem', cursor: 'pointer', fontSize: '0.78rem', color: 'var(--text-2)', lineHeight: 1.45 }}>
            <input type="checkbox"
              checked={!!prefs.alias_color_from_group}
              onChange={e => setPrefs(p => ({ ...p, alias_color_from_group: e.target.checked }))} />
            <span>Automatically use the selected group's colour for new aliases and update it while the group changes.</span>
          </label>
        </div>
      </div>

      <div style={{ marginTop: '0.5rem' }}>
        <button className="pm-btn pm-btn-primary" onClick={save} disabled={saving}>
          <Save size={13} /> {saving ? 'Saving…' : 'Save'}
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
    <div style={{ maxWidth: '640px' }}>
      <h2 style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--text-1)', marginBottom: '0.5rem',
        display: 'flex', alignItems: 'center', gap: '0.5rem', justifyContent: 'space-between' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <Bell size={16} style={{ color: 'var(--accent-amber)' }} /> User Preferences
        </span>
        <button className="pm-btn" onClick={load}><RefreshCw size={12} /></button>
      </h2>
      <p style={{ fontSize: '0.82rem', color: 'var(--text-3)', marginBottom: '1rem', lineHeight: 1.6 }}>
        Set email address, email notification filter, push notification filter, alert filter
        (bypasses silent/Do Not Disturb on the Android app), and alias creation preferences for each user.
        Users can also update their own preferences from the profile icon in the header.
      </p>

      {loading && <div style={{ color: 'var(--text-3)', fontFamily: 'monospace' }}>Loading…</div>}
      {!loading && users.map(u => (
        <UserCard key={u.id} user={u} groups={groups} aliases={aliases} onSave={load} />
      ))}
    </div>
  );
}
