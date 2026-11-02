// One-off: carry the old fall26-load-local tracker into the new data files.
//   node scripts/migrate.mjs <old state.json> <brightspace snapshot.json|--fixture> <out dir>
// Old rows are matched to the real Brightspace item by their link (dropbox / quiz /
// content topic id), then by exact title within the course. Ticks, estimate overrides,
// notes and pinned dates come along. Rows that match nothing stay as your own tasks
// under their old id. Old placeholders are folded into the real item they stood for.

import fs from 'node:fs';
import path from 'node:path';
import { stamp, live } from '../shared/doc.js';
import { reconcile, buildLibrary, mergeTasks, mylabTitleKey } from '../shared/reconcile.js';
import { DEFAULT_SETTINGS, classify, isPlaceholderFor, signature, contentWords, COURSE_ALIASES } from '../shared/model.js';
import { daysBetween, dayOf } from '../shared/time.js';

const [oldPath, snapArg, outDir] = process.argv.slice(2);
const old = JSON.parse(fs.readFileSync(oldPath, 'utf8'));
let snap;
if (snapArg === '--fixture') snap = await (await import('../tests/fixture.js')).snapshotFromFixture({ term: '202710', extraOus: [1134648] });
else snap = JSON.parse(fs.readFileSync(snapArg, 'utf8'));

const T = Date.now();
const settings = { ...DEFAULT_SETTINGS };
const { db: db0, schedules } = reconcile({}, snap, { settings, now: T });
const tasks = { ...db0.tasks };

// Courses: keep the old colours and full names.
const courses = { ...db0.courses };
for (const [k, c] of Object.entries(old.courses || {})) {
  courses[k] = stamp(courses[k], {
    id: k, name: `${c.name} · ${c.full}`, color: c.color, include: true,
    aliases: courses[k]?.aliases || COURSE_ALIASES[k] || [k.toLowerCase()], ous: courses[k]?.ous || [],
  }, T);
}

const index = new Map();
for (const t of live(tasks)) for (const r of [t.id, ...(t.refs || [])]) index.set(r, t.id);
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const byTitle = new Map();
for (const t of live(tasks)) {
  const k = `${t.course}|${norm(t.title)}`;
  byTitle.set(k, byTitle.has(k) ? null : t.id); // null = ambiguous
}

