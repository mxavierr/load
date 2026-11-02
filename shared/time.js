// Dates are stored as wall-clock strings in the school's time zone:
// "YYYY-MM-DDTHH:mm" for moments, "YYYY-MM-DD" for days. Comparing them as strings
// orders them correctly, which keeps the rest of the code free of Date math.

export const TZ = 'America/Indiana/Indianapolis';

const fmtCache = new Map();
function fmt(tz) {
  if (!fmtCache.has(tz)) {
    fmtCache.set(tz, new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }));
  }
  return fmtCache.get(tz);
}

function parts(date, tz) {
  const o = {};
  for (const p of fmt(tz).formatToParts(date)) o[p.type] = p.value;
  return o;
}

/** Date (or UTC ISO string) -> "YYYY-MM-DDTHH:mm" in tz. Seconds 59 round down, so 03:59:59Z -> 23:59. */
export function toLocal(d, tz = TZ) {
  if (d == null || d === '') return null;
  const date = d instanceof Date ? d : new Date(d);
  if (isNaN(date)) return null;
  const p = parts(date, tz);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

/** "YYYY-MM-DDTHH:mm" in tz -> Date. */
export function fromLocal(s, tz = TZ) {
  if (!s) return null;
  const [d, t = '00:00'] = s.split('T');
  const [y, mo, da] = d.split('-').map(Number);
  const [h, mi] = t.split(':').map(Number);
  const guess = Date.UTC(y, mo - 1, da, h, mi);
  // Offset of tz at that instant, applied twice to settle across DST edges.
  let ts = guess;
  for (let i = 0; i < 2; i++) {
    const p = parts(new Date(ts), tz);
    const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
    ts += guess - asUtc;
  }
  return new Date(ts);
}

/** Accepts either a wall-clock string or an ISO timestamp with a zone; returns wall clock. */
export const asLocal = (s, tz = TZ) => (!s ? null : /(Z|[+-]\d\d:\d\d)$/.test(s) ? toLocal(s, tz) : s);

export const nowLocal = (tz = TZ, now = new Date()) => toLocal(now, tz);
export const today = (tz = TZ, now = new Date()) => toLocal(now, tz).slice(0, 10);
export const dayOf = (s) => (s ? s.slice(0, 10) : null);
export const timeOf = (s) => (s && s.length > 10 ? s.slice(11, 16) : null);

export function addDays(day, n) {
  const [y, m, d] = day.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

export function daysBetween(a, b) {
  const pa = a.split('-').map(Number), pb = b.split('-').map(Number);
  return Math.round((Date.UTC(pb[0], pb[1] - 1, pb[2]) - Date.UTC(pa[0], pa[1] - 1, pa[2])) / 864e5);
}

/** 0 = Sunday */
export function weekday(day) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Minutes between two local moments (b - a). */
export function minutesBetween(a, b, tz = TZ) {
  return Math.round((fromLocal(b, tz) - fromLocal(a, tz)) / 6e4);
}

export function startOfWeek(day) {
  // Weeks start Monday.
  const wd = weekday(day);
  return addDays(day, wd === 0 ? -6 : 1 - wd);
}

export function fmtTime(t) {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  if (h === 23 && m === 59) return '11:59p';
  if (h === 12 && m === 0) return 'noon';
  const hh = h % 12 || 12;
  return m ? `${hh}:${String(m).padStart(2, '0')}${h < 12 ? 'a' : 'p'}` : `${hh}${h < 12 ? 'a' : 'p'}`;
}

export function fmtDay(day, ref) {
  if (ref) {
    const n = daysBetween(ref, day);
    if (n === 0) return 'Today';
    if (n === 1) return 'Tomorrow';
    if (n === -1) return 'Yesterday';
    if (n > 1 && n < 7) return DOW[weekday(day)];
  }
  const [, m, d] = day.split('-').map(Number);
  return `${DOW[weekday(day)]} ${MONTHS[m - 1]} ${d}`;
}

export function fmtMin(min) {
  if (min == null) return '';
  min = Math.round(min);
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h}h${String(m).padStart(2, '0')}` : `${h}h`;
}
