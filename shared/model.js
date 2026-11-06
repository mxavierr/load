// Task vocabulary shared by the app, the hub and the extension.
//
// Task record (tasks table):
//   id        stable id. Synced work uses its source key ("bs:<ou>:dropbox:<id>",
//             "mylab:<id>"); hand-made tasks use "t:<random>". Never derived from a title.
//   refs      every source key that belongs to this task (calendar event, content topic,
//             dropbox...). Sync finds a task by any of them, which is what stops duplicates.
//   title course due ("YYYY-MM-DDTHH:mm") start kind est (minutes, your override)
//   done doneAt doneBy ("you" | "sync")    sub (when Brightspace saw a submission)
//   url notes checklist [{id,text,done}]   doDate (the day you plan to work on it)
//   lock      { field: true } for fields you changed by hand; sync leaves them alone
//   srcDue    the source's due date when it disagrees with your locked one
//   moved     { from, at } when sync moved the due date
//   missing   when the source stopped listing it (never auto-deleted)
//   src       "bs" | "mylab" | "manual"     pri  0 normal, 1 high
//   deleted mergedInto aliases (ids merged into this one; their time logs count here)

export const KINDS = {
  exam: { label: 'Exam', icon: '◆' },
  quiz: { label: 'Quiz', icon: '◇' },
  lab: { label: 'Lab', icon: '⚗' },
  rec: { label: 'Recitation', icon: '✎' },
  hw: { label: 'Homework', icon: '✎' },
  project: { label: 'Project', icon: '▣' },
  prep: { label: 'Prep', icon: '▷' },
  survey: { label: 'Survey', icon: '☐' },
  event: { label: 'Event', icon: '●' },
  task: { label: 'Task', icon: '○' },
};

export const DEFAULT_EST = { exam: 180, quiz: 30, lab: 150, rec: 60, hw: 75, project: 120, prep: 40, survey: 15, event: 0, task: 30 };

export function classify(title = '') {
  const t = title.toLowerCase();
  if (/\b(review|study|studying|practice|prep|prepare)\b/.test(t) && /\b(exam|midterm|test|final|quiz)\b/.test(t)) return 'prep';
  if (/\b(final exam|exam|midterm|test (i|ii|iii|\d))\b/.test(t) || /^test\b/.test(t)) return 'exam';
  if (/\bquiz/.test(t)) return 'quiz';
  if (/\blab\b/.test(t)) return 'lab';
  if (/\brec(itation)?\b/.test(t)) return 'rec';
  if (/\b(hw|homework|lesson \d+|wileyplus|problem set|pset)\b/.test(t) || /\bhw\d/.test(t)) return 'hw';
  if (/survey/.test(t)) return 'survey';
  if (/\b(project|report|essay|paper|journal|presentation)\b/.test(t)) return 'project';
  if (/\b(read|reading|video|lecture|pre-?lecture|watch|chapter)\b/.test(t)) return 'prep';
  return 'task';
}

