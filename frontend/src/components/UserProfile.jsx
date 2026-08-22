import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { User, Save, X, Bell, Lock, Mail, Smartphone, Send, Tag, Siren, ShieldCheck, ShieldAlert, ChevronRight, ChevronDown, Languages } from 'lucide-react';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { useAuth } from '../context/AuthContext.jsx';

const isNative = Capacitor.isNativePlatform();
const AlertChannel = isNative ? registerPlugin('AlertChannel') : null;

const BASE = import.meta.env.VITE_BACKEND_URL || '';
const tok  = () => localStorage.getItem('pm_token') || '';
const api  = (m, p, b) => fetch(`${BASE}${p}`, {
  method: m, headers: { 'Content-Type':'application/json', Authorization:`Bearer ${tok()}` },
  body: b ? JSON.stringify(b) : undefined,
}).then(r => r.json());

function useModes() {
  const { t } = useTranslation();
  return [
    { id:'all',      label:t('userProfile.modes.all.label'),      desc:t('userProfile.modes.all.desc') },
    { id:'groups',   label:t('userProfile.modes.groups.label'),   desc:t('userProfile.modes.groups.desc') },
    { id:'aliases',  label:t('userProfile.modes.aliases.label'),  desc:t('userProfile.modes.aliases.desc') },
    { id:'capcodes', label:t('userProfile.modes.capcodes.label'), desc:t('userProfile.modes.capcodes.desc') },
    { id:'keywords', label:t('userProfile.modes.keywords.label'), desc:t('userProfile.modes.keywords.desc') },
  ];
}

// One level of group nesting (top-level "parent" groups + their children) rendered as a
// collapsible tree. Checking a parent selects/deselects every child with it — the backend
// treats a selected parent as covering every child regardless of the children's own state
// (see groupMatchesSelection in database.js), so a child left unchecked while its parent
// stays checked would still alarm; cascading the checkbox keeps what's on screen truthful
// about what will actually fire, and children are locked (not just visually ticked) while
// their parent is selected so unchecking one can't silently do nothing.
function GroupPicker({ groups, selectedIds, onChange }) {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const topLevel = groups.filter(g => !g.parent_id);
  const subOf    = pid => groups.filter(g => g.parent_id === pid);
  // Start expanded for any parent that already has an individually-selected child, so an
  // existing selection is visible rather than hidden behind a collapsed row.
  const [expanded, setExpanded] = useState(() => new Set(
    topLevel.filter(g => subOf(g.id).some(c => selectedIds.includes(c.id))).map(g => g.id)
  ));

  const toggleExpanded = id => setExpanded(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const toggleParent = g => {
    const childIds     = subOf(g.id).map(c => c.id);
    const isSelected    = selectedIds.includes(g.id);
    const withoutBranch = selectedIds.filter(x => x !== g.id && !childIds.includes(x));
    onChange(isSelected ? withoutBranch : [...withoutBranch, g.id, ...childIds]);
  };

  const toggleLeaf = id => onChange(selectedIds.includes(id) ? selectedIds.filter(x => x !== id) : [...selectedIds, id]);

  if (!groups.length) return <span style={{ fontSize:'0.75rem', color:'var(--text-3)' }}>{t('userProfile.noGroupsDefined')}</span>;

  const q           = search.trim().toLowerCase();
  const nameMatches = g => g.name?.toLowerCase().includes(q);
  // While searching, a parent stays visible if it matches or any child does, and force-expands
  // so the match is actually shown — overriding manual collapse state without losing it.
  const visibleTop  = q ? topLevel.filter(g => nameMatches(g) || subOf(g.id).some(nameMatches)) : topLevel;

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:'0.3rem' }}>
      <div style={{ fontSize:'0.68rem', color:'var(--text-3)', marginBottom:'0.15rem' }}>{t('userProfile.groupsIncludeChildren')}</div>
      <input className="pm-input" type="text" placeholder={t('userProfile.searchGroups')}
        value={search} onChange={e => setSearch(e.target.value)}
        style={{ fontSize:'0.75rem', padding:'0.3rem 0.5rem' }} />
      {q && !visibleTop.length && <span style={{ fontSize:'0.75rem', color:'var(--text-3)' }}>{t('userProfile.noSearchResults')}</span>}
      {visibleTop.map(g => {
        const allChildren    = subOf(g.id);
        const children       = q && !nameMatches(g) ? allChildren.filter(nameMatches) : allChildren;
        const parentSelected = selectedIds.includes(g.id);
        const isExpanded     = q ? true : expanded.has(g.id);
        return (
          <div key={g.id} style={{ display:'flex', flexDirection:'column', gap:'0.3rem' }}>
            <div style={{ display:'flex', alignItems:'center', gap:'0.2rem' }}>
              {allChildren.length > 0 ? (
                <button type="button" onClick={() => toggleExpanded(g.id)}
                  title={isExpanded ? t('userProfile.collapse') : t('userProfile.expand')}
                  style={{ background:'none', border:'none', cursor:'pointer', color:'var(--text-3)',
                    padding:'0.1rem', display:'flex', flexShrink:0 }}>
                  {isExpanded ? <ChevronDown size={13}/> : <ChevronRight size={13}/>}
                </button>
              ) : <span style={{ width:'19px', flexShrink:0 }} />}
              <label style={{ display:'flex', alignItems:'center', gap:'0.3rem', fontSize:'0.78rem', cursor:'pointer',
                padding:'0.15rem 0.4rem', borderRadius:'0.3rem', border:'1px solid var(--border)', background:'var(--bg-0)', flex:1 }}>
                <input type="checkbox" checked={parentSelected} onChange={() => toggleParent(g)} />
                <span style={{ color: g.color }}>{g.name}</span>
                {allChildren.length > 0 && <span style={{ fontSize:'0.65rem', color:'var(--text-3)' }}>({allChildren.length})</span>}
              </label>
            </div>
            {isExpanded && children.map(sub => (
              <label key={sub.id} title={parentSelected ? t('userProfile.includedViaParent') : undefined}
                style={{ display:'flex', alignItems:'center', gap:'0.3rem', fontSize:'0.78rem',
                  cursor: parentSelected ? 'default' : 'pointer', padding:'0.15rem 0.4rem', borderRadius:'0.3rem',
                  border:'1px solid var(--border)', background:'var(--bg-0)', marginLeft:'1.6rem',
                  opacity: parentSelected ? 0.6 : 1 }}>
                <input type="checkbox" checked={parentSelected || selectedIds.includes(sub.id)}
                  disabled={parentSelected} onChange={() => toggleLeaf(sub.id)} />
                <span style={{ color: sub.color }}>{sub.name}</span>
              </label>
            ))}
          </div>
        );
      })}
    </div>
  );
}

