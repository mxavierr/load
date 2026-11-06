// Drives the built extension background through the ways a sync can go wrong, against a
// simulated Safari and a throwaway hub:
//   node tests/ext-scenarios.mjs http://127.0.0.1:8799 fixtures/snap-live.json fixtures/mylab-snap.json
import fs from 'node:fs';
import vm from 'node:vm';

const [hubUrl, snapPath, mylabPath] = process.argv.slice(2);
if (!hubUrl || /:8766\b/.test(hubUrl)) { console.error('Use a throwaway hub, never the live one (8766).'); process.exit(1); }
const snap = JSON.parse(fs.readFileSync(snapPath, 'utf8'));
const mylab = JSON.parse(fs.readFileSync(mylabPath, 'utf8')).mylab;
const CODE = fs.readFileSync(new URL('../extension/dist/background.js', import.meta.url), 'utf8');
const BS = 'https://purdue.brightspace.com';
const LOGIN = 'https://login.microsoftonline.com/saml2?SAMLRequest=abc';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const H = { 'X-Load': '1', 'Content-Type': 'application/json' };

// One simulated Safari; `start()` loads a background page into it, as Safari does after shutting one down.
function safari() {
  const world = {
    storage: {}, tabs: new Map(), next: 10, log: [], reports: [],
    session: 'live', // live | sso (renews silently) | none (needs a person)
    apiSignedOut: false, scriptMode: 'ok', myLabThrows: false, failIngests: 0, warp: 1, offset: 0, t0: Date.now(),
  };
  const now = () => { const r = Date.now(); return r + world.offset + (r - world.t0) * (world.warp - 1); };
  world.setWarp = (w) => { world.offset = now() - Date.now(); world.t0 = Date.now(); world.warp = w; };
  let held = null;
  const pages = new Map(); // which tabs have a script that has been injected by hand
  world.start = () => {
    const L = {};
    world.L = L;
    const on = (n) => ({ addListener: (f) => (L[n] ||= []).push(f), removeListener: (f) => { L[n] = (L[n] || []).filter((x) => x !== f); } });
    const emit = (n, ...a) => (L[n] || []).map((f) => f(...a));
    world.emit = emit;
    const land = (t, url) => {
      const set = (u) => { Object.assign(t, { url: u, status: 'complete' }); emit('updated', t.id, { status: 'complete' }, t); };
      if (url.includes('quickLink')) return set('https://console.pearson.com/courses/x/dashboard');
      if (url.includes('/links/assignments/launch')) return set('https://mylab.pearson.com/Student/DoAssignments.aspx?view=all');
      if (url.startsWith(BS) && world.session === 'none') return set(LOGIN);
      if (url.startsWith(BS) && world.session === 'sso') { set(LOGIN); setTimeout(() => { if (world.tabs.has(t.id)) set(url); }, 2500); return; }
      set(url);
    };
    const browser = {
      runtime: { getManifest: () => ({ version: 'test' }), onInstalled: on('installed'), onStartup: on('startup'), onMessage: on('message') },
      alarms: { create: () => {}, onAlarm: on('alarm') },
      contextMenus: { removeAll: async () => {}, create: () => {}, onClicked: on('menu') },
      action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
      permissions: { contains: async () => true },
      scripting: { executeScript: async ({ target }) => { pages.set(target.tabId, true); world.log.push(`inject ${target.tabId}`); return []; } },
      storage: { local: { get: async (k) => ({ [k]: world.storage[k] }), set: async (o) => Object.assign(world.storage, JSON.parse(JSON.stringify(o))) } },
      tabs: {
        query: async () => [...world.tabs.values()],
        get: async (id) => { if (!world.tabs.has(id)) throw new Error('no tab'); return world.tabs.get(id); },
        create: async ({ url }) => { const t = { id: world.next++, url, status: 'loading' }; world.tabs.set(t.id, t); world.log.push(`open ${t.id}`); setTimeout(() => land(t, url), 30); return t; },
        update: async (id, { url }) => { const t = world.tabs.get(id); if (!t) throw new Error('Tab not found'); if (url) setTimeout(() => land(t, url), 30); return t; },
        remove: async (id) => { world.tabs.delete(id); world.log.push(`close ${id}`); },
        sendMessage: async (id, msg) => {
          const t = world.tabs.get(id);
          if (!t) throw new Error('no tab');
          if (t.dead) return undefined; // a script orphaned by an extension update
          if (msg.type === 'parseMyLab') { if (world.myLabThrows) throw new Error('mylab broke'); return { ok: true, rows: mylab.rows }; }
          if (!t.url.startsWith(BS)) return undefined; // no listener on other sites
          if (world.scriptMode === 'silent' && !pages.get(id)) return undefined;
          if (msg.type === 'ping') return { ok: true };
          if (msg.type === 'collect') {
            world.log.push(`collect ${id}`);
            const s = world.apiSignedOut ? { ok: false, errors: ['signed-out'], courses: [] } : { ...snap, at: new Date().toISOString() };
            held = JSON.stringify(s);
            return { chunks: Math.ceil(held.length / 150000), size: held.length, ok: s.ok };
          }
          if (msg.type === 'chunk') return { i: msg.i, data: held.slice(msg.i * 150000, (msg.i + 1) * 150000) };
          if (msg.type === 'topicUrl') return { url: '/d2l/common/dialogs/quickLink/quickLink.d2l?ou=1638698&type=lti' };
        },
        onUpdated: on('updated'), onCreated: on('created'), onRemoved: on('removed'),
      },
    };
    const myFetch = (url, opts) => {
      if (String(url).endsWith('/api/ingest') && world.failIngests > 0) { world.failIngests--; world.log.push('ingest refused'); return Promise.resolve(new Response('{}', { status: 500 })); }
      if (String(url).endsWith('/api/ext/report')) { const b = JSON.parse(opts.body); if (!b.started) world.reports.push(b); }
      return fetch(url, opts);
    };
    const FakeDate = class extends Date { constructor(...a) { if (a.length) super(...a); else super(now()); } static now() { return now(); } };
    const ctx = vm.createContext({ browser, fetch: myFetch, console, setTimeout, clearTimeout, setInterval, clearInterval, Date: FakeDate, URL, __LOAD_HUB__: hubUrl });
    vm.runInContext(CODE, ctx);
  };
  world.tick = () => world.emit('alarm', { name: 'tick' });
  world.popupSync = () => new Promise((res) => { world.emit('message', { type: 'sync' }, {}, res); });
  // A run is over when it has written a result newer than `since` and cleared its record.
  world.done = async (since) => {
    for (let i = 0; i < 400; i++) {
      if (world.storage.lastResult && world.storage.lastResult.at >= since && !world.storage.run) return;
      await sleep(100);
    }
    throw new Error('run never finished');
  };
  return world;
}

