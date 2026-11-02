// Moves Load's data from this Mac to the private GitHub repo so the phone can reach it,
// then switches the hub to GitHub mode. Run once, after creating the repo:
//   gh repo create mxavierr/load-data --private
//   node scripts/publish-data.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { RemoteFile, FILES } from '../shared/store.js';

const HOME = path.join(os.homedir(), 'Library/Application Support/Load');
const CONFIG = path.join(HOME, 'config.json');
const config = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
const token = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();

for (const [k, p] of Object.entries(FILES)) {
  const local = JSON.parse(fs.readFileSync(path.join(HOME, 'data', p), 'utf8'));
  const f = new RemoteFile({ repo: config.repo, path: p, token });
  await f.pull(); // merges with anything already there
  await f.push(local, `Publish ${p} from the Mac`);
  console.log(`${p}: uploaded`);
}
fs.writeFileSync(CONFIG, JSON.stringify({ ...config, mode: 'github' }, null, 2));
console.log(`Hub switched to GitHub mode (${config.repo}). Restart it: ./hub/install.sh`);
