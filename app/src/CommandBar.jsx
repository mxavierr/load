import { useState, useEffect, useRef } from 'preact/hooks';
import { db, ui, settings, courses, addTask, ask, closeRequest, runOps, conn } from './state.js';
import { Icon, CoursePill } from './ui.jsx';
import { parseQuick } from '../../shared/quickadd.js';
import { describeOp } from '../../shared/ops.js';
import { live } from '../../shared/doc.js';
import { fmtDay, fmtTime, fmtMin, today as todayFn } from '../../shared/time.js';

/**
 * One box for everything: type a task and it is parsed as you go
 * ("phys lab report fri 5pm 2h"); type a change or a question and Enter sends it off.
 * Tab switches between the two when the guess is wrong.
 */
export function CommandBar() {
  const [text, setText] = useState('');
  const [force, setForce] = useState(null); // null | 'add' | 'ask'
  const ref = useRef();

  useEffect(() => {
    const h = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); ref.current?.focus(); }
      else if (e.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName)) { e.preventDefault(); ref.current?.focus(); }
    };
    addEventListener('keydown', h);
    return () => removeEventListener('keydown', h);
  }, []);

  const p = text.trim() ? parseQuick(text, { courses: live(db.value?.courses), tz: settings.value.tz }) : null;
  const mode = force || (p?.command ? 'ask' : 'add');
  const today = todayFn(settings.value.tz);

  const submit = () => {
    const s = text.trim();
    if (!s) return;
    if (mode === 'ask') ask(s);
    else addTask({ title: p.title || s, course: p.course, due: p.due, est: p.est, kind: p.kind, pri: p.pri });
    setText('');
    setForce(null);
  };

  const req = ui.value.answer ? db.value?.inbox?.[ui.value.answer] : null;

  return (
    <div class="cmd">
      <div class="cmdBox">
        <span class="cmdIcon"><Icon n={mode === 'ask' ? 'sparkle' : 'plus'} /></span>
        <input
          ref={ref}
          value={text}
          placeholder="Add a task, or ask for a change…"
          enterKeyHint="go"
          autocomplete="off"
          onInput={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); submit(); }
            else if (e.key === 'Tab' && text.trim()) { e.preventDefault(); setForce(mode === 'ask' ? 'add' : 'ask'); }
            else if (e.key === 'Escape') { setText(''); setForce(null); e.target.blur(); }
          }}
        />
        {p && mode === 'add' && (
          <span class="cmdChips">
            {p.course && <CoursePill id={p.course} />}
            {p.due && <span class="tag">{fmtDay(p.due.slice(0, 10), today)} {fmtTime(p.due.slice(11))}</span>}
            {p.est && <span class="tag">{fmtMin(p.est)}</span>}
            {p.pri ? <span class="tag red">High</span> : null}
          </span>
        )}
        {text.trim() && (
          <button class={`cmdGo${mode === 'ask' ? ' ask' : ''}`} onClick={submit} title="Tab to switch">
            {mode === 'ask' ? 'Do it' : 'Add'} <span style={{ opacity: 0.7 }}>↵</span>
          </button>
        )}
      </div>
      {req && <Answer req={req} />}
    </div>
  );
}

function Answer({ req }) {
  const close = (status) => closeRequest(req.id, status);
  const waiting = req.status === 'new' || req.status === 'working';
  const offline = waiting && conn.value.mode !== 'hub' && Date.now() - Date.parse(req.at) > 20e3;
  return (
    <div class="answer">
      <div class="q">{req.text}</div>
      {waiting && (
        <div class="working">
          <span class="spinner" />
          {offline ? 'Queued. It will be answered when your Mac is awake.' : 'Working on it…'}
          <div class="spacer" />
          <button class="btn subtle" onClick={() => close('dismissed')}>Hide</button>
        </div>
      )}
      {!waiting && (
        <>
          <div class="reply">{req.reply}</div>
          {req.ops?.length > 0 && (
            <ul>
              {req.ops.map((op) => (
                <li><Icon n={op.op === 'add' ? 'plus' : op.op === 'delete' ? 'trash' : 'right'} size={12} /><span>{describeOp(op, db.value.tasks)}</span></li>
              ))}
            </ul>
          )}
          <div class="row">
            {req.ops?.length > 0 ? (
              <>
                <button class="btn subtle" onClick={() => close('dismissed')}>Dismiss</button>
                <button class="btn primary" onClick={() => { runOps(req.ops); close('applied'); }}>Apply {req.ops.length > 1 ? `${req.ops.length} changes` : ''}</button>
              </>
            ) : (
              <button class="btn" onClick={() => close('dismissed')}>OK</button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
