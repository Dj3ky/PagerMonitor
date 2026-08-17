import { useState, useEffect } from 'react';
import { Bot, Trash2, Plus, Save } from 'lucide-react';

const BASE = import.meta.env.VITE_BACKEND_URL || '';
const tok  = () => localStorage.getItem('pm_token') || '';
const api  = (m,p,b) => fetch(`${BASE}${p}`,{method:m,headers:{'Content-Type':'application/json','Authorization':`Bearer ${tok()}`},body:b?JSON.stringify(b):undefined}).then(r=>r.json());

const EMPTY = { description:'', channel_ids:[], bot_token:'', guild_id:'', discord_channel_id:'', enabled:true };

function Flash({msg}){ if(!msg)return null; const ok=msg.type==='ok'; return <div style={{padding:'0.4rem 0.75rem',borderRadius:'0.4rem',fontSize:'0.78rem',fontFamily:'monospace',marginBottom:'0.75rem',color:ok?'var(--accent-green)':'var(--accent-red)',background:`color-mix(in srgb,${ok?'var(--accent-green)':'var(--accent-red)'} 10%,transparent)`,border:`1px solid color-mix(in srgb,${ok?'var(--accent-green)':'var(--accent-red)'} 30%,transparent)`}}>{msg.text}</div>; }

