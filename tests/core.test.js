import { describe, it, expect } from 'vitest';
import { stamp, mergeDocs, live } from '../shared/doc.js';
import { toLocal, fromLocal, addDays } from '../shared/time.js';
import { parseQuick } from '../shared/quickadd.js';
import { signature, family, courseKey, classify } from '../shared/model.js';
import { makePlan } from '../shared/plan.js';
import { reconcile } from '../shared/reconcile.js';
import { hasFixture, snapshotFromFixture } from './fixture.js';

const TZ = 'America/Indiana/Indianapolis';
const settings = { tz: TZ, ignore: ['excused absence'], mylab: { ou: 1638698, topicId: 21938619, course: 'MA261' } };

describe('time', () => {
  it('converts D2L UTC to Eastern wall clock', () => {
    expect(toLocal('2026-08-30T03:59:59.000Z', TZ)).toBe('2026-08-29T23:59');
    expect(toLocal('2026-11-12T04:59:00.000Z', TZ)).toBe('2026-11-11T23:59');
    expect(fromLocal('2026-11-11T23:59', TZ).toISOString()).toBe('2026-11-12T04:59:00.000Z');
  });
});

describe('doc merge', () => {
  it('keeps the newer write of each field from both sides', () => {
    const base = { tasks: { a: stamp(null, { id: 'a', title: 'x', done: false }, 1) } };
    const phone = { tasks: { a: stamp(base.tasks.a, { done: true }, 5) } };
    const mac = { tasks: { a: stamp(base.tasks.a, { title: 'y' }, 6), b: stamp(null, { id: 'b' }, 6) } };
    const m1 = mergeDocs(phone, mac), m2 = mergeDocs(mac, phone);
    expect(m1).toEqual(m2);
    expect(m1.tasks.a.done).toBe(true);
    expect(m1.tasks.a.title).toBe('y');
    expect(Object.keys(m1.tasks)).toHaveLength(2);
  });
});

describe('quick add', () => {
  const courses = [{ id: 'PHYS172', aliases: ['phys', 'physics'] }, { id: 'MA261', aliases: ['math', 'calc'] }];
  const now = new Date('2026-11-01T15:00:00Z'); // Sunday
  it('parses course, day, time, duration', () => {
    const p = parseQuick('phys hw 9 fri 5pm 2h', { courses, tz: TZ, now });
    expect(p).toMatchObject({ course: 'PHYS172', due: '2026-11-06T17:00', est: 120, title: 'Hw 9', command: false });
  });
  it('flags instructions for the assistant', () => {
    expect(parseQuick('move all ENGT labs an hour later', { courses, tz: TZ, now }).command).toBe(true);
    expect(parseQuick('what is due this week?', { courses, tz: TZ, now }).command).toBe(true);
  });
  it('handles month names and tomorrow', () => {
    expect(parseQuick('essay draft nov 12 noon', { courses, tz: TZ, now }).due).toBe('2026-11-12T12:00');
    expect(parseQuick('call advisor tomorrow', { courses, tz: TZ, now }).due).toBe('2026-11-02T23:59');
  });
});

describe('model', () => {
  it('signatures match placeholders to real items', () => {
    expect(signature('ENGT Homework 8')).toContain('hw 8');
    expect(signature('PHYS 172 - FA25 - HW08')).toContain('hw 8');
    expect(signature('LAB 09 : IPYNB FILE UPLOAD')).toContain('lab 9');
    expect(family('LAB 09 : IPYNB FILE UPLOAD')).toBe('lab # ipynb file upload');
    expect(courseKey('wl.202710.PHYS.17200.102')).toBe('PHYS172');
    expect(courseKey('wl_empoweredchoices', 'Empowered Choices')).toBe('ADMIN');
    expect(classify('AD 227 Test II')).toBe('exam');
  });
});

