import { useState, useEffect, useRef } from 'react';
import { Radio, Play, Square, Loader2, AlertCircle } from 'lucide-react';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { fetchVoiceChannels, fetchActiveVoiceChannels } from '../utils/api.js';
import { sendWsMessage, subscribeWsAudio, subscribeWsMessages } from '../hooks/useWebSocket.js';

const isNative = Capacitor.isNativePlatform();
const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || '';

// Native Android plays live channels through a dedicated background service
// (LiveAudioService.kt) instead of the WebView's Web Audio API — see that file's
// class doc: Chrome/WebView freezes a backgrounded page's JS after a few minutes
// regardless of any foreground service keeping the *process* alive, which silently
// killed audio even with the keep-awake/foreground-service approach tried first.
const LiveAudio = isNative ? registerPlugin('LiveAudio') : null;

function nativeWsUrl() {
  const base = BACKEND_URL.replace(/^https/, 'wss').replace(/^http(?!s)/, 'ws') + '/ws';
  const token = localStorage.getItem('pm_token') || '';
  return token ? `${base}?token=${encodeURIComponent(token)}` : base;
}

// Keep the screen/CPU awake while a live channel is playing — a courtesy for when
// the phone is actively being looked at (visible but unfocused); doesn't affect
// whether audio itself keeps running, LiveAudioService handles that independently.
const setKeepAwake = (on) => {
  if (!isNative) return;
  import('@capacitor-community/keep-awake')
    .then(({ KeepAwake }) => on ? KeepAwake.keepAwake() : KeepAwake.allowSleep())
    .catch(() => {});
};

const hapticTap = () => {
  if (!isNative) return;
  import('@capacitor/haptics')
    .then(({ Haptics, ImpactStyle }) => Haptics.impact({ style: ImpactStyle.Light }))
    .catch(() => {});
};

