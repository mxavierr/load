// A stand-in for GitHub's contents API backed by a folder on this Mac. Used until the
// private data repo exists (config "mode": "local"). It speaks the same protocol, so the
// app, the extension and RemoteFile cannot tell the difference, and switching to GitHub
// later is a config change plus `node scripts/publish-data.mjs`.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function localGitHub(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const fileFor = (url) => {
    const m = /\/repos\/[^/]+\/[^/]+\/contents\/([^?]+)/.exec(url);
    if (!m) return null;
    const name = decodeURIComponent(m[1]);
    if (name.includes('..') || name.includes('/')) return null;
    return path.join(dir, name);
  };
  const sha = (buf) => crypto.createHash('sha1').update(buf).digest('hex');
  const reply = (status, body, headers = {}) => new Response(body == null ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

  return async function fetchLocal(url, opts = {}) {
    const file = fileFor(String(url));
    if (!file) return reply(404, { message: 'Not Found' });
    const method = (opts.method || 'GET').toUpperCase();
    const headers = Object.fromEntries(Object.entries(opts.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    if (method === 'GET') {
      if (!fs.existsSync(file)) return reply(404, { message: 'Not Found' });
      const buf = fs.readFileSync(file);
      const s = sha(buf);
      const etag = `"${s}"`;
      if (headers['if-none-match'] === etag) return new Response(null, { status: 304, headers: { ETag: etag } });
      return reply(200, { sha: s, content: buf.toString('base64'), encoding: 'base64' }, { ETag: etag });
    }
    if (method === 'PUT') {
      const body = JSON.parse(opts.body || '{}');
      const cur = fs.existsSync(file) ? sha(fs.readFileSync(file)) : null;
      if (cur && body.sha !== cur) return reply(409, { message: 'sha mismatch' });
      if (!cur && body.sha) return reply(409, { message: 'file gone' });
      const buf = Buffer.from(body.content || '', 'base64');
      fs.writeFileSync(`${file}.tmp`, buf);
      fs.renameSync(`${file}.tmp`, file);
      return reply(200, { content: { sha: sha(buf) } });
    }
    return reply(405, { message: 'method' });
  };
}
