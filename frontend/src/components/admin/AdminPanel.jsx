import { useState, useEffect, useRef } from 'react';
import { useAuth } from '../../context/AuthContext.jsx';
import { Cpu, Database, Bell, Tag, Terminal, Server, Users, Highlighter,
         Copy, Layers, Settings2, ChevronDown, Wifi,
         BarChart2, Link, Radio, ClipboardList, Archive, Activity, HardDrive, Mail, Brain, RefreshCw, EyeOff, Wand2 } from 'lucide-react';
import ErrorBoundary  from '../ErrorBoundary.jsx';
import SdrControl     from './SdrControl.jsx';
import SystemStats    from './SystemStats.jsx';
import DbTools        from './DbTools.jsx';
import NotifConfig    from './NotifConfig.jsx';
import AliasManager   from './AliasManager.jsx';
import GroupManager   from './GroupManager.jsx';
import LogViewer      from './LogViewer.jsx';
import UsersPanel     from './UsersPanel.jsx';
import HighlightRules from './HighlightRules.jsx';
import DedupConfig    from './DedupConfig.jsx';
import SiteSettings   from './SiteSettings.jsx';
import ClientSettings from './ClientSettings.jsx';
import SdrClients     from './SdrClients.jsx';
import KeywordAlerts  from './KeywordAlerts.jsx';
import DeadAirConfig  from './DeadAirConfig.jsx';
import Webhooks       from './Webhooks.jsx';
import StatsDashboard from './StatsDashboard.jsx';
import AuditLog       from './AuditLog.jsx';
import BackupRestore  from './BackupRestore.jsx';
import EmailConfig      from './EmailConfig.jsx';
import UserNotifPrefs  from './UserNotifPrefs.jsx';
import ArchiveConfig   from './ArchiveConfig.jsx';
import AiGeocodeConfig from './AiGeocodeConfig.jsx';
import UpdatePanel    from './UpdatePanel.jsx';
import FeedFilter          from './FeedFilter.jsx';
import MsgNormalizations   from './MsgNormalizations.jsx';

const TABS = [
  { group: 'SDR' },
  { id:'sdr',         label:'SDR Control',    icon:<Cpu size={14}/>,        sdrOnly: true },
  { id:'logs',        label:'Live Logs',      icon:<Terminal size={14}/>,   sdrOnly: true },
  { id:'sdrclients',  label:'SDR Clients',    icon:<Activity size={14}/>,   serverOnly: true },
  { id:'client',      label:'Client Key',     icon:<Wifi size={14}/>,       serverOnly: true },
  { id:'deadair',     label:'Dead Air',       icon:<Radio size={14}/> },

  { group: 'Messages' },
  { id:'db',          label:'Database',       icon:<Database size={14}/> },
  { id:'archive',     label:'Archive',        icon:<Archive size={14}/> },
  { id:'stats',       label:'Statistics',     icon:<BarChart2 size={14}/> },
  { id:'dedup',       label:'Dedup',          icon:<Copy size={14}/> },
  { id:'highlights',  label:'Highlights',     icon:<Highlighter size={14}/> },
  { id:'keyword',     label:'Keyword Alerts', icon:<Bell size={14}/> },
  { id:'feedfilter',  label:'Feed Filter',    icon:<EyeOff size={14}/> },
  { id:'msgnorm',     label:'Msg Normalize',  icon:<Wand2 size={14}/> },

  { group: 'Notifications' },
  { id:'notif',       label:'Services',       icon:<Bell size={14}/> },
  { id:'webhooks',    label:'Webhooks',       icon:<Link size={14}/> },
  { id:'email',       label:'Email (SMTP)',   icon:<Mail size={14}/> },
  { id:'usernotif',   label:'User preferences', icon:<Bell size={14}/> },

  { group: 'Aliases & Groups' },
  { id:'groups',      label:'Groups',         icon:<Layers size={14}/> },
  { id:'aliases',     label:'Aliases',        icon:<Tag size={14}/> },

  { group: 'System' },
  { id:'system',      label:'System',          icon:<Server size={14}/> },
  { id:'update',      label:'Update',          icon:<RefreshCw size={14}/> },
  { id:'backup',      label:'Backup & Restore', icon:<HardDrive size={14}/> },
  { id:'auditlog',    label:'Audit Log',        icon:<ClipboardList size={14}/> },

  { group: 'Site' },
  { id:'site',        label:'Site Settings',  icon:<Settings2 size={14}/> },
  { id:'aigeocode',   label:'AI Geocode',     icon:<Brain size={14}/> },
  { id:'users',       label:'Users',          icon:<Users size={14}/> },
];