const hubState = () => fetch(`${hubUrl}/api/ext`, { headers: H }).then((r) => r.json());
const dataFile = async (f) => JSON.parse(Buffer.from((await fetch(`${hubUrl}/gh/repos/test/load-data/contents/${f}.json`, { headers: H }).then((r) => r.json())).content, 'base64').toString());
const records = async () => Object.values((await dataFile('log')).syncs || {}).filter((s) => !s.deleted && s.kind !== 'migration').length;

let failures = 0;
const check = (name, ok, extra = '') => { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? ` (${extra})` : ''}`); if (!ok) failures++; };
const scenario = (title) => console.log(`\n${title}`);
const go = async (w) => { const t = (w.storage.lastResult?.at ?? -1) + 1; await w.popupSync(); await w.done(t); };

// ---------------------------------------------------------------- 1
scenario('1. An old Brightspace tab whose script no longer answers (what broke on Nov 5)');
{
  const w = safari();
  w.tabs.set(1, { id: 1, url: `${BS}/d2l/home`, status: 'complete', dead: true });
  w.start();
  const n0 = await records();
  const started = Date.now();
  await go(w);
  check('saved, reading through a fresh tab', w.storage.lastResult.ok === true && w.log.some((l) => /^collect 1\d$/.test(l)), JSON.stringify(w.storage.lastResult.errors));
  check('never read through the dead tab', !w.log.includes('collect 1'));
  check('your own tab was left open, its own tabs closed', w.tabs.size === 1 && w.tabs.has(1), `tabs ${[...w.tabs.keys()]}`);
  check('Brightspace and MyLab saved separately', (await records()) - n0 === 2, `+${(await records()) - n0}`);
  check('took seconds, not a 2-minute timeout', Date.now() - started < 30e3, `${Math.round((Date.now() - started) / 1000)}s`);
  const s = await hubState();
  check('hub knows both dates', !!s.lastSync && !!s.lastMyLab);
}

// ---------------------------------------------------------------- 2
scenario('2. MyLab cadence');
{
  const w = safari();
  w.start();
  w.storage.lastTry = 0;
  const n0 = await records();
  w.setWarp(1); w.offset = 13 * 3600e3; // 13 hours later: a slot has passed
  const t = Date.now() + w.offset;
  await w.emit('message', { type: 'noop' }, {}, () => {});
  w.tick();
  await w.done(t);
  check('scheduled sync skips MyLab when it was read recently', (await records()) - n0 === 1 && !w.log.some((l) => l === 'open 11'), `+${(await records()) - n0}, ${w.log.join(' ')}`);
  w.offset = 8 * 864e5;
  w.storage.lastTry = 0; w.storage.lastMyLabTry = 0;
  const t2 = Date.now() + w.offset, n1 = await records();
  w.tick();
  await w.done(t2);
  check('reads MyLab after a week', (await records()) - n1 === 2, `+${(await records()) - n1}`);
}

// ---------------------------------------------------------------- 3
scenario('3. Idle session that the university login renews by itself');
{
  const w = safari();
  w.session = 'sso';
  w.start();
  await go(w);
  check('saved with no help from you', w.storage.lastResult.ok === true && !w.storage.needsSignin, JSON.stringify(w.storage.lastResult.errors));
}

// ---------------------------------------------------------------- 4
scenario('4. Really signed out, then you sign in');
{
  const w = safari();
  w.session = 'none';
  w.setWarp(6); // the 40 s wait passes in about 7
  w.start();
  await go(w);
  check('asks for a sign-in instead of failing vaguely', w.storage.needsSignin === true && w.storage.lastResult.signin === true);
  check('one sign-in page stays open', w.tabs.size === 1 && w.tabs.has(w.storage.signinTab), `tabs ${[...w.tabs.keys()]}`);
  const rep = w.reports.at(-1);
  check('hub is told why and where', rep?.kind === 'signin' && rep?.where === 'login.microsoftonline.com/saml2' && !rep.where.includes('SAML'), rep?.where);
  await sleep(300);
  const db = await dataFile('db');
  check('app can show it', db.settings.main.extError?.kind === 'signin');

  const kept = w.storage.signinTab;
  await go(w);
  check('checking again adds no second sign-in page', w.tabs.size === 1 && w.storage.signinTab === kept, `tabs ${[...w.tabs.keys()]}`);
  const unchanged = w.tabs.get(kept).url === LOGIN;
  check('the page you might be typing in was not reloaded', unchanged);

  // You sign in: the page lands on Brightspace. Past the short cooldown, it syncs by itself.
  w.setWarp(1); w.offset += 3 * 60e3;
  w.session = 'live';
  const t = Date.now() + w.offset;
  const page = w.tabs.get(kept);
  Object.assign(page, { url: `${BS}/d2l/home`, status: 'complete' });
  w.emit('updated', kept, { status: 'complete' }, page);
  await w.done(t);
  check('syncs by itself after you sign in', w.storage.lastResult.ok === true && w.storage.needsSignin === false, JSON.stringify(w.storage.lastResult));
  check('leaves you on the page you signed in on', w.tabs.has(kept) && w.tabs.size === 1);
  await sleep(300);
  check('app error clears', !(await dataFile('db')).settings.main.extError);
}

// ---------------------------------------------------------------- 5
scenario('5. Sign-in finished while a check was running (the page load went unseen)');
{
  const w = safari();
  w.session = 'none';
  w.setWarp(6);
  w.start();
  await go(w);
  w.setWarp(1); w.offset += 3 * 60e3;
  w.session = 'live';
  Object.assign(w.tabs.get(w.storage.signinTab), { url: `${BS}/d2l/home`, status: 'complete' }); // no event
  const t = Date.now() + w.offset;
  w.tick();
  await w.done(t);
  check('the next tick notices and syncs', w.storage.lastResult.ok === true && w.storage.needsSignin === false, JSON.stringify(w.storage.lastResult));
}

// ---------------------------------------------------------------- 6
scenario('6. Brightspace loads but its API says signed out');
{
  const w = safari();
  w.apiSignedOut = true;
  w.start();
  await go(w);
  check('treated as needing a sign-in', w.storage.needsSignin === true && w.reports.at(-1)?.where === 'the Brightspace API');
  for (const id of w.tabs.keys()) w.tabs.delete(id);
}

// ---------------------------------------------------------------- 7
scenario('7. Safari shuts the background page down mid-sync');
{
  const w = safari();
  w.tabs.set(50, { id: 50, url: `${BS}/d2l/home`, status: 'complete' });
  w.storage.run = { at: Date.now(), reason: 'scheduled', step: 'reading Brightspace', tabs: [50] };
  w.storage.lastTry = Date.now();
  w.start(); // a new background page
  const t = Date.now();
  w.tick();
  await w.done(t);
  check('next start closes the leftover tab', !w.tabs.has(50));
  check('says where it stopped', w.reports.at(-1)?.error === 'interrupted while reading Brightspace', w.reports.at(-1)?.error);

  const v = safari();
  v.tabs.set(51, { id: 51, url: 'https://mylab.pearson.com/x', status: 'complete' });
  v.storage.run = { at: Date.now(), reason: 'scheduled', step: 'reading MyLab', saved: true, tabs: [51] };
  v.storage.lastTry = Date.now();
  v.start();
  v.tick();
  await sleep(500);
  check('stopping during MyLab is not a failed sync', !v.tabs.has(51) && !v.reports.length && !v.storage.run);
}

// ---------------------------------------------------------------- 8
scenario('8. Hub or GitHub hiccup while saving');
{
  const w = safari();
  w.failIngests = 1;
  w.start();
  await go(w);
  check('retries instead of losing the read', w.storage.lastResult.ok === true && w.log.includes('ingest refused'), JSON.stringify(w.storage.lastResult.errors));
}

// ---------------------------------------------------------------- 9
scenario('9. MyLab breaks');
{
  const w = safari();
  w.myLabThrows = true;
  w.setWarp(4);
  w.start();
  const before = (await hubState()).lastSync;
  await go(w);
  const s = await hubState();
  check('Brightspace still saved', s.lastSync !== before);
  check('MyLab reported as an error, tabs closed', w.storage.lastResult.errors.some((e) => /MyLab/.test(e)) && w.tabs.size === 0, JSON.stringify(w.storage.lastResult.errors));
}

// ---------------------------------------------------------------- 10
scenario('10. A fresh tab whose script is slow or silent');
{
  const w = safari();
  w.scriptMode = 'silent';
  w.setWarp(4);
  w.start();
  await go(w);
  check('adds the script itself and carries on', w.storage.lastResult.ok === true && w.log.some((l) => l.startsWith('inject')), JSON.stringify(w.storage.lastResult.errors));
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll scenarios passed');
process.exit(failures ? 1 : 0);
