import { useState, useEffect } from 'react';
import { Link, Trash2, Plus, Save, Play } from 'lucide-react';

const BASE = import.meta.env.VITE_BACKEND_URL || '';
const tok  = () => localStorage.getItem('pm_token') || '';
const api  = (m,p,b) => fetch(`${BASE}${p}`,{method:m,headers:{'Content-Type':'application/json','Authorization':`Bearer ${tok()}`},body:b?JSON.stringify(b):undefined}).then(r=>r.json());
const EMPTY = { name:'', url:'', enabled:1, secret:'' };

function Flash({msg}){ if(!msg)return null; const ok=msg.type==='ok'; return <div style={{padding:'0.4rem 0.75rem',borderRadius:'0.4rem',fontSize:'0.78rem',fontFamily:'monospace',marginBottom:'0.75rem',color:ok?'var(--accent-green)':'var(--accent-red)',background:`color-mix(in srgb,${ok?'var(--accent-green)':'var(--accent-red)'} 10%,transparent)`,border:`1px solid color-mix(in srgb,${ok?'var(--accent-green)':'var(--accent-red)'} 30%,transparent)`}}>{msg.text}</div>; }

export default function Webhooks() {
  const [hooks, setHooks] = useState([]);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [msg, setMsg] = useState(null);
  const [testing, setTesting] = useState(null);

  const flash = (type,text) => { setMsg({type,text}); setTimeout(()=>setMsg(null),3500); };
  const load  = () => api('GET','/admin/webhooks').then(d=>setHooks(Array.isArray(d)?d:[]));
  useEffect(()=>{ load(); },[]);

  const edit   = (h) => { setEditing(h.id); setForm({...h, secret: h.secret||''}); };
  const cancel = () => { setEditing(null); setForm(EMPTY); };
  const save   = async () => {
    try { await api('PUT','/admin/webhooks',form); await load(); cancel(); flash('ok','Saved'); }
    catch(e){ flash('err',e.message); }
  };
  const del  = async (id) => { if(!confirm('Delete webhook?'))return; await api('DELETE',`/admin/webhooks/${id}`); await load(); };
  const test = async (id) => {
    setTesting(id);
    try { const r = await api('POST',`/admin/webhooks/${id}/test`); flash(r.ok?'ok':'err', r.ok?'Test sent!':r.error); }
    catch(e){ flash('err',e.message); }
    finally { setTesting(null); }
  };

  return (
    <div style={{maxWidth:'560px'}}>
      <h2 style={{fontSize:'1rem',fontWeight:700,color:'var(--text-1)',marginBottom:'0.5rem',display:'flex',alignItems:'center',gap:'0.5rem'}}>
        <Link size={16} style={{color:'var(--accent-blue)'}}/> Webhooks
      </h2>
      <p style={{fontSize:'0.82rem',color:'var(--text-3)',marginBottom:'1rem',lineHeight:1.6}}>
        POST decoded messages as JSON to external URLs. Optional HMAC-SHA256 signature via secret key.
      </p>
      <Flash msg={msg}/>

      {hooks.map(h=>(
        <div key={h.id} className="pm-card" style={{marginBottom:'0.5rem',display:'flex',alignItems:'center',gap:'0.75rem',flexWrap:'wrap'}}>
          <div style={{flex:1,minWidth:0}}>
            <div style={{fontWeight:600,color:'var(--text-1)',fontSize:'0.85rem'}}>{h.name}</div>
            <div style={{fontFamily:'monospace',fontSize:'0.72rem',color:'var(--text-3)',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{h.url}</div>
          </div>
          <div style={{display:'flex',gap:'0.4rem',alignItems:'center'}}>
            <span style={{fontSize:'0.7rem',padding:'0.1rem 0.4rem',borderRadius:'0.3rem',
              background:h.enabled?'color-mix(in srgb,var(--accent-green) 15%,transparent)':'var(--bg-3)',
              color:h.enabled?'var(--accent-green)':'var(--text-3)'}}>{h.enabled?'ON':'OFF'}</span>
            <button className="pm-btn" onClick={()=>test(h.id)} disabled={testing===h.id}><Play size={12}/> Test</button>
            <button className="pm-btn" onClick={()=>edit(h)}><Save size={12}/> Edit</button>
            <button className="pm-btn pm-btn-danger" onClick={()=>del(h.id)}><Trash2 size={12}/></button>
          </div>
        </div>
      ))}

      <div className="pm-card" style={{marginTop:'1rem'}}>
        <div className="pm-section-title"><Plus size={13}/> {editing?'Edit webhook':'New webhook'}</div>
        <div style={{marginBottom:'0.75rem'}}>
          <label className="pm-label">Name</label>
          <input className="pm-input" value={form.name} onChange={e=>setForm(f=>({...f,name:e.target.value}))} placeholder="Home Assistant"/>
        </div>
        <div style={{marginBottom:'0.75rem'}}>
          <label className="pm-label">URL</label>
          <input className="pm-input" value={form.url} onChange={e=>setForm(f=>({...f,url:e.target.value}))} placeholder="https://..."/>
        </div>
        <div style={{marginBottom:'0.75rem'}}>
          <label className="pm-label">Secret (optional — for HMAC signature)</label>
          <input className="pm-input" value={form.secret} onChange={e=>setForm(f=>({...f,secret:e.target.value}))} placeholder="Leave empty to disable signing"/>
        </div>
        <div style={{display:'flex',gap:'0.5rem',alignItems:'center',marginBottom:'0.75rem'}}>
          <label style={{display:'flex',alignItems:'center',gap:'0.4rem',fontSize:'0.8rem',cursor:'pointer'}}>
            <input type="checkbox" checked={!!form.enabled} onChange={e=>setForm(f=>({...f,enabled:e.target.checked?1:0}))}/> Enabled
          </label>
        </div>
        <div style={{display:'flex',gap:'0.5rem'}}>
          <button className="pm-btn pm-btn-primary" onClick={save} disabled={!form.name||!form.url}><Save size={13}/> Save</button>
          {editing && <button className="pm-btn" onClick={cancel}>Cancel</button>}
        </div>
      </div>

      <div className="pm-card" style={{marginTop:'1rem',fontSize:'0.78rem',color:'var(--text-3)',lineHeight:1.7}}>
        <div className="pm-section-title">Payload format</div>
        <pre style={{background:'var(--bg-0)',padding:'0.75rem',borderRadius:'0.4rem',fontSize:'0.72rem',overflowX:'auto',margin:0}}>{`POST https://your-url
Content-Type: application/json
X-PagerMonitor-Signature: sha256=<hmac>

{
  "type": "message",
  "id": 1234,
  "timestamp": "2026-05-19T12:00:00.000Z",
  "capcode": "1234567",
  "alias_name": "Fire station",
  "protocol": "POCSAG1200",
  "message": "Požar Dunajska 5"
}`}</pre>
      </div>
    </div>
  );
}
