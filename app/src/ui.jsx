import { courses, settings, nowTick } from './state.js';
import { dayOf, timeOf, fmtDay, fmtTime, today as todayFn, minutesBetween, nowLocal } from '../../shared/time.js';

const P = {
  check: 'M3.5 8.5l3 3 6-7',
  play: 'M5 3.5v9l7.5-4.5z',
  stop: 'M4.5 4.5h7v7h-7z',
  plus: 'M8 3v10M3 8h10',
  x: 'M4 4l8 8M12 4l-8 8',
  grip: 'M6 4h.01M10 4h.01M6 8h.01M10 8h.01M6 12h.01M10 12h.01',
  caret: 'M4 6l4 4 4-4',
  right: 'M6 4l4 4-4 4',
  link: 'M7 9a3 3 0 004 0l2-2a3 3 0 00-4-4l-.5.5M9 7a3 3 0 00-4 0l-2 2a3 3 0 004 4l.5-.5',
  out: 'M9 3h4v4M13 3L7.5 8.5M12 9.5V13H3V4h3.5',
  file: 'M4 2h5l3 3v9H4zM9 2v3h3',
  folder: 'M2 4.5h4l1.5 1.5H14V13H2z',
  video: 'M2 4h9v8H2zM11 7l3-2v6l-3-2',
  upload: 'M8 11V3M5 6l3-3 3 3M3 13h10',
  quiz: 'M8 14A6 6 0 108 2a6 6 0 000 12zM6.5 6a1.5 1.5 0 113 .5c0 1-1.5 1-1.5 2M8 11h.01',
  down: 'M8 3v8M5 8l3 3 3-3M3 13h10',
  search: 'M7 12A5 5 0 107 2a5 5 0 000 10zM11 11l3 3',
  gear: 'M8 10a2 2 0 100-4 2 2 0 000 4zM13 8l1.3-1-1-2-1.6.4-1.2-.9L10 3H8l-.5 1.5-1.2.7L4.7 4.8l-1 1.7L5 8l-1.3 1 1 2 1.6-.4 1.2.9L8 13h2l.5-1.5 1.2-.7 1.6.4 1-1.7z',
  sync: 'M13 7A5 5 0 004 4.5L3 6M3 9a5 5 0 009 2.5l1-1.5M3 3v3h3M13 13v-3h-3',
  flag: 'M4 14V2.5M4 3h7l-1.5 2.5L11 8H4',
  wide: 'M2 8h12M5 5L2 8l3 3M11 5l3 3-3 3',
  star: 'M8 2l1.8 3.8 4.2.5-3.1 2.9.8 4.1L8 11.3l-3.7 2 .8-4.1L2 6.3l4.2-.5z',
  sparkle: 'M8 2v3M8 11v3M2 8h3M11 8h3M4 4l2 2M10 10l2 2M12 4l-2 2M6 10l-2 2',
  clock: 'M8 14A6 6 0 108 2a6 6 0 000 12zM8 5v3l2 1.5',
  pulse: 'M2 8h3l1.5-3 3 6L11 8h3',
  back: 'M10 4L6 8l4 4',
  trash: 'M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.5 9h6l.5-9',
  undo: 'M5 4L2.5 6.5 5 9M2.5 6.5H10a3.5 3.5 0 010 7H7',
  list: 'M5 4h9M5 8h9M5 12h9M2 4h.01M2 8h.01M2 12h.01',
};

export function Icon({ n, size = 16, sw = 1.6, style }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width={sw} stroke-linecap="round" stroke-linejoin="round" style={style} aria-hidden="true">
      <path d={P[n]} />
    </svg>
  );
}

export const courseColor = (id) => courses.value[id]?.color || '#888';
export const courseShort = (id) => (id ? (courses.value[id]?.short || id.replace(/(\D+)(\d+)/, '$1 $2')) : '');

export function CoursePill({ id }) {
  if (!id) return null;
  return <span class="course" style={{ '--c': courseColor(id) }}>{courseShort(id)}</span>;
}

export function Ring({ value, size = 44, stroke = 5, color = 'var(--green)' }) {
  const r = (size - stroke) / 2, c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(1, value || 0));
  return (
    <svg class="ring" width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--line)" stroke-width={stroke} />
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} stroke-width={stroke} stroke-linecap="round"
        stroke-dasharray={`${c * v} ${c}`} transform={`rotate(-90 ${size / 2} ${size / 2})`} style={{ transition: 'stroke-dasharray .4s' }} />
    </svg>
  );
}

/** "Fri 11:59p", "Today 5p", "in 3h" with an urgency class. */
export function dueInfo(due) {
  if (!due) return { text: '', cls: '' };
  nowTick.value;
  const tz = settings.value.tz;
  const now = nowLocal(tz);
  const today = todayFn(tz);
  const mins = minutesBetween(now, due, tz);
  let text;
  if (mins < 0) {
    const d = -mins;
    text = d < 60 ? `${Math.round(d)}m late` : d < 48 * 60 ? `${Math.round(d / 60)}h late` : `${Math.round(d / 1440)}d late`;
  } else if (mins < 4 * 60) text = mins < 60 ? `in ${Math.max(1, Math.round(mins))}m` : `in ${Math.round(mins / 60)}h`;
  else text = `${fmtDay(dayOf(due), today)} ${fmtTime(timeOf(due))}`.trim();
  const cls = mins < 0 ? 'late' : mins < 24 * 60 ? 'soon' : '';
  return { text, cls, mins };
}

export function relTime(iso) {
  if (!iso) return 'never';
  nowTick.value;
  const m = (Date.now() - Date.parse(iso)) / 6e4;
  if (m < 1) return 'just now';
  if (m < 60) return `${Math.round(m)}m ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
}

export function Empty({ children }) {
  return <div class="empty">{children}</div>;
}
