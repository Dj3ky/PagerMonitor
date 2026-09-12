import { useEffect, useRef, useState, useCallback, useMemo } from 'react';

const RECONNECT_BASE_MS = 3000;
const RECONNECT_MAX_MS  = 60000;
const CONNECT_TIMEOUT_MS = 10000; // a handshake stuck CONNECTING this long is treated as dead — see connect()
const MAX_MESSAGES = 500;
const PING_INTERVAL_MS = 20000; // app-level liveness check — see the pong handler in connect()
const PONG_TIMEOUT_MS  = 45000; // no pong (or any other message) in this long -> treat as a zombie socket

// Simple pub/sub for WS messages — avoids global mutation
const wsListeners = new Set();
export function subscribeWsMessages(fn) {
  wsListeners.add(fn);
  return () => wsListeners.delete(fn);
}

// Binary audio frames (voice-channel relay) — separate pub/sub, keyed by channelId so
// LiveChannels only processes frames for whatever it's currently playing. Frame format:
// 4-byte little-endian channel id, followed by raw 32-bit float mono PCM at 16kHz.
const audioListeners = new Set();
export function subscribeWsAudio(fn) {
  audioListeners.add(fn);
  return () => audioListeners.delete(fn);
}

// Lets components (LiveChannels) send control messages (listen_start/listen_stop) without
// needing the ws instance threaded through props/context — mirrors the wsListeners pattern.
let currentWs = null;
export function sendWsMessage(obj) {
  if (currentWs?.readyState === WebSocket.OPEN) { try { currentWs.send(JSON.stringify(obj)); } catch (_) {} }
}

