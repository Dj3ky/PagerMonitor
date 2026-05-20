import { Filter, Pause, Play, X, ChevronLeft, ChevronRight } from 'lucide-react';

const S = {
  bar:    { flexShrink:0, background:'var(--bg-1)', borderBottom:'1px solid var(--border)' },
  row:    { display:'flex', alignItems:'center', gap:'0.5rem', padding:'0.4rem 1rem', flexWrap:'wrap' },
  input:  { background:'var(--bg-3)', border:'1px solid var(--border)', borderRadius:'0.4rem',
            padding:'0.3rem 0.6rem', fontSize:'0.78rem', fontFamily:'monospace',
            color:'var(--text-1)', outline:'none' },
  label:  { fontSize:'0.7rem', color:'var(--text-3)', fontFamily:'monospace', whiteSpace:'nowrap' },
  pgBtn:  { background:'var(--bg-3)', border:'1px solid var(--border)', borderRadius:'0.35rem',
            color:'var(--text-2)', cursor:'pointer', display:'flex', alignItems:'center',
            padding:'0.2rem 0.4rem', fontSize:'0.75rem' },
  select: { background:'var(--bg-3)', border:'1px solid var(--border)', borderRadius:'0.35rem',
            color:'var(--text-2)', cursor:'pointer', padding:'0.25rem 0.4rem', fontSize:'0.75rem',
            fontFamily:'monospace' },
};

function ActiveBadge({ label, color, onRemove }) {
  return (
    <span style={{ display:'inline-flex', alignItems:'center', gap:'0.25rem',
      fontSize:'0.68rem', padding:'0.1rem 0.4rem 0.1rem 0.5rem', borderRadius:'1rem',
      color, background: color + '20', border:`1px solid ${color}44`, fontWeight:600 }}>
      {label}
      <button onClick={onRemove} style={{ background:'none', border:'none', cursor:'pointer',
        color, padding:0, lineHeight:1, fontSize:'0.8rem', fontWeight:700 }}>×</button>
    </span>
  );
}

export default function FilterBar({ filters, onChange, paused, onTogglePause, newCount,
  pageSize, onPageSize, pageOptions, page, totalPages, onPage, totalMessages }) {

  const hasText = filters.capcode || filters.keyword;
  const hasAlias = filters.alias;
  const hasGroup = filters.group;

  return (
    <div style={S.bar}>
      {/* Row 1 — text filters */}
      <div style={S.row}>
        <Filter size={13} style={{ color:'var(--text-3)', flexShrink:0 }} />

        <input style={{ ...S.input, width:'110px' }} placeholder="Capcode…"
          value={filters.capcode} onChange={e => onChange({ ...filters, capcode: e.target.value })} />

        <input style={{ ...S.input, width:'140px' }} placeholder="Keyword / regex…"
          value={filters.keyword} onChange={e => onChange({ ...filters, keyword: e.target.value })} />

        {(hasText || hasAlias || hasGroup) && (
          <button onClick={() => onChange({ capcode:'', keyword:'', alias:'', group:'' })}
            style={{ background:'none', border:'none', cursor:'pointer', color:'var(--text-3)', padding:'0.15rem' }}
            title="Clear all filters">
            <X size={13} />
          </button>
        )}

        {/* Active alias/group badges */}
        {hasAlias && (
          <ActiveBadge label={`alias: ${filters.alias}`} color="var(--accent-green)"
            onRemove={() => onChange({ ...filters, alias:'' })} />
        )}
        {hasGroup && (
          <ActiveBadge label={`group: ${filters.group}`} color="var(--accent-purple)"
            onRemove={() => onChange({ ...filters, group:'' })} />
        )}

        <div style={{ flex:1 }} />

        <button onClick={onTogglePause} style={{
          display:'flex', alignItems:'center', gap:'0.4rem', padding:'0.25rem 0.65rem',
          borderRadius:'0.4rem', fontSize:'0.78rem', fontWeight:500, cursor:'pointer', border:'1px solid',
          background: paused ? 'color-mix(in srgb, var(--accent-amber) 12%, transparent)' : 'var(--bg-3)',
          borderColor: paused ? 'color-mix(in srgb, var(--accent-amber) 35%, transparent)' : 'var(--border)',
          color: paused ? 'var(--accent-amber)' : 'var(--text-2)',
        }}>
          {paused ? <Play size={11}/> : <Pause size={11}/>}
          {paused ? 'Resume' : 'Pause'}
          {paused && newCount > 0 && (
            <span style={{ background:'var(--accent-amber)', color:'var(--bg-0)', borderRadius:'0.25rem',
              padding:'0.05rem 0.35rem', fontSize:'0.68rem', fontWeight:800 }}>+{newCount}</span>
          )}
        </button>
      </div>

      {/* Row 2 — pagination */}
      <div style={{ ...S.row, paddingTop:0, paddingBottom:'0.4rem', gap:'0.5rem' }}>
        <span style={S.label}>Show</span>
        <select style={S.select} value={pageSize} onChange={e => onPageSize(Number(e.target.value))}>
          {pageOptions.map(o => <option key={o} value={o}>{o}</option>)}
        </select>
        <span style={S.label}>/ page</span>
        <div style={{ flex:1 }} />
        <span style={{ ...S.label, minWidth:'80px', textAlign:'right' }}>
          {totalMessages === 0 ? '0' : `${page*pageSize+1}–${Math.min((page+1)*pageSize, totalMessages)}`} of {totalMessages}
        </span>
        <button style={{ ...S.pgBtn, opacity: page===0 ? 0.4 : 1 }}
          onClick={() => onPage(p => Math.max(0, p-1))} disabled={page===0}>
          <ChevronLeft size={13}/>
        </button>
        <span style={{ ...S.label, minWidth:'50px', textAlign:'center' }}>
          {totalPages > 0 ? `${page+1} / ${totalPages}` : '—'}
        </span>
        <button style={{ ...S.pgBtn, opacity: page>=totalPages-1 ? 0.4 : 1 }}
          onClick={() => onPage(p => Math.min(totalPages-1, p+1))} disabled={page>=totalPages-1}>
          <ChevronRight size={13}/>
        </button>
      </div>
    </div>
  );
}
