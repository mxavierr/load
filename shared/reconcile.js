// Turns a Brightspace/MyLab snapshot into task changes.
//
// The old tracker keyed rows by course+title, so a placeholder, a calendar event and a
// dropbox for the same assignment became three rows. Here every task is found by the
// ids Brightspace itself uses (dropbox, quiz, survey, content topic, folder), and the
// calendar event and content topic that point at the same dropbox are folded into it.
// One assignment, one task, whatever it is called.

import { stamp, live, now as nowMs } from './doc.js';
import { toLocal, addDays, dayOf } from './time.js';
import { classify, courseKey, isPlaceholderFor, PALETTE, COURSE_ALIASES } from './model.js';

const BS = 'https://purdue.brightspace.com';
const ENT_TYPES = {
  'D2L.LE.Dropbox.Dropbox': 'dropbox',
  'D2L.LE.Quizzing.Quiz': 'quiz',
  'D2L.LE.Survey.Survey': 'survey',
  'D2L.LE.Content.ContentObject.TopicCO': 'topic',
  'D2L.LE.Content.ContentObject.ModuleCO': 'module',
};
const TOOL_ACT = { 3: 'dropbox', 4: 'quiz', 12: 'survey' };
const EV_DUE = 6, EV_END = 3, EV_PLAIN = 1;
const EXAM_RE = /\b(exam|midterm|test|quiz|final|presentation|due)\b/i;
const NOT_WORK_RE = /no class|no final|no exam|test day|spring break|fall break|holiday|recess/i;

export const topicUrl = (ou, id) => `${BS}/d2l/le/content/${ou}/viewContent/${id}/View`;
export const fileUrl = (ou, id) => `${BS}/d2l/api/le/1.100/${ou}/content/topics/${id}/file?stream=true`;

function walkToc(mods, fn, path = []) {
  for (const m of mods || []) {
    if (m.hidden) continue;
    fn(null, m, path);
    for (const t of m.topics || []) if (!t.hidden) fn(t, m, path);
    walkToc(m.modules, fn, [...path, m.title]);
  }
}

