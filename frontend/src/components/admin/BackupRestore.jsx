import { useState, useEffect, useRef } from 'react';
import { Download, Upload, RefreshCw, HardDrive, AlertTriangle, CheckCircle } from 'lucide-react';

const BASE = import.meta.env.VITE_BACKEND_URL || '';
const tok  = () => localStorage.getItem('pm_token') || '';

function fmtDate(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('sl-SI', {
    hour12:false, day:'2-digit', month:'2-digit', year:'numeric',
    hour:'2-digit', minute:'2-digit', second:'2-digit',
  });
}

function StatusCard({ label, info }) {
  return (
    <div style={{ background:'var(--bg-0)', border:'1px solid var(--border-soft)',
      borderRadius:'0.5rem', padding:'0.75rem 1rem' }}>
      <div style={{ fontSize:'0.65rem', textTransform:'uppercase', letterSpacing:'0.08em',
        color:'var(--text-3)', marginBottom:'0.4rem' }}>{label}</div>
      {info.exists ? (<>
        <div style={{ fontFamily:'monospace', fontSize:'0.85rem', fontWeight:700,
          color:'var(--accent-green)' }}>{info.sizeHuman}</div>
        <div style={{ fontFamily:'monospace', fontSize:'0.65rem', color:'var(--text-3)',
          marginTop:'0.2rem' }}>Modified {fmtDate(info.modified)}</div>
        <div style={{ fontFamily:'monospace', fontSize:'0.6rem', color:'var(--text-3)',
          marginTop:'0.1rem', wordBreak:'break-all' }}>{info.path}</div>
      </>) : (
        <div style={{ fontFamily:'monospace', fontSize:'0.78rem', color:'var(--text-3)' }}>Not created yet</div>
      )}
    </div>
  );
}

