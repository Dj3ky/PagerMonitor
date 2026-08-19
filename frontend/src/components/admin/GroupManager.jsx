import { useState, useRef } from 'react';
import { Layers, Plus, Trash2, Pencil, X, Save, Upload, Download, Search, ChevronRight, ChevronDown } from 'lucide-react';
import ActivityFeed from './ActivityFeed.jsx';
import { adminFetchGroups, adminSaveGroup, adminDeleteGroup, adminDeleteAllGroups, adminDeleteAllGlobalGroups,
         adminExportGroupsCsv, adminImportGroupsCsv,
         adminFetchAliases, adminSaveAlias } from '../../utils/api.js';
import { useAdminFetch } from '../../hooks/useAdminFetch.js';
import { useAuth } from '../../context/AuthContext.jsx';

const EMPTY = { name:'', color:'#a855f7', parent_id:'', row_color:'', row_sound:'', is_global:false };

function Flash({ msg }) {
  if (!msg) return null;
  const ok = msg.type === 'ok';
  return (
    <div style={{ padding:'0.4rem 0.75rem', borderRadius:'0.4rem', fontSize:'0.78rem', fontFamily:'monospace', marginBottom:'0.75rem',
      color: ok?'var(--accent-green)':'var(--accent-red)',
      background:`color-mix(in srgb, ${ok?'var(--accent-green)':'var(--accent-red)'} 10%, transparent)`,
      border:`1px solid color-mix(in srgb, ${ok?'var(--accent-green)':'var(--accent-red)'} 30%, transparent)`,
    }}>{msg.text}</div>
  );
}

// One group's alias roster, plus a search-and-add picker limited to ungrouped aliases —
// an alias can only belong to one group at a time, so an already-grouped alias is never
// offered here; move it by removing it from its current group first.
function GroupAliasPanel({ group, allAliases, onAssign, onUnassign }) {
  const [search, setSearch] = useState('');
  const q = search.trim().toLowerCase();
  const available = allAliases.filter(a => !a.group_id && (!q || a.name?.toLowerCase().includes(q) || a.capcode?.includes(q)));

  return (
    <div style={{ marginLeft:'1.9rem', marginBottom:'0.4rem', padding:'0.55rem 0.7rem',
      background:'var(--bg-1)', border:'1px solid var(--border)', borderRadius:'0.4rem' }}>
      <div style={{ fontSize:'0.68rem', color:'var(--text-3)', marginBottom:'0.35rem' }}>Aliases in this group</div>
      <div style={{ display:'flex', flexWrap:'wrap', gap:'0.3rem', marginBottom:'0.6rem' }}>
        {group.aliases?.length > 0
          ? group.aliases.map(a => (
            <span key={a.capcode} style={{ display:'flex', alignItems:'center', gap:'0.25rem', fontSize:'0.72rem',
              padding:'0.15rem 0.3rem 0.15rem 0.5rem', borderRadius:'0.75rem',
              color: a.color || 'var(--accent-green)', background:(a.color||'#4ade80')+'22',
              border:`1px solid ${(a.color||'#4ade80')}44` }}>
              {a.name}
              <button onClick={() => onUnassign(a)} title="Remove from group"
                style={{ background:'none', border:'none', cursor:'pointer', color:'inherit', padding:0, display:'flex' }}>
                <X size={11} />
              </button>
            </span>
          ))
          : <span style={{ fontSize:'0.72rem', color:'var(--text-3)' }}>No aliases in this group yet.</span>}
      </div>

      <div style={{ fontSize:'0.68rem', color:'var(--text-3)', marginBottom:'0.3rem' }}>Add an ungrouped alias</div>
      <input className="pm-input" placeholder="Search ungrouped aliases…" value={search}
        onChange={e => setSearch(e.target.value)} style={{ fontSize:'0.75rem', marginBottom:'0.35rem' }} />
      <div style={{ maxHeight:'140px', overflowY:'auto', display:'flex', flexWrap:'wrap', gap:'0.3rem' }}>
        {available.map(a => (
          <button key={a.capcode} className="pm-btn" onClick={() => onAssign(a)} style={{ fontSize:'0.7rem' }}>
            + {a.name} <span style={{ color:'var(--text-3)', fontFamily:'monospace' }}>{a.capcode}</span>
          </button>
        ))}
        {!available.length && (
          <span style={{ fontSize:'0.72rem', color:'var(--text-3)' }}>
            {q ? 'No matches' : 'All aliases are already assigned to a group.'}
          </span>
        )}
      </div>
    </div>
  );
}