/** Every dated, task-like thing in one course, keyed by its Brightspace id. */
export function courseEntities(c, { tz, ignore = [], at }) {
  const L = (d) => toLocal(d, tz);
  const ou = c.ou;
  const ents = new Map();
  const ign = ignore.map((s) => s.toLowerCase());
  const tooOld = addDays(dayOf(L(at)), -150);
  const skip = (title, due) => ign.some((s) => (title || '').toLowerCase().includes(s)) || (due && due < tooOld);
  const add = (key, e) => {
    if (skip(e.title, e.due)) return null;
    const ent = { key, ou, refs: new Set([key]), ...e };
    ents.set(key, ent);
    return ent;
  };

  for (const f of c.dropbox || []) {
    if (f.hidden) continue;
    add(`bs:${ou}:dropbox:${f.id}`, {
      type: 'dropbox', title: f.title, due: L(f.due), start: L(f.start), end: L(f.end), info: f.info,
      url: `${BS}/d2l/lms/dropbox/user/folder_submit_files.d2l?db=${f.id}&ou=${ou}`,
    });
  }
  for (const q of c.quizzes || []) {
    if (q.active === false) continue;
    add(`bs:${ou}:quiz:${q.id}`, {
      type: 'quiz', title: q.title, due: L(q.due), start: L(q.start), end: L(q.end), grade: q.grade,
      info: [q.limit ? `${q.limit} min limit` : '', q.attempts ? `${q.attempts} attempt${q.attempts > 1 ? 's' : ''}` : ''].filter(Boolean).join(' · '),
      url: `${BS}/d2l/lms/quizzing/user/quiz_summary.d2l?qi=${q.id}&ou=${ou}`,
    });
  }
  for (const s of c.surveys || []) {
    add(`bs:${ou}:survey:${s.id}`, { type: 'survey', title: s.title, due: null, start: L(s.start), end: L(s.end), url: `${BS}/d2l/lms/survey/user/surveys_list.d2l?ou=${ou}` });
  }

  // Content topics that are just the doorway to a dropbox/quiz/survey fold into it.
  const alias = new Map(); // topic key -> tool key
  const topics = new Map();
  const parentOf = new Map(); // topic id -> module id
  walkToc(c.toc, (t, m) => {
    if (!t) return;
    topics.set(t.id, t);
    parentOf.set(t.id, m.id);
    const tool = TOOL_ACT[t.act];
    if (tool && t.tool) {
      const k = `bs:${ou}:${tool}:${t.tool}`;
      alias.set(`bs:${ou}:topic:${t.id}`, k);
      const e = ents.get(k);
      if (e) {
        e.refs.add(`bs:${ou}:topic:${t.id}`);
        e.topicId = t.id;
        if (tool !== 'dropbox') e.url = topicUrl(ou, t.id); // dropbox keeps its submit page
      }
    }
  });

  const schedule = [];
  for (const ev of c.cal || []) {
    const when = L(ev.start);
    if (ev.ent) {
      const type = ENT_TYPES[ev.ent.type];
      if (!type) continue;
      let key = `bs:${ou}:${type}:${ev.ent.id}`;
      if (alias.has(key)) key = alias.get(key);
      const e = ents.get(key);
      if (e) {
        e.refs.add(`bs:${ou}:cal:${ev.id}`);
        if (!e.due && (ev.type === EV_DUE || (ev.type === EV_END && e.type === 'survey'))) e.due = when;
        continue;
      }
      if (ev.type !== EV_DUE) continue;
      if (type === 'topic' || type === 'module' || type === 'survey' || type === 'quiz' || type === 'dropbox') {
        const t = topics.get(ev.ent.id);
        const n = add(key, {
          type, title: ev.title, due: when,
          url: type === 'topic' ? topicUrl(ou, ev.ent.id) : ev.ent.link || ev.link,
          lti: t ? t.act === 7 : false,
        });
        if (n) {
          n.refs.add(`bs:${ou}:cal:${ev.id}`);
          if (type === 'topic') n.topicId = ev.ent.id;
        }
      }
    } else if (ev.type === EV_PLAIN && when) {
      schedule.push({ id: ev.id, title: ev.title, start: when, allDay: ev.allDay });
      if (EXAM_RE.test(ev.title) && !NOT_WORK_RE.test(ev.title)) {
        const n = add(`bs:${ou}:event:${ev.id}`, { type: 'event', title: ev.title, due: when, url: ev.link, kind: 'exam' });
        if (n) n.refs.add(`bs:${ou}:cal:${ev.id}`);
      }
    }
  }

  // A dated folder holding exactly one dated item is one piece of work, not two
  // ("SIMILAR PHYSICS PROBLEM GENERATION" folder + its survey). Keep the item.
  const kids = new Map();
  for (const e of ents.values()) {
    if (!e.topicId || e.type === 'module') continue;
    const mk = `bs:${ou}:module:${parentOf.get(e.topicId)}`;
    if (!ents.has(mk)) continue;
    if (!kids.has(mk)) kids.set(mk, []);
    kids.get(mk).push(e);
  }
  for (const [mk, list] of kids) {
    const mod = ents.get(mk);
    const near = list.filter((e) => e.due && mod.due && Math.abs(Date.parse(e.due) - Date.parse(mod.due)) <= 864e5);
    if (list.length !== 1 || near.length !== 1) continue;
    const child = near[0];
    for (const r of mod.refs) child.refs.add(r);
    child.folded = mk;
    ents.delete(mk);
  }

  // Completion. Content completion means "submitted" only for dropbox/quiz/survey doorways
  // and folders; for links and LTI tools (WileyPLUS) it only means "opened".
  const doneTopic = new Map(), doneModule = new Map();
  for (const i of c.myItems || []) {
    if (!i.done) continue;
    (i.type === 0 ? doneModule : doneTopic).set(i.id, L(i.done));
  }
  for (const e of ents.values()) {
    if (e.type === 'module' && doneModule.has(Number(e.key.split(':')[3]))) e.done = doneModule.get(Number(e.key.split(':')[3]));
    if (e.topicId && doneTopic.has(e.topicId)) {
      // Opening a file or link is the whole job ("watch the pre-lecture video");
      // opening an external tool (WileyPLUS) is not.
      const act = topics.get(e.topicId)?.act;
      if (e.type === 'topic' && act !== 1 && act !== 2) e.opened = doneTopic.get(e.topicId);
      else e.done = doneTopic.get(e.topicId);
    }
    if (e.type === 'dropbox') {
      const subs = c.subs && c.subs[e.key.split(':')[3]];
      if (Array.isArray(subs) && subs.length) e.done = L(subs.map((s) => s.at).sort().pop());
    }
    if (e.type === 'quiz' && e.grade && c.grades) {
      const g = c.grades.find((x) => String(x.id) === String(e.grade));
      if (g && g.num > 0) e.done = e.done || L(g.mod) || 'graded';
    }
  }
  return { ents, schedule, topics };
}

