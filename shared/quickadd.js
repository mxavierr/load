// Plain-code parser for the command bar: "phys hw 9 fri 5pm 2h" becomes a task
// preview as you type. Anything that reads like an instruction ("move", "all",
// "split", a question) is flagged so the bar hands it to the assistant instead.

import { today as todayFn, addDays, weekday } from './time.js';
import { classify } from './model.js';

const DAYS = { sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, weds: 3, wednesday: 3, thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6 };
const MONTHS = { jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12 };
// A request to change existing tasks, or a question, rather than a new task. Verbs that
// are also everyday tasks ("check grades", "make flashcards", "do pset 4") only count
// when they clearly point at existing tasks.
const QUESTION_RE = /\?\s*$|^(what|what's|whats|when|how|why|which|who|where)\b|^(can|could|should|would|will|is|are|do|does|did|am|have|has)\s+(i|you|we|my|there|it|this|that|anything|everything)\b/i;
const EDIT_VERB_RE = /^(move|push|pull|shift|delete|remove|rename|reschedule|postpone|delay|untick|uncheck|merge|combine|swap|undo|clear|reorder)\b/i;
const BULK_RE = /\b(all|every|each|everything|anything)\b.*\b(to|by|later|earlier|as|done|due)\b|\b(my|the)\s+(tasks|labs|homeworks?|quizzes|lessons|assignments|deadlines|due dates)\b/i;
const MARK_RE = /^(mark|tick|check off|set|change|split|break up|plan)\b.*\b(as|to|into|for|done|complete|finished)\b/i;
export const isCommand = (t) => QUESTION_RE.test(t) || EDIT_VERB_RE.test(t) || BULK_RE.test(t) || MARK_RE.test(t);

function pad(n) {
  return String(n).padStart(2, '0');
}

/**
 * @returns {{title, course, due, est, kind, pri, command:boolean, chips:[{k,v,text}]}}
 */
export function parseQuick(input, { courses = [], tz, now = new Date() } = {}) {
  const text = input.trim();
  const out = { title: '', course: null, due: null, est: null, kind: null, pri: 0, command: false, chips: [] };
  if (!text) return out;
  if (isCommand(text)) out.command = true;

  let s = ' ' + text + ' ';
  const take = (re, fn) => {
    const m = re.exec(s);
    if (!m) return false;
    const ok = fn(m);
    if (ok !== false) s = s.slice(0, m.index) + ' ' + s.slice(m.index + m[0].length);
    return ok !== false;
  };
  const today = todayFn(tz, now);

  // Priority
  take(/\s(!{1,3}|!high|!important)\s/i, () => { out.pri = 1; out.chips.push({ k: 'pri', text: 'High' }); });

  // Duration: 2h, 90m, 1.5h, 2h30, 45 min
  take(/\s(?:~|for\s+)?(\d+(?:\.\d+)?)\s?(h|hr|hrs|hours?)(?:\s?(\d+)\s?m(?:in)?)?\s/i, (m) => {
    out.est = Math.round(parseFloat(m[1]) * 60 + (m[3] ? +m[3] : 0));
  }) || take(/\s(?:~|for\s+)?(\d+)\s?(m|min|mins|minutes)\s/i, (m) => { out.est = +m[1]; });

  // Time
  let time = null;
  take(/\s(?:at\s+|@\s?|by\s+)?(\d{1,2})(?::(\d\d))?\s?(am|pm|a|p)\s/i, (m) => {
    let h = +m[1] % 12;
    if (/p/i.test(m[3])) h += 12;
    time = `${pad(h)}:${m[2] || '00'}`;
  }) || take(/\s(?:at\s+|@\s?|by\s+)?([01]?\d|2[0-3]):([0-5]\d)\s/, (m) => { time = `${pad(+m[1])}:${m[2]}`; })
    || take(/\s(?:at\s+|by\s+)?(noon|midday)\s/i, () => { time = '12:00'; })
    || take(/\s(?:at\s+|by\s+)?(midnight|eod|end of day)\s/i, () => { time = '23:59'; });
  if (!time) take(/\s(tonight)\s/i, () => { time = '23:59'; s = s + ' today '; });

  // Date
  let day = null;
  const dueWord = '(?:due\\s+|on\\s+|by\\s+)?';
  take(new RegExp(`\\s${dueWord}(today|tod)\\s`, 'i'), () => { day = today; })
    || take(new RegExp(`\\s${dueWord}(tomorrow|tmrw|tmr|tom)\\s`, 'i'), () => { day = addDays(today, 1); })
    || take(new RegExp(`\\s${dueWord}in\\s+(\\d+)\\s+(days?|weeks?)\\s`, 'i'), (m) => { day = addDays(today, +m[1] * (/w/i.test(m[2]) ? 7 : 1)); })
    || take(new RegExp(`\\s${dueWord}(next\\s+)?(${Object.keys(DAYS).join('|')})\\s`, 'i'), (m) => {
      const target = DAYS[m[2].toLowerCase()];
      let n = (target - weekday(today) + 7) % 7;
      if (n === 0) n = 7;
      if (m[1]) n += n < 7 ? 7 : 0;
      day = addDays(today, n);
    })
    || take(new RegExp(`\\s${dueWord}(${Object.keys(MONTHS).join('|')})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\s`, 'i'), (m) => { day = resolveMD(today, MONTHS[m[1].toLowerCase()], +m[2]); })
    || take(new RegExp(`\\s${dueWord}(\\d{1,2})/(\\d{1,2})(?:/(\\d{2,4}))?\\s`, 'i'), (m) => { day = resolveMD(today, +m[1], +m[2], m[3]); })
    || take(/\s(next week)\s/i, () => { day = addDays(today, 7); });
  if (day || time) {
    out.due = `${day || today}T${time || '23:59'}`;
    out.chips.push({ k: 'due', v: out.due });
  }
  if (out.est) out.chips.push({ k: 'est', v: out.est });

  // Course: match any alias as a whole word; the first hit wins and is removed.
  const words = s.toLowerCase();
  let best = null;
  for (const c of courses) {
    for (const a of [c.id.toLowerCase(), ...(c.aliases || [])]) {
      const re = new RegExp(`\\s(${a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})\\s`, 'i');
      const m = re.exec(words);
      if (m && (!best || m.index < best.index || (m.index === best.index && a.length > best.len))) best = { id: c.id, index: m.index, len: a.length, re };
    }
  }
  if (best) {
    out.course = best.id;
    s = s.replace(best.re, ' ');
    // "ma 261 hw" names the course twice; drop the other spellings too.
    const c = courses.find((x) => x.id === best.id);
    for (const a of [c.id.toLowerCase(), ...(c.aliases || [])]) {
      const re = new RegExp(`\\s(${a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})(?=\\s)`, 'gi');
      s = s.replace(re, ' ');
    }
    out.chips.push({ k: 'course', v: best.id });
  }

  s = s.replace(/\s+due\s*$/i, ' ').replace(/\s+/g, ' ').trim();
  out.title = s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
  out.kind = classify(out.title);
  return out;
}

function resolveMD(today, m, d, y) {
  let year = y ? (y.length === 2 ? 2000 + +y : +y) : +today.slice(0, 4);
  let day = `${year}-${pad(m)}-${pad(d)}`;
  if (!y && day < addDays(today, -60)) day = `${year + 1}-${pad(m)}-${pad(d)}`;
  return day;
}
