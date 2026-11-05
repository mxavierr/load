// The grade estimator: each course's syllabus rules plus the gradebook rows from sync.
// Pure functions only, so the same numbers show up on the Mac, the phone and in tests.
//
// A category is one of three shapes:
//   pool     many small items with a "best K of N" rule; every item is in the gradebook
//   overall  only the gradebook's own category score can be trusted (MyLab's overall
//            score, or an instructor's hidden drops), so it is used as is
//   slots    a few named items such as exams, each graded or still to come
// plus `bonus`, extra-credit points added on top.

const PLUS_MINUS = (cp, c, cm, dp, d, dm) => [
  ['A+', 97], ['A', 93], ['A-', 90], ['B+', 87], ['B', 83], ['B-', 80],
  ['C+', cp], ['C', c], ['C-', cm], ['D+', dp], ['D', d], ...(dm ? [['D-', dm]] : []),
].map(([l, min]) => ({ l, min }));
const STRAIGHT = [['A', 90], ['B', 80], ['C', 70], ['D', 60]].map(([l, min]) => ({ l, min }));

export const GRADING = {
  PHYS172: {
    source: 'Course syllabus, Aug 31',
    scale: PLUS_MINUS(75, 70, 65, 60, 55, 50),
    note: 'The syllabus says cutoffs will be no higher than these. Extra credit isn\'t in its 2000-point table, so it\'s added here on top of that total.',
    cats: [
      { id: 'lec', name: 'Lecture iClickers', weight: 2, pool: { match: /^LEC(0[4-9]|[12]\d)\b/, n: 24, keep: 20 } },
      { id: 'hw', name: 'Homework', weight: 8, pool: { match: /\bHW\s?\d+/, n: 25, keep: 20 } },
      { id: 'rec', name: 'Recitations', weight: 18, pool: { match: /^REC \d+/, n: 14, keep: 12 } },
      { id: 'lab', name: 'Labs', weight: 21, pool: { match: /^LAB \d+/, n: 14, keep: 12 } },
      { id: 'cpde', name: 'Design essay (CPDE)', weight: 3, slots: [{ id: 'cpde', name: 'CPDE final report', match: /CPDE/i }] },
      {
        id: 'exams', name: 'Exams', weight: 48, rule: 'phys-exams',
        ruleNote: 'Counts the higher of: best two midterms + full final, or all three midterms + half the final.',
        slots: [
          { id: 'm1', name: 'Midterm 1', match: /^Exam 1\b/ },
          { id: 'm2', name: 'Midterm 2', match: /^Exam 2\b/ },
          { id: 'm3', name: 'Midterm 3', match: /^Exam 3\b/ },
          { id: 'final', name: 'Final exam', match: /^Final/i, w: 2 },
        ],
      },
      { id: 'ec', name: 'Extra credit', bonus: { category: /^EXTRA CREDIT/, base: 2000 } },
    ],
  },
  MA261: {
    source: 'MA 261 Ground Rules, Fall 2026 (matches Brightspace)',
    scale: PLUS_MINUS(77, 73, 70, 67, 60),
    note: 'These cutoffs are the guaranteed minimum. Actual letter grades are curved from exam totals, so yours can come out higher. Quiz count is an estimate.',
    cats: [
      { id: 'hw', name: 'Homework', weight: 15, overall: { category: /^Homework/, tasks: { src: 'mylab' }, n: 42, dropNote: 'lowest 3 dropped at the end of term' } },
      { id: 'quiz', name: 'Quizzes', weight: 15, pool: { match: /^Quiz \d+/, n: 12, keep: 10 } },
      { id: 'm1', name: 'Midterm 1', weight: 20, slots: [{ id: 'm1', name: 'Midterm 1', match: /^Midterm 1$/ }] },
      { id: 'm2', name: 'Midterm 2', weight: 20, slots: [{ id: 'm2', name: 'Midterm 2', match: /^Midterm 2$/ }] },
      { id: 'final', name: 'Final exam', weight: 30, slots: [{ id: 'final', name: 'Final exam', match: /^Final/i }] },
    ],
  },
  ENGT182: {
    source: 'Brightspace gradebook setup, checked Nov 5',
    scale: STRAIGHT,
    note: 'Letter cutoffs are inferred from the letters Brightspace shows, and the two midterms are assumed equal. Scores use Brightspace\'s own category totals, which already include its drops (lowest 2 quizzes, lowest homework).',
    cats: [
      { id: 'lab', name: 'Labs', weight: 20, overall: { category: /^Labs$/, items: /Lab\b(?!.*(Rules|Assessment))/i, n: 13 } },
      { id: 'quiz', name: 'Quizzes', weight: 10, overall: { category: /^Quiz$/, items: /Quiz|Attn Qz|Assessment|Attendance/i, n: 15 } },
      { id: 'hw', name: 'Homework', weight: 20, overall: { category: /^Homework\s*$/, items: /Homework/i, tasks: { course: 'ENGT182', match: /homework|\bhw\b/i }, n: 12 } },
      {
        id: 'exams', name: 'Exams', weight: 30,
        slots: [{ id: 'e1', name: 'Exam 1', match: /Exam 1\b(?!.*Practice)/ }, { id: 'e2', name: 'Exam 2', match: /Exam 2\b(?!.*Practice)/ }],
      },
      { id: 'final', name: 'Final exam', weight: 20, slots: [{ id: 'final', name: 'Final exam', match: /^(Fall 2026 )?(ENGT 18\d+ )?Final/i }] },
    ],
  },
  AD227: {
    source: 'Brightspace gradebook setup, checked Nov 5',
    scale: STRAIGHT,
    note: 'Three 100-point tests, 300 in total. Extra credit is the 10-point assignment and 5-point quiz, assumed to add to the 300. Letter cutoffs are assumed; check them against the syllabus.',
    cats: [
      {
        id: 'tests', name: 'Tests', weight: 100,
        slots: [{ id: 't1', name: 'Test I', match: /^Test I$/ }, { id: 't2', name: 'Test II', match: /^Test II$/ }, { id: 't3', name: 'Test III', match: /^Test III$/ }],
      },
      { id: 'ec', name: 'Extra credit', bonus: { items: /extra credit/i, base: 300 } },
    ],
  },
};

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const pctOf = (r) => (r && r.den > 0 && r.num != null ? (100 * r.num) / r.den : null);
const isScore = (r) => r.type !== 'Text' && r.type !== 'Category' && r.den > 0 && r.num != null;
const numberOr = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);

