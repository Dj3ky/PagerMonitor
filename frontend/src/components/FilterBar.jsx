import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Filter, Pause, Play, X, ChevronLeft, ChevronRight, ChevronsLeft, ChevronDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';

const S = {
  bar:    { flexShrink:0, background:'var(--bg-1)', borderBottom:'1px solid var(--border)' },
  row:    { display:'flex', alignItems:'center', gap:'0.5rem', padding:'0.4rem 1rem', flexWrap:'wrap' },
  // Row 1 must never wrap — with flexWrap:'wrap', a browser moves an item that doesn't fit
  // entirely to a new line rather than shrinking what's already on the line, which is what
  // sent Pause to its own row on some devices (larger Android font-scale/display-size
  // settings alone, even on identical hardware, was enough to tip it over). nowrap forces
  // the two inputs (the only items without flexShrink:0 below) to compress instead — down
  // to their minWidth floor — before anything is pushed off the line. overflowX is just a
  // safety net for truly extreme zoom levels beyond what that floor can absorb.
  row1:   { display:'flex', alignItems:'center', gap:'0.5rem', padding:'0.4rem 1rem', flexWrap:'nowrap', overflowX:'auto' },
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
  popover: { position:'fixed', zIndex:2500,
             background:'var(--bg-1)', border:'1px solid var(--border)', borderRadius:'0.5rem',
             boxShadow:'0 4px 16px rgba(0,0,0,0.3)', padding:'0.5rem', width:'240px',
             maxHeight:'320px', overflowY:'auto', display:'flex', flexDirection:'column', gap:'0.15rem' },
  checkRow: { display:'flex', alignItems:'center', gap:'0.35rem', fontSize:'0.76rem', cursor:'pointer',
              padding:'0.22rem 0.3rem', borderRadius:'0.3rem' },
  emptyHint: { fontSize:'0.72rem', color:'var(--text-3)', padding:'0.2rem 0.3rem' },
};

function ActiveBadge({ label, color, onRemove }) {
  return (
    <span style={{ display:'inline-flex', alignItems:'center', gap:'0.25rem', flexShrink:0,
      fontSize:'0.68rem', padding:'0.1rem 0.4rem 0.1rem 0.5rem', borderRadius:'1rem',
      color, background: color + '20', border:`1px solid ${color}44`, fontWeight:600 }}>
      {label}
      <button onClick={onRemove} style={{ background:'none', border:'none', cursor:'pointer',
        color, padding:0, lineHeight:1, fontSize:'0.8rem', fontWeight:700 }}>×</button>
    </span>
  );
}