/** "Lesson 1, Part 2- Section 13.2" -> "mylab-t:lesson 1 part 2" (matches rows made before MyLab ids were known). */
export function mylabTitleKey(title = '') {
  const m = /lesson\s*0*(\d+)(?:\s*,?\s*part\s*(\d+|i{1,3}))?/i.exec(title);
  if (!m) return null;
  const roman = { i: 1, ii: 2, iii: 3 };
  const part = m[2] ? roman[m[2].toLowerCase()] || +m[2] : null;
  return `mylab-t:lesson ${+m[1]}${part ? ` part ${part}` : ''}`;
}

export function mylabEntities(rows, settings) {
  const ents = new Map();
  const ml = settings.mylab || {};
  for (const r of rows || []) {
    const key = `mylab:${r.id}`;
    const lt = mylabTitleKey(r.title);
    ents.set(key, {
      key, refs: new Set(lt ? [key, lt] : [key]), type: 'mylab', title: r.title, due: r.due,
      done: r.scored ? 'scored' : null, score: r.score,
      url: topicUrl(ml.ou, ml.topicId), kind: r.kind === 'homework' ? 'hw' : classify(r.title),
    });
  }
  return ents;
}

function ensureCourses(db, snap, t) {
  const courses = { ...(db.courses || {}) };
  const byOu = new Map();
  for (const rec of live(courses)) for (const ou of rec.ous || []) byOu.set(String(ou), rec.id);
  let i = Object.keys(courses).length;
  for (const c of snap.courses || []) {
    let key = byOu.get(String(c.ou));
    if (!key) {
      key = courseKey(c.code, c.name);
      const prev = courses[key];
      const ous = [...new Set([...(prev?.ous || []), c.ou])];
      courses[key] = stamp(prev, {
        id: key, name: prev?.name || c.name.replace(/^Fall \d{4}\s*/, '').replace(/\s*-\s*Merge$/, ''), ous,
        ...(prev ? {} : { color: PALETTE[i++ % PALETTE.length], aliases: COURSE_ALIASES[key] || [key.toLowerCase()], include: true }),
      }, t);
      byOu.set(String(c.ou), key);
    }
  }
  return { courses, byOu };
}

function changed(rec, patch) {
  const out = {};
  for (const [k, v] of Object.entries(patch)) if (JSON.stringify(rec?.[k]) !== JSON.stringify(v)) out[k] = v;
  return out;
}

