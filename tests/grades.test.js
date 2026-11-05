import { describe, it, expect } from 'vitest';
import { GRADING, estimateCourse, recentlyGraded, letterFor, hasWhatIf, setWhatIfValue } from '../shared/grades.js';
import { buildLibrary, trackedIds } from '../shared/reconcile.js';

const item = (name, num, den, extra = {}) => ({ name, type: 'Numeric', num, den, shown: `${num} / ${den}`, ...extra });
const cat = (name, num, den) => ({ name, type: 'Category', num, den, shown: `${num} / ${den}` });

describe('MA 261 weights from the Ground Rules', () => {
  const rows = [
    cat('Homework', 85.5, 100), cat('Midterms', 78, 100),
    ...[1, 2, 3, 4, 5, 6, 7].map((i) => item(`Quiz ${i}`, 10, 10)),
    item('Midterm 1', 78, 100),
    { name: 'Midterm 1 Advisory Grade', type: 'Text', shown: 'A+/A' },
  ];
  const ctx = { tasks: Array.from({ length: 42 }, (_, i) => ({ src: 'mylab', due: i < 32 ? '2026-10-01T23:59' : '2026-12-01T23:59' })), now: '2026-11-05T16:00' };

  it('adds up to 100%', () => {
    expect(GRADING.MA261.cats.reduce((a, c) => a + (c.weight || 0), 0)).toBe(100);
  });
  it('computes the grade so far from graded categories only', () => {
    const e = estimateCourse(GRADING.MA261, rows, {}, ctx);
    // (15*85.5 + 15*100 + 20*78) / 50
    expect(e.soFar).toBeCloseTo((15 * 85.5 + 15 * 100 + 20 * 78) / 50, 5);
  });
  it('a what-if on a future exam moves the projection and leaves the real score alone', () => {
    const real = estimateCourse(GRADING.MA261, rows, {}, ctx);
    const wi = estimateCourse(GRADING.MA261, rows, { items: { final: 70 } }, ctx);
    expect(wi.projected).toBeLessThan(real.projected);
    expect(wi.soFar).toBeCloseTo(real.soFar + (30 * 70) / 80 - (real.soFar * 30) / 80, 5);
    expect(rows.find((r) => r.name === 'Midterm 1').num).toBe(78);
    // Final is 30%, and the assumed average falls away: difference is exact.
    const finalCat = (e) => e.cats.find((c) => c.id === 'final');
    expect(finalCat(wi).final).toBe(70);
    expect(wi.projected).toBeCloseTo(real.projected - finalCat(real).points + 21, 5);
  });
  it('a what-if can replace a score that is already in', () => {
    const e = estimateCourse(GRADING.MA261, rows, { items: { m1: 100 } }, ctx);
    const m1 = e.cats.find((c) => c.id === 'm1');
    expect(m1.final).toBe(100);
    expect(m1.list[0].actual).toBe(78);
  });
  it('reports what you need on everything left', () => {
    const e = estimateCourse(GRADING.MA261, rows, {}, ctx);
    const a = e.needs.find((n) => n.l === 'A');
    expect(a).toBeTruthy();
    // Check it by putting that score back in: it lands on the cutoff.
    const check = estimateCourse(GRADING.MA261, rows, { rest: { quiz: a.need, hw: a.need, m2: a.need, final: a.need } }, ctx);
    expect(check.projected).toBeCloseTo(93, 2);
  });
  it('the range brackets the projection', () => {
    const e = estimateCourse(GRADING.MA261, rows, {}, ctx);
    expect(e.lowest).toBeLessThan(e.projected);
    expect(e.highest).toBeGreaterThan(e.projected);
  });
});