/** Title with numbers and course boilerplate stripped: "LAB 09 : IPYNB" -> "lab # ipynb". */
export function family(title = '') {
  return title
    .toLowerCase()
    .replace(/\b[a-z]{2,5}\s?\d{3,5}\b/g, ' ') // course codes like "phys 172"
    .replace(/\b(fa|sp|su)\d{2}\b/g, ' ')
    .replace(/\d+/g, '#')
    .replace(/[^a-z#]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const SIG_WORDS = {
  hw: 'hw', homework: 'hw', lab: 'lab', rec: 'rec', recitation: 'rec', exam: 'exam', test: 'exam',
  midterm: 'exam', quiz: 'quiz', lesson: 'lesson', week: 'week', chapter: 'ch', ch: 'ch', journal: 'journal',
};

/** Numbered things a title mentions: "ENGT Homework 8" -> ["hw 8"]. Used to match placeholders. */
export function signature(title = '') {
  const out = new Set();
  const re = /\b(hw|homework|lab|rec|recitation|exam|test|midterm|quiz|lesson|week|chapter|ch|journal)\s*[#:.-]?\s*0*(\d+|i{1,3}|iv|v)\b/gi;
  const roman = { i: 1, ii: 2, iii: 3, iv: 4, v: 5 };
  let m;
  while ((m = re.exec(title))) {
    const n = roman[m[2].toLowerCase()] || parseInt(m[2], 10);
    out.add(`${SIG_WORDS[m[1].toLowerCase()]} ${n}`);
  }
  const hw = /\bhw0*(\d+)/i.exec(title);
  if (hw) out.add(`hw ${parseInt(hw[1], 10)}`);
  return [...out];
}

/** "wl.202710.PHYS.17200.102" -> "PHYS172"; "wl.202710.MA.26100.331" -> "MA261". */
export function courseKey(code = '', name = '') {
  const m = /\.([A-Z]{2,5})\.(\d{3})\d{2}\./.exec(code);
  if (m) return m[1] + m[2];
  const n = /\b([A-Z]{2,5})\s?(\d{3})/.exec(name);
  if (n) return n[1] + n[2];
  if (/empowered/i.test(code + name)) return 'ADMIN';
  return code.replace(/^wl[._]/, '').replace(/[^A-Za-z0-9]/g, '').slice(0, 10).toUpperCase() || 'OTHER';
}

export const PALETTE = ['#e0603a', '#3a7be0', '#2fa36b', '#a35fd6', '#d6a21f', '#d6457a', '#2aa6b8', '#7a7a7a'];

export const DEFAULT_SETTINGS = {
  tz: 'America/Indiana/Indianapolis',
  term: '202710',
  syncTimes: ['08:00', '18:00'],
  mylabEveryDays: 7, // MyLab's list barely changes; Sync reads it too
  capacity: { weekday: 240, weekend: 300 },
  earlyDue: '12:00', // due at or before this -> plan to finish the day before
  ignore: ['excused absence', 'request for extension', 'regrade request'],
  mylab: {
    ou: 1638698,
    topicId: 21938619,
    launch: 'https://mylab.pearson.com/api/v1/courses/14285764/links/assignments/launch',
    course: 'MA261',
  },
  extraOus: [1134648],
  managerHour: 21,
};

export const COURSE_ALIASES = {
  PHYS172: ['phys', 'physics', '172'],
  MA261: ['ma', 'math', 'calc', 'calc3', '261', 'mylab'],
  ENGT182: ['engt', '182', 'engineering tech'],
  AD227: ['ad', 'art', 'art history', '227'],
  ADMIN: ['admin', 'life', 'purdue'],
};

export function isOpen(t) {
  return !t.deleted && !t.done;
}

export function effectiveDue(t) {
  return t.due || null;
}

export const SOURCE_LABEL = { dropbox: 'Dropbox', quiz: 'Quiz', survey: 'Survey', topic: 'Content', module: 'Folder', event: 'Calendar' };

/** A key's parts: "bs:1641950:dropbox:1550124" -> {sys:'bs', ou:'1641950', type:'dropbox', id:'1550124'}. */
export function parseKey(k = '') {
  const p = k.split(':');
  if (p[0] === 'bs') return { sys: 'bs', ou: p[1], type: p[2], id: p[3] };
  if (p[0] === 'mylab') return { sys: 'mylab', type: 'mylab', id: p[1] };
  return { sys: p[0], id: p[1] };
}

const GENERIC = new Set(('a an the of for and to in on at by with due file files upload uploads ipynb pdf notebook worksheet submission submit assignment '
  + 'wileyplus mylab hw homework lab labs rec recitation quiz quizzes exam test lesson lessons part section sections '
  + 'fa sp su phys ma engt ad admin brightspace online').split(' '));

/** Words that say what a title is about, beyond its course, number and kind. */
export function contentWords(title = '') {
  return title.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w && !/\d/.test(w) && !GENERIC.has(w) && w.length > 1);
}

/** Is `ph` (a hand-made placeholder) clearly the same work as the synced `real` item? */
export function isPlaceholderFor(ph, real) {
  const sig = signature(ph.title).filter((s) => !/^(week|ch) /.test(s));
  if (!sig.length || !signature(real.title).some((s) => sig.includes(s))) return false;
  const pw = contentWords(ph.title), rw = new Set(contentWords(real.title));
  if (!pw.every((w) => rw.has(w))) return false;
  return [...rw].filter((w) => !pw.includes(w)).length <= 2;
}
