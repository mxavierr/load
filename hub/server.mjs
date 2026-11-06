// The Mac side of Load. Runs in the background (LaunchAgent) on 127.0.0.1:8766.
//  - serves the app locally and proxies the data repo with your `gh` login, so the Mac
//    needs no token pasted anywhere
//  - takes Brightspace/MyLab snapshots and time logs from the Safari extension
//  - answers requests typed into the command bar (queued in db.inbox, so the phone can
//    ask too and get its answer when the Mac is awake) and runs the periodic review
//  - keeps nightly local backups

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { RemoteFile, FILES } from '../shared/store.js';
import { stamp, live, uid } from '../shared/doc.js';
import { reconcile, buildLibrary, trackedIds } from '../shared/reconcile.js';
import { DEFAULT_SETTINGS } from '../shared/model.js';
import { parseQuick } from '../shared/quickadd.js';
import { newTask } from '../shared/ops.js';
import { makePlan } from '../shared/plan.js';
import { today as todayFn, toLocal, nowLocal, asLocal } from '../shared/time.js';
import { runChecks, syncAlert } from '../shared/checks.js';
import { assist, review } from './brain.mjs';
import { claudeStatus, probeClaude } from './claude.mjs';
import { localGitHub } from './localgh.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, '../app/dist');
const HOME = process.env.LOAD_HOME || path.join(os.homedir(), 'Library/Application Support/Load');
const CONFIG = path.join(HOME, 'config.json');
fs.mkdirSync(path.join(HOME, 'backups'), { recursive: true });

// mode "local": data lives in ~/Library/Application Support/Load/data (works offline, Mac only).
// mode "github": data lives in the private repo, so the phone can reach it.
const config = { repo: 'mxavierr/load-data', port: 8766, mode: 'local', ...(fs.existsSync(CONFIG) ? JSON.parse(fs.readFileSync(CONFIG, 'utf8')) : {}) };
if (!fs.existsSync(CONFIG)) fs.writeFileSync(CONFIG, JSON.stringify(config, null, 2));
const PORT = Number(process.env.LOAD_PORT || config.port);

function log(...a) {
  console.log(new Date().toISOString().slice(0, 19), ...a);
}

let token = null;
function refreshToken() {
  try {
    token = execFileSync('/opt/homebrew/bin/gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
  } catch (e) {
    log('gh auth token failed', e.message);
  }
}
refreshToken();
setInterval(refreshToken, 3600e3);

const localFetch = localGitHub(path.join(HOME, 'data'));
const authFetch = config.mode === 'github'
  ? (url, opts = {}) => fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: `Bearer ${token}` } })
  : localFetch;
const files = {};
for (const [k, p] of Object.entries(FILES)) files[k] = new RemoteFile({ repo: config.repo, path: p, fetch: authFetch });

