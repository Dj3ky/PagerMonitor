import { X, SearchX } from 'lucide-react';
import MessageRow from './MessageRow.jsx';

export default function SearchPanel({ results, searching, onClear, highlightRules = [], groups = [], onFilter }) {
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '0.5rem 1rem', borderBottom: '1px solid var(--border)', background: 'var(--bg-1)', flexShrink: 0 }}>
        <span style={{ fontSize: '0.85rem', fontWeight: 500, color: 'var(--text-2)' }}>
          {searching ? 'Searching…' : results ? `${results.length} result${results.length !== 1 ? 's' : ''}` : 'Search results'}
        </span>
        <button onClick={onClear} style={{
          display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.78rem',
          color: 'var(--text-3)', background: 'none', border: 'none', cursor: 'pointer', padding: '0.25rem 0.5rem',
          borderRadius: '0.3rem',
        }}>
          <X size={12} /> Back to feed
        </button>
      </div>
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {searching && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '8rem',
            color: 'var(--text-3)', fontFamily: 'monospace', fontSize: '0.85rem' }}>Searching…</div>
        )}
        {!searching && results?.length === 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            height: '8rem', color: 'var(--text-3)', gap: '0.5rem' }}>
            <SearchX size={22} style={{ opacity: 0.4 }} />
            <span style={{ fontFamily: 'monospace', fontSize: '0.85rem' }}>No results found</span>
          </div>
        )}
        {!searching && results?.map((msg, i) => (
          <MessageRow key={msg.id ?? i} msg={msg} isNew={false} highlightRules={highlightRules} groups={groups} onFilter={onFilter} />
        ))}
      </div>
    </div>
  );
}
