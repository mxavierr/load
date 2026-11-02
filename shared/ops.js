// The small set of changes the assistant and the reviewer may propose. The app shows
// them, you tap Apply, and they run through here, the same code the UI uses.

import { stamp, uid, live } from './doc.js';
import { classify } from './model.js';
import { mergeTasks } from './reconcile.js';

const EDITABLE = ['title', 'course', 'due', 'est', 'kind', 'notes', 'doDate', 'pri', 'done', 'snooze', 'url', 'checklist'];
const LOCKABLE = ['title', 'due', 'url', 'kind', 'done'];

/** Patch a task the way a hand edit does: lockable fields are locked so sync respects them. */
export function editTask(task, set, t = Date.now()) {
  const patch = {};
  const lock = { ...(task.lock || {}) };
  for (const [k, v] of Object.entries(set)) {
    if (k === 'lock') { Object.assign(lock, v); continue; }
    if (!EDITABLE.includes(k)) continue;
    patch[k] = v;
    if (LOCKABLE.includes(k) && task.src && task.src !== 'manual') lock[k] = true;
  }
  if ('done' in set) {
    patch.doneAt = set.done ? set.doneAt || new Date(t).toISOString() : undefined;
    patch.doneBy = set.done ? 'you' : undefined;
  }
  if ('due' in set && lock.due && task.srcDue === set.due) { lock.due = false; patch.srcDue = undefined; }
  if (JSON.stringify(lock) !== JSON.stringify(task.lock || {})) patch.lock = lock;
  return stamp(task, patch, t);
}

export function newTask(fields, t = Date.now()) {
  const id = fields.id || uid('t');
  return stamp(null, {
    id, title: fields.title || 'Untitled', course: fields.course || null, due: fields.due || null,
    est: fields.est ?? undefined, kind: fields.kind || classify(fields.title || ''), notes: fields.notes || undefined,
    doDate: fields.doDate || undefined, pri: fields.pri || undefined, url: fields.url || undefined,
    src: 'manual', created: t,
  }, t);
}

/** Apply ops to db.tasks. Returns {db, applied:[text]} and ignores ops that point nowhere. */
export function applyOps(db, ops = [], t = Date.now()) {
  const tasks = { ...(db.tasks || {}) };
  const applied = [];
  for (const op of ops) {
    if (op.op === 'add' && op.task?.title) {
      const n = newTask(op.task, t);
      tasks[n.id] = n;
      applied.push(`Added “${n.title}”`);
    } else if (op.op === 'update' && tasks[op.id] && !tasks[op.id].deleted) {
      tasks[op.id] = editTask(tasks[op.id], op.set || {}, t);
      applied.push(`Updated “${tasks[op.id].title}”`);
    } else if (op.op === 'delete' && tasks[op.id]) {
      tasks[op.id] = stamp(tasks[op.id], { deleted: true }, t);
      applied.push(`Removed “${tasks[op.id].title}”`);
    } else if (op.op === 'merge' && Array.isArray(op.ids)) {
      const hits = op.ids.map((id) => tasks[id]).filter((x) => x && !x.deleted);
      if (hits.length > 1) {
        const keep = mergeTasks(tasks, hits, op.keep || hits.find((h) => h.src !== 'manual')?.id, t);
        applied.push(`Merged into “${keep.title}”`);
      }
    }
  }
  return { db: { ...db, tasks }, applied };
}

export function describeOp(op, tasks) {
  const name = (id) => `“${tasks?.[id]?.title || id}”`;
  if (op.op === 'add') return `Add ${op.task?.title ? `“${op.task.title}”` : 'a task'}${op.task?.due ? ` · ${op.task.due.replace('T', ' ')}` : ''}`;
  if (op.op === 'update') return `${name(op.id)}: ${Object.entries(op.set || {}).filter(([k]) => k !== 'lock').map(([k, v]) => `${k} → ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(', ')}`;
  if (op.op === 'delete') return `Remove ${name(op.id)}`;
  if (op.op === 'merge') return `Merge ${op.ids.map(name).join(' + ')}`;
  return JSON.stringify(op);
}

export function compactTasks(tasks, { from, to, limit = 160 } = {}) {
  return live(tasks)
    .filter((t) => (!from || !t.due || t.due >= from) && (!to || !t.due || t.due <= to))
    .sort((a, b) => (a.due || '9').localeCompare(b.due || '9'))
    .slice(0, limit)
    .map((t) => [t.id, t.course || '-', t.due || 'no date', t.kind, t.est ?? '', t.done ? 'done' : 'open', t.doDate || '', t.title].join(' | '));
}
