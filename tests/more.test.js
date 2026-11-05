import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RemoteFile } from '../shared/store.js';
import { stamp, live, mergeDocs } from '../shared/doc.js';
import { localGitHub } from '../hub/localgh.mjs';
import { makePlan, workDay } from '../shared/plan.js';
import { parseQuick, isCommand } from '../shared/quickadd.js';
import { editTask, applyOps, newTask } from '../shared/ops.js';
import { runChecks } from '../shared/checks.js';
import { reconcile, trackedIds } from '../shared/reconcile.js';
import { shouldSync, matchTask, beat, close, lastSlot } from '../extension/src/logic.js';
import { asLocal } from '../shared/time.js';

const TZ = 'America/Indiana/Indianapolis';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'load-test-'));
const file = (fetch) => new RemoteFile({ repo: 'me/data', path: 'db.json', fetch });
const task = (id, f, t = 1) => stamp(null, { id, title: id, src: 'manual', ...f }, t);

describe('saving from two devices', () => {
  it('merges concurrent edits instead of overwriting', async () => {
    const gh = localGitHub(tmp());
    const mac = file(gh), phone = file(gh);
    await mac.pull();
    await mac.push({ tasks: { a: task('a', { title: 'A' }) } });
    await phone.pull();
    await mac.pull();
    await phone.push({ ...phone.doc, tasks: { ...phone.doc.tasks, a: stamp(phone.doc.tasks.a, { done: true }, 5) } });
    // The Mac saves without having seen the phone's write: GitHub rejects the sha, it merges, retries.
    await mac.push({ ...mac.doc, tasks: { ...mac.doc.tasks, b: task('b', {}, 6) } });
    const check = file(gh);
    await check.pull();
    expect(check.doc.tasks.a.done).toBe(true);
    expect(Object.keys(check.doc.tasks).sort()).toEqual(['a', 'b']);
  });

  it('a poll landing mid-save cannot make the save erase another device', async () => {
    const gh = localGitHub(tmp());
    const mac = file(gh), phone = file(gh);
    await mac.push({ tasks: { a: task('a', {}) } });
    await phone.pull();
    const prepared = { ...mac.doc, tasks: { ...mac.doc.tasks, b: task('b', {}, 7) } }; // built from the old copy
    await phone.push({ ...phone.doc, tasks: { ...phone.doc.tasks, c: task('c', {}, 8) } });
    await mac.pull(); // the background poll picks up the phone's write (new sha)...
    await mac.push(prepared); // ...then the save made from the old copy goes out under that sha
    const check = file(gh);
    await check.pull();
    expect(Object.keys(check.doc.tasks).sort()).toEqual(['a', 'b', 'c']);
  });

  it('skips the write when nothing changed', async () => {
    let puts = 0;
    const gh = localGitHub(tmp());
    const f = file((u, o) => { if (o?.method === 'PUT') puts++; return gh(u, o); });
    await f.push({ tasks: { a: task('a', {}) } });
    await f.push(f.doc);
    expect(puts).toBe(1);
  });

  it('deletes stay deleted after merging with an older copy', () => {
    const a = { tasks: { x: task('x', {}, 1) } };
    const b = { tasks: { x: stamp(a.tasks.x, { deleted: true }, 2) } };
    expect(mergeDocs(a, b).tasks.x.deleted).toBe(true);
    expect(mergeDocs(b, a).tasks.x.deleted).toBe(true);
  });
});

