// Load for Safari: the twice-daily Brightspace + MyLab sync and automatic time tracking.
// It talks only to the Load hub on this Mac (127.0.0.1:8766), which owns the data.

import { shouldSync, matchTask as match, beat, close, GAP } from './logic.js';

const HUB = globalThis.__LOAD_HUB__ || 'http://127.0.0.1:8766'; // overridable for tests
const BS = 'https://purdue.brightspace.com';
const VERSION = browser.runtime.getManifest().version;

const store = {
  async get(k, d) { const r = await browser.storage.local.get(k); return r[k] ?? d; },
  set(k, v) { return browser.storage.local.set({ [k]: v }); },
};

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
  if (!s) return;
  const why = shouldSync({
    times: s.settings?.syncTimes, lastSync: s.lastSync, request: s.syncRequest,
    lastTry: await store.get('lastTry', 0), lastActive: await store.get('lastActive', 0),
  });
  if (why) await runSync(why);
}

// ---------------------------------------------------------------- sync

let syncing = 0;
async function runSync(reason) {
  // A sync that somehow never finishes must not block every later one.
  if (syncing && Date.now() - syncing < 6 * 60e3) return;
  syncing = Date.now();
  hub('/api/ext/report', { at: new Date().toISOString(), reason, started: true, access: await siteAccess() }).catch(() => {});
  return within(6 * 60e3, sync(reason), 'sync').catch(async (e) => {
    await store.set('lastResult', { at: Date.now(), ok: false, errors: [String(e.message || e)] });
    hub('/api/ext/report', { at: new Date().toISOString(), reason, error: String(e.message || e) }).catch(() => {});
  }).finally(() => { syncing = 0; });
}

async function sync(reason) {
  await store.set('lastTry', Date.now());
  setBadge('…');
  const opened = [];
  let step = 'checking access';
  try {
    const s = state || (await refresh());
    const cfg = { term: s?.settings?.term, extraOus: s?.settings?.extraOus };
    const access = await siteAccess();
    if (access.brightspace === false) throw new Error('Safari has not given Load access to purdue.brightspace.com');
    step = 'finding a Brightspace tab';
    const tab = await brightspaceTab(opened);
    step = 'reading Brightspace';
    const head = await sendWithRetry(tab.id, { type: 'collect', cfg }, 120e3);
    step = `fetching ${head.chunks} part(s) of the Brightspace data`;
    let text = '';
    for (let i = 0; i < head.chunks; i++) text += (await ask(tab.id, { type: 'chunk', i }, 15000)).data || '';
    if (text.length !== head.size) throw new Error(`got ${text.length} of ${head.size} bytes`);
    const snap = JSON.parse(text);
    snap.reason = reason;
    // Time not sent to the hub yet still counts: sync must not tick work in progress.
    const open = await store.get('session', null);
    snap.tracking = [...new Set([open?.task, ...(await store.get('pending', [])).map((p) => p.task)].filter(Boolean))];
    if (!snap.ok && snap.errors?.includes('signed-out')) throw new Error('signed-out');
    step = 'reading MyLab';
    snap.mylab = await readMyLab(tab.id, s?.settings?.mylab, opened).catch((e) => ({ ok: false, error: String(e.message || e) }));
    step = 'saving';
    const report = await hub('/api/ingest', snap);
    await store.set('lastResult', { at: Date.now(), ok: report.ok, added: report.added?.length || 0, errors: report.errors || [] });
    setBadge(report.errors?.length ? '!' : '');
  } catch (e) {
    const msg = `${step}: ${String(e.message || e)}`;
    await store.set('lastResult', { at: Date.now(), ok: false, errors: [msg] });
    hub('/api/ext/report', { at: new Date().toISOString(), reason, error: msg, access: await siteAccess() }).catch(() => {});
    setBadge('!');
  } finally {
    for (const id of opened) browser.tabs.remove(id).catch(() => {});
  }
}

/** Whether Safari lets the extension run on the sites a sync needs (null = cannot tell). */
async function siteAccess() {
  const has = async (o) => { try { return await browser.permissions.contains({ origins: [o] }); } catch { return null; } };
  return { brightspace: await has(`${BS}/*`), mylab: await has('https://mylab.pearson.com/*') };
}

async function brightspaceTab(opened) {
  const tabs = await browser.tabs.query({ url: `${BS}/*` });
  for (const t of tabs) {
    try {
      await ask(t.id, { type: 'ping' }, 3000);
      return t;
    } catch { /* tab opened before the extension was turned on: add our script to it */ }
    try {
      await within(5000, browser.scripting.executeScript({ target: { tabId: t.id }, files: ['brightspace.js'] }), 'inject');
      await sleep(300);
      await ask(t.id, { type: 'ping' }, 3000);
      return t;
    } catch { /* try the next tab */ }
  }
  const t = await browser.tabs.create({ url: `${BS}/d2l/home`, active: false });
  opened.push(t.id);
  await waitFor(t.id, (u) => u.startsWith(BS), 45e3);
  await sleep(1500);
  return t;
}

async function readMyLab(bsTabId, ml, opened) {
  if (!ml?.ou || !ml?.topicId) return { ok: false, error: 'not configured' };
  const { url } = await ask(bsTabId, { type: 'topicUrl', ou: ml.ou, topicId: ml.topicId }, 15000);
  if (!url) throw new Error('MyLab link not found');
  // The course's Pearson link signs you in to Pearson; the assignments page then opens in the same tab.
  const t = await browser.tabs.create({ url: BS + url, active: false });
  opened.push(t.id);
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
  if (msg?.type === 'timer') { hub('/api/timer', { task: msg.task || null }).then(refresh).then(() => reply({ ok: true }), (e) => reply({ ok: false, error: String(e) })); return true; }
  if (msg?.type === 'quick') { hub('/api/quick', { text: msg.text, extra: msg.extra }).then((t) => reply({ ok: true, task: t }), (e) => reply({ ok: false, error: String(e) })); return true; }
  if (msg?.type === 'attach') { attachTab(msg.tabId, msg.task).then(() => reply({ ok: true })); return true; }
});

async function attachTab(tabId, task) {
  const map = await store.get('tabTask', {});
  if (task) map[tabId] = task; else delete map[tabId];
  await store.set('tabTask', map);
}

let beats = Promise.resolve();
async function onBeat({ url }, tab, now = Date.now()) {
  await store.set('lastActive', now);
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
    syncing,
  };
}

browser.contextMenus.onClicked.addListener((info, tab) => {
  const text = (info.selectionText || tab?.title || '').trim().slice(0, 200);
  const url = info.linkUrl || info.pageUrl;
  if (text) hub('/api/quick', { text, extra: { url } }).then(() => setBadge('+')).then(() => setTimeout(() => setBadge(''), 2000)).catch(() => setBadge('!'));
});
