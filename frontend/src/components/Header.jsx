import { useState, useEffect, useRef } from 'react';
import { Capacitor } from '@capacitor/core';
import { useTranslation } from 'react-i18next';
import { Radio, Search, Volume2, VolumeX, Settings, Rss, Sun, Moon, LogOut, User, Menu, X, Bell, BellOff, Map, Archive, CloudRain, Plane, Camera, Siren } from 'lucide-react';
import { useTheme } from '../context/ThemeContext.jsx';
import { useAuth }  from '../context/AuthContext.jsx';
import { useSite }  from '../context/SiteContext.jsx';
import LiveChannels from './LiveChannels.jsx';

const isNative = Capacitor.isNativePlatform();

export default function Header({ wsStatus, soundEnabled, onToggleSound, browserNotif, onSearch, searching, view, setView, isGuest, onGuestLogin, onProfileOpen, menuOpen: menuOpenProp, onMenuOpenChange }) {
  const { t } = useTranslation();
  const [query, setQuery]       = useState('');
  const [menuOpenState, setMenuOpenState] = useState(false);
  // Controlled by App.jsx on native (so BottomNav's "More" tab can drive the same
  // dropdown) — falls back to local state for the web/PWA, which has no bottom nav.
  const menuOpen    = menuOpenProp !== undefined ? menuOpenProp : menuOpenState;
  const setMenuOpen = onMenuOpenChange || setMenuOpenState;
  const menuRef                 = useRef(null);
  const debounceRef             = useRef(null);
  const { theme, toggle: toggleTheme } = useTheme();
  const { user, logout, authFetch } = useAuth();
  const { siteName, enableTraffic, enableAircraft, enableInterventions, geocodeCountry } = useSite();
  // All three hardcoded to Slovenian data sources — same gate ARSO weather uses.
  const showAircraft      = enableAircraft      && geocodeCountry === 'si';
  const showTraffic       = enableTraffic       && geocodeCountry === 'si';
  const showInterventions = enableInterventions && geocodeCountry === 'si';

  // Blinking nav dot when any tracked plane is airborne — reads the backend's cheap
  // in-memory cache (see AircraftView.jsx's own poll), so this second poll costs nothing
  // extra against OpenSky itself.
  const [anyAirborne, setAnyAirborne] = useState(false);
  useEffect(() => {
    if (!showAircraft) { setAnyAirborne(false); return; }
    let cancelled = false;
    const poll = async () => {
      try {
        const r = await authFetch('/api/aircraft');
        if (!r.ok) return;
        const d = await r.json();
        if (!cancelled) setAnyAirborne((d.aircraft || []).some(a => a.live && !a.onGround));
      } catch (_) {}
    };
    poll();
    const iv = setInterval(poll, 20000);
    return () => { cancelled = true; clearInterval(iv); };
  }, [showAircraft, authFetch]);

  // Dynamic search — fires 350ms after user stops typing
  useEffect(() => {
    debounceRef.current = setTimeout(() => { onSearch(query); }, 350);
    return () => clearTimeout(debounceRef.current);
  }, [query]);

  const handleSubmit = e => {
    e.preventDefault();
    clearTimeout(debounceRef.current);
    onSearch(query);
    setMenuOpen(false);
  };

  const nav = v => { setView(v); setMenuOpen(false); };

  // Close dropdown on outside click
  useEffect(() => {
    if (!menuOpen) return;
    const h = e => { if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [menuOpen]);

  const dotColor = {
    open:'var(--accent-green)', connecting:'var(--accent-amber)',
    closed:'var(--accent-red)', error:'var(--accent-red)'
  }[wsStatus] || 'var(--text-3)';

  // Split siteName into prefix and last word for green colouring
  // e.g. "PagerMonitor" → "Pager" + "Monitor", "My Pager" → "My " + "Pager"
  const parts = siteName.trim().match(/^(.*?)(\S+)$/) || ['', '', siteName];
  const namePrefix = parts[1];
  const nameSuffix = parts[2];

  return (
    <>
      {/* Android's App Bar convention uses elevation, not a hairline border, to separate
          itself from content below — swapping the flat border for a shadow here to match. */}
      <header ref={menuRef} style={{ background:'var(--bg-1)',
        boxShadow:'0 2px 4px rgba(0,0,0,0.18), 0 1px 2px rgba(0,0,0,0.12)',
        flexShrink:0, position:'sticky', top:0, zIndex:1001 }}>

        {/* ── Main bar ─────────────────────────────────────────── */}
        <div style={{ display:'flex', alignItems:'center', gap:'0.5rem', padding:'0.45rem 0.75rem' }}>

          {/* Logo — clickable, goes to feed */}
          <div onClick={() => nav('feed')}
            style={{ display:'flex', alignItems:'center', gap:'0.4rem', flexShrink:0, cursor:'pointer' }}>
            <span style={{ position:'relative', display:'flex' }}>
              <Radio size={20} style={{ color:'var(--accent-green)',
                filter:'drop-shadow(0 0 6px color-mix(in srgb, var(--accent-green) 60%, transparent))' }} />
              <span style={{ position:'absolute', top:'-2px', right:'-2px', width:'6px', height:'6px',
                borderRadius:'50%', background:dotColor, boxShadow:`0 0 5px ${dotColor}` }} />
            </span>
            <span style={{ fontFamily:'"Space Grotesk"', fontWeight:700, fontSize:'1rem',
              color:'var(--text-1)', whiteSpace:'nowrap' }}>
              {namePrefix}<span style={{ color:'var(--accent-green)', textShadow:'var(--glow-green)' }}>{nameSuffix}</span>
            </span>
          </div>

          {/* ── Desktop-only controls ─────────────────────── */}
          <div className="hdr-desktop" style={{ display:'flex', alignItems:'center', gap:'0.4rem', flex:1 }}>

            {/* Search — takes remaining space */}
            <form onSubmit={handleSubmit} style={{ flex:1, maxWidth:'22rem' }}>
              <div style={{ position:'relative' }}>
                <Search size={12} style={{ position:'absolute', left:'0.55rem', top:'50%',
                  transform:'translateY(-50%)', color:'var(--text-3)', pointerEvents:'none' }} />
                <input type="text" placeholder={t('header.searchPlaceholder')} value={query}
                  onChange={e => setQuery(e.target.value)}
                  className="pm-input" style={{ paddingLeft:'1.8rem', fontSize:'0.8rem' }} />
                {searching && (
                  <div style={{ position:'absolute', right:'0.5rem', top:'50%', transform:'translateY(-50%)',
                    width:'11px', height:'11px', borderRadius:'50%',
                    border:'2px solid var(--border)', borderTopColor:'var(--accent-green)',
                    animation:'spin 0.7s linear infinite' }} />
                )}
              </div>
            </form>

            {/* Nav */}
            <NavBtn active={view==='feed'}    onClick={() => nav('feed')}    icon={<Rss size={13}/>}     label={t('header.nav.feed')} />
            <NavBtn active={view==='map'}     onClick={() => nav('map')}     icon={<Map size={13}/>}     label={t('header.nav.map')} />
            <NavBtn active={view==='archive'} onClick={() => nav('archive')} icon={<Archive size={13}/>} label={t('header.nav.archive')} />
            <NavBtn active={view==='weather'} onClick={() => nav('weather')} icon={<CloudRain size={13}/>} label={t('header.nav.weather')} />
            {showAircraft && (
              <NavBtn active={view==='aircraft'} onClick={() => nav('aircraft')} icon={<Plane size={13}/>} label={t('header.nav.aircraft')} badge={anyAirborne} />
            )}
            {showTraffic && (
              <NavBtn active={view==='traffic'} onClick={() => nav('traffic')} icon={<Camera size={13}/>} label={t('header.nav.traffic')} />
            )}
            {showInterventions && (
              <NavBtn active={view==='interventions'} onClick={() => nav('interventions')} icon={<Siren size={13}/>} label="SPIN" />
            )}
            {!isGuest && (user?.role === 'admin' || user?.role === 'editor') && (
              <NavBtn active={view==='admin'} onClick={() => nav('admin')} icon={<Settings size={13}/>} label={t('header.nav.settings')} />
            )}

            {/* Sound + browser notifications + theme */}
            <IconBtn title={soundEnabled ? t('header.muteSound') : t('header.enableSound')} onClick={onToggleSound} active={soundEnabled}>
              {soundEnabled ? <Volume2 size={14}/> : <VolumeX size={14}/>}
            </IconBtn>
            {browserNotif.supported && (
              <IconBtn
                title={
                  browserNotif.permission === 'denied'
                    ? t('header.notifBlocked')
                    : browserNotif.enabled
                      ? t('header.notifOn')
                      : t('header.notifOff')
                }
                onClick={browserNotif.toggle}
                active={browserNotif.enabled}
                dimmed={browserNotif.permission === 'denied'}>
                {browserNotif.enabled ? <Bell size={14}/> : <BellOff size={14}/>}
              </IconBtn>
            )}
            <IconBtn title={t('header.toggleTheme')} onClick={toggleTheme}>
              {theme==='dark' ? <Sun size={14}/> : <Moon size={14}/>}
            </IconBtn>

            {/* Username / login */}
            {isGuest ? (
              <button onClick={onGuestLogin} title={t('header.loginClickTitle')}
                style={{ display:'flex', alignItems:'center', gap:'0.3rem',
                  fontSize:'0.72rem', color:'var(--accent-blue)', fontFamily:'monospace',
                  padding:'0.2rem 0.5rem', borderRadius:'0.3rem', cursor:'pointer',
                  background:'color-mix(in srgb,var(--accent-blue) 10%,transparent)',
                  border:'1px solid color-mix(in srgb,var(--accent-blue) 30%,transparent)' }}>
                <User size={11}/> {t('header.login')}
              </button>
            ) : (
              <button onClick={onProfileOpen} title={user?.orgName ? t('header.profileTitleOrg', { org: user.orgName }) : t('header.profileTitle')}
                style={{ display:'flex', alignItems:'center', gap:'0.3rem',
                  fontSize:'0.72rem', color:'var(--text-3)', fontFamily:'monospace',
                  padding:'0.2rem 0.5rem', borderRadius:'0.3rem', cursor:'pointer',
                  background:'transparent', border:'1px solid transparent',
                  marginLeft:'0.2rem', whiteSpace:'nowrap', transition:'all 0.15s',
                }}
                onMouseEnter={e => { e.currentTarget.style.borderColor='var(--border)'; e.currentTarget.style.color='var(--text-1)'; }}
                onMouseLeave={e => { e.currentTarget.style.borderColor='transparent'; e.currentTarget.style.color='var(--text-3)'; }}>
                <User size={11} />
                {user?.username}
                {user?.role === 'editor' && (
                  <span style={{ fontSize:'0.6rem', padding:'0.05rem 0.3rem', borderRadius:'0.25rem',
                    background:'color-mix(in srgb,var(--accent-amber) 15%,transparent)',
                    color:'var(--accent-amber)', marginLeft:'0.2rem' }}>{t('header.editorBadge')}</span>
                )}
              </button>
            )}

            {/* Logout — only for logged-in users */}
            {!isGuest && (
              <IconBtn title={t('header.signOut')} onClick={logout}>
                <LogOut size={14}/>
              </IconBtn>
            )}
          </div>

          {/* Live voice channels — always visible (not desktop-only), sits next to the hamburger */}
          <LiveChannels />

          {/* ── Mobile hamburger — right side via CSS order ─────────────────────────────
              Hidden on native: BottomNav's "More" tab opens this same dropdown instead. */}
          {!isNative && (
            <button onClick={() => setMenuOpen(m => !m)}
              className="hdr-mobile"
              style={{ display:'none', alignItems:'center', justifyContent:'center',
                width:'36px', height:'36px', borderRadius:'0.4rem', border:'1px solid var(--border)',
                background: menuOpen ? 'var(--bg-4)' : 'var(--bg-3)',
                color:'var(--text-1)', cursor:'pointer', flexShrink:0 }}>
              {menuOpen ? <X size={18}/> : <Menu size={18}/>}
            </button>
          )}
        </div>

        {/* ── Mobile dropdown ─────────────────────────────────
            On native this is triggered by BottomNav's "More" tab, not a hamburger up
            here — anchor it as a sheet rising from the bottom nav instead of the top,
            so it visually opens near where it was tapped. */}
        {menuOpen && (
          <div className="hdr-mobile" style={isNative ? {
            display:'flex', flexDirection:'column',
            background:'var(--bg-1)', borderTop:'1px solid var(--border)',
            position:'fixed', bottom:'58px', left:0, right:0,
            maxHeight:'70vh', overflowY:'auto', borderRadius:'0.75rem 0.75rem 0 0',
            boxShadow:'0 -8px 24px rgba(0,0,0,0.5)', zIndex:2000,
          } : {
            display:'flex', flexDirection:'column',
            background:'var(--bg-1)', borderTop:'1px solid var(--border)',
            position:'absolute', top:'100%', left:0, right:0,
            boxShadow:'0 8px 24px rgba(0,0,0,0.5)', zIndex:2000,
          }}>
            {/* Search */}
            <div style={{ padding:'0.75rem 1rem', borderBottom:'1px solid var(--border-soft)' }}>
              <form onSubmit={handleSubmit}>
                <div style={{ position:'relative' }}>
                  <Search size={14} style={{ position:'absolute', left:'0.65rem', top:'50%',
                    transform:'translateY(-50%)', color:'var(--text-3)', pointerEvents:'none' }} />
                  <input type="text" placeholder={t('header.searchPlaceholderLong')} value={query}
                    onChange={e => setQuery(e.target.value)} autoFocus
                    className="pm-input" style={{ paddingLeft:'2.1rem', fontSize:'0.9rem' }} />
                </div>
              </form>
            </div>

            {/* Feed/Map/Weather always live in BottomNav on native — redundant here. Archive
                is conditional: BottomNav swaps it for SPIN on native when interventions are
                enabled (rarely-used slot), so surface Archive here instead in that case —
                and correspondingly skip SPIN here on native then, since it's in BottomNav. */}
            {!isNative && (
              <>
                <MenuRow icon={<Rss size={16}/>} label={t('header.nav.feed')} active={view==='feed'} onClick={() => nav('feed')} />
                <MenuRow icon={<Map size={16}/>} label={t('header.nav.map')}  active={view==='map'}  onClick={() => nav('map')} />
              </>
            )}
            {(!isNative || showInterventions) && (
              <MenuRow icon={<Archive size={16}/>} label={t('header.nav.archive')} active={view==='archive'} onClick={() => nav('archive')} />
            )}
            {!isNative && (
              <MenuRow icon={<CloudRain size={16}/>} label={t('header.nav.weather')} active={view==='weather'} onClick={() => nav('weather')} />
            )}
            {showAircraft && (
              <MenuRow icon={<Plane size={16}/>} label={t('header.nav.aircraft')} active={view==='aircraft'} onClick={() => nav('aircraft')} badge={anyAirborne} />
            )}
            {showTraffic && (
              <MenuRow icon={<Camera size={16}/>} label={t('header.nav.traffic')} active={view==='traffic'} onClick={() => nav('traffic')} />
            )}
            {showInterventions && !isNative && (
              <MenuRow icon={<Siren size={16}/>} label="SPIN" active={view==='interventions'} onClick={() => nav('interventions')} />
            )}
            {!isGuest && (user?.role === 'admin' || user?.role === 'editor') && (
              <MenuRow icon={<Settings size={16}/>} label={t('header.nav.settings')} active={view==='admin'} onClick={() => nav('admin')} />
            )}
            <div style={{ height:'1px', background:'var(--border-soft)' }} />
            <MenuRow icon={soundEnabled ? <Volume2 size={16}/> : <VolumeX size={16}/>}
              label={soundEnabled ? t('header.mobileMenu.soundOn') : t('header.mobileMenu.soundOff')}
              accent={soundEnabled ? 'var(--accent-green)' : null}
              onClick={onToggleSound} />
            {browserNotif.supported && (
              <MenuRow
                icon={browserNotif.enabled ? <Bell size={16}/> : <BellOff size={16}/>}
                label={
                  browserNotif.permission === 'denied'
                    ? t('header.mobileMenu.notifBlocked')
                    : browserNotif.enabled
                      ? t('header.mobileMenu.notifOn')
                      : t('header.mobileMenu.notifOff')
                }
                accent={browserNotif.enabled ? 'var(--accent-green)' : null}
                onClick={browserNotif.permission === 'denied' ? undefined : browserNotif.toggle} />
            )}
            <MenuRow icon={theme==='dark' ? <Sun size={16}/> : <Moon size={16}/>}
              label={theme==='dark' ? t('header.mobileMenu.lightTheme') : t('header.mobileMenu.darkTheme')}
              onClick={toggleTheme} />
            <div style={{ height:'1px', background:'var(--border-soft)' }} />
            {isGuest ? (
              <MenuRow icon={<User size={16}/>} label={t('header.mobileMenu.loginFull')}
                accent="var(--accent-blue)" onClick={() => { onGuestLogin(); setMenuOpen(false); }} />
            ) : (
              <>
                {user && (
                  <MenuRow icon={<User size={16}/>}
                    label={t('header.mobileMenu.profileWithUser', { username: user.username })}
                    onClick={() => { onProfileOpen(); setMenuOpen(false); }} />
                )}
                <MenuRow icon={<LogOut size={16}/>} label={t('header.mobileMenu.signOut')}
                  accent="var(--accent-red)" onClick={() => { logout(); setMenuOpen(false); }} />
              </>
            )}
          </div>
        )}
      </header>

      <style>{`
        @media (max-width: 640px) {
          .hdr-desktop { display: none !important; }
          .hdr-mobile  { display: flex !important; }
        }
      `}</style>
    </>
  );
}

function NavBtn({ active, onClick, icon, label, badge }) {
  return (
    <button onClick={onClick} style={{
      display:'flex', alignItems:'center', gap:'0.3rem', position:'relative',
      padding:'0.28rem 0.55rem', borderRadius:'0.4rem', fontSize:'0.78rem',
      fontWeight:500, cursor:'pointer', whiteSpace:'nowrap',
      border: active ? '1px solid color-mix(in srgb, var(--accent-green) 35%, transparent)' : '1px solid transparent',
      background: active ? 'color-mix(in srgb, var(--accent-green) 12%, transparent)' : 'transparent',
      color: active ? 'var(--accent-green)' : 'var(--text-2)', transition:'all 0.15s',
    }}>
      {icon} {label}
      {badge && (
        <span style={{ position:'absolute', top:'1px', right:'1px', width:'6px', height:'6px', borderRadius:'50%',
          background:'var(--accent-green)', boxShadow:'var(--glow-green)', animation:'blink 2s ease-in-out infinite' }} />
      )}
    </button>
  );
}

function IconBtn({ onClick, title, active, dimmed, children }) {
  return (
    <button onClick={onClick} title={title} style={{
      display:'flex', alignItems:'center', justifyContent:'center',
      width:'30px', height:'30px', borderRadius:'0.4rem', border:'1px solid transparent',
      cursor: dimmed ? 'not-allowed' : 'pointer', transition:'all 0.15s',
      background: active ? 'color-mix(in srgb, var(--accent-green) 12%, transparent)' : 'transparent',
      color: dimmed ? 'var(--text-3)' : active ? 'var(--accent-green)' : 'var(--text-2)',
      opacity: dimmed ? 0.5 : 1,
    }}>
      {children}
    </button>
  );
}

function MenuRow({ icon, label, onClick, active, accent, badge }) {
  const [hover, setHover] = useState(false);
  const col = active ? 'var(--accent-green)' : accent || 'var(--text-1)';
  return (
    <button onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display:'flex', alignItems:'center', gap:'0.85rem',
        padding:'0.75rem 1rem', width:'100%', textAlign:'left',
        background: hover ? 'var(--bg-3)' : active ? 'color-mix(in srgb, var(--accent-green) 8%, transparent)' : 'transparent',
        border:'none', borderLeft: active ? '3px solid var(--accent-green)' : '3px solid transparent',
        cursor:'pointer', fontSize:'0.9rem', fontWeight: active ? 600 : 400,
        color: col, transition:'background 0.12s',
      }}>
      <span style={{ position:'relative', opacity: active ? 1 : 0.75, display:'inline-flex' }}>
        {icon}
        {badge && (
          <span style={{ position:'absolute', top:'-2px', right:'-2px', width:'7px', height:'7px', borderRadius:'50%',
            background:'var(--accent-green)', boxShadow:'var(--glow-green)', animation:'blink 2s ease-in-out infinite' }} />
        )}
      </span>
      {label}
    </button>
  );
}