export function letterFor(cfg, pct) {
  if (pct == null) return null;
  return cfg.scale.find((s) => pct >= s.min)?.l || 'F';
}

/** Gradebook items graded in the last `days`, newest first. */
export function recentlyGraded(rows, now = Date.now(), days = 7) {
  return (rows || [])
    // MyLab's overall score moves with every lesson; it isn't a grade being handed back.
    .filter((r) => isScore(r) && r.mod && !/overall score/i.test(r.name) && now - Date.parse(r.mod) <= days * 864e5)
    .sort((a, b) => (a.mod < b.mod ? 1 : -1));
}

/** Read the gradebook into categories, with any what-if scores applied. */
function readCats(cfg, rows, wi, ctx) {
  const scores = rows.filter(isScore);
  const items = wi.items || {};
  const applied = (key, actual) => {
    const v = numberOr(items[key], null);
    return v == null ? { pct: actual, actual, wi: false } : { pct: v, actual, wi: true };
  };
  return cfg.cats.map((c) => {
    const base = { id: c.id, name: c.name, weight: c.weight || 0, cat: c };
    if (c.bonus) {
      const row = c.bonus.category ? rows.find((r) => r.type === 'Category' && c.bonus.category.test(r.name)) : null;
      const listed = c.bonus.items ? scores.filter((r) => c.bonus.items.test(r.name)).reduce((a, r) => a + r.num, 0) : 0;
      const actual = (row?.num || 0) + listed;
      const pts = numberOr(wi.bonus?.[c.id], actual);
      return { ...base, kind: 'bonus', actual, pts, wi: numberOr(wi.bonus?.[c.id], null) != null, base: c.bonus.base };
    }
    if (c.pool) {
      const list = scores.filter((r) => c.pool.match.test(r.name)).map((r) => ({ key: r.name, name: r.name, shown: r.shown, ...applied(r.name, pctOf(r)) }));
      return { ...base, kind: 'pool', list, soFar: mean(list.map((x) => x.pct)), done: list.length, n: Math.max(c.pool.n, list.length), keep: c.pool.keep };
    }
    if (c.overall) {
      const row = rows.find((r) => r.type === 'Category' && c.overall.category.test(r.name));
      const list = c.overall.items ? scores.filter((r) => c.overall.items.test(r.name)) : [];
      const f = c.overall.tasks;
      const past = f ? (ctx.tasks || []).filter((t) => !t.deleted && t.due && t.due < (ctx.now || '9') && (!f.src || t.src === f.src) && (!f.course || t.course === f.course) && (!f.match || f.match.test(t.title))).length : 0;
      const done = Math.max(past, list.length);
      const n = Math.max(c.overall.n, done);
      const a = applied(c.id, pctOf(row));
      return { ...base, kind: 'overall', list: list.map((r) => ({ key: r.name, name: r.name, shown: r.shown, actual: pctOf(r) })), soFar: a.pct, actual: a.actual, wi: a.wi, done, n };
    }
    const slots = c.slots.map((s) => {
      const r = scores.find((x) => s.match.test(x.name));
      return { key: s.id, name: s.name, w: s.w || 1, shown: r?.shown, ...applied(s.id, pctOf(r)) };
    });
    const known = slots.filter((s) => s.pct != null);
    const totalW = known.reduce((a, s) => a + s.w, 0);
    return { ...base, kind: 'slots', list: slots, soFar: totalW ? known.reduce((a, s) => a + s.pct * s.w, 0) / totalW : null, done: known.length, n: slots.length };
  });
}