describe('planner', () => {
  const now = new Date('2026-11-02T14:00:00Z'); // Mon 9am Eastern
  const settings = { tz: TZ, capacity: { weekday: 240, weekend: 300 }, earlyDue: '12:00' };
  const plan = (tasks) => makePlan({ tasks: Object.fromEntries(tasks.map((t) => [t.id, t])), sessions: {}, settings, now });

  it('leaves undated work out unless you pick a day', () => {
    const p = plan([task('undated', { kind: 'project' }), task('picked', { kind: 'task', doDate: '2026-11-02' })]);
    const today = p.days[0].items.map((i) => i.id);
    expect(today).toContain('picked');
    expect(p.days.flatMap((d) => d.items).map((i) => i.id)).not.toContain('undated');
  });

  it('does not plan work before it opens', () => {
    const p = plan([task('lab', { kind: 'lab', est: 150, due: '2026-11-07T23:59', start: '2026-11-05T00:00' })]);
    expect(p.days[0].items).toHaveLength(0);
    expect(p.days.slice(3).flatMap((d) => d.items).some((i) => i.id === 'lab')).toBe(true);
  });

  it('spreads a big task before its deadline and counts noon deadlines as the day before', () => {
    const p = plan([
      task('big', { kind: 'project', est: 600, due: '2026-11-05T23:59' }),
      task('noon', { kind: 'rec', est: 60, due: '2026-11-04T12:00' }),
    ]);
    const days = p.days.map((d) => d.items.filter((i) => i.id === 'big').reduce((a, i) => a + i.min, 0));
    expect(days.slice(0, 4).filter((m) => m > 0).length).toBeGreaterThan(1);
    expect(workDay(p.info && { due: '2026-11-04T12:00', kind: 'rec' })).toBe('2026-11-03');
  });

  it('keeps missing items and done items off the plan', () => {
    const p = plan([task('gone', { due: '2026-11-03T23:59', missing: '2026-11-01' }), task('done', { due: '2026-11-03T23:59', done: true })]);
    expect(p.days.flatMap((d) => d.items)).toHaveLength(0);
  });
});

describe('quick add', () => {
  const courses = [{ id: 'PHYS172', aliases: ['phys', '172'] }, { id: 'MA261', aliases: ['ma', 'math', '261'] }];
  const now = new Date('2026-11-01T15:00:00Z');
  it.each([
    ['Do problem set 4', false], ['Check grades', false], ['Set up Colab', false], ['Plan essay outline', false],
    ['Make flashcards for exam 3', false], ['Read chapter 5', false], ['Update resume', false],
    ['move all ENGT labs an hour later', true], ['what is due friday', true], ['do I have anything due tomorrow', true],
    ['mark HW 17 as done', true], ['push lab 10 to sunday', true], ['delete the iclicker quizzes', true], ['anything due tonight?', true],
  ])('%s → command %s', (text, cmd) => expect(isCommand(text)).toBe(cmd));

  it('removes every spelling of the course from the title', () => {
    expect(parseQuick('ma 261 hw due tmrw', { courses, tz: TZ, now })).toMatchObject({ course: 'MA261', title: 'Hw', due: '2026-11-02T23:59' });
  });
  it('handles tonight, noon, 24h time, decimals and next week', () => {
    expect(parseQuick('call home tonight', { courses, tz: TZ, now }).due).toBe('2026-11-01T23:59');
    expect(parseQuick('meet ta thu 14:30 1.5h', { courses, tz: TZ, now })).toMatchObject({ due: '2026-11-05T14:30', est: 90 });
    expect(parseQuick('phys review next week', { courses, tz: TZ, now }).due).toBe('2026-11-08T23:59');
    expect(parseQuick('essay 12/1 5pm', { courses, tz: TZ, now }).due).toBe('2026-12-01T17:00');
  });
  it('does not read words as dates', () => {
    const p = parseQuick('Monitor sat scores for the satellite lab', { courses, tz: TZ, now });
    expect(p.title).toContain('Monitor');
    expect(p.title).toContain('satellite');
  });
});

