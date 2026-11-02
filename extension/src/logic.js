// The extension's decisions, kept free of browser APIs so they can be tested in Node.

export const ACTIVE_WINDOW = 10 * 60e3; // "in use" = activity in the last 10 minutes
export const GAP = 5 * 60e3; // a pause longer than this ends a work session
export const MIN_SESSION = 2 * 60e3;
export const RETRY = 30 * 60e3;

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
 *  - one you asked for runs right away (once per request)
 *  - a scheduled one runs once its slot has passed, but only while you are using the Mac
 *  - a failed attempt is retried after RETRY, not hammered every minute
 */
export function shouldSync({ times, lastSync, lastTry = 0, lastActive = 0, request, now = Date.now() }) {
  const ls = Date.parse(lastSync || 0) || 0;
  const req = Date.parse(request || 0) || 0;
  if (req && req > ls && req > lastTry) return 'requested';
  const slot = lastSlot(times, new Date(now));
  if (!slot || slot <= ls) return null;
  if (now - lastActive > ACTIVE_WINDOW) return null;
  if (lastTry > slot && now - lastTry < RETRY) return null;
  return 'scheduled';
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
