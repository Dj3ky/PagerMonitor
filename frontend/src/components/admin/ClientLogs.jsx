import { useState, useEffect, useRef, useMemo } from 'react';
import { Terminal, Trash2, PauseCircle, PlayCircle } from 'lucide-react';
import { adminFetchClientLogs, adminFetchSdrClients } from '../../utils/api.js';
import { sendWsMessage, subscribeWsMessages } from '../../hooks/useWebSocket.js';
import { useSite } from '../../context/SiteContext.jsx';

const LEVEL_COLORS = {
  error: 'var(--accent-red)',
  warn:  'var(--accent-amber)',
  info:  'var(--text-2)',
  debug: 'var(--text-3)',
};

const MAX_LINES = 1000;

function LogLine({ entry, clientName, clientColor }) {
  const { locale, hour12 } = useSite();
  const color = LEVEL_COLORS[entry.level] || 'var(--text-2)';
  const ts    = new Date(entry.ts).toLocaleTimeString(locale, { hour12 });
  return (
    <div style={{ display: 'flex', gap: '0.6rem', padding: '0.15rem 0',
      borderBottom: '1px solid color-mix(in srgb, var(--border) 40%, transparent)' }}>
      <span style={{ fontFamily: 'monospace', fontSize: '0.72rem', color: 'var(--text-3)', flexShrink: 0 }}>{ts}</span>
      <span style={{ fontFamily: 'monospace', fontSize: '0.7rem', color: clientColor, flexShrink: 0, maxWidth: '110px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{clientName}</span>
      <span style={{ fontFamily: 'monospace', fontSize: '0.7rem', color, flexShrink: 0, minWidth: '40px' }}>{entry.level}</span>
      <span style={{ fontFamily: 'monospace', fontSize: '0.75rem', color: 'var(--text-1)', wordBreak: 'break-all', lineHeight: 1.4 }}>{entry.msg}</span>
    </div>
  );
}

export default function ClientLogs() {
  const [logs, setLogs]         = useState([]);
  const [clients, setClients]   = useState([]);
  const [selected, setSelected] = useState('all');
  const [paused, setPaused]     = useState(false);
  const scrollBoxRef            = useRef(null);
  const pausedRef                = useRef(false);
  pausedRef.current = paused;

  // Client list, for the filter dropdown's display names
  useEffect(() => {
    adminFetchSdrClients().then(c => setClients(Array.isArray(c) ? c : [])).catch(() => {});
  }, []);

  // Buffered history, merged across every client
  useEffect(() => {
    adminFetchClientLogs().then(setLogs).catch(console.warn);
  }, []);

  // Live tail — one subscription covers every client; the dropdown just filters what's shown
  useEffect(() => {
    sendWsMessage({ type: 'watch_all_client_logs' });
    const unsub = subscribeWsMessages(data => {
      if (data.type !== 'client_log' || pausedRef.current) return;
      setLogs(prev => {
        const next = [...prev, { clientId: data.clientId, ts: data.ts, level: data.level, msg: data.msg }];
        return next.length > MAX_LINES ? next.slice(-MAX_LINES) : next;
      });
    });
    return () => { sendWsMessage({ type: 'unwatch_all_client_logs' }); unsub(); };
  }, []);

  useEffect(() => {
    if (!paused && scrollBoxRef.current) {
      scrollBoxRef.current.scrollTop = scrollBoxRef.current.scrollHeight;
    }
  }, [logs, paused, selected]);

  const nameFor  = (id) => clients.find(c => c.id === id)?.displayName || id;
  const colorFor = (id) => clients.find(c => c.id === id)?.color || 'var(--accent-blue)';

  const visible = useMemo(
    () => selected === 'all' ? logs : logs.filter(l => l.clientId === selected),
    [logs, selected]
  );

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.75rem', flexShrink: 0, flexWrap: 'wrap' }}>
        <h2 style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--text-1)', display: 'flex', alignItems: 'center', gap: '0.5rem', margin: 0 }}>
          <Terminal size={16} style={{ color: 'var(--accent-green)' }} /> Client Logs
        </h2>
        <div style={{ display: 'flex', gap: '0.5rem', marginLeft: 'auto', alignItems: 'center', flexWrap: 'wrap' }}>
          <select value={selected} onChange={e => setSelected(e.target.value)} className="pm-input"
            style={{ fontSize: '0.75rem', padding: '0.3rem 0.5rem' }}>
            <option value="all">All clients</option>
            {clients.map(c => <option key={c.id} value={c.id}>{c.displayName || c.id}</option>)}
          </select>
          <button className="pm-btn" onClick={() => setPaused(p => !p)} style={{ fontSize: '0.75rem' }}>
            {paused ? <PlayCircle size={13} /> : <PauseCircle size={13} />}
            {paused ? 'Resume' : 'Pause'}
          </button>
          <button className="pm-btn pm-btn-danger" onClick={() => setLogs([])} style={{ fontSize: '0.75rem' }}>
            <Trash2 size={13} /> Clear
          </button>
        </div>
      </div>

      <div ref={scrollBoxRef} style={{
        flex: 1, overflow: 'hidden auto', background: 'var(--bg-0)',
        border: '1px solid var(--border)', borderRadius: '0.5rem',
        padding: '0.5rem 0.75rem', minHeight: '200px',
      }}>
        {visible.length === 0
          ? <div style={{ color: 'var(--text-3)', fontSize: '0.8rem', paddingTop: '0.5rem', fontFamily: 'monospace' }}>
              No logs yet — connect a remote client, or wait for it to log something.
            </div>
          : visible.map((e, i) => <LogLine key={i} entry={e} clientName={nameFor(e.clientId)} clientColor={colorFor(e.clientId)} />)
        }
      </div>

      <div style={{ marginTop: '0.4rem', fontSize: '0.7rem', color: 'var(--text-3)', fontFamily: 'monospace' }}>
        {visible.length} lines {paused ? '(paused)' : '(live)'}
      </div>
    </div>
  );
}
