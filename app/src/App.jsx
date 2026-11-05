import { useState, useEffect } from 'preact/hooks';
import { db, conn, ui, settings, timer, tasks, stopTimer, openPeek, setLayout, setSettings, setCourse, setGithubCreds, githubCreds, requestSync, findings, nowTick, log } from './state.js';
import { Icon, relTime } from './ui.jsx';
import { CommandBar } from './CommandBar.jsx';
import { Peek } from './Peek.jsx';
import { TodayBlock, UpcomingBlock, ClassesBlock, InsightsBlock, HealthBlock, NewsBlock } from './blocks.jsx';
import { GradesBlock } from './Grades.jsx';
import { live } from '../../shared/doc.js';
import { DOW, MONTHS, today as todayFn, weekday } from '../../shared/time.js';

const BLOCKS = {
  today: { title: 'Today', C: TodayBlock, span: 4 },
  upcoming: { title: 'Upcoming', C: UpcomingBlock, span: 5 },
  health: { title: 'Status', C: HealthBlock, span: 3 },
  classes: { title: 'Classes', C: ClassesBlock, span: 4 },
  grades: { title: 'Grades', C: GradesBlock, span: 6 },
  insights: { title: 'Insights', C: InsightsBlock, span: 4 },
  news: { title: 'Announcements', C: NewsBlock, span: 4 },
};
const DEFAULT_ORDER = ['today', 'upcoming', 'health', 'grades', 'classes', 'insights', 'news'];
const SPANS = [3, 4, 5, 6, 8, 12];

const isPhone = () => matchMedia('(max-width: 760px)').matches;

export function App() {
  const c = conn.value;
  if (c.mode === 'setup') return <Setup />;
  if (!db.value) return <div class="setup"><div class="working"><span class="spinner" />Loading…</div></div>;
  return (
    <>
      <div class="shell">
        <Top />
        <Board />
      </div>
      <Peek />
      {ui.value.settings && <Settings />}
      <Toast />
    </>
  );
}