describe.skipIf(!hasFixture)('reconcile with captured Brightspace data', () => {
  it('builds one task per assignment, no title-collisions, stable across runs', async () => {
    const snap = await snapshotFromFixture();
    expect(snap.ok).toBe(true);
    const r1 = reconcile({}, snap, { settings, now: Date.parse('2026-11-01T20:00:00Z') });
    const tasks = live(r1.db.tasks);
    expect(tasks.length).toBeGreaterThan(100);
    // Every ref belongs to exactly one task.
    const owner = new Map();
    for (const t of tasks) for (const ref of [t.id, ...t.refs]) { expect(owner.get(ref) ?? t.id).toBe(t.id); owner.set(ref, t.id); }
    // Weekly AI surveys share a title but are separate tasks.
    const ai = tasks.filter((t) => /WEEKLY AI USE SURVEY/i.test(t.title));
    expect(ai.length).toBeGreaterThan(3);
    // A second identical sync changes nothing.
    const r2 = reconcile(r1.db, snap, { settings, now: Date.parse('2026-11-01T21:00:00Z') });
    expect(r2.report.added).toHaveLength(0);
    expect(r2.report.changed).toHaveLength(0);
    expect(r2.report.missing).toHaveLength(0);
    expect(JSON.stringify(r2.db.tasks)).toBe(JSON.stringify(r1.db.tasks));
    // LAB 01 notebook was submitted -> done by sync.
    const rec1 = tasks.find((t) => t.title === 'LAB 01 : IPYNB FILE UPLOAD');
    expect(rec1.done).toBe(true);
    // HW 20 comes from the LTI topic's due event.
    const hw20 = tasks.find((t) => /HW20/.test(t.title));
    expect(hw20).toBeTruthy();
    expect(hw20.kind).toBe('hw');
  });

  it('folds a hand-made placeholder into the real item when it appears', async () => {
    const snap = await snapshotFromFixture();
    const ph = stamp(null, { id: 't:ph', title: 'WileyPLUS HW 19', course: 'PHYS172', src: 'manual', due: '2026-11-10T23:59', created: 1 }, 1);
    const r = reconcile({ tasks: { 't:ph': ph } }, snap, { settings, now: Date.now() });
    const hw19 = live(r.db.tasks).filter((t) => /HW ?19/i.test(t.title));
    expect(hw19).toHaveLength(1);
    expect(hw19[0].id).toBe('t:ph');
    expect(hw19[0].refs.some((x) => x.includes(':topic:'))).toBe(true);
  });

  it('never deletes: a vanished item is flagged missing; a locked date is kept', async () => {
    const snap = await snapshotFromFixture();
    const r1 = reconcile({}, snap, { settings, now: 1e12 });
    const hw = live(r1.db.tasks).find((t) => /HW19/.test(t.title));
    const tasks = { ...r1.db.tasks, [hw.id]: stamp(hw, { due: '2026-11-20T23:59', lock: { due: true } }, 2e12) };
    const lab = live(r1.db.tasks).find((t) => t.id.includes(':dropbox:') && !t.done && t.course === 'PHYS172');
    const snap2 = JSON.parse(JSON.stringify(snap));
    const phys = snap2.courses.find((c) => c.ou === 1641950);
    phys.dropbox = phys.dropbox.filter((f) => `bs:1641950:dropbox:${f.id}` !== lab.id);
    phys.cal = phys.cal.filter((e) => !(e.ent && String(e.ent.id) === lab.id.split(':')[3]));
    const r2 = reconcile({ ...r1.db, tasks }, snap2, { settings, now: 3e12 });
    expect(r2.db.tasks[hw.id].due).toBe('2026-11-20T23:59');
    expect(r2.db.tasks[lab.id].missing).toBeTruthy();
    expect(r2.db.tasks[lab.id].deleted).toBeFalsy();
  });

  it('plans big work ahead of its deadline', async () => {
    const snap = await snapshotFromFixture();
    const r = reconcile({}, snap, { settings, now: Date.now() });
    const p = makePlan({ tasks: r.db.tasks, sessions: {}, settings: { ...settings, capacity: { weekday: 240, weekend: 300 } }, now: new Date('2026-11-02T14:00:00Z') });
    expect(p.days[0].items.length).toBeGreaterThan(0);
  });
});

describe.skipIf(!hasFixture)('respecting your edits', () => {
  it('does not bring back a task you deleted', async () => {
    const snap = await snapshotFromFixture();
    const r1 = reconcile({}, snap, { settings, now: 1e12 });
    const t = live(r1.db.tasks).find((x) => /HW19/.test(x.title));
    const tasks = { ...r1.db.tasks, [t.id]: stamp(t, { deleted: true }, 2e12) };
    const r2 = reconcile({ ...r1.db, tasks }, snap, { settings, now: 3e12 });
    expect(live(r2.db.tasks).filter((x) => /HW19/.test(x.title))).toHaveLength(0);
    expect(r2.report.added).toHaveLength(0);
  });
});
