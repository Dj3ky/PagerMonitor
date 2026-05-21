import { useRef, useLayoutEffect } from 'react';
import { Activity, Wifi, WifiOff, Clock, HardDrive, RefreshCw } from 'lucide-react';

function fmt24(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleTimeString('sl-SI', {
    hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
}

function Dot({ on }) {
  return (
    <span style={{ width:'7px', height:'7px', borderRadius:'50%', flexShrink:0, display:'inline-block',
      background: on ? 'var(--accent-green)' : 'var(--accent-red)',
      boxShadow: on ? '0 0 6px var(--accent-green)' : 'none' }} />
  );
}

function StatusItems({ sdrStatus, serverStatus, wsStatus, messageCount }) {
  const sdrRunning = sdrStatus?.running ?? false;
  const total      = serverStatus?.stats?.total;

  return (
    <>
      <span style={{ display:'inline-flex', alignItems:'center', gap:'0.35rem' }}
        title={sdrRunning ? 'SDR active' : 'SDR offline'}>
        {/* Multi-dongle: show individual dots */}
        {sdrStatus?.dongleStatuses?.length > 1 ? (
          <>
            {sdrStatus.dongleStatuses.map((d, i) => {
              const ok = d.running;
              const tip = ok
                ? `Dongle ${d.device} (${d.freq}) — OK`
                : `Dongle ${d.device} (${d.freq}) — DOWN${d.error ? `: ${d.error}` : ''}`;
              return (
                <span key={i} title={tip} style={{ display:'inline-flex', alignItems:'center', gap:'0.2rem' }}>
                  <span style={{
                    width:'7px', height:'7px', borderRadius:'50%',
                    background: ok ? 'var(--accent-green)' : 'var(--accent-red)',
                    boxShadow:  ok ? 'var(--glow-green)'  : 'var(--glow-red)',
                    animation:  ok ? 'blink 2s ease-in-out infinite' : 'none',
                    flexShrink: 0,
                  }}/>
                </span>
              );
            })}
            <span style={{ fontWeight:700, fontSize:'0.75rem',
              color: sdrStatus.dongleStatuses.every(d => d.running)
                ? 'var(--accent-green)'
                : sdrStatus.dongleStatuses.some(d => d.running)
                  ? 'var(--accent-amber)'
                  : 'var(--accent-red)' }}>
              SDR {sdrStatus.dongleStatuses.every(d => d.running)
                ? 'ACTIVE'
                : sdrStatus.dongleStatuses.some(d => d.running)
                  ? 'PARTIAL'
                  : 'OFFLINE'}
            </span>
          </>
        ) : (
          // Single dongle: original display
          <>
            <Dot on={sdrRunning} />
            <span style={{ fontWeight:700, color: sdrRunning ? 'var(--accent-green)' : 'var(--accent-red)' }}>
              SDR {sdrRunning ? 'ACTIVE' : 'OFFLINE'}
            </span>
          </>
        )}
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
          Last: {fmt24(sdrStatus.lastMessage)}
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
      {sdrStatus?.deadAir === 'alert' && <>
        <span style={{ opacity:0.3 }}>·</span>
        <span style={{ display:'inline-flex', alignItems:'center', gap:'0.3rem', color:'var(--accent-red)', fontWeight:700 }}
          title={`No messages from ${sdrStatus.deadAirSource || 'SDR'} since ${sdrStatus.deadAirLastMessage || 'unknown'}`}>
          ⚠ DEAD AIR{sdrStatus.deadAirDongleCount > 1 ? ` (×${sdrStatus.deadAirDongleCount})` : ''}
        </span>
      </>}
      {sdrStatus?.error && <>
        <span style={{ opacity:0.3 }}>·</span>
        <span style={{ color:'var(--accent-red)' }}>{sdrStatus.error}</span>
      </>}
    </>
  );
}

// The jump-free trick:
// 1. The ticker-wrap has CSS animation running normally
// 2. Before each React re-render commits, we read the CURRENT translateX from
//    the computed matrix (actual rendered position, not the keyframe offset)
// 3. We convert that pixel offset back to a negative animation-delay
// 4. The animation continues seamlessly from where it was
function MobileTicker({ sdrStatus, serverStatus, wsStatus, messageCount }) {
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
            wsStatus={wsStatus} messageCount={messageCount} />
        </span>
        <span className="ticker-copy">
          <StatusItems sdrStatus={sdrStatus} serverStatus={serverStatus}
            wsStatus={wsStatus} messageCount={messageCount} />
        </span>
      </div>
    </div>
  );
}

export default function StatusBar({ sdrStatus, serverStatus, wsStatus, messageCount }) {
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
          wsStatus={wsStatus} messageCount={messageCount} />
      </div>

      {/* Mobile — scrolling ticker (hidden on desktop via CSS) */}
      <MobileTicker sdrStatus={sdrStatus} serverStatus={serverStatus}
        wsStatus={wsStatus} messageCount={messageCount} />

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
