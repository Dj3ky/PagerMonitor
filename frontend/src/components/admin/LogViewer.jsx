import { useState, useEffect, useRef } from 'react';
import { Terminal, Trash2, PauseCircle, PlayCircle } from 'lucide-react';
import { adminFetchSdrLogs } from '../../utils/api.js';
import { subscribeWsMessages } from '../../hooks/useWebSocket.js';

const SOURCE_COLORS = {
  rtl_fm: 'var(--accent-blue)',
  mmon:   'var(--accent-green)',
  decode: 'var(--accent-amber)',
  system: 'var(--accent-purple)',
};

function LogLine({ entry }) {
  const color = SOURCE_COLORS[entry.source] || 'var(--text-3)';
  const ts    = new Date(entry.ts).toLocaleTimeString('sl-SI', { hour12: false });
  return (
    <div style={{ display: 'flex', gap: '0.6rem', padding: '0.15rem 0',
      borderBottom: '1px solid color-mix(in srgb, var(--border) 40%, transparent)' }}>
      <span style={{ fontFamily: 'monospace', fontSize: '0.72rem', color: 'var(--text-3)', flexShrink: 0 }}>{ts}</span>
      <span style={{ fontFamily: 'monospace', fontSize: '0.7rem', color, flexShrink: 0, minWidth: '50px' }}>{entry.source}</span>
      <span style={{ fontFamily: 'monospace', fontSize: '0.75rem', color: 'var(--text-1)', wordBreak: 'break-all', lineHeight: 1.4 }}>{entry.line}</span>
    </div>
  );
}

export default function LogViewer() {
  const [logs, setLogs]     = useState([]);
  const [paused, setPaused] = useState(false);
  const bottomRef           = useRef(null);
  const pausedRef           = useRef(false);
  pausedRef.current = paused;

  // Load initial buffer from backend
  useEffect(() => {
    adminFetchSdrLogs().then(setLogs).catch(console.warn);
  }, []);

  // Subscribe to live WS log events using the clean pub/sub API
  useEffect(() => {
    const unsub = subscribeWsMessages(data => {
      if (data.type !== 'log' || pausedRef.current) return;
      setLogs(prev => {
        const next = [...prev, { ts: data.ts, source: data.source, line: data.line }];
        return next.length > 500 ? next.slice(-500) : next;
      });
    });
    return unsub; // unsubscribes cleanly when component unmounts
  }, []);

  // Auto-scroll to bottom
  useEffect(() => {
    if (!paused) bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs, paused]);

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.75rem', flexShrink: 0, flexWrap: 'wrap' }}>
        <h2 style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--text-1)', display: 'flex', alignItems: 'center', gap: '0.5rem', margin: 0 }}>
          <Terminal size={16} style={{ color: 'var(--accent-green)' }} /> Live Process Logs
        </h2>
        <div style={{ display: 'flex', gap: '0.5rem', marginLeft: 'auto', flexWrap: 'wrap' }}>
          {Object.entries(SOURCE_COLORS).map(([src, col]) => (
            <span key={src} style={{ fontSize: '0.68rem', fontFamily: 'monospace', color: col,
              background: `color-mix(in srgb, ${col} 12%, transparent)`,
              padding: '0.15rem 0.4rem', borderRadius: '0.25rem' }}>{src}</span>
          ))}
          <button className="pm-btn" onClick={() => setPaused(p => !p)} style={{ fontSize: '0.75rem' }}>
            {paused ? <PlayCircle size={13} /> : <PauseCircle size={13} />}
            {paused ? 'Resume' : 'Pause'}
          </button>
          <button className="pm-btn pm-btn-danger" onClick={() => setLogs([])} style={{ fontSize: '0.75rem' }}>
            <Trash2 size={13} /> Clear
          </button>
        </div>
      </div>

      <div style={{
        flex: 1, overflow: 'hidden auto', background: 'var(--bg-0)',
        border: '1px solid var(--border)', borderRadius: '0.5rem',
        padding: '0.5rem 0.75rem', minHeight: '200px',
      }}>
        {logs.length === 0
          ? <div style={{ color: 'var(--text-3)', fontSize: '0.8rem', paddingTop: '0.5rem', fontFamily: 'monospace' }}>
              No logs yet — start the SDR pipeline.
            </div>
          : logs.map((e, i) => <LogLine key={i} entry={e} />)
        }
        <div ref={bottomRef} />
      </div>

      <div style={{ marginTop: '0.4rem', fontSize: '0.7rem', color: 'var(--text-3)', fontFamily: 'monospace' }}>
        {logs.length} lines {paused ? '(paused)' : '(live)'}
      </div>
    </div>
  );
}
