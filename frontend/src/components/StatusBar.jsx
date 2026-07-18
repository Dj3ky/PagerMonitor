import { useRef, useLayoutEffect, useState, useEffect } from 'react';
import { Activity, Wifi, WifiOff, Clock, HardDrive, RefreshCw, GitCommit } from 'lucide-react';
import { useSite } from '../context/SiteContext.jsx';

function fmtSilent(sec) {
  if (sec < 60)        return `${sec}s ago`;
  if (sec < 3600)      return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400)     return `${Math.floor(sec / 3600)}h ago`;
  if (sec < 86400 * 30) return `${Math.floor(sec / 86400)}d ago`;
  return 'offline';
}

function fmtTime(ts, locale, hour12) {
  if (!ts) return '—';
  return new Date(ts).toLocaleTimeString(locale, {
    hour12, hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
}

function SdrDot({ on, title }) {
  return (
    <span title={title} style={{ display:'inline-flex', alignItems:'center' }}>
      <span style={{
        width:'7px', height:'7px', borderRadius:'50%', flexShrink:0,
        background: on ? 'var(--accent-green)' : 'var(--accent-red)',
        boxShadow:  on ? 'var(--glow-green)'   : 'var(--glow-red)',
        animation:  on ? 'blink 2s ease-in-out infinite' : 'none',
      }}/>
    </span>
  );
}

function StatusItems({ sdrStatus, serverStatus, wsStatus, messageCount, latestSha, onNavigate }) {
  const { locale, hour12 } = useSite();
  const sdrRunning  = sdrStatus?.running ?? false;
  const sdrDisabled = serverStatus?.sdrDisabled ?? false;
  const total       = serverStatus?.stats?.total;

  return (
    <>
      <span style={{ display:'inline-flex', alignItems:'center', gap:'0.35rem' }}>
        {sdrDisabled ? (() => {
          const clients = serverStatus?.sdrClients ?? [];
          if (clients.length === 0) return (
            <span style={{ fontWeight:700, color:'var(--text-3)' }}>SDR: REMOTE</span>
          );
          const allActive  = clients.every(c => c.online && c.sdrRunning !== false);
          const someActive = clients.some(c => c.online && c.sdrRunning !== false);
          const anyOnline  = clients.some(c => c.online);
          // Build per-client tooltips, then merge them onto the text label too
          const clientTips = clients.map(c => {
            const name  = c.displayName || c.id;
            const sdrOk = c.online && c.sdrRunning !== false;
            if (!c.online) return `${name}${c.freq ? ` · ${c.freq}` : ''} · OFFLINE · ${fmtSilent(c.silentSec)}`;
            if (sdrOk)     return `${name}${c.freq ? ` · ${c.freq}` : ''}${c.protocols ? ` · ${c.protocols}` : ''} · SDR ACTIVE`;
            return `${name} · ONLINE · SDR not running`;
          });
          const combinedTip = clientTips.join('\n');
          return (<>
            {clients.map((c, i) => {
              const sdrOk   = c.online && c.sdrRunning !== false;
              const dotBg   = sdrOk ? 'var(--accent-green)' : c.online ? 'var(--accent-amber)' : 'var(--accent-red)';
              const dotGlow = sdrOk ? 'var(--glow-green)'   : c.online ? 'var(--glow-amber)'   : 'var(--glow-red)';
              return (
                <span key={i} title={clientTips[i]} style={{ display:'inline-flex', alignItems:'center' }}>
                  <span style={{
                    width:'7px', height:'7px', borderRadius:'50%',
                    background: dotBg, boxShadow: dotGlow,
                    animation:  c.online ? 'blink 2s ease-in-out infinite' : 'none',
                    flexShrink: 0,
                  }}/>
                </span>
              );
            })}
            <span title={combinedTip} style={{ fontWeight:700,
              color: allActive ? 'var(--accent-green)' : someActive || anyOnline ? 'var(--accent-amber)' : 'var(--accent-red)',
              cursor:'default' }}>
              SDR {allActive ? 'ACTIVE' : someActive ? 'PARTIAL' : 'OFFLINE'}
            </span>
          </>);
        })() : sdrStatus?.dongleStatuses?.length > 1 ? (() => {
          // Build per-dongle tooltips, then merge them onto the text label too
          const dongleTips = sdrStatus.dongleStatuses.map(d => d.running
            ? `Dongle ${d.device} · ${d.freq}${d.protocols ? ` · ${d.protocols}` : ''} · ACTIVE`
            : `Dongle ${d.device} · ${d.freq} · OFFLINE${d.error ? ` · ${d.error}` : ''}`
          );
          const combinedTip = dongleTips.join('\n');
          const allOn  = sdrStatus.dongleStatuses.every(d => d.running);
          const someOn = sdrStatus.dongleStatuses.some(d => d.running);
          return (<>
            {sdrStatus.dongleStatuses.map((d, i) => (
              <SdrDot key={i} on={d.running} title={dongleTips[i]} />
            ))}
            <span title={combinedTip} style={{ fontWeight:700, cursor:'default',
              color: allOn ? 'var(--accent-green)' : someOn ? 'var(--accent-amber)' : 'var(--accent-red)' }}>
              SDR {allOn ? 'ACTIVE' : someOn ? 'PARTIAL' : 'OFFLINE'}
            </span>
          </>);
        })() : (() => {
          const freq      = sdrStatus?.freq;
          const protocols = Array.isArray(sdrStatus?.protocols) ? sdrStatus.protocols.join(' ') : sdrStatus?.protocols;
          const tip = sdrRunning
            ? `${freq ? `${freq} · ` : ''}${protocols ? `${protocols} · ` : ''}ACTIVE`
            : `SDR OFFLINE${sdrStatus?.error ? ` · ${sdrStatus.error}` : ''}`;
          return (<>
            <SdrDot on={sdrRunning} title={tip} />
            <span title={tip} style={{ fontWeight:700, cursor:'default',
              color: sdrRunning ? 'var(--accent-green)' : 'var(--accent-red)' }}>
              SDR {sdrRunning ? 'ACTIVE' : 'OFFLINE'}
            </span>
          </>);
        })()}
      </span>
      <span style={{ opacity:0.3 }}>·</span>
      <span style={{ display:'inline-flex', alignItems:'center', gap:'0.3rem' }}
        title={`WebSocket ${wsStatus}`}>
        {wsStatus === 'open'
          ? <Wifi size={10} style={{ color:'var(--accent-green)' }} />
          : wsStatus === 'restarting'
          ? <RefreshCw size={10} style={{ color:'var(--accent-amber)' }} />
          : <WifiOff size={10} style={{ color:'var(--accent-red)' }} />}
        <span style={{ color: wsStatus === 'open' ? 'var(--accent-green)' : wsStatus === 'restarting' ? 'var(--accent-amber)' : 'var(--accent-red)' }}>
          WS: {wsStatus.toUpperCase()}
        </span>
      </span>
      <span style={{ opacity:0.3 }}>·</span>
      <span style={{ display:'inline-flex', alignItems:'center', gap:'0.3rem' }}
        title={`${messageCount} live${total != null ? ` · ${total} total` : ''}`}>
        <Activity size={10} />
        {messageCount} live
        {total != null && <span style={{ opacity:0.6 }}>/ {total} total</span>}
      </span>
      {sdrStatus?.lastMessage && <>
        <span style={{ opacity:0.3 }}>·</span>
        <span style={{ display:'inline-flex', alignItems:'center', gap:'0.3rem' }}>
          <Clock size={10} />
          Last: {fmtTime(sdrStatus.lastMessage, locale, hour12)}
        </span>
      </>}
      {sdrStatus?.restarts > 0 && <>
        <span style={{ opacity:0.3 }}>·</span>
        <span style={{ display:'inline-flex', alignItems:'center', gap:'0.3rem', color:'var(--accent-amber)' }}>
          <RefreshCw size={10} />
          {sdrStatus.restarts} restart{sdrStatus.restarts !== 1 ? 's' : ''}
        </span>
      </>}
      {serverStatus?.memory && <>
        <span style={{ opacity:0.3 }}>·</span>
        <span style={{ display:'inline-flex', alignItems:'center', gap:'0.3rem' }}>
          <HardDrive size={10} />
          {Math.round(serverStatus.memory.rss / 1024 / 1024)}MB
        </span>
      </>}
      {sdrStatus?.deadAir === 'alert' && (() => {
        const sources = sdrStatus.deadAirSources || [];
        const count   = sources.length;
        const suffix  = count > 1
          ? ` ×${count}`
          : count === 1 ? `: ${sources[0].id}` : '';
        const tip = count > 0
          ? `Silent: ${sources.map(s => s.id).join(', ')}`
          : 'No messages received';
        return (<>
          <span style={{ opacity:0.3 }}>·</span>
          <span style={{ display:'inline-flex', alignItems:'center', gap:'0.3rem', color:'var(--accent-red)', fontWeight:700 }}
            title={tip}>
            ⚠ DEAD AIR{suffix}
          </span>
        </>);
      })()}
      {sdrStatus?.error && <>
        <span style={{ opacity:0.3 }}>·</span>
        <span style={{ color:'var(--accent-red)' }}>{sdrStatus.error}</span>
      </>}

      {/* ── Update availability badges (only shown when an update exists) ── */}
      {(() => {
        if (!latestSha) return null;
        const serverHash  = serverStatus?.gitHash;
        const sdrClients  = serverStatus?.sdrClients;

        const serverUpdate = serverHash && latestSha !== serverHash;
        // Any online client that has reported a hash and it differs from latest
        const clientUpdate = Array.isArray(sdrClients) &&
          sdrClients.some(c => c.gitHash && latestSha !== c.gitHash);

        if (!serverUpdate && !clientUpdate) return null;

        const btnStyle = {
          background: 'none', border: 'none', padding: 0, margin: 0,
          cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '0.3rem',
          color: 'var(--accent-amber)', fontFamily: 'monospace', fontSize: 'inherit',
          fontWeight: 700,
        };

        return (<>
          <span style={{ opacity:0.3 }}>·</span>
          {serverUpdate && (
            <button style={btnStyle}
              title={`Server update available\nInstalled: ${serverHash?.slice(0,7)} · GitHub: ${latestSha.slice(0,7)}\nClick to go to Update page`}
              onClick={() => onNavigate?.('update')}>
              <GitCommit size={10}/> Server update
            </button>
          )}
          {serverUpdate && clientUpdate && <span style={{ opacity:0.3 }}>·</span>}
          {clientUpdate && (
            <button style={btnStyle}
              title={`One or more clients have an update available\nClick to go to SDR Clients`}
              onClick={() => onNavigate?.('sdrclients')}>
              <GitCommit size={10}/> Client update
            </button>
          )}
        </>);
      })()}
    </>
  );
}

// The jump-free trick:
// 1. The ticker-wrap has CSS animation running normally
// 2. Before each React re-render commits, we read the CURRENT translateX from
//    the computed matrix (actual rendered position, not the keyframe offset)
// 3. We convert that pixel offset back to a negative animation-delay
// 4. The animation continues seamlessly from where it was
function MobileTicker({ sdrStatus, serverStatus, wsStatus, messageCount, latestSha, onNavigate }) {
  const wrapRef  = useRef(null);
  const startRef = useRef(null); // when animation effectively started (ms)

  // useLayoutEffect fires BEFORE browser paint — perfect for freezing position
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;

    // Read the actual rendered transform matrix to get current translateX
    const matrix    = window.getComputedStyle(el).transform;
    const currentX  = matrix && matrix !== 'none'
      ? parseFloat(matrix.split(',')[4]) // matrix(a,b,c,d, TX, TY)
      : 0;

    // The animation moves from 0 to -50% of total width
    const totalW    = el.scrollWidth / 2; // half because content is doubled
    if (totalW === 0) return;

    // Convert current pixel offset to a fraction of the animation
    const fraction  = Math.abs(currentX) / totalW;
    const duration  = 22000; // ms — must match CSS

    // Reset animation with negative delay = "start this far in"
    el.style.animation = 'none';
    // Force reflow so the browser registers the change
    void el.offsetWidth;
    el.style.animation = `tickerMove ${duration}ms linear infinite`;
    el.style.animationDelay = `-${(fraction * duration).toFixed(0)}ms`;
  });

  return (
    <div style={{ overflow:'hidden', height:'26px', position:'relative',
      background:'var(--bg-1)', borderBottom:'1px solid var(--border)', display:'none' }}
      className="statusbar-mobile">
      <div ref={wrapRef} className="ticker-wrap">
        <span className="ticker-copy">
          <StatusItems sdrStatus={sdrStatus} serverStatus={serverStatus}
            wsStatus={wsStatus} messageCount={messageCount} latestSha={latestSha} onNavigate={onNavigate} />
        </span>
        <span className="ticker-copy">
          <StatusItems sdrStatus={sdrStatus} serverStatus={serverStatus}
            wsStatus={wsStatus} messageCount={messageCount} latestSha={latestSha} onNavigate={onNavigate} />
        </span>
      </div>
    </div>
  );
}

