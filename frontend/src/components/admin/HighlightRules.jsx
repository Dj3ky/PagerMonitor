import { useState } from 'react';
import { Highlighter, Trash2, Save, TestTube } from 'lucide-react';
import { adminFetchRules, adminSaveRule, adminDeleteRule } from '../../utils/api.js';
import { useAdminFetch } from '../../hooks/useAdminFetch.js';

const EMPTY = { name:'', pattern:'', is_regex:0, color:'#ffb800', bg:'', enabled:1, sort_order:0 };

function Flash({ msg }) {
  if (!msg) return null;
  const ok = msg.type === 'ok';
  return (
    <div style={{ padding:'0.4rem 0.75rem', borderRadius:'0.4rem', fontSize:'0.78rem', fontFamily:'monospace', marginBottom:'0.75rem',
      color: ok ? 'var(--accent-green)' : 'var(--accent-red)',
      background: `color-mix(in srgb, ${ok ? 'var(--accent-green)' : 'var(--accent-red)'} 10%, transparent)`,
      border: `1px solid color-mix(in srgb, ${ok ? 'var(--accent-green)' : 'var(--accent-red)'} 30%, transparent)`,
    }}>{msg.text}</div>
  );
}

export default function HighlightRules({ onRulesChange }) {
  const { data: rulesRaw, loading, reload } = useAdminFetch(adminFetchRules, []);
  const rules = Array.isArray(rulesRaw) ? rulesRaw : [];

  const [form, setForm]       = useState({ ...EMPTY });
  const [editing, setEditing] = useState(null);
  const [msg, setMsg]         = useState(null);
  const [testText, setTestText] = useState('');

  const flash = (type, text) => { setMsg({ type, text }); setTimeout(() => setMsg(null), 3500); };

  const doReload = async () => { await reload(); onRulesChange?.(rules); };

  const startEdit = rule => { setForm({ ...EMPTY, ...rule }); setEditing(rule.id); };
  const cancelEdit = () => { setForm({ ...EMPTY }); setEditing(null); };

  const handleSave = async () => {
    if (!form.pattern) { flash('err', 'Pattern is required'); return; }
    if (form.is_regex) {
      try { new RegExp(form.pattern); } catch { flash('err', 'Invalid regular expression'); return; }
    }
    try {
      const payload = { ...form, id: editing || undefined };
      await adminSaveRule(payload);
      flash('ok', editing ? 'Rule updated' : 'Rule added');
      setForm({ ...EMPTY }); setEditing(null);
      const updated = await adminFetchRules().catch(() => rules);
      const safe = Array.isArray(updated) ? updated : rules;
      onRulesChange?.(safe);
      await reload();
    } catch (e) { flash('err', e.message); }
  };

  const handleDelete = async (id, name) => {
    if (!confirm(`Delete rule "${name}"?`)) return;
    try { await adminDeleteRule(id); flash('ok', `Deleted "${name}"`); await reload(); onRulesChange?.([]); }
    catch (e) { flash('err', e.message); }
  };

  const testMatch = (rule, text) => {
    if (!text || !rule?.pattern) return false;
    try {
      return rule.is_regex
        ? new RegExp(rule.pattern, 'i').test(text)
        : text.toLowerCase().includes(rule.pattern.toLowerCase());
    } catch { return false; }
  };

  return (
    <div style={{ maxWidth:'700px' }}>
      <h2 style={{ fontSize:'1rem', fontWeight:700, color:'var(--text-1)', marginBottom:'0.5rem', display:'flex', alignItems:'center', gap:'0.5rem' }}>
        <Highlighter size={16} style={{ color:'var(--accent-purple)' }} /> Highlight & Filter Rules
      </h2>
      <p style={{ fontSize:'0.82rem', color:'var(--text-3)', marginBottom:'1rem' }}>
        Match message text and colour matching rows in the live feed. First match wins.
      </p>

      <Flash msg={msg} />

      {/* Form */}
      <div className="pm-card" style={{ marginBottom:'1rem', borderColor: editing ? 'color-mix(in srgb, var(--accent-purple) 30%, transparent)' : 'var(--border)' }}>
        <div className="pm-section-title" style={{ color: editing ? 'var(--accent-purple)' : 'var(--text-2)' }}>
          {editing ? 'Edit rule' : 'New rule'}
        </div>
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'0.6rem', marginBottom:'0.6rem' }}>
          <div>
            <label className="pm-label">Rule name</label>
            <input className="pm-input" placeholder="e.g. Fire Alarm" value={form.name || ''}
              onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
          </div>
          <div>
            <label className="pm-label">Pattern</label>
            <input className="pm-input" placeholder={form.is_regex ? 'regex e.g. požar|alarm' : 'text e.g. požar'} value={form.pattern || ''}
              onChange={e => setForm(f => ({ ...f, pattern: e.target.value }))} />
          </div>
          <div>
            <label className="pm-label">Text colour / Background</label>
            <div style={{ display:'flex', gap:'0.5rem', alignItems:'center' }}>
              <input type="color" value={form.color || '#ffb800'} onChange={e => setForm(f => ({ ...f, color: e.target.value }))}
                style={{ width:'36px', height:'36px', borderRadius:'0.4rem', border:'1px solid var(--border)', padding:'2px', cursor:'pointer', background:'var(--bg-3)' }} />
              <input type="color" value={form.bg || '#000000'} onChange={e => setForm(f => ({ ...f, bg: e.target.value === '#000000' ? '' : e.target.value }))}
                style={{ width:'36px', height:'36px', borderRadius:'0.4rem', border:'1px solid var(--border)', padding:'2px', cursor:'pointer', background:'var(--bg-3)' }}
                title="Background (black = none)" />
            </div>
          </div>
          <div style={{ display:'flex', flexDirection:'column', gap:'0.4rem', justifyContent:'center' }}>
            <label style={{ display:'flex', alignItems:'center', gap:'0.5rem', cursor:'pointer', fontSize:'0.82rem', color:'var(--text-2)' }}>
              <input type="checkbox" checked={!!form.is_regex} onChange={e => setForm(f => ({ ...f, is_regex: e.target.checked ? 1 : 0 }))} />
              Use regex
            </label>
            <label style={{ display:'flex', alignItems:'center', gap:'0.5rem', cursor:'pointer', fontSize:'0.82rem', color:'var(--text-2)' }}>
              <input type="checkbox" checked={!!form.enabled} onChange={e => setForm(f => ({ ...f, enabled: e.target.checked ? 1 : 0 }))} />
              Enabled
            </label>
          </div>
        </div>
        {form.pattern && (
          <div style={{ marginBottom:'0.6rem', padding:'0.5rem 0.75rem', borderRadius:'0.35rem',
            background:'var(--bg-3)', border:'1px solid var(--border)',
            fontFamily:'monospace', fontSize:'0.82rem', color:'var(--text-1)' }}>
            <span>Preview: Sample message with </span>
            <mark style={{
              background: form.bg || (form.color ? form.color + '35' : '#ffb80035'),
              color: form.color || '#ffb800',
              borderRadius: '0.25rem', padding: '0.1rem 0.35rem', fontWeight:700,
            }}>{form.pattern}</mark>
            <span> in it</span>
          </div>
        )}
        <div style={{ display:'flex', gap:'0.5rem' }}>
          <button className="pm-btn pm-btn-primary" onClick={handleSave} disabled={!form.pattern}>
            <Save size={13} /> {editing ? 'Update' : 'Add rule'}
          </button>
          {editing && <button className="pm-btn" onClick={cancelEdit}>Cancel</button>}
        </div>
      </div>

      {/* Test area */}
      <div className="pm-card" style={{ marginBottom:'1rem' }}>
        <div className="pm-section-title"><TestTube size={13} /> Test rules</div>
        <input className="pm-input" placeholder="Paste a message to test all rules…" value={testText}
          onChange={e => setTestText(e.target.value)} />
        {testText && rules.filter(r => r.enabled).map(r => (
          <div key={r.id} style={{ display:'flex', alignItems:'center', gap:'0.5rem', marginTop:'0.4rem', fontSize:'0.78rem', fontFamily:'monospace' }}>
            <span style={{ width:'8px', height:'8px', borderRadius:'50%', flexShrink:0,
              background: testMatch(r, testText) ? 'var(--accent-green)' : 'var(--text-3)' }} />
            <span style={{ color: testMatch(r, testText) ? (r.color || 'var(--accent-green)') : 'var(--text-3)', flex:1 }}>{r.name || r.pattern}</span>
            <span style={{ color:'var(--text-3)', fontSize:'0.68rem' }}>{r.is_regex ? 'regex' : 'text'}</span>
          </div>
        ))}
      </div>

      {/* Rules list */}
      {loading
        ? <div style={{ color:'var(--text-3)', fontFamily:'monospace', fontSize:'0.82rem' }}>Loading…</div>
        : rules.length === 0
          ? <div style={{ color:'var(--text-3)', fontFamily:'monospace', fontSize:'0.82rem', padding:'1.5rem', textAlign:'center' }}>No rules yet.</div>
          : (
            <div style={{ display:'grid', gap:'0.3rem' }}>
              {rules.map((r, i) => (
                <div key={r.id} style={{
                  display:'flex', alignItems:'center', gap:'0.6rem',
                  background: editing === r.id ? 'color-mix(in srgb, var(--accent-purple) 8%, var(--bg-2))' : 'var(--bg-2)',
                  border: `1px solid ${editing === r.id ? 'color-mix(in srgb, var(--accent-purple) 30%, transparent)' : 'var(--border)'}`,
                  borderRadius:'0.5rem', padding:'0.5rem 0.75rem', opacity: r.enabled ? 1 : 0.5,
                }}>
                  <span style={{ fontSize:'0.68rem', color:'var(--text-3)', minWidth:'16px', textAlign:'right' }}>{i+1}</span>
                  <div style={{ display:'flex', alignItems:'center', gap:'0.25rem', flexShrink:0 }}>
                    <div style={{ width:'10px', height:'10px', borderRadius:'50%', background: r.color||'#ffb800' }} title="Text color"/>
                    {r.bg && <div style={{ width:'10px', height:'10px', borderRadius:'2px', background: r.bg, border:'1px solid var(--border)' }} title="BG color"/>}
                  </div>
                  <span style={{ flex:1, fontSize:'0.82rem', color:'var(--text-1)' }}>{r.name || '(unnamed)'}</span>
                  <mark style={{ fontFamily:'monospace', fontSize:'0.73rem',
                    color: r.color || '#ffb800',
                    background: r.bg || (r.color || '#ffb800') + '30',
                    padding:'0.1rem 0.4rem', borderRadius:'0.3rem',
                    maxWidth:'180px', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                    {r.is_regex ? '/' : ''}{r.pattern}{r.is_regex ? '/i' : ''}
                  </mark>
                  <button onClick={() => startEdit(r)} style={{ background:'none', border:'none', cursor:'pointer', color:'var(--text-3)', padding:'0.2rem' }}>✏</button>
                  <button onClick={() => handleDelete(r.id, r.name || r.pattern)} style={{ background:'none', border:'none', cursor:'pointer', color:'var(--accent-red)', padding:'0.2rem' }}>
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
            </div>
          )
      }
    </div>
  );
}
