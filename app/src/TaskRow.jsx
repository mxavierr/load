import { ui, toggleDone, openPeek, timer, startTimer, stopTimer, plan } from './state.js';
import { Icon, CoursePill, courseColor, dueInfo } from './ui.jsx';
import { fmtMin, fmtDay, today as todayFn, addDays } from '../../shared/time.js';
import { KINDS } from '../../shared/model.js';

/**
 * One task. `min` (planned minutes today) shows as a slice of the whole when the plan
 * splits a big task across days.
 */
export function TaskRow({ t, min, why, showDue = true, compact }) {
  const c = courseColor(t.course);
  const d = dueInfo(t.due);
  const running = timer.value?.task === t.id;
  const inf = plan.value?.info.get(t.id);
  const est = inf?.est.min ?? t.est;
  const spent = plan.value?.logged.get(t.id) || 0;
  const sel = ui.value.peek === t.id;
  const isEvent = t.kind === 'event' || (t.kind === 'exam' && t.src !== 'manual' && !t.url?.includes('quiz'));

  const onDrag = (e) => {
    e.dataTransfer.setData('text/load-task', t.id);
    e.dataTransfer.effectAllowed = 'move';
  };

  return (
    <div class={`task${t.done ? ' done' : ''}${sel ? ' sel' : ''}`} onClick={() => openPeek(t.id)} draggable={!t.done} onDragStart={onDrag}>
      <button
        class={`check${t.done ? ' on' : ''}${isEvent ? ' ev' : ''}`}
        style={{ '--c': c }}
        aria-label={t.done ? 'Mark not done' : 'Mark done'}
        onClick={(e) => { e.stopPropagation(); toggleDone(t.id); }}
      >
        {t.done && <Icon n="check" size={12} sw={2.4} />}
      </button>
      <div class="tmain">
        <div class="ttl">{t.title}</div>
        {!compact && (
          <div class="tmeta">
            <CoursePill id={t.course} />
            {t.pri ? <span class="tag red"><Icon n="flag" size={11} />High</span> : null}
            {why === 'pinned' && <span class="tag blue">Planned</span>}
            {why === 'ahead' && min && est && min < est - spent - 1 ? <span class="tag">{fmtMin(min)} of {fmtMin(Math.max(est - spent, min))}</span> : null}
            {t.done && t.doneBy === 'sync' && <span class="tag green">Submitted</span>}
            {!t.done && t.sub && <span class="tag green">Submitted</span>}
            {t.moved && !t.done && t.moved.at >= addDays(todayFn(), -3) && <span class="tag orange" title={`was ${t.moved.from.replace('T', ' ')}`}>Moved</span>}
            {t.srcDue && t.srcDue !== t.due && !t.done && <span class="tag orange">Date differs</span>}
            {t.missing && !t.done && <span class="tag">Not in Brightspace</span>}
            {t.checklist?.length ? <span class="tag">{t.checklist.filter((x) => x.done).length}/{t.checklist.length}</span> : null}
            {(t.kind === 'exam' || t.kind === 'quiz') && <span class="tag">{KINDS[t.kind].label}</span>}
            {spent > 0 && !t.done && est ? (
              <span class="split" title={`${fmtMin(spent)} logged`} style={{ '--c': c }}><i style={{ width: `${Math.min(100, (100 * spent) / est)}%` }} /></span>
            ) : null}
          </div>
        )}
      </div>
      <div class="tright">
        {showDue && t.due && !t.done && <span class={`due ${d.cls}`}>{d.text}</span>}
        {showDue && t.due && t.done && <span class="due">{fmtDay(t.due.slice(0, 10), todayFn())}</span>}
        {!t.done && <span class="est">{min ? fmtMin(min) : est ? `~${fmtMin(est)}` : ''}</span>}
        {!t.done && (
          <button
            class={`play${running ? ' on' : ''}`}
            aria-label={running ? 'Stop timer' : 'Start timer'}
            onClick={(e) => { e.stopPropagation(); running ? stopTimer() : startTimer(t.id); }}
          >
            <Icon n={running ? 'stop' : 'play'} size={13} />
          </button>
        )}
      </div>
    </div>
  );
}