function TabContent({ tab, sdrStatus, serverStatus, onRulesChange, onGroupsChange }) {
  switch (tab) {
    case 'sdr':         return <SdrControl sdrStatus={sdrStatus} />;
    case 'system':      return <SystemStats serverStatus={serverStatus} />;
    case 'update':      return <UpdatePanel />;
    case 'db':          return <DbTools />;
    case 'aigeocode':   return <AiGeocodeConfig />;
    case 'stats':       return <StatsDashboard />;
    case 'notif':       return <NotifConfig />;
    case 'keyword':     return <KeywordAlerts />;
    case 'deadair':     return <DeadAirConfig />;
    case 'webhooks':    return <Webhooks />;
    case 'email':       return <EmailConfig />;
    case 'usernotif':   return <UserNotifPrefs />;
    case 'groups':      return <GroupManager onGroupsChange={onGroupsChange} />;
    case 'aliases':     return <AliasManager onGroupsChange={onGroupsChange} />;
    case 'highlights':  return <HighlightRules onRulesChange={onRulesChange} />;
    case 'dedup':       return <DedupConfig />;
    case 'site':        return <SiteSettings />;
    case 'client':      return <ClientSettings />;
    case 'sdrclients':  return <SdrClients />;
    case 'users':       return <UsersPanel />;
    case 'backup':      return <BackupRestore />;
    case 'auditlog':    return <AuditLog />;
    case 'archive':     return <ArchiveConfig />;
    case 'feedfilter':  return <FeedFilter />;
    case 'msgnorm':     return <MsgNormalizations />;
    case 'logs':        return <LogViewer />;
    default:            return null;
  }
}