export default function BackupRestore() {
  const [status, setStatus]     = useState(null);
  const [loading, setLoading]   = useState(true);
  const [restoring, setRestoring] = useState(false);
  const [msg, setMsg]           = useState(null);
  const fileRef                 = useRef(null);

  const flash = (type, text) => { setMsg({type, text}); setTimeout(() => setMsg(null), 6000); };

  const loadStatus = () => {
    setLoading(true);
    fetch(`${BASE}/admin/backup/status`, { headers: { Authorization:`Bearer ${tok()}` } })
      .then(r => r.json()).then(setStatus).catch(() => {}).finally(() => setLoading(false));
  };
  useEffect(() => { loadStatus(); }, []);

  const download = async (db) => {
    try {
      const r = await fetch(`${BASE}/admin/backup/download?db=${db}`,
        { headers: { Authorization:`Bearer ${tok()}` } });
      if (!r.ok) { flash('err', 'Download failed'); return; }

      const cd   = r.headers.get('Content-Disposition') || '';
      const name = cd.match(/filename="([^"]+)"/)?.[1] || `pagermonitor-backup-${db}.pmbackup`;
      const blob = await r.blob();
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href = url; a.download = name; a.click();
      URL.revokeObjectURL(url);
    } catch (e) { flash('err', e.message); }
  };

  const restore = async (file) => {
    if (!file) return;
    if (!confirm(
      `⚠️ Restore from "${file.name}"?\n\n` +
      `This will REPLACE your current database with the backup.\n` +
      `Your current DB will be kept as a .pre-restore backup file.\n\n` +
      `The server must be restarted after restore.`
    )) return;

    setRestoring(true);
    try {
      const text = await file.text();
      // Validate it looks like our backup format
      let bundle;
      try { bundle = JSON.parse(text); } catch { flash('err', 'Not a valid .pmbackup file'); setRestoring(false); return; }
      if (!bundle.version || !bundle.main) { flash('err', 'Invalid backup file format'); setRestoring(false); return; }

      const r = await fetch(`${BASE}/admin/backup/restore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization:`Bearer ${tok()}` },
        body: text,
      });
      const d = await r.json();
      if (r.ok) {
        flash('ok', `✓ Restore complete (backup from ${fmtDate(bundle.created)}). Restart the server to apply.`);
        loadStatus();
      } else {
        flash('err', d.error || 'Restore failed');
      }
    } catch (e) { flash('err', e.message); }
    finally { setRestoring(false); if (fileRef.current) fileRef.current.value = ''; }
  };

  return (
    <div style={{ maxWidth:'560px' }}>
      <h2 style={{ fontSize:'1rem', fontWeight:700, color:'var(--text-1)', marginBottom:'0.5rem',
        display:'flex', alignItems:'center', gap:'0.5rem', justifyContent:'space-between' }}>
        <span style={{ display:'flex', alignItems:'center', gap:'0.5rem' }}>
          <HardDrive size={16} style={{ color:'var(--accent-blue)' }}/> Backup & Restore
        </span>
        <button className="pm-btn" onClick={loadStatus}><RefreshCw size={12}/></button>
      </h2>
      <p style={{ fontSize:'0.82rem', color:'var(--text-3)', marginBottom:'1rem', lineHeight:1.6 }}>
        Download a backup of your databases, or restore from a previous backup.
        Backups are saved as <code>.pmbackup</code> files containing both the main and archive databases.
      </p>

      {/* Flash message */}
      {msg && (
        <div style={{ display:'flex', alignItems:'flex-start', gap:'0.5rem', padding:'0.6rem 0.75rem',
          borderRadius:'0.4rem', marginBottom:'1rem', fontSize:'0.82rem', lineHeight:1.5,
          color: msg.type==='ok' ? 'var(--accent-green)' : 'var(--accent-red)',
          background:`color-mix(in srgb,${msg.type==='ok'?'var(--accent-green)':'var(--accent-red)'} 10%,transparent)`,
          border:`1px solid color-mix(in srgb,${msg.type==='ok'?'var(--accent-green)':'var(--accent-red)'} 30%,transparent)`,
        }}>
          {msg.type==='ok' ? <CheckCircle size={15} style={{flexShrink:0,marginTop:1}}/> : <AlertTriangle size={15} style={{flexShrink:0,marginTop:1}}/>}
          {msg.text}
        </div>
      )}

      {/* DB status */}
      {loading && <div style={{ color:'var(--text-3)', fontFamily:'monospace', fontSize:'0.82rem', padding:'0.5rem 0' }}>Loading…</div>}
      {status && (
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'0.75rem', marginBottom:'1.25rem' }}>
          <StatusCard label="Main database" info={status.main} />
          <StatusCard label="Archive database" info={status.archive} />
        </div>
      )}

      {/* Download section */}
      <div className="pm-card" style={{ marginBottom:'1rem' }}>
        <div className="pm-section-title"><Download size={13}/> Download backup</div>
        <p style={{ fontSize:'0.78rem', color:'var(--text-3)', marginBottom:'0.75rem', lineHeight:1.5 }}>
          The full backup includes both databases in a single <code>.pmbackup</code> file.
          Use this file to restore or migrate to another server.
        </p>
        <div style={{ display:'flex', gap:'0.5rem', flexWrap:'wrap' }}>
          <button className="pm-btn pm-btn-primary" onClick={() => download('all')}
            style={{ display:'flex', alignItems:'center', gap:'0.4rem' }}>
            <Download size={13}/> Full backup (.pmbackup)
          </button>
          <button className="pm-btn" onClick={() => download('main')}
            style={{ display:'flex', alignItems:'center', gap:'0.4rem' }}>
            <Download size={13}/> Main DB only (.db)
          </button>
          {status?.archive?.exists && (
            <button className="pm-btn" onClick={() => download('archive')}
              style={{ display:'flex', alignItems:'center', gap:'0.4rem' }}>
              <Download size={13}/> Archive DB only (.db)
            </button>
          )}
        </div>
      </div>

      {/* Restore section */}
      <div className="pm-card" style={{ borderColor:'color-mix(in srgb, var(--accent-amber) 30%, var(--border))' }}>
        <div className="pm-section-title"><Upload size={13}/> Restore from backup</div>

        <div style={{ display:'flex', padding:'0.5rem 0.6rem', borderRadius:'0.4rem',
          background:'color-mix(in srgb, var(--accent-amber) 8%, transparent)',
          border:'1px solid color-mix(in srgb, var(--accent-amber) 25%, transparent)',
          marginBottom:'0.75rem', alignItems:'flex-start', gap:'0.5rem' }}>
          <AlertTriangle size={14} style={{ color:'var(--accent-amber)', flexShrink:0, marginTop:'1px' }}/>
          <div style={{ fontSize:'0.75rem', color:'var(--accent-amber)', lineHeight:1.5 }}>
            Restoring will replace your current database with the backup.
            Your existing DB is saved as a <code>.pre-restore</code> file before overwriting.
            <strong> Restart the server after restore.</strong>
          </div>
        </div>

        <input ref={fileRef} type="file" accept=".pmbackup"
          onChange={e => restore(e.target.files?.[0])}
          style={{ display:'none' }} />

        <button className="pm-btn" onClick={() => fileRef.current?.click()} disabled={restoring}
          style={{ display:'flex', alignItems:'center', gap:'0.4rem' }}>
          {restoring
            ? <><RefreshCw size={13} style={{ animation:'spin 1s linear infinite' }}/> Restoring…</>
            : <><Upload size={13}/> Choose .pmbackup file to restore</>}
        </button>
      </div>

      {/* Info */}
      <div style={{ marginTop:'1rem', fontSize:'0.72rem', color:'var(--text-3)', lineHeight:1.7 }}>
        <strong style={{ color:'var(--text-2)' }}>Backup format:</strong> A <code>.pmbackup</code> file is a JSON file
        containing both databases encoded as base64. It can be large for systems with many messages.
        Individual <code>.db</code> files are raw SQLite databases that can be opened with any SQLite viewer.
      </div>
    </div>
  );
}
