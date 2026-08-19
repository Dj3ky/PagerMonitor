import { useState, useRef, useMemo, useEffect } from 'react';
import { Tag, Trash2, Save, Pencil, X, Upload, Download, Search } from 'lucide-react';
import ActivityFeed from './ActivityFeed.jsx';
import { adminFetchAliases, adminSaveAlias, adminDeleteAlias, adminDeleteAllAliases, adminDeleteAllGlobalAliases,
         adminFetchGroups, adminExportAliasesCsv, adminImportAliasesCsv } from '../../utils/api.js';
import { useAdminFetch } from '../../hooks/useAdminFetch.js';
import { useAuth } from '../../context/AuthContext.jsx';

const EMPTY = { capcode:'', name:'', color:'#00ff9d', notes:'', group_id:'', row_color:'', row_sound:'', is_global:false };

// Searchable replacement for a plain <select> of groups — with dozens/hundreds of groups a
// native dropdown means scrolling through everything to find one by eye. Typing filters by
// name; picking an option (or clicking "— No group —") sets the value and closes.
// onMouseDown+preventDefault on the options fires the pick before the input's onBlur would
// otherwise close the list first and swallow the click.
function GroupSelect({ groups, value, onChange }) {
  const [open, setOpen]     = useState(false);
  const [search, setSearch] = useState('');
  const selected = groups.find(g => String(g.id) === String(value));
  const q        = search.trim().toLowerCase();
  const filtered = !q ? groups : groups.filter(g => g.name.toLowerCase().includes(q));

  const pick = id => { onChange(id); setOpen(false); setSearch(''); };

  return (
    <div style={{ position:'relative' }}>
      <input className="pm-input" placeholder="— No group —"
        value={open ? search : (selected ? selected.name : '')}
        onFocus={() => { setOpen(true); setSearch(''); }}
        onChange={e => setSearch(e.target.value)}
        onBlur={() => setTimeout(() => setOpen(false), 150)} />
      {open && (
        <div style={{ position:'absolute', zIndex:10, top:'100%', left:0, right:0, marginTop:'0.2rem',
          maxHeight:'220px', overflowY:'auto', background:'var(--bg-1)', border:'1px solid var(--border)',
          borderRadius:'0.4rem', boxShadow:'0 4px 12px rgba(0,0,0,0.3)' }}>
          <div onMouseDown={e => { e.preventDefault(); pick(''); }}
            style={{ padding:'0.35rem 0.6rem', fontSize:'0.8rem', cursor:'pointer', color:'var(--text-3)' }}>
            — No group —
          </div>
          {filtered.map(g => (
            <div key={g.id} onMouseDown={e => { e.preventDefault(); pick(String(g.id)); }}
              style={{ padding:'0.35rem 0.6rem', fontSize:'0.8rem', cursor:'pointer',
                display:'flex', alignItems:'center', gap:'0.3rem', color: g.color || 'var(--text-1)' }}>
              {g.parent_id ? <span style={{ color:'var(--text-3)' }}>↳</span> : null}
              {g.name}
            </div>
          ))}
          {!filtered.length && <div style={{ padding:'0.35rem 0.6rem', fontSize:'0.78rem', color:'var(--text-3)' }}>No matches</div>}
        </div>
      )}
    </div>
  );
}

function Flash({ msg }) {
  if (!msg) return null;
  const ok = msg.type === 'ok';
  return (
    <div style={{ padding:'0.45rem 0.75rem', borderRadius:'0.4rem', fontSize:'0.78rem', fontFamily:'monospace', marginBottom:'0.75rem',
      color: ok?'var(--accent-green)':'var(--accent-red)',
      background:`color-mix(in srgb, ${ok?'var(--accent-green)':'var(--accent-red)'} 10%, transparent)`,
      border:`1px solid color-mix(in srgb, ${ok?'var(--accent-green)':'var(--accent-red)'} 30%, transparent)`,
    }}>{msg.text}</div>
  );
}

