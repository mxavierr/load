// Load for Safari: the Brightspace sync, the weekly MyLab read and automatic time tracking.
// It talks only to the Load hub on this Mac (127.0.0.1:8766), which owns the data.
//
// How a sync stays reliable:
//  - It always reads through a fresh hidden tab. A fresh page load lets the university's
//    login renew an idle session, and a new tab always has a working content script. Old
//    tabs can have an expired session or a script orphaned by an extension update.
//  - If a person really has to sign in, that page stays open in Safari, and the sync runs by
//    itself once a Brightspace page loads. It never opens a second one or reloads that one,
//    so it can't wipe a half-typed password.
//  - Safari can shut the background page down mid-sync. Progress is kept in storage, so
//    the next start closes the leftover tabs and reports where it stopped.
//  - Brightspace is saved before MyLab is touched, so MyLab can never cost a Brightspace read.

import { shouldSync, shouldSyncOnVisit, shouldReadMyLab, isAppPage, matchTask as match, beat, close, GAP } from './logic.js';

const HUB = globalThis.__LOAD_HUB__ || 'http://127.0.0.1:8766'; // overridable for tests
const BS = 'https://purdue.brightspace.com';
const VERSION = browser.runtime.getManifest().version;

const store = {
  async get(k, d) { const r = await browser.storage.local.get(k); return r[k] ?? d; },
  set(k, v) { return browser.storage.local.set({ [k]: v }); },
};

const MAX_RUN = 5 * 60e3;
const SIGNIN_MSG = 'Brightspace needs you to sign in. The page is waiting in Safari.';