/**
 * Apply a snapshot to the db. Never deletes and never un-ticks; a task the source stops
 * listing is flagged `missing`. Fields you edited by hand (`lock`) are left alone, and a
 * source date that disagrees with your locked date is kept beside it as `srcDue`.
 */
export function reconcile(db, snap, opts = {}) {
  const t = opts.now || nowMs();
  const settings = { ...(opts.settings || {}) };
  const tz = settings.tz;
  const at = snap.at || new Date(t).toISOString();
  const report = { at, ok: !!snap.ok, added: [], changed: [], completed: [], merged: [], missing: [], back: [], conflicts: [], errors: [...(snap.errors || [])], counts: {} };
  const { courses, byOu } = ensureCourses(db, snap, t);
  const tasks = { ...(db.tasks || {}) };

  // All entities from this snapshot.
  const all = new Map();
  const coveredOus = new Set();
  const schedules = {};
  for (const c of snap.courses || []) {
    if (c.errors?.length) report.errors.push(...c.errors.map((e) => `${byOu.get(String(c.ou))}: ${e}`));
    const course = byOu.get(String(c.ou));
    if (courses[course]?.include === false) continue;
    const { ents, schedule } = courseEntities(c, { tz, ignore: settings.ignore, at });
    if (c.ok) coveredOus.add(String(c.ou));
    schedules[c.ou] = schedule;
    for (const e of ents.values()) { e.course = course; all.set(e.key, e); }
    report.counts[course] = (report.counts[course] || 0) + ents.size;
  }
  const mylabOk = snap.mylab && snap.mylab.ok;
  if (snap.mylab?.rows) {
    for (const e of mylabEntities(snap.mylab.rows, settings).values()) { e.course = settings.mylab?.course || 'MA261'; all.set(e.key, e); }
    report.counts.MyLab = snap.mylab.rows.length;
  }
  if (snap.mylab && !snap.mylab.ok && snap.mylab.error) report.errors.push(`MyLab: ${snap.mylab.error}`);

  // Index current tasks by every ref.
  // Deleted tasks stay in the index so a sync never brings back something you removed.
  const index = new Map();
  const reindex = () => {
    index.clear();
    for (const task of Object.values(tasks)) for (const r of [task.id, ...(task.refs || [])]) {
      if (!index.has(r)) index.set(r, []);
      index.get(r).push(task.id);
    }
  };
  reindex();

  const seen = new Set();
  for (const e of all.values()) {
    for (const r of e.refs) seen.add(r);
    const all = [...new Set([...e.refs].flatMap((r) => index.get(r) || []))].map((id) => tasks[id]).filter(Boolean);
    const hits = all.filter((x) => !x.deleted);
    if (!hits.length && all.length) continue; // you removed it (or it was merged away)

    let task;
    if (hits.length > 1) {
      task = mergeTasks(tasks, hits, e.key, t);
      report.merged.push({ id: task.id, title: task.title, from: hits.filter((h) => h.id !== task.id).map((h) => h.title) });
    } else if (hits.length === 1) task = hits[0];
    else {
      const ph = placeholderFor(tasks, e);
      if (ph) {
        task = stamp(ph, { refs: [...new Set([...(ph.refs || []), ...e.refs])], title: e.title, due: e.due, lock: { ...(ph.lock || {}), title: false, due: false } }, t);
        tasks[task.id] = task;
        report.merged.push({ id: task.id, title: e.title, from: [ph.title], placeholder: true });
      }
    }

    if (!task) {
      task = stamp(null, {
        id: e.key, title: e.title, course: e.course, due: e.due || null, start: e.start || null, end: e.end || null,
        kind: e.kind || classify(e.title), url: e.url, refs: [...e.refs], src: e.type === 'mylab' ? 'mylab' : 'bs',
        info: e.info || undefined, opened: e.opened || undefined, created: t,
        ...(e.done ? { done: true, doneAt: e.done, doneBy: 'sync', sub: e.done } : {}),
      }, t);
      tasks[task.id] = task;
      report.added.push({ id: task.id, title: task.title, due: task.due, course: task.course });
      if (e.done) report.completed.push({ id: task.id, title: task.title, quiet: true });
      continue;
    }

    const lock = task.lock || {};
    const patch = { refs: [...new Set([...(task.refs || []), ...e.refs])], src: task.src === 'manual' ? 'manual' : e.type === 'mylab' ? 'mylab' : 'bs' };
    if (!lock.title) patch.title = e.title;
    if (!lock.url && e.url) patch.url = e.url;
    if (e.start !== undefined) patch.start = e.start || null;
    if (e.end !== undefined) patch.end = e.end || null;
    if (e.info) patch.info = e.info;
    if (!task.course) patch.course = e.course;
    if (e.opened) patch.opened = e.opened;
    if (lock.due) {
      if (e.due && e.due !== task.due) {
        if (task.srcDue !== e.due) report.conflicts.push({ id: task.id, title: task.title, mine: task.due, src: e.due });
        patch.srcDue = e.due;
      } else patch.srcDue = undefined;
    } else if (e.due && e.due !== task.due) {
      if (task.due) {
        patch.moved = { from: task.due, at: dayOf(toLocal(new Date(t), tz)) };
        report.changed.push({ id: task.id, title: task.title, field: 'due', from: task.due, to: e.due });
      }
      patch.due = e.due;
    }
    if (task.missing) { patch.missing = undefined; report.back.push({ id: task.id, title: task.title }); }
    if (e.done) {
      patch.sub = e.done;
      if (!task.done && !lock.done) {
        Object.assign(patch, { done: true, doneAt: e.done === 'scored' || e.done === 'graded' ? toLocal(new Date(t), tz) : e.done, doneBy: 'sync' });
        report.completed.push({ id: task.id, title: task.title });
      }
    }
    const diff = changed(task, patch);
    if (Object.keys(diff).length) tasks[task.id] = stamp(task, diff, t);
    reindex();
  }

  // Missing: only judged for courses (and MyLab) that were read completely this time.
  const today = dayOf(toLocal(new Date(t), tz));
  for (const task of live(tasks)) {
    const refs = [task.id, ...(task.refs || [])].filter((r) => r.startsWith('bs:') || r.startsWith('mylab:'));
    if (!refs.length || task.missing) continue;
    if (refs.some((r) => seen.has(r))) continue;
    const judged = refs.every((r) => (r.startsWith('mylab:') ? mylabOk : coveredOus.has(r.split(':')[1])));
    if (!judged) continue;
    if (task.done && task.due && task.due.slice(0, 10) < addDays(today, -14)) continue;
    tasks[task.id] = stamp(task, { missing: today }, t);
    report.missing.push({ id: task.id, title: task.title, done: !!task.done });
  }

  return { db: { ...db, courses, tasks }, report, schedules };
}