export default function AliasManager() {
  const { user } = useAuth();
  const isPlatformAdmin = !!user?.isPlatformAdmin;
  const { data: aliasesRaw, loading, reload } = useAdminFetch(adminFetchAliases, []);
  const { data: groupsRaw } = useAdminFetch(adminFetchGroups, []);

  const aliases = Array.isArray(aliasesRaw) ? aliasesRaw : [];
  const groups  = Array.isArray(groupsRaw)  ? groupsRaw  : [];

  const [form, setForm]       = useState({ ...EMPTY });
  const [editing, setEditing] = useState(null);
  const [overriding, setOverriding] = useState(false); // org-admin editing a global row → creates their own override, doesn't touch the shared one
  const [saving, setSaving]   = useState(false);
  const [msg, setMsg]         = useState(null);
  const [importAsGlobal, setImportAsGlobal] = useState(false);
  const [search, setSearch]   = useState('');
  const [aliasColorFromGroup, setAliasColorFromGroup] = useState(false);
  const fileRef               = useRef();

  const flash = (type, text) => { setMsg({ type, text }); setTimeout(() => setMsg(null), 3500); };

  const filteredAliases = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return aliases;
    return aliases.filter(a =>
      a.capcode?.toLowerCase().includes(q) ||
      a.name?.toLowerCase().includes(q) ||
      a.notes?.toLowerCase().includes(q) ||
      a.group_name?.toLowerCase().includes(q)
    );
  }, [aliases, search]);

  const loadAliasColorPreference = () => {
    fetch(`${import.meta.env.VITE_BACKEND_URL || ''}/auth/me/notif-prefs`, {
      headers: { 'Content-Type':'application/json', Authorization:`Bearer ${localStorage.getItem('pm_token') || ''}` },
    })
      .then(r => r.json())
      .then(d => setAliasColorFromGroup(!!d?.alias_color_from_group))
      .catch(() => {});
  };

  useEffect(() => {
    const onPrefsUpdate = (e) => {
      if (typeof e.detail?.alias_color_from_group === 'boolean') {
        setAliasColorFromGroup(e.detail.alias_color_from_group);
      } else {
        loadAliasColorPreference();
      }
    };
    loadAliasColorPreference();
    window.addEventListener('pm:notif-prefs-updated', onPrefsUpdate);
    return () => window.removeEventListener('pm:notif-prefs-updated', onPrefsUpdate);
  }, []);

  const applyGroupSelection = (groupId) => {
    setForm(f => {
      const next = { ...f, group_id: groupId };
      if (!editing && aliasColorFromGroup) {
        const selected = groups.find(g => String(g.id) === String(groupId));
        if (selected?.color) next.color = selected.color;
      }
      return next;
    });
  };

  const handleSave = async () => {
    if (!form.capcode.trim() || !form.name.trim()) { flash('err', 'Capcode and name are required'); return; }
    setSaving(true);
    try {
      await adminSaveAlias(form.capcode.trim(), {
        name: form.name, color: form.color, notes: form.notes,
        group_id: form.group_id ? parseInt(form.group_id) : null,
        row_color: form.row_color || null, row_sound: form.row_sound || null,
        is_global: form.is_global,
      });
      flash('ok', overriding ? `Saved your organization's own version of ${form.capcode}` : editing ? `Updated ${form.capcode}` : `Added ${form.capcode}`);
      setForm({ ...EMPTY }); setEditing(null); setOverriding(false); reload();
    } catch (e) { flash('err', e.message); }
    finally { setSaving(false); }
  };

  const startEdit = a => {
    // A global row opened by a non-platform-admin is an "override": saving creates a new
    // row scoped to their own org (upsertAlias always targets req.session.orgId for them)
    // rather than editing the shared global row — so it never touches what every other
    // org sees. Only a platform admin editing a global row is a real in-place edit.
    const isGlobalRow = a.org_id == null;
    setForm({ capcode:a.capcode, name:a.name||'', color:a.color||'#00ff9d', notes:a.notes||'', group_id: a.group_id||'', row_color: a.row_color||'', row_sound: a.row_sound||'', is_global: isGlobalRow && isPlatformAdmin });
    setEditing(a.capcode);
    setOverriding(isGlobalRow && !isPlatformAdmin);
  };
  const cancelEdit = () => { setForm({ ...EMPTY }); setEditing(null); setOverriding(false); };

  const handleDelete = async capcode => {
    if (!confirm(`Delete alias for ${capcode}?`)) return;
    try { await adminDeleteAlias(capcode); flash('ok', `Deleted ${capcode}`); reload(); }
    catch (e) { flash('err', e.message); }
  };

  const handleExport = () => adminExportAliasesCsv().catch(e => flash('err', e.message));

  const handleDeleteAll = async () => {
    if (!confirm(`Delete all ${aliases.length} aliases? This cannot be undone.`)) return;
    try { const r = await adminDeleteAllAliases(); flash('ok', `Deleted ${r.deleted} aliases`); reload(); }
    catch (e) { flash('err', e.message); }
  };

  const globalAliasCount = aliases.filter(a => a.org_id == null).length;
  const handleDeleteAllGlobal = async () => {
    if (!confirm(`Delete all ${globalAliasCount} GLOBAL aliases? This affects every organization on this instance, not just yours. This cannot be undone.`)) return;
    try { const r = await adminDeleteAllGlobalAliases(); flash('ok', `Deleted ${r.deleted} global aliases`); reload(); }
    catch (e) { flash('err', e.message); }
  };

  const handleImport = async e => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const r = await adminImportAliasesCsv(text, isPlatformAdmin && importAsGlobal);
      const skipNote = r.skipped ? `, ${r.skipped} skipped (empty capcode)` : '';
      flash('ok', `Imported ${r.imported ?? 0} aliases${skipNote}`);
      reload();
    } catch (e) { flash('err', e.message); }
    e.target.value = '';
  };

  return (
    <div style={{ maxWidth:'720px' }}>
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:'1rem' }}>
        <h2 style={{ fontSize:'1rem', fontWeight:700, color:'var(--text-1)', display:'flex', alignItems:'center', gap:'0.5rem', margin:0 }}>
          <Tag size={16} style={{ color:'var(--accent-amber)' }} /> Aliases
        </h2>
        <div style={{ display:'flex', alignItems:'center', gap:'0.5rem' }}>
          {isPlatformAdmin && (
            <label style={{ display:'flex', alignItems:'center', gap:'0.3rem', fontSize:'0.72rem', color:'var(--text-3)', cursor:'pointer' }}
              title="New imports become global/shared defaults instead of belonging to your own org">
              <input type="checkbox" checked={importAsGlobal} onChange={e => setImportAsGlobal(e.target.checked)} />
              Import as global
            </label>
          )}
          <button className="pm-btn" onClick={handleExport} style={{ fontSize:'0.75rem' }}><Download size={12} /> Export CSV</button>
          <button className="pm-btn" onClick={() => fileRef.current?.click()} style={{ fontSize:'0.75rem' }}><Upload size={12} /> Import CSV</button>
          {aliases.length > 0 && <button className="pm-btn" onClick={handleDeleteAll} style={{ fontSize:'0.75rem', color:'var(--accent-red)' }}><Trash2 size={12} /> Delete All</button>}
          {isPlatformAdmin && globalAliasCount > 0 && (
            <button className="pm-btn" onClick={handleDeleteAllGlobal} style={{ fontSize:'0.75rem', color:'var(--accent-red)' }}
              title="Deletes the shared global alias library — affects every organization on this instance">
              <Trash2 size={12} /> Delete Global
            </button>
          )}
          <input ref={fileRef} type="file" accept=".csv,text/csv" style={{ display:'none' }} onChange={handleImport} />
        </div>
      </div>

      <Flash msg={msg} />

      {/* Form */}
      <div className="pm-card" style={{ marginBottom:'1rem', borderColor: editing ? 'color-mix(in srgb, var(--accent-amber) 30%, transparent)' : 'var(--border)' }}>
        <div className="pm-section-title" style={{ color: editing?'var(--accent-amber)':'var(--text-2)',
          display:'flex', alignItems:'center', justifyContent:'space-between' }}>
          {overriding ? `Override ${editing} for your organization` : editing ? `Editing ${editing}` : 'Add alias'}
          {editing && <button onClick={cancelEdit} style={{ background:'none', border:'none', cursor:'pointer', color:'var(--text-3)' }}><X size={14}/></button>}
        </div>
        {overriding && (
          <p style={{ fontSize:'0.72rem', color:'var(--text-3)', margin:'-0.2rem 0 0.6rem' }}>
            This is a shared default from the global library — saving creates your organization's own version
            (e.g. to put it in one of your groups) without changing what other organizations see.
          </p>
        )}

        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'0.6rem', marginBottom:'0.6rem' }}>
          <div>
            <label className="pm-label">Capcode</label>
            <input className="pm-input" placeholder="e.g. 1234567" value={form.capcode}
              onChange={e => setForm(f=>({...f,capcode:e.target.value}))} disabled={!!editing} />
          </div>
          <div>
            <label className="pm-label">Name</label>
            <input className="pm-input" placeholder="Friendly name" value={form.name}
              onChange={e => setForm(f=>({...f,name:e.target.value}))} />
          </div>
          <div>
            <label className="pm-label">Group (optional)</label>
            <GroupSelect groups={groups} value={form.group_id} onChange={applyGroupSelection} />
          </div>
          <div>
            <label className="pm-label">Notes (optional)</label>
            <input className="pm-input" placeholder="Description…" value={form.notes}
              onChange={e => setForm(f=>({...f,notes:e.target.value}))} />
          </div>
          <div>
            <label className="pm-label">Colour</label>
            <div style={{ display:'flex', gap:'0.5rem', alignItems:'center' }}>
              <input type="color" value={form.color} onChange={e => setForm(f=>({...f,color:e.target.value}))}
                style={{ width:'36px', height:'36px', borderRadius:'0.4rem', border:'1px solid var(--border)', padding:'2px', cursor:'pointer', background:'var(--bg-3)' }} />
              <span style={{ padding:'0.15rem 0.6rem', borderRadius:'1rem', fontSize:'0.75rem', fontWeight:600,
                color:form.color, background:form.color+'22', border:`1px solid ${form.color}55` }}>
                {form.name || 'Preview'}
              </span>
            </div>
          </div>
          <div>
            <label className="pm-label">Row highlight colour (optional)</label>
            <div style={{ display:'flex', alignItems:'center', gap:'0.5rem', marginBottom:'0.35rem' }}>
              <input type="checkbox" checked={!!form.row_color}
                onChange={e => setForm(f => ({ ...f, row_color: e.target.checked ? '#ff4444' : '' }))}
                id="alias-row-color-on" />
              <label htmlFor="alias-row-color-on" style={{ fontSize:'0.82rem', cursor:'pointer', color:'var(--text-1)' }}>
                Enable row highlight
              </label>
            </div>
            {form.row_color && (
              <div style={{ display:'flex', gap:'0.5rem', alignItems:'center', marginBottom:'0.35rem' }}>
                <input type="color" value={form.row_color}
                  onChange={e => setForm(f=>({...f,row_color:e.target.value}))}
                  style={{ width:'40px', height:'32px', borderRadius:'0.4rem', border:'1px solid var(--border)', padding:'2px', cursor:'pointer', background:'var(--bg-3)' }} />
                {/* Live row preview */}
                <div style={{ flex:1, padding:'0.3rem 0.6rem', borderRadius:'0.35rem',
                  background:`color-mix(in srgb,${form.row_color} 10%,var(--bg-0))`,
                  border:`1px solid color-mix(in srgb,${form.row_color} 25%,var(--border))`,
                  fontFamily:'monospace', fontSize:'0.72rem', color:'var(--text-1)' }}>
                  ← this is how the message row will look
                </div>
              </div>
            )}
            <div style={{ fontSize:'0.65rem', color:'var(--text-3)' }}>
              {form.row_color
                ? 'Row background is tinted with a subtle version of this colour.'
                : 'No row highlight — rows display with the default background.'}
            </div>
          </div>
          <div>
            <label className="pm-label">Sound alert (optional)</label>
            <div style={{ display:'flex', gap:'0.5rem', alignItems:'center', marginBottom:'0.35rem' }}>
              <select className="pm-input" style={{ flex:1 }} value={form.row_sound||''}
                onChange={e => setForm(f=>({...f,row_sound:e.target.value}))}>
                <option value="">Inherit from group (use group's sound)</option>
                <option value="none">None — stay silent even if group has a sound</option>
                <option value="chime">Chime — soft ascending tones</option>
                <option value="info">Info — two-tone notification</option>
                <option value="alert">Alert — triple beep</option>
                <option value="urgent">Urgent — fast alternating beeps</option>
              </select>
              {form.row_sound && form.row_sound !== 'none' && (
                <button className="pm-btn" title="Test this sound"
                  onClick={() => window.__playAlertSound?.(form.row_sound)}
                  style={{ flexShrink:0 }}>
                  ▶ Test
                </button>
              )}
            </div>
          </div>
        </div>

        {isPlatformAdmin && !editing && (
          <label style={{ display:'flex', alignItems:'center', gap:'0.4rem', fontSize:'0.78rem', color:'var(--text-2)',
            cursor:'pointer', marginBottom:'0.6rem' }}
            title="Visible as a shared default to every organization, not just your own">
            <input type="checkbox" checked={form.is_global} onChange={e => setForm(f => ({ ...f, is_global: e.target.checked }))} />
            Make this global (visible to every organization)
          </label>
        )}

        <button className="pm-btn pm-btn-primary" onClick={handleSave} disabled={!form.capcode||!form.name||saving}>
          <Save size={13} /> {saving ? 'Saving…' : overriding ? 'Save override' : editing ? 'Update' : form.is_global ? 'Add global alias' : 'Add alias'}
        </button>
      </div>

      <div style={{ fontSize:'0.72rem', color:'var(--text-3)', fontFamily:'monospace', marginBottom:'0.75rem',
        padding:'0.4rem 0.6rem', background:'var(--bg-2)', borderRadius:'0.35rem', border:'1px solid var(--border)' }}>
        CSV format (semicolon-separated): <span style={{ color:'var(--text-2)' }}>capcode;name;color;notes;group_name;row_color;row_sound</span> — group_name must match an existing group exactly; unmatched or blank leaves the alias ungrouped
      </div>

      {aliases.length > 0 && (
        <div style={{ position:'relative', marginBottom:'0.75rem' }}>
          <Search size={13} style={{ position:'absolute', left:'0.6rem', top:'50%', transform:'translateY(-50%)', color:'var(--text-3)' }} />
          <input className="pm-input" placeholder="Search aliases by capcode, name, notes, or group…"
            value={search} onChange={e => setSearch(e.target.value)}
            style={{ paddingLeft:'1.9rem' }} />
          {search && (
            <button onClick={() => setSearch('')} title="Clear search"
              style={{ position:'absolute', right:'0.5rem', top:'50%', transform:'translateY(-50%)',
                background:'none', border:'none', cursor:'pointer', color:'var(--text-3)', padding:'0.2rem' }}>
              <X size={13} />
            </button>
          )}
        </div>
      )}

      {loading
        ? <div style={{ color:'var(--text-3)', fontFamily:'monospace', fontSize:'0.82rem' }}>Loading…</div>
        : aliases.length === 0
          ? <div style={{ color:'var(--text-3)', fontFamily:'monospace', fontSize:'0.82rem', padding:'2rem', textAlign:'center' }}>No aliases yet.</div>
          : filteredAliases.length === 0
            ? <div style={{ color:'var(--text-3)', fontFamily:'monospace', fontSize:'0.82rem', padding:'2rem', textAlign:'center' }}>No aliases match "{search}".</div>
            : (
            <div style={{ display:'grid', gap:'0.3rem' }}>
              {filteredAliases.map(a => {
                const isGlobal = a.org_id == null;
                const locked   = isGlobal && !isPlatformAdmin;
                return (
                <div key={a.capcode} style={{
                  display:'flex', alignItems:'center', gap:'0.6rem',
                  background: editing===a.capcode ? 'color-mix(in srgb, var(--accent-amber) 8%, var(--bg-2))' : 'var(--bg-2)',
                  border:`1px solid ${editing===a.capcode ? 'color-mix(in srgb, var(--accent-amber) 30%, transparent)' : 'var(--border)'}`,
                  borderRadius:'0.5rem', padding:'0.45rem 0.75rem',
                }}>
                  <span style={{ fontFamily:'monospace', fontSize:'0.78rem', color:'var(--accent-amber)', minWidth:'75px' }}>{a.capcode}</span>
                  <span style={{ fontSize:'0.85rem', fontWeight:600, color:a.color||'var(--accent-green)', flex:1 }}>{a.name}</span>
                  {isGlobal && (
                    <span title="Shared default — visible to every organization" style={{ fontSize:'0.65rem', color:'var(--text-3)',
                      background:'var(--bg-3)', border:'1px solid var(--border)', padding:'0.1rem 0.4rem', borderRadius:'0.75rem', flexShrink:0 }}>
                      global
                    </span>
                  )}
                  {a.group_name && (
                    <span style={{ fontSize:'0.68rem', color:a.group_color||'var(--text-3)',
                      background:(a.group_color||'#888')+'22', padding:'0.1rem 0.4rem', borderRadius:'0.75rem', flexShrink:0 }}>
                      {a.group_name}
                    </span>
                  )}
                  {a.notes && <span style={{ fontSize:'0.72rem', color:'var(--text-3)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', maxWidth:'120px' }}>{a.notes}</span>}
                  <div style={{ display:'flex', gap:'0.3rem', flexShrink:0 }}>
                    <button onClick={() => startEdit(a)} title={locked ? 'Create your organization\'s own version of this alias' : undefined}
                      style={{ background:'none', border:'none', cursor:'pointer', color: locked ? 'var(--accent-blue)' : 'var(--text-3)', padding:'0.2rem' }}><Pencil size={13}/></button>
                    <button onClick={() => handleDelete(a.capcode)} disabled={locked} title={locked ? 'Only the platform admin can delete shared defaults' : undefined}
                      style={{ background:'none', border:'none', cursor: locked ? 'not-allowed' : 'pointer', color: locked ? 'var(--border)' : 'var(--accent-red)', padding:'0.2rem' }}><Trash2 size={13}/></button>
                  </div>
                </div>
              );})}
            </div>
          )
      }

      {/* Recent alias activity */}
      <div className="pm-card" style={{ marginTop:'1.5rem' }}>
        <ActivityFeed filter="alias" limit={8} compact />
      </div>
    </div>
  );
}
