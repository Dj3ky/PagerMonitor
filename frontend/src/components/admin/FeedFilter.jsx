import { useState, useEffect } from 'react';
import { EyeOff, Save, ChevronRight, ChevronDown } from 'lucide-react';
import { adminFetchFeedFilter, adminSaveFeedFilter } from '../../utils/api.js';
import { useAdminFetch } from '../../hooks/useAdminFetch.js';
import { adminFetchAliases, adminFetchGroups, adminFetchSdrConfig, adminFetchSdrDongles } from '../../utils/api.js';

// A message can only ever come out of multimon-ng as the type MULTIMON_POCSAG_MODE (-f)
// forces it to — 'skyper' still counts as "not numeric" for our alpha/numeric classification
// (see isNumericMessage in backend/services/config.js). Returns { label, mode } for any local
// dongle whose forced mode can never satisfy the given message_type filter, so the UI can
// warn before someone locks their own feed to a permanently-empty result.
function findPocsagModeConflicts(messageType, sdrConfig, dongles) {
  if (messageType === 'all') return [];
  const neverMatches = mode =>
    (messageType === 'numeric' && (mode === 'alpha' || mode === 'skyper')) ||
    (messageType === 'alpha'   && mode === 'numeric');

  const sources = Array.isArray(dongles) && dongles.length > 0
    ? dongles.map((d, i) => ({ label: d.label || `Dongle ${i + 1}`, mode: d.pocsagMode }))
    : [{ label: 'SDR', mode: sdrConfig?.MULTIMON_POCSAG_MODE }];

  return sources.filter(s => neverMatches(s.mode));
}

