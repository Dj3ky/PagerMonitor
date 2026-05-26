import { useState, useEffect, useRef } from 'react';
import MessageRow from './MessageRow.jsx';
import { useSite } from '../context/SiteContext.jsx';
import { fetchLastSeen, saveLastSeen } from '../utils/api.js';

const BADGE_COL_WIDTH = '130px';

function FeedHeader() {
  const cell = (label, style) => (
    <span style={{ fontFamily:'monospace', fontSize:'0.6rem', fontWeight:700,
      textTransform:'uppercase', letterSpacing:'0.08em', color:'var(--text-3)', ...style }}>
      {label}
    </span>
  );
  return (
    <div className="feed-header" style={{ display:'flex', alignItems:'center', gap:'0.5rem',
      padding:'0.28rem 0.75rem',
      background:'color-mix(in srgb, var(--bg-2) 85%, transparent)',
      backdropFilter:'blur(8px)', WebkitBackdropFilter:'blur(8px)',
      borderBottom:'1px solid var(--border)', borderLeft:'3px solid transparent',
      position:'sticky', top:0, zIndex:2 }}>
      <span style={{ width:'12px', flexShrink:0 }} />
      {cell('Date / Time',   { flexShrink:0, minWidth:'62px', textAlign:'right' })}
      {cell('Capcode',       { flexShrink:0, minWidth:'70px', textAlign:'center' })}
      {cell('Alias / Group', { flexShrink:0, width: BADGE_COL_WIDTH, textAlign:'center' })}
      {cell('Message',       { flex:1 })}
    </div>
  );
}

export default function MessageFeed({ messages, highlightRules = [], groups = [], onFilter, onMapClick, onLoadMore, loadingMore, noMoreMessages, totalInDb, totalLoaded, onDelete }) {
  // settingsLoaded is true once the /api/site-settings fetch has resolved (success or fail).
  // We must NOT start the badge timer until then — otherwise a slow mobile network causes
  // the timer to fire with the hard-coded default (10 s) before the real configured value
  // arrives, permanently clearing the NEW badges too early.
  const { newBadgeSeconds = 10, settingsLoaded = true } = useSite();

  // lastSeenId from the server — tracks per-user across all devices
  const [lastSeenId, setLastSeenId] = useState(null); // null = not yet loaded
  const markSeenTimer = useRef(null);
  const pendingMarkId = useRef(null);

  // Load user's last-seen from server on mount
  useEffect(() => {
    fetchLastSeen()
      .then(d => setLastSeenId(d.lastSeenId ?? 0))
      .catch(() => setLastSeenId(0)); // if fetch fails, show nothing as new
  }, []);

  // When messages change or lastSeenId loads, schedule marking as seen.
  // Guards:
  //   1. Wait for settingsLoaded so we use the real configured duration, not the
  //      hard-coded default that is in place while the settings fetch is in flight.
  //   2. pendingMarkId is a HIGH-WATER MARK — it must never go backwards.
  //      `messages` is a paginated slice so messages[0] is the newest on the
  //      *current page*, not the global newest. If the user switches to an older
  //      page, topId can be lower than what we already recorded. Without the
  //      max() guard the timer would save that lower id to the server, causing
  //      already-seen messages to reappear as NEW on the next visit.
  useEffect(() => {
    if (!settingsLoaded) return;
    if (lastSeenId === null || messages.length === 0) return;
    const topId = messages[0]?.id ?? 0;

    // High-water mark: advance only, never regress
    const highestNew = Math.max(pendingMarkId.current ?? 0, topId);
    if (highestNew <= lastSeenId) {
      clearTimeout(markSeenTimer.current);
      return;
    }
    pendingMarkId.current = highestNew;

    clearTimeout(markSeenTimer.current);
    markSeenTimer.current = setTimeout(() => {
      const id = pendingMarkId.current;
      if (!id) return;
      setLastSeenId(id);
      saveLastSeen(id).catch(() => {}); // fire-and-forget, non-critical
    }, newBadgeSeconds * 1000);

    return () => clearTimeout(markSeenTimer.current);
  }, [messages, lastSeenId, newBadgeSeconds, settingsLoaded]);

  // When tab regains focus, restart the countdown with the same high-water mark
  useEffect(() => {
    const onFocus = () => {
      if (!settingsLoaded) return;
      if (lastSeenId === null || messages.length === 0) return;
      const topId = messages[0]?.id ?? 0;
      const highestNew = Math.max(pendingMarkId.current ?? 0, topId);
      if (highestNew <= lastSeenId) return;
      pendingMarkId.current = highestNew;
      clearTimeout(markSeenTimer.current);
      markSeenTimer.current = setTimeout(() => {
        const id = pendingMarkId.current;
        if (!id) return;
        setLastSeenId(id);
        saveLastSeen(id).catch(() => {});
      }, newBadgeSeconds * 1000);
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [messages, lastSeenId, newBadgeSeconds, settingsLoaded]);

  useEffect(() => () => clearTimeout(markSeenTimer.current), []);

  if (messages.length === 0) {
    return (
      <div style={{ display:'flex', flexDirection:'column', alignItems:'center',
        justifyContent:'center', height:'100%', color:'var(--text-3)', gap:'0.5rem' }}>
        <div style={{ fontSize:'3rem', opacity:0.2 }}>📟</div>
        <p style={{ fontFamily:'monospace', fontSize:'0.85rem', margin:0 }}>Waiting for transmissions…</p>
      </div>
    );
  }

  return (
    <div style={{ height:'100%', overflowY:'auto', display:'flex', flexDirection:'column' }}>
      <FeedHeader />
      {messages.map((msg, i) => {
        const msgId = msg.id ?? 0;
        const isNew = lastSeenId !== null && msgId > lastSeenId;
        return (
          <MessageRow key={msgId || i}
            msg={msg}
            index={i}
            isNew={isNew}
            highlightRules={highlightRules}
            groups={groups}
            onFilter={onFilter}
            onMapClick={onMapClick}
            onDelete={onDelete} />
        );
      })}

      {/* Load more — only shown on last page when there are more messages in DB */}
      {onLoadMore && !noMoreMessages && totalLoaded < totalInDb && (
        <div style={{ padding:'0.75rem', textAlign:'center', flexShrink:0 }}>
          <button onClick={onLoadMore} disabled={loadingMore}
            style={{ padding:'0.4rem 1.25rem', borderRadius:'0.5rem', cursor: loadingMore ? 'wait' : 'pointer',
              fontSize:'0.8rem', fontFamily:'monospace', fontWeight:600,
              background:'color-mix(in srgb,var(--accent-green) 10%,transparent)',
              border:'1px solid color-mix(in srgb,var(--accent-green) 25%,transparent)',
              color: loadingMore ? 'var(--text-3)' : 'var(--accent-green)',
              transition:'all 0.15s' }}>
            {loadingMore ? 'Loading…' : `Load more  (${totalLoaded} of ${totalInDb} loaded)`}
          </button>
        </div>
      )}

      <style>{`
        @media(max-width:600px){.feed-header{display:none!important}}
        @keyframes new-pulse { 0%,100%{opacity:1} 50%{opacity:0.45} }
      `}</style>
    </div>
  );
}
