// Health checks done in plain code. The reviewer (hub/manager.js) reads these first and
// only spends a model call when something here needs judgement.

import { live } from './doc.js';
import { family, isPlaceholderFor } from './model.js';
import { today as todayFn, addDays, dayOf, daysBetween } from './time.js';

const DATE_WORDS = /\b(postpone|postponed|extend|extended|moved|pushed|rescheduled|delayed|new due|now due|deadline)\b/i;

export function runChecks({ db, log, library, settings = {}, now = new Date() }) {
  const tz = settings.tz;
  const today = todayFn(tz, now);
  const out = [];
  const add = (id, level, text, extra = {}) => out.push({ id, level, text, ...extra });
  const tasks = live(db.tasks);
  const open = tasks.filter((t) => !t.done);

  // Sync freshness and errors.
  const syncs = live(log?.syncs).filter((s) => s.kind !== 'migration').sort((a, b) => (a.at < b.at ? 1 : -1));
  const full = syncs.filter((s) => s.kind === 'full');
  const lastOk = syncs.find((s) => s.ok);
  if (!syncs.length) add('sync-never', 'warn', 'Brightspace has not synced yet.');
  else {
    const hrs = lastOk ? (now - Date.parse(lastOk.at)) / 36e5 : Infinity;
    if (hrs > 30) add('sync-stale', 'warn', lastOk ? `Last full sync was ${Math.round(hrs)}h ago.` : 'No sync has fully succeeded yet.');
    const last = syncs[0];
    if (last.errors?.some((e) => /signed-out/.test(e))) add('sync-signed-out', 'error', 'Brightspace was signed out during the last sync.');
    else if (last.errors?.length) add('sync-errors', 'info', `Last sync had ${last.errors.length} read error${last.errors.length > 1 ? 's' : ''}.`, { detail: last.errors.slice(0, 6) });
    // A course that suddenly reports far fewer items usually means a failed read, not a lighter week.
    if (full.length > 1 && full[0].counts && full[1].counts) {
      for (const [c, n] of Object.entries(full[1].counts)) {
        const m = full[0].counts[c] ?? 0;
        if (n >= 5 && m < n * 0.5) add(`sync-drop-${c}`, 'warn', `${c} went from ${n} items to ${m} in the last sync.`);
      }
    }
  }

  // Overdue and unticked.
  const overdue = open.filter((t) => t.due && t.due < `${today}T00:00` && t.kind !== 'event' && !t.missing);
  if (overdue.length) add('overdue', overdue.length > 3 ? 'warn' : 'info', `${overdue.length} past due and not ticked.`, { taskIds: overdue.map((t) => t.id) });

  // Probable duplicates: same course, same numbered thing or same family, due close together.
  const seenPair = new Set();
  for (let i = 0; i < open.length; i++) {
    for (let j = i + 1; j < open.length; j++) {
      const a = open[i], b = open[j];
      if (a.course !== b.course) continue;
      if ((a.refs || []).some((r) => (b.refs || []).includes(r))) continue;
      const codes = (x) => (x.title.match(/\b[A-Z]{2,5}\s?\d{3}\b/g) || []).join();
      if (codes(a) !== codes(b)) continue; // "ENGT 182 Exam 2" vs "MA 261 Midterm 2"
      // Two synced items are duplicates only when their titles match: "LAB 09 : IPYNB" and
      // "LAB 09 : PDF" are separate uploads. A hand-made one is judged as a placeholder.
      const sameFam = family(a.title) === family(b.title) && a.title.replace(/\D/g, '') === b.title.replace(/\D/g, '');
      const bothSynced = a.src !== 'manual' && b.src !== 'manual';
      if (!sameFam && (bothSynced || !(isPlaceholderFor(a, b) || isPlaceholderFor(b, a)))) continue;
      if (a.due && b.due && Math.abs(daysBetween(dayOf(a.due), dayOf(b.due))) > 3) continue;
      const key = [a.id, b.id].sort().join('|');
      if (seenPair.has(key)) continue;
      seenPair.add(key);
      add(`dup-${key}`, 'warn', `Possible duplicate: “${a.title}” and “${b.title}”.`, { taskIds: [a.id, b.id], fix: { op: 'merge', ids: [a.id, b.id] } });
    }
  }

  // Source stopped listing an open task.
  const gone = open.filter((t) => t.missing);
  if (gone.length) add('missing', 'info', `${gone.length} open item${gone.length > 1 ? 's' : ''} no longer listed in Brightspace.`, { taskIds: gone.map((t) => t.id) });

  // Your date vs. the source's.
  const conflicts = open.filter((t) => t.srcDue && t.srcDue !== t.due);
  for (const t of conflicts) add(`conflict-${t.id}`, 'warn', `“${t.title}”: you set ${t.due}, Brightspace says ${t.srcDue}.`, { taskIds: [t.id], fix: { op: 'update', id: t.id, set: { due: t.srcDue, lock: { ...(t.lock || {}), due: false } } } });

  // Undated open work.
  const undated = open.filter((t) => !t.due && t.src !== 'manual');
  if (undated.length) add('undated', 'info', `${undated.length} synced item${undated.length > 1 ? 's have' : ' has'} no due date.`, { taskIds: undated.map((t) => t.id) });

  // Announcements that mention date changes in the last week.
  const recent = [];
  for (const c of live(library?.courses)) {
    for (const n of c.news || []) {
      if (!n.at || n.at < `${addDays(today, -7)}T00:00`) continue;
      if (DATE_WORDS.test(n.title + ' ' + n.body)) recent.push({ course: c.course, id: n.id, title: n.title, body: n.body.slice(0, 600) });
    }
  }
  if (recent.length) add('news-dates', 'review', `${recent.length} recent announcement${recent.length > 1 ? 's mention' : ' mentions'} a date change.`, { news: recent });

  // Heavy days ahead.
  return out;
}
