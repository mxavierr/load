// The extension's decisions, kept free of browser APIs so they can be tested in Node.

export const ACTIVE_WINDOW = 10 * 60e3; // "in use" = activity in the last 10 minutes
export const GAP = 5 * 60e3; // a pause longer than this ends a work session
export const MIN_SESSION = 2 * 60e3;
export const RETRY = 15 * 60e3; // after a failed attempt
export const SIGNIN_RETRY = 60 * 60e3; // re-check while waiting on a sign-in
export const VISIT_STALE = 3 * 3600e3; // on a Brightspace page with data older than this: sync
export const VISIT_COOLDOWN = 2 * 60e3;
export const MYLAB_RETRY = 6 * 3600e3;
export const MYLAB_EVERY_DAYS = 7;

/** The most recent scheduled sync time that has passed (epoch ms), in the Mac's local time. */
export function lastSlot(times, now = new Date()) {
  let best = 0;
  for (const day of [0, -1]) {
    for (const t of times || []) {
      const [h, m] = t.split(':').map(Number);
      const d = new Date(now);
      d.setDate(d.getDate() + day);
      d.setHours(h, m, 0, 0);
      if (d <= now && d.getTime() > best) best = d.getTime();
    }
  }
  return best;
}

/**
 * Should a sync start now?
 *  - one you asked for runs right away, and is retried until it works
 *  - a scheduled one runs once its slot has passed, whenever Safari is running
 *  - a failed attempt is retried after RETRY; while waiting on a sign-in, after SIGNIN_RETRY
 */
export function shouldSync({ times, lastSync, lastTry = 0, request, needsSignin = false, now = Date.now() }) {
  const ls = Date.parse(lastSync || 0) || 0;
  const req = Date.parse(request || 0) || 0;
  if (req && req > ls && req > lastTry) return 'requested';
  const slot = lastSlot(times, new Date(now));
  const wanted = req > ls;
  if (!wanted && (!slot || slot <= ls)) return null;
  if (needsSignin ? now - lastTry < SIGNIN_RETRY : lastTry > slot && now - lastTry < RETRY) return null;
  return wanted ? 'requested' : 'scheduled';
}

/**
 * You are on a Brightspace page, so the session is probably good: use it. A page that just
 * loaded is good evidence after a sign-in; one that's merely open could be long expired.
 */
export function shouldSyncOnVisit({ lastSync, lastTry = 0, needsSignin = false, loaded = false, now = Date.now() }) {
  if (needsSignin) return now - lastTry >= (loaded ? VISIT_COOLDOWN : RETRY);
  return now - (Date.parse(lastSync || 0) || 0) >= VISIT_STALE && now - lastTry >= RETRY;
}

/** MyLab's assignment list barely changes, so it is read about weekly, or when you press Sync. */
export function shouldReadMyLab({ lastMyLab, lastTry = 0, everyDays = MYLAB_EVERY_DAYS, force = false, now = Date.now() }) {
  if (force) return true;
  return now - (Date.parse(lastMyLab || 0) || 0) >= everyDays * 864e5 && now - lastTry >= MYLAB_RETRY;
}

/** A real Brightspace page, as opposed to its sign-in redirect or someone else's login page. */
export function isAppPage(url) {
  return /^https:\/\/purdue\.brightspace\.com\//.test(url || '') && !/\/d2l\/(login|lp\/auth)\b/i.test(url);
}

/** Which task, if any, a page belongs to, from the hub's index of URL fingerprints. */
export function matchTask(url, index) {
  if (!index || !url) return null;
  const bare = url.replace(/^https?:\/\//, '').split('#')[0];
  const hw = /doHomework\((\d+)/.exec(url) || /[?&](?:homeworkId|assignmentId|itemid|hwid)=(\d{6,})/i.exec(url);
  for (const t of index) {
    for (const k of t.keys) {
      if (k.startsWith('mylab:')) { if (hw && k === `mylab:${hw[1]}`) return t.id; continue; }
      if (/^[a-z]+=\d+$/.test(k)) { if (new RegExp(`[?&]${k}(?:&|$)`).test(url)) return t.id; continue; }
      if (bare.includes(k)) return t.id;
    }
  }
  return null;
}

/**
 * Feed one heartbeat ("you are active on this page, which belongs to task X or nothing")
 * into the current session. Returns the new session and, if one just ended, the finished
 * record to save.
 */
export function beat(cur, task, now, url) {
  let finished = null;
  if (cur && (cur.task !== task || now - cur.last > GAP)) {
    finished = close(cur);
    cur = null;
  }
  if (!task) return { cur: null, finished };
  cur = cur ? { ...cur, last: now } : { task, s: now, last: now, url };
  return { cur, finished };
}

/** A session as saved, or null when it was too short to count. */
export function close(cur) {
  const end = cur.last + 20e3; // the last heartbeat stands for the next 20 s
  if (end - cur.s < MIN_SESSION) return null;
  return { id: `s:x${cur.s.toString(36)}`, task: cur.task, s: new Date(cur.s).toISOString(), e: new Date(end).toISOString(), src: 'auto', url: cur.url };
}
