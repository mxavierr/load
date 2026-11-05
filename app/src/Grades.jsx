import { useState } from 'preact/hooks';
import { db, library, tasks, settings, courses, setWhatIf, toast, nowTick } from './state.js';
import { Icon, CoursePill, courseColor, relTime, Empty } from './ui.jsx';
import { live } from '../../shared/doc.js';
import { GRADING, estimateCourse, recentlyGraded, hasWhatIf, setWhatIfValue } from '../../shared/grades.js';
import { nowLocal } from '../../shared/time.js';

const pct = (v, d = 1) => (v == null ? '–' : `${v.toFixed(d)}%`);
const shortName = (n) => n.replace(/^PHYS 172 - FA\d\d - /, '').replace(/ : UPLOAD$/, '');

/** A percent box. Empty means "use the real number"; the placeholder shows what that is. */
function ScoreInput({ value, placeholder, onSet, label, unit = '%', max = 150 }) {
  const [draft, setDraft] = useState(null);
  const shown = draft ?? (value == null ? '' : String(Math.round(value * 100) / 100));
  return (
    <span class={`grInput${value != null ? ' on' : ''}`}>
      <input
        type="number" inputMode="decimal" min="0" max={max} step="any" aria-label={label}
        value={shown} placeholder={placeholder}
        onInput={(e) => {
          const raw = e.target.value;
          setDraft(raw);
          const n = parseFloat(raw);
          if (raw === '') onSet(null);
          else if (isFinite(n) && n >= 0 && n <= max) onSet(n);
        }}
        onBlur={() => setDraft(null)}
      />
      <em>{unit}</em>
    </span>
  );
}

export function GradesBlock() {
  nowTick.value;
  const [open, setOpen] = useState({});
  const rowsBy = new Map();
  for (const c of live(library.value?.courses)) {
    if (c.course && GRADING[c.course]) rowsBy.set(c.course, [...(rowsBy.get(c.course) || []), ...(c.grades || [])]);
  }
  const ctx = { tasks: live(tasks.value), now: nowLocal(settings.value.tz) };
  const ids = Object.keys(GRADING).filter((id) => courses.value[id]?.include !== false);
  const recent = ids.flatMap((id) => recentlyGraded(rowsBy.get(id) || []).map((r) => ({ ...r, course: id })))
    .sort((a, b) => (a.mod < b.mod ? 1 : -1)).slice(0, 8);
  const anyDates = ids.some((id) => (rowsBy.get(id) || []).some((r) => r.mod));

  return (
    <div>
      <div class="groupHead">Just graded <span class="sub">last 7 days</span></div>
      {recent.length ? recent.map((r) => (
        <div key={r.course + r.name} class="grRecent">
          <CoursePill id={r.course} />
          <span class="nm">{shortName(r.name)}</span>
          <span class="when">{relTime(r.mod)}</span>
          <b>{r.shown || pct((100 * r.num) / r.den, 0)}</b>
        </div>
      )) : <div class="grHint">{anyDates ? 'Nothing new this week.' : 'Grade dates appear after the next sync.'}</div>}

      <div class="groupHead" style={{ marginTop: 6 }}>Courses</div>
      {ids.map((id) => (
        <CourseGrade key={id} id={id} rows={rowsBy.get(id) || []} ctx={ctx} isOpen={!!open[id]} toggle={() => setOpen((o) => ({ ...o, [id]: !o[id] }))} />
      ))}
    </div>
  );
}

function CourseGrade({ id, rows, ctx, isOpen, toggle }) {
  const cfg = GRADING[id];
  const wi = db.value?.grading?.[id]?.whatIf || {};
  const active = hasWhatIf(wi);
  const real = estimateCourse(cfg, rows, {}, ctx);
  const est = active ? estimateCourse(cfg, rows, wi, ctx) : real;
  const delta = active && est.projected != null && real.projected != null ? est.projected - real.projected : null;
  const set = (group, key, value) => setWhatIf(id, setWhatIfValue(wi, group, key, value));

  return (
    <div class="courseCard">
      <div class="courseHead" onClick={toggle}>
        <Icon n="right" size={12} style={{ color: 'var(--text-3)', transform: isOpen ? 'rotate(90deg)' : '', transition: 'transform .15s' }} />
        <span class="swatch" style={{ background: courseColor(id) }} />
        <span class="courseName">{courses.value[id]?.name || id}</span>
        {active && <span class="tag blue">What-if</span>}
        <span class="grade">{est.projected == null ? 'No grades yet' : <><b class="grLetter">{est.letter}</b> {pct(est.projected)}</>}</span>
      </div>
      {isOpen && (
        <div class="grBody">
          <div class="kpis">
            <div class="kpi"><b>{pct(real.soFar)}</b><span>grade so far</span></div>
            <div class="kpi grKpi">
              <b>{pct(est.projected)}</b>
              <span>{active ? `what-if · ${delta >= 0 ? '+' : ''}${delta?.toFixed(1)} vs real` : 'estimated final'}</span>
            </div>
            <div class="kpi"><b class="grRange">{Math.round(est.lowest)}–{Math.round(est.highest)}</b><span>{Math.round(est.decided)}% decided</span></div>
          </div>

          {est.needs.length > 0 && (
            <div class="grNeeds">
              <span class="lbl">On everything left, you need</span>
              {pickNeeds(est).map((n) => <span key={n.l} class="tag"><b>{n.l}</b>&nbsp;{Math.ceil(n.need - 0.01)}%</span>)}
            </div>
          )}

          {est.cats.map((c) => <CategoryRow key={c.id} c={c} set={set} />)}

          <div class="grFoot">
            {active && <button class="mini" onClick={() => { setWhatIf(id, null); toast('What-ifs cleared'); }}><Icon n="undo" size={11} /> Back to real grades</button>}
            <small>Type any score to try a what-if; it never touches your real grades. Empty boxes use your average in that category.</small>
            <small>From {cfg.source}. {cfg.note}</small>
          </div>
        </div>
      )}
    </div>
  );
}

