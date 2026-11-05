import { useState, useEffect, useRef } from 'preact/hooks';
import { db, log, ui, closePeek, updateTask, deleteTask, toggleDone, timer, startTimer, stopTimer, plan, courses, settings } from './state.js';
import { Icon, CoursePill, courseColor, dueInfo, subLabel } from './ui.jsx';
import { KINDS } from '../../shared/model.js';
import { live, uid } from '../../shared/doc.js';
import { fmtMin, today as todayFn, addDays, toLocal, fmtDay, fmtTime } from '../../shared/time.js';

function useEsc(fn) {
  useEffect(() => {
    const h = (e) => { if (e.key === 'Escape') fn(); };
    addEventListener('keydown', h);
    return () => removeEventListener('keydown', h);
  }, [fn]);
}

/**
 * Text that saves itself: shortly after you stop typing, on blur, and when the panel
 * closes (Esc or the scrim), so nothing typed is ever dropped.
 */
function AutoText({ value, onCommit, class: cls, placeholder }) {
  const [v, setV] = useState(value || '');
  const ref = useRef();
  const pending = useRef(null);
  const saveTimer = useRef(null);
  const commitRef = useRef(onCommit);
  commitRef.current = onCommit;
  const flush = () => {
    if (pending.current == null) return;
    const next = pending.current;
    pending.current = null;
    clearTimeout(saveTimer.current);
    commitRef.current(next);
  };
  useEffect(() => { if (pending.current == null) setV(value || ''); }, [value]);
  useEffect(() => () => flush(), []);
  const fit = () => { const el = ref.current; if (el) { el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px`; } };
  useEffect(fit, [v]);
  return (
    <textarea
      ref={ref} class={cls} rows={1} value={v} placeholder={placeholder}
      onInput={(e) => {
        setV(e.target.value);
        pending.current = e.target.value === (value || '') ? null : e.target.value;
        clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(flush, 900);
      }}
      onBlur={flush}
      onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && cls === 'peekTitle') { e.preventDefault(); e.target.blur(); } }}
    />
  );
}

export function Peek() {
  const id = ui.value.peek;
  useEsc(closePeek);
  if (!id) return null;
  const t = db.value?.tasks?.[id];
  if (!t || t.deleted) return null;
  const set = (patch) => updateTask(id, patch, { quiet: true });
  const tz = settings.value.tz;
  const today = todayFn(tz);
  const inf = plan.value?.info.get(id);
  const spent = plan.value?.logged.get(id) || 0;
  const running = timer.value?.task === id;
  const d = dueInfo(t.due);
  const sessions = live(log.value?.sessions).filter((s) => s.task === id || (t.aliases || []).includes(s.task)).sort((a, b) => (a.s < b.s ? 1 : -1));
  const cl = t.checklist || [];
  const setCl = (next) => set({ checklist: next });

  return (
    <>
      <div class="scrim" onClick={closePeek} />
      <aside class="peek" role="dialog" aria-label={t.title}>
        <div class="peekBar">
          <button class="iconBtn" onClick={closePeek} aria-label="Close"><Icon n="x" /></button>
          <div class="spacer" />
          {t.url && <a class="btn" href={t.url} target="_blank" rel="noopener" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, textDecoration: 'none' }}><Icon n="out" size={14} />Open</a>}
          {!t.done && (
            <button class={`btn${running ? ' danger' : ''}`} onClick={() => (running ? stopTimer() : startTimer(id))} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <Icon n={running ? 'stop' : 'play'} size={13} />{running ? 'Stop' : 'Start'}
            </button>
          )}
          <button class={`btn${t.done ? '' : ' primary'}`} onClick={() => toggleDone(id)}>{t.done ? 'Reopen' : 'Done'}</button>
        </div>
        <div class="peekBody">
          <AutoText class="peekTitle" value={t.title} onCommit={(v) => set({ title: v.trim() || t.title })} />

          {t.srcDue && t.srcDue !== t.due && (
            <div class="callout">
              <div style={{ flex: 1 }}>Brightspace says <b>{fmtDay(t.srcDue.slice(0, 10), today)} {fmtTime(t.srcDue.slice(11))}</b>; you set {fmtDay(t.due.slice(0, 10), today)} {fmtTime(t.due.slice(11))}.</div>
              <button class="mini" onClick={() => set({ due: t.srcDue, lock: { ...(t.lock || {}), due: false } })}>Use theirs</button>
            </div>
          )}
          {t.missing && !t.done && (
            <div class="callout gray"><div style={{ flex: 1 }}>No longer listed in Brightspace since {t.missing}. It may have been removed or renamed.</div>
              <button class="mini" onClick={() => deleteTask(id)}>Remove</button></div>
          )}

          <div class="props">
            <div class="pk">Course</div>
            <div class="pv">
              <select value={t.course || ''} onChange={(e) => set({ course: e.target.value || null })} style={{ color: courseColor(t.course), fontWeight: 600 }}>
                <option value="">None</option>
                {live(db.value.courses).map((c) => <option value={c.id}>{c.id}</option>)}
              </select>
            </div>

            <div class="pk">Due</div>
            <div class="pv">
              <input type="datetime-local" value={t.due || ''} onChange={(e) => set({ due: e.target.value || null })} />
              {t.due && !t.done && <span class={`due ${d.cls}`}>{d.text}</span>}
              {t.lock?.due && t.src !== 'manual' && <span class="hint">pinned</span>}
            </div>

            <div class="pk">Plan for</div>
            <div class="pv">
              {[['Today', today], ['Tomorrow', addDays(today, 1)]].map(([l, v]) => (
                <button class={`mini${t.doDate === v ? ' on' : ''}`} onClick={() => set({ doDate: t.doDate === v ? undefined : v })}>{l}</button>
              ))}
              <input type="date" value={t.doDate || ''} onChange={(e) => set({ doDate: e.target.value || undefined })} style={{ width: 140 }} />
            </div>

            <div class="pk">Estimate</div>
            <div class="pv">
              {[30, 60, 120, 180].map((m) => (
                <button class={`mini${t.est === m ? ' on' : ''}`} onClick={() => set({ est: t.est === m ? undefined : m })}>{fmtMin(m)}</button>
              ))}
              <input type="number" min="0" step="5" placeholder="min" value={t.est ?? ''} onChange={(e) => set({ est: e.target.value === '' ? undefined : +e.target.value })} style={{ width: 64 }} />
              {inf && t.est == null && <span class="hint">≈{fmtMin(inf.est.min)} {inf.est.basis === 'similar' ? `from ${inf.est.n} similar` : inf.est.basis === 'kind' ? `from ${inf.est.n} past` : ''}</span>}
            </div>

            <div class="pk">Logged</div>
            <div class="pv">{spent ? fmtMin(spent) : <span class="hint">nothing yet</span>}{inf?.est.min > 0 && spent > inf.est.min && <span class="tag orange">{fmtMin(spent - inf.est.min)} over estimate</span>}{running && <span class="tag red">running</span>}</div>

            <div class="pk">Type</div>
            <div class="pv">
              <select value={t.kind || 'task'} onChange={(e) => set({ kind: e.target.value })}>
                {Object.entries(KINDS).map(([k, v]) => <option value={k}>{v.label}</option>)}
              </select>
              <button class={`mini${t.pri ? ' on' : ''}`} onClick={() => set({ pri: t.pri ? undefined : 1 })}><Icon n="flag" size={11} /> High</button>
            </div>

            <div class="pk">Link</div>
            <div class="pv">
              <input type="url" value={t.url || ''} placeholder="Add a link" onChange={(e) => set({ url: e.target.value || undefined })} style={{ flex: 1, color: 'var(--text-2)' }} />
            </div>

            {(t.sub || t.opened || t.info) && (
              <>
                <div class="pk">Status</div>
                <div class="pv" style={{ color: 'var(--text-2)', fontSize: 13 }}>
                  {t.sub && <span class="tag green">{subLabel(t.sub)} {t.sub.length > 10 ? fmtDay(t.sub.slice(0, 10), today) : ''}</span>}
                  {t.opened && !t.sub && <span class="tag">Opened {fmtDay(t.opened.slice(0, 10), today)}</span>}
                  {t.info && <span>{t.info}</span>}
                </div>
              </>
            )}
          </div>

          <div class="sect">Checklist</div>
          {cl.map((it, i) => (
            <div key={it.id || i} class="cl">
              <button class={`check${it.done ? ' on' : ''}`} style={{ '--c': courseColor(t.course), width: 16, height: 16 }} onClick={() => setCl(cl.map((x, j) => (j === i ? { ...x, done: !x.done } : x)))}>
                {it.done && <Icon n="check" size={10} sw={2.6} />}
              </button>
              <input type="text" value={it.text} onChange={(e) => setCl(cl.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))} style={it.done ? { textDecoration: 'line-through', color: 'var(--text-3)' } : null} />
              <button class="x iconBtn" onClick={() => setCl(cl.filter((_, j) => j !== i))} aria-label="Remove"><Icon n="x" size={12} /></button>
            </div>
          ))}
          <div class="cl">
            <span style={{ width: 16, display: 'grid', placeItems: 'center', color: 'var(--text-3)' }}><Icon n="plus" size={12} /></span>
            <input type="text" placeholder="Add a step" onKeyDown={(e) => { if (e.key === 'Enter' && e.target.value.trim()) { setCl([...cl, { id: uid('c'), text: e.target.value.trim(), done: false }]); e.target.value = ''; } }} />
          </div>

          <div class="sect">Notes</div>
          <AutoText class="notes" value={t.notes} placeholder="Write anything…" onCommit={(v) => set({ notes: v || undefined })} />

          {sessions.length > 0 && (
            <>
              <div class="sect">Time</div>
              <div class="sessions">
                {sessions.slice(0, 12).map((s) => {
                  const a = toLocal(s.s, tz), b = toLocal(s.e, tz);
                  return <div><span>{fmtDay(a.slice(0, 10), today)} · {fmtTime(a.slice(11))}–{fmtTime(b.slice(11))}{s.src === 'auto' ? ' · auto' : ''}</span><span>{fmtMin((Date.parse(s.e) - Date.parse(s.s)) / 6e4)}</span></div>;
                })}
              </div>
            </>
          )}

          <div style={{ marginTop: 28, display: 'flex', gap: 8, alignItems: 'center' }}>
            <button class="btn subtle danger" onClick={() => deleteTask(id)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon n="trash" size={13} />Remove</button>
            <div class="spacer" />
            <span style={{ color: 'var(--text-3)', fontSize: 12 }}>{t.src === 'manual' ? 'Added by you' : t.src === 'mylab' ? 'From MyLab' : 'From Brightspace'}</span>
          </div>
        </div>
      </aside>
    </>
  );
}
