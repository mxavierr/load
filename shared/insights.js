// Productivity numbers from tracked sessions and finished tasks. Plain arithmetic.

import { live } from './doc.js';
import { toLocal, today as todayFn, addDays, startOfWeek, dayOf, fmtMin } from './time.js';
import { loggedByTask, makeEstimator } from './plan.js';
import { DEFAULT_EST } from './model.js';

export function insights({ tasks, sessions, settings = {}, now = new Date() }) {
  const tz = settings.tz;
  const today = todayFn(tz, now);
  const wk = startOfWeek(today);
  const taskMap = tasks || {};
  const S = live(sessions).filter((s) => s.s && s.e);

  // Minutes per day for the last 14 days, split by course.
  const byDay = {};
  for (let i = 13; i >= 0; i--) byDay[addDays(today, -i)] = {};
  const heat = Array.from({ length: 7 }, () => Array(24).fill(0)); // weekday x hour
  let weekMin = 0, lastWeekMin = 0;
  const weekByCourse = {};
  for (const s of S) {
    const start = new Date(s.s), end = new Date(s.e);
    const min = (end - start) / 6e4;
    if (min <= 0 || min > 16 * 60) continue;
    const d = dayOf(toLocal(start, tz));
    const course = taskMap[s.task]?.course || 'Other';
    if (d in byDay) byDay[d][course] = (byDay[d][course] || 0) + min;
    if (d >= wk) { weekMin += min; weekByCourse[course] = (weekByCourse[course] || 0) + min; }
    else if (d >= addDays(wk, -7)) lastWeekMin += min;
    // Spread over hours for the heatmap.
    for (let t = start.getTime(); t < end.getTime(); t += 15 * 6e4) {
      const l = toLocal(new Date(t), tz);
      const wd = new Date(Date.UTC(+l.slice(0, 4), +l.slice(5, 7) - 1, +l.slice(8, 10))).getUTCDay();
      heat[wd][+l.slice(11, 13)] += 15;
    }
  }

  // Estimates vs reality, on time vs late.
  const logged = loggedByTask(sessions, taskMap);
  const done = live(taskMap).filter((t) => t.done);
  const ratios = [];
  const byKind = {};
  for (const t of done) {
    const real = logged.get(t.id);
    if (!real || real < 5) continue;
    const guess = t.est ?? DEFAULT_EST[t.kind] ?? 30;
    ratios.push(real / guess);
    (byKind[t.kind] ||= []).push({ real, guess });
  }
  const recentDone = done.filter((t) => t.due && dayOf(t.due) >= addDays(today, -28) && dayOf(t.due) <= today);
  const late = recentDone.filter((t) => t.doneAt && t.doneAt > t.due && t.doneBy !== 'sync');
  const onTime = recentDone.length ? Math.round(100 * (1 - late.length / recentDone.length)) : null;

  // How long before the deadline you start, per kind.
  const firstStart = new Map();
  for (const s of S) if (!firstStart.has(s.task) || s.s < firstStart.get(s.task)) firstStart.set(s.task, s.s);
  const leadByKind = {};
  for (const t of done) {
    const st = firstStart.get(t.id);
    if (!st || !t.due) continue;
    const lead = (Date.parse(toUtcGuess(t.due)) - Date.parse(st)) / 36e5;
    (leadByKind[t.kind] ||= []).push(lead);
  }

  const tips = [];
  for (const [k, xs] of Object.entries(byKind)) {
    if (xs.length < 3) continue;
    const r = xs.reduce((a, x) => a + x.real, 0) / xs.reduce((a, x) => a + x.guess, 0);
    if (r > 1.3) tips.push(`${k} work runs ${Math.round((r - 1) * 100)}% over estimate; estimates now learn from it.`);
  }
  for (const [k, xs] of Object.entries(leadByKind)) {
    if (xs.length < 3) continue;
    const med = xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)];
    const work = (byKind[k] || []).map((x) => x.real);
    const avgWork = work.length ? work.reduce((a, b) => a + b, 0) / work.length : null;
    if (med < 12 && avgWork && avgWork > 90) tips.push(`You usually start ${k} work ${Math.round(med)}h before it is due, and it takes about ${fmtMin(avgWork)}.`);
  }
  const best = bestHours(heat);
  if (best) tips.push(`Most of your focused time lands ${best}.`);

  return {
    byDay, heat, weekMin, lastWeekMin, weekByCourse, onTime, lateCount: late.length,
    accuracy: ratios.length ? Math.round(100 * median(ratios)) : null, samples: ratios.length, tips,
  };
}

function median(xs) {
  const a = [...xs].sort((x, y) => x - y);
  return a[Math.floor(a.length / 2)];
}

function toUtcGuess(local) {
  // Close enough for a lead-time estimate (hours, not minutes).
  return `${local}:00-05:00`;
}

function bestHours(heat) {
  const hours = Array(24).fill(0);
  for (const row of heat) row.forEach((v, h) => (hours[h] += v));
  const total = hours.reduce((a, b) => a + b, 0);
  if (total < 300) return null;
  let bestH = 0, bestV = 0;
  for (let h = 0; h < 22; h++) {
    const v = hours[h] + hours[h + 1] + hours[h + 2];
    if (v > bestV) { bestV = v; bestH = h; }
  }
  const f = (h) => `${h % 12 || 12}${h < 12 ? 'am' : 'pm'}`;
  return `between ${f(bestH)} and ${f(bestH + 3)}`;
}
