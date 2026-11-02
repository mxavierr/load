// Estimates from your own history, and the "work on today" plan.

import { live } from './doc.js';
import { DEFAULT_EST, family } from './model.js';
import { today as todayFn, addDays, dayOf, timeOf, weekday, daysBetween, fromLocal } from './time.js';

/** Minutes logged per task id (aliases fold into their survivor). */
export function loggedByTask(sessions, tasks) {
  const aliasTo = new Map();
  for (const t of live(tasks)) for (const a of t.aliases || []) aliasTo.set(a, t.id);
  for (const t of Object.values(tasks || {})) if (t.mergedInto) aliasTo.set(t.id, t.mergedInto);
  const out = new Map();
  for (const s of live(sessions)) {
    if (!s.task || !s.s) continue;
    const id = aliasTo.get(s.task) || s.task;
    const end = s.e || null;
    if (!end) continue;
    const min = (Date.parse(end) - Date.parse(s.s)) / 6e4;
    if (min > 0 && min < 16 * 60) out.set(id, (out.get(id) || 0) + min);
  }
  return out;
}

function median(xs) {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/**
 * Build an estimator from finished tasks that have tracked time.
 * Similar = same course and same title family ("lab # ipynb file upload"), then same
 * course and kind, then kind alone.
 */
export function makeEstimator(tasks, logged) {
  const byFam = new Map(), byCK = new Map(), byK = new Map();
  for (const t of live(tasks)) {
    const min = logged.get(t.id);
    if (!t.done || !min || min < 3) continue;
    const push = (m, k) => { if (!m.has(k)) m.set(k, []); m.get(k).push(min); };
    push(byFam, `${t.course}|${family(t.title)}`);
    push(byCK, `${t.course}|${t.kind}`);
    push(byK, t.kind);
  }
  return function estimate(t) {
    if (t.est != null) return { min: t.est, basis: 'set', n: 0 };
    for (const [m, k, basis] of [[byFam, `${t.course}|${family(t.title)}`, 'similar'], [byCK, `${t.course}|${t.kind}`, 'kind'], [byK, t.kind, 'kind']]) {
      const xs = m.get(k);
      if (xs && xs.length >= (basis === 'similar' ? 1 : 3)) return { min: Math.round(median(xs) / 5) * 5 || 5, basis, n: xs.length };
    }
    return { min: DEFAULT_EST[t.kind] ?? 30, basis: 'default', n: 0 };
  };
}

/** The day a task should be finished by: due-at-or-before-noon counts as the day before. */
export function workDay(t, earlyDue = '12:00') {
  if (!t.due) return null;
  const d = dayOf(t.due), tm = timeOf(t.due) || '23:59';
  if (t.kind === 'exam' || t.kind === 'event') return d;
  return tm <= earlyDue ? addDays(d, -1) : d;
}

/**
 * Spread remaining work over the coming days, earliest deadline first, within a daily
 * capacity, so a 3-hour lab due Saturday shows up on Thursday and Friday rather than
 * only on Saturday. Things you pinned to a day stay there; snoozed things wait.
 */
export function makePlan({ tasks, sessions, settings = {}, now = new Date(), horizon = 10 }) {
  const tz = settings.tz;
  const today = todayFn(tz, now);
  const logged = loggedByTask(sessions, tasks);
  const estimate = makeEstimator(tasks, logged);
  const cap = (day) => {
    const c = settings.capacity || { weekday: 240, weekend: 300 };
    const wd = weekday(day);
    return (wd === 0 || wd === 6 ? c.weekend : c.weekday) || 240;
  };

  const open = live(tasks).filter((t) => !t.done && t.kind !== 'event');
  const days = [];
  for (let i = 0; i < horizon; i++) {
    const d = addDays(today, i);
    days.push({ day: d, cap: cap(d), used: 0, items: [] });
  }
  const dayIdx = (d) => daysBetween(today, d);

  const info = new Map();
  for (const t of open) {
    const est = estimate(t);
    const spent = logged.get(t.id) || 0;
    const left = Math.max(est.min - spent, est.min > 0 ? 10 : 0);
    info.set(t.id, { est, spent, left, by: workDay(t, settings.earlyDue) });
  }

  const overdue = open.filter((t) => t.due && t.due < `${today}T00:00` && !t.missing);
  const queue = open
    .filter((t) => !(t.due && t.due < `${today}T00:00`))
    .filter((t) => !t.snooze || t.snooze <= today)
    .sort((a, b) => (info.get(a.id).by || '9999') .localeCompare(info.get(b.id).by || '9999') || (b.pri || 0) - (a.pri || 0));

  const place = (d, t, min, why) => {
    const slot = days[d];
    slot.items.push({ id: t.id, min: Math.round(min), why });
    slot.used += min;
  };

  // Pinned first.
  for (const t of queue) {
    if (t.doDate && t.doDate >= today) {
      const i = dayIdx(t.doDate);
      if (i < horizon) { place(i, t, info.get(t.id).left, 'pinned'); info.get(t.id).left = 0; }
    }
  }
  // Then earliest deadline first, filling from today, chunks of at least 25 minutes.
  for (const t of queue) {
    const inf = info.get(t.id);
    if (inf.left <= 0) continue;
    const last = inf.by ? Math.min(dayIdx(inf.by), horizon - 1) : horizon - 1;
    if (last < 0) continue;
    for (let i = 0; i <= last && inf.left > 0; i++) {
      const free = days[i].cap - days[i].used;
      const mustFinish = i === last && inf.by && dayIdx(inf.by) <= horizon - 1;
      let chunk = mustFinish ? inf.left : Math.min(inf.left, free);
      if (!mustFinish && (chunk < 25 && chunk < inf.left)) continue;
      if (chunk <= 0) continue;
      place(i, t, chunk, i === last ? 'due' : 'ahead');
      inf.left -= chunk;
    }
  }
  for (const t of overdue) place(0, t, info.get(t.id).left, 'overdue');

  return { today, days, info, overdue: overdue.map((t) => t.id), estimate, logged };
}

/** Rough "how loaded is each day" from due work alone, for the calendar strip. */
export function dueLoad(tasks, info, from, n) {
  const out = {};
  for (let i = 0; i < n; i++) out[addDays(from, i)] = 0;
  for (const t of live(tasks)) {
    if (t.done || !t.due) continue;
    const d = dayOf(t.due);
    if (d in out) out[d] += info.get(t.id)?.est.min || 0;
  }
  return out;
}

export function minutesUntil(local, tz, now = new Date()) {
  return (fromLocal(local, tz) - now) / 6e4;
}