// Writes are serialized so a sync, a timer stop and an inbox answer never race each other.
let chain = Promise.resolve();
function exclusive(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

async function pullAll() {
  await Promise.all(Object.values(files).map((f) => f.pull()));
  cacheLocally();
}
function cacheLocally() {
  for (const [k, f] of Object.entries(files)) if (f.doc) fs.writeFileSync(path.join(HOME, `${k}.cache.json`), JSON.stringify(f.doc));
}
function settings() {
  return { ...DEFAULT_SETTINGS, ...(files.db.doc?.settings?.main || {}) };
}

// ---------- ingest from the extension ----------

async function ingest(snap) {
  return exclusive(async () => {
    await pullAll();
    const s = settings();
    const tracked = trackedIds(files.db.doc, files.log.doc?.sessions, snap.tracking);
    const { db, report, schedules } = reconcile(files.db.doc, snap, { settings: s, tracked });
    const byOu = new Map();
    for (const c of live(db.courses)) for (const ou of c.ous || []) byOu.set(String(ou), c.id);
    const library = buildLibrary(files.library.doc, snap, byOu, { tz: s.tz, schedules });
    const syncId = report.at;
    const trim = (xs) => (xs || []).slice(0, 40);
    const rec = stamp(null, {
      id: syncId, at: report.at, ok: report.ok, kind: snap.courses?.length ? 'full' : 'mylab', counts: report.counts,
      added: trim(report.added), changed: trim(report.changed), completed: trim(report.completed), merged: trim(report.merged),
      missing: trim(report.missing), back: trim(report.back), conflicts: trim(report.conflicts), errors: trim(report.errors),
      mylab: snap.mylab ? { ok: !!snap.mylab.ok, n: snap.mylab.rows?.length || 0, error: snap.mylab.error } : undefined,
    });
    const logDoc = { ...files.log.doc, syncs: pruneSyncs({ ...(files.log.doc.syncs || {}), [syncId]: rec }) };
    // MyLab is read on its own, so a MyLab-only snapshot says nothing about Brightspace.
    const stamps = {
      ...(snap.courses?.length ? { lastSync: report.at, syncRequest: undefined, extError: undefined } : {}),
      ...(snap.mylab?.ok ? { lastMyLab: report.at } : {}),
    };
    const dbDoc = { ...db, settings: { ...(db.settings || {}), main: stamp(db.settings?.main, stamps) } };
    await files.db.push(dbDoc, `sync ${report.at}`);
    await files.library.push(library, `library ${report.at}`);
    await files.log.push(logDoc, `sync log ${report.at}`);
    cacheLocally();
    log('ingest', JSON.stringify(report.counts), `+${report.added.length} ~${report.changed.length} ✓${report.completed.length} ⨯${report.missing.length} merged ${report.merged.length}`, report.errors.length ? `errors: ${report.errors.join('; ')}` : '');
    const notable = report.added.length + report.changed.length + report.missing.length + report.merged.length + report.conflicts.length + report.errors.length;
    if (notable) setTimeout(() => runReview({ auto: true }).catch((e) => log('review failed', e.message)), 2000);
    return report;
  });
}

function pruneSyncs(syncs) {
  const keys = Object.keys(syncs).filter((k) => !syncs[k].deleted).sort();
  const out = { ...syncs };
  for (const k of keys.slice(0, Math.max(0, keys.length - 60))) out[k] = stamp(out[k], { deleted: true, added: undefined, changed: undefined, completed: undefined, merged: undefined, missing: undefined, errors: undefined, counts: undefined });
  return out;
}

// ---------- the assistant and the reviewer ----------

async function processInbox() {
  const inbox = files.db.doc?.inbox || {};
  const pending = Object.values(inbox).filter((r) => r.status === 'new' && !r.deleted).sort((a, b) => (a.at < b.at ? -1 : 1));
  for (const req of pending) {
    await exclusive(async () => {
      await files.db.pull();
      await files.db.push({ ...files.db.doc, inbox: { ...files.db.doc.inbox, [req.id]: stamp(files.db.doc.inbox[req.id], { status: 'working' }) } }, 'assistant: working');
    });
    let patch;
    try {
      if (req.type === 'check') {
        const r = await runReview({ focus: req.text, push: false });
        patch = { status: 'ready', reply: r.summary, report: true };
      } else {
        const out = await assist({ text: req.text, db: files.db.doc, settings: settings() });
        patch = { status: 'ready', reply: out.reply, ops: out.ops };
      }
    } catch (e) {
      const st = claudeStatus().state;
      patch = { status: 'error', reply: st === 'needs-login' ? 'Not connected yet. Run `claude` once in Terminal and sign in.' : `Could not finish: ${e.message.slice(0, 160)}` };
    }
    await exclusive(async () => {
      await files.db.pull();
      await files.db.push({ ...files.db.doc, inbox: { ...files.db.doc.inbox, [req.id]: stamp(files.db.doc.inbox[req.id], patch) } }, 'assistant: answer');
    });
    log('inbox', req.id, patch.status);
  }
}

let reviewing = null;
let autoReviews = { day: '', n: 0 };
async function runReview({ focus, auto = false, push = true } = {}) {
  if (reviewing) return reviewing;
  reviewing = (async () => {
    await pullAll();
    const s = settings();
    const day = todayFn(s.tz);
    if (autoReviews.day !== day) autoReviews = { day, n: 0 };
    // Automatic runs only spend a model call when the code checks found something new.
    let useModel = true;
    if (auto) {
      const prev = files.db.doc.reports?.latest;
      const ids = runChecks({ db: files.db.doc, log: files.log.doc, library: files.library.doc, settings: s }).map((f) => f.id).sort().join(',');
      useModel = autoReviews.n < 4 && claudeStatus().state !== 'needs-login' && (!prev || prev.findingIds !== ids);
    }
    let r;
    try {
      r = await review({ db: files.db.doc, log: files.log.doc, library: files.library.doc, settings: s, focus, useModel });
      if (auto && useModel) autoReviews.n++;
    } catch (e) {
      r = await review({ db: files.db.doc, log: files.log.doc, library: files.library.doc, settings: s, focus, useModel: false });
      r.error = claudeStatus().state === 'needs-login' ? 'needs-login' : e.message.slice(0, 160);
    }
    r.findingIds = r.findings.map((f) => f.id).sort().join(',');
    r.applied = []; // a fresh report starts with nothing dismissed
    await exclusive(async () => {
      await files.db.pull();
      await files.db.push({ ...files.db.doc, reports: { ...(files.db.doc.reports || {}), latest: stamp(files.db.doc.reports?.latest, { id: 'latest', ...r }) } }, 'review');
    });
    log('review', focus ? `focus: ${focus}` : auto ? 'auto' : 'manual', useModel ? 'model' : 'code-only', r.summary || '');
    return r;
  })().finally(() => { reviewing = null; });
  return reviewing;
}

// ---------- extension endpoints ----------

// When the extension last checked in, so the app (on any device) can tell whether
// syncing and time tracking are actually alive. Saved at most every 20 minutes.
let extSeen = 0;
function noteExtension(version) {
  const prev = extSeen;
  extSeen = Date.now();
  const saved = Date.parse(files.db.doc?.settings?.main?.extSeen || 0) || 0;
  if (extSeen - saved < 20 * 60e3 && prev) return;
  exclusive(async () => {
    await files.db.pull();
    const main = files.db.doc.settings?.main;
    await files.db.push({ ...files.db.doc, settings: { ...files.db.doc.settings, main: stamp(main, { extSeen: new Date(extSeen).toISOString(), extVersion: version || undefined }) } }, 'extension seen');
  }).catch((e) => log('extSeen', e.message));
}

function extState() {
  const s = settings();
  const db = files.db.doc || {};
  const tasks = live(db.tasks);
  // URL fingerprints the extension can match the current tab against.
  const index = [];
  for (const t of tasks) {
    if (t.done && (asLocal(t.doneAt, s.tz) || '0') < todayFn(s.tz)) continue;
    const keys = new Set();
    for (const r of [t.id, ...(t.refs || [])]) {
      const p = r.split(':');
      if (p[0] === 'bs' && p[2] === 'dropbox') keys.add(`db=${p[3]}`);
      if (p[0] === 'bs' && p[2] === 'quiz') keys.add(`qi=${p[3]}`);
      if (p[0] === 'bs' && p[2] === 'topic') keys.add(`viewContent/${p[3]}/`);
      if (p[0] === 'mylab') keys.add(`mylab:${p[1]}`);
    }
    if (t.url && !/content\/\d+\/Home/.test(t.url)) keys.add(t.url.replace(/^https?:\/\//, '').split('#')[0]);
    for (const l of t.links || []) keys.add(l);
    if (keys.size) index.push({ id: t.id, title: t.title, course: t.course, keys: [...keys] });
  }
  let plan = null;
  try {
    plan = makePlan({ tasks: db.tasks, sessions: files.log.doc?.sessions, settings: s });
  } catch { /* empty db */ }
  const todayList = plan ? plan.days[0].items.slice(0, 8).map((i) => ({ id: i.id, min: i.min, title: db.tasks[i.id]?.title, course: db.tasks[i.id]?.course, due: db.tasks[i.id]?.due })) : [];
  const courses = Object.fromEntries(live(db.courses).map((c) => [c.id, c.color]));
  return {
    settings: { syncTimes: s.syncTimes, term: s.term, extraOus: s.extraOus, mylab: s.mylab, mylabEveryDays: s.mylabEveryDays, tz: s.tz },
    lastSync: s.lastSync || null,
    lastMyLab: s.lastMyLab || null,
    syncRequest: s.syncRequest || null,
    timer: db.timer?.main?.task ? db.timer.main : null,
    index, today: todayList, courses,
  };
}

async function addSessions(list) {
  return exclusive(async () => {
    await files.log.pull();
    const sessions = { ...(files.log.doc.sessions || {}) };
    for (const s of list) {
      if (!s.task || !s.s || !s.e) continue;
      const id = s.id || uid('s');
      sessions[id] = stamp(sessions[id], { id, task: s.task, s: s.s, e: s.e, src: s.src || 'auto', url: s.url });
    }
    await files.log.push({ ...files.log.doc, sessions }, 'time log');
  });
}

async function setTimer(body) {
  return exclusive(async () => {
    await files.db.pull();
    await files.log.pull();
    const db = files.db.doc;
    const cur = db.timer?.main;
    const nowIso = new Date().toISOString();
    if (cur?.task) {
      const id = uid('s');
      const sessions = { ...(files.log.doc.sessions || {}), [id]: stamp(null, { id, task: cur.task, s: cur.s, e: nowIso, src: 'timer' }) };
      await files.log.push({ ...files.log.doc, sessions }, 'timer stop');
    }
    const next = body.task ? { id: 'main', task: body.task, s: nowIso } : { id: 'main', task: null, s: null };
    await files.db.push({ ...db, timer: { main: stamp(cur, next) } }, body.task ? 'timer start' : 'timer stop');
    return next;
  });
}

async function quickAdd(text, extra = {}) {
  return exclusive(async () => {
    await files.db.pull();
    const s = settings();
    const p = parseQuick(text, { courses: live(files.db.doc.courses), tz: s.tz });
    const t = newTask({ title: p.title || text, course: p.course, due: p.due, est: p.est, kind: p.kind, pri: p.pri, ...extra });
    await files.db.push({ ...files.db.doc, tasks: { ...files.db.doc.tasks, [t.id]: t } }, 'quick add');
    return t;
  });
}

// ---------- http ----------

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon' };

// The Safari extension calls from its own origin. Answer it (and only it) with CORS
// headers, so a preflight for the X-Load header cannot block a sync.
const EXT_ORIGIN = /^(safari-web-extension|chrome-extension|moz-extension):\/\//;
function send(res, code, body, type = 'application/json') {
  const h = { 'Content-Type': type, 'Cache-Control': 'no-store' };
  if (res.corsOrigin) Object.assign(h, { 'Access-Control-Allow-Origin': res.corsOrigin, Vary: 'Origin' });
  res.writeHead(code, h);
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const s = Buffer.concat(chunks).toString('utf8');
  return s ? JSON.parse(s) : {};
}

async function proxyGitHub(req, res, rest) {
  // Only the data repo's contents, nothing else on your account.
  if (!rest.startsWith(`/repos/${config.repo}/contents/`)) return send(res, 403, { error: 'not allowed' });
  const headers = { Accept: req.headers.accept?.includes('github.raw') ? 'application/vnd.github.raw' : 'application/vnd.github+json' };
  if (req.headers['if-none-match']) headers['If-None-Match'] = req.headers['if-none-match'];
  let body;
  if (req.method === 'PUT') { headers['Content-Type'] = 'application/json'; body = JSON.stringify(await readBody(req)); }
  const r = await authFetch(`https://api.github.com${rest}`, { method: req.method, headers, body });
  const out = Buffer.from(await r.arrayBuffer());
  const h = { 'Content-Type': r.headers.get('content-type') || 'application/json', 'Cache-Control': 'no-store' };
  if (r.headers.get('etag')) h.ETag = r.headers.get('etag');
  res.writeHead(r.status, h);
  res.end(out);
}

function serveStatic(req, res, p) {
  let file = path.join(DIST, decodeURIComponent(p));
  if (!file.startsWith(DIST)) return send(res, 403, 'no');
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
  if (!fs.existsSync(file)) return send(res, 503, 'App not built yet. Run npm run build.', 'text/plain');
  send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] || 'application/octet-stream');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const corsOrigin = (res.corsOrigin = EXT_ORIGIN.test(req.headers.origin || '') ? req.headers.origin : null);
  try {
    if (req.method === 'OPTIONS') {
      if (!corsOrigin) return send(res, 403, { error: 'no' });
      res.writeHead(204, { 'Access-Control-Allow-Origin': corsOrigin, 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'X-Load, Content-Type', 'Access-Control-Max-Age': '600', Vary: 'Origin' });
      return res.end();
    }
    if (p.startsWith('/gh/') || p.startsWith('/api/')) {
      // A web page cannot add this header to a cross-site request without our blessing,
      // which we never give, so other sites cannot drive the hub.
      if (req.headers['x-load'] !== '1') return send(res, 403, { error: 'missing header' });
    }
    if (p.startsWith('/gh/')) return await proxyGitHub(req, res, p.slice(3) + url.search);
    if (p === '/api/ping') return send(res, 200, { ok: true, repo: config.repo, mode: config.mode, claude: claudeStatus(), ext: extSeen ? new Date(extSeen).toISOString() : null, now: nowLocal(settings().tz) });
    if (p === '/api/ext' && req.method === 'GET') {
      await files.db.pull().catch(() => {});
      noteExtension(url.searchParams.get('v'));
      return send(res, 200, extState());
    }
    if (p === '/api/ext/report' && req.method === 'POST') {
      // A sync the extension could not finish: log it and show it in Status.
      const b = await readBody(req);
      if (b.started) { log('extension sync started', b.reason || '', JSON.stringify(b.access || {})); return send(res, 200, { ok: true }); }
      log('extension sync failed', b.reason || '', b.error || '', b.where ? `at ${b.where}` : '', JSON.stringify(b.access || {}));
      exclusive(async () => {
        await files.db.pull();
        await files.db.push({ ...files.db.doc, settings: { ...files.db.doc.settings, main: stamp(files.db.doc.settings?.main, { extError: { at: b.at, kind: b.kind, error: String(b.error || '').slice(0, 300), where: b.where, access: b.access } }) } }, 'extension error');
      }).catch((e) => log('ext report', e.message));
      return send(res, 200, { ok: true });
    }
    if (p === '/api/ingest' && req.method === 'POST') return send(res, 200, await ingest(await readBody(req)));
    if (p === '/api/sessions' && req.method === 'POST') { await addSessions((await readBody(req)).sessions || []); return send(res, 200, { ok: true }); }
    if (p === '/api/timer' && req.method === 'POST') return send(res, 200, await setTimer(await readBody(req)));
    if (p === '/api/quick' && req.method === 'POST') { const b = await readBody(req); return send(res, 200, await quickAdd(b.text, b.extra)); }
    if (p === '/api/kick' && req.method === 'POST') { await files.db.pull(); processInbox().catch((e) => log('inbox', e.message)); return send(res, 200, { ok: true }); }
    if (p === '/api/review' && req.method === 'POST') { const b = await readBody(req); runReview({ focus: b.focus }).catch((e) => log('review', e.message)); return send(res, 200, { ok: true }); }
    if (p === '/api/claude' && req.method === 'POST') return send(res, 200, await probeClaude());
    return serveStatic(req, res, p === '/' ? '/index.html' : p);
  } catch (e) {
    log('error', p, e.stack || e.message);
    return send(res, 500, { error: e.message });
  }
});