/** Fold duplicate tasks into one; the survivor keeps the source id when one of them has it. */
export function mergeTasks(tasks, hits, preferId, t) {
  const sorted = [...hits].sort((a, b) => (a.id === preferId ? -1 : b.id === preferId ? 1 : (a.created || 0) - (b.created || 0)));
  let keep = sorted[0];
  const rest = sorted.slice(1);
  const patch = {
    refs: [...new Set(hits.flatMap((h) => [h.id, ...(h.refs || [])]))].filter((r) => r !== keep.id),
    aliases: [...new Set([...(keep.aliases || []), ...rest.flatMap((h) => [h.id, ...(h.aliases || [])])])],
  };
  const doneOne = hits.find((h) => h.done);
  if (doneOne && !keep.done) Object.assign(patch, { done: true, doneAt: doneOne.doneAt, doneBy: doneOne.doneBy });
  const notes = hits.map((h) => h.notes).filter(Boolean);
  if (notes.length > 1 || (notes.length === 1 && !keep.notes)) patch.notes = [...new Set(notes)].join('\n\n');
  if (!keep.est) { const est = hits.find((h) => h.est)?.est; if (est) patch.est = est; }
  const cl = hits.flatMap((h) => h.checklist || []);
  if (cl.length) patch.checklist = cl;
  if (!keep.doDate) { const d = hits.find((h) => h.doDate)?.doDate; if (d) patch.doDate = d; }
  if (!keep.due) { const d = hits.find((h) => h.due)?.due; if (d) patch.due = d; }
  const others = rest.map((h) => h.title).filter((x) => x && x !== keep.title);
  if (others.length) {
    const line = `Also listed as: ${others.join(' · ')}`;
    const base = patch.notes ?? keep.notes;
    if (!(base || '').includes(line)) patch.notes = [base, line].filter(Boolean).join('\n\n');
  }
  keep = stamp(keep, patch, t);
  tasks[keep.id] = keep;
  for (const h of rest) tasks[h.id] = stamp(h, { deleted: true, mergedInto: keep.id }, t);
  return keep;
}

