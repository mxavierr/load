import { useState, useMemo } from 'preact/hooks';
import { db, log, library, plan, tasks, settings, courses, findings, conn, updateTask, runOps, requestSync, ask, openPeek, toast, isHub, nowTick, setLayout, markReportItem } from './state.js';
import { TaskRow } from './TaskRow.jsx';
import { Icon, Ring, CoursePill, courseColor, courseShort, relTime, Empty } from './ui.jsx';
import { live } from '../../shared/doc.js';
import { addDays, dayOf, fmtDay, fmtMin, today as todayFn, weekday, DOW, daysBetween, toLocal, asLocal } from '../../shared/time.js';
import { insights } from '../../shared/insights.js';
import { describeOp } from '../../shared/ops.js';

const byDue = (a, b) => (a.due || '9999').localeCompare(b.due || '9999');

function useDrop(onTask) {
  const [over, setOver] = useState(false);
  return [over, {
    onDragOver: (e) => { if (e.dataTransfer.types.includes('text/load-task')) { e.preventDefault(); setOver(true); } },
    onDragLeave: () => setOver(false),
    onDrop: (e) => { const id = e.dataTransfer.getData('text/load-task'); setOver(false); if (id) { e.preventDefault(); onTask(id); } },
  }];
}

// ---------------------------------------------------------------- Today

export function TodayBlock() {
  const p = plan.value;
  const tz = settings.value.tz;
  const today = todayFn(tz);
  const T = tasks.value;
  const [over, drop] = useDrop((id) => { updateTask(id, { doDate: today }, { quiet: true }); toast('Planned for today'); });
  if (!p) return <Empty>Loading…</Empty>;
  const items = p.days[0].items.filter((i) => T[i.id] && !T[i.id].done);
  const overdue = items.filter((i) => i.why === 'overdue');
  const rest = items.filter((i) => i.why !== 'overdue');
  const doneToday = live(T).filter((t) => t.done && (asLocal(t.doneAt, tz) || '').slice(0, 10) === today);
  const events = live(T).filter((t) => t.due && dayOf(t.due) === today && (t.kind === 'event' || t.kind === 'exam'));
  const planned = rest.reduce((a, i) => a + i.min, 0);
  const loggedToday = live(log.value?.sessions).filter((s) => s.e && toLocal(s.s, tz).slice(0, 10) === today).reduce((a, s) => a + (Date.parse(s.e) - Date.parse(s.s)) / 6e4, 0);
  const progress = planned + loggedToday ? loggedToday / (planned + loggedToday) : doneToday.length ? 1 : 0;
  const [showDone, setShowDone] = useState(false);
  const tomorrow = p.days[1]?.items.filter((i) => T[i.id] && !T[i.id].done).slice(0, 3) || [];

  return (
    <div {...drop} style={over ? { outline: '2px dashed var(--accent)', borderRadius: 10 } : null}>
      <div class="todayHead">
        <Ring value={progress} />
        <div class="todayStat">
          <b>{fmtMin(planned) || '0m'}</b>
          <span>{rest.length ? `${rest.length} thing${rest.length > 1 ? 's' : ''} left · ${fmtMin(loggedToday) || '0m'} done` : 'Nothing left today'}</span>
        </div>
      </div>
      {events.map((t) => <TaskRow key={t.id} t={t} why="event" />)}
      {overdue.length > 0 && <div class="groupHead" style={{ color: 'var(--red)' }}>Overdue</div>}
      <div class="rows">{overdue.map((i) => <TaskRow key={i.id} t={T[i.id]} why="overdue" />)}</div>
      {overdue.length > 0 && rest.length > 0 && <div class="groupHead">Today</div>}
      <div class="rows">{rest.map((i) => <TaskRow key={i.id} t={T[i.id]} min={i.min} why={i.why} />)}</div>
      {!items.length && <Empty>{doneToday.length ? 'All done for today.' : 'Clear day. Drag something here to plan it.'}</Empty>}
      {tomorrow.length > 0 && items.length < 3 && (
        <>
          <div class="groupHead">Get ahead <span class="sub">tomorrow's plan</span></div>
          <div class="rows">{tomorrow.map((i) => <TaskRow key={i.id} t={T[i.id]} min={i.min} why="ahead" />)}</div>
        </>
      )}
      {doneToday.length > 0 && (
        <button class="more" onClick={() => setShowDone(!showDone)}>{showDone ? 'Hide' : `${doneToday.length} done today`}</button>
      )}
      {showDone && <div class="rows">{doneToday.map((t) => <TaskRow key={t.id} t={t} compact />)}</div>}
    </div>
  );
}