// Closes an open popover on any click outside both its trigger and its panel — same
// pattern as the account menu in Header.jsx, extended to two refs since the panel is
// portaled out to <body> (see FilterPopover) and so is no longer a DOM descendant of
// the trigger it visually belongs to.
function useOutsideClose(open, setOpen, refs) {
  useEffect(() => {
    if (!open) return;
    const h = e => { if (!refs.some(r => r.current?.contains(e.target))) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);
}

function DropdownTrigger({ triggerRef, label, count, onClick }) {
  const active = count > 0;
  return (
    <button ref={triggerRef} type="button" onClick={onClick} style={{
      display:'flex', alignItems:'center', gap:'0.3rem', flexShrink:0,
      background: active ? 'color-mix(in srgb, var(--accent-blue) 12%, transparent)' : 'var(--bg-3)',
      border:'1px solid', borderColor: active ? 'color-mix(in srgb, var(--accent-blue) 35%, transparent)' : 'var(--border)',
      borderRadius:'0.4rem', color: active ? 'var(--accent-blue)' : 'var(--text-2)',
      padding:'0.3rem 0.55rem', fontSize:'0.75rem', fontFamily:'monospace', cursor:'pointer' }}>
      {label}{active && <span style={{ fontWeight:700 }}>({count})</span>}
      <ChevronDown size={12} />
    </button>
  );
}

// Portals the panel to <body>, positioned with `fixed` coordinates read off the trigger's
// bounding rect. Rendering it as a normal in-flow child (the original approach) put it
// inside row1, whose overflowX:'auto' implicitly resolves overflowY to 'auto' too (CSS
// spec: an explicit x + a visible y computes the y to auto) — that silently clipped the
// dropdown to the filter bar's own height, hiding it behind the message feed below.
function FilterPopover({ triggerRef, popoverRef, children }) {
  const [rect, setRect] = useState(null);
  useEffect(() => { setRect(triggerRef.current?.getBoundingClientRect() ?? null); }, [triggerRef]);
  if (!rect) return null;
  return createPortal(
    <div ref={popoverRef} style={{ ...S.popover, top: rect.bottom + 4, left: rect.left }}>
      {children}
    </div>,
    document.body
  );
}

// Group/parent-group checkbox tree with search — mirrors GroupPicker in
// admin/FeedFilter.jsx, but keyed by group NAME rather than id, since that's what
// messages carry (m.group_name/m.parent_group_name) and what the click-to-filter
// badges already match against. Selecting a parent selects all its children with it.
function GroupFilterDropdown({ groups, selected, onChange }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const triggerRef = useRef(null);
  const popoverRef = useRef(null);
  useOutsideClose(open, setOpen, [triggerRef, popoverRef]);

  if (!groups.length) return null;

  const topLevel = groups.filter(g => !g.parent_id);
  const subOf    = pid => groups.filter(g => g.parent_id === pid);

  const toggleParent = g => {
    const childNames = subOf(g.id).map(c => c.name);
    const isSelected  = selected.includes(g.name);
    const without     = selected.filter(x => x !== g.name && !childNames.includes(x));
    onChange(isSelected ? without : [...without, g.name, ...childNames]);
  };
  const toggleLeaf = name => onChange(selected.includes(name) ? selected.filter(x => x !== name) : [...selected, name]);

  const q           = search.trim().toLowerCase();
  const nameMatches = g => g.name?.toLowerCase().includes(q);
  const visibleTop  = q ? topLevel.filter(g => nameMatches(g) || subOf(g.id).some(nameMatches)) : topLevel;

  return (
    <div style={{ position:'relative' }}>
      <DropdownTrigger triggerRef={triggerRef} label={t('filterBar.groupFilter')} count={selected.length}
        onClick={() => setOpen(o => !o)} />
      {open && (
        <FilterPopover triggerRef={triggerRef} popoverRef={popoverRef}>
          <input className="pm-input" style={{ ...S.input, width:'100%' }}
            placeholder={t('filterBar.searchGroups')} value={search}
            onChange={e => setSearch(e.target.value)} autoFocus />
          {q && !visibleTop.length && <div style={S.emptyHint}>{t('filterBar.noMatches')}</div>}
          {visibleTop.map(g => {
            const children       = subOf(g.id);
            const shownChildren  = q && !nameMatches(g) ? children.filter(nameMatches) : children;
            const parentSelected = selected.includes(g.name);
            return (
              <div key={g.id}>
                <label style={S.checkRow}>
                  <input type="checkbox" checked={parentSelected} onChange={() => toggleParent(g)}
                    style={{ accentColor: g.color || 'var(--accent-purple)' }} />
                  <span style={{ color: g.color || 'var(--accent-purple)', fontWeight:600 }}>{g.name}</span>
                </label>
                {shownChildren.map(sub => (
                  <label key={sub.id} style={{ ...S.checkRow, marginLeft:'1.1rem' }}
                    title={parentSelected ? t('filterBar.includedViaParent') : undefined}>
                    <input type="checkbox" checked={parentSelected || selected.includes(sub.name)}
                      disabled={parentSelected} onChange={() => toggleLeaf(sub.name)} />
                    <span style={{ color: sub.color }}>{sub.name}</span>
                  </label>
                ))}
              </div>
            );
          })}
        </FilterPopover>
      )}
    </div>
  );
}

// Flat alias checkbox list with search, keyed by alias NAME (matches m.alias_name/m.alias).
function AliasFilterDropdown({ aliases, selected, onChange }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const triggerRef = useRef(null);
  const popoverRef = useRef(null);
  useOutsideClose(open, setOpen, [triggerRef, popoverRef]);

  if (!aliases.length) return null;

  const q       = search.trim().toLowerCase();
  const visible = q ? aliases.filter(a => a.name?.toLowerCase().includes(q)) : aliases;
  const toggle  = name => onChange(selected.includes(name) ? selected.filter(x => x !== name) : [...selected, name]);

  return (
    <div style={{ position:'relative' }}>
      <DropdownTrigger triggerRef={triggerRef} label={t('filterBar.aliasFilter')} count={selected.length}
        onClick={() => setOpen(o => !o)} />
      {open && (
        <FilterPopover triggerRef={triggerRef} popoverRef={popoverRef}>
          <input className="pm-input" style={{ ...S.input, width:'100%' }}
            placeholder={t('filterBar.searchAliases')} value={search}
            onChange={e => setSearch(e.target.value)} autoFocus />
          {q && !visible.length && <div style={S.emptyHint}>{t('filterBar.noMatches')}</div>}
          {visible.map(a => (
            <label key={a.capcode} style={S.checkRow}>
              <input type="checkbox" checked={selected.includes(a.name)} onChange={() => toggle(a.name)}
                style={{ accentColor: a.color || 'var(--accent-green)' }} />
              <span style={{ color: a.color || 'var(--accent-green)', fontWeight:600 }}>{a.name}</span>
            </label>
          ))}
        </FilterPopover>
      )}
    </div>
  );
}

// Flat source checkbox list with search, keyed by source ID (matches m.client_id) since
// unlike group/alias names, source labels aren't guaranteed unique (e.g. two dongles both
// falling back to "Dongle 1"/"Dongle 2"-style defaults would collide on name).
function SourceFilterDropdown({ sources, selected, onChange }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const triggerRef = useRef(null);
  const popoverRef = useRef(null);
  useOutsideClose(open, setOpen, [triggerRef, popoverRef]);

  if (!sources.length) return null;

  const q       = search.trim().toLowerCase();
  const visible = q ? sources.filter(s => s.label?.toLowerCase().includes(q)) : sources;
  const toggle  = id => onChange(selected.includes(id) ? selected.filter(x => x !== id) : [...selected, id]);

  return (
    <div style={{ position:'relative' }}>
      <DropdownTrigger triggerRef={triggerRef} label={t('filterBar.sourceFilter')} count={selected.length}
        onClick={() => setOpen(o => !o)} />
      {open && (
        <FilterPopover triggerRef={triggerRef} popoverRef={popoverRef}>
          <input className="pm-input" style={{ ...S.input, width:'100%' }}
            placeholder={t('filterBar.searchSources')} value={search}
            onChange={e => setSearch(e.target.value)} autoFocus />
          {q && !visible.length && <div style={S.emptyHint}>{t('filterBar.noMatches')}</div>}
          {visible.map(s => (
            <label key={s.id} style={S.checkRow}>
              <input type="checkbox" checked={selected.includes(s.id)} onChange={() => toggle(s.id)}
                style={{ accentColor:'var(--accent-blue)' }} />
              <span style={{ color:'var(--accent-blue)', fontWeight:600 }}>{s.label}</span>
            </label>
          ))}
        </FilterPopover>
      )}
    </div>
  );
}

export default function FilterBar({ filters, onChange, groups=[], aliases=[], sources=[], paused, onTogglePause, newCount,
  pageSize, onPageSize, pageOptions, page, totalPages, onPage, totalMessages }) {
  const { t } = useTranslation();

  const hasText   = filters.capcode || filters.keyword;
  const hasAlias  = filters.alias.length > 0;
  const hasGroup  = filters.group.length > 0;
  const hasSource = filters.source.length > 0;
  const sourceLabel = id => sources.find(s => s.id === id)?.label || id;

  return (
    <div style={S.bar}>
      {/* Row 1 — text filters */}
      <div style={S.row1}>
        <Filter size={13} style={{ color:'var(--text-3)', flexShrink:0 }} />

        <input style={{ ...S.input, width:'110px', minWidth:'50px' }} placeholder={t('filterBar.capcodePlaceholder')}
          value={filters.capcode} onChange={e => onChange({ ...filters, capcode: e.target.value })} />

        <input style={{ ...S.input, width:'140px', minWidth:'60px' }} placeholder={t('filterBar.keywordPlaceholder')}
          value={filters.keyword} onChange={e => onChange({ ...filters, keyword: e.target.value })} />

        {/* Source/group/alias multi-select dropdowns — desktop only, no room for these on phone */}
        <div className="pm-filter-desktop-only" style={{ display:'flex', gap:'0.4rem', flexShrink:0 }}>
          <SourceFilterDropdown sources={sources} selected={filters.source}
            onChange={ids => onChange({ ...filters, source: ids })} />
          <GroupFilterDropdown groups={groups} selected={filters.group}
            onChange={ids => onChange({ ...filters, group: ids })} />
          <AliasFilterDropdown aliases={aliases} selected={filters.alias}
            onChange={ids => onChange({ ...filters, alias: ids })} />
        </div>

        {(hasText || hasAlias || hasGroup || hasSource) && (
          <button onClick={() => onChange({ capcode:'', keyword:'', alias:[], group:[], source:[] })}
            style={{ background:'none', border:'none', cursor:'pointer', color:'var(--text-3)', padding:'0.15rem', flexShrink:0 }}
            title={t('filterBar.clearAll')}>
            <X size={13} />
          </button>
        )}

        {/* Active source/alias/group badges — one per selected value */}
        {filters.source.map(v => (
          <ActiveBadge key={`source-${v}`} label={t('filterBar.sourceBadge', { value: sourceLabel(v) })} color="var(--accent-blue)"
            onRemove={() => onChange({ ...filters, source: filters.source.filter(x => x !== v) })} />
        ))}
        {filters.alias.map(v => (
          <ActiveBadge key={`alias-${v}`} label={t('filterBar.aliasBadge', { value: v })} color="var(--accent-green)"
            onRemove={() => onChange({ ...filters, alias: filters.alias.filter(x => x !== v) })} />
        ))}
        {filters.group.map(v => (
          <ActiveBadge key={`group-${v}`} label={t('filterBar.groupBadge', { value: v })} color="var(--accent-purple)"
            onRemove={() => onChange({ ...filters, group: filters.group.filter(x => x !== v) })} />
        ))}

        <div style={{ flex:1, minWidth:0 }} />

        <button onClick={onTogglePause} style={{
          display:'flex', alignItems:'center', gap:'0.4rem', padding:'0.25rem 0.65rem', flexShrink:0,
          borderRadius:'0.4rem', fontSize:'0.78rem', fontWeight:500, cursor:'pointer', border:'1px solid',
          background: paused ? 'color-mix(in srgb, var(--accent-amber) 12%, transparent)' : 'var(--bg-3)',
          borderColor: paused ? 'color-mix(in srgb, var(--accent-amber) 35%, transparent)' : 'var(--border)',
          color: paused ? 'var(--accent-amber)' : 'var(--text-2)',
        }}>
          {paused ? <Play size={11}/> : <Pause size={11}/>}
          {paused ? t('filterBar.resume') : t('filterBar.pause')}
          {paused && newCount > 0 && (
            <span style={{ background:'var(--accent-amber)', color:'var(--bg-0)', borderRadius:'0.25rem',
              padding:'0.05rem 0.35rem', fontSize:'0.68rem', fontWeight:800 }}>+{newCount}</span>
          )}
        </button>
      </div>

      {/* Row 2 — pagination */}
      <div style={{ ...S.row, paddingTop:0, paddingBottom:'0.4rem', gap:'0.5rem' }}>
        <span style={S.label}>{t('filterBar.show')}</span>
        <select style={S.select} value={pageSize} onChange={e => onPageSize(Number(e.target.value))}>
          {pageOptions.map(o => <option key={o} value={o}>{o}</option>)}
        </select>
        <span style={S.label}>{t('filterBar.perPage')}</span>
        <div style={{ flex:1 }} />
        <span style={{ ...S.label, minWidth:'80px', textAlign:'right' }}>
          {t('filterBar.rangeOfTotal', { range: totalMessages === 0 ? '0' : `${page*pageSize+1}–${Math.min((page+1)*pageSize, totalMessages)}`, total: totalMessages })}
        </span>
        <button style={{ ...S.pgBtn, opacity: page===0 ? 0.4 : 1 }}
          onClick={() => onPage(0)} disabled={page===0} title={t('filterBar.firstPage')}>
          <ChevronsLeft size={13}/>
        </button>
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

      <style>{`
        @media(max-width:600px){.pm-filter-desktop-only{display:none!important}}
      `}</style>
    </div>
  );
}
