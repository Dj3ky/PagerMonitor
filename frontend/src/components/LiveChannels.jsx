import { useState, useEffect, useRef } from 'react';
import { Radio, Play, Square, Loader2, AlertCircle } from 'lucide-react';
import { fetchVoiceChannels } from '../utils/api.js';
import { sendWsMessage, subscribeWsAudio } from '../hooks/useWebSocket.js';

const SAMPLE_RATE = 16000; // rtl_airband's fixed udp_stream rate — raw passthrough, no resampling anywhere in this path
const CONNECT_TIMEOUT_MS = 8000; // no audio frame within this long after pressing play -> treat as failed
const PLAY_AHEAD_SEC = 0.2; // small scheduling cushion so the first frame doesn't click

// Live voice-channel listening (firefighter dispatch etc.) — separate from the POCSAG
// feed. Audio is relayed over the app's existing WebSocket (see services/audioRelay.js on
// the backend) as raw PCM frames and scheduled directly via the Web Audio API, instead of
// pointing an <audio> element at an Icecast stream — gives sub-second latency instead of
// being at the mercy of the browser's built-in buffering heuristic for live streams.
export default function LiveChannels() {
  const [channels, setChannels]   = useState([]);
  const [open, setOpen]           = useState(false);
  const [playingId, setPlayingId] = useState(null);
  const [status, setStatus]       = useState(null); // 'connecting' | 'playing' | 'error'

  const audioCtxRef  = useRef(null);
  const nextTimeRef  = useRef(0);
  const unsubRef     = useRef(null);
  const timeoutRef   = useRef(null);
  const panelRef     = useRef(null);

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
    if (playingId != null) sendWsMessage({ type: 'listen_stop', channelId: playingId });
    unsubRef.current?.();
    unsubRef.current = null;
    clearTimeout(timeoutRef.current);
    if (audioCtxRef.current) { try { audioCtxRef.current.close(); } catch (_) {} audioCtxRef.current = null; }
    setPlayingId(null);
    setStatus(null);
    clearMediaSession();
  };

  const play = (ch) => {
    stop();
    setPlayingId(ch.id);
    setStatus('connecting');

    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    ctx.resume().catch(() => {});
    audioCtxRef.current = ctx;
    nextTimeRef.current = ctx.currentTime + PLAY_AHEAD_SEC;

    timeoutRef.current = setTimeout(() => {
      setStatus(s => s === 'connecting' ? 'error' : s);
    }, CONNECT_TIMEOUT_MS);

    unsubRef.current = subscribeWsAudio((channelId, arrayBuffer) => {
      if (channelId !== ch.id || audioCtxRef.current !== ctx) return;
      clearTimeout(timeoutRef.current);

      const floats = new Float32Array(arrayBuffer);
      if (floats.length === 0) return;

      setStatus(s => {
        if (s === 'playing') return s;
        if ('mediaSession' in navigator) {
          navigator.mediaSession.metadata = new MediaMetadata({ title: ch.description || 'Live channel', artist: 'PagerMonitor' });
          navigator.mediaSession.playbackState = 'playing';
          navigator.mediaSession.setActionHandler('play',  () => play(ch));
          navigator.mediaSession.setActionHandler('pause', () => stop());
          navigator.mediaSession.setActionHandler('stop',  () => stop());
        }
        return 'playing';
      });

      const buffer = ctx.createBuffer(1, floats.length, SAMPLE_RATE);
      buffer.copyToChannel(floats, 0);

      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(ctx.destination);

      const startAt = Math.max(nextTimeRef.current, ctx.currentTime);
      src.start(startAt);
      nextTimeRef.current = startAt + buffer.duration;
    });

    sendWsMessage({ type: 'listen_start', channelId: ch.id });
  };

  if (channels.length === 0) return null;

  return (
    <div ref={panelRef} style={{ position:'relative', flexShrink:0, marginLeft:'auto' }}>
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
