import { useState, useEffect } from 'react';
import { StickyNote, ChevronDown, ChevronRight, MapPin, Trash2 } from 'lucide-react';
import MessageNotes from './MessageNotes.jsx';
import { useSite } from '../context/SiteContext.jsx';
import { useAuth } from '../context/AuthContext.jsx';

const BASE = import.meta.env.VITE_BACKEND_URL || '';

function fmtTime(ts) { return new Date(ts).toLocaleTimeString('sl-SI', { hour12:false }); }
function fmtDate(ts) { return new Date(ts).toLocaleDateString('sl-SI', { day:'2-digit', month:'2-digit', year:'numeric' }); }

// Split text and highlight matching segments
function highlightSegments(text, rules) {
  if (!text || !rules?.length) return null;
  for (const rule of rules.filter(r => r.enabled && r.pattern)) {
    try {
      const escaped = rule.is_regex ? rule.pattern : rule.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re      = new RegExp(`((?:${escaped}))`, 'gi');
      const parts   = text.split(re);
      if (parts.length <= 1) continue;
      const hl = { color: rule.color || '#ffb800', bg: rule.bg || (rule.color || '#ffb800') + '35' };
      return parts.map((p, i) => ({ text:p, hl: i%2===1 ? hl : null }));
    } catch (_) {}
  }
  return null;
}

function HighlightedMsg({ text, rules, style }) {
  const segs = highlightSegments(text, rules);
  if (!segs) return <span style={style}>{text}</span>;
  return (
    <span style={style}>
      {segs.map((s, i) => s.hl ? (
        <mark key={i} style={{ background:s.hl.bg, color:s.hl.color,
          borderRadius:'0.25rem', padding:'0.1rem 0.35rem', fontWeight:700 }}>{s.text}</mark>
      ) : <span key={i}>{s.text}</span>)}
    </span>
  );
}

// Fixed-width badge column keeps alignment in desktop feed
const BADGE_COL_W = '120px';

function Badge({ label, color, title, onClick }) {
  return (
    <span onClick={e => { e.stopPropagation(); onClick?.(); }} title={title}
      style={{ fontSize:'0.62rem', fontWeight:600, padding:'0.1rem 0.4rem', borderRadius:'0.75rem',
        color, background:color+'22', border:`1px solid ${color}44`,
        whiteSpace:'nowrap', flexShrink:0,
        cursor: onClick ? 'pointer' : 'default', transition: onClick ? 'background 0.1s' : 'none' }}
      onMouseEnter={e => onClick && (e.currentTarget.style.background = color+'44')}
      onMouseLeave={e => onClick && (e.currentTarget.style.background = color+'22')}>
      {label}
    </span>
  );
}

