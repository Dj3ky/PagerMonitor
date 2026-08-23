import { useMemo, useState } from 'react';
import { X, SearchX } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import MessageRow from './MessageRow.jsx';
import { usePtrScroll } from '../hooks/usePtrScroll.js';

// Click-to-filter on a result's capcode/alias/group narrows the currently
// loaded search results in place — it's a local refinement of this result
// set, unrelated to the feed's own filters.
const EMPTY_FILTER = { capcode: '', alias: '', group: '' };

export default function SearchPanel({ results, searching, onClear, highlightRules = [], groups = [], onMapClick, onDelete, onLoadMore, hasMore, loadingMore, onAddAlias }) {
  const { t } = useTranslation();
  const { ref: scrollRef } = usePtrScroll();
  const [localFilter, setLocalFilter] = useState(EMPTY_FILTER);

  const handleLocalFilter = (type, value) => {
    setLocalFilter(f => ({ ...EMPTY_FILTER, [type]: f[type] === value ? '' : value }));
  };

  const filteredResults = useMemo(() => {
    if (!results) return results;
    if (!localFilter.capcode && !localFilter.alias && !localFilter.group) return results;
    return results.filter(m => {
      if (localFilter.capcode && m.capcode !== localFilter.capcode) return false;
      if (localFilter.alias && (m.alias_name || m.alias) !== localFilter.alias) return false;
      if (localFilter.group && (m.group_name || m.parent_group_name) !== localFilter.group) return false;
      return true;
    });
  }, [results, localFilter]);

  const activeFilterValue = localFilter.capcode || localFilter.alias || localFilter.group;

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '0.5rem 1rem', borderBottom: '1px solid var(--border)', background: 'var(--bg-1)', flexShrink: 0, gap: '0.5rem' }}>
        <span style={{ fontSize: '0.85rem', fontWeight: 500, color: 'var(--text-2)', display: 'flex', alignItems: 'center', gap: '0.5rem', minWidth: 0 }}>
          {searching ? t('searchPanel.searching') : results ? t('searchPanel.resultCount', { count: filteredResults.length }) : t('searchPanel.searchResults')}
          {activeFilterValue && (
            <span onClick={() => setLocalFilter(EMPTY_FILTER)} title={t('searchPanel.clearFilter')} style={{
              display: 'inline-flex', alignItems: 'center', gap: '0.25rem', fontSize: '0.68rem',
              padding: '0.1rem 0.4rem 0.1rem 0.5rem', borderRadius: '1rem', cursor: 'pointer',
              color: 'var(--accent-blue)', background: 'color-mix(in srgb,var(--accent-blue) 12%,transparent)',
              border: '1px solid color-mix(in srgb,var(--accent-blue) 35%,transparent)', fontWeight: 600,
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {activeFilterValue} <X size={10} />
            </span>
          )}
        </span>
        <button onClick={onClear} style={{
          display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.78rem',
          color: 'var(--text-3)', background: 'none', border: 'none', cursor: 'pointer', padding: '0.25rem 0.5rem',
          borderRadius: '0.3rem', flexShrink: 0,
        }}>
          <X size={12} /> {t('searchPanel.backToFeed')}
        </button>
      </div>
      <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto' }}>
        {searching && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '8rem',
            color: 'var(--text-3)', fontFamily: 'monospace', fontSize: '0.85rem' }}>{t('searchPanel.searching')}</div>
        )}
        {!searching && filteredResults?.length === 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            height: '8rem', color: 'var(--text-3)', gap: '0.5rem' }}>
            <SearchX size={22} style={{ opacity: 0.4 }} />
            <span style={{ fontFamily: 'monospace', fontSize: '0.85rem' }}>{t('searchPanel.noResults')}</span>
          </div>
        )}
        {!searching && filteredResults?.map((msg, i) => (
          <MessageRow key={msg.id ?? i} msg={msg} isNew={false} highlightRules={highlightRules} groups={groups} onFilter={handleLocalFilter} onMapClick={onMapClick} onDelete={onDelete} onAddAlias={onAddAlias} />
        ))}

        {!searching && hasMore && onLoadMore && (
          <div style={{ padding:'0.75rem', textAlign:'center', flexShrink:0 }}>
            <button onClick={onLoadMore} disabled={loadingMore}
              style={{ padding:'0.4rem 1.25rem', borderRadius:'0.5rem', cursor: loadingMore ? 'wait' : 'pointer',
                fontSize:'0.8rem', fontFamily:'monospace', fontWeight:600,
                background:'color-mix(in srgb,var(--accent-green) 10%,transparent)',
                border:'1px solid color-mix(in srgb,var(--accent-green) 25%,transparent)',
                color: loadingMore ? 'var(--text-3)' : 'var(--accent-green)',
                transition:'all 0.15s' }}>
              {loadingMore ? t('messageFeed.loading') : t('searchPanel.loadMore')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