const SAMPLE_RATE = 16000; // rtl_airband's fixed udp_stream rate — raw passthrough, no resampling anywhere in this path
const STALL_TIMEOUT_MS = 8000; // no audio frame for this long (initial connect, or mid-playback) -> treat as failed
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
  const [activeChannels, setActiveChannels] = useState(() => new Set()); // channel ids currently transmitting (any listener or none)
  const [autoListen, setAutoListen] = useState(() => localStorage.getItem('pm_auto_listen') === '1');

  const audioCtxRef  = useRef(null);
  const nextTimeRef  = useRef(0);
  const unsubRef     = useRef(null);
  const timeoutRef   = useRef(null);
  const panelRef     = useRef(null);
  const autoGraceTimerRef = useRef(null); // pending "give up on this channel" timer while auto-listen is on

  // Mirrors of the latest state, readable from inside the grace-period setTimeout below —
  // a plain closure over channels/activeChannels/playingId/autoListen would see whatever
  // those were 3-4s ago when the timer was scheduled, not what they are when it actually fires.
  const channelsRef = useRef(channels); channelsRef.current = channels;
  const activeChannelsRef = useRef(activeChannels); activeChannelsRef.current = activeChannels;
  const playingIdRef = useRef(playingId); playingIdRef.current = playingId;
  const autoListenRef = useRef(autoListen); autoListenRef.current = autoListen;

  useEffect(() => {
    fetchVoiceChannels().then(r => setChannels(Array.isArray(r) ? r : [])).catch(() => {});
  }, []);

  // "Is anyone talking" indicator — independent of whether we're actually listening,
  // so users can see a channel is active before deciding to open it. Seed from the
  // current snapshot, then keep it live via the same channel_activity WS broadcasts.
  useEffect(() => {
    fetchActiveVoiceChannels()
      .then(r => setActiveChannels(new Set(Object.keys(r || {}).map(Number))))
      .catch(() => {});
    return subscribeWsMessages(data => {
      if (data.type === 'ws_reconnected') {
        // A transition while we were offline never gets re-broadcast (the server only
        // sends channel_activity on change) — re-fetch the real snapshot instead of
        // trusting whatever this Set was left holding before the drop.
        fetchActiveVoiceChannels()
          .then(r => setActiveChannels(new Set(Object.keys(r || {}).map(Number))))
          .catch(() => {});
        return;
      }
      if (data.type !== 'channel_activity') return;
      setActiveChannels(prev => {
        const has = prev.has(data.channelId);
        if (has === !!data.active) return prev;
        const next = new Set(prev);
        if (data.active) next.add(data.channelId); else next.delete(data.channelId);
        return next;
      });
    });
  }, []);

  useEffect(() => {
    if (!open) return;
    const h = e => { if (panelRef.current && !panelRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);

  useEffect(() => { localStorage.setItem('pm_auto_listen', autoListen ? '1' : '0'); }, [autoListen]);

  // Auto-listen: while enabled, keeps you tuned to whichever channel is transmitting,
  // switching or stopping as activity changes. Manual play/stop (see userAction below)
  // turns this off immediately, so a human's choice is never overridden — only this
  // effect drives playback while the toggle is on.
  //
  // Native only: this JS-driven version is skipped entirely — LiveAudioService.kt makes
  // the same decision natively instead, because this effect stops running once Chrome
  // freezes a backgrounded WebView's JS, which would otherwise mean auto-listen just goes
  // silent whenever the app isn't in the foreground. See startAuto() below.
  const AUTO_SWITCH_GRACE_MS = 3500; // stay put briefly after "quiet" — radio chatter often has a few-second pause mid-conversation, not the end of it
  useEffect(() => {
    if (!autoListen || isNative) {
      clearTimeout(autoGraceTimerRef.current);
      autoGraceTimerRef.current = null;
      return;
    }

    if (playingId != null) {
      if (activeChannels.has(playingId)) {
        // Back (or never left) — cancel any pending "give up on this channel" timer.
        clearTimeout(autoGraceTimerRef.current);
        autoGraceTimerRef.current = null;
        return;
      }
      // Currently-playing channel just went quiet. Don't switch away immediately — wait out
      // the grace period first, re-checking the *latest* state (via refs) once it elapses,
      // since a lot can change in 3-4s. Guarded so an unrelated dep change (some other
      // channel's activity flipping) while already waiting doesn't reset the countdown.
      if (!autoGraceTimerRef.current) {
        autoGraceTimerRef.current = setTimeout(() => {
          autoGraceTimerRef.current = null;
          if (!autoListenRef.current) return;
          const curId = playingIdRef.current;
          const curActive = activeChannelsRef.current;
          if (curId != null && curActive.has(curId)) return; // resumed just before the timer fired
          stop();
          const next = channelsRef.current.find(c => curActive.has(c.id));
          if (next) play(next);
        }, AUTO_SWITCH_GRACE_MS);
      }
      return;
    }

    // Nothing playing — jump straight to any active channel, no grace period needed here.
    const next = channels.find(c => activeChannels.has(c.id));
    if (next) play(next);
  }, [autoListen, activeChannels, playingId, channels]); // eslint-disable-line react-hooks/exhaustive-deps

  // Native equivalent of the effect above: instead of deciding which channel to play here
  // in JS, just tell LiveAudioService whether auto-listen is on at all and let it make (and
  // keep making) that decision itself — see that file's class doc for why. The playingId
  // guard on the stop branch avoids racing a manual channel tap: userAction() below turns
  // autoListen off and calls play() in the same synchronous handler, so by the time this
  // effect re-runs, playingId is already the new channel — don't undo that start (the
  // redundant start() it fires in that case is a harmless no-op re-issue of the same channel).
  useEffect(() => {
    if (!isNative) return;
    if (autoListen && channels.length > 0) {
      LiveAudio.startAuto({
        wsUrl: nativeWsUrl(),
        restBase: BACKEND_URL,
        token: localStorage.getItem('pm_token') || '',
        channelsJson: JSON.stringify(channels.map(c => ({ id: c.id, description: c.description || 'Live channel' }))),
      }).catch(() => {});
    } else if (!autoListen) {
      if (playingId != null) {
        // Something was already playing via auto-listen — pin to it (stop future
        // auto-switching) instead of cutting audio off just because the toggle flipped.
        const ch = channels.find(c => c.id === playingId);
        LiveAudio.start({ wsUrl: nativeWsUrl(), channelId: playingId, description: ch?.description || 'Live channel' }).catch(() => {});
      } else {
        LiveAudio.stop().catch(() => {});
      }
    }
  }, [autoListen, channels, playingId]); // eslint-disable-line react-hooks/exhaustive-deps

  const userAction = (fn) => { if (autoListen) setAutoListen(false); fn(); };

  useEffect(() => () => { clearTimeout(autoGraceTimerRef.current); stop(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Reflects LiveAudioService's status — the service is the source of truth on native,
  // this just mirrors it into the UI (connecting/playing/error, or stopped -> idle).
  useEffect(() => {
    if (!isNative) return;
    let handle;
    LiveAudio.addListener('statusChange', ({ status: s, channelId: cid }) => {
      setStatus(s === 'stopped' ? null : s);
      // In auto-watch mode the native side picks the channel on its own (see
      // LiveAudioService.kt), without JS ever calling play() — without this, playingId
      // would stay null and the UI wouldn't show which channel it switched to.
      if (s === 'stopped') setPlayingId(null);
      else if (cid != null && cid >= 0) setPlayingId(cid);
    }).then(h => { handle = h; });

    // The service may already be running from before this component existed — e.g. the
    // app was closed and reopened while a channel kept playing in the background. Without
    // this, the fresh UI has no way to know that, and only finds out once the *next* audio
    // frame flips status to "playing" with no channel id attached to show a name for it.
    LiveAudio.getStatus().then(({ status: s, channelId }) => {
      if (s && s !== 'stopped' && channelId >= 0) {
        setPlayingId(channelId);
        setStatus(s);
      }
    }).catch(() => {});

    return () => handle?.remove();
  }, []);

  const clearMediaSession = () => {
    if (!('mediaSession' in navigator)) return;
    navigator.mediaSession.metadata = null;
    navigator.mediaSession.playbackState = 'none';
  };

  // Everything stop() does except resetting playingId/status — used by the stall
  // watchdog too, which needs to tear down audio/keep-awake/the listening
  // notification on failure while still leaving the row showing "error" (with a
  // retry affordance) rather than silently reverting to "not playing".
  const releaseResources = () => {
    unsubRef.current?.();
    unsubRef.current = null;
    clearTimeout(timeoutRef.current);
    if (audioCtxRef.current) { try { audioCtxRef.current.close(); } catch (_) {} audioCtxRef.current = null; }
    clearMediaSession();
    setKeepAwake(false);
  };

  const stop = () => {
    if (isNative) {
      setKeepAwake(false);
      // Skip the native call entirely when nothing's playing — play() unconditionally
      // calls stop() first to reset any prior session, so without this guard, the very
      // first tap ever would fire a pointless stop() that still starts-and-immediately-
      // kills the Android service for nothing.
      if (playingId != null) LiveAudio.stop().catch(() => {});
      setPlayingId(null);
      setStatus(null);
      return;
    }
    if (playingId != null) sendWsMessage({ type: 'listen_stop', channelId: playingId });
    releaseResources();
    setPlayingId(null);
    setStatus(null);
  };

  const play = (ch) => {
    hapticTap();

    if (isNative) {
      // No stop() first here on purpose — switching channels while one is already
      // playing used to send a STOP then a START to the Android service back-to-back,
      // and the STOP could finish tearing the whole service down before the START
      // landed, silently dropping it (had to tap twice). connect() on the native side
      // already cleans up whatever channel was previously playing before switching, so
      // a bare start is both correct and race-free.
      setPlayingId(ch.id);
      setStatus('connecting');
      setKeepAwake(true);
      LiveAudio.start({ wsUrl: nativeWsUrl(), channelId: ch.id, description: ch.description || 'Live channel' })
        .catch(() => setStatus('error'));
      return;
    }

    stop();
    setPlayingId(ch.id);
    setStatus('connecting');
    setKeepAwake(true);

    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    ctx.resume().catch(() => {});
    audioCtxRef.current = ctx;
    nextTimeRef.current = ctx.currentTime + PLAY_AHEAD_SEC;

    // Ongoing watchdog, not just an initial-connect timeout — re-armed on every frame, so a
    // source that goes offline mid-playback (client disconnects, rtl_airband dies, etc.) gets
    // caught too, not just a stream that never started. Safe to use the same short timeout
    // throughout: voice channels are continuous=true (always sending, even through real RF
    // silence), so a healthy stream never actually goes this long between frames.
    const armWatchdog = () => {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => {
        if (audioCtxRef.current !== ctx) return;
        sendWsMessage({ type: 'listen_stop', channelId: ch.id });
        releaseResources();
        setStatus('error');
      }, STALL_TIMEOUT_MS);
    };
    armWatchdog();

    unsubRef.current = subscribeWsAudio((channelId, arrayBuffer) => {
      if (channelId !== ch.id || audioCtxRef.current !== ctx) return;
      armWatchdog();

      const floats = new Float32Array(arrayBuffer);
      if (floats.length === 0) return;

      setStatus(s => {
        if (s === 'playing') return s;
        if ('mediaSession' in navigator) {
          navigator.mediaSession.metadata = new MediaMetadata({ title: ch.description || 'Live channel', artist: 'PagerMonitor' });
          navigator.mediaSession.playbackState = 'playing';
          navigator.mediaSession.setActionHandler('play',  () => userAction(() => play(ch)));
          navigator.mediaSession.setActionHandler('pause', () => userAction(() => stop()));
          navigator.mediaSession.setActionHandler('stop',  () => userAction(() => stop()));
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

  const activeChannel = channels.find(c => c.id === playingId);
  // Auto is on, nothing's playing yet — standing by for the next transmission. Distinct
  // from "playing", which always means red-with-name whether it got there manually or
  // via auto-listen — the icon shouldn't look different depending on how you got there.
  const armed = autoListen && playingId == null && status !== 'error';

  return (
    <div ref={panelRef} style={{ position:'relative', flexShrink:0, marginLeft:'auto',
      display:'flex', alignItems:'center', gap:'0.4rem' }}>
      {activeChannel && (
        <span title={activeChannel.description} style={{
          fontSize:'0.75rem', fontWeight:600, whiteSpace:'nowrap',
          overflow:'hidden', textOverflow:'ellipsis', maxWidth:'110px',
          color: status === 'error' ? 'var(--accent-amber)' : status === 'playing' ? 'var(--accent-red)' : 'var(--text-3)',
        }}>
          {activeChannel.description}
        </span>
      )}
      <button title={
          status === 'playing' ? 'Listening — tap to view channels'
          : armed ? 'Auto-listen armed — waiting for activity'
          : activeChannels.size > 0 ? 'Live voice channels — someone is transmitting'
          : 'Live voice channels'
        }
        onClick={() => setOpen(o => !o)} style={{
        position:'relative', display:'flex', alignItems:'center', justifyContent:'center',
        width:'36px', height:'36px', borderRadius:'0.4rem',
        border:'1px solid var(--border)', cursor:'pointer', transition:'all 0.15s',
        background: open ? 'var(--bg-4)'
          : status === 'error' ? 'color-mix(in srgb, var(--accent-amber) 12%, transparent)'
          : status === 'playing' ? 'color-mix(in srgb, var(--accent-red) 12%, transparent)'
          : armed ? 'color-mix(in srgb, var(--accent-green) 12%, transparent)'
          : 'var(--bg-3)',
        color: status === 'error' ? 'var(--accent-amber)' : status === 'playing' ? 'var(--accent-red)' : armed ? 'var(--accent-green)' : 'var(--text-1)',
      }}>
        {/* Breathing green = auto-armed, standing by. Solid red + name = actually listening
            (same look whether that started manually or via auto). Corner dot = "some channel
            has activity" independent of whether you're tuned in — three separate signals. */}
        <Radio size={18} className={armed ? 'animate-blink' : undefined} />
        {activeChannels.size > 0 && (
          <span className="animate-blink" style={{
            position:'absolute', top:'3px', right:'3px', width:'8px', height:'8px',
            borderRadius:'50%', background:'var(--accent-green)',
            boxShadow:'0 0 0 2px var(--bg-3)',
          }} />
        )}
      </button>

      {open && (
        <div style={{
          position:'absolute', top:'calc(100% + 6px)', right:0, zIndex:2000,
          width:'220px', maxWidth:'calc(100vw - 1.5rem)', boxSizing:'border-box',
          background:'var(--bg-1)', border:'1px solid var(--border)',
          borderRadius:'0.5rem', boxShadow:'0 8px 24px rgba(0,0,0,0.5)', padding:'0.4rem',
        }}>
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'0.3rem 0.4rem' }}>
            <span style={{ fontSize:'0.68rem', fontWeight:600, color:'var(--text-3)',
              textTransform:'uppercase', letterSpacing:'0.05em' }}>
              Live channels
            </span>
            <button
              title={autoListen ? 'Auto-listen is on — automatically tunes to whichever channel is active. Tap to turn off.'
                : 'Auto-listen is off. Tap to automatically tune to whichever channel is active.'}
              onClick={() => setAutoListen(a => !a)}
              style={{
                padding:'0.15rem 0.45rem', borderRadius:'999px', border:'1px solid var(--border)',
                cursor:'pointer', fontSize:'0.65rem', fontWeight:600, whiteSpace:'nowrap',
                background: autoListen ? 'color-mix(in srgb, var(--accent-green) 15%, transparent)' : 'var(--bg-3)',
                color: autoListen ? 'var(--accent-green)' : 'var(--text-3)',
              }}>
              Auto {autoListen ? 'on' : 'off'}
            </button>
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
              <button key={ch.id} onClick={() => userAction(() => !isActive ? play(ch) : chStatus === 'error' ? play(ch) : (hapticTap(), stop()))}
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
                {activeChannels.has(ch.id) && (
                  <span title="Transmitting now" className="animate-blink" style={{
                    width:'7px', height:'7px', borderRadius:'50%',
                    background:'var(--accent-green)', flexShrink:0,
                  }} />
                )}
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
