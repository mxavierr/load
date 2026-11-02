// Replays the captured Brightspace responses (fixtures/bs1.json, not committed) as fetch.
import fs from 'node:fs';
import { collectBrightspace } from '../shared/collect.js';

export const FIX = new URL('../fixtures/bs1.json', import.meta.url);
export const hasFixture = fs.existsSync(FIX);

export function fakeFetch(raw) {
  const map = { toc: 'content/toc', dropbox: 'dropbox/folders/', quizzes: 'quizzes/', surveys: 'surveys/', news: 'news/', cal: 'calendar/events/', grades: 'grades/values/myGradeValues/', myItems: 'content/myItems/' };
  return async (path) => {
    const res = (status, body) => ({ ok: status === 200, status, redirected: false, url: path, headers: { get: () => 'application/json' }, json: async () => body, text: async () => JSON.stringify(body) });
    if (path.includes('enrollments/myenrollments')) return res(200, raw.base.enroll.b);
    if (path.includes('bookmark=')) return res(200, { Objects: [], Next: null });
    if (path.includes('/submissions/mysubmissions/')) return res(403, null);
    const m = /\/le\/[\d.]+\/(\d+)\/(.*)$/.exec(path);
    if (!m) return res(404, null);
    const c = raw.courses[m[1]];
    const k = Object.keys(map).find((k) => m[2] === map[k]);
    if (!c || !k || !c[k] || c[k].s !== 200) return res(404, null);
    if (k === 'myItems') return res(200, { Objects: [...c.myItems.b.Objects, ...((c.myItemsDue && c.myItemsDue.b && c.myItemsDue.b.Objects) || [])], Next: c.myItems.b.Next });
    return res(200, c[k].b);
  };
}

export async function snapshotFromFixture(cfg = { term: '202710', extraOus: [1134648] }) {
  const raw = JSON.parse(fs.readFileSync(FIX, 'utf8'));
  const prev = globalThis.fetch;
  globalThis.fetch = fakeFetch(raw);
  try { return await collectBrightspace(cfg); } finally { globalThis.fetch = prev; }
}