// Checkbox list of aliases with a search box filtering by name or capcode — shared by all
// three notification tiers (email/push/alert), each of which stores its own capcode list.
function AliasPicker({ aliases, selectedCapcodes, onChange }) {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const toggle = capcode => onChange(selectedCapcodes.includes(capcode) ? selectedCapcodes.filter(x => x !== capcode) : [...selectedCapcodes, capcode]);

  if (!aliases.length) return <span style={{ fontSize:'0.75rem', color:'var(--text-3)' }}>{t('userProfile.noAliasesDefined')}</span>;

  const q        = search.trim().toLowerCase();
  const filtered = q ? aliases.filter(a => a.name?.toLowerCase().includes(q) || a.capcode?.toLowerCase().includes(q)) : aliases;

  return (
    <div>
      <input className="pm-input" type="text" placeholder={t('userProfile.searchAliases')}
        value={search} onChange={e => setSearch(e.target.value)}
        style={{ fontSize:'0.75rem', padding:'0.3rem 0.5rem', marginBottom:'0.35rem' }} />
      <div style={{ maxHeight:'160px', overflowY:'auto', border:'1px solid var(--border)',
        borderRadius:'0.4rem', padding:'0.35rem', display:'flex', flexWrap:'wrap', gap:'0.3rem' }}>
        {filtered.map(a => (
          <label key={a.capcode} style={{ display:'flex', alignItems:'center', gap:'0.3rem',
            fontSize:'0.75rem', cursor:'pointer', padding:'0.15rem 0.4rem',
            borderRadius:'0.3rem', border:'1px solid var(--border)', background:'var(--bg-0)',
            whiteSpace:'nowrap' }}>
            <input type="checkbox" checked={selectedCapcodes.includes(a.capcode)} onChange={() => toggle(a.capcode)} />
            <span style={{ color: a.color || 'var(--accent-green)' }}>{a.name}</span>
            <span style={{ color:'var(--text-3)', fontFamily:'monospace', fontSize:'0.68rem' }}>{a.capcode}</span>
          </label>
        ))}
        {!filtered.length && <span style={{ fontSize:'0.75rem', color:'var(--text-3)' }}>{t('userProfile.noSearchResults')}</span>}
      </div>
    </div>
  );
}

