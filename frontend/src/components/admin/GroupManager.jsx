import { useState } from 'react';
import { Layers, Plus, Trash2, Pencil, X, Save } from 'lucide-react';
import ActivityFeed from './ActivityFeed.jsx';
import { adminFetchGroups, adminSaveGroup, adminDeleteGroup } from '../../utils/api.js';
import { useAdminFetch } from '../../hooks/useAdminFetch.js';

const EMPTY = { name:'', color:'#a855f7', parent_id:'', row_color:'', row_sound:'' };

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

export default function GroupManager({ onGroupsChange }) {
  const { data: raw, loading, reload } = useAdminFetch(adminFetchGroups, []);
  const groups = Array.isArray(raw) ? raw : [];

  const [form, setForm]       = useState({ ...EMPTY });
  const [editing, setEditing] = useState(null); // group id
  const [msg, setMsg]         = useState(null);

  const flash = (type, text) => { setMsg({ type, text }); setTimeout(() => setMsg(null), 3500); };

  const topLevel = groups.filter(g => !g.parent_id);
  const subOf    = (parentId) => groups.filter(g => g.parent_id === parentId);

  const startEdit = g => {
    setForm({ name: g.name, color: g.color||'#a855f7', parent_id: g.parent_id||'', row_color: g.row_color||'', row_sound: g.row_sound||'' });
    setEditing(g.id);
  };
  const cancelEdit = () => { setForm({ ...EMPTY }); setEditing(null); };

  const handleSave = async () => {
    if (!form.name.trim()) { flash('err', 'Name is required'); return; }
    try {
      const payload = { name: form.name, color: form.color, parent_id: form.parent_id ? parseInt(form.parent_id) : null, row_color: form.row_color || null, row_sound: form.row_sound || null };
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

  const GroupRow = ({ g, indent = 0 }) => (
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
        {g.aliases?.length > 0 && (
          <span style={{ fontSize:'0.68rem', color:'var(--text-3)', fontFamily:'monospace' }}>
            {g.aliases.length} alias{g.aliases.length!==1?'es':''}
          </span>
        )}
        <button onClick={() => startEdit(g)} style={{ background:'none', border:'none', cursor:'pointer', color:'var(--text-3)', padding:'0.2rem' }}>
          <Pencil size={13} />
        </button>
        <button onClick={() => handleDelete(g.id, g.name)} style={{ background:'none', border:'none', cursor:'pointer', color:'var(--accent-red)', padding:'0.2rem' }}>
          <Trash2 size={13} />
        </button>
      </div>
      {subOf(g.id).map(sub => <GroupRow key={sub.id} g={sub} indent={indent+1} />)}
    </>
  );

  return (
    <div style={{ maxWidth:'600px' }}>
      <h2 style={{ fontSize:'1rem', fontWeight:700, color:'var(--text-1)', marginBottom:'1rem', display:'flex', alignItems:'center', gap:'0.5rem' }}>
        <Layers size={16} style={{ color:'var(--accent-purple)' }} /> Groups
      </h2>
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

        <button className="pm-btn pm-btn-primary" onClick={handleSave} disabled={!form.name}>
          <Save size={13} /> {editing ? 'Update group' : 'Create group'}
        </button>
      </div>

      {/* Group list */}
      {loading
        ? <div style={{ color:'var(--text-3)', fontFamily:'monospace', fontSize:'0.82rem' }}>Loading…</div>
        : groups.length === 0
          ? <div style={{ color:'var(--text-3)', fontFamily:'monospace', fontSize:'0.82rem', padding:'1.5rem', textAlign:'center' }}>No groups yet.</div>
          : topLevel.map(g => <GroupRow key={g.id} g={g} />)
      }

      {/* Recent group activity */}
      <div className="pm-card" style={{ marginTop:'1.5rem' }}>
        <ActivityFeed filter="group" limit={8} compact />
      </div>
    </div>
  );
}
