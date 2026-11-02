// Runs Claude Code headless (`claude -p`) so model calls use your Claude subscription,
// not an API key. No tools, no files, no session history: text in, JSON out.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CANDIDATES = ['/opt/homebrew/bin/claude', '/usr/local/bin/claude', path.join(os.homedir(), '.claude/local/claude'), path.join(os.homedir(), '.local/bin/claude')];
export const CLAUDE = process.env.LOAD_CLAUDE || CANDIDATES.find((p) => fs.existsSync(p)) || 'claude';
const WORKDIR = path.join(os.homedir(), 'Library/Application Support/Load/claude');

let status = { state: 'unknown', at: 0 };
export const claudeStatus = () => status;

export function runClaude({ system, prompt, schema, model = 'opus', timeoutMs = 240000 }) {
  fs.mkdirSync(WORKDIR, { recursive: true });
  const args = ['-p', '--model', model, '--output-format', 'json', '--no-session-persistence', '--tools', ''];
  if (system) args.push('--system-prompt', system);
  if (schema) args.push('--json-schema', JSON.stringify(schema));
  return new Promise((resolve, reject) => {
    const child = spawn(CLAUDE, args, {
      cwd: WORKDIR,
      env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${process.env.PATH || ''}` },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('timed out')); }, timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => { clearTimeout(timer); status = { state: 'missing', at: Date.now(), detail: e.message }; reject(e); });
    child.on('close', () => {
      clearTimeout(timer);
      let j;
      try { j = JSON.parse(out); } catch { status = { state: 'error', at: Date.now(), detail: (err || out).slice(0, 300) }; return reject(new Error((err || out).slice(0, 300) || 'no output')); }
      if (j.is_error) {
        const msg = String(j.result || j.subtype || 'error');
        status = { state: /log ?in|login|auth/i.test(msg) ? 'needs-login' : 'error', at: Date.now(), detail: msg.slice(0, 200) };
        return reject(new Error(msg));
      }
      status = { state: 'ok', at: Date.now() };
      let data = j.structured_output;
      if (data == null) {
        const text = String(j.result || '');
        const m = text.match(/\{[\s\S]*\}/);
        try { data = m ? JSON.parse(m[0]) : { reply: text }; } catch { data = { reply: text }; }
      }
      resolve(data);
    });
    child.stdin.end(prompt);
  });
}

/** Cheap probe so the app can show whether the assistant is connected. */
export async function probeClaude() {
  try {
    await runClaude({ prompt: 'Reply with {"ok":true}', model: 'haiku', schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] }, timeoutMs: 60000 });
  } catch { /* status already set */ }
  return status;
}
