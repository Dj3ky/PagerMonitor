import { useState, useRef } from 'react';
import { Tag, Trash2, Save, Pencil, X, Upload, Download } from 'lucide-react';
import ActivityFeed from './ActivityFeed.jsx';
import { adminFetchAliases, adminSaveAlias, adminDeleteAlias,
         adminFetchGroups, adminExportAliasesCsv, adminImportAliasesCsv } from '../../utils/api.js';
import { useAdminFetch } from '../../hooks/useAdminFetch.js';

const EMPTY = { capcode:'', name:'', color:'#00ff9d', notes:'', group_id:'', row_color:'', row_sound:'' };

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
  const { data: aliasesRaw, loading, reload } = useAdminFetch(adminFetchAliases, []);
  const { data: groupsRaw } = useAdminFetch(adminFetchGroups, []);

  const aliases = Array.isArray(aliasesRaw) ? aliasesRaw : [];
  const groups  = Array.isArray(groupsRaw)  ? groupsRaw  : [];

  const [form, setForm]       = useState({ ...EMPTY });
  const [editing, setEditing] = useState(null);
  const [saving, setSaving]   = useState(false);
  const [msg, setMsg]         = useState(null);
  const fileRef               = useRef();

  const flash = (type, text) => { setMsg({ type, text }); setTimeout(() => setMsg(null), 3500); };

  const handleSave = async () => {
    if (!form.capcode.trim() || !form.name.trim()) { flash('err', 'Capcode and name are required'); return; }
    setSaving(true);
    try {
      await adminSaveAlias(form.capcode.trim(), {
        name: form.name, color: form.color, notes: form.notes,
        group_id: form.group_id ? parseInt(form.group_id) : null,
        row_color: form.row_color || null, row_sound: form.row_sound || null,
      });
      flash('ok', editing ? `Updated ${form.capcode}` : `Added ${form.capcode}`);
      setForm({ ...EMPTY }); setEditing(null); reload();
    } catch (e) { flash('err', e.message); }
    finally { setSaving(false); }
  };

  const startEdit = a => {
    setForm({ capcode:a.capcode, name:a.name||'', color:a.color||'#00ff9d', notes:a.notes||'', group_id: a.group_id||'', row_color: a.row_color||'', row_sound: a.row_sound||'' });
    setEditing(a.capcode);
  };
  const cancelEdit = () => { setForm({ ...EMPTY }); setEditing(null); };

  const handleDelete = async capcode => {
    if (!confirm(`Delete alias for ${capcode}?`)) return;
    try { await adminDeleteAlias(capcode); flash('ok', `Deleted ${capcode}`); reload(); }
    catch (e) { flash('err', e.message); }
  };

  const handleExport = () => adminExportAliasesCsv().catch(e => flash('err', e.message));

  const handleImport = async e => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const r = await adminImportAliasesCsv(text);
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
        <div style={{ display:'flex', gap:'0.5rem' }}>
          <button className="pm-btn" onClick={handleExport} style={{ fontSize:'0.75rem' }}><Download size={12} /> Export CSV</button>
          <button className="pm-btn" onClick={() => fileRef.current?.click()} style={{ fontSize:'0.75rem' }}><Upload size={12} /> Import CSV</button>
          <input ref={fileRef} type="file" accept=".csv,text/csv" style={{ display:'none' }} onChange={handleImport} />
        </div>
      </div>

      <Flash msg={msg} />

      {/* Form */}
      <div className="pm-card" style={{ marginBottom:'1rem', borderColor: editing ? 'color-mix(in srgb, var(--accent-amber) 30%, transparent)' : 'var(--border)' }}>
        <div className="pm-section-title" style={{ color: editing?'var(--accent-amber)':'var(--text-2)',
          display:'flex', alignItems:'center', justifyContent:'space-between' }}>
          {editing ? `Editing ${editing}` : 'Add alias'}
          {editing && <button onClick={cancelEdit} style={{ background:'none', border:'none', cursor:'pointer', color:'var(--text-3)' }}><X size={14}/></button>}
        </div>

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
            <select className="pm-input" value={form.group_id||''} onChange={e => setForm(f=>({...f,group_id:e.target.value}))}>
              <option value="">— No group —</option>
              {groups.map(g => (
                <option key={g.id} value={g.id}>{g.parent_id ? '  ↳ ' : ''}{g.name}</option>
              ))}
            </select>
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

        <button className="pm-btn pm-btn-primary" onClick={handleSave} disabled={!form.capcode||!form.name||saving}>
          <Save size={13} /> {saving ? 'Saving…' : editing ? 'Update' : 'Add alias'}
        </button>
      </div>

      <div style={{ fontSize:'0.72rem', color:'var(--text-3)', fontFamily:'monospace', marginBottom:'0.75rem',
        padding:'0.4rem 0.6rem', background:'var(--bg-2)', borderRadius:'0.35rem', border:'1px solid var(--border)' }}>
        CSV format: <span style={{ color:'var(--text-2)' }}>capcode,name,color,notes,group_id</span>
      </div>

      {loading
        ? <div style={{ color:'var(--text-3)', fontFamily:'monospace', fontSize:'0.82rem' }}>Loading…</div>
        : aliases.length === 0
          ? <div style={{ color:'var(--text-3)', fontFamily:'monospace', fontSize:'0.82rem', padding:'2rem', textAlign:'center' }}>No aliases yet.</div>
          : (
            <div style={{ display:'grid', gap:'0.3rem' }}>
              {aliases.map(a => (
                <div key={a.capcode} style={{
                  display:'flex', alignItems:'center', gap:'0.6rem',
                  background: editing===a.capcode ? 'color-mix(in srgb, var(--accent-amber) 8%, var(--bg-2))' : 'var(--bg-2)',
                  border:`1px solid ${editing===a.capcode ? 'color-mix(in srgb, var(--accent-amber) 30%, transparent)' : 'var(--border)'}`,
                  borderRadius:'0.5rem', padding:'0.45rem 0.75rem',
                }}>
                  <span style={{ fontFamily:'monospace', fontSize:'0.78rem', color:'var(--accent-amber)', minWidth:'75px' }}>{a.capcode}</span>
                  <span style={{ fontSize:'0.85rem', fontWeight:600, color:a.color||'var(--accent-green)', flex:1 }}>{a.name}</span>
                  {a.group_name && (
                    <span style={{ fontSize:'0.68rem', color:a.group_color||'var(--text-3)',
                      background:(a.group_color||'#888')+'22', padding:'0.1rem 0.4rem', borderRadius:'0.75rem', flexShrink:0 }}>
                      {a.group_name}
                    </span>
                  )}
                  {a.notes && <span style={{ fontSize:'0.72rem', color:'var(--text-3)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', maxWidth:'120px' }}>{a.notes}</span>}
                  <div style={{ display:'flex', gap:'0.3rem', flexShrink:0 }}>
                    <button onClick={() => startEdit(a)} style={{ background:'none', border:'none', cursor:'pointer', color:'var(--text-3)', padding:'0.2rem' }}><Pencil size={13}/></button>
                    <button onClick={() => handleDelete(a.capcode)} style={{ background:'none', border:'none', cursor:'pointer', color:'var(--accent-red)', padding:'0.2rem' }}><Trash2 size={13}/></button>
                  </div>
                </div>
              ))}
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