export default function MessageRow({ msg, isNew, highlightRules=[], groups=[], onFilter, onMapClick, onDelete }) {
  const [expanded, setExpanded] = useState(false);
  const [showNotes, setShowNotes] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const { showMapButton = true } = useSite();
  const { user, token } = useAuth();
  // Only show map button if message has confirmed stored coordinates in DB
  const hasLocation  = !!(msg.lat && msg.lng);
  const isKeyAlert   = !!(window.__pm_alerts?.has(msg.id));

  const alias      = msg.alias_name || msg.alias;
  const aliasColor = msg.alias_color || '#4ade80';
  const groupName  = msg.group_name  || msg.parent_group_name;
  const groupColor = msg.group_color || msg.parent_group_color || '#a855f7';

  // Row background color: alias takes priority over group, group over parent group
  const rowColor = msg.alias_row_color || msg.group_row_color || msg.parent_group_row_color || null;
  // Row sound: alias takes priority, 'none' explicitly silences even if group has a sound
  const _aliasSound = msg.alias_row_sound;
  const _groupSound = msg.group_row_sound || msg.parent_group_row_sound;
  const rowSound = _aliasSound === 'none' ? null      // alias explicitly silent
                 : _aliasSound             ? _aliasSound  // alias has a sound
                 : _groupSound === 'none'  ? null      // group explicitly silent (edge case)
                 : _groupSound             || null;    // group sound or nothing

  // Play sound for new messages that have a row sound configured
  useEffect(() => {
    if (!rowSound || !isNew) return;
    if (window.__playAlertSound) window.__playAlertSound(rowSound);
  }, [isNew, rowSound]);

  return (
    <>
      <div
        style={{ borderBottom:'1px solid var(--border-soft)', cursor:'pointer', transition:'background 0.1s',
          background: isKeyAlert ? 'color-mix(in srgb, var(--accent-amber) 12%, var(--bg-0))'
                    : rowColor   ? `color-mix(in srgb, ${rowColor} 10%, var(--bg-0))`
                    : isNew      ? 'color-mix(in srgb, var(--accent-green) 4%, var(--bg-0))'
                    : 'transparent',
          animation: isKeyAlert ? 'keyalert-blink 0.6s ease-in-out 5' : 'none' }}
        onClick={() => setExpanded(e => !e)}
      >
        {/* ── DESKTOP row (hidden on mobile) ───────────────────── */}
        <div className="msg-desktop" style={{ display:'flex', alignItems:'center', gap:'0.5rem', padding:'0.42rem 0.75rem' }}>
          <span style={{ color:'var(--text-3)', flexShrink:0, lineHeight:1, width:'12px' }}>
            {expanded ? <ChevronDown size={11}/> : <ChevronRight size={11}/>}
          </span>
          {/* Date + Time — two lines */}
          <div style={{ fontFamily:'monospace', fontSize:'0.7rem', color:'var(--text-3)',
            flexShrink:0, minWidth:'62px', textAlign:'right', lineHeight:1.3 }}>
            <div style={{ fontSize:'0.68rem' }}>{fmtDate(msg.timestamp)}</div>
            <div>{fmtTime(msg.timestamp)}</div>
          </div>
          {/* Capcode */}
          <span onClick={e => { e.stopPropagation(); onFilter?.('capcode', msg.capcode); }}
            title="Click to filter"
            style={{ fontFamily:'monospace', fontSize:'0.78rem', fontWeight:700,
              color:'var(--accent-amber)', flexShrink:0, minWidth:'70px', cursor:'pointer',
              borderRadius:'0.2rem', padding:'0 0.1rem' }}
            onMouseEnter={e => e.currentTarget.style.background='color-mix(in srgb,var(--accent-amber) 12%,transparent)'}
            onMouseLeave={e => e.currentTarget.style.background='transparent'}>
            {msg.capcode}
          </span>
          {/* Badge column — fixed width keeps message aligned; wrap so both badges are always visible */}
          <div style={{ flexShrink:0, width:BADGE_COL_W, display:'flex', alignItems:'flex-start', gap:'0.3rem', flexWrap:'wrap' }}>
            {alias     && <Badge label={alias}     color={aliasColor} title="Filter by alias"  onClick={() => onFilter?.('alias',alias)} />}
            {groupName && <Badge label={groupName} color={groupColor} title="Filter by group"  onClick={() => onFilter?.('group',groupName)} />}
          </div>
          {/* Message */}
          <div style={{ flex:1, minWidth:0, overflow:'hidden' }}>
            {msg.message
              ? <HighlightedMsg text={msg.message} rules={highlightRules}
                  style={{ fontFamily:'monospace', fontSize:'0.82rem', display:'block',
                    overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', color:'var(--text-1)' }} />
              : <span style={{ fontFamily:'monospace', fontSize:'0.82rem', color:'var(--text-3)', fontStyle:'italic' }}>
                  [tone / numeric only]
                </span>
            }
          </div>
          {showMapButton && hasLocation && (
            <span onClick={e => { e.stopPropagation(); onMapClick?.(msg); }}
              title="Show on map"
              style={{ flexShrink:0, cursor:'pointer', color:'var(--accent-blue)', lineHeight:1,
                padding:'0.1rem', borderRadius:'0.2rem', transition:'background 0.1s' }}
              onMouseEnter={e => e.currentTarget.style.background='color-mix(in srgb,var(--accent-blue) 12%,transparent)'}
              onMouseLeave={e => e.currentTarget.style.background='transparent'}>
              <MapPin size={13}/>
            </span>
          )}
          <span onClick={e => { e.stopPropagation(); setShowNotes(n => !n); }}
            title={showNotes ? 'Hide notes' : (msg.note_count > 0 ? `${msg.note_count} note${msg.note_count !== 1 ? 's' : ''}` : 'Add note')}
            style={{ flexShrink:0, cursor:'pointer', lineHeight:1, position:'relative',
              padding:'0.1rem', borderRadius:'0.2rem', transition:'all 0.1s',
              color: showNotes ? 'var(--accent-amber)'
                   : msg.note_count > 0 ? 'var(--accent-amber)'
                   : 'var(--text-3)' }}
            onMouseEnter={e => e.currentTarget.style.color='var(--accent-amber)'}
            onMouseLeave={e => e.currentTarget.style.color = (showNotes || msg.note_count > 0) ? 'var(--accent-amber)' : 'var(--text-3)'}>
            <StickyNote size={13}/>
            {msg.note_count > 0 && (
              <span style={{ position:'absolute', top:'-4px', right:'-4px',
                fontSize:'0.5rem', fontWeight:800, lineHeight:1,
                background:'var(--accent-amber)', color:'#000',
                borderRadius:'0.6rem', padding:'0.05rem 0.25rem', minWidth:'10px',
                textAlign:'center' }}>
                {msg.note_count}
              </span>
            )}
          </span>
          {isNew && <span style={{ fontSize:'0.6rem', fontWeight:800, color:'var(--accent-green)',
            background:'color-mix(in srgb,var(--accent-green) 15%,transparent)',
            padding:'0.1rem 0.35rem', borderRadius:'0.3rem', flexShrink:0 }}>NEW</span>}
        </div>

        {/* ── MOBILE card (hidden on desktop) ──────────────────── */}
        <div className="msg-mobile" style={{ display:'none', padding:'0.5rem 0.75rem', gap:'0.2rem', flexDirection:'column' }}>
          {/* Top line: time + capcode + badges + NEW */}
          <div style={{ display:'flex', alignItems:'center', gap:'0.4rem', flexWrap:'wrap' }}>
            <span style={{ fontFamily:'monospace', fontSize:'0.68rem', color:'var(--text-3)', flexShrink:0, lineHeight:1.3 }}>
              <span style={{ fontSize:'0.62rem', opacity:0.7 }}>{fmtDate(msg.timestamp)} </span>
              {fmtTime(msg.timestamp)}
            </span>
            <span onClick={e => { e.stopPropagation(); onFilter?.('capcode', msg.capcode); }}
              style={{ fontFamily:'monospace', fontSize:'0.75rem', fontWeight:700,
                color:'var(--accent-amber)', flexShrink:0, cursor:'pointer' }}>
              {msg.capcode}
            </span>
            {alias     && <Badge label={alias}     color={aliasColor} onClick={() => onFilter?.('alias',alias)} />}
            {groupName && <Badge label={groupName} color={groupColor} onClick={() => onFilter?.('group',groupName)} />}
            <span style={{ flex:1 }} />
            {showMapButton && hasLocation && (
              <span onClick={e => { e.stopPropagation(); onMapClick?.(msg); }}
                style={{ cursor:'pointer', color:'var(--accent-blue)', lineHeight:1, padding:'0.1rem' }}>
                <MapPin size={12}/>
              </span>
            )}
            <span onClick={e => { e.stopPropagation(); setShowNotes(n => !n); }}
              title={msg.note_count > 0 ? `${msg.note_count} notes` : 'Add note'}
              style={{ cursor:'pointer', lineHeight:1, padding:'0.1rem', position:'relative',
                color: (showNotes || msg.note_count > 0) ? 'var(--accent-amber)' : 'var(--text-3)' }}>
              <StickyNote size={12}/>
              {msg.note_count > 0 && (
                <span style={{ position:'absolute', top:'-3px', right:'-4px',
                  fontSize:'0.48rem', fontWeight:800, lineHeight:1,
                  background:'var(--accent-amber)', color:'#000',
                  borderRadius:'0.6rem', padding:'0.05rem 0.2rem' }}>
                  {msg.note_count}
                </span>
              )}
            </span>
            {isNew && <span style={{ fontSize:'0.58rem', fontWeight:800, color:'var(--accent-green)',
              background:'color-mix(in srgb,var(--accent-green) 15%,transparent)',
              padding:'0.08rem 0.3rem', borderRadius:'0.25rem' }}>NEW</span>}
            <span style={{ color:'var(--text-3)', lineHeight:1 }}>
              {expanded ? <ChevronDown size={10}/> : <ChevronRight size={10}/>}
            </span>
          </div>
          {/* Message — full wrapping on mobile */}
          <div style={{ fontFamily:'monospace', fontSize:'0.82rem', color: msg.message ? 'var(--text-1)' : 'var(--text-3)',
            fontStyle: msg.message ? 'normal' : 'italic', lineHeight:1.4,
            wordBreak:'break-word', whiteSpace:'normal' }}>
            {msg.message
              ? <HighlightedMsg text={msg.message} rules={highlightRules} />
              : '[tone / numeric only]'
            }
          </div>
        </div>

        {/* ── Expanded detail ───────────────────────────────────── */}
        {expanded && (
          <div style={{ padding:'0.5rem 0.75rem 0.75rem 0.75rem', background:'var(--bg-1)',
            borderTop:'1px solid var(--border-soft)', animation:'fadeIn 0.15s ease-out' }}>
            <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(130px,1fr))', gap:'0.5rem', marginBottom:'0.6rem' }}>
              <Field label="Capcode"   v={msg.capcode} mono />
              <Field label="Protocol"  v={`${msg.protocol} @ ${msg.baud ?? '?'}bps`} />
              <Field label="Function"  v={msg.funcbits?.toString() ?? '—'} mono />
              <Field label="Date/Time" v={`${fmtDate(msg.timestamp)} ${fmtTime(msg.timestamp)}`} mono />
              {alias     && <Field label="Alias" v={alias} />}
              {groupName && <Field label="Group" v={groupName} />}
            </div>
            {msg.message && (
              <div style={{ fontFamily:'monospace', fontSize:'0.82rem', color:'var(--text-1)',
                background:'var(--bg-3)', padding:'0.6rem 0.85rem', borderRadius:'0.4rem',
                whiteSpace:'pre-wrap', wordBreak:'break-word', lineHeight:1.6 }}>
                <HighlightedMsg text={msg.message} rules={highlightRules} />
              </div>
            )}
            {msg.raw && (
              <div style={{ marginTop:'0.35rem', fontFamily:'monospace', fontSize:'0.68rem',
                color:'var(--text-3)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}
                title={msg.raw}>RAW: {msg.raw}</div>
            )}
            {user?.role === 'admin' && msg.id && (
              <div style={{ marginTop:'0.6rem', display:'flex', justifyContent:'flex-end' }}
                onClick={e => e.stopPropagation()}>
                <button
                  disabled={deleting}
                  onClick={async () => {
                    if (!confirm('Delete this message permanently?')) return;
                    setDeleting(true);
                    try {
                      await fetch(`${BASE}/admin/messages/${msg.id}`, {
                        method: 'DELETE',
                        headers: { Authorization: `Bearer ${token}` },
                      });
                      onDelete?.(msg.id);
                    } catch (_) {
                      setDeleting(false);
                    }
                  }}
                  title="Delete message"
                  style={{ display:'flex', alignItems:'center', gap:'0.3rem',
                    fontSize:'0.7rem', fontFamily:'monospace', fontWeight:600,
                    padding:'0.25rem 0.6rem', borderRadius:'0.35rem', cursor: deleting ? 'wait' : 'pointer',
                    background:'color-mix(in srgb,var(--accent-red,#ef4444) 10%,transparent)',
                    border:'1px solid color-mix(in srgb,var(--accent-red,#ef4444) 30%,transparent)',
                    color:'var(--accent-red,#ef4444)', transition:'background 0.1s' }}
                  onMouseEnter={e => e.currentTarget.style.background='color-mix(in srgb,var(--accent-red,#ef4444) 20%,transparent)'}
                  onMouseLeave={e => e.currentTarget.style.background='color-mix(in srgb,var(--accent-red,#ef4444) 10%,transparent)'}>
                  <Trash2 size={11}/>{deleting ? 'Deleting…' : 'Delete'}
                </button>
              </div>
            )}
          </div>
        )}

        {/* ── Notes panel ───────────────────────────────────────── */}
        {showNotes && msg.id && (
          <div onClick={e => e.stopPropagation()}>
            <MessageNotes messageId={msg.id}
              onCountChange={delta => { msg.note_count = (msg.note_count || 0) + delta; }} />
          </div>
        )}
      </div>

      {/* CSS for desktop/mobile toggle and keyword alert blink */}
      <style>{`
        @media (max-width: 600px) {
          .msg-desktop { display: none !important; }
          .msg-mobile  { display: flex !important; }
        }
        @keyframes keyalert-blink {
          0%,100% { background: color-mix(in srgb, var(--accent-amber) 12%, var(--bg-0)); }
          50%      { background: color-mix(in srgb, var(--accent-amber) 35%, var(--bg-0)); }
        }
      `}</style>
    </>
  );
}

function Field({ label, v, mono }) {
  return (
    <div>
      <div style={{ fontSize:'0.6rem', textTransform:'uppercase', letterSpacing:'0.08em',
        color:'var(--text-3)', marginBottom:'0.15rem' }}>{label}</div>
      <div style={{ fontSize:'0.78rem', color:'var(--text-1)', fontFamily:mono?'monospace':'inherit' }}>{v}</div>
    </div>
  );
}