describe('editing', () => {
  it('locks synced fields you change, and "use theirs" unlocks the date', () => {
    const t = stamp(null, { id: 'bs:1:dropbox:2', title: 'LAB', src: 'bs', due: '2026-11-07T23:59' }, 1);
    const e1 = editTask(t, { due: '2026-11-08T23:59' }, 2);
    expect(e1.lock.due).toBe(true);
    const withSrc = stamp(e1, { srcDue: '2026-11-07T23:59' }, 3);
    const e2 = editTask(withSrc, { due: withSrc.srcDue, lock: { ...withSrc.lock, due: false } }, 4);
    expect(e2.lock.due).toBe(false);
    expect(e2.srcDue).toBeUndefined();
  });
  it('records completion in local time', () => {
    const t = editTask(newTask({ title: 'x' }, 1), { done: true }, Date.parse('2026-11-02T02:30:00Z'));
    expect(t.doneAt).toBe('2026-11-01T21:30'); // 9:30pm Eastern stays on the 1st
    expect(asLocal('2026-11-02T02:30:00.000Z', TZ)).toBe('2026-11-01T21:30');
  });
  it('applies assistant ops and ignores ones that point nowhere', () => {
    const db = { tasks: { a: newTask({ id: 'a', title: 'A' }, 1) } };
    const r = applyOps(db, [{ op: 'update', id: 'a', set: { doDate: '2026-11-03', bogus: 1 } }, { op: 'update', id: 'nope', set: { title: 'x' } }, { op: 'add', task: { title: 'B' } }, { op: 'delete', id: 'nope' }]);
    expect(r.applied).toHaveLength(2);
    expect(r.db.tasks.a.doDate).toBe('2026-11-03');
    expect(r.db.tasks.a.bogus).toBeUndefined();
    expect(live(r.db.tasks)).toHaveLength(2);
  });
  it('merging keeps the tick, notes and time of both', () => {
    const db = { tasks: { m: newTask({ id: 'm', title: 'HW 21' }, 1), s: stamp(null, { id: 's', title: 'PHYS - HW21', src: 'bs', refs: ['bs:1:topic:9'] }, 1) } };
    db.tasks.m = editTask(stamp(db.tasks.m, { notes: 'start early' }, 2), { done: true }, 3);
    const r = applyOps(db, [{ op: 'merge', ids: ['m', 's'] }]);
    expect(r.db.tasks.s.done).toBe(true);
    expect(r.db.tasks.s.notes).toContain('start early');
    expect(r.db.tasks.s.aliases).toContain('m');
    expect(r.db.tasks.m.deleted).toBe(true);
  });
});

