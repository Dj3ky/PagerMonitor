import { Rss, Map, Archive, CloudRain, MoreHorizontal } from 'lucide-react';
import { useTranslation } from 'react-i18next';

// Native-only persistent bottom nav (Material's standard mobile pattern) — the
// hamburger+dropdown in Header.jsx is a web pattern that reads as "website" on an
// installed app. "More" re-uses that same dropdown (still in Header) for anything
// that doesn't fit one of these four fixed slots, instead of duplicating it here.
export default function BottomNav({ view, setView, menuOpen, onMenuOpenChange }) {
  const { t } = useTranslation();
  const items = [
    { id: 'feed',    label: t('header.nav.feed'),    icon: Rss },
    { id: 'map',     label: t('header.nav.map'),     icon: Map },
    { id: 'archive', label: t('header.nav.archive'), icon: Archive },
    { id: 'weather', label: t('header.nav.weather'), icon: CloudRain },
  ];

  const isMoreActive = menuOpen || !items.some(i => i.id === view);

  return (
    <nav style={{
      display: 'flex', flexShrink: 0, height: '58px',
      background: 'var(--bg-1)', borderTop: '1px solid var(--border)',
    }}>
      {items.map(({ id, label, icon: Icon }) => (
        <Tab key={id} active={view === id && !menuOpen}
          onClick={() => { onMenuOpenChange(false); setView(id); }}
          icon={<Icon size={20} />} label={label} />
      ))}
      <Tab active={isMoreActive} onClick={() => onMenuOpenChange(!menuOpen)}
        icon={<MoreHorizontal size={20} />} label={t('bottomNav.more')} />
    </nav>
  );
}

function Tab({ active, onClick, icon, label }) {
  return (
    <button onClick={onClick} style={{
      flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center',
      justifyContent: 'center', gap: '0.15rem', border: 'none', background: 'transparent',
      color: active ? 'var(--accent-green)' : 'var(--text-3)', cursor: 'pointer',
    }}>
      {icon}
      <span style={{ fontSize: '0.62rem', fontWeight: active ? 600 : 500 }}>{label}</span>
    </button>
  );
}
