// App state: the three data files, kept in signals, saved with a short debounce and
// merged with whatever another device saved meanwhile.

import { signal, computed } from '@preact/signals';
import { RemoteFile, FILES } from '../../shared/store.js';
import { mergeDocs, docEquals, stamp, live, uid } from '../../shared/doc.js';
import { DEFAULT_SETTINGS } from '../../shared/model.js';
import { makePlan } from '../../shared/plan.js';
import { editTask, newTask, applyOps } from '../../shared/ops.js';
import { runChecks } from '../../shared/checks.js';

export const db = signal(null);
export const log = signal(null);
export const library = signal(null);
export const conn = signal({ mode: null, ready: false, error: null, saving: false, pulledAt: 0, claude: null });
export const ui = signal({ peek: null, settings: false, toast: null, filter: {}, answer: null });
export const nowTick = signal(Date.now());
setInterval(() => (nowTick.value = Date.now()), 30e3);

const SIGNALS = { db, log, library };
const LS = 'load:v1:';
let files = null;
let hubMode = false;

export const settings = computed(() => ({ ...DEFAULT_SETTINGS, ...(db.value?.settings?.main || {}) }));
export const tasks = computed(() => db.value?.tasks || {});
export const courses = computed(() => Object.fromEntries(live(db.value?.courses).map((c) => [c.id, c])));
export const plan = computed(() => {
  nowTick.value;
  if (!db.value) return null;
  return makePlan({ tasks: tasks.value, sessions: log.value?.sessions, settings: settings.value, now: new Date() });
});
export const findings = computed(() => (db.value ? runChecks({ db: db.value, log: log.value, library: library.value, settings: settings.value }) : []));
export const timer = computed(() => (db.value?.timer?.main?.task ? db.value.timer.main : null));

// ---------- connection ----------

const isLocal = ['127.0.0.1', 'localhost'].includes(location.hostname);

export function githubCreds() {
  try {
    return JSON.parse(localStorage.getItem(`${LS}gh`) || 'null');
  } catch {
    return null;
  }
}
export function setGithubCreds(c) {
  try {
    localStorage.setItem(`${LS}gh`, JSON.stringify(c));
  } catch { /* private mode */ }
}

export async function connect() {
  let repo, base, fetchFn, token;
  if (isLocal) {
    try {
      const r = await fetch('./api/ping', { headers: { 'X-Load': '1' } });
      if (r.ok) {
        const j = await r.json();
        hubMode = true;
        repo = j.repo;
        base = './gh';
        fetchFn = (u, o = {}) => fetch(u, { ...o, headers: { ...(o.headers || {}), 'X-Load': '1' } });
        conn.value = { ...conn.value, mode: 'hub', claude: j.claude };
      }
    } catch { /* fall through */ }
  }
  if (!hubMode) {
    const c = githubCreds();
    if (!c?.token) {
      conn.value = { ...conn.value, mode: 'setup' };
      return;
    }
    repo = c.repo || 'mxavierr/load-data';
    token = c.token;
    base = 'https://api.github.com';
    conn.value = { ...conn.value, mode: 'github' };
  }
  files = {};
  for (const [k, p] of Object.entries(FILES)) files[k] = new RemoteFile({ base, repo, path: p, token, fetch: fetchFn });

  // Paint from the last copy right away, then catch up.
  for (const k of Object.keys(FILES)) {
    try {
      const cached = JSON.parse(localStorage.getItem(LS + k) || 'null');
      if (cached) { files[k].doc = cached; SIGNALS[k].value = cached; }
    } catch { /* ignore */ }
  }
  await pullAll();
  setInterval(() => { if (document.visibilityState === 'visible') pullAll(); }, hubMode ? 10e3 : 25e3);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') pullAll(); });
  if (hubMode) setInterval(pingHub, 60e3);
}

async function pingHub() {
  try {
    const j = await (await fetch('./api/ping', { headers: { 'X-Load': '1' } })).json();
    conn.value = { ...conn.value, claude: j.claude };
  } catch { /* hub restarting */ }
}

let pulling = false;
export async function pullAll() {
  if (!files || pulling) return;
  pulling = true;
  try {
    for (const k of Object.keys(FILES)) {
      const f = files[k];
      const { changed, dirty } = await f.pull();
      if (changed || !SIGNALS[k].value) {
        SIGNALS[k].value = f.doc;
        cache(k);
      }
      if (dirty && k !== 'library') scheduleSave(k);
    }
    conn.value = { ...conn.value, ready: true, error: null, pulledAt: Date.now() };
  } catch (e) {
    conn.value = { ...conn.value, ready: !!db.value, error: e.status === 401 ? 'auth' : 'offline' };
  } finally {
    pulling = false;
  }
}

function cache(k) {
  try {
    localStorage.setItem(LS + k, JSON.stringify(SIGNALS[k].value));
  } catch { /* quota */ }
}

const timers = {};
function scheduleSave(k) {
  clearTimeout(timers[k]);
  timers[k] = setTimeout(() => save(k), 700);
}

async function save(k) {
  const f = files[k];
  conn.value = { ...conn.value, saving: true };
  try {
    const sent = SIGNALS[k].value;
    await f.push(mergeDocs(f.doc, sent), k === 'db' ? 'edit' : 'time');
    const merged = mergeDocs(f.doc, SIGNALS[k].value); // keep edits made while saving
    f.doc = merged;
    SIGNALS[k].value = merged;
    cache(k);
    if (!docEquals(merged, f.remote)) scheduleSave(k);
    conn.value = { ...conn.value, saving: false, error: null };
  } catch (e) {
    conn.value = { ...conn.value, saving: false, error: e.status === 401 ? 'auth' : 'offline' };
    timers[k] = setTimeout(() => save(k), 15e3);
  }
}