// One level of group nesting (top-level "parent" groups + their children) as a collapsible,
// searchable tree. Selecting a parent selects/deselects every child with it — the backend
// treats a selected parent as covering every child regardless of the children's own state
// (see groupMatchesSelection in database.js), so a child left unchecked while its parent
// stays checked would still pass the filter; cascading the checkbox keeps what's on screen
// truthful, and children are locked while their parent is selected so unchecking one can't
// silently do nothing.
function GroupPicker({ groups, selectedIds, onChange }) {
  const [search, setSearch] = useState('');
  const topLevel = groups.filter(g => !g.parent_id);
  const subOf    = pid => groups.filter(g => g.parent_id === pid);
  const [expanded, setExpanded] = useState(() => new Set(
    topLevel.filter(g => subOf(g.id).some(c => selectedIds.includes(c.id))).map(g => g.id)
  ));

  const toggleExpanded = id => setExpanded(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const toggleParent = g => {
    const childIds      = subOf(g.id).map(c => c.id);
    const isSelected     = selectedIds.includes(g.id);
    const withoutBranch  = selectedIds.filter(x => x !== g.id && !childIds.includes(x));
    onChange(isSelected ? withoutBranch : [...withoutBranch, g.id, ...childIds]);
  };

  const toggleLeaf = id => onChange(selectedIds.includes(id) ? selectedIds.filter(x => x !== id) : [...selectedIds, id]);

  if (!groups.length) return <span style={{ fontSize:'0.75rem', color:'var(--text-3)' }}>No groups defined</span>;

  const q           = search.trim().toLowerCase();
  const nameMatches = g => g.name?.toLowerCase().includes(q);
  const visibleTop  = q ? topLevel.filter(g => nameMatches(g) || subOf(g.id).some(nameMatches)) : topLevel;

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:'0.3rem' }}>
      <input className="pm-input" type="text" placeholder="Search groups…"
        value={search} onChange={e => setSearch(e.target.value)}
        style={{ fontSize:'0.75rem', padding:'0.25rem 0.5rem' }} />
      {q && !visibleTop.length && <span style={{ fontSize:'0.72rem', color:'var(--text-3)' }}>No matches</span>}
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
                  title={isExpanded ? 'Collapse' : 'Expand'}
                  style={{ background:'none', border:'none', cursor:'pointer', color:'var(--text-3)',
                    padding:'0.1rem', display:'flex', flexShrink:0 }}>
                  {isExpanded ? <ChevronDown size={12}/> : <ChevronRight size={12}/>}
                </button>
              ) : <span style={{ width:'17px', flexShrink:0 }} />}
              <label style={{ display:'flex', alignItems:'center', gap:'0.3rem', fontSize:'0.78rem', cursor:'pointer',
                padding:'0.2rem 0.55rem', borderRadius:'0.3rem', flex:1,
                border: `1px solid ${parentSelected ? 'color-mix(in srgb,' + (g.color || 'var(--accent-green)') + ' 50%,transparent)' : 'var(--border)'}`,
                background: parentSelected ? 'color-mix(in srgb,' + (g.color || 'var(--accent-green)') + ' 12%,transparent)' : 'var(--bg-0)' }}>
                <input type="checkbox" checked={parentSelected} onChange={() => toggleParent(g)}
                  style={{ accentColor: g.color || 'var(--accent-green)' }} />
                <span style={{ color: g.color || 'var(--accent-green)', fontWeight: 600 }}>{g.name}</span>
                {allChildren.length > 0 && <span style={{ fontSize:'0.62rem', color:'var(--text-3)' }}>({allChildren.length})</span>}
              </label>
            </div>
            {isExpanded && children.map(sub => (
              <label key={sub.id} title={parentSelected ? 'Included via its parent group — uncheck the parent to select individually' : undefined}
                style={{ display:'flex', alignItems:'center', gap:'0.3rem', fontSize:'0.78rem',
                  cursor: parentSelected ? 'default' : 'pointer', padding:'0.2rem 0.55rem', borderRadius:'0.3rem',
                  border:'1px solid var(--border)', background:'var(--bg-0)', marginLeft:'1.4rem',
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

const MODES = [
  { id: 'show_all',        label: 'Accept all',          desc: 'No filtering — all received messages are processed normally.' },
  { id: 'ignore_capcodes', label: 'Ignore capcodes',     desc: 'Drop messages from specific capcodes. All other messages are processed normally.' },
  { id: 'only_capcodes',   label: 'Only capcodes',       desc: 'Only process messages from the listed capcodes. Everything else is dropped.' },
  { id: 'only_groups',     label: 'Only groups',         desc: 'Only process messages whose alias belongs to one of the selected groups. Everything else is dropped.' },
  { id: 'only_aliases',    label: 'Only aliased',        desc: 'Only process messages from capcodes that have an alias. Unaliased capcodes are dropped. Optionally restrict to specific aliases.' },
];

const MESSAGE_TYPES = [
  { id: 'all',     label: 'All' },
  { id: 'alpha',   label: 'Alpha only' },
  { id: 'numeric', label: 'Numeric only' },
];

const DEFAULTS = { mode: 'show_all', capcodes: [], group_ids: [], text_strings: [], text_regex: [], message_type: 'all' };

function sanitise(raw) {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  return {
    mode:         MODES.map(m => m.id).includes(raw.mode) ? raw.mode : 'show_all',
    capcodes:     Array.isArray(raw.capcodes)     ? raw.capcodes : [],
    group_ids:    Array.isArray(raw.group_ids)    ? raw.group_ids.map(Number) : [],
    text_strings: Array.isArray(raw.text_strings) ? raw.text_strings : [],
    text_regex:   Array.isArray(raw.text_regex)   ? raw.text_regex : [],
    message_type: MESSAGE_TYPES.map(t => t.id).includes(raw.message_type) ? raw.message_type : 'all',
  };
}

function setListField(value) {
  return value.split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
}

export default function FeedFilter() {
  const { data: rawFilter,  loading: loadingFilter  } = useAdminFetch(adminFetchFeedFilter,  DEFAULTS);
  const { data: rawAliases, loading: loadingAliases } = useAdminFetch(adminFetchAliases, []);
  const { data: rawGroups,  loading: loadingGroups  } = useAdminFetch(adminFetchGroups,  []);
  // Best-effort — a non-platform org (or any fetch failure) just leaves these at their
  // defaults, which findPocsagModeConflicts treats as "no forced mode", i.e. no warning.
  const { data: sdrConfig } = useAdminFetch(adminFetchSdrConfig,  {});
  const { data: dongles }   = useAdminFetch(adminFetchSdrDongles, []);

  const [filter, setFilter] = useState(sanitise(null));
  const [saving, setSaving] = useState(false);
  const [msg,    setMsg]    = useState(null);

  useEffect(() => { if (rawFilter) setFilter(sanitise(rawFilter)); }, [rawFilter]);

  const aliases = Array.isArray(rawAliases) ? rawAliases : [];
  const groups  = Array.isArray(rawGroups)  ? rawGroups : [];

  const flash = (type, text) => { setMsg({ type, text }); setTimeout(() => setMsg(null), 4000); };

  const save = async () => {
    setSaving(true);
    try { await adminSaveFeedFilter(filter); flash('ok', 'Feed filter saved'); }
    catch (e) { flash('err', e.message); }
    finally { setSaving(false); }
  };

  if (loadingFilter) return (
    <div style={{ color: 'var(--text-3)', fontFamily: 'monospace', fontSize: '0.85rem' }}>Loading…</div>
  );

  const safe        = sanitise(filter);
  const isFiltering = safe.mode !== 'show_all' || safe.text_strings.length > 0 || safe.text_regex.length > 0 || safe.message_type !== 'all';
  const pocsagModeConflicts = findPocsagModeConflicts(safe.message_type, sdrConfig, dongles);

  return (
    <div style={{ maxWidth: '640px' }}>
      <h2 style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--text-1)',
        marginBottom: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <EyeOff size={16} style={{ color: 'var(--accent-blue)' }} />
        Feed Filter
      </h2>

      <p style={{ fontSize: '0.82rem', color: 'var(--text-3)', marginBottom: '1rem', lineHeight: 1.6 }}>
        Controls which messages are processed. Filtered messages are <strong style={{ color: 'var(--accent-red, #f87171)' }}>completely ignored</strong> —
        not saved to the database, not shown in the feed or archive, and no notifications are sent.
      </p>

      {isFiltering && (
        <div style={{
          padding: '0.5rem 0.75rem', borderRadius: '0.4rem', marginBottom: '1rem',
          fontSize: '0.78rem', fontFamily: 'monospace',
          background: 'color-mix(in srgb, var(--accent-yellow, #f59e0b) 10%, transparent)',
          border: '1px solid color-mix(in srgb, var(--accent-yellow, #f59e0b) 30%, transparent)',
          color: 'var(--accent-yellow, #f59e0b)',
        }}>
          ⚠ Feed filter is active — some messages are being completely ignored (not saved, no notifications).
        </div>
      )}

      {msg && (
        <div style={{
          padding: '0.45rem 0.75rem', borderRadius: '0.4rem', fontSize: '0.78rem',
          fontFamily: 'monospace', marginBottom: '0.75rem',
          color: msg.type === 'ok' ? 'var(--accent-green)' : 'var(--accent-red)',
          background: `color-mix(in srgb, ${msg.type === 'ok' ? 'var(--accent-green)' : 'var(--accent-red)'} 10%, transparent)`,
          border: `1px solid color-mix(in srgb, ${msg.type === 'ok' ? 'var(--accent-green)' : 'var(--accent-red)'} 30%, transparent)`,
        }}>{msg.text}</div>
      )}

      {/* Mode selector */}
      <div className="pm-card" style={{ marginBottom: '1rem' }}>
        <div className="pm-section-title">Filter Mode</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
          {MODES.map(m => (
            <label key={m.id} onClick={() => setFilter(f => ({ ...sanitise(f), mode: m.id }))}
              style={{
                display: 'flex', alignItems: 'flex-start', gap: '0.6rem',
                padding: '0.45rem 0.65rem', borderRadius: '0.4rem', cursor: 'pointer',
                border: '1px solid',
                background: safe.mode === m.id
                  ? 'color-mix(in srgb,var(--accent-blue) 12%,transparent)'
                  : 'var(--bg-3)',
                borderColor: safe.mode === m.id
                  ? 'color-mix(in srgb,var(--accent-blue) 35%,transparent)'
                  : 'var(--border)',
                transition: 'all 0.12s',
              }}>
              <input type="radio" name="feed_filter_mode" value={m.id}
                checked={safe.mode === m.id}
                onChange={() => setFilter(f => ({ ...sanitise(f), mode: m.id }))}
                style={{ marginTop: '2px', flexShrink: 0, accentColor: 'var(--accent-blue)' }} />
              <span>
                <span style={{
                  fontSize: '0.82rem', fontWeight: 600,
                  color: safe.mode === m.id ? 'var(--accent-blue)' : 'var(--text-1)',
                }}>{m.label}</span>
                <span style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-3)', marginTop: '0.1rem' }}>
                  {m.desc}
                </span>
              </span>
            </label>
          ))}
        </div>
      </div>

      {/* Ignore capcodes — blacklist textarea */}
      {safe.mode === 'ignore_capcodes' && (
        <div className="pm-card" style={{ marginBottom: '1rem' }}>
          <div className="pm-section-title">Capcodes to ignore (one per line or comma-separated)</div>
          <textarea className="pm-input" rows={5}
            value={safe.capcodes.join('\n')}
            onChange={e => setFilter(f => ({ ...sanitise(f), capcodes: setListField(e.target.value) }))}
            placeholder={'1234567\n2345678\n3456789'}
            style={{ resize: 'vertical', fontFamily: 'monospace', fontSize: '0.8rem' }} />
          <div style={{ fontSize: '0.73rem', color: 'var(--text-3)', marginTop: '0.4rem' }}>
            {safe.capcodes.length > 0
              ? `${safe.capcodes.length} capcode(s) will be dropped. All others are processed normally.`
              : 'No capcodes entered — all messages will be processed.'}
          </div>
        </div>
      )}

      {/* Only capcodes — whitelist textarea */}
      {safe.mode === 'only_capcodes' && (
        <div className="pm-card" style={{ marginBottom: '1rem' }}>
          <div className="pm-section-title">Capcodes to accept (one per line or comma-separated)</div>
          <textarea className="pm-input" rows={5}
            value={safe.capcodes.join('\n')}
            onChange={e => setFilter(f => ({ ...sanitise(f), capcodes: setListField(e.target.value) }))}
            placeholder={'1234567\n2345678\n3456789'}
            style={{ resize: 'vertical', fontFamily: 'monospace', fontSize: '0.8rem' }} />
          <div style={{ fontSize: '0.73rem', color: 'var(--text-3)', marginTop: '0.4rem' }}>
            {safe.capcodes.length > 0
              ? `Only messages from these ${safe.capcodes.length} capcode(s) will be processed. Everything else is dropped.`
              : 'No capcodes entered — all messages will be dropped.'}
          </div>
        </div>
      )}

      {/* Only groups — group checkboxes */}
      {safe.mode === 'only_groups' && (
        <div className="pm-card" style={{ marginBottom: '1rem' }}>
          <div className="pm-section-title">
            Groups to accept ({safe.group_ids.length} selected)
          </div>
          {loadingGroups
            ? <div style={{ color: 'var(--text-3)', fontSize: '0.82rem' }}>Loading groups…</div>
            : groups.length === 0
              ? <div style={{ color: 'var(--text-3)', fontSize: '0.82rem' }}>
                  No groups defined yet. Create groups in <em>Admin → Groups</em>.
                </div>
              : (
                <GroupPicker groups={groups} selectedIds={safe.group_ids}
                  onChange={ids => setFilter(f => ({ ...sanitise(f), group_ids: ids }))} />
              )
          }
          {safe.group_ids.length === 0 && groups.length > 0 && (
            <div style={{ fontSize: '0.73rem', color: 'var(--accent-red, #f87171)', marginTop: '0.5rem' }}>
              No groups selected — all messages will be dropped until you pick at least one.
            </div>
          )}
        </div>
      )}

      {/* Only aliases — show all aliased, optionally filter to specific ones */}
      {safe.mode === 'only_aliases' && (
        <div className="pm-card" style={{ marginBottom: '1rem' }}>
          <div className="pm-section-title">
            Specific aliases to accept
            <span style={{ fontWeight: 400, color: 'var(--text-3)', marginLeft: '0.4rem' }}>
              (leave empty to accept <em>all</em> aliased capcodes)
            </span>
          </div>
          {loadingAliases
            ? <div style={{ color: 'var(--text-3)', fontSize: '0.82rem' }}>Loading aliases…</div>
            : aliases.length === 0
              ? <div style={{ color: 'var(--text-3)', fontSize: '0.82rem' }}>
                  No aliases defined yet. Add them in <em>Admin → Aliases</em>.
                </div>
              : (
                <>
                  <div style={{
                    maxHeight: '260px', overflowY: 'auto',
                    display: 'flex', flexWrap: 'wrap', gap: '0.3rem',
                    marginBottom: '0.5rem',
                  }}>
                    {aliases.map(a => (
                      <label key={a.capcode} style={{
                        display: 'flex', alignItems: 'center', gap: '0.3rem',
                        fontSize: '0.75rem', cursor: 'pointer', padding: '0.18rem 0.45rem',
                        borderRadius: '0.3rem', whiteSpace: 'nowrap',
                        border: `1px solid ${safe.capcodes.includes(a.capcode)
                          ? 'color-mix(in srgb,' + (a.color || 'var(--accent-green)') + ' 50%,transparent)'
                          : 'var(--border)'}`,
                        background: safe.capcodes.includes(a.capcode)
                          ? 'color-mix(in srgb,' + (a.color || 'var(--accent-green)') + ' 12%,transparent)'
                          : 'var(--bg-0)',
                      }}>
                        <input type="checkbox"
                          checked={safe.capcodes.includes(a.capcode)}
                          onChange={e => {
                            const caps = e.target.checked
                              ? [...safe.capcodes, a.capcode]
                              : safe.capcodes.filter(x => x !== a.capcode);
                            setFilter(f => ({ ...sanitise(f), capcodes: caps }));
                          }}
                          style={{ accentColor: a.color || 'var(--accent-green)' }} />
                        <span style={{ color: a.color || 'var(--accent-green)', fontWeight: 600 }}>{a.name}</span>
                        <span style={{ color: 'var(--text-3)', fontFamily: 'monospace', fontSize: '0.68rem' }}>
                          {a.capcode}
                        </span>
                      </label>
                    ))}
                  </div>
                  <div style={{ fontSize: '0.73rem', color: 'var(--text-3)' }}>
                    {safe.capcodes.length === 0
                      ? `All ${aliases.length} aliased capcode(s) will be accepted. Unaliased capcodes are dropped.`
                      : `Only ${safe.capcodes.length} of ${aliases.length} aliased capcode(s) will be accepted. Everything else is dropped.`}
                  </div>
                </>
              )
          }
        </div>
      )}

      {/* Message type — alpha vs numeric, independent of mode above */}
      <div className="pm-card" style={{ marginBottom: '1rem' }}>
        <div className="pm-section-title">Message type</div>
        <div style={{ fontSize: '0.75rem', color: 'var(--text-3)', marginBottom: '0.6rem', lineHeight: 1.55 }}>
          Runs <strong>after</strong> the selected mode above. Based on the message type multimon-ng itself
          decoded (Alpha/Numeric/Skyper) — messages aren't re-classified here, just dropped before reaching the feed.
        </div>
        {pocsagModeConflicts.length > 0 && (
          <div style={{
            padding: '0.5rem 0.75rem', borderRadius: '0.4rem', marginBottom: '0.6rem',
            fontSize: '0.78rem', lineHeight: 1.5,
            background: 'color-mix(in srgb, var(--accent-red, #f87171) 10%, transparent)',
            border: '1px solid color-mix(in srgb, var(--accent-red, #f87171) 30%, transparent)',
            color: 'var(--accent-red, #f87171)',
          }}>
            ⚠ POCSAG mode (-f) is forced on {pocsagModeConflicts.map((c, i) => (
              <span key={c.label}>{i > 0 ? ', ' : ''}<strong>{c.label}</strong> (mode: {c.mode})</span>
            ))} — {pocsagModeConflicts.length > 1 ? 'those decoders' : 'that decoder'} can never
            produce a message matching "{MESSAGE_TYPES.find(t => t.id === safe.message_type)?.label}". This filter will silently empty that part of the feed.
          </div>
        )}
        <div style={{ display: 'flex', gap: '0.4rem' }}>
          {MESSAGE_TYPES.map(t => (
            <label key={t.id} onClick={() => setFilter(f => ({ ...sanitise(f), message_type: t.id }))}
              style={{
                flex: 1, textAlign: 'center', padding: '0.4rem 0.5rem', borderRadius: '0.4rem', cursor: 'pointer',
                fontSize: '0.8rem', fontWeight: 600, border: '1px solid',
                color: safe.message_type === t.id ? 'var(--accent-blue)' : 'var(--text-2)',
                background: safe.message_type === t.id
                  ? 'color-mix(in srgb,var(--accent-blue) 12%,transparent)'
                  : 'var(--bg-3)',
                borderColor: safe.message_type === t.id
                  ? 'color-mix(in srgb,var(--accent-blue) 35%,transparent)'
                  : 'var(--border)',
                transition: 'all 0.12s',
              }}>
              <input type="radio" name="feed_filter_message_type" value={t.id}
                checked={safe.message_type === t.id}
                onChange={() => setFilter(f => ({ ...sanitise(f), message_type: t.id }))}
                style={{ display: 'none' }} />
              {t.label}
            </label>
          ))}
        </div>
      </div>

      <div className="pm-card" style={{ marginBottom: '1rem' }}>
        <div className="pm-section-title">Message content filters</div>
        <div style={{ fontSize: '0.75rem', color: 'var(--text-3)', marginBottom: '0.7rem', lineHeight: 1.55 }}>
          These filters run <strong>after</strong> the selected mode above. If a message body contains one of the strings
          or matches one of the regex patterns below, it is dropped completely and never stored.
        </div>

        <div style={{ display: 'grid', gap: '0.85rem' }}>
          <div>
            <div className="pm-section-title" style={{ marginBottom: '0.35rem' }}>
              Drop when message contains one of these strings
            </div>
            <textarea className="pm-input" rows={4}
              value={safe.text_strings.join('\n')}
              onChange={e => setFilter(f => ({ ...sanitise(f), text_strings: setListField(e.target.value) }))}
              placeholder={'Test message\nRoutine alert\nSystem check'}
              style={{ resize: 'vertical', fontFamily: 'monospace', fontSize: '0.8rem' }} />
            <div style={{ fontSize: '0.73rem', color: 'var(--text-3)', marginTop: '0.35rem' }}>
              Plain string match, case-insensitive. {safe.text_strings.length} string filter(s) configured.
            </div>
          </div>

          <div>
            <div className="pm-section-title" style={{ marginBottom: '0.35rem' }}>
              Drop when message matches one of these regex patterns
            </div>
            <textarea className="pm-input" rows={4}
              value={safe.text_regex.join('\n')}
              onChange={e => setFilter(f => ({ ...sanitise(f), text_regex: setListField(e.target.value) }))}
              placeholder={'^TEST\\b\n\\bmaintenance\\b'}
              style={{ resize: 'vertical', fontFamily: 'monospace', fontSize: '0.8rem' }} />
            <div style={{ fontSize: '0.73rem', color: 'var(--text-3)', marginTop: '0.35rem' }}>
              Regex match, case-insensitive. Invalid regex patterns are ignored. Patterns prone to catastrophic
              backtracking (e.g. nested repetition like <code>(a+)+</code>) or longer than 200 characters are
              rejected on save.
            </div>
          </div>
        </div>
      </div>

      <button className="pm-btn pm-btn-primary" onClick={save} disabled={saving}>
        <Save size={13} /> {saving ? 'Saving…' : 'Save filter'}
      </button>
    </div>
  );
}