export default function AdminPanel({ sdrStatus, serverStatus, onRulesChange, onGroupsChange, requestedTab, onTabHandled }) {
  const { user } = useAuth();
  const sdrDisabled = serverStatus?.sdrDisabled === true;
  const isEditor    = user?.role === 'editor';

  // Editor-allowed tab IDs
  const EDITOR_TABS = new Set(['groups','aliases','highlights','keyword']);

  // Filter tabs by mode and role
  const visibleTabs = TABS.filter(t => {
    if (t.group) return true;
    if (t.sdrOnly    && sdrDisabled)  return false;
    if (t.serverOnly && !sdrDisabled) return false;
    if (isEditor && !EDITOR_TABS.has(t.id)) return false;
    return true;
  }).filter((t, i, arr) => {
    if (!t.group) return true;
    const next = arr[i + 1];
    return next && !next.group;
  });
  const [tab, setTab]               = useState(() => sessionStorage.getItem('pm_admin_tab') || 'sdr');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const pickerRef                   = useRef(null);
  const contentRef                  = useRef(null);

  // Same touching-based overscroll as MessageFeed: contain when scrolled down
  // (so bottom overscroll doesn't shift the header), auto only when at top AND
  // actively touching (deliberate pull-to-refresh).
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    let touching = false;
    const update = () => {
      if (el.scrollTop > 0) {
        el.style.overscrollBehaviorY = 'contain';
      } else {
        el.style.overscrollBehaviorY = touching ? 'auto' : 'contain';
      }
    };
    const onTouchStart  = () => { touching = true;  update(); };
    const onTouchEnd    = () => { touching = false; };
    update();
    el.addEventListener('scroll',      update,       { passive: true });
    el.addEventListener('touchstart',  onTouchStart, { passive: true });
    el.addEventListener('touchend',    onTouchEnd,   { passive: true });
    el.addEventListener('touchcancel', onTouchEnd,   { passive: true });
    return () => {
      el.removeEventListener('scroll',      update);
      el.removeEventListener('touchstart',  onTouchStart);
      el.removeEventListener('touchend',    onTouchEnd);
      el.removeEventListener('touchcancel', onTouchEnd);
    };
  }, []);

  const actualTabs  = visibleTabs.filter(t => !t.group);
  const currentTab  = actualTabs.find(t => t.id === tab) || actualTabs[0];

  // When sdrDisabled changes (serverStatus loads), the stored tab may no longer
  // be visible (e.g. 'sdr' in server mode, 'sdrclients' in single-device mode).
  // Reset to the first available tab so state, sidebar highlight and content stay in sync.
  useEffect(() => {
    if (actualTabs.length && !actualTabs.find(t => t.id === tab)) {
      const newTab = actualTabs[0].id;
      sessionStorage.setItem('pm_admin_tab', newTab);
      setTab(newTab);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sdrDisabled]);

  const handleSetTab = (t) => {
    sessionStorage.setItem('pm_admin_tab', t);
    setTab(t);
    setSidebarOpen(false);
  };

  // Navigate to a specific tab when requested externally (e.g. status-bar update link
  // clicked while the Settings panel is already open — the panel is already mounted
  // so sessionStorage writes don't trigger a re-read; we need a proper prop+effect).
  useEffect(() => {
    if (!requestedTab) return;
    handleSetTab(requestedTab);
    onTabHandled?.();
  }, [requestedTab]);

  // Close dropdown on outside click
  useEffect(() => {
    if (!sidebarOpen) return;
    const handler = e => {
      if (pickerRef.current && !pickerRef.current.contains(e.target)) {
        setSidebarOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    document.addEventListener('touchstart', handler);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('touchstart', handler);
    };
  }, [sidebarOpen]);

  return (
    <>
      <div style={{ display:'flex', height:'100%', overflow:'hidden' }}>

        {/* ── Desktop sidebar ───────────────────────────────────── */}
        <aside className="admin-sidebar" style={{
          width:'10.5rem', flexShrink:0, background:'var(--bg-1)',
          borderRight:'1px solid var(--border)', padding:'0.6rem 0.4rem',
          display:'flex', flexDirection:'column', gap:'0.1rem', overflowY:'auto',
        }}>
          <div style={{ padding:'0 0.5rem 0.5rem', fontSize:'0.6rem', fontWeight:700,
            textTransform:'uppercase', letterSpacing:'0.1em', color:'var(--text-3)' }}>
            Settings
          </div>
          {visibleTabs.map((t, i) => t.group ? (
            <div key={`g-${i}`} style={{
              padding:'0.55rem 0.55rem 0.15rem',
              fontSize:'0.58rem', fontWeight:700,
              textTransform:'uppercase', letterSpacing:'0.1em',
              color:'var(--text-3)', marginTop: i === 0 ? 0 : '0.25rem',
            }}>
              {t.group}
            </div>
          ) : (
            <button key={t.id} onClick={() => handleSetTab(t.id)} style={{
              display:'flex', alignItems:'center', gap:'0.45rem',
              padding:'0.38rem 0.55rem', borderRadius:'0.4rem', fontSize:'0.78rem',
              fontWeight:500, cursor:'pointer', textAlign:'left', width:'100%',
              border:'1px solid transparent',
              background: tab===t.id ? 'color-mix(in srgb, var(--accent-green) 12%, transparent)' : 'transparent',
              color:       tab===t.id ? 'var(--accent-green)' : 'var(--text-2)',
              borderColor: tab===t.id ? 'color-mix(in srgb, var(--accent-green) 25%, transparent)' : 'transparent',
              transition:'all 0.12s',
            }}>
              <span style={{ opacity:0.8, flexShrink:0 }}>{t.icon}</span>
              {t.label}
            </button>
          ))}
        </aside>

        {/* ── Content area ──────────────────────────────────────── */}
        <div style={{ flex:1, overflow:'hidden', display:'flex', flexDirection:'column' }}>

          {/* Mobile tab picker — shown only on small screens */}
          <div ref={pickerRef} className="admin-mobile-picker" style={{ display:'none', flexShrink:0 }}>
            <button
              onClick={() => setSidebarOpen(o => !o)}
              style={{
                display:'flex', alignItems:'center', justifyContent:'space-between',
                width:'100%', padding:'0.6rem 1rem',
                background:'var(--bg-2)', border:'none', borderBottom:'1px solid var(--border)',
                cursor:'pointer', color:'var(--text-1)', fontSize:'0.85rem', fontWeight:600,
              }}>
              <span style={{ display:'flex', alignItems:'center', gap:'0.5rem' }}>
                <span style={{ color:'var(--accent-green)', opacity:0.9 }}>{currentTab.icon}</span>
                {currentTab.label}
              </span>
              <ChevronDown size={16} style={{
                color:'var(--text-3)', transition:'transform 0.2s',
                transform: sidebarOpen ? 'rotate(180deg)' : 'rotate(0deg)',
              }} />
            </button>

            {/* Dropdown menu */}
            {sidebarOpen && (
              <div style={{
                position:'absolute', left:0, right:0, zIndex:50,
                background:'var(--bg-1)', borderBottom:'1px solid var(--border)',
                boxShadow:'0 8px 20px rgba(0,0,0,0.4)',
                display:'grid', gridTemplateColumns:'1fr 1fr',
                gap:'0.2rem', padding:'0.5rem',
              }}>
                {visibleTabs.map((t, i) => t.group ? (
                  <div key={`g-${i}`} style={{
                    gridColumn:'1 / -1',
                    padding:'0.4rem 0.55rem 0.1rem',
                    fontSize:'0.58rem', fontWeight:700,
                    textTransform:'uppercase', letterSpacing:'0.1em',
                    color:'var(--text-3)',
                    marginTop: i === 0 ? 0 : '0.25rem',
                  }}>
                    {t.group}
                  </div>
                ) : (
                  <button key={t.id} onClick={() => handleSetTab(t.id)} style={{
                    display:'flex', alignItems:'center', gap:'0.5rem',
                    padding:'0.55rem 0.75rem', borderRadius:'0.4rem',
                    fontSize:'0.82rem', fontWeight: tab===t.id ? 600 : 400,
                    cursor:'pointer', border:'1px solid transparent', textAlign:'left',
                    background: tab===t.id ? 'color-mix(in srgb, var(--accent-green) 12%, transparent)' : 'transparent',
                    color:       tab===t.id ? 'var(--accent-green)' : 'var(--text-2)',
                    borderColor: tab===t.id ? 'color-mix(in srgb, var(--accent-green) 25%, transparent)' : 'transparent',
                  }}>
                    <span style={{ opacity:0.8, flexShrink:0 }}>{t.icon}</span>
                    {t.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Tab content */}
          <div ref={contentRef} style={{ flex:1, overflow:'hidden auto', padding:'1.25rem', position:'relative' }}>
            <ErrorBoundary key={tab} name={currentTab.label}>
              <TabContent tab={currentTab.id} sdrStatus={sdrStatus} serverStatus={serverStatus}
                onRulesChange={onRulesChange} onGroupsChange={onGroupsChange} />
            </ErrorBoundary>

            {/* Version footer */}
            <div style={{ marginTop:'2.5rem', paddingTop:'0.75rem',
              borderTop:'1px solid var(--border-soft)',
              textAlign:'center', fontSize:'0.67rem', color:'var(--text-3)',
              fontFamily:'monospace', lineHeight:2 }}>
              PagerMonitor&nbsp;
              <span style={{ color:'var(--accent-green)' }}>
                v{serverStatus?.version || '—'}
              </span>
              &nbsp;·&nbsp;
              <a href="https://github.com/dj3ky/pagermonitor/blob/main/CHANGELOG.md"
                target="_blank" rel="noopener noreferrer"
                style={{ color:'var(--text-3)', textDecoration:'underline dotted' }}>
                changelog
              </a>
              &nbsp;·&nbsp;
              <a href="https://github.com/dj3ky/pagermonitor"
                target="_blank" rel="noopener noreferrer"
                style={{ color:'var(--text-3)', textDecoration:'underline dotted' }}>
                GitHub
              </a>
            </div>
          </div>
        </div>
      </div>

      <style>{`
        @media (max-width: 640px) {
          .admin-sidebar       { display: none !important; }
          .admin-mobile-picker { display: flex !important; flex-direction: column; position: relative; }
        }
      `}</style>
    </>
  );
}
