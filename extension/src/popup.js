// Toolbar popup: what this page is, today's list, the timer, quick add, sync.
const $ = (h) => { const t = document.createElement('template'); t.innerHTML = h.trim(); return t.content.firstChild; };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtMin = (m) => (m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60 ? String(m % 60).padStart(2, '0') : ''}`);
const ago = (t) => { if (!t) return 'never'; const m = (Date.now() - t) / 6e4; return m < 1 ? 'just now' : m < 60 ? `${Math.round(m)}m ago` : m < 2880 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`; };

async function render() {
  const p = await browser.runtime.sendMessage({ type: 'popup' });
  const s = p.state;
  const root = document.getElementById('root');
  root.innerHTML = '';
  const w = $('<div class="wrap"></div>');
  root.append(w);

  const last = s?.lastSync ? Date.parse(s.lastSync) : 0;
  const bad = p.lastResult && !p.lastResult.ok;
  w.append($(`<div class="head"><b>Load</b><span class="sp"></span>
    <span class="small">${p.syncing ? 'Syncing…' : `Synced ${ago(last)}`}</span>
    <span class="dot ${!p.hub ? 'bad' : bad ? 'bad' : 'ok'}" title="${!p.hub ? 'The Load hub on this Mac is not running' : ''}"></span></div>`));
  if (!p.hub) w.append($('<div class="err" style="margin:-4px 0 10px">The Load hub on this Mac is not answering. Run hub/install.sh once.</div>'));
  if (bad) w.append($(`<div class="err" style="margin:-4px 0 10px">Last sync: ${esc(p.lastResult.errors.join('; ')).slice(0, 160)}</div>`));

  const add = $('<form class="add"><input placeholder="Add a task…" autofocus /></form>');
  add.onsubmit = async (e) => {
    e.preventDefault();
    const v = add.querySelector('input').value.trim();
    if (!v) return;
    add.querySelector('input').value = '';
    await browser.runtime.sendMessage({ type: 'quick', text: v, extra: {} });
    render();
  };
  w.append(add);

  if (s?.timer) {
    const t = s.index.find((x) => x.id === s.timer.task) || s.today.find((x) => x.id === s.timer.task);
    const el = $(`<div class="timer"><span class="dot bad"></span><span class="t">${esc(t?.title || 'Timer running')}</span><span class="small" id="el"></span><button>Stop</button></div>`);
    const tickEl = () => { const sec = Math.floor((Date.now() - Date.parse(s.timer.s)) / 1000); el.querySelector('#el').textContent = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`; };
    tickEl(); setInterval(tickEl, 1000);
    el.querySelector('button').onclick = async () => { await browser.runtime.sendMessage({ type: 'timer', task: null }); render(); };
    w.append(el);
  } else if (p.session) {
    const t = s?.index.find((x) => x.id === p.session.task);
    w.append($(`<div class="timer" style="background:var(--soft)"><span class="dot ok"></span><span class="t">Tracking ${esc(t?.title || '')}</span><span class="small">${fmtMin(Math.max(1, Math.round((p.session.last - p.session.s) / 6e4)))}</span></div>`));
  }

  // This page: which task it counts toward, or pick one.
  if (p.tabUrl && /^https?:/.test(p.tabUrl) && s) {
    const t = p.here ? s.index.find((x) => x.id === p.here) : null;
    const here = $(`<div class="here"><div class="small">This page counts toward</div><div class="t">${t ? esc(t.title) : '<span class="small">nothing yet</span>'}</div></div>`);
    const sel = $('<select><option value="">Choose a task…</option></select>');
    for (const x of [...s.today, ...s.index.filter((i) => !s.today.some((y) => y.id === i.id))].slice(0, 60)) sel.append($(`<option value="${esc(x.id)}" ${x.id === p.here ? 'selected' : ''}>${esc(x.title)}</option>`));
    sel.onchange = async () => { await browser.runtime.sendMessage({ type: 'attach', tabId: p.tabId, task: sel.value || null }); render(); };
    here.append(sel);
    w.append(here);
  }

  w.append($('<div class="sect">Today</div>'));
  if (!s?.today?.length) w.append($('<div class="empty">Nothing planned.</div>'));
  for (const x of s?.today || []) {
    const row = $(`<div class="row"><span class="c" style="background:${esc(s.courses[x.course] || '#888')}"></span><span class="n">${esc(x.title)}</span><span class="m">${fmtMin(x.min)}</span><button class="p" title="Start timer">▶</button></div>`);
    row.querySelector('.p').onclick = async () => { await browser.runtime.sendMessage({ type: 'timer', task: x.id }); render(); };
    w.append(row);
  }

  const foot = $('<div class="foot"><button class="btn primary">Open Load</button><button class="btn">Sync now</button></div>');
  foot.children[0].onclick = () => browser.tabs.create({ url: 'http://127.0.0.1:8766/' });
  foot.children[1].onclick = async () => { await browser.runtime.sendMessage({ type: 'sync' }); setTimeout(render, 400); };
  w.append(foot);
}
render();