function Flash({ msg }) {
  if (!msg) return null;
  const ok = msg.type === 'ok';
  return <div style={{ padding:'0.35rem 0.6rem', borderRadius:'0.35rem', fontSize:'0.75rem',
    fontFamily:'monospace', marginTop:'0.4rem',
    color: ok ? 'var(--accent-green)' : 'var(--accent-red)',
    background:`color-mix(in srgb,${ok?'var(--accent-green)':'var(--accent-red)'} 10%,transparent)`,
  }}>{msg.text}</div>;
}

export default function UserProfile({ onClose }) {
  const { t } = useTranslation();
  const MODES = useModes();
  const { user, refreshUser } = useAuth();
  const [email, setEmail]   = useState('');
  const [uiLanguage, setUiLanguage] = useState(user?.uiLanguage || '');
  const [langSaving, setLangSaving] = useState(false);
  const [langMsg, setLangMsg]       = useState(null);
  const [prefs, setPrefs]   = useState({
    enabled:false, mode:'all', group_ids:[], capcodes:[], keywords:[],
    alias_color_from_group:false,
    push_enabled:false, push_mode:'all', push_group_ids:[], push_capcodes:[], push_keywords:[],
    alert_enabled:false, alert_mode:'all', alert_group_ids:[], alert_capcodes:[], alert_keywords:[],
  });
  const [groups, setGroups]   = useState([]);
  const [aliases, setAliases] = useState([]);
  const [pw, setPw]         = useState({ current:'', next:'', confirm:'' });
  const [saving, setSaving] = useState(false);
  const [pwSaving, setPwSaving] = useState(false);
  const [emailMsg, setEmailMsg]   = useState(null);
  const [pwMsg, setPwMsg]         = useState(null);
  const [prefMsg, setPrefMsg]     = useState(null);
  const [pushCount, setPushCount] = useState(null);   // number of subscribed devices
  const [testMsg, setTestMsg]     = useState(null);   // test push result
  const [testing, setTesting]     = useState(false);
  const [dndGranted, setDndGranted] = useState(null); // null = unknown/not native yet

  const flashEmail = (t,m) => { setEmailMsg({type:t,text:m}); setTimeout(()=>setEmailMsg(null),3000); };
  const flashLang  = (t,m) => { setLangMsg({type:t,text:m});  setTimeout(()=>setLangMsg(null),3000); };
  const flashPw    = (t,m) => { setPwMsg({type:t,text:m});    setTimeout(()=>setPwMsg(null),3000); };
  const flashPref  = (t,m) => { setPrefMsg({type:t,text:m});  setTimeout(()=>setPrefMsg(null),3000); };
  const flashTest  = (t,m) => { setTestMsg({type:t,text:m});  setTimeout(()=>setTestMsg(null),5000); };

  useEffect(() => {
    // Load current email and prefs
    api('GET', '/auth/me').then(d => { setEmail(d.email || ''); setUiLanguage(d.uiLanguage || ''); }).catch(() => {});
    api('GET', '/auth/me/notif-prefs').then(setPrefs).catch(() => {});
    api('GET', '/admin/groups').then(d => setGroups(Array.isArray(d) ? d : [])).catch(() => {});
    api('GET', '/admin/aliases').then(d => setAliases(Array.isArray(d) ? d : [])).catch(() => {});
    api('GET', '/api/push/subscriptions/count').then(d => setPushCount(d.count ?? null)).catch(() => {});
  }, []);

  // Granting DND access happens in a system settings screen outside the app, so re-check
  // whenever the app regains focus rather than only once on mount.
  useEffect(() => {
    if (!isNative) return;
    const check = () => AlertChannel.checkDndAccess().then(r => setDndGranted(!!r.granted)).catch(() => {});
    check();
    document.addEventListener('visibilitychange', check);
    return () => document.removeEventListener('visibilitychange', check);
  }, []);

  const saveEmail = async () => {
    setSaving(true);
    try { await api('PUT', '/auth/me/email', { email }); flashEmail('ok', t('userProfile.emailSaved')); }
    catch (e) { flashEmail('err', e.message); }
    finally { setSaving(false); }
  };

  const saveLanguage = async (lang) => {
    setUiLanguage(lang);
    setLangSaving(true);
    try {
      await api('PUT', '/auth/me/language', { uiLanguage: lang || null });
      await refreshUser();
      flashLang('ok', t('userProfile.languageSaved'));
    } catch (e) { flashLang('err', e.message); }
    finally { setLangSaving(false); }
  };

  const savePrefs = async () => {
    setSaving(true);
    try {
      await api('PUT', '/auth/me/notif-prefs', prefs);
      window.dispatchEvent(new CustomEvent('pm:notif-prefs-updated', { detail: { alias_color_from_group: !!prefs.alias_color_from_group } }));
      flashPref('ok', t('userProfile.preferencesSaved'));
    }
    catch (e) { flashPref('err', e.message); }
    finally { setSaving(false); }
  };

  const changePassword = async () => {
    if (!pw.current) return flashPw('err', t('userProfile.enterCurrentPassword'));
    if (pw.next.length < 6) return flashPw('err', t('userProfile.newPasswordTooShort'));
    if (pw.next !== pw.confirm) return flashPw('err', t('userProfile.passwordsMismatch'));
    setPwSaving(true);
    try {
      const r = await api('POST', '/auth/change-password', { current: pw.current, next: pw.next });
      if (r.ok) { flashPw('ok', t('userProfile.passwordChanged')); setPw({ current:'', next:'', confirm:'' }); }
      else flashPw('err', r.error || t('userProfile.failed'));
    } catch (e) { flashPw('err', e.message); }
    finally { setPwSaving(false); }
  };

  const setListField = (field, value) => {
    const arr = value.split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
    setPrefs(p => ({ ...p, [field]: arr }));
  };

  const sendTestPush = async () => {
    setTesting(true);
    try {
      const r = await api('POST', '/api/push/test');
      if (r.ok) {
        // Refresh subscription count (stale endpoints get pruned during the test send)
        api('GET', '/api/push/subscriptions/count').then(d => setPushCount(d.count ?? null)).catch(() => {});
        if (r.sent === 0) flashTest('err', t('userProfile.noActiveSubscriptions'));
        else flashTest('ok', t('userProfile.testSentToDevices', { count: r.sent }));
      } else {
        flashTest('err', r.error || t('userProfile.failedToSend'));
      }
    } catch (e) { flashTest('err', e.message); }
    finally { setTesting(false); }
  };

  return (
    <div style={{ position:'fixed', inset:0, zIndex:3000, display:'flex', alignItems:'flex-start', justifyContent:'flex-end' }}
      onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ width:'min(420px,100vw)', height:'100vh', background:'var(--bg-1)',
        borderLeft:'1px solid var(--border)', overflowY:'auto', boxShadow:'-4px 0 24px rgba(0,0,0,0.4)' }}>

        {/* Header */}
        <div style={{ display:'flex', alignItems:'center', gap:'0.75rem', padding:'1rem',
          borderBottom:'1px solid var(--border)', position:'sticky', top:0, background:'var(--bg-1)', zIndex:1 }}>
          <User size={18} style={{ color:'var(--accent-green)' }}/>
          <div style={{ flex:1 }}>
            <div style={{ fontWeight:700, color:'var(--text-1)' }}>{user?.username}</div>
            <div style={{ fontSize:'0.7rem', color:'var(--text-3)' }}>
              {user?.role}{user?.orgName ? ` · ${user.orgName}` : ''}{user?.isPlatformAdmin ? ` · ${t('userProfile.platformAdmin')}` : ''}
            </div>
          </div>
          <button onClick={onClose} style={{ background:'none', border:'none', cursor:'pointer',
            color:'var(--text-3)', padding:'0.25rem' }}><X size={18}/></button>
        </div>

        <div style={{ padding:'1rem', display:'flex', flexDirection:'column', gap:'1rem' }}>

          {/* Email */}
          <div className="pm-card">
            <div className="pm-section-title"><Mail size={13}/> {t('userProfile.emailAddress')}</div>
            <p style={{ fontSize:'0.75rem', color:'var(--text-3)', marginBottom:'0.6rem', lineHeight:1.5 }}>
              {t('userProfile.emailHint')}
            </p>
            <input className="pm-input" type="email" value={email}
              onChange={e => setEmail(e.target.value)} placeholder="you@example.com"
              onKeyDown={e => e.key === 'Enter' && saveEmail()} />
            <Flash msg={emailMsg} />
            <button className="pm-btn pm-btn-primary" onClick={saveEmail} disabled={saving}
              style={{ marginTop:'0.5rem' }}>
              <Save size={13}/> {t('userProfile.saveEmail')}
            </button>
          </div>

          {/* UI language — overrides the site-wide default for this account only;
              does not affect date/time formatting, which always follows the site setting. */}
          <div className="pm-card">
            <div className="pm-section-title"><Languages size={13}/> {t('userProfile.uiLanguage')}</div>
            <p style={{ fontSize:'0.75rem', color:'var(--text-3)', marginBottom:'0.6rem', lineHeight:1.5 }}>
              {t('userProfile.uiLanguageHint')}
            </p>
            <select className="pm-input" value={uiLanguage} disabled={langSaving}
              onChange={e => saveLanguage(e.target.value)}>
              <option value="">{t('userProfile.followSiteDefault')}</option>
              <option value="en">English</option>
              <option value="sl">Slovenščina</option>
            </select>
            <Flash msg={langMsg} />
          </div>

	          {/* Notification prefs */}
          <div className="pm-card">
            <div className="pm-section-title"><Bell size={13}/> {t('userProfile.emailNotifPrefs')}</div>
            <p style={{ fontSize:'0.75rem', color:'var(--text-3)', marginBottom:'0.75rem', lineHeight:1.5 }}>
              {t('userProfile.emailNotifHint')}
            </p>

            <label style={{ display:'flex', alignItems:'center', gap:'0.5rem',
              fontSize:'0.85rem', cursor:'pointer', marginBottom:'0.75rem' }}>
              <input type="checkbox" checked={prefs.enabled}
                onChange={e => setPrefs(p => ({ ...p, enabled: e.target.checked }))} />
              {t('userProfile.enableEmailNotifs')}
            </label>

            <div style={{ opacity: prefs.enabled ? 1 : 0.45, transition:'opacity 0.2s' }}>
              <label className="pm-label">{t('userProfile.notifyFor')}</label>
              <div style={{ display:'flex', flexWrap:'wrap', gap:'0.35rem', marginBottom:'0.75rem' }}>
                {MODES.map(m => (
                  <button key={m.id} onClick={() => setPrefs(p => ({ ...p, mode: m.id }))}
                    title={m.desc}
                    style={{ padding:'0.2rem 0.6rem', borderRadius:'0.75rem', fontSize:'0.75rem',
                      cursor:'pointer', border:'1px solid',
                      background: prefs.mode === m.id ? 'color-mix(in srgb,var(--accent-green) 15%,transparent)' : 'var(--bg-3)',
                      color: prefs.mode === m.id ? 'var(--accent-green)' : 'var(--text-3)',
                      borderColor: prefs.mode === m.id ? 'color-mix(in srgb,var(--accent-green) 35%,transparent)' : 'var(--border)',
                    }}>
                    {m.label}
                  </button>
                ))}
              </div>

              {prefs.mode === 'aliases' && (
                <div style={{ marginBottom:'0.75rem' }}>
                  <label className="pm-label">{t('userProfile.selectAliases')}</label>
                  <AliasPicker aliases={aliases} selectedCapcodes={prefs.capcodes || []}
                    onChange={caps => setPrefs(p => ({ ...p, capcodes: caps }))} />
                </div>
              )}

              {prefs.mode === 'groups' && (
                <div style={{ marginBottom:'0.75rem' }}>
                  <label className="pm-label">{t('userProfile.selectGroups')}</label>
                  <GroupPicker groups={groups} selectedIds={prefs.group_ids}
                    onChange={ids => setPrefs(p => ({ ...p, group_ids: ids }))} />
                </div>
              )}

              {prefs.mode === 'capcodes' && (
                <div style={{ marginBottom:'0.75rem' }}>
                  <label className="pm-label">{t('userProfile.capcodesOnePerLine')}</label>
                  <textarea className="pm-input" rows={3}
                    value={prefs.capcodes.join('\n')}
                    onChange={e => setListField('capcodes', e.target.value)}
                    placeholder="1234567&#10;2345678"
                    style={{ resize:'vertical', fontFamily:'monospace', fontSize:'0.8rem' }} />
                </div>
              )}

              {prefs.mode === 'keywords' && (
                <div style={{ marginBottom:'0.75rem' }}>
                  <label className="pm-label">{t('userProfile.keywordsOnePerLine')}</label>
                  <textarea className="pm-input" rows={3}
                    value={prefs.keywords.join('\n')}
                    onChange={e => setListField('keywords', e.target.value)}
                    placeholder="požar&#10;nujna&#10;urgent"
                    style={{ resize:'vertical', fontFamily:'monospace', fontSize:'0.8rem' }} />
                </div>
              )}
            </div>

            <Flash msg={prefMsg} />
            <button className="pm-btn pm-btn-primary" onClick={savePrefs} disabled={saving}
              style={{ marginTop:'0.25rem' }}>
              <Save size={13}/> {t('userProfile.savePreferences')}
            </button>
          </div>

          {/* Push notification prefs */}
          <div className="pm-card">
            <div className="pm-section-title"><Smartphone size={13}/> {t('userProfile.pushNotifPrefs')}</div>
            <p style={{ fontSize:'0.75rem', color:'var(--text-3)', marginBottom:'0.75rem', lineHeight:1.5 }}>
              {t('userProfile.pushNotifHint')}
            </p>

            {/* Device subscription status + test button */}
            <div style={{ display:'flex', alignItems:'center', gap:'0.5rem', marginBottom:'0.75rem',
              padding:'0.4rem 0.6rem', borderRadius:'0.4rem', background:'var(--bg-0)',
              border:'1px solid var(--border)', flexWrap:'wrap' }}>
              <Smartphone size={12} style={{ color: pushCount > 0 ? 'var(--accent-green)' : 'var(--text-3)' }} />
              <span style={{ fontSize:'0.75rem', color:'var(--text-2)', flex:1 }}>
                {pushCount === null ? t('userProfile.checking')
                  : pushCount === 0 ? t('userProfile.noDevicesSubscribed')
                  : t('userProfile.devicesSubscribed', { count: pushCount })}
              </span>
              {pushCount > 0 && (
                <button className="pm-btn" onClick={sendTestPush} disabled={testing}
                  title={t('userProfile.sendTestPushTitle')}
                  style={{ fontSize:'0.72rem', padding:'0.15rem 0.45rem' }}>
                  <Send size={11}/> {testing ? t('userProfile.sending') : t('userProfile.testPush')}
                </button>
              )}
            </div>
            {testMsg && <Flash msg={testMsg} />}

            <label style={{ display:'flex', alignItems:'center', gap:'0.5rem',
              fontSize:'0.85rem', cursor:'pointer', marginBottom:'0.75rem' }}>
              <input type="checkbox" checked={prefs.push_enabled}
                onChange={e => setPrefs(p => ({ ...p, push_enabled: e.target.checked }))} />
              {t('userProfile.enablePushNotifs')}
            </label>

            <div style={{ opacity: prefs.push_enabled ? 1 : 0.45, transition:'opacity 0.2s' }}>
              <label className="pm-label">{t('userProfile.notifyFor')}</label>
              <div style={{ display:'flex', flexWrap:'wrap', gap:'0.35rem', marginBottom:'0.75rem' }}>
                {MODES.map(m => (
                  <button key={m.id} onClick={() => setPrefs(p => ({ ...p, push_mode: m.id }))}
                    title={m.desc}
                    style={{ padding:'0.2rem 0.6rem', borderRadius:'0.75rem', fontSize:'0.75rem',
                      cursor:'pointer', border:'1px solid',
                      background: prefs.push_mode === m.id ? 'color-mix(in srgb,var(--accent-green) 15%,transparent)' : 'var(--bg-3)',
                      color: prefs.push_mode === m.id ? 'var(--accent-green)' : 'var(--text-3)',
                      borderColor: prefs.push_mode === m.id ? 'color-mix(in srgb,var(--accent-green) 35%,transparent)' : 'var(--border)',
                    }}>
                    {m.label}
                  </button>
                ))}
              </div>

              {prefs.push_mode === 'aliases' && (
                <div style={{ marginBottom:'0.75rem' }}>
                  <label className="pm-label">{t('userProfile.selectAliases')}</label>
                  <AliasPicker aliases={aliases} selectedCapcodes={prefs.push_capcodes || []}
                    onChange={caps => setPrefs(p => ({ ...p, push_capcodes: caps }))} />
                </div>
              )}

              {prefs.push_mode === 'groups' && (
                <div style={{ marginBottom:'0.75rem' }}>
                  <label className="pm-label">{t('userProfile.selectGroups')}</label>
                  <GroupPicker groups={groups} selectedIds={prefs.push_group_ids || []}
                    onChange={ids => setPrefs(p => ({ ...p, push_group_ids: ids }))} />
                </div>
              )}

              {prefs.push_mode === 'capcodes' && (
                <div style={{ marginBottom:'0.75rem' }}>
                  <label className="pm-label">{t('userProfile.capcodesOnePerLine')}</label>
                  <textarea className="pm-input" rows={3}
                    value={(prefs.push_capcodes || []).join('\n')}
                    onChange={e => setListField('push_capcodes', e.target.value)}
                    placeholder="1234567&#10;2345678"
                    style={{ resize:'vertical', fontFamily:'monospace', fontSize:'0.8rem' }} />
                </div>
              )}

              {prefs.push_mode === 'keywords' && (
                <div style={{ marginBottom:'0.75rem' }}>
                  <label className="pm-label">{t('userProfile.keywordsOnePerLine')}</label>
                  <textarea className="pm-input" rows={3}
                    value={(prefs.push_keywords || []).join('\n')}
                    onChange={e => setListField('push_keywords', e.target.value)}
                    placeholder="požar&#10;nujna&#10;urgent"
                    style={{ resize:'vertical', fontFamily:'monospace', fontSize:'0.8rem' }} />
                </div>
              )}
            </div>

            <button className="pm-btn pm-btn-primary" onClick={savePrefs} disabled={saving}
              style={{ marginTop:'0.25rem' }}>
              <Save size={13}/> {t('userProfile.savePreferences')}
            </button>
          </div>

          {/* Alias creation prefs */}
          <div className="pm-card">
            <div className="pm-section-title"><Tag size={13}/> {t('userProfile.aliasCreation')}</div>
            <p style={{ fontSize:'0.75rem', color:'var(--text-3)', marginBottom:'0.75rem', lineHeight:1.5 }}>
              {t('userProfile.aliasCreationHint')}
            </p>

            <label style={{ display:'flex', alignItems:'flex-start', gap:'0.5rem',
              fontSize:'0.82rem', cursor:'pointer', color:'var(--text-1)', lineHeight:1.45 }}>
              <input type="checkbox" checked={!!prefs.alias_color_from_group}
                onChange={e => setPrefs(p => ({ ...p, alias_color_from_group: e.target.checked }))} />
              <span>{t('userProfile.aliasColorSync')}</span>
            </label>

            <button className="pm-btn pm-btn-primary" onClick={savePrefs} disabled={saving}
              style={{ marginTop:'0.75rem' }}>
              <Save size={13}/> {t('userProfile.savePreferences')}
            </button>
          </div>

          {/* Alert notification prefs — separate, opt-in tier that can bypass silent/Do
              Not Disturb on the native Android app, so it's deliberately its own filter
              rather than reusing the push filter above (e.g. every message vs just the
              ones you'd want to be woken up for). */}
          <div className="pm-card">
            <div className="pm-section-title"><Siren size={13}/> {t('userProfile.alertNotifPrefs')}</div>
            <p style={{ fontSize:'0.75rem', color:'var(--text-3)', marginBottom:'0.75rem', lineHeight:1.5 }}>
              {t('userProfile.alertNotifHint')}
            </p>

            {isNative && (
              <div style={{ display:'flex', alignItems:'center', gap:'0.5rem', marginBottom:'0.75rem',
                padding:'0.4rem 0.6rem', borderRadius:'0.4rem', background:'var(--bg-0)',
                border:'1px solid var(--border)', flexWrap:'wrap' }}>
                {dndGranted
                  ? <ShieldCheck size={12} style={{ color:'var(--accent-green)' }} />
                  : <ShieldAlert size={12} style={{ color:'var(--accent-red)' }} />}
                <span style={{ fontSize:'0.75rem', color:'var(--text-2)', flex:1 }}>
                  {dndGranted === null ? t('userProfile.checking')
                    : dndGranted ? t('userProfile.dndGranted')
                    : t('userProfile.dndNotGranted')}
                </span>
                {dndGranted === false && (
                  <button className="pm-btn" onClick={() => AlertChannel.requestDndAccess()}
                    style={{ fontSize:'0.72rem', padding:'0.15rem 0.45rem' }}>
                    {t('userProfile.grantAccess')}
                  </button>
                )}
              </div>
            )}

            <label style={{ display:'flex', alignItems:'center', gap:'0.5rem',
              fontSize:'0.85rem', cursor:'pointer', marginBottom:'0.75rem' }}>
              <input type="checkbox" checked={prefs.alert_enabled}
                onChange={e => setPrefs(p => ({ ...p, alert_enabled: e.target.checked }))} />
              {t('userProfile.enableAlertNotifs')}
            </label>

            <div style={{ opacity: prefs.alert_enabled ? 1 : 0.45, transition:'opacity 0.2s' }}>
              <label className="pm-label">{t('userProfile.notifyFor')}</label>
              <div style={{ display:'flex', flexWrap:'wrap', gap:'0.35rem', marginBottom:'0.75rem' }}>
                {MODES.map(m => (
                  <button key={m.id} onClick={() => setPrefs(p => ({ ...p, alert_mode: m.id }))}
                    title={m.desc}
                    style={{ padding:'0.2rem 0.6rem', borderRadius:'0.75rem', fontSize:'0.75rem',
                      cursor:'pointer', border:'1px solid',
                      background: prefs.alert_mode === m.id ? 'color-mix(in srgb,var(--accent-red) 15%,transparent)' : 'var(--bg-3)',
                      color: prefs.alert_mode === m.id ? 'var(--accent-red)' : 'var(--text-3)',
                      borderColor: prefs.alert_mode === m.id ? 'color-mix(in srgb,var(--accent-red) 35%,transparent)' : 'var(--border)',
                    }}>
                    {m.label}
                  </button>
                ))}
              </div>

              {prefs.alert_mode === 'aliases' && (
                <div style={{ marginBottom:'0.75rem' }}>
                  <label className="pm-label">{t('userProfile.selectAliases')}</label>
                  <AliasPicker aliases={aliases} selectedCapcodes={prefs.alert_capcodes || []}
                    onChange={caps => setPrefs(p => ({ ...p, alert_capcodes: caps }))} />
                </div>
              )}

              {prefs.alert_mode === 'groups' && (
                <div style={{ marginBottom:'0.75rem' }}>
                  <label className="pm-label">{t('userProfile.selectGroups')}</label>
                  <GroupPicker groups={groups} selectedIds={prefs.alert_group_ids || []}
                    onChange={ids => setPrefs(p => ({ ...p, alert_group_ids: ids }))} />
                </div>
              )}

              {prefs.alert_mode === 'capcodes' && (
                <div style={{ marginBottom:'0.75rem' }}>
                  <label className="pm-label">{t('userProfile.capcodesOnePerLine')}</label>
                  <textarea className="pm-input" rows={3}
                    value={(prefs.alert_capcodes || []).join('\n')}
                    onChange={e => setListField('alert_capcodes', e.target.value)}
                    placeholder="1234567&#10;2345678"
                    style={{ resize:'vertical', fontFamily:'monospace', fontSize:'0.8rem' }} />
                </div>
              )}

              {prefs.alert_mode === 'keywords' && (
                <div style={{ marginBottom:'0.75rem' }}>
                  <label className="pm-label">{t('userProfile.keywordsOnePerLine')}</label>
                  <textarea className="pm-input" rows={3}
                    value={(prefs.alert_keywords || []).join('\n')}
                    onChange={e => setListField('alert_keywords', e.target.value)}
                    placeholder="požar&#10;nujna&#10;urgent"
                    style={{ resize:'vertical', fontFamily:'monospace', fontSize:'0.8rem' }} />
                </div>
              )}
            </div>

            <button className="pm-btn pm-btn-primary" onClick={savePrefs} disabled={saving}
              style={{ marginTop:'0.25rem' }}>
              <Save size={13}/> {t('userProfile.savePreferences')}
            </button>
          </div>

          {/* Change password */}
          <div className="pm-card">
            <div className="pm-section-title"><Lock size={13}/> {t('userProfile.changePassword')}</div>
            <div style={{ display:'flex', flexDirection:'column', gap:'0.5rem' }}>
              {[
                { label:t('userProfile.currentPassword'), key:'current' },
                { label:t('userProfile.newPassword'),     key:'next'    },
                { label:t('userProfile.confirmNew'),      key:'confirm' },
              ].map(f => (
                <div key={f.key}>
                  <label className="pm-label">{f.label}</label>
                  <input className="pm-input" type="password" value={pw[f.key]}
                    onChange={e => setPw(p => ({ ...p, [f.key]: e.target.value }))} />
                </div>
              ))}
            </div>
            <Flash msg={pwMsg} />
            <button className="pm-btn pm-btn-primary" onClick={changePassword} disabled={pwSaving}
              style={{ marginTop:'0.5rem' }}>
              <Lock size={13}/> {pwSaving ? t('userProfile.saving') : t('userProfile.changePassword')}
            </button>
          </div>

        </div>
      </div>
    </div>
  );
}