async function hub(path, body) {
  const r = await fetch(HUB + path, {
    method: body ? 'POST' : 'GET',
    headers: { 'X-Load': '1', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`hub ${r.status}`);
  return r.json();
}

// ---------------------------------------------------------------- schedule

browser.runtime.onInstalled.addListener(setup);
browser.runtime.onStartup.addListener(setup);
function setup() {
  browser.alarms.create('tick', { periodInMinutes: 1 });
  browser.contextMenus.removeAll().then(() => {
    browser.contextMenus.create({ id: 'add', title: 'Add to Load', contexts: ['page', 'selection', 'link'] });
  });
}
setup();

browser.alarms.onAlarm.addListener((a) => { if (a.name === 'tick') tick().catch((e) => console.warn('tick', e)); });

let state = null;
async function refresh() {
  try {
    state = await hub(`/api/ext?v=${VERSION}`);
    await store.set('state', state);
    await store.set('hubOk', Date.now());
  } catch {
    state = state || (await store.get('state', null));
  }
  return state;
}

async function tick() {
  const s = await refresh();
  await closeIdleSession();
  await flushSessions();
  if (!syncing) await recoverRun();
  await checkSigninTab();
  if (!s) return;
  const why = shouldSync({
    times: s.settings?.syncTimes, lastSync: s.lastSync, request: s.syncRequest,
    lastTry: await store.get('lastTry', 0), needsSignin: await store.get('needsSignin', false),
  });
  if (why) await runSync(why);
}

// ---------------------------------------------------------------- sync

let syncing = 0;
async function runSync(reason) {
  // A sync that somehow never finishes must not block every later one.
  if (syncing && Date.now() - syncing < MAX_RUN) return;
  syncing = Date.now();
  await recoverRun();
  hub('/api/ext/report', { at: new Date().toISOString(), reason, started: true, access: await siteAccess() }).catch(() => {});
  return within(MAX_RUN, sync(reason), 'sync').catch(async (e) => {
    await fail(reason, String(e.message || e));
  }).finally(() => { syncing = 0; });
}

async function fail(reason, msg) {
  await store.set('lastResult', { at: Date.now(), ok: false, errors: [msg] });
  hub('/api/ext/report', { at: new Date().toISOString(), reason, error: msg, access: await siteAccess() }).catch(() => {});
  setBadge('!');
}

/** Safari shut a previous run down partway: tidy up its tabs and say where it stopped. */
async function recoverRun() {
  const run = await store.get('run', null);
  if (!run) return;
  await store.set('run', null);
  for (const id of run.tabs || []) browser.tabs.remove(id).catch(() => {});
  if (run.saved) return; // Brightspace had already been saved; only MyLab was cut short
  await fail(run.reason, `interrupted while ${run.step}`);
}

async function sync(reason) {
  await store.set('lastTry', Date.now());
  setBadge('…');
  const run = { at: Date.now(), reason, step: 'starting', tabs: [] };
  const step = (name) => { run.step = name; return store.set('run', run); };
  const open = async (url) => {
    const t = await browser.tabs.create({ url, active: false });
    run.tabs.push(t.id);
    await store.set('run', run);
    return t;
  };
  // Regular extension calls keep Safari from treating the background page as idle.
  const alive = setInterval(() => { store.get('run', null).catch(() => {}); }, 5000);
  try {
    const s = await refresh();
    const access = await siteAccess();
    if (access.brightspace === false) throw new Error('Safari has not given Load access to purdue.brightspace.com');
    await step('opening Brightspace');
    const tab = await open(`${BS}/d2l/home`);
    const landed = await settle(tab.id);
    if (!landed.ok) return await signInNeeded(tab.id, reason, run, landed.where);

    await step('reading Brightspace');
    await scriptReady(tab.id);
    const head = await ask(tab.id, { type: 'collect', cfg: { term: s?.settings?.term, extraOus: s?.settings?.extraOus } }, 120e3);
    if (!head?.chunks) throw new Error('the page did not return any data');
    await step(`fetching ${head.chunks} part(s) of the Brightspace data`);
    let text = '';
    for (let i = 0; i < head.chunks; i++) text += (await ask(tab.id, { type: 'chunk', i }, 15000)).data || '';
    if (text.length !== head.size) throw new Error(`got ${text.length} of ${head.size} bytes`);
    const snap = JSON.parse(text);
    if (!snap.ok && snap.errors?.includes('signed-out')) return await signInNeeded(tab.id, reason, run, 'the Brightspace API');
    snap.reason = reason;
    snap.tracking = await trackedNow();

    await step('saving');
    const report = await save(snap);
    run.saved = true;
    await store.set('run', run);
    await signedIn();
    const errors = [...(report.errors || [])];

    const force = reason === 'requested' || reason === 'popup';
    if (shouldReadMyLab({ lastMyLab: s?.lastMyLab, lastTry: await store.get('lastMyLabTry', 0), everyDays: s?.settings?.mylabEveryDays, force })) {
      await step('reading MyLab');
      await store.set('lastMyLabTry', Date.now());
      const mylab = await readMyLab(tab.id, s?.settings?.mylab, open).catch((e) => ({ ok: false, error: String(e.message || e) }));
      await step('saving MyLab');
      const r2 = await save({ at: new Date().toISOString(), ok: true, errors: [], courses: [], reason, tracking: await trackedNow(), mylab });
      errors.push(...(r2.errors || []));
    }
    await store.set('lastResult', { at: Date.now(), ok: report.ok, added: report.added?.length || 0, errors });
    setBadge(report.errors?.length ? '!' : '');
  } catch (e) {
    await fail(reason, `${run.step}: ${String(e.message || e)}`);
  } finally {
    clearInterval(alive);
    for (const id of run.tabs) browser.tabs.remove(id).catch(() => {});
    await store.set('run', null);
  }
}

/** Time not sent to the hub yet still counts: sync must not tick work in progress. */
async function trackedNow() {
  const open = await store.get('session', null);
  return [...new Set([open?.task, ...(await store.get('pending', [])).map((p) => p.task)].filter(Boolean))];
}

/** The snapshot is the expensive part, so a brief hub or GitHub hiccup must not lose it. */
async function save(snap) {
  let err;
  for (const wait of [0, 5000, 20000]) {
    if (wait) await sleep(wait);
    try { return await hub('/api/ingest', snap); } catch (e) { err = e; }
  }
  throw err;
}

/**
 * Follow a freshly opened tab until it settles. Silent single sign-on passes through other
 * hosts for a few seconds; a page that stays off Brightspace is waiting for a person.
 */
async function settle(tabId, timeout = 40e3) {
  const end = Date.now() + timeout;
  let good = 0, tab = null;
  while (Date.now() < end) {
    tab = await browser.tabs.get(tabId).catch(() => null);
    if (!tab) throw new Error('the Brightspace tab was closed');
    good = tab.status === 'complete' && isAppPage(tab.url) ? good + 1 : 0;
    if (good >= 2) return { ok: true };
    await sleep(1000);
  }
  if (isAppPage(tab?.url)) throw new Error('the page did not finish loading');
  return { ok: false, where: placeOf(tab?.url) };
}

const placeOf = (url) => { try { const u = new URL(url); return u.host + u.pathname; } catch { return 'unknown'; } };

/** Wait for a real answer from the page's script. Silence or an empty reply is not one. */
async function scriptReady(tabId) {
  const start = Date.now();
  let injected = false;
  while (Date.now() - start < 25e3) {
    try {
      if ((await ask(tabId, { type: 'ping' }, 3000))?.ok) return;
    } catch { /* not listening yet */ }
    if (!injected && Date.now() - start > 8000) {
      injected = true;
      await within(5000, browser.scripting.executeScript({ target: { tabId }, files: ['brightspace.js'] }), 'inject').catch(() => {});
    }
    await sleep(1000);
  }
  throw new Error('the page script did not answer');
}

/** Leave one sign-in page open for you, and resume as soon as Brightspace loads. */
async function signInNeeded(tabId, reason, run, where) {
  const prev = await store.get('signinTab', null);
  const waiting = prev != null ? await browser.tabs.get(prev).catch(() => null) : null;
  if (!waiting || isAppPage(waiting.url)) {
    run.tabs = run.tabs.filter((id) => id !== tabId);
    await store.set('signinTab', tabId);
  }
  await store.set('needsSignin', true);
  await store.set('lastResult', { at: Date.now(), ok: false, signin: true, errors: [SIGNIN_MSG] });
  hub('/api/ext/report', { at: new Date().toISOString(), reason, kind: 'signin', error: SIGNIN_MSG, where, access: await siteAccess() }).catch(() => {});
  setBadge('!');
}

async function signedIn() {
  const id = await store.get('signinTab', null);
  if (id != null) {
    const t = await browser.tabs.get(id).catch(() => null);
    if (t && !isAppPage(t.url)) browser.tabs.remove(id).catch(() => {}); // unused: it signed in another way
    await store.set('signinTab', null);
  }
  await store.set('needsSignin', false);
}

/** A Brightspace page just loaded or is in use, which is the best moment to sync. */
async function onBrightspacePage(loaded) {
  if (syncing) return;
  const s = state || (await store.get('state', null));
  if (shouldSyncOnVisit({ lastSync: s?.lastSync, lastTry: await store.get('lastTry', 0), needsSignin: await store.get('needsSignin', false), loaded })) runSync('visit');
}

/** A sign-in can finish while a check is already running, so that page load goes unseen. */
async function checkSigninTab() {
  if (syncing || !(await store.get('needsSignin', false))) return;
  const id = await store.get('signinTab', null);
  const t = id != null ? await browser.tabs.get(id).catch(() => null) : null;
  if (t?.status === 'complete' && isAppPage(t.url)) await onBrightspacePage(true);
}

browser.tabs.onUpdated.addListener((id, info, tab) => {
  if (info.status === 'complete' && isAppPage(tab?.url)) onBrightspacePage(true).catch(() => {});
});

/** Whether Safari lets the extension run on the sites a sync needs (null = cannot tell). */
async function siteAccess() {
  const has = async (o) => { try { return await browser.permissions.contains({ origins: [o] }); } catch { return null; } };
  return { brightspace: await has(`${BS}/*`), mylab: await has('https://mylab.pearson.com/*') };
}

async function readMyLab(bsTabId, ml, open) {
  if (!ml?.ou || !ml?.topicId) return { ok: false, error: 'not configured' };
  const { url } = await ask(bsTabId, { type: 'topicUrl', ou: ml.ou, topicId: ml.topicId }, 15000);
  if (!url) throw new Error('MyLab link not found');
  // The course's Pearson link signs you in to Pearson; the assignments page then opens in the same tab.
  const t = await open(BS + url);
  await waitFor(t.id, (u) => /pearson\.com/.test(u), 60e3);
  await sleep(4000);
  if (ml.launch) await browser.tabs.update(t.id, { url: ml.launch });
  await waitFor(t.id, (u) => /DoAssignments\.aspx/i.test(u), 60e3);
  await sleep(1500);
  const r = await sendWithRetry(t.id, { type: 'parseMyLab' }, 30e3);
  return { ok: !!r?.ok && r.rows.length > 0, rows: r?.rows || [], error: r?.ok ? undefined : 'no rows' };
}

function waitFor(tabId, test, timeout) {
  return new Promise((resolve, reject) => {
    const done = (ok, v) => { clearTimeout(timer); browser.tabs.onUpdated.removeListener(on); ok ? resolve(v) : reject(v); };
    const on = (id, info, tab) => { if (id === tabId && tab.status === 'complete' && tab.url && test(tab.url)) done(true, tab); };
    const timer = setTimeout(() => done(false, new Error('page did not load')), timeout);
    browser.tabs.onUpdated.addListener(on);
    browser.tabs.get(tabId).then((tab) => { if (tab.status === 'complete' && tab.url && test(tab.url)) done(true, tab); }).catch(() => {});
  });
}

async function sendWithRetry(tabId, msg, timeout) {
  const end = Date.now() + timeout;
  let err;
  while (Date.now() < end) {
    try {
      const r = await ask(tabId, msg, Math.max(1000, end - Date.now()));
      if (r !== undefined) return r;
    } catch (e) { err = e; }
    await sleep(1500);
  }
  throw err || new Error('no answer from page');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Safari can leave a message to a tab with no listener pending forever; never wait on one unbounded. */
function within(ms, promise, what) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} timed out`)), ms))]);
}
const ask = (tabId, msg, ms = 8000) => within(ms, browser.tabs.sendMessage(tabId, msg), msg.type);
function setBadge(text) {
  browser.action.setBadgeText({ text }).catch(() => {});
  if (text) browser.action.setBadgeBackgroundColor({ color: text === '!' ? '#e03e3e' : '#888' }).catch(() => {});
}

// ---------------------------------------------------------------- time tracking

const matchTask = (url, s) => match(url, s?.index);

browser.tabs.onCreated.addListener(async (tab) => {
  // A tool opened from a task's page (WileyPLUS, Colab, a PDF) inherits that task.
  if (!tab.openerTabId) return;
  const map = await store.get('tabTask', {});
  if (map[tab.openerTabId]) { map[tab.id] = map[tab.openerTabId]; await store.set('tabTask', map); }
});
browser.tabs.onRemoved.addListener(async (id) => {
  const map = await store.get('tabTask', {});
  if (map[id]) { delete map[id]; await store.set('tabTask', map); }
});

browser.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.type === 'beat') {
    // One at a time: two visible windows can beat together, and each reads then writes the session.
    const now = Date.now();
    beats = beats.then(() => onBeat(msg, sender.tab, now)).catch((e) => console.warn('beat', e));
    return false;
  }
  if (msg?.type === 'popup') { popupState().then(reply); return true; }
  if (msg?.type === 'sync') { runSync('popup'); reply({ ok: true }); return false; }
  if (msg?.type === 'showSignin') { showSignin().then(() => reply({ ok: true }), () => reply({ ok: false })); return true; }
  if (msg?.type === 'timer') { hub('/api/timer', { task: msg.task || null }).then(refresh).then(() => reply({ ok: true }), (e) => reply({ ok: false, error: String(e) })); return true; }
  if (msg?.type === 'quick') { hub('/api/quick', { text: msg.text, extra: msg.extra }).then((t) => reply({ ok: true, task: t }), (e) => reply({ ok: false, error: String(e) })); return true; }
  if (msg?.type === 'attach') { attachTab(msg.tabId, msg.task).then(() => reply({ ok: true })); return true; }
});

async function attachTab(tabId, task) {
  const map = await store.get('tabTask', {});
  if (task) map[tabId] = task; else delete map[tabId];
  await store.set('tabTask', map);
}

async function showSignin() {
  const id = await store.get('signinTab', null);
  const t = id != null ? await browser.tabs.get(id).catch(() => null) : null;
  if (t) {
    await browser.tabs.update(t.id, { active: true });
    await browser.windows?.update?.(t.windowId, { focused: true }).catch(() => {});
    return;
  }
  const made = await browser.tabs.create({ url: `${BS}/d2l/home`, active: true });
  await store.set('signinTab', made.id);
}

let beats = Promise.resolve();
async function onBeat({ url }, tab, now = Date.now()) {
  if (isAppPage(url)) onBrightspacePage(false).catch(() => {}); // not awaited: a sync must not hold up the heartbeats
  const s = state || (await store.get('state', null));
  if (s?.timer) return; // a timer you started yourself already covers this
  let task = matchTask(url, s);
  const map = await store.get('tabTask', {});
  if (task && tab?.id != null && map[tab.id] !== task) { map[tab.id] = task; await store.set('tabTask', map); }
  if (!task && tab?.id != null) task = map[tab.id] || null;
  const r = beat(await store.get('session', null), task, now, url);
  if (r.finished) await queue(r.finished);
  await store.set('session', r.cur);
}

async function queue(rec) {
  const pending = await store.get('pending', []);
  pending.push(rec);
  await store.set('pending', pending);
}

async function closeIdleSession() {
  const cur = await store.get('session', null);
  if (cur && Date.now() - cur.last > GAP) {
    const rec = close(cur);
    if (rec) await queue(rec);
    await store.set('session', null);
  }
}

async function flushSessions() {
  const pending = await store.get('pending', []);
  if (!pending.length) return;
  try {
    await hub('/api/sessions', { sessions: pending });
    await store.set('pending', []);
  } catch { /* hub down: keep them for next time */ }
}

// ---------------------------------------------------------------- popup + menu

async function popupState() {
  const s = await refresh();
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  const map = await store.get('tabTask', {});
  const here = tab ? matchTask(tab.url, s) || map[tab.id] || null : null;
  return {
    hub: !!s && Date.now() - (await store.get('hubOk', 0)) < 120e3,
    state: s, here, tabId: tab?.id, tabTitle: tab?.title, tabUrl: tab?.url,
    session: await store.get('session', null),
    lastResult: await store.get('lastResult', null),
    needsSignin: await store.get('needsSignin', false),
    syncing,
  };
}

browser.contextMenus.onClicked.addListener((info, tab) => {
  const text = (info.selectionText || tab?.title || '').trim().slice(0, 200);
  const url = info.linkUrl || info.pageUrl;
  if (text) hub('/api/quick', { text, extra: { url } }).then(() => setBadge('+')).then(() => setTimeout(() => setBadge(''), 2000)).catch(() => setBadge('!'));
});
