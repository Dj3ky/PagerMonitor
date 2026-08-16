import { useState, useEffect } from 'react';
import { Headphones, Eye, EyeOff } from 'lucide-react';

const BASE = import.meta.env.VITE_BACKEND_URL || '';
const tok  = () => localStorage.getItem('pm_token') || '';
const api  = (m, p, b) => fetch(`${BASE}${p}`, {
  method: m, headers: { 'Content-Type':'application/json', Authorization:`Bearer ${tok()}` },
  body: b ? JSON.stringify(b) : undefined,
}).then(async r => {
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
  return d;
});

function Flash({ msg }) {
  if (!msg) return null;
  const ok = msg.type === 'ok';
  return <div style={{padding:'0.4rem 0.75rem',borderRadius:'0.4rem',fontSize:'0.78rem',fontFamily:'monospace',marginBottom:'0.75rem',color:ok?'var(--accent-green)':'var(--accent-red)',background:`color-mix(in srgb,${ok?'var(--accent-green)':'var(--accent-red)'} 10%,transparent)`,border:`1px solid color-mix(in srgb,${ok?'var(--accent-green)':'var(--accent-red)'} 30%,transparent)`}}>{msg.text}</div>;
}

// Voice channels are a shared, instance-wide catalog (see VoiceChannels.jsx, platform-admin
// only) since they're tied to physical dongles the whole server has in common. This panel is
// the org-level counterpart: pick which of those shared channels this org's own users get to
// see/listen to. Visible by default — toggling here only ever *hides* a channel for this org,
// never removes or edits it from the shared catalog.
export default function VoiceChannelVisibility() {
  const [channels, setChannels] = useState([]);
  const [hidden, setHidden]     = useState(new Set());
  const [loading, setLoading]   = useState(true);
  const [msg, setMsg]           = useState(null);

  const flash = (type, text) => { setMsg({ type, text }); setTimeout(() => setMsg(null), 3500); };

  const load = () => {
    api('GET', '/admin/voice-channel-visibility')
      .then(d => {
        setChannels(Array.isArray(d.channels) ? d.channels : []);
        setHidden(new Set(Array.isArray(d.hidden) ? d.hidden : []));
      })
      .catch(e => flash('err', e.message))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  const toggle = async (id, nextHidden) => {
    // Optimistic — this is a simple boolean flip, and reverting on failure is cheap.
    setHidden(prev => {
      const next = new Set(prev);
      if (nextHidden) next.add(id); else next.delete(id);
      return next;
    });
    try {
      await api('PUT', `/admin/voice-channel-visibility/${id}`, { hidden: nextHidden });
    } catch (e) {
      setHidden(prev => {
        const next = new Set(prev);
        if (nextHidden) next.delete(id); else next.add(id);
        return next;
      });
      flash('err', e.message);
    }
  };

  return (
    <div style={{ maxWidth: '560px' }}>
      <h2 style={{ fontSize:'1rem', fontWeight:700, color:'var(--text-1)', marginBottom:'0.5rem', display:'flex', alignItems:'center', gap:'0.5rem' }}>
        <Headphones size={16} style={{ color:'var(--accent-blue)' }}/> Channel Visibility
      </h2>
      <p style={{ fontSize:'0.82rem', color:'var(--text-3)', marginBottom:'1rem', lineHeight:1.6 }}>
        Voice channels are a shared catalog managed by the platform admin (Voice Channels, under SDR).
        Turn any of them off here to hide it from your own organization's users — this doesn't
        affect the channel for anyone else, and doesn't touch its frequency/dongle assignment.
      </p>
      <Flash msg={msg}/>

      {loading ? (
        <div style={{ fontSize:'0.82rem', color:'var(--text-3)' }}>Loading…</div>
      ) : channels.length === 0 ? (
        <div style={{ fontSize:'0.82rem', color:'var(--text-3)' }}>No voice channels have been set up yet.</div>
      ) : channels.map(c => {
        const isHidden = hidden.has(c.id);
        return (
          <div key={c.id} className="pm-card" style={{ marginBottom:'0.5rem', display:'flex', alignItems:'center', gap:'0.75rem' }}>
            <div style={{ flex:1, minWidth:0 }}>
              <div style={{ fontWeight:600, color:'var(--text-1)', fontSize:'0.85rem' }}>{c.description}</div>
              <div style={{ fontFamily:'monospace', fontSize:'0.75rem', color:'var(--text-3)' }}>
                <span style={{ color:'var(--accent-amber)' }}>{c.freq}</span>{' · '}<span style={{ color:'var(--accent-blue)' }}>{c.mode}</span>
              </div>
            </div>
            <button className="pm-btn" onClick={() => toggle(c.id, !isHidden)}
              title={isHidden ? 'Hidden from your org — click to show' : 'Visible to your org — click to hide'}
              style={{ display:'flex', alignItems:'center', gap:'0.4rem',
                color: isHidden ? 'var(--text-3)' : 'var(--accent-green)' }}>
              {isHidden ? <><EyeOff size={13}/> Hidden</> : <><Eye size={13}/> Visible</>}
            </button>
          </div>
        );
      })}
    </div>
  );
}
