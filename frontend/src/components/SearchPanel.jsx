import { X, SearchX } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import MessageRow from './MessageRow.jsx';
import { usePtrScroll } from '../hooks/usePtrScroll.js';

export default function SearchPanel({ results, searching, onClear, highlightRules = [], groups = [], onFilter, onMapClick, onDelete }) {
  const { t } = useTranslation();
  const { ref: scrollRef } = usePtrScroll();
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '0.5rem 1rem', borderBottom: '1px solid var(--border)', background: 'var(--bg-1)', flexShrink: 0 }}>
        <span style={{ fontSize: '0.85rem', fontWeight: 500, color: 'var(--text-2)' }}>
          {searching ? t('searchPanel.searching') : results ? t('searchPanel.resultCount', { count: results.length }) : t('searchPanel.searchResults')}
        </span>
        <button onClick={onClear} style={{
          display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.78rem',
          color: 'var(--text-3)', background: 'none', border: 'none', cursor: 'pointer', padding: '0.25rem 0.5rem',
          borderRadius: '0.3rem',
        }}>
          <X size={12} /> {t('searchPanel.backToFeed')}
        </button>
      </div>
      <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto' }}>
        {searching && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '8rem',
            color: 'var(--text-3)', fontFamily: 'monospace', fontSize: '0.85rem' }}>{t('searchPanel.searching')}</div>
        )}
        {!searching && results?.length === 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            height: '8rem', color: 'var(--text-3)', gap: '0.5rem' }}>
            <SearchX size={22} style={{ opacity: 0.4 }} />
            <span style={{ fontFamily: 'monospace', fontSize: '0.85rem' }}>{t('searchPanel.noResults')}</span>
          </div>
        )}
        {!searching && results?.map((msg, i) => (
          <MessageRow key={msg.id ?? i} msg={msg} isNew={false} highlightRules={highlightRules} groups={groups} onFilter={onFilter} onMapClick={onMapClick} onDelete={onDelete} />
        ))}
      </div>
    </div>
  );
}
