// Bundles the extension into extension/dist (the folder the Xcode project points at).
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname);
const out = path.join(here, 'dist');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
for (const f of fs.readdirSync(path.join(here, 'static'))) fs.copyFileSync(path.join(here, 'static', f), path.join(out, f));
await build({
  entryPoints: ['background', 'brightspace', 'mylab', 'activity', 'popup'].map((n) => path.join(here, 'src', `${n}.js`)),
  outdir: out, bundle: true, format: 'iife', target: 'safari16', minify: false, logLevel: 'warning',
});
console.log('extension built →', out);