// ---------------------------------------------------------------- Upcoming

export function UpcomingBlock({ cfg }) {
  const tz = settings.value.tz;
  const today = todayFn(tz);
  const T = tasks.value;
  const p = plan.value;
  const filter = cfg?.filter || [];
  const showDone = !!cfg?.showDone;
  const setCfg = (patch) => setLayout('upcoming', { ...(cfg || {}), ...patch });
  const [limit, setLimit] = useState(21);
  const [jump, setJump] = useState(null);

  const list = live(T).filter((t) => (showDone || !t.done) && (!filter.length || filter.includes(t.course)));
  const groups = new Map();
  const later = [], undated = [];
  for (const t of list.sort(byDue)) {
    if (!t.due) { undated.push(t); continue; }
    const d = dayOf(t.due);
    if (d < today) { if (!t.done) (groups.get('past') || groups.set('past', []).get('past')).push(t); continue; }
    if (daysBetween(today, d) >= limit) { later.push(t); continue; }
    if (!groups.has(d)) groups.set(d, []);
    groups.get(d).push(t);
  }
  const loadOf = (items) => items.filter((t) => !t.done).reduce((a, t) => a + (p?.info.get(t.id)?.est.min || 0), 0);
  const capOf = (d) => { const c = settings.value.capacity; const w = weekday(d); return (w === 0 || w === 6 ? c.weekend : c.weekday) || 240; };
  const color = (r) => (r > 1 ? 'var(--red)' : r > 0.7 ? 'var(--orange)' : 'var(--green)');

  return (
    <div>
      <Strip today={today} onPick={(d) => { setJump(d); document.getElementById(`day-${d}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }} />
      <div class="filters">
        {live(db.value?.courses).filter((c) => c.include !== false).map((c) => (
          <button key={c.id} class={`fchip${filter.includes(c.id) ? ' on' : ''}`} style={{ '--c': c.color }} onClick={() => setCfg({ filter: filter.includes(c.id) ? filter.filter((x) => x !== c.id) : [...filter, c.id] })}>
            <span class="swatch" style={{ background: c.color, width: 7, height: 7 }} />{courseShort(c.id)}
          </button>
        ))}
        <button class={`fchip${showDone ? ' on' : ''}`} onClick={() => setCfg({ showDone: !showDone })}>Done</button>
      </div>
      {groups.has('past') && (
        <div class="group">
          <div class="groupHead" style={{ color: 'var(--red)' }}>Past due</div>
          <div class="rows">{groups.get('past').map((t) => <TaskRow key={t.id} t={t} />)}</div>
        </div>
      )}
      {[...groups.entries()].filter(([d]) => d !== 'past').map(([d, items]) => {
        const load = loadOf(items), cap = capOf(d);
        return (
          <div key={d} class="group" id={`day-${d}`} style={jump === d ? { background: 'var(--bg-soft)', borderRadius: 8 } : null}>
            <div class="groupHead">
              <span>{fmtDay(d, today)}</span>
              {daysBetween(today, d) >= 2 && daysBetween(today, d) < 7 && <span class="sub">{fmtDay(d)}</span>}
              {load > 0 && <span class="load" title={`${fmtMin(load)} due`}><i style={{ width: `${Math.min(100, (100 * load) / cap)}%`, background: color(load / cap) }} /></span>}
            </div>
            <div class="rows">{items.map((t) => <TaskRow key={t.id} t={t} />)}</div>
          </div>
        );
      })}
      {!groups.size && <Empty>Nothing due in the next {limit} days.</Empty>}
      {later.length > 0 && <button class="more" onClick={() => setLimit(limit + 28)}>{later.length} more later · show 4 more weeks</button>}
      {undated.length > 0 && (
        <div class="group">
          <div class="groupHead">No date</div>
          <div class="rows">{undated.map((t) => <TaskRow key={t.id} t={t} />)}</div>
        </div>
      )}
    </div>
  );
}

function Strip({ today, onPick }) {
  const p = plan.value;
  const T = tasks.value;
  const cells = [];
  for (let i = 0; i < 14; i++) {
    const d = addDays(today, i);
    const planned = p?.days[i]?.items.reduce((a, x) => a + x.min, 0) || 0;
    const cap = p?.days[i]?.cap || 240;
    const due = live(T).filter((t) => !t.done && t.due && dayOf(t.due) === d).length;
    cells.push({ d, planned, cap, due });
  }
  return <div class="strip">{cells.map((c) => <StripCell key={c.d} c={c} today={today} onPick={onPick} />)}</div>;
}

function StripCell({ c, today, onPick }) {
  const [over, drop] = useDrop((id) => { updateTask(id, { doDate: c.d }, { quiet: true }); toast(`Planned for ${fmtDay(c.d, today)}`); });
  const r = c.planned / c.cap;
  return (
    <div class={`cell${c.d === today ? ' today' : ''}${over ? ' drop' : ''}`} onClick={() => onPick(c.d)} {...drop} title={`${fmtMin(c.planned)} planned · ${c.due} due`}>
      <span class="d">{DOW[weekday(c.d)].slice(0, 2)}</span>
      <span class="n">{+c.d.slice(8)}</span>
      <span class="bar"><i style={{ width: `${Math.min(100, r * 100)}%`, background: r > 1 ? 'var(--red)' : r > 0.7 ? 'var(--orange)' : 'var(--green)' }} /></span>
    </div>
  );
}

// ---------------------------------------------------------------- Classes

const KIND_ICON = { module: 'folder', file: 'file', link: 'link', lti: 'out', dropbox: 'upload', quiz: 'quiz', survey: 'quiz' };

export function ClassesBlock({ cfg }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState({});
  const lib = library.value;
  const tz = settings.value.tz;
  const today = todayFn(tz);
  const pins = cfg?.pins || [];
  const setCfg = (patch) => setLayout('classes', { ...(cfg || {}), ...patch });
  const byCourse = new Map();
  for (const c of live(lib?.courses)) {
    if (!c.course || courses.value[c.course]?.include === false) continue;
    if (!byCourse.has(c.course)) byCourse.set(c.course, []);
    byCourse.get(c.course).push(c);
  }
  const fresh = (n) => n && n !== '2000-01-01T00:00' && daysBetween(n.slice(0, 10), today) <= 7;

  // Flatten for search, newest first, pinned.
  const flat = useMemo(() => {
    const out = [];
    const walk = (nodes, course, path) => nodes.forEach((n) => {
      out.push({ ...n, course, path });
      if (n.c) walk(n.c, course, [...path, n.t]);
    });
    for (const c of live(lib?.courses)) walk(c.tree || [], c.course, []);
    return out;
  }, [lib]);

  const ql = q.trim().toLowerCase();
  const hits = ql ? searchTree(flat, ql, (c) => courseShort(c) + ' ' + (courses.value[c]?.name || '') + ' ' + (courses.value[c]?.aliases || []).join(' ')) : [];
  const newest = flat.filter((n) => n.k !== 'module' && fresh(n.n)).slice(0, 8);
  const pinned = flat.filter((n) => pins.includes(`${n.course}:${n.id}`));
  const togglePin = (n) => { const k = `${n.course}:${n.id}`; setCfg({ pins: pins.includes(k) ? pins.filter((x) => x !== k) : [...pins, k] }); };

  return (
    <div>
      <div class="search">
        <Icon n="search" size={14} style={{ color: 'var(--text-3)' }} />
        <input value={q} placeholder="Find anything in your courses" onInput={(e) => setQ(e.target.value)} />
        {q && <button class="iconBtn" onClick={() => setQ('')}><Icon n="x" size={12} /></button>}
      </div>
      {ql ? (
        hits.length ? hits.map((n) => <Leaf key={n.course + n.id} n={n} hl={ql} showPath pinned={pins.includes(`${n.course}:${n.id}`)} onPin={togglePin} />) : <Empty>No matches.</Empty>
      ) : (
        <>
          {pinned.length > 0 && <><div class="groupHead">Pinned</div>{pinned.map((n) => <Leaf key={n.course + n.id} n={n} showPath pinned onPin={togglePin} />)}</>}
          {newest.length > 0 && <><div class="groupHead">New this week</div>{newest.map((n) => <Leaf key={n.course + n.id} n={n} showPath fresh onPin={togglePin} />)}</>}
          {(pinned.length > 0 || newest.length > 0) && <div class="groupHead">Courses</div>}
          {[...byCourse.entries()].map(([cid, parts]) => {
            const grades = parts.flatMap((p) => p.grades || []);
            const overall = grades.find((g) => /final calculated|final adjusted/i.test(g.name)) || null;
            const nextDue = live(tasks.value).filter((t) => t.course === cid && !t.done && t.due && t.due >= today).sort(byDue)[0];
            const isOpen = open[cid];
            return (
              <div key={cid} class="courseCard">
                <div class="courseHead" onClick={() => setOpen({ ...open, [cid]: !isOpen })}>
                  <Icon n="right" size={12} style={{ color: 'var(--text-3)', transform: isOpen ? 'rotate(90deg)' : '', transition: 'transform .15s' }} />
                  <span class="swatch" style={{ background: courseColor(cid) }} />
                  <span class="courseName">{courses.value[cid]?.name || cid}</span>
                  {overall?.shown && <span class="grade">{overall.shown}</span>}
                </div>
                {isOpen && (
                  <div class="tree">
                    {nextDue && <div class="path" style={{ padding: '0 6px 6px' }}>Next: {nextDue.title} · {fmtDay(dayOf(nextDue.due), today)}</div>}
                    {grades.length > 0 && <Grades grades={grades} />}
                    {parts.map((p) => (p.tree || []).map((n) => <Branch key={p.ou + n.id} n={n} course={cid} fresh={fresh} pins={pins} onPin={togglePin} />))}
                  </div>
                )}
              </div>
            );
          })}
          {!byCourse.size && <Empty>Course material appears after the first sync.</Empty>}
        </>
      )}
    </div>
  );
}

function Grades({ grades }) {
  const [open, setOpen] = useState(false);
  const cats = grades.filter((g) => g.type === 'Category' && g.shown);
  const list = cats.length ? cats : grades.filter((g) => g.shown).slice(0, 12);
  return (
    <div class="node" style={{ display: 'block', cursor: 'default' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }} onClick={() => setOpen(!open)}>
        <span class="ic"><Icon n="pulse" size={14} /></span><span class="nm">Grades</span>
        <span class="grade">{list.length} item{list.length === 1 ? '' : 's'}</span>
      </div>
      {open && list.map((g) => (
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, color: 'var(--text-2)', padding: '3px 0 3px 22px' }}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{g.name}</span>
          <span style={{ fontVariantNumeric: 'tabular-nums', flex: 'none', marginLeft: 8 }}>{g.shown || (g.den ? `${g.num ?? '–'}/${g.den}` : '')}</span>
        </div>
      ))}
    </div>
  );
}

function Branch({ n, course, fresh, pins, onPin, depth = 0 }) {
  const [open, setOpen] = useState(false);
  if (n.k !== 'module') return <Leaf n={{ ...n, course }} fresh={fresh(n.n)} pinned={pins.includes(`${course}:${n.id}`)} onPin={onPin} />;
  const hasNew = (x) => fresh(x.n) || (x.c || []).some(hasNew);
  return (
    <div>
      <div class="node" onClick={() => setOpen(!open)}>
        <span class="ic"><Icon n="right" size={11} style={{ transform: open ? 'rotate(90deg)' : '', transition: 'transform .15s' }} /></span>
        <span class="nm">{n.t}</span>
        {hasNew(n) && <span class="new" />}
      </div>
      {open && <div class="kids">{(n.c || []).map((x) => <Branch key={x.id} n={x} course={course} fresh={fresh} pins={pins} onPin={onPin} depth={depth + 1} />)}{!(n.c || []).length && <div class="path" style={{ padding: '4px 6px' }}>Empty</div>}</div>}
    </div>
  );
}

function Leaf({ n, hl, showPath, fresh, pinned, onPin }) {
  const name = hl ? highlight(n.t, hl.split(/\s+/).sort((a, b) => b.length - a.length)[0]) : n.t;
  return (
    <div class="node" role="link" tabIndex={0} onClick={() => window.open(n.u, '_blank', 'noopener')} onKeyDown={(e) => e.key === 'Enter' && window.open(n.u, '_blank', 'noopener')}>
      <span class="ic"><Icon n={KIND_ICON[n.k] || 'file'} size={14} /></span>
      <span class="nm">
        {name}
        {showPath && <div class="path">{courseShort(n.course)} · {(n.path || []).slice(-2).join(' › ')}</div>}
      </span>
      {fresh && <span class="new" />}
      {n.f && <a class="act iconBtn" href={n.f} target="_blank" rel="noopener" title="Open file" onClick={(e) => e.stopPropagation()}><Icon n="down" size={13} /></a>}
      <button class="act iconBtn" style={pinned ? { opacity: 1, color: 'var(--yellow)' } : null} title={pinned ? 'Unpin' : 'Pin'} onClick={(e) => { e.preventDefault(); e.stopPropagation(); onPin(n); }}><Icon n="star" size={13} /></button>
    </div>
  );
}

// "physics recitation 4" finds "PHYS 172 › RECITATION 04 › …". Text is split into words and
// numbers ("MA261_Lesson26" → ma 261 lesson 26); numbers must match exactly (4 = 04, not
// 04:35 or 261); words may be abbreviations either way (rec ↔ recitation, phys ↔ physics).
// Every query word must match the item, its folders or its course; title matches rank first.
// Durations like (04:35) are not numbers to match.
const toks = (x) => (x.toLowerCase().replace(/\d{1,2}:\d{2}(:\d{2})?/g, ' ').match(/[a-z]+|\d+/g) || []).map((t) => (/^\d+$/.test(t) ? String(+t) : t));
const hit = (w, ts) => ts.some((t) => (/^\d/.test(w) ? t === w : t === w || (w.length >= 3 && t.startsWith(w)) || (t.length >= 3 && w.startsWith(t))));
function searchTree(flat, q, courseWords) {
  const words = toks(q);
  const out = [];
  for (const n of flat) {
    if (n.k === 'module') continue;
    const tt = toks(n.t), pt = toks(n.path.join(' ')), ct = toks(courseWords(n.course));
    let score = 0;
    for (const w of words) {
      if (hit(w, tt)) score += 10;
      else if (hit(w, pt)) score += 4;
      else if (hit(w, ct)) score += 2;
      else { score = -1; break; }
    }
    if (score > 0) out.push({ n, score: score - n.path.length * 0.1 + (n.k === 'file' ? 0.5 : 0) });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 40).map((x) => x.n);
}

function highlight(text, q) {
  const i = text.toLowerCase().indexOf(q);
  if (i < 0) return text;
  return <>{text.slice(0, i)}<span class="hl">{text.slice(i, i + q.length)}</span>{text.slice(i + q.length)}</>;
}

// ---------------------------------------------------------------- Insights

export function InsightsBlock() {
  nowTick.value;
  const s = settings.value;
  const ins = useMemo(() => insights({ tasks: tasks.value, sessions: log.value?.sessions, settings: s }), [db.value, log.value]);
  const days = Object.entries(ins.byDay);
  const max = Math.max(60, ...days.map(([, v]) => Object.values(v).reduce((a, b) => a + b, 0)));
  const heatMax = Math.max(1, ...ins.heat.flat());
  const delta = ins.lastWeekMin ? Math.round((100 * (ins.weekMin - ins.lastWeekMin)) / ins.lastWeekMin) : null;
  const usedCourses = [...new Set(days.flatMap(([, v]) => Object.keys(v)))];
  return (
    <div>
      <div class="kpis">
        <div class="kpi"><b>{fmtMin(ins.weekMin) || '0m'}</b><span>this week{delta != null ? ` · ${delta >= 0 ? '+' : ''}${delta}%` : ''}</span></div>
        <div class="kpi"><b>{ins.onTime != null ? `${ins.onTime}%` : '–'}</b><span>on time (4 wk)</span></div>
        <div class="kpi"><b>{ins.accuracy != null ? `${ins.accuracy}%` : '–'}</b><span>of estimate</span></div>
      </div>
      <div class="bars">
        {days.map(([d, v]) => (
          <div class="col" title={`${fmtDay(d)} · ${fmtMin(Object.values(v).reduce((a, b) => a + b, 0))}`} style={{ height: `${(100 * Object.values(v).reduce((a, b) => a + b, 0)) / max}%`, background: 'transparent' }}>
            {Object.entries(v).map(([c, m]) => <i style={{ display: 'block', height: `${(100 * m) / Object.values(v).reduce((a, b) => a + b, 0)}%`, background: courseColor(c) }} />)}
          </div>
        ))}
      </div>
      <div class="barsX">{days.map(([d]) => <span>{DOW[weekday(d)][0]}</span>)}</div>
      {usedCourses.length > 0 && <div class="legend">{usedCourses.map((c) => <span><i class="swatch" style={{ background: courseColor(c), width: 7, height: 7 }} />{courseShort(c)}</span>)}</div>}
      <div class="heat">
        {ins.heat.map((row, wd) => [<em>{DOW[wd].slice(0, 2)}</em>, ...row.map((v) => <i style={v ? { background: `color-mix(in srgb, var(--accent) ${Math.round(15 + (85 * v) / heatMax)}%, transparent)` } : null} />)])}
      </div>
      {ins.tips.length > 0 ? <ul class="tips">{ins.tips.map((t) => <li>{t}</li>)}</ul> : <Empty>Start a timer on a task, or let the extension track it, and patterns show up here.</Empty>}
    </div>
  );
}

// ---------------------------------------------------------------- Health

export function HealthBlock() {
  const [focus, setFocus] = useState('');
  const s = settings.value;
  const syncs = live(log.value?.syncs).filter((x) => x.kind !== 'migration').sort((a, b) => (a.at < b.at ? 1 : -1));
  const last = syncs.find((x) => x.kind !== 'mylab');
  const lastMyLab = syncs.find((x) => x.mylab);
  const report = db.value?.reports?.latest;
  const F = findings.value;
  const claude = conn.value.claude?.state || s.claude;
  const fixFor = (f) => {
    if (f.fix?.op === 'merge') return [{ label: 'Merge', run: () => runOps([f.fix]) }];
    if (f.fix?.op === 'update') return [{ label: 'Use theirs', run: () => runOps([f.fix]) }];
    if (f.taskIds?.length === 1) return [{ label: 'Open', run: () => openPeek(f.taskIds[0]) }];
    return [];
  };
  const pendingCheck = live(db.value?.inbox).find((r) => r.type === 'check' && (r.status === 'new' || r.status === 'working'));
  const syncDot = !last ? 'idle' : last.ok && !last.errors?.length ? 'ok' : last.errors?.some((e) => /signed-out/.test(e)) ? 'err' : 'warn';
  const requested = s.syncRequest && (!s.lastSync || s.syncRequest > s.lastSync) && Date.now() - Date.parse(s.syncRequest) < 6 * 36e5 ? s.syncRequest : null;
  const extSeen = [conn.value.ext, s.extSeen].filter(Boolean).sort().pop();
  const extAlive = extSeen && Date.now() - Date.parse(extSeen) < 45 * 60e3;
  // Items already acted on, or about tasks that are now done or gone, drop off the report.
  const items = (report?.items || []).filter((it, i) => it.level !== 'ok' && !(report.applied || []).includes(i)
    && !(it.taskIds?.length && it.taskIds.every((id) => !tasks.value[id] || tasks.value[id].deleted || tasks.value[id].done)));

  return (
    <div>
      <div class="status">
        <div class="statusRow">
          <span class={`dot ${requested ? 'idle' : syncDot}`} />
          <span class="lbl">{requested ? 'Sync requested' : `Brightspace ${last ? `synced ${relTime(last.at)}` : 'not synced yet'}`}
            <small>{requested ? (extAlive ? 'Starting within a minute…' : 'Waiting for the Safari extension on the Mac.') : last ? summarize(last) : `Runs at ${s.syncTimes.join(' and ')} while the Mac is in use.`}</small>
          </span>
          <button class="iconBtn" title="Sync now" onClick={requestSync}><Icon n="sync" size={15} /></button>
        </div>
        {lastMyLab && (
          <div class="statusRow">
            <span class={`dot ${lastMyLab.mylab.ok ? 'ok' : 'warn'}`} />
            <span class="lbl">MyLab {lastMyLab.mylab.ok ? `read ${relTime(lastMyLab.at)}` : 'skipped last time'}
              <small>{lastMyLab.mylab.ok ? `${lastMyLab.mylab.n} assignments` : lastMyLab.mylab.error || 'Could not open MyLab'}</small>
            </span>
          </div>
        )}
        <div class="statusRow">
          <span class={`dot ${extAlive ? 'ok' : 'warn'}`} />
          <span class="lbl">Safari extension {extAlive ? 'connected' : extSeen ? `last seen ${relTime(extSeen)}` : 'not connected'}
            {!extAlive && <small>Safari › Settings › Extensions › tick Load, then allow it on all websites.</small>}
          </span>
        </div>
        <div class="statusRow">
          <span class={`dot ${claude === 'ok' ? 'ok' : claude === 'needs-login' ? 'warn' : 'idle'}`} />
          <span class="lbl">Assistant {claude === 'ok' ? 'ready' : claude === 'needs-login' ? 'needs sign-in on the Mac' : 'answers when the Mac is awake'}
            {claude === 'needs-login' && <small>Open Terminal, run <code>claude</code>, sign in once.</small>}
          </span>
        </div>
      </div>

      {report?.summary && <div class="summary">{report.summary}<div class="path" style={{ marginTop: 4 }}>Checked {relTime(report.at)}{report.focus ? ` · ${report.focus}` : ''}</div></div>}
      {items.map((it) => (
        <div key={it.text} class="finding">
          <span class={`dot ${it.level === 'warn' || it.level === 'action' ? 'warn' : 'idle'}`} style={{ marginTop: 6 }} />
          <div class="ft">{it.text}{it.taskIds?.length ? <small>{names(it.taskIds)}</small> : null}</div>
          <div class="fx">
            {it.ops?.length > 0 && <button class="mini" title={it.ops.map((o) => describeOp(o, tasks.value)).join('\n')} onClick={() => { runOps(it.ops); markReportItem(report.items.indexOf(it)); }}>Apply</button>}
            <button class="mini" title="Dismiss" onClick={() => markReportItem(report.items.indexOf(it))}><Icon n="x" size={10} /></button>
            {it.taskIds?.length === 1 && <button class="mini" onClick={() => openPeek(it.taskIds[0])}>Open</button>}
          </div>
        </div>
      ))}

      {F.filter((f) => f.level !== 'review').map((f) => (
        <div key={f.id} class="finding">
          <span class={`dot ${f.level === 'error' ? 'err' : f.level === 'warn' ? 'warn' : 'idle'}`} style={{ marginTop: 6 }} />
          <div class="ft">{f.text}{f.taskIds?.length && !f.id.startsWith('dup-') && !f.id.startsWith('conflict-') ? <small>{names(f.taskIds)}</small> : null}</div>
          <div class="fx">{fixFor(f).map((b) => <button class="mini" onClick={b.run}>{b.label}</button>)}</div>
        </div>
      ))}
      {!F.length && !items.length && <div class="finding"><span class="dot ok" style={{ marginTop: 6 }} /><div class="ft">Everything looks right.</div></div>}

      <div class="checkRow">
        <input value={focus} placeholder="Look into something specific…" onInput={(e) => setFocus(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { ask(focus.trim() || 'Routine check', 'check'); setFocus(''); } }} />
        <button class="btn" disabled={!!pendingCheck} onClick={() => { ask(focus.trim() || 'Routine check', 'check'); setFocus(''); }}>{pendingCheck ? <span class="spinner" /> : 'Check'}</button>
      </div>
    </div>
  );
}

function names(ids, n = 3) {
  const t = ids.map((id) => tasks.value[id]).filter((x) => x && !x.deleted).map((x) => x.title);
  return t.slice(0, n).join(' · ') + (t.length > n ? ` +${t.length - n} more` : '');
}

function summarize(s) {
  const bits = [];
  if (s.added?.length) bits.push(`${s.added.length} new`);
  if (s.changed?.length) bits.push(`${s.changed.length} moved`);
  if (s.completed?.length) bits.push(`${s.completed.length} submitted`);
  if (s.merged?.length) bits.push(`${s.merged.length} merged`);
  if (s.missing?.length) bits.push(`${s.missing.length} gone`);
  if (s.errors?.length) bits.push(`${s.errors.length} error${s.errors.length > 1 ? 's' : ''}`);
  if (s.mylab && !s.mylab.ok) bits.push('MyLab skipped');
  return bits.length ? bits.join(' · ') : 'No changes';
}

// ---------------------------------------------------------------- Announcements

export function NewsBlock({ cfg }) {
  const [open, setOpen] = useState(null);
  const tz = settings.value.tz;
  const today = todayFn(tz);
  const seen = cfg?.seen || '2000-01-01';
  const items = live(library.value?.courses).flatMap((c) => (c.news || []).map((n) => ({ ...n, course: c.course }))).filter((n) => courses.value[n.course]?.include !== false)
    .sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 12);
  if (!items.length) return <Empty>No announcements yet.</Empty>;
  const unread = items.filter((n) => (n.at || '') > seen).length;
  return (
    <div>
      {unread > 0 && <button class="more" onClick={() => setLayout('news', { ...(cfg || {}), seen: toLocal(new Date(), tz) })}>Mark {unread} as read</button>}
      {items.map((n) => (
        <div key={n.id} class={`news${open === n.id ? ' open' : ''}`} onClick={() => setOpen(open === n.id ? null : n.id)}>
          <h4>{(n.at || '') > seen && <span class="new dot" style={{ background: 'var(--accent)', width: 6, height: 6 }} />}<CoursePill id={n.course} /><span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{n.title}</span><span class="when">{n.at ? fmtDay(n.at.slice(0, 10), today) : ''}</span></h4>
          <p>{n.body.replace(/&#(\d+);/g, (m, c) => String.fromCharCode(+c)).replace(/&gt;/g, '>').replace(/&lt;/g, '<')}</p>
        </div>
      ))}
    </div>
  );
}