function Top() {
  nowTick.value;
  const t = todayFn(settings.value.tz);
  const [y, m, d] = t.split('-').map(Number);
  const T = timer.value;
  const c = conn.value;
  const warn = findings.value.some((f) => f.level === 'error' || f.level === 'warn');
  return (
    <header class="top">
      <div class="topRow">
        <div>
          <div class="dateTitle">{DOW[weekday(t)]}, {MONTHS[m - 1]} {d}</div>
        </div>
        <div class="spacer" />
        {T && <TimerChip T={T} />}
        <button class="chipBtn" title={c.error === 'offline' ? 'Offline. Changes will sync when back.' : c.saving ? 'Saving' : 'Saved'} onClick={() => (c.error === 'auth' ? (conn.value = { ...conn.value, mode: 'setup' }) : document.getElementById('b-health')?.scrollIntoView({ behavior: 'smooth' }))}>
          <span class={`dot ${c.error ? 'err' : warn ? 'warn' : c.saving ? 'idle' : 'ok'}`} />
          <span class="dateSub">{c.error === 'offline' ? 'Offline' : c.error === 'auth' ? 'Sign in again' : c.saving ? 'Saving…' : 'Up to date'}</span>
        </button>
        <button class="iconBtn" onClick={() => (ui.value = { ...ui.value, settings: true })} aria-label="Settings"><Icon n="gear" /></button>
      </div>
      <CommandBar />
      <nav class="jump">
        {Object.entries(BLOCKS).map(([k, b]) => <button onClick={() => document.getElementById(`b-${k}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>{b.title}</button>)}
      </nav>
    </header>
  );
}

function TimerChip({ T }) {
  const [, force] = useState(0);
  useEffect(() => { const i = setInterval(() => force((x) => x + 1), 1000); return () => clearInterval(i); }, []);
  const s = Math.max(0, Math.floor((Date.now() - Date.parse(T.s)) / 1000));
  const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
  const t = tasks.value[T.task];
  return (
    <button class="timerChip" onClick={() => openPeek(T.task)} title="Open task">
      <span class="pulse" />
      <span>{hh ? `${hh}:` : ''}{String(mm).padStart(hh ? 2 : 1, '0')}:{String(ss).padStart(2, '0')}</span>
      <span class="t">{t?.title}</span>
      <span class="iconBtn" style={{ width: 22, height: 22, color: 'var(--red)' }} onClick={(e) => { e.stopPropagation(); stopTimer(); }} title="Stop"><Icon n="stop" size={12} /></span>
    </button>
  );
}

function Board() {
  const device = isPhone() ? 'mobile' : 'desktop';
  const L = db.value.layout?.[device] || {};
  // Saved order first, then any block it does not mention yet; a Set also repairs layouts
  // saved with duplicates by an earlier version.
  const order = [...new Set([...(L.order || []).filter((k) => BLOCKS[k]), ...DEFAULT_ORDER])];
  const spans = L.spans || {};
  const collapsed = L.collapsed || {};
  const [drag, setDrag] = useState(null);
  const [over, setOver] = useState(null);
  const save = (patch) => setLayout(device, { order, spans, collapsed, ...patch });

  const move = (from, to) => {
    if (from === to) return;
    const next = order.filter((k) => k !== from);
    next.splice(next.indexOf(to), 0, from);
    save({ order: next });
  };

  return (
    <main class="board">
      {order.map((k) => {
        const B = BLOCKS[k];
        const isCol = !!collapsed[k];
        const span = spans[k] || B.span;
        return (
          <section
            id={`b-${k}`}
            key={k}
            class={`block${isCol ? ' collapsed' : ''}${drag === k ? ' dragging' : ''}${over === k && drag && drag !== k ? ' dropBefore' : ''}`}
            style={{ '--span': span }}
            onDragOver={(e) => { if (drag) { e.preventDefault(); setOver(k); } }}
            onDrop={(e) => { if (drag) { e.preventDefault(); move(drag, k); setDrag(null); setOver(null); } }}
          >
            <div class="blockHead">
              <span class="grip" draggable onDragStart={(e) => { e.dataTransfer.setData('text/plain', k); setDrag(k); }} onDragEnd={() => { setDrag(null); setOver(null); }} title="Drag to move">
                <Icon n="grip" size={14} sw={2.4} />
              </span>
              <span class="blockTitle" onClick={() => save({ collapsed: { ...collapsed, [k]: !isCol } })}>
                {B.title}
                <Icon n="caret" size={12} style={{ transform: isCol ? 'rotate(-90deg)' : '', transition: 'transform .15s', color: 'var(--text-3)' }} />
                <BlockCount k={k} />
              </span>
              <span class="blockTools">
                <button class="iconBtn wide" title="Width" onClick={() => save({ spans: { ...spans, [k]: SPANS[(SPANS.indexOf(span) + 1) % SPANS.length] } })}><Icon n="wide" size={14} /></button>
              </span>
            </div>
            <div class="blockBody"><B.C cfg={db.value.layout?.[k]} /></div>
          </section>
        );
      })}
    </main>
  );
}

function BlockCount({ k }) {
  const T = live(tasks.value);
  if (k === 'upcoming') return <span class="count">{T.filter((t) => !t.done && t.due).length}</span>;
  if (k === 'health') {
    const n = findings.value.filter((f) => f.level === 'warn' || f.level === 'error').length;
    return n ? <span class="count" style={{ color: 'var(--orange)' }}>{n}</span> : null;
  }
  return null;
}

function Toast() {
  const t = ui.value.toast;
  if (!t) return null;
  return (
    <div class="toast" role="status">
      <span>{t.text}</span>
      {t.action && <button onClick={() => { t.action.run(); ui.value = { ...ui.value, toast: null }; }}>{t.action.label}</button>}
    </div>
  );
}

function Settings() {
  const s = settings.value;
  const close = () => (ui.value = { ...ui.value, settings: false });
  const cs = live(db.value.courses);
  const gh = githubCreds();
  return (
    <>
      <div class="scrim" onClick={close} style={{ zIndex: 60 }} />
      <div class="modal" role="dialog">
        <h2>Settings</h2>
        <div class="field">
          <label>Courses</label>
          <div class="cgrid">
            {cs.map((c) => (
              <>
                <input type="color" value={c.color} onChange={(e) => setCourse(c.id, { color: e.target.value })} />
                <input value={c.name} onChange={(e) => setCourse(c.id, { name: e.target.value })} style={{ height: 30 }} />
                <input value={(c.aliases || []).join(', ')} title="Words that mean this course in the command bar" onChange={(e) => setCourse(c.id, { aliases: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} style={{ height: 30 }} />
                <label style={{ display: 'flex', gap: 4, alignItems: 'center', fontSize: 12 }}><input type="checkbox" checked={c.include !== false} onChange={(e) => setCourse(c.id, { include: e.target.checked })} />Show</label>
              </>
            ))}
          </div>
          <small>Colour · name · words that mean this course when you type a task.</small>
        </div>
        <div class="field">
          <label>Time you have for schoolwork (minutes)</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input type="number" value={s.capacity.weekday} onChange={(e) => setSettings({ capacity: { ...s.capacity, weekday: +e.target.value } })} placeholder="weekdays" />
            <input type="number" value={s.capacity.weekend} onChange={(e) => setSettings({ capacity: { ...s.capacity, weekend: +e.target.value } })} placeholder="weekends" />
          </div>
          <small>Weekdays · weekends. Today's list spreads big work so no day goes over this.</small>
        </div>
        <div class="field">
          <label>Brightspace sync times</label>
          <input value={s.syncTimes.join(', ')} onChange={(e) => setSettings({ syncTimes: e.target.value.split(',').map((x) => x.trim()).filter((x) => /^\d\d:\d\d$/.test(x)) })} />
          <small>Runs at these times while the Mac is in use; catches up if it was asleep.</small>
        </div>
        <div class="field">
          <label>Skip items whose title contains</label>
          <input value={s.ignore.join(', ')} onChange={(e) => setSettings({ ignore: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} />
        </div>
        <div class="field">
          <label>Phone access</label>
          {conn.value.mode === 'hub' ? (
            <small>On the Mac, nothing to set. On your phone, open the GitHub Pages address and paste a token there.</small>
          ) : (
            <>
              <input value={gh?.repo || 'mxavierr/load-data'} onChange={(e) => setGithubCreds({ ...(gh || {}), repo: e.target.value })} />
              <button class="btn subtle danger" style={{ justifySelf: 'start' }} onClick={() => { setGithubCreds(null); location.reload(); }}>Sign out on this device</button>
            </>
          )}
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
          <button class="btn" onClick={requestSync}>Sync now</button>
          <button class="btn primary" onClick={close}>Done</button>
        </div>
      </div>
    </>
  );
}

function Setup() {
  const [token, setToken] = useState('');
  const [repo, setRepo] = useState(githubCreds()?.repo || 'mxavierr/load-data');
  return (
    <div class="setup">
      <h1>Load</h1>
      <p>Connect this device to your task data. Paste a GitHub fine-grained token that can read and write only the <b>{repo}</b> repository.</p>
      <div class="field"><label>Token</label><input type="password" value={token} onInput={(e) => setToken(e.target.value)} autocomplete="off" placeholder="github_pat_…" /></div>
      <div class="field"><label>Data repository</label><input value={repo} onInput={(e) => setRepo(e.target.value)} /></div>
      <button class="btn primary" disabled={!token.trim()} onClick={() => { setGithubCreds({ ...(githubCreds() || {}), token: token.trim(), repo: repo.trim() }); location.reload(); }}>Connect</button>
      <p style={{ fontSize: 12.5, marginTop: 18 }}>The token stays on this device. github.com › Settings › Developer settings › Fine-grained tokens › only this repository › Contents: read and write.</p>
    </div>
  );
}
