import { useState, useEffect } from 'react';
import { Filter, Save } from 'lucide-react';
import { adminFetchNotifFilter, adminSaveNotifFilter } from '../../utils/api.js';
import { useAdminFetch } from '../../hooks/useAdminFetch.js';
import { adminFetchAliases, adminFetchGroups } from '../../utils/api.js';

const DEFAULTS = { mode: 'all', capcodes: [] };

function sanitise(raw) {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  return {
    mode:     ['all','filtered'].includes(raw.mode) ? raw.mode : 'all',
    capcodes: Array.isArray(raw.capcodes) ? raw.capcodes : [],
  };
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
  const groups  = Array.isArray(rawGroups)  ? rawGroups  : [];

  const flash = (type, text) => { setMsg({ type, text }); setTimeout(() => setMsg(null), 4000); };

  const toggleCapcode = (capcode) => {
    setFilter(f => {
      const safe = sanitise(f);
      const next = safe.capcodes.includes(capcode)
        ? safe.capcodes.filter(c => c !== capcode)
        : [...safe.capcodes, capcode];
      return { ...safe, capcodes: next };
    });
  };

  const selectGroup = (groupId, add) => {
    const capcodes = aliases.filter(a => a.group_id === groupId).map(a => a.capcode);
    setFilter(f => {
      const safe = sanitise(f);
      let next = [...safe.capcodes];
      for (const c of capcodes) {
        if (add && !next.includes(c)) next.push(c);
        if (!add) next = next.filter(x => x !== c);
      }
      return { ...safe, capcodes: next };
    });
  };

  const save = async () => {
    setSaving(true);
    try { await adminSaveNotifFilter(filter); flash('ok', 'Notification filter saved'); }
    catch (e) { flash('err', e.message); }
    finally { setSaving(false); }
  };

  if (loadingFilter) return <div style={{ color:'var(--text-3)', fontFamily:'monospace', fontSize:'0.85rem' }}>Loading…</div>;

  const safe = sanitise(filter);

  return (
    <div style={{ maxWidth:'600px' }}>
      <h2 style={{ fontSize:'1rem', fontWeight:700, color:'var(--text-1)', marginBottom:'0.5rem', display:'flex', alignItems:'center', gap:'0.5rem' }}>
        <Filter size={16} style={{ color:'var(--accent-blue)' }} /> Notification Filter
      </h2>
      <p style={{ fontSize:'0.82rem', color:'var(--text-3)', marginBottom:'1rem' }}>
        Control which messages trigger notifications. "All" sends every decoded message. "Filtered" sends only messages from selected capcodes.
      </p>

      {msg && (
        <div style={{ padding:'0.45rem 0.75rem', borderRadius:'0.4rem', fontSize:'0.78rem', fontFamily:'monospace', marginBottom:'0.75rem',
          color: msg.type==='ok'?'var(--accent-green)':'var(--accent-red)',
          background:`color-mix(in srgb, ${msg.type==='ok'?'var(--accent-green)':'var(--accent-red)'} 10%, transparent)`,
          border:`1px solid color-mix(in srgb, ${msg.type==='ok'?'var(--accent-green)':'var(--accent-red)'} 30%, transparent)`,
        }}>{msg.text}</div>
      )}

      {/* Mode selector */}
      <div className="pm-card" style={{ marginBottom:'1rem' }}>
        <div className="pm-section-title">Mode</div>
        {['all','filtered'].map(m => (
          <label key={m} style={{ display:'flex', alignItems:'center', gap:'0.6rem', marginBottom:'0.5rem', cursor:'pointer', fontSize:'0.85rem', color:'var(--text-1)' }}>
            <input type="radio" name="notif_mode" value={m} checked={safe.mode === m}
              onChange={() => setFilter(f => ({ ...sanitise(f), mode: m }))} />
            <span>
              {m === 'all' ? '📡 All messages' : '🎯 Filtered — only selected capcodes'}
            </span>
          </label>
        ))}
      </div>

      {/* Capcode selection (only when filtered) */}
      {safe.mode === 'filtered' && (
        <div className="pm-card" style={{ marginBottom:'1rem' }}>
          <div className="pm-section-title">
            Select capcodes ({safe.capcodes.length} selected)
          </div>

          {/* Group quick-select buttons */}
          {groups.length > 0 && (
            <div style={{ marginBottom:'0.75rem' }}>
              <div className="pm-label">Quick select by group</div>
              <div style={{ display:'flex', flexWrap:'wrap', gap:'0.4rem' }}>
                {groups.map(g => {
                  const groupCodes = aliases.filter(a => a.group_id === g.id).map(a => a.capcode);
                  const allSelected = groupCodes.length > 0 && groupCodes.every(c => safe.capcodes.includes(c));
                  return (
                    <button key={g.id} onClick={() => selectGroup(g.id, !allSelected)} style={{
                      fontSize:'0.72rem', padding:'0.2rem 0.6rem', borderRadius:'1rem', cursor:'pointer',
                      background: allSelected ? (g.color||'#a855f7') + '25' : 'var(--bg-3)',
                      border:`1px solid ${allSelected ? (g.color||'#a855f7') : 'var(--border)'}`,
                      color: allSelected ? (g.color||'#a855f7') : 'var(--text-2)',
                      fontWeight: allSelected ? 600 : 400,
                    }}>
                      {g.name} ({groupCodes.length})
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Individual aliases */}
          {aliases.length === 0
            ? <div style={{ color:'var(--text-3)', fontSize:'0.82rem' }}>No aliases defined yet. Add aliases first.</div>
            : (
              <div style={{ display:'grid', gap:'0.25rem', maxHeight:'300px', overflowY:'auto' }}>
                {aliases.map(a => {
                  const checked = safe.capcodes.includes(a.capcode);
                  return (
                    <label key={a.capcode} style={{ display:'flex', alignItems:'center', gap:'0.6rem',
                      padding:'0.3rem 0.5rem', borderRadius:'0.35rem', cursor:'pointer',
                      background: checked ? 'color-mix(in srgb, var(--accent-blue) 8%, transparent)' : 'transparent' }}>
                      <input type="checkbox" checked={checked} onChange={() => toggleCapcode(a.capcode)} />
                      <span style={{ fontFamily:'monospace', fontSize:'0.78rem', color:'var(--accent-amber)', minWidth:'75px' }}>{a.capcode}</span>
                      <span style={{ fontSize:'0.82rem', color: a.color||'var(--accent-green)', fontWeight:600 }}>{a.name}</span>
                      {a.group_name && (
                        <span style={{ fontSize:'0.68rem', color: a.group_color||'var(--text-3)',
                          background: (a.group_color||'#888') + '22', padding:'0.1rem 0.4rem', borderRadius:'0.75rem' }}>
                          {a.group_name}
                        </span>
                      )}
                    </label>
                  );
                })}
              </div>
            )
          }
        </div>
      )}

      <button className="pm-btn pm-btn-primary" onClick={save} disabled={saving}>
        <Save size={13} /> {saving ? 'Saving…' : 'Save filter'}
      </button>
    </div>
  );
}