describe('PHYS 172 rules from the syllabus', () => {
  const allHw = (n, score = 8) => Array.from({ length: n }, (_, i) => item(`PHYS 172 - FA25 - HW${String(i + 1).padStart(2, '0')}`, score, 8));
  const exams = (m1, m2, m3, f) => [
    ...(m1 != null ? [item('Exam 1 FINAL', m1, 240)] : []), ...(m2 != null ? [item('Exam 2 FINAL', m2, 240)] : []),
    ...(m3 != null ? [item('Exam 3 FINAL', m3, 240)] : []), ...(f != null ? [item('Final Exam', f, 480)] : []),
  ];
  const examCat = (rows) => estimateCourse(GRADING.PHYS172, rows).cats.find((c) => c.id === 'exams');

  it('weights add up to 100% and match its point table', () => {
    const w = Object.fromEntries(GRADING.PHYS172.cats.map((c) => [c.id, c.weight]));
    expect(w).toMatchObject({ lec: 2, hw: 8, rec: 18, lab: 21, cpde: 3, exams: 48 });
    expect(GRADING.PHYS172.cats.reduce((a, c) => a + (c.weight || 0), 0)).toBe(100);
  });
  it('drops the lowest five homeworks', () => {
    const rows = [...allHw(20), ...Array.from({ length: 5 }, (_, i) => item(`PHYS 172 - FA25 - HW${21 + i}`, 0, 8))];
    expect(estimateCourse(GRADING.PHYS172, rows).cats.find((c) => c.id === 'hw').final).toBe(100);
  });
  it('a sixth missed homework starts to cost you', () => {
    const rows = [...allHw(19), ...Array.from({ length: 6 }, (_, i) => item(`PHYS 172 - FA25 - HW${20 + i}`, 0, 8))];
    expect(estimateCourse(GRADING.PHYS172, rows).cats.find((c) => c.id === 'hw').final).toBe(95);
  });
  it('uses best two midterms + full final when that is higher', () => {
    // Bad third midterm: 240+240+0 and a perfect final -> (240+240+480)/960 = 100%.
    expect(examCat(exams(240, 240, 0, 480)).final).toBe(100);
  });
  it('uses all three midterms + half the final when that is higher', () => {
    // Bad final: (240*3 + 0)/960 = 75%, versus (240+240+0)/960 = 50%.
    expect(examCat(exams(240, 240, 240, 0)).final).toBe(75);
  });
  it('matches the worked example in the syllabus', () => {
    // 85% on non-exam work and 70% on exams -> 1556/2000 = 77.8%, a C+.
    const pct = (n) => n;
    const est = estimateCourse(GRADING.PHYS172, [...exams(168, 168, 168, 336)], {
      items: { cpde: pct(85) }, rest: { lec: 85, hw: 85, rec: 85, lab: 85 },
    });
    expect(est.projected).toBeCloseTo(77.8, 5);
    expect(letterFor(GRADING.PHYS172, est.projected)).toBe('C+');
  });
  it('counts extra credit on top, from the gradebook or a what-if', () => {
    const rows = [{ name: 'EXTRA CREDIT', type: 'Category', num: 15, den: 0, shown: '0 %' }, ...exams(240)];
    const base = estimateCourse(GRADING.PHYS172, exams(240));
    expect(estimateCourse(GRADING.PHYS172, rows).projected).toBeCloseTo(base.projected + 0.75, 5);
    expect(estimateCourse(GRADING.PHYS172, rows, { bonus: { ec: 25 } }).projected).toBeCloseTo(base.projected + 1.25, 5);
  });
  it('ignores LEC 03, which the syllabus says does not count', () => {
    const e = estimateCourse(GRADING.PHYS172, [item('LEC03', 0, 2), item('LEC04', 2, 2)]);
    expect(e.cats.find((c) => c.id === 'lec').done).toBe(1);
  });
  it('does not read "Exam 2 Location" as a score', () => {
    const e = estimateCourse(GRADING.PHYS172, [{ name: 'Exam 2 Location', type: 'Text', shown: 'PTS' }]);
    expect(e.cats.find((c) => c.id === 'exams').list[1].pct).toBeNull();
    expect(e.projected).toBeNull();
  });
});

describe('other courses', () => {
  it('AD 227: three equal tests', () => {
    const e = estimateCourse(GRADING.AD227, [item('Test I', 100, 100), item('Test II', 70, 100)], { items: { t3: 85 } });
    expect(e.projected).toBeCloseTo((100 + 70 + 85) / 3, 5);
    expect(e.decided).toBeCloseTo(100, 5);
  });
  it('ENGT 182: uses the gradebook category, which already applied hidden drops', () => {
    const rows = [cat('Homework ', 66, 100), item('Homework 3 Career Pathways', 100, 100), item('Homework 5 Energy', 55, 100)];
    const hw = estimateCourse(GRADING.ENGT182, rows).cats.find((c) => c.id === 'hw');
    expect(hw.soFar).toBe(66);
    expect(hw.done).toBe(2);
  });
  it('ENGT 182: every category weight adds up', () => {
    expect(GRADING.ENGT182.cats.reduce((a, c) => a + c.weight, 0)).toBe(100);
    expect(estimateCourse(GRADING.ENGT182, [item('ENGT 182 Exam 1 Fall 2026', 100, 100), item('Exam 1 Practice Fall 2026', 0, 10)]).cats.find((c) => c.id === 'exams').list[0].actual).toBe(100);
  });
  it('a course with nothing graded projects nothing rather than a fake number', () => {
    const e = estimateCourse(GRADING.MA261, []);
    expect(e.soFar).toBeNull();
    expect(e.projected).toBeNull();
    expect(e.letter).toBeNull();
  });
});