// The phone cannot ask the hub directly, so the assistant's state is kept in the data.
function publishClaudeState() {
  const st = claudeStatus().state;
  if (st === 'unknown' || files.db.doc?.settings?.main?.claude === st) return;
  exclusive(async () => {
    await files.db.pull();
    await files.db.push({ ...files.db.doc, settings: { ...files.db.doc.settings, main: stamp(files.db.doc.settings?.main, { claude: st }) } }, 'assistant state');
  }).catch((e) => log('claude state', e.message));
}

// ---------- background loops ----------

async function tick() {
  try {
    const { changed } = await files.db.pull();
    if (changed) cacheLocally();
    await processInbox();
  } catch (e) {
    log('tick', e.message);
  }
}

// Remembered across restarts so a restart after 9 pm does not run the nightly review twice.
const DAILY = path.join(HOME, 'daily.json');
let { lastReviewDay = '', lastBackupDay = '', lastAlert = 0 } = fs.existsSync(DAILY) ? JSON.parse(fs.readFileSync(DAILY, 'utf8')) : {};
const saveDaily = () => fs.writeFileSync(DAILY, JSON.stringify({ lastReviewDay, lastBackupDay, lastAlert }));

// The extension cannot speak up when Safari is closed or the extension is off, so the hub
// watches for syncs falling behind. At most one notification every 6 hours, during the day.
const ALERT_EVERY = 6 * 3600e3;
function watchSync() {
  const s = settings();
  if (!files.db.doc) return;
  const seen = [s.extSeen, extSeen ? new Date(extSeen).toISOString() : null].filter(Boolean).sort().pop();
  const alert = syncAlert({ lastSync: s.lastSync, extError: s.extError, extSeen: seen });
  if (!alert || Date.now() - lastAlert < ALERT_EVERY) return;
  const hour = +nowLocal(s.tz).slice(11, 13);
  if (hour < 8 || hour >= 23) return;
  lastAlert = Date.now();
  saveDaily();
  log('sync alert', alert.id, alert.text);
  if (config.mode !== 'github') return; // a throwaway test hub stays quiet
  const script = `display notification ${JSON.stringify(alert.text)} with title "Load" sound name "Glass"`;
  execFile('/usr/bin/osascript', ['-e', script], (e) => { if (e) log('sync alert failed', e.message); });
}
async function daily() {
  const s = settings();
  const d = todayFn(s.tz);
  const hour = +nowLocal(s.tz).slice(11, 13);
  if (hour >= (s.managerHour ?? 21) && lastReviewDay !== d) {
    lastReviewDay = d;
    saveDaily();
    runReview({ auto: false }).catch((e) => log('nightly review', e.message));
  }
  if (lastBackupDay !== d) {
    lastBackupDay = d;
    saveDaily();
    const dir = path.join(HOME, 'backups');
    for (const [k, f] of Object.entries(files)) if (f.doc) fs.writeFileSync(path.join(dir, `${d}-${k}.json`), JSON.stringify(f.doc));
    const all = fs.readdirSync(dir).sort();
    for (const old of all.slice(0, Math.max(0, all.length - 90))) fs.unlinkSync(path.join(dir, old));
  }
}

// Start from the local cache if GitHub is unreachable.
for (const [k, f] of Object.entries(files)) {
  const c = path.join(HOME, `${k}.cache.json`);
  if (fs.existsSync(c)) try { f.doc = JSON.parse(fs.readFileSync(c, 'utf8')); } catch { /* ignore */ }
}

server.listen(PORT, '127.0.0.1', async () => {
  log(`Load hub on http://127.0.0.1:${PORT} · data ${config.mode === 'github' ? config.repo : 'local'}`);
  await pullAll().catch((e) => log('initial pull', e.message));
  probeClaude().then((s) => { log('claude', s.state); publishClaudeState(); });
  setInterval(publishClaudeState, 5 * 60e3);
  setInterval(tick, 20e3);
  setInterval(daily, 5 * 60e3);
  setTimeout(daily, 30e3);
  setInterval(watchSync, 5 * 60e3);
  setTimeout(watchSync, 60e3);
});