/** A category's final score (0-100) if everything still to come scores `rest`. */
function finishCat(c, rest) {
  if (c.kind === 'pool') {
    const vals = [...c.list.map((x) => x.pct), ...Array(Math.max(0, c.n - c.list.length)).fill(rest)].sort((a, b) => b - a).slice(0, c.keep);
    return mean(vals);
  }
  if (c.kind === 'overall') {
    if (c.soFar == null) return rest;
    const f = Math.min(1, c.done / c.n);
    return f * c.soFar + (1 - f) * rest;
  }
  const v = c.list.map((s) => (s.pct != null ? s.pct : rest));
  if (c.cat.rule === 'phys-exams') {
    const mids = v.slice(0, 3).sort((a, b) => b - a), f = v[3];
    return Math.max((mids[0] + mids[1] + 2 * f) / 4, (mids[0] + mids[1] + mids[2] + f) / 4);
  }
  const w = c.list.map((s) => s.w);
  return v.reduce((a, x, i) => a + x * w[i], 0) / w.reduce((a, b) => a + b, 0);
}

/** How much of the category's weight is already decided, 0-1. */
function decidedShare(c) {
  if (c.kind === 'pool') return Math.min(1, c.list.length / c.keep);
  if (c.kind === 'overall') return c.soFar == null ? 0 : Math.min(1, c.done / c.n);
  const total = c.list.reduce((a, s) => a + s.w, 0);
  return c.list.filter((s) => s.pct != null).reduce((a, s) => a + s.w, 0) / total;
}

/**
 * Estimate a course.
 *   wi     what-ifs: { items: {name or slot id: percent}, rest: {category id: percent}, bonus: {category id: points} }
 *   ctx    { tasks, now }: counts work already past due where the gradebook lists no items
 * Returns the grade so far, a projection, the lowest and highest still possible, and
 * what you'd need on everything left to reach each letter. By default, work still to
 * come is assumed to match your average in that category, which is how the PHYS 172
 * syllabus estimates a standing. A category with no grades yet uses your overall average.
 */
export function estimateCourse(cfg, rows = [], wi = {}, ctx = {}) {
  const cats = readCats(cfg, rows, wi, ctx);
  const scored = cats.filter((c) => c.kind !== 'bonus');
  const graded = scored.filter((c) => c.soFar != null);
  const gradedW = graded.reduce((a, c) => a + c.weight, 0);
  const bonus = cats.filter((c) => c.kind === 'bonus').reduce((a, c) => a + (100 * c.pts) / c.base, 0);
  const soFarBase = gradedW ? graded.reduce((a, c) => a + c.weight * c.soFar, 0) / gradedW : null;
  const soFar = soFarBase == null ? null : soFarBase + bonus;

  // Assumptions come from your real grades, so trying a score on one exam doesn't quietly
  // change what's assumed for the others.
  const realCats = readCats(cfg, rows, {}, ctx).filter((c) => c.kind !== 'bonus');
  const realGraded = realCats.filter((c) => c.soFar != null);
  const realW = realGraded.reduce((a, c) => a + c.weight, 0);
  const realBase = realW ? realGraded.reduce((a, c) => a + c.weight * c.soFar, 0) / realW : null;
  const restFor = (c, forced) => {
    const chosen = numberOr(wi.rest?.[c.id], null);
    if (chosen != null) return chosen;
    if (forced != null) return forced;
    return realCats.find((x) => x.id === c.id)?.soFar ?? realBase ?? soFarBase ?? 0;
  };
  const total = (forced) => scored.reduce((a, c) => a + (c.weight * finishCat(c, restFor(c, forced))) / 100, 0) + bonus;

  const projected = gradedW ? total() : null;
  const lowest = total(0);
  const highest = total(100);
  const decided = scored.reduce((a, c) => a + c.weight * decidedShare(c), 0);

  // What flat score on everything left reaches each letter.
  const needs = [];
  for (const s of cfg.scale) {
    if (highest < s.min || lowest >= s.min) continue;
    let lo = 0, hi = 100;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (total(mid) >= s.min) hi = mid; else lo = mid;
    }
    needs.push({ l: s.l, min: s.min, need: hi });
  }

  return {
    soFar, projected, lowest, highest, decided,
    letter: letterFor(cfg, projected),
    needs,
    cats: cats.map((c) => (c.kind === 'bonus' ? c : {
      ...c,
      rest: restFor(c),
      restChosen: numberOr(wi.rest?.[c.id], null),
      final: finishCat(c, restFor(c)),
      points: (c.weight * finishCat(c, restFor(c))) / 100,
    })),
  };
}

export function hasWhatIf(wi) {
  return !!wi && ['items', 'rest', 'bonus'].some((k) => wi[k] && Object.keys(wi[k]).length);
}

/** A copy of the what-ifs with one value set, or removed when value is null. */
export function setWhatIfValue(wi = {}, group, key, value) {
  const next = { ...(wi[group] || {}) };
  if (value == null) delete next[key]; else next[key] = value;
  return { ...wi, [group]: next };
}
