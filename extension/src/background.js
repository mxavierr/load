// Load for Safari: the twice-daily Brightspace + MyLab sync and automatic time tracking.
// It talks only to the Load hub on this Mac (127.0.0.1:8766), which owns the data.

const HUB = 'http://127.0.0.1:8766';
const BS = 'https://purdue.brightspace.com';
const ACTIVE_WINDOW = 10 * 60e3; // "in use" = activity in the last 10 minutes
const GAP = 5 * 60e3; // a pause longer than this ends a work session
const MIN_SESSION = 2 * 60e3;

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
    state = await hub('/api/ext');
    await store.set('state', state);
    await store.set('hubOk', Date.now());
  } catch {
    state = state || (await store.get('state', null));
  }
  return state;
}

/** The most recent scheduled sync time that has passed, as an epoch ms. */
function lastSlot(times, now = new Date()) {
  let best = 0;
  for (const day of [0, -1]) {
    for (const t of times || []) {
      const [h, m] = t.split(':').map(Number);
      const d = new Date(now);
      d.setDate(d.getDate() + day);
      d.setHours(h, m, 0, 0);
      if (d <= now && d.getTime() > best) best = d.getTime();
    }
  }
  return best;
}

async function tick() {
  const s = await refresh();
  await closeIdleSession();
  await flushSessions();
  if (!s) return;
  const lastSync = Date.parse(s.lastSync || 0) || 0;
  const lastTry = await store.get('lastTry', 0);
  const lastActive = await store.get('lastActive', 0);
  const requested = s.syncRequest && Date.parse(s.syncRequest) > lastSync && Date.parse(s.syncRequest) > lastTry;
  const due = lastSlot(s.settings?.syncTimes) > Math.max(lastSync, lastTry);
  const inUse = Date.now() - lastActive < ACTIVE_WINDOW;
  // A scheduled sync waits until you are actually at the Mac; one you asked for runs now.
  if (requested || (due && inUse)) await runSync(requested ? 'requested' : 'scheduled');
}

// ---------------------------------------------------------------- sync

let syncing = false;
async function runSync(reason) {
  if (syncing) return;
  syncing = true;
  await store.set('lastTry', Date.now());
  setBadge('…');
  const opened = [];
  try {
    const s = state || (await refresh());
    const cfg = { term: s?.settings?.term, extraOus: s?.settings?.extraOus };
    const tab = await brightspaceTab(opened);
    const snap = await sendWithRetry(tab.id, { type: 'collect', cfg }, 90e3);
    snap.reason = reason;
    if (!snap.ok && snap.errors?.includes('signed-out')) throw new Error('signed-out');
    snap.mylab = await readMyLab(tab.id, s?.settings?.mylab, opened).catch((e) => ({ ok: false, error: String(e.message || e) }));
    const report = await hub('/api/ingest', snap);
    await store.set('lastResult', { at: Date.now(), ok: report.ok, added: report.added?.length || 0, errors: report.errors || [] });
    setBadge(report.errors?.length ? '!' : '');
  } catch (e) {
    await store.set('lastResult', { at: Date.now(), ok: false, errors: [String(e.message || e)] });
    setBadge('!');
  } finally {
    for (const id of opened) browser.tabs.remove(id).catch(() => {});
    syncing = false;
  }
}

async function brightspaceTab(opened) {
  const tabs = await browser.tabs.query({ url: `${BS}/*` });
  for (const t of tabs) {
    try {
      await browser.tabs.sendMessage(t.id, { type: 'ping' });
      return t;
    } catch { /* tab without our script yet */ }
  }
  const t = await browser.tabs.create({ url: `${BS}/d2l/home`, active: false });
  opened.push(t.id);
  await waitFor(t.id, (u) => u.startsWith(BS), 45e3);
  await sleep(1500);
  return t;
}

async function readMyLab(bsTabId, ml, opened) {
  if (!ml?.ou || !ml?.topicId) return { ok: false, error: 'not configured' };
  const { url } = await browser.tabs.sendMessage(bsTabId, { type: 'topicUrl', ou: ml.ou, topicId: ml.topicId });
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
      const r = await browser.tabs.sendMessage(tabId, msg);
      if (r !== undefined) return r;
    } catch (e) { err = e; }
    await sleep(1500);
  }
  throw err || new Error('no answer from page');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function setBadge(text) {
  browser.action.setBadgeText({ text }).catch(() => {});
  if (text) browser.action.setBadgeBackgroundColor({ color: text === '!' ? '#e03e3e' : '#888' }).catch(() => {});
}

// ---------------------------------------------------------------- time tracking

/** Which task, if any, a page belongs to. */
function matchTask(url, s) {
  if (!s?.index || !url) return null;
  const bare = url.replace(/^https?:\/\//, '').split('#')[0];
  const hw = /doHomework\((\d+)/.exec(url) || /[?&](?:homeworkId|assignmentId|itemid)=(\d{6,})/i.exec(url);
  for (const t of s.index) {
    for (const k of t.keys) {
      if (k.startsWith('mylab:') ? hw && k === `mylab:${hw[1]}` : k.includes('=') ? new RegExp(`[?&]${k}(?:&|$)`).test(url) : bare.includes(k)) return t.id;
    }
  }
  return null;
}

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
  if (msg?.type === 'beat') { onBeat(msg, sender.tab).catch(() => {}); return false; }
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

async function onBeat({ url }, tab) {
  const now = Date.now();
  await store.set('lastActive', now);
  const s = state || (await store.get('state', null));
  if (s?.timer) return; // a timer you started yourself already covers this
  let task = matchTask(url, s);
  const map = await store.get('tabTask', {});
  if (task && tab?.id != null && map[tab.id] !== task) { map[tab.id] = task; await store.set('tabTask', map); }
  if (!task && tab?.id != null) task = map[tab.id] || null;
  let cur = await store.get('session', null);
  if (cur && (cur.task !== task || now - cur.last > GAP)) {
    await closeSession(cur);
    cur = null;
  }
  if (!task) { await store.set('session', null); return; }
  cur = cur || { task, s: now, last: now, url };
  cur.last = now;
  await store.set('session', cur);
}

async function closeSession(cur) {
  const end = cur.last + 20e3;
  if (end - cur.s < MIN_SESSION) return;
  const pending = await store.get('pending', []);
  pending.push({ id: `s:x${cur.s.toString(36)}`, task: cur.task, s: new Date(cur.s).toISOString(), e: new Date(end).toISOString(), src: 'auto', url: cur.url });
  await store.set('pending', pending);
}

async function closeIdleSession() {
  const cur = await store.get('session', null);
  if (cur && Date.now() - cur.last > GAP) {
    await closeSession(cur);
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