export default function DiscordRelay() {
  const [relays, setRelays]   = useState([]);
  const [channels, setChannels] = useState([]);
  const [editing, setEditing] = useState(null);
  const [form, setForm]       = useState(EMPTY);
  const [msg, setMsg]         = useState(null);

  const flash = (type,text) => { setMsg({type,text}); setTimeout(()=>setMsg(null),3500); };
  const load  = () => Promise.all([
    api('GET','/admin/discord-relays'),
    api('GET','/admin/voice-channels'),
  ]).then(([r,ch]) => { setRelays(Array.isArray(r)?r:[]); setChannels(Array.isArray(ch)?ch:[]); });
  useEffect(()=>{ load(); },[]);

  const edit = (r) => { setEditing(r.id); setForm({...r, enabled: !!r.enabled, channel_ids: Array.isArray(r.channel_ids) ? r.channel_ids : (r.voice_channel_id ? [r.voice_channel_id] : [])}); };
  const cancel = () => { setEditing(null); setForm(EMPTY); };

  const save = async () => {
    if (!form.channel_ids?.length) { flash('err', 'Pick at least one voice channel'); return; }
    if (!form.bot_token || !form.guild_id || !form.discord_channel_id) { flash('err', 'Bot token, guild ID, and Discord channel ID are all required'); return; }
    try {
      await api('PUT','/admin/discord-relays', form);
      await load(); cancel(); flash('ok','Saved — reconnecting relay bot(s)');
    } catch(e){ flash('err',e.message); }
  };

  const del = async (id) => {
    if (!confirm('Delete this relay?')) return;
    await api('DELETE',`/admin/discord-relays/${id}`);
    await load(); flash('ok','Deleted');
  };

  const channelName = (id) => channels.find(c => c.id === id)?.description || `#${id}`;
  const channelNames = (ids) => (Array.isArray(ids) ? ids : []).map(channelName).join(', ');

  return (
    <div style={{maxWidth:'560px'}}>
      <h2 style={{fontSize:'1rem',fontWeight:700,color:'var(--text-1)',marginBottom:'0.5rem',display:'flex',alignItems:'center',gap:'0.5rem'}}>
        <Bot size={16} style={{color:'var(--accent-blue)'}}/> Discord Relay
      </h2>
      <p style={{fontSize:'0.82rem',color:'var(--text-3)',marginBottom:'1rem',lineHeight:1.6}}>
        Stream a voice channel live into a Discord voice channel via a bot. One bot token can join
        multiple <em>different</em> Discord servers at once, but within the <em>same</em> server a bot
        can only be in one voice channel at a time — use separate bot tokens if you need more than
        one channel relayed into the same server simultaneously.
      </p>
      <Flash msg={msg}/>

      {relays.map(r=>(
        <div key={r.id} className="pm-card" style={{marginBottom:'0.5rem',display:'flex',alignItems:'center',gap:'0.75rem',flexWrap:'wrap'}}>
          <div style={{flex:1,minWidth:0}}>
            <div style={{fontWeight:600,color:'var(--text-1)',fontSize:'0.85rem',display:'flex',alignItems:'center',gap:'0.4rem'}}>
              {r.description || `Relay #${r.id}`}
              {!r.enabled && (
                <span style={{fontSize:'0.65rem',fontWeight:600,color:'var(--text-3)',
                  background:'var(--bg-3)',border:'1px solid var(--border)',borderRadius:'1rem',padding:'0.1rem 0.5rem'}}>disabled</span>
              )}
            </div>
            <div style={{fontFamily:'monospace',fontSize:'0.75rem',color:'var(--text-3)'}}>
              <span style={{color:'var(--accent-amber)'}}>{channelNames(r.channel_ids)}</span>
              {' -> guild '}{r.guild_id}{' / channel '}{r.discord_channel_id}
            </div>
          </div>
          <div style={{display:'flex',gap:'0.4rem',alignItems:'center'}}>
            <button className="pm-btn" onClick={()=>edit(r)}><Save size={12}/> Edit</button>
            <button className="pm-btn pm-btn-danger" onClick={()=>del(r.id)}><Trash2 size={12}/></button>
          </div>
        </div>
      ))}

      <div className="pm-card" style={{marginTop:'1rem'}}>
        <div className="pm-section-title"><Plus size={13}/> {editing?'Edit relay':'New relay'}</div>
        <div style={{marginBottom:'0.75rem'}}>
          <label className="pm-label">Description</label>
          <input className="pm-input" value={form.description} onChange={e=>setForm(f=>({...f,description:e.target.value}))} placeholder="e.g. Fire dispatch -> Discord"/>
        </div>
        <div style={{marginBottom:'0.75rem'}}>
          <label className="pm-label">Voice channels to relay ({form.channel_ids?.length || 0} selected)</label>
          <p style={{fontSize:'0.72rem',color:'var(--text-3)',margin:'0 0 0.4rem'}}>
            Pick more than one to relay whichever is actively transmitting — the bot sticks with it until it
            drops, then hands off, same as the live-listen auto-switch on the dashboard.
          </p>
          {channels.length === 0 ? (
            <div style={{fontSize:'0.68rem',color:'var(--text-3)'}}>
              No channels defined yet — add some in Admin → Voice Channels first.
            </div>
          ) : (
            <div style={{maxHeight:'220px',overflowY:'auto',display:'flex',flexWrap:'wrap',gap:'0.35rem'}}>
              {channels.map(c=>(
                <label key={c.id} style={{
                  display:'flex',alignItems:'center',gap:'0.3rem',
                  fontSize:'0.78rem',cursor:'pointer',padding:'0.15rem 0.5rem',
                  borderRadius:'0.3rem',border:'1px solid var(--border)',background:'var(--bg-0)',
                }}>
                  <input type="checkbox"
                    checked={(form.channel_ids || []).includes(c.id)}
                    onChange={e=>{
                      const ids = e.target.checked
                        ? [...(form.channel_ids || []), c.id]
                        : (form.channel_ids || []).filter(x=>x!==c.id);
                      setForm(f=>({...f, channel_ids: ids}));
                    }}/>
                  <span>{c.description} ({c.freq})</span>
                </label>
              ))}
            </div>
          )}
        </div>
        <div style={{marginBottom:'0.75rem'}}>
          <label className="pm-label">Bot token</label>
          <input className="pm-input" type="password" value={form.bot_token} onChange={e=>setForm(f=>({...f,bot_token:e.target.value}))} placeholder="from the Discord Developer Portal"/>
        </div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'0.5rem',marginBottom:'0.75rem'}}>
          <div>
            <label className="pm-label">Guild (server) ID</label>
            <input className="pm-input" value={form.guild_id} onChange={e=>setForm(f=>({...f,guild_id:e.target.value}))} placeholder="123456789012345678"/>
          </div>
          <div>
            <label className="pm-label">Discord voice channel ID</label>
            <input className="pm-input" value={form.discord_channel_id} onChange={e=>setForm(f=>({...f,discord_channel_id:e.target.value}))} placeholder="123456789012345678"/>
          </div>
        </div>
        <label style={{display:'flex',alignItems:'center',gap:'0.5rem',fontSize:'0.82rem',color:'var(--text-1)',cursor:'pointer',marginBottom:'0.75rem'}}>
          <input type="checkbox" checked={form.enabled} onChange={e=>setForm(f=>({...f,enabled:e.target.checked}))}/>
          Enabled
        </label>
        <div style={{display:'flex',gap:'0.5rem'}}>
          <button className="pm-btn pm-btn-primary" onClick={save} disabled={!form.channel_ids?.length||!form.bot_token||!form.guild_id||!form.discord_channel_id}><Save size={13}/> Save</button>
          {editing && <button className="pm-btn" onClick={cancel}>Cancel</button>}
        </div>
      </div>
    </div>
  );
}
