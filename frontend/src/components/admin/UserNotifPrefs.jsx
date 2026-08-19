import { useState, useEffect } from 'react';
import { Bell, Save, RefreshCw, Mail, Smartphone, Siren, ChevronRight, ChevronDown } from 'lucide-react';
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

// One level of group nesting (top-level "parent" groups + their children) as a collapsible,
// searchable tree. Selecting a parent selects/deselects every child with it — the backend
// treats a selected parent as covering every child regardless of the children's own state
// (see groupMatchesSelection in database.js), so a child left unchecked while its parent
// stays checked would still alarm; cascading the checkbox keeps what's on screen truthful,
// and children are locked while their parent is selected so unchecking one can't silently
// do nothing.
function GroupPicker({ groups, selectedIds, onChange }) {
  const [search, setSearch] = useState('');
  const topLevel = groups.filter(g => !g.parent_id);
  const subOf    = pid => groups.filter(g => g.parent_id === pid);
  const [expanded, setExpanded] = useState(() => new Set(
    topLevel.filter(g => subOf(g.id).some(c => selectedIds.includes(c.id))).map(g => g.id)
  ));

  const toggleExpanded = id => setExpanded(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const toggleParent = g => {
    const childIds      = subOf(g.id).map(c => c.id);
    const isSelected     = selectedIds.includes(g.id);
    const withoutBranch  = selectedIds.filter(x => x !== g.id && !childIds.includes(x));
    onChange(isSelected ? withoutBranch : [...withoutBranch, g.id, ...childIds]);
  };

  const toggleLeaf = id => onChange(selectedIds.includes(id) ? selectedIds.filter(x => x !== id) : [...selectedIds, id]);

  if (!groups.length) return <span style={{ fontSize:'0.75rem', color:'var(--text-3)' }}>No groups defined</span>;

  const q           = search.trim().toLowerCase();
  const nameMatches = g => g.name?.toLowerCase().includes(q);
  const visibleTop  = q ? topLevel.filter(g => nameMatches(g) || subOf(g.id).some(nameMatches)) : topLevel;

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:'0.3rem' }}>
      <div style={{ fontSize:'0.65rem', color:'var(--text-3)' }}>
        Selecting a top-level group also notifies for every group nested under it — including ones added later.
      </div>
      <input className="pm-input" type="text" placeholder="Search groups…"
        value={search} onChange={e => setSearch(e.target.value)}
        style={{ fontSize:'0.75rem', padding:'0.25rem 0.5rem' }} />
      {q && !visibleTop.length && <span style={{ fontSize:'0.72rem', color:'var(--text-3)' }}>No matches</span>}
      {visibleTop.map(g => {
        const allChildren    = subOf(g.id);
        const children       = q && !nameMatches(g) ? allChildren.filter(nameMatches) : allChildren;
        const parentSelected = selectedIds.includes(g.id);
        const isExpanded     = q ? true : expanded.has(g.id);
        return (
          <div key={g.id} style={{ display:'flex', flexDirection:'column', gap:'0.3rem' }}>
            <div style={{ display:'flex', alignItems:'center', gap:'0.2rem' }}>
              {allChildren.length > 0 ? (
                <button type="button" onClick={() => toggleExpanded(g.id)}
                  title={isExpanded ? 'Collapse' : 'Expand'}
                  style={{ background:'none', border:'none', cursor:'pointer', color:'var(--text-3)',
                    padding:'0.1rem', display:'flex', flexShrink:0 }}>
                  {isExpanded ? <ChevronDown size={12}/> : <ChevronRight size={12}/>}
                </button>
              ) : <span style={{ width:'17px', flexShrink:0 }} />}
              <label style={{ display:'flex', alignItems:'center', gap:'0.3rem', fontSize:'0.75rem', cursor:'pointer',
                padding:'0.15rem 0.4rem', borderRadius:'0.3rem', border:'1px solid var(--border)', background:'var(--bg-0)', flex:1 }}>
                <input type="checkbox" checked={parentSelected} onChange={() => toggleParent(g)} />
                <span style={{ color: g.color }}>{g.name}</span>
                {allChildren.length > 0 && <span style={{ fontSize:'0.62rem', color:'var(--text-3)' }}>({allChildren.length})</span>}
              </label>
            </div>
            {isExpanded && children.map(sub => (
              <label key={sub.id} title={parentSelected ? 'Included via its parent group — uncheck the parent to select individually' : undefined}
                style={{ display:'flex', alignItems:'center', gap:'0.3rem', fontSize:'0.75rem',
                  cursor: parentSelected ? 'default' : 'pointer', padding:'0.15rem 0.4rem', borderRadius:'0.3rem',
                  border:'1px solid var(--border)', background:'var(--bg-0)', marginLeft:'1.4rem',
                  opacity: parentSelected ? 0.6 : 1 }}>
                <input type="checkbox" checked={parentSelected || selectedIds.includes(sub.id)}
                  disabled={parentSelected} onChange={() => toggleLeaf(sub.id)} />
                <span style={{ color: sub.color }}>{sub.name}</span>
              </label>
            ))}
          </div>
        );
      })}
    </div>
  );
}

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
            <GroupPicker groups={groups} selectedIds={groupIds}
              onChange={ids => set({ [`${prefixKey}group_ids`]: ids })} />
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
      setGroups(Array.isArray(g) ? g : []);
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
