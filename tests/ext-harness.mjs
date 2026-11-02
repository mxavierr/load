// Runs the built extension background (extension/dist/background.js) against a fake
// `browser` API and a real hub, and drives a full sync plus time tracking.
//   node tests/ext-harness.mjs http://127.0.0.1:8799 fixtures/snap-live.json fixtures/mylab-snap.json
import fs from 'node:fs';
import vm from 'node:vm';

const [hubUrl, snapPath, mylabPath] = process.argv.slice(2);
const snap = JSON.parse(fs.readFileSync(snapPath, 'utf8'));
const mylab = JSON.parse(fs.readFileSync(mylabPath, 'utf8')).mylab;

const listeners = {};
const on = (name) => ({ addListener: (f) => (listeners[name] ||= []).push(f), removeListener: (f) => (listeners[name] = (listeners[name] || []).filter((x) => x !== f)) });
const emit = (name, ...a) => (listeners[name] || []).map((f) => f(...a));
const storage = {};
const tabs = new Map([[1, { id: 1, url: 'https://purdue.brightspace.com/d2l/home', status: 'complete' }]]);
let nextTab = 10;
const log = [];
const browser = {
  runtime: { getManifest: () => ({ version: '1.1' }), onInstalled: on('installed'), onStartup: on('startup'), onMessage: on('message') },
  alarms: { create: (n, o) => log.push(`alarm ${n} ${o.periodInMinutes}m`), onAlarm: on('alarm') },
  contextMenus: { removeAll: async () => {}, create: () => {}, onClicked: on('menu') },
  action: { setBadgeText: async ({ text }) => log.push(`badge "${text}"`), setBadgeBackgroundColor: async () => {} },
  storage: { local: { get: async (k) => ({ [k]: storage[k] }), set: async (o) => Object.assign(storage, o) } },
  tabs: {
    query: async ({ url }) => [...tabs.values()].filter((t) => url ? t.url.startsWith(url.replace('/*', '')) : true),
    get: async (id) => tabs.get(id),
    create: async ({ url }) => { const t = { id: nextTab++, url, status: 'loading' }; tabs.set(t.id, t); log.push(`open tab ${url.slice(0, 70)}`); setTimeout(() => navigate(t, url), 50); return t; },
    update: async (id, { url }) => { const t = tabs.get(id); log.push(`navigate tab to ${url.slice(0, 70)}`); setTimeout(() => navigate(t, url), 50); return t; },
    remove: async (id) => { tabs.delete(id); log.push(`close tab ${id}`); },
    sendMessage: async (id, msg) => {
      const t = tabs.get(id);
      if (msg.type === 'ping') return { ok: true };
      if (msg.type === 'collect') { log.push(`collect in tab ${id}`); return { ...snap, at: new Date().toISOString() }; }
      if (msg.type === 'topicUrl') return { url: '/d2l/common/dialogs/quickLink/quickLink.d2l?ou=1638698&type=lti' };
      if (msg.type === 'parseMyLab') { if (!/DoAssignments/.test(t.url)) throw new Error('no receiver'); return { ok: true, rows: mylab.rows }; }
    },
    onUpdated: on('updated'), onCreated: on('created'), onRemoved: on('removed'),
  },
};
// Simulated redirects: the Brightspace LTI link lands on Pearson; the MyLab launch lands on DoAssignments.
function navigate(t, url) {
  let final = url;
  if (url.includes('quickLink')) final = 'https://console.pearson.com/courses/x/dashboard';
  if (url.includes('/links/assignments/launch')) final = 'https://mylab.pearson.com/Student/DoAssignments.aspx?view=all';
  Object.assign(t, { url: final, status: 'complete' });
  emit('updated', t.id, { status: 'complete' }, t);
}

const ctx = vm.createContext({ browser, fetch, console, setTimeout, clearTimeout, setInterval, Date, URL, __LOAD_HUB__: hubUrl });
vm.runInContext(fs.readFileSync(new URL('../extension/dist/background.js', import.meta.url), 'utf8'), ctx);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const send = (msg, tab) => new Promise((res) => { const r = emit('message', msg, { tab }, res); if (!r.includes(true)) res(); });

// 1. Ask for a sync the way the app does, then let the alarm fire.
await fetch(`${hubUrl}/api/ext`, { headers: { 'X-Load': '1' } });
const req = new Date().toISOString();
log.push(`sync requested ${req}`);
await fetch(`${hubUrl}/api/quick`, { method: 'POST', headers: { 'X-Load': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'harness marker' }) });
const db0 = await fetch(`${hubUrl}/gh/repos/test/load-data/contents/db.json`, { headers: { 'X-Load': '1' } }).then((r) => r.json());
// set syncRequest through the hub's data, as the app would
const doc = JSON.parse(Buffer.from(db0.content, 'base64').toString());
doc.settings.main.syncRequest = req; doc.settings.main._t.syncRequest = Date.now();
await fetch(`${hubUrl}/gh/repos/test/load-data/contents/db.json`, { method: 'PUT', headers: { 'X-Load': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'req', sha: db0.sha, content: Buffer.from(JSON.stringify(doc)).toString('base64') }) });
await sleep(300);
emit('alarm', { name: 'tick' });
for (let i = 0; i < 60 && !storage.lastResult; i++) await sleep(500);
log.push(`result ${JSON.stringify(storage.lastResult)}`);

// 2. Time tracking: 3 minutes of heartbeats on a dropbox page, then idle.
const st = await fetch(`${hubUrl}/api/ext`, { headers: { 'X-Load': '1' } }).then((r) => r.json());
const target = st.index.find((t) => t.keys.some((k) => k.startsWith('db=')));
const key = target.keys.find((k) => k.startsWith('db='));
const page = `https://purdue.brightspace.com/d2l/lms/dropbox/user/folder_submit_files.d2l?${key}&ou=1641950`;
const realNow = Date.now;
let fake = realNow();
ctx.Date.now = () => fake; // drive the clock
for (let s = 0; s <= 180; s += 20) { fake = realNow() + s * 1000; await send({ type: 'beat', url: page, title: 'x' }, { id: 1 }); }
log.push(`session open on ${storage.session?.task}`);
fake += 6 * 60e3; // walk away
emit('alarm', { name: 'tick' });
await sleep(1500);
log.push(`pending after flush ${JSON.stringify(storage.pending)}`);
const lg = await fetch(`${hubUrl}/gh/repos/test/load-data/contents/log.json`, { headers: { 'X-Load': '1' } }).then((r) => r.json());
const sessions = Object.values(JSON.parse(Buffer.from(lg.content, 'base64').toString()).sessions || {}).filter((s) => s.task === target.id);
log.push(`hub has ${sessions.length} session(s) for "${target.title}" lasting ${sessions.map((s) => Math.round((Date.parse(s.e) - Date.parse(s.s)) / 1000) + 's').join(',')}`);

// 3. The popup.
const pop = await send({ type: 'popup' });
log.push(`popup: hub ${pop.hub}, today ${pop.state.today.length}, lastResult ok ${pop.lastResult?.ok}`);
console.log(log.join('\n'));
process.exit(0);
