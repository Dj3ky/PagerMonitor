import { useState, useEffect, useRef } from 'react';
import { RefreshCw, CheckCircle, AlertCircle, GitCommit, Loader } from 'lucide-react';
import { adminFetchUpdateStatus } from '../../utils/api.js';

const GITHUB_REPO    = 'Dj3ky/PagerMonitor';
const GITHUB_API_URL = `https://api.github.com/repos/${GITHUB_REPO}/commits/main`;
const BASE           = import.meta.env.VITE_BACKEND_URL || '';

function getToken() { return localStorage.getItem('pm_token') || ''; }

export default function UpdatePanel() {
  const [localInfo,  setLocalInfo]  = useState(null);   // { version, localHash, localDate, localCommits }
  const [remoteInfo, setRemoteInfo] = useState(null);   // { sha, date } from GitHub
  const [loading,    setLoading]    = useState(true);
  const [error,      setError]      = useState(null);

  const [status,  setStatus]  = useState('idle'); // idle | running | restarting | done | error
  const [logLines, setLogLines] = useState([]);
  const scrollRef = useRef(null);

  // ── Fetch version info ──────────────────────────────────────────────────────
  const fetchInfo = async () => {
    setLoading(true);
    setError(null);
    try {
      const [local, remote] = await Promise.all([
        adminFetchUpdateStatus(),
        fetch(GITHUB_API_URL).then(r => r.ok ? r.json() : null).catch(() => null),
      ]);
      setLocalInfo(local);
      if (remote) setRemoteInfo({ sha: remote.sha, date: remote.commit?.committer?.date });
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchInfo(); }, []);

  // ── Auto-scroll log ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [logLines]);

  // ── Poll for server back up after restart ───────────────────────────────────
  useEffect(() => {
    if (status !== 'restarting') return;
    let tries = 0;
    const poll = setInterval(async () => {
      tries++;
      try {
        const r = await fetch(`${BASE}/api/status`);
        if (r.ok) { clearInterval(poll); window.location.reload(); }
      } catch (_) {}
      if (tries > 60) clearInterval(poll); // give up after 2 min
    }, 2000);
    return () => clearInterval(poll);
  }, [status]);

  // ── Run update ──────────────────────────────────────────────────────────────
  const startUpdate = async () => {
    setStatus('running');
    setLogLines([]);

    try {
      const res = await fetch(`${BASE}/admin/update`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${getToken()}` },
      });
      if (!res.ok) { setStatus('error'); return; }

      const reader  = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split('\n\n');
        buf = parts.pop();
        for (const part of parts) {
          const raw = part.replace(/^data:\s*/, '').trim();
          if (!raw || raw.startsWith(':')) continue;
          try {
            const obj = JSON.parse(raw);
            if      (obj.type === 'log')        setLogLines(p => [...p, { text: obj.text, err: !!obj.err }]);
            else if (obj.type === 'restarting') setStatus('restarting');
            else if (obj.type === 'error')      { setLogLines(p => [...p, { text: obj.text, err: true }]); setStatus('error'); }
          } catch (_) {}
        }
      }
    } catch (e) {
      // If status is already 'restarting', the disconnect is expected
      if (status !== 'restarting') {
        setStatus('error');
        setLogLines(p => [...p, { text: e.message, err: true }]);
      }
    }
  };

  // ── Derived state ───────────────────────────────────────────────────────────
  const upToDate   = localInfo && remoteInfo && localInfo.localCommits === remoteInfo.sha;
  const hasUpdate  = localInfo && remoteInfo && localInfo.localCommits !== remoteInfo.sha;
  const localShort = localInfo?.localHash;
  const remShort   = remoteInfo?.sha?.slice(0, 7);
  const localDateF = localInfo?.localDate  ? new Date(localInfo.localDate).toLocaleDateString()  : '—';
  const remDateF   = remoteInfo?.date      ? new Date(remoteInfo.date).toLocaleDateString()      : '—';

  const col = v => `var(--accent-${v})`;

  return (
    <div style={{ maxWidth: '720px' }}>
      <h2 style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--text-1)', marginBottom: '1.25rem' }}>
        System Update
      </h2>

      {/* ── Version status card ─────────────────────────────────────── */}
      <div style={{ background: 'var(--bg-1)', border: '1px solid var(--border)',
        borderRadius: '0.6rem', padding: '1rem 1.25rem', marginBottom: '1.25rem' }}>

        {loading && (
          <div style={{ color: 'var(--text-3)', fontSize: '0.82rem', display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <Loader size={13} style={{ animation: 'spin 1s linear infinite' }} /> Checking versions…
          </div>
        )}

        {error && !loading && (
          <div style={{ color: col('red'), fontSize: '0.82rem' }}>
            <AlertCircle size={13} style={{ marginRight: '0.4rem' }} />
            {error}
          </div>
        )}

        {!loading && localInfo && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem 2rem' }}>
            {/* Installed */}
            <div>
              <div style={{ fontSize: '0.65rem', textTransform: 'uppercase', letterSpacing: '0.08em',
                color: 'var(--text-3)', marginBottom: '0.25rem' }}>Installed</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                <GitCommit size={13} style={{ color: col('green') }} />
                <span style={{ fontFamily: 'monospace', fontSize: '0.82rem', color: 'var(--text-1)' }}>
                  {localShort || '—'}
                </span>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-3)' }}>{localDateF}</span>
              </div>
              <div style={{ fontSize: '0.72rem', color: 'var(--text-3)', marginTop: '0.2rem' }}>
                v{localInfo.version}
              </div>
            </div>

            {/* Latest on GitHub */}
            <div>
              <div style={{ fontSize: '0.65rem', textTransform: 'uppercase', letterSpacing: '0.08em',
                color: 'var(--text-3)', marginBottom: '0.25rem' }}>Latest on GitHub</div>
              {remoteInfo ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                  <GitCommit size={13} style={{ color: hasUpdate ? col('amber') : col('green') }} />
                  <span style={{ fontFamily: 'monospace', fontSize: '0.82rem', color: 'var(--text-1)' }}>
                    {remShort || '—'}
                  </span>
                  <span style={{ fontSize: '0.75rem', color: 'var(--text-3)' }}>{remDateF}</span>
                </div>
              ) : (
                <span style={{ fontSize: '0.8rem', color: 'var(--text-3)' }}>Cannot reach GitHub</span>
              )}
            </div>

            {/* Status badge */}
            <div style={{ gridColumn: '1 / -1', marginTop: '0.25rem' }}>
              {upToDate && (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem',
                  fontSize: '0.78rem', color: col('green') }}>
                  <CheckCircle size={13} /> Up to date
                </span>
              )}
              {hasUpdate && (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem',
                  fontSize: '0.78rem', color: col('amber') }}>
                  <RefreshCw size={13} /> Update available ({localShort} → {remShort})
                </span>
              )}
              {!remoteInfo && localInfo && (
                <span style={{ fontSize: '0.78rem', color: 'var(--text-3)' }}>
                  Cannot compare — GitHub unreachable
                </span>
              )}
            </div>
          </div>
        )}
      </div>

      {/* ── Action buttons ──────────────────────────────────────────── */}
      {status === 'idle' && !loading && (
        <div style={{ display: 'flex', gap: '0.75rem', marginBottom: '1.25rem' }}>
          <button className="pm-btn pm-btn-primary" onClick={startUpdate}
            style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
            <RefreshCw size={14} />
            {hasUpdate ? 'Update Now' : 'Check & Update'}
          </button>
          <button className="pm-btn" onClick={fetchInfo}
            style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.8rem' }}>
            <RefreshCw size={12} /> Refresh
          </button>
        </div>
      )}

      {status === 'running' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem',
          marginBottom: '1rem', fontSize: '0.82rem', color: col('blue') }}>
          <Loader size={14} style={{ animation: 'spin 1s linear infinite' }} />
          Update in progress — do not close this page…
        </div>
      )}

      {status === 'restarting' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem',
          marginBottom: '1rem', fontSize: '0.82rem', color: col('amber') }}>
          <Loader size={14} style={{ animation: 'spin 1s linear infinite' }} />
          Service restarting — page will reload automatically…
        </div>
      )}

      {status === 'error' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem',
          marginBottom: '1rem', fontSize: '0.82rem', color: col('red') }}>
          <AlertCircle size={14} />
          Update failed — see log below.
          <button className="pm-btn" onClick={() => { setStatus('idle'); setLogLines([]); }}
            style={{ marginLeft: '0.5rem', fontSize: '0.75rem' }}>Try Again</button>
        </div>
      )}

      {/* ── Live log output ─────────────────────────────────────────── */}
      {logLines.length > 0 && (
        <div ref={scrollRef} style={{
          background: 'var(--bg-0)', border: '1px solid var(--border)',
          borderRadius: '0.5rem', padding: '0.6rem 0.75rem',
          maxHeight: '420px', overflowY: 'auto', fontFamily: 'monospace', fontSize: '0.72rem',
        }}>
          {logLines.map((l, i) => (
            <div key={i} style={{
              color: l.err ? col('red') : 'var(--text-1)',
              padding: '0.05rem 0', lineHeight: 1.5,
              borderBottom: '1px solid color-mix(in srgb, var(--border) 30%, transparent)',
            }}>
              {l.text}
            </div>
          ))}
        </div>
      )}

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}