export default function GroupManager({ onGroupsChange }) {
  const { user } = useAuth();
  const isPlatformAdmin = !!user?.isPlatformAdmin;
  const { data: raw, loading, reload } = useAdminFetch(adminFetchGroups, []);
  const groups = Array.isArray(raw) ? raw : [];
  const { data: aliasesRaw, reload: reloadAliases } = useAdminFetch(adminFetchAliases, []);
  const aliases = Array.isArray(aliasesRaw) ? aliasesRaw : [];

  const [form, setForm]       = useState({ ...EMPTY });
  const [editing, setEditing] = useState(null); // group id
  const [originalIsGlobal, setOriginalIsGlobal] = useState(false); // scope at the time editing started
  const [msg, setMsg]         = useState(null);
  const [importAsGlobal, setImportAsGlobal] = useState(false);
  const [search, setSearch]   = useState('');
  const [expandedAliasGroupIds, setExpandedAliasGroupIds] = useState(() => new Set());
  const fileRef                = useRef();

  const flash = (type, text) => { setMsg({ type, text }); setTimeout(() => setMsg(null), 3500); };

  const topLevel = groups.filter(g => !g.parent_id);
  const subOf    = (parentId) => groups.filter(g => g.parent_id === parentId);

  const searchQ = search.trim().toLowerCase();
  const filteredTopLevel = !searchQ ? topLevel
    : topLevel.filter(g => g.name.toLowerCase().includes(searchQ) || subOf(g.id).some(c => c.name.toLowerCase().includes(searchQ)));

  const toggleAliasPanel = id => setExpandedAliasGroupIds(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const handleAssignAlias = async (alias, groupId) => {
    try {
      await adminSaveAlias(alias.capcode, { name: alias.name, color: alias.color, notes: alias.notes,
        group_id: groupId, row_color: alias.row_color || null, row_sound: alias.row_sound || null });
      reload(); reloadAliases();
    } catch (e) { flash('err', e.message); }
  };
  const handleUnassignAlias = async alias => {
    try {
      await adminSaveAlias(alias.capcode, { name: alias.name, color: alias.color, notes: alias.notes,
        group_id: null, row_color: alias.row_color || null, row_sound: alias.row_sound || null });
      reload(); reloadAliases();
    } catch (e) { flash('err', e.message); }
  };

  const startEdit = g => {
    const isGlobal = g.org_id == null;
    setForm({ name: g.name, color: g.color||'#a855f7', parent_id: g.parent_id||'', row_color: g.row_color||'', row_sound: g.row_sound||'', is_global: isGlobal });
    setOriginalIsGlobal(isGlobal);
    setEditing(g.id);
  };
  const cancelEdit = () => { setForm({ ...EMPTY }); setEditing(null); setOriginalIsGlobal(false); };

  const handleSave = async () => {
    if (!form.name.trim()) { flash('err', 'Name is required'); return; }
    try {
      const payload = { name: form.name, color: form.color, parent_id: form.parent_id ? parseInt(form.parent_id) : null, row_color: form.row_color || null, row_sound: form.row_sound || null };
      // Only send is_global when creating, or when editing AND the checkbox was actually
      // changed from the group's current scope — otherwise a routine name/color edit could
      // silently reassign the group's org as a side effect (see admin.js's /groups/:id route).
      if (!editing || form.is_global !== originalIsGlobal) payload.is_global = form.is_global;
      await adminSaveGroup(editing, payload);
      flash('ok', editing ? 'Group updated' : 'Group created');
      setForm({ ...EMPTY }); setEditing(null);
      reload();
      onGroupsChange?.([]);  // trigger parent refresh — actual data comes from next reload
    } catch (e) { flash('err', e.message); }
  };

  const handleDelete = async (id, name) => {
    if (!confirm(`Delete group "${name}"? Aliases in this group will become ungrouped.`)) return;
    try {
      await adminDeleteGroup(id);
      flash('ok', `Deleted "${name}"`);
      reload();
      onGroupsChange?.([]);
    } catch (e) { flash('err', e.message); }
  };

  const handleExport = () => adminExportGroupsCsv().catch(e => flash('err', e.message));

  const handleDeleteAll = async () => {
    if (!confirm(`Delete all ${groups.length} groups? Aliases and subgroups in them will become ungrouped. This cannot be undone.`)) return;
    try {
      const r = await adminDeleteAllGroups();
      flash('ok', `Deleted ${r.deleted} groups`);
      reload();
      onGroupsChange?.([]);
    } catch (e) { flash('err', e.message); }
  };

  const globalGroupCount = groups.filter(g => g.org_id == null).length;
  const handleDeleteAllGlobal = async () => {
    if (!confirm(`Delete all ${globalGroupCount} GLOBAL groups? This affects every organization on this instance, not just yours. Aliases and subgroups in them will become ungrouped. This cannot be undone.`)) return;
    try {
      const r = await adminDeleteAllGlobalGroups();
      flash('ok', `Deleted ${r.deleted} global groups`);
      reload();
      onGroupsChange?.([]);
    } catch (e) { flash('err', e.message); }
  };

  const handleImport = async e => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const r = await adminImportGroupsCsv(text, isPlatformAdmin && importAsGlobal);
      const skipNote = r.skipped ? `, ${r.skipped} skipped (empty name)` : '';
      flash('ok', `Imported ${r.imported ?? 0} groups${skipNote}`);
      reload();
      onGroupsChange?.([]);
    } catch (e) { flash('err', e.message); }
    e.target.value = '';
  };

  const GroupRow = ({ g, indent = 0 }) => {
    const isGlobal        = g.org_id == null;
    const locked          = isGlobal && !isPlatformAdmin;
    const aliasPanelOpen  = expandedAliasGroupIds.has(g.id);
    const allChildren     = subOf(g.id);
    // While searching, only descend into children that themselves match — unless this
    // group's own name already matched, in which case show all of them.
    const children = !searchQ ? allChildren
      : (g.name.toLowerCase().includes(searchQ) ? allChildren : allChildren.filter(c => c.name.toLowerCase().includes(searchQ)));
    return (
    <>
      <div style={{
        display:'flex', alignItems:'center', gap:'0.6rem',
        background: editing === g.id ? 'color-mix(in srgb, var(--accent-purple) 8%, var(--bg-2))' : 'var(--bg-2)',
        border:`1px solid ${editing===g.id ? 'color-mix(in srgb, var(--accent-purple) 30%, transparent)' : 'var(--border)'}`,
        borderRadius:'0.5rem', padding:'0.45rem 0.75rem', marginLeft: indent ? '1.25rem' : 0,
        marginBottom:'0.3rem',
      }}>
        {indent > 0 && <span style={{ fontSize:'0.7rem', color:'var(--text-3)' }}>↳</span>}
        <div style={{ width:'12px', height:'12px', borderRadius:'50%', background: g.color||'#a855f7', flexShrink:0 }} />
        <span style={{ flex:1, fontSize:'0.85rem', fontWeight:600, color: g.color||'var(--accent-purple)' }}>{g.name}</span>
        {isGlobal && (
          <span title="Shared default — visible to every organization" style={{ fontSize:'0.65rem', color:'var(--text-3)',
            background:'var(--bg-3)', border:'1px solid var(--border)', padding:'0.1rem 0.4rem', borderRadius:'0.75rem', flexShrink:0 }}>
            global
          </span>
        )}
        <button onClick={() => toggleAliasPanel(g.id)} title="View and manage aliases in this group"
          style={{ display:'flex', alignItems:'center', gap:'0.15rem', fontSize:'0.68rem', fontFamily:'monospace',
            color: aliasPanelOpen ? 'var(--accent-purple)' : 'var(--text-3)',
            background:'none', border:'none', cursor:'pointer', padding:'0.15rem 0.3rem', flexShrink:0 }}>
          {aliasPanelOpen ? <ChevronDown size={11}/> : <ChevronRight size={11}/>}
          {g.aliases?.length || 0} alias{(g.aliases?.length||0)!==1?'es':''}
        </button>
        <button onClick={() => startEdit(g)} disabled={locked} title={locked ? 'Only the platform admin can edit shared defaults' : undefined}
          style={{ background:'none', border:'none', cursor: locked ? 'not-allowed' : 'pointer', color: locked ? 'var(--border)' : 'var(--text-3)', padding:'0.2rem' }}>
          <Pencil size={13} />
        </button>
        <button onClick={() => handleDelete(g.id, g.name)} disabled={locked} title={locked ? 'Only the platform admin can delete shared defaults' : undefined}
          style={{ background:'none', border:'none', cursor: locked ? 'not-allowed' : 'pointer', color: locked ? 'var(--border)' : 'var(--accent-red)', padding:'0.2rem' }}>
          <Trash2 size={13} />
        </button>
      </div>
      {aliasPanelOpen && (
        <GroupAliasPanel group={g} allAliases={aliases}
          onAssign={a => handleAssignAlias(a, g.id)} onUnassign={handleUnassignAlias} />
      )}
      {children.map(sub => <GroupRow key={sub.id} g={sub} indent={indent+1} />)}
    </>
    );
  };

  return (
    <div style={{ maxWidth:'720px' }}>
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:'0.5rem' }}>
        <h2 style={{ fontSize:'1rem', fontWeight:700, color:'var(--text-1)', display:'flex', alignItems:'center', gap:'0.5rem', margin:0 }}>
          <Layers size={16} style={{ color:'var(--accent-purple)' }} /> Groups
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
          {groups.length > 0 && <button className="pm-btn" onClick={handleDeleteAll} style={{ fontSize:'0.75rem', color:'var(--accent-red)' }}><Trash2 size={12} /> Delete All</button>}
          {isPlatformAdmin && globalGroupCount > 0 && (
            <button className="pm-btn" onClick={handleDeleteAllGlobal} style={{ fontSize:'0.75rem', color:'var(--accent-red)' }}
              title="Deletes the shared global group library — affects every organization on this instance">
              <Trash2 size={12} /> Delete Global
            </button>
          )}
          <input ref={fileRef} type="file" accept=".csv,text/csv" style={{ display:'none' }} onChange={handleImport} />
        </div>
      </div>
      <p style={{ fontSize:'0.82rem', color:'var(--text-3)', marginBottom:'1rem' }}>
        Organise aliases into groups and subgroups. Groups appear as badges in the message feed.
      </p>

      <Flash msg={msg} />

      {/* Form */}
      <div className="pm-card" style={{ marginBottom:'1rem', borderColor: editing ? 'color-mix(in srgb, var(--accent-purple) 30%, transparent)' : 'var(--border)' }}>
        <div className="pm-section-title" style={{ color: editing ? 'var(--accent-purple)' : 'var(--text-2)',
          display:'flex', alignItems:'center', justifyContent:'space-between' }}>
          {editing ? 'Edit group' : 'New group'}
          {editing && <button onClick={cancelEdit} style={{ background:'none', border:'none', cursor:'pointer', color:'var(--text-3)' }}><X size={14} /></button>}
        </div>

        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'0.6rem', marginBottom:'0.6rem' }}>
          <div>
            <label className="pm-label">Group name</label>
            <input className="pm-input" placeholder="e.g. Emergency Services" value={form.name}
              onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
          </div>
          <div>
            <label className="pm-label">Colour</label>
            <div style={{ display:'flex', gap:'0.5rem', alignItems:'center' }}>
              <input type="color" value={form.color||'#a855f7'} onChange={e => setForm(f => ({ ...f, color: e.target.value }))}
                style={{ width:'36px', height:'36px', borderRadius:'0.4rem', border:'1px solid var(--border)', padding:'2px', cursor:'pointer', background:'var(--bg-3)' }} />
              <span style={{ padding:'0.15rem 0.6rem', borderRadius:'1rem', fontSize:'0.78rem', fontWeight:600,
                color: form.color||'#a855f7', background: (form.color||'#a855f7') + '22' }}>
                {form.name || 'Preview'}
              </span>
            </div>
          </div>
          <div>
            <label className="pm-label">Parent group (optional)</label>
            <select className="pm-input" value={form.parent_id||''} onChange={e => setForm(f => ({ ...f, parent_id: e.target.value }))}>
              <option value="">— Top level —</option>
              {topLevel.filter(g => g.id !== editing).map(g => (
                <option key={g.id} value={g.id}>{g.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="pm-label">Row highlight colour (optional)</label>
            <div style={{ display:'flex', alignItems:'center', gap:'0.5rem', marginBottom:'0.35rem' }}>
              <input type="checkbox" checked={!!form.row_color}
                onChange={e => setForm(f => ({ ...f, row_color: e.target.checked ? '#a855f7' : '' }))}
                id="group-row-color-on" />
              <label htmlFor="group-row-color-on" style={{ fontSize:'0.82rem', cursor:'pointer', color:'var(--text-1)' }}>
                Enable row highlight for this group
              </label>
            </div>
            {form.row_color && (
              <div style={{ display:'flex', gap:'0.5rem', alignItems:'center', marginBottom:'0.35rem' }}>
                <input type="color" value={form.row_color}
                  onChange={e => setForm(f => ({ ...f, row_color: e.target.value }))}
                  style={{ width:'40px', height:'32px', borderRadius:'0.4rem', border:'1px solid var(--border)', padding:'2px', cursor:'pointer', background:'var(--bg-3)' }} />
                <div style={{ flex:1, padding:'0.3rem 0.6rem', borderRadius:'0.35rem',
                  background:`color-mix(in srgb,${form.row_color} 10%,var(--bg-0))`,
                  border:`1px solid color-mix(in srgb,${form.row_color} 25%,var(--border))`,
                  fontFamily:'monospace', fontSize:'0.72rem', color:'var(--text-1)' }}>
                  ← message rows in this group will look like this
                </div>
              </div>
            )}
            <div style={{ fontSize:'0.65rem', color:'var(--text-3)' }}>
              {form.row_color
                ? 'Applies to all aliases in this group unless the alias overrides it.'
                : 'No row highlight for this group.'}
            </div>
          </div>
          <div>
            <label className="pm-label">Sound alert (optional)</label>
            <div style={{ display:'flex', gap:'0.5rem', alignItems:'center' }}>
              <select className="pm-input" style={{ flex:1 }} value={form.row_sound||''}
                onChange={e => setForm(f=>({...f,row_sound:e.target.value}))}>
                <option value="">None</option>
                <option value="chime">Chime — soft ascending tones</option>
                <option value="info">Info — two-tone notification</option>
                <option value="alert">Alert — triple beep</option>
                <option value="urgent">Urgent — fast alternating beeps</option>
              </select>
              {form.row_sound && (
                <button className="pm-btn" title="Test this sound"
                  onClick={() => window.__playAlertSound?.(form.row_sound)}
                  style={{ flexShrink:0 }}>
                  ▶ Test
                </button>
              )}
            </div>
            <div style={{ fontSize:'0.65rem', color:'var(--text-3)', marginTop:'0.25rem' }}>
              Plays when a new message arrives for any alias in this group. Can be overridden per alias.
            </div>
          </div>
        </div>

        {isPlatformAdmin && (
          <label style={{ display:'flex', alignItems:'center', gap:'0.4rem', fontSize:'0.78rem', color:'var(--text-2)',
            cursor:'pointer', marginBottom:'0.6rem' }}
            title="Visible as a shared default to every organization, not just your own">
            <input type="checkbox" checked={form.is_global} onChange={e => setForm(f => ({ ...f, is_global: e.target.checked }))} />
            Make this global (visible to every organization)
          </label>
        )}

        <button className="pm-btn pm-btn-primary" onClick={handleSave} disabled={!form.name}>
          <Save size={13} />
          {editing
            ? (form.is_global !== originalIsGlobal ? (form.is_global ? 'Update & make global' : 'Update & assign to my org') : 'Update group')
            : (form.is_global ? 'Create global group' : 'Create group')}
        </button>
      </div>

      <div style={{ fontSize:'0.72rem', color:'var(--text-3)', fontFamily:'monospace', marginBottom:'0.75rem',
        padding:'0.4rem 0.6rem', background:'var(--bg-2)', borderRadius:'0.35rem', border:'1px solid var(--border)' }}>
        CSV format (semicolon-separated): <span style={{ color:'var(--text-2)' }}>id;name;color;parent_name;row_color;row_sound</span> — id is exported for cross-referencing the aliases CSV's group_id column; it's ignored on import
      </div>

      {groups.length > 0 && (
        <div style={{ position:'relative', marginBottom:'0.75rem' }}>
          <Search size={13} style={{ position:'absolute', left:'0.6rem', top:'50%', transform:'translateY(-50%)', color:'var(--text-3)' }} />
          <input className="pm-input" placeholder="Search groups by name…"
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

      {/* Group list */}
      {loading
        ? <div style={{ color:'var(--text-3)', fontFamily:'monospace', fontSize:'0.82rem' }}>Loading…</div>
        : groups.length === 0
          ? <div style={{ color:'var(--text-3)', fontFamily:'monospace', fontSize:'0.82rem', padding:'1.5rem', textAlign:'center' }}>No groups yet.</div>
          : filteredTopLevel.length === 0
            ? <div style={{ color:'var(--text-3)', fontFamily:'monospace', fontSize:'0.82rem', padding:'1.5rem', textAlign:'center' }}>No groups match "{search}".</div>
            : filteredTopLevel.map(g => <GroupRow key={g.id} g={g} />)
      }

      {/* Recent group activity */}
      <div className="pm-card" style={{ marginTop:'1.5rem' }}>
        <ActivityFeed filter="group" limit={8} compact />
      </div>
    </div>
  );
}
