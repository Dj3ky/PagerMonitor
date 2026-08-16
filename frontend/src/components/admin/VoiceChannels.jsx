import { useState, useEffect } from 'react';
import { Radio, Trash2, Plus, Save, Headphones, Cpu, Clock } from 'lucide-react';

const BASE = import.meta.env.VITE_BACKEND_URL || '';
const tok  = () => localStorage.getItem('pm_token') || '';
const api  = (m,p,b) => fetch(`${BASE}${p}`,{method:m,headers:{'Content-Type':'application/json','Authorization':`Bearer ${tok()}`},body:b?JSON.stringify(b):undefined})
  .then(async r => { const d = await r.json().catch(()=>({})); if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`); return d; });

const MODES = ['nfm','am'];
const EMPTY = { description:'', freq:'', mode:'nfm', squelch:'', tau:'', sort_order:0 };

function Flash({msg}){ if(!msg)return null; const ok=msg.type==='ok'; return <div style={{padding:'0.4rem 0.75rem',borderRadius:'0.4rem',fontSize:'0.78rem',fontFamily:'monospace',marginBottom:'0.75rem',color:ok?'var(--accent-green)':'var(--accent-red)',background:`color-mix(in srgb,${ok?'var(--accent-green)':'var(--accent-red)'} 10%,transparent)`,border:`1px solid color-mix(in srgb,${ok?'var(--accent-green)':'var(--accent-red)'} 30%,transparent)`}}>{msg.text}</div>; }

// Relative "last heard" label — mirrors SdrClients.jsx's fmtSilent for consistency.
function fmtAgo(ms) {
  const sec = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (sec < 60)         return `${sec}s ago`;
  if (sec < 3600)       return `${Math.floor(sec/60)}m ago`;
  if (sec < 86400)      return `${Math.floor(sec/3600)}h ago`;
  return `${Math.floor(sec/86400)}d ago`;
}

export default function VoiceChannels() {
  const [channels, setChannels] = useState([]);
  const [listeners, setListeners] = useState({}); // { channelId: count }
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [msg, setMsg] = useState(null);

  const flash = (type,text) => { setMsg({type,text}); setTimeout(()=>setMsg(null),3500); };
  const load  = () => api('GET','/admin/voice-channels').then(d=>setChannels(Array.isArray(d)?d:[]));
  const loadListeners = () => api('GET','/admin/voice-channels/listeners').then(d=>setListeners(d && typeof d === 'object' ? d : {})).catch(()=>{});
  useEffect(()=>{
    load();
    loadListeners();
    const t = setInterval(loadListeners, 5000);
    return () => clearInterval(t);
  },[]);

  const edit = (c) => { setEditing(c.id); setForm({...c}); };
  const cancel = () => { setEditing(null); setForm(EMPTY); };

  const save = async () => {
    if (!form.description) { flash('err', 'Description is required'); return; }
    if (!form.freq)        { flash('err', 'Frequency is required'); return; }
    try {
      await api('PUT','/admin/voice-channels', form);
      await load(); cancel(); flash('ok','Saved');
    } catch(e){ flash('err',e.message); }
  };

  const del = async (id) => {
    if (!confirm('Delete this channel?')) return;
    try {
      await api('DELETE',`/admin/voice-channels/${id}`);
      await load(); flash('ok','Deleted');
    } catch(e){ flash('err',e.message); }
  };

  return (
    <div style={{maxWidth:'560px'}}>
      <h2 style={{fontSize:'1rem',fontWeight:700,color:'var(--text-1)',marginBottom:'0.5rem',display:'flex',alignItems:'center',gap:'0.5rem'}}>
        <Radio size={16} style={{color:'var(--accent-blue)'}}/> Voice Channels
      </h2>
      <p style={{fontSize:'0.82rem',color:'var(--text-3)',marginBottom:'1rem',lineHeight:1.6}}>
        Catalog of listenable voice channels (e.g. firefighter dispatch frequencies) — separate from the POCSAG
        decode frequency. Assign channels to a dongle in SDR Control → Multiple SDR dongles to stream them live.
        Shared instance-wide across every organization on this server — an org admin can hide individual
        channels from their own users under Channel Visibility, but can't edit the catalog itself.
      </p>
      <Flash msg={msg}/>

      {/* Existing channels */}
      {channels.map(c=>(
        <div key={c.id} className="pm-card" style={{marginBottom:'0.5rem',display:'flex',alignItems:'center',gap:'0.75rem',flexWrap:'wrap'}}>
          <div style={{flex:1,minWidth:0}}>
            <div style={{fontWeight:600,color:'var(--text-1)',fontSize:'0.85rem'}}>{c.description}</div>
            <div style={{fontFamily:'monospace',fontSize:'0.75rem',color:'var(--text-3)'}}>
              <span style={{color:'var(--accent-amber)'}}>{c.freq}</span>
              {' · '}<span style={{color:'var(--accent-blue)'}}>{c.mode}</span>
              {c.squelch ? <>{' · squelch '}{c.squelch}</> : null}
              {c.tau ? <>{' · tau '}{c.tau}µs</> : null}
            </div>
            <div style={{display:'flex',alignItems:'center',gap:'0.75rem',flexWrap:'wrap',marginTop:'0.2rem',fontSize:'0.72rem',color:'var(--text-3)'}}>
              <span style={{display:'flex',alignItems:'center',gap:'0.25rem'}} title="Dongle/client this channel is assigned to">
                <Cpu size={11}/> {listeners[c.id]?.owner?.label || 'unassigned'}
              </span>
              <span style={{display:'flex',alignItems:'center',gap:'0.25rem'}}
                title={listeners[c.id]?.lastHeardAt ? new Date(listeners[c.id].lastHeardAt).toLocaleString() : 'No confirmed transmission since server start'}>
                <Clock size={11}/> {listeners[c.id]?.lastHeardAt ? fmtAgo(listeners[c.id].lastHeardAt) : 'never heard'}
              </span>
            </div>
          </div>
          {!!listeners[c.id]?.count && (
            <span title={`Listening: ${listeners[c.id].usernames.join(', ')}`}
              style={{display:'flex',alignItems:'center',gap:'0.3rem',
              fontSize:'0.75rem',fontWeight:600,color:'var(--accent-green)',
              background:'color-mix(in srgb,var(--accent-green) 10%,transparent)',
              border:'1px solid color-mix(in srgb,var(--accent-green) 30%,transparent)',
              borderRadius:'1rem',padding:'0.2rem 0.6rem'}}>
              <Headphones size={12}/> {listeners[c.id].count}
            </span>
          )}
          <div style={{display:'flex',gap:'0.4rem',alignItems:'center'}}>
            <button className="pm-btn" onClick={()=>edit(c)}><Save size={12}/> Edit</button>
            <button className="pm-btn pm-btn-danger" onClick={()=>del(c.id)}><Trash2 size={12}/></button>
          </div>
        </div>
      ))}

      {/* Add / Edit form */}
      <div className="pm-card" style={{marginTop:'1rem'}}>
        <div className="pm-section-title"><Plus size={13}/> {editing?'Edit channel':'New channel'}</div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'0.5rem',marginBottom:'0.75rem'}}>
          <div>
            <label className="pm-label">Description</label>
            <input className="pm-input" value={form.description} onChange={e=>setForm(f=>({...f,description:e.target.value}))} placeholder="e.g. Fire dispatch"/>
          </div>
          <div>
            <label className="pm-label">Mode</label>
            <select className="pm-input" value={form.mode} onChange={e=>setForm(f=>({...f,mode:e.target.value}))}>
              {MODES.map(m=><option key={m} value={m}>{m}</option>)}
            </select>
          </div>
        </div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'0.5rem',marginBottom:'0.75rem'}}>
          <div>
            <label className="pm-label">Frequency</label>
            <input className="pm-input" value={form.freq} onChange={e=>setForm(f=>({...f,freq:e.target.value}))} placeholder="e.g. 173.4875M"/>
          </div>
          <div>
            <label className="pm-label">Squelch</label>
            <input className="pm-input" value={form.squelch} onChange={e=>setForm(f=>({...f,squelch:e.target.value}))} placeholder="leave empty for auto"/>
          </div>
        </div>
        <div style={{marginBottom:'0.75rem'}}>
          <label className="pm-label">De-emphasis (tau, µs)</label>
          <input className="pm-input" value={form.tau} onChange={e=>setForm(f=>({...f,tau:e.target.value}))} placeholder="leave empty for rtl_airband's default (200)"/>
          <div style={{fontSize:'0.68rem',color:'var(--text-3)',marginTop:'0.2rem'}}>
            Higher = cuts more high-frequency hiss (voice sounds a bit more muffled). Lower = crisper but noisier.
          </div>
        </div>
        <div style={{display:'flex',gap:'0.5rem'}}>
          <button className="pm-btn pm-btn-primary" onClick={save} disabled={!form.description||!form.freq}><Save size={13}/> Save</button>
          {editing && <button className="pm-btn" onClick={cancel}>Cancel</button>}
        </div>
      </div>
    </div>
  );
}