/** Change a data file. fn gets the current doc and returns the next one. */
export function change(k, fn) {
  const next = fn(SIGNALS[k].value || {});
  SIGNALS[k].value = next;
  if (files) files[k].doc = mergeDocs(files[k].doc, next);
  cache(k);
  scheduleSave(k);
}

// ---------- actions ----------

const undoStack = [];
function remember(id) {
  const prev = db.value?.tasks?.[id];
  if (prev) undoStack.push(prev);
  if (undoStack.length > 30) undoStack.shift();
}

export function undo() {
  const prev = undoStack.pop();
  if (!prev) return;
  change('db', (d) => {
    const cur = d.tasks[prev.id];
    const restore = {};
    for (const k of new Set([...Object.keys(prev), ...Object.keys(cur || {})])) if (k !== '_t') restore[k] = prev[k];
    return { ...d, tasks: { ...d.tasks, [prev.id]: stamp(cur, restore) } };
  });
  toast('Undone');
}

export function toast(text, action) {
  ui.value = { ...ui.value, toast: { text, action, at: Date.now() } };
  const at = ui.value.toast.at;
  setTimeout(() => { if (ui.value.toast?.at === at) ui.value = { ...ui.value, toast: null }; }, action ? 6000 : 2500);
}

export function updateTask(id, set, { quiet } = {}) {
  remember(id);
  change('db', (d) => ({ ...d, tasks: { ...d.tasks, [id]: editTask(d.tasks[id], set) } }));
  if (!quiet) toast('Saved', { label: 'Undo', run: undo });
}

export function toggleDone(id) {
  const t = db.value.tasks[id];
  remember(id);
  change('db', (d) => ({ ...d, tasks: { ...d.tasks, [id]: editTask(d.tasks[id], { done: !t.done, lock: t.src !== 'manual' ? { ...(t.lock || {}), done: true } : t.lock }) } }));
  if (!t.done) toast(`Done · ${t.title}`, { label: 'Undo', run: undo });
  if (!t.done && timer.value?.task === id) stopTimer();
}

export function addTask(fields) {
  const t = newTask(fields);
  change('db', (d) => ({ ...d, tasks: { ...(d.tasks || {}), [t.id]: t } }));
  toast(`Added · ${t.title}`, { label: 'Open', run: () => openPeek(t.id) });
  return t;
}

export function deleteTask(id) {
  remember(id);
  change('db', (d) => ({ ...d, tasks: { ...d.tasks, [id]: stamp(d.tasks[id], { deleted: true }) } }));
  if (ui.value.peek === id) closePeek();
  toast('Removed', { label: 'Undo', run: undo });
}

export function runOps(ops, label = 'Applied') {
  let applied = [];
  change('db', (d) => {
    const r = applyOps(d, ops);
    applied = r.applied;
    return r.db;
  });
  toast(applied.length ? `${label} · ${applied.length} change${applied.length > 1 ? 's' : ''}` : 'Nothing to change');
}

export function openPeek(id) {
  ui.value = { ...ui.value, peek: id };
}
export function closePeek() {
  ui.value = { ...ui.value, peek: null };
}

export function startTimer(id) {
  const cur = timer.value;
  const now = new Date().toISOString();
  if (cur) logSession(cur.task, cur.s, now, 'timer');
  change('db', (d) => ({ ...d, timer: { main: stamp(d.timer?.main, { id: 'main', task: id, s: now }) } }));
}
export function stopTimer() {
  const cur = timer.value;
  if (!cur) return;
  logSession(cur.task, cur.s, new Date().toISOString(), 'timer');
  change('db', (d) => ({ ...d, timer: { main: stamp(d.timer?.main, { id: 'main', task: null, s: null }) } }));
}
function logSession(task, s, e, src) {
  if ((Date.parse(e) - Date.parse(s)) / 6e4 < 1) return;
  const id = uid('s');
  change('log', (l) => ({ ...l, sessions: { ...(l.sessions || {}), [id]: stamp(null, { id, task, s, e, src }) } }));
}

export function setSettings(patch) {
  change('db', (d) => ({ ...d, settings: { ...(d.settings || {}), main: stamp(d.settings?.main, { id: 'main', ...patch }) } }));
}
export function setCourse(id, patch) {
  change('db', (d) => ({ ...d, courses: { ...d.courses, [id]: stamp(d.courses[id], patch) } }));
}
export function setLayout(key, value) {
  change('db', (d) => ({ ...d, layout: { ...(d.layout || {}), [key]: stamp(d.layout?.[key], { id: key, ...value }) } }));
}

// Requests to the assistant and the reviewer go through db.inbox so the phone can ask
// too; the Mac answers when it is awake.
export function ask(text, type = 'ask') {
  const id = uid('q');
  change('db', (d) => ({ ...d, inbox: { ...(d.inbox || {}), [id]: stamp(null, { id, text, type, status: 'new', at: new Date().toISOString() }) } }));
  ui.value = { ...ui.value, answer: id };
  if (hubMode) setTimeout(() => fetch('./api/kick', { method: 'POST', headers: { 'X-Load': '1' } }).catch(() => {}), 900);
  return id;
}
export function closeRequest(id, status) {
  change('db', (d) => ({ ...d, inbox: { ...d.inbox, [id]: stamp(d.inbox[id], { status }) } }));
  if (ui.value.answer === id) ui.value = { ...ui.value, answer: null };
}

export function requestSync() {
  setSettings({ syncRequest: new Date().toISOString() });
  toast('Sync requested · runs on the Mac');
}

export const isHub = () => hubMode;
