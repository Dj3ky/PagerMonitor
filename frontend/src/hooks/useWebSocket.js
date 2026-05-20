import { useEffect, useRef, useState, useCallback, useMemo } from 'react';

const RECONNECT_BASE_MS = 3000;
const RECONNECT_MAX_MS  = 60000;
const MAX_MESSAGES = 500;

// Simple pub/sub for WS messages — avoids global mutation
const wsListeners = new Set();
export function subscribeWsMessages(fn) {
  wsListeners.add(fn);
  return () => wsListeners.delete(fn);
}

export function useWebSocket(backendUrl) {
  const [messages, setMessages]   = useState([]);
  const [wsStatus, setWsStatus]   = useState('connecting');
  const [sdrStatus, setSdrStatus] = useState(null);
  const wsRef    = useRef(null);
  const timerRef = useRef(null);

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
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;
    setWsStatus('connecting');

    ws.onopen = () => {
      setWsStatus('open');
      // On reconnect (not first connect) fetch history to catch missed messages
      if (attemptsRef.current > 0) {
        fetch((backendUrl || '') + '/api/history?limit=50')
          .then(r => r.json())
          .then(rows => {
            if (Array.isArray(rows)) {
              setMessages(prev => {
                const ids  = new Set(prev.map(m => m.id));
                const fresh = rows.filter(m => !ids.has(m.id));
                if (!fresh.length) return prev;
                return [...fresh, ...prev].slice(0, MAX_MESSAGES);
              });
            }
          })
          .catch(() => {});
      }
      attemptsRef.current = 0;
    };

    ws.onmessage = (evt) => {
      try {
        const data = JSON.parse(evt.data);

        // Notify all subscribers (LogViewer etc.)
        wsListeners.forEach(fn => { try { fn(data); } catch (_) {} });

        if (data.type === 'message') {
          setMessages(prev => {
            const next = [data, ...prev];
            return next.length > MAX_MESSAGES ? next.slice(0, MAX_MESSAGES) : next;
          });
          // Normal sound alert
          if (window.__pagemon_sound) {
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
            return next.length > MAX_MESSAGES ? next.slice(0, MAX_MESSAGES) : next;
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
        } else if (data.type === 'dead_air') {
          setSdrStatus(s => ({ ...s,
            deadAir:             data.state,
            deadAirLastMessage:  data.lastMessage,
            deadAirDongleCount:  data.dongleCount || 1,
            deadAirSource:       data.source || 'SDR',
          }));
          if (data.state === 'alert' && window.__playAlertSound) window.__playAlertSound('urgent');
        } else if (data.type === 'sdr_status') {
          setSdrStatus(data.status);
        }
      } catch (_) {}
    };

    ws.onclose = () => {
      setWsStatus('closed');
      attemptsRef.current += 1;
      const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, attemptsRef.current - 1), RECONNECT_MAX_MS);
      timerRef.current = setTimeout(connect, delay);
    };

    ws.onerror = () => { setWsStatus('error'); ws.close(); };
  }, [wsUrl, backendUrl]);

  useEffect(() => {
    connect();
    return () => { clearTimeout(timerRef.current); wsRef.current?.close(); };
  }, [connect]);

  const prependHistory = useCallback((history) => {
    setMessages(prev => {
      const ids   = new Set(prev.map(m => m.id));
      const fresh = history.filter(m => !ids.has(m.id));
      return [...prev, ...fresh].slice(0, MAX_MESSAGES);
    });
  }, []);

  // Append older messages at the bottom (load more)
  const appendHistory = useCallback((older) => {
    setMessages(prev => {
      const ids   = new Set(prev.map(m => m.id));
      const fresh = older.filter(m => !ids.has(m.id));
      // No MAX_MESSAGES cap on load-more — user explicitly requested them
      return [...prev, ...fresh];
    });
  }, []);

  return { messages, wsStatus, sdrStatus, prependHistory, appendHistory };
}