describe('Brightspace setup, checked Nov 5', () => {
  it('ENGT homework counts assignments past due when the gradebook hides some', () => {
    const c = { tasks: Array.from({ length: 9 }, (_, i) => ({ course: 'ENGT182', title: `Homework ${i}`, due: '2026-10-01T17:00' })), now: '2026-11-05T16:00' };
    const hw = estimateCourse(GRADING.ENGT182, [cat('Homework ', 66, 100), item('Homework 1', 50, 100)], {}, c).cats.find((x) => x.id === 'hw');
    expect(hw.done).toBe(9);
    expect(hw.n).toBe(12);
  });
  it('MA 261 finds the Final item by its gradebook name', () => {
    expect(estimateCourse(GRADING.MA261, [item('Final', 180, 200)]).cats.find((c) => c.id === 'final').final).toBe(90);
  });
  it('ENGT 182 finds Exam 2 by its gradebook name and skips its practice problem', () => {
    const e = estimateCourse(GRADING.ENGT182, [item('Fall 2026 ENGT 18200 Exam 2 Practice Problem', 0, 10), item('Fall 2026 ENGT 18200 Exam 2 ', 88, 100)]);
    expect(e.cats.find((c) => c.id === 'exams').list[1].actual).toBe(88);
  });
  it('AD 227 extra credit sits on top of 300 points', () => {
    const e = estimateCourse(GRADING.AD227, [item('Test I', 100, 100), item('Test II', 100, 100), item('Optional Extra Credit Assignment', 10, 10)]);
    expect(e.cats.find((c) => c.id === 'ec').pts).toBe(10);
    expect(e.projected).toBeCloseTo(100 + (100 * 10) / 300, 5);
  });
});

describe('just graded', () => {
  const now = Date.parse('2026-11-05T20:00:00Z');
  it('lists recent scores newest first and skips categories and text', () => {
    const rows = [
      item('Old', 1, 1, { mod: '2026-10-01T00:00:00Z' }),
      item('Older new', 1, 1, { mod: '2026-11-03T00:00:00Z' }),
      item('Newest', 1, 1, { mod: '2026-11-05T00:00:00Z' }),
      item('MyLab Overall Score', 98, 100, { mod: '2026-11-05T00:00:00Z' }),
      { ...cat('Labs', 1, 1), mod: '2026-11-05T00:00:00Z' },
      { name: 'Code', type: 'Text', shown: 'abc', mod: '2026-11-05T00:00:00Z' },
    ];
    expect(recentlyGraded(rows, now).map((r) => r.name)).toEqual(['Newest', 'Older new']);
  });
  it('sync keeps the grade date in the library', () => {
    const lib = buildLibrary(null, { courses: [{ ou: 1, name: 'X', grades: [{ id: '9', name: 'HW1', type: 'Numeric', num: 8, den: 8, shown: '100 %', mod: '2026-11-05T00:00:00Z' }] }] }, new Map([['1', 'PHYS172']]), { tz: 'America/Indiana/Indianapolis' });
    expect(lib.courses[1].grades[0].mod).toBe('2026-11-05T00:00:00Z');
  });
});

describe('what-if values', () => {
  it('set, then cleared, leaves nothing behind', () => {
    const a = setWhatIfValue({}, 'items', 'final', 80);
    expect(hasWhatIf(a)).toBe(true);
    expect(hasWhatIf(setWhatIfValue(a, 'items', 'final', null))).toBe(false);
  });
  it('a score of zero is a real what-if', () => {
    const a = setWhatIfValue({}, 'items', 'final', 0);
    expect(hasWhatIf(a)).toBe(true);
    expect(estimateCourse(GRADING.MA261, [item('Midterm 1', 90, 100)], a).cats.find((c) => c.id === 'final').final).toBe(0);
  });
});
