// One JSON file in the private data repo, read and written through GitHub's contents
// API. Saving sends the sha we last read; if someone else (the phone, the Mac) saved in
// between, GitHub refuses, we fetch theirs, merge field by field and try again.
// The same class talks to the hub's proxy on the Mac, which adds the token itself.

import { mergeDocs, docEquals } from './doc.js';

function b64encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function b64decode(b64) {
  const bin = atob(b64.replace(/\n/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export class RemoteFile {
  /**
   * @param {{base:string, repo:string, path:string, token?:string, branch?:string, fetch?:Function}} o
   */
  constructor(o) {
    this.base = o.base || 'https://api.github.com';
    this.repo = o.repo;
    this.path = o.path;
    this.token = o.token;
    this.branch = o.branch || 'main';
    this.fetch = o.fetch || ((...a) => fetch(...a));
    this.sha = null;
    this.etag = null;
    this.doc = null;
  }

  url() {
    return `${this.base}/repos/${this.repo}/contents/${this.path}`;
  }

  headers(extra = {}) {
    const h = { Accept: 'application/vnd.github+json', ...extra };
    if (this.token) h.Authorization = `Bearer ${this.token}`;
    return h;
  }

  /** Fetch the file. Returns {changed}. A missing file reads as an empty doc. */
  async pull() {
    const h = this.headers(this.etag ? { 'If-None-Match': this.etag } : {});
    const r = await this.fetch(`${this.url()}?ref=${this.branch}&t=${Date.now()}`, { headers: h, cache: 'no-store' });
    if (r.status === 304) return { changed: false };
    if (r.status === 404) {
      const first = this.doc == null;
      this.doc = this.doc || {};
      this.sha = null;
      return { changed: first };
    }
    if (!r.ok) throw httpError(r, await r.text());
    const j = await r.json();
    if (j.sha === this.sha && this.doc) { this.etag = r.headers.get('etag'); return { changed: false }; }
    let text;
    if (!j.content && j.size > 0) {
      // Over 1 MB GitHub leaves `content` empty; ask for the raw file instead.
      const raw = await this.fetch(`${this.url()}?ref=${this.branch}&t=${Date.now()}`, { headers: this.headers({ Accept: 'application/vnd.github.raw' }), cache: 'no-store' });
      if (!raw.ok) throw httpError(raw, await raw.text());
      text = await raw.text();
    } else text = b64decode(j.content || '');
    const remote = JSON.parse(text || '{}');
    this.etag = r.headers.get('etag');
    this.sha = j.sha;
    const before = this.doc;
    this.doc = this.doc ? mergeDocs(remote, this.doc) : remote;
    this.remote = remote;
    return { changed: !before || !docEquals(before, this.doc), dirty: !docEquals(remote, this.doc) };
  }

  /** Save `doc` (merged over whatever is there). Returns the doc as saved. */
  async push(doc, message = 'update') {
    let mine = doc;
    for (let attempt = 0; attempt < 4; attempt++) {
      // Always write on top of the newest copy we have seen, under that copy's sha. A poll
      // that ran while this doc was being prepared may have brought in another device's
      // edit; merging it here is what keeps the write from erasing it.
      const sha = this.sha;
      if (this.remote) mine = mergeDocs(this.remote, mine);
      if (this.remote && docEquals(this.remote, mine) && sha) { this.doc = mine; return mine; }
      const body = { message, content: b64encode(JSON.stringify(mine)), branch: this.branch };
      if (sha) body.sha = sha;
      const r = await this.fetch(this.url(), { method: 'PUT', headers: this.headers({ 'Content-Type': 'application/json' }), body: JSON.stringify(body) });
      if (r.ok) {
        const j = await r.json();
        this.sha = j.content.sha;
        this.etag = null;
        this.doc = mine;
        this.remote = mine;
        return mine;
      }
      if (r.status === 409 || r.status === 422 || (r.status === 400 && !this.sha)) {
        // Someone saved first: take theirs, merge ours over it, retry.
        this.etag = null;
        const keep = mine;
        this.doc = keep;
        await this.pull();
        mine = mergeDocs(this.remote || {}, keep);
        continue;
      }
      throw httpError(r, await r.text());
    }
    throw new Error('Could not save after several tries');
  }
}

function httpError(r, text) {
  const e = new Error(`${r.status} ${text.slice(0, 200)}`);
  e.status = r.status;
  return e;
}

export const FILES = { db: 'db.json', log: 'log.json', library: 'library.json' };
