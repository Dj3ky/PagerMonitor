import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { StickyNote, Lock, Globe, Trash2, Plus, Loader } from 'lucide-react';
import { useAuth } from '../context/AuthContext.jsx';
import { useSite } from '../context/SiteContext.jsx';
import { normTs } from '../utils/time.js';

const BASE = import.meta.env.VITE_BACKEND_URL || '';
const tok  = () => localStorage.getItem('pm_token') || '';

function fmtTime(ts, locale, hour12) {
  return new Date(normTs(ts)).toLocaleString(locale, { hour12, day:'2-digit', month:'2-digit',
    hour:'2-digit', minute:'2-digit' });
}

export default function MessageNotes({ messageId, onCountChange }) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const { locale, hour12 } = useSite();
  const [notes, setNotes]     = useState([]);
  const [loading, setLoading] = useState(true);
  const [text, setText]       = useState('');
  const [isPrivate, setIsPrivate] = useState(false);
  const [saving, setSaving]   = useState(false);
  const textRef               = useRef(null);

  const load = () => {
    setLoading(true);
    fetch(`${BASE}/api/messages/${messageId}/notes`, {
      headers: { Authorization: `Bearer ${tok()}` },
    }).then(r => r.json())
      .then(d => setNotes(Array.isArray(d) ? d : []))
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); textRef.current?.focus(); }, [messageId]);

  const submit = async () => {
    if (!text.trim()) return;
    setSaving(true);
    try {
      await fetch(`${BASE}/api/messages/${messageId}/notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok()}` },
        body: JSON.stringify({ note: text, isPrivate }),
      });
      setText('');
      onCountChange?.(1);
      load();
    } catch (_) {}
    finally { setSaving(false); }
  };

  const remove = async (noteId, isPrivate) => {
    await fetch(`${BASE}/api/notes/${noteId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${tok()}` },
    });
    if (!isPrivate) onCountChange?.(-1);
    load();
  };

  const canDelete = (note) => user?.role === 'admin' || note.user_id === user?.id;

  return (
    <div style={{ padding:'0.6rem 0.75rem 0.75rem',
      background:'color-mix(in srgb, var(--accent-blue) 4%, var(--bg-0))',
      borderTop:'1px dashed color-mix(in srgb, var(--accent-blue) 20%, var(--border))',
    }}>

      {/* Existing notes */}
      {loading && (
        <div style={{ display:'flex', alignItems:'center', gap:'0.4rem',
          color:'var(--text-3)', fontSize:'0.75rem', marginBottom:'0.5rem' }}>
          <Loader size={12} style={{ animation:'spin 1s linear infinite' }}/> {t('messageNotes.loading')}
        </div>
      )}

      {!loading && notes.length === 0 && (
        <div style={{ color:'var(--text-3)', fontSize:'0.75rem', fontStyle:'italic',
          marginBottom:'0.5rem' }}>
          {t('messageNotes.noneYet')}
        </div>
      )}

      {notes.map(n => (
        <div key={n.id} style={{ display:'flex', alignItems:'flex-start', gap:'0.5rem',
          marginBottom:'0.4rem', padding:'0.35rem 0.5rem', borderRadius:'0.4rem',
          background: n.is_private
            ? 'color-mix(in srgb, var(--accent-amber) 8%, var(--bg-1))'
            : 'var(--bg-1)',
          border:`1px solid ${n.is_private
            ? 'color-mix(in srgb, var(--accent-amber) 20%, transparent)'
            : 'var(--border-soft)'}`,
        }}>
          {/* Private/shared indicator */}
          <span title={n.is_private ? t('messageNotes.privateTooltip') : t('messageNotes.sharedTooltip')}
            style={{ flexShrink:0, marginTop:'2px' }}>
            {n.is_private
              ? <Lock size={11} style={{ color:'var(--accent-amber)' }}/>
              : <Globe size={11} style={{ color:'var(--text-3)' }}/>}
          </span>

          <div style={{ flex:1, minWidth:0 }}>
            <div style={{ fontSize:'0.8rem', color:'var(--text-1)', lineHeight:1.5,
              wordBreak:'break-word' }}>
              {n.note}
            </div>
            <div style={{ fontSize:'0.65rem', color:'var(--text-3)', marginTop:'0.15rem',
              fontFamily:'monospace' }}>
              <span style={{ color:'var(--accent-blue)', fontWeight:600 }}>{n.username}</span>
              {' · '}{fmtTime(n.created_at, locale, hour12)}
              {n.is_private && <span style={{ color:'var(--accent-amber)', marginLeft:'0.3rem' }}>{t('messageNotes.privateTag')}</span>}
            </div>
          </div>

          {canDelete(n) && (
            <button onClick={() => remove(n.id, !!n.is_private)} title={t('messageNotes.deleteNote')}
              style={{ flexShrink:0, background:'none', border:'none', cursor:'pointer',
                color:'var(--text-3)', padding:'0.1rem', opacity:0.5,
                transition:'opacity 0.15s' }}
              onMouseEnter={e => e.currentTarget.style.opacity = 1}
              onMouseLeave={e => e.currentTarget.style.opacity = 0.5}>
              <Trash2 size={11}/>
            </button>
          )}
        </div>
      ))}

      {/* Add note */}
      {user && !user.isGuest && (
        <div style={{ marginTop:'0.5rem', display:'flex', gap:'0.4rem', alignItems:'flex-start' }}>
          <textarea ref={textRef} value={text} onChange={e => setText(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submit(); }}
            placeholder={t('messageNotes.addPlaceholder')}
            rows={2}
            style={{ flex:1, background:'var(--bg-2)', border:'1px solid var(--border)',
              borderRadius:'0.4rem', color:'var(--text-1)', fontSize:'0.8rem',
              padding:'0.35rem 0.5rem', resize:'none', fontFamily:'inherit',
              outline:'none', minHeight:'52px' }} />
          <div style={{ display:'flex', flexDirection:'column', gap:'0.3rem' }}>
            <button onClick={submit} disabled={!text.trim() || saving}
              style={{ display:'flex', alignItems:'center', gap:'0.3rem',
                padding:'0.3rem 0.6rem', borderRadius:'0.4rem', fontSize:'0.75rem',
                fontWeight:600, cursor: (!text.trim() || saving) ? 'not-allowed' : 'pointer',
                background:'color-mix(in srgb, var(--accent-green) 18%, transparent)',
                border:'1px solid color-mix(in srgb, var(--accent-green) 35%, transparent)',
                color:'var(--accent-green)', opacity: (!text.trim() || saving) ? 0.5 : 1 }}>
              {saving ? <Loader size={11} style={{ animation:'spin 1s linear infinite' }}/> : <Plus size={11}/>}
              {t('messageNotes.save')}
            </button>
            <button onClick={() => setIsPrivate(p => !p)} title={isPrivate ? t('messageNotes.clickToShare') : t('messageNotes.clickToPrivate')}
              style={{ display:'flex', alignItems:'center', gap:'0.25rem',
                padding:'0.25rem 0.5rem', borderRadius:'0.4rem', fontSize:'0.68rem',
                cursor:'pointer', border:'1px solid',
                background: isPrivate
                  ? 'color-mix(in srgb, var(--accent-amber) 12%, transparent)'
                  : 'transparent',
                borderColor: isPrivate
                  ? 'color-mix(in srgb, var(--accent-amber) 30%, transparent)'
                  : 'var(--border)',
                color: isPrivate ? 'var(--accent-amber)' : 'var(--text-3)' }}>
              {isPrivate ? <><Lock size={10}/> {t('messageNotes.private')}</> : <><Globe size={10}/> {t('messageNotes.shared')}</>}
            </button>
          </div>
        </div>
      )}
      {(!user || user.isGuest) && (
        <div style={{ fontSize:'0.72rem', color:'var(--text-3)', fontStyle:'italic', marginTop:'0.4rem' }}>
          {t('messageNotes.loginToAdd')}
        </div>
      )}
    </div>
  );
}
