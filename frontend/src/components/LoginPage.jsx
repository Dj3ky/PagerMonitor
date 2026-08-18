import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { LogIn, UserPlus, Eye, EyeOff, Radio } from 'lucide-react';
import { useAuth } from '../context/AuthContext.jsx';
import { useSite } from '../context/SiteContext.jsx';

export default function LoginPage({ onCancel }) {
  const { t } = useTranslation();
  const { login, needsSetup, setNeedsSetup } = useAuth();
  const { siteName, siteDescription }        = useSite();
  const isSetup = needsSetup;

  // Split name same way as Header: last word gets green
  const parts      = siteName.trim().match(/^(.*?)(\S+)$/) || ['','',siteName];
  const namePrefix = parts[1];
  const nameSuffix = parts[2];

  const [showForgot, setShowForgot] = useState(false);
  const [forgotUser, setForgotUser] = useState('');
  const [forgotMsg, setForgotMsg]   = useState('');
  const [forgotSent, setForgotSent] = useState(false);
  const [form, setForm]   = useState({ username: '', password: '', confirm: '' });
  const [showPw, setShowPw]   = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState('');

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const BASE = import.meta.env.VITE_BACKEND_URL || '';

  const sendForgot = async () => {
    if (!forgotUser) return;
    try {
      await fetch(`${BASE}/auth/forgot-password`, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ username: forgotUser }),
      });
      setForgotSent(true);
    } catch { setForgotMsg(t('loginPage.forgotFailed')); }
  };

  if (showForgot) return (
    <div style={{ minHeight:'100vh', display:'flex', alignItems:'center', justifyContent:'center',
      background:'var(--bg-0)', padding:'1rem' }}>
      <div style={{ width:'100%', maxWidth:'360px' }}>
        <div style={{ textAlign:'center', marginBottom:'1.5rem' }}>
          <div style={{ fontSize:'1.3rem', fontWeight:700, color:'var(--text-1)' }}>{t('loginPage.resetPassword')}</div>
          <div style={{ fontSize:'0.82rem', color:'var(--text-3)', marginTop:'0.25rem' }}>
            {t('loginPage.resetPasswordHint')}
          </div>
        </div>
        {forgotSent ? (
          <div style={{ textAlign:'center', color:'var(--accent-green)', fontSize:'0.9rem', lineHeight:1.6 }}>
            ✓ {t('loginPage.resetLinkSent')}<br/>
            <button onClick={() => setShowForgot(false)}
              style={{ marginTop:'1rem', background:'none', border:'none', cursor:'pointer',
                color:'var(--text-3)', textDecoration:'underline', fontSize:'0.82rem' }}>
              ← {t('loginPage.backToLogin')}
            </button>
          </div>
        ) : (
          <>
            <input className="pm-input" value={forgotUser} onChange={e => setForgotUser(e.target.value)}
              placeholder={t('loginPage.username')} style={{ width:'100%', marginBottom:'0.5rem', boxSizing:'border-box' }}
              onKeyDown={e => e.key === 'Enter' && sendForgot()} />
            {forgotMsg && <div style={{ color:'var(--accent-red)', fontSize:'0.78rem', marginBottom:'0.5rem' }}>{forgotMsg}</div>}
            <button onClick={sendForgot} style={{ width:'100%', padding:'0.6rem', borderRadius:'0.5rem',
              background:'color-mix(in srgb,var(--accent-green) 18%,transparent)',
              border:'1px solid color-mix(in srgb,var(--accent-green) 40%,transparent)',
              color:'var(--accent-green)', fontWeight:600, cursor:'pointer', marginBottom:'0.5rem' }}>
              {t('loginPage.sendResetLink')}
            </button>
            <button onClick={() => setShowForgot(false)} style={{ width:'100%', padding:'0.4rem',
              background:'none', border:'none', cursor:'pointer',
              color:'var(--text-3)', textDecoration:'underline', fontSize:'0.82rem' }}>
              ← {t('loginPage.backToLogin')}
            </button>
          </>
        )}
      </div>
    </div>
  );

  const validate = () => {
    if (!form.username || form.username.length < 2) { setError(t('loginPage.usernameTooShort')); return false; }
    if (!form.password || form.password.length < 6) { setError(t('loginPage.passwordTooShort')); return false; }
    if (isSetup && form.password !== form.confirm)  { setError(t('loginPage.passwordsMismatch')); return false; }
    return true;
  };

  const handleSubmit = async e => {
    e.preventDefault();
    setError('');
    if (!validate()) return;
    setLoading(true);
    try {
      if (isSetup) {
        const r = await fetch((import.meta.env.VITE_BACKEND_URL || '') + '/auth/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: form.username, password: form.password, role: 'admin' }),
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || 'Setup failed');
        setNeedsSetup(false);
      }
      await login(form.username, form.password);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ minHeight:'100vh', display:'flex', alignItems:'center', justifyContent:'center',
      background:'var(--bg-0)', padding:'1rem' }}>
      <div style={{ width:'100%', maxWidth:'360px' }}>

        {/* Logo */}
        <div style={{ textAlign:'center', marginBottom:'2rem' }}>
          <div style={{ display:'inline-flex', alignItems:'center', justifyContent:'center',
            width:'52px', height:'52px', borderRadius:'14px', marginBottom:'0.9rem',
            background:'color-mix(in srgb, var(--accent-green) 12%, var(--bg-2))',
            border:'1.5px solid color-mix(in srgb, var(--accent-green) 30%, transparent)' }}>
            <Radio size={28} style={{ color:'var(--accent-green)', filter:'drop-shadow(0 0 8px color-mix(in srgb, var(--accent-green) 70%, transparent))' }} />
          </div>
          <div style={{ fontFamily:'"Space Grotesk"', fontWeight:800, fontSize:'1.7rem',
            color:'var(--text-1)', lineHeight:1.1, marginBottom:'0.3rem' }}>
            {namePrefix}<span style={{ color:'var(--accent-green)' }}>{nameSuffix}</span>
          </div>
          <div style={{ color:'var(--text-3)', fontSize:'0.83rem' }}>
            {isSetup ? t('loginPage.createAdminHint') : (siteDescription || t('loginPage.signInToContinue'))}
          </div>
        </div>

        {/* Card */}
        <div className="pm-card" style={{ padding:'1.5rem' }}>
          <form onSubmit={handleSubmit}>
            <div style={{ marginBottom:'1rem' }}>
              <label className="pm-label">{t('loginPage.username')}</label>
              <input className="pm-input" type="text" autoFocus autoComplete="username"
                value={form.username} onChange={e => set('username', e.target.value)}
                placeholder={t('loginPage.enterUsername')} />
            </div>

            <div style={{ marginBottom: isSetup ? '1rem' : '1.5rem' }}>
              <label className="pm-label">{t('loginPage.password')}</label>
              <div style={{ position:'relative' }}>
                <input className="pm-input" type={showPw ? 'text' : 'password'}
                  autoComplete={isSetup ? 'new-password' : 'current-password'}
                  value={form.password} onChange={e => set('password', e.target.value)}
                  placeholder={isSetup ? t('loginPage.min6chars') : t('loginPage.enterPassword')}
                  style={{ paddingRight:'2.5rem' }} />
                <button type="button" onClick={() => setShowPw(s => !s)} style={{
                  position:'absolute', right:'0.5rem', top:'50%', transform:'translateY(-50%)',
                  background:'none', border:'none', cursor:'pointer', color:'var(--text-3)', padding:'0.25rem' }}>
                  {showPw ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </div>
            </div>

            {isSetup && (
              <div style={{ marginBottom:'1.5rem' }}>
                <label className="pm-label">{t('loginPage.confirmPassword')}</label>
                <input className="pm-input" type={showPw ? 'text' : 'password'}
                  autoComplete="new-password"
                  value={form.confirm} onChange={e => set('confirm', e.target.value)}
                  placeholder={t('loginPage.repeatPassword')} />
              </div>
            )}

            {error && (
              <div style={{ marginBottom:'1rem', padding:'0.5rem 0.75rem', borderRadius:'0.4rem',
                background:'color-mix(in srgb, var(--accent-red) 10%, transparent)',
                border:'1px solid color-mix(in srgb, var(--accent-red) 30%, transparent)',
                color:'var(--accent-red)', fontSize:'0.82rem', fontFamily:'monospace' }}>
                {error}
              </div>
            )}

            <button type="submit" disabled={loading} style={{
              width:'100%', padding:'0.6rem', borderRadius:'0.5rem', fontWeight:600,
              fontSize:'0.9rem', cursor: loading ? 'wait' : 'pointer', display:'flex',
              alignItems:'center', justifyContent:'center', gap:'0.5rem', border:'1px solid',
              background:'color-mix(in srgb, var(--accent-green) 18%, transparent)',
              borderColor:'color-mix(in srgb, var(--accent-green) 40%, transparent)',
              color:'var(--accent-green)', transition:'all 0.15s',
            }}>
              {loading ? <Spinner /> : isSetup ? <UserPlus size={16} /> : <LogIn size={16} />}
              {loading ? (isSetup ? t('loginPage.creating') : t('loginPage.signingIn')) : isSetup ? t('loginPage.createAdminAccount') : t('loginPage.signIn')}
            </button>

            {onCancel && (
              <button type="button" onClick={onCancel} style={{
                width:'100%', padding:'0.5rem', marginTop:'0.5rem', borderRadius:'0.5rem',
                fontSize:'0.85rem', cursor:'pointer', border:'1px solid var(--border)',
                background:'transparent', color:'var(--text-3)', transition:'all 0.15s',
              }}>
                ← {t('loginPage.backToFeed')}
              </button>
            )}

            {!isSetup && (
              <button type="button" onClick={() => setShowForgot(true)}
                style={{ background:'none', border:'none', cursor:'pointer',
                  color:'var(--text-3)', fontSize:'0.75rem', marginTop:'0.25rem',
                  textDecoration:'underline', padding:0 }}>
                {t('loginPage.forgotPassword')}
              </button>
            )}
          </form>
        </div>

        {isSetup && (
          <p style={{ color:'var(--text-3)', fontSize:'0.75rem', textAlign:'center', marginTop:'1rem' }}>
            {t('loginPage.firstRunSetup')}
          </p>
        )}
      </div>
    </div>
  );
}

function Spinner() {
  return <div style={{ width:'14px', height:'14px', borderRadius:'50%', flexShrink:0,
    border:'2px solid color-mix(in srgb, var(--accent-green) 30%, transparent)',
    borderTopColor:'var(--accent-green)', animation:'spin 0.7s linear infinite' }} />;
}
