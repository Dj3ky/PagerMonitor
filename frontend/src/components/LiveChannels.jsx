import { useState, useEffect, useRef } from 'react';
import { Radio, Play, Square } from 'lucide-react';
import { fetchVoiceChannels } from '../utils/api.js';

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || '';

// Live voice-channel listening (firefighter dispatch etc.) — separate from the POCSAG
// feed. Channels stream continuously to Icecast regardless of listeners; this just
// points a plain <audio> element at the mountpoint when the user presses play.
export default function LiveChannels() {
  const [channels, setChannels] = useState([]);
  const [open, setOpen]         = useState(false);
  const [playingId, setPlayingId] = useState(null);
  const audioRef = useRef(null);
  const panelRef = useRef(null);

  useEffect(() => {
    fetchVoiceChannels().then(r => setChannels(Array.isArray(r) ? r : [])).catch(() => {});
  }, []);

  useEffect(() => {
    if (!open) return;
    const h = e => { if (panelRef.current && !panelRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);

  useEffect(() => () => { audioRef.current?.pause(); }, []);

  const stop = () => {
    audioRef.current?.pause();
    audioRef.current = null;
    setPlayingId(null);
  };

  const play = (ch) => {
    stop();
    const audio = new Audio(`${BACKEND_URL}/audio/${ch.mount}`);
    audio.play().catch(() => {});
    audioRef.current = audio;
    setPlayingId(ch.id);
  };

  if (channels.length === 0) return null;

  return (
    <div ref={panelRef} style={{ position:'relative', flexShrink:0, marginLeft:'auto' }}>
      <button title="Live voice channels" onClick={() => setOpen(o => !o)} style={{
        display:'flex', alignItems:'center', justifyContent:'center',
        width:'36px', height:'36px', borderRadius:'0.4rem',
        border:'1px solid var(--border)', cursor:'pointer', transition:'all 0.15s',
        background: open ? 'var(--bg-4)' : playingId != null ? 'color-mix(in srgb, var(--accent-red) 12%, transparent)' : 'var(--bg-3)',
        color: playingId != null ? 'var(--accent-red)' : 'var(--text-1)',
      }}>
        <Radio size={18} />
      </button>

      {open && (
        <div style={{
          position:'absolute', top:'calc(100% + 6px)', right:0, zIndex:2000,
          width:'220px', maxWidth:'calc(100vw - 1.5rem)', boxSizing:'border-box',
          background:'var(--bg-1)', border:'1px solid var(--border)',
          borderRadius:'0.5rem', boxShadow:'0 8px 24px rgba(0,0,0,0.5)', padding:'0.4rem',
        }}>
          <div style={{ fontSize:'0.68rem', fontWeight:600, color:'var(--text-3)',
            textTransform:'uppercase', letterSpacing:'0.05em', padding:'0.3rem 0.4rem' }}>
            Live channels
          </div>
          {channels.map(ch => {
            const isPlaying = playingId === ch.id;
            return (
              <button key={ch.id} onClick={() => isPlaying ? stop() : play(ch)}
                style={{
                  display:'flex', alignItems:'center', gap:'0.5rem', width:'100%',
                  padding:'0.4rem 0.5rem', borderRadius:'0.4rem', border:'none',
                  background: isPlaying ? 'color-mix(in srgb, var(--accent-red) 10%, transparent)' : 'transparent',
                  color:'var(--text-1)', cursor:'pointer', fontSize:'0.82rem', textAlign:'left',
                }}>
                {isPlaying ? <Square size={13} style={{ color:'var(--accent-red)' }} /> : <Play size={13} style={{ color:'var(--accent-green)' }} />}
                <span style={{ flex:1, minWidth:0, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                  {ch.description}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
