import { useState, useEffect, useRef } from 'react';
import { Radio, Play, Square, Loader2, AlertCircle } from 'lucide-react';
import { fetchVoiceChannels } from '../utils/api.js';

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || '';
const RETRY_DELAY_MS = 1500;

// Live voice-channel listening (firefighter dispatch etc.) — separate from the POCSAG
// feed. Channels stream continuously to Icecast regardless of listeners; this points a
// real <audio> element at the mountpoint when the user presses play, with a connecting/
// error state (instead of failing silently) and Media Session integration so Android
// treats it as legitimate background media (lock-screen controls, less likely to be
// suspended when the screen locks).
export default function LiveChannels() {
  const [channels, setChannels]   = useState([]);
  const [open, setOpen]           = useState(false);
  const [playingId, setPlayingId] = useState(null);
  const [status, setStatus]       = useState(null); // 'connecting' | 'playing' | 'error'
  const audioRef   = useRef(null);
  const panelRef   = useRef(null);
  const attemptRef = useRef(0);

  useEffect(() => {
    fetchVoiceChannels().then(r => setChannels(Array.isArray(r) ? r : [])).catch(() => {});
  }, []);

  useEffect(() => {
    if (!open) return;
    const h = e => { if (panelRef.current && !panelRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);

  useEffect(() => () => stop(), []); // eslint-disable-line react-hooks/exhaustive-deps

  const clearMediaSession = () => {
    if (!('mediaSession' in navigator)) return;
    navigator.mediaSession.metadata = null;
    navigator.mediaSession.playbackState = 'none';
  };

  const stop = () => {
    attemptRef.current += 1; // invalidates any in-flight retry/event from the previous attempt
    const audio = audioRef.current;
    if (audio) { audio.pause(); audio.removeAttribute('src'); audio.load(); }
    setPlayingId(null);
    setStatus(null);
    clearMediaSession();
  };

  const play = (ch, isRetry = false) => {
    const myAttempt = isRetry ? attemptRef.current : ++attemptRef.current;
    if (!isRetry) setPlayingId(ch.id);
    setStatus('connecting');

    const audio = audioRef.current;
    audio.src = `${BACKEND_URL}/audio/${ch.mount}`;

    const fail = () => {
      if (attemptRef.current !== myAttempt) return;
      if (!isRetry) setTimeout(() => { if (attemptRef.current === myAttempt) play(ch, true); }, RETRY_DELAY_MS);
      else setStatus('error');
    };

    audio.onplaying = () => {
      if (attemptRef.current !== myAttempt) return;
      setStatus('playing');
      if ('mediaSession' in navigator) {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: ch.description || 'Live channel',
          artist: 'PagerMonitor',
        });
        navigator.mediaSession.playbackState = 'playing';
        navigator.mediaSession.setActionHandler('play',  () => play(ch));
        navigator.mediaSession.setActionHandler('pause', () => stop());
        navigator.mediaSession.setActionHandler('stop',  () => stop());
      }
    };
    audio.onerror = fail;

    audio.play().catch(fail);
  };

  if (channels.length === 0) return null;

  return (
    <div ref={panelRef} style={{ position:'relative', flexShrink:0, marginLeft:'auto' }}>
      <audio ref={audioRef} style={{ display:'none' }} />

      <button title="Live voice channels" onClick={() => setOpen(o => !o)} style={{
        display:'flex', alignItems:'center', justifyContent:'center',
        width:'36px', height:'36px', borderRadius:'0.4rem',
        border:'1px solid var(--border)', cursor:'pointer', transition:'all 0.15s',
        background: open ? 'var(--bg-4)'
          : status === 'error' ? 'color-mix(in srgb, var(--accent-amber) 12%, transparent)'
          : status === 'playing' ? 'color-mix(in srgb, var(--accent-red) 12%, transparent)'
          : 'var(--bg-3)',
        color: status === 'error' ? 'var(--accent-amber)' : status === 'playing' ? 'var(--accent-red)' : 'var(--text-1)',
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
            const isActive = playingId === ch.id;
            const chStatus = isActive ? status : null;
            const icon =
              chStatus === 'connecting' ? <Loader2 size={13} className="animate-spin" style={{ color:'var(--text-3)' }} /> :
              chStatus === 'error'      ? <AlertCircle size={13} style={{ color:'var(--accent-amber)' }} /> :
              chStatus === 'playing'    ? <Square size={13} style={{ color:'var(--accent-red)' }} /> :
              <Play size={13} style={{ color:'var(--accent-green)' }} />;
            const rowBg =
              chStatus === 'error'   ? 'color-mix(in srgb, var(--accent-amber) 10%, transparent)' :
              chStatus === 'playing' ? 'color-mix(in srgb, var(--accent-red) 10%, transparent)' :
              'transparent';
            return (
              <button key={ch.id} onClick={() => !isActive ? play(ch) : chStatus === 'error' ? play(ch) : stop()}
                style={{
                  display:'flex', alignItems:'center', gap:'0.5rem', width:'100%',
                  padding:'0.4rem 0.5rem', borderRadius:'0.4rem', border:'none',
                  background: rowBg,
                  color:'var(--text-1)', cursor:'pointer', fontSize:'0.82rem', textAlign:'left',
                }}>
                {icon}
                <span style={{ flex:1, minWidth:0, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                  {ch.description}
                </span>
                {chStatus === 'error' && (
                  <span style={{ fontSize:'0.68rem', color:'var(--accent-amber)' }}>retry</span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