/** The letters around where you're headed, best first. */
function pickNeeds(est) {
  const i = est.needs.findIndex((n) => n.min <= (est.projected ?? 0));
  const at = i < 0 ? est.needs.length : i;
  return est.needs.slice(Math.max(0, at - 3), at + 1);
}

function CategoryRow({ c, set }) {
  const [open, setOpen] = useState(false);
  if (c.kind === 'bonus') {
    return (
      <div class="grCat">
        <div class="grRow">
          <span class="nm">{c.name}<small>on top of {c.base} points</small></span>
          <ScoreInput unit="pts" max={c.base} value={c.wi ? c.pts : null} placeholder={String(c.actual)} label={`${c.name} points`} onSet={(v) => set('bonus', c.id, v)} />
          <span class="pts">+{((100 * c.pts) / c.base).toFixed(1)}</span>
        </div>
      </div>
    );
  }
  const left = c.kind === 'slots' ? c.list.filter((s) => s.pct == null).length : Math.max(0, c.n - c.done);
  const inlineSlots = c.kind === 'slots';
  const expandable = c.kind === 'pool' || (c.kind === 'overall' && c.list.length > 0);
  const showRest = !inlineSlots && left > 0;
  return (
    <div class="grCat">
      <div class={`grRow${c.kind === 'overall' ? ' two' : ''}`} onClick={expandable ? () => setOpen(!open) : undefined} style={expandable ? { cursor: 'pointer' } : null}>
        {expandable ? <Icon n="right" size={10} style={{ color: 'var(--text-3)', flex: 'none', transform: open ? 'rotate(90deg)' : '', transition: 'transform .15s' }} /> : <span style={{ width: 10, flex: 'none' }} />}
        <span class="nm">{c.name} <i>{c.weight % 1 ? c.weight.toFixed(1) : c.weight}%</i>
          <small>{statusLine(c, left)}</small>
        </span>
        {showRest && (
          <label class="grRest" onClick={(e) => e.stopPropagation()}>
            <span>rest at</span>
            <ScoreInput value={c.restChosen} placeholder={c.rest.toFixed(0)} label={`Score on the rest of ${c.name}`} onSet={(v) => set('rest', c.id, v)} />
          </label>
        )}
        {c.kind === 'overall' && (
          <label class="grRest" onClick={(e) => e.stopPropagation()}>
            <span>so far</span>
            <ScoreInput value={c.wi ? c.soFar : null} placeholder={c.actual == null ? '–' : c.actual.toFixed(1)} label={`${c.name} score so far`} onSet={(v) => set('items', c.id, v)} />
          </label>
        )}
        <span class="pts" title={`${c.final.toFixed(1)}% of this category`}>{c.points.toFixed(1)}<small>/{c.weight % 1 ? c.weight.toFixed(1) : c.weight}</small></span>
      </div>
      {inlineSlots && c.list.map((s) => <ItemRow key={s.key} s={s} set={set} pending={c.rest} />)}
      {c.cat.ruleNote && <div class="grHint" style={{ paddingLeft: 26 }}>{c.cat.ruleNote}</div>}
      {open && c.kind === 'pool' && c.list.map((s) => <ItemRow key={s.key} s={s} set={set} />)}
      {open && c.kind === 'pool' && !c.list.length && <div class="grHint" style={{ paddingLeft: 26 }}>Nothing graded yet.</div>}
      {open && c.kind === 'overall' && c.list.map((s) => (
        <div key={s.key} class="grItem"><span class="nm">{shortName(s.name)}</span><span class="val">{s.shown}{s.actual != null ? ` · ${s.actual.toFixed(0)}%` : ''}</span></div>
      ))}
    </div>
  );
}

function statusLine(c, left) {
  if (c.kind === 'pool') return `${c.done} of ${c.n} graded, avg ${pct(c.soFar, 1)} · best ${c.keep} count`;
  if (c.kind === 'overall') return `${c.done} of ${c.n} so far${c.cat.overall.dropNote ? ` · ${c.cat.overall.dropNote}` : ''}`;
  return left ? `${c.list.length - left} of ${c.list.length} graded${c.soFar != null ? `, avg ${pct(c.soFar, 1)}` : ''}` : `${pct(c.soFar, 1)}`;
}

function ItemRow({ s, set, pending }) {
  return (
    <div class="grItem">
      <span class="nm">{shortName(s.name)}</span>
      {s.actual != null && s.wi && <span class="was">was {s.actual.toFixed(0)}%</span>}
      <ScoreInput
        value={s.wi ? s.pct : null}
        placeholder={s.actual != null ? s.actual.toFixed(s.actual % 1 ? 1 : 0) : pending != null ? `~${pending.toFixed(0)}` : '–'}
        label={`What-if score for ${s.name}`}
        onSet={(v) => set('items', s.key, v)}
      />
    </div>
  );
}
