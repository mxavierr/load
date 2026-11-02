// These two functions run inside the Brightspace / MyLab page (the extension injects
// them), so they must stay self-contained: no imports, no outer variables.

/**
 * Read everything that can produce a task, from every course this term, through
 * Brightspace's own JSON API using the signed-in page's session. Returns a trimmed
 * snapshot; reconcile.js turns it into tasks.
 */
export async function collectBrightspace(cfg) {
  cfg = cfg || {};
  const LE = '/d2l/api/le/' + (cfg.le || '1.100') + '/';
  const LP = '/d2l/api/lp/' + (cfg.lp || '1.30') + '/';
  const snap = { at: new Date().toISOString(), ok: true, errors: [], courses: [] };

  async function get(path) {
    const r = await fetch(path, { credentials: 'include', headers: { Accept: 'application/json' } });
    if (r.redirected && /login|sso|shibboleth/i.test(r.url)) throw Object.assign(new Error('signed-out'), { status: 401 });
    if (!r.ok) throw Object.assign(new Error(r.status + ' ' + path), { status: r.status });
    const ct = r.headers.get('content-type') || '';
    if (!ct.includes('json')) throw Object.assign(new Error('signed-out'), { status: 401 });
    return r.json();
  }
  async function paged(path) {
    // Two paging styles: {Objects, Next} and {PagingInfo:{Bookmark,HasMoreItems}, Items}.
    let out = [], url = path, guard = 0;
    while (url && guard++ < 40) {
      const b = await get(url);
      if (Array.isArray(b)) return b;
      if (b.Objects) {
        out = out.concat(b.Objects);
        url = b.Next ? b.Next.replace(/^https?:\/\/[^/]+/, '') : null;
      } else if (b.Items) {
        out = out.concat(b.Items);
        url = b.PagingInfo && b.PagingInfo.HasMoreItems ? path + (path.includes('?') ? '&' : '?') + 'bookmark=' + encodeURIComponent(b.PagingInfo.Bookmark) : null;
      } else return b;
    }
    return out;
  }
  const strip = (h, n) => (h || '').replace(/<[^>]+>/g, ' ').replace(/&#(\d+);/g, (m, c) => String.fromCharCode(+c)).replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim().slice(0, n || 600);

  let enroll;
  try {
    enroll = await paged(LP + 'enrollments/myenrollments/?orgUnitTypeId=3');
  } catch (e) {
    snap.ok = false;
    snap.errors.push(e.status === 401 || e.status === 403 ? 'signed-out' : String(e.message));
    return snap;
  }
  const term = cfg.term || '';
  const extra = (cfg.extraOus || []).map(Number);
  const courses = enroll
    .map((i) => i.OrgUnit)
    .filter((o) => (term && o.Code.indexOf('.' + term + '.') >= 0) || extra.indexOf(o.Id) >= 0 || (cfg.ous || []).indexOf(o.Id) >= 0);

  const soonFrom = Date.now() - 10 * 864e5, soonTo = Date.now() + 21 * 864e5;

  for (const o of courses) {
    const ou = o.Id;
    const c = { ou, code: o.Code, name: o.Name, ok: true, errors: [] };
    const tryGet = async (name, fn) => {
      try {
        return await fn();
      } catch (e) {
        c.errors.push(name + ': ' + e.message);
        if (name !== 'grades' && name !== 'news' && name !== 'surveys') c.ok = false;
        return null;
      }
    };
    const [toc, dropbox, quizzes, surveys, cal, myItems, news, grades] = await Promise.all([
      tryGet('toc', () => get(LE + ou + '/content/toc')),
      tryGet('dropbox', () => get(LE + ou + '/dropbox/folders/')),
      tryGet('quizzes', () => paged(LE + ou + '/quizzes/')),
      tryGet('surveys', () => paged(LE + ou + '/surveys/')),
      tryGet('calendar', () => get(LE + ou + '/calendar/events/')),
      tryGet('myItems', () => paged(LE + ou + '/content/myItems/')),
      tryGet('news', () => get(LE + ou + '/news/')),
      tryGet('grades', () => get(LE + ou + '/grades/values/myGradeValues/')),
    ]);

    const trimModule = (m) => ({
      id: m.ModuleId, title: m.Title, hidden: !!m.IsHidden, start: m.StartDateTime, mod: m.LastModifiedDate,
      modules: (m.Modules || []).map(trimModule),
      topics: (m.Topics || []).map((t) => ({
        id: t.TopicId, title: t.Title, url: t.Url, act: t.ActivityType, tool: t.ToolItemId, type: t.TypeIdentifier,
        mod: t.LastModifiedDate, hidden: !!t.IsHidden, start: t.StartDateTime, end: t.EndDateTime,
      })),
    });
    c.toc = toc ? (toc.Modules || []).map(trimModule) : null;
    c.dropbox = dropbox ? dropbox.map((f) => ({
      id: f.Id, title: f.Name, due: f.DueDate, start: f.Availability && f.Availability.StartDate,
      end: f.Availability && f.Availability.EndDate, hidden: !!f.IsHidden, grade: f.GradeItemId, info: strip(f.CustomInstructions && f.CustomInstructions.Html, 400),
    })) : null;
    c.quizzes = quizzes ? quizzes.map((q) => ({ id: q.QuizId, title: q.Name, due: q.DueDate, start: q.StartDate, end: q.EndDate, active: q.IsActive, grade: q.GradeItemId, limit: q.SubmissionTimeLimit && q.SubmissionTimeLimit.IsEnforced ? q.SubmissionTimeLimit.TimeLimitValue : null, attempts: q.AttemptsAllowed && !q.AttemptsAllowed.IsUnlimited ? q.AttemptsAllowed.NumberOfAttemptsAllowed : null })) : null;
    c.surveys = surveys ? surveys.map((s) => ({ id: s.SurveyId, title: s.Name, start: s.StartDate, end: s.EndDate })) : null;
    c.cal = cal ? cal.map((e) => ({
      id: e.CalendarEventId, title: e.Title, start: e.StartDateTime || (e.StartDay ? e.StartDay + 'T12:00:00.000Z' : null), end: e.EndDateTime,
      type: e.EventType, allDay: !!e.IsAllDayEvent, link: e.CalendarEventViewUrl,
      ent: e.AssociatedEntity ? { type: e.AssociatedEntity.AssociatedEntityType, id: e.AssociatedEntity.AssociatedEntityId, link: e.AssociatedEntity.Link } : null,
      desc: strip(e.Description, 300),
    })) : null;
    c.myItems = myItems ? myItems.map((i) => ({ id: i.ItemId, type: i.ItemType, done: i.DateCompleted, act: i.ActivityType, title: i.ItemName })) : null;
    c.news = news ? news.filter((n) => !n.IsHidden).map((n) => ({ id: n.Id, title: n.Title, body: strip(n.Body && n.Body.Html, 2000), at: n.StartDate || n.CreatedDate, mod: n.LastModifiedDate })) : null;
    c.grades = grades ? grades.map((g) => ({ id: g.GradeObjectIdentifier, name: g.GradeObjectName, type: g.GradeObjectTypeName, num: g.PointsNumerator, den: g.PointsDenominator, shown: g.DisplayedGrade, mod: g.LastModified })) : null;

    // Submissions for dropboxes closing soon that content completion cannot vouch for.
    c.subs = {};
    if (c.dropbox) {
      const doneTopics = new Set((c.myItems || []).filter((i) => i.done).map((i) => i.id));
      const coveredDb = new Set();
      const walk = (ms) => ms.forEach((m) => { m.topics.forEach((t) => { if (t.act === 3 && doneTopics.has(t.id)) coveredDb.add(t.tool); }); walk(m.modules); });
      if (c.toc) walk(c.toc);
      const soon = c.dropbox.filter((f) => { const d = Date.parse(f.due || f.end || ''); return d && d > soonFrom && d < soonTo && !coveredDb.has(f.id); }).slice(0, 25);
      await Promise.all(soon.map(async (f) => {
        try {
          const s = await get(LE + ou + '/dropbox/folders/' + f.id + '/submissions/mysubmissions/');
          const list = [];
          (s || []).forEach((e) => (e.Submissions || []).forEach((x) => list.push({ at: x.SubmissionDate, files: (x.Files || []).length })));
          c.subs[f.id] = list;
        } catch (e) {
          c.subs[f.id] = e.status === 403 ? 'forbidden' : 'error';
        }
      }));
    }
    snap.courses.push(c);
  }
  snap.ok = snap.courses.length > 0 && snap.courses.every((c) => c.ok);
  return snap;
}

/** Parse MyLab's "Homework and Tests" (DoAssignments.aspx?view=all) table. */
export function parseMyLab() {
  const rows = Array.prototype.slice.call(document.querySelectorAll('tr')).filter((r) => r.querySelector('th') && r.cells[0] && /\d\d\/\d\d\/\d\d/.test(r.cells[0].innerText || ''));
  return rows.map((r) => {
    const th = r.querySelector('th');
    const m = /(?:[HQT]_|doHomework\(|doQuiz\(|doTest\()(\d{6,})/.exec(r.innerHTML);
    const dm = /(\d\d)\/(\d\d)\/(\d\d)\s*(\d{1,2}):(\d\d)\s*(am|pm)/i.exec(r.cells[0].innerText.replace(/\s+/g, ' '));
    let due = null;
    if (dm) {
      let h = parseInt(dm[4], 10) % 12;
      if (dm[6].toLowerCase() === 'pm') h += 12;
      due = '20' + dm[3] + '-' + dm[1] + '-' + dm[2] + 'T' + String(h).padStart(2, '0') + ':' + dm[5];
    }
    const a = th.querySelector('a');
    const score = (r.innerText.match(/\d+(\.\d+)?%/) || [null])[0];
    return {
      id: m ? m[1] : null,
      due,
      kind: ((th.querySelector('i') || {}).className || '').replace('xlicon-', ''),
      title: a ? a.textContent.replace(/\s+/g, ' ').trim() : th.innerText.trim(),
      scored: /see score/i.test(r.innerText) || !!score,
      score,
    };
  }).filter((r) => r.id);
}
