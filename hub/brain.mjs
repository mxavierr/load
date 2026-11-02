// The two jobs that get a model call: turning a typed request into changes, and the
// periodic review. Both return proposals; nothing is applied until you tap Apply.

import { runClaude } from './claude.mjs';
import { compactTasks } from '../shared/ops.js';
import { live, plain } from '../shared/doc.js';
import { today as todayFn, addDays, nowLocal, DOW, weekday } from '../shared/time.js';
import { runChecks } from '../shared/checks.js';

const OP_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      op: { type: 'string', enum: ['add', 'update', 'delete', 'merge'] },
      id: { type: 'string' },
      ids: { type: 'array', items: { type: 'string' } },
      task: { type: 'object', properties: { title: { type: 'string' }, course: { type: 'string' }, due: { type: 'string' }, est: { type: 'number' }, kind: { type: 'string' }, notes: { type: 'string' }, doDate: { type: 'string' }, pri: { type: 'number' } } },
      set: { type: 'object', properties: { title: { type: 'string' }, course: { type: 'string' }, due: { type: 'string' }, est: { type: 'number' }, kind: { type: 'string' }, notes: { type: 'string' }, doDate: { type: 'string' }, pri: { type: 'number' }, done: { type: 'boolean' }, snooze: { type: 'string' } } },
    },
    required: ['op'],
  },
};

const SHARED_RULES = `Dates are wall-clock "YYYY-MM-DDTHH:mm" in the student's time zone (US Eastern); day-only fields are "YYYY-MM-DD".
Courses are referred to by their id (e.g. PHYS172). Kinds: exam quiz lab rec hw project prep survey event task.
"due" is the real deadline. "doDate" is the day the student plans to work on it. "est" is minutes.
Use task ids exactly as given. Never invent ids for update/delete/merge.
Changing a synced task's due date pins it; only do that when the student clearly asks.
Tasks marked "gone from Brightspace" were removed by the course; don't count them as due.
Nothing changes until the student taps Apply, so describe proposed changes ("This plans…", "Moves…"), never "I've done…".
Keep "reply" short and plain: one or two sentences for a change, at most four for an answer. No preamble, no emoji, no mention of being an AI.`;

function context(db, settings) {
  const tz = settings.tz;
  const t = todayFn(tz);
  const courses = live(db.courses).filter((c) => c.include !== false).map((c) => `${c.id}: ${c.name} (aliases: ${(c.aliases || []).join(', ')})`);
  const tasks = compactTasks(db.tasks, { from: `${addDays(t, -14)}T00:00`, to: `${addDays(t, 60)}T23:59` });
  return `Now: ${nowLocal(tz)} (${DOW[weekday(t)]})
Courses:
${courses.join('\n')}

Tasks (id | course | due | kind | est | state | doDate | title):
${tasks.join('\n')}`;
}

export async function assist({ text, db, settings }) {
  const system = `You maintain a student's task list. Turn the request into precise changes.\n${SHARED_RULES}\nIf the request is a question, answer it in "reply" and return no ops.`;
  const prompt = `${context(db, settings)}\n\nRequest: ${text}`;
  const schema = { type: 'object', properties: { reply: { type: 'string' }, ops: OP_SCHEMA }, required: ['reply', 'ops'] };
  const out = await runClaude({ system, prompt, schema });
  return { reply: String(out.reply || ''), ops: Array.isArray(out.ops) ? out.ops : [] };
}

/**
 * The reviewer. Plain-code checks run first; the model only sees their findings plus a
 * compact picture of the next three weeks, and it is asked for judgement, not chores.
 */
export async function review({ db, log, library, settings, focus, useModel = true }) {
  const findings = runChecks({ db, log, library, settings });
  const base = { at: new Date().toISOString(), focus: focus || null, findings, summary: '', items: [] };
  if (!useModel) return base;
  const syncs = live(log?.syncs).sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 3).map(plain);
  const system = `You review a student's synced task list for problems: duplicates, wrong or stale dates, things that slipped, overload, sync failures, announcements that change deadlines. Be concrete and brief. Propose ops only when you are confident; otherwise describe what to check.\n${SHARED_RULES}`;
  const prompt = `${context(db, settings)}

Automatic findings (from code):
${JSON.stringify(findings.map(({ id, level, text, taskIds, news, detail }) => ({ id, level, text, taskIds, news, detail })), null, 1)}

Recent syncs:
${JSON.stringify(syncs.map((s) => ({ at: s.at, ok: s.ok, counts: s.counts, added: s.added?.length, changed: s.changed, missing: s.missing, merged: s.merged, errors: s.errors })), null, 1)}

${focus ? `The student asked you to look at: ${focus}` : 'Routine check.'}

Return a one-sentence summary ("All clear" if nothing matters) and at most 6 items. Each item: level ("ok" | "info" | "warn" | "action"), short text, related taskIds, and ops if a fix is clear.`;
  const schema = {
    type: 'object',
    properties: {
      summary: { type: 'string' },
      items: { type: 'array', items: { type: 'object', properties: { level: { type: 'string' }, text: { type: 'string' }, taskIds: { type: 'array', items: { type: 'string' } }, ops: OP_SCHEMA }, required: ['level', 'text'] } },
    },
    required: ['summary', 'items'],
  };
  const out = await runClaude({ system, prompt, schema });
  return { ...base, summary: String(out.summary || ''), items: (out.items || []).slice(0, 8) };
}
