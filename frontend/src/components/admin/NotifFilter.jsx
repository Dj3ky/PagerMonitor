import { useState, useEffect } from 'react';
import { Filter, Save, ChevronRight, ChevronDown } from 'lucide-react';
import { adminFetchNotifFilter, adminSaveNotifFilter } from '../../utils/api.js';
import { useAdminFetch } from '../../hooks/useAdminFetch.js';
import { adminFetchAliases, adminFetchGroups } from '../../utils/api.js';

// One level of group nesting (top-level "parent" groups + their children) as a collapsible,
// searchable tree. Selecting a parent selects/deselects every child with it — the backend
// treats a selected parent as covering every child regardless of the children's own state
// (see groupMatchesSelection in database.js), so a child left unchecked while its parent
// stays checked would still trigger notifications; cascading the checkbox keeps what's on
// screen truthful, and children are locked while their parent is selected so unchecking
// one can't silently do nothing.
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
              <label style={{ display:'flex', alignItems:'center', gap:'0.3rem', fontSize:'0.78rem', cursor:'pointer',
                padding:'0.15rem 0.5rem', borderRadius:'0.3rem', border:'1px solid var(--border)', background:'var(--bg-0)', flex:1 }}>
                <input type="checkbox" checked={parentSelected} onChange={() => toggleParent(g)} />
                <span style={{ color: g.color }}>{g.name}</span>
                {allChildren.length > 0 && <span style={{ fontSize:'0.62rem', color:'var(--text-3)' }}>({allChildren.length})</span>}
              </label>
            </div>
            {isExpanded && children.map(sub => (
              <label key={sub.id} title={parentSelected ? 'Included via its parent group — uncheck the parent to select individually' : undefined}
                style={{ display:'flex', alignItems:'center', gap:'0.3rem', fontSize:'0.78rem',
                  cursor: parentSelected ? 'default' : 'pointer', padding:'0.15rem 0.5rem', borderRadius:'0.3rem',
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

const MODES = [
  { id: 'all',      label: 'All messages' },
  { id: 'groups',   label: 'By group' },
  { id: 'aliases',  label: 'By alias' },
  { id: 'capcodes', label: 'By capcode' },
  { id: 'keywords', label: 'By keyword' },
];

const DEFAULTS = { mode: 'all', group_ids: [], capcodes: [], keywords: [] };

function sanitise(raw) {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  return {
    mode:      MODES.map(m => m.id).includes(raw.mode) ? raw.mode : 'all',
    group_ids: Array.isArray(raw.group_ids) ? raw.group_ids.map(Number) : [],
    capcodes:  Array.isArray(raw.capcodes)  ? raw.capcodes  : [],
    keywords:  Array.isArray(raw.keywords)  ? raw.keywords  : [],
  };
}

function setListField(value) {
  return value.split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
}

export default function NotifFilter() {
  const { data: rawFilter, loading: loadingFilter } = useAdminFetch(adminFetchNotifFilter, DEFAULTS);
  const { data: rawAliases } = useAdminFetch(adminFetchAliases, []);
  const { data: rawGroups  } = useAdminFetch(adminFetchGroups,  []);

  const [filter, setFilter] = useState(sanitise(null));
  const [saving, setSaving] = useState(false);
  const [msg, setMsg]       = useState(null);

  useEffect(() => { if (rawFilter) setFilter(sanitise(rawFilter)); }, [rawFilter]);

  const aliases = Array.isArray(rawAliases) ? rawAliases : [];
  const groups  = Array.isArray(rawGroups)  ? rawGroups : [];

  const flash = (type, text) => { setMsg({ type, text }); setTimeout(() => setMsg(null), 4000); };

  const save = async () => {
    setSaving(true);
    try { await adminSaveNotifFilter(filter); flash('ok', 'Notification filter saved'); }
    catch (e) { flash('err', e.message); }
    finally { setSaving(false); }
  };

  if (loadingFilter) return <div style={{ color: 'var(--text-3)', fontFamily: 'monospace', fontSize: '0.85rem' }}>Loading…</div>;

  const safe = sanitise(filter);

  return (
    <div style={{ maxWidth: '600px' }}>
      <h2 style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--text-1)', marginBottom: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <Filter size={16} style={{ color: 'var(--accent-blue)' }} /> Notification Filter
      </h2>
      <p style={{ fontSize: '0.82rem', color: 'var(--text-3)', marginBottom: '1rem', lineHeight: 1.6 }}>
        Controls which messages trigger <strong style={{ color: 'var(--text-2)' }}>Discord, Telegram, Gotify, Pushover, and MQTT</strong> notifications.
        Email and push notifications use per-user filters instead.
      </p>

      {msg && (
        <div style={{
          padding: '0.45rem 0.75rem', borderRadius: '0.4rem', fontSize: '0.78rem', fontFamily: 'monospace', marginBottom: '0.75rem',
          color: msg.type === 'ok' ? 'var(--accent-green)' : 'var(--accent-red)',
          background: `color-mix(in srgb, ${msg.type === 'ok' ? 'var(--accent-green)' : 'var(--accent-red)'} 10%, transparent)`,
          border: `1px solid color-mix(in srgb, ${msg.type === 'ok' ? 'var(--accent-green)' : 'var(--accent-red)'} 30%, transparent)`,
        }}>{msg.text}</div>
      )}

      <div className="pm-card" style={{ marginBottom: '1rem' }}>
        <div className="pm-section-title">Mode</div>
        <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
          {MODES.map(m => (
            <button key={m.id} onClick={() => setFilter(f => ({ ...sanitise(f), mode: m.id }))}
              style={{
                padding: '0.2rem 0.6rem', borderRadius: '0.75rem', fontSize: '0.75rem',
                cursor: 'pointer', border: '1px solid',
                background: safe.mode === m.id ? 'color-mix(in srgb,var(--accent-blue) 15%,transparent)' : 'var(--bg-3)',
                color: safe.mode === m.id ? 'var(--accent-blue)' : 'var(--text-3)',
                borderColor: safe.mode === m.id ? 'color-mix(in srgb,var(--accent-blue) 35%,transparent)' : 'var(--border)',
              }}>
              {m.label}
            </button>
          ))}
        </div>
      </div>

      {safe.mode === 'groups' && (
        <div className="pm-card" style={{ marginBottom: '1rem' }}>
          <div className="pm-section-title">Groups ({safe.group_ids.length} selected)</div>
          {groups.length === 0
            ? <div style={{ color: 'var(--text-3)', fontSize: '0.82rem' }}>No groups defined yet.</div>
            : (
              <GroupPicker groups={groups} selectedIds={safe.group_ids}
                onChange={ids => setFilter(f => ({ ...sanitise(f), group_ids: ids }))} />
            )
          }
        </div>
      )}

      {safe.mode === 'aliases' && (
        <div className="pm-card" style={{ marginBottom: '1rem' }}>
          <div className="pm-section-title">Aliases ({safe.capcodes.length} selected)</div>
          {aliases.length === 0
            ? <div style={{ color: 'var(--text-3)', fontSize: '0.82rem' }}>No aliases defined yet.</div>
            : (
              <div style={{ maxHeight: '260px', overflowY: 'auto', display: 'flex', flexWrap: 'wrap', gap: '0.3rem' }}>
                {aliases.map(a => (
                  <label key={a.capcode} style={{
                    display: 'flex', alignItems: 'center', gap: '0.3rem',
                    fontSize: '0.75rem', cursor: 'pointer', padding: '0.15rem 0.4rem',
                    borderRadius: '0.3rem', border: '1px solid var(--border)', background: 'var(--bg-0)',
                    whiteSpace: 'nowrap',
                  }}>
                    <input type="checkbox"
                      checked={safe.capcodes.includes(a.capcode)}
                      onChange={e => {
                        const caps = e.target.checked
                          ? [...safe.capcodes, a.capcode]
                          : safe.capcodes.filter(x => x !== a.capcode);
                        setFilter(f => ({ ...sanitise(f), capcodes: caps }));
                      }} />
                    <span style={{ color: a.color || 'var(--accent-green)' }}>{a.name}</span>
                    <span style={{ color: 'var(--text-3)', fontFamily: 'monospace', fontSize: '0.68rem' }}>{a.capcode}</span>
                  </label>
                ))}
              </div>
            )
          }
        </div>
      )}

      {safe.mode === 'capcodes' && (
        <div className="pm-card" style={{ marginBottom: '1rem' }}>
          <div className="pm-section-title">Capcodes (one per line or comma-separated)</div>
          <textarea className="pm-input" rows={4}
            value={safe.capcodes.join('\n')}
            onChange={e => setFilter(f => ({ ...sanitise(f), capcodes: setListField(e.target.value) }))}
            placeholder="1234567&#10;2345678"
            style={{ resize: 'vertical', fontFamily: 'monospace', fontSize: '0.8rem' }} />
        </div>
      )}

      {safe.mode === 'keywords' && (
        <div className="pm-card" style={{ marginBottom: '1rem' }}>
          <div className="pm-section-title">Keywords (one per line or comma-separated)</div>
          <textarea className="pm-input" rows={4}
            value={safe.keywords.join('\n')}
            onChange={e => setFilter(f => ({ ...sanitise(f), keywords: setListField(e.target.value) }))}
            placeholder="požar&#10;nujna&#10;urgent"
            style={{ resize: 'vertical', fontFamily: 'monospace', fontSize: '0.8rem' }} />
        </div>
      )}

      <button className="pm-btn pm-btn-primary" onClick={save} disabled={saving}>
        <Save size={13} /> {saving ? 'Saving…' : 'Save filter'}
      </button>
    </div>
  );
}