/** A hand-made, unsynced task that is clearly the placeholder for this new item. */
function placeholderFor(tasks, e) {
  const cands = live(tasks).filter((x) => x.course === e.course && (x.src === 'manual' || !x.src) && !(x.refs || []).length && !x.done && isPlaceholderFor(x, e));
  return cands.length === 1 ? cands[0] : null;
}

/** Course material trees, grades, announcements and first-seen dates for "new" badges. */
export function buildLibrary(prev, snap, byOuKey, opts = {}) {
  const tz = opts.tz;
  const t = opts.now || nowMs();
  const nowL = toLocal(new Date(t), tz);
  const lib = { courses: { ...(prev?.courses || {}) }, seen: { ...(prev?.seen || {}) } };
  const first = !prev || !Object.keys(prev.seen || {}).length;
  const mark = (k) => { if (!lib.seen[k]) lib.seen[k] = { id: k, at: first ? '2000-01-01T00:00' : nowL }; return lib.seen[k].at; };
  for (const c of snap.courses || []) {
    if (!c.toc && !c.grades && !c.news) continue;
    const ou = c.ou;
    const kind = (tp) => (tp.act === 3 ? 'dropbox' : tp.act === 4 ? 'quiz' : tp.act === 12 ? 'survey' : tp.act === 7 ? 'lti' : tp.type === 'File' ? 'file' : 'link');
    const tree = (mods) => (mods || []).filter((m) => !m.hidden).map((m) => ({
      id: `m${m.id}`, t: m.title, k: 'module', n: mark(`${ou}:m:${m.id}`),
      c: [
        ...tree(m.modules),
        ...(m.topics || []).filter((x) => !x.hidden).map((x) => ({
          id: `t${x.id}`, t: x.title, k: kind(x), n: mark(`${ou}:t:${x.id}`),
          u: x.act === 2 && /^https?:/.test(x.url || '') ? x.url : topicUrl(ou, x.id),
          ...(x.type === 'File' ? { f: fileUrl(ou, x.id) } : {}),
        })),
      ],
    }));
    const prevC = lib.courses[ou] || {};
    lib.courses[ou] = {
      id: String(ou), ou, course: byOuKey.get(String(ou)), name: c.name, at: nowL,
      tree: c.toc ? tree(c.toc) : prevC.tree || [],
      grades: c.grades ? c.grades.filter((g) => g.den || g.shown).map((g) => ({ name: g.name, type: g.type, num: g.num, den: g.den, shown: g.shown })) : prevC.grades || [],
      news: c.news ? c.news.slice(0, 15).map((n) => ({ ...n, at: toLocal(n.at, tz), n: mark(`${ou}:n:${n.id}`) })) : prevC.news || [],
      schedule: opts.schedules?.[ou] || prevC.schedule || [],
    };
  }
  return lib;
}