describe('sync never fights you', () => {
  const snap = (ents) => ({ at: '2026-11-02T13:00:00.000Z', ok: true, courses: [{ ou: 9, code: 'wl.202710.PHYS.17200.1', name: 'PHYS', ok: true, toc: [], quizzes: [], surveys: [], cal: [], myItems: [], subs: {}, dropbox: ents }] });
  const settings = { tz: TZ, ignore: [] };
  it('re-ticks nothing you unticked and moves dates it owns', () => {
    const r1 = reconcile({}, snap([{ id: 1, title: 'LAB 1', due: '2026-11-08T04:59:00.000Z' }]), { settings, now: 1 });
    const id = 'bs:9:dropbox:1';
    const unticked = editTask(stamp(r1.db.tasks[id], { done: true, doneBy: 'sync' }, 2), { done: false }, 3);
    const r2 = reconcile({ ...r1.db, tasks: { [id]: unticked } }, { ...snap([{ id: 1, title: 'LAB 1', due: '2026-11-09T04:59:00.000Z' }]), courses: [{ ...snap([]).courses[0], dropbox: [{ id: 1, title: 'LAB 1', due: '2026-11-09T04:59:00.000Z' }], subs: { 1: [{ at: '2026-11-08T01:00:00Z', files: 1 }] } }] }, { settings, now: 4 });
    expect(r2.db.tasks[id].done).toBe(false);
    expect(r2.db.tasks[id].due).toBe('2026-11-08T23:59');
    expect(r2.db.tasks[id].moved.from).toBe('2026-11-07T23:59');
  });
  describe('work you are tracking', () => {
    const rows = (scored) => ({ at: '2026-11-02T13:00:00.000Z', ok: true, courses: [], mylab: { ok: true, rows: [{ id: '123456', title: 'Lesson 26', due: '2026-11-03T23:59', scored }] } });
    const start = () => reconcile({}, rows(false), { settings, now: 1 }).db;
    const id = 'mylab:123456';

    it('sync ticks work nobody tracked', () => {
      expect(reconcile(start(), rows(true), { settings, now: 2 }).db.tasks[id].done).toBe(true);
    });
    it('sync leaves tracked work open and notes what it saw', () => {
      const r = reconcile(start(), rows(true), { settings, now: 2, tracked: new Set([id]) });
      expect(r.db.tasks[id].done).toBeFalsy();
      expect(r.db.tasks[id].sub).toBe('scored');
      expect(r.report.completed).toEqual([]);
    });
    it('time logged under a merged-in id still counts', () => {
      const db = start();
      db.tasks[id] = stamp(db.tasks[id], { aliases: ['t:old'] }, 2);
      expect(reconcile(db, rows(true), { settings, now: 3, tracked: new Set(['t:old']) }).db.tasks[id].done).toBeFalsy();
    });
    it('finds the running timer, logged sessions and the extension\'s open session', () => {
      const ids = trackedIds({ timer: { main: { task: 'a' } } }, { s1: { task: 'b' }, s2: { task: 'gone', deleted: true } }, ['c']);
      expect([...ids].sort()).toEqual(['a', 'b', 'c']);
    });
    it('your own tick still sticks', () => {
      const db = start();
      db.tasks[id] = editTask(db.tasks[id], { done: true }, 2);
      expect(reconcile(db, rows(true), { settings, now: 3, tracked: new Set([id]) }).db.tasks[id].doneBy).toBe('you');
    });
    it('going over the estimate keeps a task on the plan, open', () => {
      const tasks = { x: stamp(null, { id: 'x', title: 'Lesson 26', kind: 'hw', est: 60, due: '2026-11-05T23:59' }, 1) };
      const sessions = { s: { id: 's', task: 'x', s: '2026-11-05T10:00:00Z', e: '2026-11-05T12:00:00Z' } };
      const p = makePlan({ tasks, sessions, settings: { tz: TZ }, now: new Date('2026-11-05T15:00:00Z') });
      expect(tasks.x.done).toBeUndefined();
      expect(p.days[0].items.map((i) => i.id)).toEqual(['x']);
      expect(p.info.get('x').spent).toBe(120);
    });
  });
  it('a failed course read never marks its tasks missing', () => {
    const r1 = reconcile({}, snap([{ id: 1, title: 'LAB 1', due: '2026-11-08T04:59:00.000Z' }]), { settings, now: 1 });
    const bad = snap([]);
    bad.courses[0].ok = false;
    bad.courses[0].dropbox = null;
    const r2 = reconcile(r1.db, bad, { settings, now: 2 });
    expect(r2.db.tasks['bs:9:dropbox:1'].missing).toBeUndefined();
  });
});

describe('checks', () => {
  it('flags a placeholder that duplicates a synced item, not two different uploads', () => {
    const tasks = Object.fromEntries([
      task('ph', { title: 'WileyPLUS HW 21', course: 'P', due: '2026-11-18T23:59' }),
      stamp(null, { id: 's', title: 'PHYS 172 - FA25 - HW21', course: 'P', src: 'bs', due: '2026-11-18T23:59' }, 1),
      stamp(null, { id: 'l1', title: 'LAB 10 : IPYNB FILE UPLOAD', course: 'P', src: 'bs', due: '2026-11-07T23:59' }, 1),
      stamp(null, { id: 'l2', title: 'LAB 10 : PDF FILE UPLOAD', course: 'P', src: 'bs', due: '2026-11-07T23:59' }, 1),
    ].map((t) => [t.id, t]));
    const f = runChecks({ db: { tasks }, log: {}, library: {}, settings: { tz: TZ } });
    const dups = f.filter((x) => x.id.startsWith('dup-'));
    expect(dups).toHaveLength(1);
    expect(dups[0].taskIds.sort()).toEqual(['ph', 's']);
  });
});