function LiveClock() {
  const { locale, hour12 } = useSite();
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <span style={{ display:'inline-flex', alignItems:'center', gap:'0.3rem', marginLeft:'auto', color:'var(--text-2)', flexShrink:0 }}>
      <Clock size={10} />
      {now.toLocaleDateString(locale, { day:'numeric', month:'numeric', year:'numeric' }).replace(/\s/g, '')}
      {' '}
      {now.toLocaleTimeString(locale, { hour:'2-digit', minute:'2-digit', second:'2-digit', hour12 })}
    </span>
  );
}

export default function StatusBar({ sdrStatus, serverStatus, wsStatus, messageCount, latestSha, onNavigate }) {
  return (
    <>
      {/* Desktop — static flex row */}
      <div className="statusbar-desktop" style={{
        flexShrink:0, display:'flex', alignItems:'center', gap:'0.9rem',
        padding:'0.25rem 0.75rem', overflow:'hidden', flexWrap:'nowrap',
        background:'var(--bg-1)', borderBottom:'1px solid var(--border)',
        fontFamily:'monospace', fontSize:'0.75rem', color:'var(--text-3)',
      }}>
        <StatusItems sdrStatus={sdrStatus} serverStatus={serverStatus}
          wsStatus={wsStatus} messageCount={messageCount} latestSha={latestSha} onNavigate={onNavigate} />
        <LiveClock />
      </div>

      {/* Mobile — scrolling ticker (hidden on desktop via CSS) */}
      <MobileTicker sdrStatus={sdrStatus} serverStatus={serverStatus}
        wsStatus={wsStatus} messageCount={messageCount} latestSha={latestSha} onNavigate={onNavigate} />

      <style>{`
        @keyframes tickerMove {
          from { transform: translateX(0); }
          to   { transform: translateX(-50%); }
        }
        .ticker-wrap {
          display: inline-flex;
          align-items: center;
          white-space: nowrap;
          height: 26px;
          font-family: monospace;
          font-size: 0.72rem;
          color: var(--text-3);
          animation: tickerMove 22s linear infinite;
          will-change: transform;
        }
        .ticker-wrap:hover {
          animation-play-state: paused;
        }
        .ticker-copy {
          display: inline-flex;
          align-items: center;
          gap: 0.75rem;
          padding: 0 2.5rem;
        }
        @media (max-width: 640px) {
          .statusbar-desktop { display: none !important; }
          .statusbar-mobile  { display: block !important; }
        }
      `}</style>
    </>
  );
}