function urlKey(u = '', course) {
  const ou = (/[?&]ou=(\d+)/.exec(u) || /content\/(\d+)\//.exec(u) || [])[1];
  let m;
  if ((m = /[?&]db=(\d+)/.exec(u)) && ou) return `bs:${ou}:dropbox:${m[1]}`;
  if ((m = /[?&]qi=(\d+)/.exec(u)) && ou) return `bs:${ou}:quiz:${m[1]}`;
  if ((m = /viewContent\/(\d+)\/View/.exec(u)) && ou) return `bs:${ou}:topic:${m[1]}`;
  if ((m = /ModuleCO-(\d+)/.exec(u)) && ou) return `bs:${ou}:module:${m[1]}`;
  if ((m = /TopicCO-(\d+)/.exec(u)) && ou) return `bs:${ou}:topic:${m[1]}`;
  return null;
}

// Rows Matthew asked to decide himself: copied as they are, never matched or merged.
const KEEP_AS_IS = new Set(['x6e58f3d4b3']);

const report = { byUrl: 0, byTitle: 0, kept: 0, skipped: [], merged: [] };
const done = old.done || {};
const estO = old.est || {};
for (const it of old.items) {
  if (it.g === 'folder') { report.skipped.push(it.t); continue; } // replaced by "new material" badges
  const notes = [it.s, it.n].filter(Boolean).join('\n\n') || undefined;
  const pin = old.pinned?.[it.id];
  let target = null;
  const uk = KEEP_AS_IS.has(it.id) ? null : urlKey(it.u, it.c);
  // Recurring titles were keyed by calendar event: "EXTRA CREDIT : WEEKLY AI USE SURVEY #5242598".
  const ev = /#(\d{6,})\s*$/.exec(it.t);
  const evKey = ev && courses[it.c]?.ous?.length ? courses[it.c].ous.map((ou) => `bs:${ou}:cal:${ev[1]}`).find((k) => index.has(k)) : null;
  if (evKey) { target = index.get(evKey); report.byUrl++; }
  else if (uk && index.has(uk)) { target = index.get(uk); report.byUrl++; }
  else if (!KEEP_AS_IS.has(it.id)) {
    const tk = byTitle.get(`${it.c}|${norm(it.t)}`);
    if (tk) { target = tk; report.byTitle++; }
  }
  if (target) {
    const t = tasks[target];
    const patch = { aliases: [...new Set([...(t.aliases || []), it.id])] };
    if (done[it.id] && !t.done) Object.assign(patch, { done: true, doneBy: 'you', doneAt: t.due || undefined });
    if (estO[it.id]) patch.est = estO[it.id];
    if (notes && !(t.notes || '').includes(notes)) patch.notes = [t.notes, notes].filter(Boolean).join('\n\n');
    if (pin) Object.assign(patch, { due: pin.d, lock: { ...(t.lock || {}), due: true } });
    if (it.p) patch.pri = 1;
    tasks[target] = stamp(t, patch, T);
    continue;
  }
  report.kept++;
  const ml = it.c === 'MA261' ? mylabTitleKey(it.t) : null;
  tasks[it.id] = stamp(null, {
    id: it.id, title: it.t, course: it.c, due: pin ? pin.d : it.d || null,
    kind: it.k === 'event' ? 'event' : classify(it.t), est: estO[it.id] ?? (it.e || undefined),
    url: it.u ? (it.u.startsWith('/') ? `https://purdue.brightspace.com${it.u}` : it.u) : undefined,
    notes, pri: it.p ? 1 : undefined, src: ml ? 'mylab' : it.g === 'feed' ? 'bs' : 'manual', refs: ml ? [ml] : [],
    // A calendar-feed row that Brightspace no longer lists anywhere.
    missing: it.g === 'feed' && !done[it.id] ? new Date(T).toISOString().slice(0, 10) : undefined,
    ...(done[it.id] ? { done: true, doneBy: 'you', doneAt: it.d || undefined } : {}),
    created: T - 1,
  }, T);
}

// Fold old placeholders ("WileyPLUS HW 19") into the synced item they stood for, and
// placeholder + vanished-feed-row pairs for the same thing on the same deadline.
for (const ph of live(tasks).filter((t) => t.src === 'manual' && !KEEP_AS_IS.has(t.id))) {
  const twin = live(tasks).filter((t) => t.id !== ph.id && t.src === 'bs' && t.missing && t.course === ph.course && t.due === ph.due
    && signature(t.title).some((s) => signature(ph.title).includes(s)) && contentWords(ph.title).every((w) => contentWords(t.title).includes(w)));
  if (twin.length === 1) { mergeTasks(tasks, [twin[0], ph], twin[0].id, T + 1); report.merged.push(`${ph.title} → ${twin[0].title}`); continue; }
  const cands = live(tasks).filter((t) => t.src !== 'manual' && t.course === ph.course && isPlaceholderFor(ph, t)
    && (!ph.due || !t.due || Math.abs(daysBetween(dayOf(ph.due), dayOf(t.due))) <= 4));
  if (cands.length !== 1) continue;
  const keep = mergeTasks(tasks, [cands[0], ph], cands[0].id, T + 1);
  report.merged.push(`${ph.title} → ${keep.title}`);
}

const db = {
  tasks, courses,
  settings: { main: stamp(null, { id: 'main', ...settings, migratedAt: new Date(T).toISOString() }, T) },
  layout: {}, inbox: {}, reports: {}, timer: {},
};
const byOu = new Map();
for (const c of live(courses)) for (const ou of c.ous || []) byOu.set(String(ou), c.id);
const library = buildLibrary(null, snap, byOu, { tz: settings.tz, schedules, now: T });
const logDoc = { sessions: {}, syncs: { [new Date(T).toISOString()]: stamp(null, { id: new Date(T).toISOString(), at: new Date(T).toISOString(), ok: true, kind: 'migration', counts: {}, added: [], changed: [], errors: [] }, T) } };

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'db.json'), JSON.stringify(db));
fs.writeFileSync(path.join(outDir, 'library.json'), JSON.stringify(library));
fs.writeFileSync(path.join(outDir, 'log.json'), JSON.stringify(logDoc));

const L = live(tasks);
console.log(JSON.stringify({
  oldRows: old.items.length, oldDone: Object.values(done).filter(Boolean).length,
  tasks: L.length, open: L.filter((t) => !t.done).length, done: L.filter((t) => t.done).length,
  matchedByUrl: report.byUrl, matchedByTitle: report.byTitle, keptAsOwn: report.kept,
  skippedFolderRows: report.skipped.length, placeholdersFolded: report.merged,
}, null, 1));