describe('extension logic', () => {
  const at = (s) => new Date(s).getTime();
  it('runs a scheduled sync only once its slot passed and you are at the Mac', () => {
    const now = at('2026-11-02T08:30:00');
    const base = { times: ['08:00', '18:00'], lastSync: new Date(at('2026-11-01T18:05:00')).toISOString(), now };
    expect(shouldSync({ ...base, lastActive: now - 60e3 })).toBe('scheduled');
    expect(shouldSync({ ...base, lastActive: now - 3 * 3600e3 })).toBe(null);
    expect(shouldSync({ ...base, lastSync: new Date(at('2026-11-02T08:10:00')).toISOString(), lastActive: now })).toBe(null);
  });
  it('retries a failed scheduled sync after 30 minutes, not every minute', () => {
    const now = at('2026-11-02T08:20:00');
    const base = { times: ['08:00'], lastSync: new Date(at('2026-11-01T08:05:00')).toISOString(), lastActive: now };
    expect(shouldSync({ ...base, lastTry: at('2026-11-02T08:10:00'), now })).toBe(null);
    expect(shouldSync({ ...base, lastTry: at('2026-11-02T08:10:00'), now: at('2026-11-02T08:45:00'), lastActive: at('2026-11-02T08:44:00') })).toBe('scheduled');
  });
  it('honours a request once, even away from the keyboard', () => {
    const now = at('2026-11-02T12:00:00');
    const req = new Date(now - 60e3).toISOString();
    expect(shouldSync({ times: [], lastSync: new Date(now - 3600e3).toISOString(), request: req, now })).toBe('requested');
    expect(shouldSync({ times: [], lastSync: new Date(now - 3600e3).toISOString(), request: req, lastTry: now - 30e3, now })).toBe(null);
  });
  it('catches up the morning slot after a night asleep', () => {
    expect(lastSlot(['08:00', '18:00'], new Date('2026-11-02T07:00:00'))).toBe(at('2026-11-01T18:00:00'));
  });
  it('matches assignment pages to tasks by id, not by accident', () => {
    const index = [{ id: 'lab', keys: ['db=1550200'] }, { id: 'quiz', keys: ['qi=77'] }, { id: 'hw', keys: ['viewContent/21782274/'] }, { id: 'ml', keys: ['mylab:729259669'] }];
    expect(matchTask('https://purdue.brightspace.com/d2l/lms/dropbox/user/folder_submit_files.d2l?db=1550200&ou=1', index)).toBe('lab');
    expect(matchTask('https://purdue.brightspace.com/d2l/lms/dropbox/user/folder_submit_files.d2l?db=15502001&ou=1', index)).toBe(null);
    expect(matchTask('https://purdue.brightspace.com/d2l/lms/quizzing/user/quiz_summary.d2l?ou=1&qi=77', index)).toBe('quiz');
    expect(matchTask('https://purdue.brightspace.com/d2l/le/content/1641950/viewContent/21782274/View', index)).toBe('hw');
    expect(matchTask('https://mylab.pearson.com/Student/PlayerHomework.aspx?homeworkId=729259669&x=1', index)).toBe('ml');
    expect(matchTask('https://example.com/', index)).toBe(null);
  });
  it('turns heartbeats into sessions, splitting on long pauses and task switches', () => {
    let cur = null, saved = [];
    const feed = (task, t) => { const r = beat(cur, task, t); cur = r.cur; if (r.finished) saved.push(r.finished); };
    const m = 60e3;
    for (let t = 0; t <= 20 * m; t += m / 3) feed('a', t); // 20 min on a
    feed('b', 21 * m); // switch
    feed('b', 21.5 * m);
    feed('b', 40 * m); // came back after a long pause
    for (let t = 40 * m; t <= 50 * m; t += m / 3) feed('b', t);
    feed(null, 51 * m);
    expect(saved.map((s) => s.task)).toEqual(['a', 'b']); // the 30-second b blip was too short to count
    expect((Date.parse(saved[0].e) - Date.parse(saved[0].s)) / m).toBeCloseTo(20.33, 1);
    expect(cur).toBe(null);
    expect(close({ task: 'x', s: 0, last: 30e3 })).toBe(null);
  });
});