export function useWebSocket(backendUrl) {
  const [messages, setMessages]   = useState([]);
  const [wsStatus, setWsStatus]   = useState('connecting');
  const [sdrStatus, setSdrStatus] = useState(null);
  const wsRef          = useRef(null);
  const timerRef       = useRef(null);
  const shuttingDownRef = useRef(false);
  const lastActivityRef = useRef(Date.now()); // last time *anything* arrived — see the heartbeat effect below
  const pingTimerRef    = useRef(null);
  // Set once the user has fetched older history via "Load More" — past that point we must
  // stop capping `messages` at MAX_MESSAGES, or the very next live message (or reconnect
  // catch-up fetch) would slice the array back down to MAX_MESSAGES and silently drop the
  // older messages Load More just fetched, even though Load More itself never caps.
  const extendedRef = useRef(false);

  // Derive WebSocket URL — MUST use wss:// when page is loaded over https://
  // otherwise browsers block it as mixed content
  const wsUrl = useMemo(() => {
    if (backendUrl) {
      // Replace http(s):// with ws(s)://
      return backendUrl.replace(/^https/, 'wss').replace(/^http(?!s)/, 'ws') + '/ws';
    }
    // Same origin — mirror the current protocol
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${window.location.host}/ws`;
  }, [backendUrl]);

  const attemptsRef = useRef(0);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;
    // Browsers can't set custom headers on a WS handshake, so the bearer token — which
    // determines which organization's feed this connection sees — travels as a query param.
    const token = localStorage.getItem('pm_token') || '';
    const ws = new WebSocket(token ? `${wsUrl}?token=${encodeURIComponent(token)}` : wsUrl);
    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;
    currentWs = ws;
    setWsStatus('connecting');

    // A handshake can stall at the network layer indefinitely with no open/close/error ever
    // firing to tell us — seen in the wild as a WS request sitting in Chrome's "Stalled"
    // state for *days* after a laptop sleep/resume, silently killing the reconnect loop
    // (which is otherwise entirely driven by onclose). Treat "still CONNECTING after this
    // long" as a dead attempt ourselves rather than trusting the browser to ever say so.
    const connectTimeout = setTimeout(() => {
      if (ws.readyState !== WebSocket.CONNECTING) return;
      try { ws.close(); } catch (_) {}
      // close() on a still-CONNECTING socket doesn't reliably fire onclose in every browser.
      handleDown();
    }, CONNECT_TIMEOUT_MS);

    // Shared by the natural close event and the connectTimeout fallback above — guarded so
    // whichever fires first is the only one that schedules a retry for this attempt.
    let handledDown = false;
    const handleDown = () => {
      if (handledDown) return;
      handledDown = true;
      clearTimeout(connectTimeout);
      if (currentWs === ws) currentWs = null;
      if (wsRef.current === ws) wsRef.current = null;
      if (!shuttingDownRef.current) setWsStatus('closed');
      attemptsRef.current += 1;
      const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, attemptsRef.current - 1), RECONNECT_MAX_MS);
      timerRef.current = setTimeout(connect, delay);
    };

    ws.onopen = () => {
      clearTimeout(connectTimeout);
      setWsStatus('open');
      shuttingDownRef.current = false;
      lastActivityRef.current = Date.now();
      // On reconnect (not first connect) fetch history to catch missed messages
      if (attemptsRef.current > 0) {
        const tok = localStorage.getItem('pm_token') || '';
        fetch((backendUrl || '') + '/api/history?limit=50', {
          headers: tok ? { Authorization: `Bearer ${tok}` } : {},
        })
          .then(r => r.json())
          .then(({ messages: rows }) => {
            if (Array.isArray(rows)) {
              setMessages(prev => {
                const ids  = new Set(prev.map(m => m.id));
                const fresh = rows.filter(m => !ids.has(m.id));
                if (!fresh.length) return prev;
                const next = [...fresh, ...prev];
                return extendedRef.current || next.length <= MAX_MESSAGES ? next : next.slice(0, MAX_MESSAGES);
              });
            }
          })
          .catch(() => {});
        // Other listeners keep incremental/delta state (e.g. LiveChannels' "who's
        // transmitting" set, built from edge-triggered channel_activity broadcasts) that
        // a dropped connection can desync — a transition that happens while offline never
        // gets (re-)broadcast once we're back, since the server only sends on change. Let
        // them know to do a full resync instead of trusting what they've got.
        wsListeners.forEach(fn => { try { fn({ type: 'ws_reconnected' }); } catch (_) {} });
      }
      attemptsRef.current = 0;
    };

    ws.onmessage = (evt) => {
      lastActivityRef.current = Date.now();
      if (evt.data instanceof ArrayBuffer) {
        if (evt.data.byteLength < 4) return;
        const view = new DataView(evt.data);
        const channelId = view.getUint32(0, true); // little-endian
        const payload = evt.data.slice(4);
        audioListeners.forEach(fn => { try { fn(channelId, payload); } catch (_) {} });
        return;
      }
      try {
        const data = JSON.parse(evt.data);
        if (data.type === 'pong') return; // liveness reply only — see the heartbeat effect below

        // Notify all subscribers (LogViewer etc.)
        wsListeners.forEach(fn => { try { fn(data); } catch (_) {} });

        if (data.type === 'message') {
          setMessages(prev => {
            const next = [data, ...prev];
            return !extendedRef.current && next.length > MAX_MESSAGES ? next.slice(0, MAX_MESSAGES) : next;
          });
          // Normal sound alert
          if (window.__pagermonitor_sound) {
            try {
              const ctx  = new AudioContext();
              const osc  = ctx.createOscillator();
              const gain = ctx.createGain();
              osc.connect(gain); gain.connect(ctx.destination);
              osc.frequency.value = 880;
              gain.gain.setValueAtTime(0.08, ctx.currentTime);
              gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);
              osc.start(); osc.stop(ctx.currentTime + 0.15);
            } catch (_) {}
          }
        } else if (data.type === 'keyword_alert') {
          // Add message to feed (avoid duplicate)
          setMessages(prev => {
            if (prev.find(m => m.id === data.id)) return prev;
            const next = [{ ...data, type:'message', isKeywordAlert:true }, ...prev];
            return !extendedRef.current && next.length > MAX_MESSAGES ? next.slice(0, MAX_MESSAGES) : next;
          });
          // Play keyword alert sound via global
          const sound = data.matchedAlerts?.[0]?.sound || 'alert';
          if (window.__playAlertSound) window.__playAlertSound(sound);
          // Flash tab title for 5 seconds
          const orig = document.title;
          let cnt = 0;
          const iv = setInterval(() => {
            document.title = cnt++ % 2 === 0 ? `🔔 ALERT — ${orig}` : orig;
            if (cnt > 10) { clearInterval(iv); document.title = orig; }
          }, 500);
          // Mark this message id for blink animation in feed
          window.__pm_alerts = window.__pm_alerts || new Set();
          window.__pm_alerts.add(data.id);
          setTimeout(() => window.__pm_alerts?.delete(data.id), 30000);
        } else if (data.type === 'message_update') {
          setMessages(prev => prev.map(m =>
            m.id === data.id ? { ...m, message: data.message } : m
          ));
        } else if (data.type === 'message_location') {
          setMessages(prev => prev.map(m =>
            m.id === data.id ? { ...m, lat: data.lat, lng: data.lng } : m
          ));
        } else if (data.type === 'message_location_clear') {
          setMessages(prev => prev.map(m =>
            m.id === data.id ? { ...m, lat: null, lng: null } : m
          ));
        } else if (data.type === 'map_locations_cleared') {
          setMessages(prev => prev.map(m => ({ ...m, lat: null, lng: null })));
        } else if (data.type === 'dead_air') {
          setSdrStatus(s => ({ ...s,
            deadAir:        data.state,
            deadAirSources: data.silentSources || [],
          }));
          if (data.state === 'alert' && window.__playAlertSound) window.__playAlertSound('urgent');
        } else if (data.type === 'sdr_status') {
          setSdrStatus(data.status);
        } else if (data.type === 'server_shutdown') {
          shuttingDownRef.current = true;
          attemptsRef.current = 0;
          setWsStatus('restarting');
        }
      } catch (_) {}
    };

    ws.onclose = () => handleDown();

    ws.onerror = () => { setWsStatus('error'); try { ws.close(); } catch (_) {} };
  }, [wsUrl, backendUrl]);

  // Login/logout can leave a stale socket sitting in a backoff wait (connected with no
  // token, or authenticated under an identity that just logged out) — reconnect right
  // away instead of waiting for whatever retry delay that earlier attempt landed on.
  const forceReconnect = useCallback(() => {
    clearTimeout(timerRef.current);
    const old = wsRef.current;
    if (old) {
      old.onopen = null; old.onmessage = null; old.onclose = null; old.onerror = null;
      if (old.readyState === WebSocket.OPEN || old.readyState === WebSocket.CONNECTING) old.close();
      if (currentWs === old) currentWs = null;
      wsRef.current = null;
    }
    // Treat this like any other reconnect, not a fresh mount — onopen's `attemptsRef.current
    // > 0` check is what triggers the history catch-up fetch and the `ws_reconnected`
    // broadcast that listeners (e.g. LiveChannels) rely on to resync. onopen zeroes it back
    // out itself once that check has run.
    attemptsRef.current = Math.max(attemptsRef.current, 1);
    connect();
  }, [connect]);

  useEffect(() => {
    connect();
    return () => { clearTimeout(timerRef.current); wsRef.current?.close(); };
  }, [connect]);

  useEffect(() => {
    window.addEventListener('pm_token_changed', forceReconnect);
    return () => window.removeEventListener('pm_token_changed', forceReconnect);
  }, [forceReconnect]);

  // The connectTimeout in connect() is a safety net for a stall happening while the tab is
  // active, but it still leaves a genuinely dead connection sitting for up to 10s before
  // retrying. Coming back to the tab (or the OS reporting the network is back) is a much
  // stronger, immediate signal to just check right now instead of waiting on that timer or
  // whatever backoff delay is currently in flight.
  useEffect(() => {
    const checkStillAlive = () => {
      if (document.visibilityState === 'hidden') return;
      if (wsRef.current?.readyState !== WebSocket.OPEN) { forceReconnect(); return; }
      // readyState alone isn't trustworthy coming back from background: Chrome/WebView
      // freezes a backgrounded tab's JS while the OS keeps responding to the WebSocket's
      // protocol-level ping/pong transparently underneath it, so a socket that's actually
      // dead (or just never delivered anything the whole time we were away) still reports
      // OPEN. Fall back to "have we heard *anything* recently" instead of trusting that flag.
      if (Date.now() - lastActivityRef.current > PONG_TIMEOUT_MS) forceReconnect();
    };
    document.addEventListener('visibilitychange', checkStillAlive);
    window.addEventListener('focus', checkStillAlive);
    window.addEventListener('online', checkStillAlive);
    return () => {
      document.removeEventListener('visibilitychange', checkStillAlive);
      window.removeEventListener('focus', checkStillAlive);
      window.removeEventListener('online', checkStillAlive);
    };
  }, [forceReconnect]);

  // Same zombie-socket problem, but for the case where the tab never goes hidden at all
  // (e.g. a laptop sleep/resume, or a network path that silently drops packets without the
  // OS ever surfacing a close). Round-trip an app-level ping through the JS message handler
  // — not just relying on the transport's own ping/pong — since that's what actually proves
  // messages are getting through, which is the thing consumers (e.g. LiveChannels' "who's
  // transmitting" indicator) depend on.
  useEffect(() => {
    pingTimerRef.current = setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      if (wsRef.current?.readyState !== WebSocket.OPEN) return;
      if (Date.now() - lastActivityRef.current > PONG_TIMEOUT_MS) { forceReconnect(); return; }
      sendWsMessage({ type: 'ping', ts: Date.now() });
    }, PING_INTERVAL_MS);
    return () => clearInterval(pingTimerRef.current);
  }, [forceReconnect]);

  const prependHistory = useCallback((history) => {
    setMessages(prev => {
      const ids   = new Set(prev.map(m => m.id));
      const fresh = history.filter(m => !ids.has(m.id));
      const next  = [...prev, ...fresh];
      return extendedRef.current || next.length <= MAX_MESSAGES ? next : next.slice(0, MAX_MESSAGES);
    });
  }, []);

  // Append older messages at the bottom (load more)
  const appendHistory = useCallback((older) => {
    extendedRef.current = true; // stop capping at MAX_MESSAGES — see extendedRef above
    setMessages(prev => {
      const ids   = new Set(prev.map(m => m.id));
      const fresh = older.filter(m => !ids.has(m.id));
      // No MAX_MESSAGES cap on load-more — user explicitly requested them
      return [...prev, ...fresh];
    });
  }, []);

  const removeMessage = useCallback((id) => {
    setMessages(prev => prev.filter(m => m.id !== id));
  }, []);

  return { messages, wsStatus, sdrStatus, prependHistory, appendHistory, removeMessage };
}
