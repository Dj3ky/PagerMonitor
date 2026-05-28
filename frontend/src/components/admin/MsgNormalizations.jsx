import { useState, useEffect, useMemo } from 'react';
import { Wand2, Plus, Trash2, Save } from 'lucide-react';
import { adminFetchMsgNorm, adminSaveMsgNorm } from '../../utils/api.js';

function applyRules(rules, text) {
  let out = text;
  for (const { pattern, replace } of rules) {
    if (!pattern) continue;
    try { out = out.replace(new RegExp(pattern, 'g'), replace); } catch (_) {}
  }
  return out;
}

function isValidRegex(pattern) {
  if (!pattern) return true;
  try { new RegExp(pattern); return true; } catch (_) { return false; }
}

export default function MsgNormalizations() {
  const [rules, setRules]   = useState([]);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg]       = useState(null);
  const [testInput, setTestInput] = useState('');

  useEffect(() => {
    adminFetchMsgNorm()
      .then(r => setRules(Array.isArray(r) ? r : []))
      .catch(console.warn);
  }, []);

  const flash = (type, text) => { setMsg({ type, text }); setTimeout(() => setMsg(null), 3500); };

  const addRule = () => setRules(r => [...r, { pattern: '', replace: '' }]);

  const updateRule = (i, field, value) =>
    setRules(r => r.map((rule, idx) => idx === i ? { ...rule, [field]: value } : rule));

  const removeRule = i => setRules(r => r.filter((_, idx) => idx !== i));

  const save = async () => {
    if (rules.some(r => !isValidRegex(r.pattern))) {
      flash('err', 'One or more patterns are invalid regex');
      return;
    }
    setSaving(true);
    try { await adminSaveMsgNorm(rules); flash('ok', 'Saved'); }
    catch (e) { flash('err', e.message); }
    finally { setSaving(false); }
  };

  const testOutput = useMemo(() => applyRules(rules, testInput), [rules, testInput]);
  const testChanged = testInput !== testOutput;

  return (
    <div style={{ maxWidth: '600px' }}>
      <h2 style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--text-1)', marginBottom: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <Wand2 size={16} style={{ color: 'var(--accent-green)' }} /> Message Normalizations
      </h2>
      <p style={{ fontSize: '0.82rem', color: 'var(--text-3)', marginBottom: '1rem' }}>
        Regex rules applied to every decoded message before it is stored or geocoded.
        Rules run in order, top to bottom. Pattern uses JavaScript regex syntax (no flags needed — global is always applied).
      </p>

      <div className="pm-card" style={{ marginBottom: '1rem' }}>
        {rules.length === 0 && (
          <div style={{ fontSize: '0.82rem', color: 'var(--text-3)', marginBottom: '0.75rem' }}>
            No rules defined. Click <strong>Add rule</strong> to create one.
          </div>
        )}

        {rules.map((rule, i) => {
          const patternInvalid = rule.pattern && !isValidRegex(rule.pattern);
          return (
            <div key={i} style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start', marginBottom: '0.6rem' }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: '0.72rem', color: 'var(--text-3)', marginBottom: '0.2rem' }}>Pattern</div>
                <input
                  className="pm-input"
                  placeholder="e.g. :\\s*\\/(\\w)"
                  value={rule.pattern}
                  onChange={e => updateRule(i, 'pattern', e.target.value)}
                  style={{ fontFamily: 'monospace', fontSize: '0.82rem', borderColor: patternInvalid ? 'var(--accent-red)' : undefined }}
                />
                {patternInvalid && (
                  <div style={{ fontSize: '0.7rem', color: 'var(--accent-red)', marginTop: '0.2rem' }}>Invalid regex</div>
                )}
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: '0.72rem', color: 'var(--text-3)', marginBottom: '0.2rem' }}>Replace with</div>
                <input
                  className="pm-input"
                  placeholder="e.g. : $1"
                  value={rule.replace}
                  onChange={e => updateRule(i, 'replace', e.target.value)}
                  style={{ fontFamily: 'monospace', fontSize: '0.82rem' }}
                />
              </div>
              <button
                onClick={() => removeRule(i)}
                style={{ marginTop: '1.4rem', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-3)', padding: '0.3rem' }}
                title="Remove rule"
              >
                <Trash2 size={14} />
              </button>
            </div>
          );
        })}

        <button className="pm-btn" onClick={addRule} style={{ marginTop: '0.25rem' }}>
          <Plus size={13} /> Add rule
        </button>
      </div>

      <div className="pm-card" style={{ marginBottom: '1rem' }}>
        <div style={{ fontSize: '0.82rem', fontWeight: 600, color: 'var(--text-2)', marginBottom: '0.5rem' }}>Live test</div>
        <div style={{ fontSize: '0.72rem', color: 'var(--text-3)', marginBottom: '0.5rem' }}>
          Type a raw message to preview how the rules transform it.
        </div>
        <input
          className="pm-input"
          placeholder="Paste a message to test all rules…"
          value={testInput}
          onChange={e => setTestInput(e.target.value)}
          style={{ fontFamily: 'monospace', fontSize: '0.82rem', marginBottom: '0.5rem' }}
        />
        {testInput && (
          <div style={{
            padding: '0.5rem 0.75rem', borderRadius: '0.35rem', fontFamily: 'monospace', fontSize: '0.82rem',
            background: testChanged ? 'color-mix(in srgb, var(--accent-green) 8%, transparent)' : 'var(--bg-3)',
            border: `1px solid ${testChanged ? 'color-mix(in srgb, var(--accent-green) 30%, transparent)' : 'var(--border-1)'}`,
            color: testChanged ? 'var(--accent-green)' : 'var(--text-3)',
          }}>
            {testChanged ? testOutput : 'No change — rules do not match this input'}
          </div>
        )}
      </div>

      {msg && (
        <div style={{
          marginBottom: '0.75rem', padding: '0.45rem 0.75rem', borderRadius: '0.4rem', fontSize: '0.78rem', fontFamily: 'monospace',
          color: msg.type === 'ok' ? 'var(--accent-green)' : 'var(--accent-red)',
          background: `color-mix(in srgb, ${msg.type === 'ok' ? 'var(--accent-green)' : 'var(--accent-red)'} 10%, transparent)`,
          border: `1px solid color-mix(in srgb, ${msg.type === 'ok' ? 'var(--accent-green)' : 'var(--accent-red)'} 30%, transparent)`,
        }}>{msg.text}</div>
      )}

      <button className="pm-btn pm-btn-primary" onClick={save} disabled={saving}>
        <Save size={13} /> {saving ? 'Saving…' : 'Save'}
      </button>
    </div>
  );
}
